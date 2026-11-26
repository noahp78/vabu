const ref = (value) => /^@r[1-9]\d{0,2}$/.test(value);
const integer = (value) => /^-?\d{1,5}$/.test(value);
const buttons = new Map([['left', [0, 1]], ['middle', [1, 4]], ['right', [2, 2]]]);
const modifierNames = { Alt: 'altKey', Control: 'ctrlKey', Meta: 'metaKey', Shift: 'shiftKey' };

function modifiers(names) {
  if (new Set(names).size !== names.length || names.some((name) => !Object.hasOwn(modifierNames, name))) {
    throw new Error('Use distinct Alt, Control, Meta or Shift modifiers');
  }
  return Object.fromEntries(names.map((name) => [modifierNames[name], true]));
}

function target(args) {
  if (args.length === 1 && ref(args[0])) return { ref: args[0] };
  if (args.length === 2 && args.every(integer)) return { x: Number(args[0]), y: Number(args[1]) };
  throw new Error('Expected a fresh @r reference or two viewport coordinates');
}

async function run(ctx, action, preview = false) {
  await ctx.assertCurrent();
  if (!preview) return ctx.page('interaction', 'apply', action);
  const ticket = crypto.randomUUID();
  const point = await ctx.page('interaction', 'preview', { ...action, ticket });
  await ctx.waitForCursor();
  await ctx.assertCurrent();
  await ctx.page('interaction', 'commit', ticket);
  return point;
}

export const commands = {
  'cursor-move': async (args, ctx) => run(ctx, { kind: 'move', start: target(args) }),
  'mouse-click': async ([button, chord, ...args], ctx) => {
    if (!buttons.has(button) || chord === undefined) throw new Error('Expected BUTTON MODIFIERS TARGET (use - for none)');
    const keys = modifiers(chord === '-' ? [] : chord.split('+'));
    return run(ctx, { kind: 'click', start: target(args), button: buttons.get(button), keys, count: 1 }, true);
  },
  'double-click': async (args, ctx) => run(ctx, { kind: 'click', start: target(args), button: buttons.get('left'), count: 2 }, true),
  drag: async (args, ctx) => {
    if (args.length !== 4 || !args.every(integer)) throw new Error('Expected drag X1 Y1 X2 Y2');
    const start = target(args.slice(0, 2));
    const end = target(args.slice(2));
    if (start.x === end.x && start.y === end.y) throw new Error('Drag requires distinct points');
    return run(ctx, { kind: 'drag', start, end }, true);
  },
  wheel: async ([dx, dy, ...args], ctx) => {
    if (!integer(dx) || !integer(dy)) throw new Error('Expected wheel DX DY [TARGET]');
    return run(ctx, { kind: 'wheel', dx: Number(dx), dy: Number(dy), start: args.length ? target(args) : null });
  },
  keypress: async ([chord, ...rest], ctx) => {
    if (!chord || rest.length) throw new Error('Expected a key or chord such as Control+Shift+A');
    const names = chord.split('+');
    const key = names.pop();
    if (!/^[!-~]$|^(Enter|Escape|Tab|Space|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(Left|Right|Up|Down)|F([1-9]|1[0-2]))$/.test(key)) {
      throw new Error('Unsupported key');
    }
    return run(ctx, { kind: 'key', key: key === 'Space' ? ' ' : key, keys: modifiers(names) });
  },
  'insert-text': async ([text, ...rest], ctx) => {
    if (!text || text.length > 4000 || rest.length) throw new Error('Expected nonempty text (4000 characters max)');
    return run(ctx, { kind: 'insert', text });
  },
  fill: async ([reference, text, ...rest], ctx) => {
    if (!ref(reference) || text === undefined || text.length > 4000 || rest.length) throw new Error('Expected fill @rN TEXT (4000 characters max)');
    return run(ctx, { kind: 'fill', ref: reference, text });
  },
  'select-option': async ([reference, value, ...rest], ctx) => {
    if (!ref(reference) || value === undefined || value.length > 4000 || rest.length) throw new Error('Expected select-option @rN VALUE');
    return run(ctx, { kind: 'select', ref: reference, value });
  },
  'set-checked': async ([reference, checked, ...rest], ctx) => {
    if (!ref(reference) || !['true', 'false'].includes(checked) || rest.length) throw new Error('Expected set-checked @rN true|false');
    return run(ctx, { kind: 'checked', ref: reference, checked: checked === 'true' });
  },
};

// Self-contained for chrome.scripting.executeScript in the isolated top document.
// Reuses the existing overlay, waitCursor, and snapshot refs; never calls native coordinate input.
// shortcut: synthetic input only, upgrade if Chrome exposes trusted dispatch bound to a checked DOM target.
export function interactionInPage(origin, overlayKey, phase, payload) {
  const ok = (value) => ({ ok: true, value });
  const fail = (error) => ({ error });
  const state = globalThis.vabuCursorState;
  if (window !== window.top || location.origin !== origin || state?.key !== overlayKey || !state.host.isConnected) {
    return fail('Interaction document changed');
  }
  const blocked = 'iframe, frame, embed, object, fencedframe, portal, input[type=file], input[type=password], [inert], :disabled';
  const safe = (element) => {
    if (!element?.isConnected || element.ownerDocument !== document || element.closest(blocked)
      || element.closest('label')?.control?.closest(blocked)) throw new Error('Unavailable, framed, disabled or protected target');
    return element;
  };
  const lookup = (reference) => {
    const element = safe(state.targets?.[Number(reference.slice(2)) - 1]);
    if (!element.checkVisibility({ visibilityProperty: true })) throw new Error('Snapshot control is not visible');
    return element;
  };
  const hit = ({ x, y }) => {
    if (!(x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) throw new Error('Coordinates outside the viewport');
    return safe(document.elementFromPoint(x, y));
  };
  const resolve = (point, selection) => {
    if (!point) return state.point ?? { x: innerWidth / 2, y: innerHeight / 2 };
    if (!point.ref) return point;
    let element = lookup(point.ref);
    const proxy = selection && state.radioProxies?.get(state.targets)?.get(element);
    if (proxy) {
      if (!proxy.valid()) throw new Error('Radio label changed; take a fresh snapshot');
      selection.binding = proxy;
    }
    const center = () => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      return { x: (Math.max(left, 0) + Math.min(right, innerWidth)) / 2, y: (Math.max(top, 0) + Math.min(bottom, innerHeight)) / 2 };
    };
    let { x, y } = center();
    if (proxy && (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      || !element.contains(document.elementFromPoint(x, y)))) {
      element = proxy.label;
      selection.proxy = proxy;
      ({ x, y } = center());
    }
    if (!element.contains(document.elementFromPoint(x, y))) {
      element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      ({ x, y } = center());
    }
    const target = hit({ x, y });
    if (!element.contains(target) || (selection?.proxy && !selection.proxy.valid(target))) {
      throw new Error('Snapshot control is covered or unavailable');
    }
    return { x, y };
  };
  const cursor = (point, ring) => {
    state.cursor.firstElementChild.setAttribute('opacity', ring ? '1' : '0');
    for (const [name, value] of Object.entries({ display: 'block',
      transition: matchMedia('(prefers-reduced-motion: no-preference)').matches ? 'transform 180ms ease-out' : 'none',
      transform: `translate(${point.x - 12}px, ${point.y - 12}px)`,
    })) state.cursor.style.setProperty(name, value, 'important');
    state.point = point;
  };
  const fire = (element, event) => safe(element).dispatchEvent(event);
  const event = { bubbles: true, cancelable: true, composed: true };
  const mouse = (point, options) => ({ ...event, clientX: point.x, clientY: point.y, ...options });
  const send = (element, type, point, options) => fire(element, type.startsWith('pointer')
    ? new PointerEvent(type, { ...mouse(point, options), pointerId: 1, pointerType: 'mouse', isPrimary: true })
    : new MouseEvent(type, mouse(point, options)));
  const activation = (element) => {
    const label = element.closest('label');
    const control = label?.control ?? element.closest('input, button, select, textarea, summary');
    const link = element.closest('a, area');
    const form = control?.form;
    const base = document.querySelector('base[target]')?.getAttribute('target');
    const linkTarget = (link?.getAttribute('target') ?? base ?? '').toLowerCase();
    const formTarget = (control?.getAttribute('formtarget') ?? form?.getAttribute('target') ?? base ?? '').toLowerCase();
    const href = link?.hasAttribute('href') ? new URL(link.getAttribute('href'), document.baseURI).href : null;
    const actionAttr = control?.getAttribute('formaction') ?? form?.getAttribute('action');
    const action = form ? new URL(actionAttr || location.href, document.baseURI).href : null;
    if ((link && (link.hasAttribute('download') || !['', '_self'].includes(linkTarget) || (href && !/^https?:/i.test(href)))) ||
        (form && ['submit', 'image'].includes(control.type) && (!['', '_self'].includes(formTarget) || !/^https?:/i.test(action)))) {
      throw new Error('Unsupported link or form destination');
    }
    return [element, label, control, control?.type, link, href, linkTarget, form, action, formTarget,
      control?.getAttribute('formmethod'), control?.getAttribute('formenctype'), form?.getAttribute('method'), form?.getAttribute('enctype')];
  };
  const checkedHit = (saved) => {
    const element = hit(saved.point);
    if (element !== saved.element || (saved.binding && !saved.binding.valid(saved.proxy ? element : undefined))
      || (saved.signature && activation(element).some((value, i) => value !== saved.signature[i]))) {
      throw new Error('Target changed during interaction; take a fresh snapshot');
    }
    return element;
  };

  try {
    if (phase === 'preview') {
      delete state.interactionPreview;
      const selection = payload.kind === 'click' ? {} : undefined;
      const start = resolve(payload.start, selection);
      const points = [start];
      if (payload.kind === 'drag') {
        const { x, y } = resolve(payload.end);
        for (let i = 1; i <= 12; i++) points.push({ x: start.x + (x - start.x) * i / 12, y: start.y + (y - start.y) * i / 12 });
      } else if (payload.kind !== 'click') throw new Error('Invalid interaction preview');
      const path = points.map((point) => {
        const element = hit(point);
        return { point, element, binding: selection?.binding, proxy: selection?.proxy,
          signature: payload.kind === 'click' ? activation(element) : null };
      });
      state.interactionPreview = { action: payload, path, snapshot: payload.start.ref ? state.targets : null };
      cursor(start, true);
      return ok(start);
    }
    if (phase === 'commit') {
      const preview = state.interactionPreview;
      delete state.interactionPreview;
      if (!preview || preview.action.ticket !== payload) throw new Error('Interaction preview expired');
      const { action, path } = preview;
      const start = path[0];
      cursor(start.point, false);
      if (preview.snapshot && (state.targets !== preview.snapshot
        || !(start.proxy?.label ?? lookup(action.start.ref)).contains(start.element))) {
        throw new Error('Snapshot changed during interaction');
      }
      for (const step of path) checkedHit(step);
      const [button, buttons] = action.button ?? [0, 1];
      const emit = (step, type, held, detail) => send(checkedHit(step), type, step.point, { ...action.keys, button, buttons: held, detail });
      for (let detail = 1; detail <= (action.count ?? 1); detail++) {
        const focus = emit(start, 'pointerdown', buttons, 0) && emit(start, 'mousedown', buttons, detail);
        if (focus && action.kind === 'click' && button === 0 && !Object.values(action.keys ?? {}).some(Boolean)) {
          const focusable = checkedHit(start).closest('a[href], button, input, textarea, select, summary');
          if (focusable) safe(focusable).focus({ preventScroll: true });
        }
        for (const step of path.slice(1)) {
          emit(step, 'pointermove', buttons, 0);
          emit(step, 'mousemove', buttons, 0);
        }
        const end = path.at(-1);
        emit(end, 'pointerup', 0, 0);
        emit(end, 'mouseup', 0, detail);
        if (action.kind === 'click') {
          if (button === 0) emit(end, 'click', 0, detail);
          else {
            emit(end, button === 2 ? 'contextmenu' : 'auxclick', 0, detail);
            if (button === 2) emit(end, 'auxclick', 0, detail);
          }
        } else cursor(end.point, false);
      }
      if (action.count === 2) emit(start, 'dblclick', 0, 2);
      return ok(true);
    }
    if (phase !== 'apply') throw new Error('Invalid interaction operation');
    if (payload.kind === 'move' || payload.kind === 'wheel') {
      const point = resolve(payload.start);
      const element = hit(point);
      cursor(point, false);
      if (payload.kind === 'move') {
        send(element, 'pointermove', point);
        send(checkedHit({ point, element }), 'mousemove', point);
        return ok(point);
      }
      if (fire(element, new WheelEvent('wheel', { ...mouse(point), deltaX: payload.dx, deltaY: payload.dy }))) {
        safe(element);
        for (const [axis, delta] of [['X', payload.dx], ['Y', payload.dy]]) {
          if (!delta) continue;
          const scroll = axis === 'X' ? 'left' : 'top';
          const size = axis === 'X' ? 'Width' : 'Height';
          for (let node = element; node; node = node.parentElement) {
            if (node === document.scrollingElement ||
              (/^(auto|scroll)$/.test(getComputedStyle(node)['overflow' + axis]) && node['scroll' + size] > node['client' + size])) {
              const before = node[axis === 'X' ? 'scrollLeft' : 'scrollTop'];
              node.scrollBy({ [scroll]: delta, behavior: 'instant' });
              if (node[axis === 'X' ? 'scrollLeft' : 'scrollTop'] !== before || getComputedStyle(node)['overscrollBehavior' + axis] !== 'auto') break;
            }
          }
        }
      }
      return ok(true);
    }

    const field = payload.ref ? lookup(payload.ref) : safe(document.activeElement);
    if (payload.kind === 'key') {
      const keys = { Alt: 'altKey', Control: 'ctrlKey', Meta: 'metaKey', Shift: 'shiftKey' };
      const held = {};
      const keyEvent = (type, key) => fire(field, new KeyboardEvent(type, { ...event, ...held, key }));
      const names = Object.keys(keys).filter((name) => payload.keys[keys[name]]);
      for (const name of names) { held[keys[name]] = true; keyEvent('keydown', name); }
      keyEvent('keydown', payload.key);
      keyEvent('keyup', payload.key);
      for (const name of names.reverse()) { held[keys[name]] = false; keyEvent('keyup', name); }
      return ok(true);
    }
    if (payload.kind === 'select' || payload.kind === 'checked') {
      if (payload.kind === 'select') {
        if (!(field instanceof HTMLSelectElement) || field.multiple) throw new Error('Expected a single-select control');
        const matches = Array.from(field.options).filter((option) => option.value === payload.value);
        if (matches.length !== 1 || matches[0].closest(':disabled')) throw new Error('Option is missing, ambiguous or disabled');
        if (field.selectedIndex === matches[0].index) return ok(true);
        field.selectedIndex = matches[0].index;
      } else {
        if (!field.matches('input[type=checkbox], input[type=radio]') || (field.type === 'radio' && !payload.checked)) {
          throw new Error('Expected a checkbox, or a radio to check');
        }
        if (field.checked === payload.checked) return ok(true);
        field.checked = payload.checked;
      }
      fire(field, new Event('input', { bubbles: true, composed: true }));
      fire(field, new Event('change', { bubbles: true }));
      return ok(true);
    }
    if (!['insert', 'fill'].includes(payload.kind)) throw new Error('Unsupported interaction operation');
    const editable = field.isContentEditable;
    const textControl = field instanceof HTMLTextAreaElement || (field.localName === 'input' && ['text', 'search', 'url', 'tel', 'email', 'number'].includes(field.type));
    if (!(editable || textControl) || field.readOnly) throw new Error('Expected an editable non-protected text field');
    const inserting = payload.kind === 'insert';
    const edit = { ...event, inputType: inserting ? 'insertText' : 'insertReplacementText', data: payload.text };
    const validate = () => {
      safe(field);
      if ((!payload.ref && document.activeElement !== field) || (payload.ref && lookup(payload.ref) !== field)
        || field.readOnly || editable !== field.isContentEditable) throw new Error('Text field changed during edit');
    };
    const type = field.type;
    if (!fire(field, new InputEvent('beforeinput', edit))) return ok(false);
    validate();
    if (type !== field.type) throw new Error('Text field changed during edit');
    if (editable) {
      if (!inserting) {
        if (field.querySelector(`${blocked}, [contenteditable=false]`)) throw new Error('Replacement crosses protected or noneditable content');
        field.textContent = payload.text;
      } else {
        const selection = document.getSelection();
        if (!selection?.rangeCount) throw new Error('Place the caret inside the text field first');
        const range = selection.getRangeAt(0);
        if (!field.contains(range.startContainer) || !field.contains(range.endContainer) ||
          [range.startContainer, range.endContainer].some((node) => !(node.nodeType === 1 ? node : node.parentElement)?.isContentEditable)) {
          throw new Error('Selection is outside editable content');
        }
        for (const node of field.querySelectorAll(`${blocked}, [contenteditable=false]`)) {
          if (range.intersectsNode(node)) throw new Error('Selection crosses protected or noneditable content');
        }
        range.deleteContents();
        const text = document.createTextNode(payload.text);
        range.insertNode(text);
        selection.collapse(text, text.length);
      }
    } else {
      const first = inserting ? field.selectionStart : 0;
      const last = inserting ? field.selectionEnd : field.value.length;
      if (first === null || last === null) throw new Error('This field does not support caret insertion; use fill');
      const value = field.value.slice(0, first) + payload.text + field.value.slice(last);
      if (field.maxLength >= 0 && value.length > field.maxLength) throw new Error('Text exceeds the field maxlength');
      const candidate = document.createElement(field.localName);
      if (field.localName === 'input') candidate.type = field.type;
      candidate.value = value;
      if (candidate.value !== value) throw new Error('Text cannot be represented by this field without changes');
      field.value = value;
      if (inserting) field.setSelectionRange(first + payload.text.length, first + payload.text.length);
    }
    fire(field, new InputEvent('input', { ...edit, cancelable: false }));
    if (!inserting && !editable) fire(field, new Event('change', { bubbles: true }));
    return ok(true);
  } catch (error) {
    return fail(error.message);
  }
}
