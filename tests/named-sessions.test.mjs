import assert from 'node:assert/strict';
import test from 'node:test';

const event = () => ({ addListener(fn) { this.fire = fn; } });

test('named sessions group their own tabs and reject commands targeting another session', async () => {
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) {
    if (message.type === 'configure') {
      assert.deepEqual(message, { type: 'configure', socketName: 'chrome-default' });
      queueMicrotask(() => this.onMessage.fire({ ready: true, socketName: 'chrome-default' }));
    } else this.reply = message;
  } };
  const tabs = new Map();
  const groups = new Map();
  const pageActions = [];
  const mouseEvents = [];
  const clickMotion = [];
  let visible = true;
  let afterPreview;
  let normalWindow = { id: 1, type: 'normal', incognito: false };
  globalThis.chrome = {
    windows: { async getLastFocused(options) {
      assert.deepEqual(options, { windowTypes: ['normal'] });
      return normalWindow;
    } },
    runtime: { onMessage: event(), onConnect: event(), getURL: () => 'popup', connectNative: () => port },
    storage: { local: { async get() { return {}; } }, session: { async set() {} } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains() { return true; } },
    debugger: { onDetach: event(), onEvent: event(), async attach() {}, async detach() {}, async sendCommand(_target, method, params) {
      if (method === 'Input.dispatchMouseEvent') mouseEvents.push(params.type);
    } },
    webNavigation: {
      onBeforeNavigate: event(), onCommitted: event(), onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event(), onErrorOccurred: event(),
      async getFrame({ tabId, frameId }) {
        assert.equal(frameId, 0);
        return { documentId: `document-${tabId}`, url: tabs.get(tabId).url,
          documentLifecycle: 'active', frameType: 'outermost_frame', errorOccurred: false };
      },
    },
    scripting: { async executeScript({ args, target }) {
      pageActions.push([target.tabId, args[3]]);
      if (args[3] === 'click') { clickMotion.push(args[6]); afterPreview?.(); }
      const documentId = `document-${target.tabId}`;
      if (['click', 'confirmClick', 'clickReceipt'].includes(args[3])) assert.deepEqual(target.documentIds, [documentId]);
      if (args[3] === 'confirmClick' && !tabs.get(target.tabId).active) {
        assert.equal(args[5], true);
        assert.equal(args[6], tabs.get(target.tabId).url);
      }
      const value = args[3] === 'click' ? { x: 10, y: 10 } : args[3] !== 'waitCursor' || visible;
      return [{ documentId, result: { ok: true, value } }];
    } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async get(id) { return tabs.get(id); },
      update: assert.fail,
      async create({ url, windowId, active }) {
        assert.equal(windowId, normalWindow.id);
        assert.equal(active, false);
        const tab = { id: tabs.size + 1, groupId: -1, windowId, url, active, status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      async query({ groupId }) { return [...tabs.values()].filter(tab => groupId === undefined || tab.groupId === groupId); },
      async group({ groupId = groups.size + 1, tabIds }) {
        groups.set(groupId, groups.get(groupId) ?? { windowId: 1 });
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        return groupId;
      },
    },
    tabGroups: {
      async get(id) { return groups.get(id); },
      async update(id, info) { Object.assign(groups.get(id), info); },
    },
  };
  try {
    await import('../extension/chrome/worker.js');
    const started = new Promise(resolve => chrome.runtime.onMessage.fire({ action: 'start' }, { url: 'popup' }, resolve));
    assert.deepEqual(await started, { ok: true });
    async function run(...args) {
      await port.onMessage.fire({ id: 'fixture', args });
      return port.reply.error ?? port.reply.value;
    }
    const savedWindow = normalWindow;
    normalWindow = { id: 2, type: 'app', incognito: false };
    assert.match(await run('open', 'https://example.test/'), /normal Chromium window/);
    assert.equal(tabs.size, 0);
    normalWindow = savedWindow;
    const a = await run('session-start', 'Checkout');
    const b = await run('session-start', 'Catalog');
    assert.notEqual(a.sessionId, b.sessionId);
    const first = await run('--session', a.sessionId, 'open', 'https://example.test/');
    const sibling = await run('--session', a.sessionId, 'open', 'https://example.test/other');
    const second = await run('--session', b.sessionId, 'open', 'https://example.test/');
    assert.equal(first.active, false);
    assert.equal(sibling.active, false);
    assert.equal(second.active, false);
    assert.equal(first.group, sibling.group);
    assert.notEqual(first.group, second.group);
    await run('--session', a.sessionId, 'use', String(first.tab));
    assert.match(await run('--session', b.sessionId, 'use', String(first.tab)), /does not belong/);
    assert.match(await run('--session', b.sessionId, 'snapshot'), /Select a tab/);
    assert.match(await run('use', String(first.tab)), /does not belong/);
    await run('--session', b.sessionId, 'use', String(second.tab));
    assert.deepEqual(pageActions, [[first.tab, 'show'], [first.tab, 'clear'], [second.tab, 'show']]);
    assert.equal(groups.get(first.group).title, 'Checkout');
    assert.equal(groups.get(second.group).title, 'Catalog');
    assert.deepEqual(await run('--session', a.sessionId, 'session-end'), { ended: true });
    assert.deepEqual(await run('session-list'), [b]);
    assert.equal(tabs.size, 3);
    assert.equal(tabs.get(second.tab).active, false);
    const click = () => run('--session', b.sessionId, 'click', '@r1');
    assert.deepEqual(await click(), { x: 10, y: 10, dispatched: true, trusted: true });
    assert.equal(tabs.get(second.tab).active, false);
    assert.deepEqual(mouseEvents.splice(0), ['mousePressed', 'mouseReleased']);
    assert.deepEqual(pageActions.at(-1), [second.tab, 'clickReceipt']);
    afterPreview = () => { tabs.get(second.tab).active = true; };
    assert.match(await click(), /activation changed/);
    assert.deepEqual(mouseEvents, []);
    tabs.get(second.tab).active = false;
    afterPreview = () => chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: second.tab, frameId: 0 });
    assert.match(await click(), /document selection expired/);
    assert.deepEqual(mouseEvents, []);
    afterPreview = undefined;
    tabs.get(second.tab).active = true; // User selects it manually, never the extension.
    assert.deepEqual(await click(), { x: 10, y: 10, dispatched: true });
    assert.deepEqual(mouseEvents, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    visible = false;
    assert.match(await run('--session', b.sessionId, 'click', '@r1'), /not visible/);
    assert.deepEqual(mouseEvents, ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseMoved']);
    assert.deepEqual(clickMotion, [false, false, false, true, true]);
    try {
      assert.match(await run('use', String(first.tab)), /Approval required/);
      assert.match(await run('use', String(sibling.tab)), /Approval required/);
    } finally {
      await run('release');
    }
  } finally {
    delete globalThis.chrome;
  }
});
