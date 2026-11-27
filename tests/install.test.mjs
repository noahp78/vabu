import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const install = join(root, 'install.mjs');
const exec = promisify(execFile);
const mac = process.platform === 'darwin';

test('registers VABU per browser without installing into the runtime directory', { skip: !mac && process.platform !== 'linux' }, async (t) => {
  const HOME = await mkdtemp(join(tmpdir(), 'vabu-install-'));
  t.after(() => rm(HOME, { recursive: true, force: true }));
  const XDG_RUNTIME_DIR = join(HOME, 'run');
  const XDG_CONFIG_HOME = join(HOME, 'config');
  const XDG_DATA_HOME = join(HOME, 'data');
  const env = { ...process.env, HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR };
  const run = (...args) => exec(process.execPath, [install, ...args], { env });
  const id = 'a'.repeat(32);
  const custom = join(HOME, 'Ungoogled Chromium');
  const launcher = join(XDG_DATA_HOME, 'vabu', 'host');
  const chromeDir = mac ? join(HOME, 'Library/Application Support/Google/Chrome') : join(XDG_CONFIG_HOME, 'chromium');
  const chromium = join(chromeDir, 'NativeMessagingHosts/local.vabu.json');
  const firefox = join(HOME, mac ? 'Library/Application Support/Mozilla/NativeMessagingHosts' : '.mozilla/native-messaging-hosts', 'local.vabu.json');
  const override = join(custom, 'NativeMessagingHosts/local.vabu.json');
  const defaults = { name: 'local.vabu', description: 'VABU local bridge', path: launcher, type: 'stdio' };
  const parse = async (path) => JSON.parse(await readFile(path, 'utf8'));

  await assert.rejects(run(id, '--config-dir', './relative'), /ABSOLUTE_PATH/);
  await assert.rejects(run('--firefox', '--config-dir', custom), /Supply/);
  await assert.rejects(run('q'.repeat(32)), /Supply/);
  assert.equal((await run(id)).stdout, `Registered ${chromium}\n`);
  await run('--firefox');
  await run(id, '--config-dir', custom);
  for (const path of [chromium, override]) {
    assert.deepEqual(await parse(path), { ...defaults, allowed_origins: [`chrome-extension://${id}/`] });
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await parse(firefox), { ...defaults, allowed_extensions: ['vabu@local.invalid'] });
  assert.equal((await lstat(launcher)).mode & 0o777, 0o700);
  assert.doesNotMatch(await readFile(launcher, 'utf8'), /XDG_RUNTIME_DIR|XDG_CACHE_HOME/);
  await assert.rejects(lstat(XDG_RUNTIME_DIR), { code: 'ENOENT' });

  const untouched = join(HOME, 'untouched');
  await writeFile(untouched, 'keep');
  await rm(override);
  await symlink(untouched, override);
  await run(id, '--config-dir', custom);
  assert.equal(await readFile(untouched, 'utf8'), 'keep');
  assert.equal((await lstat(override)).isFile(), true);

  await exec(process.execPath, [install, '--firefox'], { env: { ...env, XDG_DATA_HOME: 'relative' } });
  assert.equal((await parse(firefox)).path, join(HOME, '.local/share/vabu/host'));
});

test('release downloads install offline and stage Chrome without changing any installed extension',
  { skip: !mac && process.platform !== 'linux' }, async (t) => {
    const HOME = await mkdtemp(join(tmpdir(), 'vabu-downloads-'));
    t.after(() => rm(HOME, { recursive: true, force: true }));
    const output = join(HOME, 'release downloads');
    const XDG_DATA_HOME = join(HOME, 'some data');
    const XDG_CONFIG_HOME = join(HOME, 'config');
    const XDG_RUNTIME_DIR = join(HOME, 'run');
    const env = { ...process.env, HOME, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_RUNTIME_DIR, XDG_CACHE_HOME: join(HOME, 'cache'),
      NPM_CONFIG_CACHE: join(HOME, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(HOME, 'npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(HOME, 'global-npmrc') };
    const build = (...args) => exec('sh', [join(root, 'scripts/build.sh'), ...args], { cwd: HOME, env });
    await build(output);
    await assert.rejects(build(output), /already exists/);
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const tgz = `noahp78-vabu-${version}.tgz`;
    const archives = ['chrome', 'firefox'].map(browser => `vabu-${browser}-${version}.zip`);
    assert.deepEqual((await readdir(output)).sort(), ['install.sh', tgz, ...archives].sort());
    for (const [index, browser] of ['chrome', 'firefox'].entries()) {
      const files = (await exec('unzip', ['-Z1', join(output, archives[index])], { env })).stdout.trim().split('\n');
      assert.ok(files.includes('manifest.json'));
      assert.ok(files.includes(browser === 'chrome' ? 'chrome/worker.js' : 'firefox/content.js'));
      assert.ok(files.every(file => file === 'manifest.json' || file.startsWith('shared/') || file.startsWith(`${browser}/`)));
      assert.ok(files.every(file => !/\/(?:package\.mjs|manifest\.json|README\.md)$/.test(file)));
    }
    const installScript = (...args) => exec('sh', [join(output, 'install.sh'), ...args], { cwd: HOME, env });
    await assert.rejects(installScript('-invalid'), /Usage/);
    await cp(join(output, tgz), join(output, `noahp78-vabu-extra.tgz`));
    await assert.rejects(installScript(), /exactly one/);
    await rm(join(output, 'noahp78-vabu-extra.tgz'));
    const prefix = join(HOME, '.local');
    await assert.rejects(lstat(prefix), { code: 'ENOENT' });
    const { stdout } = await installScript();
    const vabu = (...args) => exec(join(prefix, 'bin/vabu'), args, { cwd: HOME, env });
    await assert.rejects(lstat(join(prefix, 'bin/vacu')), { code: 'ENOENT' });
    const folder = (await vabu('setup')).stdout.trim();
    assert.match(stdout, /Chrome extension folder:/);
    assert.ok(stdout.includes(folder));
    assert.equal((await vabu('setup')).stdout.trim(), folder);
    assert.match(folder.slice(join(XDG_DATA_HOME, 'vabu').length), /^\/chrome-[a-f0-9]{64}$/);
    assert.equal((await lstat(folder)).mode & 0o777, 0o700);
    const manifestPath = join(folder, 'manifest.json');
    const manifest = await readFile(manifestPath, 'utf8');
    assert.equal(JSON.parse(manifest).background.service_worker, 'chrome/worker.js');
    const id = 'b'.repeat(32);
    const chromeConfig = mac ? join(HOME, 'Library/Application Support/Google/Chrome') : join(XDG_CONFIG_HOME, 'google-chrome');
    const chromeHost = join(chromeConfig, 'NativeMessagingHosts/local.vabu.json');
    await assert.rejects(lstat(chromeHost), { code: 'ENOENT' });
    await vabu('setup', id);
    assert.deepEqual(JSON.parse(await readFile(chromeHost, 'utf8')).allowed_origins, [`chrome-extension://${id}/`]);
    const custom = join(HOME, 'Custom Browser');
    await installScript(id, '--config-dir', custom);
    assert.deepEqual(JSON.parse(await readFile(join(custom, 'NativeMessagingHosts/local.vabu.json'), 'utf8')).allowed_origins,
      [`chrome-extension://${id}/`]);
    assert.match((await installScript('--firefox')).stdout, /--socket firefox-default status/);
    const firefoxHost = join(HOME, mac ? 'Library/Application Support/Mozilla/NativeMessagingHosts' : '.mozilla/native-messaging-hosts', 'local.vabu.json');
    const { allowed_extensions, path: launcher } = JSON.parse(await readFile(firefoxHost, 'utf8'));
    assert.deepEqual(allowed_extensions, ['vabu@local.invalid']);
    assert.equal((await exec('sh', ['-c', 'exec "$1" </dev/null', 'sh', launcher], { env, timeout: 4000 })).stderr, '');
    await assert.rejects(lstat(XDG_RUNTIME_DIR), { code: 'ENOENT' });
    await assert.rejects(lstat(join(env.XDG_CACHE_HOME, 'vabu')), { code: 'ENOENT' });

    // A changed package stages at a new path; tampering with a cached stage never overwrites it.
    const source = join(prefix, 'lib/node_modules/@noahp78/vabu/extension/chrome/manifest.json');
    const contents = JSON.parse(manifest);
    assert.equal(contents.name, 'VABU');
    const modified = JSON.stringify({ ...contents, description: 'New Browser Build' });
    await writeFile(source, modified);
    const updated = (await vabu('setup')).stdout.trim();
    assert.notEqual(updated, folder);
    assert.equal(await readFile(manifestPath, 'utf8'), manifest);
    await writeFile(join(updated, 'manifest.json'), 'tampered');
    await assert.rejects(vabu('setup'), /Unpacked extension has changed/);
    assert.equal(await readFile(join(updated, 'manifest.json'), 'utf8'), 'tampered');
  });
