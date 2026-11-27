import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const native = fileURLToPath(new URL('../native.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const exec = promisify(execFile);

async function* frames(stream) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
      const end = 4 + buffer.readUInt32LE();
      yield JSON.parse(buffer.subarray(4, end));
      buffer = buffer.subarray(end);
    }
  }
}

test('native hosts bind only after configuration and route CLI calls to distinct private Unix sockets', { timeout: 15_000 }, async (t) => {
  const HOME = await mkdtemp(join(tmpdir(), 'vabu-'));
  const XDG_RUNTIME_DIR = join(HOME, 'run');
  const directory = join(XDG_RUNTIME_DIR, 'vabu');
  const env = { ...process.env, HOME, XDG_RUNTIME_DIR, XDG_CACHE_HOME: join(HOME, 'ignored') };
  await mkdir(XDG_RUNTIME_DIR, { mode: 0o700 });
  const hosts = [];
  t.after(async () => {
    for (const { child } of hosts) child.kill('SIGKILL');
    await Promise.allSettled(hosts.map(({ closed }) => closed));
    await rm(HOME, { recursive: true, force: true });
  });

  function host(overrides = {}) {
    const child = spawn(process.execPath, [native], { env: { ...env, ...overrides }, stdio: ['pipe', 'pipe', 'inherit'] });
    const closed = once(child, 'close');
    const messages = frames(child.stdout);
    function send(message) {
      const body = Buffer.from(JSON.stringify(message));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([header, body]));
    }
    const connection = { child, closed, send, configure: (socketName) => send({ type: 'configure', socketName }),
      next: async () => (await messages.next()).value };
    hosts.push(connection);
    return connection;
  }
  const run = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 4000 });

  const help = (await run('help')).stdout;
  assert.match(help, /instructions/);
  assert.match(help, /offline/);

  const waiting = host();
  const firstFrame = waiting.next();
  assert.equal(await Promise.race([firstFrame, delay(125, 'waiting')]), 'waiting');
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  waiting.configure('chrome-default');
  assert.deepEqual(await firstFrame, { ready: true, socketName: 'chrome-default' });

  const profiles = [[waiting, 'chrome-default'], [host(), 'firefox-default'], [host(), 'work-1']];
  for (const [connection, port] of profiles.slice(1)) connection.configure(port);
  const paths = [join(directory, 'chrome-default.sock'), join(directory, 'firefox-default.sock'), join(directory, 'work-1.sock')];
  assert.deepEqual(await Promise.all(profiles.slice(1).map(([connection]) => connection.next())),
    [{ ready: true, socketName: 'firefox-default' }, { ready: true, socketName: 'work-1' }]);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const path of paths) {
    const stat = await lstat(path);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o077, 0);
  }

  for (const config of [{ type: 'configure', socketName: '' }, { type: 'configure', socketName: 'A' },
    { type: 'configure', socketName: 'a-' }, { type: 'configure', socketName: 'a'.repeat(33) },
    { type: 'configure', socketName: '../socket' }, { type: 'configure', socketName: null },
    { type: 'configure', socketName: 'valid', path: '/tmp/other.sock' }, { type: 'configure', port: 1 }, null]) {
    const invalid = host();
    invalid.send(config);
    assert.match((await invalid.next()).startupError, /configuration|Socket name/);
    await invalid.closed;
  }
  const collision = host();
  collision.configure('firefox-default');
  assert.match((await collision.next()).startupError, /Socket already in use/);
  await collision.closed;

  await Promise.all([
    [profiles[0], ['status'], ['status'], false],
    [profiles[1], ['--pretty', '--socket', 'firefox-default', '--session', 'demo', 'status'], ['--session', 'demo', 'status'], true],
    [profiles[2], ['--socket', 'work-1', '--compact', 'status'], ['status'], false],
  ].map(async ([[connection, port], argv, command, pretty]) => {
    const output = run(...argv);
    const { id, args } = await connection.next();
    assert.deepEqual(args, command);
    connection.send({ id, value: { profile: port } });
    assert.equal((await output).stdout, JSON.stringify({ profile: port }, null, pretty ? 2 : 0) + '\n');
  }));
  for (const [connection, argv, command] of [
    [profiles[0][0], ['tab-navigate', '42', 'https://example.test/other'], ['tab-navigate', '42', 'https://example.test/other']],
    [profiles[1][0], ['--socket', 'firefox-default', '--session', 'demo', 'tab-navigate', '42', 'https://example.test/other'],
      ['--session', 'demo', 'tab-navigate', '42', 'https://example.test/other']],
    [profiles[0][0], ['tab-show', '42'], ['tab-show', '42']],
    [profiles[1][0], ['--socket', 'firefox-default', '--session', 'demo', 'tab-show', '42'], ['--session', 'demo', 'tab-show', '42']],
    [profiles[0][0], ['tab-close', '43'], ['tab-close', '43']],
    [profiles[1][0], ['--socket', 'firefox-default', '--session', 'demo', 'tab-close', '43'], ['--session', 'demo', 'tab-close', '43']],
  ]) {
    const output = run(...argv);
    const { id, args } = await connection.next();
    assert.deepEqual(args, command);
    connection.send({ id, value: { ok: true } });
    assert.deepEqual(JSON.parse((await output).stdout), { ok: true });
  }
  const ref = '@i00000000-0000-0000-0000-000000000001:1';
  for (const [command, value] of [
    [['get', 'styles', ref], { styles: { 'font-size': '16px', display: 'block' } }],
    [['eval', 'document.title'], 'Demo page'],
  ]) {
    const output = run('--socket', 'work-1', '--session', 'demo', ...command);
    const { id, args } = await profiles[2][0].next();
    assert.deepEqual(args, ['--session', 'demo', ...command]);
    profiles[2][0].send({ id, value });
    assert.deepEqual(JSON.parse((await output).stdout), value);
  }
  const instructions = run('--socket', 'firefox-default', 'instructions');
  const { id, args } = await profiles[1][0].next();
  assert.deepEqual(args, ['instructions']);
  const guide = { browser: 'firefox', version: '0.5.0', instructions: '# Browser instructions' };
  profiles[1][0].send({ id, value: guide });
  assert.deepEqual(JSON.parse((await instructions).stdout), guide);
  for (const args of [['--socket'], ['--socket', ''], ['--socket', '0'], ['--socket', 'Bad'],
    ['--socket', 'a-'], ['--socket', '../socket'], ['--socket', 'a'.repeat(33)]]) {
    await assert.rejects(run(...args), /Socket name/);
  }
  await assert.rejects(run('--socket', 'a', '--socket', 'b', 'status'), /only once/);

  profiles[1][0].child.stdin.end();
  await profiles[1][0].closed;
  await assert.rejects(lstat(paths[1]), { code: 'ENOENT' });
  const restarted = host();
  restarted.configure('firefox-default');
  assert.deepEqual(await restarted.next(), { ready: true, socketName: 'firefox-default' });
  for (const connection of [waiting, restarted, profiles[2][0]]) {
    connection.child.stdin.end();
    await connection.closed;
  }
  for (const path of paths) await assert.rejects(lstat(path), { code: 'ENOENT' });

  const work = 'work-1';
  for (const [cache, root] of [[join(HOME, 'cache'), join(HOME, 'cache')], ['relative-cache', join(HOME, '.cache')]]) {
    const overrides = { XDG_RUNTIME_DIR: './relative-runtime', XDG_CACHE_HOME: cache };
    const fallback = host(overrides);
    fallback.configure(work);
    assert.deepEqual(await fallback.next(), { ready: true, socketName: work });
    assert.equal((await lstat(join(root, 'vabu', `${work}.sock`))).isSocket(), true);
    const output = exec(process.execPath, [cli, '--socket', work, 'status'], { env: { ...env, ...overrides }, timeout: 4000 });
    const { id } = await fallback.next();
    fallback.send({ id, value: true });
    assert.equal((await output).stdout, 'true\n');
    fallback.child.stdin.end();
    await fallback.closed;
  }

  await chmod(directory, 0o755);
  await assert.rejects(run('status'), /mode 0700/);
  await rm(directory, { recursive: true });
  await symlink(join(HOME, '.cache', 'vabu'), directory);
  await assert.rejects(run('status'), /real directory/);
  await chmod(XDG_RUNTIME_DIR, 0o777);
  for (const [overrides, error] of [
    [{}, /mode 0700/],
    [{ XDG_RUNTIME_DIR: '', XDG_CACHE_HOME: XDG_RUNTIME_DIR }, /not writable by others/],
    [{ XDG_RUNTIME_DIR: join(HOME, 'é'.repeat(55)) }, /path is too long/],
  ]) {
    const invalid = host(overrides);
    invalid.configure(work);
    assert.match((await invalid.next()).startupError, error);
    await invalid.closed;
  }
  await assert.rejects(lstat(env.XDG_CACHE_HOME), { code: 'ENOENT' });
});
