import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APICallError } from 'ai';
import { cachedSpeech, speakAll, type Provider } from './voiceover';

const wav = (tag: string) => Buffer.from(`RIFF\0\0\0\0WAVE${tag}`);
const fake = (provider: string, synthesize: (text: string) => Promise<Buffer>): Provider => ({ provider, model: 'm', voice: 'v', synthesize });
const recorder = (provider: string, asked: string[]) => fake(provider, async text => { asked.push(text); return wav(text); });
const measure = async (path: string) => (await readFile(path, 'utf8')).includes('broken') ? Promise.reject(new Error('Cannot read a duration.')) : 1;

let previous: string | undefined, dir: string;
beforeEach(async () => {
  previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir = await mkdtemp(join(tmpdir(), 'video-review-speech-'));
});
afterEach(async () => {
  if (previous === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous;
  await rm(dir, { recursive: true, force: true });
});

test('each provider, model, voice and line caches its own speech', () => {
  const base = { provider: 'gemini', model: 'm', voice: 'v' }, line = 'The list kept both items.';
  const paths = [base, { ...base, provider: 'azure' }, { ...base, model: 'n' }, { ...base, voice: 'Puck' }].map(voice => cachedSpeech(voice, line));
  expect(new Set([...paths, cachedSpeech(base, 'The list kept one item.')]).size).toBe(5);
});

test('the provider that cached most lines speaks the review, requesting only the changed line', async () => {
  const gemini: string[] = [], azure: string[] = [];
  await speakAll([recorder('azure', [])], ['Save.'], measure);
  const spoken = await speakAll([recorder('gemini', gemini), recorder('azure', azure)], ['Save.', 'Done.'], measure);
  expect([spoken.voice.provider, gemini, azure]).toEqual(['azure', [], ['Done.']]);
});

test('a provider failing midway hands every line to the next one', async () => {
  const asked: string[] = [];
  const gemini = fake('gemini', async text => { if (text === 'Done.') throw new Error('gemini returned HTTP 429.'); return wav(text); });
  const azure = recorder('azure', asked);
  const spoken = await speakAll([gemini, azure], ['Save.', 'Done.'], measure);
  expect([spoken.voice.provider, asked, spoken.seconds]).toEqual(['azure', ['Save.', 'Done.'], [1, 1]]);
  expect(spoken.paths).toEqual(['Save.', 'Done.'].map(line => cachedSpeech(azure, line)));
});

test('audio without a duration is not kept, and the error gives each reason without a key', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { GEMINI_API_KEY: 'g-secret', AZURE_SPEECH_KEY: 'a-secret', ELEVENLABS_API_KEY: 'e-secret' });
  try {
    const broken = fake('azure', async () => wav('broken'));
    const quota = fake('elevenlabs', async () => { throw new APICallError({ message: 'Unauthorized', url: 'https://api.elevenlabs.io', requestBodyValues: {}, statusCode: 401,
      responseBody: '{"code": "quota_exceeded", "keys": "g-secret a\\u002dsecret e-secret"}' }); });
    await expect(speakAll([broken, quota], ['Save.'], measure)).rejects.toThrow(
      'azure: Cannot read a duration. elevenlabs: HTTP 401 Unauthorized {"code":"quota_exceeded","keys":"[redacted] [redacted] [redacted]"}. Build with --captions-only');
    expect(await Bun.file(cachedSpeech(broken, 'Save.')).exists()).toBe(false);
  } finally {
    for (const name of ['GEMINI_API_KEY', 'AZURE_SPEECH_KEY', 'ELEVENLABS_API_KEY']) if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
});
