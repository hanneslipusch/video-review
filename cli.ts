#!/usr/bin/env bun
import { mkdir, mkdtemp, readdir, realpath, rename, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { assets, template } from './assets.generated';
import { speak, tts } from './voiceover';
import { parseArgs } from 'node:util';
const FRAME_STEP = 0.5;
import { CHAPTER_LIMIT, isImage, lineSeconds, parseLines, parseReview, pace, vtt, chaptersVtt, renderPlayer } from './contract';

const help = `video-review — turn an existing recording into a captioned review

  video-review build <video> <steps.json> --out <directory>
  video-review build --help
  video-review frames <video> --out <directory>
  video-review lines <steps.json> [--voiceover]

Example:
  video-review frames recording.webm --out frames
  video-review build recording.webm steps.json --out review

frames writes one image every ${FRAME_STEP} s of the recording, named by its second (0003.5.jpg),
and sheet-1.jpg, sheet-2.jpg… with 12 labelled frames each, to find the steps at a glance.
Sheets are too small for text: open the full frame at each step's end before writing its caption.
lines prints the seconds each step's line needs, so a recording made for the review can wait that long on each step.

The recorder, verification, hosting and sharing belong to your workflow.`;
const buildHelp = `${help}

Input: {"title":"Saved settings","steps":[{"start":0,"end":3,"chapter":"Saved value","text":"The saved value appeared."}]}
chapter is a short label of 1–${CHAPTER_LIMIT} characters; text is the caption and, with --voiceover, the spoken line.
Optional source names another video or a PNG/JPG card, relative to steps.json. Steps without it use <video>
and stay ordered; other videos use their own clock and may repeat or reorder. An image step has no start or end:
{"source":"what-changed.png","chapter":"What changed","text":"Watch the attachment when the model switches."}
Every source fits a 1920×1080 frame, with bars where its shape differs.
Seconds refer to the source media clock. Each interval plays at original speed, captioned and spoken
for its whole length, and must last as long as its line needs: the build names each step that is too short.
An image step shows for as long as its line needs.

--out <directory>  Required; replaces a review built here before, refuses any other folder.
--voiceover        Add a voiceover. Use it when the reviewer will listen rather than read, such as
                   a demo for people outside the work; skip it for routine evidence.
--help             Show the input contract and example before recording.

--voiceover needs GEMINI_API_KEY from https://aistudio.google.com/apikey for direct Gemini TTS.
Speech is cached in $XDG_CACHE_HOME/video-review/speech (default ~/.cache), so a rebuild requests only changed lines.
Outputs: index.html, video.mp4, preview.gif (captioned, at 2.5×, for pages that cannot play video), poster.jpg,
captions.vtt, chapters.vtt, thumbnails.vtt, thumbnails.jpg, timeline.json, and frames/*.jpg: per step, its first,
middle and last frame with the caption as shown. --voiceover adds the speech to video.mp4.
Source audio is removed. Inputs are never changed.
Success prints one JSON object listing the frames. Read each; if one does not show what its caption says, fix steps.json and build again.
Exit 0: built, 1: runtime failure, 2: usage.`;

const PREVIEW_RATE = 2.5;

function requireFFmpeg() {
  for (const tool of ['ffmpeg', 'ffprobe'])
    if (!Bun.which(tool)) throw new Error(`${tool} not found on PATH. Install FFmpeg: https://ffmpeg.org/download.html`);
}

async function run(command: string[], cwd?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${command[0]} failed (${code}): ${Buffer.concat(stderr).toString().trim()}`));
      else resolve(Buffer.concat(stdout).toString());
    });
  });
}

async function probe(path: string, video = false): Promise<{ seconds: number; width: number; height: number }> {
  const data = JSON.parse(await run(['ffprobe', '-v', 'error', ...(video ? ['-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration'] : ['-show_entries', 'format=duration']), '-of', 'json', path]));
  const { width = 0, height = 0 } = data.streams?.[0] ?? {};
  if (video && !width) throw new Error('Input contains no video stream.');
  const seconds = Number(data.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 86400)
    throw new Error(`Cannot read a positive media duration below 24 hours: ${basename(path)}`);
  return { seconds, width, height };
}

async function sha256(path: string): Promise<string> {
  const hasher = createHash('sha256');
  for await (const chunk of createReadStream(path)) hasher.update(chunk);
  return hasher.digest('hex');
}

async function build(video: string, input: string, destination: string, voiceover: boolean) {
  requireFFmpeg();
  const source = await realpath(video);
  const target = resolve(destination);
  const main = await probe(source, true);
  const review = parseReview(JSON.parse(await readFile(input, 'utf8')), main.seconds);
  const media = new Map<string, { path: string; image: boolean; seconds: number; sha256: string }>();
  const stepSources: string[] = [];
  for (const [index, step] of review.steps.entries()) {
    const path = step.source === undefined ? source : await realpath(resolve(dirname(resolve(input)), step.source));
    if (!media.has(path)) {
      const image = isImage(path);
      if (image) {
        const data: { streams?: { codec_name: string; width: number }[] } = JSON.parse(await run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', path]));
        const stream = data.streams?.[0];
        if (!stream?.width || !['png', 'mjpeg'].includes(stream.codec_name)) throw new Error(`Invalid PNG/JPG image: ${basename(path)}`);
      }
      media.set(path, { path, image, seconds: image ? Infinity : (path === source ? main : await probe(path, true)).seconds, sha256: await sha256(path) });
    }
    if (step.end > media.get(path)!.seconds)
      throw new Error(`Step ${index + 1}: end exceeds ${basename(path)} duration.`);
    stepSources.push(path);
  }
  await run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=2x2:d=0.04', '-c:v', 'libx264', '-f', 'null', '-']);
  const key = process.env.GEMINI_API_KEY;
  if (voiceover && !key) throw new Error('Set GEMINI_API_KEY from https://aistudio.google.com/apikey, or build without --voiceover for a captions-only review.');
  const existing = await readdir(target).catch(() => null);
  if (existing?.length && !existing.includes('timeline.json'))
    throw new Error(`${target} exists and is not a video-review output. Choose another --out directory.`);
  // Build beside the target, so a failed rebuild keeps the previous review.
  const output = `${target}.partial-${process.pid}`;
  await mkdir(dirname(target), { recursive: true });
  await mkdir(output);
  let complete = false;
  try {
    await mkdir(join(output, 'frames'));
    const lengths: number[] = [];
    for (const [index, step] of review.steps.entries()) {
      if (!voiceover) { lengths.push(0); continue; }
      process.stderr.write(`Voiceover ${index + 1}/${review.steps.length}\n`);
      await speak(step.text, join(output, `speech-${index}.wav`), key!);
      lengths.push((await probe(join(output, `speech-${index}.wav`))).seconds);
    }
    const timeline = pace(review.steps, lengths);
    const total = timeline.at(-1)!.until;
    const videoPath = join(output, 'video.mp4');
    // Keep buffered chapters when color metadata changes: https://ffmpeg.org/ffmpeg.html#Advanced-options
    const sources = [...media.values()];
    const args = ['ffmpeg', '-v', 'error'];
    for (const media of sources) args.push(...(media.image ? ['-loop', '1', '-framerate', '30'] : []), '-reinit_filter:v', '0', '-i', media.path);
    if (voiceover) for (const [index] of timeline.entries()) args.push('-i', join(output, `speech-${index}.wav`));
    // A 16:9 frame fills common screens in fullscreen; every source fits inside it.
    const width = 1920, height = 1080;
    const filters: string[] = [];
    // One encode avoids concatenated AAC priming offsets: https://ffmpeg.org/ffmpeg-filters.html#concat
    for (const [inputIndex, media] of sources.entries()) {
      const indices = stepSources.flatMap((path, i) => path === media.path ? [i] : []);
      filters.push(`[${inputIndex}:v]split=${indices.length}${indices.map(i => `[source${i}]`).join('')}`);
    }
    for (const [index, step] of timeline.entries()) {
      const length = step.until - step.at;
      // Non-square pixels widen to their display shape first; the clone pad only fills a frame lost to rounding.
      filters.push(`[source${index}]trim=start=${step.start}:end=${step.start + length},setpts=PTS-STARTPTS,fps=30,scale=trunc(iw*sar/2)*2:ih,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=0.1,trim=duration=${length},setpts=PTS-STARTPTS[v${index}]`);
      if (voiceover) filters.push(`[${sources.length + index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad,atrim=duration=${length},asetpts=PTS-STARTPTS[a${index}]`);
    }
    filters.push(`${timeline.map((_, i) => `[v${i}]${voiceover ? `[a${i}]` : ''}`).join('')}concat=n=${timeline.length}:v=1:a=${voiceover ? 1 : 0}[v]${voiceover ? '[a]' : ''}`);
    await run([...args, '-filter_complex_threads', '2', '-filter_complex', filters.join(';'), '-map', '[v]', ...(voiceover ? ['-map', '[a]'] : ['-an']), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '24', '-pix_fmt', 'yuv420p', ...(voiceover ? ['-c:a', 'aac', '-b:a', '96k'] : []), '-movflags', '+faststart', videoPath]);
    for (const [index] of timeline.entries()) if (voiceover) await rm(join(output, `speech-${index}.wav`));
    const rendered = await probe(videoPath, true);
    if (Math.abs(rendered.seconds - total) > 0.1)
      throw new Error(`Rendered duration ${rendered.seconds.toFixed(3)}s differs from the planned ${total.toFixed(3)}s. The recording may change frame properties midstream.`);
    await writeFile(join(output, 'captions.vtt'), vtt(timeline.map((s, i) => ({ id: i + 1, start: s.at, end: s.until, text: s.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") }))));
    await writeFile(join(output, 'chapters.vtt'), chaptersVtt(timeline));
    // GitHub plays only videos uploaded in its web editor, so pages embed this instead: https://ffmpeg.org/ffmpeg-filters.html#subtitles
    const captioned = 'subtitles=captions.vtt';
    await run(['ffmpeg', '-v', 'error', '-i', 'video.mp4', '-vf', `${captioned},setpts=PTS/${PREVIEW_RATE},fps=10,scale='min(960,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, 'preview.gif'], output);
    // Three frames per step, as a viewer sees them: the start, the middle and the last.
    // The start is 0.1 s in, since libass times captions to 1/100 s and can show the previous one first.
    const picks = timeline.flatMap(s => [s.at + 0.1, (s.at + s.until) / 2, s.until - 1 / 30].map(t => `eq(n,${Math.round(t * 30)})`));
    await run(['ffmpeg', '-v', 'error', '-i', 'video.mp4', '-vf', `${captioned},select='${picks.join('+')}',scale='min(960,iw)':-2,tile=3x1:padding=8:color=white`,
      '-fps_mode', 'vfr', '-pix_fmt', 'yuvj420p', '-q:v', '3', join('frames', '%d.jpg')], output);
    for (const [index] of timeline.entries())
      if (!(await stat(join(output, 'frames', `${index + 1}.jpg`)).catch(() => null))?.size) throw new Error(`Frames for step ${index + 1} are missing.`);
    await run(['ffmpeg', '-v', 'error', '-ss', String(timeline[0]!.until - 0.1), '-i', 'video.mp4', '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', 'poster.jpg'], output);
    const count = Math.ceil(total / 2), columns = Math.min(10, count), rows = Math.ceil(count / columns);
    const tileHeight = 2 * Math.round(160 * rendered.height / rendered.width);
    await run(['ffmpeg', '-v', 'error', '-i', videoPath, '-vf',
      `fps=1/2:start_time=0:round=up,scale=320:${tileHeight},tile=${columns}x${rows}`,
      '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-threads', '1', '-q:v', '2', join(output, 'thumbnails.jpg')]);
    if (!(await stat(join(output, 'thumbnails.jpg'))).size) throw new Error('Thumbnail sprite is empty.');
    await writeFile(join(output, 'thumbnails.vtt'), vtt(Array.from({ length: count }, (_, i) => ({
      start: i * 2, end: Math.min(total, (i + 1) * 2), text: `thumbnails.jpg#xywh=${(i % columns) * 320},${Math.floor(i / columns) * tileHeight},320,${tileHeight}` }))));
    const manifest = { title: review.title, sources: sources.map(({ path, sha256 }) => ({ file: basename(path), sha256 })), voiceover: voiceover ? tts : null,
      steps: timeline.map(({ start, end, ...step }) => step.source !== undefined && isImage(step.source) ? step : { start, end, ...step }) };
    await writeFile(join(output, 'timeline.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(join(output, 'vendor'));
    for (const [name, content] of Object.entries(assets)) await writeFile(join(output, 'vendor', name), Buffer.from(content, 'base64'));
    await writeFile(join(output, 'index.html'), renderPlayer(template, review.title));
    await rm(target, { recursive: true, force: true });
    await rename(output, target);
    complete = true;
    console.log(JSON.stringify({ player: join(target, 'index.html'), video: join(target, 'video.mp4'), preview: join(target, 'preview.gif'), frames: timeline.map((_, i) => join(target, 'frames', `${i + 1}.jpg`)) }));
  } finally {
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}

async function lines(input: string, voiceover: boolean) {
  const texts = parseLines(JSON.parse(await readFile(input, 'utf8')));
  const key = process.env.GEMINI_API_KEY;
  if (voiceover && !key) throw new Error('Set GEMINI_API_KEY from https://aistudio.google.com/apikey, or time the lines without --voiceover.');
  const scratch = await mkdtemp(join(tmpdir(), 'video-review-lines-'));
  try {
    const seconds: number[] = [];
    for (const [index, text] of texts.entries()) {
      if (!voiceover) { seconds.push(lineSeconds(text, 0)); continue; }
      await speak(text, join(scratch, `${index}.wav`), key!);
      seconds.push(lineSeconds(text, (await probe(join(scratch, `${index}.wav`))).seconds));
    }
    console.log(JSON.stringify({ seconds }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function frames(video: string, destination: string) {
  requireFFmpeg();
  const output = resolve(destination);
  const { seconds } = await probe(await realpath(video), true);
  await mkdir(output, { recursive: true });
  // The fps filter pads past the end; stop at the last timestamp inside the recording.
  const sample = `fps=${1 / FRAME_STEP}:start_time=0,trim=end_frame=${Math.floor(seconds / FRAME_STEP) + 1}`;
  await run(['ffmpeg', '-v', 'error', '-y', '-reinit_filter:v', '0', '-i', video, '-vf', sample, '-pix_fmt', 'yuvj420p', '-q:v', '3', join(output, 'frame-%d.jpg')]);
  // One overview image per 12 frames, each labelled with its time: https://ffmpeg.org/ffmpeg-filters.html#drawtext-1
  await run(['ffmpeg', '-v', 'error', '-y', '-reinit_filter:v', '0', '-i', video, '-vf', `${sample},scale=480:-2,`
    + "pad=iw:ih+22:0:0:white,drawtext=text='%{pts\\:hms}':fontsize=18:x=4:y=h-20:fontcolor=black,tile=3x4:padding=4:color=white",
    '-pix_fmt', 'yuvj420p', '-q:v', '3', join(output, 'sheet-%d.jpg')]);
  const files = await readdir(output);
  const written = files.filter(name => /^frame-\d+\.jpg$/.test(name));
  for (const name of written) {
    const at = (Number(name.slice(6, -4)) - 1) * FRAME_STEP;
    await rename(join(output, name), join(output, `${at.toFixed(1).padStart(6, '0')}.jpg`));
  }
  const sheets = files.filter(name => /^sheet-\d+\.jpg$/.test(name)).sort((a, b) => Number(a.slice(6, -4)) - Number(b.slice(6, -4)));
  console.log(JSON.stringify({ frames: output, count: written.length, every: FRAME_STEP, seconds, sheets: sheets.map(name => join(output, name)) }));
}

try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), options: { out: { type: 'string' }, help: { type: 'boolean' }, voiceover: { type: 'boolean' } }, allowPositionals: true, strict: true });
  const [command, video, input, ...extra] = positionals;
  if (values.help || !command) {
    console.log(command === 'build' ? buildHelp : help);
  } else if (command === 'build' && video && input && values.out && !extra.length) {
    await build(video, input, values.out, values.voiceover === true);
  } else if (command === 'lines' && video && !input && !values.out) {
    if (values.voiceover) requireFFmpeg();
    await lines(video, values.voiceover === true);
  } else if (command === 'frames' && video && !input && values.out && !values.voiceover) {
    await frames(video, values.out);
  } else {
    console.error(help);
    process.exitCode = 2;
  }
} catch (error) {
  // Provider exceptions can embed request headers; surface only a redacted message.
  let message = error instanceof Error ? error.message : 'Build failed.';
  const key = process.env.GEMINI_API_KEY;
  if (key) message = message.replaceAll(key, '[redacted]');
  console.error(`video-review: ${message}`);
  process.exitCode = error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS') ? 2 : 1;
}
