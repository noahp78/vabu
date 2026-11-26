import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedDialog } from '../extension/chrome/owned-dialog.mjs';

test('exposes only supported type and fresh opaque ID; explicit tab-scoped response', async () => {
  const calls = [];
  const dialog = createOwnedDialog({ tabId: 7, sendCommand: async (...args) => {
    calls.push(args);
    dialog.closed({ result: false, userInput: 'ignored' });
  } });
  dialog.opening({ type: 'prompt', message: 'secret', defaultPrompt: 'secret' });
  const first = dialog.getCurrent();
  assert.deepEqual(Object.keys(first).sort(), ['id', 'type']);
  dialog.opening({ type: 'confirm' });
  const second = dialog.getCurrent();
  assert.notEqual(first.id, second.id);
  await assert.rejects(dialog.respond(first.id, 'accept'));
  assert.equal(calls.length, 0);
  await dialog.respond(second.id, 'dismiss');
  assert.deepEqual(calls, [[{ tabId: 7 }, 'Page.handleJavaScriptDialog', { accept: false }]]);
  assert.equal(dialog.getCurrent(), null);
  await assert.rejects(dialog.respond(second.id, 'dismiss'));
  for (const type of ['beforeunload', 'other']) {
    dialog.opening({ type });
    assert.equal(dialog.getCurrent(), null);
  }
});

test('pending response cannot be duplicated and invalidation cannot erase a newer dialog', async () => {
  let resolve;
  const dialog = createOwnedDialog({ tabId: 1, sendCommand: () => new Promise(r => { resolve = r; }) });
  dialog.opening({ type: 'alert' });
  const id = dialog.getCurrent().id;
  const result = dialog.respond(id, 'accept');
  await assert.rejects(dialog.respond(id, 'accept'));
  dialog.invalidate();
  dialog.opening({ type: 'confirm' });
  const next = dialog.getCurrent();
  await assert.rejects(dialog.respond(next.id, 'accept'));
  resolve();
  await assert.rejects(result, /indeterminate/);
  assert.deepEqual(dialog.getCurrent(), next);
  dialog.closed({ result: false });
  assert.equal(dialog.getCurrent(), null);
  dialog.dispose();
  dialog.opening({ type: 'alert' });
  assert.equal(dialog.getCurrent(), null);
});

test('requires a matching close, including when close arrives after command resolution', async () => {
  const dialog = createOwnedDialog({ tabId: 1, sendCommand: async () => {} });
  dialog.opening({ type: 'confirm' });
  const first = dialog.respond(dialog.getCurrent().id, 'accept');
  await Promise.resolve();
  dialog.closed({ result: true });
  await first;
  dialog.opening({ type: 'confirm' });
  const second = dialog.respond(dialog.getCurrent().id, 'accept');
  dialog.closed({ result: false });
  await assert.rejects(second, /indeterminate/);
  assert.equal(dialog.getCurrent(), null);
});

test('a replacement opening before dispatch completion is never consumed as the old ID', async () => {
  const dialog = createOwnedDialog({ tabId: 1, sendCommand: async () => {
    dialog.closed({ result: true });
    dialog.opening({ type: 'prompt' });
  } });
  dialog.opening({ type: 'alert' });
  const id = dialog.getCurrent().id;
  await assert.rejects(dialog.respond(id, 'accept'), /indeterminate/);
  assert.equal(dialog.getCurrent().type, 'prompt');
  assert.notEqual(dialog.getCurrent().id, id);
  await assert.rejects(dialog.respond(id, 'accept'), /stale/);
});

test('failed dispatch invalidates the ID', async () => {
  const dialog = createOwnedDialog({ tabId: 0, sendCommand: async () => { throw new Error('failed'); } });
  dialog.opening({ type: 'alert' });
  await assert.rejects(dialog.respond(dialog.getCurrent().id, 'accept'));
  assert.equal(dialog.getCurrent(), null);
});
