import { webUrl } from './domains.js';

const maxTimeout = 15_000;
const pollInterval = 100;
const normalize = (text) => text.normalize('NFC').replace(/\s+/g, ' ').trim();

async function wait(args, ctx) {
  const [flag, input, timeoutFlag, duration] = args;
  if (!['--url', '--text'].includes(flag) || typeof input !== 'string'
    || (args.length !== 2 && (args.length !== 4 || timeoutFlag !== '--timeout'))) {
    throw new Error('Usage: wait --url URL [--timeout MS] or wait --text TEXT [--timeout MS]');
  }
  const ms = args.length === 2 ? 5_000 : Number(duration);
  if (args.length === 4 && (!/^\d+$/.test(duration) || ms < 1 || ms > maxTimeout)) {
    throw new Error('Wait timeout must be an integer from 1 to 15000 ms');
  }
  const kind = flag.slice(2);
  let value;
  if (kind === 'url') {
    let url;
    try { url = webUrl(input); } catch { throw new Error('Wait URL must be HTTP(S) without credentials'); }
    if (url.origin !== ctx.origin) throw new Error('Wait URL must match the selected tab origin');
    value = url.href;
  } else {
    value = normalize(input);
    if (!value) throw new Error('Wait text must not be empty');
  }
  if (!ctx.origin || typeof ctx.observeWait !== 'function') throw new Error('Wait is unavailable without an approved selection');

  const deadline = performance.now() + ms;
  let expired = false;
  let timer;
  let nextPoll;
  const timedOut = new Error('Wait timed out');
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(timedOut); }, ms);
      }),
      (async () => {
        while (!expired && performance.now() < deadline) {
          let matched;
          try {
            // The observer checks the original selection and authorization on both sides of every read.
            matched = await ctx.observeWait(kind, value);
          } catch {
            if (expired || performance.now() >= deadline) throw timedOut;
            throw new Error('Wait aborted: selected tab or document is no longer observable');
          }
          const remaining = deadline - performance.now();
          if (expired || remaining <= 0) break;
          if (matched === true) return { matched: true };
          if (matched !== false) throw new Error('Wait aborted: invalid observation');
          await new Promise((resolve) => { nextPoll = setTimeout(resolve, Math.min(pollInterval, remaining)); });
        }
        throw timedOut;
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    clearTimeout(nextPoll);
  }
}

export const commands = { wait };

// Standalone for isolated-world injection in the current top document only.
export function waitTextInPage(origin, text) {
  if (location.origin !== origin || window !== window.top) throw new Error('Wait document changed');
  const body = document.body;
  if (!body || body.isContentEditable) return false;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, (node) =>
    node.nodeType === Node.ELEMENT_NODE && node.matches('script,style,noscript,template,iframe,frame,object,embed,input,textarea,select,[contenteditable]:not([contenteditable="false"])')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT);
  const range = document.createRange();
  let rendered = '';
  let block;
  // shortcut: limit each sample to 10k nodes and 100k characters; use a targeted locator for larger pages.
  for (let i = 0, node; i < 10_000 && rendered.length < 100_000 && (node = walker.nextNode()); i++) {
    if (node.nodeName === 'BR' && node.getClientRects().length) rendered += ' ';
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const parent = node.parentElement;
    const style = getComputedStyle(parent);
    const masking = style.getPropertyValue('-webkit-text-security');
    if (style.visibility !== 'visible' || (masking && masking !== 'none')) continue;
    let box = parent;
    while (box && getComputedStyle(box).display === 'contents') box = box.parentElement;
    if (!box?.checkVisibility({ opacityProperty: true })) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    let container = box;
    while (container && container !== body && ['inline', 'contents'].includes(getComputedStyle(container).display)) {
      container = container.parentElement;
    }
    if (block && block !== container) rendered += ' ';
    block = container;
    rendered += node.data.slice(0, 100_000 - rendered.length);
  }
  return rendered.normalize('NFC').replace(/\s+/g, ' ').includes(text);
}
