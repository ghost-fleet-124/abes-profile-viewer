'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const searchForm = document.getElementById('searchForm');
  const rollNumberInput = document.getElementById('rollNumberInput');
  const searchBtn = document.getElementById('searchBtn');
  const clearBtn = document.getElementById('clearBtn');
  const inputHelper = document.getElementById('inputHelper');

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
  let currentBlob = null;
  let currentAdmissionNumber = '';
  let promoTimer = null;
  const ROLL_NUMBER_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

  const promoModal = document.getElementById('promoModal');
  const promoCloseBtn = document.getElementById('promoCloseBtn');
  const promoDismissBtn = document.getElementById('promoDismissBtn');
  const promoInstaBtn = document.getElementById('promoInstaBtn');

  function openPromoModal() {
    if (!promoModal) return;
    promoModal.classList.remove('hidden');
    promoModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closePromoModal() {
    if (!promoModal) return;
    promoModal.classList.add('hidden');
    promoModal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  if (promoCloseBtn) promoCloseBtn.addEventListener('click', closePromoModal);
  if (promoDismissBtn) promoDismissBtn.addEventListener('click', closePromoModal);
  if (promoInstaBtn) {
    promoInstaBtn.addEventListener('click', () => {
      setTimeout(closePromoModal, 300);
    });
  }

  if (promoModal) {
    promoModal.addEventListener('click', (e) => {
      if (e.target === promoModal) {
        closePromoModal();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && promoModal && !promoModal.classList.contains('hidden')) {
      closePromoModal();
    }
  });

  async function checkGatewayHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        if (data.sessionConfigured) {
          if (data.erpSession === 'active') {
            systemStatus.className = 'system-status-badge status-online';
            statusLabel.textContent = 'Api Session Active';
          } else if (data.erpSession === 'expired') {
            systemStatus.className = 'system-status-badge status-warning';
            statusLabel.textContent = 'API Session Expired';
          } else if (data.erpSession === 'temporarily_unavailable') {
            systemStatus.className = 'system-status-badge status-warning';
            statusLabel.textContent = 'Api Unavailable';
          } else {
            systemStatus.className = 'system-status-badge status-online';
            statusLabel.textContent = 'Api Session Configured';
          }
        } else {
          systemStatus.className = 'system-status-badge status-warning';
          statusLabel.textContent = 'Api Session Not Configured';
        }
      } else {
        throw new Error('Health check returned non-200');
      }
    } catch {
      systemStatus.className = 'system-status-badge status-offline';
      statusLabel.textContent = 'Gateway Offline';
    }
  }

  function cleanupObjectUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
    currentBlob = null;
    currentAdmissionNumber = '';
  }

  function resetStates() {
    if (promoTimer) clearTimeout(promoTimer);
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

    currentBlob = blob;
    currentAdmissionNumber = rollNumber;
    currentObjectUrl = URL.createObjectURL(blob);
    profileImage.src = currentObjectUrl;
    displayRoll.textContent = rollNumber;

    const targetFilename = `GHOST-FLEET-${rollNumber}.jpg`;
    downloadBtn.href = currentObjectUrl;
    downloadBtn.setAttribute('download', targetFilename);
    downloadBtn.download = targetFilename;
    openNewTabBtn.href = currentObjectUrl;

    resultState.classList.remove('hidden');

    // Trigger popup advertisement after 3 seconds of successful search
    if (promoTimer) clearTimeout(promoTimer);
    promoTimer = setTimeout(() => {
      openPromoModal();
    }, 3000);
  }

  function setLoading(isLoading) {
    if (isLoading) {
      if (promoTimer) clearTimeout(promoTimer);
      closePromoModal();
      searchBtn.disabled = true;
      searchBtn.querySelector('.btn-text').textContent = 'Fetching...';
      loadingState.classList.remove('hidden');
      errorState.classList.add('hidden');
      resultState.classList.add('hidden');
    } else {
      searchBtn.disabled = false;
      searchBtn.querySelector('.btn-text').textContent = 'Search Profile';
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
      showError('Validation Error', 'Please enter a student admission number.');
      rollNumberInput.focus();
      return;
    }

    if (trimmedRoll.length < 3 || trimmedRoll.length > 30) {
      showError('Validation Error', 'Admission number must be between 3 and 30 characters.');
      rollNumberInput.focus();
      return;
    }

    if (!ROLL_NUMBER_PATTERN.test(trimmedRoll)) {
      showError(
        'Validation Error',
        'Admission number contains invalid characters. Use only letters, numbers, hyphens, and underscores.'
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
        systemStatus.className = 'system-status-badge status-online';
        statusLabel.textContent = 'Api Session Active';
      } else {
        let errData = {};
        try {
          errData = await response.json();
        } catch {
          errData = { error: `Server returned unexpected status ${response.status}` };
        }

        const rawMsg = errData.error || 'Failed to retrieve profile image.';
        const msg = rawMsg.replace(/roll number/gi, 'admission number');

        if (response.status === 400) {
          showError('Invalid Admission Number', msg);
        } else if (response.status === 401) {
          showError('API Session Expired', 'Wait For Admin to fix the issue.', true);
          systemStatus.className = 'system-status-badge status-warning';
          statusLabel.textContent = 'API Session Expired';
        } else if (response.status === 404) {
          showError('Profile Not Found', msg);
        } else if (response.status === 429) {
          showError('Rate Limit Reached', msg);
        } else if (response.status === 504) {
          showError('Request Timed Out', msg);
        } else {
          showError('Gateway Error', msg);
        }
      }
    } catch {
      showError(
        'Connection Error',
        'Could not communicate with the server. Please ensure the server is reachable.'
      );
    } finally {
      setLoading(false);
    }
  });

  // Theme Toggle (Light / Dark Mode) with Circular View Transition
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const THEME_STORAGE_KEY = 'abes_theme_preference';

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (themeToggleBtn) {
        themeToggleBtn.setAttribute('aria-checked', 'true');
        themeToggleBtn.classList.add('is-dark');
      }
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (themeToggleBtn) {
        themeToggleBtn.setAttribute('aria-checked', 'false');
        themeToggleBtn.classList.remove('is-dark');
      }
    }
  }

  // Initialize theme from storage or system preference
  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);

  // Switch Theme with circular wave animation originating from the button
  function switchThemeWithAnimation(event) {
    const isCurrentlyDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextTheme = isCurrentlyDark ? 'light' : 'dark';
    localStorage.setItem(THEME_STORAGE_KEY, nextTheme);

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (document.startViewTransition && !prefersReducedMotion) {
      let x = window.innerWidth - 40;
      let y = 40;
      if (themeToggleBtn) {
        const rect = themeToggleBtn.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      const endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );

      const transition = document.startViewTransition(() => {
        applyTheme(nextTheme);
      });

      transition.ready.then(() => {
        document.documentElement.animate(
          {
            clipPath: [
              `circle(0px at ${x}px ${y}px)`,
              `circle(${endRadius}px at ${x}px ${y}px)`
            ]
          },
          {
            duration: 520,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            pseudoElement: '::view-transition-new(root)'
          }
        );
      });
    } else {
      applyTheme(nextTheme);
    }
  }

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', switchThemeWithAnimation);
  }

  
  // Robust Forced Download with GHOST-FLEET naming
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const adm = currentAdmissionNumber || displayRoll.textContent.trim() || rollNumberInput.value.trim() || 'student';
      const targetFilename = `GHOST-FLEET-${adm}.jpg`;

      const blobToDownload = currentBlob;
      let url = currentObjectUrl;
      let isTemp = false;

      if (blobToDownload) {
        url = URL.createObjectURL(blobToDownload);
        isTemp = true;
      }

      if (!url) return;

      const tempLink = document.createElement('a');
      tempLink.style.display = 'none';
      tempLink.href = url;
      tempLink.download = targetFilename;
      tempLink.setAttribute('download', targetFilename);
      document.body.appendChild(tempLink);
      tempLink.click();

      setTimeout(() => {
        if (document.body.contains(tempLink)) {
          document.body.removeChild(tempLink);
        }
        if (isTemp) {
          URL.revokeObjectURL(url);
        }
      }, 300);
    });
  }

  checkGatewayHealth();
  updateClearButton();

  // =========================================================================
  // ANTI-INSPECTION & DEVTOOLS TAMPER SHIELD (UI/UX Pro Max)
  // =========================================================================
  const securityModal = document.getElementById('securityModal');
  let isDevToolsActive = false;
  let devtoolsConsecutiveCleanChecks = 0;

  function lockWebsiteForInspection() {
    if (isDevToolsActive) return;
    isDevToolsActive = true;
    devtoolsConsecutiveCleanChecks = 0;

    document.body.classList.add('is-devtools-locked');
    if (securityModal) {
      securityModal.classList.remove('hidden');
      securityModal.setAttribute('aria-hidden', 'false');
    }
  }

  function unlockWebsiteFromInspection() {
    if (!isDevToolsActive) return;
    isDevToolsActive = false;

    document.body.classList.remove('is-devtools-locked');
    if (securityModal) {
      securityModal.classList.add('hidden');
      securityModal.setAttribute('aria-hidden', 'true');
    }
  }

  // Prevent closing via modal click
  if (securityModal) {
    securityModal.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
    }, { capture: true });
  }

  // 1. Trap Right-Click Context Menu (Inspect Entry Point)
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    lockWebsiteForInspection();
  }, { capture: true });

  // 2. Trap Keyboard Inspection Shortcuts
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isModifier = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key ? e.key.toUpperCase() : '';

    // F12
    if (e.key === 'F12' || e.keyCode === 123) {
      e.preventDefault();
      e.stopPropagation();
      lockWebsiteForInspection();
      return false;
    }

    // Ctrl+Shift+I / Cmd+Opt+I (Inspect)
    // Ctrl+Shift+J / Cmd+Opt+J (Console)
    // Ctrl+Shift+C / Cmd+Opt+C (Element Inspector)
    // Ctrl+U / Cmd+Opt+U (View Source)
    // Ctrl+Shift+K (Firefox Console)
    if (
      (isModifier && e.shiftKey && (key === 'I' || key === 'J' || key === 'C' || key === 'K')) ||
      (isModifier && key === 'U') ||
      (isMac && e.altKey && e.metaKey && (key === 'I' || key === 'J' || key === 'C' || key === 'U'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      lockWebsiteForInspection();
      return false;
    }

    // Block keyboard interactions outside modal while locked
    if (isDevToolsActive) {
      if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }, { capture: true });

  // 3. Multi-Vector DevTools Detection
  function checkWindowDimensions() {
    const threshold = 160;
    const widthDiff = window.outerWidth - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;
    return widthDiff > threshold || heightDiff > threshold;
  }

  let consoleDetectorFired = false;
  const detectorObj = new Image();
  Object.defineProperty(detectorObj, 'id', {
    get: function () {
      consoleDetectorFired = true;
      return 'sec-shield';
    }
  });

  function checkDebuggerTiming() {
    try {
      const t0 = performance.now();
      new Function('debugger')();
      const t1 = performance.now();
      return (t1 - t0) > 100;
    } catch {
      return false;
    }
  }

  function evaluateDevToolsState() {
    consoleDetectorFired = false;
    try {
      console.log(detectorObj);
      console.clear();
    } catch {}

    const isDimensionTriggered = checkWindowDimensions();
    const isTimingTriggered = checkDebuggerTiming();
    const isDetected = isDimensionTriggered || consoleDetectorFired || isTimingTriggered;

    if (isDetected) {
      devtoolsConsecutiveCleanChecks = 0;
      lockWebsiteForInspection();
    } else {
      if (isDevToolsActive) {
        devtoolsConsecutiveCleanChecks++;
        if (devtoolsConsecutiveCleanChecks >= 2) {
          unlockWebsiteFromInspection();
        }
      }
    }
  }

  setInterval(evaluateDevToolsState, 450);
  window.addEventListener('resize', evaluateDevToolsState);

  // 4. DOM Tamper Resistance
  if (window.MutationObserver && securityModal) {
    const observer = new MutationObserver(() => {
      if (isDevToolsActive) {
        if (!document.body.contains(securityModal)) {
          document.body.appendChild(securityModal);
        }
        if (securityModal.classList.contains('hidden')) {
          securityModal.classList.remove('hidden');
        }
        if (!document.body.classList.contains('is-devtools-locked')) {
          document.body.classList.add('is-devtools-locked');
        }
      }
    });
    observer.observe(document.body, { childList: true, attributes: true, subtree: true });
  }
});
