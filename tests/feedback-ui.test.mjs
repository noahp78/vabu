import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackCount, handleFeedback, invalidateFeedback, listFeedback, takeFeedback } from '../extension/shared/feedback.mjs';

test('feedback inbox counts and lists live scopes without consuming or exposing notes', () => {
  const note = (i) => ({ page: `https://example.test/${i}`, target: null, note: `note ${i}` });
  const unscoped = note(0);
  const named = Array.from({ length: 20 }, (_, i) => note(i + 1));
  const workspace = { name: 'Design', feedback: named };
  const connection = { online: true, feedback: [unscoped], workspaces: new Map([['id', workspace]]) };
  assert.equal(feedbackCount(undefined), 0);
  assert.deepEqual(listFeedback(undefined), { feedback: [], total: 0 });
  assert.equal(feedbackCount(connection), 21);
  const result = listFeedback(connection);
  assert.equal(result.total, 21);
  assert.equal(result.feedback.length, 20);
  assert.deepEqual(result.feedback[0], { ...unscoped, workspace: null });
  assert.deepEqual(result.feedback[1], { ...named[0], workspace: 'Design' });
  result.feedback[0].note = 'changed';
  assert.equal(unscoped.note, 'note 0');
  assert.deepEqual(listFeedback(connection).feedback[0], { ...unscoped, workspace: null });
  assert.deepEqual(takeFeedback(workspace, []), { feedback: Array.from({ length: 20 }, (_, i) => note(i + 1)) });
  assert.equal(feedbackCount(connection), 1);
  assert.deepEqual(takeFeedback(connection, []), { feedback: [unscoped] });
  assert.deepEqual(listFeedback(connection), { feedback: [], total: 0 });
  workspace.feedback = [note(99)];
  connection.workspaces.delete('id');
  assert.equal(feedbackCount(connection), 0);
  connection.feedback = [note(100)];
  connection.online = false;
  assert.equal(feedbackCount(connection), 0);
  assert.deepEqual(listFeedback(connection), { feedback: [], total: 0 });
});

function fixture() {
  const href = 'https://example.test/page?private=1';
  const tab = { id: 1, active: true, status: 'complete', url: href };
  const owner = { name: 'Original' };
  const connection = { online: true, workspaces: new Map([[owner.name, owner]]) };
  const state = { owner, connection, tab, documentId: 'document', allowed: true, active: tab, inject: () => true };
  const popup = { id: 'extension', url: 'extension://shared/popup.html' };
  const api = {
    runtime: { id: 'extension', getURL: (path) => `extension://${path}` },
    tabs: { query: async () => [state.active], get: async () => tab },
    webNavigation: { getFrame: async () => ({ url: tab.url, documentId: state.documentId }) },
    permissions: { contains: async () => { await state.beforeAccess?.(); return state.allowed; } },
    scripting: { executeScript: async ({ target, world, func, args }) => {
      assert.equal(target.tabId, tab.id);
      assert.equal(world, 'ISOLATED');
      const [documentId] = target.documentIds;
      const result = await state.inject(func, args, documentId);
      return [{ documentId, frameId: 0, result }];
    } },
  };
  const send = (message, sender = popup) => handleFeedback(api, connection, () => state.connection, () => state.owner, message, sender);
  const fromPage = (message) => send(message, { id: popup.id, tab, url: href, frameId: 0, documentId: state.documentId });
  const open = (action = 'feedback-start') => send({ action });
  const submit = async (...points) => {
    await open();
    return fromPage({ action: 'feedback-submit', token: connection.feedbackLeases.get(tab.id).token, points });
  };
  return { href, tab, owner, connection, state, popup, send, open, fromPage, submit };
}

const page = 'https://example.test/page';
const point = (note, target = null) => ({ target, note });

test('recall reserves only the newest matching batch and a racing CLI read observes the commit', async () => {
  const { owner, connection, state, open, submit } = fixture();
  const older = point('An older batch');
  const latest = [point('Preserve  spaces\nand newlines', '#title'), point('Another note')];
  await submit(older);
  await submit(...latest);
  const { promise: acknowledging, resolve: acknowledge } = Promise.withResolvers();
  const { promise: resume, resolve: proceed } = Promise.withResolvers();
  const calls = [];
  state.inject = async (func, [, , action], doc) => {
    assert.equal(doc, 'document');
    if (func.name === 'feedbackInPage') {
      assert.deepEqual(action, latest);
      calls.push('stage');
    } else {
      calls.push(action);
      if (action === 'acknowledge') { acknowledge(); await resume; }
    }
    return true;
  };
  const recall = open('feedback-recall');
  await acknowledging;
  assert.deepEqual(calls, ['stage', 'activate', 'acknowledge']);
  assert.equal(feedbackCount(connection), 3);
  const other = { feedback: [{ page, ...point('Unrelated workspace') }] };
  assert.deepEqual(takeFeedback(other, []), { feedback: [{ page, ...point('Unrelated workspace') }] });
  let read = false;
  const reading = takeFeedback(owner, []).then(result => { read = true; return result; });
  await Promise.resolve();
  assert.equal(read, false);
  proceed();
  assert.deepEqual(await recall, { ok: true });
  assert.deepEqual(await reading, { feedback: [{ page, ...older }] });
  await assert.rejects(open('feedback-recall'), /No unread batch/);
});

test('recall failure releases a racing CLI read even if UI cleanup stalls', { timeout: 1000 }, async () => {
  const { owner, state, open, submit } = fixture();
  const sent = point('Do not lose me', '#still-here');
  await submit(sent);
  const { promise: staged, resolve: stage } = Promise.withResolvers();
  const { promise: resume, resolve: proceed } = Promise.withResolvers();
  const calls = [];
  state.inject = async (func, [, , action]) => {
    calls.push(func.name === 'feedbackInPage' ? 'stage' : action);
    if (action === 'activate') { stage(); await resume; }
    if (action === 'rollback') await new Promise(() => {});
    return true;
  };
  const rejected = assert.rejects(open('feedback-recall'), /site access/);
  await staged;
  const reading = takeFeedback(owner, []);
  state.allowed = false;
  proceed();
  await rejected;
  assert.deepEqual(calls, ['stage', 'activate', 'rollback']);
  assert.deepEqual(await reading, { feedback: [{ page, ...sent }] });
  state.allowed = true;
  await assert.rejects(open('feedback-recall'), /No unread batch/);
});

test('invalidating recall while acknowledgement is in flight leaves the batch unread', async () => {
  const { owner, connection, state, open, submit } = fixture();
  const sent = point('Keep on invalidation');
  await submit(sent);
  const { promise: acknowledging, resolve: acknowledge } = Promise.withResolvers();
  const { promise: response, resolve: respond } = Promise.withResolvers();
  state.inject = (_, [, , action]) => {
    if (action !== 'acknowledge') return true;
    acknowledge();
    return response;
  };
  const rejected = assert.rejects(open('feedback-recall'), /Feedback expired/);
  await acknowledging;
  const reading = takeFeedback(owner, []);
  invalidateFeedback(connection);
  respond(true);
  await rejected;
  assert.equal(connection.feedbackLeases.size, 0);
  assert.deepEqual(await reading, { feedback: [{ page, ...sent }] });
});

test('recall times out a stalled acknowledgement and ignores its late result', async (t) => {
  const { owner, connection, state, open, submit } = fixture();
  const sent = point('Preserve on timeout');
  await submit(sent);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { promise: acknowledging, resolve: acknowledge } = Promise.withResolvers();
  const { promise: late, resolve: finish } = Promise.withResolvers();
  state.inject = async (_, [, , action]) => {
    if (action === 'acknowledge') { acknowledge(); await late; }
    if (action === 'rollback') await new Promise(() => {});
    return true;
  };
  const rejected = assert.rejects(open('feedback-recall'), /recall timed out/);
  await acknowledging;
  const reading = takeFeedback(owner, []);
  t.mock.timers.tick(5000);
  await rejected;
  assert.deepEqual(await reading, { feedback: [{ page, ...sent }] });
  finish();
  await assert.rejects(open('feedback-recall'), /No unread batch/);
  assert.equal(connection.feedbackLeases.size, 0);
  assert.deepEqual(takeFeedback(owner, []), { feedback: [] });
});

test('recall fails closed for non-popup senders, other tabs/workspaces, and navigated documents', async () => {
  const { tab, owner, connection, state, popup, send, open, submit } = fixture();
  const sent = point('Original batch');
  await submit(sent);
  state.inject = () => assert.fail('Must not inject');
  for (const sender of [{ ...popup, frameId: 2 }, { ...popup, tab }, { ...popup, url: 'extension://other.html' }, { ...popup, id: 'other' }]) {
    await assert.rejects(send({ action: 'feedback-recall' }, sender), /sender|popup/);
  }
  state.owner = {};
  await assert.rejects(open('feedback-recall'), /No unread batch/);
  state.owner = owner;
  state.active = { ...tab, id: 2 };
  await assert.rejects(open('feedback-recall'), /active website document/);
  state.active = tab;
  state.documentId = 'reloaded';
  await assert.rejects(open('feedback-recall'), /No unread batch/);
  invalidateFeedback(connection, tab.id);
  state.documentId = 'document'; // Even if the browser revives it from its back/forward cache.
  await assert.rejects(open('feedback-recall'), /No unread batch/);
  assert.deepEqual(takeFeedback(owner, []), { feedback: [{ page, ...sent }] });
});

test('shared annotation UI preserves unsent drafts and recalls, edits, and resends unread notes', async () => {
  const { href, state, owner, connection, open, fromPage, submit } = fixture();
  const older = point('Already sent', '#missing');
  await submit(older);
  state.inject = (func, args) => func(...args);

  let focused;
  class Node {
    constructor(tag) {
      this.localName = tag;
      this.id = '';
      this.classList = [];
      this.children = [];
      this.style = {};
      this.attributes = {};
      this.textContent = '';
      this.isConnected = true;
    }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    attachShadow() { return this.shadow = new Node('shadow'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    showPopover() { this.open = true; }
    hidePopover() { this.open = false; }
    matches(selector) { return selector === ':popover-open' ? !!this.open : selector === this.localName; }
    focus() { focused = this; }
    remove() { this.isConnected = false; this.removed = true; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
  }
  const root = new Node('html');
  const matches = new Map();
  const document = { hidden: false, documentElement: root, createElement: (tag) => new Node(tag), querySelectorAll: (selector) => matches.get(selector) ?? [] };
  const handlers = new Map();
  const window = { addEventListener(type, handler) { handlers.set(type, handler); }, visualViewport: null };
  window.top = window;
  const messages = [];
  const runtime = { sendMessage: async (message) => { messages.push(message); return fromPage(message); } };
  const globals = { document, window, location: new URL(href), origin: new URL(href).origin,
    innerWidth: 1024, innerHeight: 768, CSSStyleSheet: class { replaceSync(text) { this.text = text; } },
    browser: { runtime }, chrome: { runtime }, Element: Node };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    await open();
    let host = root.children.at(-1);
    assert.match(host.shadow.adoptedStyleSheets[0].text, /#picker \.actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    const all = (node) => [node, ...node.children.flatMap(all)];
    const find = (tag, text) => {
      const node = all(host.shadow).find((item) => item.localName === tag && item.textContent === text);
      assert.ok(node, `Expected ${tag} with text ${JSON.stringify(text)}`);
      return node;
    };
    const heading = find('h2', 'Annotate this page');
    assert.equal(focused, heading.parentElement);
    assert.equal(focused.tabIndex, -1);
    const wholePage = find('button', 'Comment on whole page');
    find('button', 'Save annotation');
    const send = find('button', 'Send annotations');
    assert.equal(send.disabled, true);
    wholePage.onclick({ isTrusted: true });
    const input = all(host.shadow).find((node) => node.localName === 'textarea');
    assert.ok(input);
    input.value = 'A page comment';
    const form = all(host.shadow).find((node) => node.localName === 'form');
    form.onsubmit({ isTrusted: true, preventDefault() {} });
    assert.deepEqual(messages, []);
    assert.equal(send.textContent, 'Send 1 annotation');
    assert.equal(send.disabled, false);
    const originalToken = connection.feedbackLeases.get(1).token;
    await assert.rejects(open('feedback-recall'), /already has unsent drafts/);
    assert.equal(host.isConnected, true);
    assert.equal(connection.feedbackLeases.get(1).token, originalToken);
    const notes = ['A page comment', 'A second comment', 'A third comment'];
    for (const note of notes.slice(1)) {
      wholePage.onclick({ isTrusted: true });
      input.value = note;
      form.onsubmit({ isTrusted: true, preventDefault() {} });
    }
    assert.equal(send.textContent, 'Send 3 annotations');
    await send.onclick({ isTrusted: false });
    assert.deepEqual(messages, []);
    await send.onclick({ isTrusted: true });
    assert.deepEqual(messages, [{ action: 'feedback-submit', token: originalToken,
      points: notes.map(note => ({ note, target: null })) }]);
    assert.equal(host.removed, true);
    assert.equal(globalThis.vabuFeedback, undefined);

    await open('feedback-recall');
    host = root.children.at(-1);
    assert.equal(host.inert, false);
    assert.deepEqual(listFeedback(connection).feedback, [{ page, ...older, workspace: owner.name }]);
    find('button', '2').onclick({ isTrusted: true });
    const recalledInput = all(host.shadow).find(node => node.localName === 'textarea');
    assert.equal(recalledInput.value, notes[1]);
    recalledInput.value = 'Edited\nwith  spaces';
    all(host.shadow).find(node => node.localName === 'form').onsubmit({ isTrusted: true, preventDefault() {} });
    await find('button', 'Send 3 annotations').onclick({ isTrusted: true });
    const resent = [notes[0], recalledInput.value, notes[2]].map(note => ({ page, ...point(note) }));
    assert.deepEqual(listFeedback(connection).feedback.map(({ workspace, ...note }) => note), [{ page, ...older }, ...resent]);
    assert.equal(host.removed, true);

    // Even when no element matches anymore, the note remains editable and its selector survives.
    state.inject = () => true;
    await submit(point('Missing element\nwith  spaces', '#no-longer-present'));
    state.inject = (func, args) => func(...args);
    await open('feedback-recall');
    host = root.children.at(-1);
    find('button', '1').onclick({ isTrusted: true });
    const missingInput = all(host.shadow).find(node => node.localName === 'textarea');
    assert.equal(missingInput.value, 'Missing element\nwith  spaces');
    all(host.shadow).find(node => node.localName === 'form').onsubmit({ isTrusted: true, preventDefault() {} });
    await find('button', 'Send 1 annotation').onclick({ isTrusted: true });
    assert.deepEqual(takeFeedback(owner, []), { feedback: [{ page, ...older }, ...resent,
      { page, ...point(missingInput.value, '#no-longer-present') }] });

    // The same document can lose the provisional editor after activation, while
    // the background is still checking site access. A racing CLI read gets the batch once.
    const removed = point('Do not lose this on a same-document change', '#missing');
    state.inject = () => true;
    await submit(removed);
    const { promise: verifying, resolve: verify } = Promise.withResolvers();
    const { promise: resume, resolve: proceed } = Promise.withResolvers();
    state.inject = (func, args) => {
      const result = func(...args);
      if (func.name === 'finishFeedbackRecall' && args[2] === 'activate') {
        assert.equal(result, true);
        state.beforeAccess = () => { verify(); return resume; };
      }
      return result;
    };
    const rejected = assert.rejects(open('feedback-recall'), /Could not restore the recalled drafts/);
    await verifying;
    host = root.children.at(-1);
    assert.equal(find('button', 'Send 1 annotation').disabled, true);
    const reading = takeFeedback(owner, []);
    host.remove();
    state.beforeAccess = undefined;
    proceed();
    await rejected;
    assert.equal(globalThis.vabuFeedback, undefined);
    assert.equal(connection.feedbackLeases.size, 0);
    assert.deepEqual(await reading, { feedback: [{ page, ...removed }] });
    assert.deepEqual(takeFeedback(owner, []), { feedback: [] });
    state.inject = (func, args) => func(...args);

    const section = new Node('section');
    const first = new Node('button');
    const second = new Node('button');
    root.append(section);
    section.append(first, second);
    matches.set('button', [first, second]);
    matches.set('section > button:nth-of-type(2)', [second]);
    await open();
    host = root.children.at(-1);
    const click = (target) => handlers.get('click')({ isTrusted: true, target, preventDefault() {}, stopImmediatePropagation() {} });
    click(second);
    const positionalInput = all(host.shadow).find(node => node.localName === 'textarea');
    positionalInput.value = 'Second sibling';
    const positionalForm = all(host.shadow).find(node => node.localName === 'form');
    positionalForm.onsubmit({ isTrusted: true, preventDefault() {} });
    assert.equal(find('button', 'Send 1 annotation').disabled, false);
    await find('button', 'Send 1 annotation').onclick({ isTrusted: true });
    const selector = 'section > button:nth-of-type(2)';
    matches.set(selector, [first]); // The list changed without a navigation.
    await open('feedback-recall');
    host = root.children.at(-1);
    const markers = all(host.shadow).filter(node => node.localName === 'button' && node.textContent === '1');
    assert.equal(markers.length, 1, 'Only the draft list marker should remain');
    markers[0].onclick({ isTrusted: true });
    assert.equal(all(host.shadow).find(node => node.localName === 'textarea').value, 'Second sibling');
    all(host.shadow).find(node => node.localName === 'form').onsubmit({ isTrusted: true, preventDefault() {} });
    await find('button', 'Send 1 annotation').onclick({ isTrusted: true });
    assert.deepEqual(takeFeedback(owner, []), { feedback: [{ page, ...point('Second sibling', selector) }] });

    // The selected element may be unique among its siblings while an ancestor is not.
    const otherSection = new Node('section');
    const link = new Node('a');
    root.append(otherSection);
    section.append(link);
    matches.set('a', [link, new Node('a')]);
    matches.set('html > section:nth-of-type(1) > a', [link]);
    await open();
    host = root.children.at(-1);
    click(link);
    const ancestorInput = all(host.shadow).find(node => node.localName === 'textarea');
    ancestorInput.value = 'Ambiguous ancestor';
    all(host.shadow).find(node => node.localName === 'form').onsubmit({ isTrusted: true, preventDefault() {} });
    await find('button', 'Send 1 annotation').onclick({ isTrusted: true });
    assert.deepEqual(takeFeedback(owner, []), { feedback: [{ page, ...point('Ambiguous ancestor', 'html > section:nth-of-type(1) > a') }] });

    // A disconnected or otherwise unidentifiable element cannot become a page comment.
    await open();
    host = root.children.at(-1);
    const detached = new Node('aside');
    click(detached);
    const retained = all(host.shadow).find(node => node.localName === 'textarea');
    retained.value = 'Keep this text';
    all(host.shadow).find(node => node.localName === 'form').onsubmit({ isTrusted: true, preventDefault() {} });
    assert.equal(retained.value, 'Keep this text');
    assert.ok(all(host.shadow).some(node => node.textContent.includes('Could not identify this element')));
    assert.equal(find('button', 'Send annotations').disabled, true);
    await find('button', 'Send annotations').onclick({ isTrusted: true });
    assert.deepEqual(takeFeedback(owner, []), { feedback: [] });
  } finally {
    globalThis.vabuFeedback?.();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
