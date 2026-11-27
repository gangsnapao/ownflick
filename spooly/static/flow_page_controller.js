  (async () => {
    document.body.classList.add('immersive');

    const feedContainer = document.getElementById('feed-container');
    const videoStartCover = document.getElementById('video-start-cover');
    const overlayLayer = document.getElementById('overlay-layer');
    const speedBtn = document.getElementById('speed-btn');
    const speedWrap = document.getElementById('speed-tool-wrap');
    const speedChoices = document.getElementById('speed-options');
    const speedMenu = document.getElementById('speed-menu');
    const backToLatestBtn = document.getElementById('back-to-latest');
    const hud = document.getElementById('flow-hud');
    const magnifierToolWrap = document.getElementById('magnifier-tool-wrap');
    const likeBtn = document.getElementById('like-btn');
    const favoriteBtn = document.getElementById('favorite-btn');
    const muteBtn = document.getElementById('mute-btn');
    const collectionBtn = document.getElementById('collection-btn');
    const collectionPlayback = document.getElementById('collection-playback');
    const collectionPlaybackOpen = document.getElementById('collection-playback-open');
    const collectionPlaybackName = document.getElementById('collection-playback-name');
    const collectionPlaybackCount = document.getElementById('collection-playback-count');
    const collectionPlaylist = document.getElementById('collection-playlist');
    const collectionPlaylistTitle = document.getElementById('collection-playlist-title');
    const collectionPlaylistMeta = document.getElementById('collection-playlist-meta');
    const collectionPlaylistItems = document.getElementById('collection-playlist-items');
    const collectionPlaylistMore = document.getElementById('collection-playlist-more');
    const collectionPlaylistClose = document.getElementById('collection-playlist-close');
    const infoBtn = document.getElementById('info-btn');
    const cleanModeBtn = document.getElementById('clean-mode-btn');
    const cleanModeExit = document.getElementById('clean-mode-exit');
    // R2 清屏只保留迷你进度条与退出按钮：其余常驻元素全部隐藏并退出焦点流。
    const cleanModeSurfaces = document.querySelectorAll(
      '.mobile-app-header, .floating-dock, #controls, #controls-drawer-toggle, .controls-quick, #flow-mode, #collection-playback, #sound-prompt, #back-to-latest, #play-status-icon'
    );

    const playStatusIcon = document.getElementById('play-status-icon');
    const customControls = document.getElementById('custom-controls');
    const progressBar = document.getElementById('video-progress');
    const progressFill = document.getElementById('progress-fill');
    const timeCurrent = document.getElementById('time-current');
    const timeTotal = document.getElementById('time-total');

    const flowStatus = document.getElementById('flow-state');
    const flowStatusTitle = document.getElementById('flow-state-title');
    const flowStatusDetail = document.getElementById('flow-state-detail');
    const flowStatusActions = document.getElementById('flow-state-actions');
    const flowStatusRetry = document.getElementById('flow-state-retry');
    const flowStatusNext = document.getElementById('flow-state-next');
    const flowStatusLibrary = document.getElementById('flow-state-library');
    const uiShared = window.FlowUIShared || {};
    const actionsShared = window.FlowActionsShared || {};

    const keySeekSeconds = 5;
    // A full-width drag covers the whole clip, but never more than this many seconds.
    const scrubSpanSeconds = 90;

    const flowSession = window.createFlowSession({
      initialItems: [],
      initialHasMore: true,
      initialCursor: { page: 1 },
      keyOf: (item) => String(item?.name || ''),
    });
    const feedItems = flowSession.items;
    const feedLoadWaiters = [];
    const persistence = window.createFlowPersistence();
    let savedSession = persistence.read();
    let seed = savedSession?.seed || '';
    let avoidUri = savedSession?.avoidUri || '';
    let restoreTarget = savedSession?.uri || '';
    let restoring = !!savedSession;
    let feedEpoch = 0;
    let roundLoading = false;
    let feedAbort = new AbortController();
    let lastSessionSave = 0;
    // ?collection=<id> plays one collection in order; otherwise full-library Flow.
    const flowBoot = window.__SPOOLY_FLOW_BOOT__ || {};
    const flowCollection = flowBoot.collection && flowBoot.collection.id ? flowBoot.collection : null;
    const collectionScopeId = flowCollection ? String(flowCollection.id) : '';
    // ?folder=@source/path plays one folder; private folders only play here.
    const flowFolder = flowBoot.folder && flowBoot.folder.uri ? flowBoot.folder : null;
    const folderScopeUri = flowFolder ? String(flowFolder.uri) : '';
    let folderSeed = '';
    const modeBadge = document.getElementById('flow-mode');
    function showModeBadge(text) {
      if (!modeBadge) return;
      modeBadge.hidden = false;
      modeBadge.href = '/flow';
      modeBadge.textContent = text;
      const exitMark = document.createElement('span');
      exitMark.setAttribute('aria-hidden', 'true');
      exitMark.textContent = '×';
      modeBadge.appendChild(exitMark);
    }
    if (collectionScopeId && flowCollection) {
      showModeBadge(`合集：${flowCollection.name} `);
      if (collectionPlayback) collectionPlayback.hidden = false;
      if (collectionPlaybackName) collectionPlaybackName.textContent = String(flowCollection.name || '合集');
    } else if (folderScopeUri && flowFolder) {
      showModeBadge(flowFolder.is_private
        ? '隐私文件夹 · 仅在此处播放 '
        : `文件夹：${flowFolder.name || ''} `);
    } else if (modeBadge) {
      modeBadge.hidden = true;
    }
    const activitySessionId = globalThis.crypto?.randomUUID?.()
      || `flow-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let activeActivity = null;

    function postActivity(events, useBeacon = false) {
      const valid = events.filter(Boolean);
      if (!valid.length) return;
      const body = JSON.stringify({
        events: valid,
        _csrf_token: window.SpoolySecurity?.csrfToken || '',
      });
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon('/api/activity', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => {});
    }

    function activityTarget(item) {
      if (!item) return null;
      if (item.type === 'image_group') {
        const entries = Array.isArray(item.items) ? item.items : [];
        const index = Math.max(0, Math.min(Number(item.activeChildIndex) || 0, entries.length - 1));
        const entry = entries[index];
        return entry?.name ? { uri: entry.name, type: 'image', el: item.el } : null;
      }
      if (!['video', 'image'].includes(item.type) || !item.name) return null;
      return { uri: item.name, type: item.type, el: item.el };
    }

    function beginActivity(item) {
      const target = activityTarget(item);
      if (!target) return null;
      if (target.type === 'video' && target.el) {
        target.el._completedInView = false;
        target.el._activityPlayedSeconds = 0;
        target.el._activityLastPosition = null;
      }
      activeActivity = { target, startedAt: performance.now() };
      return {
        session_id: activitySessionId,
        uri: target.uri,
        media_type: target.type,
        surface: 'flow',
        event: 'impression',
      };
    }

    function finishActivity() {
      if (!activeActivity) return null;
      const { target, startedAt } = activeActivity;
      activeActivity = null;
      const visibleMs = Math.max(0, Math.round(performance.now() - startedAt));
      let ratio = null;
      if (target.type === 'video' && Number.isFinite(target.el?.duration) && target.el.duration > 0) {
        ratio = Math.max(0, Math.min(Number(target.el._activityPlayedSeconds || 0) / target.el.duration, 1));
      }
      const completed = target.type === 'video'
        ? !!target.el?._completedInView
        : visibleMs >= 5000;
      const skipped = target.type === 'video'
        ? visibleMs < 2200 && (ratio === null || ratio < 0.12)
        : visibleMs < 1600;
      return {
        session_id: activitySessionId,
        uri: target.uri,
        media_type: target.type,
        surface: 'flow',
        event: completed ? 'complete' : (skipped ? 'skip' : 'consumed'),
        ratio,
        visible_ms: visibleMs,
      };
    }

    let speedRate = 1;
    // B1 音量/亮度手势：右缘竖滑调音量、左缘竖滑调亮度，中央竖滑照常切条。
    let volumeLevel = 1;
    let brightnessLevel = 1;
    try {
      const savedVolume = window.localStorage.getItem('ownflick-volume');
      if (savedVolume !== null) {
        const value = Number(savedVolume);
        if (Number.isFinite(value) && value >= 0 && value <= 1) volumeLevel = value;
      }
      const savedBrightness = window.localStorage.getItem('ownflick-brightness');
      if (savedBrightness !== null) {
        const value = Number(savedBrightness);
        if (Number.isFinite(value) && value >= 0.4 && value <= 1.6) brightnessLevel = value;
      }
    } catch (error) {
      // Private mode or blocked storage: keep the in-session defaults.
    }
    let hudTimer = null;
    let isDragging = false;
    let flowLoadingTimer = null;
    let videoStartCoverTimer = null;
    let videoActivationId = 0;
    // Unplayable media is skipped with a short note; the full status only shows when skips repeat.
    const maxQuietSkips = 3;
    let quietSkips = 0;
    let skipTimer = null;
    let lastStep = 1;
    let preloadTimer = null;
    let resumeOnVisible = null;
    let pageSuspended = false;
    let progressFrame = null;
    let lastProgressPaint = 0;
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    function canPreloadMedia() {
      return !document.hidden && !pageSuspended && !connection?.saveData
        && !['slow-2g', '2g', '3g'].includes(connection?.effectiveType);
    }

    function isVideoStartReady(videoEl) {
      return videoEl?._startReady === true
        && videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    }

    function showVideoStartCover(item) {
      clearTimeout(videoStartCoverTimer);
      // The thumbnail matches what the page slid in with, so the hand-off does not flash black.
      videoStartCover.style.backgroundImage = item?.thumb_url ? `url("${item.thumb_url}")` : '';
      videoStartCover.classList.remove('is-waiting');
      videoStartCover.classList.add('is-visible');
      videoStartCover.setAttribute('aria-hidden', 'false');
      videoStartCoverTimer = setTimeout(() => {
        videoStartCover.classList.add('is-waiting');
      }, 250);
    }

    function hideVideoStartCover() {
      clearTimeout(videoStartCoverTimer);
      videoStartCover.classList.remove('is-visible', 'is-waiting');
      videoStartCover.setAttribute('aria-hidden', 'true');
    }

    function showFlowStatus(kind, title, detail = '') {
      clearTimeout(flowLoadingTimer);
      flowLoadingTimer = null;
      flowStatus.dataset.kind = kind;
      flowStatusTitle.textContent = title;
      flowStatusDetail.textContent = detail;
      flowStatusRetry.hidden = !['error', 'media-error'].includes(kind);
      flowStatusNext.hidden = kind !== 'media-error';
      flowStatusLibrary.hidden = !['empty', 'error'].includes(kind);
      flowStatusActions.hidden = !['empty', 'error', 'media-error'].includes(kind);
      flowStatus.classList.add('is-visible');
      flowStatus.setAttribute('aria-hidden', 'false');
    }

    function hideFlowStatus() {
      clearTimeout(flowLoadingTimer);
      flowLoadingTimer = null;
      flowStatus.classList.remove('is-visible');
      flowStatus.setAttribute('aria-hidden', 'true');
    }

    function scheduleFlowLoadingStatus() {
      clearTimeout(flowLoadingTimer);
      flowLoadingTimer = setTimeout(() => {
        showFlowStatus('loading', '正在准备媒体');
      }, 250);
    }

    const { formatTime } = uiShared;
    const currentItem = () => flowSession.currentItem();
    const getCurrentIndex = () => flowSession.getIndex();

    const magnifier = uiShared.createMagnifier({
      lens: document.getElementById('magnifier'),
      toggle: document.getElementById('magnifier-toggle'),
      zoomOptions: document.getElementById('zoom-options'),
      badge: document.getElementById('mag-badge'),
      zoomButtons: document.querySelectorAll('#zoom-options .zoom-btn'),
      largeClass: 'magnifier-large',
      settleTransition: 'transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      setMagnifying: (enabled) => flowState.setMagnifying(enabled),
      target: () => {
        const item = currentItem();
        if (item?.type === 'video') return { type: 'video', el: item.el };
        if (item?.type === 'image') return { type: 'image', el: item.el };
        if (item?.type === 'image_group') return { type: 'image', el: item.el?.querySelector('.image-group-media') };
        return null;
      },
    });

    const flowState = window.createFlowStateController({
      getMediaType: () => currentItem()?.type || '',
      canMagnifyMedia: (mediaType) => mediaType === 'image' || mediaType === 'video',
      onImmersiveChange: (enabled) => {
        progressControls.cancel();
        cancelStageGesture();
        closeSpeedChoices();
        closeSpeedMenu();
        hideHud();
        clearTimeout(tapTimer);
        if (enabled && collections.isOpen()) collections.close();
        if (enabled && isCollectionPlaylistOpen()) closeCollectionPlaylist();
        const navTrigger = document.getElementById('app-nav-menu-trigger');
        if (enabled && navTrigger?.getAttribute('aria-expanded') === 'true') navTrigger.click();
        document.body.classList.toggle('immersive-mode', enabled);
        // The compact progress bar stays visible in clean mode, so keep painting.
        startProgressLoop();
        cleanModeBtn.setAttribute('aria-pressed', String(enabled));
        if (cleanModeExit) cleanModeExit.hidden = !enabled;
        // Hidden controls must also leave the keyboard focus order.
        cleanModeSurfaces.forEach((element) => { element.inert = enabled; });
        if (enabled && cleanModeExit) cleanModeExit.focus({ preventScroll: true });
        else if (!enabled && cleanModeBtn) cleanModeBtn.focus({ preventScroll: true });
      },
      onMagnifyingChange: (enabled) => magnifier.onStateChange(enabled),
    });

    const toggleUI = () => flowState.toggleCleanMode();
    const cleanModeActive = () => document.body.classList.contains('immersive-mode');
    cleanModeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      flowState.setCleanMode(true);
    });
    if (cleanModeExit) {
      cleanModeExit.addEventListener('click', (event) => {
        event.stopPropagation();
        flowState.setCleanMode(false);
      });
    }

    // Mute toggle: one click switches video sound, the preference sticks across
    // swipes and later sessions. Videos still start muted internally for
    // preloading; activation applies this state right before playback.
    let soundMuted = false;
    try {
      soundMuted = window.localStorage.getItem('ownflick-muted') === '1';
    } catch (error) {
      soundMuted = false;
    }

    function renderMuteButton() {
      if (!muteBtn) return;
      muteBtn.classList.toggle('is-muted', soundMuted);
      muteBtn.setAttribute('aria-pressed', String(soundMuted));
      const label = soundMuted ? '取消静音' : '静音';
      muteBtn.title = label;
      muteBtn.setAttribute('aria-label', label);
    }
    renderMuteButton();

    if (muteBtn) {
      muteBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        soundMuted = !soundMuted;
        try {
          window.localStorage.setItem('ownflick-muted', soundMuted ? '1' : '0');
        } catch (error) {
          // Private mode or full storage: keep the in-session state.
        }
        const video = currentVideo();
        if (video) video.muted = soundMuted;
        soundPromptDismissed = true;
        hideSoundPrompt();
        renderMuteButton();
        showHud(soundMuted ? '已静音' : '声音已开启', 1200);
      });
    }

    // A1 免点击起播：浏览器只保证「静音自动播放」。有声偏好在首个用户手势后
    // 升级为有声；起播路径永不因自动播放策略而阻塞。
    let hasUserGesture = false;
    let soundPromptDismissed = false;
    const soundPrompt = document.getElementById('sound-prompt');

    function hideSoundPrompt() {
      if (soundPrompt) soundPrompt.hidden = true;
    }

    function showSoundPrompt() {
      if (!soundPrompt || soundPromptDismissed || !soundPrompt.hidden) return;
      soundPrompt.hidden = false;
      clearTimeout(showSoundPrompt._timer);
      showSoundPrompt._timer = setTimeout(hideSoundPrompt, 8000);
    }

    function upgradeToSoundIfPreferred() {
      if (soundMuted) return;
      const video = currentVideo();
      if (video && video.muted) {
        video.muted = false;
        renderMuteButton();
      }
      hideSoundPrompt();
    }

    function markUserGesture() {
      if (hasUserGesture) return;
      hasUserGesture = true;
      upgradeToSoundIfPreferred();
    }
    document.addEventListener('pointerdown', markUserGesture, { capture: true, passive: true });
    document.addEventListener('keydown', markUserGesture, { capture: true, passive: true });

    if (soundPrompt) {
      soundPrompt.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        soundMuted = false;
        try {
          window.localStorage.setItem('ownflick-muted', '0');
        } catch (error) {
          // Private mode or full storage: keep the in-session state.
        }
        soundPromptDismissed = true;
        upgradeToSoundIfPreferred();
        renderMuteButton();
        showHud('声音已开启', 1200);
      });
    }

    // R1：信息流不再显示文案、文件夹信息与音乐转盘（信息层已下线）。

    // R3：右侧控件抽屉——默认收起为把手，点击弹出/收起；打开时 scrim 吞掉外部点击。
    const drawerToggle = document.getElementById('controls-drawer-toggle');
    const drawerScrim = document.getElementById('controls-drawer-scrim');

    function setDrawer(open) {
      document.body.classList.toggle('drawer-open', open);
      if (drawerToggle) {
        drawerToggle.setAttribute('aria-expanded', String(open));
        drawerToggle.setAttribute('aria-label', open ? '收起工具栏' : '展开工具栏');
      }
      if (drawerScrim) drawerScrim.hidden = !open;
    }

    if (drawerToggle) {
      drawerToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        setDrawer(!document.body.classList.contains('drawer-open'));
      });
    }
    if (drawerScrim) {
      // 吞掉整次点击：收起抽屉但不透传给舞台手势（避免误触播放/暂停）。
      ['pointerdown', 'pointerup', 'click', 'dblclick', 'touchstart', 'touchend'].forEach((type) => {
        drawerScrim.addEventListener(type, (event) => {
          event.preventDefault();
          event.stopPropagation();
        }, { passive: false });
      });
      drawerScrim.addEventListener('pointerdown', () => setDrawer(false));
    }

    // 入口按钮闲置淡出：3 秒无交互降至 30%；有交互立即恢复。
    let idleTimer = null;
    function armIdleFade() {
      clearTimeout(idleTimer);
      document.body.classList.remove('controls-idle');
      idleTimer = setTimeout(() => {
        if (!document.body.classList.contains('drawer-open')) {
          document.body.classList.add('controls-idle');
        }
      }, 3000);
    }
    ['pointerdown', 'pointermove', 'touchstart', 'click'].forEach((type) => {
      window.addEventListener(type, armIdleFade, { passive: true });
    });
    armIdleFade();

    const collections = (collectionBtn && window.SpoolyCollections && window.SpoolyCollections.createPicker)
      ? window.SpoolyCollections.createPicker({
          button: collectionBtn,
          countEl: document.getElementById('collection-count'),
          modal: document.getElementById('collection-modal'),
          closeBtn: document.getElementById('collection-modal-close'),
          meta: document.getElementById('collection-modal-meta'),
          createBtn: document.getElementById('collection-create-btn'),
          nameInput: document.getElementById('collection-name-input'),
          list: document.getElementById('collection-list'),
          itemClass: 'collection-modal-item',
          emptyClass: 'collection-modal-empty',
          currentUri: () => String(currentItem()?.name || ''),
        })
      : { isOpen: () => false, close: () => {}, sync: () => {} };

    // R1：信息流不显示标题/标签面板，caption 回调全部 noop（生成能力保留在详情页）。
    const mediaActions = window.createFlowMediaActionsController({
      actions: actionsShared,
      onCaptionClear: () => {},
      onCaptionRender: () => {},
      onCaptionLoading: () => {},
      onError: () => {},
      confirmCaptionReplace: () => Promise.resolve(true),
    });


    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function isCollectionPlaylistOpen() {
      return !!collectionPlaylist && !collectionPlaylist.hidden;
    }

    function closeCollectionPlaylist() {
      if (!collectionPlaylist || collectionPlaylist.hidden) return;
      collectionPlaylist.classList.remove('is-open');
      collectionPlaylist.hidden = true;
      collectionPlaylist.setAttribute('aria-hidden', 'true');
      if (collectionPlaybackOpen) collectionPlaybackOpen.focus({ preventScroll: true });
    }

    function updateCollectionPosition() {
      if (!collectionScopeId || !collectionPlaybackCount) return;
      const total = Number(flowCollection?.item_count) || feedItems.length || 1;
      const position = Math.min(getCurrentIndex() + 1, total);
      collectionPlaybackCount.textContent = `${position} / ${total}`;
    }

    function renderCollectionPlaylist() {
      if (!collectionPlaylistItems) return;
      const current = getCurrentIndex();
      if (!feedItems.length) {
        collectionPlaylistItems.innerHTML = '<div class="collection-playlist-empty">合集里还没有可播放内容。</div>';
      } else {
        collectionPlaylistItems.innerHTML = feedItems.map((item, index) => {
          const active = index === current ? ' aria-current="true"' : '';
          const thumb = item.thumb_url
            ? `<img src="${item.thumb_url}" alt="" loading="lazy">`
            : '<i data-feather="film"></i>';
          const fullName = String(item.name || '').split('/').pop();
          const shownName = window.SpoolyCaption ? window.SpoolyCaption.display(item.name) : fullName;
          const label = escapeHtml(`${index + 1}. ${shownName}`);
          return `<button type="button" class="collection-playlist-item"${active} data-index="${index}" title="${escapeHtml(fullName)}">`
            + `<span class="collection-playlist-thumb">${thumb}</span>`
            + '<span class="collection-playlist-copy">'
            + `<strong>${label}</strong>`
            + `<span>${item.type === 'video' ? '视频' : '图片'}</span></span></button>`;
        }).join('');
        if (window.feather) window.feather.replace();
      }
      if (collectionPlaylistTitle) collectionPlaylistTitle.textContent = String(flowCollection?.name || '合集');
      if (collectionPlaylistMeta) {
        collectionPlaylistMeta.textContent = `已加载 ${feedItems.length} / ${Number(flowCollection?.item_count) || feedItems.length} 条`;
      }
      if (collectionPlaylistMore) collectionPlaylistMore.hidden = !flowSession.hasMore();
    }

    function openCollectionPlaylist() {
      if (!collectionPlaylist) return;
      renderCollectionPlaylist();
      collectionPlaylist.hidden = false;
      collectionPlaylist.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => collectionPlaylist.classList.add('is-open'));
      if (collectionPlaylistClose) collectionPlaylistClose.focus({ preventScroll: true });
    }

    if (collectionPlaybackOpen) {
      collectionPlaybackOpen.addEventListener('click', (event) => {
        event.stopPropagation();
        openCollectionPlaylist();
      });
    }
    if (collectionPlaylistClose) {
      collectionPlaylistClose.addEventListener('click', (event) => {
        event.stopPropagation();
        closeCollectionPlaylist();
      });
    }
    if (collectionPlaylist) {
      collectionPlaylist.addEventListener('click', (event) => {
        if (event.target === collectionPlaylist) closeCollectionPlaylist();
      });
    }
    if (collectionPlaylistItems) {
      collectionPlaylistItems.addEventListener('click', async (event) => {
        const tile = event.target.closest('[data-index]');
        if (!tile) return;
        const index = Number(tile.getAttribute('data-index'));
        if (!Number.isInteger(index)) return;
        closeCollectionPlaylist();
        await showItem(index);
      });
    }
    if (collectionPlaylistMore) {
      collectionPlaylistMore.addEventListener('click', async () => {
        collectionPlaylistMore.disabled = true;
        try {
          await loadFeed();
          renderCollectionPlaylist();
        } finally {
          collectionPlaylistMore.disabled = false;
        }
      });
    }

    function saveCurrentSession(force = false) {
      // Scoped playback (collection / folder) never overwrites the full-flow resume.
      if (collectionScopeId || folderScopeUri) return;
      const item = currentItem();
      if (!item || !seed || !['video', 'image'].includes(item.type)) return;
      const video = item.type === 'video' ? item.el : null;
      if (restoring && savedSession?.uri === item.name && video && !video._localResumeReady) return;
      if (!force && Date.now() - lastSessionSave < 1000) return;
      let position = 0;
      let duration = 0;
      if (video) {
        if (video.readyState >= 1 && Number.isFinite(video.duration)) {
          position = Number(video.currentTime) || 0;
          duration = video.duration;
        } else {
          position = Number(video._resumePosition) || 0;
        }
      }
      persistence.save({ seed, avoidUri, uri: item.name, type: item.type, position, duration });
      lastSessionSave = Date.now();
    }

    async function startNewRound() {
      if (roundLoading) return;
      roundLoading = true;
      const previousName = currentItem()?.name || savedSession?.uri || '';
      saveCurrentSession(true);
      feedEpoch += 1;
      feedAbort.abort();
      feedAbort = new AbortController();
      videoActivationId += 1;
      clearTimeout(skipTimer);
      postActivity([finishActivity()]);
      clearPreviousState(currentItem());
      feedItems.forEach(disposeMedia);
      pager = null;
      settling = false;
      flowSession.reset({ index: -1, hasMore: true, cursor: { page: 1, after: '' } });
      seed = '';
      avoidUri = previousName;
      savedSession = null;
      restoreTarget = '';
      restoring = false;
      hideVideoStartCover();
      try {
        await loadFeed();
        if (feedItems.length) await showItem(0);
      } finally {
        roundLoading = false;
      }
    }

    async function goNext() {
      if (getCurrentIndex() >= feedItems.length - 1 && flowSession.hasMore()) {
        if (flowSession.isLoading()) await new Promise((resolve) => feedLoadWaiters.push(resolve));
        if (getCurrentIndex() >= feedItems.length - 1 && flowSession.hasMore()) await loadFeed();
      }
      if (getCurrentIndex() >= feedItems.length - 1 && !flowSession.hasMore() && feedItems.length) {
        if (collectionScopeId) {
          showHud('合集已播完', 1600);
          return;
        }
        if (folderScopeUri) {
          showHud('文件夹已播完', 1600);
          return;
        }
        await startNewRound();
        return;
      }
      slidePage(1);
    }

    function goPrev() {
      if (isDragging || settling || pager) return;
      slidePage(-1);
    }

    // Paging moves the current item and its neighbour together, so a swipe follows the finger.
    const pageEase = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pager = null;
    let settling = false;

    function setPeek(item, visible) {
      if (!item) return;
      item.el.classList.toggle('active', visible);
      item.el.style.display = visible ? 'block' : 'none';
      item.el.style.removeProperty('transition');
      item.el.style.translate = '';
    }

    function placePage(offset, duration = 0) {
      const transition = duration ? `translate ${duration}ms ${pageEase}` : 'none';
      const height = feedContainer.clientHeight;
      [currentItem()?.el, videoStartCover].forEach((el) => {
        if (!el) return;
        // Inline !important: the global stylesheet disables transitions on img/video.
        el.style.setProperty('transition', transition, 'important');
        el.style.translate = `0 ${offset}px`;
      });
      if (pager?.peer) {
        pager.peer.el.style.setProperty('transition', transition, 'important');
        pager.peer.el.style.translate = `0 ${offset + pager.dir * height}px`;
      }
    }

    function beginPage(dir) {
      const index = getCurrentIndex() + dir;
      const peer = feedItems[index] || null;
      if (pager?.peer && pager.peer !== peer) setPeek(pager.peer, false);
      pager = { dir, index, peer };
      if (peer) setPeek(peer, true);
    }

    function settlePage(commit, offset) {
      if (!pager) return;
      const { index, peer, dir } = pager;
      const height = feedContainer.clientHeight;
      const moving = commit && !!peer;
      const target = moving ? -dir * height : 0;
      const distance = Math.abs(target - offset) / Math.max(height, 1);
      const duration = reduceMotion.matches ? 0 : Math.round(Math.min(340, Math.max(170, distance * 380)));
      settling = true;
      const transitionEpoch = feedEpoch;
      const transitionPager = pager;
      if (duration) placePage(target, duration);
      window.setTimeout(() => {
        if (transitionEpoch !== feedEpoch || pager !== transitionPager) return;
        [currentItem()?.el, videoStartCover].forEach((el) => {
          if (!el) return;
          el.style.removeProperty('transition');
          el.style.translate = '';
        });
        if (moving) {
          peer.el.style.removeProperty('transition');
          peer.el.style.translate = '';
        } else {
          setPeek(peer, false);
        }
        pager = null;
        settling = false;
        if (moving) showItem(index);
        else if (commit && dir > 0 && index >= feedItems.length) void goNext();
      }, duration);
    }

    function slidePage(dir) {
      if (isDragging || settling || pager || !feedItems[getCurrentIndex() + dir]) return;
      beginPage(dir);
      placePage(0);
      void feedContainer.offsetHeight;
      settlePage(true, 0);
    }

    function goGroupNext() {
      const item = currentItem();
      if (!item || item.type !== 'image_group' || typeof item.renderChild !== 'function') return false;
      const entries = Array.isArray(item.items) ? item.items : [];
      const nextIndex = (Number(item.activeChildIndex) || 0) + 1;
      if (nextIndex >= entries.length) return false;
      const previousActivity = finishActivity();
      item.activeChildIndex = item.renderChild(nextIndex);
      postActivity([previousActivity, beginActivity(item)]);
      return true;
    }

    function goGroupPrev() {
      const item = currentItem();
      if (!item || item.type !== 'image_group' || typeof item.renderChild !== 'function') return false;
      const nextIndex = (Number(item.activeChildIndex) || 0) - 1;
      if (nextIndex < 0) return false;
      const previousActivity = finishActivity();
      item.activeChildIndex = item.renderChild(nextIndex);
      postActivity([previousActivity, beginActivity(item)]);
      return true;
    }

    const reactions = window.createFlowReactionsController({
      setReaction: actionsShared.setMediaReaction,
      onChange: (state, name, meta) => {
        [[likeBtn, state.is_liked, state.likePending, '点赞'],
          [favoriteBtn, state.is_favorited, state.favoritePending, '收藏']].forEach(([button, value, pending, label]) => {
          if (button.dataset.value !== name) return;
          button.classList.toggle('is-active', value);
          button.disabled = !name || pending;
          button.setAttribute('aria-pressed', String(value));
          button.setAttribute('aria-busy', String(pending));
          button.title = value ? `取消${label}` : label;
          button.setAttribute('aria-label', button.title);
        });

      },
    });

    function updateControls(item) {
      const isVideo = item.type === 'video';
      const isImageGroup = item.type === 'image_group';
      const displayEntry = currentDisplayEntry();
      speedWrap.hidden = !isVideo;
      closeSpeedChoices();
      magnifierToolWrap.hidden = isImageGroup;
      customControls.hidden = !isVideo;

      const detailUrl = String(displayEntry?.detail_url || item.detail_url || '#');
      const mediaName = String(displayEntry?.name || item.name || '');
      infoBtn.href = detailUrl;
      likeBtn.dataset.value = mediaName;
      favoriteBtn.dataset.value = mediaName;
      reactions.show(mediaName);
      if (mediaName) {
        collections.sync(mediaName);
      }

      if (isVideo) {
        progressControls.sync(item.el);
        playStatusIcon.classList.remove('hidden');
      } else {
        progressBar.disabled = true;
        progressBar.value = 0;
        progressFill.style.width = '0%';
        timeCurrent.textContent = '';
        timeTotal.textContent = '';
        playStatusIcon.classList.add('hidden');
        playStatusIcon.classList.remove('visible');
      }
    }

    function ensureVideoSrc(videoEl) {
      if (!videoEl) return;
      if (!videoEl.getAttribute('src')) {
        videoEl.src = videoEl.dataset.src || '';
        videoEl.load();
      }
    }

    function waitForVideoState(videoEl, eventNames, condition, signal, timeoutMs = 12000) {
      if (signal?.aborted) return Promise.reject(new DOMException('Playback preparation cancelled', 'AbortError'));
      if (condition()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        let timeoutId = null;
        const names = Array.isArray(eventNames) ? eventNames : [eventNames];
        const cleanup = () => {
          names.forEach((name) => videoEl.removeEventListener(name, onStateChange));
          videoEl.removeEventListener('error', onError);
          signal?.removeEventListener('abort', onAbort);
          clearTimeout(timeoutId);
        };
        const onStateChange = () => {
          if (!condition()) return;
          cleanup();
          resolve();
        };
        const onError = () => {
          cleanup();
          reject(new Error('Video failed while preparing playback'));
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException('Playback preparation cancelled', 'AbortError'));
        };
        names.forEach((name) => videoEl.addEventListener(name, onStateChange));
        videoEl.addEventListener('error', onError, { once: true });
        signal?.addEventListener('abort', onAbort, { once: true });
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Timed out while preparing playback'));
        }, timeoutMs);
      });
    }

    function prepareVideoStart(videoEl) {
      if (!videoEl) return Promise.reject(new Error('Missing video element'));
      if (isVideoStartReady(videoEl)) return Promise.resolve(videoEl);
      if (videoEl._startPromise) return videoEl._startPromise;

      const controller = new AbortController();
      const { signal } = controller;
      videoEl._startController = controller;
      videoEl._startReady = false;
      videoEl.preload = 'auto';
      ensureVideoSrc(videoEl);
      const preparation = (async () => {
        if (videoEl._resumePosition > 0) {
          await waitForVideoState(videoEl, 'loadedmetadata', () => videoEl.readyState >= 1, signal);
          if (Number.isFinite(videoEl.duration) && videoEl._resumePosition < videoEl.duration) {
            videoEl.currentTime = videoEl._resumePosition;
          }
        }
        await waitForVideoState(
          videoEl,
          ['loadeddata', 'canplay', 'seeked'],
          () => videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !videoEl.seeking,
          signal,
        );
        if (signal.aborted) throw new DOMException('Playback preparation cancelled', 'AbortError');
        videoEl._startReady = true;
        videoEl._resumePosition = null;
        videoEl._activityLastPosition = videoEl.currentTime;
        // Keep the active clip buffering; speculative clips only need a first frame.
        videoEl.preload = currentVideo() === videoEl ? 'auto' : 'metadata';
        return videoEl;
      })().finally(() => {
        if (videoEl._startController !== controller) return;
        videoEl._startController = null;
        videoEl._startPromise = null;
      });
      videoEl._startPromise = preparation;
      return preparation;
    }

    function releaseVideo(videoEl) {
      videoEl._startController?.abort();
      videoEl._startController = null;
      videoEl._startPromise = null;
      if (!videoEl.getAttribute('src')) return;
      if (videoEl.readyState >= 1 && Number.isFinite(videoEl.currentTime)) {
        videoEl._resumePosition = videoEl.currentTime;
      }
      videoEl.pause();
      videoEl.muted = true;
      videoEl._startReady = false;
      videoEl._loadFailed = false;
      videoEl.preload = 'none';
      videoEl.removeAttribute('src');
      videoEl.removeAttribute('poster');
      // Resetting the element stops outstanding requests and releases its decoder.
      videoEl.load();
    }

    function disposeMedia(item) {
      if (item.type === 'video') releaseVideo(item.el);
      item.el.remove();
    }

    function syncMediaWindow() {
      const index = getCurrentIndex();
      const speculative = canPreloadMedia();
      const keepVideos = new Set([index]);
      if (speculative) {
        // Back: one nearby video for smooth rewind. Forward: up to five videos so
        // swiping ahead stays instant (metadata-only weight for +2 and beyond).
        for (let distance = 1; distance <= 2; distance++) {
          const neighbor = index - distance;
          if (feedItems[neighbor]?.type !== 'video') continue;
          keepVideos.add(neighbor);
          break;
        }
        let ahead = 0;
        for (let distance = 1; ahead < 5 && index + distance < feedItems.length; distance++) {
          const neighbor = index + distance;
          if (feedItems[neighbor]?.type !== 'video') continue;
          keepVideos.add(neighbor);
          ahead += 1;
        }
      }
      feedItems.forEach((entry, itemIndex) => {
        if (entry.type === 'video') {
          if (!keepVideos.has(itemIndex)) releaseVideo(entry.el);
          else if (entry.el.dataset.poster && !entry.el.getAttribute('poster')) entry.el.poster = entry.el.dataset.poster;
          return;
        }
        const nearby = itemIndex === index || (speculative && Math.abs(itemIndex - index) === 1);
        if (entry.type === 'image') {
          if (nearby) {
            entry.el.loading = 'eager';
            entry.el.fetchPriority = itemIndex === index ? 'high' : 'low';
            if (!entry.el.getAttribute('src')) entry.el.src = entry.el.dataset.src;
          } else if (entry.el.getAttribute('src')) {
            entry.el.removeAttribute('src');
          }
        } else if (entry.type === 'image_group') {
          if (nearby) entry.renderChild?.(Number(entry.activeChildIndex) || 0);
          else entry.el.querySelector('.image-group-stage')?.replaceChildren();
        }
      });
    }

    function preloadNextVideo() {
      clearTimeout(preloadTimer);
      if (!canPreloadMedia()) return;
      const active = currentVideo();
      if (active && (active.paused || active.readyState < HTMLMediaElement.HAVE_FUTURE_DATA || active.seeking)) return;
      const activationId = videoActivationId;
      preloadTimer = setTimeout(() => {
        preloadTimer = null;
        if (activationId !== videoActivationId || !canPreloadMedia()) return;
        // A2+：+1 预热首帧（prepareVideoStart），+2~+5 挂载源并仅拉取元数据，
        // 刷到即有缓冲起点，大幅提升连续上滑的流畅度。
        let prepared = 0;
        for (let i = getCurrentIndex() + 1; i < feedItems.length && prepared < 5; i++) {
          const item = feedItems[i];
          if (item?.type !== 'video') continue;
          if (prepared === 0) {
            prepareVideoStart(item.el).catch(() => {});
          } else {
            item.el.preload = 'metadata';
            ensureVideoSrc(item.el);
          }
          prepared += 1;
        }
      }, 160);
    }

    function waitForPresentedVideoFrame(videoEl, timeoutMs = 350) {
      if (typeof videoEl.requestVideoFrameCallback !== 'function') return Promise.resolve();
      return new Promise((resolve) => {
        let settled = false;
        let frameId = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          if (frameId !== null) videoEl.cancelVideoFrameCallback?.(frameId);
          resolve();
        };
        const timeoutId = setTimeout(finish, timeoutMs);
        frameId = videoEl.requestVideoFrameCallback(finish);
      });
    }

    function stopProgressLoop() {
      if (progressFrame !== null) cancelAnimationFrame(progressFrame);
      progressFrame = null;
    }

    function startProgressLoop() {
      if (progressFrame !== null) return;
      const paint = (now) => {
        progressFrame = null;
        const video = currentVideo();
        if (!video || video.paused || document.hidden || pageSuspended) return;
        // A 30 Hz progress bar stays smooth without rewriting the controls every frame.
        if (now - lastProgressPaint >= 32) {
          updateVideoProgress(video);
          lastProgressPaint = now;
        }
        progressFrame = requestAnimationFrame(paint);
      };
      progressFrame = requestAnimationFrame(paint);
    }

    function updateVideoProgress(videoEl) {
      if (gesture?.mode === 'scrub') return;
      progressControls.sync(videoEl);
    }

    function updatePlaybackIndicator(videoEl = currentVideo()) {
      if (!videoEl || currentVideo() !== videoEl) return;
      playStatusIcon.classList.toggle('visible', videoEl.paused && !isDragging);
    }

    function currentDisplayEntry() {
      const item = currentItem();
      if (!item) return null;
      if (item.type === 'image_group') {
        const entries = Array.isArray(item.items) ? item.items : [];
        const idx = Math.max(0, Math.min(Number(item.activeChildIndex) || 0, entries.length - 1));
        return entries[idx] || null;
      }
      return item;
    }

    function clearPreviousState(prevItem) {
      stopProgressLoop();
      clearTimeout(preloadTimer);
      progressControls.cancel();
      cancelStageGesture();
      magnifier.toggle(false);
      closeSpeedMenu();

      if (!prevItem) return;
      prevItem.el.classList.remove('active');
      prevItem.el.style.display = 'none';
      if (prevItem.type === 'video') {
        prevItem.el.pause();
        prevItem.el.muted = true;
      }
    }

    async function activateVideo(item, activationId) {
      const video = item.el;
      const isCurrent = () => activationId === videoActivationId && currentVideo() === video;
      const canStart = () => isCurrent() && !document.hidden && !pageSuspended;
      if (!isCurrent()) return false;
      // Retain pending starts as well as playing clips across a hidden page.
      resumeOnVisible = video;
      if (!canStart()) return false;
      if (video._loadFailed) handleMediaFailure(video);
      video.preload = 'auto';
      video.playbackRate = speedRate;
      mediaActions.clearCaption();

      try {
        await prepareVideoStart(video);
      } catch (error) {
        if (error.name === 'AbortError' || !canStart()) return false;
        if (video._loadFailed) handleMediaFailure(video);
      }
      if (!canStart()) return false;
      // A1：有声偏好但尚无用户手势时先静音起播，首手势后自动升级有声。
      const startMuted = soundMuted || !hasUserGesture;
      video.muted = startMuted;
      try {
        const playPromise = video.play();
        if (playPromise !== undefined) await playPromise;
      } catch (error) {
        if (!canStart()) return false;
        // 兜底：强制静音重试一次；仍失败才提示手动点击播放。
        video.muted = true;
        try {
          const retry = video.play();
          if (retry !== undefined) await retry;
        } catch (retryError) {
          playStatusIcon.classList.add('visible');
          showHud('点击画面开始播放', 2400);
          resumeOnVisible = null;
          hideVideoStartCover();
          return true;
        }
      }
      await waitForPresentedVideoFrame(video);
      if (!canStart()) return false;
      playStatusIcon.classList.remove('visible');
      if (!soundMuted && video.muted) showSoundPrompt();
      resumeOnVisible = null;
      hideVideoStartCover();
      return true;
    }

    async function showItem(nextIndex) {
      if (!feedItems.length) return;
      const safeIndex = Math.max(0, Math.min(nextIndex, feedItems.length - 1));
      const prevItem = currentItem();
      if (safeIndex !== getCurrentIndex()) lastStep = safeIndex < getCurrentIndex() ? -1 : 1;
      clearTimeout(skipTimer);
      skipTimer = null;
      saveCurrentSession(true);
      const previousActivity = finishActivity();
      clearPreviousState(prevItem);

      flowSession.setIndex(safeIndex);
      updateCollectionPosition();
      const item = currentItem();
      if (!item) return;
      const activationId = ++videoActivationId;
      postActivity([previousActivity, beginActivity(item)]);
      if (item.type !== 'video' || item.name !== savedSession?.uri) restoring = false;
      saveCurrentSession(true);
      flowState.onMediaChanged();

      const needsVideoStartCover = item.type === 'video' && !isVideoStartReady(item.el);
      if (needsVideoStartCover) showVideoStartCover(item);
      else hideVideoStartCover();

      item.el.style.display = 'block';
      requestAnimationFrame(() => {
        if (activationId === videoActivationId && currentItem() === item) item.el.classList.add('active');
      });
      updateControls(item);
      syncMediaWindow();

      if (item.type === 'video') {
        if (!(await activateVideo(item, activationId))) return;
      } else if (item.type === 'image_group') {
        mediaActions.clearCaption();
        if (typeof item.renderChild === 'function') {
          item.activeChildIndex = item.renderChild(Number(item.activeChildIndex) || 0);
        }
        playStatusIcon.classList.add('hidden');
        playStatusIcon.classList.remove('visible');
      } else {
        playStatusIcon.classList.remove('visible');
        mediaActions.clearCaption();
        if (item.el._loadFailed) handleMediaFailure(item.el);
      }

      preloadNextVideo();
      if (getCurrentIndex() >= feedItems.length - 4 && flowSession.hasMore()) {
        loadFeed();
      }
    }

    function buildMediaElement(item) {
      if (item.type === 'image_group') {
        const panel = document.createElement('section');
        panel.className = 'feed-media feed-image-group';
        panel.dataset.name = item.name;
        panel.innerHTML = `
          <div class="image-group-stage"></div>
          <div class="image-group-overlay">
            ${item.caption ? `<span>${escapeHtml(item.caption)}</span>` : ''}
            <span class="image-group-counter"></span>
          </div>
        `;
        const stage = panel.querySelector('.image-group-stage');
        const counterEl = panel.querySelector('.image-group-counter');
        const children = Array.isArray(item.items) ? item.items : [];

        function renderImageGroup(index, force = false) {
          if (!stage || !counterEl || !children.length) return;
          const safeIndex = Math.max(0, Math.min(index, children.length - 1));
          const entry = children[safeIndex];
          if (!entry || !entry.media_url) return;
          const previousIndex = Number(panel._activeChildIndex);
          const direction = Number.isFinite(previousIndex) && safeIndex < previousIndex ? -1 : 1;
          const previousMedia = stage.querySelector('.image-group-media');
          const img = document.createElement('img');
          img.className = 'image-group-media';
          img.addEventListener('error', () => handleMediaFailure(panel));
          img.src = force
            ? `${entry.media_url}${entry.media_url.includes('?') ? '&' : '?'}retry=${Date.now()}`
            : entry.media_url;
          img.alt = entry.name || '';
          img.loading = 'eager';
          img.decoding = 'async';
          img.style.opacity = '0';
          img.style.transform = `translateX(${direction * 18}px)`;
          stage.appendChild(img);
          requestAnimationFrame(() => {
            img.style.opacity = '1';
            img.style.transform = 'translateX(0)';
            if (previousMedia) {
              previousMedia.style.opacity = '0';
              previousMedia.style.transform = `translateX(${direction * -12}px)`;
            }
          });
          if (previousMedia) {
            window.setTimeout(() => {
              if (previousMedia.parentNode === stage) previousMedia.remove();
            }, 220);
          }
          panel._activeChildIndex = safeIndex;
          counterEl.textContent = `${safeIndex + 1} / ${children.length}`;
          if (currentItem()?.el === panel) {
            currentItem().activeChildIndex = safeIndex;
            updateControls(currentItem());
          }
        }

        panel._renderImageGroup = renderImageGroup;
        panel._activeChildIndex = 0;
        renderImageGroup(0);
        return panel;
      }

      if (item.type === 'video') {
        const video = document.createElement('video');
        video.className = 'feed-media feed-video';
        video.muted = true;
        video.volume = volumeLevel;
        video.loop = true;
        video.playsInline = true;
        video.controls = false;
        video.preload = 'metadata';
        if (item.thumb_url) {
          video.poster = item.thumb_url;
          video.dataset.poster = item.thumb_url;
        }
        video.dataset.src = item.media_url;
        video.dataset.name = item.name;
        const resumePosition = restoring && savedSession?.uri === item.name ? savedSession.position : 0;
        window.SpoolyResume.trackLocal(video, {
          position: resumePosition,
          onReady: () => {
            if (currentVideo() === video && savedSession?.uri === item.name) restoring = false;
          },
          onSample: ({ force }) => {
            if (currentVideo() === video) saveCurrentSession(force);
          },
        });
        video.addEventListener('error', () => {
          video._loadFailed = true;
          handleMediaFailure(video);
        });
        video.addEventListener('loadeddata', () => {
          video._loadFailed = false;
        });
        video.addEventListener('playing', () => {
          quietSkips = 0;
        });
        video.addEventListener('timeupdate', () => {
          updateVideoProgress(video);
          const duration = Number(video.duration || 0);
          const current = Number(video.currentTime || 0);
          const previous = video._activityLastPosition;
          const playedDelta = current - previous;
          if (Number.isFinite(previous) && playedDelta > 0 && playedDelta <= 2.5) {
            video._activityPlayedSeconds = Number(video._activityPlayedSeconds || 0) + playedDelta;
          }
          video._activityLastPosition = current;
          if (duration > 0 && previous > duration * 0.85 && current < 1.5) {
            video._completedInView = true;
            postActivity([{
              session_id: activitySessionId,
              uri: item.name,
              media_type: 'video',
              surface: 'flow',
              event: 'replay',
            }]);
          }
          video._lastActivityTime = current;
        });
        const updateDuration = () => updateVideoProgress(video);
        video.addEventListener('loadedmetadata', updateDuration);
        video.addEventListener('durationchange', updateDuration);
        video.addEventListener('play', () => {
          updatePlaybackIndicator(video);
          magnifier.onVideoPlay(video);
        });
        video.addEventListener('pause', () => updatePlaybackIndicator(video));
        video.addEventListener('seeked', () => magnifier.onVideoSeeked(video));
        return video;
      }

      const img = document.createElement('img');
      img.className = 'feed-media feed-image';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = item.name;
      img.addEventListener('error', () => {
        img._loadFailed = true;
        handleMediaFailure(img);
      });
      img.addEventListener('load', () => {
        img._loadFailed = false;
        quietSkips = 0;
      });
      img.dataset.src = item.media_url;
      img.dataset.name = item.name;
      return img;
    }

    async function requestFeedPage(cursor, epoch) {
      if (folderScopeUri) {
        const offset = Number(cursor?.offset) || 0;
        const query = new URLSearchParams({
          folder: folderScopeUri, recursive: 'true', order: 'random',
          offset: String(offset), limit: '24',
        });
        if (folderSeed) query.set('seed', folderSeed);
        const res = await fetch(`/api/feed?${query}`, { signal: feedAbort.signal });
        const data = await res.json();
        if (epoch !== feedEpoch) throw new DOMException('旧轮次请求已取消', 'AbortError');
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const page = data?.data;
        if (!page || !Array.isArray(page.items)) throw new Error('文件夹内容响应无效');
        if (!folderSeed && page.seed) folderSeed = String(page.seed);
        return {
          items: page.items,
          has_more: page.has_more === true,
          next_offset: Number(page.next_offset) || (offset + page.items.length),
          seed: 'folder',
        };
      }
      if (collectionScopeId) {
        const offset = Number(cursor?.offset) || 0;
        const query = new URLSearchParams({ offset: String(offset), limit: '24' });
        const res = await fetch(`/api/collections/${encodeURIComponent(collectionScopeId)}/flow?${query}`, { signal: feedAbort.signal });
        const data = await res.json();
        if (epoch !== feedEpoch) throw new DOMException('旧轮次请求已取消', 'AbortError');
        if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
        const page = data?.data;
        if (!page || !Array.isArray(page.items)) throw new Error('合集内容响应无效');
        return {
          items: page.items,
          has_more: page.has_more === true,
          next_offset: Number(page.next_offset) || (offset + page.items.length),
          seed: 'collection',
        };
      }
      const query = new URLSearchParams({ size: '24' });
      if (seed) query.set('seed', seed);
      if (avoidUri) query.set('avoid_uri', avoidUri);
      if (cursor?.after) query.set('after', cursor.after);
      else if (restoreTarget) query.set('resume_uri', restoreTarget);
      const res = await fetch(`/api/feed/mix?${query}`, { signal: feedAbort.signal });
      const data = await res.json();
      if (epoch !== feedEpoch) throw new DOMException('旧轮次请求已取消', 'AbortError');
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      if (!Array.isArray(data.items) || typeof data.seed !== 'string') throw new Error('信息流响应无效');
      if (!seed) seed = data.seed;
      if (restoreTarget && !data.resume_found) {
        restoring = false;
        savedSession = null;
      }
      restoreTarget = '';
      return data;
    }

    async function loadFeed() {
      if (flowSession.isLoading() || !flowSession.hasMore()) return;
      const isInitialLoad = feedItems.length === 0;
      const epoch = feedEpoch;
      if (isInitialLoad) scheduleFlowLoadingStatus();
      try {
        const result = await flowSession.loadMore(async (cursor) => {
          const data = await requestFeedPage(cursor, epoch);
          const incoming = data.items;
          reactions.hydrate(incoming);
          const normalized = incoming.map((item) => {
            if (!item || !item.type || !item.name) return null;
            const mediaEl = buildMediaElement(item);
            if (!mediaEl) return null;
            return {
              type: item.type,
              name: item.name,
              media_url: item.media_url || '',
              detail_url: item.detail_url || '#',
              thumb_url: item.thumb_url || '',
              items: Array.isArray(item.items) ? item.items : [],
              renderChild: typeof mediaEl._renderImageGroup === 'function' ? (index, force = false) => {
                mediaEl._renderImageGroup(index, force);
                return Number(mediaEl._activeChildIndex) || 0;
              } : null,
              activeChildIndex: Number(mediaEl._activeChildIndex) || 0,
              el: mediaEl,
            };
          }).filter(Boolean);

          return {
            items: normalized,
            hasMore: data.has_more !== false,
            cursor: (collectionScopeId || folderScopeUri)
              ? { offset: Number(data.next_offset) || 0 }
              : { after: data.next_after || '', page: Number(cursor?.page || 1) + 1 },
          };
        });

        if (epoch !== feedEpoch || result.stale) return null;
        (result.appendedIndices || []).forEach((itemIndex) => {
          const entry = feedItems[itemIndex];
          if (entry?.el) feedContainer.appendChild(entry.el);
        });

        // A3 无限回看：超 300 条才丢弃最旧 100 条；丢弃后顶部提供「回到最新」。
        // 合集/文件夹 scoped 播放不丢弃（与现有 scoped 会话逻辑一致）。
        if (feedItems.length > 300 && !collectionScopeId && !folderScopeUri) {
          const removeCount = 100;
          const removed = flowSession.dropHead(removeCount);
          removed.forEach(disposeMedia);
          updateCollectionPosition();
          if (removed.length && backToLatestBtn) backToLatestBtn.hidden = false;
        }
        if (feedItems.length) {
          hideFlowStatus();
        } else if (!flowSession.hasMore()) {
          showFlowStatus('empty', '媒体库里还没有可播放内容', '前往媒体库导入图片和视频，或重新扫描媒体目录。');
        }
        return result;
      } catch (error) {
        if (epoch !== feedEpoch || error.name === 'AbortError') return null;
        clearTimeout(flowLoadingTimer);
        flowLoadingTimer = null;
        const reachedEnd = getCurrentIndex() >= feedItems.length - 1;
        if (isInitialLoad || reachedEnd) {
          showFlowStatus('error', '暂时无法加载媒体', '请重试，或前往媒体库检查文件和扫描状态。');
        }
        return null;
      } finally {
        if (!flowSession.isLoading()) feedLoadWaiters.splice(0).forEach((resolve) => resolve());
      }
    }

    function handleMediaFailure(mediaEl) {
      const item = currentItem();
      if (item?.el !== mediaEl || skipTimer) return;
      const code = mediaEl.error?.code;
      if (code === 1) return;
      if (code === 2 && !mediaEl._networkRetried) {
        mediaEl._networkRetried = true;
        retryCurrentMedia();
        return;
      }
      if (quietSkips >= maxQuietSkips) {
        showFlowStatus('media-error', '无法打开这个媒体', '文件可能已移动、离线，或格式不受浏览器支持。');
        return;
      }
      if (item.type === 'image_group') {
        showHud('无法显示这张图片', 1600);
        return;
      }
      quietSkips += 1;
      showHud(`无法播放这个${item.type === 'video' ? '视频' : '图片'}，已跳过`, 1600);
      skipTimer = setTimeout(() => {
        skipTimer = null;
        if (currentItem() !== item) return;
        if (lastStep < 0 && getCurrentIndex() > 0) goPrev();
        else goNext();
      }, 700);
    }

    async function retryCurrentMedia() {
      const item = currentItem();
      if (!item) return;
      hideFlowStatus();
      const retryUrl = `${item.media_url}${item.media_url.includes('?') ? '&' : '?'}retry=${Date.now()}`;
      if (item.type === 'video') {
        item.el.pause();
        item.el._loadFailed = false;
        item.el._startReady = false;
        item.el._startPromise = null;
        item.el.src = retryUrl;
        item.el.load();
        await showItem(getCurrentIndex());
      } else if (item.type === 'image') {
        item.el._loadFailed = false;
        item.el.src = retryUrl;
      } else if (item.type === 'image_group' && typeof item.renderChild === 'function') {
        item.activeChildIndex = item.renderChild(Number(item.activeChildIndex) || 0, true);
      }
    }

    async function retryFlowLoad() {
      flowSession.setHasMore(true);
      showFlowStatus('loading', '正在重新加载');
      const result = await loadFeed();
      if (result && feedItems.length && getCurrentIndex() < 0) {
        await showItem(0);
      }
    }

    function togglePlay() {
      const item = currentItem();
      if (!item || item.type !== 'video') return;
      const video = item.el;
      if (video.paused) {
        video.play();
        playStatusIcon.classList.remove('visible');
      } else {
        video.pause();
        playStatusIcon.classList.add('visible');
      }
    }

    function currentVideo() {
      const item = currentItem();
      return item?.type === 'video' ? item.el : null;
    }

    function showHud(text, holdMs = 0) {
      clearTimeout(hudTimer);
      hud.textContent = text;
      hud.classList.add('is-visible');
      if (holdMs) hudTimer = setTimeout(hideHud, holdMs);
    }

    function hideHud() {
      clearTimeout(hudTimer);
      hud.classList.remove('is-visible');
    }

    function seekLabel(from, to, duration) {
      const delta = Math.round(to - from);
      return `${delta < 0 ? '−' : '+'}${Math.abs(delta)}s · ${formatTime(to)} / ${formatTime(duration)}`;
    }

    function showSeekProgress(time, duration) {
      const pct = duration > 0 ? (time / duration) * 100 : 0;
      progressBar.value = pct;
      progressFill.style.width = `${pct}%`;
      timeCurrent.textContent = formatTime(time);
    }

    // B1: volume follows every slide; brightness paints only the playback stage.
    function applyVolume() {
      feedContainer.querySelectorAll('video.feed-video').forEach((video) => {
        video.volume = volumeLevel;
      });
    }

    function applyBrightness() {
      feedContainer.style.filter = brightnessLevel === 1 ? '' : `brightness(${brightnessLevel})`;
    }
    applyBrightness();

    function persistLevels() {
      try {
        window.localStorage.setItem('ownflick-volume', String(volumeLevel));
        window.localStorage.setItem('ownflick-brightness', String(brightnessLevel));
      } catch (error) {
        // Private mode or blocked storage: keep the in-session state.
      }
    }

    // B2: holding a video opens the speed menu instead of a fixed 2x boost.
    function openSpeedMenu() {
      if (!speedMenu) return;
      speedMenu.hidden = false;
      speedMenu.classList.add('show');
      navigator.vibrate?.(10);
    }

    function closeSpeedMenu() {
      if (!speedMenu) return;
      speedMenu.classList.remove('show');
      speedMenu.hidden = true;
    }

    function seekBy(seconds) {
      const video = currentVideo();
      const duration = Number(video?.duration);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const from = video.currentTime;
      const to = Math.max(0, Math.min(duration, from + seconds));
      video.currentTime = to;
      showSeekProgress(to, duration);
      showHud(seekLabel(from, to, duration), 900);
    }

    // Dragging sideways on a video moves through it relative to where the drag began.
    function beginScrub(state) {
      const video = currentVideo();
      state.mode = 'scrub';
      state.video = video;
      state.from = video.currentTime;
      state.to = video.currentTime;
      isDragging = true;
      customControls.classList.add('is-seeking');
      updatePlaybackIndicator();
    }

    function moveScrub(state, dx) {
      const duration = Number(state.video.duration);
      if (!Number.isFinite(duration) || duration <= 0) return;
      const span = Math.min(duration, scrubSpanSeconds);
      state.to = Math.max(0, Math.min(duration, state.from + (dx / feedContainer.clientWidth) * span));
      showSeekProgress(state.to, duration);
      showHud(seekLabel(state.from, state.to, duration));
      // Safari and Firefox can show the nearby frame while dragging; elsewhere the seek lands on release.
      if (typeof state.video.fastSeek === 'function' && !state.frame) {
        state.frame = requestAnimationFrame(() => {
          state.frame = null;
          state.video.fastSeek(state.to);
        });
      }
    }

    function endScrub(state, cancelled) {
      cancelAnimationFrame(state.frame);
      isDragging = false;
      customControls.classList.remove('is-seeking');
      try {
        if (currentVideo() === state.video) state.video.currentTime = cancelled ? state.from : state.to;
      } catch (error) {
        // An unloaded or unseekable video must still release the paging lock.
      }
      hideHud();
      updatePlaybackIndicator();
    }

    // One pointer gesture for the stage: drag to page, tap to play or reveal, double-tap to like,
    // hold a video to speed it up, drag a video sideways to seek.
    const tapSlop = 10;
    const doubleTapMs = 250;
    const longPressMs = 450;
    let gesture = null;
    let lastTap = { time: 0, x: 0, y: 0 };
    let tapTimer = null;

    function likeAt(x, y) {
      const name = currentDisplayEntry()?.name;
      if (!name) return;
      const heart = document.createElement('div');
      heart.className = 'tap-heart';
      heart.style.left = `${x}px`;
      heart.style.top = `${y}px`;
      heart.style.setProperty('--tilt', `${Math.round(Math.random() * 28 - 14)}deg`);
      heart.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
      heart.addEventListener('animationend', () => heart.remove());
      document.body.appendChild(heart);
      reactions.ensureLike(name).catch(() => showReactionError(name, 'like'));
    }

    function handleTap(x, y) {
      const now = performance.now();
      const name = currentDisplayEntry()?.name;
      const isDouble = lastTap.time > 0 && lastTap.name === name
        && now - lastTap.time < doubleTapMs && Math.hypot(x - lastTap.x, y - lastTap.y) < 40;
      lastTap = isDouble ? { time: 0, x: 0, y: 0 } : { time: now, x, y, name };
      clearTimeout(tapTimer);
      if (isDouble) {
        // R2：清屏中双击 = 退出清屏（退出入口替代已移除的退出按钮，不再点赞）。
        if (cleanModeActive()) {
          flowState.setCleanMode(false);
          return;
        }
        likeAt(x, y);
        return;
      }
      // R4：仅屏幕中央（18%–82%）单击切换播放/暂停；边缘留给音量/亮度手势。
      const relX = x / Math.max(1, document.documentElement.clientWidth);
      if (relX < 0.18 || relX > 0.82) return;
      // A single tap waits out the double-tap window, so a double tap never touches playback.
      const item = currentItem();
      tapTimer = setTimeout(() => {
        if (currentItem() !== item) return;
        if (item?.type === 'video') togglePlay();
        else toggleUI();
      }, doubleTapMs);
    }

    function releaseVelocity(samples) {
      const last = samples[samples.length - 1];
      const first = samples.find(([time]) => last[0] - time <= 90) || last;
      return last[0] > first[0] ? (last[1] - first[1]) / (last[0] - first[0]) : 0;
    }

    overlayLayer.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0 || isDragging || gesture || magnifier.isActive() || settling || collections.isOpen()) return;
      overlayLayer.setPointerCapture(event.pointerId);
      // B1 手势分区：左缘调亮度、右缘调音量，中央竖滑切条，互不误触。
      const relX = event.clientX / Math.max(1, document.documentElement.clientWidth);
      const zone = relX <= 0.18 ? 'brightness' : relX >= 0.82 ? 'volume' : 'page';
      gesture = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        mode: 'pending',
        zone,
        startVolume: volumeLevel,
        startBrightness: brightnessLevel,
        offset: 0,
        dx: 0,
        samples: [[event.timeStamp, event.clientY]],
        longPressed: false,
      };
      gesture.timer = setTimeout(() => {
        if (gesture?.mode !== 'pending') return;
        gesture.longPressed = true;
        clearTimeout(tapTimer);
        lastTap = { time: 0, x: 0, y: 0 };
        const video = currentVideo();
        if (video) openSpeedMenu();
        else toggleUI();
      }, longPressMs);
    });

    overlayLayer.addEventListener('pointermove', (event) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (gesture.mode === 'pending') {
        if (Math.hypot(dx, dy) < tapSlop) return;
        clearTimeout(gesture.timer);
        clearTimeout(tapTimer);
        lastTap = { time: 0, x: 0, y: 0 };
        gesture.mode = gesture.longPressed ? 'none' : (Math.abs(dy) > Math.abs(dx)
          ? (gesture.zone === 'volume' ? 'volume' : gesture.zone === 'brightness' ? 'brightness' : 'vertical')
          : 'horizontal');
        if (gesture.mode === 'horizontal' && currentVideo()) beginScrub(gesture);
      }
      if (gesture.mode === 'scrub') {
        moveScrub(gesture, dx);
        return;
      }
      if (gesture.mode === 'volume' || gesture.mode === 'brightness') {
        const delta = -dy / (feedContainer.clientHeight * 0.6);
        if (gesture.mode === 'volume') {
          volumeLevel = Math.max(0, Math.min(1, gesture.startVolume + delta));
          if (volumeLevel > 0 && soundMuted) {
            // The gesture expresses intent to hear sound; drop the mute like the sound pill does.
            soundMuted = false;
            try {
              window.localStorage.setItem('ownflick-muted', '0');
            } catch (error) {
              // Private mode or blocked storage: keep the in-session state.
            }
            soundPromptDismissed = true;
            hideSoundPrompt();
            renderMuteButton();
          }
          applyVolume();
          showHud(`🔊 音量 ${Math.round(volumeLevel * 100)}%`);
        } else {
          brightnessLevel = Math.max(0.4, Math.min(1.6, gesture.startBrightness + delta));
          applyBrightness();
          showHud(`☀ 亮度 ${Math.round(brightnessLevel * 100)}%`);
        }
        return;
      }
      if (gesture.mode === 'horizontal') gesture.dx = dx;
      if (gesture.mode !== 'vertical') return;
      const dir = dy < 0 ? 1 : -1;
      if (!pager || pager.dir !== dir) beginPage(dir);
      gesture.offset = pager.peer ? dy : dy * 0.25;
      gesture.samples.push([event.timeStamp, event.clientY]);
      if (gesture.samples.length > 6) gesture.samples.shift();
      placePage(gesture.offset);
    });

    function endGesture(event, cancelled) {
      if (!gesture || event.pointerId !== gesture.id) return;
      const current = gesture;
      gesture = null;
      clearTimeout(current.timer);
      try {
        if (overlayLayer.hasPointerCapture(current.id)) overlayLayer.releasePointerCapture(current.id);
      } catch (error) {
        // The browser may already have released capture while cancelling the pointer.
      }
      if (current.mode === 'volume' || current.mode === 'brightness') {
        persistLevels();
        showHud(current.mode === 'volume'
          ? `🔊 音量 ${Math.round(volumeLevel * 100)}%`
          : `☀ 亮度 ${Math.round(brightnessLevel * 100)}%`, 900);
        return;
      }
      if (current.mode === 'scrub') {
        endScrub(current, cancelled);
        return;
      }
      if (current.mode === 'vertical' && pager) {
        const height = feedContainer.clientHeight;
        const toward = -current.offset * pager.dir;
        const fling = -releaseVelocity(current.samples) * pager.dir > 0.45;
        const commit = !cancelled && (toward > height * 0.22 || (fling && toward > 24));
        if (commit && !pager.peer && pager.dir > 0 && flowSession.hasMore()) loadFeed();
        settlePage(commit, current.offset);
        return;
      }
      if (cancelled) {
        clearTimeout(tapTimer);
        lastTap = { time: 0, x: 0, y: 0 };
        return;
      }
      if (current.mode === 'horizontal' && Math.abs(current.dx) > 36) {
        if (current.dx < 0) goGroupNext();
        else goGroupPrev();
        return;
      }
      if (current.mode === 'pending' && !current.longPressed) handleTap(event.clientX, event.clientY);
    }

    overlayLayer.addEventListener('pointerup', (event) => endGesture(event, false));
    overlayLayer.addEventListener('pointercancel', (event) => endGesture(event, true));
    overlayLayer.addEventListener('lostpointercapture', (event) => endGesture(event, true));

    function cancelStageGesture() {
      clearTimeout(tapTimer);
      lastTap = { time: 0, x: 0, y: 0 };
      if (gesture) endGesture({ pointerId: gesture.id }, true);
    }

    window.addEventListener('blur', cancelStageGesture);
    window.addEventListener('pagehide', cancelStageGesture);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        saveCurrentSession(true);
        pageSuspended = true;
        const video = currentVideo();
        if (video && !video.paused) {
          resumeOnVisible = video;
          video.pause();
        }
        stopProgressLoop();
        clearTimeout(preloadTimer);
        cancelStageGesture();
        return;
      }
      pageSuspended = false;
      syncMediaWindow();
      const video = currentVideo();
      if (video && resumeOnVisible === video) {
        resumeOnVisible = null;
        // Background tabs may also defer the original activation animation frame.
        video.classList.add('active');
        // Invalidate a start that was still awaiting data when the page hid.
        activateVideo(currentItem(), ++videoActivationId).then((started) => {
          if (started && currentVideo() === video && !document.hidden) {
            startProgressLoop();
            preloadNextVideo();
          }
        }).catch(() => {});
      } else if (video && !video.paused) {
        startProgressLoop();
      }
    });

    // Wheel and trackpad page once per gesture; momentum is absorbed until the wheel goes quiet.
    let wheelLocked = false;
    let wheelQuietTimer = null;
    overlayLayer.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (isDragging || magnifier.isActive()) return;
      clearTimeout(wheelQuietTimer);
      wheelQuietTimer = setTimeout(() => { wheelLocked = false; }, 200);
      if (wheelLocked || Math.abs(event.deltaY) < 12) return;
      wheelLocked = true;
      if (event.deltaY > 0) goNext();
      else goPrev();
    }, { passive: false });

    function closeSpeedChoices() {
      speedChoices.classList.remove('show');
      speedBtn.setAttribute('aria-expanded', 'false');
    }

    function setSpeed(rate) {
      speedRate = rate;
      speedBtn.textContent = `${rate}x`;
      speedBtn.setAttribute('aria-label', `播放速度，当前 ${rate} 倍`);
      speedBtn.classList.toggle('is-changed', rate !== 1);
      document.querySelectorAll('#speed-options [data-rate], #speed-menu [data-rate]').forEach((btn) => {
        btn.classList.toggle('active', Number(btn.dataset.rate) === rate);
      });
      const video = currentVideo();
      if (video) video.playbackRate = rate;
    }

    speedBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (speedBtn._longPressed) {
        speedBtn._longPressed = false;
        return;
      }
      const open = !speedChoices.classList.contains('show');
      speedChoices.classList.toggle('show', open);
      speedBtn.setAttribute('aria-expanded', String(open));
    });

    // B2: long-pressing the speed button opens the same stage speed menu.
    speedBtn.addEventListener('pointerdown', () => {
      clearTimeout(speedBtn._holdTimer);
      speedBtn._holdTimer = setTimeout(() => {
        speedBtn._longPressed = true;
        openSpeedMenu();
        // Auto-reset in case the browser never synthesizes the trailing click.
        setTimeout(() => { speedBtn._longPressed = false; }, 600);
      }, longPressMs);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => {
      speedBtn.addEventListener(type, () => clearTimeout(speedBtn._holdTimer));
    });

    // A3: after head drops, jump straight back to the newest watched item.
    if (backToLatestBtn) {
      backToLatestBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        backToLatestBtn.hidden = true;
        if (feedItems.length) showItem(feedItems.length - 1);
      });
    }

    // B2: the stage speed menu applies a rate on click and closes on backdrop.
    if (speedMenu) {
      speedMenu.addEventListener('click', (event) => {
        event.stopPropagation();
        const choice = event.target.closest('[data-rate]');
        if (choice) {
          setSpeed(Number(choice.dataset.rate));
          closeSpeedMenu();
          showHud(`倍速 ${choice.dataset.rate}x`, 1200);
          return;
        }
        if (event.target === speedMenu) closeSpeedMenu();
      });
    }
    speedChoices.addEventListener('click', (event) => {
      const choice = event.target.closest('[data-rate]');
      if (!choice) return;
      event.stopPropagation();
      setSpeed(Number(choice.dataset.rate));
      closeSpeedChoices();
    });
    document.addEventListener('click', (event) => {
      if (!speedWrap.contains(event.target)) closeSpeedChoices();
    });

    function showReactionError(name, kind) {
      const button = kind === 'like' ? likeBtn : favoriteBtn;
      if (button.dataset.value !== name) return;
      const message = `${kind === 'like' ? '点赞' : '收藏'}未保存，请重试`;
      button.title = message;
      showHud(message, 2000);
    }

    [[likeBtn, 'like'], [favoriteBtn, 'favorite']].forEach(([button, kind]) => {
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const name = button.dataset.value;
        if (!name || button.disabled) return;
        const type = currentItem()?.type === 'video' ? 'video' : 'image';
        try {
          const value = await reactions.toggle(name, kind);
          // Existing recommendation activity consumes favorites only.
          if (kind === 'favorite') postActivity([{
            session_id: activitySessionId, uri: name, media_type: type,
            surface: 'flow', event: value ? 'favorite' : 'unfavorite',
          }]);
        } catch (error) { showReactionError(name, kind); }
      });
    });

    // Controls must not complete a pending stage tap or start a swipe/seek.
    const actionControls = document.getElementById('controls');
    ['pointerdown', 'touchstart', 'mousedown'].forEach((type) => {
      actionControls.addEventListener(type, (event) => {
        cancelStageGesture();
        event.stopPropagation();
      }, { passive: true });
    });
    ['pointermove', 'pointerup', 'pointercancel', 'touchmove', 'touchend',
      'touchcancel', 'mouseup', 'click', 'dblclick'].forEach((type) => {
      actionControls.addEventListener(type, (event) => event.stopPropagation());
    });
    actionControls.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, { passive: false });

    infoBtn.addEventListener('click', () => {
      const target = activityTarget(currentItem());
      if (!target) return;
      postActivity([{
        session_id: activitySessionId,
        uri: target.uri,
        media_type: target.type,
        surface: 'flow',
        event: 'open_detail',
      }]);
    });

    document.addEventListener('keydown', (event) => {
      if (isCollectionPlaylistOpen()) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCollectionPlaylist();
          collectionPlaybackOpen.focus({ preventScroll: true });
        } else if (event.key === 'Tab') {
          const focusable = Array.from(collectionPlaylist.querySelectorAll('button:not(:disabled):not([hidden])'));
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) {
          if (event.key !== ' ' || !event.target.closest('button')) event.preventDefault();
        }
        return;
      }
      if (collections.isOpen()) {
        if (event.key === 'Escape') {
          event.preventDefault();
          collections.close();
          collectionBtn.focus({ preventScroll: true });
        }
        return;
      }
      if (document.getElementById('app-nav-menu-trigger')?.getAttribute('aria-expanded') === 'true') return;
      if (event.key === 'Escape' && speedChoices.classList.contains('show')) {
        event.preventDefault();
        closeSpeedChoices();
        speedBtn.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Escape' && flowState.isCleanMode()) {
        event.preventDefault();
        flowState.setCleanMode(false);
        return;
      }
      if (isDragging) {
        event.preventDefault();
        return;
      }
      const target = event.target;
      if (target && typeof target.closest === 'function') {
        if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) {
          return;
        }
        if ([' ', 'Enter'].includes(event.key) && target.closest('button, a[href]')) return;
      }
      if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && currentVideo()) {
        event.preventDefault();
        seekBy(event.key === 'ArrowRight' ? keySeekSeconds : -keySeekSeconds);
        return;
      }
      if (event.key === 'ArrowRight') {
        if (!goGroupNext()) goNext();
      }
      if (event.key === 'ArrowLeft') {
        if (!goGroupPrev()) goPrev();
      }
      if (event.key === 'ArrowDown') goNext();
      if (event.key === 'ArrowUp') goPrev();
      if (event.key === ' ') {
        event.preventDefault();
        togglePlay();
      }
    });

    flowStatusRetry.addEventListener('click', async () => {
      if (flowStatus.dataset.kind === 'media-error') {
        await retryCurrentMedia();
      } else {
        await retryFlowLoad();
      }
    });

    flowStatusNext.addEventListener('click', async () => {
      hideFlowStatus();
      await goNext();
    });

    const progressControls = window.createFlowProgressController({
      controls: customControls,
      range: progressBar,
      fill: progressFill,
      current: timeCurrent,
      total: timeTotal,
      preview: document.getElementById('seek-preview'),
      getVideo: currentVideo,
      // Seeking can temporarily lower readyState even after the first frame has loaded.
      isBlocked: () => settling || !!gesture || collections.isOpen()
        || currentVideo()?._startReady !== true,
      onSeekingChange: (seeking) => {
        isDragging = seeking;
        updatePlaybackIndicator();
        clearTimeout(tapTimer);
        lastTap = { time: 0, x: 0, y: 0 };
      },
      formatTime,
    });


    window.addEventListener('pagehide', () => {
      saveCurrentSession(true);
      postActivity([finishActivity()], true);
    });
    document.getElementById('flow-shuffle-button')?.addEventListener('click', () => {
      void startNewRound();
    });

    const initialEpoch = feedEpoch;
    await loadFeed();
    if (initialEpoch === feedEpoch && feedItems.length > 0) await showItem(0);
  })();
