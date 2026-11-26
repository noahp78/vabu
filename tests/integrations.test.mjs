import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { commands, inPageIntegration } from '../extension/chrome/integrations.mjs';

const origin = 'https://approved.example';
const current = async () => {};

test('sensitive actions require separate trusted confirmation and checked manual handoff', async () => {
  for (const action of ['download', 'upload', 'clipboard-copy', 'clipboard-paste', 'show-tab', 'sign-in']) {
    const trace = [];
    const ctx = {
      assertCurrent: async () => trace.push('current'),
      pauseForManualHandoff: async (intent) => { trace.push(['handoff', intent]); return true; },
    };
    await assert.rejects(commands[action]([], ctx), /Trusted extension confirmation/);
    await assert.rejects(commands[action](['--yes'], ctx), /Invalid/);
    assert.deepEqual(trace, []);
    ctx.confirmIntegration = async () => false;
    await assert.rejects(commands[action]([], ctx), /did not confirm/);
    assert.deepEqual(trace, ['current']);
    trace.length = 0;
    ctx.confirmIntegration = async (intent, flags) => { trace.push(['confirm', intent, flags]); return true; };
    assert.deepEqual(await commands[action]([], ctx), { handoff: action, manual: true });
    assert.deepEqual(trace, ['current', ['confirm', action, { handoff: true }], 'current', ['handoff', action]]);
  }
});

test('standalone confirmation is an acknowledgement, not a reusable grant', async () => {
  const ctx = {
    assertCurrent: current,
    confirmIntegration: async (intent, flags) => intent === 'upload' && flags.handoff === false,
    pauseForManualHandoff: async () => assert.fail('approval replayed'),
  };
  assert.deepEqual(await commands.confirm(['upload'], ctx), { confirmed: true, action: 'upload' });
  await assert.rejects(commands.upload([], ctx), /did not confirm/);
  await assert.rejects(commands.confirm(['run arbitrary operation'], ctx), /Unsupported/);
  await assert.rejects(commands['sign-in']([], { assertCurrent: current }), /manual handoff is unavailable/);
});

test('navigation during a confirmation prevents handoff; incomplete handoff is not reported as success', async () => {
  let valid = true;
  const ctx = {
    assertCurrent: async () => { if (!valid) throw new Error('document changed'); },
    confirmIntegration: async () => { valid = false; return true; },
    pauseForManualHandoff: async () => assert.fail('must not hand off a different document'),
  };
  await assert.rejects(commands['sign-in']([], ctx), /document changed/);
  await assert.rejects(commands['sign-in']([], {
    assertCurrent: current, confirmIntegration: async () => true, pauseForManualHandoff: async () => false,
  }), /did not complete/);
});

test('site export availability is checked both before and after approval without invoking a control', async () => {
  let observed = true;
  const ctx = {
    assertCurrent: current,
    page: async (operation) => {
      assert.equal(operation, 'integration-export-available');
      return observed;
    },
    confirmIntegration: async () => { observed = false; return true; },
    pauseForManualHandoff: async () => assert.fail('export unavailable'),
  };
  await assert.rejects(commands.export([], ctx), /No same-origin download link/);
  ctx.confirmIntegration = async () => assert.fail('must not prompt when export is already unavailable');
  await assert.rejects(commands.export([], ctx), /No same-origin download link/);
  observed = true;
  ctx.confirmIntegration = async () => true;
  ctx.pauseForManualHandoff = async () => true;
  assert.deepEqual(await commands.export([], ctx), { handoff: 'export', manual: true });
});

function page(operation, { entries = [], links = [], actualOrigin = origin, top = true } = {}) {
  const window = {};
  window.top = top ? window : {};
  const result = vm.runInNewContext(`(${inPageIntegration.toString()})(origin, operation)`, {
    window, URL, origin, operation, location: { origin: actualOrigin }, innerWidth: 600, innerHeight: 400,
    document: { links, readyState: 'complete', visibilityState: 'hidden' },
    performance: { getEntriesByType: (type) => { assert.equal(type, 'resource'); return entries; } },
  });
  return JSON.parse(JSON.stringify(result));
}

test('resource observation is capped, origin scoped and emits no URLs or raw timing entries', () => {
  const entries = [
    { name: `${origin}/private-id?a=token#fragment`, initiatorType: 'img' },
    { name: 'https://outside.example/script.js', initiatorType: 'script' },
    { name: 'https://user:password@approved.example/video', initiatorType: 'video' },
    { name: `blob:${origin}/blob-id`, initiatorType: 'video' },
    ...Array(247).fill({ name: `${origin}/script.js`, initiatorType: 'script' }),
  ];
  assert.deepEqual(page('integration-assets', { entries }), {
    counts: { image: 1, script: 246, styleOrLink: 0, media: 0, other: 0 }, truncated: true,
  });
  assert.throws(() => page('integration-assets', { actualOrigin: 'https://outside.example' }), /out of scope/);
  assert.throws(() => page('integration-assets', { top: false }), /out of scope/);
});

test('export detection does not reveal URLs and ignores external, non-web and implicit links', () => {
  const link = (href, explicit = true) => ({ localName: 'a', href, hasAttribute: (name) => name === 'download' && explicit });
  const links = [link('https://outside.example/file'), link(`blob:${origin}/blob-id`), link(`${origin}/file`, false)];
  assert.equal(page('integration-export-available', { links }), false);
  assert.equal(page('integration-export-available', { links: [...links, link(`${origin}/file`)] }), true);
});

test('diagnostics are fixed, filtered and discarded if scope changes during capture', async () => {
  assert.deepEqual(page('integration-inspect'), { readyState: 'complete', visibility: 'hidden', width: 600, height: 400 });
  assert.throws(() => page('eval'), /Unsupported/);
  const ctx = {
    assertCurrent: current,
    integrationLayoutMetrics: async () => ({ cssLayoutViewport: { clientWidth: 640, clientHeight: 480, pageX: 22 }, secret: 'discard' }),
  };
  assert.deepEqual(await commands['layout-metrics']([], ctx), { width: 640, height: 480 });
  await assert.rejects(commands['layout-metrics'](['Runtime.evaluate'], ctx), /Invalid/);
  ctx.integrationLayoutMetrics = async () => ({ cssLayoutViewport: { clientWidth: 200, clientHeight: '600' } });
  await assert.rejects(commands['layout-metrics']([], ctx), /Invalid layout metrics/);
  let valid = true;
  ctx.assertCurrent = async () => { if (!valid) throw new Error('scope changed'); };
  ctx.page = async (operation) => { valid = false; return page(operation); };
  await assert.rejects(commands.assets([], ctx), /scope changed/);
});

test('temporary viewport sends bounded dimensions or reset only', async () => {
  const changes = [];
  const ctx = { assertCurrent: current, integrationViewport: async (size) => changes.push(size) };
  await assert.rejects(commands.viewport(['640', '480'], { assertCurrent: current }), /unavailable/);
  await assert.rejects(commands.viewport(['640', '8192'], ctx), /200 to 4096/);
  await assert.rejects(commands.viewport(['0400', '1e3'], ctx), /200 to 4096/);
  await assert.rejects(commands.viewport(['640', '480', '99999'], ctx), /Invalid/);
  assert.deepEqual(await commands.viewport(['640', '480'], ctx), { width: 640, height: 480, expiresWithinMs: 30000 });
  assert.deepEqual(await commands.viewport(['reset'], ctx), { reset: true });
  assert.deepEqual(changes, [{ width: 640, height: 480 }, null]);
});

test('unsupported features never consult a transport, permission or testing API', async () => {
  assert.equal(commands.constructor, undefined);
  const untouched = new Proxy({}, { get: () => assert.fail('unsupported operation must not access context') });
  for (const name of ['webmcp-list', 'webmcp-call', 'hide-tab', 'console-logs']) {
    await assert.rejects(commands[name]([], untouched), /unavailable|No supported|no scoped/);
  }
});
