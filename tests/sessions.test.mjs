import assert from 'node:assert/strict';
import test from 'node:test';
import { commands, createSessionState, setSessionDataOptIn } from '../extension/chrome/sessions.mjs';

function fixture() {
  const origin = 'http://127.0.0.1:8123';
  const tab = { id: 3, url: `${origin}/current?key=fixture`, title: 'Fixture', windowId: 5, active: false, groupId: -1 };
  const other = { id: 8, windowId: 7, groupId: -1 };
  const calls = [];
  let attached = true;
  let connected = true;
  const ctx = {
    tabId: tab.id,
    origin,
    sessionState: createSessionState(),
    assertBridge() { if (!connected) throw new Error('Disconnected'); },
    async assertCurrent() { if (!attached) throw new Error('Selection changed'); },
    async releaseSelection() { calls.push(['release']); attached = false; },
    browser: {
      permissions: {
        async contains({ origins }) { return origins?.[0] === 'http://127.0.0.1/*'; },
      },
      tabs: {
        async get() { return { ...tab }; },
        async reload(tabId) { calls.push(['reload', tabId]); },
        async group(options) { calls.push(['group', options]); return 6; },
        async query() { return [tab, { id: 33 }]; },
        async move(...args) { calls.push(['move', ...args]); },
      },
      windows: {
        async create(options) { calls.push(['create', options]); return { id: 7, tabs: [other] }; },
        async get() { return { type: 'normal', tabs: [other] }; },
      },
    },
  };
  return { tab, other, ctx, calls, reconnect: () => { attached = true; }, disconnect: () => { connected = false; },
    run: (verb, ...args) => commands[verb](args, ctx) };
}

test('12: selected metadata and reload require current, approved URL', async () => {
  const { tab, ctx, run, calls } = fixture();
  assert.equal(await run('title'), 'Fixture');
  assert.equal(await run('url'), tab.url);
  assert.deepEqual(await run('tab-info'), { tab: 3, window: 5, origin: ctx.origin, active: false });
  assert.deepEqual(await run('reload'), { requested: true });
  await assert.rejects(run('title', 'extra'), /arguments/);
  tab.pendingUrl = `${ctx.origin}/next`;
  await assert.rejects(run('url'), /changed/);
  delete tab.pendingUrl;
  ctx.browser.permissions.contains = async () => false;
  await assert.rejects(run('reload'), /approved/);
  assert.deepEqual(calls, [['reload', 3]]);
});

test('12: no metadata is returned if the bridge disconnects during the read', async () => {
  const { tab, ctx, run, disconnect } = fixture();
  ctx.browser.tabs.get = async () => { disconnect(); return tab; };
  await assert.rejects(run('title'), /Disconnected/);
});

test('12: back/forward send only validated same-origin history entries', async () => {
  const { tab, ctx, run } = fixture();
  const entries = [{ id: 10, url: `${ctx.origin}/before` }, { id: 11, url: tab.url }, { id: 12, url: `${ctx.origin}/after` }];
  const moves = [];
  ctx.navigation = { history: async () => ({ currentIndex: 1, entries }), go: async (entry) => moves.push(entry) };
  await run('back');
  await run('forward');
  entries[0].url = 'http://127.0.0.1:8124/other';
  await assert.rejects(run('back'), /outside/);
  entries[2].url = `http://user:secret@127.0.0.1:8123/private`;
  await assert.rejects(run('forward'), /credentials/);
  assert.deepEqual(moves, [
    { currentIndex: 1, currentUrl: tab.url, entryId: 10, targetUrl: `${ctx.origin}/before` },
    { currentIndex: 1, currentUrl: tab.url, entryId: 12, targetUrl: `${ctx.origin}/after` },
  ]);
});

test('12: navigation rejects a stale selected document or URL', async () => {
  const { tab, ctx, run } = fixture();
  ctx.navigation = {
    history: async () => {
      tab.url = `${ctx.origin}/changed`;
      return { currentIndex: 1, entries: [{ id: 10, url: `${ctx.origin}/before` }] };
    },
    go: () => assert.fail('must not navigate'),
  };
  await assert.rejects(run('back'), /changed/);
});

test('13: group creation is limited to owned, ungrouped tabs', async () => {
  const { tab, ctx, run, calls } = fixture();
  await assert.rejects(run('tab-group-new'), /VABU-created/);
  ctx.sessionState.tabs.add(tab.id);
  tab.groupId = 46;
  await assert.rejects(run('tab-group-new'), /ungrouped/);
  tab.groupId = -1;
  tab.pinned = true;
  await assert.rejects(run('tab-group-new'), /unpinned/);
  tab.pinned = false;
  assert.deepEqual(await run('tab-group-new'), { group: 6 });
  assert.deepEqual(calls, [['group', { tabIds: [3], createProperties: { windowId: 5 } }]]);
});

test('14: move only to owned windows without touching user tabs or groups', async () => {
  const { tab, other, ctx, run, calls } = fixture();
  ctx.sessionState.tabs.add(tab.id);
  await assert.rejects(run('tab-move-window', '7'), /not owned/);
  assert.deepEqual(await run('window-new'), { window: 7 });
  ctx.browser.windows.get = async () => ({ type: 'normal', tabs: [other, { id: 98, groupId: -1 }] });
  await assert.rejects(run('tab-move-window', '7'), /not a private/);
  ctx.browser.windows.get = async () => ({ type: 'normal', tabs: [other] });
  other.groupId = 42;
  await assert.rejects(run('tab-move-window', '7'), /ungrouped/);
  other.groupId = -1;
  ctx.browser.tabs.query = async () => [tab];
  await assert.rejects(run('tab-move-window', '7'), /close the source/);
  ctx.browser.tabs.query = async () => [tab, { id: 33 }];
  assert.deepEqual(await run('tab-move-window', '7'), { moved: true });
  assert.deepEqual(calls, [
    ['create', { url: `${ctx.origin}/`, type: 'normal', focused: false }],
    ['move', tab.id, { windowId: 7, index: -1 }],
  ]);
});

test('15/18: session handoff, result, checked restoration and content-free audit', async () => {
  const { tab, ctx, run, calls, reconnect, disconnect } = fixture();
  assert.deepEqual(await run('session-status'), { active: false });
  await run('session-start');
  await assert.rejects(run('session-start'), /End the current/);
  await run('session-handoff');
  await run('session-result', 'ok');
  await assert.rejects(run('session-result', 'free text'), /Expected/);
  assert.deepEqual(await run('session-status'), { active: true, handedOff: true, result: 'ok' });
  await assert.rejects(run('session-restore'), /Selection changed/);
  reconnect();
  tab.id = ctx.tabId = 99;
  await assert.rejects(run('session-restore'), /original session tab/);
  tab.id = ctx.tabId = 3;
  await run('session-restore');
  assert.deepEqual(await run('session-end'), { ended: true, result: 'ok' });
  assert.deepEqual(calls, [['release'], ['release']]);
  const events = await run('session-audit');
  assert.deepEqual(events.map(({ action }) => action), ['session-start', 'session-handoff', 'session-result', 'session-restore', 'session-end']);
  assert.ok(events.every((entry) => Object.keys(entry).sort().join() === 'action,at' && Number.isFinite(entry.at)));
  disconnect();
  await assert.rejects(run('session-audit'), /Disconnected/);
});

test('17: scoped counts require trusted opt-in and existing permissions, and do not return raw data', async () => {
  const { tab, ctx, run, calls } = fixture();
  ctx.browser.history = { getVisits: async (options) => { calls.push(options); return [{ visitId: 'private' }]; } };
  ctx.browser.bookmarks = { search: async (options) => { calls.push(options); return [tab, { url: 'http://127.0.0.1:6123/private' }]; } };
  await assert.rejects(run('history-current'), /opt-in/);
  setSessionDataOptIn(ctx.sessionState, ctx.origin, true);
  await assert.rejects(run('history-current'), /permission/);
  assert.deepEqual(calls, []);
  ctx.browser.permissions.contains = async () => true;
  assert.deepEqual(await run('history-current'), { count: 1 });
  assert.deepEqual(await run('bookmarks-current'), { count: 1 });
  assert.deepEqual(calls, [{ url: tab.url }, { url: tab.url }]);
  ctx.browser.history.getVisits = async () => {
    setSessionDataOptIn(ctx.sessionState, ctx.origin, false);
    return [];
  };
  await assert.rejects(run('history-current'), /opt-in/);
});
