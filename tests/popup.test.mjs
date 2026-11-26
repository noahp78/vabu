import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

import { defaultSocketNames, socketNameError, validSocketName } from '../extension/shared/socket-name.mjs';

const source = (await readFile(new URL('../extension/shared/popup.js', import.meta.url), 'utf8')).replace(/^import .*;\n/, '');

function popup(browser) {
  const elements = new Map();
  const select = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: true, dataset: {},
      addEventListener(type, listener) { this[type] = listener; } });
    return elements.get(id);
  };
  const state = { browser, connected: false, starting: false, socketName: `${browser}-default`, socketOverride: null };
  const actions = [];
  const decisions = [];
  const copied = [];
  const event = () => ({ addListener(fn) { this.fire = fn; } });
  const channel = { onMessage: event(), onDisconnect: event(), postMessage(message) { decisions.push({ ...message }); } };
  const fixture = { select, state, actions, channel, decisions, copied, approvals: 0, failSave: false };
  const permissionActions = fixture.permissionActions = [];
  const permissions = {
    async contains() { return !!fixture.granted; },
    request({ origins }) {
      permissionActions.push(['request', origins.join()]);
      return new Promise(resolve => { fixture.resolvePermission = value => resolve(fixture.granted = value); });
    },
    async remove({ origins }) { permissionActions.push(['remove', origins.join()]); fixture.granted = false; },
  };
  const runtime = {
    async sendMessage(message) {
      actions.push({ ...message });
      if (message.action === 'status') return { ...state };
      if (message.action === 'set-socket') {
        if (fixture.failSave) return { error: 'Storage unavailable' };
        state.socketOverride = message.socketOverride;
        state.socketName = message.socketOverride ?? `${browser}-default`;
      }
      if (message.action === 'start') state.connected = true;
      if (message.action === 'stop') state.connected = false;
      if (message.action === 'feedback-start' && fixture.feedbackError) return { error: fixture.feedbackError };
      return { ok: true };
    },
    connect({ name }) {
      assert.equal(name, 'tab-approval');
      fixture.approvals++;
      return channel;
    },
  };
  runInNewContext(source, { defaultSocketNames, socketNameError, validSocketName, [browser === 'firefox' ? 'browser' : 'chrome']: { runtime, permissions },
    window: { close() { permissionActions.push(['close']); } },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
    document: { querySelector: select }, setTimeout(fn) { fixture.poll = fn; }, clearTimeout() {} });
  return fixture;
}

test('popup copies the displayed socket and CLI command', async () => {
  const { select, copied } = popup('firefox');
  await setImmediate();
  await select('#copy-socket').click();
  assert.equal(select('#copy-status').textContent, 'Socket name copied.');
  await select('#copy-cli').click();
  assert.equal(select('#copy-status').textContent, 'CLI command copied.');
  assert.deepEqual(copied, ['firefox-default', 'vabu --socket firefox-default status']);
});

test('Firefox popup saves only while stopped, refreshes status, and does not connect for tab approvals', async () => {
  const fixture = popup('firefox');
  const { select, actions } = fixture;
  const submit = () => select('#socket-form').submit({ preventDefault() {} });
  await setImmediate();
  assert.equal(select('#socket').value, '');
  select('#socket').value = 'BAD';
  submit();
  assert.match(select('#socket-status').textContent, /Socket name/);
  assert.equal(actions.length, 1);
  select('#socket').value = 'work-4102';
  fixture.failSave = true;
  submit();
  await setImmediate();
  assert.equal(select('#socket-status').textContent, 'Storage unavailable');
  assert.equal(select('#socket').value, 'work-4102');
  fixture.failSave = false;
  submit();
  await setImmediate();
  assert.deepEqual(actions.slice(-2), [{ action: 'set-socket', socketOverride: 'work-4102' }, { action: 'status' }]);
  assert.match(select('#socket-status').textContent, /Socket name saved/);
  select('#bridge').click();
  await setImmediate();
  assert.equal(select('#bridge-state').dataset.state, 'online');
  assert.equal(select('#socket-save').disabled, true);
  submit();
  assert.deepEqual(actions.slice(-2), [{ action: 'start' }, { action: 'status' }]);
  fixture.state.connected = false;
  fixture.state.bridgeError = 'Native host disconnected';
  fixture.poll();
  await setImmediate();
  assert.equal(select('#socket-save').disabled, false);
  assert.equal(select('#bridge-state').dataset.state, 'error');
  assert.equal(fixture.approvals, 0);
  assert.equal(select('#approval-status').textContent, '');
});

test('trusted Firefox click requests permission before closing the toolbar popup', async () => {
  const firefox = popup('firefox');
  const chrome = popup('chrome');
  await setImmediate();
  assert.equal(chrome.select('#screenshots').hidden, true);
  await chrome.select('#screenshot-permission').click({ isTrusted: true });
  assert.deepEqual(chrome.permissionActions, []);
  assert.equal(firefox.select('#screenshots').hidden, false);
  const button = firefox.select('#screenshot-permission');
  await button.click({ isTrusted: false });
  assert.deepEqual(firefox.permissionActions, []);
  const pending = button.click({ isTrusted: true });
  assert.deepEqual(firefox.permissionActions, [['request', '<all_urls>'], ['close']]);
  firefox.resolvePermission(true);
  await pending;
  assert.equal(button.textContent, 'Revoke screenshot access');
  await button.click({ isTrusted: true });
  assert.equal(button.textContent, 'Enable screenshots');
  assert.deepEqual(firefox.permissionActions, [['request', '<all_urls>'], ['close'], ['remove', '<all_urls>']]);
});

test('page feedback starts only via a trusted click on a connected popup', async () => {
  const fixture = popup('chrome');
  const { select, actions, permissionActions } = fixture;
  const button = select('#feedback');
  await setImmediate();
  await button.click({ isTrusted: true });
  assert.equal(button.disabled, true);
  assert.deepEqual(actions, [{ action: 'status' }]);
  select('#bridge').click();
  await setImmediate();
  await button.click({ isTrusted: false });
  assert.notEqual(actions.at(-1).action, 'feedback-start');
  fixture.feedbackError = 'Select an owned tab';
  await button.click({ isTrusted: true });
  assert.equal(select('#feedback-status').textContent, 'Select an owned tab');
  assert.deepEqual(permissionActions, []);
  fixture.feedbackError = undefined;
  await button.click({ isTrusted: true });
  assert.deepEqual(actions.at(-1), { action: 'feedback-start' });
  assert.deepEqual(permissionActions, [['close']]);
});

test('Chrome popup connects for tab approvals and requires a trusted click with a pending token', async () => {
  const fixture = popup('chrome');
  const { select, channel, decisions } = fixture;
  assert.equal(fixture.approvals, 0); // Wait for the background to identify itself.
  await setImmediate();
  assert.equal(fixture.approvals, 1);
  select('#allow').click({ isTrusted: true });
  channel.onMessage.fire({ state: 'pending', request: { tab: 7, origin: 'https://example.test', token: 'test-token' } });
  assert.equal(select('#approval').hidden, false);
  select('#allow').click({ isTrusted: false });
  assert.deepEqual(decisions, []);
  select('#allow').click({ isTrusted: true });
  assert.deepEqual(decisions, [{ token: 'test-token', decision: 'allow' }]);
  channel.onDisconnect.fire();
  assert.equal(select('#approval').hidden, true);
});
