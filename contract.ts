import { PLAYBACK_RATE } from './rate';

export const CHAPTER_LIMIT = 20, FPS = 30;
// Netflix's adult reading speed and shortest subtitle event, in watching time at PLAYBACK_RATE:
// https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide
// https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements
const READING_CHARACTERS_PER_SECOND = 17, SHORTEST_LINE_SECONDS = 5 / 6, SPEECH_TAIL_SECONDS = 0.5;
// An image step has no interval: it carries start 0 and end 1, and shows for as long as its line needs.
type Step = { start: number; end: number; chapter: string; text: string; source?: string; notes?: string };
export const isImage = (path: string) => /\.(png|jpe?g)$/i.test(path);
type Review = { title: string; steps: Step[] };
type Chapter = Step & { at: number; until: number; speechSeconds: number };

export function parseReview(value: unknown, duration: number): Review {
  if (!value || typeof value !== 'object' || !('title' in value) || !('steps' in value))
    throw new Error('Expected {title, steps: [{start, end, chapter, text, source?, notes?}]}. See video-review build --help.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160)
    throw new Error('title must contain 1–160 characters.');
  if (!Array.isArray(value.steps) || !value.steps.length)
    throw new Error('steps must be a nonempty array.');
  let previousEnd = 0;
  const steps = value.steps.map((step: unknown, index: number): Step => {
    if (!step || typeof step !== 'object' || !('chapter' in step) || !('text' in step))
      throw new Error(`Step ${index + 1} needs chapter and text.`);
    const { chapter, text } = step;
    const source = localPath(step, 'source', index), notes = localPath(step, 'notes', index);
    const image = source !== undefined && isImage(source);
    if (image && ('start' in step || 'end' in step))
      throw new Error(`Step ${index + 1}: an image step takes no start or end; it shows for as long as its line needs.`);
    if (!image && (!('start' in step) || !('end' in step)))
      throw new Error(`Step ${index + 1} needs start and end.`);
    const start = image ? 0 : 'start' in step ? step.start : undefined;
    const end = image ? 1 : 'end' in step ? step.end : undefined;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < (source === undefined ? previousEnd : 0) || end <= start || end >= 86400 || (source === undefined && end > duration))
      throw new Error(source === undefined
        ? `Step ${index + 1}: intervals must be ordered, nonoverlapping, and inside 0–${duration.toFixed(3)} seconds.`
        : `Step ${index + 1}: intervals need finite 0 <= start < end < 86400; end must fit the source.`);
    checkLine(text, index);
    if (typeof chapter !== 'string' || !chapter.trim() || chapter.length > CHAPTER_LIMIT || /[\r\n\u0000-\u001f]|-->/.test(chapter))
      throw new Error(`Step ${index + 1}: chapter must be one line of 1–${CHAPTER_LIMIT} characters without VTT delimiters.`);
    if (source === undefined) previousEnd = end;
    return { start, end, chapter: chapter.trim(), text: text.trim(), ...(source === undefined ? {} : { source }), ...(notes === undefined ? {} : { notes }) };
  });
  return { title: value.title.trim(), steps };
}

function localPath(step: object, name: 'source' | 'notes', index: number) {
  const path: unknown = name in step ? Reflect.get(step, name) : undefined;
  if (path !== undefined && (typeof path !== 'string' || !path.trim() || /[\u0000-\u001f]/.test(path)))
    throw new Error(`Step ${index + 1}: ${name} must be a nonempty local file path.`);
  return path;
}

function checkLine(text: unknown, index: number): asserts text is string {
  if (typeof text !== 'string' || !text.trim() || text.length > 320 || /[\r\n\u0000-\u001f]|-->/.test(text))
    throw new Error(`Step ${index + 1}: text must be one line of 1–320 characters without VTT delimiters.`);
}

// Lines alone, to time a recording before it exists.
export function parseLines(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('steps' in value) || !Array.isArray(value.steps) || !value.steps.length)
    throw new Error('Expected {steps: [{text}]}. See video-review build --help.');
  return value.steps.map((step: unknown, index: number) => {
    const text = step && typeof step === 'object' && 'text' in step ? step.text : undefined;
    checkLine(text, index);
    return text.trim();
  });
}

export const lineSeconds = (text: string, speechSeconds: number) =>
  Math.ceil((speechSeconds > 0 ? speechSeconds + SPEECH_TAIL_SECONDS
    : Math.max(SHORTEST_LINE_SECONDS, text.length / READING_CHARACTERS_PER_SECOND) * PLAYBACK_RATE) * FPS - 1e-9) / FPS;

export function pace(steps: Step[], speech: number[]): Chapter[] {
  let at = 0;
  const short: string[] = [];
  const chapters = steps.map((step, index) => {
    const speechSeconds = speech[index]!;
    const needed = lineSeconds(step.text, speechSeconds);
    const footage = step.source !== undefined && isImage(step.source) ? needed : Math.round((step.end - step.start) * FPS) / FPS;
    if (footage < needed - 1e-6) short.push(`Step ${index + 1}: its line needs ${needed.toFixed(1)} s; its footage is ${footage.toFixed(1)} s.`);
    const chapter = { ...step, at, until: at + footage, speechSeconds };
    at = chapter.until;
    return chapter;
  });
  if (short.length) throw new Error(`${short.join('\n')}\nWiden each interval to footage that still shows the step, or shorten its line.`);
  return chapters;
}

function vttTime(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const parts = [Math.floor(milliseconds / 3600000), Math.floor(milliseconds / 60000) % 60, Math.floor(milliseconds / 1000) % 60];
  return parts.map(value => String(value).padStart(2, '0')).join(':') + '.' + String(milliseconds % 1000).padStart(3, '0');
}

// settings apply to every cue, such as "position:40% size:80%": https://www.w3.org/TR/webvtt1/#cue-settings
export function vtt(cues: { start: number; end: number; text: string; id?: number }[], settings = ''): string {
  return `WEBVTT\n\n${cues.map(({ start, end, text, id }) =>
    `${id === undefined ? '' : `${id}\n`}${vttTime(start)} --> ${vttTime(end)}${settings && ` ${settings}`}\n${text}\n`).join('\n')}`;
}

export function chaptersVtt(chapters: Chapter[]): string {
  // Round edges up, so the last chapter reaches the end of the media and the player adds no unlabelled segment.
  const edge = (seconds: number) => Math.ceil(seconds * 1000 - 1e-6) / 1000;
  return vtt(chapters.map((s, i) => ({ id: i + 1, start: edge(s.at), end: edge(s.until), text: s.chapter })));
}

// A step's note as the page drawn beside its footage. Raw HTML shows as text, so a logged <Tag> stays visible.
// Options: https://bun.com/docs/runtime/markdown
export const notePage = (chapter: string, markdown: string, background: string) => `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:24px;font:24px/1.45 system-ui,sans-serif;color:#20302a;background:${background}}
article{padding:20px 22px;border:2px solid #e1e5e0;border-radius:16px;background:#fff}
h2{margin:0 0 16px;font-size:20px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#5c6a60}
p,ul,ol,pre,table{margin:0 0 18px}article>:last-child{margin-bottom:0}ul,ol{padding-left:30px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:8px 12px 8px 0;border-bottom:2px solid #e9ece8;text-align:left;vertical-align:top}th{font-weight:600}
code{font:20px/1.45 ui-monospace,monospace;overflow-wrap:anywhere}pre{padding:10px 12px;border-radius:10px;background:#f3f5f2;white-space:pre-wrap}
</style><article><h2>${Bun.escapeHTML(chapter)}</h2>${Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true, autolinks: true })}</article>`;

// The page keeps today's player height for a wider frame: 1120 px wide, less its padding, at 16:9.
export function renderPlayer(template: string, title: string, width: number, height: number) {
  const divisor = (a: number, b: number): number => b ? divisor(b, a % b) : a;
  const values: Record<string, string> = {
    TITLE: Bun.escapeHTML(title), ASPECT: `${width / divisor(width, height)}/${height / divisor(width, height)}`,
    PAGE: String(Math.round(48 + 1072 * 9 / 16 * width / height)),
  };
  return template.replace(/\{\{(TITLE|ASPECT|PAGE)\}\}/g, (_, key: string) => values[key]!);
}
