import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const style = 'Speak like a colleague walking someone through a short demo: warm, clear and natural.';

export type Voice = { provider: string; model: string; voice: string };
export type Provider = Voice & { synthesize(text: string): Promise<Buffer> };

// Every provider whose settings are complete, in the order a build tries them.
export function providers(env: typeof process.env = process.env): Provider[] {
  const list: Provider[] = [];
  if (env.GEMINI_API_KEY) list.push(gemini(env.GEMINI_API_KEY));
  if (env.AZURE_SPEECH_KEY) {
    if (/^[a-z0-9]+$/.test(env.AZURE_SPEECH_REGION ?? '')) list.push(azure(env.AZURE_SPEECH_KEY, env.AZURE_SPEECH_REGION!));
    else process.stderr.write('AZURE_SPEECH_KEY needs AZURE_SPEECH_REGION, the resource region such as westeurope, so Azure is skipped.\n');
  }
  if (env.ELEVENLABS_API_KEY) {
    if (env.ELEVENLABS_VOICE_ID) list.push(elevenlabs(env.ELEVENLABS_API_KEY, env.ELEVENLABS_VOICE_ID));
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

// Speaks every line with one provider, so a review never changes voice. A provider that has every line
// cached goes first, so a build keeps the voice `lines` timed; on any failure the next provider respeaks all.
export async function speakAll(voices: Provider[], texts: string[]): Promise<{ voice: Voice; paths: string[] }> {
  const cached = await Promise.all(voices.map(async p => (await Promise.all(texts.map(t => Bun.file(cachedSpeech(p, t)).exists()))).every(Boolean)));
  const order = [...voices.filter((_, i) => cached[i]), ...voices.filter((_, i) => !cached[i])];
  const failures: string[] = [];
  for (const [index, provider] of order.entries()) {
    try {
      const paths: string[] = [];
      for (const [line, text] of texts.entries()) {
        process.stderr.write(`Voiceover ${line + 1}/${texts.length} (${provider.provider})\n`);
        paths.push(await speak(provider, text));
      }
      const { provider: name, model, voice } = provider;
      return { voice: { provider: name, model, voice }, paths };
    } catch (error) {
      failures.push(redact(error instanceof Error ? error.message : String(error)));
      const next = order[index + 1];
      if (next) process.stderr.write(`${failures.at(-1)} Speaking every line with ${next.provider} instead.\n`);
    }
  }
  throw new Error(`${failures.join(' ')} Build with --captions-only, deliver it, and tell the user what to fix for a voiceover.`);
}

async function speak(provider: Provider, text: string): Promise<string> {
  const cached = cachedSpeech(provider, text);
  if (await Bun.file(cached).exists()) return cached;
  const wav = await provider.synthesize(text);
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`${provider.provider} returned audio without a WAV header.`);
  await mkdir(dirname(cached), { recursive: true });
  await writeFile(`${cached}.${process.pid}`, wav);
  await rename(`${cached}.${process.pid}`, cached);
  return cached;
}

async function post(provider: string, url: string, headers: Record<string, string>, body: string): Promise<Response> {
  // A redirect would forward the key header to another host.
  const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (response.ok) return response;
  const reason = /"message":\s*"([^"]+)"/.exec(await response.text())?.[1]?.trim().replace(/\.$/, '').slice(0, 200);
  throw new Error(`${provider} returned HTTP ${response.status}${reason ? `: ${reason}` : ''}.`);
}

function gemini(key: string): Provider {
  const model = 'gemini-3.8-flash-tts', voice = 'Kore';
  return { provider: 'gemini', model, voice, async synthesize(text) {
    // REST schema and WAV format: https://ai.google.dev/gemini-api/docs/speech-generation
    const response = await post('gemini', 'https://generativelanguage.googleapis.com/v1beta/interactions', { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, JSON.stringify({
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice }] },
    }));
    const result: unknown = await response.json();
    let audio: string | undefined;
    if (result && typeof result === 'object' && 'steps' in result && Array.isArray(result.steps)) for (const step of result.steps) {
      if (!step || typeof step !== 'object' || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
      for (const block of step.content) if (block && typeof block === 'object' && block.type === 'audio' && typeof block.data === 'string') audio = block.data;
    }
    if (!audio) throw new Error('gemini returned no audio.');
    return Buffer.from(audio, 'base64');
  } };
}

function azure(key: string, region: string): Provider {
  // A multilingual voice speaks each line in its own language: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts
  const voice = 'en-US-AvaMultilingualNeural';
  return { provider: 'azure', model: 'neural', voice, async synthesize(text) {
    // REST request and output formats: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
    const response = await post('azure', `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      'Ocp-Apim-Subscription-Key': key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm', 'User-Agent': 'video-review',
    }, `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">${Bun.escapeHTML(text)}</voice></speak>`);
    return Buffer.from(await response.arrayBuffer());
  } };
}

function elevenlabs(key: string, voice: string): Provider {
  const model = 'eleven_v4';
  return { provider: 'elevenlabs', model, voice, async synthesize(text) {
    // Create speech; WAV below 44.1 kHz works on every plan: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
    const response = await post('elevenlabs', `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=wav_24000`,
      { 'xi-api-key': key, 'Content-Type': 'application/json' }, JSON.stringify({ text, model_id: model }));
    return Buffer.from(await response.arrayBuffer());
  } };
}
