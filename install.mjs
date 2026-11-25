import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { directory, privateDirectory } from './socket.mjs';

export function registerHost(id) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('VACU native bridge setup currently supports macOS and Linux');
  const firefox = id === '--firefox';
  if (!firefox && !/^[a-p]{32}$/.test(id)) throw new Error('Supply the 32-character Chrome extension ID or --firefox');
  const launcher = join(directory, 'host');
  const home = homedir();
  const config = process.env.XDG_CONFIG_HOME;
  const nativeDir = process.platform === 'darwin'
    ? join(home, 'Library/Application Support', firefox ? 'Mozilla' : 'Google/Chrome', 'NativeMessagingHosts')
    : firefox
      ? join(home, '.mozilla', 'native-messaging-hosts')
      : join(config && isAbsolute(config) ? config : join(home, '.config'), 'google-chrome', 'NativeMessagingHosts');
  const manifest = join(nativeDir, 'local.pi_chrome.json');
  const shellQuote = (path) => "'" + path.replaceAll("'", "'\\''") + "'";
  const entry = fileURLToPath(new URL('./native.mjs', import.meta.url));

  privateDirectory(true);
  mkdirSync(nativeDir, { mode: 0o700, recursive: true });
  writeFileSync(launcher, '#!/bin/sh\nexec ' + shellQuote(realpathSync(process.execPath)) + ' ' + shellQuote(entry) + '\n', { mode: 0o700 });
  chmodSync(launcher, 0o700);
  writeFileSync(manifest, JSON.stringify({
    name: 'local.pi_chrome',
    description: 'VACU local bridge',
    path: launcher,
    type: 'stdio',
    ...(firefox ? { allowed_extensions: ['vacu@local.invalid'] } : { allowed_origins: ['chrome-extension://' + id + '/'] }),
  }, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node install.mjs CHROME_EXTENSION_ID | node install.mjs --firefox');
    console.log('Registered ' + registerHost(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
