import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { frameTextInPage } from '../extension/shared/frame-probes.mjs';

const event = () => {
  const listeners = [];
  return { addListener: fn => listeners.push(fn),
    fire(...args) { let result; for (const fn of listeners) result = fn(...args); return result; } };
};
const origin = 'http://127.0.0.1:8080';
const childOrigin = 'http://127.0.0.2:8081';

test('Chrome frame reads, viewport captures and dialogs stay within the verified owned selection', async (t) => {
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
  let rootAllowed = true, styleCalls = 0, afterStyle, evalCalls = 0, onEval, onGroupQuery;
  const groups = new Map();
  const stored = {};
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
    storage: { local: { async get() { return { ...stored }; }, async set(values) { Object.assign(stored, values); } }, session: { async set() {} } },
    action: { async setBadgeText() {}, async setIcon() {} },
    permissions: { onRemoved: event(), async contains({ origins }) {
      return origins[0] === 'http://127.0.0.1/*' ? rootAllowed : childAllowed;
    } },
    debugger: { onDetach: event(), onEvent: event(), async attach() {}, async detach() {}, async sendCommand(...args) {
      cdpCalls.push(args);
      return onCdp?.(...args);
    } },
    tabs: { onRemoved: event(), onUpdated: event(), async get(id) { return tabs.get(id); },
      async group({ groupId, tabIds, createProperties }) {
        if (groupId === undefined) {
          groupId = groups.size + 1;
          groups.set(groupId, { id: groupId, windowId: createProperties.windowId });
        }
        for (const id of tabIds) tabs.get(id).groupId = groupId;
        return groupId;
      },
      async query(options) {
        if ('groupId' in options) {
          const snapshot = [...tabs.values()].filter(tab => tab.groupId === options.groupId).map(tab => ({ ...tab }));
          await onGroupQuery?.();
          return snapshot;
        }
        assert.deepEqual(options, { active: true, currentWindow: true });
        return [...tabs.values()].filter(tab => tab.active);
      },
      async create({ url, windowId }) { const tab = { url, windowId, id: tabs.size + 1, status: 'complete' }; tabs.set(tab.id, tab); return tab; } },
    tabGroups: { async get(id) { return groups.get(id); }, async update(id, values) { Object.assign(groups.get(id), values); } },
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
      if (func.name === 'navigationTiming') {
        assert.deepEqual(target, { tabId: 2, documentIds: [topFrame.documentId] });
        return [{ documentId: topFrame.documentId, frameId: 0, result: { type: 'reload', load: 42 } }];
      }
      if (func.name === 'feedbackInPage') {
        assert.deepEqual(target, { tabId: target.tabId, documentIds: [topFrame.documentId] });
        assert.equal(world, 'ISOLATED');
        assert.equal(args[0], tabs.get(target.tabId).url);
        feedbackToken = args[1];
        return [{ documentId: topFrame.documentId, frameId: 0, result: true }];
      }
      if (func.name === 'evalInPage') {
        assert.deepEqual(target, { tabId: 2, documentIds: [topFrame.documentId] });
        assert.equal(world, 'MAIN');
        assert.deepEqual(args, [origin, tabs.get(2).url, '1 + 1', 16384]);
        evalCalls++;
        await onEval?.();
        return [{ documentId: topFrame.documentId, frameId: 0, result: '2' }];
      }
      if (func.name === 'inspectionPage') {
        const [, , operation, spec, urls, styleHref] = args;
        if (operation === 'styles') {
          assert.deepEqual(target, { tabId: 2, documentIds: [topFrame.documentId] });
          assert.equal(spec, ref);
          assert.equal(urls, null);
          assert.equal(styleHref, tabs.get(2).url);
          assert.equal(world, 'ISOLATED');
          styleCalls++;
          afterStyle?.();
          return [{ documentId: target.documentIds[0], frameId: 0,
            result: { ok: true, value: { styles: { color: 'rgb(0, 0, 0)' } } } }];
        }
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
    const existing = tabs.get(1);
    existing.active = true;
    assert.deepEqual(await action('feedback-start'), { ok: true });
    const sender = { id: 'ext', frameId: 0, documentId: topFrame.documentId, tab: existing, url: existing.url };
    const submitExisting = () => send({ action: 'feedback-submit', token: feedbackToken,
      points: [{ note: 'Existing tab', target: null }] }, sender);
    assert.deepEqual(await submitExisting(), { ok: true });
    assert.equal((await action('status')).feedbackCount, 1);
    assert.equal(chrome.runtime.onMessage.fire({ action: 'feedback-list' }, { ...popupSender, tab: existing }, assert.fail), false);
    assert.deepEqual(await action('feedback-list'), { total: 1, feedback: [{ page: existing.url, target: null, note: 'Existing tab', workspace: null }] });
    assert.deepEqual((await run('feedback')).value, { feedback: [{ page: existing.url, target: null, note: 'Existing tab' }] });
    assert.equal((await action('status')).feedbackCount, 0);
    assert.deepEqual(await action('feedback-start'), { ok: true });
    chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: 1, frameId: 0 });
    assert.match((await submitExisting()).error, /current active document/);
    existing.active = false;
    assert.match((await run('use', '1')).error, /Approval required/);
    chrome.runtime.onConnect.fire(popup);
    await popup.onMessage.fire({ token: popup.message.request.token, decision: 'allow' });
    assert.equal(popup.message.state, 'allowed');
    assert.equal((await run('use', '1')).value.tab, 1);
    assert.match((await run('frame-list')).error, /opened by VABU/);
    assert.match((await run('frames')).error, /opened by VABU/);
    assert.match((await run('frame-read', 'arbitrary')).error, /opened by VABU/);
    assert.match((await run('screenshot')).error, /opened by VABU/);
    assert.match((await run('inspect-dialog', 'show')).error, /opened by VABU/);
    assert.match((await run('get', 'styles', ref)).error, /opened by VABU/);
    assert.match((await run('eval', '1 + 1')).error, /opened by VABU/);
    assert.equal(cdpCalls.filter(([, method]) => method !== 'Page.enable').length, 0);
    const { sessionId } = (await run('session-start', 'Testing')).value;
    const scoped = (...args) => run('--session', sessionId, ...args);
    const { tab, group } = (await scoped('open', `${origin}/owned`)).value;
    assert.equal((await scoped('use', String(tab))).value.tab, tab);
    const readStyle = () => scoped('get', 'styles', ref);
    const evaluate = () => scoped('eval', '1 + 1');
    const setMode = evalMode => send({ action: 'set-eval-mode', evalMode });
    assert.deepEqual((await readStyle()).value, { styles: { color: 'rgb(0, 0, 0)' } });
    assert.match((await run('get', 'styles', ref)).error, /Select a tab for this VABU session/);
    assert.match((await run('eval', '1 + 1')).error, /Select a tab for this VABU session/);
    assert.equal((await action('status')).evalMode, 'ask');
    assert.equal((await send({ action: 'status' }, { url: 'popup' })).evalMode, undefined);
    assert.equal(chrome.runtime.onMessage.fire({ action: 'set-eval-mode', evalMode: 'allow' },
      { ...popupSender, tab: existing }, assert.fail), false);
    assert.match((await setMode('invalid')).error, /Invalid eval mode/);
    assert.match((await evaluate()).error, /Open the VABU popup/);
    const { token } = (await action('status')).evalApproval;
    assert.deepEqual(await setMode('off'), { ok: true });
    assert.equal((await action('status')).evalApproval, undefined);
    assert.match((await send({ action: 'eval-approve', token })).error, /stale/);
    assert.match((await evaluate()).error, /Eval is off/);
    assert.deepEqual(await setMode('allow'), { ok: true });
    assert.equal((await evaluate()).value, 2);
    const target = tabs.get(tab);
    const denyBoth = async () => {
      assert.match((await readStyle()).error, /VABU-managed group/);
      assert.match((await evaluate()).error, /Cannot verify|VABU-managed group/);
    };
    target.groupId = -1;
    await denyBoth();
    target.groupId = group;
    target.windowId = 2;
    await denyBoth();
    target.windowId = 1;
    Object.assign(existing, { windowId: 1, groupId: group });
    await denyBoth();
    delete existing.groupId;
    const { sessionId: foreign } = (await run('session-start', 'Foreign')).value;
    const { tab: foreignTab, group: foreignGroup } = (await run('--session', foreign, 'open', `${origin}/other`)).value;
    tabs.get(foreignTab).groupId = group;
    await denyBoth();
    tabs.get(foreignTab).groupId = foreignGroup;
    const tabGroups = chrome.tabGroups;
    delete chrome.tabGroups;
    await denyBoth();
    chrome.tabGroups = tabGroups;
    assert.equal(evalCalls, 1);
    rootAllowed = false;
    assert.match((await readStyle()).error, /no longer authorized/);
    assert.equal(styleCalls, 1);
    rootAllowed = true;

    // The tab query has already snapshotted membership when these events arrive.
    onGroupQuery = () => {
      tabs.get(foreignTab).groupId = group;
      chrome.tabs.onUpdated.fire(foreignTab, { groupId: group });
    };
    assert.match((await evaluate()).error, /Cannot verify/);
    assert.equal(evalCalls, 1);
    tabs.get(foreignTab).groupId = foreignGroup;
    let queries = 0;
    onGroupQuery = () => {
      if (++queries !== 3) return; // Last verification, after styles have been read.
      target.groupId = -1;
      chrome.tabs.onUpdated.fire(tab, { groupId: -1 });
    };
    const staleStyles = await readStyle();
    assert.match(staleStyles.error, /VABU-managed group/);
    assert.equal(staleStyles.value, undefined);
    assert.equal(styleCalls, 2);
    target.groupId = group;

    // Ordinary unrelated tab updates do not invalidate a grouped evaluation.
    onGroupQuery = () => chrome.tabs.onUpdated.fire(foreignTab, { title: 'Unrelated', status: 'complete' });
    assert.equal((await evaluate()).value, 2);
    onGroupQuery = undefined;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const dispatch = Promise.withResolvers(), completion = Promise.withResolvers();
      onEval = () => { dispatch.resolve(); return completion.promise; };
      const stalled = evaluate();
      await dispatch.promise;
      assert.match((await scoped('session-status')).error, /Another command is running/);
      t.mock.timers.tick(5000);
      const timedOut = await stalled;
      assert.match(timedOut.error, /Eval timed out; it may have run/);
      assert.equal(timedOut.value, undefined);
      assert.equal((await scoped('session-status')).value.tab, tab);
      onEval = undefined;
      completion.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(evalCalls, 3); // Late browser completion does not replay or reply.
      assert.equal(port.reply.value.tab, tab);
      assert.equal((await evaluate()).value, 2);
    } finally {
      t.mock.timers.reset();
    }
    afterStyle = () => chrome.webNavigation.onHistoryStateUpdated.fire({ tabId: tab, frameId: 0 });
    const changed = await readStyle();
    assert.match(changed.error, /selection expired/);
    assert.equal(changed.value, undefined);
    afterStyle = undefined;
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
    assert.match((await submit({ ...feedbackSender, documentId: 'another-document' })).error, /current active document/);
    assert.deepEqual(await submit(), { ok: true });
    assert.deepEqual((await scoped('feedback')).value, { feedback: [{ ...points[0], page: tabs.get(tab).url }] });
    tabs.get(tab).active = false;
    assert.match((await run('screenshot')).error, /Select a tab for this VABU session/);
    const emit = (method, params) => chrome.debugger.onEvent.fire({ tabId: tab }, `Runtime.${method}`, params);
    const context = (id, frameId, contextOrigin = origin) => emit('executionContextCreated', {
      context: { id, origin: contextOrigin, auxData: { isDefault: true, frameId } },
    });
    const log = (executionContextId, value) => emit('consoleAPICalled', { executionContextId, type: 'log', args: [{ value }] });
    const debugMethods = [];
    onCdp = (_, method) => {
      debugMethods.push(method);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root', url: tabs.get(tab).url } } };
      if (method === 'Runtime.enable') context(1, 'root');
      if (method === 'Page.reload') {
        log(1, 'old document');
        context(2, 'root');
        context(3, 'child');
        context(4, 'root', childOrigin);
        log(3, 'child');
        log(4, 'other origin');
        log(2, 'startup');
        emit('exceptionThrown', { exceptionDetails: { executionContextId: 2, text: 'Unhandled', lineNumber: 4 } });
      }
    };
    assert.deepEqual((await scoped('console', 'reload')).value, { recording: true });
    assert.deepEqual(debugMethods, ['Page.getFrameTree', 'Runtime.enable', 'Page.reload']);
    assert.deepEqual((await scoped('console', 'read')).value, { dropped: 0,
      entries: [{ level: 'log', text: 'startup' }, { level: 'error', text: 'Unhandled', line: 5 }] });
    for (let i = 0; i < 100; i++) log(2, 'bounded');
    const bounded = (await scoped('console', 'read')).value;
    assert.equal(bounded.dropped, 2);
    assert.equal(bounded.entries.length, 100);
    assert.deepEqual((await scoped('console', 'stop')).value, { recording: false });
    assert.match((await scoped('console', 'read')).error, /Start console recording first/);
    assert.deepEqual((await scoped('js', 'timing')).value, { type: 'reload', load: 42 });
    assert.match((await scoped('js', 'document.title')).error, /Usage: vabu js timing/);
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
