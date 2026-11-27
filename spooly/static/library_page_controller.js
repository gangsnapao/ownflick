(() => {
  'use strict';
  const boot = window.__SPOOLY_LIBRARY_BOOT__ || {};
  delete window.__SPOOLY_LIBRARY_BOOT__;

  const scope = boot.scope;
  const collectionId = boot.collectionId;
  let collectionCoverUri = String(boot.collectionCoverUri || '');
  const pageSize = Number(boot.pageSize || 24);
  const initialItems = Array.isArray(boot.initialItems) ? boot.initialItems : [];
  const initialHasMore = !!boot.initialHasMore;
  const initialNextOffset = Number(boot.initialNextOffset || 0);
  const initialMode = String(boot.initialMode || 'all');
  const initialSeed = String(boot.initialSeed || '');
  const minMb = Number(boot.minMb || 0);
  const emptyMessage = String(boot.emptyMessage || '');
  const timelineMonth = String(boot.timelineMonth || '');
  const focusName = new URLSearchParams(window.location.search).get('focus') || '';
  let searchRequest = 0;
  let searchQuery = new URLSearchParams(window.location.search).get('q') || '';
  // Module L3：网格的文件夹筛选（如 @default/私密）。
  let folderFilter = new URLSearchParams(window.location.search).get('folder') || '';

  const grid = document.getElementById('library-grid');
  const statusText = document.getElementById('library-status-text');
  const statusActions = document.getElementById('library-status-actions');
  const retryButton = document.getElementById('library-retry');
  const clearSearchButton = document.getElementById('library-clear-search');
  const sentinel = document.getElementById('library-sentinel');
  const searchInput = document.getElementById('library-search-input');
  const searchClearButton = document.getElementById('library-search-clear');
  const searchToggleButton = document.getElementById('library-search-toggle');
  const libraryToolbar = document.getElementById('library-toolbar');
  const collectionIdentityCover = document.getElementById('collection-identity-cover');

  const quickView = document.getElementById('quick-view');
  const quickOverlay = document.getElementById('quick-overlay');
  const quickVideo = document.getElementById('quick-video');
  const quickImage = document.getElementById('quick-image');
  const quickPlayStatus = document.getElementById('quick-play-status');
  const quickPlayIcon = document.getElementById('quick-play-icon');
  const quickCloseTop = document.getElementById('quick-close-top');
  const quickCounter = document.getElementById('quick-counter');
  const quickControls = document.getElementById('quick-controls');
  const quickProgress = document.getElementById('quick-progress');
  const quickProgressFill = document.getElementById('quick-progress-fill');
  const quickTimeCurrent = document.getElementById('quick-time-current');
  const quickTimeTotal = document.getElementById('quick-time-total');
  const quickProgressPreview = document.getElementById('quick-progress-preview');
  const quickCleanBtn = document.getElementById('quick-clean-btn');
  const quickCleanExit = document.getElementById('quick-clean-exit');
  const quickActions = quickView.querySelector('.quick-actions');

  const quickSpeed = document.getElementById('quick-speed');
  const quickCaption = document.getElementById('quick-caption');
  const quickMagnifierToolWrap = document.getElementById('quick-magnifier-tool-wrap');
  const quickCaptionPanel = document.getElementById('quick-caption-panel');
  const quickCaptionTitle = document.getElementById('quick-caption-title');
  const quickCaptionTags = document.getElementById('quick-caption-tags');
  const uiShared = window.FlowUIShared || {};
  const formatTime = uiShared.formatTime;
  const actionsShared = window.FlowActionsShared || {};

  const quickFavorite = document.getElementById('quick-favorite');
  const quickSetCover = document.getElementById('quick-set-cover');
  const quickSource = document.getElementById('quick-source');
  const quickDetail = document.getElementById('quick-detail');

  let mode = scope === 'all' ? initialMode : 'all';
  let seed = initialSeed || '';
  const flowSession = window.createFlowSession({
    initialItems,
    initialHasMore: !!initialHasMore,
    initialCursor: { offset: Number(initialNextOffset || 0) },
    keyOf: (item) => String(item?.name || ''),
  });
  const items = flowSession.items;
  let currentSpeedIndex = 1;
  let clickTimer = null;
  let lastClickTime = 0;
  let wheelLocked = false;
  let overlayGestureActive = false;
  let overlayPointer = null;
  let suppressTapUntil = 0;
  let quickProgressController = null;
  const cleanLayerState = new Map();
  let bodyOverflowBackup = '';
  let bodyScrollLocked = false;
  let focusHandled = false;
  let focusLoading = false;
  const speedOptions = [0.75, 1, 1.25, 1.5, 2];

  function makeRandomSeed() {
    if (window.crypto?.getRandomValues) {
      return Array.from(window.crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16).padStart(8, '0')).join('');
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const currentItem = () => flowSession.currentItem();
  const getCurrentIndex = () => flowSession.getIndex();

  const magnifier = uiShared.createMagnifier({
    lens: document.getElementById('quick-magnifier'),
    toggle: document.getElementById('quick-magnifier-toggle'),
    zoomOptions: document.getElementById('quick-zoom-options'),
    badge: document.getElementById('quick-mag-badge'),
    zoomButtons: document.querySelectorAll('.quick-zoom-btn'),
    activeClass: 'is-active',
    largeClass: 'quick-magnifier-large',
    settleTransition: 'transform 0.2s ease, width 0.2s ease, height 0.2s ease',
    setMagnifying: (enabled) => flowState.setMagnifying(enabled),
    target: () => {
      const type = currentItem()?.type;
      if (type === 'video') return { type, el: quickVideo };
      if (type === 'image') return { type, el: quickImage };
      return null;
    },
  });

  const flowState = window.createFlowStateController({
    getMediaType: () => currentItem()?.type || '',
    canMagnifyMedia: (mediaType) => mediaType === 'image' || mediaType === 'video',
    onImmersiveChange: renderCleanMode,
    onMagnifyingChange: (enabled) => magnifier.onStateChange(enabled),
  });

  // 清屏播放：这两个按钮此前未接线，点击无反应。
  quickCleanBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    flowState.setCleanMode(true);
  });
  quickCleanExit.addEventListener('click', (event) => {
    event.stopPropagation();
    flowState.setCleanMode(false);
  });

  // The management page has no collection UI; keep viewer callers safe.
  const collectionButton = document.getElementById('quick-collection');
  const collectionModal = document.getElementById('quick-collection-modal');
  const collections = collectionButton && collectionModal && window.SpoolyCollections?.createPicker
    ? window.SpoolyCollections.createPicker({
      button: collectionButton,
      countEl: document.getElementById('quick-collection-count'),
      modal: collectionModal,
      closeBtn: document.getElementById('quick-collection-close'),
      meta: document.getElementById('quick-collection-meta'),
      createBtn: document.getElementById('quick-collection-create-btn'),
      nameInput: document.getElementById('quick-collection-name'),
      list: document.getElementById('quick-collection-list'),
      itemClass: 'quick-collection-item',
      emptyClass: 'quick-collection-empty',
      currentUri: () => currentItem()?.name,
    })
    : { isOpen: () => false, close() {}, sync() {} };

  function clearPendingTap() {
    clearTimeout(clickTimer);
    clickTimer = null;
    lastClickTime = 0;
  }

  function renderCleanMode(enabled) {
    const clean = !!enabled;
    if (clean) {
      quickProgressController?.cancel();
      clearPendingTap();
    }
    quickView.classList.toggle('immersive', clean);
    document.body.classList.toggle('quick-clean-mode', clean);
    quickCleanBtn.setAttribute('aria-pressed', String(clean));
    quickCleanExit.hidden = !clean;
    const layers = [
      quickActions, quickCloseTop, quickCounter,
      quickCaptionPanel, quickPlayStatus, document.getElementById('quick-magnifier'),
      document.getElementById('quick-feedback'),
      ...document.querySelectorAll('.mobile-app-header, .floating-dock, #app-nav-menu'),
    ];
    layers.forEach((element) => {
      if (!element) return;
      if (clean) {
        if (!cleanLayerState.has(element)) {
          cleanLayerState.set(element, {
            inert: element.hasAttribute('inert'),
            ariaHidden: element.getAttribute('aria-hidden'),
          });
        }
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      } else if (cleanLayerState.has(element)) {
        const previous = cleanLayerState.get(element);
        element.toggleAttribute('inert', previous.inert);
        if (previous.ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', previous.ariaHidden);
      }
    });
    if (clean) quickCleanExit.focus({ preventScroll: true });
    else cleanLayerState.clear();
  }

  quickProgressController = window.createPlayerProgressController({
    input: quickProgress,
    controls: quickControls,
    fill: quickProgressFill,
    currentTime: quickTimeCurrent,
    totalTime: quickTimeTotal,
    preview: quickProgressPreview,
    getVideo: () => quickView.classList.contains('active') && currentItem()?.type === 'video'
      ? quickVideo : null,
    canStart: () => !collections.isOpen() && !overlayGestureActive
      && !magnifier.isActive(),
    onActiveChange: (active) => {
      quickView.classList.toggle('is-seeking', active);
      if (active) clearPendingTap();
    },
  });

  function canNavigateViewer() {
    return quickView.classList.contains('active') && !quickProgressController.isActive()
      && !collections.isOpen() && !magnifier.isActive();
  }

  function showPlayStatus(paused) {
    const isPaused = !!paused;
    quickPlayIcon.innerHTML = isPaused
      ? '<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>'
      : '<polygon points="5 3 19 12 5 21 5 3"></polygon>';
    quickPlayStatus.classList.add('visible');
    setTimeout(() => quickPlayStatus.classList.remove('visible'), 220);
  }

  const toggleUI = () => flowState.toggleCleanMode();

  function activeTab() {
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      const isActive = tab.dataset.mode === mode;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-pressed', String(isActive));
    });
  }

  function syncSearchUI() {
    const hasQuery = !!String(searchInput?.value || '').trim();
    libraryToolbar?.classList.toggle('is-searching', hasQuery);
    if (searchClearButton) searchClearButton.hidden = !hasQuery;
  }

  function setSearchOpen(open, { focus = false } = {}) {
    const isOpen = !searchToggleButton || !!open;
    libraryToolbar?.classList.toggle('is-search-open', isOpen);
    searchToggleButton?.setAttribute('aria-expanded', String(isOpen));
    if (isOpen && focus) requestAnimationFrame(() => searchInput?.focus());
  }

  function readLibraryStateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const nextMode = params.get('mode') || 'all';
    const allowed = new Set(['all', 'image_random', 'video_latest', 'big_files']);
    return {
      mode: allowed.has(nextMode) ? nextMode : 'all',
      seed: params.get('seed') || '',
      search: params.get('q') || '',
      folder: params.get('folder') || '',
    };
  }

  function syncLibraryUrl(replace = false) {
    if (scope !== 'all') return;
    const params = new URLSearchParams(window.location.search);
    params.delete('focus');
    if (mode === 'all') {
      params.delete('mode');
      params.delete('seed');
    } else {
      params.set('mode', mode);
      if (mode === 'image_random' && seed) params.set('seed', seed);
      else params.delete('seed');
    }
    if (mode === 'big_files' && minMb) params.set('min_mb', String(minMb));
    else params.delete('min_mb');
    if (searchQuery) params.set('q', searchQuery);
    else params.delete('q');
    if (folderFilter) params.set('folder', folderFilter);
    else params.delete('folder');
    const query = params.toString();
    const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    const method = replace ? 'replaceState' : 'pushState';
    window.history[method]({ mode, seed }, '', nextUrl);
  }

  function getTileAspectRatio(item) {
    const width = Number(item?.width || 0);
    const height = Number(item?.height || 0);
    if (width > 0 && height > 0) {
      return `${width} / ${height}`;
    }
    return item?.type === 'video' ? '16 / 9' : '4 / 5';
  }

  function getTileHeightRatio(item) {
    const width = Number(item?.width || 0);
    const height = Number(item?.height || 0);
    if (width > 0 && height > 0) {
      return height / width;
    }
    return item?.type === 'video' ? (9 / 16) : (5 / 4);
  }

  const waterfall = {
    count: 0,
    gap: 8,
    gridWidth: 0,
    columnWidth: 0,
    columns: [],
    heights: [],
  };
  let relayoutTimer = null;

  function getWaterfallColumnCount() {
    const width = window.innerWidth;
    if (width >= 1536) return 5;
    if (width >= 1100) return 4;
    if (width >= 768) return 3;
    return 2;
  }

  function getWaterfallGap() {
    return window.innerWidth >= 768 ? 10 : 8;
  }

  function updateWaterfallMetrics() {
    const count = Math.max(1, waterfall.count || getWaterfallColumnCount());
    const gap = getWaterfallGap();
    const gridWidth = Math.max(1, grid.clientWidth || window.innerWidth);
    waterfall.gap = gap;
    waterfall.gridWidth = gridWidth;
    waterfall.columnWidth = Math.max(1, (gridWidth - gap * (count - 1)) / count);
    grid.style.setProperty('--wf-gap', `${gap}px`);
  }

  function resetWaterfallLayout() {
    waterfall.count = 0;
    waterfall.gridWidth = 0;
    waterfall.columnWidth = 0;
    waterfall.columns = [];
    waterfall.heights = [];
    grid.innerHTML = '';
  }

  function ensureWaterfallLayout(force = false) {
    const nextCount = getWaterfallColumnCount();
    if (!force && waterfall.count === nextCount && waterfall.columns.length) {
      updateWaterfallMetrics();
      return;
    }

    waterfall.count = nextCount;
    grid.innerHTML = '';
    waterfall.columns = [];
    waterfall.heights = new Array(nextCount).fill(0);
    updateWaterfallMetrics();

    for (let i = 0; i < nextCount; i += 1) {
      const col = document.createElement('div');
      col.className = 'waterfall-col';
      grid.appendChild(col);
      waterfall.columns.push(col);
    }
  }

  function pickShortestColumnIndex() {
    if (!waterfall.heights.length) return 0;
    let target = 0;
    let minHeight = waterfall.heights[0];
    for (let i = 1; i < waterfall.heights.length; i += 1) {
      if (waterfall.heights[i] < minHeight) {
        minHeight = waterfall.heights[i];
        target = i;
      }
    }
    return target;
  }

  function estimateTileHeight(item) {
    return waterfall.columnWidth * getTileHeightRatio(item) + 56;
  }

  function requestDelete(item) {
    if (!item?.name) return;
    document.dispatchEvent(new CustomEvent('library:delete-request', { detail: { item } }));
  }

  function createTile(item, index) {
    const tile = document.createElement('article');
    tile.className = 'media-tile';
    tile.dataset.index = String(index);
    tile.dataset.uri = String(item.name || '');
    const filename = String(item.name || '').split('/').pop() || '未命名资源';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'tile-preview';
    preview.setAttribute('aria-label', `预览${item.type === 'video' ? '视频' : '图片'}：${filename}`);
    preview.title = `预览：${filename}`;
    const img = document.createElement('img');
    img.src = item.thumb_url || item.media_url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.aspectRatio = getTileAspectRatio(item);
    preview.appendChild(img);
    if (item.type === 'video') {
      const badge = document.createElement('span');
      badge.className = 'tile-video-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.innerHTML = feather.icons.play.toSvg({ width: 12, height: 12 });
      preview.appendChild(badge);
      if (item.progress) {
        const progress = document.createElement('span');
        progress.className = 'tile-progress';
        progress.style.setProperty('--progress', `${item.progress * 100}%`);
        preview.appendChild(progress);
      }
    }
    img.addEventListener('error', () => {
      preview.classList.add('has-thumbnail-error');
      img.hidden = true;
      const message = document.createElement('span');
      message.className = 'tile-thumbnail-error';
      message.textContent = '缩略图暂不可用，点击预览';
      preview.appendChild(message);
    }, { once: true });
    // Multi-select (module G): tap toggles selection while batch mode is on,
    // and a touch long-press jumps straight into batch mode with this tile picked.
    let pressTimer = null;
    let pressStart = null;
    let longPressed = false;
    const cancelPress = () => {
      clearTimeout(pressTimer);
      pressTimer = null;
      pressStart = null;
    };
    preview.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      longPressed = false;
      pressStart = { x: event.clientX, y: event.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        document.dispatchEvent(new CustomEvent('library:batch-longpress', { detail: { item, tile } }));
      }, 500);
    });
    preview.addEventListener('pointermove', (event) => {
      if (!pressStart) return;
      if (Math.abs(event.clientX - pressStart.x) > 10 || Math.abs(event.clientY - pressStart.y) > 10) cancelPress();
    });
    preview.addEventListener('pointerup', cancelPress);
    preview.addEventListener('pointercancel', cancelPress);
    preview.addEventListener('click', () => {
      if (longPressed) { longPressed = false; return; }
      if (window.SpoolyLibraryBatch?.isActive()) {
        document.dispatchEvent(new CustomEvent('library:batch-toggle', { detail: { item, tile } }));
        return;
      }
      openViewer(index);
    });
    const selectBox = document.createElement('button');
    selectBox.type = 'button';
    selectBox.className = 'tile-select';
    selectBox.setAttribute('aria-label', `选择 ${filename}`);
    selectBox.setAttribute('aria-pressed', 'false');
    selectBox.innerHTML = feather.icons.check.toSvg({ width: 14, height: 14 });
    selectBox.addEventListener('click', (event) => {
      event.stopPropagation();
      document.dispatchEvent(new CustomEvent('library:batch-toggle', { detail: { item, tile } }));
    });
    tile.appendChild(preview);
    tile.appendChild(selectBox);
    const footer = document.createElement('div');
    footer.className = 'tile-management';
    const label = document.createElement('div');
    label.className = 'tile-file-label';
    const name = document.createElement('span');
    name.className = 'tile-file-name';
    name.textContent = window.SpoolyCaption ? window.SpoolyCaption.display(item.name) : filename;
    name.title = String(item.name || '');
    const type = document.createElement('span');
    type.className = 'tile-file-type';
    type.textContent = item.type === 'video' ? '视频' : '图片';
    label.append(name, type);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tile-delete';
    remove.title = '移到回收站';
    remove.setAttribute('aria-label', `将“${filename}”移到回收站`);
    remove.innerHTML = feather.icons['trash-2'].toSvg({ width: 16, height: 16 });
    remove.addEventListener('click', () => requestDelete(item));
    footer.append(label, remove);
    tile.appendChild(footer);
    // Late-loaded pages must still reflect the current batch selection.
    window.SpoolyLibraryBatch?.syncTile?.(tile);
    return tile;
  }

  function appendIndexToWaterfall(index) {
    const item = items[index];
    if (!item) return;
    const colIndex = pickShortestColumnIndex();
    const col = waterfall.columns[colIndex];
    if (!col) return;
    col.appendChild(createTile(item, index));
    waterfall.heights[colIndex] += estimateTileHeight(item) + waterfall.gap;
  }

  function relayoutWaterfall() {
    if (!items.length) {
      resetWaterfallLayout();
      ensureWaterfallLayout(true);
      return;
    }
    ensureWaterfallLayout(true);
    updateWaterfallMetrics();
    for (let i = 0; i < items.length; i += 1) {
      appendIndexToWaterfall(i);
    }
    feather.replace();
  }

  function scheduleWaterfallRelayout() {
    if (relayoutTimer) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      relayoutTimer = null;
      const nextCount = getWaterfallColumnCount();
      const nextGap = getWaterfallGap();
      const nextGridWidth = Math.max(1, grid.clientWidth || window.innerWidth);
      const layoutChanged = waterfall.count !== nextCount
        || waterfall.gap !== nextGap
        || waterfall.gridWidth !== nextGridWidth;
      if (!layoutChanged) return;
      relayoutWaterfall();
    }, 180);
  }

  function setLoadingText(text, actions = {}) {
    statusText.textContent = text;
    retryButton.hidden = actions.retry !== true;
    clearSearchButton.hidden = actions.clearSearch !== true;
    statusActions.hidden = actions.retry !== true && actions.clearSearch !== true;
  }

  function findItemIndexByName(name) {
    const expected = String(name || '').trim();
    if (!expected) return -1;
    for (let i = 0; i < items.length; i += 1) {
      if (String(items[i]?.name || '') === expected) return i;
    }
    return -1;
  }

  function apiParams(offset) {
    const params = new URLSearchParams({
      scope,
      mode,
      offset: String(offset),
      limit: String(pageSize),
    });
    if (scope === 'collection' && collectionId) {
      params.set('collection_id', String(collectionId));
    }
    if (mode === 'big_files') {
      params.set('min_mb', String(minMb));
    }
    if (mode === 'image_random') {
      if (!seed) seed = makeRandomSeed();
      params.set('seed', seed);
    }
    if (searchQuery) params.set('q', searchQuery);
    if (timelineMonth) params.set('month', timelineMonth);
    if (folderFilter) params.set('folder', folderFilter);
    return params;
  }

  async function loadNextPage() {
    if (flowSession.isLoading() || !flowSession.hasMore()) return false;
    const requestVersion = searchRequest;
    setLoadingText('正在加载媒体…');
    try {
      await flowSession.loadMore(async (cursor) => {
        const offset = Number(cursor?.offset || 0);
        const url = `/api/library/items?${apiParams(offset).toString()}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || !data?.success) throw new Error('媒体加载失败');

        const payload = data.data || {};
        if (payload.seed && mode === 'image_random') seed = String(payload.seed);
        return {
          items: Array.isArray(payload.items) ? payload.items : [],
          hasMore: payload.has_more === true,
          cursor: { offset: Number(payload.next_offset || (offset + pageSize)) },
        };
      }).then((result) => {
        if (requestVersion !== searchRequest || result.stale) return;
        const appendedIndexes = result.appendedIndices || [];
        if (appendedIndexes.length) {
          ensureWaterfallLayout(!waterfall.columns.length);
          updateWaterfallMetrics();
          appendedIndexes.forEach((idx) => appendIndexToWaterfall(idx));
          feather.replace();
          if (quickView.classList.contains('active') && getCurrentIndex() >= 0) {
            quickCounter.textContent = `${getCurrentIndex() + 1} / ${items.length}`;
          }
        }
      });

      if (requestVersion !== searchRequest) return false;
      if (!items.length) {
        if (searchQuery) {
          setLoadingText(`没有找到与“${searchQuery}”匹配的媒体，可换个关键词试试（支持文件名、文案和路径）。`, { clearSearch: true });
        } else {
          setLoadingText(emptyMessage);
        }
      } else if (!flowSession.hasMore()) {
        setLoadingText('已显示全部媒体');
      } else {
        setLoadingText('继续向下滚动加载更多');
      }
      return true;
    } catch (error) {
      if (requestVersion === searchRequest) setLoadingText('加载失败，请检查连接后重试。', { retry: true });
      return false;
    }
  }

  async function maybeOpenFocusedItem() {
    if (!focusName || focusHandled || focusLoading) return;
    const directIndex = findItemIndexByName(focusName);
    if (directIndex >= 0) {
      focusHandled = true;
      openViewer(directIndex);
      return;
    }
    if (!flowSession.hasMore()) {
      focusHandled = true;
      return;
    }

    focusLoading = true;
    try {
      while (!focusHandled && flowSession.hasMore()) {
        if (!await loadNextPage()) break;
        const index = findItemIndexByName(focusName);
        if (index >= 0) {
          focusHandled = true;
          openViewer(index);
          return;
        }
      }
      if (!flowSession.hasMore()) {
        focusHandled = true;
      }
    } finally {
      focusLoading = false;
    }
  }

  async function reloadCurrentMode() {
    searchRequest += 1;
    closeViewer();
    flowSession.reset({
      hasMore: true,
      cursor: { offset: 0 },
    });
    resetWaterfallLayout();
    activeTab();
    setLoadingText('正在加载媒体…');
    await loadNextPage();
  }

  async function reloadMode(nextMode) {
    mode = nextMode;
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    syncSearchUI();
    setSearchOpen(false);
    if (mode === 'image_random') seed = makeRandomSeed();
    else seed = '';
    syncLibraryUrl(false);
    await reloadCurrentMode();
  }

  async function reloadModeFromUrl() {
    if (scope !== 'all') return;
    const state = readLibraryStateFromUrl();
    mode = state.mode;
    seed = state.seed;
    searchQuery = state.search;
    folderFilter = state.folder;
    renderFolderChip();
    if (searchInput) searchInput.value = searchQuery;
    syncSearchUI();
    setSearchOpen(!!searchQuery);
    if (mode === 'image_random' && !seed) seed = makeRandomSeed();
    syncLibraryUrl(true);
    await reloadCurrentMode();
  }

  function updateCollectionCoverButton(item) {
    const shouldShow = scope === 'collection' && !!collectionId && !!item?.name;
    quickSetCover.classList.toggle('is-hidden', !shouldShow);
    if (!shouldShow) {
      quickSetCover.dataset.currentCover = 'false';
      quickSetCover.disabled = false;
      return;
    }
    const isCurrent = String(item.name) === collectionCoverUri;
    quickSetCover.dataset.currentCover = isCurrent ? 'true' : 'false';
    quickSetCover.title = isCurrent ? '当前封面' : '设为封面';
    quickSetCover.setAttribute('aria-label', quickSetCover.title);
    quickSetCover.disabled = isCurrent;
  }

  function updateCollectionIdentityCover(item) {
    if (!collectionIdentityCover || !item?.thumb_url) return;
    const collage = collectionIdentityCover.querySelector('.collection-identity-collage');
    const firstTile = collage?.querySelector('.collection-identity-tile');
    if (firstTile) {
      firstTile.dataset.uri = item.name;
      firstTile.dataset.type = item.type;
      const image = firstTile.querySelector('img');
      if (image) image.src = item.thumb_url;
      return;
    }
    const nextCollage = document.createElement('div');
    nextCollage.className = 'collection-identity-collage';
    nextCollage.dataset.count = '1';
    const tile = document.createElement('span');
    tile.className = 'collection-identity-tile';
    tile.dataset.uri = item.name;
    tile.dataset.type = item.type;
    const image = document.createElement('img');
    image.src = item.thumb_url;
    image.alt = '';
    image.decoding = 'async';
    tile.appendChild(image);
    nextCollage.appendChild(tile);
    collectionIdentityCover.replaceChildren(nextCollage);
  }

  async function syncFavoriteState(item) {
    if (!item?.name) return;
    try {
      await mediaActions.syncFavorite(item.name);
    } catch (error) {
      if (currentItem()?.name === item.name) updateFavoriteButton(false);
    }
  }

  function updateFavoriteButton(favorited) {
    quickFavorite.classList.toggle('is-favorited', !!favorited);
    quickFavorite.setAttribute('aria-pressed', String(!!favorited));
    quickFavorite.setAttribute('aria-label', favorited ? '取消收藏' : '添加收藏');
    quickFavorite.title = favorited ? '取消收藏' : '添加收藏';
  }

  function updateSourceButton(sourceMeta) {
    const url = String(sourceMeta?.url || '').trim();
    if (!url) {
      quickSource.classList.add('is-hidden');
      quickSource.removeAttribute('href');
      quickSource.title = '未记录来源';
      return;
    }
    const domain = String(sourceMeta?.source_domain || '').trim();
    quickSource.href = url;
    quickSource.title = domain ? `查看来源（${domain}）` : '查看来源';
    quickSource.classList.remove('is-hidden');
  }

  function clearCaption() {
    quickCaptionTitle.textContent = '';
    quickCaptionTags.innerHTML = '';
    quickCaptionPanel.classList.add('is-hidden');
  }

  function renderCaption(data) {
    const title = String(data?.title || '').trim();
    const tags = Array.isArray(data?.tags) ? data.tags : [];
    if (!title && tags.length === 0) {
      clearCaption();
      return;
    }
    quickCaptionPanel.classList.remove('is-hidden');
    quickCaptionTitle.textContent = title;
    quickCaptionTags.innerHTML = '';
    tags.forEach((tag) => {
      const chip = document.createElement('span');
      chip.className = 'quick-caption-tag';
      chip.textContent = String(tag || '');
      quickCaptionTags.appendChild(chip);
    });
  }

  function setCaptionLoading(loadingState) {
    quickCaption.disabled = !!loadingState;
    quickCaption.classList.toggle('is-loading', !!loadingState);
  }

  function flashCaptionError() {
    quickCaption.classList.add('is-error');
    setTimeout(() => quickCaption.classList.remove('is-error'), 1400);
  }

  const mediaActions = window.createFlowMediaActionsController({
    actions: actionsShared,
    onFavoriteChange: (value, name) => {
      if (currentItem()?.name === name) updateFavoriteButton(value);
    },
    onSourceChange: (sourceMeta) => {
      updateSourceButton(sourceMeta);
    },
    onCaptionClear: () => {
      clearCaption();
    },
    onCaptionRender: (payload) => {
      renderCaption(payload);
    },
    onCaptionLoading: (loading) => {
      setCaptionLoading(loading);
    },
    onError: (kind) => {
      if (kind === 'caption_load' || kind === 'caption_generate') {
        flashCaptionError();
      }
    },
  });

  function updateControls(item) {
    const isVideo = item?.type === 'video';
    quickControls.classList.toggle('is-hidden', !isVideo);
    quickSpeed.hidden = !isVideo;
    quickCaption.hidden = true;
    quickMagnifierToolWrap.hidden = false;

    if (!isVideo) quickPlayStatus.classList.remove('visible');
  }

  function updateVideoProgress() {
    quickProgressController.sync();
  }

  function togglePlay() {
    const item = currentItem();
    if (!item || item.type !== 'video') return;
    if (quickVideo.paused) {
      quickVideo.play().then(() => showQuickFeedback('')).catch(() => {
        showQuickFeedback('播放未能开始，请再次点击视频播放。');
      });
      showPlayStatus(false);
    } else {
      quickVideo.pause();
      showPlayStatus(true);
    }
  }

  function closeViewer() {
    flowState.reset();
    collections.close();
    quickView.classList.remove('active');
    quickView.setAttribute('aria-hidden', 'true');
    quickProgressController?.cancel({ resume: false });
    quickVideo.pause();
    quickVideo.removeAttribute('src');
    quickVideo.removeAttribute('poster');
    quickVideo.load();
    quickVideo.classList.remove('active');
    quickImage.classList.remove('active');
    quickImage.src = '';
    showQuickFeedback('');
    quickPlayStatus.classList.remove('visible');
    quickProgress.value = 0;
    quickProgressFill.style.width = '0%';
    quickTimeCurrent.textContent = '00:00';
    quickTimeTotal.textContent = '00:00';
    updateSourceButton(null);
    mediaActions.clearCaption();
    magnifier.toggle(false);
    updateCollectionCoverButton(null);
    collections.sync('');
    flowSession.setIndex(-1);
    if (bodyScrollLocked) {
      document.body.style.overflow = bodyOverflowBackup;
      bodyOverflowBackup = '';
      bodyScrollLocked = false;
    }
  }

  function showItem(index) {
    if (index < 0 || index >= items.length) return;
    quickProgressController?.cancel({ resume: false });
    showQuickFeedback('');
    flowSession.setIndex(index);
    const item = items[index];
    quickCounter.textContent = `${index + 1} / ${items.length}`;
    quickDetail.href = item.detail_url || '#';
    magnifier.toggle(false);
    flowState.onMediaChanged();
    updateControls(item);
    updateCollectionCoverButton(item);

    if (item.type === 'video') {
      mediaActions.clearCaption();
      quickImage.classList.remove('active');
      quickImage.src = '';
      const nextSrc = String(item.media_url || '');
      if (quickVideo.getAttribute('src') !== nextSrc) {
        quickVideo.src = nextSrc;
        quickVideo.load();
        window.SpoolyResume?.track(quickVideo, item.name, item.resume || 0);
      }
      quickVideo.poster = item.thumb_url || '';
      quickVideo.classList.add('active');
      quickVideo.playbackRate = speedOptions[currentSpeedIndex];
      quickProgress.value = 0;
      quickProgressFill.style.width = '0%';
      quickTimeCurrent.textContent = '00:00';
      quickTimeTotal.textContent = formatTime(quickVideo.duration);
      quickVideo.play()
        .then(() => { quickPlayStatus.classList.remove('visible'); showQuickFeedback(''); })
        .catch(() => { showPlayStatus(true); showQuickFeedback('点击视频即可播放；浏览器可能需要你先点击以开启声音。'); });
    } else {
      quickVideo.pause();
      quickVideo.classList.remove('active');
      quickVideo.removeAttribute('src');
      quickVideo.removeAttribute('poster');
      quickVideo.load();
      quickImage.src = item.media_url;
      quickImage.classList.add('active');
      // Caption generation is not exposed in the simplified library.
    }

    syncFavoriteState(item);
    collections.sync(item.name);
    syncSourceState(item);
    if (index >= items.length - 8 && flowSession.hasMore()) loadNextPage();
  }

  function openViewer(index) {
    if (index < 0 || index >= items.length) return;
    if (!quickView.classList.contains('active')) {
      bodyOverflowBackup = document.body.style.overflow || '';
      document.body.style.overflow = 'hidden';
      bodyScrollLocked = true;
    }
    quickView.classList.add('active');
    quickView.setAttribute('aria-hidden', 'false');
    showItem(index);
  }

  async function nextItem() {
    if (getCurrentIndex() >= items.length - 1 && flowSession.hasMore()) await loadNextPage();
    if (getCurrentIndex() < items.length - 1) await showItem(getCurrentIndex() + 1);
  }

  async function prevItem() {
    if (getCurrentIndex() > 0) await showItem(getCurrentIndex() - 1);
  }

  async function syncSourceState(item) {
    if (!item?.name) {
      updateSourceButton(null);
      return;
    }
    try {
      await mediaActions.syncSource(item.name);
    } catch (error) {
      updateSourceButton(null);
    }
  }

  quickFavorite.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const idx = getCurrentIndex();
    if (idx < 0 || idx >= items.length) return;
    const item = items[idx];
    if (!item?.name) return;
    try {
      await mediaActions.toggleFavorite(item.name);
    } catch (error) {
      await syncFavoriteState(item);
      if (currentItem()?.name === item.name) {
        quickFavorite.title = '收藏未能保存，请重试。';
        quickFavorite.setAttribute('aria-label', quickFavorite.title);
      }
    }
  });

  async function setCurrentAsCollectionCover() {
    const item = currentItem();
    if (!item || !item.name || scope !== 'collection' || !collectionId) return;
    if (item.name === collectionCoverUri) return;
    quickSetCover.disabled = true;
    try {
      await window.SpoolyCollections.request(`/api/collections/${encodeURIComponent(collectionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover_uri: item.name }),
      });
      collectionCoverUri = String(item.name);
      updateCollectionIdentityCover(item);
      updateCollectionCoverButton(item);
    } catch (error) {
      quickSetCover.disabled = false;
      return;
    }
  }

  quickSetCover.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await setCurrentAsCollectionCover();
  });

  quickCloseTop.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closeViewer();
  });

  document.addEventListener('keydown', (event) => {
    if (document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape' && collections.isOpen()) {
      collections.close();
      return;
    }
    if (!quickView.classList.contains('active')) return;
    if (event.key === 'Escape') closeViewer();
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextItem();
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') prevItem();
    if (event.key === ' ') {
      event.preventDefault();
      togglePlay();
    }
  });

  quickOverlay.addEventListener('click', () => {
    const item = currentItem();
    if (!item) return;
    const now = Date.now();
    const delta = now - lastClickTime;
    if (delta > 0 && delta < 250) {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = null;
      if (item.type === 'video') {
        togglePlay();
      }
    } else {
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        toggleUI();
        clickTimer = null;
      }, 250);
    }
    lastClickTime = now;
  });

  quickSpeed.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    currentSpeedIndex = (currentSpeedIndex + 1) % speedOptions.length;
    const rate = speedOptions[currentSpeedIndex];
    quickSpeed.textContent = `${rate}倍`;
    quickSpeed.title = `当前${rate}倍速，点击切换`;
    quickSpeed.setAttribute('aria-label', quickSpeed.title);
    const item = currentItem();
    if (item?.type === 'video') {
      quickVideo.playbackRate = rate;
    }
  });

  quickCaption.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const item = currentItem();
    if (!item || item.type !== 'image') return;
    mediaActions.generateCaption(item.name);
  });

  quickView.addEventListener('wheel', (event) => {
    if (!quickView.classList.contains('active')) return;
    const target = event.target;
    if (target && typeof target.closest === 'function') {
      if (target.closest('.quick-actions, #quick-controls, #quick-close-top, #quick-caption-panel, .quick-magnifier')) {
        return;
      }
    }
    if (magnifier.isActive()) return;
    const deltaY = event.deltaY || 0;
    if (Math.abs(deltaY) < 24) return;
    event.preventDefault();
    if (wheelLocked) return;
    wheelLocked = true;
    if (deltaY > 0) nextItem();
    else prevItem();
    setTimeout(() => {
      wheelLocked = false;
    }, 260);
  }, { passive: false });

  const swipe = new Hammer(quickOverlay);
  swipe.get('swipe').set({ direction: Hammer.DIRECTION_VERTICAL });
  swipe.on('swipeup', () => {
    if (magnifier.isActive()) return;
    nextItem();
  });
  swipe.on('swipedown', () => {
    if (magnifier.isActive()) return;
    prevItem();
  });

  window.addEventListener('resize', scheduleWaterfallRelayout);

  function showQuickFeedback(message) {
    const feedback = document.getElementById('quick-feedback');
    if (!feedback) return;
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  document.getElementById('quick-delete')?.addEventListener('click', () => requestDelete(currentItem()));
  quickVideo.addEventListener('error', () => {
    if (quickView.classList.contains('active') && currentItem()?.type === 'video') showQuickFeedback('视频暂时无法播放，请关闭预览后重试或重新扫描。');
  });
  quickImage.addEventListener('error', () => {
    if (quickView.classList.contains('active') && currentItem()?.type === 'image') showQuickFeedback('图片加载失败，请关闭预览后重试或重新扫描。');
  });
  quickVideo.addEventListener('timeupdate', updateVideoProgress);
  quickVideo.addEventListener('loadedmetadata', updateVideoProgress);
  quickVideo.addEventListener('durationchange', updateVideoProgress);
  quickVideo.addEventListener('play', () => {
    quickPlayStatus.classList.remove('visible');
    magnifier.onVideoPlay(quickVideo);
  });
  quickVideo.addEventListener('seeked', () => magnifier.onVideoSeeked(quickVideo));
  quickVideo.addEventListener('pause', () => {
    const item = currentItem();
    if (item?.type === 'video') showPlayStatus(true);
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) loadNextPage();
    });
  }, { rootMargin: '1000px 0px' });
  observer.observe(sentinel);

  if (scope === 'all') {
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetMode = tab.dataset.mode || 'all';
        if (targetMode === mode) return;
        reloadMode(targetMode);
      });
    });
    activeTab();
    syncLibraryUrl(true);
    window.addEventListener('popstate', () => {
      reloadModeFromUrl();
    });
    let searchTimer = null;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      syncSearchUI();
      searchTimer = setTimeout(async () => {
        searchQuery = String(searchInput.value || '').trim();
        if (searchQuery && mode !== 'all') {
          mode = 'all';
          seed = '';
        }
        syncLibraryUrl(true);
        await reloadCurrentMode();
      }, 300);
    });
    searchClearButton?.addEventListener('click', async () => {
      clearTimeout(searchTimer);
      searchQuery = '';
      searchInput.value = '';
      syncSearchUI();
      syncLibraryUrl(true);
      await reloadCurrentMode();
      searchInput.focus();
    });
    searchToggleButton?.addEventListener('click', () => {
      const isOpen = libraryToolbar?.classList.contains('is-search-open');
      setSearchOpen(!isOpen, { focus: !isOpen });
    });
    searchInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || String(searchInput.value || '').trim() || !searchToggleButton) return;
      event.preventDefault();
      setSearchOpen(false);
      searchToggleButton?.focus();
    });
  }

  retryButton.addEventListener('click', async () => {
    setLoadingText('正在重新加载…');
    await loadNextPage();
  });

  clearSearchButton.addEventListener('click', async () => {
    searchQuery = '';
    if (searchInput) searchInput.value = '';
    syncSearchUI();
    syncLibraryUrl(true);
    await reloadCurrentMode();
    searchInput?.focus();
  });

  quickSpeed.textContent = `${speedOptions[currentSpeedIndex]}倍`;
  const monthHeading = document.querySelector('[data-month-heading]');
  if (monthHeading && /^\d{4}-\d{2}$/.test(timelineMonth)) {
    const [year, monthNumber] = timelineMonth.split('-');
    monthHeading.textContent = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date(year, Number(monthNumber) - 1, 1));
  }
  relayoutWaterfall();
  if (!items.length && !flowSession.hasMore()) {
    if (searchQuery) {
      setLoadingText(`没有找到与“${searchQuery}”匹配的媒体，可换个关键词试试（支持文件名、文案和路径）。`, { clearSearch: true });
    } else {
      setLoadingText(emptyMessage);
    }
  } else if (!flowSession.hasMore()) {
    setLoadingText('已显示全部媒体');
  } else {
    setLoadingText('继续向下滚动加载更多');
  }
  // Module L3: 按文件夹浏览网格（复用 /api/folders 浏览组件）。
  const folderFilterBtn = document.getElementById('library-folder-filter');
  const folderChip = document.getElementById('library-folder-chip');
  const folderChipText = document.getElementById('library-folder-chip-text');
  const folderChipClear = document.getElementById('library-folder-chip-clear');
  const folderDialog = document.getElementById('library-folder-dialog');
  const folderList = document.getElementById('library-folder-list');
  const folderCrumbs = document.getElementById('library-folder-crumbs');
  const folderUpBtn = document.getElementById('library-folder-up');
  const folderClearBtn = document.getElementById('library-folder-clear');
  const folderCloseBtn = document.getElementById('library-folder-close');
  let folderPickerUri = null; // null = 源列表

  function renderFolderChip() {
    if (!folderChip) return;
    const active = !!folderFilter;
    folderChip.hidden = !active;
    if (active) {
      folderChipText.textContent = `文件夹：${folderFilter.replace(/^@/, '').replace(/\/+$/, '')}`;
    }
    if (folderFilterBtn) folderFilterBtn.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function folderParent(uri) {
    const rest = String(uri || '').slice(1);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const source = rest.slice(0, slash);
    const rel = rest.slice(slash + 1).replace(/\/+$/, '');
    if (!rel) return null;
    const cut = rel.lastIndexOf('/');
    return '@' + source + '/' + (cut < 0 ? '' : rel.slice(0, cut + 1));
  }

  function folderRow({ uri, name, subtitle, count, canEnter }) {
    const row = document.createElement('li');
    row.className = 'library-privacy-row';
    const main = document.createElement('div');
    main.className = 'library-privacy-row-main';
    const strong = document.createElement('strong');
    strong.textContent = String(name || uri);
    main.append(strong);
    if (subtitle) {
      const code = document.createElement('code');
      code.textContent = String(subtitle);
      main.append(code);
    }
    if (count != null) {
      const span = document.createElement('span');
      span.textContent = `${Number(count)} 个媒体`;
      main.append(span);
    }
    const actions = document.createElement('div');
    actions.className = 'library-privacy-row-actions';
    const pick = document.createElement('button');
    pick.className = 'library-management-button is-primary';
    pick.type = 'button';
    pick.textContent = '选择';
    pick.addEventListener('click', () => applyFolderFilter(uri));
    actions.append(pick);
    if (canEnter) {
      const enter = document.createElement('button');
      enter.className = 'library-management-button';
      enter.type = 'button';
      enter.textContent = '进入';
      enter.addEventListener('click', () => { folderPickerUri = uri; renderFolderPicker(); });
      actions.append(enter);
    }
    row.append(main, actions);
    return row;
  }

  async function renderFolderPicker() {
    if (!folderList) return;
    if (folderUpBtn) folderUpBtn.hidden = !folderPickerUri;
    folderList.innerHTML = '<li class="library-privacy-empty">正在加载文件夹…</li>';
    try {
      let rows = [];
      if (!folderPickerUri) {
        if (folderCrumbs) folderCrumbs.textContent = '全部媒体源';
        const body = await (await fetch('/api/media-sources')).json();
        const list = body.data?.items || body.items || [];
        rows = (Array.isArray(list) ? list : []).map((item) => ({
          uri: '@' + item.id + '/',
          name: item.name || item.id,
          subtitle: item.path || '',
          count: item.media_count,
          canEnter: true,
        }));
      } else {
        if (folderCrumbs) folderCrumbs.textContent = folderPickerUri.replace(/^@/, '').replace(/\/+$/, '');
        const data = await (await fetch('/api/folders?folder=' + encodeURIComponent(folderPickerUri) + '&limit=96')).json();
        rows = (data.data?.items || []).map((node) => ({
          uri: node.uri,
          name: node.name,
          count: node.media_count,
          canEnter: !!node.has_children,
        }));
      }
      folderList.replaceChildren();
      rows.forEach((item) => folderList.append(folderRow(item)));
      if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'library-privacy-empty';
        empty.textContent = folderPickerUri ? '该文件夹下没有子文件夹。' : '还没有挂载文件夹。';
        folderList.append(empty);
      }
    } catch (error) {
      folderList.replaceChildren();
      const empty = document.createElement('li');
      empty.className = 'library-privacy-empty';
      empty.textContent = String(error.message || '文件夹加载失败，请稍后重试。');
      folderList.append(empty);
    }
  }

  async function applyFolderFilter(uri) {
    folderFilter = String(uri || '');
    renderFolderChip();
    syncLibraryUrl();
    if (folderDialog && folderDialog.open) folderDialog.close();
    await reloadCurrentMode();
  }

  if (folderFilterBtn) {
    folderFilterBtn.addEventListener('click', () => {
      folderPickerUri = null;
      renderFolderPicker();
      if (folderDialog) folderDialog.showModal();
    });
  }
  if (folderUpBtn) {
    folderUpBtn.addEventListener('click', () => {
      folderPickerUri = folderParent(folderPickerUri);
      renderFolderPicker();
    });
  }
  if (folderClearBtn) folderClearBtn.addEventListener('click', () => applyFolderFilter(''));
  if (folderChipClear) folderChipClear.addEventListener('click', () => applyFolderFilter(''));
  if (folderCloseBtn) folderCloseBtn.addEventListener('click', () => folderDialog.close());
  renderFolderChip();

  // Module J: 「标题显示：文案 / 完整文件名」切换开关。
  const captionModeBtn = document.getElementById('library-caption-mode');
  const syncCaptionModeLabel = () => {
    if (!captionModeBtn) return;
    const isFilename = window.SpoolyCaption && window.SpoolyCaption.mode() === 'filename';
    captionModeBtn.textContent = isFilename ? '标题：完整文件名' : '标题：文案';
    captionModeBtn.setAttribute('aria-pressed', String(isFilename));
    captionModeBtn.title = isFilename ? '点击切换为只显示文案' : '点击切换为显示完整文件名';
  };
  if (captionModeBtn && window.SpoolyCaption) {
    syncCaptionModeLabel();
    captionModeBtn.addEventListener('click', async () => {
      const next = window.SpoolyCaption.mode() === 'filename' ? 'caption' : 'filename';
      window.SpoolyCaption.setMode(next);
      syncCaptionModeLabel();
      await reloadCurrentMode();
    });
  }

  feather.replace();
  syncSearchUI();
  window.SpoolyLibraryPage = { reload: reloadCurrentMode, closeViewer };
  if (!items.length && flowSession.hasMore()) loadNextPage().then(maybeOpenFocusedItem);
  else maybeOpenFocusedItem();
})();
