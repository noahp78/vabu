import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { createEvalApproval, evalInPage } from '../extension/shared/eval.mjs';

const href = 'http://127.0.0.1:4000/?private=query';
const origin = new URL(href).origin;

function page(expression, codeGeneration = true) {
  const context = createContext({ expression, location: { href }, TextEncoder, origin }, { codeGeneration: { strings: codeGeneration } });
  return runInContext(`globalThis.window = globalThis; window.top = window;
    (${evalInPage.toString()})(origin, location.href, expression, 16384);`, context);
}

test('MAIN wrapper parses an expression under CSP and returns only bounded synchronous JSON', () => {
  assert.equal(page('({href: location.href, answer: (6, 42), text: /[)\\]]/.test("]")})'), JSON.stringify({ href, answer: 42, text: true }));
  assert.equal(page('1, 2 // line comment'), '2');
  assert.equal(page('`nested ${/[)]/.source} ${`template ${1}`}`'), '"nested [)] template 1"');
  assert.equal(page('null'), 'null');
  assert.equal(page('1', false), 1);
  for (const expression of ['1; 2', '1); throw new Error("private"); (2', '1), x=(2', '1], x=[2', '1)\nthrow new Error()\n(2', '(() => { throw new Error("secret"); })()']) {
    assert.equal(page(expression), 2, expression);
  }
  for (const expression of ['undefined', 'Promise.resolve(1)', 'new Map()', 'NaN', '1n', 'Symbol()', '[1, undefined]', '({a: Infinity})', '(() => { let a = {}; a.a = a; return a; })()']) {
    assert.equal(page(expression), 3, expression);
  }
  assert.equal(page('"é".repeat(8191)').length, 8193);
  assert.equal(page('"é".repeat(8192)'), 4);
});

test('consent is exact, expires, is consumed before dispatch and does not disclose unverified results', async (t) => {
  let now = 1;
  t.mock.method(Date, 'now', () => now);
  const selection = {};
  let valid = true;
  let calls = 0;
  let inject = () => [{ frameId: 0, documentId: 'doc', result: '"ok"' }];
  const approval = createEvalApproval({ storage: { local: { async get() { return {}; } } }, scripting: { async executeScript(details) {
    calls++;
    assert.deepEqual(details, { target: { tabId: 1, documentIds: ['doc'] }, world: 'MAIN', func: evalInPage, args: [origin, href, '1', 16384] });
    assert.deepEqual(await approval.status(), { evalMode: 'ask' });
    return inject();
  } } });
  const assertCurrent = () => { if (!valid) throw new Error('private URL'); };
  const scope = { id: 1, documentId: 'doc', origin, href, assertCurrent, verify: async () => assertCurrent() };
  let beforeReply;
  const run = (expression = '1') => approval.run(selection, [expression], () => scope, (verify, assert) => {
    beforeReply = async () => { await verify(); assert(); };
  });
  const pending = async () => (await approval.status()).evalApproval;
  const allow = async () => approval.decide('eval-approve', (await pending()).token);
  await assert.rejects(run('é'.repeat(2049)), /4 KiB/);
  assert.equal(await pending(), undefined);
  await assert.rejects(run(), /Open the VABU popup/);
  const first = await pending();
  assert.deepEqual(first, { token: first.token, origin, expression: '1' });
  await assert.rejects(run(), /Open the VABU popup/);
  assert.equal((await pending()).token, first.token);
  await assert.rejects(run('2'), /Open the VABU popup/);
  await assert.rejects(approval.decide('eval-approve', first.token), /stale/);
  const expiring = (await pending()).token;
  now += 60_000;
  await assert.rejects(approval.decide('eval-approve', expiring), /expired/);
  await assert.rejects(run(), /Open the VABU popup/);
  now += 59_000;
  await allow();
  assert.equal(await pending(), undefined);
  now += 59_000;
  assert.equal(await run(), 'ok');
  valid = false;
  await assert.rejects(beforeReply(), /Cannot verify/);
  valid = true;
  assert.equal(calls, 1);
  for (const [doInject, message] of [
    [() => { throw new Error('secret source'); }, /^Eval dispatch failed/],
    [() => [{ frameId: 0, documentId: 'replacement', result: '"secret"' }], /^Eval dispatch failed/],
    [() => [{ frameId: 1, documentId: 'doc', result: '"secret"' }], /^Eval dispatch failed/],
    [() => [{ frameId: 0, documentId: 'doc', result: '1e999' }], /^Eval result is not valid JSON$/],
    [() => [{ frameId: 0, documentId: 'doc', result: '"' + 'é'.repeat(8192) + '"' }], /^Eval result exceeds 16 KiB$/],
    [() => { valid = false; return [{ frameId: 0, documentId: 'doc', result: '"secret"' }]; }, /^Cannot verify/],
  ]) {
    inject = doInject;
    await assert.rejects(run(), /Open the VABU popup/);
    await allow();
    await assert.rejects(run(), { message });
    assert.equal(await pending(), undefined);
    valid = true;
  }
  await assert.rejects(run(), /Open the VABU popup/);
  await allow();
  now += 60_000;
  await assert.rejects(run(), /Open the VABU popup/);
  assert.equal(calls, 7);
  approval.clear();
});

test('persisted modes revoke pending review and stop stale approval or dispatch across a policy change', async () => {
  const saved = {};
  const storageListeners = [];
  let calls = 0;
  const api = { storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } },
    local: { async get() { return { ...saved }; }, async set(settings) { Object.assign(saved, settings); } } },
    scripting: { async executeScript() { calls++; return [{ frameId: 0, documentId: 'doc', result: '42' }]; } } };
  const approval = createEvalApproval(api);
  let duringVerify, beforeReply;
  const scope = { id: 1, documentId: 'doc', origin, href, assertCurrent() {}, async verify() { await duringVerify?.(); } };
  const run = () => approval.run(scope, ['42'], () => scope, (verify, assert) => {
    beforeReply = async () => { await verify(); assert(); };
  });
  await assert.rejects(approval.setMode('always'), /Invalid eval mode/);
  await assert.rejects(run(), /Open the VABU popup/);
  const { token } = (await approval.status()).evalApproval;
  duringVerify = () => approval.setMode('off');
  await assert.rejects(approval.decide('eval-approve', token), /mode changed/);
  await assert.rejects(run(), /Eval is off/);
  await approval.setMode('ask');
  await assert.rejects(approval.decide('eval-approve', token), /stale/);
  duringVerify = undefined;
  await assert.rejects(run(), /Open the VABU popup/);
  await approval.decide('eval-approve', (await approval.status()).evalApproval.token);
  duringVerify = () => approval.setMode('allow');
  await assert.rejects(run(), /mode changed/);
  assert.equal(calls, 0);
  assert.deepEqual(await createEvalApproval(api).status(), { evalMode: 'allow' });
  duringVerify = undefined;
  assert.equal(await run(), 42);
  assert.equal(calls, 1);
  assert.deepEqual(await approval.status(), { evalMode: 'allow' });
  const externalMode = evalMode => {
    saved.evalMode = evalMode;
    for (const notify of storageListeners) notify({ evalMode: { newValue: evalMode } }, 'local');
  };
  duringVerify = () => { externalMode('off'); externalMode('allow'); };
  await assert.rejects(run(), /mode changed/);
  assert.equal(calls, 1);
  duringVerify = undefined;
  await approval.setMode('off');
  await assert.rejects(beforeReply(), /mode changed/);
  await assert.rejects(run(), /Eval is off/);
});

test('eval deadlines cover verification without late dispatch or disclosure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const started = Promise.withResolvers(), pending = Promise.withResolvers();
  let calls = 0, beforeReply;
  let hold = () => { started.resolve(); return pending.promise; };
  const approval = createEvalApproval({ storage: { local: { async get() { return { evalMode: 'allow' }; } } },
    scripting: { async executeScript() { calls++; return [{ frameId: 0, documentId: 'doc', result: '42' }]; } } });
  const scope = { id: 1, documentId: 'doc', origin, href, assertCurrent() {}, async verify() { await hold?.(); } };
  const run = () => approval.run(scope, ['42'], () => scope, (verify, assert) => {
    beforeReply = async () => { await verify(); assert(); };
  });
  const evalRequest = run();
  await started.promise;
  t.mock.timers.tick(5_000);
  await assert.rejects(evalRequest, /timed out before dispatch/);
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal(beforeReply, undefined);
  hold = undefined;
  assert.equal(await run(), 42);
  hold = () => new Promise(() => {});
  const reply = beforeReply();
  t.mock.timers.tick(5_000);
  await assert.rejects(reply, /timed out; it may have run/);
  assert.equal(calls, 1);
});
