import { hasHostAccess, webUrl } from './domains.js';
import { commands as interaction, interactionInPage } from './interaction.mjs';
import { commands as inspection, inspectionPage } from './inspection.mjs';
import { commands as integrations, inPageIntegration } from './integrations.mjs';
import { commands as sessions, browserWideCommands, createSessionState } from './sessions.mjs';

import { commands as elementCommands, getElementInPage } from './get-element.mjs';
import { commands as waitCommands, waitTextInPage } from './wait.mjs';
import { commands as scopedCommands, scopedSnapshotInPage } from './scoped-snapshot.mjs';
import { commands as findCommands } from './find-click.mjs';
import { changedRatio, clampClip, frameFingerprint, maxImageBase64, screenshotInPage, screenshotRequest } from './screenshot.mjs';

const adapterCommands = { __proto__: null, ...interaction, ...inspection, ...integrations, ...elementCommands, ...waitCommands, ...scopedCommands, ...findCommands };
for (const verb of ['url', 'tab-info', 'session-start', 'session-handoff', 'session-restore', ...browserWideCommands]) {
  adapterCommands[verb] = sessions[verb];
}
const integrationOperations = new Set(['integration-inspect', 'integration-assets', 'integration-export-available']);

let bridge;
const bridgeStorage = chrome.storage?.session;
let bridgeTransition = Promise.resolve();
let bridgeIntent = 0;
let session;
let detaching = Promise.resolve();
const idleGroupTitle = 'VACU';
const activeGroupTitle = 'VACU actief';
const approvalLifetime = 60_000;
const popupUrl = chrome.runtime.getURL('popup.html');
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
  if (bridge) void chrome.action.setBadgeText({ text: 'ON' }).catch(() => {});
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
  clearApproval();
  detaching = (async () => {
    if (s.documentId) await page(s, 'clear').catch(() => {});
    await chrome.debugger.detach({ tabId: s.id }).catch(() => {});
    if (await s.groupMarked) await renameGroup(s.groupId, activeGroupTitle, idleGroupTitle, s.ownedTabs).catch(() => {});
  })();
  return detaching;
}

async function stopBridge(connection, error) {
  if (bridge !== connection) return;
  bridge = undefined;
  clearApproval();
  connection.port.disconnect();
  connection.reject(new Error(error || 'Bridge stopped'));
  await detach(session);
  if (!bridge) await chrome.action.setBadgeText({ text: error ? 'ERR' : '' });
}

function startBridge() {
  if (bridge) return bridge.ready;
  const port = chrome.runtime.connectNative('local.pi_chrome');
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  const connection = bridge = { port, ready, reject, busy: false, sessionState: createSessionState(), workspaces: new Map(), groups: new Map(), ownedTabs: new Set() };
  port.onDisconnect.addListener(() => {
    void stopBridge(connection, chrome.runtime.lastError?.message || 'Native host disconnected');
  });
  port.onMessage.addListener(async (msg) => {
    if (bridge !== connection) return;
    if (typeof msg?.startupError === 'string') {
      await stopBridge(connection, msg.startupError);
      return;
    }
    if (msg?.ready === true) {
      resolve();
      await chrome.action.setBadgeText({ text: approval?.documentId ? 'ASK' : 'ON' });
      return;
    }
    if (typeof msg?.id !== 'string') return;
    if (connection.busy) {
      port.postMessage({ id: msg.id, error: 'Another command is running' });
      return;
    }
    connection.busy = true;
    let response;
    try {
      response = { value: await command(connection, msg.args) };
    } catch (error) {
      response = { error: error.message };
    } finally {
      connection.busy = false;
    }
    if (bridge === connection) port.postMessage({ id: msg.id, ...response });
  });
  return ready;
}

async function changeBridge(action) {
  if (!bridgeStorage) {
    if (action === 'start') return startBridge();
    if (action === 'stop' && bridge) return stopBridge(bridge);
    return;
  }

  const intent = action === 'auto' ? bridgeIntent : ++bridgeIntent;
  // Serialize policy writes, not the native handshake: Stop must be able to cancel it.
  const transition = bridgeTransition.then(async () => {
    if (action === 'stop') {
      try {
        if (bridge) await stopBridge(bridge);
      } finally {
        await bridgeStorage.set({ bridgeMode: 'stopped' });
      }
      return;
    }
    if (action === 'auto' && (bridge || (await bridgeStorage.get('bridgeMode')).bridgeMode !== undefined)) return;
    if (intent !== bridgeIntent) throw new Error('Bridge request superseded');
    await bridgeStorage.set({ bridgeMode: 'attempted' });
    if (intent !== bridgeIntent) throw new Error('Bridge request superseded');
    const ready = startBridge();
    if (action === 'auto') void ready.catch(() => {});
    else return { ready };
  });
  bridgeTransition = transition.catch(() => {});
  return (await transition)?.ready;
}

function tryAutoStart() {
  return changeBridge('auto').catch(() => {});
}

chrome.runtime.onStartup?.addListener(tryAutoStart);
chrome.runtime.onInstalled?.addListener(tryAutoStart);
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.url !== popupUrl) return false;
  if (message.action === 'status') {
    if (!bridgeStorage) {
      reply({ connected: Boolean(bridge) });
      return false;
    }
    void tryAutoStart().then(() => reply({ connected: Boolean(bridge) }));
  } else if (message.action === 'start' || message.action === 'stop') {
    changeBridge(message.action).then(() => reply({ ok: true }), (error) => reply({ error: error.message }));
  } else {
    reply({ ok: true });
    return false;
  }
  return true;
});

chrome.permissions.onRemoved.addListener(({ origins, permissions }) => {
  if (origins?.length || permissions?.some((permission) => ['webNavigation', 'debugger', 'scripting'].includes(permission))) {
    clearApproval();
    if (session) void detach(session);
  }
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (approval?.id === tabId) clearApproval();
  if (session?.id === tabId) void detach(session);
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  const s = session;
  if (!s || s.id !== tabId || method !== 'Page.frameNavigated' || params.frame.parentId) return;
  try {
    if (!s.userDocument && webUrl(params.frame.url).origin === s.origin) return;
  } catch {}
  void detach(s);
});

function forgetTab(tabId) {
  if (approval?.id === tabId) clearApproval();
  bridge?.ownedTabs.delete(tabId);
  for (const workspace of bridge?.workspaces.values() ?? []) workspace.tabs.delete(tabId);
  if (session?.id === tabId) void detach(session);
}

chrome.tabs.onRemoved.addListener(forgetTab);
chrome.tabs.onReplaced?.addListener((_added, removed) => forgetTab(removed));

function invalidateDocument({ tabId, frameId = 0 }) {
  if (frameId !== 0) return;
  if (approval?.id === tabId) clearApproval();
  if (session?.id === tabId && session.userDocument) void detach(session);
}

navigation?.onBeforeNavigate?.addListener(invalidateDocument);
navigation?.onCommitted?.addListener(invalidateDocument);
navigation?.onHistoryStateUpdated?.addListener(invalidateDocument);
navigation?.onReferenceFragmentUpdated?.addListener(invalidateDocument);
chrome.tabs.onUpdated.addListener((tabId, { status, url, discarded }) => {
  if (status === 'loading' || url !== undefined || discarded) invalidateDocument({ tabId });
  const s = session;
  if (status === 'complete' && s?.ready && !s.userDocument && s.id === tabId) void page(s, 'show').catch(() => {});
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
    if (operation === 'confirmClick') target.documentIds = [args.shift()];
    if (operation === 'findClick') target.documentIds = [args.pop()];
    if (s.userDocument) {
      await checkedTab(s);
      target.documentIds = [s.userDocument.documentId];
    }
    if (session !== s) throw new Error('Tab is no longer authorized');
  }
  const [injection] = await chrome.scripting.executeScript({
    target, func: inPage, args: [s.origin, s.overlayKey, !s.inManagedGroup, operation, ...args],
  });
  if (operation !== 'clear') {
    if (session !== s) {
      if (injection?.documentId) {
        await page({ ...s, documentId: injection.documentId }, 'clear').catch(() => {});
      }
      throw new Error('Tab is no longer authorized');
    }
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
    if (globalThis.piChrome?.key === key) globalThis.piChrome.clear();
    return ok(true);
  }

  const style = (element, properties) => {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
  };
  if (globalThis.piChrome?.key !== key || !globalThis.piChrome.host.isConnected) {
    globalThis.piChrome?.clear();
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
      document.title = originalTitle ? '🟣 VACU actief · ' + originalTitle : '🟣 VACU actief';
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
      delete globalThis.piChrome;
    };
    addEventListener('pagehide', clear, { once: true });
    globalThis.piChrome = { key, host, cursor, title, clear };
  }
  const state = globalThis.piChrome;
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
  if (operation === 'confirmClick') {
    const preview = state.preview;
    const find = preview?.find;
    if (find?.ticket !== (arg ?? undefined) || (find && state.find !== find)) return fail('Find target expired');
    delete state.preview;
    if (find) delete state.find;
    if ((!y && document.hidden) || !preview || document.elementFromPoint(preview.x, preview.y) !== preview.hit
      || preview.hit.closest('a[href]')?.href !== preview.href || preview.hit.closest(':disabled')
      || (preview.binding && ((!find && state.targets !== preview.targets)
        || !preview.binding.valid(preview.proxy ? preview.hit : undefined)))) {
      return fail('Click target changed during preview; take a new snapshot');
    }
    const verified = find?.verify();
    if (verified && !verified.ok) return verified;
    if (y) {
      const { hit, x, y: clientY } = preview;
      const control = hit.closest('label')?.control ?? hit.closest('input,button');
      if (hit.closest('iframe,frame,embed,object,fencedframe,portal,[inert],input[type=file],input[type=password]')
        || control?.matches(':disabled,input[type=file],input[type=password]')) {
        return fail('This control cannot be clicked in the background');
      }
      const anchor = hit.closest('a,area');
      if (anchor && anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        return fail('SVG links require a foreground click; select the tab manually');
      }
      const link = anchor?.hasAttribute('href') ? anchor : null;
      const form = ['submit', 'image'].includes(control?.type) ? control.form : null;
      const baseTarget = document.querySelector('base[target]')?.getAttribute('target');
      const sameTab = (target) => ['', '_self'].includes((target || baseTarget || '').toLowerCase());
      const destination = link?.href ?? (form && (control.getAttribute('formaction') === null ? form.action : control.formAction));
      if ((link && (link.hasAttribute('download') || !sameTab(link.getAttribute('target'))))
        || (form && !sameTab(control.getAttribute('formtarget') ?? form.getAttribute('target')))
        || ((link || form) && !/^https?:/i.test(destination))) {
        return fail('This link or form requires a foreground click; select the tab manually');
      }
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY, view: window, detail: 1 }));
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
      || (field?.localName === 'input' && ['text', 'search', 'url', 'email', 'tel', 'number'].includes(field.type))) {
      return ok(true);
    }
    return fail('Click a text field first; password, file and other non-text fields are not supported');
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

async function click(s, target, y, wasActive, expectedDocument, findTicket) {
  if (!wasActive) expectedDocument ??= s.documentId;
  if (!wasActive && !expectedDocument) throw new Error('Selected document is not ready');
  if (expectedDocument && s.documentId !== expectedDocument) throw new Error('Click cancelled: selected document changed');
  const point = findTicket
    ? await page(s, 'findClick', target, y, Boolean(wasActive), findTicket, expectedDocument)
    : await page(s, 'click', target, y, Boolean(wasActive), ...(expectedDocument ? [expectedDocument] : []));
  const documentId = s.documentId;
  if (expectedDocument && documentId !== expectedDocument) throw new Error('Click cancelled: selected document changed');
  if (!wasActive) {
    await checkedTab(s);
    if (s.documentId !== documentId) throw new Error('Click cancelled: selected document changed');
    await page(s, 'confirmClick', documentId, findTicket ?? null, true);
    return { ...point, dispatched: true, trusted: false };
  }
  await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseMoved' });
  if (!documentId || !await waitForCursor(s) || !(await checkedTab(s)).active) {
    throw new Error('Click cancelled: selected tab is not visible');
  }
  if (s.documentId !== documentId) throw new Error('Click cancelled: selected document changed');
  await page(s, 'confirmClick', documentId, ...(findTicket ? [findTicket] : []));
  await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 });
  await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', clickCount: 1 });
  return { ...point, dispatched: true };
}

// Last image per tab and capture mode, kept only in memory, for --if-changed.
const lastCaptures = new Map();
chrome.tabs.onRemoved.addListener((tabId) => lastCaptures.delete(tabId));

async function decodeImage(data) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function guardedFrames(s) {
  if (!navigation?.getAllFrames) throw new Error('Screenshots require Chrome webNavigation');
  return frameFingerprint(await navigation.getAllFrames({ tabId: s.id }),
    (url) => hasHostAccess(chrome.permissions, url));
}

async function screenshotPage(s, documentId, operation, payload) {
  if (session !== s || s.documentId !== documentId) throw new Error('Selected document changed; screenshot cancelled');
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: s.id, documentIds: [documentId] }, world: 'ISOLATED',
    func: screenshotInPage, args: [s.origin, s.overlayKey, operation, payload ?? null],
  });
  if (injection?.documentId !== documentId) throw new Error('Selected document changed; screenshot cancelled');
  if (!injection.result?.ok) throw new Error(injection.result?.error || 'Page is not available');
  return injection.result.value;
}

async function screenshot(s, args) {
  if (args.length !== 1) throw new Error('Usage: vacu screenshot [SELECTOR] [PATH] [--full] [--annotate] ...');
  const request = screenshotRequest(args[0]);
  let annotations;
  if (request.annotate) {
    const { controls } = await page(s, 'snapshot');
    annotations = controls.map(({ ref, role, name }, i) => ({ label: i + 1, ref, role, name }));
  } else {
    await page(s, 'show');
  }
  const documentId = s.documentId;
  if (!documentId) throw new Error('Selected document is not ready');
  const prepared = await screenshotPage(s, documentId, 'prepare', { target: request.target, annotate: request.annotate });
  let data;
  let clipped = false;
  try {
    const before = await guardedFrames(s);
    let clip = prepared.clip;
    if (request.full) {
      const { cssContentSize, contentSize } = await cdp(s, 'Page.getLayoutMetrics');
      const { width, height } = cssContentSize ?? contentSize;
      clip = { x: 0, y: 0, width, height };
    }
    const params = { format: request.format };
    if (request.quality !== null) params.quality = request.quality;
    if (clip) {
      ({ clip, clipped } = clampClip(clip));
      Object.assign(params, { clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
    }
    // Chrome can occasionally never answer; don't keep the bridge busy forever.
    let timer;
    ({ data } = await Promise.race([
      cdp(s, 'Page.captureScreenshot', params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome did not return a screenshot; try again')), 12_000); }),
    ]).finally(() => clearTimeout(timer)));
    // Discard the image if any frame document appeared, navigated or lost access while capturing.
    if (await guardedFrames(s) !== before) throw new Error('Frames changed during capture; screenshot discarded, try again');
    await checkedTab(s);
    if (session !== s || s.documentId !== documentId) throw new Error('Selected document changed; screenshot discarded');
  } finally {
    await screenshotPage(s, documentId, 'restore').catch(() => {});
  }
  if (typeof data !== 'string' || !data || data.length > maxImageBase64) {
    throw new Error('Screenshot is too large; capture a selector or use --screenshot-format jpeg');
  }
  const result = { format: request.format, ...(clipped ? { clipped } : {}), ...(annotations ? { annotations } : {}) };
  if (request.ifChanged) {
    const key = JSON.stringify([s.origin, request.target, request.full, request.annotate, request.format, request.quality]);
    const previous = lastCaptures.get(s.id);
    const ratio = previous?.key !== key ? 1 : previous.data === data ? 0
      : changedRatio(await decodeImage(previous.data), await decodeImage(data));
    result.changedRatio = ratio;
    if (previous?.key === key && ratio <= request.threshold) return { ...result, unchanged: true };
    lastCaptures.set(s.id, { key, data });
  }
  return { ...result, data };
}

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
      target: { tabId: s.id, documentIds: [documentId] }, func, args: [s.origin, ...params],
    });
    await assertCurrent();
    if (result?.documentId !== documentId) throw new Error('Selected document changed');
    return result.result;
  };
  const unwrap = (result) => {
    if (result?.ok !== true) throw new Error(result?.error || 'Page operation failed');
    return result.value;
  };
  const frameIndex = async () => {
    await assertCurrent();
    if (!navigation?.getAllFrames) throw new Error('Frame inspection requires Chrome webNavigation');
    const entries = await navigation.getAllFrames({ tabId: s.id });
    await assertCurrent();
    return new Map((entries ?? []).map(frame => [frame.frameId, frame]));
  };
  const frameChain = (index, frameId) => {
    const chain = [];
    try {
      for (let entry = index.get(frameId); entry && chain.length < 20; entry = index.get(entry.parentFrameId)) {
        if (!entry.documentId || entry.errorOccurred || entry.documentLifecycle !== 'active') return;
        const { origin, href } = webUrl(entry.url);
        chain.push({ frameId: entry.frameId, documentId: entry.documentId, origin, href });
        if (entry.frameId === 0) {
          if (entry.frameType === 'outermost_frame' && entry.documentId === documentId && origin === s.origin) return chain;
          return;
        }
        if (entry.frameType !== 'sub_frame' || index.get(entry.parentFrameId)?.documentId !== entry.parentDocumentId) return;
      }
    } catch {}
  };
  const injectFrame = async (chain, operation, payload) => {
    const [entry, ...ancestors] = chain;
    if (!await hasHostAccess(chrome.permissions, webUrl(entry.href))) throw new Error('Frame host access is not granted');
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: s.id, documentIds: [entry.documentId] }, world: 'ISOLATED', func: inspectionPage,
        args: [entry.origin, s.overlayKey, operation, payload ?? null, ancestors.map(node => node.origin), entry.href],
      });
    } catch {
      throw new Error('Chrome could not access the authorized frame document');
    }
    const [result] = results;
    if (results.length !== 1 || result.documentId !== entry.documentId || result.frameId !== entry.frameId) {
      throw new Error('Frame changed; run frames again');
    }
    return unwrap(result.result);
  };
  const verifyChain = async (chain, probes = new Map()) => {
    for (let i = chain.length - 1; i >= 0; i--) {
      const { documentId: id } = chain[i];
      if (!probes.has(id)) probes.set(id, injectFrame(chain.slice(i), 'scope'));
      if (await probes.get(id) !== true) throw new Error('Frame ancestry could not be verified');
    }
  };
  const assertChain = async (chain) => {
    const current = frameChain(await frameIndex(), chain[0].frameId);
    if (!current || JSON.stringify(current) !== JSON.stringify(chain)) throw new Error('Frame changed; run frames again');
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
    inspectionScope: async (frameId, expectedDocument) => {
      if (frameId !== 0) {
        const chain = frameChain(await frameIndex(), frameId);
        if (!chain || chain[0].documentId !== expectedDocument) throw new Error('Frame is stale or unavailable; run frames again');
        return { documentId: chain[0].documentId, assertCurrent: () => assertChain(chain),
          run: async (operation, payload) => {
            // CDP hit testing cannot pin synthetic dispatch to the verified ref and layout.
            if (operation === 'click' && chain.some(node => node.origin !== s.origin)) {
              throw new Error('Cross-origin frame clicks require safe ancestor hit testing, which Chrome cannot verify');
            }
            await verifyChain(chain);
            await assertChain(chain);
            const result = await injectFrame(chain, operation, payload);
            await verifyChain(chain);
            await assertChain(chain);
            return result;
          },
        };
      }
      await assertCurrent();
      return { documentId, assertCurrent,
        run: async (operation, value) => unwrap(await inject(inspectionPage, s.overlayKey, operation, value)),
      };
    },
    integrationLayoutMetrics: async () => { await assertCurrent(); return cdp(s, 'Page.getLayoutMetrics'); },
    getElement: async (property, ref) => unwrap(await inject(getElementInPage, s.overlayKey, property, ref)),
    findControl: async (criteria) => unwrap(await inject(scopedSnapshotInPage, s.overlayKey, 'uniqueControl', criteria, null, findTicket)),
    clickRef: async (ref) => {
      await assertCurrent();
      const { active } = await checkedTab(s);
      await assertCurrent();
      return click(s, ref, null, active, documentId, findTicket);
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
  if (verb === 'frames') {
    if (args.length) throw new Error('Usage: frames');
    const index = await frameIndex();
    const probes = new Map();
    const frames = [];
    for (const frameId of index.keys()) {
      if (frameId === 0) continue;
      const chain = frameChain(index, frameId);
      if (!chain) continue;
      try {
        await verifyChain(chain, probes);
        frames.push(chain);
      } catch {}
    }
    const current = await frameIndex();
    return frames.flatMap(chain => {
      const { frameId, documentId } = chain[0];
      return JSON.stringify(frameChain(current, frameId)) === JSON.stringify(chain) ? [{ frameId, documentId }] : [];
    });
  }
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

async function command(connection, args) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Invalid command');
  if (bridge !== connection) throw new Error('Bridge stopped');
  const [scope, id] = args;
  const workspaces = connection.workspaces;
  const scoped = scope === '--session';
  const workspace = scoped ? workspaces.get(id) : undefined;
  if (scoped && !workspace) throw new Error('Unknown VACU session ID');
  if (scoped) args = args.slice(2);
  const [verb, a, b] = args;
  const count = args.length - 1;
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
  if (verb === 'open' && count === 1) {
    const url = webUrl(a);
    if (!await hasHostAccess(chrome.permissions, url)) throw new Error('Chrome has not granted access to this site');
    if (bridge !== connection) throw new Error('Bridge stopped');
    const tab = await chrome.tabs.create({ url: url.href, active: false });
    if (bridge !== connection) throw new Error('Bridge stopped');
    connection.ownedTabs.add(tab.id);
    workspace?.tabs.add(tab.id);
    const group = await groupNewTab(tab, workspace, connection).catch((error) => {
      if (workspace) throw new Error(`Tab ${tab.id} opened, but grouping failed: ${error.message}`);
      return null;
    });
    return { tab: tab.id, origin: url.origin, group };
  }
  if (verb === 'use' && count === 1 && /^\d{1,10}$/.test(a)) {
    const id = Number(a);
    if (workspace ? !workspace.tabs.has(id) : [...workspaces.values()].some(({ tabs }) => tabs.has(id))) {
      throw new Error('Tab does not belong to this VACU session');
    }
    const tab = await chrome.tabs.get(id);
    const info = await tabInfo(tab);
    if (!info) throw new Error('Chrome has not granted access to this tab');
    if (session?.ready && session.id === id && session.workspace === workspace) return checkedTab(session);
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
      if (!request?.allowed) throw new Error(`Approval required: open the VACU toolbar popup, choose Allow, then retry use ${id} within 60 seconds`);
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
        userDocument, groupId: tab.groupId, documentId: userDocument?.documentId };
      await cdp(s, 'Page.enable');
      await checkedTab(s);
      if (!userDocument && !workspace && groups.get(tab.windowId) === s.groupId) {
        s.groupMarked = renameGroup(s.groupId, idleGroupTitle, activeGroupTitle, ownedTabs).catch(() => false);
        s.inManagedGroup = await s.groupMarked;
      }
      s.ready = true;
      // A loading tab may not have a document yet; onUpdated marks the tab when it does.
      if (userDocument) await page(s, 'show');
      else await page(s, 'show').catch(() => {});
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
    throw new Error('Select a tab for this VACU session with use TAB_ID');
  }
  if (verb === 'title' || verb === 'frames' || Object.hasOwn(adapterCommands, verb)) return runAdapter(connection, verb, args.slice(1));
  const s = session;
  if (!s) throw new Error('Select an allowed tab with vacu use TAB_ID');
  const { active: wasActive } = await checkedTab(s);
  if (verb === 'snapshot' && count === 0) return page(s, verb);
  if (verb === 'screenshot') return screenshot(s, args.slice(1));
  if (verb === 'type' && count === 1 && a.length > 0 && a.length <= 4000) {
    await page(s, verb);
    await cdp(s, 'Input.insertText', { text: a });
    return true;
  }
  const integer = (value) => /^-?\d{1,5}$/.test(value);
  const ref = (value) => /^@r[1-9]\d{0,2}$/.test(value);
  if (verb === 'scroll' && integer(a) && (count === 1 || (count === 2 && ref(b)))) {
    const point = await page(s, verb, b ?? null);
    await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseMoved' });
    await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseWheel', deltaX: 0, deltaY: Number(a) });
    return true;
  }
  if ((verb === 'move' || verb === 'click') && count === 2 && integer(a) && integer(b)
    || (verb === 'hover' || verb === 'click') && count === 1 && ref(a)) {
    const target = count === 1 ? a : Number(a);
    const y = count === 1 ? null : Number(b);
    if (verb === 'click') return click(s, target, y, wasActive);
    const point = await page(s, verb, target, y, Boolean(wasActive));
    await cdp(s, 'Input.dispatchMouseEvent', { ...point, type: 'mouseMoved' });
    return point;
  }
  throw new Error('Invalid command arguments; see vacu help');
}
