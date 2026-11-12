'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('searchForm');
  const rollNumberInput = document.getElementById('rollNumberInput');
  const searchBtn = document.getElementById('searchBtn');
  const clearBtn = document.getElementById('clearBtn');
  const terminalCard = document.getElementById('terminalCard');

  const loadingState = document.getElementById('loadingState');
  const errorState = document.getElementById('errorState');
  const errorTitle = document.getElementById('errorTitle');
  const errorMessage = document.getElementById('errorMessage');
  const adminTip = document.getElementById('adminTip');

  const resultState = document.getElementById('resultState');
  const profileImage = document.getElementById('profileImage');
  const displayRoll = document.getElementById('displayRoll');
  const downloadBtn = document.getElementById('downloadBtn');
  const openNewTabBtn = document.getElementById('openNewTabBtn');

  const systemStatus = document.getElementById('systemStatus');
  const statusLabel = systemStatus ? systemStatus.querySelector('.status-label') : null;

  let currentObjectUrl = null;
  const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

  const canvas = document.getElementById('ambientCanvas');
  if (canvas) {
    try {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        let width = (canvas.width = window.innerWidth);
        let height = (canvas.height = window.innerHeight);

        let resizeTimer = null;
        window.addEventListener('resize', () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
          }, 100);
        }, { passive: true });

        const particles = Array.from({ length: 24 }, () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.25,
          vy: -0.15 - Math.random() * 0.25,
          size: 1 + Math.random() * 1.5,
          alpha: 0.08 + Math.random() * 0.12,
        }));

        function drawAmbient() {
          ctx.clearRect(0, 0, width, height);

          ctx.strokeStyle = 'rgba(41, 49, 57, 0.25)';
          ctx.lineWidth = 1;
          const gridSize = 48;
          for (let x = 0; x < width; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
          }
          for (let y = 0; y < height; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
          }

          ctx.fillStyle = '#A8C5B8';
          for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;

            if (p.y < 0) {
              p.y = height + 10;
              p.x = Math.random() * width;
            }
            if (p.x < 0) p.x = width;
            if (p.x > width) p.x = 0;

            ctx.globalAlpha = p.alpha;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;

          requestAnimationFrame(drawAmbient);
        }
        requestAnimationFrame(drawAmbient);
      }
    } catch {}
  }

  async function checkGatewayHealth() {
    if (!systemStatus || !statusLabel) return;
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        if (data.sessionConfigured) {
          if (data.erpSession === 'active') {
            systemStatus.className = 'status-indicator status-online';
            statusLabel.textContent = 'GATEWAY ACTIVE';
          } else if (data.erpSession === 'expired') {
            systemStatus.className = 'status-indicator status-warning';
            statusLabel.textContent = 'SESSION EXPIRED';
          } else {
            systemStatus.className = 'status-indicator status-online';
            statusLabel.textContent = 'RADAR READY';
          }
        } else {
          systemStatus.className = 'status-indicator status-warning';
          statusLabel.textContent = 'AWAITING AUTH';
        }
      } else {
        throw new Error();
      }
    } catch {
      systemStatus.className = 'status-indicator status-offline';
      statusLabel.textContent = 'OFFLINE';
    }
  }

  function cleanupObjectUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  }

  function resetStates() {
    if (loadingState) loadingState.classList.add('hidden');
    if (errorState) errorState.classList.add('hidden');
    if (resultState) resultState.classList.add('hidden');
    if (adminTip) adminTip.classList.add('hidden');
    if (rollNumberInput) rollNumberInput.classList.remove('input-error');
  }

  function showError(title, message, isSessionError = false) {
    resetStates();
    if (errorTitle) errorTitle.textContent = title;
    if (errorMessage) errorMessage.textContent = message;
    if (rollNumberInput) rollNumberInput.classList.add('input-error');

    if (isSessionError && adminTip) {
      adminTip.classList.remove('hidden');
    }

    if (errorState) errorState.classList.remove('hidden');
  }

  function showResult(blob, identifier) {
    resetStates();
    cleanupObjectUrl();

    currentObjectUrl = URL.createObjectURL(blob);
    if (profileImage) profileImage.src = currentObjectUrl;
    if (displayRoll) displayRoll.textContent = identifier;

    if (downloadBtn) {
      downloadBtn.href = currentObjectUrl;
      downloadBtn.download = `profile_${identifier}.jpg`;
    }
    if (openNewTabBtn) {
      openNewTabBtn.href = currentObjectUrl;
    }

    if (resultState) resultState.classList.remove('hidden');
  }

  function setLoading(isLoading) {
    if (!searchBtn) return;
    const btnText = searchBtn.querySelector('.btn-text') || searchBtn;
    if (isLoading) {
      searchBtn.disabled = true;
      btnText.textContent = 'Searching Profile...';
      if (loadingState) loadingState.classList.remove('hidden');
      if (errorState) errorState.classList.add('hidden');
      if (resultState) resultState.classList.add('hidden');
    } else {
      searchBtn.disabled = false;
      btnText.textContent = 'Search Profile';
      if (loadingState) loadingState.classList.add('hidden');
    }
  }

  function updateClearButton() {
    if (!clearBtn || !rollNumberInput) return;
    if (rollNumberInput.value.trim().length > 0) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }

  if (rollNumberInput) {
    rollNumberInput.addEventListener('input', () => {
      updateClearButton();
      rollNumberInput.classList.remove('input-error');
    });
  }

  if (clearBtn && rollNumberInput) {
    clearBtn.addEventListener('click', () => {
      rollNumberInput.value = '';
      updateClearButton();
      rollNumberInput.focus();
      resetStates();
    });
  }

  if (searchForm && rollNumberInput) {
    searchForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const rawVal = rollNumberInput.value;
      const trimmed = rawVal.trim();

      if (!trimmed) {
        showError('Validation Error', 'Please enter a profile username or identifier.');
        rollNumberInput.focus();
        return;
      }

      if (trimmed.length < 3 || trimmed.length > 30) {
        showError('Validation Error', 'Identifier must be between 3 and 30 characters.');
        rollNumberInput.focus();
        return;
      }

      if (!IDENTIFIER_PATTERN.test(trimmed)) {
        showError(
          'Validation Error',
          'Only letters, numbers, hyphens, and underscores are permitted.'
        );
        rollNumberInput.focus();
        return;
      }

      setLoading(true);

      try {
        const response = await fetch(`/api/profile/${encodeURIComponent(trimmed)}`);
        const contentType = response.headers.get('content-type') || '';

        if (response.ok && contentType.startsWith('image/')) {
          const imageBlob = await response.blob();
          showResult(imageBlob, trimmed);
        } else {
          let errData = null;
          try {
            errData = await response.json();
          } catch {}

          if (response.status === 401) {
            showError(
              'Session Expired (401)',
              errData?.message || 'The authorized gateway session has expired.',
              true
            );
          } else if (response.status === 404) {
            showError(
              'Profile Not Found (404)',
              errData?.message || `No profile photo found for identifier: ${trimmed}`
            );
          } else if (response.status === 429) {
            showError(
              'Rate Limit Exceeded (429)',
              errData?.message || 'Too many requests. Please wait a moment before trying again.'
            );
          } else {
            showError(
              `Error (${response.status})`,
              errData?.message || 'Unable to retrieve profile photo at this time.'
            );
          }
        }
      } catch (err) {
        showError(
          'Connection Error',
          'Failed to reach the gateway server. Please check your connection.'
        );
      } finally {
        setLoading(false);
      }
    });
  }

  checkGatewayHealth();
  setInterval(checkGatewayHealth, 30000);
});
