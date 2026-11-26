import { webUrl } from './domains.js';

export async function handleFeedback(api, connection, getScope, message, sender) {
  if (sender.id !== api.runtime.id) throw new Error('Invalid VABU feedback sender');
  if (!connection?.online) throw new Error('Start the local bridge in the VABU popup first');
  if (message.action === 'feedback-start') {
    if (sender.tab || sender.url !== api.runtime.getURL('shared/popup.html')) throw new Error('Use the VABU popup to open feedback');
    const scope = await getScope();
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== scope.id || tab.incognito) throw new Error('Switch to the selected VABU tab to leave feedback');
    if ((await scope.verify()).active !== true) throw new Error('The selected tab is no longer active');
    scope.assertCurrent();
    const token = crypto.randomUUID();
    const lease = connection.feedbackLease = { scope, token };
    try {
      const results = await api.scripting.executeScript({ target: { tabId: scope.id, documentIds: [scope.documentId] },
        world: 'ISOLATED', func: feedbackInPage, args: [scope.href, token] });
      if (results?.length !== 1 || results[0].documentId !== scope.documentId || results[0].frameId !== 0
        || results[0].result !== true) throw new Error('Could not open feedback on the selected document');
      await scope.verify();
      if (connection.feedbackLease !== lease) throw new Error('Feedback was replaced');
      scope.assertCurrent();
      return { ok: true };
    } catch (error) {
      if (connection.feedbackLease === lease) delete connection.feedbackLease;
      throw error;
    }
  }

  const lease = connection.feedbackLease;
  const scope = lease?.scope;
  // The one-time token only exists in the exact isolated world we injected into.
  // Firefox need not expose sender.documentId; check it as well when present.
  if (!scope || message.token !== lease.token || sender.frameId !== 0 || sender.tab?.id !== scope.id
    || sender.tab.incognito || sender.url !== scope.href
    || (sender.documentId !== undefined && sender.documentId !== scope.documentId)) {
    throw new Error('Feedback must come from the current selected document');
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
  if (connection.feedbackLease !== lease) throw new Error('Feedback was replaced or already submitted');
  scope.assertCurrent();
  const inbox = scope.owner.feedback ??= [];
  if (inbox.length + points.length > 20) throw new Error('Inbox full. Run vabu feedback for this workspace, then retry.');
  delete connection.feedbackLease;
  inbox.push(...points.map(({ target, note }) => ({ page, target, note: note.trim() })));
  return { ok: true };
}

export function takeFeedback(owner, terms) {
  if (terms.length) throw new Error('Usage: vabu feedback');
  return { feedback: owner.feedback?.splice(0) ?? [] };
}

// executeScript serializes this function into the extension's isolated world.
function feedbackInPage(href, token) {
  if (window !== window.top || document.hidden || location.href !== href || globalThis.origin !== location.origin) return false;
  globalThis.vabuFeedback?.();
  const host = document.createElement('div');
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all: initial !important; }
    dialog, [popover] { box-sizing: border-box; color-scheme: light dark; background: Canvas;
      color: CanvasText; border: 1px solid GrayText; border-radius: .75rem; padding: 1rem;
      font: 1rem system-ui; max-inline-size: calc(100vw - 2rem); }
    [popover] { margin: 0; }
    #picker { inset: auto 1rem 1rem auto; }
    #pins { position: fixed; inset: 0; max-inline-size: none; max-block-size: none; border: 0; padding: 0;
      inline-size: auto; block-size: auto; background: transparent; pointer-events: none; }
    #editor { position: fixed; inset: 0 auto auto 0; inline-size: 22rem; overflow: auto;
      overscroll-behavior: contain; box-shadow: 0 .25rem 1.25rem #0004; }
    .pin { min-inline-size: 2rem; min-block-size: 2rem; border-radius: 2rem; border: 2px solid white;
      background: #6035ce; color: white; margin: 0; padding: 0 .3rem; font-weight: bold; }
    #pins .pin { position: absolute; pointer-events: auto; }
    #point-list { display: flex; flex-wrap: wrap; gap: .25rem; margin-block: .5rem; }
    #point-list:empty { display: none; }
    h2, p { margin: 0 0 .75rem; }
    h2 { font-size: 1.15rem; }
    button { font: inherit; padding: .35em .6em; margin-inline-end: .5rem; }
    textarea { display: block; box-sizing: border-box; inline-size: 100%; font: inherit; margin-block: .3rem .75rem; }
    #status:empty { margin: 0; }
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
  picker.setAttribute('popover', 'manual');
  picker.setAttribute('aria-label', 'VABU feedback mode');
  add(picker, 'h2', 'VABU feedback');
  add(picker, 'p', 'Click an element, or Tab to a control and press Enter. Ready sends your points to the local VABU inbox.');
  const pointList = add(picker, 'div');
  pointList.id = 'point-list';
  const wholePage = add(picker, 'button', 'Comment on page');
  const ready = add(picker, 'button', 'Ready');
  const status = add(picker, 'p');
  status.id = 'status';
  status.setAttribute('role', 'status');
  const dialog = add(shadow, 'dialog');
  dialog.id = 'editor';
  dialog.setAttribute('popover', 'manual');
  const title = add(dialog, 'h2');
  title.id = 'feedback-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const form = add(dialog, 'form');
  const label = add(form, 'label', 'Comment');
  const input = add(label, 'textarea');
  input.required = true;
  input.maxLength = 2000;
  input.rows = 3;
  input.autofocus = true;
  add(form, 'button', 'Save point');
  const back = add(form, 'button', 'Cancel');
  back.type = 'button';
  const listeners = new AbortController();
  const points = [];
  let draft;
  let sending = false;
  function cleanup() {
    listeners.abort();
    host.remove();
    if (globalThis.vabuFeedback === cleanup) delete globalThis.vabuFeedback;
  }
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
      const siblings = Array.from(node.parentElement.children);
      const segment = options.find((option) => siblings.filter((sibling) => sibling.matches(option)).length === 1);
      if (!segment) return null;
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
    if (sending) return;
    if (draft) { input.focus(); return; }
    if (!point && points.length >= 20) { status.textContent = '20 points saved. Choose Ready to send them.'; return; }
    status.textContent = '';
    draft = { element, opener, point };
    title.textContent = point ? `Edit point ${point.number}` : `Feedback point ${points.length + 1}`;
    input.value = point?.note ?? '';
    dialog.showPopover();
    layout();
    input.focus({ preventScroll: true });
  }
  function closeEditor(focus = draft.opener) {
    draft = undefined;
    dialog.hidePopover();
    focus.focus({ preventScroll: true });
  }
  wholePage.onclick = (event) => { if (event.isTrusted) compose(null, wholePage); };
  back.onclick = (event) => { if (event.isTrusted && draft) closeEditor(); };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!event.isTrusted || !draft) return;
    const note = input.value.trim();
    if (!note) { input.value = ''; input.reportValidity(); return; }
    let { point } = draft;
    if (!point) {
      const { element } = draft;
      point = { element, target: element ? describe(element) : null, number: points.length + 1 };
      function marker(parent) {
        const button = add(parent, 'button', String(point.number));
        button.className = 'pin';
        button.setAttribute('aria-label', `Edit point ${point.number}`);
        button.onclick = (event) => { if (event.isTrusted) compose(element, button, point); };
        return button;
      }
      point.control = marker(pointList);
      if (element) {
        point.pin = marker(pins);
        point.pin.tabIndex = -1;
      }
      points.push(point);
    }
    point.note = note;
    closeEditor(point.control);
    layout();
    status.textContent = `Point ${point.number} saved. Choose Ready to send all points.`;
  };
  ready.onclick = async (event) => {
    if (!event.isTrusted || sending) return;
    if (draft) { status.textContent = 'Save or cancel the open point first.'; input.focus(); return; }
    if (!points.length) { cleanup(); return; }
    if (location.href !== href) { status.textContent = 'Page changed. Copy your notes before leaving feedback.'; return; }
    sending = ready.disabled = true;
    status.textContent = 'Sending feedback…';
    try {
      const result = await (globalThis.browser ?? chrome).runtime.sendMessage({
        action: 'feedback-submit', token, points: points.map(({ note, target }) => ({ note, target })),
      });
      if (!result?.ok) throw new Error(result?.error || 'Feedback was not sent');
      cleanup();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      sending = ready.disabled = false;
    }
  };

  const pageTarget = (event) => host.isConnected && event.isTrusted && location.href === href
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
    if (!host.isConnected || !event.isTrusted) return;
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
  document.documentElement.append(host);
  globalThis.vabuFeedback = cleanup;
  pins.showPopover();
  picker.showPopover();
  wholePage.focus({ preventScroll: true });
  return true;
}
