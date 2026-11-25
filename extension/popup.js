const status = document.querySelector('#status');
const bridge = document.querySelector('#bridge');

async function update(action) {
  bridge.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action });
    if (result?.error) throw new Error(result.error);
    const { connected } = await chrome.runtime.sendMessage({ action: 'status' });
    bridge.textContent = connected ? 'Stop local bridge' : 'Start local bridge';
    status.textContent = connected ? 'Bridge is running.' : 'Bridge is stopped.';
    bridge.onclick = () => update(connected ? 'stop' : 'start');
  } catch (error) {
    status.textContent = error.message;
  } finally {
    bridge.disabled = false;
  }
}

const approval = document.querySelector('#approval');
const target = document.querySelector('#approval-target');
const approvalStatus = document.querySelector('#approval-status');
const decisions = ['deny', 'allow'].map((decision) => [decision, document.querySelector(`#${decision}`)]);
const port = chrome.runtime.connect({ name: 'tab-approval' });
let token;

port.onMessage.addListener(({ state, request }) => {
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
});
port.onDisconnect.addListener(() => {
  token = undefined;
  approval.hidden = true;
  approvalStatus.textContent = 'Tab approvals unavailable. Reopen the VACU popup to retry.';
});
for (const [decision, button] of decisions) {
  button.addEventListener('click', (event) => {
    if (!event.isTrusted || !token) return;
    for (const [, control] of decisions) control.disabled = true;
    port.postMessage({ token, decision });
  });
}

const feedback = document.querySelector('#feedback');
feedback.addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  feedback.disabled = true;
  const status = document.querySelector('#feedback-status');
  status.textContent = '';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'feedback-start' });
    if (!result?.ok) throw new Error(result?.error || 'Unable to open feedback');
    window.close();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    feedback.disabled = false;
  }
});

void update('status');
