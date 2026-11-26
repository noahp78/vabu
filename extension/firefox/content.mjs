// Packaged as a classic isolated content script, with the shared page functions inlined.
export function install(interactionInPage, inspectionPage, scopedSnapshotInPage, waitTextInPage, getElementInPage) {
  if (window !== window.top || globalThis.vabuFirefoxInstalled) return;
  globalThis.vabuFirefoxInstalled = true;
  let active;
  let closeActive;
  const css = (node, properties) => {
    for (const [name, value] of Object.entries(properties)) node.style.setProperty(name, value, 'important');
  };
  const svg = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'vabu-selected-document' || port.sender?.id !== browser.runtime.id || port.sender?.tab) return;
    closeActive?.();
    active = port;
    let state;
    const disconnect = closeActive = () => { clear(); port.disconnect(); };
    function clear() {
      if (active !== port) return;
      active = closeActive = undefined;
      state?.host.remove();
      delete globalThis.vabuCursorState;
      delete globalThis.vabuInspectionState;
      removeEventListener('pagehide', disconnect);
      removeEventListener('hashchange', disconnect);
      removeEventListener('popstate', disconnect);
    }
    port.onDisconnect.addListener(clear);
    addEventListener('pagehide', disconnect);
    addEventListener('hashchange', disconnect);
    addEventListener('popstate', disconnect);

    const ok = (value) => ({ ok: true, value });
    function assertCurrent() {
      if (active !== port || !state?.host.isConnected || location.href !== state.href || globalThis.origin !== state.origin) {
        throw new Error('Firefox document changed; select it again');
      }
    }
    async function run(op, args) {
      if (op === 'init') {
        const [href, origin, key] = args;
        if (active !== port || state || !/^https?:$/.test(location.protocol) || origin === 'null' || location.origin !== origin ||
            globalThis.origin !== origin || location.href !== href) throw new Error('Firefox document is not authorized');
        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        css(host, { all: 'initial', display: 'block', position: 'fixed', inset: '0',
          'z-index': '2147483647', 'pointer-events': 'none', overflow: 'clip' });
        const cursor = svg('svg', { viewBox: '0 0 38 40' });
        cursor.append(svg('circle', { cx: 12, cy: 12, r: 9, fill: '#6d28d988', stroke: 'white', opacity: 0 }),
          svg('path', { d: 'M12 12 L33 25 L24 26 L20 35 Z', fill: '#6d28d9', stroke: 'white', 'stroke-width': 2 }));
        css(cursor, { position: 'absolute', top: '0', left: '0', width: '38px', height: '40px',
          transform: `translate(${innerWidth / 2 - 12}px, ${innerHeight / 2 - 12}px)` });
        host.attachShadow({ mode: 'closed' }).append(cursor);
        document.documentElement.append(host);
        state = globalThis.vabuCursorState = { key, href, origin, host, cursor, title: () => document.title };
        return ok(true);
      }
      assertCurrent();
      switch (op) {
        case 'title': return ok(document.title.slice(0, 200));
        case 'snapshot': {
          state.targets = Array.from(document.querySelectorAll(
            'a[href], button, input:not([type=hidden],[type=file]), select, textarea, summary, [contenteditable=true], [role=button], [role=link]'
          )).filter((el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).slice(0, 100);
          const controls = state.targets.map((el, i) => ({ ref: `@r${i + 1}`, role: el.getAttribute('role') || el.localName,
            name: (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || (el.isContentEditable ? '' : el.innerText)
              || el.getAttribute('placeholder') || '').trim().slice(0, 150) }));
          return ok({ title: document.title.slice(0, 200), text: document.body?.innerText.trim().slice(0, 4000) ?? '', controls });
        }
        case 'scopedSnapshot': return scopedSnapshotInPage(state.origin, state.key, ...args);
        case 'getElement': return getElementInPage(state.origin, state.key, ...args);
        case 'waitText': return ok(waitTextInPage(state.origin, ...args));
        case 'findControl': return scopedSnapshotInPage(state.origin, state.key, 'uniqueControl', args[0], null, args[1]);
        case 'findInteraction': {
          const [ticket, phase, payload] = args;
          const match = state.find;
          if (!match || match.ticket !== ticket) throw new Error('Find target expired');
          if (phase === 'commit') delete state.find;
          const verified = match.verify();
          if (!verified.ok) return verified;
          // Only the guarded preview/commit sees this private ref; existing snapshot refs stay intact.
          const hadTargets = Object.hasOwn(state, 'targets');
          const previous = state.targets;
          try {
            state.targets = match.targets;
            return interactionInPage(state.origin, state.key, phase, payload);
          } finally {
            if (hadTargets) state.targets = previous;
            else delete state.targets;
          }
        }
        case 'interaction': return interactionInPage(state.origin, state.key, ...args);
        case 'inspect': return inspectionPage(state.origin, state.key, ...args);
        case 'waitCursor': {
          if (document.hidden) return ok(false);
          let raf;
          let timeout;
          try {
            await Promise.race([
              new Promise((resolve) => {
                raf = requestAnimationFrame(() => {
                  raf = requestAnimationFrame(async () => {
                    await Promise.allSettled(state.cursor.getAnimations().map((a) => a.finished));
                    resolve();
                  });
                });
              }),
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Cursor preview did not paint; click cancelled')), 1100); }),
            ]);
          } finally {
            cancelAnimationFrame(raf);
            clearTimeout(timeout);
          }
          await new Promise((resolve) => setTimeout(resolve, 180));
          return ok(!document.hidden);
        }
        default: throw new Error('Unsupported Firefox page operation');
      }
    }
    port.onMessage.addListener(async ({ id, op, args }) => {
      let result;
      try {
        result = await run(op, args);
        assertCurrent();
      } catch (error) {
        result = { error: error.message };
      }
      if (active === port) port.postMessage({ id, result });
    });
  });
}
