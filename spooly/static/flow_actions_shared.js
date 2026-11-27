(function (global) {
  'use strict';

  function encodeName(name) {
    return encodeURIComponent(String(name || ''));
  }

  async function readJsonResponse(response) {
    try {
      return await response.json();
    } catch (error) {
      return null;
    }
  }

  async function getFavoriteState(name) {
    var encoded = encodeName(name);
    if (!encoded) return false;
    var response = await fetch('/api/favorite/' + encoded);
    var data = await readJsonResponse(response);
    if (!response.ok || !data || typeof data.favorite !== 'boolean') {
      throw new Error((data && data.error) || '无法更新收藏状态，请重试。');
    }
    return data.favorite;
  }

  async function toggleFavorite(name) {
    var encoded = encodeName(name);
    if (!encoded) return false;
    var response = await fetch('/api/favorite/' + encoded, { method: 'POST' });
    var data = await readJsonResponse(response);
    if (!response.ok || !data || typeof data.favorite !== 'boolean') {
      throw new Error((data && data.error) || '无法更新收藏状态，请重试。');
    }
    return data.favorite;
  }

  async function setMediaReaction(name, kind, state) {
    if (!name || !['like', 'favorite'].includes(kind)) throw new Error('互动操作无效');
    var response = await fetch('/api/media/' + encodeName(name) + '/' + kind, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: state }),
    });
    var data = await readJsonResponse(response);
    var field = kind === 'like' ? 'is_liked' : 'is_favorited';
    if (!response.ok || !data || !data.success || typeof data.data?.[field] !== 'boolean') {
      throw new Error((data && data.error) || '状态未保存，请重试');
    }
    return data.data;
  }

  async function getSourceMeta(name) {
    return null;
  }

  async function getImageMetadata(uri) {
    var encoded = encodeName(uri);
    if (!encoded) return { success: false, error: '缺少媒体标识' };
    var response = await fetch('/api/image/metadata?uri=' + encoded);
    var data = await readJsonResponse(response);
    if (!response.ok || !data || !data.success) throw new Error((data && data.error) || '标题请求失败');
    return data;
  }

  async function generateImageMetadata(uri, options) {
    var conf = options || {};
    if (!uri) return { success: false, error: '缺少媒体标识' };
    var response = await fetch('/api/image/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: uri, force: conf.force !== false, prompt_override: conf.promptOverride }),
    });
    var data = await readJsonResponse(response);
    if (!response.ok || !data || !data.success) throw new Error((data && data.error) || '标题请求失败');
    return data;
  }

  global.FlowActionsShared = {
    getFavoriteState: getFavoriteState,
    toggleFavorite: toggleFavorite,
    setMediaReaction: setMediaReaction,
    getSourceMeta: getSourceMeta,
    getImageMetadata: getImageMetadata,
    generateImageMetadata: generateImageMetadata,
  };
})(window);
