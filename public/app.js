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

  const canvas = document.getElementById('matrixCanvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    window.addEventListener('resize', () => {
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
      initColumns();
    });

    const characters = '010101100101';
    const fontSize = 14;
    let columns = Math.floor(width / fontSize);
    let drops = [];

    function initColumns() {
      columns = Math.floor(width / fontSize);
      drops = [];
      for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -100;
      }
    }
    initColumns();

    let mouseX = width / 2;
    let mouseY = height / 2;
    window.addEventListener('mousemove', (e) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
    });

    function drawMatrix() {
      ctx.fillStyle = 'rgba(0, 12, 6, 0.15)';
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = '#00e870';
      ctx.font = `${fontSize}px "IBM Plex Mono", monospace`;

      for (let i = 0; i < drops.length; i++) {
        const text = characters.charAt(Math.floor(Math.random() * characters.length));
        const x = i * fontSize;
        const y = drops[i] * fontSize;

        const dist = Math.hypot(x - mouseX, y - mouseY);
        if (dist < 120) {
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

  if (terminalCard) {
    let currentX = 0;
    let currentY = 0;
    let targetX = 0;
    let targetY = 0;

    window.addEventListener('mousemove', (e) => {
      const rect = terminalCard.getBoundingClientRect();
      const cardCenterX = rect.left + rect.width / 2;
      const cardCenterY = rect.top + rect.height / 2;

      const normX = (e.clientX - cardCenterX) / (window.innerWidth / 2);
      const normY = (e.clientY - cardCenterY) / (window.innerHeight / 2);

      const maxTilt = 6;
      targetX = -normY * maxTilt;
      targetY = normX * maxTilt;
    });

    window.addEventListener('mouseleave', () => {
      targetX = 0;
      targetY = 0;
    });

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

    el.addEventListener('mouseenter', () => {
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
    });
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
