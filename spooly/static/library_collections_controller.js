/* Library page: collection cards strip, each card deep-links into collection playback. */
(function () {
  'use strict';

  var section = document.getElementById('library-collections');
  var strip = document.getElementById('library-collections-strip');
  if (!section || !strip) return;

  var boot = window.__SPOOLY_LIBRARY_BOOT__ || {};
  if (String(boot.scope || 'all') !== 'all') return;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function badgeFor(item) {
    if (item.system === 'liked') return '<span class="collection-card-badge">❤ 点赞自动</span>';
    if (item.system === 'favorited') return '<span class="collection-card-badge">★ 收藏自动</span>';
    return '';
  }

  function cardHtml(item) {
    var tiles = (Array.isArray(item.preview_items) ? item.preview_items : [])
      .slice(0, 4)
      .map(function (preview) {
        return preview.thumb_url
          ? '<img src="' + escapeHtml(preview.thumb_url) + '" alt="" loading="lazy">'
          : '<span class="collection-card-tile-empty"></span>';
      })
      .join('');
    var href = '/flow?collection=' + encodeURIComponent(String(item.id || ''));
    return '<a class="collection-card" href="' + escapeHtml(href) + '" data-id="' + escapeHtml(item.id) + '">'
      + '<div class="collection-card-collage">' + tiles + '</div>'
      + '<div class="collection-card-copy">'
      + '<strong>' + escapeHtml(item.name || '未命名合集') + '</strong>'
      + badgeFor(item)
      + '<em>' + Number(item.item_count || 0) + ' 项</em>'
      + '</div></a>';
  }

  async function load() {
    try {
      var res = await fetch('/api/collections');
      var payload = await res.json();
      if (!res.ok || !(payload && payload.success)) throw new Error('load failed');
      var items = (payload.data && payload.data.items) || [];
      if (!items.length) {
        section.hidden = true;
        return;
      }
      strip.innerHTML = items.map(cardHtml).join('');
      section.hidden = false;
    } catch (error) {
      section.hidden = true;
    }
  }

  load();
})();
