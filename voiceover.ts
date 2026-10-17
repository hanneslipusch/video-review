import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { APICallError, generateSpeech, type SpeechModel } from 'ai';
import { createElevenLabs } from '@ai-sdk/elevenlabs';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const style = 'Speak like a colleague walking someone through a short demo: warm, clear and natural.';

export type Voice = { provider: string; model: string; voice: string };
export type Provider = Voice & { synthesize(text: string): Promise<Uint8Array> };

// A redirect would forward the key header to another host.
const fetchOnce: typeof fetch = Object.assign((url: string | URL | Request, init?: RequestInit) =>
  fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(120_000) }), { preconnect: fetch.preconnect });

export function providers(env: typeof process.env = process.env): Provider[] {
  const list: Provider[] = [];
  if (env.GEMINI_API_KEY) {
    // https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai#speech-models
    const model = 'gemini-3.8-flash-tts';
    list.push(sdk({ provider: 'gemini', model, voice: 'Kore' }, createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY, fetch: fetchOnce }).speech(model), { instructions: style, outputFormat: 'wav' }));
  }
  if (env.AZURE_SPEECH_KEY) {
    const region = env.AZURE_SPEECH_REGION;
    if (region && /^[a-z0-9]+$/.test(region)) list.push(azure(env.AZURE_SPEECH_KEY, region));
    else process.stderr.write('AZURE_SPEECH_KEY needs AZURE_SPEECH_REGION set to its resource region, such as westeurope, so Azure is skipped.\n');
  }
  if (env.ELEVENLABS_API_KEY) {
    // https://ai-sdk.dev/providers/ai-sdk-providers/elevenlabs#speech-models
    const model = 'eleven_v4';
    const voice = env.ELEVENLABS_VOICE_ID;
    if (voice) list.push(sdk({ provider: 'elevenlabs', model, voice }, createElevenLabs({ apiKey: env.ELEVENLABS_API_KEY, fetch: fetchOnce }).speech(model), { voice: encodeURIComponent(voice), outputFormat: 'wav_24000' }));
    else process.stderr.write('ELEVENLABS_API_KEY needs ELEVENLABS_VOICE_ID, a voice your account can use, so ElevenLabs is skipped.\n');
  }
  return list;
}

export function redact(message: string): string {
  for (const key of [process.env.GEMINI_API_KEY, process.env.AZURE_SPEECH_KEY, process.env.ELEVENLABS_API_KEY])
    if (key) message = message.replaceAll(key, '[redacted]');
  return message;
}

// Cache location: https://specifications.freedesktop.org/basedir-spec/latest/
export function cachedSpeech({ provider, model, voice }: Voice, text: string): string {
  const hash = createHash('sha256').update(JSON.stringify([provider, model, voice, style, text])).digest('hex');
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'video-review', 'speech', `${hash}.wav`);
}

// Speaks and measures every line with one provider, so a review never changes voice. The provider that cached
// most of these lines goes first, so a rebuild keeps the voice `lines` timed; on any failure the next respeaks all.
export async function speakAll(voices: Provider[], texts: string[], measure: (path: string) => Promise<number>) {
  const order = (await Promise.all(voices.map(async provider => ({
    provider, cached: (await Promise.all(texts.map(text => Bun.file(cachedSpeech(provider, text)).exists()))).filter(Boolean).length,
  })))).sort((a, b) => b.cached - a.cached);
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
      const { provider: name, model, voice } = provider;
      return { voice: { provider: name, model, voice } satisfies Voice, paths, seconds };
    } catch (error) {
      // The AI SDK's message can be only the status text, such as "Unauthorized" for ElevenLabs' quota_exceeded.
      const reason = APICallError.isInstance(error) ? `HTTP ${error.statusCode} ${error.message} ${error.responseBody ?? ''}` : error instanceof Error ? error.message : String(error);
      failures.push(`${provider.provider}: ${redact(reason).replace(/\s+/g, ' ').trim().slice(0, 500).replace(/\.$/, '')}`);
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
  await mkdir(dirname(cached), { recursive: true });
  await writeFile(`${cached}.${process.pid}`, audio);
  await rename(`${cached}.${process.pid}`, cached);
  return cached;
}

// Each line is one request, and a failure falls back to the next provider instead of retrying.
function sdk(voice: Voice, model: SpeechModel, options: Partial<Parameters<typeof generateSpeech>[0]>): Provider {
  return { ...voice, synthesize: async text => (await generateSpeech({ model, text, voice: voice.voice, maxRetries: 0, ...options })).audio.uint8Array };
}

// @ai-sdk/azure appends a model to every voice name, so it reaches only HD and MAI voices, which most regions lack:
// https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions?tabs=tts
function azure(key: string, region: string): Provider {
  // A multilingual voice speaks each line in its own language: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
  const voice = 'en-US-AvaMultilingualNeural';
  return { provider: 'azure', model: 'neural', voice, async synthesize(text) {
    // REST request and output formats: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
    const response = await fetchOnce(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, { method: 'POST', headers: {
      'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'video-review',
    }, body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">${Bun.escapeHTML(text)}</voice></speak>` });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${await response.text()}`);
    return new Uint8Array(await response.arrayBuffer());
  } };
}
