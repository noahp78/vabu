const lifetime = 60_000;
// Leave room to report failure before the native host's 18-second socket timeout.
const commandTimeout = 5_000;
const sourceLimit = 4 * 1024;
const resultLimit = 16 * 1024;
const utf8 = new TextEncoder();
const prompt = 'Open the VABU popup to review and allow this eval expression, then retry it unchanged';
const changed = 'Cannot verify the selected document, site access, or VABU-managed group for eval; use the tab again';
const uncertain = 'Eval dispatch failed or returned an unverifiable result; it may have run';

// Serialized by scripting.executeScript. Keep this function closure-free; the
// expression is an argument, not part of the injected function's source.
export function evalInPage(origin, href, expression, limit) {
  if (window !== window.top || window.origin !== origin || location.href !== href) return 0;
  const evaluate = globalThis.eval;
  try {
    // Do not submit user source to the browser on ordinary CSP / Trusted Types denial.
    evaluate('0');
  } catch { return 1; }
  try {
    // Parse only, using the separately parsed FormalParameters grammar. The
    // array and paren contexts start at the same lexical goal but require
    // different closing delimiters: source that escapes one cannot parse in
    // the other. This blocks statement breakouts without lexing JS ourselves.
    new Function('value = [\n' + expression + '\n]', '');
  } catch (error) {
    return error instanceof SyntaxError ? 2 : 1;
  }
  let value;
  try {
    value = evaluate('(\n' + expression + '\n)');
  } catch { return 2; }
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (item === null || typeof item === 'string' || typeof item === 'boolean' || Number.isFinite(item)) return item;
      if (typeof item === 'object' && (Array.isArray(item) || [null, Object.prototype].includes(Object.getPrototypeOf(item)))) return item;
      throw 0;
    });
    if (json.length > limit || new TextEncoder().encode(json).length > limit) return 4;
    return json;
  } catch { return 3; }
}

async function verifyScope({ verify, assertCurrent }) {
  try {
    await verify();
    assertCurrent();
  } catch { throw new Error(changed); }
}

function evalDeadline() {
  const deadline = performance.now() + commandTimeout;
  let dispatched = false;
  function timeout() {
    return new Error(dispatched ? 'Eval timed out; it may have run' : 'Eval verification timed out before dispatch');
  }
  function remaining() {
    const ms = deadline - performance.now();
    if (ms <= 0) throw timeout();
    return ms;
  }
  return {
    dispatch() { remaining(); dispatched = true; },
    async wait(operation) {
      let timer;
      try {
        const ms = remaining();
        const expired = new Promise((_, reject) => {
          timer = setTimeout(() => reject(timeout()), ms);
        });
        const value = await Promise.race([expired, operation()]);
        remaining();
        return value;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function decode(results, documentId) {
  const injection = Array.isArray(results) && results.length === 1 && results[0];
  if (!injection || injection.frameId !== 0 || injection.documentId !== documentId || injection.error !== undefined) {
    throw new Error(uncertain);
  }
  const { result } = injection;
  if (result === 0) throw new Error(changed);
  if (result === 1) throw new Error('Eval is blocked by the page’s Content Security Policy or Trusted Types policy');
  if (result === 2) throw new Error('Eval expression is invalid or threw an exception');
  if (result === 3) throw new Error('Eval result is not a synchronous JSON value');
  if (result === 4 || (typeof result === 'string' && (result.length > resultLimit || utf8.encode(result).length > resultLimit))) {
    throw new Error('Eval result exceeds 16 KiB');
  }
  if (typeof result !== 'string') throw new Error(uncertain);
  // Firefox/Chrome deliver data from an untrusted page realm, including any
  // monkey-patched serializer. Disclose only bounded, valid JSON.
  let invalid = false;
  try {
    const value = JSON.parse(result, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) invalid = true;
      return item;
    });
    if (!invalid) return value;
  } catch {}
  throw new Error('Eval result is not valid JSON');
}

export function createEvalApproval(api) {
  const validMode = mode => ['ask', 'off', 'allow'].includes(mode);
  const effectiveMode = value => validMode(value) ? value : 'ask';
  let request;
  let timer;
  let writes = Promise.resolve();
  let revision = 0;
  let mode;
  function assertPolicy(policy) {
    if (revision !== policy.revision) throw new Error('Eval mode changed; retry the command');
  }
  function observeMode(value) {
    const next = effectiveMode(value);
    if (mode !== undefined && mode !== next) {
      revision++;
      clear();
    }
    mode = next;
  }
  api.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, 'evalMode')) observeMode(changes.evalMode.newValue);
  });
  async function policy() {
    const started = { revision };
    await writes;
    const { evalMode } = await api.storage.local.get('evalMode');
    assertPolicy(started);
    observeMode(evalMode);
    return { mode, revision };
  }
  function clear(selection) {
    if (!request || (selection !== undefined && request.selection !== selection)) return;
    request = undefined;
    clearTimeout(timer);
  }
  function expireLater(entry) {
    clearTimeout(timer);
    entry.expires = Date.now() + lifetime;
    timer = setTimeout(() => { if (request === entry) clear(); }, lifetime);
    timer?.unref?.();
  }
  function current() {
    if (request) {
      try {
        if (Date.now() >= request.expires) clear();
        else request.scope.assertCurrent();
      } catch { clear(); }
    }
    return request;
  }
  return {
    clear,
    async setMode(evalMode) {
      if (!validMode(evalMode)) throw new Error('Invalid eval mode; choose ask, off, or allow');
      revision++;
      clear();
      const write = writes.then(async () => {
        await api.storage.local.set({ evalMode });
        mode = evalMode;
      });
      writes = write.catch(() => {});
      await write;
      return { ok: true };
    },
    async status() {
      const active = await policy();
      assertPolicy(active);
      const entry = active.mode === 'ask' && current();
      if (!entry || entry.allowed) return { evalMode: active.mode };
      return { evalMode: active.mode, evalApproval: { token: entry.token, origin: entry.scope.origin, expression: entry.expression } };
    },
    async decide(action, token) {
      const active = await policy();
      assertPolicy(active);
      const entry = active.mode === 'ask' && current();
      if (!entry || entry.token !== token || entry.allowed || entry.deciding) throw new Error('Eval approval is stale or expired');
      if (action === 'eval-deny') clear();
      else {
        entry.deciding = true;
        try {
          await verifyScope(entry.scope);
          assertPolicy(active);
          if (current() !== entry) throw new Error('Eval approval is stale or expired');
          entry.allowed = true;
          expireLater(entry);
        } catch (error) {
          if (request === entry) clear();
          throw error;
        }
      }
      return { ok: true };
    },
    async run(selection, terms, getScope, setBeforeReply) {
      const [expression] = terms;
      if (terms.length !== 1 || !expression.trim()) throw new Error('Usage: vabu eval EXPRESSION');
      if (expression.length > sourceLimit || utf8.encode(expression).length > sourceLimit) throw new Error('Eval expression exceeds 4 KiB');
      const deadline = evalDeadline();
      const active = await deadline.wait(policy);
      assertPolicy(active);
      if (active.mode === 'off') throw new Error('Eval is off; change the mode in the VABU popup');
      const entry = active.mode === 'ask' && current();
      // An identical retry while pending keeps the token (including during a
      // popup decision). Different validated code requires a new decision.
      const retry = entry && entry.selection === selection && entry.expression === expression;
      const scope = retry ? entry.scope : await deadline.wait(getScope);
      const verify = () => deadline.wait(() => verifyScope(scope));
      try { await verify(); }
      catch (error) {
        if (retry && request === entry) clear();
        throw error;
      }
      const assertCurrent = () => {
        assertPolicy(active);
        scope.assertCurrent();
      };
      assertCurrent();
      if (active.mode === 'ask') {
        if (!retry) {
          const pending = request = { selection, scope, expression, token: crypto.randomUUID() };
          expireLater(pending);
          throw new Error(prompt);
        }
        if (current() !== entry || !entry.allowed) throw new Error(prompt);
        // Consume first, even if dispatch throws or its result is uncertain.
        clear();
      }
      const { id: tabId, documentId, origin, href } = scope;
      const results = await deadline.wait(async () => {
        deadline.dispatch();
        try {
          return await api.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
            world: 'MAIN', func: evalInPage, args: [origin, href, expression, resultLimit] });
        } catch { /* Do not echo browser errors, which can contain user source. */ }
      });
      await verify();
      assertCurrent();
      const value = decode(results, documentId);
      setBeforeReply(verify, assertCurrent);
      return value;
    },
  };
}
