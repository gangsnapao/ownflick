(function (global) {
  'use strict';

  // Each field has its own request lifecycle: a late favorite response must never
  // overwrite a newer like, or the controls for a different displayed image.
  function createFlowReactionsController(options) {
    var opts = options || {};
    var states = new Map();
    var onChange = opts.onChange || function () {};
    var fields = { like: 'is_liked', favorite: 'is_favorited' };

    function entry(name) {
      if (!states.has(name)) {
        states.set(name, { is_liked: false, is_favorited: false, pending: {} });
      }
      return states.get(name);
    }

    function notify(name, meta) {
      var state = entry(name);
      onChange({
        is_liked: state.is_liked,
        is_favorited: state.is_favorited,
        likePending: !!state.pending.like,
        favoritePending: !!state.pending.favorite,
      }, name, meta || {});
    }

    function hydrate(items) {
      (items || []).forEach(function (item) {
        if (item.type === 'image_group') { hydrate(item.items); return; }
        var name = String(item.name || item.uri || '');
        if (!name || states.has(name)) return;
        var state = entry(name);
        state.is_liked = item.is_liked === true;
        state.is_favorited = item.is_favorited === true;
      });
    }

    function set(name, kind, desired) {
      var key = String(name || '');
      if (!key || !fields[kind]) return Promise.resolve(false);
      var state = entry(key);
      var field = fields[kind];
      if (state.pending[kind]) {
        // Double tapping while an unlike is in flight still ends in a like.
        if (typeof desired === 'boolean') {
          return state.pending[kind].catch(function () {}).then(function () {
            return set(key, kind, desired);
          });
        }
        return state.pending[kind];
      }
      var before = state[field];
      var value = typeof desired === 'boolean' ? desired : !before;
      if (before === value) return Promise.resolve(value);
      state[field] = value;
      var request = Promise.resolve().then(function () {
        return opts.setReaction(key, kind, value);
      }).then(function (result) {
        state[field] = result[field];
        notify(key, { persisted: true, kind: kind, before: before, value: state[field] });
        return state[field];
      }, function (error) {
        state[field] = before;
        throw error;
      }).finally(function () {
        delete state.pending[kind];
        notify(key);
      });
      state.pending[kind] = request;
      notify(key);
      return request;
    }

    return {
      hydrate: hydrate,
      show: function (name) { notify(String(name || '')); },
      toggle: function (name, kind) { return set(name, kind); },
      ensureLike: function (name) { return set(name, 'like', true); },
    };
  }

  global.createFlowReactionsController = createFlowReactionsController;
})(window);
