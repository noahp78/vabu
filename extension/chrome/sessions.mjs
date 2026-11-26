import { hasHostAccess, webUrl } from '../shared/domains.js';

// One instance per bridge generation. Never reuse this state across reconnects or worker restarts.
export function createSessionState() {
  return { tabs: new Set(), windows: new Set(), optIns: new Set(), run: null, audit: [] };
}

// Call only from trusted extension UI after a user gesture; never route this through the CLI.
export function setSessionDataOptIn(state, origin, enabled) {
  if (webUrl(origin).origin !== origin || typeof enabled !== 'boolean') throw new Error('Invalid opt-in');
  if (!enabled) state.optIns.delete(origin);
  else state.optIns.add(origin);
}

function arity(args, count) {
  if (args.length !== count) throw new Error('Invalid command arguments');
}

function id(value) {
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new Error('Invalid Chrome ID');
  return Number(value);
}

function browser(ctx) {
  const { browser: api, sessionState: state, assertBridge } = ctx;
  if (!api || !state || typeof assertBridge !== 'function') throw new Error('Browser capability is not available');
  assertBridge();
  return { api, state };
}

async function approved(tab, permissions) {
  try {
    const url = webUrl(tab.url);
    if (tab.incognito || tab.pendingUrl || !await hasHostAccess(permissions, url)) return;
    return url;
  } catch {}
}

async function current(ctx) {
  const { api } = browser(ctx);
  await ctx.assertCurrent();
  const tab = await api.tabs.get(ctx.tabId);
  const url = await approved(tab, api.permissions);
  await ctx.assertCurrent();
  ctx.assertBridge();
  if (!url || url.origin !== ctx.origin || tab.id !== ctx.tabId) throw new Error('Selected tab changed or is not approved');
  return { tab, url };
}

function record(ctx, action) {
  const { state } = browser(ctx);
  if (state.audit.length === 100) state.audit.shift();
  // Do not retain titles, URLs, free text, or tab content.
  state.audit.push({ action, at: Date.now() });
}

function navigation(direction) {
  return async (args, ctx) => {
    arity(args, 0);
    const { api } = browser(ctx);
    const { url } = await current(ctx);
    if (direction === 'reload') {
      await api.tabs.reload(ctx.tabId);
    } else {
      if (!ctx.navigation) throw new Error('Checked navigation history is unavailable');
      const { currentIndex, entries } = await ctx.navigation.history();
      const entry = entries[currentIndex + direction];
      if (!entry) throw new Error('No navigation entry in this direction');
      const target = webUrl(entry.url);
      if (target.origin !== ctx.origin) throw new Error('History destination is outside the selected origin');
      if ((await current(ctx)).url.href !== url.href) throw new Error('Selected page changed');
      // Integration must recheck document and the exact history entry before invoking Page.navigateToHistoryEntry.
      await ctx.navigation.go({ currentIndex, currentUrl: url.href, entryId: entry.id, targetUrl: target.href });
    }
    record(ctx, direction === 'reload' ? 'reload' : direction < 0 ? 'back' : 'forward');
    return { requested: true };
  };
}

async function ownedTab(ctx) {
  const { state } = browser(ctx);
  const { tab, url } = await current(ctx);
  if (!state.tabs.has(tab.id) || tab.groupId !== -1 || tab.pinned) {
    throw new Error('Requires an ungrouped, unpinned VABU-created tab');
  }
  return { tab, url };
}

async function ownedWindow(ctx, windowId) {
  const { api, state } = browser(ctx);
  if (!state.windows.has(windowId)) throw new Error('Window is not owned by VABU');
  const window = await api.windows.get(windowId, { populate: true });
  ctx.assertBridge();
  if (window.type !== 'normal' || window.incognito || !window.tabs?.length || window.tabs.some((tab) =>
    !state.tabs.has(tab.id) || tab.groupId !== -1 || tab.pinned)) {
    throw new Error('Destination is not a private ungrouped VABU window');
  }
}

function activeRun(ctx) {
  const { state } = browser(ctx);
  if (!state.run) throw new Error('Start a session first');
  return state.run;
}

function sessionTab(run, { tab, url }) {
  if (tab.id !== run.tab || url.origin !== run.origin) throw new Error('Select the original session tab and origin');
}

function scopedData(permission) {
  return async (args, ctx) => {
    arity(args, 0);
    const { api, state } = browser(ctx);
    async function check() {
      const { url } = await current(ctx);
      if (!state.optIns.has(url.origin) || !await api.permissions.contains({ permissions: [permission] })) {
        throw new Error(`Scoped ${permission} requires user opt-in and an existing Chrome permission`);
      }
      if ((await current(ctx)).url.href !== url.href || !state.optIns.has(url.origin)) throw new Error('Scope changed');
      return url.href;
    }
    const url = await check();
    if (typeof api[permission]?.[permission === 'history' ? 'getVisits' : 'search'] !== 'function') {
      throw new Error(`Chrome ${permission} is unavailable`);
    }
    // Never query all browser history/bookmarks or return raw entries.
    const entries = permission === 'history' ? await api.history.getVisits({ url }) : await api.bookmarks.search({ url });
    if (await check() !== url) throw new Error('Scope changed');
    record(ctx, permission);
    return { count: permission === 'history' ? entries.length : entries.filter((entry) => entry.url === url).length };
  };
}

// These commands can run with no selected document; the bridge must still be authenticated.
export const browserWideCommands = new Set(['session-status', 'session-result', 'session-end', 'session-audit']);

export const commands = {
  back: navigation(-1),
  forward: navigation(1),
  reload: navigation('reload'),
  async title(args, ctx) {
    arity(args, 0);
    return (await current(ctx)).tab.title ?? '';
  },
  async url(args, ctx) {
    arity(args, 0);
    return (await current(ctx)).url.href;
  },
  async 'tab-info'(args, ctx) {
    arity(args, 0);
    const { tab, url } = await current(ctx);
    return { tab: tab.id, origin: url.origin, window: tab.windowId, active: tab.active };
  },
  async 'tab-group-new'(args, ctx) {
    arity(args, 0);
    const { api } = browser(ctx);
    const { tab } = await ownedTab(ctx);
    // Only create a group for this tab. Never update, move, or join a pre-existing group.
    const group = await api.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    record(ctx, 'tab-group-new');
    return { group };
  },
  async 'tab-move-window'(args, ctx) {
    arity(args, 1);
    const windowId = id(args[0]);
    const { api } = browser(ctx);
    await ownedWindow(ctx, windowId);
    const { tab } = await ownedTab(ctx);
    if (tab.windowId === windowId) throw new Error('Tab is already in this window');
    await ownedWindow(ctx, windowId);
    const siblings = await api.tabs.query({ windowId: tab.windowId });
    if (!siblings.some((sibling) => sibling.id !== tab.id)) throw new Error('Move would close the source window');
    if ((await ownedTab(ctx)).tab.windowId !== tab.windowId) throw new Error('Source window changed');
    await api.tabs.move(tab.id, { windowId, index: -1 });
    record(ctx, 'tab-move-window');
    return { moved: true };
  },
  async 'window-new'(args, ctx) {
    arity(args, 0);
    const { api, state } = browser(ctx);
    const { url } = await current(ctx);
    // Open an origin's root, never duplicate a possibly sensitive current URL.
    const window = await api.windows.create({ url: url.origin + '/', type: 'normal', focused: false });
    ctx.assertBridge();
    if (!window || window.incognito || !Number.isInteger(window.id)) throw new Error('Chrome did not return a normal window');
    state.windows.add(window.id);
    if (window.tabs?.length === 1 && Number.isInteger(window.tabs[0].id)) state.tabs.add(window.tabs[0].id);
    record(ctx, 'window-new');
    return { window: window.id };
  },
  async 'session-start'(args, ctx) {
    arity(args, 0);
    const { state } = browser(ctx);
    if (state.run) throw new Error('End the current session first');
    const { tab, url } = await current(ctx);
    state.run = { tab: tab.id, origin: url.origin, handedOff: false, result: null };
    record(ctx, 'session-start');
    return { started: true };
  },
  async 'session-handoff'(args, ctx) {
    arity(args, 0);
    const run = activeRun(ctx);
    if (run.handedOff) throw new Error('Session is already handed off');
    if (typeof ctx.releaseSelection !== 'function') throw new Error('Selection release is unavailable');
    sessionTab(run, await current(ctx));
    await ctx.releaseSelection();
    browser(ctx);
    run.handedOff = true;
    record(ctx, 'session-handoff');
    return { handedOff: true };
  },
  async 'session-restore'(args, ctx) {
    arity(args, 0);
    const run = activeRun(ctx);
    if (!run.handedOff) throw new Error('Session was not handed off');
    // Explicit `use TAB_ID` selects the tab first; never resurrect a tab or replay navigation.
    sessionTab(run, await current(ctx));
    run.handedOff = false;
    record(ctx, 'session-restore');
    return { restored: true };
  },
  async 'session-result'(args, ctx) {
    arity(args, 1);
    const [result] = args;
    if (!['ok', 'failed', 'cancelled'].includes(result)) throw new Error('Expected ok, failed, or cancelled');
    const run = activeRun(ctx);
    run.result = result;
    record(ctx, 'session-result');
    return { result };
  },
  async 'session-status'(args, ctx) {
    arity(args, 0);
    const { state } = browser(ctx);
    const run = state.run;
    return run ? { active: true, handedOff: run.handedOff, result: run.result } : { active: false };
  },
  async 'session-end'(args, ctx) {
    arity(args, 0);
    const { state } = browser(ctx);
    const run = activeRun(ctx);
    if (!run.handedOff && ctx.tabId === run.tab && ctx.origin === run.origin) {
      if (typeof ctx.releaseSelection !== 'function') throw new Error('Selection release is unavailable');
      sessionTab(run, await current(ctx));
      await ctx.releaseSelection();
      browser(ctx);
    }
    state.run = null;
    record(ctx, 'session-end');
    return { ended: true, result: run.result };
  },
  async 'session-audit'(args, ctx) {
    arity(args, 0);
    return browser(ctx).state.audit.map((entry) => ({ ...entry }));
  },
  'history-current': scopedData('history'),
  'bookmarks-current': scopedData('bookmarks'),
};
