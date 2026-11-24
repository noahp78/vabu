import assert from 'node:assert/strict';
import test from 'node:test';
import { changedRatio, clampClip, frameFingerprint, screenshotInPage, screenshotRequest } from '../extension/screenshot.mjs';
import { parseScreenshotArgs, screenshotFileName } from '../screenshot-options.mjs';

test('CLI parses agent-browser screenshot arguments', () => {
  assert.deepEqual(parseScreenshotArgs([]), {
    path: null, dir: null,
    options: { full: false, annotate: false, ifChanged: false, threshold: 0, selector: null, format: 'png' },
  });
  assert.equal(parseScreenshotArgs(['./page.png']).path, './page.png');
  assert.equal(parseScreenshotArgs(['@r3']).options.selector, '@r3');
  const both = parseScreenshotArgs(['#main', 'out/shot.jpg', '--full', '--annotate', '--json']);
  assert.equal(both.path, 'out/shot.jpg');
  assert.deepEqual(both.options, { full: true, annotate: true, ifChanged: false, threshold: 0, selector: '#main', format: 'jpeg' });
  assert.deepEqual(parseScreenshotArgs(['-f', '--threshold', '0.01']).options,
    { full: true, annotate: false, ifChanged: true, threshold: 0.01, selector: null, format: 'png' });
  assert.deepEqual(parseScreenshotArgs(['--screenshot-format', 'jpeg', '--screenshot-quality', '70', '--screenshot-dir', 'shots']),
    { path: null, dir: 'shots', options: { full: false, annotate: false, ifChanged: false, threshold: 0, selector: null, format: 'jpeg', quality: 70 } });
  const env = parseScreenshotArgs([], { VACU_SCREENSHOT_DIR: '/tmp/s', VACU_SCREENSHOT_FORMAT: 'jpeg', VACU_SCREENSHOT_QUALITY: '40' });
  assert.deepEqual([env.dir, env.options.format, env.options.quality], ['/tmp/s', 'jpeg', 40]);
  assert.equal(parseScreenshotArgs(['--screenshot-quality', '50']).options.quality, undefined, 'quality only applies to jpeg');
  assert.throws(() => parseScreenshotArgs(['a.png', '--screenshot-format', 'jpeg']), /does not match/);
  assert.throws(() => parseScreenshotArgs(['#a', 'page.gif']), /must end in/);
  assert.throws(() => parseScreenshotArgs(['--threshold', '2']), /0 to 1/);
  assert.throws(() => parseScreenshotArgs(['--screenshot-quality', '101']), /0-100/);
  assert.throws(() => parseScreenshotArgs(['--bogus']), /Unknown/);
  assert.throws(() => parseScreenshotArgs(['a', 'b.png', 'c']), /Usage/);
  assert.equal(screenshotFileName('jpeg', new Date(2026, 0, 2, 3, 4, 5), 'ab12'), 'screenshot-20260102-030405-ab12.jpg');
  assert.equal(screenshotFileName('png', new Date(2026, 10, 24, 13, 0, 9)), 'screenshot-20261124-130009.png');
});

test('worker validates normalized screenshot requests', () => {
  assert.deepEqual(screenshotRequest('{}'),
    { target: null, full: false, annotate: false, format: 'png', quality: null, ifChanged: false, threshold: 0 });
  assert.deepEqual(screenshotRequest('{"selector":"@r12","format":"jpeg","quality":80}').target, { ref: '@r12' });
  assert.equal(screenshotRequest('{"format":"jpeg","quality":80}').quality, 80);
  assert.deepEqual(screenshotRequest('{"selector":"main  >  .hero"}').target, { css: 'main>.hero' });
  assert.throws(() => screenshotRequest('{"selector":"a[href=\\"x\\"]"}'), /CSS locator supports only/);
  assert.throws(() => screenshotRequest('{"selector":"#a","full":true}'), /either a selector or --full/);
  assert.throws(() => screenshotRequest('{"format":"webp"}'), /png or jpeg/);
  assert.throws(() => screenshotRequest('{"quality":1.5,"format":"jpeg"}'), /quality/);
  assert.throws(() => screenshotRequest('{"threshold":-1}'), /Threshold/);
  assert.throws(() => screenshotRequest('{"script":"x"}'), /Invalid screenshot options/);
  assert.throws(() => screenshotRequest('[]'), /Invalid screenshot options/);
});

test('frame guard fails closed on frames VACU cannot access', async () => {
  const allowed = async (url) => url.hostname !== 'blocked.test';
  const main = { frameId: 0, documentId: 'D0', url: 'https://example.test/' };
  assert.equal(await frameFingerprint([main, { frameId: 4, documentId: 'D4', url: 'about:srcdoc' }], allowed), '0:D0,4:D4');
  assert.notEqual(await frameFingerprint([main, { frameId: 4, documentId: 'D5', url: 'about:blank' }], allowed),
    await frameFingerprint([main, { frameId: 4, documentId: 'D4', url: 'about:blank' }], allowed));
  for (const url of ['https://blocked.test/', 'chrome-extension://abc/viewer.html', 'data:text/html,x', 'https://u:p@example.test/']) {
    await assert.rejects(frameFingerprint([main, { frameId: 1, documentId: 'D1', url }], allowed), /not granted/);
  }
  await assert.rejects(frameFingerprint([{ ...main, url: 'about:blank' }], allowed), /not granted/);
  await assert.rejects(frameFingerprint([main, { frameId: 2, url: 'https://example.test/' }], allowed), /could not be verified/);
  await assert.rejects(frameFingerprint([], allowed), /Could not list/);
});

test('pixel comparison and clip bounds', () => {
  const image = (...pixels) => ({ width: pixels.length, height: 1, data: Uint8ClampedArray.from(pixels.flat()) });
  assert.equal(changedRatio(image([0, 0, 0, 255], [1, 1, 1, 255]), image([0, 0, 0, 255], [1, 1, 1, 255])), 0);
  assert.equal(changedRatio(image([0, 0, 0, 255], [1, 1, 1, 255]), image([0, 0, 0, 255], [1, 1, 2, 255])), 0.5);
  assert.equal(changedRatio(image([0, 0, 0, 255]), image([0, 0, 0, 255], [0, 0, 0, 255])), 1);
  assert.equal(changedRatio(undefined, image([0, 0, 0, 255])), 1);
  assert.deepEqual(clampClip({ x: -2, y: 5, width: 100, height: 40000 }),
    { clip: { x: 0, y: 5, width: 100, height: 16384 }, clipped: true });
  assert.throws(() => clampClip({ x: 0, y: 0, width: 0, height: 10 }), /no visible area/);
});

test('in-page preparation resolves targets, labels controls, hides and restores the cursor', (t) => {
  const origin = 'https://example.test';
  const appended = [];
  const element = (rect, extra = {}) => ({
    isConnected: true, getBoundingClientRect: () => rect, checkVisibility: () => true, ...extra,
  });
  const styleOf = () => {
    const values = {};
    return { values, setProperty: (name, value) => { values[name] = value; }, getPropertyValue: (name) => values[name] ?? '' };
  };
  const node = () => {
    const children = [];
    return { style: styleOf(), children, append: (...items) => children.push(...items),
      remove() { appended.splice(appended.indexOf(this), 1); },
      attachShadow: () => ({ append: (...items) => children.push(...items) }) };
  };
  const cursor = { style: styleOf() };
  const targets = [element({ left: 10, top: 20, width: 30, height: 10 }), element({ left: 0, top: 0, width: 0, height: 0 })];
  const hero = element({ left: 1, top: 2, width: 300, height: 100 });
  const globals = {
    window: {}, location: { origin }, scrollX: 5, scrollY: 100,
    piChrome: { key: 'k', cursor, targets },
    document: {
      createElement: () => node(),
      documentElement: { append: (item) => appended.push(item) },
      querySelectorAll: (css) => css === '.hero' ? [hero] : css === 'p' ? [hero, hero] : [],
    },
  };
  globals.window.top = globals.window;
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  assert.match(screenshotInPage('https://other.test', 'k', 'prepare', {}).error, /origin/);
  assert.match(screenshotInPage(origin, 'stale', 'prepare', {}).error, /changed/);
  assert.deepEqual(screenshotInPage(origin, 'k', 'prepare', { target: { ref: '@r1' } }),
    { ok: true, value: { clip: { x: 15, y: 120, width: 30, height: 10 } } });
  assert.equal(cursor.style.values.visibility, 'hidden');
  assert.deepEqual(screenshotInPage(origin, 'k', 'prepare', { target: { css: '.hero' } }).value.clip,
    { x: 6, y: 102, width: 300, height: 100 });
  assert.match(screenshotInPage(origin, 'k', 'prepare', { target: { css: 'p' } }).error, /Ambiguous/);
  assert.match(screenshotInPage(origin, 'k', 'prepare', { target: { css: 'nav' } }).error, /No visible element/);
  assert.match(screenshotInPage(origin, 'k', 'prepare', { target: { ref: '@r9' } }).error, /Stale ref/);
  assert.deepEqual(screenshotInPage(origin, 'k', 'prepare', { annotate: true }), { ok: true, value: { clip: null } });
  assert.equal(appended.length, 1);
  const [box] = appended[0].children;
  assert.equal(appended[0].children.length, 1, 'zero-size controls get no label');
  assert.equal(box.style.values.left, '15px');
  assert.equal(box.children[0].textContent, '1');
  assert.equal(box.children[0].style.values.transform, 'translateY(-100%)', 'label sits above a control with room');
  assert.deepEqual(screenshotInPage(origin, 'k', 'restore'), { ok: true, value: true });
  assert.equal(appended.length, 0);
  assert.equal(cursor.style.values.visibility, '');
});
