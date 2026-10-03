import { expect, test } from 'bun:test';
import { parseReview, pace, chaptersVtt, renderPlayer, vttTime, vtt } from './contract';

test('wrong intervals fail before paid speech or evidence writes', () => {
  const good = { start: 0, end: 2, chapter: 'Saved value', text: 'Saved.' };
  for (const steps of [[{ ...good, end: 4 }], [{ ...good, start: -1 }], [good, { ...good, start: 1, end: 3 }], [{ ...good, end: NaN }]])
    expect(() => parseReview({ title: 'Review', steps }, 3)).toThrow('intervals');
  expect(() => parseReview({ title: 'Review', steps: [{ ...good, text: 'cue --> injection' }] }, 3)).toThrow('text');
});

test('speech never overlaps the next observation, even when the take is too short', () => {
  const [first, second] = pace([{ start: 0, end: 0.1, chapter: 'Saved value', text: 'Saved.' }, { start: 1, end: 2, chapter: 'Reloaded value', text: 'Reloaded.' }], [9, 1]);
  expect(first!.outcome).toBeCloseTo(0.1);
  expect(first!.until - first!.outcome).toBeGreaterThanOrEqual(9);
  expect(second!.at).toBe(first!.until);
  expect(second!.until - second!.outcome).toBeGreaterThanOrEqual(6);
});

test('literal template tokens and dollar sequences cannot corrupt the player', () => {
  const title = '{{DATA}} $& </script>';
  const result = renderPlayer('<title>{{TITLE}}</title>{{ASPECT}}{{NOTES}}', title, '<script>x</script> https://example.com/pull/7', '16/9', false);
  expect(result).toBe('<title>{{DATA}} $&amp; &lt;/script&gt;</title>16/9<p>&lt;script&gt;x&lt;/script&gt; <a href="https://example.com/pull/7">https://example.com/pull/7</a></p>\n');
});

test('VTT tracks preserve optional cue IDs, millisecond rounding and payloads', () => {
  expect(vttTime(86401.025)).toBe('24:00:01.025');
  expect(vtt([{ id: 1, start: 2, end: 8.3001, text: 'speech/1.m4a' }, { start: 8.3001, end: 10, text: 'thumbnails.jpg#xywh=0,0,320,240' }]))
    .toBe('WEBVTT\n\n1\n00:00:02.000 --> 00:00:08.300\nspeech/1.m4a\n\n00:00:08.300 --> 00:00:10.000\nthumbnails.jpg#xywh=0,0,320,240\n');
});

test('chapters reach the end of the media, so the player adds no unlabelled gap segment', () => {
  const [chapter] = pace([{ start: 0, end: 46.5333, chapter: 'Saved value', text: 'Saved.' }], [0]);
  expect(chapter!.until).toBeCloseTo(52.5333, 3);
  expect(chaptersVtt([chapter!])).toContain('00:00:00.000 --> 00:00:52.534\nSaved value');
  expect(chaptersVtt([{ ...chapter!, until: 17.2 }])).toContain('--> 00:00:17.200');
});

test('long chapter titles fail with the step and limit before building', () => {
  const step = { start: 0, end: 1, chapter: 'W'.repeat(20), text: 'The saved value appeared.' };
  expect(parseReview({ title: 'Review', steps: [step] }, 2).steps[0]!.chapter).toBe(step.chapter);
  expect(() => parseReview({ title: 'Review', steps: [step, { ...step, start: 1, end: 2, chapter: 'W'.repeat(21) }] }, 2)).toThrow('Step 2: chapter must be one line of 1–20 characters');
});

test('voiceover steps hold for their speech, not for caption reading time', () => {
  const steps = [{ start: 0, end: 1, chapter: 'Saved value', text: Array(20).fill('word').join(' ') }];
  const [spoken] = pace(steps, [7]);
  const [read] = pace(steps, [0]);
  expect(spoken!.until - spoken!.outcome).toBeCloseTo(8, 1);
  expect(read!.until - read!.outcome).toBeCloseTo(18, 1);
});
