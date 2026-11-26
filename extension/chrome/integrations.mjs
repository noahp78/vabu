const handoffs = new Set(['download', 'upload', 'clipboard-copy', 'clipboard-paste', 'export', 'show-tab', 'sign-in']);

function argsCount(args, count) {
  if (args.length !== count) throw new Error('Invalid integration command arguments');
}

async function checked(ctx, run) {
  await ctx.assertCurrent();
  const result = await run();
  await ctx.assertCurrent();
  return result;
}

async function approve(ctx, action, handoff) {
  if (typeof ctx.confirmIntegration !== 'function') throw new Error('Trusted extension confirmation is unavailable');
  await ctx.assertCurrent();
  // Confirmation belongs to this request, not to a CLI flag or a reusable token.
  if (await ctx.confirmIntegration(action, { handoff }) !== true) throw new Error('User did not confirm');
  await ctx.assertCurrent();
}

function manual(action) {
  return async (args, ctx) => {
    argsCount(args, 0);
    if (typeof ctx.pauseForManualHandoff !== 'function') throw new Error('Secure manual handoff is unavailable');
    async function requireExport() {
      if (await checked(ctx, () => ctx.page('integration-export-available')) !== true) {
        throw new Error('No same-origin download link observed; site export is unsupported');
      }
    }
    if (action === 'export') await requireExport();
    await approve(ctx, action, true);
    if (action === 'export') await requireExport();
    // The trusted boundary must recheck identity, pause bridge commands and detach before showing the tab.
    if (await ctx.pauseForManualHandoff(action) !== true) throw new Error('Manual handoff did not complete');
    return { handoff: action, manual: true };
  };
}

const unavailable = (reason) => async () => { throw new Error(reason); };

function dimension(value) {
  if (!/^[1-9][0-9]{0,3}$/.test(value) || Number(value) < 200 || Number(value) > 4096) {
    throw new Error('Viewport dimensions must be integers from 200 to 4096 CSS pixels');
  }
  return Number(value);
}

export const commands = Object.freeze({
  __proto__: null,
  'download': manual('download'),
  'upload': manual('upload'),
  'clipboard-copy': manual('clipboard-copy'),
  'clipboard-paste': manual('clipboard-paste'),
  'export': manual('export'),
  'sign-in': manual('sign-in'),
  'show-tab': manual('show-tab'),
  'hide-tab': unavailable('Chrome has no scoped temporary tab-hide API'),
  'confirm': async (args, ctx) => {
    argsCount(args, 1);
    if (!handoffs.has(args[0])) throw new Error('Unsupported confirmation intent');
    await approve(ctx, args[0], false);
    return { confirmed: true, action: args[0] };
  },
  'assets': async (args, ctx) => {
    argsCount(args, 0);
    return checked(ctx, () => ctx.page('integration-assets'));
  },
  'inspect-page': async (args, ctx) => {
    argsCount(args, 0);
    return checked(ctx, () => ctx.page('integration-inspect'));
  },
  'layout-metrics': async (args, ctx) => {
    argsCount(args, 0);
    if (typeof ctx.integrationLayoutMetrics !== 'function') throw new Error('Scoped layout diagnostics are unavailable');
    return checked(ctx, async () => {
      const result = await ctx.integrationLayoutMetrics();
      const width = result?.cssLayoutViewport?.clientWidth;
      const height = result?.cssLayoutViewport?.clientHeight;
      if (![width, height].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid layout metrics');
      return { width, height };
    });
  },
  'console-logs': unavailable('Safe console capture is unavailable; raw log payloads may contain credentials'),
  'viewport': async (args, ctx) => {
    const reset = args.length === 1 && args[0] === 'reset';
    if (!reset) argsCount(args, 2);
    if (typeof ctx.integrationViewport !== 'function') throw new Error('Temporary scoped viewport is unavailable');
    const dimensions = reset ? null : { width: dimension(args[0]), height: dimension(args[1]) };
    // Adapter uses a fixed lease of at most 30s and clears emulation on navigation and session teardown.
    await checked(ctx, () => ctx.integrationViewport(dimensions));
    return reset ? { reset: true } : { ...dimensions, expiresWithinMs: 30000 };
  },
  'webmcp-list': unavailable('No supported public WebMCP consumer API is wired'),
  'webmcp-call': unavailable('No supported public WebMCP consumer API or scoped invocation approval is wired'),
});

// Serialized as a fixed function in the main document's ISOLATED world, never in the site world.
export function inPageIntegration(origin, operation) {
  if (window !== window.top || location.origin !== origin) throw new Error('Integration document is out of scope');
  if (operation === 'integration-inspect') {
    return { readyState: document.readyState, visibility: document.visibilityState, width: innerWidth, height: innerHeight };
  }
  if (operation === 'integration-assets') {
    // shortcut: aggregate the first 250 buffered resource entries; use a bounded observer if recent events are required.
    const entries = performance.getEntriesByType('resource');
    const counts = { image: 0, script: 0, styleOrLink: 0, media: 0, other: 0 };
    for (let i = 0; i < Math.min(entries.length, 250); i++) {
      const entry = entries[i];
      let url;
      try { url = new URL(entry.name); } catch { continue; }
      if (url.origin !== origin || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) continue;
      const type = entry.initiatorType;
      if (type === 'img' || type === 'image') counts.image++;
      else if (type === 'script') counts.script++;
      else if (type === 'css' || type === 'link') counts.styleOrLink++;
      else if (type === 'audio' || type === 'video' || type === 'track') counts.media++;
      else counts.other++;
    }
    return { counts, truncated: entries.length > 250 };
  }
  if (operation === 'integration-export-available') {
    // shortcut: inspect at most 250 links and only explicit download anchors; otherwise use manual download.
    const links = document.links;
    for (let i = 0; i < Math.min(links.length, 250); i++) {
      const link = links[i];
      if (link.localName !== 'a' || !link.hasAttribute('download')) continue;
      let url;
      try { url = new URL(link.href); } catch { continue; }
      if (url.origin === origin && !url.username && !url.password && ['https:', 'http:'].includes(url.protocol)) return true;
    }
    return false;
  }
  throw new Error('Unsupported integration page operation');
}
