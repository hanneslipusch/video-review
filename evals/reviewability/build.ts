#!/usr/bin/env bun
// Builds versions A (before, then after), B (side by side) and C (B with each chapter's receipt as its notes) of every scenario,
// and the packet each judge sees. Usage: bun evals/reviewability/build.ts [scenario...]
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CHAPTER_LIMIT, lineSeconds } from '../../contract';
import { HALF, LABEL_BAND, loadScenario, scenarioDirs, type Clip, type Scenario } from './scenario';

export const OUT = resolve(import.meta.dir, '../results/reviewability');
const CLI = resolve(import.meta.dir, '../../bin/video-review');
export const VERSIONS = ['A', 'B', 'C'] as const;
export type Version = (typeof VERSIONS)[number];
export type PacketStep = { chapter: string; caption: string; frames: string[] };
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

type BuildStep = { chapter: string; text: string; source: string; start?: number; end?: number; notes?: string };

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

// Before on the left, after on the right, each at its recorded size under a small label; the shorter side holds its last frame.
function sideBySide(scenario: Scenario, dir: string): BuildStep[] {
  mkdirSync(join(dir, 'clips'), { recursive: true });
  return scenario.steps.map((step, index) => {
    if (step.image) return { chapter: step.chapter, text: step.text, source: join(scenario.dir, step.image) };
    const sides = (['before', 'after'] as const).filter(side => step[side]);
    const out = join(dir, 'clips', `${index + 1}.mp4`);
    const length = (c: Clip) => c.end - c.start;
    const duration = Math.max(...sides.map(side => length(step[side]!)), lineSeconds(step.text, 0) + 0.1);
    const inputs = sides.flatMap(side => ['-ss', String(step[side]!.start), '-t', String(length(step[side]!)), '-i', join(scenario.dir, step[side]!.source)]);
    const text = (side: string, x: number) =>
      `drawtext=text='${side === 'before' ? 'Before' : 'After'}':fontsize=24:fontcolor=0x52606d:x=${x}+(${HALF.width}-text_w)/2:y=(${LABEL_BAND}-24)/2`;
    const half = (i: number) => `[${i}:v]scale=${HALF.width}:${HALF.height}:force_original_aspect_ratio=decrease,pad=${HALF.width}:${HALF.height}:(ow-iw)/2:0:white,fps=30,tpad=stop_mode=clone:stop_duration=${duration}[v${i}]`;
    const filter = sides.length === 2
      ? `${half(0)};${half(1)};[v0][v1]hstack,pad=1920:1080:0:${LABEL_BAND}:white,${text('before', 0)},${text('after', HALF.width)}`
      : `${half(0)};[v0]pad=1920:1080:${HALF.width / 2}:${LABEL_BAND}:white,${text(sides[0]!, HALF.width / 2)}`;
    run(['ffmpeg', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', filter, '-t', String(duration), '-an', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
    return { chapter: step.chapter, text: step.text, source: out, start: 0, end: Math.floor(duration * 10) / 10 };
  });
}

function buildReview(dir: string, title: string, steps: BuildStep[]) {
  mkdirSync(dir, { recursive: true });
  const stepsFile = join(dir, 'steps.json');
  writeFileSync(stepsFile, JSON.stringify({
    title, steps: steps.map(({ source, notes, ...step }) => ({ ...step, source: relative(dir, source), ...(notes ? { notes: relative(dir, notes) } : {}) })),
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

if (import.meta.main) {
  for (const dir of scenarioDirs(Bun.argv.slice(2))) {
    const scenario = loadScenario(dir);
    const root = join(OUT, scenario.id);
    rmSync(root, { recursive: true, force: true });
    buildReview(join(root, 'A'), scenario.title, sequential(scenario));
    const b = sideBySide(scenario, join(root, 'B'));
    buildReview(join(root, 'B'), scenario.title, b);
    mkdirSync(join(root, 'C/notes'), { recursive: true });
    buildReview(join(root, 'C'), scenario.title, b.map((step, i) => {
      const receipt = scenario.steps[i]!.receipt;
      if (!receipt) return step;
      writeFileSync(join(root, 'C/notes', `${i + 1}.md`), receipt);
      return { ...step, notes: join(root, 'C/notes', `${i + 1}.md`) };
    }));
    const packet = (version: Version, steps: PacketStep[]): Packet =>
      ({ scenario: scenario.id, version, title: scenario.title, description: scenario.description, steps });
    for (const version of VERSIONS)
      writeFileSync(join(root, version, 'packet.json'), JSON.stringify(packet(version, frames(join(root, version))), null, 1));
    console.log(scenario.id, 'built A, B and C');
  }
}
