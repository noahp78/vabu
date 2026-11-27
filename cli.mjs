#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseScreenshotArgs, screenshotFileName } from './screenshot-options.mjs';
import { createConnection } from 'node:net';
import { runInNewContext } from 'node:vm';
import { privateSocketDirectory, requestLimit, responseLimit, socketPath } from './socket.mjs';
import { defaultSocketNames } from './extension/shared/socket-name.mjs';

const usage = `vabu setup [OPTIONS]           Set up the local browser extension and bridge
vabu status | tabs | use TAB_ID | release
vabu [--session ID] feedback   Read and clear submitted page comments
vabu open URL                  Open a background tab; run use TAB_ID before wait or snapshot
vabu [--session ID] tab-navigate TAB_ID URL [--wait-load]
vabu [--session ID] tab-show TAB_ID | tab-close TAB_ID [--wait-load]
vabu snapshot                  Page text and control references
vabu --pretty COMMAND ...      Indent JSON for human readers (default: compact)
vabu [--pretty|--compact] [--socket NAME] [--session ID] COMMAND ...
                               Select a local Unix socket (default: chrome-default)
vabu [--session ID] snapshot --brief  Short page preview with clickable refs
vabu [--session ID] snapshot --find TEXT   Find controls by name; keep clickable refs
vabu [--session ID] snapshot --regex PATTERN   Match control names with a case-insensitive regex
vabu [--session ID] snapshot --role ROLE [--find TEXT | --regex PATTERN]
vabu snapshot --within SELECTOR [--role ROLE]
vabu find role ROLE --name NAME click
vabu wait --url URL | --text TEXT [--timeout MS]
vabu get text|href @rN
vabu frame-list | frame-read FRAME_ID  Guarded direct iframe text in VABU-opened tabs
vabu frames                     List verified direct same-origin iframe ID/document pairs
vabu inspect-query [--brief] --frame ID DOCUMENT_ID LOCATOR_JSON
vabu inspect-element --frame ID DOCUMENT_ID LOCATOR_JSON
vabu inspect-wait --frame ID DOCUMENT_ID EVENT TIMEOUT_MS [LOCATOR_JSON]
vabu inspect-click --frame ID DOCUMENT_ID @iREF
vabu [--session ID] inspect-query --brief LOCATOR_JSON  Short match list
vabu click @rN | click X Y     Click a fresh control or viewport point
vabu move X Y | hover @rN      Move the virtual cursor to a point or control
vabu type TEXT                 Insert text into the focused text field
vabu scroll DY [@rN]           Wheel-scroll over the cursor or a control
vabu [--session ID] screenshot [NEW_FILE.png|jpg] [--if-changed | --threshold 0-1]
    --screenshot-dir DIR | --screenshot-format png|jpeg | --screenshot-quality 0-100
    Owned tab viewport, including visible iframe pixels (Firefox requires popup opt-in)
vabu [--session ID] inspect-dialog show | accept ID | dismiss ID  Owned Chrome tabs only
vabu [--session ID] console start | reload | read | stop        Owned Chrome tabs only
vabu [--session ID] js timing                                  Owned Chrome tabs only
vabu cursor-move TARGET | mouse-click BUTTON MODIFIERS TARGET | double-click TARGET
vabu drag X1 Y1 X2 Y2 | wheel DX DY [TARGET] | keypress CHORD
vabu insert-text TEXT | fill @rN TEXT | select-option @rN VALUE | set-checked @rN true|false
vabu inspect-query LOCATOR_JSON | inspect-element LOCATOR_JSON
vabu inspect-wait visible|hidden TIMEOUT_MS LOCATOR_JSON
vabu inspect-wait domcontentloaded|load TIMEOUT_MS
vabu title | url | tab-info | assets | inspect-page | layout-metrics
vabu session-start NAME | session-list
vabu --session ID open URL | tabs | use TAB_ID | session-status | session-end
vabu --session ID COMMAND ...  Target a named session; select its tab before page commands
vabu session-start | session-status | session-handoff | session-restore | session-audit
vabu session-result ok|failed|cancelled | session-end
TARGET is @rN or X Y; use - for no mouse modifiers. Frame operations in Firefox require 153+.`;

async function request(args) {
  const line = JSON.stringify(args) + '\n';
  if (Buffer.byteLength(line) > requestLimit) throw new Error('Command too large');
  const path = socketPath(socketName ?? defaultSocketNames.chrome);
  privateSocketDirectory();
  const client = createConnection(path);
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
let pretty;
let socketName;

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
  while (['--socket', '--pretty', '--compact'].includes(args[0])) {
    const flag = args.shift();
    if (flag === '--socket') {
      if (socketName !== undefined) throw new Error('Supply --socket only once');
      socketName = args.shift();
      socketPath(socketName); // Validate even when no command is supplied.
    } else {
      if (pretty !== undefined) throw new Error('Supply only one of --pretty or --compact');
      pretty = flag === '--pretty';
    }
  }
  const index = args[0] === '--session' ? 2 : 0;
  const verb = args[index];
  if (!args.length || ['help', '--help', '-h'].includes(args[0])) {
    console.log(usage);
  } else if (args[0].startsWith('-') && args[0] !== '--session') {
    throw new Error(`Unknown option: ${args[0]}`);
  } else if (args[0] === 'setup') {
    const { setup } = await import('./install.mjs');
    console.log(await setup(args.slice(1)));
  } else if (verb === 'screenshot') {
    const { path, dir, options } = parseScreenshotArgs(args.slice(index + 1), process.env);
    const { data, format, ...value } = await request([...args.slice(0, index + 1), JSON.stringify(options)]);
    if (format !== options.format) throw new Error('Browser returned an unexpected screenshot format');
    if (!value.unchanged) {
      const image = Buffer.from(data ?? '', 'base64');
      const valid = format === 'png'
        ? image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : image.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      if (!valid) throw new Error(`Browser did not return a ${format.toUpperCase()} image`);
      const file = resolve(path ?? join(dir ?? join(tmpdir(), 'vabu-screenshots'),
        screenshotFileName(format, new Date(), randomBytes(3).toString('hex'))));
      if (!path) await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, image, { flag: 'wx', mode: 0o600 });
      value.path = file;
    }
    console.log(JSON.stringify({ ...value, format }, null, pretty ? 2 : 0));
  } else {
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
    console.error(`Bridge not reachable on ${socketName ?? defaultSocketNames.chrome}. Open the VABU popup, check its socket name, and start the local bridge.`);
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}
