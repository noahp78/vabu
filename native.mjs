import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { privateSocketDirectory, requestLimit, responseLimit, socketPath } from './socket.mjs';

process.umask(0o077);
const pending = new Map();
const clients = new Set();
let input = Buffer.alloc(0);
let configured = false;
const configTimeout = setTimeout(() => startupError('Timed out waiting for VABU native configuration'), 10_000).unref();

function send(message) {
  const data = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([header, data]));
}

const server = createServer((client) => {
  if (clients.size >= 4) return client.destroy();
  clients.add(client);
  let buffer = Buffer.alloc(0);
  let id;
  client.setTimeout(18_000, () => client.destroy());
  client.on('error', () => client.destroy());
  client.on('close', () => {
    clients.delete(client);
    pending.delete(id);
  });
  client.on('data', (chunk) => {
    if (id || buffer.length + chunk.length > requestLimit) return client.destroy();
    buffer = Buffer.concat([buffer, chunk]);
    if (!buffer.includes(10)) return;
    try {
      const args = JSON.parse(buffer.toString('utf8'));
      if (!Array.isArray(args) || args.length < 1 || args.length > (args[0] === '--session' ? 8 : 6)
        || !args.every((arg) => typeof arg === 'string')) throw new Error('Invalid command');
      id = randomUUID();
      pending.set(id, client);
      send({ id, args });
    } catch (error) {
      client.end(JSON.stringify({ error: error.message }) + '\n');
    }
  });
});

function shutdown() {
  clearTimeout(configTimeout);
  for (const client of clients) client.destroy();
  server.close();
}

function startupError(error) {
  clearTimeout(configTimeout);
  process.stdin.destroy();
  send({ startupError: error });
}

function configure(message) {
  if (message?.type !== 'configure' || !Object.hasOwn(message, 'socketName') || Object.keys(message).length !== 2) {
    throw new Error('Invalid VABU native configuration');
  }
  const { socketName } = message;
  const path = socketPath(socketName); // Validate the name and path before creating the directory or binding.
  privateSocketDirectory(true);
  configured = true;
  clearTimeout(configTimeout);
  server.listen(path, () => send({ ready: true, socketName }));
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32LE(0);
    if (!configured && size > 1024) return startupError('Invalid VABU native configuration');
    if (size > responseLimit) { shutdown(); return process.stdin.destroy(); }
    if (input.length < size + 4) return;
    let message;
    try { message = JSON.parse(input.subarray(4, size + 4).toString('utf8')); }
    catch {
      if (!configured) return startupError('Invalid VABU native configuration');
      shutdown();
      return process.stdin.destroy();
    }
    input = input.subarray(size + 4);
    if (!configured) {
      try { configure(message); }
      catch (error) { return startupError(error.message); }
      continue;
    }
    const client = pending.get(message?.id);
    if (client) {
      pending.delete(message.id);
      client.end(JSON.stringify({ value: message.value, error: message.error }) + '\n');
    }
  }
});
process.stdin.on('end', shutdown);
process.stdout.on('error', () => { shutdown(); process.stdin.destroy(); });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { shutdown(); process.stdin.destroy(); });
}
server.maxConnections = 4;
server.on('error', (error) => startupError(error.code === 'EADDRINUSE'
  ? 'Socket already in use. Stop the other VABU bridge or choose a distinct socket name; see README for stale sockets.'
  : error.message));
