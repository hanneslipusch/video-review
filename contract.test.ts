import { expect, test } from 'bun:test';
import { parseReview, parseLines, pace, chaptersVtt, renderPlayer, vtt } from './contract';

test('wrong intervals fail before paid speech or evidence writes', () => {
  const good = { start: 0, end: 2, chapter: 'Saved value', text: 'Saved.' };
  for (const steps of [[{ ...good, end: 4 }], [{ ...good, start: -1 }], [good, { ...good, start: 1, end: 3 }], [{ ...good, end: NaN }]])
    expect(() => parseReview({ title: 'Review', steps }, 3)).toThrow('intervals');
  expect(() => parseReview({ title: 'Review', steps: [{ ...good, text: 'cue --> injection' }] }, 3)).toThrow('text');
});

test('literal template tokens and dollar sequences cannot corrupt the player', () => {
  const title = '{{ASPECT}} $& </script>';
  const result = renderPlayer('<title>{{TITLE}}</title><h1>{{TITLE}}</h1>{{ASPECT}} {{PAGE}}', title, 1920, 1080);
  expect(result).toBe('<title>{{ASPECT}} $&amp; &lt;/script&gt;</title><h1>{{ASPECT}} $&amp; &lt;/script&gt;</h1>16/9 1120');
});

test('VTT tracks preserve optional cue IDs, millisecond rounding and payloads', () => {
  expect(vtt([{ id: 1, start: 2, end: 8.3001, text: 'speech/1.m4a' }, { start: 8.3001, end: 86401.025, text: 'thumbnails.jpg#xywh=0,0,320,240' }]))
    .toBe('WEBVTT\n\n1\n00:00:02.000 --> 00:00:08.300\nspeech/1.m4a\n\n00:00:08.300 --> 24:00:01.025\nthumbnails.jpg#xywh=0,0,320,240\n');
});

test('chapters reach the end of the media, so the player adds no unlabelled gap segment', () => {
  const [chapter] = pace([{ start: 0, end: 46.5333, chapter: 'Saved value', text: 'Saved.' }], [0]);
  expect(chapter!.until).toBeCloseTo(46.5333, 3);
  expect(chaptersVtt([chapter!])).toContain('00:00:00.000 --> 00:00:46.534\nSaved value');
  expect(chaptersVtt([{ ...chapter!, until: 17.2 }])).toContain('--> 00:00:17.200');
});

test('long chapter titles fail with the step and limit before building', () => {
  const step = { start: 0, end: 1, chapter: 'W'.repeat(20), text: 'The saved value appeared.' };
  expect(parseReview({ title: 'Review', steps: [step] }, 2).steps[0]!.chapter).toBe(step.chapter);
  expect(() => parseReview({ title: 'Review', steps: [step, { ...step, start: 1, end: 2, chapter: 'W'.repeat(21) }] }, 2)).toThrow('Step 2: chapter must be one line of 1–20 characters');
});

test('a step shows only its own footage, and the build names every step too short for its line', () => {
  const step = { start: 0, end: 4, chapter: 'Saved value', text: 'The saved value appeared.' };
  const [shown, card] = pace([step, { ...step, source: 'card.png', start: 0, end: 1 }], [0, 6]);
  expect([shown!.at, shown!.until, card!.until - card!.at]).toEqual([0, 4, 6.5]);
  expect(() => pace([step, { ...step, start: 4, end: 5 }, { ...step, start: 5, end: 6 }], [0, 0, 2]))
    .toThrow('Step 2: its line needs 2.2 s; its footage is 1.0 s.\nStep 3: its line needs 2.5 s; its footage is 1.0 s.');
  expect(parseLines({ steps: [{ text: ' Saved. ' }] })).toEqual(['Saved.']);
});
