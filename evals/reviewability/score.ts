#!/usr/bin/env bun
// Scores the judges' answers against each scenario's ground truth. Prints JSON; no LLM is involved.
// Usage: bun evals/reviewability/score.ts [scenario...]
import { existsSync, readFileSync } from 'node:fs';
import type { Version } from './build';
import { currentKeys, RESULTS, type AnswerOutput, type Judge, type Judgment } from './judge';
import { loadScenario, scenarioDirs, type Scenario } from './scenario';

const VERSIONS: Version[] = ['A', 'B', 'C'];
const rate = (hits: number, total: number) => total ? { rate: hits / total, hits, total } : null;
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
// The majority answer over a judge's repeats, or "tie" when no single answer leads.
const mode = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const [first, second] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return !first ? undefined : second && second[1] === first[1] ? 'tie' : first[0];
};

// The planted bug counts as caught only when an issue has its category and names it (verdict.evidence).
const names = (scenario: Scenario, issue: AnswerOutput['blocking_issues'][number]) =>
  issue.category === scenario.verdict.category && new RegExp(scenario.verdict.evidence ?? '$^', 'i').test(issue.description);
export const caught = (scenario: Scenario, a: AnswerOutput) =>
  a.decision === 'request_changes' && a.blocking_issues.some(issue => names(scenario, issue));
// A blocker that is not the planted bug: every blocker on a clean change, any other blocker on a buggy one.
const spurious = (scenario: Scenario, a: AnswerOutput) => a.blocking_issues.some(issue => !scenario.verdict.blocking || !names(scenario, issue));

export function score(names: string[] = []) {
  const scenarios = new Map(scenarioDirs(names).map(dir => loadScenario(dir)).map(s => [s.id, s]));
  const all: Judgment[] = existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const keys = currentKeys([...scenarios.values()], Math.max(0, ...all.map(j => j.repeat)));
  const judgments = all.filter(j => scenarios.has(j.scenario) && keys.has(j.key));
  const answers = judgments.flatMap(j => j.kind === 'answer' ? [{ ...j, a: j.output, s: scenarios.get(j.scenario)! }] : []);
  const pairs = judgments.flatMap(j => j.kind === 'pair' ? [j] : []);
  type Pair = (typeof pairs)[number];
  const winner = (p: Pair) => p.shown[p.output.preferred === 'X' ? 0 : 1];
  const pairOf = (p: Pair) => [...p.shown].sort().join('');

  const metrics = (subset: typeof answers) => {
    const blocking = subset.filter(x => x.s.verdict.blocking), clean = subset.filter(x => !x.s.verdict.blocking);
    const questions = subset.flatMap(x => x.s.questions.map(q => ({ kind: q.kind, ok: x.a.answers[q.id] === q.answer, given: x.a.answers[q.id] })));
    const confident = questions.filter(q => q.given !== 'cannot tell');
    return {
      bugCaught: rate(blocking.filter(x => caught(x.s, x.a)).length, blocking.length),
      falseAlarm: rate(clean.filter(x => x.a.decision === 'request_changes').length, clean.length),
      accuracy: rate(questions.filter(q => q.ok).length, questions.length),
      visibleAccuracy: rate(questions.filter(q => q.kind === 'visible' && q.ok).length, questions.filter(q => q.kind === 'visible').length),
      backendAccuracy: rate(questions.filter(q => q.kind === 'backend' && q.ok).length, questions.filter(q => q.kind === 'backend').length),
      // "cannot tell" is the honest answer to a backend question the review doesn't show, so backendAccuracy measures access, not care.
      wrongWhenConfident: rate(confident.filter(q => !q.ok).length, confident.length),
      spuriousBlocker: rate(subset.filter(x => spurious(x.s, x.a)).length, subset.length),
      legibility: mean(subset.map(x => x.a.legibility)),
      calls: subset.length,
    };
  };
  const byVersion = Object.fromEntries(VERSIONS.map(v => [v, {
    all: metrics(answers.filter(x => x.version === v)),
    opus: metrics(answers.filter(x => x.version === v && x.judge === 'opus')),
    sol: metrics(answers.filter(x => x.version === v && x.judge === 'sol')),
  }]));
  const byScenario = [...scenarios.values()].map(s => ({
    id: s.id, private: s.private, blocking: s.verdict.blocking, category: s.verdict.category,
    ...Object.fromEntries(VERSIONS.map(v => [v, metrics(answers.filter(x => x.scenario === s.id && x.version === v))])),
  }));

  // Pairwise: the share of comparisons the second version of each pair wins, over both orders.
  const preference = Object.fromEntries((['AB', 'BC'] as const).map(pair => {
    const these = pairs.filter(p => pairOf(p) === pair);
    const challenger = pair[1];
    const of = (list: Pair[]) => rate(list.filter(p => winner(p) === challenger).length, list.length);
    return [pair, {
      challenger, winRate: of(these), opus: of(these.filter(p => p.judge === 'opus')), sol: of(these.filter(p => p.judge === 'sol')),
      firstShownPicked: rate(these.filter(p => p.output.preferred === 'X').length, these.length),
      byScenario: Object.fromEntries([...scenarios.keys()].map(id => [id, of(these.filter(p => p.scenario === id))])),
    }];
  }));

  // Agreement on each judge's majority over its repeats: per question, per decision, per pairwise preference.
  type Item = { scenario: string; what: string; opus: unknown; sol: unknown; truth?: unknown; detail?: Record<Judge, string> };
  const items: Item[] = [];
  for (const s of scenarios.values()) for (const v of VERSIONS) {
    const of = (judge: Judge) => answers.filter(x => x.scenario === s.id && x.version === v && x.judge === judge);
    const [o, l] = [of('opus'), of('sol')];
    if (!o.length || !l.length) continue;
    for (const q of s.questions)
      items.push({ scenario: s.id, what: `${v} · ${q.id}`, opus: mode(o.map(x => x.a.answers[q.id] ?? "missing")), sol: mode(l.map(x => x.a.answers[q.id] ?? "missing")), truth: q.answer });
    const decision = (list: typeof o) => mode(list.map(x => x.a.decision));
    const why = (list: typeof o) => list.map(x => x.a.blocking_issues.map(i => `${i.category}: ${i.description}`).join(' / ') || 'approve').join(' | ');
    items.push({ scenario: s.id, what: `${v} · decision`, opus: decision(o), sol: decision(l), truth: s.verdict.blocking ? 'request_changes' : 'approve', detail: { opus: why(o), sol: why(l) } });
  }
  for (const s of scenarios.values()) for (const pair of ['AB', 'BC'] as const) {
    const these = (judge: Judge) => pairs.filter(p => p.scenario === s.id && p.judge === judge && pairOf(p) === pair);
    const of = (judge: Judge) => these(judge).map(winner);
    const [o, l] = [of('opus'), of('sol')];
    if (!o.length || !l.length) continue;
    const reasons = (judge: Judge) => these(judge).map(p => `${p.shown.join('→')} picked ${p.output.preferred}: ${p.output.reasons}`).join(' | ');
    items.push({ scenario: s.id, what: `prefer ${pair[0]} vs ${pair[1]}`, opus: `${pair[1]} wins ${o.filter(w => w === pair[1]).length}/${o.length}`, sol: `${pair[1]} wins ${l.filter(w => w === pair[1]).length}/${l.length}`, detail: { opus: reasons('opus'), sol: reasons('sol') } });
  }
  const agreeOn = (filter: (i: Item) => boolean, same: (i: Item) => boolean) => rate(items.filter(filter).filter(same).length, items.filter(filter).length);
  const sideOf = (x: unknown) => { const m = String(x).match(/wins (\d+)\/(\d+)/); return m ? Math.sign(2 * Number(m[1]) - Number(m[2])) : x; };
  const agreement = {
    questions: agreeOn(i => !i.what.includes('decision') && !i.what.startsWith('prefer'), i => i.opus === i.sol),
    decisions: agreeOn(i => i.what.endsWith('decision'), i => i.opus === i.sol),
    preferences: agreeOn(i => i.what.startsWith('prefer'), i => sideOf(i.opus) === sideOf(i.sol)),
  };
  // For a human to label: decisions first (no code can settle a merge call), then preferences, then questions.
  const disagreements = items.filter(i => i.what.startsWith('prefer') ? sideOf(i.opus) !== sideOf(i.sol) : i.opus !== i.sol)
    .sort((a, b) => rank(a) - rank(b)).slice(0, 10);

  // Explain the number: does C win only because the receipt states the answer?
  const receipts = [...scenarios.values()].flatMap(s => s.steps.map(step => step.receipt ?? ''));
  const verdictWords = receipts.filter(r => /n\s*\+\s*1|regress|should|block|bug|slow|problem/i.test(r)).length;
  const inference = (v: Version) => {
    const read = answers.filter(x => x.version === v && x.s.verdict.blocking && x.s.verdict.category !== 'visible_behavior'
      && x.s.questions.filter(q => q.kind === 'backend').every(q => x.a.answers[q.id] === q.answer));
    return rate(read.filter(x => caught(x.s, x.a)).length, read.length);
  };
  return {
    scenarios: [...scenarios.values()].map(s => ({ id: s.id, private: s.private, title: s.title, verdict: s.verdict })),
    byVersion, byScenario, preference, agreement, disagreements,
    explain: { receiptsWithVerdictWords: verdictWords, receipts: receipts.filter(Boolean).length, readThenBlocked: { B: inference('B'), C: inference('C') } },
    cost: {
      calls: judgments.length, opusCalls: judgments.filter(j => j.judge === 'opus').length, solCalls: judgments.filter(j => j.judge === 'sol').length,
      opusListUsd: judgments.reduce((sum, j) => sum + (j.costUsd ?? 0), 0), solToolCalls: judgments.reduce((sum, j) => sum + (j.toolCalls ?? 0), 0),
    },
  };
}

const rank = (i: { what: string }) => i.what.endsWith('decision') ? 0 : i.what.startsWith('prefer') ? 1 : 2;

if (import.meta.main) console.log(JSON.stringify(score(Bun.argv.slice(2)), null, 1));
