import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { commands, inspectionPage } from '../extension/shared/inspection.mjs';

const locator = (by, value, extra) => JSON.stringify({ all: [{ by, value }], ...extra });
const button = locator('role', 'button');
const origin = 'http://127.0.0.1:9000';
const documentId = 'currentFrameDocument01';
const call = (verb, args, ctx) => commands[`inspect-${verb}`](args, ctx);

function context(overrides = {}) {
  const scope = { documentId, async assertCurrent() {}, ...overrides };
  return { async assertCurrent() {}, async inspectionScope() { return scope; } };
}

function fixture(t) {
  const page = { location: new URL(origin), origin, scrollX: 7, scrollY: 11 };
  const rect = { x: 2, y: 3, width: 50, height: 10 };
  function element(localName, options = {}) {
    const el = {
      localName, attrs: {}, isConnected: true, checkVisibility: () => !el.hidden,
      innerText: '', getBoundingClientRect: () => rect, contains: (other) => other === el || el.children.includes(other),
      matches: (css) => css === '*' || css === localName || (css === ':disabled' && el.disabled),
      closest: (css) => css.includes('input[type=password i]') && ['password', 'file'].includes(el.type) ? el : null,
      getAttribute: (attr) => el.attrs[attr] ?? null, hasAttribute: (attr) => attr in el.attrs,
      children: [], ...options,
    };
    el.querySelectorAll = (css) => el.children.filter((child) => child.matches(css));
    return el;
  }
  const label = element('label', { innerText: 'Product   code' });
  const save = element('button', { innerText: 'Save', attrs: { 'data-testid': 'save-btn' } });
  const later = element('button', { innerText: 'Later', hidden: true, disabled: true });
  const editor = element('input', { type: 'text', labels: [label], value: 'PRIVATE_VALUE' });
  const password = element('input', { type: 'password', value: 'PASSWORD_VALUE' });
  const section = element('section', { children: [save, later, editor, password, label] });
  const all = [section, ...section.children];
  page.document = {
    readyState: 'complete', contains: (el) => all.includes(el),
    querySelectorAll: (css) => all.filter((el) => el.isConnected && el.matches(css)),
  };
  for (const el of all) el.ownerDocument = page.document;
  const props = [...Object.keys(page), 'vabuInspectionState'];
  const original = Object.fromEntries(props.map((prop) => [prop, Object.getOwnPropertyDescriptor(globalThis, prop)]));
  t.after(() => {
    for (const key of props) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else delete globalThis[key];
    }
  });
  for (const key of props) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page[key] });
  const makeContext = (key = 'session/doc', overrides) => context({ async run(operation, spec) {
    const result = inspectionPage(origin, key, operation, spec);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }, ...overrides });
  return { ctx: makeContext(), makeContext, save, later, rect };
}

test('06–07: typed locators, intersection, scoping, filters, and metadata without input values', async (t) => {
  const { ctx, rect } = fixture(t);
  const spec = locator('role', 'button', {
    all: [{ by: 'role', value: 'button' }, { by: 'testid', value: 'save-btn' }],
    within: { by: 'css', value: 'section' }, visible: true, enabled: true,
  });
  const { items: [save], count, truncated } = await call('query', [spec], ctx);
  assert.equal(count, 1);
  assert.equal(truncated, false);
  assert.deepEqual(save, { ref: save.ref, tag: 'button', name: 'Save', text: 'Save', role: 'button', enabled: true, visible: true, rect });
  for (const by of ['text', 'name', 'testid']) {
    assert.equal((await call('element', [locator(by, by === 'testid' ? 'save-btn' : 'Save')], ctx)).name, 'Save');
  }
  const field = await call('element', [locator('label', 'Product   code')], ctx);
  assert.equal(field.role, 'textbox');
  assert.ok(!JSON.stringify(field).includes('PRIVATE_VALUE'));
  const inputs = await call('query', [locator('css', 'input')], ctx);
  assert.equal(inputs.count, 2);
  assert.ok(!JSON.stringify(inputs).includes('PASSWORD_VALUE'));
  assert.equal((await call('element', [locator('css', 'button', { enabled: false })], ctx)).visible, false);
  await assert.rejects(call('element', [button], ctx), /Ambiguous/);
  await assert.rejects(call('element', [locator('css', 'input[value]')], ctx), /supports only/);
  await assert.rejects(call('query', [locator('css', 'section > > button')], ctx), /supports only/);
  await assert.rejects(call('query', [locator('xpath', '//button')], ctx), /typed locator/);
});

test('CSS shorthand and structural attributes share the same restricted grammar', async () => {
  const selectors = [
    'input[type=radio][name^=bundle_option]',
    '[data-ctp-configurator] label',
    '[data-ctp-configurator]>input[type="radio"]',
  ];
  for (const value of selectors) {
    const ctx = context({ async run(operation, spec) {
      assert.equal(operation, 'query');
      assert.deepEqual(spec, { all: [{ by: 'css', value }] });
      return { count: 0, items: [], truncated: false };
    } });
    for (const arg of [JSON.stringify({ css: value }), JSON.stringify({ selector: value }), locator('css', value)]) {
      assert.equal((await call('query', [arg], ctx)).count, 0);
    }
  }
  const ctx = context({ run: assert.fail });
  for (const css of ['input[value^=secret]', '[data-token^=secret]', 'input[autocomplete]',
    '[name^=bundle_option]', 'form:has(input[type=radio])', '[data-marker],input', 'input[name^="bad value"]']) {
    await assert.rejects(call('query', [JSON.stringify({ css })], ctx), /supports only/);
  }
});

test('06–07: refs belong to a live document, selected session and latest query', async (t) => {
  const { ctx, makeContext, save } = fixture(t);
  const getRef = async () => locator('ref', (await call('query', [locator('name', 'Save')], ctx)).items[0].ref);
  const first = await getRef();
  assert.equal((await call('element', [first], ctx)).name, 'Save');
  await assert.rejects(call('element', [first], makeContext('other-session')), /Stale/);
  const second = await getRef();
  await assert.rejects(call('element', [first], ctx), /Stale/);
  location.hash = 'next';
  await assert.rejects(call('element', [second], ctx), /Stale/);
  const third = await getRef();
  save.isConnected = false;
  await assert.rejects(call('element', [third], ctx), /Stale/);
});

test('08: frame scope pins the intended document and checks approval before and after inspection', async () => {
  let allowed = true;
  let calls = 0;
  const args = ['--frame', '2', documentId, button];
  const ctx = { async assertCurrent() {}, async inspectionScope(frame, doc) {
    assert.equal(frame, 2);
    assert.equal(doc, documentId);
    return { documentId,
      async assertCurrent() { if (!allowed) throw new Error('Frame approval lost'); },
      async run() { calls++; allowed = false; return { text: 'Do not return' }; },
    };
  } };
  await assert.rejects(call('query', ['--frame', '2', button], ctx), /requires a current document/);
  await assert.rejects(call('query', args, context({ documentId: 'replacement', run: assert.fail })), /Stale frame/);
  assert.deepEqual(await call('query', args, context({ async run(op, spec) {
    assert.equal(op, 'query');
    assert.deepEqual(spec, JSON.parse(button));
    return { count: 0, items: [], truncated: false };
  } })), { count: 0, items: [], truncated: false });
  await assert.rejects(call('query', args, ctx), /approval lost/);
  assert.equal(calls, 1);
  await assert.rejects(call('query', args, ctx), /approval lost/);
  assert.equal(calls, 1);
  await assert.rejects(call('query', args, { async assertCurrent() {}, page: assert.fail }), /Unsupported/);
});

test('08: the isolated operation refuses mismatched and opaque origins', async (t) => {
  const { ctx } = fixture(t);
  globalThis.origin = 'null';
  await assert.rejects(call('query', [button], ctx), /not authorized/);
  globalThis.origin = origin;
  location.href = 'http://127.0.0.1:9001';
  await assert.rejects(call('query', [button], ctx), /not authorized/);
});

test('verified iframe click requires the live ref, visible owner and hit in both documents', () => {
  const events = [];
  const rect = { left: 0, top: 0, right: 30, bottom: 30 };
  const childDocument = { designMode: 'off', contentType: 'text/html', readyState: 'complete' };
  const topDocument = {};
  const props = { transform: 'none', scale: 'none', rotate: 'none', translate: 'none', perspective: 'none', offsetPath: 'none',
    zoom: '1', borderLeftWidth: '0', paddingLeft: '0', borderTopWidth: '0', paddingTop: '0' };
  const parent = { origin, location: new URL(origin), document: topDocument, innerHeight: 100, innerWidth: 100, getComputedStyle: () => props };
  const window = { top: parent, parent };
  const attributes = new Set();
  const owner = { namespaceURI: 'http://www.w3.org/1999/xhtml', localName: 'iframe', contentWindow: window,
    contentDocument: childDocument, getRootNode: () => topDocument, hasAttribute: (key) => attributes.has(key),
    checkVisibility: () => true, matches: () => false, closest: () => null, getBoundingClientRect: () => rect };
  window.frameElement = owner;
  const control = { ownerDocument: childDocument, isConnected: true, getBoundingClientRect: () => rect, checkVisibility: () => true,
    contains: (node) => node === control, closest: () => null, matches: () => false, dispatchEvent: (event) => events.push(event) };
  childDocument.elementFromPoint = () => control;
  topDocument.elementFromPoint = () => owner;
  const href = new URL('/frame', origin).href;
  const generation = crypto.randomUUID();
  const context = { window, document: childDocument, location: new URL(href), origin, innerWidth: 100, innerHeight: 100,
    MouseEvent: class { constructor(type, init) { Object.assign(this, { type, ...init, isTrusted: false }); } },
    vabuInspectionState: { key: 'scope', href, generation, refs: [control] } };
  const run = (ref = `@i${generation}:1`) => runInNewContext(`(${inspectionPage})(origin, 'scope', 'click', ref, scope)`, {
    ...context, ref, scope: { href, parentHref: parent.location.href },
  });
  attributes.add('sandbox');
  assert.match(run().error, /not an authorized visible iframe/);
  attributes.clear();
  topDocument.elementFromPoint = () => null;
  assert.match(run().error, /covered or unavailable/);
  topDocument.elementFromPoint = () => owner;
  props.zoom = '2';
  assert.match(run().error, /coordinate mapping/);
  props.zoom = '1';
  assert.match(run(`@i${crypto.randomUUID()}:1`).error, /Stale/);
  assert.deepEqual(events, []);
  assert.equal(run().value.trusted, false);
  assert.equal(events[0].type, 'click');
  assert.equal(events[0].isTrusted, false);
  assert.equal(events[0].clientX, 15);
});

test('09: bounded waits observe document and locator conditions, refusing ambiguity and late work', async (t) => {
  const { ctx, later } = fixture(t);
  assert.deepEqual(await call('wait', ['load', '1000'], ctx), { event: 'load' });
  assert.deepEqual(await call('wait', ['hidden', '1000', locator('testid', 'not-present')], ctx), { event: 'hidden' });
  await assert.rejects(call('wait', ['visible', '1000', button], ctx), /Ambiguous/);
  let probes = 0;
  assert.deepEqual(await call('wait', ['visible', '1000', locator('css', 'button', { enabled: false })], {
    ...ctx, async inspectionScope() {
      const scope = await ctx.inspectionScope();
      return { ...scope, run(op, payload) { if (++probes === 2) later.hidden = false; return scope.run(op, payload); } };
    },
  }), { event: 'visible' });
  await assert.rejects(call('wait', ['load', '10'], context({ run: () => new Promise(() => {}) })), /timed out/);
  await assert.rejects(call('wait', ['load', '15001'], ctx), /Invalid timeout/);
});

test('10: capture never falls back to raw CDP; guarded modes discard results after navigation', async (t) => {
  const jpeg = '/9j/QUJDRA==';
  const { ctx, makeContext } = fixture(t);
  await assert.rejects(call('screenshot', ['page'], { ...ctx, cdp: assert.fail }), /Unsupported.*captureGuarded/);
  const requests = [];
  const capture = makeContext('session/doc', { async captureGuarded(request) { requests.push(request); return { data: jpeg }; } });
  assert.deepEqual(await call('screenshot', ['page'], capture), { format: 'jpeg', data: jpeg });
  await call('screenshot', ['clip', '0', '2', '100', '200'], capture);
  await call('screenshot', ['annotated', locator('name', 'Save')], capture);
  assert.deepEqual(requests[0], { mode: 'page' });
  assert.deepEqual(requests[1], { mode: 'clip', clip: { x: 0, y: 2, width: 100, height: 200 } });
  assert.deepEqual(requests[2].annotation, { x: 9, y: 14, width: 50, height: 10 });
  await assert.rejects(call('screenshot', ['annotated', button], capture), /Ambiguous/);
  await assert.rejects(call('screenshot', ['clip', '0', '0', '9000', '9000'], capture), /too large/);
  assert.equal(requests.length, 3);
  let current = true;
  await assert.rejects(call('screenshot', ['page'], context({
    async assertCurrent() { if (!current) throw new Error('Navigated'); },
    async captureGuarded() { current = false; return { data: jpeg }; },
  })), /Navigated/);
});

test('11: dialog identity, redaction, explicit actions, and wait cancellation', async () => {
  const id = 'currentDialogId012345';
  const pending = { id, type: 'prompt', message: 'DO NOT RETURN', defaultPrompt: 'PRIVATE' };
  let handled = false;
  const ctx = context({ async dialog(request) {
    if (request.action === 'show') return pending;
    if (request.action === 'wait') return pending;
    if (request.id !== id || handled) throw new Error('Dialog is stale');
    handled = true;
    return true;
  } });
  assert.deepEqual(await call('dialog', ['show'], ctx), { id, type: 'prompt' });
  assert.deepEqual(await call('wait', ['dialog', '1000'], ctx), { id, type: 'prompt' });
  assert.deepEqual(await call('dialog', ['dismiss', id], ctx), { handled: true });
  await assert.rejects(call('dialog', ['accept', id], ctx), /stale/);
  await assert.rejects(call('dialog', ['accept', id, 'not-supported'], ctx), /Usage/);
  let aborted = false;
  await assert.rejects(call('wait', ['dialog', '10'], context({ dialog({ signal }) {
    return new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(pending); }));
  } })), /timed out/);
  assert.equal(aborted, true);
});
