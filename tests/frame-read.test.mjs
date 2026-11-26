import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { frameTextInPage } from '../extension/shared/frame-probes.mjs';

const event = () => ({ addListener(fn) { this.fire = fn; } });
const origin = 'http://127.0.0.1:8080';
const childOrigin = 'http://127.0.0.2:8081';

test('Chrome frame reads, viewport captures and dialogs stay within the verified owned selection', async () => {
  const port = { onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) {
    if (message.type === 'configure') queueMicrotask(() => this.onMessage.fire({ ready: true, socketName: 'chrome-default' }));
    else this.reply = message;
  } };
  const popup = { name: 'tab-approval', sender: { id: 'ext', url: 'popup' }, onMessage: event(), onDisconnect: event(),
    postMessage(message) { this.message = message; } };
  const tabs = new Map([[1, { id: 1, url: `${origin}/user`, status: 'complete' }]]);
  const topFrame = { documentId: 'top', frameId: 0, frameType: 'outermost_frame', documentLifecycle: 'active', errorOccurred: false };
  const child = { ...topFrame, frameId: 8, frameType: 'sub_frame', parentFrameId: 0, parentDocumentId: 'top',
    documentId: 'child', url: `${childOrigin}/private-path?secret=value` };
  let childAllowed = true;
  let probeCount = 0;
  let onRead;
  let onProbe;
  let ownerProof = true;
  let onCdp;
  let onRootLookup;
  let scriptsBlocked = false;
  let feedbackToken;
  const childScripts = [];
  const inspectionOps = [];
  const ref = `@i${crypto.randomUUID()}:1`;
  const cdpCalls = [];
  globalThis.chrome = {
    windows: { async getLastFocused() { return { id: 1, type: 'normal' }; } },
    runtime: { id: 'ext', getURL: () => 'popup', onMessage: event(), onConnect: event(), connectNative: () => port },
    storage: { local: { async get() { return {}; } }, session: { async set() {} } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains({ origins }) {
      return childAllowed || origins[0] === 'http://127.0.0.1/*';
    } },
    debugger: { onDetach: event(), onEvent: event(), async attach() {}, async detach() {}, async sendCommand(...args) {
      cdpCalls.push(args);
      return onCdp?.(...args);
    } },
    tabs: { onRemoved: event(), onUpdated: event(), async get(id) { return tabs.get(id); }, async group() { return 1; },
      async query(options) {
        assert.deepEqual(options, { active: true, currentWindow: true });
        return [...tabs.values()].filter(tab => tab.active);
      },
      async create({ url }) { const tab = { url, id: tabs.size + 1, status: 'complete' }; tabs.set(tab.id, tab); return tab; } },
    tabGroups: { async update() {} },
    webNavigation: {
      onBeforeNavigate: event(), onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), onErrorOccurred: event(),
      async getFrame({ tabId, frameId }) {
        if (frameId !== 0) return { ...child };
        await onRootLookup?.();
        return { ...topFrame, url: tabs.get(tabId).url };
      },
      async getAllFrames() { return [topFrame, { ...child }, { ...child, frameId: 9, parentFrameId: 8 },
        { ...child, frameId: 10, parentDocumentId: 'old-parent' }, { ...child, frameId: 11, url: 'about:blank' }]; },
    },
    scripting: { async executeScript({ target, world, func, args }) {
      assert.equal(scriptsBlocked, false, 'Dialog commands must not inject into the blocked document');
      if (func.name === 'iframeOwnersInPage') {
        assert.deepEqual(target.documentIds, [topFrame.documentId]);
        return [{ documentId: topFrame.documentId, frameId: 0, result: ownerProof }];
      }
      if (func === frameTextInPage) {
        assert.deepEqual(target, { tabId: 2, documentIds: [child.documentId] });
        assert.equal(world, 'ISOLATED');
        assert.deepEqual(args.slice(0, 3), [new URL(child.url).origin, child.url, origin]);
        const result = args[3] ? true : { text: 'public text', truncated: false };
        const output = [{ documentId: child.documentId, frameId: child.frameId, result }];
        childScripts.push(args[3] ? 'probe' : 'read');
        if (args[3]) await onProbe?.(++probeCount);
        else await onRead?.();
        return output;
      }
      if (func.name === 'feedbackInPage') {
        assert.deepEqual(target, { tabId: 2, documentIds: [topFrame.documentId] });
        assert.equal(world, 'ISOLATED');
        assert.equal(args[0], tabs.get(2).url);
        feedbackToken = args[1];
        return [{ documentId: topFrame.documentId, frameId: 0, result: true }];
      }
      if (func.name === 'inspectionPage') {
        const [, , operation, spec, urls] = args;
        assert.deepEqual(target, { tabId: 2, documentIds: [child.documentId] });
        assert.deepEqual(urls, { parentHref: tabs.get(2).url, href: child.url });
        assert.equal(world, 'ISOLATED');
        inspectionOps.push(operation);
        if (operation === 'click') assert.equal(spec, ref);
        const value = operation === 'query' ? { count: 1, items: [{ ref }], truncated: false }
          : operation === 'click' ? { dispatched: true, trusted: false } : true;
        return [{ documentId: child.documentId, frameId: child.frameId, result: { ok: true, value } }];
      }
      return [{ documentId: topFrame.documentId, result: { ok: true, value: true } }];
    } },
  };
  const popupSender = { id: 'ext', url: 'popup' };
  const send = (message, sender = popupSender) => new Promise(resolve => chrome.runtime.onMessage.fire(message, sender, resolve));
  const action = (action) => send({ action });
  async function run(...args) {
    port.reply = undefined;
    await port.onMessage.fire({ id: 'test', args });
    return port.reply;
  }
  try {
    await import('../extension/chrome/worker.js');
    assert.deepEqual(await action('start'), { ok: true });
    assert.match((await run('use', '1')).error, /Approval required/);
    chrome.runtime.onConnect.fire(popup);
    await popup.onMessage.fire({ token: popup.message.request.token, decision: 'allow' });
    assert.equal(popup.message.state, 'allowed');
    assert.equal((await run('use', '1')).value.tab, 1);
    assert.match((await action('feedback-start')).error, /opened by VABU/);
    assert.match((await run('frame-list')).error, /opened by VABU/);
    assert.match((await run('frames')).error, /opened by VABU/);
    assert.match((await run('frame-read', 'arbitrary')).error, /opened by VABU/);
    assert.match((await run('screenshot')).error, /opened by VABU/);
    assert.match((await run('inspect-dialog', 'show')).error, /opened by VABU/);
    assert.equal(cdpCalls.filter(([, method]) => method !== 'Page.enable').length, 0);
    const { sessionId } = (await run('session-start', 'Testing')).value;
    const scoped = (...args) => run('--session', sessionId, ...args);
    const { tab } = (await scoped('open', `${origin}/owned`)).value;
    assert.equal((await scoped('use', String(tab))).value.tab, tab);
    const discover = async () => {
      const { value } = await scoped('frame-list');
      assert.equal(value?.length, 1);
      const [{ id }] = value;
      assert.deepEqual(value, [{ id, origin: childOrigin }]);
      return id;
    };
    let id = await discover();
    assert.deepEqual(childScripts, []);
    assert.match((await run('frame-read', id)).error, /Select a tab for this VABU session/);
    assert.deepEqual((await scoped('frame-read', id)).value, { text: 'public text', truncated: false });
    assert.deepEqual(childScripts, ['read', 'probe', 'probe']);
    assert.equal(popup.message.state, 'used'); // No additional popup request.
    const old = id;
    id = await discover();
    assert.notEqual(old, id);
    assert.match((await scoped('frame-read', old)).error, /stale iframe/);
    chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: tab, frameId: child.frameId });
    assert.match((await scoped('frame-read', id)).error, /stale iframe/);
    id = await discover();
    child.documentId = 'same-url-reload';
    const before = childScripts.length;
    assert.match((await scoped('frame-read', id)).error, /Cannot verify/);
    assert.equal(childScripts.length, before);
    id = await discover();
    const oldTop = topFrame.documentId;
    topFrame.documentId = 'parent-reload';
    assert.match((await scoped('frame-read', id)).error, /Cannot verify/);
    assert.equal(childScripts.length, before);
    // Restore the fixture's initial top document, then change the child during injection.
    topFrame.documentId = oldTop;
    id = await discover();
    onRead = () => { child.documentId = 'new-during-injection'; };
    const post = await scoped('frame-read', id);
    assert.match(post.error, /Cannot verify/);
    assert.equal(post.value, undefined);
    onRead = undefined;
    id = await discover();
    probeCount = 0;
    onProbe = (count) => { if (count === 2) childAllowed = false; };
    const final = await scoped('frame-read', id);
    assert.match(final.error, /Cannot verify/);
    assert.equal(final.value, undefined);
    childAllowed = true;
    onProbe = undefined;
    assert.match((await scoped('frame-read', id)).error, /stale iframe/);
    id = await discover();
    ownerProof = false;
    assert.match((await scoped('frame-read', id)).error, /Cannot verify/);
    assert.match((await scoped('frame-list')).error, /Cannot verify/);
    ownerProof = true;
    assert.deepEqual((await scoped('frames')).value, []); // Cross-origin text works, but richer inspection does not.
    assert.deepEqual(inspectionOps, []);
    child.url = `${origin}/embedded`;
    child.documentId = 'verified-same-origin-document';
    const frameTerms = ['--frame', String(child.frameId), child.documentId];
    assert.match((await scoped('inspect-query', ...frameTerms, '{"css":"button"}')).error, /run frames again/);
    assert.deepEqual((await scoped('frames')).value, [{ frameId: child.frameId, documentId: child.documentId }]);
    assert.deepEqual((await scoped('inspect-query', ...frameTerms, '{"css":"button"}')).value.items, [{ ref }]);
    assert.deepEqual((await scoped('inspect-click', ...frameTerms, ref)).value, { dispatched: true, trusted: false });
    assert.equal(inspectionOps.filter(op => op === 'click').length, 1);
    chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: tab, frameId: child.frameId });
    assert.match((await scoped('inspect-click', ...frameTerms, ref)).error, /run frames again/);
    assert.equal(inspectionOps.filter(op => op === 'click').length, 1);
    child.url = `${childOrigin}/private-path?secret=value`;
    tabs.get(tab).active = true;
    assert.deepEqual(await action('feedback-start'), { ok: true });
    const feedbackSender = { id: 'ext', frameId: 0, documentId: topFrame.documentId, tab: tabs.get(tab), url: tabs.get(tab).url };
    const points = [{ note: 'test feedback', target: null }];
    const submit = (sender = feedbackSender) => send({ action: 'feedback-submit', token: feedbackToken, points }, sender);
    assert.match((await submit({ ...feedbackSender, documentId: 'another-document' })).error, /current selected document/);
    assert.deepEqual(await submit(), { ok: true });
    assert.deepEqual((await scoped('feedback')).value, { feedback: [{ ...points[0], page: tabs.get(tab).url }] });
    tabs.get(tab).active = false;
    assert.match((await run('screenshot')).error, /Select a tab for this VABU session/);
    const jpeg = '/9j/AAAA';
    const nav = (frameId = 0) => chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: tab, frameId });
    const dialogEvent = (suffix, params, target = { tabId: tab }) =>
      chrome.debugger.onEvent.fire(target, `Page.javascriptDialog${suffix}`, params);
    const openDialog = (type, target) => dialogEvent('Opening', {
      type, url: tabs.get(tab).url, message: 'private text', defaultPrompt: 'private default',
    }, target);
    onCdp = (target, method, params) => {
      assert.deepEqual([target, method, params], [{ tabId: tab }, 'Page.captureScreenshot', {
        format: 'jpeg', quality: 80, captureBeyondViewport: false,
      }]);
      nav(child.frameId); // Child navigation is not a root-document change.
      return { data: jpeg };
    };
    childAllowed = false;
    assert.deepEqual(await scoped('screenshot'), { id: 'test', value: jpeg });
    childAllowed = true;
    assert.equal(popup.message.state, 'used');
    onRootLookup = () => nav();
    const calls = cdpCalls.length;
    assert.match((await scoped('screenshot')).error, /selection expired/);
    assert.equal(cdpCalls.length, calls);
    let rootChecks = 0;
    onRootLookup = () => { if (++rootChecks === 3) nav(); };
    const staleCapture = await scoped('screenshot');
    assert.match(staleCapture.error, /selection expired/);
    assert.equal(staleCapture.value, undefined);
    onRootLookup = undefined;
    onCdp = () => { topFrame.documentId = 'unexpected-root'; return { data: jpeg }; };
    assert.match((await scoped('screenshot')).error, /verify the requested document/);
    topFrame.documentId = oldTop;
    assert.match((await scoped('inspect-dialog', 'show')).error, /No verified dialog observer/);
    await scoped('use', String(tab));
    openDialog('alert', { tabId: 1 });
    openDialog('alert', { tabId: tab, sessionId: 'child-session' });
    openDialog('beforeunload');
    assert.match((await scoped('inspect-dialog', 'show')).error, /No current supported dialog/);
    dialogEvent('Closed', { result: false });
    scriptsBlocked = true;
    openDialog('confirm');
    const shown = (await scoped('inspect-dialog', 'show')).value;
    assert.deepEqual(shown, { id: shown.id, type: 'confirm' });
    onRootLookup = () => {
      onRootLookup = undefined;
      dialogEvent('Closed', { result: false });
      openDialog('prompt');
    };
    const beforeRespond = cdpCalls.length;
    assert.match((await scoped('inspect-dialog', 'accept', shown.id)).error, /stale/);
    assert.equal(cdpCalls.length, beforeRespond);
    const next = (await scoped('inspect-dialog', 'show')).value;
    assert.notEqual(shown.id, next.id);
    assert.deepEqual(next, { id: next.id, type: 'prompt' });
    onCdp = (target, method, params) => {
      assert.deepEqual([target, method, params], [{ tabId: tab }, 'Page.handleJavaScriptDialog', { accept: false }]);
      dialogEvent('Closed', { result: false, userInput: 'private' });
    };
    assert.match((await scoped('inspect-dialog', 'dismiss', next.id, 'injected value')).error, /Usage/);
    assert.equal(cdpCalls.length, beforeRespond);
    assert.deepEqual((await scoped('inspect-dialog', 'dismiss', next.id)).value, { handled: true });
    assert.match((await scoped('inspect-dialog', 'dismiss', next.id)).error, /stale/);
    openDialog('alert');
    const later = (await scoped('inspect-dialog', 'show')).value;
    onCdp = () => { dialogEvent('Closed', { result: true }); nav(); };
    assert.match((await scoped('inspect-dialog', 'accept', later.id)).error, /indeterminate/);
    assert.match((await scoped('inspect-dialog', 'accept', later.id)).error, /No verified dialog observer/);
    scriptsBlocked = false;
    onCdp = undefined;
    const getAllFrames = chrome.webNavigation.getAllFrames;
    chrome.webNavigation.getAllFrames = undefined;
    assert.match((await scoped('frame-list')).error, /require Chrome document verification APIs/);
    chrome.webNavigation.getAllFrames = getAllFrames;
    id = await discover();
    onRead = () => action('stop');
    assert.equal(await scoped('frame-read', id), undefined);
    await action('start');
    assert.match((await run('frame-list')).error, /opened by VABU/);
    assert.match((await run('screenshot')).error, /opened by VABU/);
    assert.match((await run('inspect-dialog', 'show')).error, /opened by VABU/);
    assert.match((await run('use', String(tab))).error, /Approval required/);
    await action('stop');
  } finally {
    delete globalThis.chrome;
  }
});

function runText(children, overrides = {}) {
  function element({ children = [], protected: blocked, editable, display, shadowRoot } = {}) {
    const parent = { nodeType: 1, matches: () => !!blocked, isContentEditable: editable, shadowRoot, display };
    const nodes = children.map((child) => typeof child === 'string'
      ? { nodeType: 3, length: child.length, substringData: (start, count) => child.slice(start, start + count) }
      : element(child));
    parent.firstChild = nodes[0];
    nodes.forEach((node, i) => { node.parentNode = parent; node.nextSibling = nodes[i + 1]; });
    return parent;
  }
  const window = { top: {}, origin: childOrigin };
  window.parent = window.top;
  const location = { origin: childOrigin, href: `${childOrigin}/path`, ancestorOrigins: [origin] };
  const document = { contentType: 'text/html', designMode: 'off', readyState: 'complete',
    documentElement: element(), body: element({ children }) };
  const context = { window, self: window, location, document, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    getComputedStyle: (el) => ({ display: el.display || 'block', visibility: 'visible' }), ...overrides };
  const result = runInNewContext(`(${frameTextInPage})('${childOrigin}', '${childOrigin}/path', '${origin}', false)`, context);
  return result && { ...result };
}

test('iframe text traversal prunes protected subtrees and bounds characters and work', () => {
  assert.deepEqual(runText(['  public   text ', { protected: true, children: ['protected'] },
    { editable: true, children: ['editable'] }, { display: 'none', children: ['hidden'] },
    { shadowRoot: {}, children: ['slotted'] }, { children: ['tail'] }]), { text: 'public text tail', truncated: false });
  assert.deepEqual(runText(['a'.repeat(10_000)]), { text: 'a'.repeat(4000), truncated: true });
  assert.deepEqual(runText([...Array(10_001).fill(''), 'not visited']), { text: '', truncated: true });
  assert.equal(runText(['opaque should not leak'], { self: { origin: 'null' } }), null);
  assert.equal(runText(['wrong port should not leak'], { self: { origin } }), null);
});
