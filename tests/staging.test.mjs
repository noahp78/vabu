import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { setBridgeIcon } from '../extension/shared/toolbar.mjs';

const exec = promisify(execFile);

async function files(root, dir = '') {
  const result = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(root, path));
    else {
      assert.ok(entry.isFile(), `${path} must be a regular staged file`);
      result.push([path, await readFile(join(root, path))]);
    }
  }
  return new Map(result);
}

for (const browser of ['chrome', 'firefox']) {
  test(`${browser}: unpacked builds are reproducible, self-contained and browser-specific`, async (t) => {
    const temp = await mkdtemp(join(tmpdir(), 'vabu-stage-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const source = join(temp, 'checkout', 'extension');
    await cp(new URL('../extension/', import.meta.url), source, { recursive: true });
    const alias = join(temp, 'source-alias');
    await symlink(source, alias, 'dir');
    const entry = join(alias, browser, 'package.mjs');
    const run = (...args) => exec(process.execPath, [entry, ...args], { cwd: temp });
    const output = join(temp, 'checkout', 'dist', browser);
    await run();
    const staged = await files(output);
    await run('custom-output');
    assert.deepEqual(await files(join(temp, 'custom-output')), staged);
    await assert.rejects(run(), /EEXIST/);
    assert.deepEqual(await files(output), staged);

    const firefox = browser === 'firefox';
    const manifest = JSON.parse(staged.get('manifest.json'));
    assert.equal(manifest.name, 'VABU');
    const visited = new Set(['manifest.json']);
    function visit(path) {
      assert.match(path, new RegExp(`^(shared|${browser})/`));
      assert.ok(staged.has(path), `missing staged dependency: ${path}`);
      if (visited.has(path)) return;
      visited.add(path);
      const local = ref => visit(posix.normalize(posix.join(posix.dirname(path), ref)));
      if (path.endsWith('.html')) {
        for (const [, ref] of staged.get(path).toString().matchAll(/\b(?:src|href)="([^"]+)"/g)) local(ref);
      } else if (/\.m?js$/.test(path)) {
        const source = staged.get(path).toString();
        // Runtime modules use static relative imports; follow their transitive dependencies.
        for (const [, ref] of source.matchAll(/^(?:import|export)\s+(?:[^;]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
          assert.ok(ref.startsWith('./') || ref.startsWith('../'), `non-relative import: ${ref}`);
          local(ref);
        }
        assert.doesNotMatch(source, /\bimport\s*\(/);
        if (path.startsWith('shared/')) {
          assert.doesNotMatch(source, /\b(?:createFrameScope|captureOwnedViewport|createOwnedDialog)\b/);
        }
      }
    }
    assert.equal(manifest.permissions.includes('debugger'), !firefox);
    assert.equal(manifest.web_accessible_resources, undefined);
    assert.equal(manifest.action.default_popup, 'shared/popup.html');
    for (const path of [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
      manifest.action.default_popup]) visit(path);
    for (const online of [false, true]) {
      let icons;
      await setBridgeIcon({ async setIcon({ path }) { icons = path; } }, online);
      for (const icon of Object.values(icons)) {
        assert.ok(icon.startsWith('/'), `icon must resolve from the extension root: ${icon}`);
        visit(icon.slice(1));
      }
    }
    if (firefox) {
      assert.deepEqual(manifest.browser_specific_settings.gecko, {
        id: 'vabu@local.invalid',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['browsingActivity', 'websiteContent', 'websiteActivity'] },
      });
      assert.deepEqual(manifest.background.scripts, ['firefox/background.mjs']);
      assert.equal(manifest.background.service_worker, undefined);
      visit(manifest.background.scripts[0]);
      assert.match(staged.get(manifest.background.scripts[0]).toString(), /['"]firefox\/content\.js['"]/);
      visit('firefox/content.js');
      const content = staged.get('firefox/content.js').toString();
      assert.doesNotThrow(() => new Script(content)); // Classic script, not an ES module.
      assert.doesNotMatch(content, /\beval\s*\(|\bnew Function\s*\(/);
    } else {
      assert.equal(manifest.background.service_worker, 'chrome/worker.js');
      assert.equal(manifest.background.scripts, undefined);
      visit(manifest.background.service_worker);
    }
    assert.deepEqual(visited, new Set(staged.keys()), 'no tooling, unused assets or other browser files');
  });
}
