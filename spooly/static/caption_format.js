/* Filename → caption cleanup for display (module J).
 *
 * Faithful port of spooly/services/caption_text.py; both implementations run
 * against the shared case table in tests/caption_cases.json. Display-only:
 * URIs, search and downloads keep the original file names (J4).
 */
(function () {
  'use strict';

  var EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;

  // Leading date/time prefixes, newest formats first (stripped at most once).
  var LEADING_PATTERNS = [
    /^\d{4}[-_. ]?\d{2}[-_. ]?\d{2}[-_. ]+\d{2}[-_.:. ]?\d{2}[-_.:. ]?\d{2}/,
    /^\d{14}[-_ ]*/,
    /^\d{4}[-_. ]\d{2}[-_. ]\d{2}[-_. ]*/,
    /^\d{8}(?=[^\d])/,
  ];

  // Trailing numbering: 123 / _123 / -123456 / (2) and repeated groups.
  var TRAILING_NUMBERING_RE = /(?:\s*[-_]\s*\d+|\s*\(\d+\)|\d+)+$/;

  // Stray separators left over after stripping, at both edges.
  var EDGE_SEPARATOR_RE = /^[\s\-_\.]+|[\s\-_\.]+$/g;

  // Optional extra rules (J3): disabled by default, enable by flipping enabled.
  var OPTIONAL_RULES = [
    // { pattern: /^[\w\u4e00-\u9fff]+?[-_](?=(视频|图集))/, enabled: false },
  ];

  var MODE_KEY = 'spooly.captionMode';

  function baseName(filename) {
    var text = String(filename == null ? '' : filename).replace(/\\/g, '/').replace(/\/+$/, '');
    var cut = text.lastIndexOf('/');
    return cut < 0 ? text : text.slice(cut + 1);
  }

  function formatCaption(filename) {
    var name = baseName(filename);
    var stem = name.replace(EXTENSION_RE, '');
    for (var i = 0; i < LEADING_PATTERNS.length; i += 1) {
      var pattern = LEADING_PATTERNS[i];
      if (pattern.test(stem)) {
        stem = stem.replace(pattern, '');
        break;
      }
    }
    stem = stem.replace(TRAILING_NUMBERING_RE, '');
    stem = stem.replace(EDGE_SEPARATOR_RE, '');
    for (var j = 0; j < OPTIONAL_RULES.length; j += 1) {
      if (OPTIONAL_RULES[j].enabled) {
        stem = stem.replace(OPTIONAL_RULES[j].pattern, '').replace(EDGE_SEPARATOR_RE, '');
      }
    }
    return stem.trim() || name;
  }

  function mode() {
    try {
      return window.localStorage.getItem(MODE_KEY) === 'filename' ? 'filename' : 'caption';
    } catch (error) {
      return 'caption';
    }
  }

  function setMode(next) {
    try {
      window.localStorage.setItem(MODE_KEY, next === 'filename' ? 'filename' : 'caption');
    } catch (error) {
      /* Preference stays on its default when storage is unavailable. */
    }
  }

  function display(filename) {
    return mode() === 'filename' ? baseName(filename) : formatCaption(filename);
  }

  window.SpoolyCaption = {
    format: formatCaption,
    baseName: baseName,
    mode: mode,
    setMode: setMode,
    display: display,
  };
})();
