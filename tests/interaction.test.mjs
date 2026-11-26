import assert from 'node:assert/strict';
import test from 'node:test';
import { commands, interactionInPage } from '../extension/shared/interaction.mjs';

const origin = 'http://127.0.0.1:8888';

function fixture(t) {
  const log = [];
  const overlays = new Map();
  const doc = { querySelector: () => null, baseURI: `${origin}/`, createElement: () => ({}) };
  const top = {};
  top.top = top;
  class FakeEvent {
    constructor(type, options) { Object.assign(this, options, { type }); }
  }
  const element = (tag = 'div', type) => ({
    localName: tag, type, ownerDocument: doc, isConnected: true,
    closest(selector) {
      return selector.split(/,\s*/).some((part) => part === tag || part === `input[type=${this.type}]` ||
        (part === ':disabled' && this.disabled)) ? this : null;
    },
    contains(node) { return node === this; },
    checkVisibility: () => true,
    getBoundingClientRect: () => ({ left: 5, right: 15, top: 5, bottom: 15 }),
    getAttribute(name) { return this[name] ?? null; },
    hasAttribute(name) { return this.getAttribute(name) !== null; },
    dispatchEvent(event) { log.push({ target: this, event }); return !this.cancel?.(event); },
    focus() { doc.activeElement = this; },
    matches(selector) { return this.closest(selector) === this; },
  });
  const button = element('button');
  const field = Object.assign(element('input', 'text'), {
    value: 'abcd', selectionStart: 1, selectionEnd: 3, maxLength: 10,
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
  });
  const select = Object.assign(new (class Select {})(), element('select'), {
    options: [{ value: 'a', index: 0, closest: () => null }, { value: 'b', index: 1, closest: () => null }], selectedIndex: 0,
  });
  const state = {
    host: { isConnected: true }, key: 'overlay', targets: [button, field, select],
    cursor: { style: { setProperty: (key, value) => overlays.set(key, value) }, firstElementChild: {
      setAttribute: (key, value) => overlays.set(key, value),
    } },
  };
  doc.elementFromPoint = () => button;
  doc.activeElement = field;
  const globals = {
    vabuCursorState: state, document: doc, location: { origin }, window: top, innerWidth: 100, innerHeight: 100,
    matchMedia: () => ({ matches: false }), getComputedStyle: (node) => node.styles ?? {},
    Event: FakeEvent, MouseEvent: FakeEvent, PointerEvent: FakeEvent, KeyboardEvent: FakeEvent, WheelEvent: FakeEvent,
    InputEvent: FakeEvent, HTMLTextAreaElement: class {}, HTMLSelectElement: select.constructor,
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
  }
  const ctx = {
    async assertCurrent() {},
    async waitForCursor() {},
    async page(operation, phase, payload) {
      assert.equal(operation, 'interaction');
      const reply = interactionInPage(origin, 'overlay', phase, payload);
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
  };
  return { ctx, doc, button, field, select, element, overlays, log, state };
}

test('cursor arrives and renders click preview without focusing or pressing before commit', async (t) => {
  const { ctx, doc, button, field, overlays, log } = fixture(t);
  await commands['cursor-move'](['10', '10'], ctx);
  assert.equal(doc.activeElement, field);
  assert.deepEqual(log.splice(0).map(({ event }) => event.type), ['pointermove', 'mousemove']);
  ctx.waitForCursor = async () => {
    assert.equal(overlays.get('opacity'), '1');
    assert.equal(overlays.get('transition'), 'none');
    assert.equal(overlays.get('transform'), 'translate(-2px, -2px)');
    assert.equal(doc.activeElement, field);
    assert.equal(log.length, 0);
  };
  await commands['mouse-click'](['left', '-', '@r1'], ctx);
  assert.equal(doc.activeElement, button);
  assert.equal(overlays.get('opacity'), '0');
  assert.deepEqual(log.map(({ event }) => event.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
});

test('abort after navigation, changed hit, same-node href change, or iframe overlay', async (t) => {
  const { ctx, doc, element, button, log, state } = fixture(t);
  const click = () => commands['mouse-click'](['left', '-', '10', '10'], ctx);
  ctx.waitForCursor = async () => { location.origin = 'http://other.test'; };
  await assert.rejects(click(), /document changed/);
  location.origin = origin;
  ctx.waitForCursor = async () => { globalThis.vabuCursorState = { ...state }; delete globalThis.vabuCursorState.interactionPreview; };
  await assert.rejects(click(), /preview expired/);
  globalThis.vabuCursorState = state;
  ctx.waitForCursor = async () => { doc.elementFromPoint = () => element('button'); };
  await assert.rejects(click(), /Target changed/);
  const link = Object.assign(element('a'), { href: `${origin}/one` });
  doc.elementFromPoint = () => link;
  ctx.waitForCursor = async () => { link.href = `${origin}/two`; };
  await assert.rejects(click(), /Target changed/);
  doc.elementFromPoint = () => button;
  ctx.waitForCursor = async () => { doc.elementFromPoint = () => element('iframe'); };
  await assert.rejects(click(), /framed/);
  await assert.rejects(commands['cursor-move'](['10', '10'], ctx), /framed/);
  await assert.rejects(commands.wheel(['10', '0', '10', '10'], ctx), /framed/);
  assert.equal(log.length, 0);
});

test('a replacement snapshot invalidates a pending reference even when it contains the same control', async (t) => {
  const { ctx, state, log } = fixture(t);
  ctx.waitForCursor = async () => { state.targets = [...state.targets]; };
  await assert.rejects(commands['double-click'](['@r1'], ctx), /Snapshot changed/);
  assert.equal(log.length, 0);
});

test('radio click uses the pinned label without replacing the snapshot ref', async (t) => {
  const { ctx, doc, element, state, log } = fixture(t);
  const radio = element('input', 'radio');
  const label = element('label');
  label.control = radio;
  doc.elementFromPoint = () => label;
  state.targets = [radio];
  state.radioProxies = new WeakMap([[state.targets, new Map([[radio, {
    label, valid: (hit = label) => hit === label && label.control === radio,
  }]])]]);
  const click = () => commands['mouse-click'](['left', '-', '@r1'], ctx);
  await click();
  assert.equal(state.targets[0], radio);
  assert.deepEqual(log.map(({ target, event }) => [target, event.type]),
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].map((type) => [label, type]));
  log.length = 0;
  ctx.waitForCursor = async () => { label.control = element('input', 'radio'); };
  await assert.rejects(click(), /Target changed/);
  assert.equal(log.length, 0);
});

test('rejecting authorization during preview prevents commit', async (t) => {
  const { ctx, log } = fixture(t);
  ctx.waitForCursor = async () => { ctx.assertCurrent = async () => { throw new Error('revoked'); }; };
  await assert.rejects(commands['double-click'](['@r1'], ctx), /revoked/);
  assert.equal(log.length, 0);
});

test('mouse button masks, modifiers, and double click detail are distinct', async (t) => {
  const { ctx, doc, field, log } = fixture(t);
  await commands['mouse-click'](['right', 'Shift+Alt', '@r1'], ctx);
  assert.equal(doc.activeElement, field);
  assert.deepEqual(log.map(({ event: e }) => [e.type, e.button, e.buttons, e.shiftKey, e.altKey]), [
    ['pointerdown', 2, 2, true, true], ['mousedown', 2, 2, true, true], ['pointerup', 2, 0, true, true],
    ['mouseup', 2, 0, true, true], ['contextmenu', 2, 0, true, true], ['auxclick', 2, 0, true, true],
  ]);
  log.length = 0;
  await commands['mouse-click'](['middle', '-', '@r1'], ctx);
  assert.deepEqual(log.filter(({ event }) => ['mousedown', 'auxclick'].includes(event.type)).map(({ event: e }) => [e.button, e.buttons]), [[1, 4], [1, 0]]);
  log.length = 0;
  await commands['double-click'](['@r1'], ctx);
  assert.deepEqual(log.filter(({ event }) => ['click', 'dblclick'].includes(event.type)).map(({ event }) => [event.type, event.detail]), [
    ['click', 1], ['click', 2], ['dblclick', 2],
  ]);
});

test('drag delivers held moves and releases only on the revalidated path', async (t) => {
  const { ctx, doc, button, element, log } = fixture(t);
  const end = element();
  doc.elementFromPoint = (x) => x > 50 ? end : button;
  await commands.drag(['10', '10', '80', '80'], ctx);
  assert.equal(log.filter(({ event }) => event.type === 'pointermove' && event.buttons === 1).length, 12);
  assert.equal(log.at(-1).target, end);
  assert.equal(log.at(-1).event.buttons, 0);
  log.length = 0;
  const frame = element('iframe');
  ctx.waitForCursor = async () => { doc.elementFromPoint = (x) => x > 40 && x < 50 ? frame : x > 50 ? end : button; };
  await assert.rejects(commands.drag(['10', '10', '80', '80'], ctx), /framed/);
  assert.equal(log.length, 0);
});

test('wheel emits both axes, scrolls nested panels, and honors cancellation', async (t) => {
  const { ctx, button, element, log } = fixture(t);
  const scroller = Object.assign(element(), {
    scrollWidth: 100, clientWidth: 10, scrollHeight: 100, clientHeight: 10, scrollLeft: 20, scrollTop: 20,
    styles: { overflowX: 'auto', overflowY: 'auto' },
    scrollBy({ left, top }) { this.scrollLeft += left ?? 0; this.scrollTop += top ?? 0; },
  });
  button.parentElement = scroller;
  await commands.wheel(['-5', '12', '@r1'], ctx);
  assert.deepEqual([log[0].event.deltaX, log[0].event.deltaY, scroller.scrollLeft, scroller.scrollTop], [-5, 12, 15, 32]);
  button.cancel = (event) => event.type === 'wheel';
  await commands.wheel(['5', '5', '@r1'], ctx);
  assert.deepEqual([scroller.scrollLeft, scroller.scrollTop], [15, 32]);
});

test('keyboard chords target the original focus with ordered modifier lifetimes', async (t) => {
  const { ctx, doc, field, element, log } = fixture(t);
  await commands.keypress(['Control+Shift+A'], ctx);
  assert.ok(log.every(({ target }) => target === field));
  assert.deepEqual(log.map(({ event: e }) => [e.type, e.key, !!e.ctrlKey, !!e.shiftKey]), [
    ['keydown', 'Control', true, false], ['keydown', 'Shift', true, true], ['keydown', 'A', true, true],
    ['keyup', 'A', true, true], ['keyup', 'Shift', true, false], ['keyup', 'Control', false, false],
  ]);
  doc.activeElement = element('iframe');
  await assert.rejects(commands.keypress(['Enter'], ctx), /framed/);
});

test('selection replacement, fill, select and checkbox use explicit events without moving focus', async (t) => {
  const { ctx, doc, button, field, select, log, element, state } = fixture(t);
  await commands['insert-text'](['X'], ctx);
  assert.equal(field.value, 'aXd');
  assert.equal(field.selectionStart, 2);
  assert.deepEqual(log.splice(0).map(({ event }) => event.type), ['beforeinput', 'input']);
  doc.activeElement = button;
  await commands.fill(['@r2', ''], ctx);
  await commands['select-option'](['@r3', 'b'], ctx);
  assert.equal(field.value, '');
  assert.equal(select.selectedIndex, 1);
  const checkbox = Object.assign(element('input', 'checkbox'), { checked: false });
  state.targets.push(checkbox);
  await commands['set-checked'](['@r4', 'true'], ctx);
  assert.equal(checkbox.checked, true);
  assert.equal(doc.activeElement, button);
  assert.deepEqual(log.map(({ event }) => event.type), ['beforeinput', 'input', 'change', 'input', 'change', 'input', 'change']);
});

test('protected fields and beforeinput changes fail closed', async (t) => {
  const { ctx, doc, field, button, log } = fixture(t);
  field.type = 'file';
  await assert.rejects(commands['insert-text'](['X'], ctx), /protected/);
  assert.equal(log.length, 0);
  field.type = 'text';
  field.cancel = (event) => event.type === 'beforeinput';
  assert.equal(await commands['insert-text'](['X'], ctx), false);
  field.cancel = () => { doc.activeElement = button; return false; };
  await assert.rejects(commands['insert-text'](['X'], ctx), /changed during edit/);
  assert.equal(field.value, 'abcd');
});

test('password fields accept typing and filling', async (t) => {
  const { ctx, field, log } = fixture(t);
  field.type = 'password';
  await commands['insert-text'](['X'], ctx);
  assert.equal(field.value, 'aXd');
  await commands.fill(['@r2', 'secret'], ctx);
  assert.equal(field.value, 'secret');
  assert.deepEqual(log.map(({ event }) => event.type), ['beforeinput', 'input', 'beforeinput', 'input', 'change']);
});

test('invalid command arguments never call the adapter', async () => {
  for (const [verb, args] of [
    ['mouse-click', ['back', '-', '@r1']], ['mouse-click', ['left', 'constructor', '@r1']],
    ['wheel', ['1.5', '0']], ['drag', ['10', '10', '10', '10']], ['double-click', ['#selector']],
    ['keypress', ['Control+Control+A']], ['fill', ['@r1']], ['set-checked', ['@r1', 'yes']],
  ]) await assert.rejects(commands[verb](args, {}), (error) => !(error instanceof TypeError));
});
