'use strict';

// OWNFLICK_TEST_PYTHON=/path/to/python node --test tests/browser/folders_collections.cjs
// Every API uses a disposable Flask/SQLite instance. Only media bytes are served
// from the bundled samples, so no user media/configuration is read or changed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const poster = path.join(root, 'spooly/static/radio/breeze-window-poster.jpg');
const folder = '@default/旅行 & # %';
const photos = Array.from({ length: 30 }, (_, i) => `${folder}/照片-${String(i).padStart(2, '0')}.jpg`);
const clip = `${folder}/片段 & # %.mp4`;
const fixtures = [...photos, clip, `${folder}/子目录/下一级.jpg`, '@default/only-child/nested/pic.jpg', '@default/song.mp3'];
let browser, server, origin, collectionId;
let logs = '';

before(async () => {
  server = spawn(process.env.OWNFLICK_TEST_PYTHON || 'python3', ['-B', '-u', '-c', `
import json, os, shutil, signal, tempfile
from pathlib import Path
from werkzeug.serving import make_server
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
with tempfile.TemporaryDirectory(prefix='ownflick-phase5-browser-') as temporary:
    data = Path(temporary)
    media = data / 'media'
    media.mkdir()
    for uri in json.loads(os.environ['OWNFLICK_BROWSER_FIXTURES']):
        target = media / uri.removeprefix('@default/')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix == '.jpg':
            shutil.copyfile(os.environ['OWNFLICK_BROWSER_POSTER'], target)
        else:
            target.write_bytes(b'Disposable browser fixture')
    os.environ['SPOOLY_INSTANCE'] = str(data / 'instance')
    from spooly.app import create_app
    app = create_app({'TESTING': True, 'MEDIA_ROOT': media})
    with make_server('127.0.0.1', 0, app, threaded=True) as server:
        print('OWNFLICK_TEST_URL=http://127.0.0.1:' + str(server.server_port), flush=True)
        server.serve_forever()
`], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', OWNFLICK_BROWSER_FIXTURES: JSON.stringify(fixtures), OWNFLICK_BROWSER_POSTER: poster },
  });
  server.stderr.on('data', (data) => { logs = (logs + data).slice(-8000); });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Flask startup timed out: ' + logs)), 20000);
    server.stdout.on('data', (data) => {
      output += data;
      const found = output.match(/OWNFLICK_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Flask exited ${code}: ${logs}`)); });
  });
  browser = await chromium.launch({
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }),
    headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext();
  try {
    await api(context, '/api/library/sync', { method: 'POST' });
    collectionId = (await api(context, '/api/collections', { method: 'POST', data: { name: '旅行选集' } })).item.id;
    await api(context, `/api/collections/${collectionId}/items`, {
      method: 'POST', data: { uris: [...photos, clip, '@default/song.mp3'] },
    });
  } finally { await context.close(); }
});

after(async () => {
  try { await browser?.close(); }
  finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
  }
});

async function api(context, url, options = {}) {
  const response = await context.request.fetch(origin + url, options);
  assert.equal(response.status(), 200, await response.text());
  const payload = await response.json();
  assert.equal(payload.success, true);
  return payload.data;
}

async function open(url, { mobile = false, intercept, viewport } = {}) {
  const context = await browser.newContext({
    viewport: viewport || (mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
    isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname.startsWith('/media/'), (route) => route.continue({
    url: origin + (decodeURIComponent(new URL(route.request().url()).pathname).endsWith('.mp4')
      ? '/static/radio/breeze-window.mp4' : '/static/radio/breeze-window-poster.jpg'),
  }));
  await page.route((url) => url.pathname === '/thumb', (route) => route.fulfill({ path: poster, contentType: 'image/jpeg' }));
  if (intercept) await intercept(page, context);
  await page.goto(origin + url);
  return { context, page, errors };
}
const active = (page) => page.locator('#feed-container > .active');
async function position(page, expected) {
  await page.waitForFunction((text) => document.getElementById('collection-playback-count').textContent === text, expected);
}
async function screenshot(page, name) {
  if (process.env.OWNFLICK_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, name + '.png') });
}

test('folder hierarchy, recursive counts and encoded sequential/random playback use real scoped feeds', async () => {
  const { context, page, errors } = await open('/folders');
  try {
    await page.locator('.folder-card-open').first().click();
    await page.waitForURL((url) => url.searchParams.get('folder') === '@default/');
    await page.getByRole('link', { name: '打开文件夹 旅行 & # %', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('folder') === folder);
    await page.waitForFunction(() => document.querySelector('#folder-play-current span').textContent.endsWith('32'));
    await page.locator('#folder-recursive').uncheck();
    assert.match(await page.locator('#folder-play-current').innerText(), /31/);
    await page.locator('#folder-play-current').click();
    await page.waitForURL((url) => url.pathname === '/flow' && url.searchParams.get('folder') === folder);
    assert.equal(new URL(page.url()).searchParams.get('recursive'), 'false');
    await active(page).waitFor();
    const expected = (await api(context, '/api/feed?' + new URLSearchParams({ folder, recursive: 'false', order: 'sequential', limit: '96' }))).items;
    assert.equal(expected.length, 31);
    assert.equal(await page.locator('#like-btn').getAttribute('data-value'), expected[0].name);
    await page.goto(origin + '/folders?' + new URLSearchParams({ folder }));
    await page.locator('[data-order="random"]').click();
    await page.locator('#folder-play-current:not(:disabled)').click();
    await active(page).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('order'), 'random');
    assert.equal(new URL(page.url()).searchParams.get('recursive'), 'true');
    assert.ok((await page.locator('#like-btn').getAttribute('data-value')).startsWith(folder + '/'));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('non-recursive playback disables folders containing only descendants', async () => {
  const { context, page, errors } = await open('/folders?' + new URLSearchParams({ folder: '@default/only-child' }));
  try {
    await page.locator('#folder-play-current:not(:disabled)').waitFor();
    await page.locator('#folder-recursive').uncheck();
    assert.equal(await page.locator('#folder-play-current').isDisabled(), true);
    await page.locator('#folder-recursive').check();
    assert.equal(await page.locator('#folder-play-current').isEnabled(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('collection video duration, current marker, cross-page jump and adjacent playback stay in collection order', async () => {
  const { context, page, errors } = await open('/flow?collection=' + collectionId);
  try {
    await position(page, '1 / 31');
    assert.equal(await page.locator('#like-btn').getAttribute('data-value'), clip);
    await page.locator('#collection-playback-open').click();
    await page.locator('.collection-playlist-item').nth(23).waitFor();
    assert.equal(await page.locator('.collection-playlist-item[aria-current="true"]').getAttribute('data-index'), '0');
    await page.waitForFunction(() => /^\d+:\d\d$/.test(document.querySelector('.collection-playlist-duration').textContent));
    await page.locator('#collection-playlist-more').click();
    await page.locator('.collection-playlist-item').nth(30).waitFor();
    await screenshot(page, 'desktop-collection-playlist');
    await page.locator('.collection-playlist-item[data-index="27"]').click();
    await position(page, '28 / 31');
    assert.equal(await page.locator('#like-btn').getAttribute('data-value'), photos[3]);
    await page.keyboard.press('ArrowDown');
    await position(page, '29 / 31');
    await page.keyboard.press('ArrowUp');
    await position(page, '28 / 31');
    await page.locator('#collection-playback-open').click();
    assert.equal(await page.locator('.collection-playlist-item[aria-current="true"]').getAttribute('data-index'), '27');
    await page.locator('.collection-playlist-item[data-index="1"]').click();
    await position(page, '2 / 31');
    assert.equal(await page.locator('#like-btn').getAttribute('data-value'), photos[29]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('playlist buttons support Space and the previous page remains reachable after jumping', async () => {
  const { context, page, errors } = await open('/flow?collection=' + collectionId);
  try {
    await position(page, '1 / 31');
    await page.locator('#collection-playback-open').click();
    await page.locator('.collection-playlist-item').nth(23).waitFor();
    await page.locator('#collection-playlist-more').focus();
    await page.keyboard.press('Space');
    await page.locator('.collection-playlist-item').nth(30).waitFor();
    await page.locator('.collection-playlist-item[data-index="24"]').focus();
    await page.keyboard.press('Space');
    await position(page, '25 / 31');
    await page.keyboard.press('ArrowUp');
    await position(page, '24 / 31');
    assert.equal(await page.locator('#like-btn').getAttribute('data-value'), photos[7]);
    await page.keyboard.press('ArrowDown');
    await position(page, '25 / 31');
    await page.locator('#collection-playback-open').click();
    await page.locator('#collection-playlist-close').focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('collection-playlist').getAttribute('aria-hidden') === 'true');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('touching the previous-page boundary after an episode jump loads its predecessor', async () => {
  const { context, page, errors } = await open('/flow?collection=' + collectionId, { mobile: true });
  try {
    await position(page, '1 / 31');
    await page.locator('#collection-playback-open').tap();
    await page.locator('#collection-playlist-more:not([hidden])').tap();
    await page.locator('.collection-playlist-item[data-index="24"]').tap();
    await position(page, '25 / 31');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 170, y: 200 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 170, y: 500 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await position(page, '24 / 31');
    assert.equal(await page.locator('#like-btn').getAttribute('data-value'), photos[7]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('late collection summary cannot replace playable count with audio/member count', async () => {
  let release, requested;
  const held = new Promise((resolve) => { release = resolve; });
  const arrived = new Promise((resolve) => { requested = resolve; });
  const { context, page } = await open('/flow?collection=' + collectionId, { intercept: async (page) => {
    await page.route((url) => url.pathname === `/api/collections/${collectionId}`, async (route) => {
      const response = await route.fetch();
      requested();
      await held;
      await route.fulfill({ response });
    });
  } });
  try {
    await arrived;
    await position(page, '1 / 31');
    const summary = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/collections/${collectionId}`);
    release();
    await summary;
    await page.waitForFunction(() => document.getElementById('collection-playback-name').textContent === '旅行选集');
    assert.equal(await page.locator('#collection-playback-count').innerText(), '1 / 31');
  } finally { release(); await context.close(); }
});

test('closing a loading playlist keeps it closed, preserves focus and does not page on keys', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { context, page, errors } = await open('/flow?collection=' + collectionId, { intercept: async (page) => {
    await page.route((url) => url.pathname === `/api/collections/${collectionId}/flow`, async (route) => {
      if (++calls === 2) await held;
      await route.continue();
    });
  } });
  try {
    await position(page, '1 / 31');
    await page.locator('#collection-playback-open').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#collection-playlist').getAttribute('aria-hidden'), 'true');
    release();
    await page.waitForFunction(() => document.querySelectorAll('.collection-playlist-item').length === 24);
    assert.equal(await page.locator('#collection-playlist').getAttribute('aria-hidden'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'collection-playback-open');
    await page.locator('#collection-playback-open').click();
    await page.keyboard.press('ArrowDown');
    await position(page, '1 / 31');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test('mobile playlist fits viewport, isolates touch, restores controls after clean mode, and adds a new collection', async () => {
  const { context, page, errors } = await open('/flow?collection=' + collectionId, { mobile: true });
  try {
    await position(page, '1 / 31');
    await page.locator('#collection-playback-open').tap();
    await page.locator('.collection-playlist-item').nth(23).waitFor();
    const box = await page.locator('.collection-playlist-sheet').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 845);
    await screenshot(page, 'mobile-collection-playlist');
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 700 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 520 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await position(page, '1 / 31');
    await page.locator('#collection-playlist-close').tap();
    await page.locator('#clean-mode-btn').tap();
    assert.equal(await page.locator('#collection-playback').evaluate((el) => el.inert), true);
    await page.locator('#clean-mode-exit').tap();
    await page.locator('#collection-btn').tap();
    await page.locator('#collection-modal.active').waitFor();
    await page.locator('#collection-name-input').fill('手机新建合集');
    await page.locator('#collection-create-btn').tap();
    await page.waitForFunction(() => document.querySelector('#collection-count').textContent === '2');
    const created = (await api(context, '/api/collections')).items.find((item) => item.name === '手机新建合集');
    assert.ok(created);
    assert.equal((await api(context, `/api/collections/${created.id}/flow`)).items[0].name, clip);
    await page.locator('#collection-modal-close').tap();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
