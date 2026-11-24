const imageExtension = /\.(png|jpe?g)$/i;

// Parses agent-browser compatible screenshot flags: [SELECTOR] [PATH] plus options, in any order.
export function parseScreenshotArgs(argv, env = {}) {
  const positional = [];
  const options = { full: false, annotate: false, ifChanged: false, threshold: 0 };
  let dir = env.VACU_SCREENSHOT_DIR || null;
  let format = null;
  let quality = env.VACU_SCREENSHOT_QUALITY ?? null;
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--full' || arg === '-f') options.full = true;
    else if (arg === '--annotate') options.annotate = true;
    else if (arg === '--if-changed') options.ifChanged = true;
    else if (arg === '--json') {} // VACU always prints JSON; accepted for agent-browser compatibility.
    else if (arg === '--threshold') {
      const raw = value(i++, arg);
      const threshold = Number(raw);
      if (!/^\d*\.?\d+$/.test(raw) || threshold > 1) throw new Error('--threshold must be a number from 0 to 1');
      Object.assign(options, { threshold, ifChanged: true });
    } else if (arg === '--screenshot-dir') dir = value(i++, arg);
    else if (arg === '--screenshot-format') format = value(i++, arg);
    else if (arg === '--screenshot-quality') quality = value(i++, arg);
    else if (arg.startsWith('-')) throw new Error(`Unknown screenshot option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new Error('Usage: screenshot [SELECTOR] [PATH] [options]');
  let [selector = null, path = null] = positional;
  if (positional.length === 1 && imageExtension.test(selector)) [selector, path] = [null, selector];
  if (path !== null && !imageExtension.test(path)) throw new Error('Screenshot PATH must end in .png, .jpg or .jpeg');

  const fromPath = path && (/\.png$/i.test(path) ? 'png' : 'jpeg');
  format = (format ?? fromPath ?? env.VACU_SCREENSHOT_FORMAT ?? 'png').toLowerCase();
  if (format === 'jpg') format = 'jpeg';
  if (!['png', 'jpeg'].includes(format)) throw new Error('--screenshot-format must be png or jpeg');
  if (fromPath && fromPath !== format) throw new Error(`PATH extension does not match format ${format}`);
  if (quality !== null && quality !== '') {
    if (!/^\d{1,3}$/.test(String(quality)) || Number(quality) > 100) throw new Error('--screenshot-quality must be 0-100');
    quality = Number(quality);
  } else quality = null;
  return {
    path, dir,
    options: { ...options, selector, format, ...(format === 'jpeg' && quality !== null ? { quality } : {}) },
  };
}

export function screenshotFileName(format, date = new Date(), suffix = '') {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `screenshot-${stamp}${suffix ? '-' + suffix : ''}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}
