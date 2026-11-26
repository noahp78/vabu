import assert from 'node:assert/strict';
import { test } from 'node:test';

const event = () => ({ addListener(fn) { this.fire = fn; } });
const storage = (data = {}) => ({ data, async get(key) { return { [key]: data[key] }; },
  async set(values) { Object.assign(data, values); } });

for (const browser of ['chrome', 'firefox']) {
  test(`${browser}: socket name, startup policy, and serialized stop/edit/start`, { timeout: 4000 }, async (t) => {
    const chromium = browser === 'chrome';
    const apiName = chromium ? 'chrome' : 'browser';
    const source = chromium ? '../extension/chrome/worker.js' : '../extension/firefox/background.mjs';
    const local = storage({ bridgeSocketName: 'work' });
    const session = storage();
    let configured = Promise.withResolvers();
    let connections = 0;
    const onMessage = event();
    const toolbar = {};
    const api = globalThis[apiName] = {
      storage: { local, session },
      runtime: { onMessage, onStartup: event(), onInstalled: event(), getURL(path) {
        assert.equal(path, 'shared/popup.html');
        return 'popup';
      }, connectNative(name) {
        assert.equal(name, 'local.vabu');
        connections++;
        return { onDisconnect: event(), onMessage: event(), disconnect() { this.closed = true; },
          postMessage(message) { configured.resolve({ connection: this, message }); } };
      } },
      action: {
        async setBadgeText({ text }) { toolbar.badge = text; },
        async setIcon({ path }) { toolbar.icon = path[16]; },
      },
      permissions: { onRemoved: event() },
      debugger: { onDetach: event(), onEvent: event() },
      tabs: { onRemoved: event(), onUpdated: event() },
    };
    t.after(() => { delete globalThis[apiName]; });
    const send = (action, props) => {
      const message = { action, ...props };
      return chromium
        ? new Promise(resolve => assert.equal(onMessage.fire(message, { url: 'popup' }, resolve), true))
        : onMessage.fire(message, { url: 'popup' });
    };
    const next = async (selector) => {
      const { connection, message } = await configured.promise;
      assert.deepEqual(message, { type: 'configure', socketName: selector });
      configured = Promise.withResolvers();
      return connection;
    };

    await import(source);
    const state = await send('status');
    assert.equal(state.browser, browser);
    assert.equal(state.socketName, 'work');
    assert.equal(state.connected, false);
    assert.equal(state.starting, chromium);
    assert.equal(onMessage.fire({ action: 'set-socket', socketOverride: 'other' }, { url: 'not-popup' }), false);
    assert.equal(connections, Number(chromium));
    const start = send('start');
    const first = await next('work');
    assert.match((await send('set-socket', { socketOverride: 'other' })).error, /Stop/);
    await first.onMessage.fire({ ready: true, socketName: 'work' });
    assert.deepEqual(await start, { ok: true });
    assert.equal((await send('status')).connected, true);
    assert.deepEqual(toolbar, { badge: '', icon: '/shared/icons/vabu-online-16.png' });
    assert.match((await send('set-socket', { socketOverride: null })).error, /Stop/);
    assert.equal(local.data.bridgeSocketName, 'work');
    assert.deepEqual(await send('stop'), { ok: true });
    assert.equal(first.closed, true);
    assert.deepEqual(toolbar, { badge: '', icon: '/shared/icons/vabu-16.png' });

    if (chromium) {
      assert.equal(session.data.bridgeMode, 'stopped');
      await import(`${source}?reloaded`);
      await api.runtime.onStartup.fire();
      const stopped = await send('status');
      assert.equal(stopped.connected || stopped.starting, false);
      assert.equal(connections, 1);
    }
    assert.match((await send('set-socket', { socketOverride: 'BAD' })).error, /Socket name/);
    const set = local.set;
    local.set = async () => { throw new Error('Storage unavailable'); };
    assert.deepEqual(await send('set-socket', { socketOverride: 'other' }), { error: 'Storage unavailable' });
    assert.equal((await send('status')).socketName, 'work');
    local.set = set;

    const entered = Promise.withResolvers();
    const commit = Promise.withResolvers();
    local.set = async (values) => {
      entered.resolve();
      await commit.promise;
      await set(values);
    };
    const save = send('set-socket', { socketOverride: 'other' });
    await entered.promise;
    const pending = send('start');
    assert.equal(connections, 1);
    commit.resolve();
    assert.deepEqual(await save, { ok: true });
    const second = await next('other');
    assert.deepEqual(await send('stop'), { ok: true }); // Don't wait for the host's ready frame.
    assert.match((await pending).error, /stopped/);
    assert.equal(second.closed, true);
    await second.onMessage.fire({ ready: true, socketName: 'other' });
    assert.equal((await send('status')).connected, false);
    assert.deepEqual(await send('set-socket', { socketOverride: null }), { ok: true });
    assert.equal((await send('status')).socketOverride, null);

    const fallback = send('start');
    const legacy = await next(`${browser}-default`);
    await legacy.onMessage.fire({ ready: true }); // An outdated host wouldn't echo the selector.
    assert.match((await fallback).error, /Update the VABU native host/);
    assert.equal(legacy.closed, true);
    assert.deepEqual(toolbar, { badge: 'ERR', icon: '/shared/icons/vabu-16.png' });
    assert.equal((await send('status')).connected, false);
  });
}
