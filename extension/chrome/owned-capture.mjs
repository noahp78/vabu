import { validateCapture } from '../shared/capture-jpeg.mjs';

// Chrome-only building block; not a command handler. Integration must create a
// guard before capture, installing a root-navigation/ownership/permission
// watcher before its initial validation. assertValid() must reject on any
// transient change since installation as well as validate the current selected
// VABU-owned tab, authorized HTTP(S) root document and document identity. It
// must also reject if the debugger detaches or the selected tab changes. close()
// removes the watcher. Neither callback may trust page-controlled state.
// sendCommand must address exactly the supplied tabId (never the active tab).
// Visible cross-origin iframe pixels are intentionally included.
export async function captureOwnedViewport({ tabId, createGuard, sendCommand, format = 'jpeg', quality = 80 }) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof createGuard !== 'function' || typeof sendCommand !== 'function') {
    throw new Error('Invalid capture integration');
  }
  const guard = await createGuard(tabId);
  if (!guard || typeof guard.assertValid !== 'function' || typeof guard.close !== 'function') {
    throw new Error('Invalid capture guard');
  }
  let timer;
  try {
    await guard.assertValid();
    const result = await Promise.race([
      sendCommand({ tabId }, 'Page.captureScreenshot', {
        format, ...(format === 'jpeg' ? { quality } : {}), captureBeyondViewport: false,
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chrome screenshot timed out')), 12_000); }),
    ]);
    await guard.assertValid();
    return validateCapture(result?.data, format);
  } finally {
    clearTimeout(timer);
    await guard.close();
  }
}
