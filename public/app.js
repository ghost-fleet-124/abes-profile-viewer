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
  const statusLabel = systemStatus.querySelector('.status-label');

  let currentObjectUrl = null;
  const ROLL_NUMBER_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

  function triggerHaptic(type = 'light') {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        if (type === 'light') navigator.vibrate(12);
        else if (type === 'success') navigator.vibrate([15, 30, 20]);
        else if (type === 'error') navigator.vibrate([30, 40, 30]);
      } catch {}
    }
  }

  const canvas = document.getElementById('matrixCanvas');
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
            initColumns();
          }, 100);
        }, { passive: true });

        const characters = '010101100101';
        const fontSize = 14;
        let columns = Math.max(1, Math.floor(width / fontSize));
        let drops = [];

        function initColumns() {
          columns = Math.max(1, Math.floor(width / fontSize));
          drops = [];
          for (let i = 0; i < columns; i++) {
            drops[i] = Math.random() * -80;
          }
        }
        initColumns();

        let pointerX = width / 2;
        let pointerY = height / 2;
        let pointerActive = false;

        function updatePointer(x, y) {
          pointerX = x;
          pointerY = y;
          pointerActive = true;
        }

        window.addEventListener('mousemove', (e) => {
          updatePointer(e.clientX, e.clientY);
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
          if (e.touches && e.touches.length > 0) {
            updatePointer(e.touches[0].clientX, e.touches[0].clientY);
          }
        }, { passive: true });

        window.addEventListener('touchstart', (e) => {
          if (e.touches && e.touches.length > 0) {
            updatePointer(e.touches[0].clientX, e.touches[0].clientY);
          }
        }, { passive: true });

        window.addEventListener('touchend', () => {
          pointerActive = false;
        }, { passive: true });

        function drawMatrix() {
          ctx.fillStyle = 'rgba(0, 12, 6, 0.16)';
          ctx.fillRect(0, 0, width, height);

          ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;

          for (let i = 0; i < drops.length; i++) {
            const text = characters.charAt(Math.floor(Math.random() * characters.length));
            const x = i * fontSize;
            const y = drops[i] * fontSize;

            const dist = pointerActive ? Math.hypot(x - pointerX, y - pointerY) : 999;
            if (dist < 100) {
              ctx.fillStyle = '#ffffff';
            } else {
              ctx.fillStyle = 'rgba(0, 232, 112, 0.45)';
            }

            ctx.fillText(text, x, y);

            if (y > height && Math.random() > 0.985) {
              drops[i] = 0;
            }
            drops[i]++;
          }
          requestAnimationFrame(drawMatrix);
        }
        requestAnimationFrame(drawMatrix);
      }
    } catch {}
  }

  if (terminalCard) {
    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;
    const maxTilt = 8;

    function handlePointerTilt(clientX, clientY) {
      const rect = terminalCard.getBoundingClientRect();
      const cardCenterX = rect.left + rect.width / 2;
      const cardCenterY = rect.top + rect.height / 2;

      const normX = (clientX - cardCenterX) / (window.innerWidth / 2);
      const normY = (clientY - cardCenterY) / (window.innerHeight / 2);

      const clampedX = Math.max(-1, Math.min(1, normX));
      const clampedY = Math.max(-1, Math.min(1, normY));

      targetX = -clampedY * maxTilt;
      targetY = clampedX * maxTilt;
    }

    window.addEventListener('mousemove', (e) => {
      handlePointerTilt(e.clientX, e.clientY);
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (e.touches && e.touches.length > 0) {
        handlePointerTilt(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });

    window.addEventListener('touchend', () => {
      targetX = 0;
      targetY = 0;
    }, { passive: true });

    window.addEventListener('mouseleave', () => {
      targetX = 0;
      targetY = 0;
    });

    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', (e) => {
        if (e.gamma !== null && e.beta !== null) {
          const tiltY = Math.max(-20, Math.min(20, e.gamma)) / 20;
          const tiltX = (Math.max(15, Math.min(65, e.beta)) - 40) / 25;
          targetX = -tiltX * maxTilt;
          targetY = tiltY * maxTilt;
        }
      }, { passive: true });
    }

    function updateCardTilt() {
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;

      terminalCard.style.transform = `perspective(1200px) rotateX(${currentX.toFixed(2)}deg) rotateY(${currentY.toFixed(2)}deg)`;
      requestAnimationFrame(updateCardTilt);
    }
    requestAnimationFrame(updateCardTilt);
  }

  const scrambleElements = document.querySelectorAll('[data-scramble]');
  const scrambleChars = '010101ABCDEF#$<>[]';

  scrambleElements.forEach((el) => {
    const originalText = el.getAttribute('data-scramble');
    let interval = null;

    function triggerScramble() {
      let iteration = 0;
      clearInterval(interval);

      const textTarget = el.querySelector('.btn-text') || el;

      interval = setInterval(() => {
        textTarget.innerText = originalText
          .split('')
          .map((letter, index) => {
            if (index < iteration) {
              return originalText[index];
            }
            return scrambleChars[Math.floor(Math.random() * scrambleChars.length)];
          })
          .join('');

        if (iteration >= originalText.length) {
          clearInterval(interval);
        }
        iteration += 1 / 2;
      }, 25);
    }

    el.addEventListener('mouseenter', triggerScramble);
    el.addEventListener('pointerdown', triggerScramble, { passive: true });
  });

  async function checkGatewayHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        if (data.sessionConfigured) {
          if (data.erpSession === 'active') {
            systemStatus.className = 'status-pill status-online';
            statusLabel.textContent = 'GATEWAY ONLINE // ACTIVE';
          } else if (data.erpSession === 'expired') {
            systemStatus.className = 'status-pill status-warning';
            statusLabel.textContent = 'SESSION EXPIRED';
          } else if (data.erpSession === 'temporarily_unavailable') {
            systemStatus.className = 'status-pill status-warning';
            statusLabel.textContent = 'GATEWAY BUSY';
          } else {
            systemStatus.className = 'status-pill status-online';
            statusLabel.textContent = 'GATEWAY CONFIGURED';
          }
        } else {
          systemStatus.className = 'status-pill status-warning';
          statusLabel.textContent = 'AWAITING CREDENTIALS';
        }
      } else {
        throw new Error('Non-200 response');
      }
    } catch {
      systemStatus.className = 'status-pill status-offline';
      statusLabel.textContent = 'GATEWAY OFFLINE';
    }
  }

  function cleanupObjectUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  }

  function resetStates() {
    loadingState.classList.add('hidden');
    errorState.classList.add('hidden');
    resultState.classList.add('hidden');
    adminTip.classList.add('hidden');
    rollNumberInput.classList.remove('input-error');
  }

  function showError(title, message, isSessionError = false) {
    resetStates();
    errorTitle.textContent = title;
    errorMessage.textContent = message;
    rollNumberInput.classList.add('input-error');

    if (isSessionError) {
      adminTip.classList.remove('hidden');
    }

    errorState.classList.remove('hidden');
    triggerHaptic('error');
  }

  function showResult(blob, rollNumber) {
    resetStates();
    cleanupObjectUrl();

    currentObjectUrl = URL.createObjectURL(blob);
    profileImage.src = currentObjectUrl;
    displayRoll.textContent = rollNumber;

    downloadBtn.href = currentObjectUrl;
    downloadBtn.download = `ABES_${rollNumber}.jpg`;
    openNewTabBtn.href = currentObjectUrl;

    resultState.classList.remove('hidden');
    triggerHaptic('success');
  }

  function setLoading(isLoading) {
    if (isLoading) {
      searchBtn.disabled = true;
      searchBtn.querySelector('.btn-text').textContent = 'QUERYING...';
      loadingState.classList.remove('hidden');
      errorState.classList.add('hidden');
      resultState.classList.add('hidden');
    } else {
      searchBtn.disabled = false;
      searchBtn.querySelector('.btn-text').textContent = 'INITIATE QUERY';
      loadingState.classList.add('hidden');
    }
  }

  function updateClearButton() {
    if (rollNumberInput.value.trim().length > 0) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }

  rollNumberInput.addEventListener('input', () => {
    updateClearButton();
    rollNumberInput.classList.remove('input-error');
  });

  clearBtn.addEventListener('click', () => {
    rollNumberInput.value = '';
    updateClearButton();
    rollNumberInput.focus();
    resetStates();
    triggerHaptic('light');
  });

  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const rawRoll = rollNumberInput.value;
    const trimmedRoll = rawRoll.trim();

    if (!trimmedRoll) {
      showError('VALIDATION EXCEPTION', 'Please enter a student roll number.');
      rollNumberInput.focus();
      return;
    }

    if (trimmedRoll.length < 3 || trimmedRoll.length > 30) {
      showError('VALIDATION EXCEPTION', 'Roll number length must be between 3 and 30 characters.');
      rollNumberInput.focus();
      return;
    }

    if (!ROLL_NUMBER_PATTERN.test(trimmedRoll)) {
      showError(
        'VALIDATION EXCEPTION',
        'Invalid characters detected. Only letters, numbers, hyphens, and underscores are permitted.'
      );
      rollNumberInput.focus();
      return;
    }

    setLoading(true);
    triggerHaptic('light');

    try {
      const response = await fetch(`/api/profile/${encodeURIComponent(trimmedRoll)}`);
      const contentType = response.headers.get('content-type') || '';

      if (response.ok && contentType.startsWith('image/')) {
        const imageBlob = await response.blob();
        showResult(imageBlob, trimmedRoll);
        systemStatus.className = 'status-pill status-online';
        statusLabel.textContent = 'GATEWAY ONLINE // ACTIVE';
      } else {
        let errData = {};
        try {
          errData = await response.json();
        } catch {
          errData = { error: `Server returned HTTP ${response.status}` };
        }

        const msg = errData.error || 'Failed to retrieve profile record.';

        if (response.status === 400) {
          showError('INVALID IDENTIFIER', msg);
        } else if (response.status === 401) {
          showError('SESSION EXPIRED', msg, true);
          systemStatus.className = 'status-pill status-warning';
          statusLabel.textContent = 'SESSION EXPIRED';
        } else if (response.status === 404) {
          showError('RECORD NOT FOUND', msg);
        } else if (response.status === 429) {
          showError('RATE LIMIT REACHED', msg);
        } else if (response.status === 504) {
          showError('TIMEOUT EXCEEDED', msg);
        } else {
          showError('GATEWAY ERROR', msg);
        }
      }
    } catch {
      showError(
        'NETWORK EXCEPTION',
        'Could not communicate with the gateway server. Verify server connectivity.'
      );
    } finally {
      setLoading(false);
    }
  });

  checkGatewayHealth();
  updateClearButton();
});