import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { APICallError, generateSpeech, type SpeechModel } from 'ai';
import { createElevenLabs } from '@ai-sdk/elevenlabs';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const style = 'Speak like a colleague walking someone through a short demo: warm, clear and natural.';

export type Voice = { provider: string; model: string; voice: string };
export type Provider = Voice & { synthesize(text: string): Promise<Uint8Array> };

// A redirect would forward the key header to another host.
function fetchOnce(url: string | URL | Request, init?: RequestInit) {
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120_000) });
}
// The AI SDK types its fetch option as Bun's fetch, which has preconnect.
fetchOnce.preconnect = fetch.preconnect;

export function providers(): Provider[] {
  const env = process.env, list: Provider[] = [];
  if (env.GEMINI_API_KEY) {
    // https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai#speech-models
    const voice = { provider: 'gemini', model: 'gemini-3.8-flash-tts', voice: 'Kore' };
    const model = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY, fetch: fetchOnce }).speech(voice.model);
    list.push(sdk(voice, model, { instructions: style, outputFormat: 'wav' }));
  }
  if (env.AZURE_SPEECH_KEY) {
    // The region becomes the host name that receives the key.
    const region = env.AZURE_SPEECH_REGION ?? '';
    if (/^[a-z0-9]+$/i.test(region)) list.push(azure(env.AZURE_SPEECH_KEY, region));
    else process.stderr.write('AZURE_SPEECH_KEY needs AZURE_SPEECH_REGION set to its resource region, such as westeurope, so Azure is skipped.\n');
  }
  if (env.ELEVENLABS_API_KEY) {
    if (env.ELEVENLABS_VOICE_ID) {
      // https://ai-sdk.dev/providers/ai-sdk-providers/elevenlabs#speech-models; the SDK puts the voice ID in the URL path unencoded.
      const voice = { provider: 'elevenlabs', model: 'eleven_v4', voice: encodeURIComponent(env.ELEVENLABS_VOICE_ID) };
      const model = createElevenLabs({ apiKey: env.ELEVENLABS_API_KEY, fetch: fetchOnce }).speech(voice.model);
      list.push(sdk(voice, model, { outputFormat: 'wav_24000' }));
    } else process.stderr.write('ELEVENLABS_API_KEY needs ELEVENLABS_VOICE_ID, a voice your account can use, so ElevenLabs is skipped.\n');
  }
  return list;
}

export function redact(message: string): string {
  for (const key of [process.env.GEMINI_API_KEY, process.env.AZURE_SPEECH_KEY, process.env.ELEVENLABS_API_KEY])
    if (key) message = message.replaceAll(key, '[redacted]');
  return message;
}

// Cache location: https://specifications.freedesktop.org/basedir-spec/latest/
const speechDir = () => join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'video-review', 'speech');

export function cachedSpeech({ provider, model, voice }: Voice, text: string): string {
  const hash = createHash('sha256').update(JSON.stringify([provider, model, voice, style, text])).digest('hex');
  return join(speechDir(), `${hash}.wav`);
}

// Speaks and measures every line with one provider, so a review never changes voice. The provider that cached
// most of these lines goes first, so a rebuild keeps the voice `lines` timed; on any failure the next respeaks all.
export async function speakAll(voices: Provider[], texts: string[], measure: (path: string) => Promise<number>) {
  const order = (await Promise.all(voices.map(async provider => ({
    provider, cached: (await Promise.all(texts.map(text => Bun.file(cachedSpeech(provider, text)).exists()))).filter(Boolean).length,
  })))).sort((a, b) => b.cached - a.cached);
  await mkdir(speechDir(), { recursive: true });
  const failures: string[] = [];
  for (const [index, { provider }] of order.entries()) {
    try {
      const paths: string[] = [], seconds: number[] = [];
      for (const [line, text] of texts.entries()) {
        process.stderr.write(`Voiceover ${line + 1}/${texts.length} (${provider.provider})\n`);
        const path = await speak(provider, text);
        seconds.push(await measure(path).catch(async (error: unknown) => { await rm(path, { force: true }); throw error; }));
        paths.push(path);
      }
      const { synthesize: _, ...voice } = provider;
      return { voice, paths, seconds };
    } catch (error) {
      failures.push(`${provider.provider}: ${reason(error)}`);
      const next = order[index + 1]?.provider;
      if (next) process.stderr.write(`${failures.at(-1)}. Speaking every line with ${next.provider} instead.\n`);
    }
  }
  throw new Error(`${failures.join('. ')}. Build with --captions-only, deliver it, and tell the user what to fix for a voiceover.`);
}

async function speak(provider: Provider, text: string): Promise<string> {
  const cached = cachedSpeech(provider, text);
  if (await Bun.file(cached).exists()) return cached;
  const audio = await provider.synthesize(text);
  await writeFile(`${cached}.${process.pid}`, audio);
  await rename(`${cached}.${process.pid}`, cached);
  return cached;
}

// The AI SDK's message can be only the status text, such as "Unauthorized" for ElevenLabs' quota_exceeded.
// Decoding the JSON body first lets redact() find a key the body escapes.
function reason(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  if (APICallError.isInstance(error)) {
    let body = error.responseBody ?? '';
    try { body = JSON.stringify(JSON.parse(body)); } catch { /* not JSON */ }
    message = [error.statusCode && `HTTP ${error.statusCode}`, message, body].filter(Boolean).join(' ');
  }
  return redact(message).replace(/\s+/g, ' ').trim().slice(0, 500).replace(/\.$/, '');
}

function sdk(voice: Voice, model: SpeechModel, options: Pick<Parameters<typeof generateSpeech>[0], 'instructions' | 'outputFormat'>): Provider {
  return { ...voice, synthesize: async text => (await generateSpeech({ model, text, voice: voice.voice, maxRetries: 0, ...options })).audio.uint8Array };
}

// @ai-sdk/azure appends a model to every voice name, so it reaches only HD and MAI voices, which most regions lack:
// https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=tts
function azure(key: string, region: string): Provider {
  // A multilingual voice speaks each line in its own language: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
  const voice = 'en-US-AvaMultilingualNeural';
  // REST request and output formats: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
  return { provider: 'azure', model: 'neural', voice, async synthesize(text) {
    const response = await fetchOnce(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'video-review' },
      body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">${Bun.escapeHTML(text)}</voice></speak>`,
    });
    if (!response.ok) throw new APICallError({ message: response.statusText, url: response.url, requestBodyValues: {}, statusCode: response.status, responseBody: await response.text() });
    return response.bytes();
  } };
}
