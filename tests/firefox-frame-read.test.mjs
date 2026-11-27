import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { navigationEvents } from '../extension/firefox/frame-read.mjs';

const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn),
    fire(...args) { let result; for (const fn of listeners) result = fn(...args); return result; } };
};

test('Firefox binds frame reads and screenshots to the owned, selected document and rechecks before disclosure', async () => {
  const top = { tabId: 2, frameId: 0, parentFrameId: -1, documentId: 'top', url: 'https://parent.example/' };
  const child = { tabId: 2, frameId: 4, parentFrameId: 0, parentDocumentId: 'top', documentId: 'child', url: 'https://child.example/private?q=secret' };
  const frames = new Map([[0, top], [4, child],
    [5, { ...child, frameId: 5, parentFrameId: 4, documentId: 'nested' }],
    [6, { ...child, frameId: 6, parentDocumentId: 'other-top', documentId: 'orphan' }],
    [7, { ...child, frameId: 7, documentId: 'opaque' }],
    [8, { ...child, frameId: 8, documentId: undefined }]]);
  const nav = Object.fromEntries(navigationEvents.map((name) => [name, event()]));
  let legacy = true, childGranted = true, owners = true, afterRead, wrongResultId, native;
  const injected = [];
  let ownedSelection = true, captureGrant = false, captureCalls = 0, onCapture, onProbe, badJpeg = false;
  let active = false, activeTabId = 2, feedbackToken;
  const styleRef = `@i${crypto.randomUUID()}:1`;
  let selectionKey, rootGranted = true, styleCalls = 0, afterStyle;
  let evalCalls = 0, afterEval, afterTiming, onGroupQuery;
  const timing = { type: 'navigate', responseStart: 1, domInteractive: 2, domContentLoaded: 3, load: 4 };
  const storage = {};
  const tabGroups = new Map();
  const membership = new Map();
  let ownedWindow = 1;
  const tab = (id) => ({ id, url: top.url, status: 'complete', windowId: id === 2 ? ownedWindow : 1,
    groupId: membership.get(id) ?? -1, active: active && id === activeTabId });
  globalThis.browser = {
    runtime: { id: 'vabu-test', onMessage: event(), getURL: () => 'popup', connectNative: () => native = {
      onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) {
        if (message.type === 'configure') queueMicrotask(() => this.onMessage.fire({ ready: true, socketName: 'firefox-default' }));
        else this.reply = message;
      },
    } },
    storage: { local: { async get() { return { ...storage }; }, async set(settings) { Object.assign(storage, settings); } } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains({ origins }) {
      return origins.every((origin) => origin === '<all_urls>' ? captureGrant : origin.includes('child.example') ? childGranted : rootGranted);
    } },
    windows: { async getLastFocused() { return { id: 1, type: 'normal' }; } },
    webNavigation: Object.assign(nav, {
      async getFrame({ tabId, frameId }) {
        const frame = frames.get(frameId);
        return frame && { ...frame, tabId, documentId: legacy ? undefined : frame.documentId };
      },
      async getAllFrames() { return [...frames.values()]; },
    }),
    tabGroups: { async get(id) { return tabGroups.get(id); }, async update(id, values) { Object.assign(tabGroups.get(id), values); } },
    tabs: { onRemoved: event(), onUpdated: event(), async get(id) { return tab(id); }, async create({ windowId }) { return { ...tab(2), windowId }; },
      async group({ groupId, tabIds, createProperties }) {
        if (groupId === undefined) {
          groupId = tabGroups.size + 1;
          tabGroups.set(groupId, { id: groupId, windowId: createProperties.windowId });
        }
        for (const id of tabIds) membership.set(id, groupId);
        return groupId;
      },
      captureVisibleTab: assert.fail, update: assert.fail,
      async query(options) {
        if ('groupId' in options) {
          const snapshot = [tab(1), tab(2)].filter(entry => entry.groupId === options.groupId);
          await onGroupQuery?.();
          return snapshot;
        }
        assert.deepEqual(options, { active: true, currentWindow: true });
        return [tab(activeTabId)];
      },
      async captureTab(id, options) {
        assert.equal(id, 2);
        assert.deepEqual(options, options.format === 'png' ? { format: 'png' } : { format: 'jpeg', quality: 80 });
        captureCalls++;
        onCapture?.();
        if (options.format === 'png') return 'data:image/png;base64,iVBORw0KGgo=';
        return badJpeg ? 'data:image/png;base64,/9j/2Q==' : 'data:image/jpeg;base64,/9j/2Q==';
      },
      connect(id, details) {
        assert.deepEqual(details, { name: 'vabu-selected-document', ...(legacy || !ownedSelection ? { frameId: 0 } : { documentId: top.documentId }) });
        return { onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage({ id, op, args }) {
          if (op === 'init') selectionKey = args[2];
          const value = op === 'inspect' ? { count: 1, items: [{ ref: styleRef }] } : undefined;
          this.onMessage.fire({ id, result: { ok: true, value } });
        } };
      },
    },
    scripting: { async executeScript({ target, files, func, args, world }) {
      if (target.frameIds) { assert.deepEqual(target.frameIds, [0]); assert.ok(files); return; }
      if (world === 'MAIN') {
        assert.deepEqual(target, { tabId: 2, documentIds: [top.documentId] });
        assert.equal(func.name, 'evalInPage');
        assert.deepEqual(args, [new URL(top.url).origin, top.url, 'document.title', 16384]);
        evalCalls++;
        afterEval?.();
        return [{ frameId: 0, documentId: top.documentId, result: '"Firefox fixture"' }];
      }
      assert.equal(world, 'ISOLATED');
      assert.equal(target.frameIds, undefined);
      assert.equal(target.documentIds.length, 1);
      const frame = [...frames.values()].find(({ documentId }) => documentId === target.documentIds[0]);
      assert.ok(frame);
      injected.push(frame.documentId);
      let result;
      if (func?.name === 'func') {
        assert.equal(frame.frameId, 0);
        assert.deepEqual(args, [new URL(top.url).origin, top.url]);
        onProbe?.();
        result = true;
      }
      if (func?.name === 'navigationTiming') {
        assert.deepEqual(args, [top.url]);
        result = timing;
        afterTiming?.();
      }
      if (func?.name === 'iframeOwnersInPage') result = owners;
      if (func?.name === 'frameTextInPage') {
        assert.deepEqual(args.slice(0, 3), [new URL(frame.url).origin, frame.url, 'https://parent.example']);
        result = frame.documentId === 'opaque' ? null : args[3] ? true : { text: 'safe', truncated: false };
        if (!args[3]) afterRead?.();
      }
      if (func?.name === 'inspectionPage') {
        if (args[2] === 'styles') {
          assert.equal(frame.frameId, 0);
          assert.deepEqual(args, ['https://parent.example', selectionKey, 'styles', styleRef, null, top.url]);
          styleCalls++;
          afterStyle?.();
          result = { ok: true, value: { styles: { color: 'rgb(0, 0, 0)' } } };
        } else {
          assert.equal(frame.frameId, 4);
          assert.deepEqual(args[4], { parentHref: top.url, href: frame.url });
          result = { ok: true, value: true };
        }
      }
      if (func?.name === 'feedbackInPage') {
        assert.equal(frame.frameId, 0);
        assert.equal(args[0], top.url);
        feedbackToken = args[1];
        result = true;
      }
      return [{ frameId: frame.frameId, documentId: wrongResultId ?? frame.documentId, result }];
    } },
  };
  try {
    await import('../extension/firefox/background.mjs');
    assert.deepEqual(await browser.runtime.onMessage.fire({ action: 'start' }, { url: 'popup' }), { ok: true });
    async function send(...args) {
      await native.onMessage.fire({ id: 'fixture', args });
      return native.reply;
    }
    async function run(...args) {
      const reply = await send(...args);
      assert.equal(reply.error, undefined);
      return reply.value;
    }
    async function reject(pattern, ...args) {
      const reply = await send(...args);
      assert.match(reply.error, pattern);
      assert.equal(reply.value, undefined);
    }
    ownedSelection = false;
    await run('use', '1');
    ownedSelection = true;
    assert.equal(await run('url'), top.url);
    assert.deepEqual(await run('tab-info'), { tab: 1, origin: 'https://parent.example', window: 1, active: false });
    await reject(/Usage/, 'url', 'extra');
    await reject(/opened by VABU/, 'js', 'timing');
    await reject(/Usage/, 'js', 'timing', 'extra');
    await reject(/opened by VABU/, 'frame-list');
    await reject(/opened by VABU/, 'screenshot');
    await reject(/opened by VABU/, 'get', 'styles', styleRef);
    await reject(/opened by VABU/, 'eval', 'document.title');
    await reject(/Not supported/, 'enable-screenshots');
    assert.equal(await browser.runtime.onMessage.fire({ action: 'enable-screenshots' }, { url: 'popup' }), false);
    const { sessionId } = await run('session-start', 'Frames');
    const scoped = ['--session', sessionId];
    const { group } = await run(...scoped, 'open', top.url);
    await run(...scoped, 'use', '2');
    await reject(/require verified document IDs/, ...scoped, 'js', 'timing');
    await reject(/require verified document IDs/, ...scoped, 'frame-list');
    await reject(/require verified document IDs/, ...scoped, 'screenshot');
    await reject(/require verified document IDs/, ...scoped, 'get', 'styles', styleRef);
    await reject(/require verified document IDs/, ...scoped, 'eval', 'document.title');
    legacy = false;
    const normalUrl = top.url;
    top.url = 'http://127.0.0.1:4567/?private=query';
    await run(...scoped, 'use', '2');
    assert.equal(await run(...scoped, 'url'), top.url);
    assert.deepEqual(await run(...scoped, 'tab-info'), { tab: 2, origin: 'http://127.0.0.1:4567', window: 1, active: false });
    membership.set(1, group); // Timing does not require a managed group.
    assert.deepEqual(await run(...scoped, 'js', 'timing'), timing);
    membership.delete(1);
    let timingProbes = 0;
    onProbe = () => { if (++timingProbes === 3) rootGranted = false; };
    await reject(/Cannot verify/, ...scoped, 'js', 'timing');
    rootGranted = true;
    timingProbes = 0;
    await reject(/Cannot verify/, ...scoped, 'tab-info');
    rootGranted = true;
    onProbe = undefined;
    afterTiming = () => { rootGranted = false; };
    await reject(/Cannot verify/, ...scoped, 'js', 'timing');
    rootGranted = true;
    afterTiming = undefined;
    frames.set(0, { ...top, documentId: 'replacement' });
    await reject(/Cannot verify/, ...scoped, 'url');
    await reject(/Cannot verify/, ...scoped, 'tab-info');
    await reject(/Cannot verify/, ...scoped, 'js', 'timing');
    frames.set(0, top);
    const expression = [...scoped, 'eval', 'document.title'];
    const evalPopup = { url: 'popup', id: 'vabu-test' };
    const popupMessage = (action, token, sender = evalPopup) => browser.runtime.onMessage.fire({ action, token }, sender);
    const evalStatus = async () => (await popupMessage('status')).evalApproval;
    const setMode = (evalMode, sender = evalPopup) => browser.runtime.onMessage.fire({ action: 'set-eval-mode', evalMode }, sender);
    assert.equal((await popupMessage('status')).evalMode, 'ask');
    assert.equal((await popupMessage('status', null, { url: 'popup' })).evalMode, undefined);
    assert.equal(await setMode('allow', { ...evalPopup, tab: tab(2) }), false);
    assert.match((await setMode('always')).error, /Invalid eval mode/);
    await reject(/Select a tab for this VABU session/, 'eval', 'document.title');
    await reject(/Open the VABU popup/, ...expression);
    const first = await evalStatus();
    assert.deepEqual(first, { token: first.token, origin: 'http://127.0.0.1:4567', expression: 'document.title' });
    assert.equal(await popupMessage('eval-approve', first.token, { ...evalPopup, tab: tab(2) }), false);
    assert.equal(await popupMessage('eval-approve', first.token, { ...evalPopup, url: top.url }), false);
    assert.equal(await popupMessage('eval-approve', first.token, { ...evalPopup, id: 'wrong' }), false);
    assert.equal((await popupMessage('status', null, { url: 'popup' })).evalApproval, undefined);
    await reject(/Open the VABU popup/, ...expression);
    assert.equal(evalCalls, 0);
    assert.deepEqual(await popupMessage('eval-deny', first.token), { ok: true });
    assert.equal(await evalStatus(), undefined);
    await reject(/Open the VABU popup/, ...expression);
    assert.match((await popupMessage('eval-approve', first.token)).error, /stale/);
    assert.deepEqual(await popupMessage('eval-approve', (await evalStatus()).token), { ok: true });
    frames.set(0, { ...top, documentId: 'same-url-eval-reload' });
    await reject(/Cannot verify/, ...expression);
    assert.equal(evalCalls, 0);
    frames.set(0, top);
    await reject(/Open the VABU popup/, ...expression);
    await popupMessage('eval-approve', (await evalStatus()).token);
    assert.equal(await run(...expression), 'Firefox fixture');
    await reject(/Open the VABU popup/, ...expression);
    await popupMessage('eval-approve', (await evalStatus()).token);
    afterEval = () => { rootGranted = false; };
    await reject(/Cannot verify/, ...expression);
    assert.equal(evalCalls, 2);
    assert.equal(await evalStatus(), undefined);
    rootGranted = true;
    afterEval = undefined;
    await reject(/Open the VABU popup/, ...expression);
    const stale = (await evalStatus()).token;
    assert.deepEqual(await setMode('off'), { ok: true });
    assert.match((await popupMessage('eval-approve', stale)).error, /stale/);
    await reject(/Eval is off/, ...expression);
    assert.deepEqual(await setMode('ask'), { ok: true });
    await reject(/Open the VABU popup/, ...expression);
    membership.set(1, group);
    assert.match((await popupMessage('eval-approve', (await evalStatus()).token)).error, /Cannot verify/);
    membership.delete(1);
    assert.deepEqual(await setMode('allow'), { ok: true });
    assert.equal(await run(...expression), 'Firefox fixture');
    membership.delete(2);
    await reject(/Cannot verify/, ...expression);
    membership.set(2, group);
    membership.set(1, group);
    await reject(/Cannot verify/, ...expression);
    membership.delete(1);
    const groupApi = browser.tabGroups;
    delete browser.tabGroups;
    await reject(/VABU-managed group/, ...expression);
    await reject(/VABU-managed group/, ...scoped, 'get', 'styles', styleRef);
    browser.tabGroups = groupApi;
    afterEval = () => { membership.delete(2); };
    await reject(/Cannot verify/, ...expression);
    assert.equal(evalCalls, 4);
    afterEval = undefined;
    membership.set(2, group);
    top.url = normalUrl;
    await run(...scoped, 'use', '2');
    const { items: [{ ref }] } = await run(...scoped, 'inspect-query', '{"css":"p"}');
    const readStyle = [...scoped, 'get', 'styles', ref];
    assert.deepEqual(await run(...readStyle), { styles: { color: 'rgb(0, 0, 0)' } });
    await reject(/Select a tab for this VABU session/, 'get', 'styles', ref);
    membership.delete(2);
    await reject(/VABU-managed group/, ...readStyle);
    membership.set(2, group);
    ownedWindow = 2;
    await reject(/VABU-managed group/, ...readStyle);
    ownedWindow = 1;
    membership.set(1, group);
    await reject(/VABU-managed group/, ...readStyle);
    membership.delete(1);
    rootGranted = false;
    await reject(/Cannot verify/, ...readStyle);
    assert.equal(styleCalls, 1);
    rootGranted = true;

    // The query returns its pre-event snapshot on both the dispatch and reply paths.
    onGroupQuery = () => {
      membership.delete(2);
      browser.tabs.onUpdated.fire(2, { groupId: -1 });
    };
    await reject(/VABU-managed group/, ...readStyle);
    assert.equal(styleCalls, 1);
    membership.set(2, group);
    let queries = 0;
    onGroupQuery = () => {
      if (++queries !== 3) return;
      membership.set(1, group);
      browser.tabs.onUpdated.fire(1, { groupId: group });
    };
    const liveExpression = [...scoped, 'eval', 'document.title'];
    await reject(/Cannot verify/, ...liveExpression);
    assert.equal(evalCalls, 5);
    membership.delete(1);
    onGroupQuery = () => browser.tabs.onUpdated.fire(1, { title: 'Unrelated', status: 'complete' });
    assert.deepEqual(await run(...readStyle), { styles: { color: 'rgb(0, 0, 0)' } });
    onGroupQuery = undefined;
    afterStyle = () => frames.set(0, { ...top, documentId: 'same-url-style-reload' });
    await reject(/Cannot verify/, ...readStyle);
    frames.set(0, top);
    afterStyle = undefined;
    await reject(/Select a tab for this VABU session/, 'frame-list');
    childGranted = false;
    assert.deepEqual(await run(...scoped, 'frame-list'), []);
    childGranted = true;
    const list = () => run(...scoped, 'frame-list');
    const get = (id) => run(...scoped, 'frame-read', id);
    const [frame, ...rest] = await list();
    assert.deepEqual(rest, []);
    assert.deepEqual(frame, { id: frame.id, origin: 'https://child.example' });
    assert.equal(typeof frame.id, 'string');
    assert.deepEqual(await get(frame.id), { text: 'safe', truncated: false });
    assert.ok(!injected.includes('nested') && !injected.includes('orphan'));

    let [{ id }] = await list();
    assert.notEqual(id, frame.id);
    await reject(/Cannot verify/, ...scoped, 'frame-read', frame.id);
    [{ id }] = await list();
    wrongResultId = 'wrong';
    await reject(/Cannot verify/, ...scoped, 'frame-read', id);
    wrongResultId = undefined;
    [{ id }] = await list();
    afterRead = () => { frames.set(4, { ...child, documentId: 'replacement' }); };
    await reject(/Cannot verify/, ...scoped, 'frame-read', id); // Same URL and frame ID, different document.
    frames.set(4, child);
    [{ id }] = await list();
    afterRead = () => { nav.onHistoryStateUpdated.fire({ tabId: 2, frameId: 4 }); };
    await reject(/Cannot verify/, ...scoped, 'frame-read', id);
    [{ id }] = await list();
    afterRead = () => { childGranted = false; };
    await reject(/Cannot verify/, ...scoped, 'frame-read', id);
    childGranted = true;
    [{ id }] = await list();
    afterRead = () => { frames.set(0, { ...top, documentId: 'replacement-top' }); };
    await reject(/Cannot verify/, ...scoped, 'frame-read', id);
    frames.set(0, top);
    [{ id }] = await list();
    afterRead = () => { owners = false; };
    await reject(/Cannot verify/, ...scoped, 'frame-read', id);
    await reject(/Cannot verify/, ...scoped, 'frame-list');

    owners = true;
    child.documentId = 'known-live-child-document';
    assert.deepEqual(await run(...scoped, 'frames'), []);
    const oldChildUrl = child.url;
    child.url = new URL('direct', top.url).href;
    assert.deepEqual(await run(...scoped, 'frames'), [{ frameId: 4, documentId: child.documentId }]);
    const frameTerms = ['--frame', '4', child.documentId];
    assert.deepEqual(await run(...scoped, 'inspect-wait', ...frameTerms, 'load', '1000'), { event: 'load' });
    frames.set(4, { ...child, documentId: 'reloaded-same-frame-and-url' });
    await reject(/Cannot verify/, ...scoped, 'inspect-element', ...frameTerms, '{"css":"button"}');
    frames.set(4, child);
    child.url = oldChildUrl;
    const popup = { url: 'popup', id: 'vabu-test' };
    const feedbackStart = () => browser.runtime.onMessage.fire({ action: 'feedback-start' }, popup);
    assert.match((await feedbackStart()).error, /Open a normal website tab/);
    active = true;
    activeTabId = 1;
    assert.deepEqual(await feedbackStart(), { ok: true });
    assert.deepEqual(await browser.runtime.onMessage.fire({ action: 'feedback-submit', token: feedbackToken,
      points: [{ note: 'Existing tab', target: null }] }, { id: 'vabu-test', frameId: 0, tab: tab(1), url: top.url }), { ok: true });
    assert.equal((await browser.runtime.onMessage.fire({ action: 'status' }, popup)).feedbackCount, 1);
    assert.equal(await browser.runtime.onMessage.fire({ action: 'feedback-list' }, { ...popup, tab: tab(1) }), false);
    assert.deepEqual(await browser.runtime.onMessage.fire({ action: 'feedback-list' }, popup),
      { total: 1, feedback: [{ page: top.url, target: null, note: 'Existing tab', workspace: null }] });
    assert.deepEqual(await run('feedback'), { feedback: [{ page: top.url, target: null, note: 'Existing tab' }] });
    activeTabId = 2;
    assert.deepEqual(await feedbackStart(), { ok: true }); // No <all_urls> needed for feedback.
    const message = { action: 'feedback-submit', points: [{ target: '#example', note: ' Comment ' }], token: feedbackToken };
    const sender = { id: popup.id, frameId: 0, url: top.url, tab: tab(2) };
    assert.match((await browser.runtime.onMessage.fire(message, { ...sender, frameId: 4 })).error, /current active document/);
    assert.deepEqual(await browser.runtime.onMessage.fire(message, sender), { ok: true });
    assert.match((await browser.runtime.onMessage.fire(message, sender)).error, /current active document/);
    assert.deepEqual(await run('feedback'), { feedback: [] });
    assert.deepEqual(await run(...scoped, 'feedback'), { feedback: [{ page: top.url, target: '#example', note: 'Comment' }] });
    assert.deepEqual(await run(...scoped, 'feedback'), { feedback: [] });
    active = false;

    const capture = [...scoped, 'screenshot'];
    const reselect = () => run(...scoped, 'use', '2');
    await reject(/Select a tab for this VABU session/, 'screenshot');
    await reject(/Enable Firefox screenshots/, ...capture);
    assert.equal(captureCalls, 0);
    captureGrant = true;
    const captureTab = browser.tabs.captureTab;
    delete browser.tabs.captureTab;
    await reject(/tab-ID capture is unavailable/, ...capture);
    browser.tabs.captureTab = captureTab;
    assert.equal(await run(...capture), '/9j/2Q==');
    const options = JSON.stringify({ format: 'png', ifChanged: true });
    assert.deepEqual(await run(...capture, options), { format: 'png', changedRatio: 1, data: 'iVBORw0KGgo=' });
    assert.deepEqual(await run(...capture, options), { format: 'png', changedRatio: 0, unchanged: true });
    badJpeg = true;
    await reject(/Invalid or oversized JPEG/, ...capture);
    badJpeg = false;
    onCapture = () => { captureGrant = false; }; // Recheck even if no notification has arrived.
    await reject(/Enable Firefox screenshots/, ...capture);
    captureGrant = true;
    onCapture = () => browser.permissions.onRemoved.fire({ origins: ['<all_urls>'] });
    await reject(/Cannot verify/, ...capture); // Revoked and restored before the post-check.
    await reselect();
    onCapture = () => frames.set(0, { ...top, documentId: 'replacement-top' });
    await reject(/Cannot verify/, ...capture); // Same URL, different root document.
    frames.set(0, top);
    onCapture = undefined;
    onProbe = () => nav.onHistoryStateUpdated.fire({ tabId: 2, frameId: 0 });
    const previousCalls = captureCalls;
    await reject(/Cannot verify/, ...capture);
    assert.equal(captureCalls, previousCalls);
    await reselect();
    let probes = 0;
    onProbe = () => { if (++probes === 2) nav.onBeforeNavigate.fire({ tabId: 2, frameId: 0 }); };
    await reject(/Cannot verify/, ...capture); // Transient change during final verification.
    assert.equal(captureCalls, previousCalls + 1);
    await reselect();
    probes = 0;
    onProbe = () => { if (++probes === 2) captureGrant = false; };
    await reject(/Cannot verify/, ...capture); // Grant lost during the final document probe, without an event.
    captureGrant = true;
    onProbe = undefined;
    await run(...scoped, 'release');
    await reject(/opened by VABU/, ...capture);
    await browser.runtime.onMessage.fire({ action: 'stop' }, { url: 'popup' });
    await browser.runtime.onMessage.fire({ action: 'start' }, { url: 'popup' });
    ownedSelection = false;
    await run('use', '2');
    await reject(/opened by VABU/, 'screenshot');
  } finally {
    delete globalThis.browser;
  }
});

test('Firefox declares all-sites screenshot access only as an optional host permission', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/firefox/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  assert.ok(![...manifest.permissions, ...manifest.host_permissions, ...(manifest.optional_permissions ?? [])].includes('<all_urls>'));
  for (const permission of ['debugger', 'activeTab']) assert.ok(!manifest.permissions.includes(permission));
});
