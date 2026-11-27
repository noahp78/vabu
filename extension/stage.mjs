import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const shared = [
  'popup.html', 'popup.css', 'popup.js', 'toolbar.mjs', 'socket-name.mjs', 'domains.js',
  'interaction.mjs', 'inspection.mjs', 'scoped-snapshot.mjs', 'find-click.mjs',
  'wait.mjs', 'get-element.mjs', 'frame-probes.mjs', 'capture-jpeg.mjs', 'feedback.mjs',
  'icons/vabu.svg',
  ...['vabu', 'vabu-online'].flatMap(icon => [16, 32, 48, 128].map(size => `icons/${icon}-${size}.png`)),
];

export async function stageExtension(browser, directory, runtime) {
  if (directory === undefined) await mkdir(dist, { recursive: true });
  const output = directory === undefined ? join(dist, browser) : resolve(directory);
  await mkdir(output); // Never overlay an existing installation or build.
  await mkdir(join(output, browser));
  await mkdir(join(output, 'shared', 'icons'), { recursive: true });
  const copy = (source, target = source) => copyFile(new URL(source, import.meta.url), join(output, target));
  await Promise.all([
    copy(`${browser}/manifest.json`, 'manifest.json'),
    ...shared.map(file => copy(`shared/${file}`)),
    ...runtime.map(file => copy(`${browser}/${file}`)),
  ]);
  return output;
}

export async function runPackage(url, browser, stage) {
  const entry = process.argv[1];
  if (!entry || (url !== pathToFileURL(entry).href && fileURLToPath(url) !== await realpath(entry).catch(() => null))) return;
  if (process.argv.length > 3 || process.argv[2] === '') {
    throw new Error(`Usage: node extension/${browser}/package.mjs [NEW_DIRECTORY]`);
  }
  await stage(process.argv[2]);
}
