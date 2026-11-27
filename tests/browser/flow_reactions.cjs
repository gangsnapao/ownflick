'use strict';

// OWNFLICK_TEST_PYTHON=/path/to/python node --test tests/browser/flow_reactions.cjs
// Chrome + a disposable Flask instance: mutations and scoped feeds are real. Only
// the mixed ordering/media bytes and explicitly held/failed responses are mocked.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const poster = path.join(root, 'spooly/static/radio/breeze-window-poster.jpg');
const csrfTokens = new WeakMap();
const loginPassword = 'phase4-disposable-browser-password';
const uri = (name) => '@default/' + name;
const clip = uri('片段 & hash#%.mp4');
const secondClip = uri('second.mp4');
const photo = uri('photo.jpg');
const childA = uri('gallery/照片 & hash#%.jpg');
const childB = uri('gallery/second.jpg');
const timeline = Array.from({ length: 27 }, (_, i) => uri(`timeline-${String(i).padStart(2, '0')}.jpg`));
const fixtureNames = [clip, secondClip, photo, childA, childB, ...timeline];
const defaultLayout = [clip, photo, secondClip, [childA, childB]];
const reactionPath = (name, kind) => `/api/media/${encodeURIComponent(name)}/${kind}`;
const labels = { like: ['点赞', '取消点赞'], favorite: ['收藏', '取消收藏'] };
let browser;
let server;
let origin;
let serverLogs = '';

before(async () => {
  const python = process.env.OWNFLICK_TEST_PYTHON || 'python3';
  // No user's library, config, SQLite database, thumbnails, or favorites are used.
  // JPEG hard links share the small bundled poster; videos are indexed placeholders
  // served from the sample MP4 by Playwright, never copied into the temporary tree.
  server = spawn(python, ['-B', '-u', '-c', `
import json, os, shutil, signal, tempfile
from pathlib import Path
from werkzeug.serving import make_server
signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
with tempfile.TemporaryDirectory(prefix='ownflick-reactions-browser-') as temporary:
    data = Path(temporary)
    media = data / 'media'
    media.mkdir()
    for uri in json.loads(os.environ['OWNFLICK_BROWSER_FIXTURES']):
        target = media / uri.removeprefix('@default/')
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix == '.jpg':
            try:
                os.link(os.environ['OWNFLICK_BROWSER_POSTER'], target)
            except OSError:
                shutil.copyfile(os.environ['OWNFLICK_BROWSER_POSTER'], target)
        else:
            target.write_bytes(b'Browser fixture; playback uses bundled sample media.')
    os.environ['SPOOLY_INSTANCE'] = str(data / 'instance')
    from spooly.app import create_app
    app = create_app({'TESTING': True, 'AUTH_ENABLED': True, 'MEDIA_ROOT': media, 'INSTANCE_NAME': 'Reaction browser test'})
    with make_server('127.0.0.1', 0, app, threaded=True) as server:
        print('OWNFLICK_TEST_URL=http://127.0.0.1:' + str(server.server_port), flush=True)
        server.serve_forever()
`], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      SPOOLY_AUTH_PASSWORD: loginPassword,
      OWNFLICK_BROWSER_FIXTURES: JSON.stringify(fixtureNames),
      OWNFLICK_BROWSER_POSTER: poster,
    },
  });
  server.stderr.on('data', (data) => { serverLogs = (serverLogs + data).slice(-12000); });
  origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Flask startup timed out: ' + serverLogs)), 20000);
    server.stdout.on('data', (data) => {
      output += data;
      const match = output.match(/OWNFLICK_TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.once('error', (error) => { clearTimeout(timeout); reject(error); });
    server.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Flask exited ${code}: ${serverLogs}`)); });
  });
  browser = await chromium.launch({
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' }),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
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

async function authenticate(context) {
  const login = await context.request.get(origin + '/login');
  const token = (await login.text()).match(/name="_csrf_token" value="([^"]+)"/);
  assert.ok(token, 'The disposable login form must provide a CSRF token.');
  const response = await context.request.post(origin + '/login', {
    form: { password: loginPassword, _csrf_token: token[1], next: '/flow' }, maxRedirects: 0,
  });
  assert.equal(response.status(), 302);
  const html = await (await context.request.get(origin + '/flow')).text();
  const authenticatedToken = html.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(authenticatedToken, 'The authenticated page must supply the refreshed CSRF token.');
  csrfTokens.set(context, authenticatedToken[1]);
}

async function feed(context, query = 'order=sequential&offset=0&limit=96') {
  const response = await context.request.get(origin + '/api/feed?' + query);
  assert.equal(response.status(), 200, await response.text());
  const payload = await response.json();
  assert.equal(payload.success, true);
  return payload.data;
}

async function mutate(context, name, kind, state) {
  const response = await context.request.post(origin + reactionPath(name, kind), {
    data: { state }, headers: { 'X-CSRF-Token': csrfTokens.get(context) },
  });
  assert.equal(response.status(), 200, await response.text());
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.uri, name);
  assert.equal(typeof payload.data.is_liked, 'boolean');
  assert.equal(typeof payload.data.is_favorited, 'boolean');
  assert.equal(payload.data[kind === 'like' ? 'is_liked' : 'is_favorited'], state);
  assert.ok(state ? payload.data[kind === 'like' ? 'liked_at' : 'favorited_at'] :
    payload.data[kind === 'like' ? 'liked_at' : 'favorited_at'] === null);
  return payload.data;
}

async function reset(context) {
  const existing = await feed(context);
  assert.equal(existing.items.length, fixtureNames.length, 'All fixture media must be indexed in the temporary source.');
  for (const item of existing.items) {
    if (item.is_liked) await mutate(context, item.name, 'like', false);
    if (item.is_favorited) await mutate(context, item.name, 'favorite', false);
  }
}

async function saved(context, name) {
  const record = (await feed(context)).items.find((item) => item.name === name);
  assert.ok(record, 'Expected indexed fixture: ' + name);
  return record;
}

async function openFlow({ mobile = false, viewport, reducedMotion = 'no-preference', url = '/flow', layout = defaultLayout, prepare, intercept } = {}) {
  const context = await browser.newContext({
    viewport: viewport || (mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }),
    reducedMotion,
    isMobile: mobile,
    hasTouch: mobile,
  });
  try {
    await authenticate(context);
    await reset(context);
    if (prepare) await prepare(context);
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.reactionPageTransition = Promise.resolve();
      window.addEventListener('pagereveal', (event) => {
        if (event.viewTransition) window.reactionPageTransition = event.viewTransition.finished.catch(() => {});
      });
    });
    page.setDefaultTimeout(12000);
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      const requested = new URL(request.url());
      if (!requested.pathname.startsWith('/api/')) return;
      requests.push({ path: requested.pathname, query: requested.searchParams, method: request.method(), body: request.postDataJSON() });
    });
    // Decode/seek real media in Chrome without depending on ffmpeg or probes.
    await page.route((url) => url.pathname.startsWith('/media/'), (route) => route.continue({
      // Preserve Flask's Range/206 handling: fulfilling an entire MP4 for a byte
      // range makes Chrome seek back to zero even though metadata has loaded.
      url: origin + (decodeURIComponent(new URL(route.request().url()).pathname).endsWith('.mp4')
        ? '/static/radio/breeze-window.mp4' : '/static/radio/breeze-window-poster.jpg'),
    }));
    await page.route((url) => url.pathname === '/thumb', (route) => route.fulfill({ path: poster, contentType: 'image/jpeg' }));
    if (layout) {
      await page.route((url) => url.pathname === '/api/feed/mix', async (route) => {
        // Hydration comes from the real SQLite join, including after a refresh.
        const records = new Map((await feed(context)).items.map((item) => [item.name, item]));
        const items = layout.map((entry, index) => Array.isArray(entry)
          ? { type: 'image_group', name: `gallery-fixture-${index}`, items: entry.map((name) => records.get(name)) }
          : records.get(entry));
        assert.ok(items.every(Boolean), 'Mixed fixture references must exist in the real index.');
        await route.fulfill({ json: { items, has_more: false, seed: 'phase4-browser' } });
      });
    }
    if (intercept) await intercept(page);
    await page.goto(origin + url);
    await ready(page);
    return { context, page, errors, requests };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function ready(page) {
  await page.waitForFunction(() => {
    const active = document.querySelector('.feed-media.active');
    if (!active) return false;
    if (active.tagName === 'VIDEO') return active.readyState >= 2 && active.duration > 0 &&
      !document.getElementById('video-progress').disabled &&
      !document.getElementById('video-start-cover').classList.contains('is-visible');
    const image = active.tagName === 'IMG' ? active : active.querySelector('img');
    return image && image.complete && image.naturalWidth > 0;
  });
  await page.evaluate(() => window.reactionPageTransition);
}

async function activeName(page) {
  return page.locator('.feed-media.active').getAttribute('data-name');
}

async function waitName(page, name) {
  await page.waitForFunction((expected) => {
    const active = document.querySelectorAll('#feed-container > .feed-media.active');
    return active.length === 1 && active[0].dataset.name === expected;
  }, name);
}

async function move(page, name, key = 'ArrowDown') {
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(key);
  await waitName(page, name);
  await ready(page);
}

async function state(page, liked, favorited, { pendingLike = false, pendingFavorite = false } = {}) {
  await page.waitForFunction((expected) => {
    const like = document.getElementById('like-btn');
    const favorite = document.getElementById('favorite-btn');
    return like?.getAttribute('aria-pressed') === String(expected.liked) &&
      favorite?.getAttribute('aria-pressed') === String(expected.favorited) &&
      like.disabled === expected.pendingLike && favorite.disabled === expected.pendingFavorite;
  }, { liked, favorited, pendingLike, pendingFavorite });
  for (const [kind, value] of [['like', liked], ['favorite', favorited]]) {
    const button = page.locator(`#${kind}-btn`);
    assert.equal(await button.evaluate((el) => el.tagName), 'BUTTON');
    assert.equal(await button.getAttribute('type'), 'button');
    assert.equal(await button.getAttribute('aria-label'), labels[kind][Number(value)]);
  }
}

async function clickReaction(page, name, kind) {
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === reactionPath(name, kind));
  await page.locator(`#${kind}-btn`).click();
  const result = await response;
  assert.equal(result.status(), 200);
  const payload = await result.json();
  assert.equal(payload.success, true);
  assert.equal(payload.data.uri, name);
  return payload.data;
}

function mutations(requests) {
  return requests.filter((request) => request.method === 'POST' && /\/api\/media\/.*\/(like|favorite)$/.test(request.path));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function holdMutation(page, name, kind, fail = false) {
  const entered = deferred();
  const release = deferred();
  let first = true;
  await page.route((url) => url.pathname === reactionPath(name, kind), async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = fail ? null : await route.fetch();
    entered.resolve(response ? await response.json() : null);
    await release.promise;
    if (fail) await route.fulfill({ status: 503, json: { success: false, error: 'Temporary test storage failure' } });
    else await route.fulfill({ response });
  });
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    async finish() {
      const finished = page.waitForEvent('requestfinished', { predicate: (request) => new URL(request.url()).pathname === reactionPath(name, kind) });
      release.resolve();
      await finished;
      // Flush application promise callbacks before asserting that unrelated DOM
      // did not change; a negative assertion before delivery would miss the race.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    },
  };
}

async function touchDrag(page, from, to) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x, y: to.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await cdp.detach(); }
}

async function doubleTap(page, mobile, x = mobile ? 170 : 480, y = 330) {
  if (mobile) {
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
  } else await page.mouse.dblclick(x, y, { delay: 55 });
}

async function observePlayback(page) {
  await page.locator('video.active').evaluate(async (video) => {
    await video.play();
    video.currentTime = 1;
    window.reactionObservations = { pauses: 0, hearts: 0 };
    video.addEventListener('pause', () => window.reactionObservations.pauses++);
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && node.matches('.tap-heart')) window.reactionObservations.hearts++;
      }
    }).observe(document.body, { childList: true });
  });
}

async function clockAdvances(page) {
  const before = await page.locator('video.active').evaluate((video) => video.currentTime);
  await page.waitForFunction((time) => {
    const video = document.querySelector('video.active');
    return video && !video.paused && video.currentTime - time > 0.36;
  }, before);
}

test('real default mix hydrates both saved states without per-media favorite lookups', async () => {
  const { context, page, errors, requests } = await openFlow({
    layout: null,
    prepare: async (context) => {
      for (const name of fixtureNames) {
        await mutate(context, name, 'like', true);
        await mutate(context, name, 'favorite', true);
      }
    },
  });
  try {
    await state(page, true, true);
    await page.reload();
    await ready(page);
    await state(page, true, true);
    assert.ok(requests.some((request) => request.path === '/api/feed/mix'));
    assert.equal(requests.some((request) => request.path === '/api/feed'), false);
    assert.equal(requests.some((request) => request.path.startsWith('/api/favorite/')), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('native reaction buttons send explicit encoded states and persist independently through refresh', async () => {
  const { context, page, errors, requests } = await openFlow({
    prepare: (context) => mutate(context, clip, 'like', true),
  });
  try {
    await state(page, true, false);
    const both = await clickReaction(page, clip, 'favorite');
    assert.equal(both.is_liked, true);
    assert.equal(both.is_favorited, true);
    await page.reload();
    await ready(page);
    await state(page, true, true);
    const favoriteOnly = await clickReaction(page, clip, 'like');
    assert.equal(favoriteOnly.is_liked, false);
    assert.equal(favoriteOnly.is_favorited, true);
    await state(page, false, true);
    await page.reload();
    await ready(page);
    await state(page, false, true);
    await clickReaction(page, clip, 'favorite');
    await state(page, false, false);
    await page.reload();
    await ready(page);
    await state(page, false, false);
    const record = await saved(context, clip);
    assert.equal(record.is_liked, false);
    assert.equal(record.is_favorited, false);
    assert.equal(record.liked_at, null);
    assert.equal(record.favorited_at, null);
    assert.deepEqual(mutations(requests).map((request) => [request.path, request.body.state]), [
      [reactionPath(clip, 'favorite'), true],
      [reactionPath(clip, 'like'), false],
      [reactionPath(clip, 'favorite'), false],
    ]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const filter of ['liked', 'favorited']) {
  test(`${filter} plays the real API in reaction-time order and requests its next_offset page`, async () => {
    const kind = filter === 'liked' ? 'like' : 'favorite';
    const otherKind = kind === 'like' ? 'favorite' : 'like';
    // Deliberately differ from filename order so a sequential-name feed fails.
    const written = [...timeline.filter((_, i) => i % 2), ...timeline.filter((_, i) => !(i % 2))];
    const expected = [...written].reverse();
    const { context, page, errors, requests } = await openFlow({
      url: '/flow?filter=' + filter,
      prepare: async (context) => {
        await mutate(context, photo, otherKind, true); // Must never enter this feed.
        for (let i = 0; i < written.length; i++) {
          await mutate(context, written[i], kind, true);
          if (i % 3 === 0) await mutate(context, written[i], otherKind, true);
        }
      },
    });
    try {
      const initial = await feed(context, `filter=${filter}&order=sequential&offset=0&limit=24`);
      assert.equal(initial.total, timeline.length);
      assert.equal(initial.next_offset, 24);
      assert.equal(initial.has_more, true);
      assert.deepEqual(initial.items.map((item) => item.name), expected.slice(0, 24));
      assert.equal(await activeName(page), expected[0]);
      for (let i = 0; i < expected.length; i++) {
        if (i) await move(page, expected[i]);
        const record = await saved(context, expected[i]);
        await state(page, record.is_liked, record.is_favorited);
      }
      const scoped = requests.filter((request) => request.path === '/api/feed');
      assert.deepEqual(scoped.map((request) => request.query.get('offset')), ['0', '24']);
      for (const request of scoped) {
        assert.equal(request.method, 'GET');
        assert.equal(request.query.get('filter'), filter);
        assert.equal(request.query.get('order'), 'sequential');
        assert.equal(request.query.get('limit'), '24');
      }
      assert.equal(requests.some((request) => request.path === '/api/feed/mix'), false);
      const loaded = await page.locator('#feed-container > .feed-media').evaluateAll((items) => items.map((item) => item.dataset.name));
      assert.deepEqual(loaded, expected);
      assert.equal(new Set(loaded).size, expected.length);
      await page.reload();
      await ready(page);
      await waitName(page, expected[0]);
      const latest = await saved(context, expected[0]);
      await state(page, latest.is_liked, latest.is_favorited);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

for (const mobile of [false, true]) {
  test(`${mobile ? 'touch' : 'desktop'} stage double taps only ensure like and animate without pausing or favoriting`, async () => {
    const { context, page, errors, requests } = await openFlow({ mobile });
    try {
      await state(page, false, false);
      await observePlayback(page);
      const likedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === reactionPath(clip, 'like'));
      await doubleTap(page, mobile);
      assert.equal((await likedResponse).status(), 200);
      await page.waitForFunction(() => window.reactionObservations.hearts === 1);
      await state(page, true, false);
      await clockAdvances(page); // Exceeds the single-tap timer, so a late pause fails.
      await doubleTap(page, mobile);
      await page.waitForFunction(() => window.reactionObservations.hearts === 2);
      await clockAdvances(page);
      await state(page, true, false);
      if (process.env.OWNFLICK_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, `${mobile ? 'mobile' : 'desktop'}-reactions.png`) });
      assert.deepEqual(await page.evaluate(() => window.reactionObservations), { pauses: 0, hearts: 2 });
      assert.equal(await activeName(page), clip);
      const record = await saved(context, clip);
      assert.equal(record.is_liked, true);
      assert.equal(record.is_favorited, false);
      assert.deepEqual(mutations(requests).map((request) => [request.path, request.body.state]), [[reactionPath(clip, 'like'), true]]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('gallery children hydrate and mutate their own URI, including double-tap likes and revisits', async () => {
  const { context, page, errors, requests } = await openFlow({
    layout: [[childA, childB], clip],
    prepare: async (context) => {
      await mutate(context, childA, 'like', true);
      await mutate(context, childB, 'favorite', true);
    },
  });
  try {
    await state(page, true, false);
    await clickReaction(page, childA, 'favorite');
    await state(page, true, true);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('.feed-media.active .image-group-counter')?.textContent === '2 / 2');
    await state(page, false, true);
    const liked = page.waitForResponse((response) => new URL(response.url()).pathname === reactionPath(childB, 'like'));
    await doubleTap(page, false);
    assert.equal((await liked).status(), 200);
    await state(page, true, true);
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('.feed-media.active .image-group-counter')?.textContent === '1 / 2');
    await state(page, true, true);
    assert.deepEqual(mutations(requests).map((request) => [request.path, request.body.state]), [
      [reactionPath(childA, 'favorite'), true], [reactionPath(childB, 'like'), true],
    ]);
    for (const name of [childA, childB]) {
      const record = await saved(context, name);
      assert.equal(record.is_liked, true);
      assert.equal(record.is_favorited, true);
    }
    await page.reload();
    await ready(page);
    await state(page, true, true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const kind of ['like', 'favorite']) {
  test(`failed ${kind} rolls back and re-enables a real successful retry`, async () => {
    const { context, page, errors, requests } = await openFlow();
    const held = await holdMutation(page, clip, kind, true);
    try {
      await page.locator(`#${kind}-btn`).click();
      await held.entered;
      await state(page, kind === 'like', kind === 'favorite', { pendingLike: kind === 'like', pendingFavorite: kind === 'favorite' });
      await held.finish();
      await state(page, false, false);
      assert.equal((await saved(context, clip))[kind === 'like' ? 'is_liked' : 'is_favorited'], false);
      await clickReaction(page, clip, kind);
      await state(page, kind === 'like', kind === 'favorite');
      assert.equal((await saved(context, clip))[kind === 'like' ? 'is_liked' : 'is_favorited'], true);
      assert.deepEqual(mutations(requests).map((request) => request.body.state), [true, true]);
      assert.deepEqual(errors, []);
    } finally { held.release(); await context.close(); }
  });
}

test('an old media response cannot overwrite the active media or release its pending button', async () => {
  const { context, page, errors } = await openFlow({ prepare: (context) => mutate(context, photo, 'favorite', true) });
  const oldMedia = await holdMutation(page, clip, 'like');
  const newMedia = await holdMutation(page, photo, 'favorite');
  try {
    await page.locator('#like-btn').click();
    await oldMedia.entered;
    await state(page, true, false, { pendingLike: true });
    await move(page, photo);
    await state(page, false, true);
    await page.locator('#favorite-btn').click();
    await newMedia.entered;
    await state(page, false, false, { pendingFavorite: true });
    await oldMedia.finish();
    await state(page, false, false, { pendingFavorite: true });
    assert.equal(await activeName(page), photo);
    await newMedia.finish();
    await state(page, false, false);
    await move(page, clip, 'ArrowUp');
    await state(page, true, false);
    assert.deepEqual(errors, []);
  } finally { oldMedia.release(); newMedia.release(); await context.close(); }
});

test('a delayed favorite snapshot cannot overwrite a newer independent like', async () => {
  const { context, page, errors } = await openFlow();
  const favorite = await holdMutation(page, clip, 'favorite');
  try {
    await page.locator('#favorite-btn').click();
    const oldSnapshot = await favorite.entered;
    assert.equal(oldSnapshot.data.is_liked, false);
    await clickReaction(page, clip, 'like');
    await state(page, true, true, { pendingFavorite: true });
    await favorite.finish();
    await state(page, true, true);
    await page.reload();
    await ready(page);
    await state(page, true, true);
    assert.deepEqual(errors, []);
  } finally { favorite.release(); await context.close(); }
});

for (const mobile of [false, true]) {
  test(`${mobile ? 'touch' : 'desktop'} progress and action controls isolate seeking, double taps and pending stage taps`, async () => {
    const { context, page, errors, requests } = await openFlow({ mobile });
    try {
      await page.locator('video.active').evaluate((video) => { video.pause(); video.currentTime = 1; });
      const bounds = await page.locator('#video-progress').boundingBox();
      const y = bounds.y + bounds.height / 2;
      const from = { x: bounds.x + bounds.width * 0.2, y };
      const to = { x: bounds.x + bounds.width * 0.7, y: y - 100 };
      if (mobile) await touchDrag(page, from, to);
      else {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
      }
      const seek = await page.locator('video.active').evaluate((video) => ({ paused: video.paused, time: video.currentTime, duration: video.duration, progress: document.getElementById('video-progress').value, seeking: document.getElementById('custom-controls').classList.contains('is-seeking') }));
      assert.ok(seek.paused && Math.abs(seek.time / seek.duration - 0.7) < 0.025, JSON.stringify({ seek, bounds, from, to }));
      await doubleTap(page, mobile, bounds.x + bounds.width * 0.5, y);
      assert.equal(await activeName(page), clip);
      await state(page, false, false);
      assert.equal(await page.locator('.tap-heart').count(), 0);
      assert.deepEqual(mutations(requests), []);
      assert.equal(await page.locator('video.active').evaluate((video) => video.paused), true);
      await observePlayback(page);
      // An action immediately after one stage tap cancels its delayed pause.
      if (mobile) await page.touchscreen.tap(170, 330);
      else await page.mouse.click(480, 330);
      await clickReaction(page, clip, 'like');
      await clickReaction(page, clip, 'favorite');
      await clockAdvances(page);
      await state(page, true, true);
      await page.locator('#like-btn').focus();
      await page.keyboard.press('Space');
      await state(page, false, true);
      await page.locator('#favorite-btn').hover();
      await page.mouse.wheel(0, 250);
      await clockAdvances(page);
      assert.equal(await activeName(page), clip);
      assert.deepEqual(await page.evaluate(() => window.reactionObservations), { pauses: 0, hearts: 0 });
      assert.deepEqual(mutations(requests).map((request) => [request.path, request.body.state]), [
        [reactionPath(clip, 'like'), true], [reactionPath(clip, 'favorite'), true], [reactionPath(clip, 'like'), false],
      ]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });

  test(`${mobile ? 'mobile menu' : 'desktop dock'} exposes working Chinese like and favorite feed links`, async () => {
    // Navigation functionality uses the app's real reduced-motion preference;
    // this opts out of Chrome's separate cross-document transition experiment.
    const { context, page, errors, requests } = await openFlow({ mobile, reducedMotion: 'reduce' });
    try {
      for (const [label, filter] of [['我的点赞', 'liked'], ['我的收藏', 'favorited']]) {
        if (mobile) await page.locator('#app-nav-menu-trigger').click();
        const nav = page.locator(mobile ? '#app-nav-menu' : '.floating-dock');
        const link = nav.getByRole('link', { name: label, exact: true });
        assert.equal(await link.isVisible(), true);
        assert.equal(await link.getAttribute('href'), '/flow?filter=' + filter);
        await link.click();
        await page.waitForURL(origin + '/flow?filter=' + filter);
        await page.waitForFunction(() => document.getElementById('flow-state')?.dataset.kind === 'empty' &&
          document.getElementById('flow-state')?.getAttribute('aria-hidden') === 'false');
        assert.equal(await page.locator('.feed-media.active').count(), 0);
        await page.evaluate(() => window.reactionPageTransition);
        assert.ok(requests.some((request) => request.path === '/api/feed' && request.query.get('filter') === filter &&
          request.query.get('order') === 'sequential' && request.query.get('offset') === '0' && request.query.get('limit') === '24'));
        await page.goto(origin + '/flow');
        await ready(page);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

async function reachable(locator, viewport, label) {
  await locator.click({ trial: true });
  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      receivesInput: !!hit && (hit === element || element.contains(hit)), obstruction: hit?.id || hit?.className || null };
  });
  assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.x >= -0.5 && geometry.y >= -0.5 &&
    geometry.right <= viewport.width + 0.5 && geometry.bottom <= viewport.height + 0.5 && geometry.receivesInput,
  `${label} must remain inside the viewport and receive input: ${JSON.stringify(geometry)}`);
  await locator.click({ trial: true });
  return geometry;
}

for (const viewport of [{ width: 844, height: 390 }, { width: 1280, height: 600 }, { width: 390, height: 500 }, { width: 320, height: 480 }]) {
  test(`authenticated ${viewport.width}x${viewport.height} keeps reactions, speeds and state-feed navigation reachable`, async () => {
    const mobile = viewport.width < 768 || viewport.height < 600;
    const { context, page, errors } = await openFlow({ mobile, viewport });
    try {
      const progress = await page.locator('#custom-controls').boundingBox();
      for (const id of ['like-btn', 'favorite-btn', 'speed-btn', 'collection-btn', 'info-btn', 'clean-mode-btn']) {
        const action = await reachable(page.locator('#' + id), viewport, id);
        const overlaps = action.x < progress.x + progress.width && action.right > progress.x &&
          action.y < progress.y + progress.height && action.bottom > progress.y;
        assert.equal(overlaps, false, `${id} must not cover the progress touch target.`);
      }
      if (process.env.OWNFLICK_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, `auth-${viewport.width}x${viewport.height}-controls.png`) });
      await page.locator('#speed-btn').click();
      for (const rate of ['0.75', '1', '1.25', '1.5', '2']) {
        await reachable(page.locator(`#speed-options [data-rate="${rate}"]`), viewport, 'speed ' + rate);
      }
      await page.locator('#speed-options [data-rate="2"]').click();
      assert.equal(await page.locator('video.active').evaluate((video) => video.playbackRate), 2);
      const dockVisible = await page.locator('.floating-dock').isVisible();
      if (!dockVisible) await page.locator('#app-nav-menu-trigger').click();
      const nav = page.locator(dockVisible ? '.floating-dock' : '#app-nav-menu');
      for (const label of ['我的点赞', '我的收藏']) {
        const link = nav.getByRole('link', { name: label, exact: true });
        if (!dockVisible) await link.scrollIntoViewIfNeeded();
        await reachable(link, viewport, label);
      }
      const signOut = nav.getByRole('button', { name: 'Sign out', exact: true });
      if (!dockVisible) await signOut.scrollIntoViewIfNeeded();
      await reachable(signOut, viewport, 'authenticated sign out');
      if (process.env.OWNFLICK_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OWNFLICK_SCREENSHOT_DIR, `auth-${viewport.width}x${viewport.height}-navigation.png`) });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test('a cancelled touch between two single stage taps cannot turn them into a double-tap like', async () => {
  const { context, page, errors, requests } = await openFlow({ mobile: true, layout: [photo, clip] });
  const cdp = await context.newCDPSession(page);
  try {
    await page.touchscreen.tap(170, 330);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 170, y: 330 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.touchscreen.tap(170, 330);
    await page.waitForTimeout(300); // Let the single-tap window expire.
    assert.equal(await page.locator('.tap-heart').count(), 0);
    assert.deepEqual(mutations(requests), []);
    await state(page, false, false);
    assert.deepEqual(errors, []);
  } finally { await cdp.detach(); await context.close(); }
});

test('a filter membership write during a held next page retries its offset without skipping the original 25th item', async () => {
  const pageRequested = deferred();
  const releasePage = deferred();
  const delayedPayload = deferred();
  const expected = [...timeline].reverse();
  let first = true;
  const { context, page, errors, requests } = await openFlow({
    url: '/flow?filter=liked',
    prepare: async (context) => {
      for (const name of timeline) await mutate(context, name, 'like', true);
    },
    intercept: async (page) => {
      await page.route((url) => url.pathname === '/api/feed' && url.searchParams.get('offset') === '24', async (route) => {
        if (!first) return route.continue();
        first = false;
        pageRequested.resolve();
        // Take this real database snapshot only AFTER the unlike has committed.
        await releasePage.promise;
        const response = await route.fetch();
        delayedPayload.resolve(await response.json());
        await route.fulfill({ response });
      });
    },
  });
  try {
    for (let index = 1; index <= 20; index++) await move(page, expected[index]);
    await pageRequested.promise;
    await clickReaction(page, expected[20], 'like');
    await state(page, false, false);
    assert.equal((await saved(context, expected[20])).is_liked, false);
    releasePage.resolve();
    const stale = await delayedPayload.promise;
    assert.equal(stale.data.items.some((item) => item.name === expected[24]), false,
      'The held offset=24 response must actually exhibit the shifted database snapshot.');
    await page.waitForFunction((name) => Array.from(document.querySelectorAll('#feed-container > .feed-media'))
      .some((element) => element.dataset.name === name), expected[24]);
    for (let index = 21; index < expected.length; index++) {
      await move(page, expected[index]);
      await state(page, true, false);
    }
    const loaded = await page.locator('#feed-container > .feed-media').evaluateAll((items) => items.map((item) => item.dataset.name));
    assert.deepEqual(loaded, expected, 'The retained current item plus all subsequent members must appear once.');
    assert.deepEqual(requests.filter((request) => request.path === '/api/feed').map((request) => request.query.get('offset')), ['0', '24', '23']);
    assert.deepEqual(errors, []);
  } finally { releasePage.resolve(); await context.close(); }
});
