#!/usr/bin/env bun
// Builds versions A (before, then after), B (side by side) and C (B plus a per-chapter receipt) of every scenario,
// and the packet each judge sees. Usage: bun evals/reviewability/build.ts [scenario...]
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CHAPTER_LIMIT, lineSeconds } from '../../contract';
import { loadScenario, scenarioDirs, type Clip, type Scenario } from './scenario';

export const OUT = resolve(import.meta.dir, '../results/reviewability');
const CLI = resolve(import.meta.dir, '../../bin/video-review');
export const VERSIONS = ['A', 'B', 'C'] as const;
export type Version = (typeof VERSIONS)[number];
export type PacketStep = { chapter: string; caption: string; frames: string[]; receipt?: string; card?: string };
export type Packet = { scenario: string; version: Version; title: string; description: string; steps: PacketStep[] };

function run(cmd: string[]) {
  const result = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')}\n${result.stderr}${result.stdout}`);
  return result.stdout.toString();
}

const label = (side: 'Before' | 'After', chapter: string) => {
  const name = `${side}: ${chapter}`;
  if (name.length > CHAPTER_LIMIT) throw new Error(`Chapter "${chapter}" is too long for "${side}: ".`);
  return name;
};

type BuildStep = { chapter: string; text: string; source: string; start?: number; end?: number };

function sequential(scenario: Scenario): BuildStep[] {
  const side = (which: 'before' | 'after') => scenario.steps.filter(step => step[which]).map(step => ({
    chapter: label(which === 'before' ? 'Before' : 'After', step.chapter),
    text: (which === 'before' ? step.beforeText : step.afterText) ?? `${which === 'before' ? 'Before' : 'After'}: ${step.text}`,
    ...clip(scenario, step[which]!),
  }));
  return [...side('before'), ...side('after'), ...images(scenario)];
}

const clip = (scenario: Scenario, c: Clip) => ({ source: join(scenario.dir, c.source), start: c.start, end: c.end });
const images = (scenario: Scenario) => scenario.steps.filter(step => step.image)
  .map(step => ({ chapter: step.chapter, text: step.text, source: join(scenario.dir, step.image!) }));

// Before on the left, after on the right, each at half width under a label; the shorter side holds its last frame.
function sideBySide(scenario: Scenario, dir: string): BuildStep[] {
  mkdirSync(join(dir, 'clips'), { recursive: true });
  return scenario.steps.map((step, index) => {
    if (step.image) return { chapter: step.chapter, text: step.text, source: join(scenario.dir, step.image) };
    const sides = (['before', 'after'] as const).filter(side => step[side]);
    const out = join(dir, 'clips', `${index + 1}.mp4`);
    const length = (c: Clip) => c.end - c.start;
    const duration = Math.max(...sides.map(side => length(step[side]!)), lineSeconds(step.text, 0) + 0.1);
    const inputs = sides.flatMap(side => ['-ss', String(step[side]!.start), '-t', String(length(step[side]!)), '-i', join(scenario.dir, step[side]!.source)]);
    const text = (name: string, x: number) =>
      `drawtext=text='${name}':fontsize=56:fontcolor=0x1f2933:x=${x}+(960-text_w)/2:y=190`;
    const half = (i: number) => `[${i}:v]scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2:white,fps=30,tpad=stop_mode=clone:stop_duration=${duration}[v${i}]`;
    const filter = sides.length === 2
      ? `${half(0)};${half(1)};[v0][v1]hstack,pad=1920:1080:0:270:white,${text('Before', 0)},${text('After', 960)}`
      : `${half(0)};[v0]pad=1920:1080:480:270:white,${text(sides[0] === 'before' ? 'Before' : 'After', 480)}`;
    run(['ffmpeg', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-t', String(duration), '-an', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
    return { chapter: step.chapter, text: step.text, source: out, start: 0, end: Math.floor(duration * 10) / 10 };
  });
}

function buildReview(dir: string, title: string, steps: BuildStep[]) {
  mkdirSync(dir, { recursive: true });
  const stepsFile = join(dir, 'steps.json');
  writeFileSync(stepsFile, JSON.stringify({
    title, steps: steps.map(({ source, ...step }) => ({ ...step, source: relative(dir, source) })),
  }, null, 1));
  const main = steps.find(step => step.start !== undefined)!.source;
  run([CLI, 'build', main, stepsFile, '--out', join(dir, 'review'), '--captions-only']);
}

// Full-size first, middle and last frames of each step, as a reviewer sees them in the player.
function frames(dir: string): { chapter: string; caption: string; frames: string[] }[] {
  const timeline = JSON.parse(readFileSync(join(dir, 'review/timeline.json'), 'utf8'));
  mkdirSync(join(dir, 'frames'), { recursive: true });
  return timeline.steps.map((step: { chapter: string; text: string; at: number; until: number }, index: number) => {
    const times = [step.at + 0.1, (step.at + step.until) / 2, step.until - 0.15];
    const paths = times.map((time, i) => {
      const path = join(dir, 'frames', `${index + 1}-${['first', 'middle', 'last'][i]}.jpg`);
      run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', time.toFixed(3), '-i', join(dir, 'review/video.mp4'), '-frames:v', '1', '-q:v', '3', path]);
      return path;
    });
    return { chapter: step.chapter, caption: step.text, frames: paths };
  });
}

const CARD_CSS = `body{margin:0;font:22px/1.45 system-ui,sans-serif;color:#1f2933;background:#fff}
.card{padding:22px 28px;width:900px}h2{font-size:24px;margin:0 0 12px}
table{border-collapse:collapse;width:100%;margin-bottom:12px}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #e3e6ea;vertical-align:top}
th{background:#f3f4f6}code{font:19px ui-monospace,monospace;background:#f3f4f6;padding:1px 4px;border-radius:4px}p{margin:6px 0}ul{margin:6px 0;padding-left:22px}pre{margin:6px 0;padding:8px 10px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap}pre code{padding:0}`;
export const receiptHtml = (chapter: string, markdown: string) =>
  `<div class="card"><h2>${Bun.escapeHTML(chapter)}</h2>${Bun.markdown.html(markdown, { tables: true })}</div>`;

async function cards(scenario: Scenario, dir: string): Promise<(string | undefined)[]> {
  mkdirSync(join(dir, 'cards'), { recursive: true });
  const server = Bun.serve({ hostname: '0.0.0.0', port: 0, fetch: async req => { const file = Bun.file(join(dir, 'cards', new URL(req.url).pathname)); return await file.exists() ? new Response(file) : new Response(null, { status: 404 }); } });
  const session = `reviewability-cards-${process.pid}`;
  // Async: the card server runs on this process's event loop.
  const browser = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (await child.exited !== 0) throw new Error(`agent-browser ${args.join(' ')}: ${await new Response(child.stderr).text()}`);
  };
  try {
    await browser('set', 'viewport', '960', '600');
    const paths: (string | undefined)[] = [];
    for (const [index, step] of scenario.steps.entries()) {
      if (!step.receipt) { paths.push(undefined); continue; }
      writeFileSync(join(dir, 'cards', `${index + 1}.html`), `<!doctype html><meta charset="utf-8"><style>${CARD_CSS}</style>${receiptHtml(step.chapter, step.receipt)}`);
      // agent-browser's Chrome may run in a container; it reaches a host server on 0.0.0.0 as host.docker.internal.
      await browser('open', `http://host.docker.internal:${server.port}/${index + 1}.html`);
      const path = join(dir, 'cards', `${index + 1}.png`);
      await browser('screenshot', '--full', path);
      paths.push(path);
    }
    return paths;
  } finally {
    await browser('close');
    server.stop(true);
  }
}

// The throwaway C page: B's player with the chapter's receipt beside it.
function prototype(dir: string, scenario: Scenario) {
  const timeline = JSON.parse(readFileSync(join(dir, '../B/review/timeline.json'), 'utf8'));
  const chapters = timeline.steps.map((step: { at: number; until: number }, i: number) => ({
    at: step.at, until: step.until, html: scenario.steps[i]!.receipt ? receiptHtml(scenario.steps[i]!.chapter, scenario.steps[i]!.receipt!) : '',
  }));
  writeFileSync(join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${Bun.escapeHTML(scenario.title)}</title>
<style>${CARD_CSS}body{background:#f6f7f9;padding:16px}.wrap{display:grid;grid-template-columns:minmax(0,3fr) minmax(320px,1.15fr);gap:16px;align-items:start}
video{width:100%;background:#000;border-radius:8px}.card{width:auto;border-radius:8px;box-shadow:0 1px 3px #0002;font-size:17px}code{font-size:15px}
h1{font-size:22px;margin:0 0 12px}</style>
<h1>${Bun.escapeHTML(scenario.title)}</h1><div class="wrap"><video controls playsinline src="../B/review/video.mp4">
<track kind="captions" src="../B/review/captions.vtt" default></video><aside id="receipt"></aside></div>
<script>const chapters=${JSON.stringify(chapters)};const video=document.querySelector('video'),aside=document.getElementById('receipt');
const show=()=>{const t=video.currentTime;const c=chapters.find(c=>t>=c.at&&t<c.until)??chapters.at(-1);aside.innerHTML=c.html};
video.addEventListener('timeupdate',show);video.addEventListener('loadedmetadata',()=>{video.playbackRate=1.5;show()});show();</script>`);
}

if (import.meta.main) {
  for (const dir of scenarioDirs(Bun.argv.slice(2))) {
    const scenario = loadScenario(dir);
    const root = join(OUT, scenario.id);
    rmSync(root, { recursive: true, force: true });
    buildReview(join(root, 'A'), scenario.title, sequential(scenario));
    buildReview(join(root, 'B'), scenario.title, sideBySide(scenario, join(root, 'B')));
    const packet = (version: Version, steps: PacketStep[]): Packet =>
      ({ scenario: scenario.id, version, title: scenario.title, description: scenario.description, steps });
    const a = frames(join(root, 'A')), b = frames(join(root, 'B'));
    const c = await cards(scenario, join(root, 'C'));
    prototype(join(root, 'C'), scenario);
    for (const [version, steps] of [['A', a], ['B', b], ['C', b.map((step, i) => ({ ...step, receipt: scenario.steps[i]!.receipt, card: c[i] }))]] as const)
      writeFileSync(join(root, version, 'packet.json'), JSON.stringify(packet(version, steps as PacketStep[]), null, 1));
    console.log(scenario.id, 'A', a.length, 'B', b.length, 'C cards', c.filter(Boolean).length);
  }
}
