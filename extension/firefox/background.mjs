import { hasHostAccess, webUrl } from '../domains.js';
import { handleFeedback, takeFeedback } from '../feedback.mjs';
import { commands as interaction } from '../interaction.mjs';
import { commands as inspection } from '../inspection.mjs';
import { commands as scoped } from '../scoped-snapshot.mjs';
import { commands as find } from '../find-click.mjs';
import { commands as wait } from '../wait.mjs';
import { commands as get } from '../get-element.mjs';

const browser = globalThis.browser;
const channel = 'vacu-selected-document';
let bridge;
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
  release();
  connection.port.disconnect();
  connection.reject(new Error(error || 'Bridge stopped'));
  void browser.action.setBadgeText({ text: error ? 'ERR' : '' }).catch(() => {});
}

function start() {
  if (bridge) return bridge.ready;
  const port = browser.runtime.connectNative('local.pi_chrome');
  const { promise: ready, resolve, reject } = Promise.withResolvers();
  const connection = bridge = { port, ready, reject, online: false, busy: false };
  port.onDisconnect.addListener(() => stop(connection, port.error?.message || 'Native host disconnected'));
  port.onMessage.addListener(async (msg) => {
    if (bridge !== connection) return;
    if (typeof msg?.startupError === 'string') return stop(connection, msg.startupError);
    if (msg?.ready === true && !connection.online) {
      connection.online = true;
      resolve();
      void browser.action.setBadgeText({ text: 'ON' }).catch(() => {});
      return;
    }
    if (!connection.online || typeof msg?.id !== 'string') return;
    if (connection.busy) return port.postMessage({ id: msg.id, error: 'Another command is running' });
    connection.busy = true;
    try {
      const value = await command(connection, msg.args);
      if (bridge === connection) port.postMessage({ id: msg.id, value });
    } catch (error) {
      if (bridge === connection) port.postMessage({ id: msg.id, error: error.message });
    } finally {
      connection.busy = false;
    }
  });
  return ready;
}

browser.runtime.onMessage.addListener((message, sender) => {
  const fromPopup = sender.url === browser.runtime.getURL('popup.html');
  if ((message.action === 'feedback-start' && fromPopup) || message.action === 'feedback-submit') {
    return handleFeedback(browser, () => bridge?.online ? bridge : undefined, message, sender)
      .catch((error) => ({ error: error.message }));
  }
  if (!fromPopup) return false;
  if (message.action === 'status') return Promise.resolve({ connected: bridge?.online === true });
  return (async () => {
    try {
      if (message.action === 'start') await start();
      else if (message.action === 'stop' && bridge) stop(bridge);
      return { ok: true };
    } catch (error) {
      return { error: error.message };
    }
  })();
});

browser.tabs.onRemoved.addListener((id) => { if (id === selected?.id) release(); });
browser.tabs.onUpdated.addListener((id, change) => {
  if (id === selected?.id && (change.status === 'loading' || (change.url && change.url !== selected.href))) release();
});
browser.permissions.onRemoved.addListener(({ origins }) => { if (origins?.length) release(); });

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

async function select(connection, id) {
  const tab = await browser.tabs.get(id);
  const url = await allowed(tab);
  if (!url || tab.status === 'loading') throw new Error('Firefox has not granted access to a loaded HTTP(S) document in this tab');
  if (bridge !== connection) throw new Error('Bridge stopped');
  release();
  const s = selected = { id, href: url.href, origin: url.origin };
  try {
    await browser.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, files: ['firefox/content.js'] });
    await current(s);
    const port = s.port = browser.tabs.connect(id, { name: channel, frameId: 0 });
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

async function command(connection, args) {
  if (!Array.isArray(args) || !args.length || !args.every((arg) => typeof arg === 'string')) throw new Error('Invalid command');
  const [verb, ...terms] = args;
  if (verb === 'feedback') return takeFeedback(connection, terms);
  if (verb === 'status' && !terms.length) {
    const { origins: domains = [] } = await browser.permissions.getAll();
    return { connected: true, tab: selected?.id ?? null, domains };
  }
  if (verb === 'tabs' && !terms.length) {
    const tabs = await browser.tabs.query({});
    return (await Promise.all(tabs.map(async (tab) => {
      const url = await allowed(tab);
      return url && info(tab, url);
    }))).filter(Boolean);
  }
  if (verb === 'open' && terms.length === 1) {
    const url = webUrl(terms[0]);
    if (!await hasHostAccess(browser.permissions, url)) throw new Error('Firefox has not granted access to this site');
    if (bridge !== connection) throw new Error('Bridge stopped');
    const tab = await browser.tabs.create({ url: url.href, active: false });
    return { tab: tab.id, origin: url.origin, group: null };
  }
  if (verb === 'use' && terms.length === 1 && /^\d{1,10}$/.test(terms[0])) return select(connection, Number(terms[0]));
  if (verb === 'release' && !terms.length) { release(); return { tab: null }; }

  const s = selected;
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
    inspectionScope: async (frameId, documentId) => {
      if (!frameId) return { assertCurrent: () => current(s), run: (...params) => page(s, 'inspect', ...params) };
      const run = (...params) => page(s, 'inspectFrame', frameId, documentId, ...params);
      return { documentId, assertCurrent: () => run('assert'), run };
    },
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
  if (verb === 'frames' && !terms.length) return page(s, 'frames');
  if (['inspect-query', 'inspect-element', 'inspect-wait', 'inspect-click'].includes(verb)) {
    if (!(verb === 'inspect-wait' && terms[0] === 'dialog')) return inspection[verb](terms, ctx);
  }
  throw new Error('Not supported by the Firefox baseline (or invalid arguments)');
}
