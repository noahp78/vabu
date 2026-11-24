#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseScreenshotArgs, screenshotFileName } from './screenshot-options.mjs';
import { privateDirectory, requestLimit, responseLimit, socketPath } from './socket.mjs';

const usage = `vacu status | tabs | use TAB_ID | release
vacu open URL                  Open a background tab; run use TAB_ID before wait or snapshot
vacu snapshot                  Page text and control references
vacu --pretty COMMAND ...      Indent JSON for human readers (default: compact)
vacu [--session ID] snapshot --brief  Short page preview with clickable refs
vacu [--session ID] snapshot --find TEXT   Find controls by name; keep clickable refs
vacu [--session ID] snapshot --regex PATTERN   Match control names with a case-insensitive regex
vacu [--session ID] snapshot --role ROLE [--find TEXT | --regex PATTERN]
vacu snapshot --within SELECTOR [--role ROLE]
vacu find role ROLE --name NAME click
vacu wait --url URL | --text TEXT [--timeout MS]
vacu get text|href @rN
vacu [--session ID] inspect-query --brief LOCATOR_JSON  Short match list
vacu click @rN | click X Y     Click a fresh control or viewport point
vacu move X Y | hover @rN      Move the virtual cursor to a point or control
vacu type TEXT                 Insert text into the focused text field
vacu scroll DY [@rN]           Wheel-scroll over the cursor or a control
vacu screenshot [SELECTOR] [PATH]  Save a PNG/JPEG of the viewport, @rN or a CSS-selected element (Chrome)
    --full, -f                 Capture the full page, not just the viewport
    --annotate                 Take a snapshot and label each control [N] = @rN; prints the legend
    --if-changed               Skip writing if the image matches the previous capture of this tab
    --threshold 0-1            Changed-pixel ratio still treated as unchanged (implies --if-changed)
    --screenshot-dir DIR       Directory when no PATH is given (VACU_SCREENSHOT_DIR, default: temp)
    --screenshot-format FMT    png (default) or jpeg (VACU_SCREENSHOT_FORMAT, or PATH extension)
    --screenshot-quality 0-100 JPEG quality (VACU_SCREENSHOT_QUALITY)
vacu cursor-move TARGET | mouse-click BUTTON MODIFIERS TARGET | double-click TARGET
vacu drag X1 Y1 X2 Y2 | wheel DX DY [TARGET] | keypress CHORD
vacu insert-text TEXT | fill @rN TEXT | select-option @rN VALUE | set-checked @rN true|false
vacu inspect-query LOCATOR_JSON | inspect-element LOCATOR_JSON
vacu frames                    List same-origin iframe IDs and document IDs (Chrome)
vacu inspect-query [--brief] --frame ID DOCUMENT_ID LOCATOR_JSON
vacu inspect-click --frame ID DOCUMENT_ID @iREF
vacu inspect-wait visible|hidden TIMEOUT_MS LOCATOR_JSON
vacu inspect-wait domcontentloaded|load TIMEOUT_MS
vacu title | url | tab-info | assets | inspect-page | layout-metrics
vacu session-start NAME | session-list
vacu --session ID open URL | tabs | use TAB_ID | session-status | session-end
vacu --session ID COMMAND ...  Target a named session; select its tab before page commands
vacu session-start | session-status | session-handoff | session-restore | session-audit
vacu session-result ok|failed|cancelled | session-end
TARGET is @rN or X Y; use - for no mouse modifiers. New interactions use synthetic events; inspection is main-document only.`;

async function request(args) {
  const line = JSON.stringify(args) + '\n';
  if (Buffer.byteLength(line) > requestLimit) throw new Error('Command too large');
  privateDirectory();
  const client = createConnection(socketPath);
  client.setTimeout(19_000, () => client.destroy(new Error('Command timed out')));
  client.on('connect', () => client.write(line));
  const chunks = [];
  let size = 0;
  for await (const chunk of client) {
    size += chunk.length;
    if (size > responseLimit + 128) {
      client.destroy();
      throw new Error('Response too large');
    }
    chunks.push(chunk);
  }
  if (!size) throw new Error('Bridge closed or command timed out. Verify the tab before retrying.');
  const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (response.error) throw new Error(response.error);
  return response.value;
}

const args = process.argv.slice(2);
const pretty = args[0] === '--pretty';
if (pretty || args[0] === '--compact') args.shift();

function brief(value, verb) {
  if (verb === 'snapshot') {
    const { title, text, controls } = value;
    const preview = Array.from(text).slice(0, 480).join('');
    return { v: 1, title, text: preview,
      controls: controls.slice(0, 20).map(({ ref, role, name }) => [ref, role, name]),
      truncated: { text: preview !== text, controls: controls.length > 20 } };
  }
  const { count, items, truncated } = value;
  return { v: 1, count, truncated: truncated || items.length > 10,
    items: items.slice(0, 10).map(({ ref, role, name, visible, enabled }) => [ref, role, name, visible, enabled]) };
}

function filterControls({ title, controls }, { role, term = '', regex }) {
  if (role) controls = controls.filter(control => control.role.trim().toLowerCase().split(/\s+/)[0] === role);
  const normalize = (text) => text.normalize('NFC').replace(/\s+/g, ' ').trim();
  const names = controls.map(({ name }) => normalize(name));
  const pattern = normalize(term).toLowerCase();
  // Keep pathological caller-supplied patterns from hanging the CLI.
  const hits = regex
    ? runInNewContext('const pattern = new RegExp(term, "iu"); names.map(name => pattern.test(name))',
      { names, term }, { timeout: 100 })
    : names.map(name => name.toLowerCase().includes(pattern));
  const matches = controls.filter((_, i) => hits[i]);
  return { title, count: matches.length, truncated: matches.length > 20,
    controls: matches.slice(0, 20).map(({ ref, role, name }) => [ref, role, name]) };
}

try {
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log(usage);
  } else if (args[args[0] === '--session' ? 2 : 0] === 'screenshot') {
    const index = args[0] === '--session' ? 2 : 0;
    const { path, dir, options } = parseScreenshotArgs(args.slice(index + 1), process.env);
    const { data, ...value } = await request([...args.slice(0, index + 1), JSON.stringify(options)]);
    if (value.unchanged) {
      console.log(JSON.stringify(value, null, pretty ? 2 : 0));
    } else {
      const image = Buffer.from(data ?? '', 'base64');
      const png = image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const jpeg = image[0] === 0xff && image[1] === 0xd8;
      if (!(options.format === 'png' ? png : jpeg)) throw new Error(`Chrome did not return a ${options.format.toUpperCase()} image`);
      const file = resolve(path ?? join(dir ?? join(tmpdir(), 'vacu-screenshots'),
        screenshotFileName(options.format, new Date(), randomBytes(3).toString('hex'))));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, image, { mode: 0o600 });
      console.log(JSON.stringify({ path: file, ...value }, null, pretty ? 2 : 0));
    }
  } else {
    const index = args[0] === '--session' ? 2 : 0;
    const verb = args[index];
    if (verb === 'snapshot' && args[index + 1] === '--within') args[index] = 'scoped-snapshot';
    const short = ['snapshot', 'inspect-query'].includes(verb) && args[index + 1] === '--brief';
    let filters;
    if (verb === 'snapshot' && ['--find', '--regex', '--role'].includes(args[index + 1])) {
      filters = {};
      const options = args.splice(index + 1);
      for (let i = 0; i < options.length; i += 2) {
        const [flag, value] = [options[i], options[i + 1]];
        if (flag === '--role' && !filters.role && /^[a-z][a-z0-9-]*$/i.test(value ?? '')) {
          filters.role = value.toLowerCase();
        } else if (['--find', '--regex'].includes(flag) && !filters.term && value?.trim()) {
          filters.term = value;
          filters.regex = flag === '--regex';
          if (filters.regex) {
            if (value.length > 256) throw new Error('Regex must be at most 256 characters');
            new RegExp(value, 'iu');
          }
        } else {
          throw new Error('Usage: snapshot [--role ROLE] [--find TEXT | --regex PATTERN]');
        }
      }
    } else if (short) args.splice(index + 1, 1);
    const value = await request(args);
    const output = filters ? filterControls(value, filters) : short ? brief(value, verb) : value;
    console.log(JSON.stringify(output, null, pretty ? 2 : 0));
  }
} catch (error) {
  if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
    console.error('Missing file or inactive bridge. Open the VACU extension and start the local bridge.');
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}
