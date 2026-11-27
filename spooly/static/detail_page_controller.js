const detailBoot = window.__SPOOLY_DETAIL_BOOT__ || {};

document.addEventListener('DOMContentLoaded', () => {
  const mainVideo = document.getElementById('main-video');
  const fullscreenBtn = document.getElementById('fullscreen-btn');
  const pipBtn = document.getElementById('pip-btn');
  const favoriteBtn = document.getElementById('favorite-btn');
  const favoriteText = document.getElementById('favorite-text');
  const copyLinkBtn = document.getElementById('copy-link-btn');
  const speedBtns = document.querySelectorAll('.speed-btn');
  const setThumbBtn = document.getElementById('set-thumb-btn');
  const moreMenuBtn = document.getElementById('more-menu-btn');
  const moreMenu = document.getElementById('detail-action-menu');
  
  const fileName = detailBoot.file;
  let isFavorited = false;

  // Module J: title shows the cleaned caption unless the user prefers file names.
  const captionHeading = document.querySelector('h1[data-caption-title]');
  if (captionHeading && window.SpoolyCaption) {
    captionHeading.textContent = window.SpoolyCaption.display(
      captionHeading.getAttribute('data-caption-title') || '',
    );
  }

  const closeMoreMenu = () => {
    if (!moreMenu || !moreMenuBtn) return;
    moreMenu.hidden = true;
    moreMenuBtn.setAttribute('aria-expanded', 'false');
  };

  const toggleMoreMenu = () => {
    if (!moreMenu || !moreMenuBtn) return;
    const nextOpen = moreMenu.hidden;
    moreMenu.hidden = !nextOpen;
    moreMenuBtn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
  };

  moreMenuBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleMoreMenu();
  });

  document.addEventListener('click', (event) => {
    if (!moreMenu || moreMenu.hidden) return;
    const target = event.target;
    if (moreMenu.contains(target) || moreMenuBtn?.contains(target)) return;
    closeMoreMenu();
  });

  // Initialize favorite state.
  async function initFavoriteStatus() {
    try {
      const response = await fetch(`/api/favorite/${encodeURIComponent(fileName)}`);
      const data = await response.json();
      if (!response.ok || typeof data.favorite !== 'boolean') throw new Error('加载收藏状态失败');
      isFavorited = data.favorite;
      updateFavoriteUI();
    } catch (error) {
      console.error('Failed to load favorite state:', error);
    }
  }

  // Update the favorite button.
  function updateFavoriteUI() {
    if (isFavorited) {
      favoriteBtn?.classList.add('active');
      favoriteBtn?.setAttribute('aria-label', '取消收藏');
      if (favoriteText) favoriteText.textContent = '取消收藏';
      if (typeof feather !== 'undefined' && feather.icons && feather.icons.heart) {
        const icon = favoriteBtn?.querySelector('svg');
        if (icon) icon.innerHTML = feather.icons.heart.toSvg();
      }
    } else {
      favoriteBtn?.classList.remove('active');
      favoriteBtn?.setAttribute('aria-label', '加入收藏');
      if (favoriteText) favoriteText.textContent = '加入收藏';
      if (typeof feather !== 'undefined' && feather.icons && feather.icons.heart) {
        const icon = favoriteBtn?.querySelector('svg');
        if (icon) icon.innerHTML = feather.icons.heart.toSvg();
      }
    }
  }

  // Favorite action.
  favoriteBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (favoriteBtn.disabled) return;
    favoriteBtn.disabled = true;
    try {
      const response = await fetch(`/api/favorite/${encodeURIComponent(fileName)}`, {
        method: 'POST'
      });
      const data = await response.json();
      if (!response.ok || typeof data.favorite !== 'boolean') throw new Error('保存收藏状态失败');
      isFavorited = data.favorite;
      updateFavoriteUI();
      SpoolyUI.toast(isFavorited ? '已加入收藏' : '已取消收藏', 'success');
    } catch (error) {
      console.error('Failed to update favorite:', error);
      SpoolyUI.toast('操作失败，请重试。', 'error');
    } finally {
      favoriteBtn.disabled = false;
    }
  });

  const togglePlayback = () => {
    if (!mainVideo) return;
    if (mainVideo.paused) {
      mainVideo.play();
    } else {
      mainVideo.pause();
    }
  };

  // Fullscreen.
  fullscreenBtn?.addEventListener('click', () => {
    if (!mainVideo) return;
    if (mainVideo.requestFullscreen) {
      mainVideo.requestFullscreen();
    } else if (mainVideo.webkitRequestFullscreen) {
      mainVideo.webkitRequestFullscreen();
    } else if (mainVideo.msRequestFullscreen) {
      mainVideo.msRequestFullscreen();
    }
  });

  // Picture in picture.
  pipBtn?.addEventListener('click', async () => {
    if (!mainVideo) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await mainVideo.requestPictureInPicture();
      }
    } catch (error) {
      SpoolyUI.toast('当前浏览器不支持画中画', 'error');
    }
  });

  // Playback speed.
  speedBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (!mainVideo) return;
      const speed = parseFloat(btn.dataset.speed);
      mainVideo.playbackRate = speed;
      speedBtns.forEach(b => b.classList.toggle('is-active', b === btn));
      SpoolyUI.toast(`播放速度已设为 ${speed} 倍`, 'info');
    });
  });

  // Copy link.
  copyLinkBtn?.addEventListener('click', async () => {
    closeMoreMenu();
    try {
      const url = window.location.origin + '/media?uri=' + encodeURIComponent(fileName);
      await navigator.clipboard.writeText(url);
      SpoolyUI.toast('链接已复制到剪贴板', 'success');
    } catch (err) {
      SpoolyUI.toast('复制失败，请手动复制链接。', 'error');
    }
  });

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName.toLowerCase() === 'input') return;
    
    switch(e.key) {
      case 'Escape':
        if (moreMenu && !moreMenu.hidden) {
          e.preventDefault();
          closeMoreMenu();
          moreMenuBtn?.focus();
        }
        break;
      case ' ':
        e.preventDefault();
        togglePlayback();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        fullscreenBtn?.click();
        break;
      case 'p':
      case 'P':
        e.preventDefault();
        pipBtn?.click();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (!mainVideo) break;
        mainVideo.currentTime = Math.max(0, mainVideo.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!mainVideo) break;
        mainVideo.currentTime = Math.min(mainVideo.duration, mainVideo.currentTime + 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!mainVideo) break;
        mainVideo.volume = Math.min(1, mainVideo.volume + 0.1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!mainVideo) break;
        mainVideo.volume = Math.max(0, mainVideo.volume - 0.1);
        break;
    }
  });

  SpoolyResume.track(mainVideo, fileName, detailBoot.resumePosition || 0);

  // Initialize.
  initFavoriteStatus();

  // Use the current paused frame as the thumbnail.
  setThumbBtn?.addEventListener('click', async () => {
    closeMoreMenu();
    if (!mainVideo) return;
    try {
      const ts = Math.max(0, mainVideo.currentTime || 0);
      const resp = await fetch(`/api/thumbnail/${encodeURIComponent(fileName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: ts })
      });
      const data = await resp.json();
      if (resp.ok && data.success) {
        // Force a poster cache refresh.
        mainVideo.setAttribute('poster', `/thumb?uri=${encodeURIComponent(fileName)}&v=${Date.now()}`);
        SpoolyUI.toast('封面已更新', 'success');
      } else {
        SpoolyUI.toast(data.error || '生成封面失败', 'error');
      }
    } catch (e) {
      SpoolyUI.toast('发生错误，请稍后重试。', 'error');
    }
  });
});

// Delete moves the file to the trash and continues to a neighbour, where Undo is offered.
async function confirmDelete() {
  const confirmed = await SpoolyUI.confirm({
    title: '确定删除这个视频吗？',
    message: '视频将移入回收站，可在删除后撤销。',
    confirmLabel: '删除',
    tone: 'danger',
  });
  if (confirmed) SpoolyUI.trash(detailBoot.deleteUrl, detailBoot.afterDeleteUrl);
}
