'use strict';

require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Configuration
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ERP_BASE_URL = process.env.ERP_BASE_URL || 'https://erp.abes.ac.in/Services/ProfilePic.aspx';
const ERP_LOGIN_URL = process.env.ERP_LOGIN_URL || 'https://erp.abes.ac.in/Login.aspx';
const ERP_KEEPALIVE_URL = process.env.ERP_KEEPALIVE_URL || 'https://erp.abes.ac.in/Home/Student/Default.aspx';

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 30; // 30 requests per minute
const ERP_TIMEOUT_MS = parseInt(process.env.ERP_TIMEOUT_MS, 10) || 15000; // 15 seconds default
const ERP_KEEPALIVE_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.ERP_KEEPALIVE_INTERVAL_MINUTES, 10) || 10);
const ERP_KEEPALIVE_STARTUP_DELAY_MS = parseInt(process.env.ERP_KEEPALIVE_STARTUP_DELAY_MS, 10) || 30000; // 30 seconds default
const MAX_IMAGE_SIZE_BYTES = parseInt(process.env.MAX_IMAGE_SIZE_BYTES, 10) || 5 * 1024 * 1024; // 5 MB default

// Disable fingerprinting
app.disable('x-powered-by');

// Trust proxy for accurate client IP resolution behind reverse proxies
app.set('trust proxy', 1);

// Security Headers Middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS Middleware for API endpoints (allows external frontends e.g. React/Next.js/mobile)
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, x-api-key');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// JSON body parser (if needed for API requests)
app.use(express.json());

// ============================================================================
// RATE LIMITING MIDDLEWARE (In-memory per-IP token/window limiter)
// ============================================================================
class InMemoryRateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.hits = new Map();

    // Periodically remove stale entries to avoid memory growth
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [ip, record] of this.hits.entries()) {
        if (now - record.startTime > this.windowMs) {
          this.hits.delete(ip);
        }
      }
    }, 60000);

    if (cleanupInterval.unref) {
      cleanupInterval.unref();
    }
  }

  middleware() {
    return (req, res, next) => {
      const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      let record = this.hits.get(clientIp);

      if (!record || (now - record.startTime > this.windowMs)) {
        record = { count: 1, startTime: now };
        this.hits.set(clientIp, record);
      } else {
        record.count++;
      }

      const remaining = Math.max(0, this.maxRequests - record.count);
      const resetTimeSeconds = Math.ceil((record.startTime + this.windowMs - now) / 1000);

      res.setHeader('RateLimit-Limit', this.maxRequests);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Reset', resetTimeSeconds);

      if (record.count > this.maxRequests) {
        res.setHeader('Retry-After', resetTimeSeconds);
        return res.status(429).json({
          error: `Rate limit exceeded. Maximum ${this.maxRequests} requests per minute allowed. Please try again in ${resetTimeSeconds} seconds.`
        });
      }

      next();
    };
  }
}

const rateLimiter = new InMemoryRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

// ============================================================================
// API KEY AUTHENTICATION MIDDLEWARE
// ============================================================================
function apiKeyAuth(req, res, next) {
  const configuredKey = (process.env.API_KEY || '').trim();

  // If no API_KEY is set in environment, open access is allowed
  if (!configuredKey) {
    return next();
  }

  // Allow same-origin requests from the built-in web frontend
  const isSameOrigin = req.headers['sec-fetch-site'] === 'same-origin' ||
                       (req.headers.referer && req.headers.host && req.headers.referer.includes(req.headers.host));
  if (isSameOrigin && !req.headers['x-api-key'] && !req.headers['authorization'] && !req.query.api_key && !req.query.key) {
    return next();
  }

  // Extract client-supplied key from header or query parameter
  let clientKey = req.headers['x-api-key'] ||
                  (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '').trim() : '') ||
                  req.query.api_key ||
                  req.query.key;

  if (typeof clientKey === 'string') {
    clientKey = clientKey.trim();
  }

  if (!clientKey) {
    return res.status(401).json({
      error: 'API key is required. Provide it via "x-api-key" header, "Authorization: Bearer <key>", or "?api_key=<key>" query parameter.'
    });
  }

  // Support multiple valid keys separated by comma for easy key rotation
  const validKeys = configuredKey.split(',').map(k => k.trim()).filter(Boolean);
  const isValid = validKeys.some(validKey => {
    if (clientKey.length !== validKey.length) return false;
    return crypto.timingSafeEqual(Buffer.from(clientKey), Buffer.from(validKey));
  });

  if (!isValid) {
    return res.status(403).json({
      error: 'Invalid API key provided. Access denied.'
    });
  }

  next();
}

// ============================================================================
// ROLL NUMBER VALIDATION
// ============================================================================
/**
 * Whitelist validation for roll number:
 * - Only letters (A-Z, a-z), numbers (0-9), hyphens (-), underscores (_)
 * - Length between 3 and 30 characters
 */
const ROLL_NUMBER_REGEX = /^[A-Za-z0-9_-]{3,30}$/;

function validateRollNumber(rollNumber) {
  if (!rollNumber || typeof rollNumber !== 'string') {
    return { valid: false, error: 'Roll number is required.' };
  }

  const trimmed = rollNumber.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Roll number cannot be empty.' };
  }

  if (trimmed.length < 3 || trimmed.length > 30) {
    return { valid: false, error: 'Roll number must be between 3 and 30 characters in length.' };
  }

  if (!ROLL_NUMBER_REGEX.test(trimmed)) {
    return {
      valid: false,
      error: 'Invalid roll number format. Only letters, numbers, hyphens, and underscores are allowed.'
    };
  }

  return { valid: true, value: trimmed };
}

// ============================================================================
// SERVER-SIDE COOKIE JAR
// ============================================================================
class ErpCookieJar {
  constructor() {
    this.cookies = new Map();
  }

  set(name, value, options = {}) {
    if (!name || typeof name !== 'string') return;
    const cleanName = name.trim();
    if (!value || (options.expires && options.expires < Date.now()) || options.maxAge === 0) {
      this.cookies.delete(cleanName);
      return;
    }
    this.cookies.set(cleanName, {
      value: String(value).trim(),
      domain: options.domain || '',
      path: options.path || '/',
      expires: options.expires || null
    });
  }

  get(name) {
    if (!name) return null;
    const entry = this.cookies.get(name.trim());
    if (!entry) return null;
    if (entry.expires && entry.expires < Date.now()) {
      this.cookies.delete(name.trim());
      return null;
    }
    return entry.value;
  }

  has(name) {
    return Boolean(this.get(name));
  }

  storeCookies(setCookieHeaders, requestUrl) {
    if (!setCookieHeaders) return;
    const headerList = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const header of headerList) {
      if (!header || typeof header !== 'string') continue;
      const parts = header.split(';').map(p => p.trim());
      if (parts.length === 0) continue;
      const [nameVal, ...attrList] = parts;
      const eqIdx = nameVal.indexOf('=');
      if (eqIdx === -1) continue;
      const name = nameVal.slice(0, eqIdx).trim();
      const value = nameVal.slice(eqIdx + 1).trim();

      const options = {};
      for (const attr of attrList) {
        const [k, v] = attr.split('=').map(s => (s ? s.trim() : ''));
        const lowerK = k.toLowerCase();
        if (lowerK === 'expires' && v) {
          const expMs = new Date(v).getTime();
          if (!isNaN(expMs)) options.expires = expMs;
        } else if (lowerK === 'max-age' && v) {
          const maxAgeSec = parseInt(v, 10);
          if (!isNaN(maxAgeSec)) options.expires = Date.now() + maxAgeSec * 1000;
        } else if (lowerK === 'path' && v) {
          options.path = v;
        } else if (lowerK === 'domain' && v) {
          options.domain = v;
        }
      }

      this.set(name, value, options);
    }
  }

  getCookieString(targetUrl) {
    const pairs = [];
    const now = Date.now();
    for (const [name, entry] of this.cookies.entries()) {
      if (entry.expires && entry.expires < now) {
        this.cookies.delete(name);
        continue;
      }
      pairs.push(`${name}=${entry.value}`);
    }
    return pairs.join('; ');
  }

  clear() {
    this.cookies.clear();
  }

  loadFromEnv() {
    const myAuth = (process.env.ERP_MYAUTH || '').trim();
    const sessionId = (process.env.ERP_ASP_NET_SESSION_ID || '').trim();
    if (myAuth) {
      this.set('MyAuth', myAuth, { path: '/' });
    }
    if (sessionId) {
      this.set('ASP.NET_SessionId', sessionId, { path: '/' });
    }
  }
}

const erpCookieJar = new ErpCookieJar();

// ============================================================================
// ERP SESSION STATE & KEEP-ALIVE MANAGEMENT
// ============================================================================
let erpSessionStatus = 'unknown'; // 'unknown' | 'active' | 'expired' | 'temporarily_unavailable'
let keepAliveInProgress = false;
let lastKeepAliveTime = null;
let lastKnownCredentialsHash = '';
let activeLoginPromise = null;

function checkCredentialsChanged(myAuth, sessionId) {
  const currentHash = `${myAuth}::${sessionId}::${process.env.ERP_USERNAME || ''}`;
  if (currentHash !== lastKnownCredentialsHash) {
    lastKnownCredentialsHash = currentHash;
    if (erpSessionStatus === 'expired') {
      erpSessionStatus = 'unknown';
    }
  }
}

function syncCredentialsToJar() {
  const myAuth = (process.env.ERP_MYAUTH || '').trim();
  const sessionId = (process.env.ERP_ASP_NET_SESSION_ID || '').trim();
  checkCredentialsChanged(myAuth, sessionId);

  if (myAuth && !erpCookieJar.has('MyAuth')) {
    erpCookieJar.set('MyAuth', myAuth, { path: '/' });
  }
  if (sessionId && !erpCookieJar.has('ASP.NET_SessionId')) {
    erpCookieJar.set('ASP.NET_SessionId', sessionId, { path: '/' });
  }
}

function isTimeoutOrAbortError(err) {
  if (!err) return false;
  return err.name === 'AbortError' ||
         err.name === 'TimeoutError' ||
         err.code === 'ABORT_ERR' ||
         Boolean(err.cause && (err.cause.name === 'AbortError' || err.cause.name === 'TimeoutError' || err.cause.code === 'ABORT_ERR')) ||
         (typeof err.message === 'string' && (err.message.includes('aborted') || err.message.includes('timeout')));
}

/**
 * Validates whether the current server-side session in erpCookieJar is authenticated.
 */
async function checkErpSession() {
  syncCredentialsToJar();
  const keepAliveUrl = process.env.ERP_KEEPALIVE_URL || ERP_KEEPALIVE_URL;
  const cookieString = erpCookieJar.getCookieString(keepAliveUrl);

  if (!cookieString || (!erpCookieJar.has('MyAuth') && !erpCookieJar.has('ASP.NET_SessionId'))) {
    erpSessionStatus = 'expired';
    return { authenticated: false, status: 'expired', reason: 'no_session_cookies' };
  }

  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.ERP_TIMEOUT_MS, 10) || ERP_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstreamRes = await fetch(keepAliveUrl, {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://erp.abes.ac.in/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'manual',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const setCookies = upstreamRes.headers.getSetCookie ? upstreamRes.headers.getSetCookie() : [upstreamRes.headers.get('set-cookie')];
    erpCookieJar.storeCookies(setCookies, keepAliveUrl);

    const status = upstreamRes.status;
    const location = (upstreamRes.headers.get('location') || '').toLowerCase();

    // 1. Session expiration redirects (301/302 to Login page)
    if (status === 301 || status === 302) {
      if (location.includes('login')) {
        erpSessionStatus = 'expired';
        return { authenticated: false, status: 'expired', reason: 'redirect_to_login' };
      }
      erpSessionStatus = 'temporarily_unavailable';
      return { authenticated: false, status: 'temporarily_unavailable', reason: 'unexpected_redirect' };
    }

    // 2. Direct HTTP 401 / 403
    if (status === 401 || status === 403) {
      erpSessionStatus = 'expired';
      return { authenticated: false, status: 'expired', reason: 'unauthorized' };
    }

    // 3. Upstream 5xx errors
    if (status >= 500) {
      erpSessionStatus = 'temporarily_unavailable';
      return { authenticated: false, status: 'temporarily_unavailable', reason: 'upstream_error' };
    }

    // 4. HTTP 200: Check content
    if (status === 200) {
      const text = await upstreamRes.text();
      const lower = text.toLowerCase();

      const isLoginPage = lower.includes('<title>login') ||
                          lower.includes('txtusername') ||
                          (lower.includes('txtuser') && lower.includes('login.aspx')) ||
                          lower.includes('name="txtpassword"') ||
                          lower.includes('object moved to');

      if (isLoginPage) {
        erpSessionStatus = 'expired';
        return { authenticated: false, status: 'expired', reason: 'login_form_returned' };
      }

      erpSessionStatus = 'active';
      return { authenticated: true, status: 'active' };
    }

    erpSessionStatus = 'temporarily_unavailable';
    return { authenticated: false, status: 'temporarily_unavailable', reason: `status_${status}` };

  } catch (err) {
    clearTimeout(timeoutId);
    erpSessionStatus = 'temporarily_unavailable';
    return {
      authenticated: false,
      status: 'temporarily_unavailable',
      reason: isTimeoutOrAbortError(err) ? 'timeout' : 'network_error'
    };
  }
}

/**
 * Executes legitimate ERP authentication flow using server-side credentials.
 * Never bypasses OTP or CAPTCHA; reports challenges cleanly if enforced by ERP.
 */
async function executeErpLoginFlow() {
  const username = (process.env.ERP_USERNAME || '').trim();
  const password = (process.env.ERP_PASSWORD || '').trim();
  const myAuth = (process.env.ERP_MYAUTH || '').trim();
  const sessionId = (process.env.ERP_ASP_NET_SESSION_ID || '').trim();

  if (!username && !password && !myAuth && !sessionId) {
    return {
      success: false,
      code: 'ERP_CREDENTIALS_MISSING',
      message: 'Server is not configured with ERP credentials (ERP_USERNAME/ERP_PASSWORD or ERP_MYAUTH/ERP_ASP_NET_SESSION_ID).'
    };
  }

  if (username && password) {
    console.log('[ERP] Starting authenticated login');
    const loginUrl = process.env.ERP_LOGIN_URL || 'https://erp.abes.ac.in/Login.aspx';

    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.ERP_TIMEOUT_MS, 10) || ERP_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Step A: Fetch initial Login.aspx page to extract Web Forms hidden fields and session
      const getRes = await fetch(loginUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        signal: controller.signal
      });

      const getCookies = getRes.headers.getSetCookie ? getRes.headers.getSetCookie() : [getRes.headers.get('set-cookie')];
      erpCookieJar.storeCookies(getCookies, loginUrl);

      const html = await getRes.text();
      const vsMatch = html.match(/name=["']__VIEWSTATE["'][^>]*value=["']([^"']*)["']/i);
      const vsgMatch = html.match(/name=["']__VIEWSTATEGENERATOR["'][^>]*value=["']([^"']*)["']/i);
      const evMatch = html.match(/name=["']__EVENTVALIDATION["'][^>]*value=["']([^"']*)["']/i);

      if (!vsMatch) {
        console.warn('[ERP] Failed to parse __VIEWSTATE from login page.');
        return {
          success: false,
          code: 'ERP_UNAVAILABLE',
          message: 'Unable to parse ASP.NET Web Forms state from ERP login page.'
        };
      }

      // Check if user account requires mandatory OTP / reCAPTCHA
      try {
        const typeUrl = loginUrl.replace(/Login\.aspx.*$/i, 'Login.aspx/GetUserLoginType');
        const typeRes = await fetch(typeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Cookie': erpCookieJar.getCookieString(loginUrl)
          },
          body: JSON.stringify({ UserID: username }),
          signal: controller.signal
        });
        if (typeRes.ok) {
          const typeData = await typeRes.json();
          const userType = typeData.d;
          const isDirectStaff = userType === 'School' || userType === 'school' || userType === 'EventAdmin';
          if (!isDirectStaff && userType) {
            console.warn('[ERP] ABES ERP requires OTP and reCAPTCHA challenge for this account type.');
            return {
              success: false,
              code: 'ERP_CHALLENGE_REQUIRED',
              message: 'ABES ERP enforces a mandatory OTP / reCAPTCHA security challenge for student accounts. In compliance with security restrictions, automated OTP/CAPTCHA bypass is not performed. Please authenticate in your browser and set authorized ERP_MYAUTH and ERP_ASP_NET_SESSION_ID session cookies.'
            };
          }
        }
      } catch (e) {
        // Continue with standard form post if GetUserLoginType check is not supported
      }

      // Build ASP.NET form post parameters
      const formData = new URLSearchParams();
      formData.append('__EVENTTARGET', '');
      formData.append('__EVENTARGUMENT', '');
      formData.append('__VIEWSTATE', vsMatch[1]);
      if (vsgMatch) formData.append('__VIEWSTATEGENERATOR', vsgMatch[1]);
      if (evMatch) formData.append('__EVENTVALIDATION', evMatch[1]);
      formData.append('txtuser', username);
      formData.append('txtPassword', password);
      formData.append('txtuserPassword', '');
      formData.append('btnStaff', 'Login');

      let origin = 'https://erp.abes.ac.in';
      try { origin = new URL(loginUrl).origin; } catch (e) {}

      const postRes = await fetch(loginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': erpCookieJar.getCookieString(loginUrl),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': loginUrl,
          'Origin': origin
        },
        body: formData.toString(),
        redirect: 'manual',
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const postCookies = postRes.headers.getSetCookie ? postRes.headers.getSetCookie() : [postRes.headers.get('set-cookie')];
      erpCookieJar.storeCookies(postCookies, loginUrl);

      const postStatus = postRes.status;
      const postLocation = (postRes.headers.get('location') || '').toLowerCase();

      // Check if redirect indicates successful login (redirect to student portal / dashboard)
      const isSuccessRedirect = (postStatus === 301 || postStatus === 302) && !postLocation.includes('login.aspx');

      if (isSuccessRedirect) {
        const sessionCheck = await checkErpSession();
        if (sessionCheck.authenticated) {
          console.log('[ERP] Login successful');
          return { success: true, code: 'LOGIN_SUCCESS' };
        }
      }

      console.warn('[ERP] Login failed');
      return {
        success: false,
        code: 'ERP_LOGIN_FAILED',
        message: 'ABES ERP login failed. Please verify credentials or check for security challenge requirements.'
      };

    } catch (err) {
      clearTimeout(timeoutId);
      if (isTimeoutOrAbortError(err)) {
        console.error('[ERP] Login request timed out');
        return {
          success: false,
          code: 'ERP_UNAVAILABLE',
          message: 'ABES ERP login request timed out.'
        };
      }
      console.error(`[ERP] Login error: ${err.message}`);
      return {
        success: false,
        code: 'ERP_UNAVAILABLE',
        message: `ABES ERP connection error: ${err.message}`
      };
    }
  }

  // Fallback: Check if pre-configured browser session cookies are valid
  syncCredentialsToJar();
  const sessionCheck = await checkErpSession();
  if (sessionCheck.authenticated) {
    return { success: true, code: 'SESSION_RESTORED' };
  }
  return {
    success: false,
    code: 'ERP_SESSION_ESTABLISHMENT_FAILED',
    message: 'ERP session establishment failed. Configured ERP session cookies are expired or invalid.'
  };
}

/**
 * Single-flight login coordinator.
 * Prevents multiple simultaneous login attempts; concurrent callers await the shared flight.
 */
function performErpLogin() {
  if (activeLoginPromise) {
    console.log('[ERP] Login already in progress. Awaiting shared login flight...');
    return activeLoginPromise;
  }

  activeLoginPromise = (async () => {
    try {
      return await executeErpLoginFlow();
    } finally {
      activeLoginPromise = null;
    }
  })();

  return activeLoginPromise;
}

/**
 * Dedicated backend keep-alive function to keep the ERP session active.
 */
async function keepErpSessionAlive() {
  if (keepAliveInProgress) {
    console.log('[ERP KEEPALIVE] Another keep-alive request is currently in progress. Skipping.');
    return erpSessionStatus;
  }

  const hasCredentials = Boolean(
    (process.env.ERP_USERNAME && process.env.ERP_PASSWORD) ||
    (process.env.ERP_MYAUTH && process.env.ERP_ASP_NET_SESSION_ID) ||
    erpCookieJar.has('MyAuth') || erpCookieJar.has('ASP.NET_SessionId')
  );

  if (!hasCredentials) {
    erpSessionStatus = 'unknown';
    console.log('[ERP KEEPALIVE] Session credentials not configured in environment.');
    return erpSessionStatus;
  }

  keepAliveInProgress = true;
  console.log('[ERP KEEPALIVE] Started');

  try {
    const check = await checkErpSession();
    lastKeepAliveTime = Date.now();
    if (check.authenticated) {
      console.log('[ERP KEEPALIVE] Success - status 200');
      console.log('[ERP KEEPALIVE] ERP session appears active');
    } else if (check.status === 'expired') {
      console.warn('[ERP KEEPALIVE] ERP session expired');
    } else {
      console.warn(`[ERP KEEPALIVE] Upstream status: ${check.reason || check.status}`);
    }
    return erpSessionStatus;
  } finally {
    keepAliveInProgress = false;
  }
}

let keepAliveTimer = null;
let keepAliveInterval = null;

function startKeepAliveScheduler() {
  if (process.env.ERP_KEEPALIVE_ENABLED === 'false') {
    console.log('[ERP KEEPALIVE] Disabled via ERP_KEEPALIVE_ENABLED=false.');
    return;
  }

  const hasCredentials = Boolean(
    (process.env.ERP_USERNAME && process.env.ERP_PASSWORD) ||
    (process.env.ERP_MYAUTH && process.env.ERP_ASP_NET_SESSION_ID)
  );

  if (!hasCredentials) {
    console.log('[ERP KEEPALIVE] Session credentials not configured in environment. Scheduler idle.');
    return;
  }

  const intervalMinutes = Math.max(1, parseInt(process.env.ERP_KEEPALIVE_INTERVAL_MINUTES, 10) || 10);
  const startupDelayMs = parseInt(process.env.ERP_KEEPALIVE_STARTUP_DELAY_MS, 10) || 30000;

  console.log(`[ERP KEEPALIVE] Scheduler initialized. First run in ${startupDelayMs / 1000}s, interval ${intervalMinutes}m.`);

  keepAliveTimer = setTimeout(async () => {
    await keepErpSessionAlive();
    keepAliveInterval = setInterval(keepErpSessionAlive, intervalMinutes * 60 * 1000);
    if (keepAliveInterval.unref) keepAliveInterval.unref();
  }, startupDelayMs);

  if (keepAliveTimer.unref) keepAliveTimer.unref();
}

function stopKeepAliveScheduler() {
  if (keepAliveTimer) clearTimeout(keepAliveTimer);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * Health check endpoint (does not leak any credentials)
 */
app.get('/api/health', (req, res) => {
  const hasUserPass = Boolean(process.env.ERP_USERNAME && process.env.ERP_PASSWORD);
  const hasCookies = Boolean(
    (process.env.ERP_MYAUTH && process.env.ERP_ASP_NET_SESSION_ID) ||
    erpCookieJar.has('MyAuth') || erpCookieJar.has('ASP.NET_SessionId')
  );

  res.json({
    status: 'ok',
    erpSession: erpSessionStatus,
    sessionConfigured: Boolean(hasUserPass || hasCookies),
    loginConfigured: hasUserPass,
    apiKeyRequired: Boolean((process.env.API_KEY || '').trim()),
    rateLimitMax: RATE_LIMIT_MAX,
    windowSeconds: RATE_LIMIT_WINDOW_MS / 1000,
    keepAliveEnabled: process.env.ERP_KEEPALIVE_ENABLED !== 'false',
    keepAliveIntervalMinutes: parseInt(process.env.ERP_KEEPALIVE_INTERVAL_MINUTES, 10) || 10,
    lastKeepAlive: lastKeepAliveTime ? new Date(lastKeepAliveTime).toISOString() : null
  });
});

/**
 * GET /api/profile/:rollNumber
 * GET /api/profile/:rollNumber/json
 * Secure proxy to fetch the profile photo from ERP with authorized session
 */
app.get(['/api/profile/:rollNumber', '/api/profile/:rollNumber/json'], rateLimiter.middleware(), apiKeyAuth, async (req, res) => {
  const { rollNumber } = req.params;

  // 1. Input Validation
  const validation = validateRollNumber(rollNumber);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const sanitizedRoll = validation.value;

  // 2. Verify and re-authenticate ERP session if needed
  let sessionValid = erpSessionStatus === 'active';
  if (!sessionValid) {
    const sessionCheck = await checkErpSession();
    sessionValid = sessionCheck.authenticated;
  }

  if (!sessionValid) {
    console.log('[ERP] Session invalid or expired. Attempting automated re-authentication...');
    const loginResult = await performErpLogin();

    if (!loginResult.success) {
      console.warn(`[ERP] Re-authentication failed: ${loginResult.code}`);
      const httpStatus = loginResult.code === 'ERP_UNAVAILABLE' ? 502 : 401;
      return res.status(httpStatus).json({
        error: loginResult.message || 'ERP session has expired or is invalid. Please refresh the authorized ERP credentials.',
        code: loginResult.code
      });
    }

    // Confirm session validity after login
    const postLoginCheck = await checkErpSession();
    if (!postLoginCheck.authenticated) {
      return res.status(401).json({
        error: 'ERP session establishment failed after login.',
        code: 'ERP_SESSION_ESTABLISHMENT_FAILED'
      });
    }
  }

  // 3. Prepare ERP profile request
  const profileBaseUrl = process.env.ERP_BASE_URL || ERP_BASE_URL;
  const upstreamUrl = `${profileBaseUrl}?ID=${encodeURIComponent(sanitizedRoll)}`;
  const cookieHeader = erpCookieJar.getCookieString(upstreamUrl);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ERP_TIMEOUT_MS);

  try {
    console.log(`[ERP Request] Initiating profile fetch for ID: ${sanitizedRoll}`);

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        'Cookie': cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://erp.abes.ac.in/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      redirect: 'manual',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Store any Set-Cookie sent by profile endpoint
    const setCookies = upstreamRes.headers.getSetCookie ? upstreamRes.headers.getSetCookie() : [upstreamRes.headers.get('set-cookie')];
    erpCookieJar.storeCookies(setCookies, upstreamUrl);

    const status = upstreamRes.status;
    const location = upstreamRes.headers.get('location') || '';
    const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

    console.log(`[ERP Response] Status: ${status}, Content-Type: ${contentType || 'none'}`);

    // If profile request discovered session has expired:
    if (status === 301 || status === 302) {
      if (location.toLowerCase().includes('login')) {
        erpSessionStatus = 'expired';
        console.warn(`[Auth Warning] ERP redirected to login page (${location}). Session has expired.`);
        return res.status(401).json({
          error: 'ERP session has expired or is invalid. Please refresh the authorized ERP credentials.',
          code: 'ERP_SESSION_EXPIRED'
        });
      }
      return res.status(502).json({
        error: `ERP returned unexpected redirect to: ${location}`
      });
    }

    if (status === 401 || status === 403) {
      erpSessionStatus = 'expired';
      console.warn(`[Auth Warning] ERP returned status ${status}.`);
      return res.status(401).json({
        error: 'ERP session is unauthorized or has expired. Please update credentials.',
        code: 'ERP_SESSION_EXPIRED'
      });
    }

    if (status === 404) {
      return res.status(404).json({
        error: `Profile image not found for roll number: ${sanitizedRoll}`
      });
    }

    if (status >= 500) {
      console.error(`[ERP Error] Upstream server error status: ${status}`);
      return res.status(502).json({
        error: `ABES ERP server encountered an error (HTTP ${status}). Please try again later.`,
        code: 'ERP_UNAVAILABLE'
      });
    }

    if (status !== 200) {
      return res.status(502).json({
        error: `ERP returned unexpected status code: ${status}`
      });
    }

    const isImage = contentType.startsWith('image/') ||
                    contentType.includes('jpeg') ||
                    contentType.includes('png') ||
                    contentType.includes('webp');

    if (!isImage) {
      console.warn(`[Validation Error] ERP returned non-image content type: ${contentType}`);
      const bodySnippet = (await upstreamRes.text()).slice(0, 1000);
      if (bodySnippet.toLowerCase().includes('login') || bodySnippet.toLowerCase().includes('object moved')) {
        erpSessionStatus = 'expired';
        return res.status(401).json({
          error: 'ERP session has expired or is invalid. Please re-authenticate and update credentials.',
          code: 'ERP_SESSION_EXPIRED'
        });
      }
      return res.status(502).json({
        error: 'ERP returned an unexpected response format instead of an image.'
      });
    }

    const arrayBuffer = await upstreamRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length === 0) {
      return res.status(404).json({
        error: `No image data returned for roll number: ${sanitizedRoll}`
      });
    }

    if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
      console.error(`[Security Warning] Image size exceeded maximum limit: ${buffer.length} bytes`);
      return res.status(502).json({
        error: 'Profile image returned by ERP exceeds maximum permissible size.'
      });
    }

    erpSessionStatus = 'active';

    const isJsonRequested = req.path.endsWith('/json') || 
                            (req.query.format && req.query.format.toLowerCase() === 'json');
    const cleanContentType = contentType.split(';')[0].trim();

    if (isJsonRequested) {
      const base64Data = buffer.toString('base64');
      return res.status(200).json({
        success: true,
        rollNumber: sanitizedRoll,
        contentType: cleanContentType,
        sizeBytes: buffer.length,
        base64: base64Data,
        dataUrl: `data:${cleanContentType};base64,${base64Data}`
      });
    }

    res.setHeader('Content-Type', cleanContentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    return res.status(200).send(buffer);

  } catch (err) {
    clearTimeout(timeoutId);

    if (isTimeoutOrAbortError(err)) {
      console.error(`[Timeout] Request to ERP timed out after ${ERP_TIMEOUT_MS}ms for roll number: ${sanitizedRoll}`);
      return res.status(504).json({
        error: `ERP request timed out after ${Math.round(ERP_TIMEOUT_MS / 1000)} seconds. The upstream server may be offline or unreachable.`,
        code: 'GATEWAY_TIMEOUT'
      });
    }

    console.error(`[Fetch Error] Failed to retrieve ERP profile: ${err.message}`);
    return res.status(502).json({
      error: 'Failed to communicate with ABES ERP server. Please try again later.'
    });
  }
});

// ============================================================================
// SERVE FRONTEND STATIC FILES
// ============================================================================
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all for API 404s
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Single Page Application fallback to index.html for UI routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Error Handler (prevents leaking internal stack traces)
app.use((err, req, res, next) => {
  console.error('[Internal Server Error]', err && err.message ? err.message : 'Unknown error');
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

// Start server only when executed directly (allows clean testing & importing)
let server = null;
if (require.main === module) {
  server = app.listen(PORT, () => {
    console.log(`====================================================`);
    const hasUserPass = Boolean(process.env.ERP_USERNAME && process.env.ERP_PASSWORD);
    const hasCookies = Boolean(process.env.ERP_MYAUTH && process.env.ERP_ASP_NET_SESSION_ID);
    console.log(` Credentials configured: ${hasUserPass ? 'USERNAME/PASSWORD' : hasCookies ? 'SESSION COOKIES' : 'NONE'}`);
    console.log(` Rate Limit: ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
    console.log(` Keep-Alive Interval: ${ERP_KEEPALIVE_INTERVAL_MINUTES} minutes`);
    console.log(`====================================================`);
    startKeepAliveScheduler();
  });
}

module.exports = {
  app,
  server,
  validateRollNumber,
  InMemoryRateLimiter,
  apiKeyAuth,
  ErpCookieJar,
  erpCookieJar,
  checkErpSession,
  executeErpLoginFlow,
  performErpLogin,
  keepErpSessionAlive,
  startKeepAliveScheduler,
  stopKeepAliveScheduler,
  getErpSessionStatus: () => erpSessionStatus,
  setErpSessionStatus: (status) => { erpSessionStatus = status; },
  checkCredentialsChanged
};
