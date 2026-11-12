/**
 * ABES Student Profile Viewer - Frontend Application
 * Handles secure communication with the backend profile proxy.
 */

'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
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

  // Track active blob URL for memory cleanup
  let currentObjectUrl = null;

  // Validation regular expression: 3 to 30 alphanumeric characters, hyphens, or underscores
  const ROLL_NUMBER_PATTERN = /^[A-Za-z0-9_-]{3,30}$/;

  /**
   * Check backend health and session status on load
   */
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
            statusLabel.textContent = 'ERP Session Expired';
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

  /**
   * Clean up previously allocated object URL
   */
  function cleanupObjectUrl() {
    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }
  }

  /**
   * Reset all dynamic states (loading, error, result)
   */
  function resetStates() {
    loadingState.classList.add('hidden');
    errorState.classList.add('hidden');
    resultState.classList.add('hidden');
    adminTip.classList.add('hidden');
    rollNumberInput.classList.remove('input-error');
  }

  /**
   * Display an error message with appropriate styling and tips
   */
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

  /**
   * Display successful profile image
   */
  function showResult(blob, rollNumber) {
    resetStates();
    cleanupObjectUrl();

    currentObjectUrl = URL.createObjectURL(blob);
    profileImage.src = currentObjectUrl;
    displayRoll.textContent = rollNumber;

    // Configure download button
    downloadBtn.href = currentObjectUrl;
    downloadBtn.download = `ABES_${rollNumber}.jpg`;

    // Configure open in new tab
    openNewTabBtn.href = currentObjectUrl;

    resultState.classList.remove('hidden');
  }

  /**
   * Set loading UI state
   */
  function setLoading(isLoading) {
    if (isLoading) {
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

  /**
   * Toggle visibility of clear button based on input value
   */
  function updateClearButton() {
    if (rollNumberInput.value.trim().length > 0) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }

  // Handle Input Changes
  rollNumberInput.addEventListener('input', () => {
    updateClearButton();
    rollNumberInput.classList.remove('input-error');
  });

  // Handle Clear Button
  clearBtn.addEventListener('click', () => {
    rollNumberInput.value = '';
    updateClearButton();
    rollNumberInput.focus();
    resetStates();
  });

  // Handle Search Submission
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const rawRoll = rollNumberInput.value;
    const trimmedRoll = rawRoll.trim();

    // 1. Client-Side Validation
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

    // 2. Execute Request to Backend API
    setLoading(true);

    try {
      const response = await fetch(`/api/profile/${encodeURIComponent(trimmedRoll)}`);

      // Check if response is successful and contains an image
      const contentType = response.headers.get('content-type') || '';

      if (response.ok && contentType.startsWith('image/')) {
        const imageBlob = await response.blob();
        showResult(imageBlob, trimmedRoll);
        systemStatus.className = 'system-status-badge status-online';
        statusLabel.textContent = 'ERP Session Active';
      } else {
        // Parse JSON error response
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
          showError('ERP Session Expired', msg, true);
          systemStatus.className = 'system-status-badge status-warning';
          statusLabel.textContent = 'ERP Session Expired';
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
    } catch (networkErr) {
      showError(
        'Connection Error',
        'Could not communicate with the local server. Please ensure the server is running.'
      );
    } finally {
      setLoading(false);
    }
  });

  // Initialize
  checkGatewayHealth();
  updateClearButton();
});
