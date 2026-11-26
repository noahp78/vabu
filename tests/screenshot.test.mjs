import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseScreenshotArgs } from '../screenshot-options.mjs';
import { captureOptions, captureResponse, changedRatio } from '../extension/shared/capture-jpeg.mjs';

const png = 'iVBORw0KGgo=';

test('screenshot flags normalize to the same strict viewport schema as the worker', () => {
  const { path, dir, options } = parseScreenshotArgs(['shot.jpg', '--threshold', '.25', '--json', '--screenshot-quality', '95'], {
    VACU_SCREENSHOT_DIR: 'old', VABU_SCREENSHOT_DIR: 'new', VACU_SCREENSHOT_FORMAT: 'png',
  });
  assert.equal(path, 'shot.jpg');
  assert.equal(dir, 'new');
  assert.deepEqual(options, { format: 'jpeg', quality: 95, ifChanged: true, threshold: .25 });
  assert.deepEqual(captureOptions([JSON.stringify(options)]), options);
  assert.equal(parseScreenshotArgs([], { VACU_SCREENSHOT_FORMAT: 'jpg' }).options.format, 'jpeg');
  assert.equal(parseScreenshotArgs([]).options.format, 'png');
  for (const args of [['--annotate'], ['-f'], ['#target', 'x.png'], ['--threshold', '1.1'], ['--threshold', '--json'],
    ['test.png', '--screenshot-format', 'jpeg'], ['--screenshot-quality', '101']]) {
    assert.throws(() => parseScreenshotArgs(args));
  }
  for (const options of [{ full: true }, { selector: '#target' }, { format: 'png', quality: 80 }, { format: 'jpeg', quality: 101 },
    { threshold: 0.5 }, { ifChanged: 'true' }, null, []]) {
    assert.throws(() => captureOptions([JSON.stringify(options)]), /Invalid viewport/);
  }
});

test('capture history is keyed by document and format, and pixel ratio compares RGBA pixels', async () => {
  const a = { width: 2, height: 1, data: [0, 0, 0, 255, 0, 0, 0, 255] };
  const b = { ...a, data: [0, 0, 0, 0, 0, 0, 0, 255] };
  assert.equal(changedRatio(a, b), .5);
  assert.equal(changedRatio(a, { ...b, width: 1 }), 1);
  const options = captureOptions(['{"format":"png","ifChanged":true}']);
  const first = await captureResponse(png, options, undefined, 'doc1');
  assert.deepEqual(first.value, { format: 'png', changedRatio: 1, data: png });
  assert.deepEqual((await captureResponse(png, options, first.next, 'doc1')).value,
    { format: 'png', changedRatio: 0, unchanged: true });
  assert.deepEqual((await captureResponse(png, options, first.next, 'doc2')).value, first.value);
});

test('CLI screenshot honors socket and session, reports JSON and never overwrites', async (t) => {
  const HOME = await mkdtemp(join(tmpdir(), 'vabu-shot-'));
  const XDG_RUNTIME_DIR = join(HOME, 'runtime');
  await mkdir(join(XDG_RUNTIME_DIR, 'vabu'), { recursive: true, mode: 0o700 });
  t.after(() => rm(HOME, { recursive: true, force: true }));
  const requests = [];
  const server = createServer({ encoding: 'utf8' }, socket => {
    let raw = '';
    socket.on('data', chunk => {
      raw += chunk;
      if (!raw.endsWith('\n')) return;
      requests.push(JSON.parse(raw));
      socket.end(JSON.stringify({ value: requests.length === 3
        ? { format: 'png', unchanged: true, changedRatio: 0 } : { format: 'png', data: png } }) + '\n');
    });
  });
  await new Promise(resolve => server.listen(join(XDG_RUNTIME_DIR, 'vabu', 'preview.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const run = (...args) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../cli.mjs', import.meta.url)),
    '--pretty', '--socket', 'preview', '--session', 'workspace', 'screenshot', ...args], {
    env: { ...process.env, HOME, XDG_RUNTIME_DIR, VABU_SCREENSHOT_FORMAT: 'png', VABU_SCREENSHOT_QUALITY: '80' }, timeout: 4000,
  });
  const file = join(HOME, 'owned.png');
  const { stdout } = await run(file);
  assert.deepEqual(JSON.parse(stdout), { path: file, format: 'png' });
  assert.deepEqual(await readFile(file), Buffer.from(png, 'base64'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(run(file), /EEXIST/);
  const absent = join(HOME, 'unchanged.png');
  const unchanged = await run('--if-changed', absent);
  assert.deepEqual(JSON.parse(unchanged.stdout), { format: 'png', unchanged: true, changedRatio: 0 });
  await assert.rejects(stat(absent), { code: 'ENOENT' });
  assert.deepEqual(requests[0].slice(0, 3), ['--session', 'workspace', 'screenshot']);
  assert.equal(captureOptions(requests[2].slice(3)).ifChanged, true);
  const { path: generated } = JSON.parse((await run('--screenshot-dir', join(HOME, 'captures'))).stdout);
  assert.match(generated, /\/captures\/screenshot-.+\.png$/);
  assert.equal((await stat(generated)).mode & 0o777, 0o600);
});
