import { hasHostAccess, webUrl } from '../shared/domains.js';
import { isToolbarPopup, setBridgeIcon } from '../shared/toolbar.mjs';
import { defaultSocketNames, socketNameError, validSocketName } from '../shared/socket-name.mjs';
import { commands as interaction, interactionInPage } from '../shared/interaction.mjs';
import { commands as inspection, inspectionPage, isFrameInspection, runListedFrameInspection, getStyles } from '../shared/inspection.mjs';
import { commands as integrations, inPageIntegration } from './integrations.mjs';
import { commands as sessions, browserWideCommands, createSessionState } from './sessions.mjs';

import { commands as elementCommands, getElementInPage } from '../shared/get-element.mjs';
import { commands as waitCommands, waitTextInPage } from '../shared/wait.mjs';
import { commands as scopedCommands, scopedSnapshotInPage } from '../shared/scoped-snapshot.mjs';
import { commands as findCommands } from '../shared/find-click.mjs';
import { canReadFrames, createFrameScope } from './frame-read.mjs';
import { captureOwnedViewport } from './owned-capture.mjs';
import { captureOptions, captureResponse } from '../shared/capture-jpeg.mjs';
import { createOwnedDialog } from './owned-dialog.mjs';
import { feedbackCount, handleFeedback, invalidateFeedback, listFeedback, takeFeedback } from '../shared/feedback.mjs';
import { forgetWorkspaceWindow, manageOwnedTab, openBackgroundTab, watchManagedGroup } from '../shared/tab-lifecycle.mjs';
import { createEvalApproval } from '../shared/eval.mjs';
import { navigationTiming } from '../shared/navigation-timing.mjs';

const adapterCommands = { __proto__: null, ...interaction, ...inspection, ...integrations, ...elementCommands, ...waitCommands, ...scopedCommands, ...findCommands };
for (const verb of ['url', 'tab-info', 'session-start', 'session-handoff', 'session-restore', ...browserWideCommands]) {
  adapterCommands[verb] = sessions[verb];
}
const integrationOperations = new Set(['integration-inspect', 'integration-assets', 'integration-export-available']);

let bridge;
let bridgeError;
const bridgeStorage = chrome.storage.session;
let bridgeTransition = Promise.resolve();
let bridgeIntent = 0;
let session;
let detaching = Promise.resolve();
const idleGroupTitle = 'VABU';
const activeGroupTitle = 'VABU actief';
const approvalLifetime = 60_000;
const popupUrl = chrome.runtime.getURL('shared/popup.html');
const evalApproval = createEvalApproval(chrome);
const managedGroup = watchManagedGroup(chrome);
const navigation = chrome.webNavigation;
const canCheckDocument = typeof navigation?.getFrame === 'function'
  && navigation.onBeforeNavigate && navigation.onCommitted && chrome.runtime.onConnect;
let approval;
let approvalPopup;

function sendApproval(state, request) {
  try {
    approvalPopup?.postMessage({ state, request });
  } catch {}
}

function clearApproval(state = 'cancelled') {
  if (!approval) return;
  clearTimeout(approval.timer);
  approval = undefined;
  sendApproval(state);
  if (bridge) void chrome.action.setBadgeText({ text: '' }).catch(() => {});
}

async function currentDocument({ id, origin, url, documentId }) {
  const tab = await chrome.tabs.get(id);
  const info = await tabInfo(tab);
  if (info?.origin !== origin || tab.pendingUrl || tab.discarded || tab.status !== 'complete' || tab.url !== url) {
    throw new Error('Tab changed, is loading, or is no longer authorized');
  }
  const frame = await navigation.getFrame({ tabId: id, frameId: 0 });
  if (!frame?.documentId || frame.documentLifecycle !== 'active' || frame.frameType !== 'outermost_frame'
    || frame.errorOccurred || frame.url !== url || (documentId && frame.documentId !== documentId)) {
    throw new Error('Chrome cannot verify the requested document; use the tab again');
  }
  return { documentId: frame.documentId, info };
}

async function checkApproval(request) {
  try {
    if (approval !== request || bridge !== request.connection || Date.now() >= request.expires) {
      throw new Error('Tab approval expired or was cancelled; use the tab again');
    }
    const { documentId } = await currentDocument(request);
    if (approval !== request || bridge !== request.connection || Date.now() >= request.expires) {
      throw new Error('Tab approval expired or was cancelled; use the tab again');
    }
    return documentId;
  } catch (error) {
    if (approval === request) clearApproval();
    throw error;
  }
}

function showApproval() {
  if (!approval) return;
  if (Date.now() >= approval.expires) return clearApproval('expired');
  if (approval.allowed) return sendApproval('allowed', { tab: approval.id });
  if (!approval.documentId) return;
  const { token, id: tab, origin } = approval;
  approval.viewer = approvalPopup;
  sendApproval('pending', { token, tab, origin });
}

chrome.runtime.onConnect?.addListener((port) => {
  const { sender } = port;
  if (port.name !== 'tab-approval' || sender?.id !== chrome.runtime.id || sender.url !== popupUrl
    || sender.tab || (sender.frameId !== undefined && sender.frameId !== 0)) return;
  if (approval?.viewer && !approval.allowed) clearApproval();
  approvalPopup = port;
  port.onDisconnect.addListener(() => {
    if (approvalPopup !== port) return;
    approvalPopup = undefined;
    if (approval?.viewer === port && !approval.allowed) clearApproval();
  });
  port.onMessage.addListener(async (message) => {
    const { token, decision } = message ?? {};
    const request = approval;
    if (!request || request.viewer !== port || approvalPopup !== port || token !== request.token
      || request.allowed || request.deciding || !['allow', 'deny'].includes(decision)) return;
    if (decision === 'deny') return clearApproval('denied');
    request.deciding = true;
    try {
      await checkApproval(request);
      if (approval !== request || approvalPopup !== port) return;
      request.allowed = true;
      showApproval();
    } catch {}
  });
  showApproval();
});

async function ownedGroup(id, ownedTabs) {
  const tabs = await chrome.tabs.query({ groupId: id });
  return tabs.length > 0 && tabs.every(({ id }) => ownedTabs.has(id));
}

async function groupNewTab(tab, workspace, connection) {
  const index = workspace?.groups ?? connection.groups;
  const title = workspace?.name ?? idleGroupTitle;
  const groupId = index.get(tab.windowId);
  if (groupId !== undefined) {
    const group = await chrome.tabGroups.get(groupId).catch(() => null);
    if (group?.windowId === tab.windowId && (workspace ? group.title === title : [title, activeGroupTitle].includes(group.title))) {
      if (await ownedGroup(groupId, workspace?.tabs ?? connection.ownedTabs)) {
        return chrome.tabs.group({ groupId, tabIds: [tab.id] });
      }
    }
  }
  const id = await chrome.tabs.group({ createProperties: { windowId: tab.windowId }, tabIds: [tab.id] });
  await chrome.tabGroups.update(id, { color: 'purple', title });
  index.set(tab.windowId, id);
  return id;
}

async function renameGroup(id, from, to, ownedTabs) {
  const group = await chrome.tabGroups.get(id);
  if (group.title !== from || !await ownedGroup(id, ownedTabs)) return false;
  await chrome.tabGroups.update(id, { title: to });
  return true;
}

function detach(s) {
  if (!s || session !== s) return detaching;
  session = undefined;
  invalidateOwnedDocument(s);
  clearApproval();
  detaching = (async () => {
    // A modal can block the cleanup injection. Still release the debugger and
    // group through this single teardown path.
    if (s.documentId && !s.modalOpen) await page(s, 'clear').catch(() => {});
    await chrome.debugger.detach({ tabId: s.id }).catch(() => {});
    if (await s.groupMarked) await renameGroup(s.groupId, activeGroupTitle, idleGroupTitle, s.ownedTabs).catch(() => {});
  })();
  return detaching;
}

async function stopBridge(connection, error) {
  if (bridge !== connection) return;
  bridge = undefined;
  bridgeError = error;
  clearApproval();
  connection.port.disconnect();
  connection.reject(new Error(error || 'Bridge stopped'));
  void setBridgeIcon(chrome.action, false);
  await detach(session);
  if (!bridge) await chrome.action.setBadgeText({ text: error ? 'ERR' : '' }).catch(() => {});
}

function startBridge(socketOverride) {
  const socketName = socketOverride ?? defaultSocketName;
  const port = chrome.runtime.connectNative('local.vabu');
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  const connection = bridge = { port, socketName, socketOverride, ready, reject, online: false, busy: false, sessionState: createSessionState(), workspaces: new Map(), groups: new Map(), ownedTabs: new Set() };
  port.onDisconnect.addListener(() => {
    void stopBridge(connection, chrome.runtime.lastError?.message || 'Native host disconnected');
  });
  port.onMessage.addListener(async (msg) => {
    if (bridge !== connection) return;
    if (typeof msg?.startupError === 'string') {
      await stopBridge(connection, msg.startupError);
      return;
    }
    if (msg?.ready === true && !connection.online) {
      if (msg.socketName !== socketName) return stopBridge(connection, 'Unexpected native host readiness. Update the VABU native host and reconnect.');
      connection.online = true;
      resolve();
      void setBridgeIcon(chrome.action, true);
      await chrome.action.setBadgeText({ text: approval?.documentId ? 'ASK' : '' }).catch(() => {});
      return;
    }
    if (!connection.online || typeof msg?.id !== 'string') return;
    if (connection.busy) {
      port.postMessage({ id: msg.id, error: 'Another command is running' });
      return;
    }
    connection.busy = true;
    let response;
    let beforeReply;
    try {
      const value = await command(connection, msg.args, (verify, assertCurrent) => { beforeReply = { verify, assertCurrent }; });
      if (beforeReply) {
        await beforeReply.verify();
        beforeReply.assertCurrent();
      }
      response = { value };
    } catch (error) {
      response = { error: error.message };
    } finally {
      connection.busy = false;
      connection.evalRunning = false;
    }
    if (bridge === connection) port.postMessage({ id: msg.id, ...response });
  });
  try { port.postMessage({ type: 'configure', socketName }); }
  catch (error) { void stopBridge(connection, error.message); }
  return ready;
}

const defaultSocketName = defaultSocketNames.chrome;
const invalidSavedSocketName = 'Saved socket name is invalid; choose a new name or clear it.';

async function storedSocketName() {
  return (await chrome.storage.local.get('bridgeSocketName')).bridgeSocketName ?? null;
}

async function changeBridge(action, socketOverride) {
  const intent = ['start', 'stop'].includes(action) ? ++bridgeIntent : bridgeIntent;
  // Serialize policy writes, not the native handshake: Stop must be able to cancel it.
  const transition = bridgeTransition.then(async () => {
    if (action === 'status') {
      const saved = bridge ? bridge.socketOverride : await storedSocketName();
      const socketOverride = validSocketName(saved) ? saved : null;
      return { browser: 'chrome', connected: bridge?.online === true, starting: !!bridge && !bridge.online,
        socketName: bridge?.socketName ?? socketOverride ?? defaultSocketName, socketOverride,
        bridgeError: bridgeError ?? (saved === socketOverride ? undefined : invalidSavedSocketName) };
    }
    if (action === 'set-socket') {
      if (bridge) throw new Error('Stop the local bridge before changing its socket name');
      if (socketOverride !== null && !validSocketName(socketOverride)) throw new Error(socketNameError);
      await chrome.storage.local.set({ bridgeSocketName: socketOverride });
      if (bridgeError) await chrome.action.setBadgeText({ text: '' }).catch(() => {});
      bridgeError = undefined;
      return;
    }
    if (action === 'stop') {
      try {
        if (bridge) await stopBridge(bridge);
        else if (bridgeError) await chrome.action.setBadgeText({ text: '' }).catch(() => {});
        bridgeError = undefined;
      } finally {
        await bridgeStorage.set({ bridgeMode: 'stopped' });
      }
      return;
    }
    if (action === 'auto' && (bridge || (await bridgeStorage.get('bridgeMode')).bridgeMode !== undefined)) return;
    if (intent !== bridgeIntent) throw new Error('Bridge request superseded');
    await bridgeStorage.set({ bridgeMode: 'attempted' });
    if (intent !== bridgeIntent) throw new Error('Bridge request superseded');
    if (bridge) return { ready: bridge.ready };
    let saved;
    try {
      saved = await storedSocketName();
      if (saved !== null && !validSocketName(saved)) throw new Error(invalidSavedSocketName);
    } catch (error) {
      bridgeError = error.message;
      throw error;
    }
    if (intent !== bridgeIntent) throw new Error('Bridge request superseded');
    bridgeError = undefined;
    try {
      const ready = startBridge(saved);
      if (action === 'auto') void ready.catch(() => {});
      else return { ready };
    } catch (error) {
      bridgeError = error.message;
      throw error;
    }
  });
  bridgeTransition = transition.catch(() => {});
  const result = await transition;
  return result?.ready ?? result;
}

function tryAutoStart() {
  return changeBridge('auto').catch(() => {});
}

chrome.runtime.onStartup?.addListener(tryAutoStart);
chrome.runtime.onInstalled?.addListener(tryAutoStart);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (['feedback-start', 'feedback-recall', 'feedback-submit'].includes(message?.action)) {
    const connection = bridge;
    handleFeedback(chrome, connection, () => bridge, id =>
      [...connection.workspaces.values()].find(workspace => workspace.tabs.has(id)) ?? connection,
    message, sender).then(reply, error => reply({ error: error.message }));
    return true;
  }
  if (message?.action === 'feedback-list') {
    if (!isToolbarPopup(chrome.runtime, sender)) return false;
    reply(listFeedback(bridge));
    return false;
  }
  if (['eval-approve', 'eval-deny', 'set-eval-mode'].includes(message?.action)) {
    if (!isToolbarPopup(chrome.runtime, sender)) return false;
    const result = message.action === 'set-eval-mode' ? evalApproval.setMode(message.evalMode)
      : evalApproval.decide(message.action, message.token);
    result.then(reply, error => reply({ error: error.message }));
    return true;
  }
  if (sender.url !== popupUrl || !['status', 'start', 'stop', 'set-socket'].includes(message?.action)) return false;
  const response = message.action === 'status'
    ? tryAutoStart().then(() => changeBridge('status')).then(async status => ({
      ...status, ...(isToolbarPopup(chrome.runtime, sender) ? { ...await evalApproval.status(), feedbackCount: feedbackCount(bridge) } : {}),
    }))
    : changeBridge(message.action, message.socketOverride);
  response.then((result) => reply(result ?? { ok: true }), (error) => reply({ error: error.message }));
  return true;
});

chrome.permissions.onRemoved.addListener(({ origins, permissions }) => {
  if (origins?.length || permissions?.some((permission) => ['webNavigation', 'debugger', 'scripting'].includes(permission))) {
    clearApproval();
    invalidateFeedback(bridge);
    if (session) void detach(session);
  }
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (approval?.id === tabId) clearApproval();
  if (session?.id === tabId) void detach(session);
});

chrome.debugger.onEvent.addListener(({ tabId, sessionId }, method, params) => {
  const s = session;
  if (!s || s.id !== tabId || sessionId !== undefined) return;
  // Do not retain eval's console messages or exception details.
  if (!bridge?.evalRunning || !['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(method)) {
    recordConsole(s, method, params);
  }
  const dialog = s.dialogScope?.dialog;
  if (method === 'Page.javascriptDialogOpening') {
    s.modalOpen = true;
    if (params.url === s.dialogScope?.parent.url) dialog?.opening(params);
    else dialog?.invalidate();
    return;
  }
  if (method === 'Page.javascriptDialogClosed') {
    s.modalOpen = false;
    return dialog?.closed(params);
  }
  if (method !== 'Page.frameNavigated' || params.frame.parentId) return;
  invalidateOwnedDocument(s);
  try {
    if (!s.userDocument && webUrl(params.frame.url).origin === s.origin) return;
  } catch {}
  void detach(s);
});

function forgetTab(tabId) {
  invalidateFeedback(bridge, tabId);
  if (approval?.id === tabId) clearApproval();
  bridge?.ownedTabs.delete(tabId);
  for (const workspace of bridge?.workspaces.values() ?? []) workspace.tabs.delete(tabId);
  if (session?.id === tabId) void detach(session);
}

chrome.windows?.onRemoved?.addListener((id) => forgetWorkspaceWindow(bridge, id));
chrome.tabs.onRemoved.addListener(forgetTab);
chrome.tabs.onReplaced?.addListener((_added, removed) => forgetTab(removed));

function invalidateFrameScope(tabId) {
  if (session?.id === tabId) session.frameScope = session.frameInspectionScope = undefined;
}

function invalidateOwnedDocument(s) {
  managedGroup.clear();
  evalApproval.clear(s);
  s.lastCapture = undefined;
  s.ownedDocumentVersion = (s.ownedDocumentVersion ?? 0) + 1;
  s.dialogScope?.dialog.dispose();
  s.dialogScope = undefined;
}

function invalidateDocument({ tabId, frameId = 0 }) {
  invalidateFrameScope(tabId);
  if (frameId !== 0) return;
  invalidateFeedback(bridge, tabId);
  if (approval?.id === tabId) clearApproval();
  if (session?.id !== tabId) return;
  if (session.userDocument) void detach(session);
  else invalidateOwnedDocument(session);
}

navigation?.onBeforeNavigate?.addListener(invalidateDocument);
navigation?.onCommitted?.addListener(invalidateDocument);
navigation?.onHistoryStateUpdated?.addListener(invalidateDocument);
navigation?.onReferenceFragmentUpdated?.addListener(invalidateDocument);
navigation?.onErrorOccurred?.addListener(({ tabId, frameId }) => {
  invalidateFrameScope(tabId);
  if (frameId === 0) {
    invalidateFeedback(bridge, tabId);
    if (session?.id === tabId) invalidateOwnedDocument(session);
  }
});
chrome.tabs.onUpdated.addListener((tabId, { status, url, discarded, pendingUrl }) => {
  if (status === 'loading' || url !== undefined || discarded || pendingUrl) invalidateDocument({ tabId });
  const s = session;
  if (status === 'complete' && s?.ready && !s.userDocument && s.id === tabId && !s.modalOpen) void page(s, 'show').catch(() => {});
});

async function cdp(s, method, params) {
  if (s.userDocument) await checkedTab(s);
  if (session !== s) throw new Error('Tab is no longer authorized');
  return chrome.debugger.sendCommand({ tabId: s.id }, method, params);
}

async function page(s, operation, ...args) {
  const target = { tabId: s.id };
  if (operation === 'clear') target.documentIds = [s.documentId];
  else if (session !== s) throw new Error('Tab is no longer authorized');
  else {
    if (operation === 'confirmClick' || operation === 'clickReceipt') target.documentIds = [args.shift()];
    if (operation === 'findClick' || operation === 'click') target.documentIds = [args.pop()];
    if (s.userDocument) {
      await checkedTab(s);
      target.documentIds = [s.userDocument.documentId];
    }
    if (session !== s) throw new Error('Tab is no longer authorized');
  }
  const [injection] = await chrome.scripting.executeScript({
    target, world: 'ISOLATED', func: inPage, args: [s.origin, s.overlayKey, !s.inManagedGroup, operation, ...args],
  });
  if (operation !== 'clear') {
    if (session !== s) {
      if (injection?.documentId) {
        await page({ ...s, documentId: injection.documentId }, 'clear').catch(() => {});
      }
      throw new Error('Tab is no longer authorized');
    }
    if (target.documentIds && injection?.documentId !== target.documentIds[0]) throw new Error('Selected document changed');
    if (injection?.documentId) s.documentId = injection.documentId;
  }
  if (!injection?.result?.ok) throw new Error(injection?.result?.error || 'Page is not available');
  return injection.result.value;
}

async function waitForCursor(s, wait = () => page(s, 'waitCursor')) {
  let timer;
  try {
    const visible = await Promise.race([
      wait(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor did not arrive; click cancelled')), 1200);
      }),
    ]);
    return visible;
  } finally {
    clearTimeout(timer);
  }
}

// Runs in the extension's isolated world in the main document, not in site JS.
function inPage(origin, key, markTitle, operation, arg, y, animate = true, findTicket) {
  const fail = (error) => ({ error });
  const ok = (value) => ({ ok: true, value });
  if (window !== window.top || location.origin !== origin) return fail('Page changed origin or frame; authorize it again');
  if (operation === 'clear') {
    if (globalThis.vabuCursorState?.key === key) globalThis.vabuCursorState.clear();
    return ok(true);
  }

  const style = (element, properties) => {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
  };
  if (globalThis.vabuCursorState?.key !== key || !globalThis.vabuCursorState.host.isConnected) {
    globalThis.vabuCursorState?.clear();
    const host = document.createElement('div');
    style(host, {
      all: 'initial', display: 'block', position: 'fixed', inset: '0',
      'z-index': '2147483647', 'pointer-events': 'none', 'user-select': 'none', overflow: 'clip',
    });
    const root = host.attachShadow({ mode: 'closed' });
    const ns = 'http://www.w3.org/2000/svg';
    const cursor = document.createElementNS(ns, 'svg');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.setAttribute('viewBox', '0 0 38 40');
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', '12');
    ring.setAttribute('cy', '12');
    ring.setAttribute('r', '9');
    ring.setAttribute('fill', '#6d28d955');
    ring.setAttribute('stroke', '#fff');
    ring.setAttribute('stroke-width', '2');
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M12 12 L33 25 L24 26 L20 35 Z');
    arrow.setAttribute('fill', '#6d28d9');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.7');
    arrow.setAttribute('stroke-linejoin', 'round');
    style(cursor, {
      position: 'absolute', top: '0', left: '0', width: '38px', height: '40px',
      display: 'block', filter: 'drop-shadow(0 1px 3px #000c)',
      transform: 'translate(' + (innerWidth / 2 - 12) + 'px, ' + (innerHeight / 2 - 12) + 'px)',
    });
    cursor.append(ring, arrow);
    root.append(cursor);
    document.documentElement.append(host);
    let originalTitle;
    let markedTitle;
    const title = () => document.title === markedTitle ? originalTitle : document.title;
    const markTab = () => {
      if (document.title === markedTitle) return;
      originalTitle = document.title;
      document.title = originalTitle ? '🟣 ' + originalTitle : '🟣';
      markedTitle = document.title;
    };
    const observer = new MutationObserver(markTab);
    if (markTitle && document.head) {
      markTab();
      observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    }
    const clear = () => {
      removeEventListener('pagehide', clear);
      observer.disconnect();
      if (document.title === markedTitle) document.title = originalTitle;
      host.remove();
      delete globalThis.vabuCursorState;
    };
    addEventListener('pagehide', clear, { once: true });
    globalThis.vabuCursorState = { key, host, cursor, title, clear };
  }
  const state = globalThis.vabuCursorState;
  if (operation === 'show') return ok(true);
  if (operation === 'title') return ok(state.title());
  if (operation === 'waitCursor') {
    if (document.hidden) return ok(false);
    const animations = state.cursor.getAnimations();
    if (!animations.length) return ok(true);
    return new Promise((resolve) => {
      const onHidden = () => { if (document.hidden) finish(false); };
      const finish = (visible) => {
        document.removeEventListener('visibilitychange', onHidden);
        resolve(ok(visible));
      };
      document.addEventListener('visibilitychange', onHidden);
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => finish(!document.hidden));
    });
  }
  if (operation === 'clickReceipt') {
    const received = state.clickReceived;
    delete state.clickReceived;
    return received ? ok(true) : fail('Click delivery not confirmed at target; inspect before retrying');
  }
  if (operation === 'confirmClick') {
    const preview = state.preview;
    const find = preview?.find;
    if (find?.ticket !== (arg ?? undefined) || (find && state.find !== find)) return fail('Find target expired');
    delete state.preview;
    if (find) delete state.find;
    const background = y === true;
    if (document.hidden !== background || (background && (location.href !== animate || globalThis.origin !== origin))
      || !preview || document.elementFromPoint(preview.x, preview.y) !== preview.hit
      || preview.hit.closest('a[href]')?.href !== preview.href || preview.hit.closest(':disabled')
      || (preview.binding && ((!find && state.targets !== preview.targets)
        || !preview.binding.valid(preview.proxy ? preview.hit : undefined)))) {
      return fail('Click target changed during preview; take a new snapshot');
    }
    const verified = find?.verify();
    if (verified && !verified.ok) return verified;
    if (background) {
      const { hit, x, y: clientY } = preview;
      const blocked = 'iframe,frame,embed,object,fencedframe,portal,[inert],[aria-disabled="true" i],:disabled,input[type=file]';
      const labelControl = hit.closest('label')?.control;
      const control = labelControl ?? hit.closest('input,button,textarea');
      if (hit.closest(blocked) || (labelControl && !labelControl.contains(hit)) || control?.closest(blocked)
        || (control?.form && ['submit', 'reset', 'image'].includes(control.type))) {
        return fail('This control cannot be clicked in the background');
      }
      const anchor = hit.closest('a,area');
      if (anchor) {
        const target = anchor.getAttribute('target') || document.querySelector('base[target]')?.getAttribute('target') || '';
        const href = anchor.getAttribute('href');
        const url = href === null ? null : new URL(href, document.baseURI);
        if (anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml' || anchor.hasAttribute('download') || anchor.hasAttribute('ping')
          || !['', '_self'].includes(target.toLowerCase()) || (url && (!/^https?:$/.test(url.protocol)
            || url.origin !== origin || url.username || url.password))) return fail('This link cannot be clicked in the background');
      }
      const receipt = {};
      state.clickReceived = false;
      state.clickAttempt = receipt;
      hit.addEventListener('click', e => {
        if (state.clickAttempt === receipt && e.isTrusted && e.target === hit && e.button === 0
          && e.clientX === Math.floor(x) && e.clientY === Math.floor(clientY)) state.clickReceived = true;
      }, { capture: true, once: true, signal: AbortSignal.timeout(5000) });
    }
    return ok(true);
  }

  if (operation === 'snapshot') {
    state.targets = Array.from(document.querySelectorAll(
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=true], [role=button], [role=link]'
    )).filter((element) => element.checkVisibility({ visibilityProperty: true, opacityProperty: true })).slice(0, 100);
    return ok({
      title: state.title().slice(0, 200),
      text: document.body?.innerText.trim().slice(0, 4000) ?? '',
      controls: state.targets.map((el, i) => {
        const name = el.getAttribute('aria-label') || el.labels?.[0]?.innerText
          || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') || '';
        return { ref: '@r' + (i + 1), role: el.getAttribute('role') || el.localName, name: name.trim().slice(0, 150) };
      }),
    });
  }

  if (operation === 'type') {
    const field = document.activeElement;
    if (field?.isContentEditable || field?.localName === 'textarea'
      || (field?.localName === 'input' && ['text', 'search', 'url', 'email', 'tel', 'number', 'password'].includes(field.type))) {
      return ok(true);
    }
    return fail('Click a text field first; file and other non-text fields are not supported');
  }

  const find = operation === 'findClick' ? state.find : null;
  if (operation === 'findClick') {
    if (!find || find.ticket !== findTicket) return fail('Find target expired');
    const verified = find.verify();
    if (!verified.ok) return verified;
    operation = 'click';
  }
  const targets = find?.targets ?? state.targets;
  let binding;
  let proxy;
  let x = arg;
  let target;
  if (arg === null) {
    ({ x, y } = state.point ?? { x: innerWidth / 2, y: innerHeight / 2 });
  } else if (typeof arg === 'string') {
    target = targets?.[Number(arg.slice(2)) - 1];
    if (!target?.isConnected || target.matches(':disabled') || !target.checkVisibility()) {
      return fail('Stale or disabled control; take a new snapshot');
    }
    const visibleCenter = (rect) => {
      const left = Math.max(0, rect.left);
      const right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(innerHeight, rect.bottom);
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    };
    let position = visibleCenter(target.getBoundingClientRect());
    binding = operation === 'click' && state.radioProxies?.get(targets)?.get(target);
    if (binding && !binding.valid()) return fail('Radio label changed; take a fresh snapshot');
    if (binding && (!target.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      || !target.contains(document.elementFromPoint(position.x, position.y)))) {
      proxy = binding;
      target = binding.label;
      position = visibleCenter(target.getBoundingClientRect());
    }
    if (!target.contains(document.elementFromPoint(position.x, position.y))) {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
    const rect = target.getBoundingClientRect();
    ({ x, y } = visibleCenter(rect));
  }
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return fail('Coordinates outside the viewport');
  const hit = document.elementFromPoint(x, y);
  if (target && (!hit || !target.contains(hit) || (proxy && !proxy.valid(hit)))) {
    return fail('Control is covered or unavailable; use a fresh snapshot or viewport coordinates');
  }
  if (operation !== 'move' && hit?.matches('iframe, frame, embed, object')) return fail('Frame input is not supported');
  if (operation === 'click') {
    if (!hit || hit.matches('input[type=file]')) return fail('No clickable target, or a file picker');
    state.preview = { x, y, hit, href: hit.closest('a[href]')?.href, binding, proxy, targets, find };
  }

  state.cursor.firstElementChild.setAttribute('opacity', operation === 'click' ? '1' : '0');
  style(state.cursor, {
    display: 'block',
    transition: animate && document.hasFocus() && matchMedia('(prefers-reduced-motion: no-preference)').matches
      ? 'transform 80ms ease-out' : 'none',
    transform: 'translate(' + (x - 12) + 'px, ' + (y - 12) + 'px)',
  });
  state.point = { x, y };
  return ok(state.point);
}

async function tabInfo(tab) {
  try {
    if (tab.incognito) return;
    const url = webUrl(tab.url || tab.pendingUrl);
    if (!await hasHostAccess(chrome.permissions, url)) return;
    if (tab.pendingUrl && webUrl(tab.pendingUrl).origin !== url.origin) return;
    return { tab: tab.id, origin: url.origin, active: tab.active };
  } catch {}
}

async function checkedTab(s) {
  if (s.userDocument) {
    try {
      const { info } = await currentDocument(s.userDocument);
      if (session !== s) throw new Error('Tab is no longer authorized');
      return info;
    } catch (error) {
      void detach(s);
      throw error;
    }
  }
  const info = await tabInfo(await chrome.tabs.get(s.id));
  if (session !== s || info?.origin !== s.origin) throw new Error('Tab is no longer authorized or changed origin');
  return info;
}

async function scroll(connection, s, dy, ref) {
  const documentId = s.documentId;
  const version = s.ownedDocumentVersion;
  const timeoutError = new Error('Scroll timed out; input may have been applied. Inspect before retrying');
  const deadline = Date.now() + 3000;
  let timer, expired = false;
  const assertCurrent = () => {
    if (expired || Date.now() >= deadline) throw timeoutError;
    if (bridge !== connection || session !== s || !documentId || s.documentId !== documentId
      || s.ownedDocumentVersion !== version) throw new Error('Scroll cancelled: selected document changed');
  };
  const assertCanScroll = () => {
    assertCurrent();
    if (s.modalOpen) throw new Error('Scroll unavailable while a JavaScript dialog is open');
  };
  const inject = async (func, ...args) => {
    assertCanScroll();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: s.id, documentIds: [documentId] }, world: 'ISOLATED', func, args: [s.origin, ...args],
    });
    assertCurrent();
    if (result?.documentId !== documentId || result.frameId !== 0) throw new Error('Selected document changed');
    if (result.result?.ok !== true) throw new Error(result.result?.error || 'Scroll target is not available');
    return result.result.value;
  };
  const run = async () => {
    const { active } = await checkedTab(s);
    assertCurrent();
    if (!active) {
      requireOwnedSelection(connection, s);
      const scope = ownedDocumentScope(connection, s);
      scope.parent.url = (await chrome.tabs.get(s.id)).url;
      if ((await scope.verify()).active !== false) throw new Error('Scroll cancelled: tab activation changed');
      const value = await inject(interactionInPage, s.overlayKey, 'apply', {
        kind: 'wheel', dx: 0, dy, start: ref ? { ref } : null,
      }, { href: scope.parent.url, deadline });
      await scope.verify();
      assertCurrent();
      return value;
    }
    const point = await inject(inPage, s.overlayKey, !s.inManagedGroup, 'scroll', ref ?? null);
    for (const event of [{ type: 'mouseMoved' }, { type: 'mouseWheel', deltaX: 0, deltaY: dy }]) {
      if (!(await checkedTab(s)).active) throw new Error('Scroll cancelled: tab activation changed');
      assertCanScroll();
      await chrome.debugger.sendCommand({ tabId: s.id }, 'Input.dispatchMouseEvent', { ...point, ...event });
      assertCurrent();
    }
    return true;
  };
  // Chromium does not expose cancellation for issued input or script calls.
  // Release the bridge slot on timeout, but never continue to the next input step.
  try {
    return await Promise.race([new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(timeoutError);
      }, Math.max(0, deadline - Date.now()));
    }), run()]);
  } finally {
    clearTimeout(timer);
  }
}

async function click(connection, s, target, y, wasActive, documentId = s.documentId, findTicket) {
  if (!documentId || s.documentId !== documentId) throw new Error('Click cancelled: selected document changed');
  let scope;
  if (!wasActive) {
    requireOwnedSelection(connection, s);
    scope = ownedDocumentScope(connection, s);
    scope.parent.url = (await chrome.tabs.get(s.id)).url;
    if ((await scope.verify()).active !== false) throw new Error('Click cancelled: tab activation changed');
  }
  const point = findTicket
    ? await page(s, 'findClick', target, y, wasActive, findTicket, documentId)
    : await page(s, 'click', target, y, wasActive, documentId);
  if (s.documentId !== documentId) throw new Error('Click cancelled: selected document changed');
  if (scope) {
    if ((await scope.verify()).active !== false) throw new Error('Click cancelled: tab activation changed');
    scope.assertCurrent();
    await page(s, 'confirmClick', documentId, findTicket ?? null, true, scope.parent.url);
    if ((await scope.verify()).active !== false) throw new Error('Click cancelled: tab activation changed');
    scope.assertCurrent();
  } else {
    await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseMoved' });
    if (!documentId || !await waitForCursor(s) || !(await checkedTab(s)).active) {
      throw new Error('Click cancelled: selected tab is not visible');
    }
    if (s.documentId !== documentId) throw new Error('Click cancelled: selected document changed');
    const epoch = s.ownedDocumentVersion;
    await page(s, 'confirmClick', documentId, ...(findTicket ? [findTicket] : []));
    if (!(await checkedTab(s)).active || s.documentId !== documentId || s.ownedDocumentVersion !== epoch) {
      throw new Error('Click cancelled: selected tab or document changed');
    }
  }
  await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
  await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
  if (scope) {
    scope.assertCurrent();
    await page(s, 'clickReceipt', documentId);
    return { ...point, dispatched: true, trusted: true };
  }
  return { ...point, dispatched: true };
}

const mainInspectionKey = (s) => `${s.overlayKey}:${s.ownedDocumentVersion ?? 0}`;

async function runAdapter(connection, verb, args) {
  const s = session;
  const documentId = s?.documentId;
  const findTicket = verb === 'find' ? crypto.randomUUID() : undefined;
  const assertBridge = () => {
    if (bridge !== connection) throw new Error('Bridge stopped');
  };
  const assertCurrent = async () => {
    assertBridge();
    if (!s || !documentId || s.documentId !== documentId) throw new Error('Select an approved document first');
    await checkedTab(s);
    if (s.userDocument) return assertBridge();
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: s.id, documentIds: [documentId] }, world: 'ISOLATED',
      func: (origin) => window === window.top && globalThis.origin === origin && location.origin === origin, args: [s.origin],
    });
    await checkedTab(s);
    assertBridge();
    if (s.documentId !== documentId || probe?.documentId !== documentId || probe.result !== true) {
      throw new Error('Selected document changed');
    }
  };
  const inject = async (func, ...params) => {
    await assertCurrent();
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: s.id, documentIds: [documentId] }, world: 'ISOLATED', func, args: [s.origin, ...params],
    });
    await assertCurrent();
    if (result?.documentId !== documentId) throw new Error('Selected document changed');
    return result.result;
  };
  const unwrap = (result) => {
    if (result?.ok !== true) throw new Error(result?.error || 'Page operation failed');
    return result.value;
  };
  const ctx = {
    tabId: s?.id, origin: s?.origin, assertBridge, assertCurrent,
    browser: chrome, sessionState: connection.sessionState,
    releaseSelection: async () => { await assertCurrent(); await detach(s); },
    waitForCursor: () => waitForCursor(s, async () => unwrap(await inject(inPage, s.overlayKey, !s.inManagedGroup, 'waitCursor'))),
    page: async (operation, ...params) => {
      if (operation === 'interaction') return unwrap(await inject(interactionInPage, s.overlayKey, ...params));
      if (operation === 'scopedSnapshot') return unwrap(await inject(scopedSnapshotInPage, s.overlayKey, ...params));
      if (integrationOperations.has(operation)) return inject(inPageIntegration, operation);
      throw new Error('Unsupported adapter operation');
    },
    inspectionScope: async (frameId) => {
      if (frameId !== 0) throw new Error('Subframe inspection is not enabled');
      await assertCurrent();
      const key = mainInspectionKey(s);
      return { documentId, assertCurrent,
        run: async (operation, value) => unwrap(await inject(inspectionPage, key, operation, value)),
      };
    },
    integrationLayoutMetrics: async () => { await assertCurrent(); return cdp(s, 'Page.getLayoutMetrics'); },
    getElement: async (property, ref) => unwrap(await inject(getElementInPage, s.overlayKey, property, ref)),
    findControl: async (criteria) => unwrap(await inject(scopedSnapshotInPage, s.overlayKey, 'uniqueControl', criteria, null, findTicket)),
    clickRef: async (ref) => {
      await assertCurrent();
      const { active } = await checkedTab(s);
      await assertCurrent();
      return click(connection, s, ref, null, active, documentId, findTicket);
    },
    observeWait: async (kind, value) => {
      if (kind === 'text') return inject(waitTextInPage, value);
      assertBridge();
      await checkedTab(s);
      const tab = await chrome.tabs.get(s.id);
      const info = await tabInfo(tab);
      await checkedTab(s);
      assertBridge();
      if (info?.origin !== s.origin || !tab.url) throw new Error('Selected tab changed origin');
      return !tab.pendingUrl && webUrl(tab.url).href === value;
    },
  };
  if (verb === 'title') {
    if (args.length) throw new Error('Invalid command arguments');
    return unwrap(await inject(inPage, s?.overlayKey, !s?.inManagedGroup, 'title'));
  }
  if (verb === 'wait' && args[0] === '--url') {
    assertBridge();
    if (!s) throw new Error('Select an approved tab first');
    await checkedTab(s);
  } else if (!browserWideCommands.has(verb)) await assertCurrent();
  return adapterCommands[verb](args, ctx);
}

function isOwnedSelection(connection, s) {
  return bridge === connection && session === s && s?.ready && s.documentId && !s.userDocument
    && connection.ownedTabs.has(s.id) && (!s.workspace || s.workspace.tabs.has(s.id));
}

function requireOwnedSelection(connection, s = session) {
  if (!isOwnedSelection(connection, s)) throw new Error('Select a tab opened by VABU in this bridge and workspace first');
  return s;
}

function ownedDocumentScope(connection, s) {
  if (!canCheckDocument || !navigation.onHistoryStateUpdated || !navigation.onReferenceFragmentUpdated
    || !navigation.onErrorOccurred) throw new Error('Chrome document verification APIs are required');
  const parent = { id: s.id, origin: s.origin, documentId: s.documentId };
  const version = s.ownedDocumentVersion;
  const assertCurrent = () => {
    if (!isOwnedSelection(connection, s) || s.ownedDocumentVersion !== version || s.documentId !== parent.documentId) {
      throw new Error('Owned document selection expired; use the tab again');
    }
  };
  const verify = async () => {
    assertCurrent();
    const { info } = await currentDocument(parent);
    assertCurrent();
    return info;
  };
  return { parent, assertCurrent, verify };
}

async function groupedDocumentScope(connection, s) {
  requireOwnedSelection(connection, s);
  const document = ownedDocumentScope(connection, s);
  const { parent } = document;
  const owner = s.workspace ?? connection;
  const group = managedGroup.pin(owner, s, id => connection.ownedTabs.has(id)
    && (s.workspace ? s.workspace.tabs.has(id) : ![...connection.workspaces.values()].some(({ tabs }) => tabs.has(id))));
  const assertCurrent = () => {
    document.assertCurrent();
    group.assertCurrent();
  };
  assertCurrent();
  parent.url = (await chrome.tabs.get(parent.id)).url;
  return { id: parent.id, documentId: parent.documentId, origin: parent.origin, href: parent.url, assertCurrent,
    async verify() {
      assertCurrent();
      await document.verify();
      await group.verify();
      assertCurrent();
    } };
}

function runEval(connection, terms, setBeforeReply) {
  connection.evalRunning = true;
  const s = session;
  return evalApproval.run(s, terms, () => groupedDocumentScope(connection, s), setBeforeReply);
}

async function runStyles(connection, terms, setBeforeReply) {
  const s = session;
  const scope = await groupedDocumentScope(connection, s);
  const { id, documentId, origin, href } = scope;
  const key = mainInspectionKey(s);
  return getStyles(terms, { ...scope, run: async (operation, ref) => {
    const results = await chrome.scripting.executeScript({
      target: { tabId: id, documentIds: [documentId] }, world: 'ISOLATED', func: inspectionPage,
      args: [origin, key, operation, ref, null, href],
    });
    if (results?.length !== 1 || results[0].documentId !== documentId || results[0].frameId !== 0 || results[0].error !== undefined) {
      throw new Error('Selected document changed');
    }
    return results[0].result;
  } }, setBeforeReply);
}

function recordConsole(s, method, params) {
  const capture = s.consoleCapture;
  if (!capture) return;
  if (method === 'Runtime.executionContextCreated') {
    const { id, origin, auxData } = params.context;
    if (auxData?.isDefault && auxData.frameId === capture.frameId && origin === s.origin) capture.context = id;
    return;
  }
  if (method === 'Runtime.executionContextsCleared'
    || (method === 'Runtime.executionContextDestroyed' && params.executionContextId === capture.context)) {
    capture.context = undefined;
    return;
  }
  if (capture.context === undefined) return;
  let entry;
  if (method === 'Runtime.consoleAPICalled' && params.executionContextId === capture.context) {
    entry = { level: params.type, text: params.args.slice(0, 8)
      .map(arg => String(arg.value ?? arg.unserializableValue ?? arg.description ?? arg.type).slice(0, 256)).join(' ') };
  } else if (method === 'Runtime.exceptionThrown' && params.exceptionDetails.executionContextId === capture.context) {
    const { exceptionDetails: error } = params;
    entry = { level: 'error', text: (error.exception?.description ?? error.text).slice(0, 2048), line: error.lineNumber + 1 };
  }
  if (!entry) return;
  if (capture.entries.length === 100) { capture.entries.shift(); capture.dropped++; }
  capture.entries.push(entry);
}

async function runDebug(connection, verb, args, setBeforeReply) {
  const [action] = args;
  if (args.length !== 1 || !(verb === 'console' ? ['start', 'reload', 'read', 'stop'].includes(action) : action === 'timing')) {
    throw new Error(verb === 'console' ? 'Usage: vabu console start | reload | read | stop' : 'Usage: vabu js timing');
  }
  const s = requireOwnedSelection(connection);
  const scope = ownedDocumentScope(connection, s);
  scope.parent.url = (await chrome.tabs.get(s.id)).url;
  await scope.verify();
  if (verb === 'js') {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: s.id, documentIds: [scope.parent.documentId] },
      world: 'ISOLATED', args: [scope.parent.url], func: navigationTiming });
    if (result?.documentId !== scope.parent.documentId || result.frameId !== 0 || !result.result) {
      throw new Error('Navigation timing unavailable for this document');
    }
    setBeforeReply(scope.verify, scope.assertCurrent);
    return result.result;
  }
  if (action === 'stop') {
    if (s.consoleCapture) {
      delete s.consoleCapture;
      await cdp(s, 'Runtime.disable');
    }
    return { recording: false };
  }
  if (action === 'read') {
    if (!s.consoleCapture) throw new Error('Start console recording first');
    setBeforeReply(scope.verify, scope.assertCurrent);
    const { entries, dropped } = s.consoleCapture;
    return { entries: entries.slice(), dropped };
  }
  if (!s.consoleCapture) {
    const tree = await cdp(s, 'Page.getFrameTree');
    const frame = tree?.frameTree?.frame;
    if (!frame?.id || frame.url !== scope.parent.url) throw new Error('Cannot verify the root frame for console recording');
    await scope.verify();
    s.consoleCapture = { frameId: frame.id, entries: [], dropped: 0 };
    try {
      await cdp(s, 'Runtime.enable');
      await scope.verify();
    } catch (error) {
      delete s.consoleCapture;
      if (session === s) await cdp(s, 'Runtime.disable').catch(() => {});
      throw error;
    }
  }
  if (action === 'reload') {
    s.consoleCapture.entries.length = 0;
    s.consoleCapture.dropped = 0;
    s.consoleCapture.context = undefined;
    scope.assertCurrent();
    await cdp(s, 'Page.reload');
  }
  return { recording: true };
}

async function runCapture(connection, args, setBeforeReply) {
  const options = captureOptions(args);
  const s = requireOwnedSelection(connection);
  // The worker's existing event listeners invalidate this version even during
  // the initial lookup, capture, or final authorization before the native reply.
  const scope = ownedDocumentScope(connection, s);
  const data = await captureOwnedViewport({
    tabId: s.id, ...options,
    createGuard: async () => {
      scope.parent.url = (await chrome.tabs.get(s.id)).url;
      return { assertValid: scope.verify, close() {} }; // No per-request listeners to remove.
    },
    sendCommand: (target, method, params) => {
      scope.assertCurrent();
      return chrome.debugger.sendCommand(target, method, params);
    },
  });
  const { value, next } = await captureResponse(data, options, s.lastCapture, scope.parent.documentId);
  setBeforeReply(scope.verify, () => {
    scope.assertCurrent();
    if (next) s.lastCapture = next;
  });
  return value;
}

async function armDialogScope(connection, s) {
  if (!isOwnedSelection(connection, s) || s.dialogScope || s.modalOpen) return;
  try {
    const scope = ownedDocumentScope(connection, s);
    scope.parent.url = (await chrome.tabs.get(s.id)).url;
    await scope.verify();
    scope.assertCurrent();
    if (s.modalOpen) return;
    const dialog = createOwnedDialog({ tabId: s.id, sendCommand: (target, method, params) => {
      scope.assertCurrent();
      return chrome.debugger.sendCommand(target, method, params);
    } });
    s.dialogScope = { ...scope, dialog };
  } catch {} // Normal selection remains available without a verified dialog observer.
}

async function runDialog(connection, args, setBeforeReply) {
  const [action, id] = args;
  if (!(action === 'show' && args.length === 1)
    && !(['accept', 'dismiss'].includes(action) && args.length === 2 && /^[a-zA-Z\d_-]{16,80}$/.test(id))) {
    throw new Error('Usage: inspect-dialog show | accept ID | dismiss ID');
  }
  const s = requireOwnedSelection(connection);
  const scope = s.dialogScope;
  if (!scope) throw new Error('No verified dialog observer; use the tab before opening a dialog');
  try {
    await scope.verify(); // Browser metadata only: scripts may be blocked by the dialog.
  } catch (error) {
    if (s.dialogScope === scope) invalidateOwnedDocument(s);
    throw error;
  }
  scope.assertCurrent();
  if (action === 'show') {
    const value = scope.dialog.getCurrent();
    if (!value) throw new Error('No current supported dialog');
    setBeforeReply(scope.verify, () => {
      scope.assertCurrent();
      if (scope.dialog.getCurrent()?.id !== value.id) throw new Error('Dialog changed; use show again');
    });
    return value;
  }
  await scope.dialog.respond(id, action);
  const verifyResponse = async () => {
    try { await scope.verify(); }
    catch { throw new Error('Dialog response outcome indeterminate; do not retry the ID'); }
  };
  setBeforeReply(verifyResponse, () => {
    try { scope.assertCurrent(); }
    catch { throw new Error('Dialog response outcome indeterminate; do not retry the ID'); }
  });
  return { handled: true };
}

async function runFrameCommand(connection, verb, args, setBeforeReply) {
  if (!canReadFrames(chrome)) throw new Error('Direct iframe reads require Chrome document verification APIs');
  const s = requireOwnedSelection(connection);
  const documentId = s.documentId;
  const inspection = isFrameInspection(verb, args);
  const field = inspection ? 'frameInspectionScope' : 'frameScope';
  let scope = s[field];
  const assertCurrent = () => {
    if (!isOwnedSelection(connection, s) || s.documentId !== documentId || s[field] !== scope) {
      throw new Error('Iframe selection expired; run frame-list again');
    }
  };
  const finalCheck = (verify) => setBeforeReply(async () => {
    try {
      await verify();
    } catch (error) {
      if (s.frameScope === scope) s.frameScope = undefined;
      throw error;
    }
  }, assertCurrent);
  if (verb === 'frames' && args.length) throw new Error('Usage: frames');
  if ((verb === 'frame-list' || verb === 'frames') && args.length === 0) {
    // Install a fresh scope before the first asynchronous lookup, so navigation
    // during discovery invalidates it even before any child IDs are known.
    const parent = { id: s.id, documentId, origin: s.origin };
    scope = s[field] = createFrameScope(chrome, parent, assertCurrent);
    try {
      parent.url = (await chrome.tabs.get(s.id)).url;
      if (inspection) return await runListedFrameInspection(verb, args, scope, assertCurrent, setBeforeReply);
      const value = await scope.discover();
      finalCheck(scope.verifyParent);
      return value;
    } catch {
      if (s[field] === scope) s[field] = undefined;
      throw new Error('Cannot verify direct iframes and site access for the selected document');
    }
  }
  if (inspection) return runListedFrameInspection(verb, args, scope, assertCurrent, setBeforeReply);
  if (verb !== 'frame-read' || args.length !== 1) throw new Error('Usage: frame-list | frame-read FRAME_ID');
  const frame = scope?.frames.get(args[0]);
  if (!frame) throw new Error('Unknown or stale iframe ID; run frame-list again');
  try {
    const value = await scope.read(frame);
    finalCheck(() => scope.verifyRead(frame));
    return value;
  } catch (error) {
    if (s.frameScope === scope) s.frameScope = undefined;
    throw error;
  }
}

async function command(connection, args, setBeforeReply) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Invalid command');
  const assertBridge = () => { if (bridge !== connection) throw new Error('Bridge stopped'); };
  assertBridge();
  const [scope, id] = args;
  const workspaces = connection.workspaces;
  const scoped = scope === '--session';
  const workspace = scoped ? workspaces.get(id) : undefined;
  if (scoped && !workspace) throw new Error('Unknown VABU session ID');
  if (scoped) args = args.slice(2);
  const [verb, a, b] = args;
  const count = args.length - 1;
  if (verb === 'feedback') return takeFeedback(workspace ?? connection, args.slice(1));
  if (!scoped && verb === 'session-start' && count === 1) {
    const name = a.trim();
    if (!name || name.length > 60 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('Supply a session name of 1–60 characters');
    const sessionId = crypto.randomUUID();
    workspaces.set(sessionId, { name, groups: new Map(), tabs: new Set() });
    return { sessionId, name };
  }
  if (!scoped && verb === 'session-list' && count === 0) {
    return Array.from(workspaces, ([sessionId, { name }]) => ({ sessionId, name }));
  }
  if (scoped && verb === 'session-end' && count === 0) {
    if (session?.workspace === workspace) await detach(session);
    for (const tabId of workspace.tabs) connection.ownedTabs.delete(tabId);
    workspaces.delete(id);
    return { ended: true };
  }
  if (scoped && verb === 'session-status' && count === 0) {
    return { sessionId: id, name: workspace.name, tab: session?.workspace === workspace ? session.id : null };
  }
  if (scoped && verb?.startsWith('session-') && !(verb === 'session-handoff' && count === 0)) {
    throw new Error('Unsupported named session action');
  }
  if (verb === 'status' && count === 0) {
    const { origins: domains = [] } = await chrome.permissions.getAll();
    return { connected: true, tab: session?.workspace === workspace ? session?.id ?? null : null, domains };
  }
  if (verb === 'tabs' && count === 0) {
    const tabs = await chrome.tabs.query({});
    return (await Promise.all(tabs.filter(({ id }) => !workspace || workspace.tabs.has(id)).map(tabInfo))).filter(Boolean);
  }
  if (verb === 'tab-show' || verb === 'tab-close' || verb === 'tab-navigate') {
    const owns = (tabId) => workspace ? workspaces.get(id) === workspace && connection.ownedTabs.has(tabId) && workspace.tabs.has(tabId)
      : connection.ownedTabs.has(tabId) && ![...workspaces.values()].some(({ tabs }) => tabs.has(tabId));
    return manageOwnedTab(chrome, verb, args.slice(1), owns, assertBridge, async (tabId) => {
      if (session?.id === tabId) await detach(session);
    });
  }
  if (verb === 'open' && count === 1) {
    const url = webUrl(a);
    if (!await hasHostAccess(chrome.permissions, url)) throw new Error('Chrome has not granted access to this site');
    const tab = await openBackgroundTab(chrome, workspace ?? connection, url, assertBridge, 'Chromium');
    assertBridge();
    connection.ownedTabs.add(tab.id);
    workspace?.tabs.add(tab.id);
    const group = await groupNewTab(tab, workspace, connection).catch((error) => {
      if (workspace) throw new Error(`Tab ${tab.id} opened, but grouping failed: ${error.message}`);
      return null;
    });
    return { tab: tab.id, origin: url.origin, group, active: (await chrome.tabs.get(tab.id)).active };
  }
  if (verb === 'use' && count === 1 && /^\d{1,10}$/.test(a)) {
    const id = Number(a);
    if (workspace ? !workspace.tabs.has(id) : [...workspaces.values()].some(({ tabs }) => tabs.has(id))) {
      throw new Error('Tab does not belong to this VABU session');
    }
    const tab = await chrome.tabs.get(id);
    const info = await tabInfo(tab);
    if (!info) throw new Error('Chrome has not granted access to this tab');
    if (session?.ready && session.id === id && session.workspace === workspace) {
      const s = session;
      const info = await checkedTab(s);
      if (!s.documentId && !s.userDocument && !s.modalOpen) await page(s, 'show').catch(() => {});
      await armDialogScope(connection, s);
      return info;
    }
    await detach(session);
    if (bridge !== connection) throw new Error('Bridge stopped');
    const { ownedTabs, groups } = connection;
    let request;
    if (!ownedTabs.has(id)) {
      // A URL can survive a reload; do not probe by injecting into an unapproved tab.
      if (!canCheckDocument) throw new Error('Existing tab control is unavailable: Chrome document verification requires webNavigation');
      if (approval?.id !== id || approval.workspace !== workspace || approval.expires <= Date.now()) {
        clearApproval();
        request = approval = { id, workspace, connection, url: tab.url, origin: info.origin,
          token: crypto.randomUUID(), expires: Date.now() + approvalLifetime };
        request.timer = setTimeout(() => { if (approval === request) clearApproval('expired'); }, approvalLifetime);
        request.documentId = await checkApproval(request);
        if (approval !== request) throw new Error('Tab approval was cancelled');
        void chrome.action.setBadgeText({ text: 'ASK' }).catch(() => {});
        showApproval();
      }
      request = approval;
      if (!request?.allowed) throw new Error(`Approval required: open the VABU toolbar popup, choose Allow, then retry use ${id} within 60 seconds`);
      await checkApproval(request);
    } else {
      clearApproval();
    }
    const target = { tabId: id };
    let attached = false;
    let s;
    try {
      if (request && (approval !== request || Date.now() >= request.expires)) throw new Error('Tab approval expired or was cancelled');
      // Chrome attaches by tab, not by document; revalidate before issuing any commands.
      await chrome.debugger.attach(target, '1.3');
      attached = true;
      if (bridge !== connection) throw new Error('Bridge stopped');
      if (request) await checkApproval(request);
      const userDocument = request && { id, origin: request.origin, url: request.url, documentId: request.documentId };
      if (request) clearApproval('used');
      s = session = { id, workspace, origin: info.origin, overlayKey: crypto.randomUUID(), ownedTabs,
        userDocument, windowId: tab.windowId, groupId: tab.groupId, documentId: userDocument?.documentId };
      await cdp(s, 'Page.enable');
      await checkedTab(s);
      if (!userDocument && !workspace && groups.get(tab.windowId) === s.groupId) {
        s.groupMarked = renameGroup(s.groupId, idleGroupTitle, activeGroupTitle, ownedTabs).catch(() => false);
        s.inManagedGroup = await s.groupMarked;
      }
      s.ready = true;
      // A loading tab may not have a document yet; onUpdated marks the tab when it does.
      if (userDocument) await page(s, 'show');
      else if (!s.modalOpen) await page(s, 'show').catch(() => {});
      await armDialogScope(connection, s);
      return await checkedTab(s);
    } catch (error) {
      if (request && approval === request) clearApproval();
      if (s) await detach(s);
      else if (attached) await chrome.debugger.detach(target).catch(() => {});
      throw error;
    }
  }
  if ((verb === 'release' || (scoped && verb === 'session-handoff')) && count === 0) {
    if (approval?.workspace === workspace) clearApproval();
    if (session?.workspace === workspace) await detach(session);
    return { tab: null };
  }
  if (session && session.workspace !== workspace && (scoped || !browserWideCommands.has(verb))) {
    throw new Error('Select a tab for this VABU session with use TAB_ID');
  }
  if (verb === 'frame-list' || verb === 'frame-read' || isFrameInspection(verb, args.slice(1))) {
    return runFrameCommand(connection, verb, args.slice(1), setBeforeReply);
  }
  if (verb === 'eval') return runEval(connection, args.slice(1), setBeforeReply);
  if (verb === 'console' || verb === 'js') return runDebug(connection, verb, args.slice(1), setBeforeReply);
  if (verb === 'screenshot') return runCapture(connection, args.slice(1), setBeforeReply);
  if (verb === 'get' && a === 'styles') return runStyles(connection, args.slice(2), setBeforeReply);
  if (verb === 'inspect-dialog') return runDialog(connection, args.slice(1), setBeforeReply);
  if (verb === 'title' || Object.hasOwn(adapterCommands, verb)) return runAdapter(connection, verb, args.slice(1));
  const s = session;
  if (!s) throw new Error('Select an allowed tab with vabu use TAB_ID');
  const integer = (value) => /^-?\d{1,5}$/.test(value);
  const ref = (value) => /^@r[1-9]\d{0,2}$/.test(value);
  if (verb === 'scroll' && integer(a) && (count === 1 || (count === 2 && ref(b)))) {
    return scroll(connection, s, Number(a), b);
  }
  const { active: wasActive } = await checkedTab(s);
  if (verb === 'snapshot' && count === 0) return page(s, verb);
  if (verb === 'type' && count === 1 && a.length > 0 && a.length <= 4000) {
    await page(s, verb);
    await cdp(s, 'Input.insertText', { text: a });
    return true;
  }
  if ((verb === 'move' || verb === 'click') && count === 2 && integer(a) && integer(b)
    || (verb === 'hover' || verb === 'click') && count === 1 && ref(a)) {
    const target = count === 1 ? a : Number(a);
    const y = count === 1 ? null : Number(b);
    if (verb === 'click') return click(connection, s, target, y, wasActive);
    const point = await page(s, verb, target, y, Boolean(wasActive));
    await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseMoved' });
    return point;
  }
  throw new Error('Invalid command arguments; see vabu help');
}
