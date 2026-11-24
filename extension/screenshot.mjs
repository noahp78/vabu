import { selector as typedSelector } from './inspection.mjs';

export const maxCaptureSize = 16384;
export const maxImageBase64 = 30 * 1024 * 1024;
const refPattern = /^@r[1-9]\d{0,2}$/;
const keys = ['selector', 'full', 'annotate', 'format', 'quality', 'ifChanged', 'threshold'];

// Validates the CLI's normalized option object; the worker never sees raw CLI flags.
export function screenshotRequest(input) {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('Invalid screenshot options');
  let options;
  try { options = JSON.parse(input); } catch { throw new Error('Invalid screenshot options'); }
  if (!options || typeof options !== 'object' || Array.isArray(options) || !Object.keys(options).every((key) => keys.includes(key))) {
    throw new Error('Invalid screenshot options');
  }
  const { selector = null, full = false, annotate = false, format = 'png', quality = null, ifChanged = false, threshold = 0 } = options;
  if (![full, annotate, ifChanged].every((flag) => typeof flag === 'boolean')) throw new Error('Invalid screenshot options');
  if (!['png', 'jpeg'].includes(format)) throw new Error('Screenshot format must be png or jpeg');
  if (quality !== null && (!Number.isInteger(quality) || quality < 0 || quality > 100)) {
    throw new Error('Screenshot quality must be an integer from 0 to 100');
  }
  if (typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1)) throw new Error('Threshold must be between 0 and 1');
  let target = null;
  if (selector !== null) {
    if (typeof selector !== 'string' || !selector.trim()) throw new Error('Invalid screenshot selector');
    if (full) throw new Error('Use either a selector or --full, not both');
    target = refPattern.test(selector)
      ? { ref: selector }
      : { css: typedSelector(JSON.stringify({ css: selector })).all[0].value };
  }
  return { target, full, annotate, format, quality: format === 'jpeg' ? quality : null, ifChanged, threshold };
}

// Every frame that can contribute pixels must be a document Chrome lets VACU access.
// Returns a fingerprint of the frame documents so callers can detect changes during capture.
export async function frameFingerprint(frames, hasAccess) {
  if (!Array.isArray(frames) || !frames.length) throw new Error('Could not list the frames in this tab');
  const ids = [];
  for (const frame of frames) {
    if (typeof frame?.documentId !== 'string' || frame.errorOccurred) throw new Error('A frame could not be verified; screenshot cancelled');
    let url;
    try { url = new URL(frame.url); } catch { throw new Error('A frame could not be verified; screenshot cancelled'); }
    const inherited = frame.frameId !== 0 && url.protocol === 'about:' && ['blank', 'srcdoc'].includes(url.pathname);
    if (!inherited) {
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !await hasAccess(url)) {
        throw new Error('Screenshot cancelled: the page shows a frame Chrome has not granted VACU access to');
      }
    }
    ids.push(`${frame.frameId}:${frame.documentId}`);
  }
  return ids.sort().join(',');
}

// Fraction of pixels that differ between two decoded RGBA images; size changes count as fully changed.
export function changedRatio(previous, next) {
  if (!previous || previous.width !== next.width || previous.height !== next.height) return 1;
  const total = next.width * next.height;
  if (!total) return 0;
  const a = previous.data;
  const b = next.data;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed++;
  }
  return changed / total;
}

export function clampClip({ x, y, width, height }) {
  const values = [x, y, width, height];
  if (!values.every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Screenshot target has no visible area');
  const clip = { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(width, maxCaptureSize), height: Math.min(height, maxCaptureSize) };
  return { clip, clipped: clip.width < width || clip.height < height };
}

// Self-contained function for chrome.scripting.executeScript in the ISOLATED world of the selected main document.
export function screenshotInPage(origin, key, operation, payload) {
  const fail = (error) => ({ error });
  const ok = (value) => ({ ok: true, value });
  if (window !== window.top || location.origin !== origin) return fail('Page changed origin or frame; authorize it again');
  const state = globalThis.piChrome;
  if (state?.key !== key) return fail('Selected document changed; select the tab again');
  const style = (element, properties) => {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
  };
  const restore = () => {
    state.screenshotLabels?.remove();
    delete state.screenshotLabels;
    if (state.screenshotCursor !== undefined) {
      state.cursor.style.setProperty('visibility', state.screenshotCursor);
      delete state.screenshotCursor;
    }
  };
  if (operation === 'restore') {
    restore();
    return ok(true);
  }
  if (operation !== 'prepare') return fail('Unsupported screenshot operation');
  restore();
  const { target, annotate } = payload ?? {};
  let clip = null;
  if (target) {
    let element;
    if (target.ref) {
      element = state.targets?.[Number(target.ref.slice(2)) - 1];
      if (!element?.isConnected) return fail('Stale ref; take a new snapshot');
    } else {
      const matches = Array.from(document.querySelectorAll(target.css))
        .filter((el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
      if (!matches.length) return fail('No visible element matches the selector');
      if (matches.length > 1) return fail('Ambiguous selector: ' + matches.length + ' visible elements match');
      element = matches[0];
    }
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return fail('Screenshot target has no visible area');
    clip = { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height };
  }
  if (annotate) {
    const host = document.createElement('div');
    style(host, {
      all: 'initial', display: 'block', position: 'absolute', top: '0', left: '0', width: '0', height: '0',
      overflow: 'visible', 'z-index': '2147483647', 'pointer-events': 'none',
    });
    const root = host.attachShadow({ mode: 'closed' });
    (state.targets ?? []).forEach((element, i) => {
      if (!element?.isConnected) return;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const box = document.createElement('div');
      style(box, {
        position: 'absolute', left: rect.left + scrollX + 'px', top: rect.top + scrollY + 'px',
        width: rect.width + 'px', height: rect.height + 'px', outline: '2px solid #6d28d9', 'box-sizing': 'border-box',
      });
      const label = document.createElement('span');
      label.textContent = String(i + 1);
      // Put the label above the control, or inside it when the control touches the top of the page.
      const above = rect.top + scrollY >= 16;
      style(label, {
        position: 'absolute', left: '-2px', top: above ? '-2px' : '0', transform: above ? 'translateY(-100%)' : 'none',
        background: '#6d28d9', color: '#fff', font: 'bold 11px/14px system-ui, sans-serif',
        padding: '0 4px', 'border-radius': '3px', 'white-space': 'nowrap',
      });
      box.append(label);
      root.append(box);
    });
    document.documentElement.append(host);
    state.screenshotLabels = host;
  }
  state.screenshotCursor = state.cursor.style.getPropertyValue('visibility');
  state.cursor.style.setProperty('visibility', 'hidden');
  return ok({ clip });
}
