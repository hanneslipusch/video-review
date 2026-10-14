import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { GEMINI_API_KEY: _, ...withoutKey } = process.env;
const run = (command: string[], env = withoutKey) => {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

test('color metadata changes preserve every interval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-review-media-'));
  try {
    for (const [i, color] of ['blue', 'green', 'red'].entries()) {
      run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x48:d=${i === 2 ? 4.4 : 2}:r=30`,
        ...(i === 2 ? ['-colorspace', 'bt470bg', '-color_range', 'tv'] : []),
        '-c:v', 'libx264', '-threads', '1', join(dir, `${i}.mp4`)]);
    }
    await writeFile(join(dir, 'concat.txt'), "file '0.mp4'\nfile '1.mp4'\nfile '2.mp4'\n");
    run(['ffmpeg', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'concat.txt'), '-c', 'copy', join(dir, 'source.mp4')]);
    await writeFile(join(dir, 'steps.json'), JSON.stringify({ title: 'Metadata transition', steps: [
      { start: 0, end: 2, chapter: 'Blue frame', text: 'Blue stayed.' },
      { start: 2, end: 4, chapter: 'Green frame', text: 'Green showed.', notes: 'notes.md' },
      { start: 4, end: 8.4, chapter: 'Red frame', text: 'Red appeared.' },
    ] }));
    await writeFile(join(dir, 'notes.md'), '| Queries |\n| --- |\n| 3 → 23 |\n');
    const out = join(dir, 'review');
    const build = (destination: string) => run(['bun', 'bin/video-review', 'build', join(dir, 'source.mp4'), join(dir, 'steps.json'), '--out', destination]);
    build(out);
    const metadata = JSON.parse(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', join(out, 'video.mp4')]));
    expect(Number(metadata.format.duration)).toBeCloseTo(8.4, 1);
    expect(metadata.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(['video']);
    const preview = JSON.parse(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', join(out, 'preview.gif')]));
    expect(Number(preview.format.duration)).toBeCloseTo(8.4 / 2.5, 0);
    expect((await readdir(join(out, 'frames'))).sort()).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    for (const [i, channel] of [2, 1, 0].entries()) {
      const pixel = join(dir, `${i}.rgb`);
      run(['ffmpeg', '-v', 'error', '-i', join(out, 'frames', `${i + 1}.jpg`), '-vf', 'crop=200:100:380:150,scale=1:1,format=rgb24', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', pixel]);
      const rgb = await readFile(pixel);
      expect(rgb[channel]!).toBeGreaterThan(Math.max(...rgb.filter((_, index) => index !== channel)));
    }
    const timeline = JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8'));
    expect([timeline.voiceover, timeline.steps[1].notes]).toEqual([null, '| Queries |\n| --- |\n| 3 → 23 |']);
    // The note widens the frame by its panel; only the green step's panel holds dark text.
    expect(JSON.parse(run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', join(out, 'video.mp4')]))).toBe(2560);
    for (const [i, text] of [[0, false], [1, true], [2, false]] as const) {
      const panel = join(dir, `panel-${i}.gray`);
      run(['ffmpeg', '-v', 'error', '-i', join(out, 'frames', `${i + 1}.jpg`), '-vf', 'crop=320:200:960:0,format=gray', '-frames:v', '1', '-f', 'rawvideo', panel]);
      expect(Math.min(...await readFile(panel)) < 100).toBe(text);
    }
    build(out);
    await writeFile(join(dir, 'notes.txt'), 'keep');
    expect(() => build(dir)).toThrow('not a video-review output');
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('keep');
    run(['bun', 'bin/video-review', 'frames', join(dir, 'source.mp4'), '--out', join(dir, 'frames')]);
    const sampled = (await readdir(join(dir, 'frames'))).sort();
    expect([sampled.length, sampled[0], sampled[1], sampled.at(-3), ...sampled.slice(-2)]).toEqual([19, '0000.0.jpg', '0000.5.jpg', '0008.0.jpg', 'sheet-1.jpg', 'sheet-2.jpg']);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test('mixed sources retain image and video outcomes at the main canvas size', async () => {
  const dir = await mkdtemp(join(process.cwd(), 'mixed-test-'));
  try {
    // main.mp4 stores 32x48 pixels twice as wide as tall, so players show it at 4:3.
    for (const [name, color, size, sar] of [['main.mp4', 'blue', '32x48', '2'], ['other.mp4', 'red', '48x64', '1'], ['card.png', 'green', '128x80', '1']])
      run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=${size}:d=4:r=30`, '-vf', `setsar=${sar}`, ...(name!.endsWith('.png') ? ['-frames:v', '1', '-update', '1'] : ['-c:v', 'libx264']), '-threads', '1', join(dir, name!)]);
    const step = { start: 0, end: 2, chapter: 'Result', text: 'Shown.' };
    const card = { source: 'card.png', chapter: 'Card', text: 'Shown.' };
    const steps = [card, step, { ...step, source: 'other.mp4', start: 2, end: 4 }, { ...step, source: 'other.mp4' }, card];
    const input = join(dir, 'steps.json'), out = join(dir, 'review');
    // A key that cannot speak proves --captions-only never calls Gemini.
    const build = () => run(['bun', 'bin/video-review', 'build', join(dir, 'main.mp4'), input, '--out', out, '--captions-only'], { ...withoutKey, GEMINI_API_KEY: 'invalid' });
    await writeFile(input, JSON.stringify({ title: 'Mixed', steps }));
    build();
    const timeline = JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8'));
    expect(timeline.sources.length).toBe(3);
    expect(timeline.steps.map((s: { source?: string }) => s.source)).toEqual(['card.png', undefined, 'other.mp4', 'other.mp4', 'card.png']);
    const video = JSON.parse(run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height,sample_aspect_ratio', '-of', 'json', join(out, 'video.mp4')]));
    expect(video.streams[0]).toEqual({ width: 1920, height: 1080, sample_aspect_ratio: '1:1' });
    // Strip tiles are 960x540; x=150 is inside main.mp4's 4:3 picture only when its pixels are widened.
    for (const [i, channel, x] of [[0, 1, 480], [1, 2, 480], [1, 2, 150], [2, 0, 480], [3, 0, 480], [4, 1, 480]] as const) {
      const file = join(dir, `pixel-${i}-${x}.rgb`);
      run(['ffmpeg', '-v', 'error', '-i', join(out, 'frames', `${i + 1}.jpg`), '-vf', `crop=2:2:${x}:200,format=rgb24`, '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', file]);
      const rgb = await readFile(file);
      expect(rgb[channel]!).toBeGreaterThan(Math.max(...rgb.subarray(0, 3).filter((_, j) => j !== channel)));
    }
    for (const invalid of [{ ...step, source: 'other.mp4', end: 5 }, { ...card, start: 0 }]) {
      await writeFile(input, JSON.stringify({ title: 'Invalid', steps: [invalid] }));
      expect(build).toThrow();
      expect(JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8')).title).toBe('Mixed');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test('a review longer than one frame-picking run keeps every step its own frames', async () => {
  const dir = await mkdtemp(join(process.cwd(), 'long-test-'));
  try {
    for (const color of ['red', 'green'])
      run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=64x48`, '-frames:v', '1', '-update', '1', join(dir, `${color}.png`)]);
    run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=64x48:d=1:r=30', '-c:v', 'libx264', '-threads', '1', join(dir, 'main.mp4')]);
    const steps = Array.from({ length: 34 }, (_, i) => ({ source: i % 2 ? 'green.png' : 'red.png', chapter: `Step ${i + 1}`, text: 'Shown.' }));
    const input = join(dir, 'steps.json'), out = join(dir, 'review');
    await writeFile(input, JSON.stringify({ title: 'Long', steps }));
    run(['bun', 'bin/video-review', 'build', join(dir, 'main.mp4'), input, '--out', out, '--captions-only']);
    expect((await readdir(join(out, 'frames'))).length).toBe(34);
    for (const [step, channel] of [[1, 0], [34, 1]] as const) {
      const file = join(dir, `${step}.rgb`);
      run(['ffmpeg', '-v', 'error', '-i', join(out, 'frames', `${step}.jpg`), '-vf', 'crop=2:2:480:200,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', file]);
      const rgb = await readFile(file);
      expect(rgb[channel]!).toBeGreaterThan(Math.max(...rgb.subarray(0, 3).filter((_, j) => j !== channel)));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 120_000);
