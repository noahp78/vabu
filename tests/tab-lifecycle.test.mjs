import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetWorkspaceWindow, manageOwnedTab, openBackgroundTab, watchManagedGroup } from '../extension/shared/tab-lifecycle.mjs';

const href = 'https://example.test/';
const normal = id => ({ id, type: 'normal', incognito: false });
const noop = () => {};
const event = () => {
  const listeners = new Set();
  return {
    addListener: fn => listeners.add(fn),
    removeListener: fn => listeners.delete(fn),
    fire: value => { for (const fn of listeners) fn(value); },
    get size() { return listeners.size; },
  };
};

test('background opens keep independent window anchors and recover after window removal', async () => {
  let focused = 1;
  let fail = true;
  const owner = { groups: new Map() };
  const bridge = { groups: new Map(), workspaces: new Map([['named', owner]]) };
  const api = {
    windows: { async getLastFocused() { return normal(focused); } },
    tabs: { async create(options) {
      assert.equal(options.active, false);
      if (fail) throw new Error('Window disappeared');
      return options;
    } },
  };
  const open = workspace => openBackgroundTab(api, workspace, new URL(href), noop, 'Browser');
  await assert.rejects(open(owner), /Window disappeared/);
  fail = false;
  focused = 2;
  assert.equal((await open(owner)).windowId, 2);
  focused = 3;
  assert.equal((await open(bridge)).windowId, 3);
  assert.equal((await open(owner)).windowId, 2);
  owner.groups.set(2, 42);
  forgetWorkspaceWindow(bridge, 2);
  assert.equal(owner.groups.has(2), false);
  focused = 4;
  assert.equal((await open(owner)).windowId, 4);
  assert.equal((await open(bridge)).windowId, 3);
});

test('managed group assertions reject live ownership loss and relevant events after verification', async () => {
  const selected = { id: 10, windowId: 2, groupId: 42 };
  const sibling = { ...selected, id: 11 };
  const owner = { groups: new Map([[2, 42]]) };
  const owned = new Set([10, 11]);
  const api = {
    tabs: { group: noop, async get() { return selected; }, async query() { return [selected, sibling]; } },
    tabGroups: { onMoved: event(), async get() { return { id: 42, windowId: 2 }; } },
    windows: { onRemoved: event() },
  };
  const guard = watchManagedGroup(api);
  const pin = () => guard.pin(owner, selected, id => owned.has(id));
  const scope = pin();
  await scope.verify();
  api.windows.onRemoved.fire(3);
  api.tabGroups.onMoved.fire({ id: 43, windowId: 2 });
  scope.assertCurrent();
  owned.delete(11);
  assert.throws(scope.assertCurrent, /VABU-managed group/);
  owned.add(11);
  api.tabGroups.onMoved.fire({ id: 42, windowId: 2 });
  assert.throws(scope.assertCurrent, /VABU-managed group/);
  const next = pin();
  await next.verify();
  api.windows.onRemoved.fire(2);
  assert.throws(next.assertCurrent, /VABU-managed group/);
  assert.throws(scope.assertCurrent, /VABU-managed group/);
});

test('tab commands fail closed on navigation, permission or bridge changes', async () => {
  let tab = { id: 10, windowId: 2, url: href, status: 'complete', active: false };
  let granted = true;
  let connected = true;
  let owned = true;
  let duringQuery = noop, duringPermission = noop;
  const onRemoved = event(), onDetached = event();
  const api = {
    permissions: { async contains() { duringPermission(); return granted; } },
    windows: { async get(id) { return normal(id); }, update: assert.fail },
    tabs: {
      async get() { return { ...tab }; },
      onRemoved, onDetached,
      async query() { duringQuery(); return [{ id: 10 }, { id: 20 }]; },
      update: assert.fail,
      remove: assert.fail,
    },
  };
  const manage = verb => manageOwnedTab(api, verb, ['10'], () => owned, () => {
    if (!connected) throw new Error('Bridge stopped');
  });
  duringQuery = () => { tab.url = `${href}other`; };
  await assert.rejects(manage('tab-close'), /changed/);
  tab.url = href;
  duringQuery = () => { tab.pinned = true; };
  await assert.rejects(manage('tab-close'), /active or pinned/);
  tab.pinned = false;
  duringQuery = () => { granted = false; };
  await assert.rejects(manage('tab-close'), /not granted/);
  await assert.rejects(manage('tab-show'), /not granted/);
  granted = true;
  duringQuery = () => { owned = false; };
  await assert.rejects(manage('tab-close'), /not owned/);
  owned = true;
  duringQuery = () => { connected = false; };
  await assert.rejects(manage('tab-close'), /Bridge stopped/);
  connected = true;
  for (const departed of [onRemoved, onDetached]) {
    duringQuery = () => { duringPermission = () => departed.fire(20); };
    await assert.rejects(manage('tab-close'), /last tab/);
    assert.equal(onRemoved.size, 0);
    assert.equal(onDetached.size, 0);
    duringPermission = noop;
  }
  api.tabs.query = async () => [{ id: 10 }];
  await assert.rejects(manage('tab-close'), /last tab/);
});

test('tab-navigate validates destination and rechecks authorization after release', async () => {
  const tab = { id: 10, windowId: 2, url: href, status: 'complete', active: false };
  const destination = 'https://other.test/path';
  let sourceGranted = true, destinationGranted = true, owned = true, connected = true;
  let window = normal(2), onRelease = noop, onGet = noop, updates = [];
  let rechecking = false, checked = 0;
  const onRemoved = event();
  const api = {
    permissions: { onRemoved, async contains({ origins: [origin] }) {
      if (rechecking) checked++;
      return origin.startsWith('https://other.test/') ? destinationGranted : sourceGranted;
    } },
    windows: { async get() { return window; } },
    tabs: {
      async get() { await onGet(); return { ...tab }; },
      async update(id, options) { updates.push([id, options]); },
    },
  };
  const navigate = (url = destination) => manageOwnedTab(api, 'tab-navigate', ['10', url], () => owned,
    () => { if (!connected) throw new Error('Bridge stopped'); }, async () => onRelease());
  for (const url of ['file:///tmp/a', 'https://user:pass@example.test/', 'not a URL']) {
    await assert.rejects(navigate(url));
  }
  destinationGranted = false;
  await assert.rejects(navigate(), /destination/);
  destinationGranted = true;
  for (const [mutate, pattern, reset] of [
    [() => { sourceGranted = false; }, /not granted/, () => { sourceGranted = true; }],
    [() => { destinationGranted = false; }, /destination/, () => { destinationGranted = true; }],
    [() => { owned = false; }, /not owned/, () => { owned = true; }],
    [() => { connected = false; }, /Bridge stopped/, () => { connected = true; }],
    [() => { tab.url += 'changed'; }, /changed/, () => { tab.url = href; }],
    [() => { window = { ...normal(2), incognito: true }; }, /normal browser window/, () => { window = normal(2); }],
  ]) {
    onRelease = mutate;
    await assert.rejects(navigate(), pattern);
    reset();
  }
  assert.deepEqual(updates, []);
  onRelease = () => { rechecking = true; };
  const started = Promise.withResolvers(), finish = Promise.withResolvers();
  onGet = () => {
    if (!rechecking) return;
    assert.equal(checked, 2);
    started.resolve();
    return finish.promise;
  };
  const pending = navigate();
  await started.promise;
  destinationGranted = false;
  onRemoved.fire({ origins: ['https://other.test/*'] });
  finish.resolve();
  await assert.rejects(pending, /site access changed before navigation/);
  assert.deepEqual(updates, []);
  assert.equal(onRemoved.size, 0);
  onGet = onRelease = noop;
  destinationGranted = true;
  assert.deepEqual(await navigate(href), { tab: 10, requested: true });
  assert.equal(onRemoved.size, 0);
  assert.deepEqual(updates, [[10, { url: href }]]);
});

test('tab-show can activate a still-loading tab with an approved pending URL', async () => {
  const tab = { id: 10, windowId: 2, url: 'about:blank', pendingUrl: href, status: 'loading', active: false };
  const api = {
    permissions: { async contains() { return true; } },
    windows: {
      async get(id) { return normal(id); },
      async update(id, options) {
        assert.equal(tab.active, true);
        assert.equal(id, 2);
        assert.deepEqual(options, { focused: true });
        return { ...normal(id), focused: false };
      },
    },
    tabs: {
      async get() { return { ...tab }; },
      async update(id, options) {
        assert.equal(id, 10);
        assert.deepEqual(options, { active: true });
        tab.active = true;
        tab.url = tab.pendingUrl;
        delete tab.pendingUrl;
      },
    },
  };
  await assert.rejects(manageOwnedTab(api, 'tab-show', ['10', '--wait-load'], () => true, noop), /Usage/);
  api.permissions.contains = async () => false;
  await assert.rejects(manageOwnedTab(api, 'tab-show', ['10'], () => true, noop), /not granted/);
  assert.equal(tab.active, false);
  api.permissions.contains = async () => true;
  assert.deepEqual(await manageOwnedTab(api, 'tab-show', ['10'], () => true, noop),
    { tab: 10, window: 2, active: true, focused: false });
  assert.equal(tab.status, 'loading');
});

test('close and navigate can act during loading or explicitly wait for a committed page', async () => {
  const destination = 'https://other.test/';
  for (const [verb, args, method, value] of [
    ['tab-close', ['10'], 'remove', { tab: 10, closed: true }],
    ['tab-navigate', ['10', destination], 'update', { tab: 10, requested: true }],
  ]) {
    const tab = { id: 10, windowId: 2, url: href, status: 'loading', active: false };
    const actions = [];
    let reads = 0, completeOnPoll = false;
    const api = {
      permissions: { onRemoved: event(), async contains() { return true; } },
      windows: { async get(id) { return normal(id); } },
      tabs: {
        async get() {
          if (++reads === 5 && completeOnPoll) tab.status = 'complete';
          return { ...tab };
        },
        async query() { return [{ id: 10 }, { id: 20 }]; },
        async [method]() { actions.push(tab.status); },
      },
    };
    const run = (...flags) => manageOwnedTab(api, verb, [...args, ...flags], () => true, noop);
    assert.deepEqual(await run(), value);
    assert.deepEqual(actions, ['loading']);
    tab.pendingUrl = destination;
    await assert.rejects(run(), /not available or changed/);
    delete tab.pendingUrl;
    completeOnPoll = true;
    reads = 0;
    assert.deepEqual(await run('--wait-load'), value);
    assert.deepEqual(actions, ['loading', 'complete']);
  }
});
