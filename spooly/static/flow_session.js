(function (global) {
  'use strict';

  function toKey(item, keyOf) {
    try {
      var key = keyOf(item);
      return String(key || '');
    } catch (error) {
      return '';
    }
  }

  function createFlowSession(options) {
    var opts = options || {};
    var keyOf = typeof opts.keyOf === 'function'
      ? opts.keyOf
      : function (item) { return String((item && item.name) || ''); };

    var items = [];
    var keys = new Set();
    var index = Number.isInteger(opts.initialIndex) ? opts.initialIndex : -1;
    var hasMore = opts.initialHasMore !== false;
    var loading = false;
    var generation = 0;
    var cursor = opts.initialCursor || null;

    function appendUnique(batch) {
      var list = Array.isArray(batch) ? batch : [];
      var appendedIndices = [];
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i];
        var key = toKey(item, keyOf);
        if (!key || keys.has(key)) continue;
        keys.add(key);
        items.push(item);
        appendedIndices.push(items.length - 1);
      }
      return {
        appended: appendedIndices.length,
        appendedIndices: appendedIndices,
      };
    }

    function currentItem() {
      if (index < 0 || index >= items.length) return null;
      return items[index];
    }

    function setIndex(next) {
      if (!Number.isInteger(next)) return index;
      index = Math.max(-1, Math.min(next, items.length - 1));
      return index;
    }

    function dropHead(count) {
      var removeCount = Math.max(0, Math.min(Number(count) || 0, items.length));
      if (!removeCount) return [];
      var removed = items.splice(0, removeCount);
      for (var i = 0; i < removed.length; i += 1) {
        var key = toKey(removed[i], keyOf);
        if (key) keys.delete(key);
      }
      index = Math.max(-1, index - removeCount);
      if (items.length === 0) index = -1;
      return removed;
    }

    async function loadMore(loader) {
      if (loading || !hasMore || typeof loader !== 'function') {
        return { skipped: true, appended: 0, appendedIndices: [] };
      }

      loading = true;
      var requestGeneration = generation;
      try {
        var payload = await loader(cursor);
        if (generation !== requestGeneration) {
          return { skipped: true, stale: true, appended: 0, appendedIndices: [] };
        }
        var incoming = Array.isArray(payload && payload.items) ? payload.items : [];
        var appendResult = appendUnique(incoming);

        if (payload && Object.prototype.hasOwnProperty.call(payload, 'hasMore')) {
          hasMore = !!payload.hasMore;
        }
        if (payload && Object.prototype.hasOwnProperty.call(payload, 'cursor')) {
          cursor = payload.cursor;
        }

        return {
          skipped: false,
          payload: payload || {},
          appended: appendResult.appended,
          appendedIndices: appendResult.appendedIndices,
        };
      } finally {
        if (generation === requestGeneration) loading = false;
      }
    }

    function reset(next) {
      generation += 1;
      loading = false;
      var conf = next || {};
      items.length = 0;
      keys.clear();
      index = Number.isInteger(conf.index) ? conf.index : -1;
      hasMore = conf.hasMore !== false;
      cursor = Object.prototype.hasOwnProperty.call(conf, 'cursor') ? conf.cursor : null;
    }

    appendUnique(opts.initialItems || []);
    index = Math.max(-1, Math.min(index, items.length - 1));

    return {
      items: items,
      currentItem: currentItem,
      getIndex: function () { return index; },
      setIndex: setIndex,
      hasMore: function () { return hasMore; },
      setHasMore: function (next) { hasMore = !!next; },
      isLoading: function () { return loading; },
      loadMore: loadMore,
      dropHead: dropHead,
      reset: reset,
    };
  }

  // Persist the permutation identity and current URI, never DOM nodes or media URLs.
  // The server reconstructs this exact order and revalidates the current file.
  function createFlowPersistence(options) {
    var opts = options || {};
    var storage = null;
    try { storage = opts.storage === undefined ? global.localStorage : opts.storage; } catch (error) {}
    var key = opts.key || 'ownflick.flow.session.v1';

    function clean(raw) {
      if (!raw || raw.version !== 1 || typeof raw.seed !== 'string' || !raw.seed
        || raw.seed.length > 512 || raw.seed.includes('\u0000')
        || typeof raw.uri !== 'string' || !raw.uri || raw.uri.length > 4096
        || raw.uri.includes('\u0000') || !['image', 'video'].includes(raw.type)) return null;
      var position = Number(raw.position);
      var duration = Number(raw.duration);
      return {
        version: 1,
        seed: raw.seed,
        avoidUri: typeof raw.avoidUri === 'string' && raw.avoidUri.length <= 4096 ? raw.avoidUri : '',
        uri: raw.uri,
        type: raw.type,
        position: raw.type === 'video' && Number.isFinite(position) && position >= 0 ? position : 0,
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        updatedAt: Number(raw.updatedAt) || 0,
      };
    }

    return {
      read: function () {
        try { return clean(JSON.parse(storage.getItem(key))); } catch (error) { return null; }
      },
      save: function (state) {
        var value = clean(Object.assign({}, state, { version: 1, updatedAt: Date.now() }));
        if (!value) return false;
        try { storage.setItem(key, JSON.stringify(value)); return true; } catch (error) { return false; }
      },
      clear: function () {
        try { storage.removeItem(key); } catch (error) {}
      },
    };
  }

  global.createFlowSession = createFlowSession;
  global.createFlowPersistence = createFlowPersistence;
})(window);
