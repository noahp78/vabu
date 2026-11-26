export const commands = {
  get: async ([property, ref, ...rest], ctx) => {
    if (rest.length || !['text', 'href'].includes(property) || !/^@r[1-9]\d{0,2}$/.test(ref)) {
      throw new Error('Usage: get text|href @rN');
    }
    if (typeof ctx.getElement !== 'function') throw new Error('Element reads are not supported');
    await ctx.assertCurrent();
    const result = await ctx.getElement(property, ref);
    await ctx.assertCurrent();
    return result;
  },
};

// Serialized into the isolated world of the pinned top document; never creates or refreshes a snapshot.
export function getElementInPage(origin, overlayKey, property, ref) {
  const fail = (error) => ({ error });
  const ok = (value) => ({ ok: true, value });
  if (!['text', 'href'].includes(property)) return fail('Unsupported element property');
  if (!/^@r[1-9]\d{0,2}$/.test(ref)) return fail('Invalid snapshot reference');
  const state = globalThis.vabuCursorState;
  if (window !== window.top || !/^https?:$/.test(location.protocol) || location.origin !== origin
    || globalThis.origin !== origin || !overlayKey || state?.key !== overlayKey
    || !state.host?.isConnected || state.host.ownerDocument !== document) {
    return fail('Selected document or overlay changed; take a new snapshot');
  }
  if (!Array.isArray(state.targets)) return fail('No current snapshot; take a snapshot first');
  const element = state.targets[Number(ref.slice(2)) - 1];
  if (!element) return fail('Snapshot reference not found');
  if (!element.isConnected || element.getRootNode() !== document) return fail('Stale reference; take a new snapshot');
  if (state.targets.indexOf(element) !== state.targets.lastIndexOf(element)) return fail('Ambiguous snapshot reference');

  const blocked = 'input, textarea, select, option, optgroup, datalist, output, [contenteditable]:not([contenteditable="false" i]), '
    + '[role~="textbox" i], [role~="searchbox" i], [role~="combobox" i], '
    + 'iframe, frame, fencedframe, portal, object, embed, script, style, template, noscript, '
    + '[hidden], [inert], [aria-hidden="true" i]';
  const excluded = (el) => el.matches(blocked)
    || el.closest('label')?.control?.matches('input[type=password i], input[type=file i]');
  const rendered = (style) => style.display !== 'none' && style.visibility === 'visible' && style.opacity !== '0'
    && style.contentVisibility !== 'hidden' && style.clipPath === 'none' && style.clip === 'auto'
    && (!style.maskImage || style.maskImage === 'none');
  for (let node = element; node; node = node.parentElement) {
    if (excluded(node) || node.isContentEditable || node.assignedSlot || !rendered(getComputedStyle(node))) {
      return fail('Reference is hidden or protected');
    }
  }
  if (state.host.contains(element) || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })) {
    return fail('Reference is not visible');
  }

  if (property === 'href') {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !element.matches('a[href]')) {
      return fail('Unsupported href target; use the reference of an HTML link itself');
    }
    const raw = element.getAttribute('href');
    if (raw.length > 8192) return fail('Link URL is too long');
    try {
      const url = new URL(raw, element.baseURI);
      if (!['https:', 'http:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
        return fail('Link is not a same-origin HTTP(S) URL without credentials');
      }
      if (url.href.length > 8192) return fail('Link URL is too long');
      return ok(url.href);
    } catch {
      return fail('Invalid link URL');
    }
  }

  // shortcut: rendered light-DOM text, not pixel occlusion, generated content, or exact typographic spacing; use reviewed capture for those.
  const range = document.createRange();
  const visibleText = (node) => {
    const parent = node.parentElement;
    if (!parent?.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })) return false;
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length) return false;
    for (let el = parent; el && el !== document.scrollingElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      const clipX = /^(hidden|clip|scroll|auto)$/.test(style.overflowX);
      const clipY = /^(hidden|clip|scroll|auto)$/.test(style.overflowY);
      if (!clipX && !clipY) continue;
      const box = el.getBoundingClientRect();
      const left = box.left + el.clientLeft;
      const top = box.top + el.clientTop;
      if (rects.some((rect) => (clipX && (rect.left < left || rect.right > left + el.clientWidth))
        || (clipY && (rect.top < top || rect.bottom > top + el.clientHeight)))) return false;
    }
    return true;
  };
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let text = '';
  let count = 0;
  let node = walker.firstChild();
  while (node && text.length < 4000 && ++count <= 2000) {
    if (node.nodeType === Node.TEXT_NODE && visibleText(node)) {
      const part = node.data.slice(0, 4000 - text.length).replace(/\s+/g, ' ').trim();
      if (part) text += (text ? ' ' : '') + part;
    }
    if (node.nodeType === Node.ELEMENT_NODE && !excluded(node) && !node.assignedSlot && rendered(getComputedStyle(node))) {
      const child = walker.firstChild();
      if (child) { node = child; continue; }
    }
    let next = walker.nextSibling();
    while (!next && walker.parentNode() !== element) next = walker.nextSibling();
    node = next;
  }
  return ok(text.slice(0, 4000));
}
