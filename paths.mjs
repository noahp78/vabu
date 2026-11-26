import { lstatSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export function absolutePath(path) {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0');
}

export function homeDirectory() {
  const home = homedir();
  return absolutePath(home) ? home : userInfo().homedir;
}

export function xdgDirectory(variable, fallback) {
  const path = process.env[variable];
  return absolutePath(path) ? resolve(path) : resolve(homeDirectory(), fallback);
}

export function privateDirectory(path, create = false) {
  if (create) mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error(path + ' must be a real directory owned by you with mode 0700');
  }
}
