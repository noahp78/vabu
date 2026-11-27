import { domainPattern, hasHostAccess, webUrl } from '../shared/domains.js';
import { setBridgeIcon } from '../shared/toolbar.mjs';
import { defaultSocketNames, socketNameError, validSocketName } from '../shared/socket-name.mjs';
import { commands as interaction } from '../shared/interaction.mjs';
import { commands as inspection, isFrameInspection, runListedFrameInspection } from '../shared/inspection.mjs';
import { commands as scoped } from '../shared/scoped-snapshot.mjs';
import { commands as find } from '../shared/find-click.mjs';
import { commands as wait } from '../shared/wait.mjs';
import { commands as get } from '../shared/get-element.mjs';
import { captureOptions, captureResponse, validateCapture } from '../shared/capture-jpeg.mjs';
import { handleFeedback, invalidateFeedback, takeFeedback } from '../shared/feedback.mjs';
import { forgetWorkspaceWindow, manageOwnedTab, openBackgroundTab } from '../shared/tab-lifecycle.mjs';
import { createFirefoxFrameScope, hasDocumentId, hasFrameApis, injectDocument, navigationEvents, unavailable } from './frame-read.mjs';

const browser = globalThis.browser;
const channel = 'vabu-selected-document';
let bridge;
let bridgeError;
let bridgeTransition = Promise.resolve();
let selected;

function release(s = selected) {
  if (!s || s !== selected) return;
  selected = undefined;
  s.port?.disconnect();
  s.pending?.reject(new Error('Selected document changed or was released'));
}

function stop(connection, error) {
  if (bridge !== connection) return;
  bridge = undefined;
  bridgeError = error;
  release();
  connection.port.disconnect();
  connection.reject(new Error(error || 'Bridge stopped'));
  void setBridgeIcon(browser.action, false);
  void browser.action.setBadgeText({ text: error ? 'ERR' : '' }).catch(() => {});
}

function start(socketOverride) {
  const socketName = socketOverride ?? defaultSocketName;
  const port = browser.runtime.connectNative('local.vabu');
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  const connection = bridge = { port, socketName, socketOverride, ready, reject, online: false, busy: false,
    workspaces: new Map(), groups: new Map(), ownedTabs: new Set() };
  port.onDisconnect.addListener(() => stop(connection, port.error?.message || 'Native host disconnected'));
  port.onMessage.addListener(async (msg) => {
    if (bridge !== connection) return;
    if (typeof msg?.startupError === 'string') return stop(connection, msg.startupError);
    if (msg?.ready === true && !connection.online) {
      if (msg.socketName !== socketName) return stop(connection, 'Unexpected native host readiness. Update the VABU native host and reconnect.');
      connection.online = true;
      resolve();
      void setBridgeIcon(browser.action, true);
      void browser.action.setBadgeText({ text: '' }).catch(() => {});
      return;
    }
    if (!connection.online || typeof msg?.id !== 'string') return;
    if (connection.busy) return port.postMessage({ id: msg.id, error: 'Another command is running' });
    connection.busy = true;
    try {
      let beforeReply, assertCurrent;
      const value = await command(connection, msg.args, (check, verify) => { beforeReply = check; assertCurrent = verify; });
      if (beforeReply) await beforeReply();
      assertCurrent?.();
      if (bridge === connection) port.postMessage({ id: msg.id, value });
    } catch (error) {
      if (bridge === connection) port.postMessage({ id: msg.id, error: error.message });
    } finally {
      connection.busy = false;
    }
  });
  try { port.postMessage({ type: 'configure', socketName }); }
  catch (error) { stop(connection, error.message); }
  return ready;
}

const defaultSocketName = defaultSocketNames.firefox;
const invalidSavedSocketName = 'Saved socket name is invalid; choose a new name or clear it.';

async function storedSocketName() {
  return (await browser.storage.local.get('bridgeSocketName')).bridgeSocketName ?? null;
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (['feedback-start', 'feedback-submit'].includes(message?.action)) {
    const connection = bridge;
    return handleFeedback(browser, connection, () => bridge, id =>
      [...connection.workspaces.values()].find(workspace => workspace.ownedTabs.has(id)) ?? connection,
    message, sender)
      .catch(error => ({ error: error.message }));
  }
  if (sender.url !== browser.runtime.getURL('shared/popup.html') || !['status', 'start', 'stop', 'set-socket'].includes(message?.action)) return false;
  // Serialize setting writes and launches, but let Stop cancel the native handshake.
  const transition = bridgeTransition.then(async () => {
    if (message.action === 'status') {
      const saved = bridge ? bridge.socketOverride : await storedSocketName();
      const socketOverride = validSocketName(saved) ? saved : null;
      return { browser: 'firefox', connected: bridge?.online === true, starting: !!bridge && !bridge.online,
        socketName: bridge?.socketName ?? socketOverride ?? defaultSocketName, socketOverride,
        bridgeError: bridgeError ?? (saved === socketOverride ? undefined : invalidSavedSocketName) };
    }
    if (message.action === 'set-socket') {
      if (bridge) throw new Error('Stop the local bridge before changing its socket name');
      const { socketOverride } = message;
      if (socketOverride !== null && !validSocketName(socketOverride)) throw new Error(socketNameError);
      await browser.storage.local.set({ bridgeSocketName: socketOverride });
      if (bridgeError) void browser.action.setBadgeText({ text: '' }).catch(() => {});
      bridgeError = undefined;
    } else if (message.action === 'stop') {
      if (bridge) stop(bridge);
      else if (bridgeError) void browser.action.setBadgeText({ text: '' }).catch(() => {});
      bridgeError = undefined;
    } else {
      if (bridge) return { ready: bridge.ready };
      try {
        const saved = await storedSocketName();
        if (saved !== null && !validSocketName(saved)) throw new Error(invalidSavedSocketName);
        bridgeError = undefined;
        return { ready: start(saved) };
      } catch (error) {
        bridgeError = error.message;
        throw error;
      }
    }
  });
  bridgeTransition = transition.catch(() => {});
  return transition.then(async (result) => {
    if (result?.ready) await result.ready;
    else if (result) return result;
    return { ok: true };
  }).catch((error) => ({ error: error.message }));
});

browser.windows?.onRemoved?.addListener((id) => forgetWorkspaceWindow(bridge, id));
browser.tabs.onRemoved.addListener((id) => {
  invalidateFeedback(bridge, id);
  if (id === selected?.id) release();
  bridge?.ownedTabs.delete(id);
  for (const workspace of bridge?.workspaces.values() ?? []) workspace.ownedTabs.delete(id);
});
browser.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading' || change.discarded || change.pendingUrl || Object.hasOwn(change, 'url')) invalidateFeedback(bridge, id);
  if (id === selected?.id && (change.status === 'loading' || change.discarded === true || change.pendingUrl
    || (Object.hasOwn(change, 'url') && change.url !== selected.href))) release();
});
browser.permissions.onRemoved.addListener(({ origins, permissions }) => {
  if (origins?.length || permissions?.some(permission => ['scripting', 'webNavigation'].includes(permission))) {
    if (bridge) delete bridge.feedbackLease;
    release();
  }
});

const frameApis = hasFrameApis(browser);
if (frameApis) {
  for (const name of navigationEvents) browser.webNavigation[name].addListener(({ tabId, frameId }) => {
    if (frameId === 0) invalidateFeedback(bridge, tabId);
    if (selected?.id !== tabId) return;
    selected.frameScope = selected.frameInspectionScope = undefined;
    if (frameId === 0 && selected.documentId) release();
  });
}

async function allowed(tab) {
  try {
    if (tab.incognito) return;
    const url = webUrl(tab.url);
    if (await hasHostAccess(browser.permissions, url)) return url;
  } catch {}
}

const info = (tab, url) => ({ tab: tab.id, origin: url.origin, active: tab.active });

async function current(s) {
  if (!s || selected !== s) throw new Error('Select an allowed Firefox tab with use TAB_ID');
  const tab = await browser.tabs.get(s.id);
  const url = await allowed(tab);
  if (selected !== s || url?.href !== s.href || tab.status === 'loading') {
    release(s);
    throw new Error('Selected document changed or Firefox site access was denied');
  }
  return info(tab, url);
}

async function page(s, op, ...args) {
  await current(s);
  if (s.pending) throw new Error('Another Firefox page operation is running');
  const id = crypto.randomUUID();
  const { promise, resolve, reject } = Promise.withResolvers();
  s.pending = { id, resolve, reject };
  const timer = setTimeout(() => release(s), 1700);
  try {
    s.port.postMessage({ id, op, args });
    const result = await promise;
    await current(s);
    if (result?.ok !== true) throw new Error(result?.error || 'Firefox page operation failed');
    return result.value;
  } finally {
    clearTimeout(timer);
    s.pending = undefined;
  }
}

async function select(connection, id, workspace) {
  const tab = await browser.tabs.get(id);
  const url = await allowed(tab);
  if (!url || tab.status === 'loading') throw new Error('Firefox has not granted access to a loaded HTTP(S) document in this tab');
  if (bridge !== connection) throw new Error('Bridge stopped');
  release();
  const s = selected = { id, workspace, href: url.href, origin: url.origin };
  try {
    const frame = frameApis && (workspace ?? connection).ownedTabs.has(id)
      && await browser.webNavigation.getFrame({ tabId: id, frameId: 0 });
    const script = { files: ['firefox/content.js'] };
    const connect = { name: channel };
    if (hasDocumentId(frame?.documentId)) {
      if (frame.tabId !== id || frame.frameId !== 0 || frame.parentFrameId !== -1 || frame.url !== s.href || selected !== s) throw unavailable();
      s.documentId = connect.documentId = frame.documentId;
      await injectDocument(browser, id, frame, script);
    } else {
      // Existing user tabs and older Firefox keep the top-document port only.
      await browser.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, ...script });
      connect.frameId = 0;
    }
    await current(s);
    const port = s.port = browser.tabs.connect(id, connect);
    port.onDisconnect.addListener(() => release(s));
    port.onMessage.addListener(({ id, result }) => {
      if (id === s.pending?.id) s.pending.resolve(result);
    });
    await page(s, 'init', s.href, s.origin, crypto.randomUUID());
    return await current(s);
  } catch (error) {
    release(s);
    // Firefox may restrict injection even when the manifest host permission matches.
    throw new Error(`Cannot select this Firefox document: ${error.message}`);
  }
}

async function waitForUrl(connection, s, terms) {
  if (!s) return current(s);
  const { id, origin } = s;
  // Observe browser metadata only; navigation still destroys the input port and refs.
  let invalid = false;
  let revision = 0;
  const stopObserving = () => { invalid = true; };
  const removed = (tabId) => { if (tabId === id) stopObserving(); };
  const permissionsRemoved = ({ origins }) => { if (origins?.length) stopObserving(); };
  const updated = (tabId, change) => {
    if (tabId !== id || (!Object.hasOwn(change, 'url') && !change.status)) return;
    revision++;
    if (Object.hasOwn(change, 'url')) {
      try { if (webUrl(change.url).origin !== origin) stopObserving(); }
      catch { stopObserving(); }
    }
  };
  browser.tabs.onRemoved.addListener(removed);
  browser.tabs.onUpdated.addListener(updated);
  browser.permissions.onRemoved.addListener(permissionsRemoved);
  const assertObservable = () => {
    if (invalid || bridge !== connection) throw new Error('Firefox URL observation ended');
  };
  try {
    await current(s);
    return await wait.wait(terms, {
      origin,
      observeWait: async (_, value) => {
        assertObservable();
        const version = revision;
        const tab = await browser.tabs.get(id);
        const url = await allowed(tab);
        assertObservable();
        if (url?.origin !== origin) throw new Error('Firefox tab origin or access changed');
        if (tab.status === 'loading' || url.href !== s.href) release(s);
        return revision === version && tab.status === 'complete' && url.href === value;
      },
    });
  } finally {
    stopObserving();
    browser.tabs.onRemoved.removeListener(removed);
    browser.tabs.onUpdated.removeListener(updated);
    browser.permissions.onRemoved.removeListener(permissionsRemoved);
  }
}

async function groupNewTab({ groups, ownedTabs, name: title = 'VABU' }, tab) {
  if (!browser.tabs.group || !browser.tabGroups) return null;
  const id = groups.get(tab.windowId);
  if (id !== undefined) {
    const group = await browser.tabGroups.get(id).catch(() => null);
    if (group?.windowId === tab.windowId && group.title === title) {
      const members = await browser.tabs.query({ groupId: id });
      if (members.length && members.every((member) => ownedTabs.has(member.id))) {
        return browser.tabs.group({ groupId: id, tabIds: [tab.id] });
      }
    }
    groups.delete(tab.windowId);
  }
  const created = await browser.tabs.group({ createProperties: { windowId: tab.windowId }, tabIds: [tab.id] });
  await browser.tabGroups.update(created, { title, color: 'purple' });
  groups.set(tab.windowId, created);
  return created;
}

async function runFrameCommand(connection, workspace, s, verb, terms, setBeforeReply) {
  const inspection = isFrameInspection(verb, terms);
  if (verb === 'frames' && terms.length) throw new Error('Usage: frames');
  if (!inspection && terms.length !== (verb === 'frame-list' ? 0 : 1)) throw new Error('Usage: frame-list | frame-read FRAME_ID');
  const owner = workspace ?? connection;
  if (!s || !owner.ownedTabs.has(s.id)) throw new Error('Select a tab opened by VABU in this bridge and workspace first');
  if (!s.documentId) throw new Error('Firefox iframe reads require verified document IDs (Firefox 153+)');
  const field = inspection ? 'frameInspectionScope' : 'frameScope';
  let scope = s[field];
  const assertCurrent = () => {
    if (bridge !== connection || selected !== s || !owner.ownedTabs.has(s.id) || s[field] !== scope) throw unavailable();
  };
  if (verb === 'frame-list' || verb === 'frames') scope = s[field] = createFirefoxFrameScope(browser, s, assertCurrent);
  if (inspection) return runListedFrameInspection(verb, terms, scope, assertCurrent, setBeforeReply);
  try {
    let value;
    if (verb === 'frame-list') {
      value = await scope.discover();
    } else {
      const child = scope?.frames.get(terms[0]);
      if (!child) throw unavailable();
      value = await scope.read(child);
    }
    setBeforeReply(undefined, assertCurrent);
    return value;
  } catch {
    if (s.frameScope === scope) s.frameScope = undefined;
    throw unavailable();
  }
}

function ownedDocumentScope(connection, workspace, s, screenshot = false) {
  const owner = workspace ?? connection;
  if (!s || !owner.ownedTabs.has(s.id)) throw new Error('Select a tab opened by VABU in this bridge and workspace first');
  if (!frameApis || !s.documentId) throw new Error('Firefox screenshots require verified document IDs (Firefox 153+)');
  const { id, documentId, href, origin } = s;
  const changed = () => new Error('Cannot verify the selected Firefox document; use the tab again');
  // Existing tab, root navigation, port and permission listeners permanently
  // release this selection, including for changes that revert during awaits.
  const assertCurrent = () => {
    if (bridge !== connection || selected !== s || s.workspace !== workspace
      || !owner.ownedTabs.has(id) || s.documentId !== documentId) throw changed();
  };
  const verify = async () => {
    assertCurrent();
    if (screenshot && !await browser.permissions.contains({ origins: ['<all_urls>'] })) {
      throw new Error('Enable Firefox screenshots in the VABU popup first');
    }
    const tab = await browser.tabs.get(id);
    const frame = await browser.webNavigation.getFrame({ tabId: id, frameId: 0 });
    if (tab.id !== id || tab.incognito || tab.discarded || tab.pendingUrl || tab.status !== 'complete' || tab.url !== href
      || frame?.tabId !== id || frame.frameId !== 0 || frame.parentFrameId !== -1 || frame.documentId !== documentId
      || frame.url !== href || frame.errorOccurred === true) throw changed();
    assertCurrent();
    // Prove Firefox still authorizes the exact document (not merely its URL).
    if (await injectDocument(browser, id, frame, {
      func: (expectedOrigin, expectedHref) => window === window.top && window.origin === expectedOrigin
        && location.origin === expectedOrigin && location.href === expectedHref,
      args: [origin, href],
    }).catch(() => false) !== true) throw changed();
    if (!await browser.permissions.contains({ origins: [...(screenshot ? ['<all_urls>'] : []), domainPattern(webUrl(href))] })) throw changed();
    assertCurrent();
    return info(tab, webUrl(href));
  };
  return { id, documentId, href, owner, verify, assertCurrent };
}

async function runCapture(connection, workspace, s, terms, setBeforeReply) {
  const options = captureOptions(terms);
  const { id, documentId, verify, assertCurrent } = ownedDocumentScope(connection, workspace, s, true);
  await verify();
  assertCurrent();
  if (typeof browser.tabs.captureTab !== 'function') throw new Error('Firefox tab-ID capture is unavailable');
  const { format, quality } = options;
  const image = await browser.tabs.captureTab(id, { format, ...(format === 'jpeg' ? { quality } : {}) });
  const prefix = `data:image/${format};base64,`;
  const data = validateCapture(typeof image === 'string' && image.startsWith(prefix) ? image.slice(prefix.length) : undefined, format);
  const { value, next } = await captureResponse(data, options, s.lastCapture, documentId);
  setBeforeReply(verify, () => {
    assertCurrent();
    if (next) s.lastCapture = next;
  });
  return value;
}

async function command(connection, args, setBeforeReply) {
  if (!Array.isArray(args) || !args.length || !args.every((arg) => typeof arg === 'string')) throw new Error('Invalid command');
  const assertBridge = () => { if (bridge !== connection) throw new Error('Bridge stopped'); };
  assertBridge();
  const named = args[0] === '--session';
  const id = named ? args[1] : undefined;
  const { workspaces } = connection;
  const workspace = workspaces.get(id);
  if (named && !workspace) throw new Error('Unknown VABU session ID');
  const [verb, ...terms] = named ? args.slice(2) : args;
  if (verb === 'feedback') return takeFeedback(workspace ?? connection, terms);
  if (!named && verb === 'session-start' && terms.length === 1) {
    const name = terms[0].trim();
    if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('Supply a session name of 1–60 characters');
    const sessionId = crypto.randomUUID();
    workspaces.set(sessionId, { name, groups: new Map(), ownedTabs: new Set() });
    return { sessionId, name };
  }
  if (!named && verb === 'session-list' && !terms.length) {
    return Array.from(workspaces, ([sessionId, { name }]) => ({ sessionId, name }));
  }
  if (named && verb === 'session-end' && !terms.length) {
    if (selected?.workspace === workspace) release();
    workspaces.delete(id);
    return { ended: true };
  }
  const selectedTab = () => selected?.workspace === workspace ? selected?.id ?? null : null;
  if (named && verb === 'session-status' && !terms.length) {
    return { sessionId: id, name: workspace.name, tab: selectedTab() };
  }
  if (verb?.startsWith('session-')) throw new Error('Unsupported session action in Firefox (or invalid arguments)');
  if (verb === 'status' && !terms.length) {
    const { origins: domains = [] } = await browser.permissions.getAll();
    return { connected: true, tab: selectedTab(), domains };
  }
  if (verb === 'tabs' && !terms.length) {
    const tabs = await browser.tabs.query({});
    return (await Promise.all(tabs.filter(({ id }) => !workspace || workspace.ownedTabs.has(id)).map(async (tab) => {
      const url = await allowed(tab);
      return url && info(tab, url);
    }))).filter(Boolean);
  }
  const owner = workspace ?? connection;
  if (verb === 'tab-show' || verb === 'tab-close' || verb === 'tab-navigate') {
    return manageOwnedTab(browser, verb, terms,
      (tabId) => (!workspace || workspaces.get(id) === workspace) && owner.ownedTabs.has(tabId), assertBridge,
      async (tabId) => { if (selected?.id === tabId) release(); });
  }
  if (verb === 'open' && terms.length === 1) {
    const url = webUrl(terms[0]);
    if (!await hasHostAccess(browser.permissions, url)) throw new Error('Firefox has not granted access to this site');
    const tab = await openBackgroundTab(browser, owner, url, assertBridge, 'Firefox');
    assertBridge();
    owner.ownedTabs.add(tab.id);
    const group = await groupNewTab(owner, tab).catch((error) => {
      if (workspace) throw new Error(`Tab ${tab.id} opened, but grouping failed: ${error.message}`);
      return null;
    });
    return { tab: tab.id, origin: url.origin, group };
  }
  if (verb === 'use' && terms.length === 1 && /^\d{1,10}$/.test(terms[0])) {
    const tabId = Number(terms[0]);
    if (workspace ? !workspace.ownedTabs.has(tabId) : [...workspaces.values()].some(({ ownedTabs }) => ownedTabs.has(tabId))) {
      throw new Error('Tab does not belong to this VABU session');
    }
    return select(connection, tabId, workspace);
  }
  if (verb === 'release' && !terms.length) {
    if (selected?.workspace === workspace) release();
    return { tab: null };
  }

  const s = selected;
  if (s && s.workspace !== workspace) throw new Error('Select a tab for this VABU session with use TAB_ID');
  if (verb === 'frame-list' || verb === 'frame-read' || isFrameInspection(verb, terms)) {
    return runFrameCommand(connection, workspace, s, verb, terms, setBeforeReply);
  }
  if (verb === 'screenshot') return runCapture(connection, workspace, s, terms, setBeforeReply);
  const findTicket = verb === 'find' ? crypto.randomUUID() : undefined;
  const ctx = {
    origin: s?.origin,
    assertCurrent: () => current(s),
    page: (...params) => page(s, ...params),
    waitForCursor: () => page(s, 'waitCursor'),
    getElement: (...params) => page(s, 'getElement', ...params),
    observeWait: (_, text) => page(s, 'waitText', text),
    findControl: (criteria) => page(s, 'findControl', criteria, findTicket),
    clickRef: (ref) => interaction['mouse-click'](['left', '-', ref], {
      ...ctx,
      page: (_, ...params) => page(s, 'findInteraction', findTicket, ...params),
    }),
    inspectionScope: async () => ({
      assertCurrent: () => current(s),
      run: (...params) => page(s, 'inspect', ...params),
    }),
  };
  if (['snapshot', 'title'].includes(verb) && !terms.length) return page(s, verb);
  if (verb === 'scoped-snapshot' || verb === 'snapshot') return scoped['scoped-snapshot'](terms, ctx);
  if (verb === 'find') return find.find(terms, ctx);
  if (verb === 'get') return get.get(terms, ctx);
  if (verb === 'wait') return terms[0] === '--url' ? waitForUrl(connection, s, terms) : wait.wait(terms, ctx);
  if (['move', 'hover'].includes(verb)) return interaction['cursor-move'](terms, ctx);
  if (verb === 'click') return interaction['mouse-click'](['left', '-', ...terms], ctx);
  if (verb === 'scroll') return interaction.wheel(['0', ...terms], ctx);
  if (verb === 'type') return interaction['insert-text'](terms, ctx);
  if (Object.hasOwn(interaction, verb)) return interaction[verb](terms, ctx);
  if (['inspect-query', 'inspect-element', 'inspect-wait'].includes(verb)) {
    if (terms[0] !== '--frame' && !(verb === 'inspect-wait' && terms[0] === 'dialog')) return inspection[verb](terms, ctx);
  }
  throw new Error('Not supported by the Firefox baseline (or invalid arguments)');
}
