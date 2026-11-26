import { hasHostAccess, webUrl } from '../shared/domains.js';
import { iframeOwnersInPage, frameTextInPage } from '../shared/frame-probes.mjs';
import { inspectionPage } from '../shared/inspection.mjs';

const navigationEvents = ['onBeforeNavigate', 'onCommitted', 'onHistoryStateUpdated',
  'onReferenceFragmentUpdated', 'onErrorOccurred'];
const unavailable = () => new Error('Cannot verify the current iframe and site access; run frame-list again');

export function canReadFrames(browser) {
  const nav = browser.webNavigation;
  return typeof nav?.getFrame === 'function' && typeof nav.getAllFrames === 'function'
    && navigationEvents.every((event) => typeof nav[event]?.addListener === 'function')
    && typeof browser.scripting?.executeScript === 'function';
}

function direct(frame, parent) {
  return Number.isInteger(frame?.frameId) && frame.frameId > 0 && frame.parentFrameId === 0
    && frame.parentDocumentId === parent.documentId && frame.frameType === 'sub_frame'
    && frame.documentLifecycle === 'active' && frame.errorOccurred === false
    && typeof frame.documentId === 'string' && frame.documentId.length > 0;
}

// Metadata and full URLs stay in the worker. Only random handles and origins leave discovery.
export function createFrameScope(browser, parent, assertCurrent) {
  const frames = new Map();
  const nav = browser.webNavigation;
  const target = { tabId: parent.id };
  const guarded = async (operation) => {
    try {
      assertCurrent();
      const result = await operation();
      assertCurrent();
      return result;
    } catch {
      throw unavailable();
    }
  };
  const checkParent = async () => {
    const tab = await browser.tabs.get(parent.id);
    const frame = await nav.getFrame({ ...target, frameId: 0 });
    if (tab.incognito || tab.pendingUrl || tab.discarded || tab.status !== 'complete' || tab.url !== parent.url
      || frame?.documentId !== parent.documentId || frame.url !== parent.url || frame.errorOccurred !== false
      || frame.frameType !== 'outermost_frame' || frame.documentLifecycle !== 'active'
      || !await hasHostAccess(browser.permissions, webUrl(parent.url))) throw unavailable();
  };
  const inject = async (frame, func, ...args) => {
    assertCurrent();
    const results = await browser.scripting.executeScript({
      target: { ...target, documentIds: [frame.documentId] }, world: 'ISOLATED', func, args,
    });
    assertCurrent();
    if (results?.length !== 1 || results[0].documentId !== frame.documentId
      || results[0].frameId !== frame.frameId) throw unavailable();
    return results[0].result;
  };
  const checkOwners = async () => {
    if (await inject({ ...parent, frameId: 0 }, iframeOwnersInPage, parent.origin, parent.url) !== true) throw unavailable();
  };
  const checkChild = async (child) => {
    const frame = await nav.getFrame({ ...target, frameId: child.frameId });
    // getFrame need not return frameId. The lookup itself is by the *current* frame slot.
    if ((frame?.frameId !== undefined && frame.frameId !== child.frameId)
      || !direct({ ...frame, frameId: child.frameId }, parent) || frame.documentId !== child.documentId
      || frame.url !== child.url || !await hasHostAccess(browser.permissions, webUrl(child.url))) throw unavailable();
  };
  const verify = (child, probeChild = false) => guarded(async () => {
    await checkParent();
    await checkChild(child);
    await checkOwners();
    if (probeChild && await inject(child, frameTextInPage, child.origin, child.url, parent.origin, true) !== true) throw unavailable();
    await checkChild(child);
    await checkParent();
  });
  const key = crypto.randomUUID();
  return {
    frames,
    verifyParent: () => guarded(checkParent),
    verifyRead: (child) => verify(child, true),
    inspect: (child, operation, spec) => guarded(async () => {
      if (child.origin !== parent.origin) throw unavailable();
      await verify(child);
      const result = await inject(child, inspectionPage, parent.origin, key, operation, spec ?? null,
        { parentHref: parent.url, href: child.url });
      await verify(child);
      return result;
    }),
    discover: (sameOrigin = false) => guarded(async () => {
      await checkParent();
      await checkOwners();
      const current = await nav.getAllFrames(target);
      if (!Array.isArray(current) || current.length > 256) throw unavailable();
      for (const frame of current) {
        if (!direct(frame, parent)) continue;
        let url;
        try { url = webUrl(frame.url); } catch { continue; }
        if ((sameOrigin && url.origin !== parent.origin) || !await hasHostAccess(browser.permissions, url)) continue;
        const handle = crypto.randomUUID();
        frames.set(handle, { ...frame, origin: url.origin, handle });
      }
      await checkOwners();
      await checkParent();
      return [...frames.values()].map(({ handle, origin }) => ({ id: handle, origin }));
    }),
    read: (child) => guarded(async () => {
      await verify(child);
      const result = await inject(child, frameTextInPage, child.origin, child.url, parent.origin, false);
      if (typeof result?.text !== 'string' || result.text.length > 4000 || typeof result.truncated !== 'boolean') throw unavailable();
      await verify(child, true);
      return { text: result.text, truncated: result.truncated };
    }),
  };
}
