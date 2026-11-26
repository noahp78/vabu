import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { hasHostAccess, webUrl } from '../extension/shared/domains.js';

test('all web hosts are requested, but Chrome decides access to each host', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../extension/chrome/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.incognito, 'not_allowed');
  const checked = [];
  const permissions = { async contains({ origins: [pattern] }) {
    checked.push(pattern);
    return pattern !== 'https://withheld.test/*';
  } };
  assert.equal(await hasHostAccess(permissions, webUrl('http://localhost:8123/fixture')), true);
  assert.equal(await hasHostAccess(permissions, webUrl('https://sub.example.test/page')), true);
  assert.equal(await hasHostAccess(permissions, webUrl('https://withheld.test/')), false);
  assert.deepEqual(checked, ['http://localhost/*', 'https://sub.example.test/*', 'https://withheld.test/*']);
  for (const url of ['chrome://settings/', 'file:///tmp/fixture', 'https://user:secret@example.test/']) {
    assert.throws(() => webUrl(url));
  }
});
