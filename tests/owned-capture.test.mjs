import test from 'node:test';
import assert from 'node:assert/strict';
import { captureOwnedViewport } from '../extension/chrome/owned-capture.mjs';
import { maxCaptureBase64Length } from '../extension/shared/capture-jpeg.mjs';

function setup() {
  let invalid = false, closed = 0, calls = 0;
  const options = {
    tabId: 42,
    createGuard: async (id) => {
      assert.equal(id, 42);
      return { assertValid: async () => { if (invalid) throw new Error('guard invalid'); }, close: async () => { closed++; } };
    },
    sendCommand: async (target, method, params) => {
      calls++;
      assert.deepEqual(target, { tabId: 42 });
      assert.equal(method, 'Page.captureScreenshot');
      assert.deepEqual(params, { format: 'jpeg', quality: 80, captureBeyondViewport: false });
      return { data: '/9j/AAAA' };
    },
  };
  return { options, invalidate: () => { invalid = true; }, counts: () => [calls, closed] };
}

test('captures the selected tab viewport once and closes the guard', async () => {
  const s = setup();
  assert.equal(await captureOwnedViewport(s.options), '/9j/AAAA');
  assert.deepEqual(s.counts(), [1, 1]);
});

test('PNG capture keeps the same tab-scoped viewport guard and omits JPEG quality', async () => {
  const s = setup();
  const png = 'iVBORw0KGgo=';
  const actual = await captureOwnedViewport({ ...s.options, format: 'png', sendCommand: async (...args) => {
    assert.deepEqual(args, [{ tabId: 42 }, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }]);
    return { data: png };
  } });
  assert.equal(actual, png);
  assert.equal(s.counts()[1], 1);
});

test('rejects invalid ownership or permission before capture', async () => {
  const s = setup(); s.invalidate();
  await assert.rejects(captureOwnedViewport(s.options), /guard invalid/);
  assert.deepEqual(s.counts(), [0, 1]);
});

test('rejects transient navigation or permission changes during capture', async () => {
  const s = setup(); const send = s.options.sendCommand;
  s.options.sendCommand = async (...args) => { const result = await send(...args); s.invalidate(); return result; };
  await assert.rejects(captureOwnedViewport(s.options), /guard invalid/);
  assert.deepEqual(s.counts(), [1, 1]);
});

test('does not retry debugger errors or accept malformed and oversized results', async () => {
  for (const result of [new Error('rejected'), { data: 'not jpeg' }, { data: '/9j/' + 'A'.repeat(maxCaptureBase64Length) }]) {
    const s = setup(); let calls = 0;
    s.options.sendCommand = async () => { calls++; if (result instanceof Error) throw result; return result; };
    await assert.rejects(captureOwnedViewport(s.options));
    assert.equal(calls, 1);
    assert.equal(s.counts()[1], 1);
  }
});
