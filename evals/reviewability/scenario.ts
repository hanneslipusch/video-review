import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Side = 'before' | 'after';
export type Clip = { source: string; start: number; end: number };
export type Request = { request: string; status: number; sql: number; ms: number; repeated: { statement: string; count: number }[]; logs: string[] };
export type Receipt = { before: Request[][]; after: Request[][]; windows: Record<Side, { start: number; end: number }[]> };
export type Question = { id: string; kind: 'visible' | 'backend'; question: string; options: string[]; answer: string };
export type Step = {
  chapter: string; text: string;
  // Version A shows each side on its own; without these it prefixes text with "Before: " or "After: ".
  beforeText?: string; afterText?: string;
  actions?: string[][]; before?: Clip; after?: Clip; image?: string; receipt?: string;
};
export type Scenario = {
  id: string; dir: string; private: boolean; title: string; description: string;
  before?: { variant: string }; after?: { variant: string };
  steps: Step[];
  // evidence: a pattern an issue's description must match to count as naming the planted bug.
  verdict: { blocking: boolean; category: Category; why: string; evidence?: string };
  questions: Question[];
};
export const CATEGORIES = ['visible_behavior', 'performance', 'error_or_warning', 'other', 'none'] as const;
export type Category = (typeof CATEGORIES)[number];

const ROOT = resolve(import.meta.dir, '../..');
const PUBLIC = join(ROOT, 'evals/reviewability/scenarios'), PRIVATE = join(ROOT, 'evals-private/reviewability');

export function scenarioDirs(names: string[] = []): string[] {
  const dirs = [PUBLIC, PRIVATE].filter(existsSync)
    .flatMap(root => readdirSync(root).map(name => join(root, name)))
    .filter(dir => existsSync(join(dir, 'scenario.json')));
  return names.length ? dirs.filter(dir => names.some(name => dir.endsWith(`/${name}`))) : dirs;
}

export function loadScenario(dir: string): Scenario {
  const scenario = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
  const id = dir.split('/').at(-1)!;
  const recording = join(dir, 'recording.json');
  if (existsSync(recording)) {
    const receipt: Receipt = JSON.parse(readFileSync(recording, 'utf8'));
    scenario.steps = scenario.steps.map((step: Step, i: number) => ({
      ...step,
      before: { source: 'before.webm', ...receipt.windows.before[i]! },
      after: { source: 'after.webm', ...receipt.windows.after[i]! },
      receipt: receiptMarkdown(receipt.before[i]!, receipt.after[i]!),
    }));
  }
  return { ...scenario, id, dir, private: dir.startsWith(PRIVATE) };
}

const cell = (r?: Request) => r ? `${r.status} · ${r.sql} SQL · ${r.ms} ms` : '—';

// The receipt states measurements only; it never names a verdict such as "N+1" or "regression".
export function receiptMarkdown(before: Request[], after: Request[]): string {
  const names = [...new Set([...before, ...after].map(r => r.request))];
  const rows = names.map(name => `| \`${name}\` | ${cell(before.find(r => r.request === name))} | ${cell(after.find(r => r.request === name))} |`);
  const repeated = (side: Request[]) => side.flatMap(r => r.repeated.map(x => `\`${x.statement}\` ×${x.count}`));
  const logs = (side: Request[]) => side.flatMap(r => r.logs.map(log => `\`${r.request}\`: ${log}`));
  const list = (items: string[]) => items.length ? items.join('; ') : 'none';
  return [
    '| Request | Before | After |', '| --- | --- | --- |', ...rows, '',
    `**Repeated SQL** before: ${list(repeated(before))}. After: ${list(repeated(after))}.`, '',
    `**Warnings and errors** before: ${list(logs(before))}. After: ${list(logs(after))}.`,
  ].join('\n');
}
