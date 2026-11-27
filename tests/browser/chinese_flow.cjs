'use strict';

// OWNFLICK_TEST_PYTHON=.venv/bin/python node --test tests/browser/chinese_flow.cjs
// All writes use disposable media/data folders and an ephemeral local port.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const sampleImage = fs.readFileSync(path.join(root, 'spooly/static/radio/breeze-window-poster.jpg'));
const sampleVideo = fs.readFileSync(path.join(root, 'spooly/static/radio/breeze-window.mp4'));
let server;
let browser;
let origin;

before(async () => {
  server = spawn(process.env.OWNFLICK_TEST_PYTHON || path.join(root, '.venv/bin/python'), ['-B', '-u', '-c', `
import os, signal, shutil, tempfile
from pathlib import Path
from PIL import Image
from werkzeug.serving import make_server
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
with tempfile.TemporaryDirectory(prefix='ownflick-chinese-flow-') as temporary:
    base = Path(temporary)
    media = base / 'media'
    media.mkdir()
    for index in range(30):
        Image.new('RGB', (360, 540), (30 + index * 5, 80, 120)).save(media / f'照片-{index:02d}.jpg')
    for index in range(2):
        shutil.copyfile('spooly/static/radio/breeze-window.mp4', media / f'视频-{index}.mp4')
    os.environ['SPOOLY_INSTANCE'] = str(base / 'data')
    from spooly.app import create_app
    app = create_app({'TESTING': True, 'MEDIA_ROOT': media})
    with make_server('127.0.0.1', 0, app, threaded=True) as httpd:
        print('OWNFLICK_TEST_URL=http://127.0.0.1:' + str(httpd.server_port), flush=True)
        httpd.serve_forever()
`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stderr.on('data', (data) => { logs = (logs + data).slice(-12000); });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Isolated server startup timed out: ' + logs)), 20000);
    server.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/OWNFLICK_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${logs}`)); });
  });
  browser = await chromium.launch({
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});

after(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    await exited;
  }
});

async function newPage(mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile, hasTouch: mobile,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function screenshot(page, name) {
  if (!process.env.OWNFLICK_SCREENSHOT_DIR) return;
  fs.mkdirSync(process.env.OWNFLICK_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, name + '.png'), fullPage: true });
}

async function activeName(page) {
  return page.locator('#feed-container > .feed-media.active').evaluate((element) => element.dataset.name);
}

async function waitActive(page, uri) {
  await page.waitForFunction((name) => {
    const active = document.querySelectorAll('#feed-container > .feed-media.active');
    return active.length === 1 && (!name || active[0].dataset.name === name);
  }, uri || '');
}

async function waitVideo(page, uri) {
  await waitActive(page, uri);
  await page.waitForFunction(() => {
    const video = document.querySelector('video.active');
    return video && video.readyState >= 2 && video._localResumeReady
      && !document.getElementById('video-start-cover').classList.contains('is-visible');
  });
}

async function seedSession(page, uri, type = 'video', position = 0) {
  await page.goto(origin + '/library');
  await page.evaluate((state) => localStorage.setItem('ownflick.flow.session.v1', JSON.stringify(state)), {
    version: 1, seed: 'browser-acceptance', uri, type, position, duration: 10,
  });
}

for (const mobile of [false, true]) {
  const layout = mobile ? 'mobile' : 'desktop';
  test(`${layout}: Chinese navigation, real multi-file import, search, preview, confirmed trash and restore`, async () => {
    const { context, page, errors } = await newPage(mobile);
    const filename = `导入图片-${layout}.jpg`;
    try {
      await page.goto(origin + '/library');
      assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
      assert.deepEqual((await page.locator('.floating-dock .dock-item').allTextContents()).map((text) => text.trim()), ['信息流', '媒体库']);
      assert.equal(await page.locator('a[href="/radio"], a[href="/download"], a[href="/collections"]').count(), 0);
      await page.locator('#library-import-files').setInputFiles([
        { name: filename, mimeType: 'image/jpeg', buffer: sampleImage },
        { name: filename, mimeType: 'image/jpeg', buffer: sampleImage },
        { name: `导入视频-${layout}.mp4`, mimeType: 'video/mp4', buffer: sampleVideo },
        { name: '空文件.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(0) },
        { name: '不支持.txt', mimeType: 'text/plain', buffer: Buffer.from('not media') },
      ]);
      await page.waitForFunction(() => document.getElementById('library-management-feedback').textContent.includes('成功 3 个，失败 2 个') && !document.getElementById('library-import').disabled);
      assert.equal(await page.locator('#library-import-list .is-success').count(), 3);
      assert.equal(await page.locator('#library-import-list .is-error').count(), 2);
      assert.match(await page.locator('#library-import-list').innerText(), /\(1\)/);
      await page.locator('#library-search-input').fill(filename);
      await page.getByRole('button', { name: `预览图片：${filename}`, exact: true }).waitFor();
      await page.getByRole('button', { name: `预览图片：${filename}`, exact: true }).click();
      await page.waitForFunction(() => document.getElementById('quick-view').getAttribute('aria-hidden') === 'false' && document.getElementById('quick-image').naturalWidth > 0);
      await page.locator('#quick-close-top').click();
      const remove = page.getByRole('button', { name: `将“${filename}”移到回收站`, exact: true });
      await remove.click();
      assert.equal(await page.locator('#library-delete-dialog').evaluate((dialog) => dialog.open), true);
      await page.locator('#library-delete-cancel').click();
      assert.equal(await remove.count(), 1);
      await remove.click();
      await page.locator('#library-delete-confirm').click();
      await page.waitForFunction(() => document.getElementById('library-management-feedback').textContent.startsWith('已移到回收站'));
      assert.equal(await remove.count(), 0);
      await page.locator('#library-trash').click();
      const row = page.locator('#library-trash-list li').filter({ hasText: filename });
      await row.getByRole('button', { name: /^恢复/ }).click();
      await page.waitForFunction(() => document.getElementById('library-management-feedback').textContent.includes('资源已恢复'));
      await page.locator('#library-trash-close').click();
      await remove.waitFor();
      await page.locator('#library-sync').click();
      await page.waitForFunction(() => document.getElementById('library-management-feedback').textContent.includes('重新扫描完成'));
      assert.equal(await remove.count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await screenshot(page, layout + '-library');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('real feed covers more than one page without repeats and reconstructs the returned seed', async () => {
  const context = await browser.newContext();
  try {
    let seed = '', after = '', total = 0;
    const names = [];
    do {
      const params = new URLSearchParams({ size: '7', seed, after });
      const response = await context.request.get(origin + '/api/feed/mix?' + params);
      assert.equal(response.status(), 200);
      const payload = await response.json();
      seed = payload.seed;
      total = payload.total;
      names.push(...payload.items.map((item) => item.name));
      if (!payload.has_more) break;
      assert.notEqual(payload.next_after, after);
      after = payload.next_after;
      assert.ok(names.length <= total);
    } while (true);
    assert.ok(total > 24);
    assert.equal(names.length, total);
    assert.equal(new Set(names).size, total);
    const replay = await (await context.request.get(origin + '/api/feed/mix?' + new URLSearchParams({ seed, size: '200' }))).json();
    assert.deepEqual(replay.items.map((item) => item.name), names);
    assert.equal(seed.length, 64);
  } finally { await context.close(); }
});

test('video seconds and current media survive refresh, library navigation and a new page', async () => {
  const { context, page, errors } = await newPage();
  const uri = '@default/视频-0.mp4';
  try {
    await seedSession(page, uri, 'video', 2.25);
    await page.goto(origin + '/');
    await waitVideo(page, uri);
    assert.ok(await page.locator('video.active').evaluate((video) => video.currentTime >= 2.1));
    await page.locator('video.active').evaluate(async (video) => {
      video.currentTime = 3.5;
      if (video.seeking) await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
      video.pause();
    });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('ownflick.flow.session.v1')).position >= 3.4);
    await page.reload();
    await waitVideo(page, uri);
    assert.ok(await page.locator('video.active').evaluate((video) => video.currentTime >= 3.35 && video.currentTime < 5));
    await page.locator('video.active').evaluate((video) => video.pause());
    await page.goto(origin + '/library');
    await page.locator('.library-management-header a[href="/flow"]').click();
    await waitVideo(page, uri);
    assert.ok(await page.locator('video.active').evaluate((video) => video.currentTime >= 3.35));
    await page.locator('video.active').evaluate((video) => video.pause());
    await page.close();
    const reopened = await context.newPage();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await reopened.goto(origin + '/');
    await waitVideo(reopened, uri);
    assert.ok(await reopened.locator('video.active').evaluate((video) => video.currentTime >= 3.35));
    await screenshot(reopened, 'desktop-flow');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile progress drag stays on the video and clean mode survives five switches', async () => {
  const { context, page, errors } = await newPage(true);
  const uri = '@default/视频-1.mp4';
  try {
    await seedSession(page, uri, 'video', 1);
    await page.goto(origin + '/');
    await waitVideo(page, uri);
    await page.locator('video.active').evaluate((video) => video.pause());
    const bounds = await page.locator('#video-progress').boundingBox();
    const y = bounds.y + bounds.height / 2;
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width * 0.2, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + bounds.width * 0.65, y: y - 120 }] });
      assert.equal(await page.locator('#seek-preview').isVisible(), true);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await cdp.detach(); }
    assert.equal(await activeName(page), uri);
    assert.ok(await page.locator('video.active').evaluate((video) => video.paused && Math.abs(video.currentTime / video.duration - 0.65) < 0.04));
    await page.locator('#clean-mode-btn').click();
    for (let index = 0; index < 5; index++) {
      const previous = await activeName(page);
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction((name) => {
        const active = document.querySelectorAll('#feed-container > .feed-media.active');
        return active.length === 1 && active[0].dataset.name !== name;
      }, previous);
      assert.equal(await page.locator('#clean-mode-exit').isVisible(), true);
      assert.equal(await page.locator('#controls').evaluate((controls) => controls.inert), true);
    }
    await screenshot(page, 'mobile-clean-flow');
    await page.locator('#clean-mode-exit').click();
    assert.equal(await page.locator('#controls').evaluate((controls) => controls.inert), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await screenshot(page, 'mobile-flow');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const stage of ['initially hidden', 'hidden while preparing']) {
  test(`video activation recovers after ${stage} without a stuck cover or muted playback`, async () => {
    const { context, page, errors } = await newPage();
    const uri = '@default/视频-0.mp4';
    let releaseMedia;
    const mediaGate = new Promise((resolve) => { releaseMedia = resolve; });
    try {
      await context.addInitScript(({ hidden, uri }) => {
        window.__testHidden = hidden;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__testHidden });
        // Real background tabs defer animation frames until they are visible.
        const requestFrame = window.requestAnimationFrame.bind(window);
        const deferredFrames = [];
        window.requestAnimationFrame = (callback) => window.__testHidden
          ? (deferredFrames.push(callback), -deferredFrames.length)
          : requestFrame(callback);
        window.__releaseFrames = () => deferredFrames.splice(0).forEach((callback) => requestFrame(callback));
        localStorage.setItem('ownflick.flow.session.v1', JSON.stringify({
          version: 1, seed: 'visibility-regression', uri, type: 'video', position: 1.25,
        }));
      }, { hidden: stage === 'initially hidden', uri });
      if (stage === 'hidden while preparing') {
        await page.route('**/*', async (route) => {
          if (route.request().resourceType() === 'media') await mediaGate;
          await route.continue();
        });
      }
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((name) => Array.from(document.querySelectorAll('video.feed-media'))
        .some((video) => video.dataset.name === name && video.style.display === 'block'), uri);
      assert.equal(await page.locator('#video-start-cover').evaluate((cover) => cover.classList.contains('is-visible')), true);
      await page.evaluate(() => { window.__testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
      releaseMedia();
      await page.evaluate(() => { window.__testHidden = false; document.dispatchEvent(new Event('visibilitychange')); window.__releaseFrames(); });
      await waitVideo(page, uri);
      await page.waitForFunction(() => {
        const video = document.querySelector('video.active');
        return video && !video.paused && !video.muted;
      });
      // A user-paused clip must stay paused through a later background cycle.
      await page.locator('video.active').evaluate((video) => video.pause());
      await page.evaluate(() => {
        window.__testHidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        window.__testHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      assert.equal(await page.locator('video.active').evaluate((video) => video.paused), true);
      assert.deepEqual(errors, []);
    } finally { releaseMedia(); await context.close(); }
  });
}

test('deleted current image and corrupt browser state both fall back to playable media', async () => {
  const { context, page, errors } = await newPage();
  const uri = '@default/照片-00.jpg';
  try {
    await seedSession(page, uri, 'image');
    await page.goto(origin + '/');
    await waitActive(page, uri);
    const response = await context.request.post(origin + '/delete/' + uri.split('/').map(encodeURIComponent).join('/'));
    assert.equal(response.status(), 200);
    await page.reload();
    await waitActive(page);
    assert.notEqual(await activeName(page), uri);
    await page.evaluate(() => localStorage.setItem('ownflick.flow.session.v1', '{broken-json'));
    await page.goto(origin + '/library');
    await page.evaluate(() => localStorage.setItem('ownflick.flow.session.v1', '{broken-json'));
    await page.goto(origin + '/');
    await waitActive(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
