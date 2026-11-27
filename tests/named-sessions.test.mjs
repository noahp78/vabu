import assert from 'node:assert/strict';
import test from 'node:test';

const event = () => {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn),
    fire(...args) { let result; for (const fn of listeners) result = fn(...args); return result; },
  };
};

test('named sessions group their own tabs and reject commands targeting another session', async (t) => {
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
  let onMouseEvent;
  let onScrollScript;
  let normalWindow = { id: 1, type: 'normal', incognito: false };
  globalThis.chrome = {
    windows: {
      onRemoved: event(),
      async getLastFocused(options) {
        assert.deepEqual(options, { windowTypes: ['normal'] });
        return normalWindow;
      },
      async get(id) { return { id, type: 'normal', incognito: false }; },
      async update(id, options) {
        assert.deepEqual(options, { focused: true });
        normalWindow = await this.get(id);
        return { ...normalWindow, focused: true };
      },
    },
    runtime: { onMessage: event(), onConnect: event(), getURL: () => 'popup', getManifest: () => ({ version: '1.2.3' }), connectNative: () => port },
    storage: { local: { async get() { return {}; } }, session: { async set() {} } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains() { return true; }, async getAll() { return {}; } },
    debugger: { onDetach: event(), onEvent: event(), async attach() {}, async detach() {}, async sendCommand(_target, method, params) {
      if (method === 'Input.dispatchMouseEvent') {
        mouseEvents.push(params.type);
        await onMouseEvent?.(params);
      }
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
    scripting: { async executeScript({ args, target, func }) {
      pageActions.push([target.tabId, args[3]]);
      if (args[3] === 'click') { clickMotion.push(args[6]); afterPreview?.(); }
      const documentId = `document-${target.tabId}`;
      if (func.name === 'interactionInPage') {
        assert.deepEqual(target.documentIds, [documentId]);
        assert.deepEqual(args.slice(2, 4), ['apply', { kind: 'wheel', dx: 0, dy: 20, start: { ref: '@r1' } }]);
        assert.equal(args[4].href, tabs.get(target.tabId).url);
        await onScrollScript?.();
      }
      if (['click', 'confirmClick', 'clickReceipt', 'scroll'].includes(args[3])) assert.deepEqual(target.documentIds, [documentId]);
      if (args[3] === 'confirmClick' && !tabs.get(target.tabId).active) {
        assert.equal(args[5], true);
        assert.equal(args[6], tabs.get(target.tabId).url);
      }
      const value = ['click', 'scroll'].includes(args[3]) ? { x: 10, y: 10 } : args[3] !== 'waitCursor' || visible;
      return [{ frameId: 0, documentId, result: { ok: true, value } }];
    } },
    tabs: {
      onUpdated: event(), onRemoved: event(),
      async get(id) { return tabs.get(id); },
      async update(id, options) {
        const tab = tabs.get(id);
        if (options.url) { tab.url = options.url; return tab; }
        assert.deepEqual(options, { active: true });
        for (const sibling of tabs.values()) if (sibling.windowId === tab.windowId) sibling.active = sibling === tab;
        return tab;
      },
      async remove(id) {
        tabs.delete(id);
        this.onRemoved.fire(id);
      },
      async create({ url, windowId, active }) {
        assert.equal(active, false);
        const tab = { id: tabs.size + 1, groupId: -1, windowId, url, active, status: 'complete' };
        tabs.set(tab.id, tab);
        return tab;
      },
      async query({ groupId, windowId }) {
        return [...tabs.values()].filter(tab =>
          (groupId === undefined || tab.groupId === groupId) && (windowId === undefined || tab.windowId === windowId));
      },
      async group({ groupId = groups.size + 1, tabIds, createProperties }) {
        if (createProperties) groups.set(groupId, createProperties);
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
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async url => {
        assert.equal(url.href, new URL('../extension/shared/browser-instructions.md', import.meta.url).href);
        return new Response('# Built-in instructions');
      };
      assert.deepEqual(await run('instructions'), { browser: 'chrome', version: '1.2.3', instructions: '# Built-in instructions' });
      assert.match(await run('instructions', 'extra'), /no arguments/);
      const scope = await run('session-start', 'Instructions test');
      assert.match(await run('--session', scope.sessionId, 'instructions'), /cannot be scoped/);
      await run('--session', scope.sessionId, 'session-end');
    } finally { globalThis.fetch = originalFetch; }
    const savedWindow = normalWindow;
    normalWindow = { id: 2, type: 'app', incognito: false };
    assert.match(await run('open', 'https://example.test/'), /normal Chromium window/);
    assert.equal(tabs.size, 0);
    normalWindow = savedWindow;
    const a = await run('session-start', 'Checkout');
    const b = await run('session-start', 'Catalog');
    assert.notEqual(a.sessionId, b.sessionId);
    const first = await run('--session', a.sessionId, 'open', 'https://example.test/');
    normalWindow = { ...savedWindow, id: 2 };
    const sibling = await run('--session', a.sessionId, 'open', 'https://example.test/other');
    const second = await run('--session', b.sessionId, 'open', 'https://example.test/');
    assert.equal(tabs.get(first.tab).windowId, 1);
    assert.equal(tabs.get(sibling.tab).windowId, 1);
    assert.equal(tabs.get(second.tab).windowId, 2);
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

    const scroll = () => run('--session', b.sessionId, 'scroll', '20', '@r1');
    mouseEvents.length = 0;
    assert.equal(await scroll(), true);
    assert.deepEqual(mouseEvents.splice(0), ['mouseMoved', 'mouseWheel']);
    tabs.get(second.tab).active = false;
    assert.equal(await scroll(), true);
    assert.deepEqual(mouseEvents, []);
    onScrollScript = () => chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: second.tab, frameId: 0 });
    assert.match(await scroll(), /selected document changed/i);
    onScrollScript = undefined;

    // Simulate unresolved browser calls. Advancing the worker's clock releases
    // the bridge without retrying, even if the original call later resolves.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      for (const step of ['mouseMoved', 'mouseWheel', 'page']) {
        const started = Promise.withResolvers();
        const pending = Promise.withResolvers();
        const hold = () => { started.resolve(); return pending.promise; };
        tabs.get(second.tab).active = step !== 'page';
        onMouseEvent = event => { if (event.type === step) return hold(); };
        onScrollScript = step === 'page' ? hold : undefined;
        const scrolling = scroll();
        await started.promise;
        assert.match(await run('status'), /Another command is running/);
        t.mock.timers.tick(3000);
        assert.match(await scrolling, /Scroll timed out.*Inspect before retrying/);
        assert.equal((await run('--session', b.sessionId, 'status')).tab, second.tab);
        pending.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(mouseEvents.splice(0), step === 'page' ? [] :
          step === 'mouseMoved' ? ['mouseMoved'] : ['mouseMoved', 'mouseWheel']);
      }
    } finally {
      t.mock.timers.reset();
      onMouseEvent = onScrollScript = undefined;
      tabs.get(second.tab).active = true;
    }
    try {
      assert.match(await run('use', String(first.tab)), /Approval required/);
      assert.match(await run('use', String(sibling.tab)), /Approval required/);
    } finally {
      await run('release');
    }

    const B = ['--session', b.sessionId];
    assert.match(await run('tab-show', String(second.tab)), /not owned/);
    assert.match(await run(...B, 'tab-close', String(first.tab)), /not owned/);
    assert.match(await run('tab-close', String(sibling.tab)), /not owned/);
    assert.match(await run(...B, 'tab-close', String(second.tab)), /active or pinned/);
    assert.equal((await run(...B, 'status')).tab, null);
    const extra = await run(...B, 'open', 'https://example.test/');
    normalWindow = savedWindow;
    assert.deepEqual(await run(...B, 'tab-show', String(extra.tab)),
      { tab: extra.tab, window: 2, active: true, focused: true });
    assert.equal(normalWindow.id, 2);
    assert.equal((await run(...B, 'status')).tab, null);
    assert.match(await run('tab-navigate', String(extra.tab), 'https://example.test/next'), /not owned/);
    await run(...B, 'use', String(extra.tab));
    assert.deepEqual(await run(...B, 'tab-navigate', String(second.tab), 'https://example.test/next'), { tab: second.tab, requested: true });
    assert.equal((await run(...B, 'status')).tab, extra.tab);
    assert.deepEqual(await run(...B, 'tab-navigate', String(extra.tab), 'https://example.test/'), { tab: extra.tab, requested: true });
    assert.equal((await run(...B, 'status')).tab, null);
    assert.deepEqual(await run(...B, 'tab-close', String(second.tab)), { tab: second.tab, closed: true });
    assert.match(await run(...B, 'tab-show', String(second.tab)), /not owned/);
  } finally {
    delete globalThis.chrome;
  }
});
