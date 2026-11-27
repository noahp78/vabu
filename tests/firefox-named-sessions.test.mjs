import assert from 'node:assert/strict';
import test from 'node:test';

const event = () => {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire(...args) { let result; for (const fn of listeners) result = fn(...args); return result; },
  };
};

test('Firefox named sessions isolate selection, ownership and safe group reuse', async () => {
  const url = 'https://example.test/';
  const tab = { id: 1, url, active: true, windowId: 1, status: 'complete' };
  const tabs = new Map([[tab.id, tab]]);
  const groups = new Map();
  const actions = [];
  let nextTab = 1;
  let windowId = 1;
  let granted = true;
  let native;
  globalThis.browser = {
    runtime: { onMessage: event(), getURL: () => 'popup', connectNative: () => native = {
      onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) {
        if (message.type === 'configure') {
          assert.equal(message.socketName, 'firefox-default');
          queueMicrotask(() => this.onMessage.fire({ ready: true, socketName: 'firefox-default' }));
        } else this.reply = message;
      },
    } },
    storage: { local: { async get() { return {}; } } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains() { return granted; }, async getAll() { return { origins: ['<all_urls>'] }; } },
    windows: {
      onRemoved: event(),
      async getLastFocused(options) {
        assert.deepEqual(options, { windowTypes: ['normal'] });
        return { id: windowId, type: 'normal', incognito: !windowId };
      },
      async get(id) { return { id, type: 'normal', incognito: false }; },
      async update(id, options) {
        assert.deepEqual(options, { focused: true });
        windowId = id;
        return { ...await this.get(id), focused: true };
      },
    },
    scripting: { async executeScript({ target, files }) {
      assert.deepEqual(target.frameIds, [0]);
      assert.deepEqual(files, ['firefox/content.js']);
      actions.push([target.tabId, 'inject']);
    } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async get(id) { return tabs.get(id); },
      async query({ groupId, windowId }) {
        return [...tabs.values()].filter(tab =>
          (groupId === undefined || groupId === tab.groupId) && (windowId === undefined || windowId === tab.windowId));
      },
      async update(id, options) {
        const target = tabs.get(id);
        if (options.url) { target.url = options.url; return target; }
        assert.deepEqual(options, { active: true });
        for (const sibling of tabs.values()) if (sibling.windowId === target.windowId) sibling.active = sibling === target;
        return target;
      },
      async remove(id) {
        tabs.delete(id);
        this.onRemoved.fire(id);
      },
      async create(options) {
        assert.equal(options.url, url);
        assert.equal(options.active, false);
        const tab = { id: ++nextTab, ...options, status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      async group({ groupId = groups.size + 1, tabIds, createProperties }) {
        if (createProperties) groups.set(groupId, { windowId: createProperties.windowId });
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        return groupId;
      },
      connect(tabId, options) {
        assert.deepEqual(options, { name: 'vabu-selected-document', frameId: 0 });
        return { onMessage: event(), onDisconnect: event(), disconnect() {
          actions.push([tabId, 'disconnect']);
        }, postMessage({ id, op }) {
          actions.push([tabId, op]);
          this.onMessage.fire({ id, result: { ok: true, value: op === 'snapshot' ? { tabId } : true } });
        } };
      },
    },
    tabGroups: {
      async get(id) { return groups.get(id); },
      async update(id, props) { Object.assign(groups.get(id), props); },
    },
  };
  try {
    await import('../extension/firefox/background.mjs');
    const popup = action => browser.runtime.onMessage.fire({ action }, { url: 'popup' });
    assert.deepEqual(await popup('start'), { ok: true });
    async function send(...args) {
      await native.onMessage.fire({ id: 'fixture', args });
      return native.reply;
    }
    async function run(...args) {
      const reply = await send(...args);
      assert.equal(reply.error, undefined);
      return reply.value;
    }
    async function fails(pattern, ...args) {
      assert.match((await send(...args)).error, pattern);
    }
    await fails(/session name/, 'session-start', 'x\u200B');
    await fails(/Unknown VABU session ID/, '--session', 'unknown', 'status');
    const a = await run('session-start', ' Checkout ');
    const b = await run('session-start', 'Checkout'); // Group reuse must never be by name alone.
    assert.notEqual(a.sessionId, b.sessionId);
    assert.deepEqual(await run('session-list'), [a, b]);
    const A = ['--session', a.sessionId], B = ['--session', b.sessionId];
    windowId = 0;
    await fails(/normal Firefox window/, ...A, 'open', url);
    windowId = 1;
    granted = false;
    await fails(/not granted access/, ...A, 'open', url);
    assert.equal(tabs.size, 1);
    granted = true;
    const first = await run(...A, 'open', url);
    const sibling = await run(...A, 'open', url);
    const second = await run(...B, 'open', url);
    const regular = await run('open', url);
    windowId = 2;
    const elsewhere = await run(...A, 'open', url);
    assert.equal(first.group, sibling.group);
    assert.equal(first.group, elsewhere.group);
    assert.equal(tabs.get(elsewhere.tab).windowId, 1);
    assert.equal(new Set([first.group, second.group, regular.group]).size, 3);
    assert.deepEqual(groups.get(first.group), { windowId: 1, title: 'Checkout', color: 'purple' });
    assert.equal(groups.get(regular.group).title, 'VABU');
    // A manually moved foreign tab makes the old group unsafe to reuse.
    tabs.get(second.tab).groupId = first.group;
    windowId = 1;
    const replacement = await run(...A, 'open', url);
    assert.notEqual(replacement.group, first.group);
    assert.equal(tabs.get(second.tab).groupId, first.group);
    assert.deepEqual((await run(...A, 'tabs')).map(({ tab }) => tab), [first.tab, sibling.tab, elsewhere.tab, replacement.tab]);
    assert.equal((await run('tabs')).length, tabs.size);

    await fails(/does not belong/, ...A, 'use', String(tab.id));
    await fails(/does not belong/, 'use', String(first.tab));
    assert.deepEqual(actions, []);
    await run('use', String(tab.id)); // Existing tabs still use Firefox's browser grants.
    assert.equal((await run('status')).tab, tab.id);
    await run(...A, 'use', String(first.tab));
    assert.deepEqual(actions, [[tab.id, 'inject'], [tab.id, 'init'], [tab.id, 'disconnect'], [first.tab, 'inject'], [first.tab, 'init']]);
    for (const scope of [[], B]) {
      assert.equal((await run(...scope, 'status')).tab, null);
      await fails(/Select a tab/, ...scope, 'snapshot');
      await run(...scope, 'release');
    }
    assert.deepEqual(await run(...A, 'session-status'), { ...a, tab: first.tab });
    assert.equal((await run(...A, 'status')).tab, first.tab);
    assert.deepEqual(await run(...A, 'snapshot'), { tabId: first.tab });
    await fails(/does not belong/, ...B, 'use', String(first.tab));
    await fails(/Unsupported session action/, ...A, 'session-handoff');
    await fails(/Unsupported session action/, 'session-audit');
    await fails(/Unsupported session action/, 'session-start');
    await run(...B, 'use', String(second.tab));
    assert.deepEqual(actions.slice(-3), [[first.tab, 'disconnect'], [second.tab, 'inject'], [second.tab, 'init']]);

    assert.deepEqual(await run(...A, 'session-end'), { ended: true });
    await fails(/Unknown VABU session ID/, ...A, 'tabs');
    assert.deepEqual(await run(...B, 'snapshot'), { tabId: second.tab });
    await fails(/not owned/, ...B, 'tab-navigate', String(tab.id), url);
    assert.deepEqual(await run('tab-navigate', String(regular.tab), url), { tab: regular.tab, requested: true });
    assert.equal((await run(...B, 'status')).tab, second.tab);
    assert.deepEqual(await run(...B, 'tab-navigate', String(second.tab), url), { tab: second.tab, requested: true });
    assert.equal((await run(...B, 'status')).tab, null);
    await run(...B, 'use', String(second.tab));
    browser.tabs.onUpdated.fire(second.tab, { status: 'loading' }); // Includes same-URL reloads.
    assert.equal((await run(...B, 'session-status')).tab, null);
    await fails(/Select an allowed Firefox tab/, ...B, 'snapshot');
    await run(...B, 'use', String(second.tab));
    granted = false;
    browser.permissions.onRemoved.fire({ origins: ['<all_urls>'] });
    await fails(/not granted access/, ...B, 'use', String(second.tab));
    assert.deepEqual(await run(...B, 'tabs'), []);
    granted = true;
    await run(...B, 'use', String(second.tab));
    assert.deepEqual(await run(...B, 'session-end'), { ended: true });
    assert.deepEqual(actions.at(-1), [second.tab, 'disconnect']);
    assert.equal(tabs.size, 7);
    assert.equal(groups.size, 4);
    assert.deepEqual([...tabs.values()].filter(tab => tab.active).map(tab => tab.id), [tab.id]);
    await fails(/not owned/, 'tab-close', String(second.tab)); // Ended session tabs are no longer owned.
    await fails(/not owned/, 'tab-show', String(tab.id));
    windowId = 2;
    assert.deepEqual(await run('tab-show', String(regular.tab)),
      { tab: regular.tab, window: 1, active: true, focused: true });
    assert.equal(windowId, 1);
    assert.equal((await run('status')).tab, null);
    await fails(/active or pinned/, 'tab-close', String(regular.tab));
    const unused = await run('open', url);
    assert.deepEqual(await run('tab-close', String(unused.tab)), { tab: unused.tab, closed: true });
    await fails(/not owned/, 'tab-close', String(unused.tab));
    await run('use', String(second.tab)); // Ending a session does not permanently claim its tabs.
    const c = await run('session-start', 'Temporary');
    assert.deepEqual(await popup('stop'), { ok: true });
    assert.deepEqual(await popup('start'), { ok: true });
    assert.deepEqual(await run('session-list'), []);
    await fails(/Unknown VABU session ID/, '--session', c.sessionId, 'status');
    assert.deepEqual(await popup('stop'), { ok: true });
  } finally {
    delete globalThis.browser;
  }
});
