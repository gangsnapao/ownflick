'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../../spooly/static/flow_progress_controller.js'), 'utf8');

class Element extends EventTarget {
  constructor(ownerDocument) {
    super();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.style = {};
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    this.value = '0';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.captured = new Set();
    this.captureCalls = [];
    this.releaseCalls = [];
    this.bounds = { left: 100, width: 320 };
  }

  dispatchEvent(event) {
    const accepted = super.dispatchEvent(event);
    if (event.bubbles && !event.cancelBubble && this.parentNode) this.parentNode.dispatchEvent(event);
    return accepted;
  }

  get value() { return this._value; }
  set value(value) {
    const number = Number(value);
    this._value = String(this.step > 0 && Number.isFinite(number) ? Math.round(number / this.step) * this.step : value);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  getBoundingClientRect() { return this.bounds; }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.captured.add(id); this.captureCalls.push(id); }
  releasePointerCapture(id) {
    this.releaseCalls.push(id);
    if (this.captured.delete(id)) emit(this, 'lostpointercapture', { pointerId: id });
  }
}

function emit(target, type, properties = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, properties);
  target.dispatchEvent(event);
  return event;
}

function pointer(target, type, x, properties = {}) {
  return emit(target, type, { pointerId: 7, isPrimary: true, button: 0, clientX: x, ...properties });
}

function video(options = {}) {
  return {
    duration: 100,
    _time: 20,
    paused: false,
    pauseCalls: 0,
    playCalls: 0,
    writes: [],
    get currentTime() { return this._time; },
    set currentTime(value) {
      if (this.throwOnSeek) throw new Error('Media is no longer seekable');
      this.writes.push(value);
      this._time = value;
    },
    pause() { this.pauseCalls += 1; this.paused = true; },
    play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
    ...options,
  };
}

function formatTime(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function setup(initialVideo = video()) {
  const document = new EventTarget();
  document.hidden = false;
  document.visibilityState = 'visible';
  const window = new EventTarget();
  window.document = document;
  const outer = new Element(document);
  const controls = new Element(document);
  const range = new Element(document);
  range.step = 0.01;
  controls.parentNode = outer;
  range.parentNode = controls;
  const elements = {
    controls,
    range,
    fill: new Element(document),
    current: new Element(document),
    total: new Element(document),
    preview: new Element(document),
  };
  let active = initialVideo;
  let blocked = false;
  const notifications = [];
  vm.runInNewContext(source, { window }, { filename: 'flow_progress_controller.js' });
  const controller = window.createFlowProgressController({
    ...elements,
    getVideo: () => active,
    isBlocked: () => blocked,
    onSeekingChange: (value) => notifications.push(value),
    formatTime,
  });
  return {
    ...elements, controller, document, window, outer, notifications,
    setVideo: (value) => { active = value; },
    setBlocked: (value) => { blocked = value; },
  };
}

function assertUnlocked(ui) {
  assert.equal(ui.controller.isSeeking(), false);
  assert.equal(ui.controls.classList.contains('is-seeking'), false);
  assert.equal(ui.preview.hidden, true);
  assert.equal(ui.preview.getAttribute('aria-hidden'), 'true');
  assert.equal(ui.range.captured.size, 0);
  assert.deepEqual(ui.notifications, [true, false]);
}

test('sync renders the active video only and refreshes duration and accessible text', () => {
  const clip = video();
  const ui = setup(clip);
  assert.equal(ui.range.disabled, false);
  assert.equal(Number(ui.range.value), 20);
  assert.equal(ui.fill.style.width, '20%');
  assert.equal(ui.current.textContent, '00:20');
  assert.equal(ui.total.textContent, '01:40');
  assert.equal(ui.range.getAttribute('aria-valuetext'), '00:20 / 01:40');
  ui.controller.sync(video({ duration: 50, _time: 45 }));
  assert.equal(Number(ui.range.value), 20);
  clip.duration = 200;
  clip._time = 50;
  ui.controller.sync(clip);
  assert.equal(Number(ui.range.value), 25);
  assert.equal(ui.total.textContent, '03:20');
  clip._time = Infinity;
  ui.controller.sync(clip);
  assert.equal(Number(ui.range.value), 0);
});

test('pointer drag pauses immediately, captures, previews only, and commits exact release position', () => {
  const clip = video({ duration: 123.45 });
  const ui = setup(clip);
  const down = pointer(ui.range, 'pointerdown', 180);
  assert.equal(down.defaultPrevented, true);
  assert.equal(ui.controller.isSeeking(), true);
  assert.equal(clip.paused, true);
  assert.equal(clip.pauseCalls, 1);
  assert.deepEqual(ui.range.captureCalls, [7]);
  assert.deepEqual(ui.notifications, [true]);
  assert.equal(ui.preview.hidden, false);
  assert.equal(ui.preview.textContent, '00:30 / 02:03');
  assert.equal(ui.range.focused, true);
  pointer(ui.range, 'pointermove', 260);
  assert.equal(ui.preview.textContent, '01:01 / 02:03');
  assert.equal(ui.fill.style.width, '50%');
  assert.equal(clip.currentTime, 20);
  assert.deepEqual(clip.writes, []);
  ui.controller.sync(clip);
  assert.equal(ui.fill.style.width, '50%');
  ui.range.value = '1';
  emit(ui.range, 'input');
  assert.deepEqual(clip.writes, []);
  assert.equal(Number(ui.range.value), 50);
  pointer(ui.range, 'pointerup', 234.567);
  const expected = (234.567 - 100) / 320 * clip.duration;
  assert.equal(clip.currentTime, expected);
  assert.notEqual(Number(ui.range.value) / 100 * clip.duration, expected, 'the native range value is step-rounded');
  emit(ui.range, 'change');
  emit(ui.range, 'change');
  assert.equal(clip.currentTime, expected, 'trailing changes must retain the exact pointer commit');
  assert.deepEqual(clip.writes, [expected]);
  assert.equal(clip.playCalls, 1);
  assert.equal(clip.paused, false);
  assert.deepEqual(ui.range.releaseCalls, [7]);
  assertUnlocked(ui);
});

test('paused video remains paused after a pointer commit, with positions clamped to the track', () => {
  const clip = video({ paused: true });
  const ui = setup(clip);
  pointer(ui.range, 'pointerdown', 0);
  assert.equal(Number(ui.range.value), 0);
  pointer(ui.range, 'pointermove', 1000);
  assert.equal(Number(ui.range.value), 100);
  pointer(ui.range, 'pointerup', 1000);
  assert.equal(clip.currentTime, 100);
  assert.equal(clip.playCalls, 0);
  assert.equal(clip.paused, true);
  assertUnlocked(ui);
});

for (const eventType of ['pointercancel', 'lostpointercapture']) {
  test(`${eventType} discards preview, unlocks, and restores the prior playback state`, () => {
    const clip = video();
    const ui = setup(clip);
    pointer(ui.range, 'pointerdown', 180);
    pointer(ui.range, 'pointermove', 400);
    pointer(ui.range, eventType, 400);
    assert.equal(clip.currentTime, 20);
    assert.deepEqual(clip.writes, []);
    assert.equal(Number(ui.range.value), 20);
    assert.equal(ui.current.textContent, '00:20');
    assert.equal(clip.playCalls, 1);
    assertUnlocked(ui);
    pointer(ui.range, 'pointerup', 400);
    assert.equal(clip.playCalls, 1);
  });
}

test('pointer cancellation also preserves an initially paused video', () => {
  const clip = video({ paused: true });
  const ui = setup(clip);
  pointer(ui.range, 'pointerdown', 300);
  pointer(ui.range, 'pointercancel', 300);
  assert.equal(clip.paused, true);
  assert.equal(clip.playCalls, 0);
  assertUnlocked(ui);
});

test('cancel used during media switching never resumes or seeks the old or new video', () => {
  const oldClip = video();
  const nextClip = video({ duration: 200, _time: 80, paused: true });
  const ui = setup(oldClip);
  pointer(ui.range, 'pointerdown', 300);
  ui.setVideo(nextClip);
  ui.controller.cancel();
  pointer(ui.range, 'pointerup', 400);
  assert.equal(oldClip.playCalls, 0);
  assert.equal(oldClip.paused, true);
  assert.deepEqual(oldClip.writes, []);
  assert.equal(nextClip.playCalls, 0);
  assert.deepEqual(nextClip.writes, []);
  assert.equal(Number(ui.range.value), 40);
  assertUnlocked(ui);
  ui.controller.cancel();
  assert.deepEqual(ui.notifications, [true, false]);
});

test('a media change detected on pointer release also clears the stale drag without replay', () => {
  const oldClip = video();
  const nextClip = video({ duration: 60, _time: 30 });
  const ui = setup(oldClip);
  pointer(ui.range, 'pointerdown', 300);
  ui.setVideo(nextClip);
  pointer(ui.range, 'pointerup', 400);
  assert.equal(oldClip.playCalls, 0);
  assert.deepEqual(oldClip.writes, []);
  assert.deepEqual(nextClip.writes, []);
  assert.equal(Number(ui.range.value), 50);
  assertUnlocked(ui);
});

for (const action of ['range blur', 'window blur', 'visibilitychange', 'pagehide']) {
  test(`${action} reliably cleans up without resuming playback`, () => {
    const clip = video();
    const ui = setup(clip);
    pointer(ui.range, 'pointerdown', 300);
    if (action === 'visibilitychange') {
      ui.document.hidden = true;
      ui.document.visibilityState = 'hidden';
      emit(ui.document, 'visibilitychange');
    } else if (action === 'range blur') {
      emit(ui.range, 'blur');
    } else {
      emit(ui.window, action === 'window blur' ? 'blur' : action);
    }
    assert.equal(clip.playCalls, 0);
    assert.deepEqual(clip.writes, []);
    assertUnlocked(ui);
  });
}

test('controls isolate pointer, touch, mouse, click and wheel events from outer paging', () => {
  const ui = setup();
  ui.setBlocked(true);
  const types = [
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture',
    'touchstart', 'touchmove', 'touchend', 'touchcancel',
    'mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'wheel',
  ];
  let escaped = 0;
  ui.outer.addEventListener('probe', () => { escaped += 1; });
  emit(ui.range, 'probe');
  assert.equal(escaped, 1, 'the DOM fake must actually bubble unhandled events');
  escaped = 0;
  for (const type of types) ui.outer.addEventListener(type, () => { escaped += 1; });
  for (const target of [ui.range, ui.controls]) {
    for (const type of types) {
      const event = pointer(target, type, 180);
      if (type.startsWith('touch') || type === 'wheel') assert.equal(event.defaultPrevented, true, type);
    }
  }
  assert.equal(escaped, 0);
  assert.equal(ui.controller.isSeeking(), false);
});

test('native keyboard input and change seek immediately without a drag lock or playback changes', () => {
  for (const paused of [true, false]) {
    const clip = video({ paused });
    const ui = setup(clip);
    const key = emit(ui.range, 'keydown', { key: 'ArrowRight' });
    assert.equal(key.defaultPrevented, false);
    ui.range.value = '35.5';
    emit(ui.range, 'input');
    assert.equal(clip.currentTime, 35.5);
    assert.equal(ui.controller.isSeeking(), false);
    ui.range.value = '75';
    emit(ui.range, 'change');
    assert.equal(clip.currentTime, 75);
    assert.equal(ui.range.getAttribute('aria-valuetext'), '01:15 / 01:40');
    assert.equal(clip.pauseCalls, 0);
    assert.equal(clip.playCalls, 0);
    assert.equal(clip.paused, paused);
    assert.deepEqual(ui.notifications, []);
  }
});

test('blocked controls do not start dragging or commit native input', () => {
  const clip = video();
  const ui = setup(clip);
  ui.setBlocked(true);
  pointer(ui.range, 'pointerdown', 300);
  ui.range.value = '90';
  emit(ui.range, 'input');
  assert.equal(ui.controller.isSeeking(), false);
  assert.equal(clip.pauseCalls, 0);
  assert.equal(clip.playCalls, 0);
  assert.deepEqual(clip.writes, []);
  assert.equal(Number(ui.range.value), 20);
  assert.deepEqual(ui.notifications, []);
  ui.setBlocked(false);
  ui.document.hidden = true;
  pointer(ui.range, 'pointerdown', 300);
  assert.equal(ui.controller.isSeeking(), false);
});

test('invalid durations stay disabled and never acquire a drag lock', () => {
  for (const duration of [NaN, Infinity, -Infinity, 0, -1]) {
    const clip = video({ duration });
    const ui = setup(clip);
    assert.equal(ui.range.disabled, true);
    assert.equal(Number(ui.range.value), 0);
    assert.equal(ui.fill.style.width, '0%');
    assert.equal(ui.total.textContent, '00:00');
    pointer(ui.range, 'pointerdown', 300);
    ui.range.value = '80';
    emit(ui.range, 'change');
    assert.equal(ui.controller.isSeeking(), false);
    assert.equal(clip.pauseCalls, 0);
    assert.deepEqual(clip.writes, []);
    assert.deepEqual(ui.notifications, []);
  }
});

test('duration becoming invalid during a drag clears the lock on sync', () => {
  const clip = video();
  const ui = setup(clip);
  pointer(ui.range, 'pointerdown', 300);
  clip.duration = NaN;
  ui.controller.sync(clip);
  assert.equal(ui.range.disabled, true);
  assert.equal(clip.playCalls, 0);
  assert.deepEqual(clip.writes, []);
  assertUnlocked(ui);
});

test('currentTime write failures still clean up capture, preview and the outer lock', () => {
  const clip = video({ throwOnSeek: true });
  const ui = setup(clip);
  pointer(ui.range, 'pointerdown', 300);
  assert.doesNotThrow(() => pointer(ui.range, 'pointerup', 350));
  assert.equal(clip.currentTime, 20);
  assert.equal(clip.playCalls, 1);
  assertUnlocked(ui);
  clip.paused = true;
  ui.range.value = '80';
  assert.doesNotThrow(() => emit(ui.range, 'input'));
  assert.equal(clip.paused, true);
  assert.equal(clip.playCalls, 1);
  assert.equal(Number(ui.range.value), 20);
});

test('capture failure aborts safely and restores a previously playing video', () => {
  const clip = video();
  const ui = setup(clip);
  ui.range.setPointerCapture = () => { throw new Error('Pointer is no longer active'); };
  assert.doesNotThrow(() => pointer(ui.range, 'pointerdown', 300));
  assert.equal(clip.playCalls, 1);
  assert.deepEqual(clip.writes, []);
  assertUnlocked(ui);
});

test('failed play promises and synchronous play errors are handled after unlocking', async () => {
  for (const throws of [false, true]) {
    const clip = video({
      play() {
        this.playCalls += 1;
        if (throws) throw new Error('Playback failed');
        return Promise.reject(new Error('Autoplay denied'));
      },
    });
    const ui = setup(clip);
    pointer(ui.range, 'pointerdown', 300);
    assert.doesNotThrow(() => pointer(ui.range, 'pointerup', 350));
    assert.equal(clip.playCalls, 1);
    assertUnlocked(ui);
  }
  await new Promise(setImmediate);
});

test('unrelated pointers cannot overwrite or finish the active drag', () => {
  const clip = video();
  const ui = setup(clip);
  pointer(ui.range, 'pointerdown', 180);
  pointer(ui.range, 'pointerdown', 400, { pointerId: 8, isPrimary: false });
  pointer(ui.range, 'pointermove', 400, { pointerId: 8 });
  pointer(ui.range, 'pointerup', 400, { pointerId: 8 });
  assert.equal(ui.controller.isSeeking(), true);
  assert.equal(Number(ui.range.value), 25);
  assert.deepEqual(clip.writes, []);
  pointer(ui.range, 'pointerup', 260);
  assert.equal(clip.currentTime, 50);
  assert.equal(clip.pauseCalls, 1);
  assertUnlocked(ui);
});
