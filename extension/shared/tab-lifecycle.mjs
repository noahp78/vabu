import { hasHostAccess, webUrl } from './domains.js';

function normalWindow(window) {
  return window?.type === 'normal' && !window.incognito && Number.isInteger(window.id);
}

export function forgetWorkspaceWindow(connection, id) {
  if (!connection) return;
  for (const owner of [connection, ...connection.workspaces.values()]) {
    if (owner.windowId === id) delete owner.windowId;
    owner.groups.delete(id);
  }
}

// One live selection per worker. Events invalidate an existing scope permanently,
// including when a group change is undone before an outstanding read returns.
export function watchManagedGroup(api) {
  let active;
  function clear() {
    if (active) active.invalid = true;
    active = undefined;
  }
  function tabChanged(id, groupId) {
    if (!active) return;
    if (groupId === active.groupId || active.members.has(id)) clear();
    // Other tabs matter only if an outstanding query returns them as owned members.
    else if (active.reads.size && active.ownsTab(id)) for (const changes of active.reads) changes.add(id);
  }
  api.tabs.onUpdated?.addListener((id, change) => {
    if (Object.hasOwn(change, 'groupId')) tabChanged(id, change.groupId);
  });
  api.tabs.onCreated?.addListener(tab => tabChanged(tab.id, tab.groupId));
  api.tabs.onRemoved?.addListener(id => tabChanged(id));
  api.tabs.onReplaced?.addListener((added, removed) => { tabChanged(added); tabChanged(removed); });
  api.tabs.onMoved?.addListener(id => tabChanged(id));
  api.tabs.onDetached?.addListener(id => tabChanged(id));
  api.tabs.onAttached?.addListener((id, { newWindowId }) => {
    // The attach event does not identify the destination group.
    if (active?.windowId === newWindowId) clear();
    else tabChanged(id);
  });
  const groupChanged = ({ id }) => { if (active?.groupId === id) clear(); };
  api.tabGroups?.onMoved?.addListener(groupChanged);
  api.tabGroups?.onRemoved?.addListener(groupChanged);
  api.tabGroups?.onUpdated?.addListener(({ id, windowId }) => {
    if (active?.groupId === id && Number.isInteger(windowId) && windowId !== active.windowId) clear();
  });
  api.windows?.onRemoved?.addListener(id => { if (active?.windowId === id) clear(); });

  function pin(owner, selection, ownsTab) {
    if (active?.selection === selection && active.owner === owner) return active.scope;
    clear();
    const { id, windowId, groupId } = selection;
    const entry = active = { selection, owner, windowId, groupId, ownsTab, members: new Set([id]), reads: new Set() };
    const unavailable = () => new Error('Select a tab still in a VABU-managed group in this workspace');
    const assertCurrent = () => {
      if (entry.invalid || typeof api.tabs.group !== 'function' || typeof api.tabs.query !== 'function'
        || typeof api.tabGroups?.get !== 'function' || !Number.isInteger(windowId) || !Number.isInteger(groupId) || groupId < 0
        || owner.groups.get(windowId) !== groupId) throw unavailable();
      for (const member of entry.members) if (!ownsTab(member)) throw unavailable();
    };
    const inGroup = tab => tab?.windowId === windowId && tab.groupId === groupId && !tab.incognito;
    const verify = async () => {
      assertCurrent();
      const changes = new Set();
      entry.reads.add(changes);
      try {
        const tab = await api.tabs.get(id).catch(() => null);
        if (tab?.id !== id || !inGroup(tab)) throw unavailable();
        assertCurrent();
        const group = await api.tabGroups.get(groupId).catch(() => null);
        if (group?.id !== groupId || group.windowId !== windowId) throw unavailable();
        assertCurrent();
        const members = await api.tabs.query({ groupId }).catch(() => null);
        assertCurrent();
        if (!members?.some(member => member.id === id)
          || !members.every(member => inGroup(member) && ownsTab(member.id) && !changes.has(member.id))) throw unavailable();
        entry.members = new Set(members.map(member => member.id));
      } catch (error) {
        if (active === entry) clear();
        throw error;
      } finally {
        entry.reads.delete(changes);
      }
    };
    return entry.scope = { assertCurrent, verify };
  }
  return { pin, clear };
}

export async function openBackgroundTab(api, owner, url, assertBridge, browserName) {
  const first = owner.windowId === undefined;
  if (first) {
    const window = await api.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    assertBridge();
    if (!normalWindow(window)) {
      throw new Error(`Open a normal ${browserName} window before opening a VABU background tab`);
    }
    owner.windowId = window.id;
  }
  const windowId = owner.windowId;
  try {
    // Window IDs are stable for a browser session; onRemoved clears this anchor.
    assertBridge();
    const tab = await api.tabs.create({ windowId, url: url.href, active: false });
    assertBridge();
    if (owner.windowId !== windowId || tab.windowId !== windowId) throw new Error('VABU work window changed');
    return tab;
  } catch (error) {
    if (first && owner.windowId === windowId) delete owner.windowId;
    throw error;
  }
}

export async function manageOwnedTab(api, verb, args, owns, assertBridge, releaseTarget = async () => {}) {
  const navigating = verb === 'tab-navigate';
  const showing = verb === 'tab-show';
  const required = navigating ? 2 : 1;
  const waitLoad = !showing && args.length === required + 1 && args.at(-1) === '--wait-load';
  if (args.length !== required + Number(waitLoad) || !/^[1-9]\d{0,9}$/.test(args[0])) {
    throw new Error(`Usage: ${verb} TAB_ID${navigating ? ' URL' : ''}${showing ? '' : ' [--wait-load]'}`);
  }
  const destination = navigating ? webUrl(args[1]) : null;
  const id = Number(args[0]);
  // Showing a tab does not use its document. Accept an approved pending URL,
  // and allow it to become the committed URL without invalidating the request.
  const href = (tab) => showing && tab.pendingUrl ? tab.pendingUrl : tab.url;
  function assertOwned() {
    assertBridge();
    if (!owns(id)) throw new Error('Tab is not owned by this VABU session');
  }
  async function read(original) {
    assertOwned();
    const tab = await api.tabs.get(id);
    assertOwned();
    if (tab?.id !== id || tab.incognito || (!showing && (tab.pendingUrl || tab.discarded))
      || (original && (tab.windowId !== original.windowId || href(tab) !== href(original)))) {
      throw new Error('VABU tab is not available or changed');
    }
    return tab;
  }
  async function approved(original) {
    const tab = await read(original);
    if (!await hasHostAccess(api.permissions, webUrl(href(tab)))) throw new Error('Browser has not granted access to this tab');
    return read(tab);
  }
  function requireStillLoaded(tab) {
    if (waitLoad && tab.status !== 'complete') throw new Error('VABU tab started loading again');
  }
  const original = await approved();
  const window = await api.windows.get(original.windowId);
  if (!normalWindow(window) || window.id !== original.windowId) throw new Error('VABU tab is not in a normal browser window');
  if (waitLoad) {
    const deadline = Date.now() + 5000;
    let tab = await approved(original);
    while (tab.status !== 'complete') {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the VABU tab to load');
      await new Promise(resolve => setTimeout(resolve, 100));
      tab = await approved(original);
    }
  }
  if (navigating) {
    if (!await hasHostAccess(api.permissions, destination)) throw new Error('Browser has not granted access to the destination');
    requireStillLoaded(await approved(original));
    await releaseTarget(id);
    const currentWindow = await api.windows.get(original.windowId);
    if (!normalWindow(currentWindow) || currentWindow.id !== original.windowId) throw new Error('VABU tab is not in a normal browser window');
    // tabs.update does not independently require a destination host grant.
    // Invalidate the final permission snapshot until the synchronous dispatch.
    let grantRemoved = false;
    const onRemoved = ({ origins }) => { if (origins?.length) grantRemoved = true; };
    api.permissions.onRemoved.addListener(onRemoved);
    try {
      const [sourceAllowed, destinationAllowed] = await Promise.all([
        hasHostAccess(api.permissions, webUrl(original.url)),
        hasHostAccess(api.permissions, destination),
      ]);
      if (!sourceAllowed) throw new Error('Browser has not granted access to this tab');
      if (!destinationAllowed) throw new Error('Browser has not granted access to the destination');
      requireStillLoaded(await read(original));
      assertOwned();
      if (grantRemoved) throw new Error('Browser site access changed before navigation; retry the command');
      await api.tabs.update(id, { url: destination.href });
    } finally {
      api.permissions.onRemoved.removeListener(onRemoved);
    }
    assertBridge();
    return { tab: id, requested: true };
  }
  if (verb === 'tab-close') {
    const departed = new Set();
    const markDeparted = (tabId) => departed.add(tabId);
    api.tabs.onRemoved?.addListener(markDeparted);
    api.tabs.onDetached?.addListener(markDeparted);
    try {
      const siblings = await api.tabs.query({ windowId: window.id });
      const tab = await approved(original);
      requireStillLoaded(tab);
      if (tab.active || tab.pinned) throw new Error('Cannot close an active or pinned tab');
      // shortcut: browser check and removal are not atomic; use a conditional close API if one becomes available.
      if (!siblings.some(sibling => sibling.id !== id && !departed.has(sibling.id))) {
        throw new Error('Cannot close the last tab in a window');
      }
      assertOwned();
      await api.tabs.remove(id);
    } finally {
      api.tabs.onRemoved?.removeListener(markDeparted);
      api.tabs.onDetached?.removeListener(markDeparted);
    }
    assertBridge();
    return { tab: id, closed: true };
  }
  const tab = await approved(original);
  assertOwned();
  if (!tab.active) await api.tabs.update(id, { active: true });
  const activated = await approved(original);
  assertOwned();
  if (!activated.active) throw new Error('VABU tab did not become active');
  const focused = await api.windows.update(window.id, { focused: true });
  const current = await approved(original);
  return { tab: id, window: window.id, active: current.active, focused: focused?.focused === true };
}
