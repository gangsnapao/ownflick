(function (global) {
  'use strict';

  function noop() {}

  function createFlowStateController(options) {
    var opts = options || {};
    var getMediaType = typeof opts.getMediaType === 'function' ? opts.getMediaType : function () { return ''; };
    var canMagnifyMedia = typeof opts.canMagnifyMedia === 'function'
      ? opts.canMagnifyMedia
      : function (mediaType) { return mediaType === 'image'; };
    var onImmersiveChange = typeof opts.onImmersiveChange === 'function' ? opts.onImmersiveChange : noop;
    var onMagnifyingChange = typeof opts.onMagnifyingChange === 'function' ? opts.onMagnifyingChange : noop;

    var isCleanMode = false;
    var magnifying = false;

    function canMagnify() {
      try {
        return !!canMagnifyMedia(getMediaType());
      } catch (error) {
        return false;
      }
    }

    function setImmersive(enabled) {
      var next = !!enabled;
      if (next === isCleanMode) return isCleanMode;

      if (next && magnifying) {
        magnifying = false;
        onMagnifyingChange(false);
      }

      isCleanMode = next;
      onImmersiveChange(isCleanMode);
      return isCleanMode;
    }

    function toggleImmersive() {
      return setImmersive(!isCleanMode);
    }

    function setMagnifying(enabled) {
      var next = !!enabled && canMagnify();
      if (next === magnifying) return magnifying;

      if (next && isCleanMode) {
        isCleanMode = false;
        onImmersiveChange(false);
      }

      magnifying = next;
      onMagnifyingChange(magnifying);
      return magnifying;
    }

    function onMediaChanged() {
      if (!canMagnify() && magnifying) {
        magnifying = false;
        onMagnifyingChange(false);
      }
    }

    function reset() {
      isCleanMode = false;
      magnifying = false;
      onImmersiveChange(false);
      onMagnifyingChange(false);
    }

    return {
      setCleanMode: setImmersive,
      toggleCleanMode: toggleImmersive,
      isCleanMode: function () { return isCleanMode; },
      setImmersive: setImmersive,
      toggleImmersive: toggleImmersive,
      setMagnifying: setMagnifying,
      onMediaChanged: onMediaChanged,
      reset: reset,
    };
  }

  global.createFlowStateController = createFlowStateController;
})(window);
