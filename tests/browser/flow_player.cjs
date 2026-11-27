'use strict';

// Run with: OWNFLICK_TEST_PYTHON=/path/to/python node --test tests/browser/flow_player.cjs
// Uses a disposable Flask instance, the real Flow page, and bundled sample media.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { chromium } = require('playwright-core');

let browser;
let server;
let origin;
const root = path.resolve(__dirname, '../..');
const imageUrl = '/static/radio/breeze-window-poster.jpg';
const entries = [
  { type: 'video', name: 'clip-0.mp4', media_url: '/static/radio/breeze-window.mp4' },
  { type: 'image', name: 'photo-1.jpg', media_url: imageUrl },
  { type: 'video', name: 'clip-2.mp4', media_url: '/static/radio/breeze-window.mp4' },
  { type: 'image_group', name: 'gallery-3', items: [
    { name: 'gallery-a.jpg', media_url: imageUrl },
    { name: 'gallery-b.jpg', media_url: imageUrl },
  ] },
  { type: 'video', name: 'clip-4.mp4', media_url: '/static/radio/breeze-window.mp4' },
  { type: 'image', name: 'photo-5.jpg', media_url: imageUrl },
  { type: 'video', name: 'clip-6.mp4', media_url: '/static/radio/breeze-window.mp4' },
].map((entry) => ({ ...entry, thumb_url: imageUrl, detail_url: '/library' }));

before(async () => {
  const python = process.env.OWNFLICK_TEST_PYTHON || 'python3';
  server = spawn(python, ['-B', '-u', '-c', `
import os, signal, tempfile
from pathlib import Path
from werkzeug.serving import make_server
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
with tempfile.TemporaryDirectory(prefix='ownflick-browser-') as temporary:
    os.environ['SPOOLY_INSTANCE'] = str(Path(temporary) / 'data')
    from spooly.app import create_app
    app = create_app({'TESTING': True, 'MEDIA_ROOT': Path(temporary), 'INSTANCE_NAME': 'Player test'})
    with make_server('127.0.0.1', 0, app, threaded=True) as server:
        print('OWNFLICK_TEST_URL=http://127.0.0.1:' + str(server.server_port), flush=True)
        server.serve_forever()
`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stderr.on('data', (data) => { logs = (logs + data).slice(-8000); });
  origin = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('Test server startup timed out: ' + logs)), 20000);
    server.stdout.on('data', (data) => {
      stdout += data;
      const match = stdout.match(/OWNFLICK_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.once('error', (error) => { clearTimeout(timeout); reject(error); });
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Test server exited ${code}: ${logs}`)); });
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

async function openFlow(mobile = false) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile, hasTouch: mobile,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/feed/mix?*', (route) => route.fulfill({ json: { items: entries, has_more: false, seed: 'phase3' } }));
  await page.route('**/api/favorite/*', (route) => route.fulfill({ json: { is_favorite: false } }));
  await page.route('**/api/collections*', (route) => route.fulfill({ json: { success: true, data: { items: [] } } }));
  await page.route('**/api/caption/*', (route) => route.fulfill({ json: {} }));
  await page.goto(origin + '/flow');
  await page.waitForFunction(() => {
    const video = document.querySelector('video.active');
    return video && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0 && !document.getElementById('video-progress').disabled;
  });
  await page.waitForFunction(() => !document.getElementById('video-start-cover').classList.contains('is-visible'));
  return { context, page, errors };
}

async function activeName(page) {
  return page.locator('.feed-media.active').evaluate((el) => el.dataset.name || el.dataset.groupName);
}

async function waitIndex(page, index) {
  await page.waitForFunction((expected) => {
    const media = Array.from(document.querySelectorAll('#feed-container > .feed-media'));
    return media[expected]?.classList.contains('active') && media.filter((el) => el.classList.contains('active')).length === 1;
  }, index);
}

async function touchDrag(page, from, to, finish = 'touchEnd') {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x, y: to.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: finish, touchPoints: [] });
  } finally { await cdp.detach(); }
}

test('desktop seeking previews, commits on release, isolates paging, and preserves paused playback', async () => {
  const { context, page, errors } = await openFlow();
  try {
    await page.locator('video.active').evaluate((video) => { video.pause(); video.currentTime = 1; });
    const name = await activeName(page);
    const bounds = await page.locator('#video-progress').boundingBox();
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(bounds.x + bounds.width * 0.25, y);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.75, y - 180, { steps: 8 });
    assert.equal(await page.locator('#seek-preview').isVisible(), true);
    assert.equal(await page.locator('#custom-controls').evaluate((el) => el.classList.contains('is-seeking')), true);
    assert.ok(await page.locator('video.active').evaluate((video) => Math.abs(video.currentTime - 1) < 0.1));
    await page.locator('#overlay-layer').dispatchEvent('wheel', { deltaY: 250 });
    await page.locator('body').dispatchEvent('keydown', { key: 'ArrowDown' });
    assert.equal(await activeName(page), name);
    if (process.env.OWNFLICK_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, 'desktop-seeking.png') });
    await page.mouse.up();
    assert.ok(await page.locator('video.active').evaluate((video) => Math.abs(video.currentTime / video.duration - 0.75) < 0.02 && video.paused));
    assert.equal(await page.locator('#seek-preview').isVisible(), false);
    assert.equal(await page.locator('#play-status-icon').evaluate((el) => el.classList.contains('visible')), true);
    await page.locator('#video-progress').focus();
    await page.keyboard.press('Home');
    const homeState = await page.locator('video.active').evaluate((video) => ({
      time: video.currentTime, paused: video.paused, duration: video.duration,
      range: document.getElementById('video-progress').value,
      focused: document.activeElement?.id,
    }));
    assert.ok(homeState.time < 0.1 && homeState.paused, JSON.stringify(homeState));
    await page.keyboard.press('End');
    const endState = await page.locator('video.active').evaluate((video) => ({
      time: video.currentTime, paused: video.paused, duration: video.duration,
      range: document.getElementById('video-progress').value,
      focused: document.activeElement?.id,
    }));
    assert.ok(endState.time / endState.duration > 0.98 && endState.paused, JSON.stringify(endState));
    await page.locator('#video-progress').evaluate((el) => el.blur());
    await page.keyboard.press('ArrowDown');
    await waitIndex(page, 1);
    assert.equal(await page.locator('#custom-controls').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile touch seeking cancels safely, resumes playing, and allows the next swipe', async () => {
  const { context, page, errors } = await openFlow(true);
  try {
    await page.locator('video.active').evaluate(async (video) => { video.pause(); video.currentTime = 1; });
    const bounds = await page.locator('#video-progress').boundingBox();
    const y = bounds.y + bounds.height / 2;
    await touchDrag(page, { x: bounds.x + bounds.width * 0.2, y }, { x: bounds.x + bounds.width * 0.8, y: y - 150 }, 'touchCancel');
    assert.ok(await page.locator('video.active').evaluate((video) => Math.abs(video.currentTime - 1) < 0.1 && video.paused));
    assert.equal(await page.locator('#seek-preview').isVisible(), false);
    await page.locator('video.active').evaluate(async (video) => { await video.play(); });
    await touchDrag(page, { x: bounds.x + bounds.width * 0.2, y }, { x: bounds.x + bounds.width * 0.6, y: y - 100 });
    assert.ok(await page.locator('video.active').evaluate((video) => !video.paused && video.currentTime / video.duration > 0.58 && video.currentTime / video.duration < 0.7));
    await touchDrag(page, { x: 180, y: 570 }, { x: 185, y: 190 });
    await waitIndex(page, 1);
    assert.equal(await page.locator('#custom-controls').isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('metadata loss and focus loss release seek state, and unloaded videos cannot start dragging', async () => {
  const { context, page, errors } = await openFlow();
  try {
    const bounds = await page.locator('#video-progress').boundingBox();
    const y = bounds.y + bounds.height / 2;
    await page.locator('video.active').evaluate((video) => { video.pause(); video._startReady = false; });
    await page.mouse.click(bounds.x + bounds.width / 2, y);
    assert.equal(await page.locator('#custom-controls').evaluate((el) => el.classList.contains('is-seeking')), false);
    await page.locator('video.active').evaluate((video) => { video._startReady = true; });
    await page.mouse.move(bounds.x + bounds.width / 3, y);
    await page.mouse.down();
    assert.equal(await page.locator('#seek-preview').isVisible(), true);
    await page.locator('video.active').evaluate((video) => {
      Object.defineProperty(video, 'duration', { configurable: true, value: NaN });
      video.dispatchEvent(new Event('durationchange'));
    });
    assert.equal(await page.locator('#seek-preview').isVisible(), false);
    assert.equal(await page.locator('#video-progress').isDisabled(), true);
    await page.mouse.up();
    await page.locator('video.active').evaluate((video) => {
      delete video.duration;
      video.dispatchEvent(new Event('durationchange'));
    });
    await page.mouse.down();
    assert.equal(await page.locator('#seek-preview').isVisible(), true);
    await page.locator('#video-progress').evaluate((el) => el.blur());
    await page.mouse.up();
    assert.equal(await page.locator('#seek-preview').isVisible(), false);
    assert.equal(await page.locator('#play-status-icon').evaluate((el) => el.classList.contains('visible')), true);
    await page.keyboard.press('ArrowDown');
    await waitIndex(page, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const interruption of ['capture loss', 'window blur', 'hidden document', 'pagehide']) {
  test(`stage scrubbing releases paging and restores paused feedback after ${interruption}`, async () => {
    const { context, page, errors } = await openFlow();
    try {
      await page.locator('video.active').evaluate((video) => { video.pause(); video.currentTime = 1; });
      await page.mouse.move(400, 350);
      await page.mouse.down();
      await page.mouse.move(650, 355, { steps: 5 });
      assert.equal(await page.locator('#custom-controls').evaluate((el) => el.classList.contains('is-seeking')), true);
      assert.equal(await page.locator('#play-status-icon').evaluate((el) => el.classList.contains('visible')), false);
      if (interruption === 'capture loss') {
        await page.locator('#overlay-layer').evaluate((el) => el.releasePointerCapture(1));
        await page.mouse.move(651, 355);
      } else {
        await page.evaluate((reason) => {
          if (reason === 'hidden document') {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            document.dispatchEvent(new Event('visibilitychange'));
            delete document.hidden;
          } else window.dispatchEvent(new Event(reason === 'window blur' ? 'blur' : 'pagehide'));
        }, interruption);
      }
      await page.waitForFunction(() => !document.getElementById('custom-controls').classList.contains('is-seeking'));
      await page.mouse.up();
      assert.ok(await page.locator('video.active').evaluate((video) => Math.abs(video.currentTime - 1) < 0.1 && video.paused));
      assert.equal(await page.locator('#play-status-icon').evaluate((el) => el.classList.contains('visible')), true);
      await page.keyboard.press('ArrowDown');
      await waitIndex(page, 1);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('collection and speed menus keep their keyboard actions separate from playback', async () => {
  const { context, page, errors } = await openFlow();
  try {
    await page.locator('video.active').evaluate((video) => { video.pause(); video.currentTime = 1; });
    const name = await activeName(page);
    await page.locator('#collection-btn').click();
    await page.locator('#collection-modal-close').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    assert.equal(await activeName(page), name);
    assert.ok(await page.locator('video.active').evaluate((video) => Math.abs(video.currentTime - 1) < 0.1 && video.paused));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#collection-modal').isVisible(), false);
    await page.locator('#speed-btn').click();
    assert.equal(await page.locator('#speed-options').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#speed-options').isVisible(), false);
    await page.keyboard.press('ArrowDown');
    await waitIndex(page, 1);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const mobile of [false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} clean mode survives five mixed media changes and restores accessible controls`, async () => {
    const { context, page, errors } = await openFlow(mobile);
    try {
      await page.locator('#clean-mode-btn').click();
      assert.equal(await page.locator('#clean-mode-exit').isVisible(), true);
      assert.equal(await page.locator('#controls').evaluate((el) => el.inert), true);
      for (let press = 0; press < 4; press++) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
        assert.ok(['clean-mode-exit', 'BODY'].includes(focused), 'Clean mode focused hidden control: ' + focused);
      }
      await page.locator('#clean-mode-exit').focus();
      for (let index = 1; index <= 5; index++) {
        if (mobile) await touchDrag(page, { x: 180, y: 570 }, { x: 180, y: 180 });
        else await page.keyboard.press('ArrowDown');
        await waitIndex(page, index);
        if (index === 3) {
          if (mobile) await touchDrag(page, { x: 285, y: 350 }, { x: 100, y: 355 });
          else await page.keyboard.press('ArrowRight');
          assert.equal(await page.locator('.feed-media.active .image-group-counter').textContent(), '2 / 2');
        }
        assert.equal(await page.locator('body').evaluate((el) => el.classList.contains('immersive-mode')), true);
        for (const selector of ['#custom-controls', '#controls', '.mobile-app-header', '.floating-dock', '.image-group-overlay']) {
          const visible = await page.locator(selector).evaluateAll((elements) => elements.some((el) => {
            const style = getComputedStyle(el);
            return el.getClientRects().length && style.visibility !== 'hidden' && Number(style.opacity) > 0 && style.display !== 'none';
          }));
          assert.equal(visible, false, selector + ' should be hidden in clean mode');
        }
      }
      if (process.env.OWNFLICK_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, `${mobile ? 'mobile' : 'desktop'}-clean.png`) });
      await page.locator('#clean-mode-exit').click();
      assert.equal(await page.locator('#clean-mode-exit').isVisible(), false);
      assert.equal(await page.locator('#controls').evaluate((el) => el.inert), false);
      await page.locator('#clean-mode-btn').focus();
      await page.keyboard.press('Space');
      assert.equal(await page.locator('#clean-mode-exit').isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('body').evaluate((el) => el.classList.contains('immersive-mode')), false);
      await page.keyboard.press('ArrowDown');
      await waitIndex(page, 6);
      await page.waitForFunction(() => !document.getElementById('video-progress').disabled);
      assert.equal(await page.locator('#custom-controls').isVisible(), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
