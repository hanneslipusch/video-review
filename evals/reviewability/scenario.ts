import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Side = 'before' | 'after';
// Each side is recorded at the size it shows in the 1920×1080 side-by-side frame, under a band for its label, so its text stays at native size.
export const LABEL_BAND = 40, HALF = { width: 960, height: 1080 - LABEL_BAND };
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

const change = (before: number | string | undefined, after: number | string | undefined, unit = '') =>
  before === after ? `${after}${unit}` : `${before ?? '—'} → ${after ?? '—'}${unit}`;

// The receipt states measurements only; it never names a verdict such as "N+1" or "regression".
// Status shows only when it changes, time only when it moves past local jitter (2× and 20 ms),
// and repeated queries and log lines as a diff of the sides.
export function receiptMarkdown(before: Request[], after: Request[]): string {
  const names = [...new Set([...before, ...after].map(r => r.request))];
  const pairs = names.map(name => [name, before.find(r => r.request === name), after.find(r => r.request === name)] as const);
  const slower = (b?: Request, a?: Request) => !!b && !!a && Math.abs(a.ms - b.ms) >= 20 && Math.max(a.ms, b.ms) >= 2 * Math.min(a.ms, b.ms);
  const status = pairs.some(([, b, a]) => b?.status !== a?.status);
  const time = pairs.some(([, b, a]) => slower(b, a));
  const table = [
    `| Request |${status ? ' Status |' : ''} Queries |${time ? ' Time |' : ''}`, `| --- |${status ? ' --- |' : ''} --- |${time ? ' --- |' : ''}`,
    ...pairs.map(([name, b, a]) => `| \`${name}\` |${status ? ` ${change(b?.status, a?.status)} |` : ''} ${change(b?.sql, a?.sql)} |${time ? ` ${slower(b, a) ? change(b?.ms, a?.ms, ' ms') : ''} |` : ''}`),
  ];
  const diff = (title: string, b: string[], a: string[]) => {
    const lines = [...b.filter(x => !a.includes(x)).map(x => `- ${x}`), ...a.filter(x => !b.includes(x)).map(x => `+ ${x}`)];
    return lines.length ? ['', `**${title}**`, '', '```diff', ...lines, '```'] : [];
  };
  const repeated = (side: Request[]) => side.flatMap(r => r.repeated.map(x => `${x.count}× ${x.statement}`));
  const logs = (side: Request[]) => [...new Set(side.flatMap(r => r.logs))];
  return [
    ...table,
    ...diff('Repeated queries', repeated(before), repeated(after)),
    ...diff('Log lines', logs(before), logs(after)),
  ].join('\n');
}
