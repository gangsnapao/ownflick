// One seek lifecycle for Flow and the Library/Favorites/Collections viewer.
(function (global) {
  'use strict';

  function createPlayerProgressController(options) {
    var input = options.input;
    var controls = options.controls;
    var preview = options.preview;
    var active = null;
    var listeners = [];
    var formatTime = global.FlowUIShared.formatTime;

    function listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      listeners.push(function () { target.removeEventListener(type, fn, opts); });
    }

    function durationOf(video) {
      var duration = Number(video && video.duration);
      return Number.isFinite(duration) && duration > 0 ? duration : 0;
    }

    function render(time, duration) {
      var safeTime = Math.max(0, Math.min(Number(time) || 0, duration));
      var percent = duration ? safeTime / duration * 100 : 0;
      input.value = percent;
      options.fill.style.width = percent + '%';
      options.currentTime.textContent = formatTime(safeTime);
      options.totalTime.textContent = formatTime(duration);
      input.setAttribute('aria-valuetext', formatTime(safeTime) + ' / ' + formatTime(duration));
      if (active && preview) preview.textContent = formatTime(safeTime) + ' / ' + formatTime(duration);
    }

    function sync() {
      if (active) return;
      var video = options.getVideo();
      var duration = durationOf(video);
      input.disabled = !duration;
      render(video ? video.currentTime : 0, duration);
    }

    function begin(mode, pointerId) {
      if (active || (options.canStart && !options.canStart())) return false;
      var video = options.getVideo();
      var duration = durationOf(video);
      if (!video || !duration) return false;
      active = {
        video: video, source: video.currentSrc || video.src, mode: mode,
        pointerId: pointerId, duration: duration, time: Number(video.currentTime) || 0,
        resume: !video.paused,
      };
      video.pause();
      controls.classList.add('is-seeking');
      if (preview) preview.hidden = false;
      if (options.onActiveChange) options.onActiveChange(true);
      render(active.time, duration);
      return true;
    }

    function finish(commit, opts) {
      if (!active) return;
      var state = active;
      active = null;
      controls.classList.remove('is-seeking');
      if (preview) preview.hidden = true;
      var sameMedia = options.getVideo() === state.video
        && (state.video.currentSrc || state.video.src) === state.source;
      if (commit && sameMedia && durationOf(state.video)) {
        state.video.currentTime = Math.min(state.time, durationOf(state.video));
      }
      if (state.pointerId != null && input.hasPointerCapture && input.hasPointerCapture(state.pointerId)) {
        input.releasePointerCapture(state.pointerId);
      }
      if (options.onActiveChange) options.onActiveChange(false);
      sync();
      if (sameMedia && state.resume && (!opts || opts.resume !== false)) {
        var promise = state.video.play();
        if (promise && promise.catch) promise.catch(function () {});
      }
    }

    function pointAt(clientX) {
      if (!active) return;
      var rect = input.getBoundingClientRect();
      if (!rect.width) return;
      active.time = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * active.duration;
      render(active.time, active.duration);
    }

    function isolate(event) {
      event.stopPropagation();
    }

    // Controls own their pointers/touches, including compatibility mouse events.
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart',
      'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'click', 'dblclick',
      'keydown', 'keyup'].forEach(function (type) {
      listen(controls, type, isolate);
    });
    listen(controls, 'wheel', function (event) {
      event.stopPropagation();
      event.preventDefault();
    }, { passive: false });

    if (global.PointerEvent) {
      listen(input, 'pointerdown', function (event) {
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0) return;
        event.preventDefault();
        if (!begin('pointer', event.pointerId)) return;
        input.focus({ preventScroll: true });
        try { input.setPointerCapture(event.pointerId); } catch (_) {}
        pointAt(event.clientX);
      });
      // Window capture also releases the lock if capture is unsupported or lost.
      listen(global, 'pointermove', function (event) {
        if (!active || active.mode !== 'pointer' || active.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (event.cancelable) event.preventDefault();
        pointAt(event.clientX);
      }, { capture: true, passive: false });
      listen(global, 'pointerup', function (event) {
        if (!active || active.mode !== 'pointer' || active.pointerId !== event.pointerId) return;
        event.stopPropagation();
        pointAt(event.clientX);
        finish(true);
      }, true);
      listen(global, 'pointercancel', function (event) {
        if (!active || active.pointerId !== event.pointerId) return;
        event.stopPropagation();
        finish(false);
      }, true);
      listen(input, 'lostpointercapture', function () { finish(false); });
    } else {
      // Older touch browsers retain a full cancellation path without Pointer Events.
      listen(input, 'touchstart', function (event) {
        event.stopPropagation();
        if (event.touches.length !== 1 || !begin('touch', event.touches[0].identifier)) return;
        event.preventDefault();
        pointAt(event.touches[0].clientX);
      }, { passive: false });
      listen(global, 'touchmove', function (event) {
        if (!active || active.mode !== 'touch') return;
        var touch = Array.from(event.touches).find(function (item) { return item.identifier === active.pointerId; });
        if (!touch) return;
        event.preventDefault();
        event.stopPropagation();
        pointAt(touch.clientX);
      }, { capture: true, passive: false });
      listen(global, 'touchend', function (event) {
        if (!active || active.mode !== 'touch') return;
        var touch = Array.from(event.changedTouches).find(function (item) { return item.identifier === active.pointerId; });
        if (!touch) return;
        event.stopPropagation();
        pointAt(touch.clientX);
        finish(true);
      }, true);
      listen(global, 'touchcancel', function () { if (active && active.mode === 'touch') finish(false); }, true);
    }

    var seekKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
    listen(input, 'keydown', function (event) {
      if (seekKeys.indexOf(event.key) < 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (!active && !begin('keyboard')) return;
      if (active.mode !== 'keyboard') return;
      var direction = ['ArrowLeft', 'ArrowDown', 'PageDown'].indexOf(event.key) >= 0 ? -1 : 1;
      var step = event.key.indexOf('Page') === 0 ? active.duration * 0.1 : 5;
      active.time = event.key === 'Home' ? 0 : event.key === 'End' ? active.duration
        : Math.max(0, Math.min(active.duration, active.time + direction * step));
      render(active.time, active.duration);
    });
    listen(input, 'keyup', function (event) {
      if (seekKeys.indexOf(event.key) >= 0 && active && active.mode === 'keyboard') finish(true);
    });
    // Native input/change remains available to assistive technology.
    listen(input, 'input', function () {
      var value = Number(input.value);
      if (!active && !begin('native')) return;
      if (active.mode !== 'native') return;
      active.time = value / 100 * active.duration;
      render(active.time, active.duration);
    });
    listen(input, 'change', function () { if (active && active.mode === 'native') finish(true); });
    listen(input, 'blur', function () { finish(false); });
    listen(global, 'blur', function () { finish(false, { resume: false }); });
    listen(global, 'pagehide', function () { finish(false, { resume: false }); });
    listen(document, 'visibilitychange', function () {
      if (document.hidden) finish(false, { resume: false });
    });
    sync();
    return {
      isActive: function () { return !!active; },
      sync: sync,
      cancel: function (opts) { finish(false, opts); },
      destroy: function () {
        finish(false, { resume: false });
        listeners.forEach(function (remove) { remove(); });
      },
    };
  }

  global.createPlayerProgressController = createPlayerProgressController;
})(window);
