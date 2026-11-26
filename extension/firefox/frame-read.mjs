import { hasHostAccess, webUrl } from '../shared/domains.js';
import { iframeOwnersInPage, frameTextInPage } from '../shared/frame-probes.mjs';
import { inspectionPage } from '../shared/inspection.mjs';

export const navigationEvents = ['onBeforeNavigate', 'onCommitted', 'onHistoryStateUpdated',
  'onReferenceFragmentUpdated', 'onErrorOccurred'];
export const hasFrameApis = (browser) => typeof browser.webNavigation?.getFrame === 'function'
  && typeof browser.webNavigation.getAllFrames === 'function'
  && navigationEvents.every((name) => typeof browser.webNavigation[name]?.addListener === 'function');
export const hasDocumentId = (value) => typeof value === 'string' && value.length > 0;
export const unavailable = () => new Error('Cannot verify the current Firefox iframe and site access; run frame-list again');

export async function injectDocument(browser, tabId, { documentId, frameId }, script) {
  const results = await browser.scripting.executeScript({
    target: { tabId, documentIds: [documentId] }, world: 'ISOLATED', ...script,
  });
  if (results?.length !== 1 || results[0].documentId !== documentId || results[0].frameId !== frameId
    || results[0].error !== undefined) throw unavailable();
  return results[0].result;
}

export function createFirefoxFrameScope(browser, parent, assertCurrent) {
  const frames = new Map();
  const { id: tabId, href, origin } = parent;
  const top = { documentId: parent.documentId, frameId: 0 };
  const frameAt = (frameId) => browser.webNavigation.getFrame({ tabId, frameId });
  const direct = (frame) => frame?.tabId === tabId && Number.isSafeInteger(frame.frameId) && frame.frameId > 0
    && frame.parentFrameId === 0 && frame.parentDocumentId === top.documentId && frame.errorOccurred !== true
    && hasDocumentId(frame.documentId) && frame.documentId !== top.documentId;
  const inject = async (frame, func, ...args) => {
    assertCurrent();
    const value = await injectDocument(browser, tabId, frame, { func, args });
    assertCurrent();
    return value;
  };
  const checkParent = async () => {
    assertCurrent();
    const tab = await browser.tabs.get(tabId);
    const frame = await frameAt(0);
    if (tab.id !== tabId || tab.incognito || tab.discarded || tab.pendingUrl || tab.status !== 'complete' || tab.url !== href
      || frame?.tabId !== tabId || frame.frameId !== 0 || frame.parentFrameId !== -1 || frame.documentId !== top.documentId
      || frame.url !== href || frame.errorOccurred === true || !await hasHostAccess(browser.permissions, webUrl(href))) throw unavailable();
    assertCurrent();
  };
  const checkOwners = async () => {
    if (await inject(top, iframeOwnersInPage, origin, href) !== true) throw unavailable();
  };
  const checkChild = async (child) => {
    const frame = await frameAt(child.frameId);
    if (!direct(frame) || frame.documentId !== child.documentId || frame.frameId !== child.frameId || frame.url !== child.url
      || !await hasHostAccess(browser.permissions, webUrl(child.url))) throw unavailable();
    assertCurrent();
  };
  const text = (child, probe) => inject(child, frameTextInPage, child.origin, child.url, origin, probe);
  const verify = async (child) => {
    await checkParent();
    await checkOwners();
    await checkChild(child);
    if (await text(child, true) !== true) throw unavailable();
    await checkChild(child);
    await checkParent();
  };
  const key = crypto.randomUUID();
  return {
    frames,
    verifyParent: checkParent,
    async inspect(child, operation, spec) {
      if (child.origin !== origin) throw unavailable();
      await verify(child);
      const result = await inject(child, inspectionPage, origin, key, operation, spec ?? null,
        { parentHref: href, href: child.url });
      await verify(child);
      return result;
    },
    async discover(sameOrigin = false) {
      await checkParent();
      await checkOwners();
      const current = await browser.webNavigation.getAllFrames({ tabId });
      if (!Array.isArray(current) || current.length > 256) throw unavailable();
      for (const frame of current) {
        if (!direct(frame)) continue;
        let url;
        try { url = webUrl(frame.url); } catch { continue; }
        if ((sameOrigin && url.origin !== origin) || !await hasHostAccess(browser.permissions, url)) continue;
        const child = { ...frame, origin: url.origin };
        // Sandboxed/opaque, non-HTML and restricted documents cannot pass this probe.
        try {
          await checkChild(child);
          if (await text(child, true) !== true) continue;
          await checkChild(child);
        } catch {
          assertCurrent();
          continue;
        }
        frames.set(crypto.randomUUID(), child);
      }
      await checkOwners();
      await checkParent();
      return [...frames].map(([id, child]) => ({ id, origin: child.origin }));
    },
    async read(child) {
      await verify(child);
      const result = await text(child, false);
      if (typeof result?.text !== 'string' || result.text.length > 4000 || typeof result.truncated !== 'boolean') throw unavailable();
      await verify(child);
      return { text: result.text, truncated: result.truncated };
    },
  };
}
