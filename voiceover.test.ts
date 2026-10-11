import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cachedSpeech, speak } from './voiceover';

test('an unchanged line reuses its cached speech without calling Gemini', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-review-speech-'));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    const wav = Buffer.from('RIFF\0\0\0\0WAVEcached');
    await mkdir(dirname(cachedSpeech('The list kept both items.')), { recursive: true });
    await writeFile(cachedSpeech('The list kept both items.'), wav);
    expect(await readFile(await speak('The list kept both items.', 'invalid-key'))).toEqual(wav);
    expect(cachedSpeech('The list kept one item.')).not.toBe(cachedSpeech('The list kept both items.'));
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
