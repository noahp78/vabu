import assert from 'node:assert/strict';
import test from 'node:test';
import { browserInstructions } from '../extension/shared/browser-instructions.mjs';

test('built-in instructions report load errors and reject a stopped bridge', async () => {
  const originalFetch = globalThis.fetch;
  const runtime = { getManifest: () => ({ version: '1.0' }) };
  try {
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(browserInstructions(runtime, 'chrome', () => {}), /Unable to load browser instructions: HTTP 404/);
    globalThis.fetch = async () => new Response('built-in');
    await assert.rejects(browserInstructions(runtime, 'firefox', () => { throw new Error('Bridge stopped'); }), /Bridge stopped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
