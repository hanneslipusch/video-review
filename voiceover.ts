import { writeFile } from 'node:fs/promises';

export const tts = { model: 'gemini-3.8-flash-tts', voice: 'Kore' };

export async function speak(text: string, path: string, key: string): Promise<void> {
  // REST schema and WAV format: https://ai.google.dev/gemini-api/docs/speech-generation
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: tts.model,
      input: [{ type: 'user_input', content: [{ type: 'text', text,
        annotations: [{ type: 'speech_metadata', style: 'Speak like a colleague walking someone through a short demo: warm, clear and natural.' }],
      }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav' },
      generation_config: { speech_config: [{ voice: tts.voice }] },
    }),
  });
  if (!response.ok) {
    const reason = /"message":\s*"([^"]+)"/.exec(await response.text())?.[1]?.trim().replace(/\.$/, '');
    throw new Error(`Gemini TTS returned HTTP ${response.status}${reason ? `: ${reason}` : ''}. Check GEMINI_API_KEY, model access and quota in Google AI Studio.`);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || !('steps' in result) || !Array.isArray(result.steps))
    throw new Error('Gemini TTS returned no output steps.');
  let audio: string | undefined;
  for (const step of result.steps) {
    if (!step || typeof step !== 'object' || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (block && typeof block === 'object' && block.type === 'audio' && typeof block.data === 'string') audio = block.data;
    }
  }
  if (!audio || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw new Error('Gemini TTS returned no valid base64 audio.');
  const wav = Buffer.from(audio, 'base64');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Gemini TTS returned audio without the documented WAV header.');
  await writeFile(path, wav);
}
