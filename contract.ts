import { PLAYBACK_RATE } from './rate';

export const CHAPTER_LIMIT = 20, FPS = 30;
// Netflix's adult reading speed and shortest subtitle event, in watching time at PLAYBACK_RATE:
// https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide
// https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements
const READING_CHARACTERS_PER_SECOND = 17, SHORTEST_LINE_SECONDS = 5 / 6, SPEECH_TAIL_SECONDS = 0.5;
// An image step has no interval; it shows for as long as its line needs.
export type Step = { start: number; end: number; chapter: string; text: string; source?: string };
export const isImage = (path: string) => /\.(png|jpe?g)$/i.test(path);
export type Review = { title: string; steps: Step[] };
export type Chapter = Step & { at: number; until: number; speechSeconds: number };

export function parseReview(value: unknown, duration: number): Review {
  if (!value || typeof value !== 'object' || !('title' in value) || !('steps' in value))
    throw new Error('Expected {title, steps: [{start, end, chapter, text, source?}]}. See video-review build --help.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160)
    throw new Error('title must contain 1–160 characters.');
  if (!Array.isArray(value.steps) || !value.steps.length)
    throw new Error('steps must be a nonempty array.');
  let previousEnd = 0;
  const steps = value.steps.map((step: unknown, index: number): Step => {
    if (!step || typeof step !== 'object' || !('chapter' in step) || !('text' in step))
      throw new Error(`Step ${index + 1} needs chapter and text.`);
    const { chapter, text } = step;
    const source = 'source' in step ? step.source : undefined;
    if (source !== undefined && (typeof source !== 'string' || !source.trim() || /[\u0000-\u001f]/.test(source)))
      throw new Error(`Step ${index + 1}: source must be a nonempty local file path.`);
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
    return { start, end, chapter: chapter.trim(), text: (text as string).trim(), ...(source === undefined ? {} : { source }) };
  });
  return { title: value.title.trim(), steps };
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
    const speechSeconds = speech[index];
    if (speechSeconds === undefined || !Number.isFinite(speechSeconds) || speechSeconds < 0)
      throw new Error(`Missing speech duration for step ${index + 1}.`);
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

export function vttTime(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const parts = [Math.floor(milliseconds / 3600000), Math.floor(milliseconds / 60000) % 60, Math.floor(milliseconds / 1000) % 60];
  return parts.map(value => String(value).padStart(2, '0')).join(':') + '.' + String(milliseconds % 1000).padStart(3, '0');
}

export function vtt(cues: { start: number; end: number; text: string; id?: number }[]): string {
  return `WEBVTT\n\n${cues.map(({ start, end, text, id }) =>
    `${id === undefined ? '' : `${id}\n`}${vttTime(start)} --> ${vttTime(end)}\n${text}\n`).join('\n')}`;
}

export function chaptersVtt(chapters: Chapter[]): string {
  const edge = (seconds: number) => Math.ceil(seconds * 1000 - 1e-6) / 1000;
  return vtt(chapters.map((s, i) => ({ id: i + 1, start: edge(s.at), end: edge(s.until), text: s.chapter })));
}

export const renderPlayer = (template: string, title: string) =>
  template.replace(/\{\{TITLE\}\}/g, () => Bun.escapeHTML(title));
