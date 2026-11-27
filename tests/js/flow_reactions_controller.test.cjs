'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function controller(setReaction) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../spooly/static/flow_reactions_controller.js'), 'utf8'), { window });
  const events = [];
  const instance = window.createFlowReactionsController({
    setReaction,
    onChange: (state, name, meta) => events.push({ ...state, name, ...meta }),
  });
  return { instance, events };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise(setImmediate);

test('hydrates media and gallery children without overwriting session changes', async () => {
  const { instance, events } = controller(async () => ({ is_liked: true }));
  instance.hydrate([{ name: 'a', is_favorited: true }, { type: 'image_group', items: [{ name: 'b', is_liked: true }] }]);
  instance.show('a');
  assert.equal(events.at(-1).is_favorited, true);
  assert.equal(events.at(-1).is_liked, false);
  instance.show('b');
  assert.equal(events.at(-1).is_liked, true);
  await instance.ensureLike('a');
  instance.hydrate([{ name: 'a', is_liked: false }]);
  instance.show('a');
  assert.equal(events.at(-1).is_liked, true);
});

test('independent fields keep concurrent responses from overwriting one another', async () => {
  const like = deferred(), favorite = deferred();
  const calls = [];
  const { instance, events } = controller((name, kind, state) => {
    calls.push({ name, kind, state });
    return kind === 'like' ? like.promise : favorite.promise;
  });
  const liking = instance.toggle('a', 'like');
  const saving = instance.toggle('a', 'favorite');
  await turn();
  assert.equal(calls.length, 2);
  favorite.resolve({ is_favorited: true, is_liked: false });
  await saving;
  assert.equal(events.at(-1).is_liked, true);
  like.resolve({ is_liked: true, is_favorited: false });
  await liking;
  assert.equal(events.at(-1).is_liked, true);
  assert.equal(events.at(-1).is_favorited, true);
  assert.equal(events.at(-1).likePending, false);
  assert.equal(events.at(-1).favoritePending, false);
});

test('repeated double taps send only one explicit true and never unlike', async () => {
  const response = deferred();
  const calls = [];
  const { instance } = controller((name, kind, value) => { calls.push({ name, kind, value }); return response.promise; });
  const first = instance.ensureLike('a');
  const second = instance.ensureLike('a');
  response.resolve({ is_liked: true });
  await Promise.all([first, second]);
  await instance.ensureLike('a');
  assert.deepEqual(calls, [{ name: 'a', kind: 'like', value: true }]);
});

test('double tap during unlike serializes a like after the pending write', async () => {
  const response = deferred();
  const calls = [];
  const { instance, events } = controller((name, kind, value) => {
    calls.push(value);
    return calls.length === 1 ? response.promise : Promise.resolve({ is_liked: value });
  });
  instance.hydrate([{ name: 'a', is_liked: true }]);
  const unliking = instance.toggle('a', 'like');
  const liking = instance.ensureLike('a');
  response.resolve({ is_liked: false });
  await Promise.all([unliking, liking]);
  assert.deepEqual(calls, [false, true]);
  assert.equal(events.at(-1).is_liked, true);
});

test('failure rolls back only its own field, releases busy state, and permits retry', async () => {
  let fail = true;
  const { instance, events } = controller(async (name, kind, value) => {
    if (kind === 'like' && fail) throw new Error('offline');
    return { [kind === 'like' ? 'is_liked' : 'is_favorited']: value };
  });
  const liking = instance.toggle('a', 'like');
  const saving = instance.toggle('a', 'favorite');
  await assert.rejects(liking, /offline/);
  await saving;
  assert.equal(events.at(-1).is_liked, false);
  assert.equal(events.at(-1).is_favorited, true);
  assert.equal(events.at(-1).likePending, false);
  fail = false;
  await instance.ensureLike('a');
  assert.equal(events.at(-1).is_liked, true);
});

test('late responses retain their original media key and leave the next media available', async () => {
  const response = deferred();
  const { instance, events } = controller((name) => name === 'a' ? response.promise : Promise.resolve({ is_liked: true }));
  const pending = instance.toggle('a', 'like');
  instance.show('b');
  assert.equal(events.at(-1).name, 'b');
  assert.equal(events.at(-1).likePending, false);
  await instance.toggle('b', 'like');
  response.resolve({ is_liked: true });
  await pending;
  assert.equal(events.at(-1).name, 'a');
  instance.show('b');
  assert.equal(events.at(-1).is_liked, true);
});
