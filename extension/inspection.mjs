const locatorKinds = ['css', 'role', 'text', 'name', 'label', 'testid', 'ref'];
const refPattern = /^@i[\da-f-]{36}:[1-9]\d?$/;
const only = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj)
  && Object.keys(obj).every((key) => keys.includes(key));

export function selector(input) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Expected a bounded JSON locator');
  let spec;
  try { spec = JSON.parse(input); } catch { throw new Error('Invalid JSON locator'); }
  if (only(spec, ['css', 'selector']) && Object.keys(spec).length === 1) {
    spec = { all: [{ by: 'css', value: spec.css ?? spec.selector }] };
  }
  const locator = (item) => {
    if (!only(item, ['by', 'value']) || !locatorKinds.includes(item.by)
      || typeof item.value !== 'string' || !item.value.trim() || item.value.length > 256
      || (item.by === 'ref' && !refPattern.test(item.value))) throw new Error('Invalid typed locator');
    let value = item.value.trim();
    if (item.by === 'css') {
      const compound = /^(?:[a-zA-Z][\w-]*|\*)?(?:[.#][a-zA-Z_][\w-]*)*$/;
      // Allow structural attributes only; never compare arbitrary DOM attribute values.
      const dataPresence = /\[data-[a-z][a-z0-9_-]*\]/gi;
      const inputAttribute = /\[(?:type=(?:[a-z][\w-]*|"[a-z][\w-]*"|'[a-z][\w-]*')|name\^=(?:[a-z_][\w-]*|"[a-z_][\w-]*"|'[a-z_][\w-]*'))\]/gi;
      value = value.replace(/\s*>\s*/g, '>').replace(/\s+/g, ' ');
      const valid = (part) => {
        if (!part) return false;
        const withoutData = part.replace(dataPresence, '.vacu-attribute');
        const structural = /^input(?=[.#\[])/i.test(part)
          ? withoutData.replace(inputAttribute, '.vacu-attribute') : withoutData;
        return compound.test(structural);
      };
      if (!value.split(/[> ]/).every(valid)) {
        throw new Error('CSS locator supports only tags, IDs, classes, [data-*] presence, input[type=…], input[name^=…], and descendant/child combinators');
      }
    }
    if (['name', 'label', 'text'].includes(item.by)) value = value.replace(/\s+/g, ' ');
    return { by: item.by, value };
  };
  if (!only(spec, ['all', 'within', 'visible', 'enabled']) || !Array.isArray(spec.all)
    || spec.all.length < 1 || spec.all.length > 8
    || ['visible', 'enabled'].some((key) => key in spec && typeof spec[key] !== 'boolean')) {
    throw new Error('Expected {all:[{by,value}], within?, visible?, enabled?}');
  }
  return { ...spec, all: spec.all.map(locator), ...('within' in spec ? { within: locator(spec.within) } : {}) };
}

function positive(value, max, name, min = 1) {
  const number = Number(value);
  if (!/^\d{1,10}$/.test(value) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

function frameArg(args) {
  if (args[0] !== '--frame') return [0, undefined, args];
  if (typeof args[2] !== 'string' || !/^[a-zA-Z\d_-]{16,80}$/.test(args[2])) {
    throw new Error('Frame scope requires a current document ID');
  }
  return [positive(args[1], 2147483647, 'frame ID'), args[2], args.slice(3)];
}

function requireCapability(target, name) {
  if (typeof target?.[name] !== 'function') throw new Error(`Unsupported inspection capability: ${name}`);
  return target[name].bind(target);
}

// The adapter pins the document ID and full approved ancestor chain even for frame 0.
async function scoped(ctx, frameId, documentId) {
  await ctx.assertCurrent();
  const scope = await requireCapability(ctx, 'inspectionScope')(frameId, documentId);
  if (documentId !== undefined && scope?.documentId !== documentId) throw new Error('Stale frame document');
  const assert = requireCapability(scope, 'assertCurrent');
  await ctx.assertCurrent();
  await assert();
  return {
    assert: async () => { await ctx.assertCurrent(); await assert(); },
    run: (op, payload) => requireCapability(scope, 'run')(op, payload),
    dialog: (request) => requireCapability(scope, 'dialog')(request),
    capture: (request) => requireCapability(scope, 'captureGuarded')(request),
  };
}

async function inspect(args, ctx, operation) {
  const [frame, documentId, terms] = frameArg(args);
  if (terms.length !== 1) throw new Error(`Usage: inspect-${operation} [--frame ID DOCUMENT_ID] LOCATOR_JSON`);
  const spec = selector(terms[0]);
  const scope = await scoped(ctx, frame, documentId);
  await scope.assert();
  const result = await scope.run(operation, spec);
  await scope.assert();
  return result;
}

async function bounded(ms, run) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Inspection wait timed out'));
          controller.abort();
        }, ms);
      }),
      run(controller.signal),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function wait(args, ctx) {
  const [frame, documentId, terms] = frameArg(args);
  const [event, timeout, json] = terms;
  const locatorEvent = ['visible', 'hidden'].includes(event);
  if (terms.length !== (locatorEvent ? 3 : 2)
    || !['visible', 'hidden', 'domcontentloaded', 'load', 'dialog'].includes(event)
    || (event === 'dialog' && frame !== 0)) throw new Error('Invalid inspect-wait event or scope');
  const ms = positive(timeout, 15000, 'timeout (ms)');
  const spec = locatorEvent ? selector(json) : undefined;
  if (spec && 'visible' in spec) throw new Error('Visibility waits cannot also filter visibility');
  return bounded(ms, async (signal) => {
    const scope = await scoped(ctx, frame, documentId);
    await scope.assert();
    signal.throwIfAborted();
    if (event === 'dialog') {
      const result = await scope.dialog({ action: 'wait', signal });
      await scope.assert();
      signal.throwIfAborted();
      return dialogInfo(result);
    }
    while (!signal.aborted) {
      await scope.assert();
      signal.throwIfAborted();
      const ready = await scope.run('condition', { event, spec });
      await scope.assert();
      signal.throwIfAborted();
      if (ready === true) return { event };
      if (ready !== false) throw new Error('Invalid inspection wait response');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    signal.throwIfAborted();
  });
}

function dialogInfo(result) {
  if (!result || !['alert', 'confirm', 'prompt', 'beforeunload'].includes(result.type)
    || typeof result.id !== 'string' || !/^[a-zA-Z\d_-]{16,80}$/.test(result.id)) throw new Error('No current supported dialog');
  return { id: result.id, type: result.type };
}

async function dialog(args, ctx) {
  const [action, id] = args;
  if (!(action === 'show' && args.length === 1)
    && !(['accept', 'dismiss'].includes(action) && args.length === 2 && /^[a-zA-Z\d_-]{16,80}$/.test(id))) {
    throw new Error('Usage: inspect-dialog show | accept ID | dismiss ID');
  }
  const scope = await scoped(ctx, 0);
  await scope.assert();
  const result = await scope.dialog({ action, id });
  await scope.assert();
  if (action === 'show') return dialogInfo(result);
  if (result !== true) throw new Error('Dialog was not handled');
  return { handled: true };
}

async function screenshot(args, ctx) {
  const [mode, ...terms] = args;
  let request;
  if (mode === 'page' && terms.length === 0) request = { mode };
  else if (mode === 'clip' && terms.length === 4) {
    const [x, y, width, height] = terms.map((arg, i) => positive(arg, 16384, 'clip coordinate or size', i < 2 ? 0 : 1));
    if (width * height > 16000000) throw new Error('Screenshot clip is too large');
    request = { mode, clip: { x, y, width, height } };
  } else if (mode === 'annotated' && terms.length === 1) request = { mode, spec: selector(terms[0]) };
  else throw new Error('Usage: inspect-screenshot page | clip X Y WIDTH HEIGHT | annotated LOCATOR_JSON');
  const scope = await scoped(ctx, 0);
  await scope.assert();
  if (request.spec) {
    request.annotation = await scope.run('annotation', request.spec);
    await scope.assert();
  }
  // A before/after frame-tree check alone cannot secure compositor capture.
  const result = await scope.capture(request);
  await scope.assert();
  if (typeof result?.data !== 'string' || result.data.length > 24000000 || !/^\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(result.data)) {
    throw new Error('No valid guarded JPEG screenshot');
  }
  return { format: 'jpeg', data: result.data };
}

async function clickFrame(args, ctx) {
  const [frame, documentId, terms] = frameArg(args);
  if (!frame || terms.length !== 1 || !refPattern.test(terms[0])) {
    throw new Error('Usage: inspect-click --frame ID DOCUMENT_ID @iREF');
  }
  const scope = await scoped(ctx, frame, documentId);
  await scope.assert();
  const result = await scope.run('click', terms[0]);
  await scope.assert();
  return result;
}

export const commands = {
  'inspect-click': clickFrame,
  'inspect-query': (args, ctx) => inspect(args, ctx, 'query'),
  'inspect-element': (args, ctx) => inspect(args, ctx, 'element'),
  'inspect-wait': wait,
  'inspect-screenshot': screenshot,
  'inspect-dialog': dialog,
};

// Self-contained fixed function for chrome.scripting.executeScript, ISOLATED world only.
export function inspectionPage(origin, key, operation, spec, ancestors, href) {
  try {
    if (typeof key !== 'string' || !key || !/^https?:$/.test(location.protocol)
      || location.origin !== origin || globalThis.origin !== origin) {
      throw new Error('Inspection document is not authorized');
    }
    // shortcut: light DOM and a subset of roles/names, use a reviewed scoped AX adapter for full accessible names.
    const visible = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
    const enabled = (el) => !el.matches(':disabled') && !el.closest('[inert], [aria-disabled="true"]');
    const safe = (el) => !el.closest('script,style,noscript,template,iframe,frame,fencedframe,object,embed,input[type=password i],input[type=file i]');
    const plain = (str) => str?.slice(0, 2048).replace(/\s+/g, ' ').trim() ?? '';
    const text = (el) => visible(el) ? plain(el.innerText) : '';
    const label = (el) => plain(Array.from(el.labels ?? [], text).join(' '));
    const name = (el) => plain(el.getAttribute('aria-label')) || label(el) || text(el)
      || plain(el.getAttribute('alt')) || plain(el.getAttribute('title'));
    const role = (el) => {
      const implicitRoles = {
        a: el.hasAttribute('href') ? 'link' : '', button: 'button', textarea: 'textbox',
        select: el.multiple || el.size > 1 ? 'listbox' : 'combobox', img: 'img', dialog: 'dialog',
        input: ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button',
          text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox', search: 'searchbox', number: 'spinbutton' })[el.type],
        h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      };
      return el.getAttribute('role')?.trim().split(/\s+/, 1)[0]
        || (Object.hasOwn(implicitRoles, el.localName) ? implicitRoles[el.localName] : '') || '';
    };
    const ok = (value) => ({ ok: true, value });
    // The adapter key includes the selection and navigation epoch, including same-document navigation.
    const state = globalThis.vacuInspectionState;
    const resolveRef = (value) => {
      const [generation, index] = value.slice(2).split(':');
      const el = state?.refs[Number(index) - 1];
      if (!state || state.key !== key || state.href !== location.href || state.generation !== generation
        || !el?.isConnected || el.ownerDocument !== document || !safe(el)) {
        throw new Error('Stale inspection reference; query again');
      }
      return el;
    };
    const checkedMatches = (terms, root) => {
      const refs = new Map(terms.filter(({ by }) => by === 'ref').map(({ value }) => [value, resolveRef(value)]));
      const css = terms.find(({ by }) => by === 'css')?.value;
      const pool = refs.size ? [refs.values().next().value] : root.querySelectorAll(css ?? '*');
      if (pool.length > 20000) throw new Error('Inspection candidate limit exceeded; narrow the locator');
      return Array.from(pool).filter((el) => root !== el && root.contains(el) && safe(el)
        && terms.every(({ by, value }) => {
          switch (by) {
            case 'css': return el.matches(value);
            case 'role': return role(el) === value;
            case 'text': return text(el) === value;
            case 'name': return name(el) === value;
            case 'label': return label(el) === value;
            case 'testid': return el.getAttribute('data-testid') === value;
            case 'ref': return refs.get(value) === el;
            default: throw new Error('Unsupported locator type');
          }
        }));
    };
    function unique(matches, allowMissing = false) {
      if (matches.length > 1) throw new Error('Ambiguous locator');
      if (!matches.length && !allowMissing) throw new Error('No matching element');
      return matches[0];
    }
    function find({ within, all, visible: show, enabled: active }) {
      const root = within ? unique(checkedMatches([within], document)) : document;
      return checkedMatches(all, root).filter((el) => (show === undefined || show === visible(el))
        && (active === undefined || active === enabled(el)));
    }
    function metadata(el) {
      const { x, y, width, height } = el.getBoundingClientRect();
      return { tag: el.localName, role: role(el), name: name(el).slice(0, 150), text: text(el).slice(0, 500),
        visible: visible(el), enabled: enabled(el), rect: { x, y, width, height } };
    }
    if (ancestors) {
      const actual = Array.from(location.ancestorOrigins ?? []);
      if (location.href !== href || (window === window.top) !== (ancestors.length === 0)
        || actual.length !== ancestors.length || actual.some((value, i) => value !== ancestors[i])) {
        throw new Error('Frame origin or ancestry could not be verified');
      }
    }
    const sameOriginChain = !ancestors || ancestors.every((value) => value === origin);
    const owners = [];
    if (sameOriginChain) {
      for (let current = window; current !== window.top; current = current.parent) {
        const frame = current.frameElement;
        if (current.origin !== origin || current.parent.origin !== origin || frame?.localName !== 'iframe'
          || frame.getRootNode() !== frame.ownerDocument || frame.hasAttribute('sandbox')
          || frame.hasAttribute('srcdoc') || !visible(frame)) throw new Error('Frame is not an authorized visible iframe');
        owners.push(frame);
      }
    }
    if (operation === 'scope' && ancestors) return ok(true);
    if (operation === 'click') {
      if (!sameOriginChain) throw new Error('Cross-origin frames are inspection-only; ancestor hit testing is unavailable');
      if (window === window.top) throw new Error('Frame required');
      const el = resolveRef(spec);
      if (!visible(el) || !enabled(el)) throw new Error('Frame control is hidden or disabled');
      const rect = el.getBoundingClientRect();
      const x = (Math.max(0, rect.left) + Math.min(innerWidth, rect.right)) / 2;
      const y = (Math.max(0, rect.top) + Math.min(innerHeight, rect.bottom)) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit) || !safe(hit) || !enabled(hit)) throw new Error('Frame control is covered or unavailable');
      let px = x;
      let py = y;
      for (const frame of owners) {
        const parent = frame.ownerDocument;
        // shortcut: refuse transformed/zoomed owners until their coordinate mapping is supported.
        for (let node = frame; node; node = node.parentElement) {
          const style = parent.defaultView.getComputedStyle(node);
          if (['transform', 'scale', 'rotate', 'translate', 'perspective', 'offsetPath'].some((prop) => style[prop] !== 'none')
            || !['normal', '1'].includes(style.zoom)) throw new Error('Frame coordinate mapping is not supported');
        }
        const style = parent.defaultView.getComputedStyle(frame);
        const box = frame.getBoundingClientRect();
        px += box.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
        py += box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
        if (!enabled(frame) || parent.elementFromPoint(px, py) !== frame) throw new Error('Frame control is covered or unavailable');
      }
      const labelControl = hit.closest('label')?.control;
      // Native label activation can focus its associated control, even for synthetic clicks.
      if (labelControl && (!labelControl.contains(hit) || !safe(labelControl) || !enabled(labelControl))) {
        throw new Error('Unsupported label control');
      }
      const control = labelControl ?? hit.closest('button,input,textarea');
      if (control?.form && ['image', 'submit', 'reset'].includes(control.type)) throw new Error('Frame form actions are not supported');
      if (control?.matches('input,textarea') && /(?:^|\s)(?:username|current-password|new-password|one-time-code|webauthn|cc-[\w-]+)(?:\s|$)/i.test(control.autocomplete)) {
        throw new Error('Credential or payment fields are not supported');
      }
      const anchor = hit.closest('a,area');
      if (anchor && anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        throw new Error('Frame link destination is not supported');
      }
      if (anchor?.hasAttribute('href')) {
        const target = anchor.getAttribute('target') || document.querySelector('base[target]')?.getAttribute('target') || '';
        const url = new URL(anchor.getAttribute('href'), document.baseURI);
        if (anchor.hasAttribute('download') || anchor.hasAttribute('ping') || !['', '_self'].includes(target.toLowerCase())
          || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
          throw new Error('Frame link destination is not supported');
        }
      }
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, detail: 1 }));
      return ok({ dispatched: true, trusted: false });
    }
    if (operation === 'condition') {
      const { event, spec: target } = spec;
      if (event === 'load') return ok(document.readyState === 'complete');
      if (event === 'domcontentloaded') {
        return ok(document.readyState === 'complete' || performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd > 0);
      }
      if (!['visible', 'hidden'].includes(event)) throw new Error('Unsupported wait condition');
      const el = unique(find(target), true);
      return ok(event === 'visible' ? !!el && visible(el) : !el || !visible(el));
    }
    if (operation === 'element') return ok(metadata(unique(find(spec))));
    if (operation === 'annotation') {
      const el = unique(find(spec));
      const { rect } = metadata(el);
      if (!visible(el) || rect.width <= 0 || rect.height <= 0) throw new Error('Annotation target is not visible');
      return ok({ ...rect, x: rect.x + scrollX, y: rect.y + scrollY });
    }
    if (operation === 'query') {
      const matches = find(spec);
      const refs = matches.slice(0, 50);
      const generation = crypto.randomUUID();
      const items = refs.map((el, i) => ({ ...metadata(el), ref: `@i${generation}:${i + 1}` }));
      globalThis.vacuInspectionState = { key, href: location.href, generation, refs };
      return ok({ count: matches.length, items, truncated: matches.length > refs.length });
    }
    throw new Error('Unsupported inspection operation');
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
