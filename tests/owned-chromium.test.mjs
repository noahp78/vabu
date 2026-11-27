import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stageChrome } from '../extension/chrome/package.mjs';

const chromium = process.env.VABU_TEST_CHROMIUM;
const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

async function until(check) {
  for (let i = 0; i < 50; ++i) {
    const result = await check();
    if (result) return result;
    await delay(100);
  }
  assert.fail('Timed out waiting for Chromium fixture');
}

test('isolated Chromium: owned scroll, capture, dialogs, computed styles, eval under page CSP, and feedback recall', {
  skip: !chromium || process.platform !== 'linux', timeout: 30000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'vabu-chrome-'));
  const profile = join(dir, 'profile');
  const extension = join(dir, 'extension');
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'), XDG_RUNTIME_DIR: join(dir, 'runtime') };
  let browser;
  let next = '';
  let polling = false;
  let result;
  let allowEval = false, evalAllowed = false, evalMode, savedMode;
  let recallTab, recallResult;
  const orders = [];
  const scrollSteps = [];
  let scrollState, foregroundWheel;
  const titles = [];
  const server = createServer((req, res) => {
    if (req.url === '/next') { polling = true; res.end(next); next = ''; }
    else if (req.url.startsWith('/result/')) { result = req.url; res.end(); }
    else if (req.url.startsWith('/scroll-step/')) { scrollSteps.push(req.url.slice('/scroll-step/'.length)); res.end(); }
    else if (req.url.startsWith('/foreground-wheel/')) { foregroundWheel = req.url.split('/').slice(2); res.end(); }
    else if (req.url === '/foreground') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Foreground scroll fixture</title><div style="height: 250vh"></div><script>
        addEventListener('wheel', e => fetch('/foreground-wheel/' + e.deltaY + '/' + e.isTrusted + '/' + document.hidden));
      </script>`);
    }
    else if (req.url.startsWith('/scroll-state/')) {
      scrollState = JSON.parse(decodeURIComponent(req.url.slice('/scroll-state/'.length)));
      res.end();
    }
    else if (req.url.startsWith('/order/')) { orders.push(req.url.slice('/order/'.length)); res.end(); }
    else if (req.url === '/allow-eval') { res.end(allowEval ? 'yes' : ''); allowEval = false; }
    else if (req.url === '/eval-allowed') { evalAllowed = true; res.end(); }
    else if (req.url === '/eval-mode') { res.end(evalMode ?? ''); evalMode = undefined; }
    else if (req.url.startsWith('/eval-mode/')) { savedMode = req.url.slice('/eval-mode/'.length); res.end(); }
    else if (req.url === '/recall-fixture') { res.end(String(recallTab ?? '')); recallTab = undefined; }
    else if (req.url.startsWith('/recall-result?')) {
      recallResult = new URL(req.url, 'http://127.0.0.1').searchParams.get('value');
      res.end();
    }
    else if (req.url === '/csp' || req.url === '/trusted-types') {
      res.setHeader('Content-Security-Policy', req.url === '/csp' ? "script-src 'self'"
        : "script-src 'self' 'unsafe-eval'; require-trusted-types-for 'script'; trusted-types 'none'");
      res.setHeader('Content-Type', 'text/html');
      res.end('<title>Restricted fixture</title>');
    }
    else if (req.url === '/other') { res.setHeader('Content-Type', 'text/html'); res.end('<title>Other owned tab</title>'); }
    else if (req.url.startsWith('/title?')) {
      titles.push(new URL(req.url, 'http://127.0.0.1').searchParams.get('value'));
      res.end();
    }
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><title>Owned fixture</title><body>Fixture
      <p id="style-target" style="font-size: 20px !important; margin: 2px 3px 4px 5px">Original content</p>
      <input type="file" id="protected"><div style="height: 150px"></div>
      <div id="panel" style="width: 200px; height: 160px; overflow: auto">
        <div style="position: sticky; top: 0"><button>Panel target</button><button id="cancel">Cancel scroll</button></div>
        <div style="height: 600px"></div>
      </div><div style="height: 250vh"></div><script>
        const target = document.querySelector('#style-target');
        const panel = document.querySelector('#panel');
        const wheels = [];
        document.addEventListener('wheel', e => wheels.push([e.deltaY, e.isTrusted]));
        document.querySelector('#cancel').addEventListener('wheel', e => e.preventDefault(), { passive: false });
        new MutationObserver(() => fetch('/title?value=' + encodeURIComponent(document.title)))
          .observe(document.querySelector('title'), { childList: true, subtree: true, characterData: true });
        (async () => { for (;;) {
          const action = await fetch('/next', { cache: 'no-store' }).then(r => r.text());
          if (action === 'check-scroll') await fetch('/scroll-state/' + encodeURIComponent(JSON.stringify({
            top: scrollY, panel: panel.scrollTop, hidden: document.hidden, wheels,
          })));
          if (action === 'alert') { alert('private alert'); await fetch('/result/true'); }
          if (action === 'confirm') await fetch('/result/' + confirm('private confirm'));
          if (action === 'prompt') await fetch('/result/' + (prompt('private prompt', 'private default') === null));
          if (action === 'check-style') await fetch('/result/' + (
            target.getAttribute('style') === 'font-size: 20px !important; margin: 2px 3px 4px 5px'
          ));
          await new Promise(r => setTimeout(r, 100));
        } })();
      </script>`);
    }
  });
  try {
    await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    await stageChrome(extension);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/`;
    // Observe event ordering inside the extension's own debugger connection.
    // Do not attach DevTools or enable Page on a second connection.
    const worker = join(extension, 'chrome', 'worker.js');
    await writeFile(worker, `
      const originalSend = chrome.debugger.sendCommand.bind(chrome.debugger);
      let resolved;
      chrome.debugger.onEvent.addListener((_, method) => {
        if (method === 'Page.javascriptDialogClosed') {
          void fetch(${JSON.stringify(url + 'order/')} + (resolved ? 'after-resolution' : 'before-resolution'));
        }
      });
      const traceScroll = name => fetch(${JSON.stringify(url + 'scroll-step/')} + name);
      const originalScript = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = async options => {
        if (options.args?.[3] !== 'scroll' && !options.args?.[4]?.deadline) return originalScript(options);
        await traceScroll('page-start');
        const reply = await originalScript(options);
        await traceScroll('page-end');
        return reply;
      };
      chrome.debugger.sendCommand = async (target, method, params) => {
        if (method === 'Input.dispatchMouseEvent') {
          await traceScroll(params.type + '-start');
          const reply = await originalSend(target, method, params);
          await traceScroll(params.type + '-end');
          return reply;
        }
        if (method !== 'Page.handleJavaScriptDialog') return originalSend(target, method, params);
        resolved = false;
        const reply = await originalSend(target, method, params);
        resolved = true;
        return reply;
      };
    ` + await readFile(worker, 'utf8') + `
      // Drive the decision layer in the disposable headless build; popup
      // sender and UI behavior have separate coverage.
      setInterval(async () => {
        const requestedMode = await fetch(${JSON.stringify(url + 'eval-mode')}).then(r => r.text());
        if (requestedMode) {
          await evalApproval.setMode(requestedMode);
          await fetch(${JSON.stringify(url + 'eval-mode/')} + (await evalApproval.status()).evalMode);
        }
        const pending = (await evalApproval.status()).evalApproval;
        if (!pending) return;
        const allowed = await fetch(${JSON.stringify(url + 'allow-eval')}).then(r => r.text());
        if (allowed !== 'yes') return;
        await evalApproval.decide('eval-approve', pending.token);
        await fetch(${JSON.stringify(url + 'eval-allowed')});
      }, 100);
      setInterval(async () => {
        const id = Number(await fetch(${JSON.stringify(url + 'recall-fixture')}).then(r => r.text()));
        if (!id) return;
        let result = 'ok';
        try {
          const tab = await chrome.tabs.update(id, { active: true });
          const connection = bridge;
          const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL('shared/popup.html') };
          const feedback = (action, sender, fields = {}) => handleFeedback(chrome, connection, () => bridge, tabId =>
            [...connection.workspaces.values()].find(owner => owner.tabs.has(tabId)) ?? connection, { action, ...fields }, sender);
          for (const note of ['Older annotation', 'Latest  annotation']) {
            await feedback('feedback-start', popup);
            const { token, scope } = connection.feedbackLeases.get(id);
            await feedback('feedback-submit', { id: popup.id, tab, url: scope.href, frameId: 0, documentId: scope.documentId },
              { token, points: [{ note, target: '#style-target' }] });
          }
          // This opens and activates the real annotation UI in the isolated document.
          await feedback('feedback-recall', popup);
        } catch (error) {
          result = error.message;
        }
        await fetch(${JSON.stringify(url + 'recall-result?value=')} + encodeURIComponent(result));
      }, 100);
    `);
    const id = createHash('sha256').update(extension).digest('hex').slice(0, 32)
      .replace(/./g, h => String.fromCharCode(97 + Number.parseInt(h, 16)));
    const install = join(root, 'install.mjs');
    // Chromium builds vary in whether they locate the user manifest under the
    // profile override or under the Chromium config directory.
    for (const config of [profile, join(env.XDG_CONFIG_HOME, 'chromium')]) {
      await exec(process.execPath, [install, id, '--config-dir', config], { env });
    }
    browser = spawn(chromium, ['--headless', '--no-sandbox', '--no-first-run', '--disable-background-networking',
      `--user-data-dir=${profile}`, `--load-extension=${extension}`, 'about:blank'], { env, stdio: 'ignore' });
    const browserEnded = new Promise(resolve => { browser.once('exit', resolve); browser.once('error', resolve); });
    const cli = async (...args) => {
      try { return (await exec(process.execPath, [join(root, 'cli.mjs'), ...args], { env, timeout: 8000 })).stdout.trim(); }
      catch (error) { throw new Error(error.stderr.trim() || `${args[args[0] === '--session' ? 2 : 0]}: ${error.message}`); }
    };
    const json = async (...args) => JSON.parse(await cli(...args));
    await until(() => json('status').catch(() => null));
    const { sessionId } = await json('session-start', 'Isolated fixture');
    const scoped = (...args) => json('--session', sessionId, ...args);
    const { tab, active } = await scoped('open', url);
    assert.equal(active, false);
    await until(() => polling);
    await scoped('use', String(tab));
    await until(() => titles.length);
    assert.equal(titles[0], '🟣 Owned fixture');
    assert.equal(await scoped('title'), 'Owned fixture');
    const snapshot = await scoped('snapshot');
    const scrollStateAfter = async () => {
      scrollState = undefined;
      next = 'check-scroll';
      return until(() => scrollState);
    };
    try {
      assert.equal(await scoped('scroll', '100'), true);
      assert.deepEqual(await scrollStateAfter(), { top: 100, panel: 0, hidden: true, wheels: [[100, false]] });
      const panelRef = snapshot.controls.find(({ name }) => name === 'Panel target').ref;
      const cancelRef = snapshot.controls.find(({ name }) => name === 'Cancel scroll').ref;
      assert.equal(await scoped('scroll', '60', panelRef), true);
      assert.deepEqual(await scrollStateAfter(), { top: 100, panel: 60, hidden: true, wheels: [[100, false], [60, false]] });
      assert.equal(await scoped('scroll', '50', cancelRef), true);
      assert.deepEqual(await scrollStateAfter(), { top: 100, panel: 60, hidden: true,
        wheels: [[100, false], [60, false], [50, false]] });
      await assert.rejects(scoped('scroll', '50', '@r999'), /Unavailable|snapshot/i);
      assert.equal((await scoped('status')).tab, tab);
      assert.equal((await scoped('tabs')).find(item => item.tab === tab).active, false);
    } finally { t.diagnostic('scroll trace: ' + scrollSteps.join(', ')); }
    assert.ok(scrollSteps.every(step => step.startsWith('page-')), 'background scroll never sends CDP mouse input');
    const jpeg = join(dir, 'viewport.jpg');
    assert.deepEqual(await scoped('screenshot', jpeg), { path: jpeg, format: 'jpeg' });
    assert.deepEqual((await readFile(jpeg)).subarray(0, 3), Buffer.from([255, 216, 255]));
    assert.equal((await stat(jpeg)).mode & 0o777, 0o600);
    assert.equal((await scoped('tabs')).find(t => t.tab === tab).active, false);
    await assert.rejects(cli('--session', sessionId, 'screenshot', jpeg), /EEXIST/);
    for (const [i, [type, action]] of [['alert', 'accept'], ['confirm', 'accept'], ['prompt', 'dismiss']].entries()) {
      next = type;
      const dialog = await until(() => scoped('inspect-dialog', 'show').catch(() => null));
      assert.deepEqual(dialog, { id: dialog.id, type });
      assert.deepEqual(await scoped('inspect-dialog', action, dialog.id), { handled: true });
      await until(() => result === '/result/true' && orders[i]);
      assert.match(orders[i], /^(before|after)-resolution$/);
      t.diagnostic(`${type}: Page.javascriptDialogClosed ${orders[i]}`);
      result = undefined;
      await assert.rejects(scoped('inspect-dialog', action, dialog.id), /stale/);
    }
    const query = css => scoped('inspect-query', JSON.stringify({ css }));
    const ref = async css => (await query(css)).items[0].ref;
    assert.equal((await query('#protected')).count, 0);
    const stale = await ref('#style-target');
    const target = await ref('#style-target');
    const getStyles = (ref, ...terms) => scoped('get', 'styles', ref, ...terms);
    await assert.rejects(getStyles(stale), /Stale inspection reference/);
    await assert.rejects(getStyles(target, 'font-size'), /Usage: get styles @iREF/);
    const { styles } = await getStyles(target);
    assert.equal(Object.keys(styles).length, 20);
    assert.equal(styles['font-size'], '20px');
    assert.equal(styles['margin-top'], '2px');
    assert.equal(styles['margin-left'], '5px');
    assert.equal(styles.display, 'block');
    assert.equal(typeof styles['font-family'], 'string');
    assert.ok(Object.values(styles).every(value => typeof value === 'string' && value.length <= 1024));
    for (const verb of ['style-read', 'style-set', 'style-reset']) await assert.rejects(scoped(verb), /Invalid command/);
    const other = await scoped('open', url + 'other');
    await until(() => scoped('use', String(other.tab)).catch(() => null));
    await assert.rejects(getStyles(target), /Stale inspection reference/);
    await scoped('use', String(tab));
    await assert.rejects(getStyles(target), /Stale inspection reference/);
    const current = await ref('#style-target');
    next = 'check-style';
    await until(() => result === '/result/true');
    assert.equal((await scoped('tabs')).find(t => t.tab === tab).active, false);
    assert.deepEqual(await scoped('tab-navigate', String(tab), url), { tab, requested: true });
    assert.equal((await scoped('status')).tab, null);
    await until(async () => {
      try { await scoped('use', String(tab)); return true; } catch { return false; }
    });
    assert.equal((await scoped('status')).tab, tab);
    await assert.rejects(getStyles(current), /Stale inspection reference/);
    assert.equal((await getStyles(await ref('#style-target'))).styles['font-size'], '20px');
    const evaluate = (...args) => scoped('eval', ...args);
    const approve = async (expression) => {
      await assert.rejects(evaluate(expression), /Open the VABU popup/);
      evalAllowed = false;
      allowEval = true;
      await until(() => evalAllowed);
    };
    const expression = '({main: !!target, count: window.evalCount = (window.evalCount || 0) + 1})';
    await approve(expression);
    assert.deepEqual(await evaluate(expression), { main: true, count: 1 });
    await assert.rejects(evaluate(expression), /Open the VABU popup/);
    await approve(expression);
    await scoped('tab-navigate', String(tab), url);
    await until(() => scoped('use', String(tab)).catch(() => null));
    await assert.rejects(evaluate(expression), /Open the VABU popup/);
    await approve('window.evalCount ?? 0');
    assert.equal(await evaluate('window.evalCount ?? 0'), 0);
    await approve(expression);
    assert.deepEqual(await evaluate(expression), { main: true, count: 1 });
    for (const [code, pattern] of [['Promise.resolve(1)', /not a synchronous JSON value/],
      ['"é".repeat(8192)', /exceeds 16 KiB/],
      ['(() => { throw new Error("private exception"); })()', /^Eval expression is invalid or threw an exception$/]]) {
      await approve(code);
      await assert.rejects(evaluate(code), { message: pattern });
    }
    const setMode = async mode => {
      evalMode = mode;
      await until(() => savedMode === mode);
    };
    await setMode('off');
    await assert.rejects(evaluate('1 + 1'), /Eval is off/);
    await setMode('allow');
    assert.equal(await evaluate('1 + 1'), 2);
    for (const path of ['csp', 'trusted-types']) {
      const restricted = await scoped('open', url + path);
      await until(() => scoped('use', String(restricted.tab)).catch(() => null));
      await assert.rejects(evaluate('location.origin'), /blocked by the page’s Content Security Policy or Trusted Types/);
    }
    await scoped('release');
    recallTab = tab;
    assert.equal(await until(() => recallResult), 'ok');
    assert.deepEqual(await scoped('feedback'), { feedback: [{ page: url, target: '#style-target', note: 'Older annotation' }] });
    assert.deepEqual(await scoped('feedback'), { feedback: [] });

    const foreground = await scoped('open', url + 'foreground');
    await scoped('tab-show', String(foreground.tab));
    await until(() => scoped('use', String(foreground.tab)).catch(() => null));
    await until(() => scoped('snapshot').then(value => value.title === 'Foreground scroll fixture').catch(() => false));
    scrollSteps.length = 0;
    assert.equal(await scoped('scroll', '100'), true);
    assert.deepEqual(await until(() => foregroundWheel), ['100', 'true', 'false']);
    assert.deepEqual(scrollSteps, ['page-start', 'page-end', 'mouseMoved-start', 'mouseMoved-end', 'mouseWheel-start', 'mouseWheel-end']);
    browser.kill();
    await browserEnded;
  } finally {
    if (browser?.exitCode === null && browser.signalCode === null && browser.pid) {
      const ended = once(browser, 'exit');
      browser.kill('SIGKILL');
      await ended;
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
