export const commands = {
  'scoped-snapshot': async (args, ctx) => {
    const [within, selector, flag, role] = args;
    if (within !== '--within' || typeof selector !== 'string' || selector.length > 256
      || !(args.length === 2 || (args.length === 4 && flag === '--role' && typeof role === 'string'
        && /^[a-z][a-z0-9-]{0,63}$/i.test(role)))) {
      throw new Error('Usage: snapshot --within SELECTOR [--role ROLE]');
    }
    await ctx.assertCurrent();
    const result = await ctx.page('scopedSnapshot', 'snapshot', { selector, ...(role ? { role } : {}) });
    await ctx.assertCurrent();
    return result;
  },
};

// Self-contained for isolated-world injection into the checked top document.
export function scopedSnapshotInPage(origin, overlayKey, operation, payload, expected, ticket) {
  try {
    const state = globalThis.vabuCursorState;
    const assertDocument = () => {
      if (window !== window.top || location.origin !== origin || globalThis.vabuCursorState !== state
        || !state || state.key !== overlayKey || !state.host?.isConnected || state.host.ownerDocument !== document) {
        throw new Error('Snapshot document changed');
      }
    };
    assertDocument();
    const unique = operation === 'uniqueControl';
    if (unique && !expected) delete state.find;
    const normalize = (text) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
    const { selector, role, name } = payload ?? {};
    if (role !== undefined && (typeof role !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/i.test(role))) {
      throw new Error('Invalid control role');
    }
    const wantedRole = role?.toLowerCase();
    let wantedName;
    if (unique) {
      if (!wantedRole || typeof name !== 'string' || name.length > 256 || !(wantedName = normalize(name))) {
        throw new Error('Expected a role and nonempty exact name (256 characters max)');
      }
    } else if (operation !== 'snapshot') throw new Error('Unsupported scoped snapshot operation');

    const protectedElements = 'iframe,frame,fencedframe,embed,object,portal,input[type=file],input[type=password],[inert]';
    const omitText = `${protectedElements},script,style,noscript,template,textarea,select,[hidden],[aria-hidden=true i]`;
    const safe = (el) => !el.closest(protectedElements) && !el.closest('label')?.control?.closest(protectedElements);
    const visible = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const hidden = '[hidden],[aria-hidden=true i]';
    const disabled = ':disabled,[aria-disabled=true i]';
    const limit = 20000;
    let visited = 0;
    function* walk(root, prune) {
      let node = root;
      let depth = 0;
      while (node) {
        if (++visited > limit || depth > 128) throw new Error('Snapshot DOM scan limit exceeded');
        if (node !== state.host && !prune?.(node)) {
          yield node;
          if (node.firstChild) { node = node.firstChild; depth++; continue; }
        }
        while (node !== root && !node.nextSibling) { node = node.parentNode; depth--; }
        node = node === root ? null : node.nextSibling;
      }
    }
    let root = document.body;
    if (!unique) {
      if (typeof selector !== 'string' || selector.length > 256) throw new Error('Expected a bounded CSS selector');
      const css = selector.trim().replace(/\s*>\s*/g, '>').replace(/\s+/g, ' ');
      const terms = css.split(/[> ]/);
      const compound = /^(?:[a-zA-Z][\w-]*|\*)?(?:[.#][a-zA-Z_][\w-]*)*$/;
      if (terms.length > 8 || terms.some((part) => !part || !compound.test(part))) {
        throw new Error('CSS scope supports only tags, IDs, classes and descendant/child combinators (up to eight terms)');
      }
      root = null;
      for (const node of walk(document.documentElement)) {
        if (node.nodeType !== 1 || !node.matches(css)) continue;
        if (root) throw new Error('Snapshot scope is ambiguous');
        root = node;
      }
    }
    if (!root || !document.body?.contains(root) || !safe(root) || root.closest('[hidden],[aria-hidden=true i]')) {
      throw new Error('No available main-document snapshot scope');
    }
    visited = 0;

    const explicit = new Set('button link checkbox radio switch textbox searchbox combobox listbox slider spinbutton tab menuitem menuitemcheckbox menuitemradio option treeitem'.split(' '));
    const inputs = new Map([['button', 'button'], ['submit', 'button'], ['reset', 'button'], ['image', 'button'],
      ['checkbox', 'checkbox'], ['radio', 'radio'], ['range', 'slider'], ['number', 'spinbutton'],
      ['text', 'textbox'], ['email', 'textbox'], ['tel', 'textbox'], ['url', 'textbox'], ['search', 'searchbox']]);
    function controlRole(el) {
      let native;
      switch (el.localName) {
        case 'a': native = el.hasAttribute('href') ? 'link' : ''; break;
        case 'button': case 'summary': native = 'button'; break;
        case 'textarea': native = 'textbox'; break;
        case 'select': native = el.multiple || el.size > 1 ? 'listbox' : 'combobox'; break;
        case 'input':
          native = inputs.get(el.type);
          if (!native) return '';
          break;
        default: native = el.matches('[contenteditable=true], [contenteditable=""]') ? 'textbox' : '';
      }
      const declared = el.getAttribute('role')?.slice(0, 256).trim().split(/\s+/, 1)[0].toLowerCase();
      return explicit.has(declared) ? declared : native;
    }
    const skipText = (node) => node.nodeType === 1 && node.matches(omitText);
    const contentCap = 4096;
    let text = '';
    let textTruncated = false;
    // shortcut: bounded rendered-text approximation; use a browser accessibility API if full naming semantics are needed.
    function content(el, radioLabel = false) {
      if (radioLabel) {
        const aria = attribute(el, 'aria-label');
        if (aria.value || aria.truncated) return aria;
      }
      let raw = '';
      let size = 0;
      for (const node of walk(el, skipText)) {
        if (++size > 256) return { value: normalize(raw), truncated: true };
        const left = contentCap - raw.length;
        if (node.nodeType === 3 && visible(node.parentElement)) {
          raw += node.substringData(0, left);
          if (node.length > left) return { value: normalize(raw), truncated: true };
        } else if (radioLabel && node.nodeType === 1 && node.matches('img') && visible(node)) {
          const alt = attribute(node, 'alt');
          const part = alt.value ? ` ${alt.value} ` : '';
          raw += part.slice(0, left);
          if (alt.truncated || part.length > left) return { value: normalize(raw), truncated: true };
        }
      }
      return { value: normalize(raw), truncated: false };
    }
    const attribute = (el, attr) => {
      const raw = el.getAttribute(attr) ?? '';
      return { value: normalize(raw.slice(0, contentCap)), truncated: raw.length > contentCap };
    };
    function controlName(el) {
      const ids = el.getAttribute('aria-labelledby') ?? '';
      if (ids.length > contentCap) return { value: '', truncated: true };
      const parts = ids.split(/[\t\n\f\r ]+/).filter(Boolean);
      if (parts.length > 8) return { value: '', truncated: true };
      const names = [];
      let truncated = false;
      for (const id of parts) {
        const label = document.getElementById(id);
        if (!label || !root.contains(label) || !safe(label) || label.closest('[hidden],[aria-hidden=true i]')) continue;
        const part = content(label);
        if (part.value) names.push(part.value);
        truncated ||= part.truncated;
      }
      if (names.length || truncated) return { value: names.join(' '), truncated };
      const aria = attribute(el, 'aria-label');
      if (aria.value || aria.truncated) return aria;
      if (el.labels?.length > 8) return { value: '', truncated: true };
      for (const label of el.labels ?? []) {
        if (!root.contains(label) || !safe(label) || label.closest('[hidden],[aria-hidden=true i]')) continue;
        const part = content(label, el.matches('input[type=radio]') && controlRole(el) === 'radio');
        if (part.value) names.push(part.value);
        truncated ||= part.truncated;
      }
      if (names.length || truncated) return { value: names.join(' '), truncated };
      if (el.localName === 'input') {
        if (el.type === 'image') return attribute(el, 'alt');
        if (['button', 'submit', 'reset'].includes(el.type)) return attribute(el, 'value');
      }
      const text = content(el);
      if (text.value || text.truncated) return text;
      const placeholder = attribute(el, 'placeholder');
      return placeholder.value || placeholder.truncated ? placeholder : attribute(el, 'title');
    }
    function radioProxy(input) {
      if (!input.matches('input[type=radio]') || input.labels.length > 8) return;
      for (const label of input.labels) {
        const valid = (hit = label) => {
          if (input.getRootNode() !== document || label.getRootNode() !== document
            || !root.contains(input) || !root.contains(label) || label.control !== input
            || input.type !== 'radio' || controlRole(input) !== 'radio' || !safe(input)
            || input.closest(`${hidden},${disabled}`) || !input.checkVisibility({ visibilityProperty: true })
            || !safe(label) || label.closest(`[hidden],${disabled}`) || !visible(label)
            || !label.contains(hit) || hit.closest('label') !== label || !safe(hit) || hit.closest(disabled)) return false;
          // Interactive descendants have their own activation behavior, not the label's.
          return !hit.closest('a[href],area[href],button,input,select,textarea,summary,[contenteditable]:not([contenteditable=false])');
        };
        const { width, height } = label.getBoundingClientRect();
        if (width > 0 && height > 0 && valid()) return { label, valid };
      }
    }
    const targets = [];
    const proxies = new Map();
    const controls = [];
    let count = 0;
    let namesTruncated = false;
    const prune = (node) => node.nodeType === 1 && node.matches(`${protectedElements},[hidden],[aria-hidden=true i],script,style,noscript,template,option`);
    for (const node of walk(root, prune)) {
      if (node.nodeType === 3 && !unique && !textTruncated && !node.parentElement.matches(omitText) && visible(node.parentElement)) {
        const left = contentCap - text.length;
        const chunk = normalize(node.substringData(0, contentCap));
        const next = text && chunk ? ' ' + chunk : chunk;
        text += next.slice(0, left);
        textTruncated = node.length > contentCap || next.length > left;
      }
      if (node.nodeType !== 1) continue;
      const kind = controlRole(node);
      if (!kind || (wantedRole && kind !== wantedRole) || !safe(node) || node.closest(disabled)) continue;
      const proxy = kind === 'radio' && radioProxy(node);
      if (!visible(node) && !proxy) continue;
      if (!unique && ++count > 100) continue;
      const label = controlName(node);
      if (unique) {
        if (label.truncated) throw new Error('Control name scan limit exceeded; cannot establish uniqueness');
        if (label.value !== wantedName) continue;
        if (targets.length) throw new Error('Exact control match is ambiguous');
      } else {
        controls.push({ ref: '@r' + (targets.length + 1), role: kind, name: label.value.slice(0, 150) });
        namesTruncated ||= label.truncated || label.value.length > 150;
      }
      targets.push(node);
      if (proxy) proxies.set(node, proxy);
    }
    if (unique && !targets.length) throw new Error('No exact control match');
    const title = unique ? '' : String(state.title() ?? '');
    const value = unique ? { ref: '@r1' } : {
      title: title.slice(0, 200), text, controls, count,
      truncated: { title: title.length > 200, text: textTruncated, controls: count > controls.length, names: namesTruncated },
    };
    assertDocument();
    if (expected) {
      if (targets[0] !== expected.node || proxies.get(targets[0])?.label !== expected.label) {
        throw new Error('Exact control changed during find');
      }
    } else {
      (state.radioProxies ??= new WeakMap()).set(targets, proxies);
      if (unique) {
        const match = { node: targets[0], label: proxies.get(targets[0])?.label };
        state.find = { targets, ticket, verify: () => scopedSnapshotInPage(origin, overlayKey, operation, payload, match) };
      } else state.targets = targets;
    }
    return { ok: true, value };
  } catch (error) {
    return { error: error.message };
  }
}
