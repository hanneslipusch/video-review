#!/usr/bin/env bun
// Records each generic scenario's before and after with the same steps, and writes the receipt its spans give.
// Usage: bun evals/reviewability/record.ts [scenario...]
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lineSeconds } from '../../contract';
import { HALF, loadScenario, scenarioDirs, type Side, type Receipt, type Request } from './scenario';

const APP = join(import.meta.dir, 'app');
const SESSION = `reviewability-${process.pid}`;

function browser(...args: string[]) {
  const run = Bun.spawnSync(['agent-browser', '--session', SESSION, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`agent-browser ${args.join(' ')}: ${run.stderr.toString()}${run.stdout.toString()}`);
}

async function record(dir: string, side: Side) {
  const variant = loadScenario(dir)[side]?.variant;
  if (variant === undefined) throw new Error(`${dir} has no ${side} variant to record.`);
  const scenario = loadScenario(dir);
  const work = mkdtempSync(join(tmpdir(), 'reviewability-'));
  const spansFile = join(work, 'spans.jsonl');
  const port = 8800 + Math.floor(Math.random() * 400);
  // agent-browser's Chrome may run in a container; it reaches a host service on 0.0.0.0 as host.docker.internal.
  const url = `http://host.docker.internal:${port}`;
  const app = Bun.spawn(['uv', 'run', '--frozen', 'uvicorn', 'app:app', '--host', '0.0.0.0', '--port', String(port), '--log-level', 'warning'], {
    cwd: APP, stdout: 'inherit', stderr: 'inherit',
    env: { ...process.env, VARIANT: variant, SEED: '1', DB_FILE: join(work, 'app.sqlite'), SPANS_FILE: spansFile },
  });
  try {
    for (let i = 0; !(await fetch(`http://127.0.0.1:${port}`).then(r => r.ok, () => false)); i++) {
      if (i > 100) throw new Error('app did not start');
      await Bun.sleep(100);
    }
    browser('set', 'viewport', String(HALF.width), String(HALF.height));
    browser('open', 'about:blank');
    const video = join(dir, `${side}.webm`);
    browser('record', 'start', video);
    const origin = performance.now();
    const windows: { start: number; end: number; wallStart: number; wallEnd: number }[] = [];
    for (const step of scenario.steps) {
      const start = (performance.now() - origin) / 1000, wallStart = Date.now();
      for (const action of step.actions ?? []) browser(...action.map(arg => arg.replace('{url}', url)));
      // The longest line any version shows for this step (A prefixes "Before: "), plus a second to look.
      const hold = lineSeconds(`Before: ${step.text}`, 0) + 1 - ((performance.now() - origin) / 1000 - start);
      await Bun.sleep(Math.max(0, hold) * 1000);
      windows.push({ start, end: (performance.now() - origin) / 1000, wallStart, wallEnd: Date.now() });
    }
    browser('record', 'stop');
    await Bun.sleep(300);
    // The recorder sometimes appends minutes of junk frames after stop; keep only the steps.
    const trimmed = join(dir, `${side}.trimmed.webm`);
    const trim = Bun.spawnSync(['ffmpeg', '-loglevel', 'error', '-i', video, '-t', String(windows.at(-1)!.end), '-c', 'copy', '-an', trimmed], { stderr: 'pipe' });
    if (trim.exitCode !== 0) throw new Error(`ffmpeg trim ${video}: ${trim.stderr.toString()}`);
    renameSync(trimmed, video);
    return { windows: windows.map(({ start, end }) => ({ start: tenth(start), end: tenth(end) })), requests: requestsByStep(spansFile, windows) };
  } finally {
    app.kill();
    await app.exited;
    rmSync(work, { recursive: true, force: true });
  }
}

// Down, so the last window never ends past the trimmed recording.
const tenth = (seconds: number) => Math.floor(seconds * 10) / 10;

type Span = { name: string; context: { trace_id: string }; parent_id: string | null; start_time: string; end_time: string; attributes: Record<string, unknown> };

function requestsByStep(spansFile: string, windows: { wallStart: number; wallEnd: number }[]): Request[][] {
  const spans: Span[] = readFileSync(spansFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const time = (iso: string) => Date.parse(iso);
  const roots = spans.filter(s => s.parent_id === null && 'http.route' in s.attributes);
  return windows.map(({ wallStart, wallEnd }) => roots
    .filter(root => time(root.start_time) >= wallStart && time(root.start_time) < wallEnd)
    .sort((a, b) => time(a.start_time) - time(b.start_time))
    .map(root => {
      const trace = spans.filter(s => s.context.trace_id === root.context.trace_id);
      const sql = trace.filter(s => s.attributes['db.system'] === 'sqlite').map(s => String(s.attributes['db.statement']));
      const repeated = Object.entries(Object.groupBy(sql, s => s)).filter(([, list]) => list!.length > 1)
        .map(([statement, list]) => ({ statement, count: list!.length }));
      // Logfire levels: warn is 13, error 17. https://github.com/pydantic/logfire/blob/main/logfire/_internal/constants.py
      const logs = trace.filter(s => Number(s.attributes['logfire.level_num'] ?? 0) >= 13)
        .map(s => `${Number(s.attributes['logfire.level_num']) >= 17 ? 'ERROR' : 'WARN'} ${s.attributes['logfire.msg']}`);
      return {
        request: root.name,
        status: Number(root.attributes['http.status_code'] ?? root.attributes['http.response.status_code']),
        sql: sql.length, ms: Math.round(time(root.end_time) - time(root.start_time)), repeated, logs,
      };
    }));
}

for (const dir of scenarioDirs(Bun.argv.slice(2)).filter(dir => existsSync(join(dir, 'scenario.json')) && loadScenario(dir).before)) {
  const before = await record(dir, 'before'), after = await record(dir, 'after');
  const receipt: Receipt = { before: before.requests, after: after.requests, windows: { before: before.windows, after: after.windows } };
  writeFileSync(join(dir, 'recording.json'), JSON.stringify(receipt, null, 1) + '\n');
  console.log(dir, JSON.stringify(receipt.windows));
}
browser('close');
