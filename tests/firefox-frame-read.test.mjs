import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { navigationEvents } from '../extension/firefox/frame-read.mjs';

const event = () => ({ addListener(fn) { this.fire = fn; } });

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
  const tab = (id) => ({ id, url: top.url, status: 'complete', active: active && id === activeTabId });
  globalThis.browser = {
    runtime: { id: 'vabu-test', onMessage: event(), getURL: () => 'popup', connectNative: () => native = {
      onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) {
        if (message.type === 'configure') queueMicrotask(() => this.onMessage.fire({ ready: true, socketName: 'firefox-default' }));
        else this.reply = message;
      },
    } },
    storage: { local: { async get() { return {}; } } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains({ origins }) {
      return origins.every((origin) => origin === '<all_urls>' ? captureGrant : childGranted || !origin.includes('child.example'));
    } },
    windows: { async getLastFocused() { return { id: 1, type: 'normal' }; } },
    webNavigation: Object.assign(nav, {
      async getFrame({ tabId, frameId }) {
        const frame = frames.get(frameId);
        return frame && { ...frame, tabId, documentId: legacy ? undefined : frame.documentId };
      },
      async getAllFrames() { return [...frames.values()]; },
    }),
    tabs: { onRemoved: event(), onUpdated: event(), async get(id) { return tab(id); }, async create() { return tab(2); },
      captureVisibleTab: assert.fail, update: assert.fail,
      async query(options) {
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
        return { onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage({ id }) {
          this.onMessage.fire({ id, result: { ok: true } });
        } };
      },
    },
    scripting: { async executeScript({ target, files, func, args, world }) {
      if (target.frameIds) { assert.deepEqual(target.frameIds, [0]); assert.ok(files); return; }
      assert.equal(world, 'ISOLATED');
      assert.equal(target.frameIds, undefined);
      assert.equal(target.documentIds.length, 1);
      const frame = [...frames.values()].find(({ documentId }) => documentId === target.documentIds[0]);
      assert.ok(frame);
      injected.push(frame.documentId);
      let result;
      if (func?.name === 'func') {
        assert.equal(frame.frameId, 0);
        assert.deepEqual(args, ['https://parent.example', top.url]);
        onProbe?.();
        result = true;
      }
      if (func?.name === 'iframeOwnersInPage') result = owners;
      if (func?.name === 'frameTextInPage') {
        assert.deepEqual(args.slice(0, 3), [new URL(frame.url).origin, frame.url, 'https://parent.example']);
        result = frame.documentId === 'opaque' ? null : args[3] ? true : { text: 'safe', truncated: false };
        if (!args[3]) afterRead?.();
      }
      if (func?.name === 'inspectionPage') {
        assert.equal(frame.frameId, 4);
        assert.deepEqual(args[4], { parentHref: top.url, href: frame.url });
        result = { ok: true, value: true };
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
    await reject(/opened by VABU/, 'frame-list');
    await reject(/opened by VABU/, 'screenshot');
    await reject(/Not supported/, 'enable-screenshots');
    assert.equal(await browser.runtime.onMessage.fire({ action: 'enable-screenshots' }, { url: 'popup' }), false);
    const { sessionId } = await run('session-start', 'Frames');
    const scoped = ['--session', sessionId];
    await run(...scoped, 'open', top.url);
    await run(...scoped, 'use', '2');
    await reject(/require verified document IDs/, ...scoped, 'frame-list');
    await reject(/require verified document IDs/, ...scoped, 'screenshot');
    legacy = false;
    await run(...scoped, 'use', '2');
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
