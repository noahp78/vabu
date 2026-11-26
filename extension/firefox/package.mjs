import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPackage, stageExtension } from '../stage.mjs';
import { interactionInPage } from '../shared/interaction.mjs';
import { inspectionPage } from '../shared/inspection.mjs';
import { scopedSnapshotInPage } from '../shared/scoped-snapshot.mjs';
import { waitTextInPage } from '../shared/wait.mjs';
import { getElementInPage } from '../shared/get-element.mjs';
import { install } from './content.mjs';

export async function stageFirefox(directory) {
  const output = await stageExtension('firefox', directory, ['background.mjs', 'frame-read.mjs']);
  // No dynamic imports/Web Accessible Resources, and no runtime compilation in the page.
  // Use secure random bytes on plain HTTP where Crypto.randomUUID may not be exposed.
  await writeFile(join(output, 'firefox/content.js'), `(() => {
      const crypto = { randomUUID() {
        if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
        const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      } };
      (${install})(${interactionInPage}, ${inspectionPage}, ${scopedSnapshotInPage}, ${waitTextInPage}, ${getElementInPage});
    })();\n`);
}

await runPackage(import.meta.url, 'firefox', stageFirefox);
