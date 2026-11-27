import { hasHostAccess, webUrl } from './domains.js';
import { isToolbarPopup } from './toolbar.mjs';

// Metadata lives only as long as the batch's first unread note, never in the CLI payload.
const batches = new WeakMap();
const recalls = new WeakMap();
const recallTimeout = 5000;

export function invalidateFeedback(connection, tabId) {
  if (!connection) return;
  if (tabId === undefined) connection.feedbackLeases?.clear();
  else connection.feedbackLeases?.delete(tabId);
  const opening = connection.feedbackOpening;
  if (opening && (tabId === undefined || opening.scope.id === tabId)) opening.cancelled = true;
  if (tabId === undefined) return; // Permission changes cancel operations, not unread notes.
  for (const owner of [connection, ...(connection.workspaces?.values() ?? [])]) {
    for (const note of owner.feedback ?? []) if (batches.get(note)?.id === tabId) batches.delete(note);
  }
}

function latestBatch(scope) {
  return scope.owner.feedback?.findLast(note => {
    const batch = batches.get(note);
    return batch?.id === scope.id && batch.href === scope.href && batch.documentId === scope.documentId;
  });
}

export async function handleFeedback(api, connection, getBridge, getOwner, message, sender) {
  if (sender.id !== api.runtime.id) throw new Error('Invalid VABU feedback sender');
  if (!connection?.online) throw new Error('Start the local bridge in the VABU popup first');
  if (message.action === 'feedback-start' || message.action === 'feedback-recall') {
    if (!isToolbarPopup(api.runtime, sender)) throw new Error('Use the VABU popup to open feedback');
    const recalling = message.action === 'feedback-recall';
    const activeTab = async () => (await api.tabs.query({ active: true, currentWindow: true }))[0];
    const tab = await activeTab();
    if (!tab?.active || tab.incognito || !Number.isInteger(tab.id)) throw new Error('Open a normal website tab to leave feedback');
    if (connection.feedbackOpening) throw new Error('Another annotation request is in progress. Try again.');
    const { id, url: href, windowId } = tab;
    const url = webUrl(href);
    const owner = getOwner(id);
    const assertCurrent = () => {
      if (getBridge() !== connection || !connection.online || lease.cancelled || getOwner(id) !== owner
        || (connection.feedbackOpening !== lease && connection.feedbackLeases?.get(id) !== lease)) {
        throw new Error('Feedback expired. Open Annotate page again.');
      }
    };
    const verify = async () => {
      assertCurrent();
      const current = await api.tabs.get(id);
      const frame = await api.webNavigation?.getFrame?.({ tabId: id, frameId: 0 });
      if (current?.id !== id || current.windowId !== windowId || !current.active || current.incognito || current.discarded || current.pendingUrl
        || current.status !== 'complete' || current.url !== href || frame?.url !== href
        || typeof frame.documentId !== 'string' || !frame.documentId || frame.errorOccurred
        || (frame.frameType !== undefined && frame.frameType !== 'outermost_frame')
        || (frame.documentLifecycle !== undefined && frame.documentLifecycle !== 'active')
        || (scope.documentId && frame.documentId !== scope.documentId)
        || !await hasHostAccess(api.permissions, url)) {
        throw new Error('Cannot verify the active website document or its site access');
      }
      const active = await activeTab();
      if (active?.id !== id || active.windowId !== windowId || active.url !== href) throw new Error('Select the original feedback tab and try again');
      assertCurrent();
      return frame.documentId;
    };
    const scope = { id, href, owner, assertCurrent, verify };
    const token = crypto.randomUUID();
    const lease = connection.feedbackOpening = { scope, token };
    const inject = async (func, ...args) => {
      const results = await api.scripting.executeScript({ target: { tabId: id, documentIds: [scope.documentId] },
        world: 'ISOLATED', func, args: [href, token, ...args] });
      if (results?.length !== 1 || results[0].documentId !== scope.documentId || results[0].frameId !== 0
        || results[0].error !== undefined) throw new Error('Could not open feedback on the selected document');
      return results[0].result;
    };
    const deadline = recalling ? Date.now() + recallTimeout : null;
    const expired = new Error('Feedback recall timed out. Try again.');
    let timer, release, attempted = false;
    const timeout = recalling && new Promise((_, reject) => { timer = setTimeout(() => reject(expired), recallTimeout); });
    const bounded = (work) => timeout ? Promise.race([work, timeout]) : work;
    const assertOpening = () => {
      if (deadline !== null && Date.now() >= deadline) throw expired;
      assertCurrent();
    };
    try {
      scope.documentId = await bounded(verify());
      assertOpening();
      const first = recalling ? latestBatch(scope) : undefined;
      if (recalling && !first) throw new Error('No unread batch to recall for this tab, document, and workspace.');
      let drafts, index;
      if (first) {
        index = owner.feedback.indexOf(first);
        drafts = owner.feedback.slice(index, index + batches.get(first).count).map(({ target, note }) => ({ target, note }));
        // A read of this inbox waits for commit or rollback. Other inboxes are unaffected.
        recalls.set(owner, new Promise(resolve => { release = resolve; }));
      }
      attempted = true;
      const opened = await bounded(inject(feedbackInPage, drafts ?? null, deadline));
      assertOpening();
      if (opened === 'drafts') throw new Error('This page already has unsent drafts. Send or close them first.');
      if (opened !== true) throw new Error('Could not open feedback on the selected document');
      await bounded(verify());
      assertOpening();
      if (first) {
        const finish = (action) => bounded(inject(finishFeedbackRecall, action, deadline));
        if (await finish('activate') !== true) throw new Error('Could not restore the recalled drafts');
        assertOpening();
        await bounded(verify());
        assertOpening();
        // Document verification alone cannot tell whether the site removed the editor.
        // Make its acknowledgement the last async check before transferring ownership.
        if (await finish('acknowledge') !== true) throw new Error('Could not restore the recalled drafts');
        assertOpening();
        if (latestBatch(scope) !== first || owner.feedback[index] !== first) throw new Error('The unread batch changed. Try again.');
        owner.feedback.splice(index, drafts.length);
        batches.delete(first);
      }
      (connection.feedbackLeases ??= new Map()).set(id, lease);
      return { ok: true };
    } catch (error) {
      lease.cancelled = true;
      // Roll back only our own UI. A failed or stalled cleanup must not hold the inbox.
      if (attempted) void inject(finishFeedbackRecall, 'rollback').catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
      delete connection.feedbackOpening;
      if (release) {
        recalls.delete(owner);
        release();
      }
    }
  }

  const lease = connection.feedbackLeases?.get(sender.tab?.id);
  const scope = lease?.scope;
  // The one-time token only exists in the exact isolated world we injected into.
  // Firefox need not expose sender.documentId; check it as well when present.
  if (!scope || message.token !== lease.token || sender.frameId !== 0 || sender.tab?.id !== scope.id
    || sender.tab.incognito || sender.url !== scope.href
    || (sender.documentId !== undefined && sender.documentId !== scope.documentId)) {
    throw new Error('Feedback must come from the current active document');
  }
  const url = webUrl(scope.href);
  const page = url.origin + url.pathname;
  if (page.length > 4000) throw new Error('Page URL is too long to include in feedback');
  const { points } = message;
  if (!Array.isArray(points) || points.length < 1 || points.length > 20 || points.some((point) =>
    !point || typeof point.note !== 'string' || !point.note.trim() || point.note.length > 2000 ||
    !(point.target === null || (typeof point.target === 'string' && point.target.length > 0 && point.target.length <= 500)))) {
    throw new Error('Invalid feedback');
  }
  await scope.verify();
  if (connection.feedbackLeases?.get(scope.id) !== lease) throw new Error('Feedback was replaced or already submitted');
  scope.assertCurrent();
  const inbox = scope.owner.feedback ??= [];
  if (inbox.length + points.length > 20) throw new Error('Inbox full. Run vabu feedback for this workspace, then retry.');
  connection.feedbackLeases.delete(scope.id);
  const notes = points.map(({ target, note }) => ({ page, target, note: note.trim() }));
  batches.set(notes[0], { id: scope.id, href: scope.href, documentId: scope.documentId, count: notes.length });
  inbox.push(...notes);
  return { ok: true };
}

export function feedbackCount(connection) {
  if (!connection?.online) return 0;
  let total = connection.feedback?.length ?? 0;
  for (const workspace of connection.workspaces?.values() ?? []) total += workspace.feedback?.length ?? 0;
  return total;
}

export function listFeedback(connection) {
  const feedback = [];
  if (!connection?.online) return { feedback, total: 0 };
  const append = (owner, workspace) => {
    for (const { page, target, note } of owner.feedback ?? []) {
      if (feedback.length === 20) break;
      feedback.push({ page, target, note, workspace });
    }
  };
  append(connection, null);
  for (const workspace of connection.workspaces?.values() ?? []) {
    if (feedback.length === 20) break;
    append(workspace, workspace.name);
  }
  return { feedback, total: feedbackCount(connection) };
}

export function takeFeedback(owner, terms) {
  if (terms.length) throw new Error('Usage: vabu feedback');
  const pending = recalls.get(owner);
  if (pending) return pending.then(() => takeFeedback(owner, terms));
  const feedback = owner.feedback?.splice(0) ?? [];
  for (const note of feedback) batches.delete(note);
  return { feedback };
}

// executeScript serializes these functions into the extension's isolated world.
function finishFeedbackRecall(href, token, action, deadline) {
  const view = globalThis.vabuFeedback;
  if (view?.token !== token) return false;
  if (action === 'rollback') { view(); return true; }
  if (document.hidden || location.href !== href || Date.now() >= deadline) return false;
  if (action === 'activate') return view.activate();
  return action === 'acknowledge' && view.acknowledge();
}

function feedbackInPage(href, token, restored, deadline) {
  if (window !== window.top || document.hidden || location.href !== href || globalThis.origin !== location.origin
    || (deadline !== null && Date.now() >= deadline)) return false;
  if (globalThis.vabuFeedback?.hasDrafts()) return 'drafts';
  globalThis.vabuFeedback?.();
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial !important; }
    * { box-sizing: border-box; }
    #picker, #editor {
      --surface: #fff; --ink: #211a35; --muted: #50485f; --border: #ded8ea;
      --field: #bcb3cd; --tint: #f5f3fa; --accent: #6245a0;
      --primary: #5b21b6; --primary-hover: #4c1d95; --primary-ink: #fff;
      color-scheme: light dark; background: var(--surface); color: var(--ink);
      border: 1px solid var(--border); border-radius: 14px; padding: 14px;
      box-shadow: 0 12px 32px #211a3538; font: 14px/1.5 system-ui, sans-serif;
      inline-size: 360px; max-inline-size: calc(100vw - 2rem); overflow: auto; overscroll-behavior: contain;
    }
    @media (prefers-color-scheme: dark) {
      #picker, #editor {
        --surface: #262031; --ink: #f3efff; --muted: #d3cadd; --border: #493d5a;
        --field: #78698a; --tint: #342b42; --accent: #c4b5fd;
        --primary: #a78bfa; --primary-hover: #c4b5fd; --primary-ink: #211138;
      }
    }
    [popover] { margin: 0; }
    #picker { inset: auto 1rem 1rem auto; inline-size: 440px; max-block-size: calc(100dvh - 2rem); }
    #picker:focus { outline: none; }
    #pins { position: fixed; inset: 0; max-inline-size: none; max-block-size: none; border: 0; padding: 0;
      inline-size: auto; block-size: auto; background: transparent; pointer-events: none; }
    #editor { position: fixed; inset: 0 auto auto 0; }
    h2, p { margin: 0; }
    h2 { font-size: 18px; line-height: 1.25; letter-spacing: -.02em; }
    .eyebrow { margin-bottom: 4px; color: var(--accent); font-size: 10px; font-weight: 750; letter-spacing: .12em; }
    .hint { margin-top: 6px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    label { display: block; margin-top: 10px; font-weight: 700; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    #picker .actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    #picker .actions button { min-inline-size: 0; overflow-wrap: anywhere; }
    button, textarea { font: inherit; border: 1px solid var(--field); border-radius: 8px; color: inherit; }
    button { background: var(--surface); padding: 6px 12px; font-weight: 650; cursor: pointer; }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:disabled { opacity: .6; cursor: not-allowed; }
    button:focus-visible, textarea:focus-visible { outline: 3px solid #9b7aef; outline-offset: 2px; }
    .primary { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); }
    .primary:hover:not(:disabled) { background: var(--primary-hover); }
    textarea { display: block; inline-size: 100%; margin-top: 4px; padding: 8px; background: var(--tint); resize: vertical; }
    .pin { min-inline-size: 2rem; min-block-size: 2rem; border-radius: 999px; border: 2px solid #fff;
      background: #5b21b6; color: #fff; padding: 0 .35rem; font: 700 12px/1 system-ui, sans-serif; }
    .pin:hover:not(:disabled) { background: #4c1d95; border-color: #fff; }
    #pins .pin { position: absolute; pointer-events: auto; }
    #point-list { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    #point-list:empty, #status:empty { display: none; }
    #outline { position: fixed; pointer-events: none; z-index: 2147483647; box-sizing: border-box;
      border: 2px solid #8454ff; background: #8454ff26; }
  `);
  shadow.adoptedStyleSheets = [sheet];
  function add(parent, tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    parent.append(node);
    return node;
  }
  const outline = add(shadow, 'div');
  outline.id = 'outline';
  outline.hidden = true;
  const pins = add(shadow, 'div');
  pins.id = 'pins';
  pins.setAttribute('popover', 'manual');
  const picker = add(shadow, 'section');
  picker.id = 'picker';
  picker.tabIndex = -1;
  picker.setAttribute('popover', 'manual');
  picker.setAttribute('aria-labelledby', 'picker-title');
  add(picker, 'p', 'VABU · PAGE FEEDBACK').className = 'eyebrow';
  add(picker, 'h2', 'Annotate this page').id = 'picker-title';
  add(picker, 'p', 'Click an element to annotate it, or focus it with Tab and press Enter. Saved annotations stay as drafts until you send them.').className = 'hint';
  const pointList = add(picker, 'div');
  pointList.id = 'point-list';
  const pickerActions = add(picker, 'div');
  pickerActions.className = 'actions';
  const wholePage = add(pickerActions, 'button', 'Comment on whole page');
  const send = add(pickerActions, 'button', 'Send annotations');
  send.className = 'primary';
  send.disabled = true;
  const status = add(picker, 'p');
  status.id = 'status';
  status.className = 'hint';
  status.setAttribute('role', 'status');
  const dialog = add(shadow, 'dialog');
  dialog.id = 'editor';
  dialog.setAttribute('popover', 'manual');
  add(dialog, 'p', 'VABU · ANNOTATION DRAFT').className = 'eyebrow';
  const title = add(dialog, 'h2');
  title.id = 'feedback-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = add(dialog, 'form');
  const label = add(form, 'label', 'Your comment');
  const input = add(label, 'textarea');
  input.required = true;
  input.maxLength = 2000;
  input.rows = 3;
  input.autofocus = true;
  const editorActions = add(form, 'div');
  editorActions.className = 'actions';
  add(editorActions, 'button', 'Save annotation').className = 'primary';
  const back = add(editorActions, 'button', 'Cancel');
  back.type = 'button';
  const listeners = new AbortController();
  const points = [];
  let draft;
  let sending = false;
  let ready = !restored;
  let expiry;
  host.inert = !ready;
  function cleanup() {
    clearTimeout(expiry);
    listeners.abort();
    host.remove();
    if (globalThis.vabuFeedback === cleanup) delete globalThis.vabuFeedback;
  }
  cleanup.token = token;
  cleanup.hasDrafts = () => !ready || !!draft || points.length > 0;
  const attached = () => globalThis.vabuFeedback === cleanup && host.isConnected
    && host.parentElement === document.documentElement && !document.hidden && location.href === href
    && picker.matches(':popover-open') && pins.matches(':popover-open');
  cleanup.activate = () => {
    // Focus can run site handlers. Leave editing and submission disabled until acknowledgement.
    if (!attached()) return false;
    host.inert = false;
    picker.focus({ preventScroll: true });
    return attached() && !host.inert;
  };
  cleanup.acknowledge = () => {
    if (!attached() || host.inert) return false;
    ready = true;
    clearTimeout(expiry);
    updateSend();
    return true;
  };
  function describe(element) {
    const unique = (selector) => {
      if (selector.length > 256) return false;
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    };
    let suffix = '';
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const tag = node.localName;
      if (!/^[a-z][\w-]*$/i.test(tag)) return null;
      const options = [];
      if (/^[a-z_][\w-]{0,79}$/i.test(node.id)) options.push('#' + node.id);
      const classes = Array.from(node.classList).filter((name) => /^[a-z][\w-]{0,59}$/i.test(name)).slice(0, 3);
      const classSelectors = classes.map((name) => `.${name}`);
      options.push(...classSelectors.map((name) => tag + name));
      if (classSelectors.length > 1) options.push(tag + classSelectors.join(''));
      options.push(tag);
      for (const option of options) {
        if (unique(option + suffix)) return option + suffix;
      }
      if (!node.parentElement) return null;
      const siblings = Array.from(node.parentElement.children);
      let segment = options.find((option) => siblings.filter((sibling) => sibling.matches(option)).length === 1);
      if (!segment) {
        const sameType = siblings.filter((sibling) => sibling.localName === tag);
        const index = sameType.indexOf(node) + 1;
        if (index < 1 || index > 999999) return null;
        segment = `${tag}:nth-of-type(${index})`;
      }
      suffix = ` > ${segment}${suffix}`;
      if (suffix.length > 256) return null;
    }
    const rooted = `html${suffix}`;
    return unique(rooted) ? rooted : null;
  }
  function layout() {
    outline.hidden = true;
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const right = left + (viewport?.width ?? innerWidth);
    const bottom = top + (viewport?.height ?? innerHeight);
    const offsets = new Map();
    for (const { element, pin } of points) {
      if (!pin) continue;
      const rect = element.isConnected && element.getBoundingClientRect();
      pin.hidden = !rect || !rect.width || !rect.height || rect.bottom <= top || rect.top >= bottom ||
        rect.right <= left || rect.left >= right;
      if (!pin.hidden) {
        const offset = offsets.get(element) ?? 0;
        pin.style.left = `${Math.max(left, Math.min(rect.right, right) - pin.offsetWidth - offset)}px`;
        pin.style.top = `${Math.max(top, Math.min(rect.top, bottom - pin.offsetHeight))}px`;
        offsets.set(element, offset + pin.offsetWidth + 4);
      }
    }
    if (!draft) return;
    const rect = draft.element?.isConnected ? draft.element.getBoundingClientRect() : draft.opener.getBoundingClientRect();
    const gap = 8;
    dialog.style.maxWidth = `${Math.max(0, right - left - 2 * gap)}px`;
    dialog.style.maxHeight = `${Math.max(0, bottom - top - 2 * gap)}px`;
    const { width, height } = dialog.getBoundingClientRect();
    // Use viewport coordinates so the editor also works without CSS anchors.
    const below = rect.bottom + gap;
    const above = rect.top - height - gap;
    const y = below + height > bottom - gap && above >= top + gap ? above : below;
    dialog.style.left = `${Math.max(left + gap, Math.min(rect.left, right - width - gap))}px`;
    dialog.style.top = `${Math.max(top + gap, Math.min(y, bottom - height - gap))}px`;
  }
  function compose(element, opener, point) {
    if (!ready || sending) return;
    if (draft) { input.focus(); return; }
    if (!point && points.length >= 20) { status.textContent = 'You have 20 drafts. Send them before adding more.'; return; }
    status.textContent = '';
    title.textContent = point ? `Edit annotation ${point.number}` : `Annotation ${points.length + 1}`;
    input.value = point?.note ?? '';
    draft = { element, opener, point, initialValue: input.value };
    dialog.showPopover();
    layout();
    input.focus({ preventScroll: true });
  }
  function closeEditor(focus = draft.opener) {
    draft = undefined;
    dialog.hidePopover();
    focus.focus({ preventScroll: true });
  }
  function addPoint(element, target, note) {
    const point = { element, target, note, number: points.length + 1 };
    function marker(parent) {
      const button = add(parent, 'button', String(point.number));
      button.className = 'pin';
      button.setAttribute('aria-label', `Edit annotation ${point.number}`);
      button.onclick = (event) => { if (event.isTrusted) compose(element, button, point); };
      return button;
    }
    point.control = marker(pointList);
    if (element) {
      point.pin = marker(pins);
      point.pin.tabIndex = -1;
    }
    points.push(point);
    return point;
  }
  function updateSend() {
    send.textContent = `Send ${points.length} ${points.length === 1 ? 'annotation' : 'annotations'}`;
    send.disabled = !ready;
  }
  wholePage.onclick = (event) => { if (event.isTrusted) compose(null, wholePage); };
  back.onclick = (event) => { if (event.isTrusted && draft) closeEditor(); };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!event.isTrusted || !draft) return;
    const note = draft.point && input.value === draft.initialValue ? draft.point.note : input.value.trim();
    if (!note) { input.value = ''; input.reportValidity(); return; }
    const { element } = draft;
    const target = draft.point ? draft.point.target : element ? describe(element) : null;
    if (element && !draft.point && !target) {
      status.textContent = 'Could not identify this element. Your text is still in the editor; copy it or cancel and select another element.';
      input.focus();
      return;
    }
    const point = draft.point ?? addPoint(element, target, note);
    point.note = note;
    closeEditor(point.control);
    layout();
    updateSend();
    status.textContent = `Annotation ${point.number} saved as a draft. Not sent yet.`;
  };
  send.onclick = async (event) => {
    if (!event.isTrusted || !ready || sending || !points.length) return;
    if (draft) { status.textContent = 'Save or cancel the open annotation first.'; input.focus(); return; }
    if (location.href !== href) { status.textContent = 'Page changed. Copy your notes before leaving feedback.'; return; }
    sending = send.disabled = true;
    status.textContent = 'Sending to the local VABU inbox…';
    try {
      const result = await (globalThis.browser ?? chrome).runtime.sendMessage({
        action: 'feedback-submit', token, points: points.map(({ note, target }) => ({ note, target })),
      });
      if (!result?.ok) throw new Error(result?.error || 'Feedback was not sent');
      cleanup();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      sending = send.disabled = false;
    }
  };

  const pageTarget = (event) => ready && host.isConnected && event.isTrusted && location.href === href
    && event.target !== host && event.target instanceof Element;
  const on = (type, fn) => window.addEventListener(type, fn, { capture: true, signal: listeners.signal });
  on('pointermove', (event) => {
    outline.hidden = Boolean(draft) || sending || !pageTarget(event);
    if (outline.hidden) return;
    const { x, y, width, height } = event.target.getBoundingClientRect();
    Object.assign(outline.style, { left: `${x}px`, top: `${y}px`, width: `${width}px`, height: `${height}px` });
  });
  on('scroll', layout);
  on('resize', layout);
  for (const type of ['scroll', 'resize']) window.visualViewport?.addEventListener(type, layout, { signal: listeners.signal });
  function intercept(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  for (const type of ['pointerdown', 'pointerup', 'auxclick', 'contextmenu']) {
    on(type, (event) => { if (pageTarget(event)) intercept(event); });
  }
  on('click', (event) => { if (pageTarget(event)) { intercept(event); compose(event.target, wholePage); } });
  // Stop site shortcuts at window capture, but keep native typing, paste and Tab defaults.
  function isolateFeedbackKey(event) {
    if (host.isConnected && event.target === host) event.stopImmediatePropagation();
  }
  on('keypress', isolateFeedbackKey);
  on('keyup', isolateFeedbackKey);
  on('keydown', (event) => {
    if (!ready || !host.isConnected || !event.isTrusted) return;
    if (event.target === host) {
      isolateFeedbackKey(event);
      if (event.key === 'Escape' && !sending && !event.isComposing) {
        event.preventDefault();
        if (draft) closeEditor();
        else cleanup();
      }
      return;
    }
    if (event.key === 'Escape' && !sending && !event.isComposing) {
      if (pageTarget(event)) intercept(event);
      if (draft) closeEditor();
      else cleanup();
      return;
    }
    if (event.key === 'Enter' && pageTarget(event) && event.target !== document.body) {
      intercept(event);
      compose(event.target, event.target);
    }
  });
  on('pagehide', cleanup);
  try {
    if (restored) {
      for (const { target, note } of restored) {
        let element;
        if (target) {
          try {
            const matches = document.querySelectorAll(target);
            if (matches.length === 1) element = matches[0];
          } catch {} // Keep the selector and the editable draft even if the element is gone.
        }
        addPoint(element, target, note);
      }
      updateSend();
      status.textContent = 'Recalled as drafts. Select a numbered annotation to edit it.';
    }
    document.documentElement.append(host);
    globalThis.vabuFeedback = cleanup;
    pins.showPopover();
    picker.showPopover();
    layout();
    if (ready) picker.focus({ preventScroll: true });
    // An abandoned provisional view cannot block opening feedback indefinitely.
    else expiry = setTimeout(cleanup, Math.max(0, deadline - Date.now()));
    return true;
  } catch (error) {
    cleanup();
    throw error;
  }
}
