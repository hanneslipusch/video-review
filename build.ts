import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const player = await Bun.build({ entrypoints: ['./player.ts'], target: 'browser', minify: true, conditions: ['browser', 'production'], metafile: true });
if (!player.success) throw new AggregateError(player.logs, 'Player bundle failed.');
const assets: Record<string, string> = {
  'player.js': Buffer.from(await player.outputs[0]!.arrayBuffer()).toString('base64'),
  'skin.css': (await readFile(fileURLToPath(import.meta.resolve('@videojs/html/video/neutral-skin.css')))).toString('base64'),
};
const bundled = new Set(Object.keys(player.metafile!.inputs).flatMap(path => path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1] ?? []));
for (const name of [...bundled].sort()) assets[`${name.replace('@', '').replace('/', '-')}-LICENSE.txt`] = (await readFile(`node_modules/${name}/LICENSE`)).toString('base64');
const template = await readFile('player.html', 'utf8');
await writeFile('assets.generated.ts', `export const assets = ${JSON.stringify(assets)};\nexport const template = ${JSON.stringify(template)};\n`);
// Committed: Claude Code puts a plugin's bin/ on PATH, so the plugin needs no install step.
// https://code.claude.com/docs/en/plugins-reference.md
const cli = await Bun.build({ entrypoints: ['./cli.ts'], target: 'bun', minify: false });
if (!cli.success) throw new AggregateError(cli.logs, 'CLI bundle failed.');
await mkdir('bin', { recursive: true });
await writeFile('bin/video-review', await cli.outputs[0]!.text(), { mode: 0o755 });
