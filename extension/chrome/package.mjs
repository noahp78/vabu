import { runPackage, stageExtension } from '../stage.mjs';

export function stageChrome(directory) {
  return stageExtension('chrome', directory, [
    'worker.js', 'frame-read.mjs', 'owned-capture.mjs', 'owned-dialog.mjs', 'sessions.mjs', 'integrations.mjs',
  ]);
}

await runPackage(import.meta.url, 'chrome', stageChrome);
