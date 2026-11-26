import { lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { absolutePath, privateDirectory, xdgDirectory } from './paths.mjs';
import { socketNameError, validSocketName } from './extension/shared/socket-name.mjs';

const runtime = process.env.XDG_RUNTIME_DIR;
const runtimeRoot = absolutePath(runtime) ? resolve(runtime) : null;
const root = runtimeRoot ?? xdgDirectory('XDG_CACHE_HOME', '.cache');
const directory = join(root, 'vabu');
export function socketPath(socketName) {
  if (!validSocketName(socketName)) throw new Error(socketNameError);
  const path = join(directory, `${socketName}.sock`);
  // Leave space for the terminating NUL in sockaddr_un (104 bytes on macOS).
  if (Buffer.byteLength(path) > (process.platform === 'linux' ? 107 : 103)) {
    throw new Error('VABU Unix socket path is too long. Choose a shorter socket name or XDG runtime/cache path.');
  }
  return path;
}
export const requestLimit = 32 * 1024;
export const responseLimit = 8 * 1024 * 1024;

export function privateSocketDirectory(create = false) {
  if (runtimeRoot) {
    privateDirectory(root);
  } else {
    if (create) mkdirSync(root, { mode: 0o700, recursive: true });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) {
      throw new Error(root + ' must be a real directory owned by you and not writable by others');
    }
  }
  privateDirectory(directory, create);
}
