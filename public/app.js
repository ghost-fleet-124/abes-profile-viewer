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
            statusLabel.textContent = 'ERP Session Active';
          } else if (data.erpSession === 'expired') {
            systemStatus.className = 'system-status-badge status-warning';
            statusLabel.textContent = 'API Session Expired';
          } else if (data.erpSession === 'temporarily_unavailable') {
            systemStatus.className = 'system-status-badge status-warning';
            statusLabel.textContent = 'ERP Unavailable';
          } else {
            systemStatus.className = 'system-status-badge status-online';
            statusLabel.textContent = 'ERP Session Configured';
          }
        } else {
          systemStatus.className = 'system-status-badge status-warning';
          statusLabel.textContent = 'ERP Session Not Configured';
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

    currentObjectUrl = URL.createObjectURL(blob);
    profileImage.src = currentObjectUrl;
    displayRoll.textContent = rollNumber;

    downloadBtn.href = currentObjectUrl;
    downloadBtn.download = `ABES_${rollNumber}.jpg`;
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
      showError('Validation Error', 'Please enter a student roll number.');
      rollNumberInput.focus();
      return;
    }

    if (trimmedRoll.length < 3 || trimmedRoll.length > 30) {
      showError('Validation Error', 'Roll number must be between 3 and 30 characters.');
      rollNumberInput.focus();
      return;
    }

    if (!ROLL_NUMBER_PATTERN.test(trimmedRoll)) {
      showError(
        'Validation Error',
        'Roll number contains invalid characters. Use only letters, numbers, hyphens, and underscores.'
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
        statusLabel.textContent = 'ERP Session Active';
      } else {
        let errData = {};
        try {
          errData = await response.json();
        } catch {
          errData = { error: `Server returned unexpected status ${response.status}` };
        }

        const msg = errData.error || 'Failed to retrieve profile image.';

        if (response.status === 400) {
          showError('Invalid Roll Number', msg);
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

  // Live Poll Functionality
  const pollBtnYes = document.getElementById('pollBtnYes');
  const pollBtnNo = document.getElementById('pollBtnNo');
  const pollCountYes = document.getElementById('pollCountYes');
  const pollCountNo = document.getElementById('pollCountNo');
  const pollBarYes = document.getElementById('pollBarYes');
  const pollBarNo = document.getElementById('pollBarNo');
  const pollTotalVotes = document.getElementById('pollTotalVotes');
  const pollStatusNotice = document.getElementById('pollStatusNotice');

  const POLL_STORAGE_KEY = 'abes_poll_voted_choice';

  function updatePollUI(data, userChoice) {
    if (!data) return;
    const total = data.total || 0;
    const yesCount = data.yes || 0;
    const noCount = data.no || 0;
    const yesPct = total > 0 ? Math.round((yesCount / total) * 100) : 0;
    const noPct = total > 0 ? Math.round((noCount / total) * 100) : 0;

    if (pollCountYes) pollCountYes.innerHTML = `${yesCount} <span class="poll-percentage">(${yesPct}%)</span>`;
    if (pollCountNo) pollCountNo.innerHTML = `${noCount} <span class="poll-percentage">(${noPct}%)</span>`;
    if (pollBarYes) pollBarYes.style.width = `${yesPct}%`;
    if (pollBarNo) pollBarNo.style.width = `${noPct}%`;
    if (pollTotalVotes) pollTotalVotes.textContent = `${total} total vote${total === 1 ? '' : 's'}`;

    const choice = userChoice || localStorage.getItem(POLL_STORAGE_KEY) || (data.hasVoted ? 'voted' : null);
    if (choice) {
      if (pollBtnYes) {
        pollBtnYes.disabled = true;
        if (choice === 'yes') pollBtnYes.classList.add('voted-choice');
      }
      if (pollBtnNo) {
        pollBtnNo.disabled = true;
        if (choice === 'no') pollBtnNo.classList.add('voted-choice');
      }
      if (pollStatusNotice) pollStatusNotice.classList.remove('hidden');
    }
  }

  async function fetchPollData() {
    try {
      const res = await fetch('/api/poll');
      if (res.ok) {
        const data = await res.json();
        updatePollUI(data);
      }
    } catch {
      // Fail silently
    }
  }

  async function castVote(option) {
    try {
      if (pollBtnYes) pollBtnYes.disabled = true;
      if (pollBtnNo) pollBtnNo.disabled = true;

      const res = await fetch('/api/poll/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ option })
      });

      if (res.ok) {
        const data = await res.json();
        localStorage.setItem(POLL_STORAGE_KEY, option);
        updatePollUI(data, option);
      } else {
        fetchPollData();
      }
    } catch {
      fetchPollData();
    }
  }

  if (pollBtnYes) pollBtnYes.addEventListener('click', () => castVote('yes'));
  if (pollBtnNo) pollBtnNo.addEventListener('click', () => castVote('no'));

  fetchPollData();
  setInterval(fetchPollData, 10000);

  checkGatewayHealth();
  updateClearButton();
});
