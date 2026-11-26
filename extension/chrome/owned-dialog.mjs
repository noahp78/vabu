// Chrome-only state helper, not a command handler or an authorization check.
// Create one instance for the selected, validated VABU-owned tab. Route only
// that tab's ordered root-target Page events here; invalidate synchronously on
// navigation, selection/ownership loss, detach or tab close. Dispose the old
// instance before selecting another tab. Only track openings observed after
// Page events are enabled and the document scope is verified. Do not inspect the page by
// injecting JavaScript while a modal is open: execution may be blocked.
//
// CDP has no dialog identifier: a close/open or navigation can race an already
// dispatched command. Invalidation prevents reuse and stale completion, but
// cannot retract a command or guarantee which dialog Chrome handles. The caller
// must serialize event delivery and commands for the tab, and treat such races
// as indeterminate; never retry automatically.
export function createOwnedDialog({ tabId, sendCommand }) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof sendCommand !== 'function') {
    throw new Error('Invalid dialog integration');
  }
  let current = null;
  let pending;
  let disposed = false;

  function invalidate() {
    current = null;
    if (pending) {
      pending.state = 'stale';
      pending.wake();
    }
  }

  return {
    // Only type is read from opening parameters; dialog contents are never kept.
    opening({ type } = {}) {
      if (disposed) return;
      invalidate();
      if (type === 'alert' || type === 'confirm' || type === 'prompt') {
        current = { id: crypto.randomUUID(), type };
      }
    },
    closed({ result } = {}) {
      // Never read the userInput field from this event.
      if (pending && pending.dialog === current && pending.state === 'open') {
        current = null;
        pending.state = result === pending.accept ? 'closed' : 'stale';
        pending.wake();
      } else {
        invalidate();
      }
    },
    invalidate,
    dispose() { disposed = true; invalidate(); },
    getCurrent() { return current ? { ...current } : null; },
    async respond(id, action) {
      if (disposed || !current || current.id !== id || pending ||
          (action !== 'accept' && action !== 'dismiss')) {
        throw new Error('Invalid or stale dialog response');
      }
      const { promise, resolve: wake } = Promise.withResolvers();
      const accept = action === 'accept';
      const attempt = pending = { dialog: current, state: 'open', accept, wake };
      let timer;
      try {
        await sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept });
        // Chrome may report the close before resolving the command. Require
        // both, without consuming an ID from a later opening event.
        if (attempt.state === 'open') {
          timer = setTimeout(wake, 1000);
          await promise;
        }
        if (attempt.state !== 'closed') throw new Error('Unconfirmed close');
      } catch {
        throw new Error('Dialog response outcome indeterminate; do not retry the ID');
      } finally {
        clearTimeout(timer);
        if (current === attempt.dialog) current = null;
        pending = undefined;
      }
    },
  };
}
