// webNavigation's sub_frame also includes legacy <frame> elements. Prove that every
// direct WindowProxy is owned by a light-DOM iframe, without ever inspecting its document.
// Unsupported owner layouts (including shadow-tree iframes) fail closed.
export function iframeOwnersInPage(origin, url) {
  if (window !== window.top || self.origin !== origin || location.href !== url || window.length > 64) return false;
  const elements = document.getElementsByTagName('iframe');
  if (elements.length > 128) return false;
  const owners = new Set();
  for (const el of elements) {
    if (!(el instanceof HTMLIFrameElement) || !el.contentWindow) continue;
    if (el.closest('form, [contenteditable], [inert], [hidden], [aria-hidden="true" i]')) return false;
    owners.add(el.contentWindow);
  }
  if (owners.size !== window.length) return false;
  for (let i = 0; i < window.length; i++) if (!owners.has(window.frames[i])) return false;
  return true;
}

// Serialized for browser injection; keep the traversal self-contained and prune before reading text.
export function frameTextInPage(origin, url, parentOrigin, probeOnly) {
  if (window === window.top || window.parent !== window.top || self.origin !== origin
    || location.origin !== origin || location.href !== url || location.ancestorOrigins?.[0] !== parentOrigin
    || document.contentType !== 'text/html' || document.readyState !== 'complete'
    || document.designMode.toLowerCase() !== 'off' || !document.body) return null;
  if (probeOnly) return true;
  const blocked = 'iframe,frame,frameset,fencedframe,object,embed,portal,script,style,template,noscript,slot,'
    + 'form,input,textarea,select,option,button,datalist,output,fieldset,label,[form],[role~="form" i],'
    + '[contenteditable],[hidden],[inert],[aria-hidden="true" i],'
    + '[role~="textbox" i],[role~="searchbox" i],[role~="combobox" i],[role~="spinbutton" i]';
  const visible = (el) => {
    if (el.matches(blocked) || el.isContentEditable || el.shadowRoot) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility === 'visible' && style.contentVisibility !== 'hidden' && style.opacity !== '0';
  };
  const root = document.body;
  if (!visible(document.documentElement) || !visible(root)) return { text: '', truncated: false };
  let text = '';
  let remaining = 10_000;
  let node = root.firstChild;
  while (node) {
    if (--remaining < 0) return { text, truncated: true };
    if (node.nodeType === Node.TEXT_NODE && node.length) {
      // Cap raw input too: a single text node can be arbitrarily large.
      const available = 4000 - text.length;
      const chunk = node.substringData(0, available).replace(/\s+/g, ' ').trim();
      text += (text && chunk ? ' ' + chunk : chunk).slice(0, available);
      if (node.length > available || text.length >= 4000) return { text, truncated: true };
    } else if (node.nodeType === Node.ELEMENT_NODE && visible(node) && node.firstChild) {
      node = node.firstChild;
      continue;
    }
    while (node !== root && !node.nextSibling) node = node.parentNode;
    node = node === root ? null : node.nextSibling;
  }
  return { text, truncated: false };
}
