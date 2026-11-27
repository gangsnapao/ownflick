'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browser(script, extras = {}) {
  const window = { addEventListener() {}, ...extras };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../spooly/static', script), 'utf8'), {
    window, Set, Map, WeakMap, Number, Date, JSON, String, Object, console,
  });
  return window;
}

function storage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

function state(overrides = {}) {
  return { version: 1, seed: 'a'.repeat(64), avoidUri: '', uri: '@default/short.mp4', type: 'video', position: 2.75, duration: 14, ...overrides };
}

test('session deduplicates a page and retains cursor/index behavior for all viewers', async () => {
  const { createFlowSession } = browser('flow_session.js');
  const session = createFlowSession({ initialCursor: { after: '' }, keyOf: x => x.name });
  await session.loadMore(async cursor => {
    assert.equal(cursor.after, '');
    return { items: [{ name: 'a' }, { name: 'a' }, { name: 'b' }], cursor: { after: 'b' }, hasMore: true };
  });
  session.setIndex(1);
  assert.equal(session.currentItem().name, 'b');
  await session.loadMore(async cursor => {
    assert.equal(cursor.after, 'b');
    return { items: [{ name: 'b' }, { name: 'c' }], hasMore: false };
  });
  assert.equal(session.items.map(x => x.name).join(','), 'a,b,c');
  assert.equal(session.hasMore(), false);
  session.dropHead(1);
  assert.equal(session.currentItem().name, 'b');
  assert.equal(session.getIndex(), 0);
});

test('a slow previous round cannot append to or unlock the new round', async () => {
  const { createFlowSession } = browser('flow_session.js');
  const session = createFlowSession();
  let finishOld, finishNew;
  const old = session.loadMore(() => new Promise(resolve => { finishOld = resolve; }));
  session.reset({ cursor: { after: '' } });
  const current = session.loadMore(() => new Promise(resolve => { finishNew = resolve; }));
  finishOld({ items: [{ name: 'stale' }], hasMore: false });
  assert.equal((await old).stale, true);
  assert.equal(session.items.length, 0);
  assert.equal(session.isLoading(), true);
  finishNew({ items: [{ name: 'fresh' }], hasMore: true });
  await current;
  assert.equal(session.items[0].name, 'fresh');
  assert.equal(session.isLoading(), false);
  assert.equal(session.hasMore(), true);
});

test('persistence restores current image or precise short-video time in a fresh page', () => {
  const window = browser('flow_session.js');
  const local = storage();
  assert.equal(window.createFlowPersistence({ storage: local }).save(state()), true);
  const restored = window.createFlowPersistence({ storage: local }).read();
  assert.equal(restored.seed, 'a'.repeat(64));
  assert.equal(restored.uri, '@default/short.mp4');
  assert.equal(restored.position, 2.75);
  const persistence = window.createFlowPersistence({ storage: local });
  persistence.save(state({ type: 'image', uri: '@default/photo.jpg', position: 19 }));
  assert.equal(persistence.read().position, 0);
  persistence.clear();
  assert.equal(persistence.read(), null);
});

test('corrupt, unavailable and quota-limited storage fail safely', () => {
  const { createFlowPersistence } = browser('flow_session.js');
  assert.equal(createFlowPersistence({ storage: null }).read(), null);
  assert.equal(createFlowPersistence({ storage: null }).save(state()), false);
  const broken = { getItem: () => '{broken', setItem() { throw new Error('quota'); } };
  const persistence = createFlowPersistence({ storage: broken });
  assert.equal(persistence.read(), null);
  assert.equal(persistence.save(state()), false);
  assert.doesNotThrow(() => persistence.clear());
  const local = storage();
  local.setItem('ownflick.flow.session.v1', JSON.stringify(state({ seed: '', position: 'oops' })));
  assert.equal(createFlowPersistence({ storage: local }).read(), null);
});

class Video extends EventTarget {
  constructor() { super(); this.readyState = 0; this.duration = NaN; this.currentTime = 0; this.paused = true; }
  fire(name) { this.dispatchEvent(new Event(name)); }
}

test('short clip resume waits for metadata, preserves fractions and does not rewind a released source', () => {
  const { SpoolyResume } = browser('playback_resume.js');
  const video = new Video();
  const samples = [];
  let ready = 0;
  SpoolyResume.trackLocal(video, { position: 2.75, onSample: x => samples.push(x), onReady: () => ready++ });
  video.fire('timeupdate');
  assert.equal(samples.length, 0);
  assert.equal(video.currentTime, 0);
  video.readyState = 1; video.duration = 14;
  video.fire('loadedmetadata');
  assert.equal(video.currentTime, 2.75);
  assert.equal(ready, 1);
  assert.equal(video._localResumeReady, true);
  video.currentTime = 3.125;
  video.fire('pause');
  assert.equal(samples.at(-1).position, 3.125);
  assert.equal(samples.at(-1).force, true);
  video.fire('loadedmetadata');
  assert.equal(video.currentTime, 3.125);
  assert.equal(ready, 1);
});

test('resume keeps near-end seconds and safely handles completed or shortened media', () => {
  const { SpoolyResume } = browser('playback_resume.js');
  for (const [position, expected] of [[29.8, 29.8], [30, 0], [90, 0], [-1, 0]]) {
    const video = new Video();
    video.readyState = 1; video.duration = 30;
    SpoolyResume.trackLocal(video, { position });
    assert.equal(video.currentTime, expected);
  }
});
