import { test, expect } from 'bun:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (command: string[]) => {
  const result = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
};

test('color metadata changes preserve every interval, hold and outcome frame', async () => {
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
      { start: 0, end: 2, chapter: 'Blue frame', text: 'The first blue frame remained on screen.' },
      { start: 2, end: 4, chapter: 'Green frame', text: 'The second green frame was visible in the review.' },
      { start: 4, end: 8.4, chapter: 'Red frame', text: 'The final red frame appeared after the change.' },
    ] }));
    const out = join(dir, 'review');
    const build = (destination: string) => run(['bun', 'bin/video-review', 'build', join(dir, 'source.mp4'), join(dir, 'steps.json'), '--out', destination]);
    build(out);
    const metadata = JSON.parse(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', join(out, 'video.mp4')]));
    expect(Number(metadata.format.duration)).toBeCloseTo(30, 1);
    expect(metadata.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(['video']);
    expect((await readdir(join(out, 'frames'))).sort()).toEqual(['1.jpg', '2.jpg', '3.jpg']);
    for (const [i, channel] of [2, 1, 0].entries()) {
      const pixel = join(dir, `${i}.rgb`);
      run(['ffmpeg', '-v', 'error', '-i', join(out, 'frames', `${i + 1}.jpg`), '-vf', 'scale=1:1,format=rgb24', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', pixel]);
      const rgb = await readFile(pixel);
      expect(rgb.length).toBe(3);
      expect(rgb[channel]!).toBeGreaterThan(Math.max(...rgb.filter((_, index) => index !== channel)));
    }
    const timeline = JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8'));
    expect(timeline.voiceover).toBeNull();
    build(out);
    await writeFile(join(dir, 'notes.txt'), 'keep');
    expect(() => build(dir)).toThrow('not a video-review output');
    expect(await readFile(join(dir, 'notes.txt'), 'utf8')).toBe('keep');
    run(['bun', 'bin/video-review', 'frames', join(dir, 'source.mp4'), '--out', join(dir, 'frames')]);
    const frames = (await readdir(join(dir, 'frames'))).sort();
    expect([frames.length, frames[0], frames[1], frames.at(-3), ...frames.slice(-2)]).toEqual([19, '0000.0.jpg', '0000.5.jpg', '0008.0.jpg', 'sheet-1.jpg', 'sheet-2.jpg']);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);

test('mixed sources retain image and video outcomes at the main canvas size', async () => {
  const dir = await mkdtemp(join(process.cwd(), 'mixed-test-'));
  try {
    for (const [name, color, size] of [['main.mp4', 'blue', '64x48'], ['other.mp4', 'red', '48x64'], ['card.png', 'green', '128x80']])
      run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=${size}:d=1:r=30`, ...(name!.endsWith('.png') ? ['-frames:v', '1'] : ['-c:v', 'libx264']), '-threads', '1', join(dir, name!)]);
    const step = { start: 0, end: 0.1, chapter: 'Result', text: 'Shown.' };
    const card = { source: 'card.png', chapter: 'Card', text: 'Shown.' };
    const steps = [card, step, { ...step, source: 'other.mp4', start: 0.4, end: 0.5 }, { ...step, source: 'other.mp4' }, card];
    const input = join(dir, 'steps.json'), out = join(dir, 'review');
    const build = () => run(['bun', 'bin/video-review', 'build', join(dir, 'main.mp4'), input, '--out', out]);
    await writeFile(input, JSON.stringify({ title: 'Mixed', steps }));
    build();
    const timeline = JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8'));
    expect(timeline.sources.length).toBe(3);
    expect(timeline.steps.map((s: { source?: string }) => s.source)).toEqual(['card.png', undefined, 'other.mp4', 'other.mp4', 'card.png']);
    for (const [i, channel] of [1, 2, 0, 0, 1].entries()) {
      const file = join(dir, `pixel-${i}.rgb`);
      const info = JSON.parse(run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', join(out, 'frames', `${i + 1}.jpg`)]));
      expect(info.streams[0]).toEqual({ width: 64, height: 48 });
      run(['ffmpeg', '-v', 'error', '-i', join(out, 'frames', `${i + 1}.jpg`), '-vf', 'crop=2:2:32:24,format=rgb24', '-frames:v', '1', '-threads', '1', '-f', 'rawvideo', file]);
      const rgb = await readFile(file);
      expect(rgb[channel]!).toBeGreaterThan(Math.max(...rgb.subarray(0, 3).filter((_, j) => j !== channel)));
    }
    for (const invalid of [{ ...step, source: 'other.mp4', end: 2 }, { ...card, start: 0 }]) {
      await writeFile(input, JSON.stringify({ title: 'Invalid', steps: [invalid] }));
      expect(build).toThrow();
      expect(JSON.parse(await readFile(join(out, 'timeline.json'), 'utf8')).title).toBe('Mixed');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 30_000);
