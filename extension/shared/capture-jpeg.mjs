// Keep below socket.mjs responseLimit (8 MiB), leaving room for envelopes.
export const maxCaptureBase64Length = 8 * 1024 * 1024 - 1024;

export function validateCapture(data, format) {
  const signature = format === 'png' ? /^iVBORw0KGg[o-r]/ : /^\/9j\//;
  if (typeof data !== 'string' || data.length > maxCaptureBase64Length || data.length % 4 !== 0
      || !signature.test(data) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error(`Invalid or oversized ${format.toUpperCase()} screenshot`);
  }
  return data;
}

export function captureOptions(args) {
  if (!args.length) return { format: 'jpeg', quality: 80, legacy: true };
  const invalid = () => new Error('Invalid viewport screenshot options');
  if (args.length !== 1 || args[0].length > 256) throw invalid();
  let options;
  try { options = JSON.parse(args[0]); } catch { throw invalid(); }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    !Object.keys(options).every(key => ['format', 'quality', 'ifChanged', 'threshold'].includes(key))) throw invalid();
  const { format = 'png', quality = format === 'jpeg' ? 80 : undefined, ifChanged = false, threshold = 0 } = options;
  if (!['png', 'jpeg'].includes(format) || (format === 'png' ? quality !== undefined
    : !Number.isInteger(quality) || quality < 0 || quality > 100) || typeof ifChanged !== 'boolean'
    || typeof threshold !== 'number' || !(threshold >= 0 && threshold <= 1) || (!ifChanged && threshold !== 0)) throw invalid();
  return { format, quality, ifChanged, threshold };
}

async function pixels(data) {
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const { width, height } = bitmap;
    if (!width || !height || width * height > 16_000_000) throw new Error('Viewport is too large for screenshot comparison');
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, width, height);
  } finally { bitmap.close(); }
}

export function changedRatio(previous, next) {
  if (previous.width !== next.width || previous.height !== next.height) return 1;
  const { data: a } = previous;
  const { data: b } = next;
  let changed = 0;
  for (let i = 0; i < b.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) changed++;
  }
  return changed / (next.width * next.height);
}

// Commit comparison history only after the caller's final document checks succeed.
export async function captureResponse(data, options, previous, documentKey) {
  if (options.legacy) return { value: data };
  const { format, quality, threshold } = options;
  if (!options.ifChanged) return { value: { format, data } };
  const key = JSON.stringify([documentKey, format, quality]);
  const same = previous?.key === key;
  const ratio = !same ? 1 : previous.data === data ? 0 : changedRatio(await pixels(previous.data), await pixels(data));
  if (same && ratio <= threshold) return { value: { format, changedRatio: ratio, unchanged: true } };
  return { value: { format, changedRatio: ratio, data }, next: { key, data } };
}
