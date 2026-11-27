(() => {
  'use strict';

  const importButton = document.getElementById('library-import');
  const fileInput = document.getElementById('library-import-files');
  const syncButton = document.getElementById('library-sync');
  const trashButton = document.getElementById('library-trash');
  const feedback = document.getElementById('library-management-feedback');
  const results = document.getElementById('library-import-results');
  const resultSummary = document.getElementById('library-import-summary');
  const resultList = document.getElementById('library-import-list');
  const deleteDialog = document.getElementById('library-delete-dialog');
  const deleteName = document.getElementById('library-delete-name');
  const deleteError = document.getElementById('library-delete-error');
  const deleteConfirm = document.getElementById('library-delete-confirm');
  const deleteCancel = document.getElementById('library-delete-cancel');
  const trashDialog = document.getElementById('library-trash-dialog');
  const trashList = document.getElementById('library-trash-list');
  const trashStatus = document.getElementById('library-trash-status');
  const trashRetry = document.getElementById('library-trash-retry');
  const trashSelectAll = document.getElementById('library-trash-select-all');
  const trashRestoreSelected = document.getElementById('library-trash-restore-selected');
  const trashEmpty = document.getElementById('library-trash-empty');
  if (!importButton || !fileInput || !deleteDialog || !trashDialog) return;

  let busy = false;
  let pendingDelete = null;
  let deleting = false;
  let trashRequest = 0;
  const previousFocus = new WeakMap();
  // Module L2: multi-select restore / clear the trash.
  const trashSelected = new Set();
  let emptyArmed = false;
  let emptyArmTimer = null;

  function syncTrashToolbar() {
    if (trashRestoreSelected) trashRestoreSelected.disabled = trashSelected.size === 0;
    if (trashSelectAll) trashSelectAll.textContent = trashSelected.size ? '取消全选' : '全选';
    if (trashEmpty) trashEmpty.textContent = emptyArmed ? '确认清空？' : '清空回收站';
  }

  function disarmEmpty() {
    emptyArmed = false;
    clearTimeout(emptyArmTimer);
    emptyArmTimer = null;
    syncTrashToolbar();
  }

  function chineseError(message, fallback) {
    const text = String(message || '').trim();
    return /[\u3400-\u9fff]/.test(text) ? text : fallback;
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(response.status === 413 ? '选择的文件总量超过服务器限制，请分批导入。' : '服务器未返回有效结果，请刷新页面后重试。');
    }
    if (!response.ok || payload?.success === false || payload?.error) {
      const fallback = response.status === 401 || response.status === 403
        ? '登录状态已失效或无权操作，请刷新页面并重新登录。'
        : response.status === 413 ? '文件数量或大小超过服务器限制，请减少文件后重试。'
          : '操作失败，请检查连接后重试。';
      throw new Error(chineseError(payload?.error, fallback));
    }
    return payload;
  }

  function notify(message, tone = 'info') {
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = false;
  }

  function setBusy(value) {
    busy = value;
    importButton.disabled = value;
    fileInput.disabled = value;
    syncButton.disabled = value;
    document.querySelector('.library-management-tools')?.setAttribute('aria-busy', String(value));
  }

  function openDialog(dialog) {
    if (dialog.open) return;
    previousFocus.set(dialog, document.activeElement);
    dialog.showModal();
  }

  function closeDialog(dialog) {
    dialog.close();
  }

  [deleteDialog, trashDialog].forEach((dialog) => {
    dialog.addEventListener('close', () => {
      const element = previousFocus.get(dialog);
      if (element?.isConnected) element.focus({ preventScroll: true });
      else trashButton.focus({ preventScroll: true });
    });
  });

  async function reloadLibrary() {
    if (window.SpoolyLibraryPage?.reload) await window.SpoolyLibraryPage.reload();
  }

  function renderImportItems(items) {
    resultList.replaceChildren();
    items.forEach((item) => {
      const row = document.createElement('li');
      row.className = item.pending ? 'is-pending' : item.success ? 'is-success' : 'is-error';
      const name = document.createElement('span');
      name.className = 'library-import-name';
      name.textContent = String(item.original_name || item.name || '未命名文件');
      const state = document.createElement('span');
      if (item.pending) state.textContent = '正在处理…';
      else if (item.success) state.textContent = item.name && item.name !== item.original_name ? `已导入为 ${item.name}` : '导入成功';
      else state.textContent = chineseError(item.error, '导入失败，请确认文件格式、大小和目录权限。');
      row.append(name, state);
      resultList.appendChild(row);
    });
    results.hidden = false;
  }

  importButton.addEventListener('click', () => {
    if (!busy) fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []);
    if (busy || !files.length) return;
    setBusy(true);
    notify(`正在导入 ${files.length} 个文件，请保留此页面，等待处理完成…`);
    resultSummary.textContent = `正在导入 ${files.length} 个文件`;
    renderImportItems(files.map((file) => ({ original_name: file.name, pending: true })));
    results.open = true;
    try {
      const form = new FormData();
      files.forEach((file) => form.append('files', file));
      const response = await request('/api/library/import', { method: 'POST', body: form });
      const data = response.data || {};
      const items = Array.isArray(data.items) ? data.items : [];
      if (!items.length) throw new Error('服务器未返回逐文件结果，请重新扫描媒体库确认导入状态。');
      renderImportItems(items);
      const imported = Number(data.imported ?? items.filter((item) => item.success).length);
      const failed = Number(data.failed ?? items.filter((item) => !item.success).length);
      const summary = `导入完成：成功 ${imported} 个，失败 ${failed} 个。`;
      resultSummary.textContent = summary;
      notify(summary, failed ? 'warning' : 'success');
      results.open = failed > 0;
      if (imported > 0) await reloadLibrary();
    } catch (error) {
      const message = chineseError(error.message, '导入失败，请检查网络连接后重试。');
      notify(message, 'error');
      resultSummary.textContent = '导入未完成';
      renderImportItems(files.map((file) => ({ original_name: file.name, success: false, error: message })));
    } finally {
      fileInput.value = '';
      setBusy(false);
    }
  });

  syncButton.addEventListener('click', async () => {
    if (busy) return;
    setBusy(true);
    syncButton.querySelector('span').textContent = '正在扫描…';
    notify('正在重新扫描媒体目录，请稍候…');
    try {
      await request('/api/library/sync', { method: 'POST' });
      await reloadLibrary();
      notify('重新扫描完成，媒体库已更新。', 'success');
    } catch (error) {
      notify(chineseError(error.message, '重新扫描失败，请稍后重试。'), 'error');
    } finally {
      syncButton.querySelector('span').textContent = '重新扫描';
      setBusy(false);
    }
  });

  document.addEventListener('library:delete-request', (event) => {
    if (deleting || !event.detail?.item?.name) return;
    pendingDelete = event.detail.item;
    deleteName.textContent = String(pendingDelete.name).split('/').pop();
    deleteError.hidden = true;
    deleteConfirm.disabled = false;
    deleteConfirm.textContent = '移到回收站';
    const video = document.getElementById('quick-video');
    if (video && !video.paused) video.pause();
    openDialog(deleteDialog);
    deleteCancel.focus();
  });

  deleteCancel.addEventListener('click', () => { if (!deleting) closeDialog(deleteDialog); });
  deleteDialog.addEventListener('cancel', (event) => { if (deleting) event.preventDefault(); });
  deleteConfirm.addEventListener('click', async () => {
    if (deleting || !pendingDelete?.name) return;
    const item = pendingDelete;
    deleting = true;
    deleteConfirm.disabled = true;
    deleteCancel.disabled = true;
    deleteConfirm.textContent = '正在移动…';
    deleteError.hidden = true;
    try {
      const path = String(item.name).split('/').map(encodeURIComponent).join('/');
      await request(`/delete/${path}`, { method: 'POST' });
      closeDialog(deleteDialog);
      pendingDelete = null;
      await reloadLibrary();
      notify('已移到回收站；如需撤销，请打开回收站恢复。', 'success');
    } catch (error) {
      deleteError.textContent = chineseError(error.message, '移动失败，请稍后重试。');
      deleteError.hidden = false;
    } finally {
      deleting = false;
      deleteConfirm.disabled = false;
      deleteCancel.disabled = false;
      deleteConfirm.textContent = '移到回收站';
    }
  });

  async function loadTrash() {
    const requestId = ++trashRequest;
    trashSelected.clear();
    disarmEmpty();
    syncTrashToolbar();
    trashStatus.textContent = '正在加载回收站…';
    trashRetry.hidden = true;
    trashList.setAttribute('aria-busy', 'true');
    try {
      const payload = await request('/api/trash');
      if (requestId !== trashRequest) return;
      const items = Array.isArray(payload.items) ? payload.items : [];
      trashList.replaceChildren();
      items.forEach((item) => {
        const row = document.createElement('li');
        row.dataset.trashId = item.id;
        const copy = document.createElement('div');
        const name = document.createElement('strong');
        const rawName = String(item.name || item.uri || '未命名资源');
        name.textContent = window.SpoolyCaption ? window.SpoolyCaption.display(rawName) : rawName;
        name.title = rawName;
        const description = document.createElement('span');
        description.textContent = '恢复到原媒体目录';
        copy.append(name, description);
        const restore = document.createElement('button');
        restore.className = 'library-management-button';
        restore.type = 'button';
        restore.textContent = '恢复';
        restore.setAttribute('aria-label', `恢复“${name.textContent}”`);
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          restore.textContent = '正在恢复…';
          try {
            await request(`/api/trash/${encodeURIComponent(item.id)}/restore`, { method: 'POST' });
            await reloadLibrary();
            await loadTrash();
            trashStatus.textContent = `已恢复“${name.textContent}”。`;
            notify('资源已恢复，媒体库已更新。', 'success');
          } catch (error) {
            trashStatus.textContent = chineseError(error.message, '恢复失败，请稍后重试。');
            restore.disabled = false;
            restore.textContent = '重试恢复';
          }
        });
        const select = document.createElement('button');
        select.className = 'library-management-button trash-select';
        select.type = 'button';
        const syncSelect = () => {
          const on = trashSelected.has(item.id);
          select.textContent = on ? '✓ 已选' : '选择';
          select.setAttribute('aria-pressed', on ? 'true' : 'false');
          row.classList.toggle('is-selected', on);
        };
        syncSelect();
        select.addEventListener('click', () => {
          if (trashSelected.has(item.id)) trashSelected.delete(item.id);
          else trashSelected.add(item.id);
          syncSelect();
          syncTrashToolbar();
        });
        row.append(select, copy, restore);
        trashList.appendChild(row);
      });
      syncTrashToolbar();
      trashStatus.textContent = items.length ? `回收站共 ${items.length} 个资源。` : '回收站是空的。';
    } catch (error) {
      if (requestId !== trashRequest) return;
      trashStatus.textContent = chineseError(error.message, '回收站加载失败，请稍后重试。');
      trashRetry.hidden = false;
    } finally {
      if (requestId === trashRequest) trashList.removeAttribute('aria-busy');
    }
  }

  trashButton.addEventListener('click', () => { openDialog(trashDialog); loadTrash(); });
  document.getElementById('library-trash-close').addEventListener('click', () => closeDialog(trashDialog));
  trashRetry.addEventListener('click', loadTrash);

  if (trashSelectAll) {
    trashSelectAll.addEventListener('click', () => {
      const ids = Array.from(trashList.querySelectorAll('[data-trash-id]')).map((row) => row.dataset.trashId);
      if (!ids.length) return;
      if (trashSelected.size) trashSelected.clear();
      else ids.forEach((id) => trashSelected.add(id));
      loadTrashRowsState();
    });
  }

  function loadTrashRowsState() {
    trashList.querySelectorAll('li[data-trash-id]').forEach((row) => {
      const on = trashSelected.has(row.dataset.trashId);
      row.classList.toggle('is-selected', on);
      const select = row.querySelector('.trash-select');
      if (select) {
        select.textContent = on ? '✓ 已选' : '选择';
        select.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    });
    syncTrashToolbar();
  }

  if (trashRestoreSelected) {
    trashRestoreSelected.addEventListener('click', async () => {
      const ids = Array.from(trashSelected);
      if (!ids.length || busy) return;
      busy = true;
      trashRestoreSelected.disabled = true;
      trashStatus.textContent = '正在恢复所选…';
      try {
        const results = [];
        for (let offset = 0; offset < ids.length; offset += 200) {
          const payload = await request('/api/trash/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restore', ids: ids.slice(offset, offset + 200) }),
          });
          results.push(...(Array.isArray(payload.results) ? payload.results : []));
        }
        const failed = results.filter((item) => !item.success);
        failed.forEach((item) => trashSelected.delete(item.id));
        const ok = results.length - failed.length;
        if (failed.length) {
          const sample = failed.slice(0, 3).map((item) => item.id).join('、');
          notify(`已恢复 ${ok} 项，失败 ${failed.length} 项（${sample}${failed.length > 3 ? ' 等' : ''}）。`, 'warning');
        } else {
          notify(`已恢复 ${ok} 项，媒体库已更新。`, 'success');
        }
        await reloadLibrary();
        await loadTrash();
      } catch (error) {
        trashStatus.textContent = chineseError(error.message, '批量恢复失败，请稍后重试。');
      } finally {
        busy = false;
        syncTrashToolbar();
      }
    });
  }

  if (trashEmpty) {
    trashEmpty.addEventListener('click', async () => {
      if (busy) return;
      if (!emptyArmed) {
        emptyArmed = true;
        syncTrashToolbar();
        emptyArmTimer = setTimeout(disarmEmpty, 5000);
        return;
      }
      disarmEmpty();
      busy = true;
      trashEmpty.disabled = true;
      trashStatus.textContent = '正在清空回收站…';
      try {
        const payload = await request('/api/trash', { method: 'DELETE' });
        notify(`回收站已清空，永久删除 ${Number(payload.purged) || 0} 项。`, 'success');
        await reloadLibrary();
        await loadTrash();
      } catch (error) {
        trashStatus.textContent = chineseError(error.message, '清空回收站失败，请稍后重试。');
      } finally {
        busy = false;
        trashEmpty.disabled = false;
        syncTrashToolbar();
      }
    });
  }
})();
