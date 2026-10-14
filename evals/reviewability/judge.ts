#!/usr/bin/env bun
// Asks Opus and Sol to review each version of each scenario, and to compare versions pairwise in both orders.
// Judges see only the packet: frames, captions and (C) the receipt. Code scores their answers in score.ts.
// Usage: bun evals/reviewability/judge.ts [--repeats 3] [--concurrency 6] [--judges opus,sol] [scenario...]
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { OUT, type Packet, type Version } from './build';
import { CATEGORIES, loadScenario, scenarioDirs, type Scenario } from './scenario';

// Ids from `claude --help` aliases and ~/.codex/models_cache.json, checked 2026-10-14.
export const JUDGES = {
  opus: { model: 'claude-opus-5-5' },
  sol: { model: 'gpt-6.1-sol', effort: 'medium' },
} as const;
export type Judge = keyof typeof JUDGES;
export const PAIRS = [['A', 'B'], ['B', 'C']] as const;
export const RESULTS = join(OUT, 'judgments.jsonl');

type Part = { text: string } | { image: string };
export type AnswerOutput = {
  observations: string; answers: Record<string, string>; decision: 'approve' | 'request_changes';
  blocking_issues: { category: string; description: string }[]; legibility: number;
};
export type PairOutput = { reasons: string; preferred: 'X' | 'Y' };
type Call = { key: string; judge: Judge; scenario: string; repeat: number };
type Asked = { kind: 'answer'; version: Version } | { kind: 'pair'; shown: [Version, Version] };
export type Judgment = Call & { seconds: number; costUsd?: number; toolCalls?: number }
  & ({ kind: 'answer'; version: Version; output: AnswerOutput } | { kind: 'pair'; shown: [Version, Version]; output: PairOutput });

const SYSTEM = `You are a senior engineer reviewing a pull request. You cannot run the code or read the diff: all you have is the review the author attached. Answer only from what that review shows. When it does not show something, answer "cannot tell" instead of guessing.`;

const LAYOUT: Record<Version, string> = {
  A: 'The review video plays the before recording first, then the after recording.',
  B: 'The review video plays before (left) and after (right) side by side, recorded with the same steps.',
  C: 'The review video plays before (left) and after (right) side by side, recorded with the same steps. Beside the video, the author attached a receipt for each chapter.',
};

function presentation(packet: Packet, name: string): Part[] {
  const parts: Part[] = [{ text: `${name}. ${LAYOUT[packet.version]} Each step below gives its chapter, its caption, and its first, middle and last video frame${packet.version === 'C' ? ', then the receipt shown beside the video for that chapter' : ''}.` }];
  packet.steps.forEach((step, i) => {
    parts.push({ text: `${name}, step ${i + 1} of ${packet.steps.length}. Chapter: ${step.chapter}. Caption: ${step.caption}` });
    for (const frame of step.frames) parts.push({ image: frame });
    if (step.card) parts.push({ image: step.card });
  });
  return parts;
}

const header = (scenario: Scenario): Part => ({ text: `Pull request: ${scenario.title}\nAuthor's description: ${scenario.description}` });

function answerPrompt(scenario: Scenario, packet: Packet): { parts: Part[]; schema: object } {
  const questions = scenario.questions.map((q, i) => `${i + 1}. [${q.id}] ${q.question} Options: ${q.options.map(o => `"${o}"`).join(', ')}.`).join('\n');
  const parts = [header(scenario), ...presentation(packet, 'The review'), { text: `Answer these questions with exactly one of the listed options each:
${questions}

Then decide: would you approve this pull request as it is, or request changes? List every issue that should block the merge, each with one category: visible_behavior (something wrong on screen), performance (slower, or more work such as more queries or requests), error_or_warning (an error or warning, shown or logged), other. Approving means the list is empty.

Finally rate how easy this review was to take in, from 1 (hard to read or follow) to 5 (effortless).
Write your observations first, then the answers.` }];
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['observations', 'answers', 'decision', 'blocking_issues', 'legibility'],
    properties: {
      observations: { type: 'string' },
      answers: {
        type: 'object', additionalProperties: false, required: scenario.questions.map(q => q.id),
        properties: Object.fromEntries(scenario.questions.map(q => [q.id, { type: 'string', enum: q.options }])),
      },
      decision: { type: 'string', enum: ['approve', 'request_changes'] },
      blocking_issues: {
        type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['category', 'description'],
          properties: { category: { type: 'string', enum: CATEGORIES.filter(c => c !== 'none') }, description: { type: 'string' } },
        },
      },
      legibility: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    },
  };
  return { parts, schema };
}

function pairPrompt(scenario: Scenario, x: Packet, y: Packet): { parts: Part[]; schema: object } {
  const parts = [header(scenario), { text: 'The author can attach one of two reviews of this pull request, Review X or Review Y. Both show the same recordings.' },
    ...presentation(x, 'Review X'), ...presentation(y, 'Review Y'),
    { text: 'Which review lets you decide faster and more reliably whether this pull request is safe to merge? Give your reasons first, then pick X or Y.' }];
  const schema = {
    type: 'object', additionalProperties: false, required: ['reasons', 'preferred'],
    properties: { reasons: { type: 'string' }, preferred: { type: 'string', enum: ['X', 'Y'] } },
  };
  return { parts, schema };
}

async function askOpus(parts: Part[], schema: object, cwd: string) {
  const content = parts.map(part => 'text' in part ? { type: 'text', text: part.text }
    : { type: 'image', source: { type: 'base64', media_type: part.image.endsWith('.png') ? 'image/png' : 'image/jpeg', data: readFileSync(part.image).toString('base64') } });
  // A custom system prompt and no settings, MCP servers or tools keep the call to the review alone.
  // https://code.claude.com/docs/en/cli-reference
  const child = Bun.spawn(['claude', '-p', '--model', JUDGES.opus.model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--system-prompt', SYSTEM, '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--tools', '', '--no-session-persistence',
    '--json-schema', JSON.stringify(schema)], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  await child.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const result = stdout.trim().split('\n').map(line => JSON.parse(line)).findLast(event => event.type === 'result');
  if (code !== 0 || !result?.structured_output) throw new Error(`opus failed (${code}): ${stderr.slice(-500)} ${JSON.stringify(result)?.slice(0, 500)}`);
  return { output: result.structured_output, costUsd: Number(result.total_cost_usd) };
}

async function askSol(parts: Part[], schema: object, cwd: string) {
  let n = 0;
  const prompt = `${SYSTEM}\n\nDo not run commands or read files: everything you need is in this message and its attached images, which are numbered in order.\n\n` +
    parts.map(part => 'text' in part ? part.text : `[image ${++n}]`).join('\n\n');
  const images = parts.flatMap(part => 'image' in part ? ['-i', part.image] : []);
  writeFileSync(join(cwd, 'schema.json'), JSON.stringify(schema));
  const child = Bun.spawn(['codex', '-m', JUDGES.sol.model, '-c', `model_reasoning_effort=${JUDGES.sol.effort}`, 'exec', '--skip-git-repo-check', '--ephemeral',
    '-s', 'read-only', '-C', cwd, ...images, '--output-schema', join(cwd, 'schema.json'), '-o', join(cwd, 'out.json'), '--', prompt],
  { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const log = stdout + stderr;
  if (code !== 0 || !existsSync(join(cwd, 'out.json'))) throw new Error(`sol failed (${code}): ${log.slice(-800)}`);
  return { output: JSON.parse(readFileSync(join(cwd, 'out.json'), 'utf8')), toolCalls: (log.match(/^exec$/gm) ?? []).length };
}

type Task = Call & Asked & { parts: Part[]; schema: object };

// A judgment counts only while its model, prompt text, image contents and schema are unchanged.
const fingerprint = (judge: Judge, prompt: { parts: Part[]; schema: object }) =>
  Bun.hash(JSON.stringify([JUDGES[judge], SYSTEM, prompt.schema,
    prompt.parts.map(part => 'image' in part ? Bun.hash(readFileSync(part.image)).toString(36) : part.text)])).toString(36).slice(0, 8);

export const currentKeys = (scenarios: Scenario[], repeats: number) =>
  new Set(tasks(scenarios, Object.keys(JUDGES).filter(isJudge), repeats).map(task => task.key));
const isJudge = (name: string): name is Judge => name in JUDGES;

function tasks(scenarios: Scenario[], judges: Judge[], repeats: number): Task[] {
  const list: Task[] = [];
  for (const scenario of scenarios) {
    const packet = (v: Version): Packet => JSON.parse(readFileSync(join(OUT, scenario.id, v, 'packet.json'), 'utf8'));
    for (const judge of judges) for (let repeat = 1; repeat <= repeats; repeat++) {
      for (const version of ['A', 'B', 'C'] as const) {
        const prompt = answerPrompt(scenario, packet(version));
        list.push({ key: `${judge}/${scenario.id}/answer/${version}/${repeat}/${fingerprint(judge, prompt)}`, judge, scenario: scenario.id, kind: 'answer', version, repeat, ...prompt });
      }
      for (const [first, second] of PAIRS) for (const shown of [[first, second], [second, first]] as [Version, Version][]) {
        const prompt = pairPrompt(scenario, packet(shown[0]), packet(shown[1]));
        list.push({ key: `${judge}/${scenario.id}/pair/${shown.join('')}/${repeat}/${fingerprint(judge, prompt)}`, judge, scenario: scenario.id, kind: 'pair', shown, repeat, ...prompt });
      }
    }
  }
  return list;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: true,
    options: { repeats: { type: 'string', default: '3' }, concurrency: { type: 'string', default: '6' }, judges: { type: 'string', default: 'opus,sol' } },
  });
  const done = new Set(existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).key) : []);
  const judges = values.judges.split(',');
  if (!judges.every(isJudge)) throw new Error(`--judges takes a comma list of: ${Object.keys(JUDGES).join(', ')}`);
  const todo = tasks(scenarioDirs(positionals).map(loadScenario), judges, Number(values.repeats)).filter(t => !done.has(t.key));
  console.log(`${todo.length} judge calls to run (${done.size} already recorded)`);
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: Number(values.concurrency) }, async () => {
    while (next < todo.length) {
      const { parts, schema, ...task } = todo[next++]!;
      const cwd = mkdtempSync(join(tmpdir(), 'reviewability-judge-'));
      const started = performance.now();
      try {
        const answer = task.judge === 'opus' ? await askOpus(parts, schema, cwd) : await askSol(parts, schema, cwd);
        const judgment = { ...task, ...answer, seconds: Math.round((performance.now() - started) / 1000) };
        appendFileSync(RESULTS, JSON.stringify(judgment) + '\n');
        console.log(`ok ${task.key} ${judgment.seconds}s`);
      } catch (error) {
        failed++;
        console.error(`FAILED ${task.key}: ${String(error).slice(0, 600)}`);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }));
  if (failed) { console.error(`${failed} calls failed; rerun to retry them.`); process.exit(1); }
}
