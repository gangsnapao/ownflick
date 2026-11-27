(function (global) {
  'use strict';

  function noop() {}

  function createFlowProgressController(options) {
    var opts = options || {};
    var controls = opts.controls;
    var range = opts.range;
    var fill = opts.fill;
    var current = opts.current;
    var total = opts.total;
    var preview = opts.preview;
    var getVideo = typeof opts.getVideo === 'function' ? opts.getVideo : function () { return null; };
    var isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : function () { return false; };
    var onSeekingChange = typeof opts.onSeekingChange === 'function' ? opts.onSeekingChange : noop;
    var formatTime = typeof opts.formatTime === 'function' ? opts.formatTime : function () { return '00:00'; };
    var doc = range?.ownerDocument || controls?.ownerDocument || global.document;
    var drag = null;
    var renderedValue = null;

    function activeVideo() {
      try {
        return getVideo();
      } catch (error) {
        return null;
      }
    }

    function durationOf(video) {
      try {
        var duration = Number(video?.duration);
        return Number.isFinite(duration) && duration > 0 ? duration : 0;
      } catch (error) {
        return 0;
      }
    }

    function clamp(value, max) {
      return Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
    }

    function timeOf(video, duration) {
      try {
        return clamp(Number(video?.currentTime), duration);
      } catch (error) {
        return 0;
      }
    }

    function isHidden() {
      return !!doc?.hidden || doc?.visibilityState === 'hidden';
    }

    function blocked() {
      try {
        return isHidden() || !!isBlocked();
      } catch (error) {
        return true;
      }
    }

    function setPreview(visible) {
      if (!preview) return;
      preview.hidden = !visible;
      preview.setAttribute('aria-hidden', String(!visible));
    }

    function notifySeeking(value) {
      if (controls?.classList) controls.classList.toggle('is-seeking', value);
      setPreview(value);
      try {
        onSeekingChange(value);
      } catch (error) {
        // A host callback must not prevent pointer capture from being released.
      }
    }

    function render(video, time) {
      var duration = durationOf(video);
      var position = duration ? clamp(time === undefined ? timeOf(video, duration) : time, duration) : 0;
      var percent = duration ? position / duration * 100 : 0;
      var currentText = formatTime(position);
      var totalText = formatTime(duration);
      var label = currentText + ' / ' + totalText;
      if (range) {
        range.disabled = !duration;
        range.value = percent;
        renderedValue = String(range.value);
        range.setAttribute('aria-valuetext', label);
      }
      if (fill) fill.style.width = percent + '%';
      if (current) current.textContent = currentText;
      if (total) total.textContent = totalText;
      if (preview) preview.textContent = label;
    }

    function playSafely(video) {
      try {
        Promise.resolve(video.play()).catch(noop);
      } catch (error) {
        // Playback can fail synchronously as well as through its promise.
      }
    }

    function finish(commit, resume) {
      var state = drag;
      if (!state) return;
      // Clear first: releasing capture can synchronously dispatch lostpointercapture.
      drag = null;
      try {
        if (typeof range?.releasePointerCapture === 'function') range.releasePointerCapture(state.id);
      } catch (error) {
        // Capture may already have been released by the browser.
      }
      notifySeeking(false);
      var video = activeVideo();
      var duration = durationOf(video);
      if (video === state.video && duration && commit && !isHidden()) {
        try {
          video.currentTime = clamp(state.to, duration);
        } catch (error) {
          // Even an unseekable media element must release the outer paging lock.
        }
      }
      render(activeVideo());
      if (resume && state.wasPlaying && activeVideo() === state.video && durationOf(state.video) && !isHidden()) {
        playSafely(state.video);
      }
    }

    function cancel() {
      finish(false, false);
    }

    function validDrag() {
      if (!drag) return false;
      if (activeVideo() !== drag.video || !durationOf(drag.video) || isHidden()) {
        cancel();
        return false;
      }
      return true;
    }

    function sync(video) {
      validDrag();
      if (video !== activeVideo() || drag) return;
      render(video);
    }

    function pointTime(event, video) {
      var bounds = range.getBoundingClientRect();
      if (!Number.isFinite(event.clientX) || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.width) || bounds.width <= 0) {
        return null;
      }
      return clamp((event.clientX - bounds.left) / bounds.width, 1) * durationOf(video);
    }

    function move(event) {
      if (!validDrag() || event.pointerId !== drag.id) return;
      if (event.cancelable) event.preventDefault();
      try {
        var time = pointTime(event, drag.video);
        if (time === null) return;
        drag.to = time;
        render(drag.video, time);
      } catch (error) {
        finish(false, true);
      }
    }

    function begin(event) {
      if (event.cancelable) event.preventDefault();
      validDrag();
      if (drag || event.isPrimary === false || (event.button !== undefined && event.button !== 0) || blocked()) return;
      var video = activeVideo();
      if (!durationOf(video)) {
        sync(video);
        return;
      }
      try {
        var time = pointTime(event, video);
        if (time === null) return;
        // Cancel the range's native pointer drag, but still allow keyboard focus.
        range.focus?.({ preventScroll: true });
        drag = { id: event.pointerId, video: video, to: time, wasPlaying: !video.paused };
        notifySeeking(true);
        if (!validDrag()) return;
        video.pause();
        range.setPointerCapture(event.pointerId);
        if (validDrag()) render(video, time);
      } catch (error) {
        finish(false, true);
      }
    }

    function end(event, commit) {
      if (!validDrag() || event.pointerId !== drag.id) return;
      if (event.cancelable) event.preventDefault();
      if (commit) move(event);
      if (drag) finish(commit, true);
    }

    function seekFromRange(event) {
      if (validDrag()) {
        render(drag.video, drag.to);
        return;
      }
      var video = activeVideo();
      // A trailing change carries the range's step-rounded value, not the exact pointer time.
      if (event.type === 'change' && String(range.value) === renderedValue) {
        sync(video);
        return;
      }
      var duration = durationOf(video);
      if (duration && !blocked()) {
        var percent = clamp(Number(range.value), 100);
        try {
          video.currentTime = percent / 100 * duration;
        } catch (error) {
          // Native keyboard input never owns a drag lock or changes playback.
        }
      }
      sync(video);
    }

    function listen(target, name, handler, options) {
      target?.addEventListener(name, handler, options);
    }

    function isolate(event) {
      event.stopPropagation();
      if ((event.type.indexOf('touch') === 0 || event.type === 'wheel') && event.cancelable) event.preventDefault();
    }

    var isolatedEvents = [
      'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
      'pointerover', 'pointerout', 'pointerenter', 'pointerleave',
      'touchstart', 'touchmove', 'touchend', 'touchcancel',
      'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
      'click', 'dblclick', 'contextmenu', 'wheel',
    ];
    isolatedEvents.forEach(function (name) {
      listen(controls, name, isolate, { passive: false });
      if (range !== controls) listen(range, name, isolate, { passive: false });
    });
    listen(range, 'pointerdown', begin);
    listen(range, 'pointermove', move);
    listen(range, 'pointerup', function (event) { end(event, true); });
    listen(range, 'pointercancel', function (event) { end(event, false); });
    listen(range, 'lostpointercapture', function (event) { end(event, false); });
    listen(range, 'input', seekFromRange);
    listen(range, 'change', seekFromRange);
    // Stopping propagation does not interfere with the range's native arrow/Home/End behavior.
    listen(range, 'keydown', function (event) { event.stopPropagation(); });
    listen(range, 'keyup', function (event) { event.stopPropagation(); });
    listen(range, 'blur', cancel);
    listen(global, 'blur', cancel);
    listen(global, 'pagehide', cancel);
    listen(doc, 'visibilitychange', function () { if (isHidden()) cancel(); });

    setPreview(false);
    sync(activeVideo());
    return {
      sync: sync,
      cancel: cancel,
      isSeeking: function () { return validDrag(); },
    };
  }

  global.createFlowProgressController = createFlowProgressController;
})(window);
