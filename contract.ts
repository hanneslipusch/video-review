export const CHAPTER_LIMIT = 20;
const MIN_HOLD_SECONDS = 6, READING_SECONDS_PER_WORD = 0.9, SPEECH_TAIL_SECONDS = 1;
export type Step = { start: number; end: number; chapter: string; text: string; source?: string };
// An image step shows its still for one frame, then the usual result hold.
const STILL_SECONDS = 1 / 30;
export const isImage = (path: string) => /\.(png|jpe?g)$/i.test(path);
export type Review = { title: string; notes: string; steps: Step[] };
export type Chapter = Step & { at: number; outcome: number; until: number; speechSeconds: number };

export function parseReview(value: unknown, duration: number): Review {
  if (!value || typeof value !== 'object' || !('title' in value) || !('steps' in value))
    throw new Error('Expected {title, steps: [{start, end, chapter, text, source?}]}. See video-review build --help.');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160)
    throw new Error('title must contain 1–160 characters.');
  const notes = 'notes' in value ? value.notes : '';
  if (typeof notes !== 'string' || notes.length > 4000)
    throw new Error('notes must be Markdown of at most 4000 characters.');
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
      throw new Error(`Step ${index + 1}: an image step takes no start or end; its hold follows the caption.`);
    if (!image && (!('start' in step) || !('end' in step)))
      throw new Error(`Step ${index + 1} needs start and end.`);
    const start = image ? 0 : 'start' in step ? step.start : undefined;
    const end = image ? STILL_SECONDS : 'end' in step ? step.end : undefined;
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)
      || start < (source === undefined ? previousEnd : 0) || end <= start || end >= 86400 || (source === undefined && end > duration))
      throw new Error(source === undefined
        ? `Step ${index + 1}: intervals must be ordered, nonoverlapping, and inside 0–${duration.toFixed(3)} seconds.`
        : `Step ${index + 1}: intervals need finite 0 <= start < end < 86400; end must fit the source.`);
    if (typeof text !== 'string' || !text.trim() || text.length > 320 || /[\r\n\u0000-\u001f]|-->/.test(text))
      throw new Error(`Step ${index + 1}: text must be one line of 1–320 characters without VTT delimiters.`);
    if (typeof chapter !== 'string' || !chapter.trim() || chapter.length > CHAPTER_LIMIT || /[\r\n\u0000-\u001f]|-->/.test(chapter))
      throw new Error(`Step ${index + 1}: chapter must be one line of 1–${CHAPTER_LIMIT} characters without VTT delimiters.`);
    if (source === undefined) previousEnd = end;
    return { start, end, chapter: chapter.trim(), text: text.trim(), ...(source === undefined ? {} : { source }) };
  });
  return { title: value.title.trim(), notes: notes.trim(), steps };
}

export function pace(steps: Step[], speech: number[]): Chapter[] {
  let at = 0;
  return steps.map((step, index) => {
    const speechSeconds = speech[index];
    if (speechSeconds === undefined || !Number.isFinite(speechSeconds) || speechSeconds < 0)
      throw new Error(`Missing speech duration for step ${index + 1}.`);
    const action = Math.ceil((step.end - step.start) * 30) / 30;
    const read = speechSeconds > 0 ? speechSeconds + SPEECH_TAIL_SECONDS : step.text.split(/\s+/).length * READING_SECONDS_PER_WORD;
    const hold = Math.ceil(Math.max(MIN_HOLD_SECONDS, read) * 30) / 30;
    const chapter = { ...step, at, outcome: at + action, until: at + action + hold, speechSeconds };
    at = chapter.until;
    return chapter;
  });
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

export function renderPlayer(template: string, title: string, notes: string, aspect: string, voiceover: boolean): string {
  // Raw HTML is escaped; the page's script-src 'self' policy blocks javascript: links.
  const html = Bun.markdown.html(notes, { noHtmlBlocks: true, noHtmlSpans: true, autolinks: true });
  const VOICEOVER = voiceover ? '<track kind="metadata" label="voiceover" src="voiceover.vtt" default>' : '';
  // Voiceover pages play a silent copy; video.mp4 keeps the voice for sharing the file alone.
  const VIDEO = voiceover ? 'player.mp4' : 'video.mp4';
  const tokens = { TITLE: Bun.escapeHTML(title), NOTES: html, ASPECT: aspect, VOICEOVER, VIDEO };
  return template.replace(/\{\{(TITLE|NOTES|ASPECT|VOICEOVER|VIDEO)\}\}/g, (_, token: keyof typeof tokens) => tokens[token]);
}
