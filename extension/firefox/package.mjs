import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interactionInPage } from '../interaction.mjs';
import { inspectionPage } from '../inspection.mjs';
import { scopedSnapshotInPage } from '../scoped-snapshot.mjs';
import { waitTextInPage } from '../wait.mjs';
import { getElementInPage } from '../get-element.mjs';
import { install } from './content.mjs';
import { frameInspection } from './frames.mjs';

export async function stageFirefox(directory) {
  const output = resolve(directory);
  await mkdir(output); // Require a new directory; never overlay an existing extension.
  await mkdir(resolve(output, 'firefox'));
  await Promise.all([
    ...['popup.html', 'popup.js', 'domains.js', 'feedback.mjs', 'interaction.mjs', 'inspection.mjs',
      'scoped-snapshot.mjs', 'find-click.mjs', 'wait.mjs', 'get-element.mjs'].map((file) =>
      copyFile(new URL(`../${file}`, import.meta.url), resolve(output, file))),
    copyFile(new URL('./manifest.template.json', import.meta.url), resolve(output, 'manifest.json')),
    copyFile(new URL('./background.mjs', import.meta.url), resolve(output, 'firefox/background.mjs')),
    // No dynamic imports/Web Accessible Resources, and no runtime compilation in the page.
    // Use secure random bytes on plain HTTP where Crypto.randomUUID may not be exposed.
    writeFile(resolve(output, 'firefox/content.js'), `(() => {
      const crypto = { randomUUID() {
        if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      } };
      // Bind the shared read-only inspector to a pinned DOM document and private per-document ref state.
      const inspectFrame = ({ doc: document, win: window, realm: globalThis }, ...args) => {
        const { location, performance, innerWidth, innerHeight, scrollX, scrollY, MouseEvent } = window;
        return (${inspectionPage})(...args);
      };
      (${install})(${interactionInPage}, ${inspectionPage}, ${scopedSnapshotInPage}, ${waitTextInPage}, ${getElementInPage}, ${frameInspection}, inspectFrame);
    })();\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node extension/firefox/package.mjs NEW_DIRECTORY');
  await stageFirefox(process.argv[2]);
}
