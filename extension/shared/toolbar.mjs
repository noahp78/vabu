const sizes = [16, 32, 48, 128];

export function isToolbarPopup(runtime, sender) {
  return !!sender && typeof runtime.id === 'string' && sender.id === runtime.id && sender.url === runtime.getURL('shared/popup.html')
    && !sender.tab && (sender.frameId === undefined || sender.frameId === 0);
}

export function setBridgeIcon(action, online) {
  // Chromium resolves relative icon paths against the background worker's directory.
  const base = online ? '/shared/icons/vabu-online' : '/shared/icons/vabu';
  return action.setIcon({ path: Object.fromEntries(sizes.map(size => [size, `${base}-${size}.png`])) }).catch(() => {});
}
