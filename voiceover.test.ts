import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cachedSpeech, speakAll, type Provider } from './voiceover';

const wav = (tag: string) => Buffer.from(`RIFF\0\0\0\0WAVE${tag}`);
const fake = (provider: string, synthesize: (text: string) => Promise<Buffer>): Provider => ({ provider, model: 'm', voice: 'v', synthesize });
const unreachable = async (): Promise<Buffer> => { throw new Error('called a provider'); };

let previous: string | undefined, dir: string;
beforeEach(async () => {
  previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir = await mkdtemp(join(tmpdir(), 'video-review-speech-'));
});
afterEach(async () => {
  if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  await rm(dir, { recursive: true, force: true });
});

test('each provider and voice caches its own speech', () => {
  const line = 'The list kept both items.';
  expect(cachedSpeech({ provider: 'azure', model: 'm', voice: 'v' }, line)).not.toBe(cachedSpeech({ provider: 'gemini', model: 'm', voice: 'v' }, line));
  expect(cachedSpeech({ provider: 'gemini', model: 'm', voice: 'Puck' }, line)).not.toBe(cachedSpeech({ provider: 'gemini', model: 'm', voice: 'v' }, line));
});

test('a provider with every line cached speaks the review without any request', async () => {
  const lines = ['Save.', 'Done.'], azure = fake('azure', unreachable), asked: string[] = [];
  for (const line of lines) {
    await mkdir(dirname(cachedSpeech(azure, line)), { recursive: true });
    await writeFile(cachedSpeech(azure, line), wav(line));
  }
  const spoken = await speakAll([fake('gemini', async text => { asked.push(text); return wav(text); }), azure], lines);
  expect(asked).toEqual([]);
  expect(spoken.voice.provider).toBe('azure');
  expect(await Promise.all(spoken.paths.map(path => readFile(path)))).toEqual(lines.map(wav));
});

test('a provider failing midway hands every line to the next one', async () => {
  const asked: string[] = [];
  const gemini = fake('gemini', async text => { if (text === 'Done.') throw new Error('gemini returned HTTP 429.'); return wav(text); });
  const azure = fake('azure', async text => { asked.push(text); return wav(text); });
  const spoken = await speakAll([gemini, azure], ['Save.', 'Done.']);
  expect(spoken.voice.provider).toBe('azure');
  expect(asked).toEqual(['Save.', 'Done.']);
  expect(spoken.paths).toEqual(['Save.', 'Done.'].map(line => cachedSpeech(azure, line)));
});

test('audio without a WAV header is not cached, and the error names every failure', async () => {
  const mp3 = fake('elevenlabs', async () => Buffer.from('ID3\x04mp3 frames'));
  const quota = fake('gemini', async () => { throw new Error('gemini returned HTTP 429.'); });
  await expect(speakAll([mp3, quota], ['Save.'])).rejects.toThrow(/elevenlabs returned audio without a WAV header\. gemini returned HTTP 429\./);
  expect(await Bun.file(cachedSpeech(mp3, 'Save.')).exists()).toBe(false);
});
