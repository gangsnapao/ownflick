(() => {
  'use strict';

  // Module G: multi-select batch management for the media library grid.
  const batchButton = document.getElementById('library-batch');
  const batchBar = document.getElementById('library-batch-bar');
  const countLabel = document.getElementById('library-batch-count');
  const selectAllButton = document.getElementById('library-batch-select-all');
  const invertButton = document.getElementById('library-batch-invert');
  const trashButton = document.getElementById('library-batch-trash');
  const purgeButton = document.getElementById('library-batch-purge');
  const exitButton = document.getElementById('library-batch-exit');
  const dialog = document.getElementById('library-batch-dialog');
  const dialogHeading = document.getElementById('library-batch-dialog-heading');
  const dialogText = document.getElementById('library-batch-dialog-text');
  const dialogWarning = document.getElementById('library-batch-dialog-warning');
  const dialogError = document.getElementById('library-batch-dialog-error');
  const dialogCancel = document.getElementById('library-batch-dialog-cancel');
  const dialogConfirm = document.getElementById('library-batch-dialog-confirm');
  const feedback = document.getElementById('library-management-feedback');
  // Module L1: batch add to a collection.
  const collectionButton = document.getElementById('library-batch-collection');
  const collectionDialog = document.getElementById('library-collection-dialog');
  const collectionList = document.getElementById('library-collection-list');
  const collectionText = document.getElementById('library-collection-text');
  const collectionNameInput = document.getElementById('library-collection-name');
  const collectionCreateButton = document.getElementById('library-collection-create');
  const collectionCloseButton = document.getElementById('library-collection-close');
  const collectionError = document.getElementById('library-collection-error');
  if (!batchButton || !batchBar || !dialog) return;

  const CHUNK_SIZE = 200;
  const selected = new Set();
  let active = false;
  let pendingAction = null;
  let submitting = false;

  function notify(message, tone = 'info') {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = false;
  }

  function tiles() {
    return Array.from(document.querySelectorAll('#library-grid .media-tile'));
  }

  function syncTile(tile) {
    if (!tile) return;
    const isOn = selected.has(tile.dataset.uri);
    tile.classList.toggle('is-selected', isOn);
    const box = tile.querySelector('.tile-select');
    if (box) box.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  }

  function syncCount() {
    const total = selected.size;
    countLabel.textContent = `已选 ${total} 项`;
    trashButton.disabled = total === 0 || submitting;
    purgeButton.disabled = total === 0 || submitting;
    if (collectionButton) collectionButton.disabled = total === 0 || submitting;
  }

  function setActive(next) {
    active = Boolean(next);
    document.body.classList.toggle('library-batch-mode', active);
    batchBar.hidden = !active;
    batchButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (!active) selected.clear();
    tiles().forEach(syncTile);
    syncCount();
  }

  function toggle(tile, uri) {
    if (!uri) return;
    if (selected.has(uri)) selected.delete(uri);
    else selected.add(uri);
    syncTile(tile);
    syncCount();
  }

  window.SpoolyLibraryBatch = {
    isActive: () => active,
    // Called when a tile is (re)built so late-loaded pages reflect the selection.
    syncTile,
  };

  document.addEventListener('library:batch-toggle', (event) => {
    if (!active) return;
    toggle(event.detail?.tile, event.detail?.item?.name);
  });

  document.addEventListener('library:batch-longpress', (event) => {
    const tile = event.detail?.tile;
    const uri = event.detail?.item?.name;
    if (!active) setActive(true);
    if (uri && !selected.has(uri)) toggle(tile, uri);
  });

  batchButton.addEventListener('click', () => setActive(!active));
  exitButton.addEventListener('click', () => setActive(false));

  selectAllButton.addEventListener('click', () => {
    tiles().forEach((tile) => {
      if (tile.dataset.uri) selected.add(tile.dataset.uri);
      syncTile(tile);
    });
    syncCount();
  });

  invertButton.addEventListener('click', () => {
    tiles().forEach((tile) => {
      const uri = tile.dataset.uri;
      if (!uri) return;
      if (selected.has(uri)) selected.delete(uri);
      else selected.add(uri);
      syncTile(tile);
    });
    syncCount();
  });

  function openConfirm(action) {
    if (!selected.size) return;
    pendingAction = action;
    dialogError.hidden = true;
    if (action === 'purge') {
      dialogHeading.textContent = '永久删除？';
      dialogText.textContent = `将永久删除选中的 ${selected.size} 个文件。`;
      dialogWarning.textContent = '此操作不可恢复：文件将从磁盘彻底删除，且无法从回收站找回。';
      dialogWarning.hidden = false;
      dialogConfirm.textContent = '永久删除';
    } else {
      dialogHeading.textContent = '移到回收站？';
      dialogText.textContent = `将选中的 ${selected.size} 个文件移到回收站。`;
      dialogWarning.textContent = '文件可在回收站中恢复，此操作不会永久删除文件。';
      dialogWarning.hidden = false;
      dialogConfirm.textContent = '移到回收站';
    }
    dialog.showModal();
    dialogCancel.focus();
  }

  function renderCollectionRows(items) {
    collectionList.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('li');
      empty.className = 'library-privacy-empty';
      empty.textContent = '还没有合集，在下方输入名称新建一个。';
      collectionList.append(empty);
      return;
    }
    items.forEach((item) => {
      const row = document.createElement('li');
      row.className = 'library-privacy-item';
      const main = document.createElement('div');
      main.className = 'library-privacy-item-main';
      const name = document.createElement('strong');
      name.textContent = String(item.name || '未命名合集');
      const meta = document.createElement('code');
      meta.textContent = `${Number(item.item_count || 0)} 项`;
      main.append(name, meta);
      const add = document.createElement('button');
      add.className = 'library-management-button';
      add.type = 'button';
      add.textContent = '加入';
      add.addEventListener('click', () => addSelectedToCollection(item.id, item.name));
      row.append(main, add);
      collectionList.append(row);
    });
  }

  async function addSelectedToCollection(collectionId, collectionName) {
    if (!selected.size) return;
    try {
      await request(`/api/collections/${encodeURIComponent(collectionId)}/items`, {
        method: 'POST',
        body: JSON.stringify({ uris: Array.from(selected) }),
      });
      collectionDialog.close();
      notify(`已把 ${selected.size} 个文件加入合集「${collectionName}」。`, 'success');
    } catch (error) {
      collectionError.textContent = String(error.message || '加入合集失败，请稍后重试。');
      collectionError.hidden = false;
    }
  }

  async function openCollectionDialog() {
    if (!selected.size) return;
    collectionError.hidden = true;
    collectionText.textContent = `把选中的 ${selected.size} 个文件加入合集。`;
    collectionList.innerHTML = '<li class="library-privacy-empty">正在加载合集…</li>';
    collectionDialog.showModal();
    try {
      const payload = await request('/api/collections');
      const items = (payload.data?.items || []).filter((item) => !item.system);
      renderCollectionRows(items);
    } catch (error) {
      collectionList.innerHTML = '';
      collectionError.textContent = String(error.message || '合集加载失败，请稍后重试。');
      collectionError.hidden = false;
    }
  }

  if (collectionButton) collectionButton.addEventListener('click', openCollectionDialog);
  if (collectionCloseButton) collectionCloseButton.addEventListener('click', () => collectionDialog.close());
  if (collectionCreateButton) {
    collectionCreateButton.addEventListener('click', async () => {
      const name = collectionNameInput.value.trim();
      if (!name || submitting) return;
      submitting = true;
      collectionCreateButton.disabled = true;
      collectionError.hidden = true;
      try {
        const created = await request('/api/collections', {
          method: 'POST',
          body: JSON.stringify({ name }),
        });
        const item = created.data?.item;
        collectionNameInput.value = '';
        await addSelectedToCollection(item.id, item.name);
      } catch (error) {
        collectionError.textContent = String(error.message || '新建合集失败，请稍后重试。');
        collectionError.hidden = false;
      } finally {
        submitting = false;
        collectionCreateButton.disabled = false;
        syncCount();
      }
    });
  }

  trashButton.addEventListener('click', () => openConfirm('trash'));
  purgeButton.addEventListener('click', () => openConfirm('purge'));
  dialogCancel.addEventListener('click', () => {
    if (!submitting) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (submitting) event.preventDefault();
  });

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('服务器未返回有效结果，请刷新页面后重试。');
    }
    if (!response.ok || payload?.error) {
      const text = String(payload?.error || '').trim();
      throw new Error(/[\u3400-\u9fff]/.test(text) ? text : '操作失败，请检查网络连接后重试。');
    }
    return payload;
  }

  dialogConfirm.addEventListener('click', async () => {
    if (submitting || !pendingAction || !selected.size) return;
    const action = pendingAction;
    const uris = Array.from(selected);
    submitting = true;
    dialogConfirm.disabled = true;
    dialogCancel.disabled = true;
    dialogConfirm.textContent = action === 'purge' ? '正在删除…' : '正在移动…';
    dialogError.hidden = true;
    const results = [];
    try {
      // G2: chunk at 200 URIs per request and aggregate per-item results.
      for (let offset = 0; offset < uris.length; offset += CHUNK_SIZE) {
        const chunk = uris.slice(offset, offset + CHUNK_SIZE);
        const payload = await request('/api/media/batch', {
          method: 'POST',
          body: JSON.stringify({ action, uris: chunk }),
        });
        results.push(...(Array.isArray(payload.results) ? payload.results : []));
      }
      const failedItems = results.filter((item) => !item.success);
      const failedUris = new Set(failedItems.map((item) => item.uri));
      // Keep failed URIs selected for a retry; drop the successful ones.
      uris.forEach((uri) => { if (!failedUris.has(uri)) selected.delete(uri); });
      dialog.close();
      const successCount = results.length - failedItems.length;
      const verb = action === 'purge' ? '已永久删除' : '已移到回收站';
      if (failedItems.length) {
        const sample = failedItems.slice(0, 3).map((item) => String(item.uri).split('/').pop()).join('、');
        notify(`${verb} ${successCount} 项，失败 ${failedItems.length} 项（${sample}${failedItems.length > 3 ? ' 等' : ''}）。`, 'warning');
      } else {
        notify(`${verb} ${successCount} 项。`, 'success');
      }
      if (window.SpoolyLibraryPage?.reload) await window.SpoolyLibraryPage.reload();
      tiles().forEach(syncTile);
      syncCount();
      if (!selected.size) setActive(false);
    } catch (error) {
      dialogError.textContent = String(error.message || '操作失败，请稍后重试。');
      dialogError.hidden = false;
    } finally {
      submitting = false;
      dialogConfirm.disabled = false;
      dialogCancel.disabled = false;
      dialogConfirm.textContent = action === 'purge' ? '永久删除' : '移到回收站';
      syncCount();
    }
  });
})();
