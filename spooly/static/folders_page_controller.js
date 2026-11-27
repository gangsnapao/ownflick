(function () {
  'use strict';

  const grid = document.getElementById('folder-grid');
  const state = document.getElementById('folder-page-state');
  const breadcrumbs = document.getElementById('folder-breadcrumbs');
  const playCurrent = document.getElementById('folder-play-current');
  const recursiveInput = document.getElementById('folder-recursive');
  const moreButton = document.getElementById('folder-more');
  const orderButtons = Array.from(document.querySelectorAll('[data-order]'));
  const params = new URLSearchParams(window.location.search);
  let currentFolder = params.get('folder') || '';
  let currentFolderData = null;
  let order = 'sequential';
  let offset = 0;
  let hasMore = false;
  let requestId = 0;
  let busy = false;
  const limit = 24;

  function setState(message, kind) {
    state.textContent = message || '';
    state.dataset.kind = kind || '';
  }

  function folderUrl(folder) {
    const url = new URL('/folders', window.location.origin);
    if (folder) url.searchParams.set('folder', folder);
    return url.pathname + url.search;
  }

  function playbackUrl(folder) {
    const url = new URL('/flow', window.location.origin);
    url.searchParams.set('folder', folder);
    url.searchParams.set('recursive', recursiveInput.checked ? 'true' : 'false');
    url.searchParams.set('order', order);
    return url.pathname + url.search;
  }

  function buildBreadcrumbs(current) {
    breadcrumbs.replaceChildren();
    const root = document.createElement('a');
    root.href = '/folders';
    root.textContent = '所有来源';
    breadcrumbs.appendChild(root);
    if (!current) return;

    const sourceId = String(current.source_id || '');
    const parts = String(current.path || '').split('/').filter(Boolean);
    const source = document.createElement('a');
    source.href = folderUrl(`@${sourceId}/`);
    source.textContent = sourceId || '媒体来源';
    breadcrumbs.appendChild(source);
    let path = '';
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      const separator = document.createElement('span');
      separator.className = 'folder-crumb-separator';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '/';
      breadcrumbs.appendChild(separator);
      if (index === parts.length - 1) {
        const label = document.createElement('span');
        label.setAttribute('aria-current', 'location');
        label.textContent = part;
        breadcrumbs.appendChild(label);
      } else {
        const link = document.createElement('a');
        link.href = folderUrl(`@${sourceId}/${path}`);
        link.textContent = part;
        breadcrumbs.appendChild(link);
      }
    });
    if (!parts.length) {
      const label = document.createElement('span');
      label.setAttribute('aria-current', 'location');
      label.textContent = String(current.name || sourceId || '来源');
      breadcrumbs.appendChild(label);
    }
  }

  function mediaSummary(folder) {
    return `${Number(folder.video_count) || 0} 个视频 · ${Number(folder.image_count) || 0} 张图片`;
  }

  function playCount(folder) {
    return Number(recursiveInput.checked ? folder.media_count : folder.direct_media_count) || 0;
  }

  function updatePlayButtons() {
    if (currentFolderData) {
      playCurrent.disabled = playCount(currentFolderData) <= 0;
      const label = playCurrent.querySelector('span');
      if (label) label.textContent = `播放此文件夹 · ${playCount(currentFolderData)}`;
    }
    grid.querySelectorAll('.folder-card').forEach((card) => {
      const count = Number(recursiveInput.checked ? card.dataset.mediaCount : card.dataset.directMediaCount) || 0;
      const button = card.querySelector('.folder-card-play');
      if (button) button.disabled = count <= 0;
    });
  }

  function makeFolderCard(folder) {
    const article = document.createElement('article');
    article.className = 'folder-card';
    article.dataset.mediaCount = String(Number(folder.media_count) || 0);
    article.dataset.directMediaCount = String(Number(folder.direct_media_count) || 0);
    const link = document.createElement('a');
    link.className = 'folder-card-open';
    link.href = folderUrl(String(folder.uri || ''));
    link.setAttribute('aria-label', `打开文件夹 ${String(folder.name || '')}`);

    const cover = document.createElement('div');
    cover.className = 'folder-card-cover';
    if (folder.thumb_url) {
      const image = document.createElement('img');
      image.src = String(folder.thumb_url);
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      cover.appendChild(image);
    } else {
      const icon = document.createElement('i');
      icon.dataset.feather = 'folder';
      icon.setAttribute('aria-hidden', 'true');
      cover.appendChild(icon);
    }

    const copy = document.createElement('span');
    copy.className = 'folder-card-copy';
    const title = document.createElement('strong');
    title.textContent = String(folder.name || '未命名文件夹');
    const summary = document.createElement('span');
    summary.textContent = mediaSummary(folder);
    const direct = document.createElement('span');
    direct.className = 'folder-direct-count';
    direct.textContent = `本级 ${Number(folder.direct_media_count) || 0} 项 · 共 ${Number(folder.media_count) || 0} 项`;
    copy.append(title, summary, direct);
    link.append(cover, copy);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'folder-card-play';
    play.disabled = playCount(folder) <= 0;
    play.setAttribute('aria-label', `播放文件夹 ${String(folder.name || '')}`);
    play.title = '播放此文件夹';
    const playIcon = document.createElement('i');
    playIcon.dataset.feather = 'play';
    playIcon.setAttribute('aria-hidden', 'true');
    play.appendChild(playIcon);
    play.addEventListener('click', () => {
      if (!play.disabled) window.location.assign(playbackUrl(String(folder.uri || '')));
    });
    article.append(link, play);
    return article;
  }

  async function loadPage({ append = false } = {}) {
    if (busy) return;
    busy = true;
    const id = ++requestId;
    moreButton.disabled = true;
    moreButton.textContent = '加载中…';
    if (!append) {
      offset = 0;
      hasMore = false;
      grid.replaceChildren();
      setState('正在读取文件夹…', 'loading');
      playCurrent.disabled = true;
    }
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (currentFolder) query.set('folder', currentFolder);
    try {
      const response = await fetch(`/api/folders?${query.toString()}`);
      const payload = await response.json();
      if (id !== requestId) return;
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error || '读取失败');
      const data = payload.data;
      if (!append) {
        buildBreadcrumbs(data.current);
        const current = data.current;
        currentFolderData = current;
        playCurrent.dataset.folder = current ? String(current.uri || '') : '';
        playCurrent.disabled = !current || playCount(current) <= 0;
        const label = playCurrent.querySelector('span');
        if (label) label.textContent = current ? `播放此文件夹 · ${playCount(current)}` : '选择文件夹开始播放';
      }
      (Array.isArray(data.items) ? data.items : []).forEach((folder) => grid.appendChild(makeFolderCard(folder)));
      updatePlayButtons();
      offset = Number(data.next_offset) || (offset + (data.items || []).length);
      hasMore = data.has_more === true;
      setState(Number(data.total) ? '' : (currentFolder ? '此目录没有可浏览的子文件夹。可播放当前目录的媒体。' : '索引中还没有可浏览的文件夹。'), Number(data.total) ? '' : 'empty');
      moreButton.hidden = !hasMore;
      if (window.feather) window.feather.replace({ width: 18, height: 18 });
    } catch (error) {
      if (id !== requestId) return;
      setState('文件夹暂时无法加载，请重试。', 'error');
      moreButton.hidden = true;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'folder-retry';
      retry.textContent = '重试';
      retry.addEventListener('click', () => loadPage({ append }));
      state.appendChild(retry);
    } finally {
      if (id === requestId) {
        busy = false;
        moreButton.disabled = false;
        moreButton.textContent = '加载更多';
      }
    }
  }

  playCurrent.addEventListener('click', () => {
    const folder = String(playCurrent.dataset.folder || '');
    if (folder && !playCurrent.disabled) window.location.assign(playbackUrl(folder));
  });
  moreButton.addEventListener('click', () => loadPage({ append: true }));
  recursiveInput.addEventListener('change', () => {
    playCurrent.setAttribute('aria-label', recursiveInput.checked ? '播放当前文件夹及子文件夹' : '只播放当前文件夹');
    updatePlayButtons();
  });
  orderButtons.forEach((button) => button.addEventListener('click', () => {
    order = button.dataset.order === 'random' ? 'random' : 'sequential';
    orderButtons.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
  }));

  loadPage();
})();
