import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { absolutePath, homeDirectory, privateDirectory, xdgDirectory } from './paths.mjs';

const mac = process.platform === 'darwin';
const dataDirectory = () => join(xdgDirectory('XDG_DATA_HOME', '.local/share'), 'vabu');
const usage = 'CHROMIUM_EXTENSION_ID [--config-dir ABSOLUTE_PATH] | --firefox';

function requirePlatform() {
  if (!mac && process.platform !== 'linux') throw new Error('VABU setup supports macOS and Linux');
}

// Replace files rather than writing through pre-existing symlinks or truncating a live launcher.
function replaceFile(path, contents, mode) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, contents, { mode, flag: 'wx' });
  try { renameSync(temp, path); }
  catch (error) { unlinkSync(temp); throw error; }
}

export function registerHost(id, configDir) {
  requirePlatform();
  const firefox = id === '--firefox';
  if ((!firefox && !/^[a-p]{32}$/.test(id ?? ''))
    || (configDir !== undefined && (firefox || !absolutePath(configDir)))) {
    throw new Error('Supply ' + usage);
  }
  const appData = dataDirectory();
  const launcher = join(appData, 'host');
  const home = homeDirectory();
  const nativeDir = firefox && !mac ? join(home, '.mozilla/native-messaging-hosts') : join(
    configDir ?? (mac ? join(home, 'Library/Application Support', firefox ? 'Mozilla' : 'Google/Chrome')
      : join(xdgDirectory('XDG_CONFIG_HOME', '.config'), 'chromium')),
    'NativeMessagingHosts',
  );
  const name = 'local.vabu';
  const manifest = join(nativeDir, `${name}.json`);
  const shellQuote = (path) => "'" + path.replaceAll("'", "'\\''") + "'";
  const entry = fileURLToPath(new URL('./native.mjs', import.meta.url));

  const mask = process.umask(0o077);
  try {
    privateDirectory(appData, true);
    mkdirSync(nativeDir, { mode: 0o700, recursive: true });
    replaceFile(launcher, '#!/bin/sh\nexec ' + shellQuote(realpathSync(process.execPath)) + ' ' + shellQuote(entry) + '\n', 0o700);
    replaceFile(manifest, JSON.stringify({
      name,
      description: 'VABU local bridge',
      path: launcher,
      type: 'stdio',
      ...(firefox ? { allowed_extensions: ['vabu@local.invalid'] } : { allowed_origins: ['chrome-extension://' + id + '/'] }),
    }, null, 2) + '\n', 0o600);
  } finally {
    process.umask(mask);
  }
  return manifest;
}

function register(args, command, linuxChrome = false) {
  if (args.length !== 1 && (args.length !== 3 || args[1] !== '--config-dir' || !absolutePath(args[2]))) {
    throw new Error(`Usage: ${command} ${usage}`);
  }
  const [id, , configDir] = args;
  const defaultConfig = linuxChrome && !mac && id !== '--firefox'
    ? join(xdgDirectory('XDG_CONFIG_HOME', '.config'), 'google-chrome') : undefined;
  return 'Registered ' + registerHost(id, configDir ?? defaultConfig);
}

async function treeDigest(root) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const dir = join(root, relative);
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(relative, entry.name);
      hash.update(JSON.stringify([path, entry.isDirectory()]));
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(createHash('sha256').update(await readFile(join(root, path))).digest());
      else throw new Error('Unexpected file in unpacked extension: ' + path);
    }
  }
  await visit('');
  return hash.digest('hex');
}

export async function setup(args) {
  requirePlatform();
  if (args.length) return register(args, 'vabu setup', true);

  // Keep the package/checkout read-only and never update a potentially loaded extension in place.
  const { stageChrome } = await import('./extension/chrome/package.mjs');
  const appData = dataDirectory();
  privateDirectory(appData, true);
  const scratch = await mkdtemp(join(appData, '.setup-'));
  const staged = join(scratch, 'chrome');
  try {
    await stageChrome(staged);
    await chmod(staged, 0o700);
    const digest = await treeDigest(staged);
    const output = join(appData, `chrome-${digest}`);
    if (!lstatSync(output, { throwIfNoEntry: false })) {
      try {
        await rename(staged, output);
        return output;
      } catch (error) {
        // Another setup may have published this same build first.
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
    }
    privateDirectory(output);
    if (await treeDigest(output) !== digest) throw new Error('Unpacked extension has changed: ' + output);
    return output;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { console.log(register(process.argv.slice(2), 'node install.mjs')); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
