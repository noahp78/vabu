import { lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const directory = join(homedir(), '.pi-chrome');
export const socketPath = join(directory, 'chrome.sock');
export const requestLimit = 32 * 1024;
// Large enough for a base64 full-page screenshot (capped at 30 MiB by the extension).
export const responseLimit = 32 * 1024 * 1024;

export function privateDirectory(create = false) {
  if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error(directory + ' must be a real directory owned by you with mode 0700');
  }
}
