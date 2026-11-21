'use strict';

require('dotenv').config();
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ERP_BASE_URL = process.env.ERP_BASE_URL || 'https://erp.abes.ac.in/Services/ProfilePic.aspx';
const ERP_LOGIN_URL = process.env.ERP_LOGIN_URL || 'https://erp.abes.ac.in/Login.aspx';
const ERP_KEEPALIVE_URL = process.env.ERP_KEEPALIVE_URL || 'https://erp.abes.ac.in/Home/Student/Default.aspx';

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000;
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 30;
const ERP_TIMEOUT_MS = parseInt(process.env.ERP_TIMEOUT_MS, 10) || 15000;
const ERP_KEEPALIVE_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.ERP_KEEPALIVE_INTERVAL_MINUTES, 10) || 1);
const ERP_KEEPALIVE_INTERVAL_SECONDS = Math.max(15, parseInt(process.env.ERP_KEEPALIVE_INTERVAL_SECONDS, 10) || (ERP_KEEPALIVE_INTERVAL_MINUTES * 60));
const ERP_KEEPALIVE_STARTUP_DELAY_MS = Math.max(500, parseInt(process.env.ERP_KEEPALIVE_STARTUP_DELAY_MS, 10) || 2000);
const MAX_IMAGE_SIZE_BYTES = parseInt(process.env.MAX_IMAGE_SIZE_BYTES, 10) || 5 * 1024 * 1024;
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS, 10) || 5 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

const profileCache = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-DNS-Prefetch-Control', 'on');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
});

// Guard against prototype pollution in URL, query, and parameter structures
app.use((req, res, next) => {
  const rawUrl = decodeURIComponent(req.originalUrl || req.url || '');
  if (rawUrl.includes('__proto__') || rawUrl.includes('constructor[prototype]') || rawUrl.includes('prototype[')) {
    return res.status(400).json({ error: 'Malicious prototype pollution parameter detected.' });
  }
  if (req.query && typeof req.query === 'object') {
    for (const key of Object.getOwnPropertyNames(req.query)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return res.status(400).json({ error: 'Malicious prototype pollution parameter detected.' });
      }
    }
  }
  next();
});

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

app.use(express.json({ limit: '10kb' }));

class InMemoryRateLimiter {
  constructor(windowMs, maxRequests) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.hits = new Map();
    this.maxTrackedIps = 10000;

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
        if (this.hits.size >= this.maxTrackedIps) {
          const oldestKey = this.hits.keys().next().value;
          this.hits.delete(oldestKey);
        }
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

function apiKeyAuth(req, res, next) {
  const configuredKey = (process.env.API_KEY || '').trim();

  if (!configuredKey) {
    return next();
  }

  const isSameOrigin = req.headers['sec-fetch-site'] === 'same-origin' ||
                       (req.headers.referer && req.headers.host && req.headers.referer.includes(req.headers.host));
  if (isSameOrigin && !req.headers['x-api-key'] && !req.headers['authorization'] && !req.query.api_key && !req.query.key) {
    return next();
  }

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

const ROLL_NUMBER_REGEX = /^[A-Za-z0-9_-]{3,30}$/;

function isSafeUpstreamUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname.toLowerCase();
    
    // In test environment, permit localhost / 127.0.0.1 for mock ERP servers
    if (process.env.NODE_ENV === 'test' || hostname === '127.0.0.1' || hostname === 'localhost') {
      return true;
    }
    
    // Disallow dangerous internal cloud metadata & private subnet IPs (SSRF protection)
    if (
      hostname === '169.254.169.254' ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('172.17.') ||
      hostname.startsWith('172.18.') ||
      hostname.startsWith('172.19.') ||
      hostname.startsWith('172.2') ||
      hostname.startsWith('172.30.') ||
      hostname.startsWith('172.31.') ||
      hostname === '0.0.0.0' ||
      hostname === '::1'
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validateRollNumber(rollNumber) {
  if (!rollNumber || typeof rollNumber !== 'string') {
    return { valid: false, error: 'Roll number is required.' };
  }

  // Reject null bytes, control characters, or non-printable ASCII
  if (/[\x00-\x1f\x7f]/.test(rollNumber) || rollNumber.includes('%00')) {
    return { valid: false, error: 'Invalid characters detected in roll number.' };
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

  touchSessionCookies() {
    // When keepalive or ERP request succeeds, ASP.NET sliding session window is refreshed upstream.
    // Extend in-memory expiration of session cookies so they remain active continuously.
    const extendedExpiry = Date.now() + 24 * 60 * 60 * 1000;
    for (const [name, entry] of this.cookies.entries()) {
      if (entry && entry.expires) {
        entry.expires = extendedExpiry;
      }
    }
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

let erpSessionStatus = 'unknown';
let keepAliveInProgress = false;
let lastKeepAliveTime = null;
let lastKnownCredentialsHash = '';
let activeLoginPromise = null;

function checkCredentialsChanged(myAuth, sessionId) {
  const currentHash = `${myAuth}::${sessionId}::${process.env.ERP_USERNAME || ''}`;
  if (currentHash !== lastKnownCredentialsHash) {
    lastKnownCredentialsHash = currentHash;
    profileCache.clear();
    if (erpSessionStatus === 'expired') {
      erpSessionStatus = 'unknown';
    }
    // Update cookies in the jar with new credentials from env
    if (myAuth) {
      erpCookieJar.set('MyAuth', myAuth, { path: '/' });
    }
    if (sessionId) {
      erpCookieJar.set('ASP.NET_SessionId', sessionId, { path: '/' });
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
    let currentUrl = keepAliveUrl;
    let redirectHops = 0;
    const maxRedirects = 2;

    while (redirectHops <= maxRedirects) {
      const currentCookies = erpCookieJar.getCookieString(currentUrl);
      const upstreamRes = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'Cookie': currentCookies,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer': 'https://erp.abes.ac.in/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'manual',
        signal: controller.signal
      });

      const setCookies = upstreamRes.headers.getSetCookie ? upstreamRes.headers.getSetCookie() : [upstreamRes.headers.get('set-cookie')];
      erpCookieJar.storeCookies(setCookies, currentUrl);

      const status = upstreamRes.status;
      const rawLocation = upstreamRes.headers.get('location') || '';
      const location = rawLocation.toLowerCase();

      if (status === 301 || status === 302) {
        if (location.includes('login')) {
          clearTimeout(timeoutId);
          erpSessionStatus = 'expired';
          return { authenticated: false, status: 'expired', reason: 'redirect_to_login' };
        }

        let nextUrl;
        try {
          nextUrl = new URL(rawLocation, currentUrl).href;
        } catch {
          nextUrl = null;
        }

        if (nextUrl && isSafeUpstreamUrl(nextUrl) && redirectHops < maxRedirects) {
          currentUrl = nextUrl;
          redirectHops++;
          continue;
        } else {
          clearTimeout(timeoutId);
          erpSessionStatus = 'active';
          erpCookieJar.touchSessionCookies();
          return { authenticated: true, status: 'active', reason: 'authenticated_redirect' };
        }
      }

      clearTimeout(timeoutId);

      if (status === 401 || status === 403) {
        erpSessionStatus = 'expired';
        return { authenticated: false, status: 'expired', reason: 'unauthorized' };
      }

      if (status >= 500) {
        erpSessionStatus = 'temporarily_unavailable';
        return { authenticated: false, status: 'temporarily_unavailable', reason: 'upstream_error' };
      }

      if (status === 200) {
        const text = await upstreamRes.text();
        const lower = text.toLowerCase();

        const isLoginPage = lower.includes('<title>login') ||
                            lower.includes('txtusername') ||
                            (lower.includes('txtuser') && lower.includes('login.aspx')) ||
                            lower.includes('name="txtpassword"') ||
                            (lower.includes('object moved to') && lower.includes('login'));

        if (isLoginPage) {
          erpSessionStatus = 'expired';
          return { authenticated: false, status: 'expired', reason: 'login_form_returned' };
        }

        erpSessionStatus = 'active';
        erpCookieJar.touchSessionCookies();
        return { authenticated: true, status: 'active' };
      }

      erpSessionStatus = 'temporarily_unavailable';
      return { authenticated: false, status: 'temporarily_unavailable', reason: `status_${status}` };
    }

    clearTimeout(timeoutId);
    erpSessionStatus = 'active';
    erpCookieJar.touchSessionCookies();
    return { authenticated: true, status: 'active' };

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

async function executeErpLoginFlow() {
  const username = (process.env.ERP_USERNAME || '').trim();
  const password = (process.env.ERP_PASSWORD || '').trim();
  const myAuth = (process.env.ERP_MYAUTH || '').trim();
  const sessionId = (process.env.ERP_ASP_NET_SESSION_ID || '').trim();

  if (!username && !password && !myAuth && !sessionId) {
    return {
      success: false,
      code: 'ERP_CREDENTIALS_MISSING',
      message: 'Server is not configured with ERP credentials.'
    };
  }

  if (username && password) {
    console.log('[ERP] Starting authenticated login');
    const loginUrl = process.env.ERP_LOGIN_URL || 'https://erp.abes.ac.in/Login.aspx';

    const controller = new AbortController();
    const timeoutMs = parseInt(process.env.ERP_TIMEOUT_MS, 10) || ERP_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
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
        return {
          success: false,
          code: 'ERP_UNAVAILABLE',
          message: 'Unable to parse ASP.NET Web Forms state from ERP login page.'
        };
      }

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
              message: 'ABES ERP requires OTP and reCAPTCHA challenge for this account type.'
            };
          }
        }
      } catch (e) {}

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
        message: 'ABES ERP login failed. Please verify credentials.'
      };

    } catch (err) {
      clearTimeout(timeoutId);
      if (isTimeoutOrAbortError(err)) {
        return {
          success: false,
          code: 'ERP_UNAVAILABLE',
          message: 'ABES ERP login request timed out.'
        };
      }
      return {
        success: false,
        code: 'ERP_UNAVAILABLE',
        message: `ABES ERP connection error: ${err.message}`
      };
    }
  }

  syncCredentialsToJar();
  const sessionCheck = await checkErpSession();
  if (sessionCheck.authenticated) {
    return { success: true, code: 'SESSION_RESTORED' };
  }
  return {
    success: false,
    code: 'ERP_SESSION_ESTABLISHMENT_FAILED',
    message: 'ERP session has expired or is invalid. Wait For Admin to fix the issue.'
  };
}

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
  console.log('[ERP KEEPALIVE] Heartbeat cycle initiated');

  try {
    let check = await checkErpSession();
    lastKeepAliveTime = Date.now();

    if (check.authenticated) {
      console.log('[ERP KEEPALIVE] Success - ERP session verified active and refreshed');
    } else if (check.status === 'expired') {
      console.warn('[ERP KEEPALIVE] ERP session expired');

      // Automated Self-Healing: if login credentials exist in env, auto-reauthenticate immediately!
      if (process.env.ERP_USERNAME && process.env.ERP_PASSWORD) {
        console.log('[ERP KEEPALIVE] Credentials present. Executing automated background re-login...');
        const loginRes = await performErpLogin();
        if (loginRes.success) {
          console.log('[ERP KEEPALIVE] Background re-login succeeded! Session restored to active.');
          erpSessionStatus = 'active';
    erpCookieJar.touchSessionCookies();
        } else {
          console.warn(`[ERP KEEPALIVE] Background re-login failed: ${loginRes.code} - ${loginRes.message}`);
          erpSessionStatus = 'expired';
        }
      } else {
        syncCredentialsToJar();
      }
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
    return;
  }

  const hasCredentials = Boolean(
    (process.env.ERP_USERNAME && process.env.ERP_PASSWORD) ||
    (process.env.ERP_MYAUTH && process.env.ERP_ASP_NET_SESSION_ID)
  );

  if (!hasCredentials) {
    return;
  }

  const intervalMinutes = Math.max(1, parseInt(process.env.ERP_KEEPALIVE_INTERVAL_MINUTES, 10) || 1);
  const intervalSeconds = Math.max(15, parseInt(process.env.ERP_KEEPALIVE_INTERVAL_SECONDS, 10) || (intervalMinutes * 60));
  const startupDelayMs = Math.max(500, parseInt(process.env.ERP_KEEPALIVE_STARTUP_DELAY_MS, 10) || 2000);

  console.log(`[ERP KEEPALIVE] Scheduler initialized. First run in ${startupDelayMs / 1000}s, interval ${intervalSeconds}s.`);

  keepAliveTimer = setTimeout(async () => {
    await keepErpSessionAlive();
    keepAliveInterval = setInterval(keepErpSessionAlive, intervalSeconds * 1000);
    if (process.env.NODE_ENV === 'test' && keepAliveInterval.unref) {
      keepAliveInterval.unref();
    }
  }, startupDelayMs);

  if (process.env.NODE_ENV === 'test' && keepAliveTimer.unref) {
    keepAliveTimer.unref();
  }
}

function stopKeepAliveScheduler() {
  if (keepAliveTimer) clearTimeout(keepAliveTimer);
  if (keepAliveInterval) clearInterval(keepAliveInterval);
}

let selfPingInterval = null;

function startSelfPingScheduler() {
  if (process.env.NODE_ENV === 'test' || process.env.SELF_PING_ENABLED === 'false') {
    return;
  }

  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || 
                 process.env.RAILWAY_STATIC_URL || 
                 process.env.APP_URL || 
                 process.env.SELF_PING_URL;

  if (!domain) {
    return;
  }

  const cleanDomain = domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`;
  const pingUrl = `${cleanDomain.replace(/\/$/, '')}/api/health`;
  const pingIntervalMs = (parseInt(process.env.SELF_PING_INTERVAL_MINUTES, 10) || 5) * 60 * 1000;

  console.log(`[SELF PING] Railway anti-sleep heartbeat enabled. Pinging ${pingUrl} every ${pingIntervalMs / 60000}m.`);

  selfPingInterval = setInterval(async () => {
    try {
      const res = await fetch(pingUrl, {
        headers: { 'User-Agent': 'Railway-AntiSleep-KeepAlive/1.0' }
      });
      console.log(`[SELF PING] Container heartbeat dispatched. Status: ${res.status}`);
    } catch (err) {
      console.warn(`[SELF PING] Container heartbeat ping error: ${err.message}`);
    }
  }, pingIntervalMs);
}

function stopSelfPingScheduler() {
  if (selfPingInterval) clearInterval(selfPingInterval);
}

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
    keepAliveIntervalMinutes: parseInt(process.env.ERP_KEEPALIVE_INTERVAL_MINUTES, 10) || ERP_KEEPALIVE_INTERVAL_MINUTES,
    keepAliveIntervalSeconds: parseInt(process.env.ERP_KEEPALIVE_INTERVAL_SECONDS, 10) || ERP_KEEPALIVE_INTERVAL_SECONDS,
    lastKeepAlive: lastKeepAliveTime ? new Date(lastKeepAliveTime).toISOString() : null
  });
});

app.get(['/api/profile/:rollNumber', '/api/profile/:rollNumber/json'], rateLimiter.middleware(), apiKeyAuth, async (req, res) => {
  const { rollNumber } = req.params;

  const validation = validateRollNumber(rollNumber);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const sanitizedRoll = validation.value;
  const isJsonRequested = req.path.endsWith('/json') || 
                          (req.query.format && req.query.format.toLowerCase() === 'json');

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
      const errorMsg = (loginResult.message && loginResult.message.toLowerCase().includes('expired'))
        ? loginResult.message
        : (httpStatus === 401
            ? `ERP session has expired or is invalid. ${loginResult.message || 'Wait For Admin to fix the issue.'}`
            : (loginResult.message || 'ABES ERP service temporarily unavailable.'));
      return res.status(httpStatus).json({
        error: errorMsg,
        code: loginResult.code
      });
    }

    const postLoginCheck = await checkErpSession();
    if (!postLoginCheck.authenticated) {
      return res.status(401).json({
        error: 'ERP session establishment failed after login. Session expired or invalid.',
        code: 'ERP_SESSION_ESTABLISHMENT_FAILED'
      });
    }
  }

  const profileBaseUrl = process.env.ERP_BASE_URL || ERP_BASE_URL;
  const cacheKey = `${profileBaseUrl}::${sanitizedRoll}`;
  const cached = profileCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    if (isJsonRequested) {
      return res.status(200).json(cached.jsonData);
    }
    const etag = `"${crypto.createHash('md5').update(cached.buffer).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Content-Length', cached.buffer.length);
    res.setHeader('Content-Disposition', `inline; filename="GHOST-FLEET-${sanitizedRoll}.jpg"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', etag);
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).send(cached.buffer);
  }

  const upstreamUrl = `${profileBaseUrl}?ID=${encodeURIComponent(sanitizedRoll)}`;
  if (!isSafeUpstreamUrl(upstreamUrl)) {
    console.error(`[Security Alert] Blocked prohibited upstream destination: ${upstreamUrl}`);
    return res.status(403).json({ error: 'Access to prohibited upstream destination.' });
  }
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

    const setCookies = upstreamRes.headers.getSetCookie ? upstreamRes.headers.getSetCookie() : [upstreamRes.headers.get('set-cookie')];
    erpCookieJar.storeCookies(setCookies, upstreamUrl);

    const status = upstreamRes.status;
    const location = upstreamRes.headers.get('location') || '';
    const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

    console.log(`[ERP Response] Status: ${status}, Content-Type: ${contentType || 'none'}`);

    if (status === 301 || status === 302) {
      if (location.toLowerCase().includes('login')) {
        erpSessionStatus = 'expired';
        console.warn(`[Auth Warning] ERP redirected to login page (${location}). Session has expired.`);
        return res.status(401).json({
          error: 'ERP session has expired or is invalid. Wait For Admin to fix the issue.',
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
    erpCookieJar.touchSessionCookies();

    const cleanContentType = contentType.split(';')[0].trim();
    const base64Data = buffer.toString('base64');
    const jsonData = {
      success: true,
      rollNumber: sanitizedRoll,
      contentType: cleanContentType,
      sizeBytes: buffer.length,
      base64: base64Data,
      dataUrl: `data:${cleanContentType};base64,${base64Data}`
    };

    if (profileCache.size >= MAX_CACHE_SIZE) {
      const oldestKey = profileCache.keys().next().value;
      profileCache.delete(oldestKey);
    }
    profileCache.set(cacheKey, {
      buffer,
      contentType: cleanContentType,
      timestamp: Date.now(),
      jsonData
    });

    if (isJsonRequested) {
      return res.status(200).json(jsonData);
    }

    const etag = `"${crypto.createHash('md5').update(buffer).digest('hex')}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', cleanContentType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `inline; filename="GHOST-FLEET-${sanitizedRoll}.jpg"`);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', etag);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Cache', 'MISS');

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

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=60');
    }
  }
}));

app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

app.get(['/insta', '/instagram'], (req, res) => {
  const target = process.env.INSTAGRAM_URL || 'https://www.instagram.com/ghost_fleet_?dmpr=dW96Mmc5ZXViZm44';
  res.redirect(target);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = err.status || err.statusCode || 500;
  if (statusCode === 413) {
    return res.status(413).json({ error: 'Request payload exceeds 10kb maximum limit.' });
  }
  console.error('[Internal Server Error]', err && err.message ? err.message : 'Unknown error');
  const safeMessage = (statusCode >= 400 && statusCode < 500) 
    ? (err.message || 'Client request error.') 
    : 'An unexpected internal server error occurred.';
  res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({ error: safeMessage });
});

let server = null;
if (require.main === module) {
  server = app.listen(PORT, HOST, () => {
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
    server.requestTimeout = 30000;
    console.log(`====================================================`);
    console.log(` ABES Student Profile Viewer running on http://${HOST}:${PORT}`);
    const hasUserPass = Boolean(process.env.ERP_USERNAME && process.env.ERP_PASSWORD);
    const hasCookies = Boolean(process.env.ERP_MYAUTH && process.env.ERP_ASP_NET_SESSION_ID);
    console.log(` Credentials configured: ${hasUserPass ? 'USERNAME/PASSWORD' : hasCookies ? 'SESSION COOKIES' : 'NONE'}`);
    console.log(` Rate Limit: ${RATE_LIMIT_MAX} req / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
    console.log(` Keep-Alive Interval: ${ERP_KEEPALIVE_INTERVAL_SECONDS}s (${ERP_KEEPALIVE_INTERVAL_MINUTES}m)`);
    console.log(`====================================================`);
    startKeepAliveScheduler();
    startSelfPingScheduler();
  });

  const shutdown = (signal) => {
    console.log(`[Server] Received ${signal}. Starting graceful shutdown...`);
    stopKeepAliveScheduler();
    stopSelfPingScheduler();
    if (server) {
      server.close(() => {
        console.log('[Server] HTTP server closed gracefully.');
        process.exit(0);
      });
      setTimeout(() => {
        console.error('[Server] Forced shutdown after timeout.');
        process.exit(1);
      }, 5000).unref();
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    if (err && (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECANCELED')) {
      return;
    }
    console.error('[FATAL UNCAUGHT EXCEPTION]', err && err.stack ? err.stack : err);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason && reason.stack ? reason.stack : reason);
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
  startSelfPingScheduler,
  stopSelfPingScheduler,
  getErpSessionStatus: () => erpSessionStatus,
  setErpSessionStatus: (status) => {
    erpSessionStatus = status;
    if (status === 'expired') profileCache.clear();
  },
  checkCredentialsChanged,
  profileCache
};
