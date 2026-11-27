import { defaultSocketNames, socketNameError, validSocketName } from './socket-name.mjs';

const runtime = (globalThis.browser ?? globalThis.chrome).runtime;
const homeView = document.querySelector('#home-view');
const settingsView = document.querySelector('#settings-view');
const settingsToggle = document.querySelector('#settings-toggle');

settingsToggle.addEventListener('click', () => {
  const showSettings = settingsView.hidden;
  homeView.hidden = showSettings;
  settingsView.hidden = !showSettings;
  settingsToggle.textContent = showSettings ? 'Back' : 'Settings';
  settingsToggle.setAttribute('aria-expanded', String(showSettings));
});
const status = document.querySelector('#status');
const bridge = document.querySelector('#bridge');
const bridgeState = document.querySelector('#bridge-state');
const bridgeSocket = document.querySelector('#bridge-socket');
const bridgeCopyStatus = document.querySelector('#bridge-copy-status');
const effectiveSocket = document.querySelector('#effective-socket');
const cliHint = document.querySelector('#cli-hint');
const cliCommand = document.querySelector('#cli-command');
const copySocket = document.querySelector('#copy-socket');
const copyCli = document.querySelector('#copy-cli');
const copyStatus = document.querySelector('#copy-status');
const socketForm = document.querySelector('#socket-form');
const socketInput = document.querySelector('#socket');
const socketStatus = document.querySelector('#socket-status');
const socketSave = document.querySelector('#socket-save');
const feedback = document.querySelector('#feedback');
const feedbackStatus = document.querySelector('#feedback-status');
const feedbackInbox = document.querySelector('#feedback-inbox');
const feedbackCount = document.querySelector('#feedback-count');
const feedbackInboxStatus = document.querySelector('#feedback-inbox-status');
const feedbackNotes = document.querySelector('#feedback-notes');
const recall = document.querySelector('#feedback-recall');
let inboxCount = 0;
let inboxRevision = 0;
const evalApproval = document.querySelector('#eval-approval');
const evalOrigin = document.querySelector('#eval-origin');
const evalExpression = document.querySelector('#eval-expression');
const evalStatus = document.querySelector('#eval-status');
const evalAllow = document.querySelector('#eval-allow');
const evalDeny = document.querySelector('#eval-deny');
const evalSettingsForm = document.querySelector('#eval-settings-form');
const evalMode = document.querySelector('#eval-mode');
const evalModeSave = document.querySelector('#eval-mode-save');
const evalSettingsStatus = document.querySelector('#eval-settings-status');
let savedEvalMode = 'ask';
let evalToken;
let evalBusy = false;
let feedbackBusy = false;
let current;
let savedSocket = '';
let busy = false;
let timer;
let revision = 0;
let bridgeActionError;

async function send(message) {
  const result = await runtime.sendMessage(message);
  if (!result || result.error) throw new Error(result?.error || 'VABU background did not respond');
  return result;
}

function controls() {
  bridge.disabled = busy || !current;
  feedback.disabled = busy || feedbackBusy || !current?.connected;
  recall.disabled = feedback.disabled || !inboxCount;
  bridgeSocket.disabled = busy || bridgeSocket.hidden;
  evalAllow.disabled = evalDeny.disabled = busy || evalBusy || !evalToken;
  evalMode.disabled = busy || !current?.evalMode;
  evalModeSave.disabled = evalMode.disabled || evalMode.value === savedEvalMode;
  copySocket.disabled = copyCli.disabled = busy || !current;
  socketInput.disabled = socketSave.disabled = busy || !current || current.connected || current.starting;
}

async function update(message) {
  if (busy) return;
  clearTimeout(timer);
  const request = ++revision;
  busy = !!message;
  if (busy) controls();
  let saved = false;
  let evalSaved = false;
  if (message) {
    if (message.action === 'set-eval-mode') evalSettingsStatus.textContent = '';
    else {
      bridgeActionError = undefined;
      socketStatus.textContent = '';
    }
    try {
      await send(message);
      saved = message.action === 'set-socket';
      evalSaved = message.action === 'set-eval-mode';
    } catch (error) {
      if (message.action === 'set-socket') socketStatus.textContent = error.message;
      else if (message.action === 'set-eval-mode') evalSettingsStatus.textContent = error.message;
      else bridgeActionError = error.message;
    }
  }
  try {
    const result = await send({ action: 'status' });
    if (request !== revision) return;
    current = result;
    const { connected, starting, browser, socketName, socketOverride, bridgeError } = current;
    showEvalApproval(connected ? current.evalApproval : undefined);
    if (current.evalMode) {
      if (evalSaved || !evalMode.value || evalMode.value === savedEvalMode) evalMode.value = current.evalMode;
      savedEvalMode = current.evalMode;
    }
    updateFeedbackCount(connected ? current.feedbackCount ?? 0 : 0);
    effectiveSocket.textContent = socketName;
    cliCommand.textContent = `vabu --socket ${socketName} status`;
    cliHint.hidden = false;
    socketInput.placeholder = defaultSocketNames[browser];
    if (browser === 'chrome') connectApproval();
    if (browser === 'firefox') void refreshScreenshotPermission();
    if (saved || connected || starting || socketInput.value === savedSocket) socketInput.value = socketOverride ?? '';
    savedSocket = socketOverride ?? '';
    if (saved) socketStatus.textContent = 'Socket name saved. Start the local bridge to use it.';
    if (connected || starting) bridgeActionError = undefined;
    const error = bridgeError || bridgeActionError;
    bridge.textContent = connected || starting ? 'Stop local bridge' : 'Start local bridge';
    status.textContent = error || (connected ? 'Bridge is running.' : starting ? 'Bridge is starting…' : 'Bridge is stopped.');
    setBadge(error ? 'error' : connected ? 'online' : 'offline', socketName);
  } catch (error) {
    if (request !== revision) return;
    current = undefined;
    showEvalApproval();
    updateFeedbackCount(0);
    effectiveSocket.textContent = 'Unavailable';
    cliHint.hidden = true;
    status.textContent = error.message;
    setBadge('error');
  } finally {
    if (request === revision) {
      busy = false;
      controls();
      timer = setTimeout(() => void update(), 1500);
    }
  }
}

function updateFeedbackCount(count) {
  if (count === inboxCount) return;
  inboxCount = count;
  feedbackInbox.hidden = !count;
  feedbackCount.textContent = count === 1 ? '1 sent annotation' : `${count} sent annotations`;
  if (!count) {
    feedbackInbox.open = false;
    clearFeedbackPreview();
  } else if (feedbackInbox.open) void showFeedbackPreview();
}

function clearFeedbackPreview() {
  ++inboxRevision;
  feedbackInboxStatus.textContent = '';
  feedbackNotes.replaceChildren();
}

async function showFeedbackPreview() {
  clearFeedbackPreview();
  const revision = inboxRevision;
  feedbackInboxStatus.textContent = 'Loading annotations…';
  try {
    const { feedback: notes, total } = await send({ action: 'feedback-list' });
    if (revision !== inboxRevision || !feedbackInbox.open) return;
    for (const { page, target, note, workspace } of notes) {
      const item = document.createElement('li');
      const context = document.createElement('p');
      context.className = 'hint';
      context.textContent = [workspace, page, target].filter(Boolean).join(' · ');
      const content = document.createElement('p');
      content.className = 'note';
      content.textContent = note;
      item.append(context, content);
      feedbackNotes.append(item);
    }
    feedbackInboxStatus.textContent = total > notes.length ? `Showing ${notes.length} of ${total}. Use vabu feedback to retrieve the rest.`
      : total ? '' : 'No sent annotations are waiting.';
  } catch (error) {
    if (revision === inboxRevision) feedbackInboxStatus.textContent = error.message;
  }
}

feedbackInbox.addEventListener('toggle', () => {
  if (feedbackInbox.open && !feedbackInbox.hidden) void showFeedbackPreview();
  else clearFeedbackPreview();
});

function showEvalApproval(request) {
  if (evalToken === request?.token) return;
  evalToken = request?.token;
  evalApproval.hidden = !evalToken;
  evalOrigin.textContent = request?.origin ?? '';
  // Display format characters explicitly so they cannot reorder the code shown for consent.
  evalExpression.textContent = (request?.expression ?? '').replace(/\p{Cf}/gu, (char) =>
    `\\u{${char.codePointAt(0).toString(16)}}`);
  if (evalToken) evalStatus.textContent = '';
}

for (const [button, action, message] of [
  [evalAllow, 'eval-approve', 'Allowed once. Retry the same eval command.'],
  [evalDeny, 'eval-deny', 'JavaScript request denied.'],
]) {
  button.addEventListener('click', async (event) => {
    if (!event.isTrusted || button.disabled || !evalToken) return;
    const token = evalToken;
    evalBusy = true;
    controls();
    evalStatus.textContent = '';
    try {
      await send({ action, token });
      if (evalToken === token) showEvalApproval();
      evalStatus.textContent = message;
    } catch (error) {
      evalStatus.textContent = error.message;
    } finally {
      evalBusy = false;
      controls();
      void update();
    }
  });
}

function setBadge(state, socketName) {
  const online = state === 'online';
  if (!online || bridgeSocket.textContent !== socketName) bridgeCopyStatus.textContent = '';
  bridgeState.dataset.state = state;
  bridgeState.hidden = online;
  bridgeState.textContent = online ? '' : state === 'error' ? 'Error' : 'Offline';
  bridgeSocket.hidden = !online;
  bridgeSocket.textContent = online ? socketName : '';
  bridgeSocket.setAttribute('aria-label', online ? `Bridge online. Copy socket name: ${socketName}` : '');
}

for (const [button, value, label, resultStatus, confirmation = ''] of [
  [bridgeSocket, effectiveSocket, 'Socket name', bridgeCopyStatus],
  [copySocket, effectiveSocket, 'Socket name', copyStatus],
  [copyCli, cliCommand, 'CLI command', copyStatus, 'CLI command copied.'],
]) {
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    try {
      await navigator.clipboard.writeText(value.textContent);
      resultStatus.textContent = confirmation;
    } catch {
      resultStatus.textContent = `Could not copy ${label.toLowerCase()}.`;
    }
  });
}

bridge.addEventListener('click', () => {
  if (current) void update({ action: current.connected || current.starting ? 'stop' : 'start' });
});
socketInput.addEventListener('input', () => { socketStatus.textContent = ''; });
socketForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (socketSave.disabled) return;
  const socketOverride = socketInput.value || null;
  if (socketOverride !== null && !validSocketName(socketOverride)) {
    socketStatus.textContent = socketNameError;
    return;
  }
  void update({ action: 'set-socket', socketOverride });
});

evalMode.addEventListener('change', () => {
  evalSettingsStatus.textContent = '';
  controls();
});
evalSettingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!event.isTrusted || evalModeSave.disabled) return;
  void update({ action: 'set-eval-mode', evalMode: evalMode.value });
});

const approval = document.querySelector('#approval');
const target = document.querySelector('#approval-target');
const approvalStatus = document.querySelector('#approval-status');
const decisions = ['deny', 'allow'].map((decision) => [decision, document.querySelector(`#${decision}`)]);
let approvalPort;
let token;
let approvalAttempted = false;

function connectApproval() {
  if (approvalAttempted) return;
  approvalAttempted = true;
  function unavailable() {
    token = undefined;
    approval.hidden = true;
    approvalStatus.textContent = 'Tab approvals unavailable. Reopen the VABU popup to retry.';
  }
  try {
    approvalPort = runtime.connect({ name: 'tab-approval' });
    approvalPort.onMessage.addListener(showApproval);
    approvalPort.onDisconnect.addListener(() => {
      // Reading lastError also suppresses an unchecked Chrome runtime warning.
      void runtime.lastError;
      unavailable();
    });
  } catch {
    unavailable();
  }
}

function showApproval({ state, request }) {
  token = state === 'pending' ? request.token : undefined;
  approval.hidden = !token;
  if (token) {
    target.textContent = `Tab ${request.tab} · ${request.origin}`;
    for (const [, button] of decisions) button.disabled = false;
  }
  approvalStatus.textContent = {
    allowed: state === 'allowed' ? `Allowed. Ask the requester to retry use ${request.tab}.` : '',
    denied: 'Tab control denied.',
    cancelled: 'Tab control request cancelled.',
    expired: 'Tab control request expired.',
    used: 'Tab approval used.',
  }[state] ?? '';
}
for (const [decision, button] of decisions) {
  button.addEventListener('click', (event) => {
    if (!event.isTrusted || !token) return;
    for (const [, control] of decisions) control.disabled = true;
    approvalPort.postMessage({ token, decision });
  });
}

const screenshotSection = document.querySelector('#screenshots');
const screenshotButton = document.querySelector('#screenshot-permission');
const screenshotStatus = document.querySelector('#screenshot-status');
const screenshotGrant = { origins: ['<all_urls>'] };
let screenshotGranted;
let screenshotBusy = false;
let screenshotRevision = 0;

async function refreshScreenshotPermission() {
  const permissions = globalThis.browser?.permissions;
  if (!permissions || screenshotBusy) return;
  const revision = ++screenshotRevision;
  screenshotSection.hidden = false;
  let granted;
  try { granted = await permissions.contains(screenshotGrant); } catch {}
  if (revision !== screenshotRevision) return;
  screenshotGranted = granted;
  screenshotButton.disabled = typeof granted !== 'boolean';
  screenshotButton.textContent = granted ? 'Revoke screenshot access' : 'Enable screenshots';
}

screenshotButton.addEventListener('click', async (event) => {
  if (!event.isTrusted || current?.browser !== 'firefox' || screenshotBusy || screenshotButton.disabled) return;
  ++screenshotRevision;
  screenshotBusy = screenshotButton.disabled = true;
  screenshotStatus.textContent = '';
  const permissions = globalThis.browser.permissions;
  try {
    if (screenshotGranted) await permissions.remove(screenshotGrant);
    else {
      // Keep the trusted click for Firefox, then get the toolbar popup out of the way.
      const request = permissions.request(screenshotGrant);
      window.close();
      if (!await request) screenshotStatus.textContent = 'All-sites access was not granted.';
    }
  } catch (error) {
    screenshotStatus.textContent = error.message;
  } finally {
    screenshotBusy = false;
    await refreshScreenshotPermission();
  }
});

for (const [button, action] of [[feedback, 'feedback-start'], [recall, 'feedback-recall']]) {
  button.addEventListener('click', async (event) => {
    if (!event.isTrusted || button.disabled || (button === recall && !feedbackInbox.open)) return;
    feedbackBusy = true;
    controls();
    feedbackStatus.textContent = '';
    try {
      await send({ action });
      window.close();
    } catch (error) {
      feedbackStatus.textContent = error.message;
    } finally {
      feedbackBusy = false;
      controls();
    }
  });
}

controls();
void update();
