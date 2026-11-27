/* Library page: manage the media sources (mounted folders) the library scans. */
(function () {
  'use strict';

  var dialog = document.getElementById('library-folders-dialog');
  var openBtn = document.getElementById('library-folders');
  if (!dialog || !openBtn) return;

  var list = document.getElementById('library-folders-list');
  var form = document.getElementById('library-folders-form');
  var formTitle = document.getElementById('library-folders-form-title');
  var pathInput = document.getElementById('library-folders-path');
  var nameInput = document.getElementById('library-folders-name');
  var excludeInput = document.getElementById('library-folders-exclude');
  var submitBtn = document.getElementById('library-folders-submit');
  var cancelBtn = document.getElementById('library-folders-cancel');
  var statusEl = document.getElementById('library-folders-status');
  var closeBtn = document.getElementById('library-folders-close');

  var editingId = null;
  var items = [];
  var reloadTimer = null;

  // --- private folders (module H): privacy markers + folder picker ---
  var privacyList = document.getElementById('library-privacy-list');
  var privacyAdd = document.getElementById('library-privacy-add');
  var privacyPicker = document.getElementById('library-privacy-picker');
  var privacyUp = document.getElementById('library-privacy-up');
  var privacyCrumbs = document.getElementById('library-privacy-crumbs');
  var privacyFolders = document.getElementById('library-privacy-folders');
  var privateItems = [];
  var pickerUri = null;

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showStatus(text, isError) {
    statusEl.textContent = text;
    if (isError) statusEl.setAttribute('data-tone', 'error');
    else statusEl.removeAttribute('data-tone');
    statusEl.hidden = !text;
  }

  function refreshLibrarySoon() {
    // The API already rescanned the index; reload so the grid shows the result.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () { window.location.reload(); }, 900);
  }

  async function request(url, options) {
    var res = await fetch(url, options || {});
    var payload = null;
    try {
      payload = await res.json();
    } catch (error) {
      payload = null;
    }
    if (!res.ok || !(payload && payload.success)) {
      throw new Error((payload && payload.error) || ('请求失败（HTTP ' + res.status + '）'));
    }
    return payload.data || {};
  }

  function render() {
    if (!items.length) {
      list.innerHTML = '<li class="library-folders-empty">还没有文件夹，请在下方添加。</li>';
      return;
    }
    list.innerHTML = items.map(function (item) {
      var meta = item.exists
        ? Number(item.media_count || 0) + ' 个媒体'
        : '路径不可用';
      if (Array.isArray(item.exclude) && item.exclude.length) {
        meta += ' · 排除 ' + item.exclude.length + ' 条规则';
      }
      if (isPrivateUri('@' + item.id + '/')) {
        meta += ' · 🔒 隐私';
      }
      return '<li class="library-folders-item' + (item.exists ? '' : ' is-missing') + '" data-id="' + escapeHtml(item.id) + '">'
        + '<div class="library-folders-item-main">'
        + '<strong>' + escapeHtml(item.name || item.id) + '</strong>'
        + '<code>' + escapeHtml(item.path) + '</code>'
        + '<span class="library-folders-item-meta">' + escapeHtml(meta) + '</span>'
        + '</div>'
        + '<div class="library-folders-item-actions">'
        + '<button type="button" class="library-management-button" data-action="edit">编辑</button>'
        + '<button type="button" class="library-management-button is-danger" data-action="delete">删除</button>'
        + '</div></li>';
    }).join('');
  }

  function entryFor(uri) {
    return String(uri || '').replace(/\/+$/, '');
  }

  function markerFor(uri) {
    var text = entryFor(uri);
    var found = privateItems.find(function (item) {
      var marker = entryFor(item.uri);
      return text === marker || text.indexOf(marker + '/') === 0;
    });
    return found ? entryFor(found.uri) : '';
  }

  function isPrivateUri(uri) {
    return !!markerFor(uri);
  }

  function renderPrivacy() {
    if (!privateItems.length) {
      privacyList.innerHTML = '<li class="library-privacy-empty">还没有隐私文件夹。隐私内容不会出现在信息流、媒体库网格和系统合集中。</li>';
      return;
    }
    privacyList.innerHTML = privateItems.map(function (item) {
      return '<li class="library-privacy-item" data-uri="' + escapeHtml(item.uri) + '">'
        + '<div class="library-privacy-item-main">'
        + '<strong>🔒 ' + escapeHtml(item.name || item.uri) + (item.is_source ? '（整个文件夹）' : '') + '</strong>'
        + '<code>' + escapeHtml(item.uri) + '</code>'
        + '</div>'
        + '<div class="library-privacy-item-actions">'
        + '<button type="button" class="library-management-button" data-privacy-action="play">播放</button>'
        + '<button type="button" class="library-management-button" data-privacy-action="remove">取消隐私</button>'
        + '</div></li>';
    }).join('');
  }

  function pickerRow(options) {
    var uri = String(options.uri || '');
    var marked = isPrivateUri(uri);
    return '<li class="library-privacy-row" data-uri="' + escapeHtml(uri) + '">'
      + '<div class="library-privacy-row-main">'
      + '<strong>' + (marked ? '🔒 ' : '') + escapeHtml(options.name || uri) + '</strong>'
      + (options.subtitle ? '<code>' + escapeHtml(options.subtitle) + '</code>' : '')
      + (options.count == null ? '' : '<span>' + Number(options.count) + ' 个媒体</span>')
      + '</div>'
      + '<div class="library-privacy-row-actions">'
      + '<button type="button" class="library-management-button" data-picker-action="play">播放</button>'
      + (options.canEnter ? '<button type="button" class="library-management-button" data-picker-action="enter">进入</button>' : '')
      + '<button type="button" class="library-management-button' + (marked ? '' : ' is-primary') + '" data-picker-action="toggle">'
      + (marked ? '取消隐私' : '设为隐私') + '</button>'
      + '</div></li>';
  }

  async function renderPicker() {
    privacyUp.hidden = !pickerUri;
    if (!pickerUri) {
      privacyCrumbs.textContent = '全部文件夹';
      privacyFolders.innerHTML = items.map(function (item) {
        return pickerRow({
          uri: '@' + item.id + '/',
          name: item.name || item.id,
          subtitle: item.path || '',
          count: item.media_count,
          canEnter: true,
        });
      }).join('') || '<li class="library-privacy-empty">还没有挂载文件夹。</li>';
      return;
    }
    privacyCrumbs.textContent = pickerUri;
    privacyFolders.innerHTML = '<li class="library-privacy-empty">正在加载文件夹…</li>';
    try {
      var data = await request('/api/folders?folder=' + encodeURIComponent(pickerUri) + '&limit=96');
      var rows = Array.isArray(data.items) ? data.items : [];
      privacyFolders.innerHTML = rows.map(function (node) {
        return pickerRow({
          uri: node.uri,
          name: node.name,
          count: node.media_count,
          canEnter: !!node.has_children,
        });
      }).join('') || '<li class="library-privacy-empty">该文件夹下没有子文件夹。</li>';
    } catch (error) {
      privacyFolders.innerHTML = '<li class="library-privacy-empty">' + escapeHtml(error.message) + '</li>';
    }
  }

  function parentUri(uri) {
    var rest = String(uri || '').slice(1);
    var slash = rest.indexOf('/');
    if (slash < 0) return null;
    var source = rest.slice(0, slash);
    var rel = rest.slice(slash + 1).replace(/\/+$/, '');
    if (!rel) return null;
    var cut = rel.lastIndexOf('/');
    return '@' + source + '/' + (cut < 0 ? '' : rel.slice(0, cut + 1));
  }

  async function savePrivate(folders) {
    try {
      var data = await request('/api/private-folders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: folders }),
      });
      privateItems = Array.isArray(data.items) ? data.items : [];
      renderPrivacy();
      render();
      if (!privacyPicker.hidden) await renderPicker();
      if (window.SpoolyLibraryPage && window.SpoolyLibraryPage.reload) window.SpoolyLibraryPage.reload();
      showStatus('隐私文件夹已更新。', false);
    } catch (error) {
      showStatus(error.message, true);
    }
  }

  async function loadPrivacy() {
    try {
      var data = await request('/api/private-folders');
      privateItems = Array.isArray(data.items) ? data.items : [];
      renderPrivacy();
      render();
      if (!privacyPicker.hidden) await renderPicker();
    } catch (error) {
      showStatus(error.message, true);
    }
  }

  async function load() {
    try {
      var data = await request('/api/media-sources');
      items = Array.isArray(data.items) ? data.items : [];
      render();
      await loadPrivacy();
    } catch (error) {
      showStatus(error.message, true);
    }
  }

  function startEdit(item) {
    editingId = String(item.id || '');
    formTitle.textContent = '编辑文件夹：' + (item.name || item.id);
    submitBtn.textContent = '保存修改';
    cancelBtn.hidden = false;
    pathInput.value = item.path || '';
    nameInput.value = item.name || '';
    excludeInput.value = (Array.isArray(item.exclude) ? item.exclude : []).join('\n');
    pathInput.focus();
  }

  function resetForm() {
    editingId = null;
    formTitle.textContent = '添加文件夹';
    submitBtn.textContent = '添加';
    cancelBtn.hidden = true;
    form.reset();
  }

  function formPayload() {
    var exclude = excludeInput.value
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
    return {
      path: pathInput.value.trim(),
      name: nameInput.value.trim(),
      exclude: exclude,
    };
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    var wasEditing = editingId;
    var body = formPayload();
    submitBtn.disabled = true;
    try {
      var data;
      if (wasEditing) {
        data = await request('/api/media-sources/' + encodeURIComponent(wasEditing), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        data = await request('/api/media-sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      items = Array.isArray(data.items) ? data.items : items;
      render();
      resetForm();
      showStatus(wasEditing ? '已保存修改，正在刷新媒体库…' : '已添加文件夹，正在扫描新内容…', false);
      refreshLibrarySoon();
    } catch (error) {
      showStatus(error.message, true);
    } finally {
      submitBtn.disabled = false;
    }
  });

  list.addEventListener('click', async function (event) {
    var button = event.target.closest('button[data-action]');
    if (!button) return;
    var row = button.closest('[data-id]');
    var id = row && row.getAttribute('data-id');
    if (!id) return;
    var item = items.find(function (entry) { return String(entry.id) === id; });
    if (!item) return;

    if (button.getAttribute('data-action') === 'edit') {
      startEdit(item);
      return;
    }
    if (!window.confirm('从媒体库移除「' + (item.name || item.id) + '」？\n仅取消挂载扫描，不会删除磁盘上的文件。')) return;
    button.disabled = true;
    try {
      var data = await request('/api/media-sources/' + encodeURIComponent(id), { method: 'DELETE' });
      items = Array.isArray(data.items) ? data.items : items;
      render();
      if (editingId === id) resetForm();
      showStatus('已移除文件夹，正在刷新媒体库…', false);
      refreshLibrarySoon();
    } catch (error) {
      showStatus(error.message, true);
      button.disabled = false;
    }
  });

  privacyAdd.addEventListener('click', function () {
    var open = privacyPicker.hidden;
    privacyPicker.hidden = !open;
    privacyAdd.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderPicker();
  });

  privacyUp.addEventListener('click', function () {
    pickerUri = parentUri(pickerUri);
    renderPicker();
  });

  privacyList.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-privacy-action]');
    if (!button) return;
    var row = button.closest('[data-uri]');
    var uri = row && row.getAttribute('data-uri');
    if (!uri) return;
    if (button.getAttribute('data-privacy-action') === 'play') {
      window.location.assign('/flow?folder=' + encodeURIComponent(uri));
      return;
    }
    savePrivate(privateItems
      .filter(function (item) { return entryFor(item.uri) !== entryFor(uri); })
      .map(function (item) { return item.uri; }));
  });

  privacyFolders.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-picker-action]');
    if (!button) return;
    var row = button.closest('[data-uri]');
    var uri = row && row.getAttribute('data-uri');
    if (!uri) return;
    var action = button.getAttribute('data-picker-action');
    if (action === 'play') {
      window.location.assign('/flow?folder=' + encodeURIComponent(uri));
      return;
    }
    if (action === 'enter') {
      pickerUri = uri;
      renderPicker();
      return;
    }
    var existing = markerFor(uri);
    if (existing) {
      savePrivate(privateItems
        .filter(function (item) { return entryFor(item.uri) !== existing; })
        .map(function (item) { return item.uri; }));
    } else {
      savePrivate(privateItems
        .map(function (item) { return item.uri; })
        .concat([entryFor(uri)]));
    }
  });

  cancelBtn.addEventListener('click', function () { resetForm(); });
  closeBtn.addEventListener('click', function () { dialog.close(); });

  openBtn.addEventListener('click', function () {
    showStatus('', false);
    dialog.showModal();
    load();
  });
})();
