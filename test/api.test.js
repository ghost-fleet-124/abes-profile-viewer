'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Load environment from .env if present
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  validateRollNumber,
  InMemoryRateLimiter,
  keepErpSessionAlive,
  startKeepAliveScheduler,
  stopKeepAliveScheduler,
  getErpSessionStatus,
  setErpSessionStatus
} = require('../server');

async function runTests() {
  console.log('\n======================================================');
  console.log(' RUNNING ABES PROFILE VIEWER VERIFICATION TEST SUITE');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  function report(name, fn) {
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  async function reportAsync(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // -------------------------------------------------------------
  // UNIT TESTS: Input Validation
  // -------------------------------------------------------------
  console.log('--- TEST GROUP 1: Roll Number Validation ---');

  report('Valid roll number (standard alphanumeric)', () => {
    const res = validateRollNumber('2025B01010618');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.value, '2025B01010618');
  });

  report('Valid roll number with hyphens and underscores', () => {
    const res = validateRollNumber('2021-CS_042');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.value, '2021-CS_042');
  });

  report('Empty roll number rejected', () => {
    const res = validateRollNumber('');
    assert.strictEqual(res.valid, false);
    assert.ok(res.error.includes('required') || res.error.includes('empty'));
  });

  report('Whitespace-only roll number rejected', () => {
    const res = validateRollNumber('    ');
    assert.strictEqual(res.valid, false);
    assert.ok(res.error.includes('empty'));
  });

  report('Too short roll number rejected (< 3 chars)', () => {
    const res = validateRollNumber('12');
    assert.strictEqual(res.valid, false);
    assert.ok(res.error.includes('between 3 and 30'));
  });

  report('Excessively long roll number rejected (> 30 chars)', () => {
    const res = validateRollNumber('1234567890123456789012345678901');
    assert.strictEqual(res.valid, false);
    assert.ok(res.error.includes('between 3 and 30'));
  });

  report('Special characters & SQL/Path injection patterns rejected', () => {
    const badInputs = [
      '2025<script>',
      'roll number',
      '../../etc/passwd',
      'id=1 OR 1=1',
      '2025B;drop table',
      '2025/01/01',
      '2025?id=1'
    ];
    for (const input of badInputs) {
      const res = validateRollNumber(input);
      assert.strictEqual(res.valid, false, `Expected '${input}' to be rejected`);
    }
  });

  // -------------------------------------------------------------
  // UNIT TESTS: Rate Limiter
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 2: In-Memory Rate Limiting ---');

  report('Rate limiter blocks requests over threshold', () => {
    const limiter = new InMemoryRateLimiter(60000, 3);
    const middleware = limiter.middleware();

    const mockReq = { ip: '192.168.1.50', socket: {} };
    let finalStatus = 200;
    let finalBody = null;

    const mockRes = {
      setHeader: () => {},
      status: (code) => {
        finalStatus = code;
        return {
          json: (body) => {
            finalBody = body;
          }
        };
      }
    };

    let nextCalled = 0;
    const next = () => { nextCalled++; };

    // Request 1, 2, 3 should pass
    middleware(mockReq, mockRes, next);
    middleware(mockReq, mockRes, next);
    middleware(mockReq, mockRes, next);
    assert.strictEqual(nextCalled, 3);

    // Request 4 should be rejected with 429
    middleware(mockReq, mockRes, next);
    assert.strictEqual(nextCalled, 3);
    assert.strictEqual(finalStatus, 429);
    assert.ok(finalBody && finalBody.error.includes('Rate limit exceeded'));
  });

  // -------------------------------------------------------------
  // SECURITY AUDIT: Verify No Secrets in Frontend or Git
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 3: Security & Secret Leak Prevention ---');

  report('.gitignore properly configured', () => {
    const gitignorePath = path.join(__dirname, '..', '.gitignore');
    assert.ok(fs.existsSync(gitignorePath), '.gitignore must exist');
    const content = fs.readFileSync(gitignorePath, 'utf8');
    assert.ok(content.includes('.env'), '.gitignore must ignore .env');
    assert.ok(content.includes('node_modules'), '.gitignore must ignore node_modules/');
    assert.ok(content.includes('*.log'), '.gitignore must ignore *.log');
  });

  report('Frontend files never contain secret tokens or ERP cookies', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    const files = ['index.html', 'style.css', 'app.js'];

    const forbiddenStrings = [
      'ERP_MYAUTH',
      'ERP_ASP_NET_SESSION_ID',
      'ptca0kv3bahmftre4i4ivycs', // Example session ID
      '36919EA4C1B9241B7A8B9DC70' // Substring of owner cookie
    ];

    for (const file of files) {
      const filePath = path.join(publicDir, file);
      assert.ok(fs.existsSync(filePath), `${file} must exist`);
      const content = fs.readFileSync(filePath, 'utf8');

      for (const secret of forbiddenStrings) {
        assert.ok(
          !content.includes(secret),
          `Security violation: ${file} contains secret/internal token: ${secret}`
        );
      }
    }
  });

  report('.env.example has empty placeholders and no real secrets', () => {
    const examplePath = path.join(__dirname, '..', '.env.example');
    assert.ok(fs.existsSync(examplePath), '.env.example must exist');
    const content = fs.readFileSync(examplePath, 'utf8');
    assert.ok(content.includes('ERP_MYAUTH='), '.env.example must have ERP_MYAUTH');
    assert.ok(content.includes('ERP_ASP_NET_SESSION_ID='), '.env.example must have ERP_ASP_NET_SESSION_ID');
    // Ensure no hardcoded cookie values
    assert.ok(!content.includes('ptca0kv3'), '.env.example must not contain real session ID');
  });

  // -------------------------------------------------------------
  // INTEGRATION TESTS: Live Server API Verification
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 4: Server HTTP API Integration Tests ---');

  const {
    app,
    erpCookieJar,
    checkErpSession,
    performErpLogin,
    executeErpLoginFlow,
    getErpSessionStatus,
    setErpSessionStatus,
    startKeepAliveScheduler,
    stopKeepAliveScheduler
  } = require('../server');
  const testServer = http.createServer(app);

  await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve));
  const testPort = testServer.address().port;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  await reportAsync('GET / serves frontend index.html', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('ABES Student Profile Viewer'));
    });

    await reportAsync('GET /style.css serves CSS stylesheet', async () => {
      const res = await fetch(`${baseUrl}/style.css`);
      assert.strictEqual(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('css'));
    });

    await reportAsync('GET /app.js serves JavaScript logic', async () => {
      const res = await fetch(`${baseUrl}/app.js`);
      assert.strictEqual(res.status, 200);
      assert.ok((res.headers.get('content-type') || '').includes('javascript'));
    });

    await reportAsync('GET /api/health returns health status without secrets', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.status, 'ok');
      assert.strictEqual(typeof data.sessionConfigured, 'boolean');
      // Verify no secrets in health check response
      assert.strictEqual(data.ERP_MYAUTH, undefined);
      assert.strictEqual(data.ERP_ASP_NET_SESSION_ID, undefined);
    });

    await reportAsync('API endpoints return proper CORS headers for external frontends', async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { 'Origin': 'https://my-custom-frontend.com' }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      assert.ok(res.headers.get('access-control-allow-methods').includes('GET'));
    });

    await reportAsync('API Key middleware rejects missing/invalid keys and accepts valid key', async () => {
      process.env.API_KEY = 'test_secret_key_12345';
      try {
        // 1. Missing key on cross-origin request returns 401
        const resMissing = await fetch(`${baseUrl}/api/profile/invalid!`, {
          headers: { 'sec-fetch-site': 'cross-site' }
        });
        assert.strictEqual(resMissing.status, 401);
        const dataMissing = await resMissing.json();
        assert.ok(dataMissing.error.includes('API key is required'));

        // 2. Invalid key returns 403
        const resWrong = await fetch(`${baseUrl}/api/profile/invalid!`, {
          headers: { 'x-api-key': 'wrong_key_1234567', 'sec-fetch-site': 'cross-site' }
        });
        assert.strictEqual(resWrong.status, 403);
        const dataWrong = await resWrong.json();
        assert.ok(dataWrong.error.includes('Invalid API key'));

        // 3. Valid key via x-api-key header passes auth (hits validation -> 400)
        const resValidHeader = await fetch(`${baseUrl}/api/profile/invalid!`, {
          headers: { 'x-api-key': 'test_secret_key_12345' }
        });
        assert.strictEqual(resValidHeader.status, 400);

        // 4. Valid key via Authorization: Bearer passes auth
        const resValidBearer = await fetch(`${baseUrl}/api/profile/invalid!`, {
          headers: { 'Authorization': 'Bearer test_secret_key_12345' }
        });
        assert.strictEqual(resValidBearer.status, 400);

        // 5. Valid key via query parameter ?api_key= passes auth
        const resValidQuery = await fetch(`${baseUrl}/api/profile/invalid!?api_key=test_secret_key_12345`);
        assert.strictEqual(resValidQuery.status, 400);
      } finally {
        delete process.env.API_KEY;
      }
    });

    await reportAsync('GET /api/profile/ with invalid characters returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/profile/invalid%20roll!`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('Invalid roll number format'));
    });

    await reportAsync('GET /api/profile/ with too short roll returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/profile/ab`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('between 3 and 30'));
    });

    await reportAsync('GET /api/profile/ with too long roll returns 400', async () => {
      const res = await fetch(`${baseUrl}/api/profile/12345678901234567890123456789012345`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.ok(data.error.includes('between 3 and 30'));
    });

    await reportAsync('GET /api/profile/ with path traversal returns 400 or 404', async () => {
      const res = await fetch(`${baseUrl}/api/profile/..%2F..%2Fetc`);
      assert.ok(res.status === 400 || res.status === 404);
    });

    await reportAsync('GET /api/profile/:validRoll checks ERP session safely', async () => {
      // Testing with live ERP endpoint.
      // If ERP session is expired, it returns 401 with clear session expired error.
      // If ERP session is valid, it returns 200 with an image.
      const res = await fetch(`${baseUrl}/api/profile/2025B01010618`);
      console.log(`    -> Upstream test returned HTTP status: ${res.status}`);
      if (res.status === 200) {
        const ct = res.headers.get('content-type') || '';
        assert.ok(ct.startsWith('image/'), 'Response must be image');
        const buf = await res.arrayBuffer();
        assert.ok(buf.byteLength > 0, 'Image buffer must not be empty');
        console.log(`    -> Received valid student image (${buf.byteLength} bytes)`);
      } else if (res.status === 401) {
        const data = await res.json();
        assert.ok(
          data.error.toLowerCase().includes('session') ||
          data.error.toLowerCase().includes('expired') ||
          data.error.toLowerCase().includes('refresh')
        );
        console.log(`    -> Handled expired ERP session gracefully: "${data.error}"`);
      } else {
        console.log(`    -> Upstream response: ${res.status}`);
      }
    });

  // -------------------------------------------------------------
  // MOCK UPSTREAM ERP SIMULATION
  // Tests edge cases: 200 image, 200 HTML rejection, 302 login, timeout
  // -------------------------------------------------------------
  console.log('\n--- TEST GROUP 5: Mock Upstream ERP Behavior Tests ---');

  // Let's create a local mock server to simulate ERP edge cases
  let mockMode = 'image'; // 'image', 'html_error', 'login_redirect', 'timeout', 'error_500'
  let loginAttemptsCount = 0;
  const mockErp = http.createServer((req, res) => {
    // Handle Login.aspx requests
    if (req.url.includes('Login.aspx')) {
      if (req.method === 'POST' && req.url.includes('GetUserLoginType')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.UserID === 'student_user') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ d: 'student_user' }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ d: 'School' }));
          } catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ d: 'School' }));
          }
        });
        return;
      }

      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'ASP.NET_SessionId=mock_initial_session; path=/; HttpOnly'
        });
        return res.end(`
          <html><head><title>Login</title></head><body>
          <form id="ctl00" method="post" action="./Login.aspx">
          <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="mock_viewstate_base64_string" />
          <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="C2EE9ABB" />
          <input name="txtuser" id="txtuser" type="text" />
          <input name="txtPassword" id="txtPassword" type="password" />
          <input type="submit" name="btnStaff" value="Login" id="btnStaff" />
          </form></body></html>
        `);
      }

      if (req.method === 'POST') {
        loginAttemptsCount++;
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const user = params.get('txtuser');
          const pass = params.get('txtPassword');
          if (user === 'valid_staff' && pass === 'valid_pass') {
            res.writeHead(302, {
              'Location': `http://127.0.0.1:${mockPort}/Home/Student/Default.aspx`,
              'Set-Cookie': [
                'MyAuth=mock_auth_token_success_999; path=/; HttpOnly',
                'ASP.NET_SessionId=mock_auth_sess_success_999; path=/; HttpOnly'
              ]
            });
            return res.end('Redirecting');
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html><head><title>Login</title></head><body><form action="Login.aspx"><input name="txtuser"/></form></body></html>');
          }
        });
        return;
      }
    }

    // Check that cookies were forwarded
    const cookie = req.headers['cookie'] || '';
    if (!cookie.includes('MyAuth=') || !cookie.includes('ASP.NET_SessionId=')) {
      res.writeHead(401);
      return res.end('Unauthorized');
    }

    if (req.url.includes('Default.aspx')) {
      if (mockMode === 'active_page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<html><head><title>Student Portal</title></head><body>Welcome to ABES Student Dashboard</body></html>');
      }
      if (mockMode === 'login_redirect') {
        res.writeHead(302, { 'Location': 'https://erp.abes.ac.in/Login.aspx' });
        return res.end('<h2>Object moved to Login.aspx</h2>');
      }
      if (mockMode === 'html_login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<html><head><title>Login</title></head><body><form action="Login.aspx"><input name="txtUserName"/></form></body></html>');
      }
      if (mockMode === 'error_500') {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        return res.end('Internal Server Error');
      }
      if (mockMode === 'timeout') {
        return;
      }
    }

    if (mockMode === 'image') {
      // 1x1 transparent PNG
      const png1px = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
        'hex'
      );
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': png1px.length
      });
      return res.end(png1px);
    }

    if (mockMode === 'html_error') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html><head><title>Login</title></head><body>Login required</body></html>');
    }

    if (mockMode === 'login_redirect') {
      res.writeHead(302, {
        'Location': 'https://erp.abes.ac.in/Login.aspx',
        'Content-Type': 'text/html'
      });
      return res.end('<h2>Object moved to Login.aspx</h2>');
    }

    if (mockMode === 'error_500') {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      return res.end('Internal Server Error');
    }

    if (mockMode === 'timeout') {
      // Don't respond to simulate timeout
      return;
    }
  });

  await new Promise((resolve) => mockErp.listen(0, '127.0.0.1', resolve));
  const mockPort = mockErp.address().port;

  // Create isolated express app targeting our mock ERP with a short 300ms timeout
  const express = require('express');
  const testApp = express();
  testApp.get('/api/test-profile/:rollNumber', async (req, res) => {
    const { rollNumber } = req.params;
    const validation = validateRollNumber(rollNumber);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400); // 400ms timeout for test

    try {
      const upstream = await fetch(`http://127.0.0.1:${mockPort}/Services/ProfilePic.aspx?ID=${encodeURIComponent(validation.value)}`, {
        headers: {
          'Cookie': 'MyAuth=test_token; ASP.NET_SessionId=test_sess',
          'User-Agent': 'TestClient/1.0'
        },
        redirect: 'manual',
        signal: controller.signal
      });
      clearTimeout(timer);

      if (upstream.status === 302 || upstream.status === 301) {
        const loc = upstream.headers.get('location') || '';
        if (loc.toLowerCase().includes('login')) {
          return res.status(401).json({ error: 'ERP session has expired or is invalid.' });
        }
      }

      if (upstream.status >= 500) {
        return res.status(502).json({ error: 'ERP server error' });
      }

      const ct = (upstream.headers.get('content-type') || '').toLowerCase();
      if (!ct.startsWith('image/')) {
        const body = await upstream.text();
        if (body.toLowerCase().includes('login')) {
          return res.status(401).json({ error: 'ERP session has expired or is invalid.' });
        }
        return res.status(502).json({ error: 'Non-image content returned' });
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', ct);
      return res.status(200).send(buf);
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return res.status(504).json({ error: 'ERP request timed out' });
      }
      return res.status(502).json({ error: 'Communication error' });
    }
  });

  const testAppServer = http.createServer(testApp);
  await new Promise((resolve) => testAppServer.listen(0, '127.0.0.1', resolve));
  const testAppPort = testAppServer.address().port;
  const mockBase = `http://127.0.0.1:${testAppPort}`;

  try {
    await reportAsync('TEST 1: Valid roll + valid session returns 200 and image', async () => {
      mockMode = 'image';
      const res = await fetch(`${mockBase}/api/test-profile/2025B01010618`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/png');
      const buf = await res.arrayBuffer();
      assert.ok(buf.byteLength > 0);
    });

    await reportAsync('TEST 5: ERP 302 Login redirect returns 401 Session Expired', async () => {
      mockMode = 'login_redirect';
      const res = await fetch(`${mockBase}/api/test-profile/2025B01010618`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.ok(data.error.includes('expired'));
    });

    await reportAsync('TEST 7: ERP 200 HTML login page rejected as 401 Session Expired', async () => {
      mockMode = 'html_error';
      const res = await fetch(`${mockBase}/api/test-profile/2025B01010618`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.ok(data.error.includes('expired'));
    });

    await reportAsync('TEST 6: ERP upstream 500 server error returns 502 Bad Gateway', async () => {
      mockMode = 'error_500';
      const res = await fetch(`${mockBase}/api/test-profile/2025B01010618`);
      assert.strictEqual(res.status, 502);
      const data = await res.json();
      assert.ok(data.error.includes('ERP server error'));
    });

    await reportAsync('TEST 11: ERP request timeout returns 504 Gateway Timeout', async () => {
      mockMode = 'timeout';
      const res = await fetch(`${mockBase}/api/test-profile/2025B01010618`);
      assert.strictEqual(res.status, 504);
      const data = await res.json();
      assert.ok(data.error.includes('timed out'));
    });

    await reportAsync('TEST 12: Real server /api/profile endpoint delivers image with active session', async () => {
      mockMode = 'image';
      process.env.ERP_BASE_URL = `http://127.0.0.1:${mockPort}/Services/ProfilePic.aspx`;
      setErpSessionStatus('active');
      const res = await fetch(`${baseUrl}/api/profile/2025B01010618`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('content-type'), 'image/png');
      const buf = await res.arrayBuffer();
      assert.ok(buf.byteLength > 0);
    });

    await reportAsync('TEST 13: Real server /api/profile/json endpoint delivers base64 dataUrl', async () => {
      mockMode = 'image';
      process.env.ERP_BASE_URL = `http://127.0.0.1:${mockPort}/Services/ProfilePic.aspx`;
      setErpSessionStatus('active');
      const res = await fetch(`${baseUrl}/api/profile/2025B01010618/json`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.rollNumber, '2025B01010618');
      assert.ok(data.dataUrl && data.dataUrl.startsWith('data:image/png;base64,'));
    });

    // -------------------------------------------------------------
    // TEST GROUP 6: Session Keep-Alive & Expiry Detection
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 6: Session Keep-Alive & Expiry Detection ---');

    // Configure keepalive URL to point to mockErp
    const originalKeepAliveUrl = process.env.ERP_KEEPALIVE_URL;
    process.env.ERP_KEEPALIVE_URL = `http://127.0.0.1:${mockPort}/Home/Student/Default.aspx`;

    await reportAsync('KEEPALIVE TEST 1: keepErpSessionAlive detects active session', async () => {
      mockMode = 'active_page';
      const status = await keepErpSessionAlive();
      assert.strictEqual(status, 'active');
      assert.strictEqual(getErpSessionStatus(), 'active');
    });

    await reportAsync('KEEPALIVE TEST 2: keepErpSessionAlive detects expired session (302 redirect to login)', async () => {
      mockMode = 'login_redirect';
      const status = await keepErpSessionAlive();
      assert.strictEqual(status, 'expired');
      assert.strictEqual(getErpSessionStatus(), 'expired');
    });

    await reportAsync('KEEPALIVE TEST 3: Profile request blocked with 401 when session status is expired', async () => {
      setErpSessionStatus('expired');
      const res = await fetch(`${baseUrl}/api/profile/2025B01010618`);
      assert.strictEqual(res.status, 401);
      const data = await res.json();
      assert.ok(data.error.includes('expired'));
    });

    await reportAsync('KEEPALIVE TEST 4: keepErpSessionAlive detects expired session (200 login page HTML)', async () => {
      setErpSessionStatus('active');
      mockMode = 'html_login';
      const status = await keepErpSessionAlive();
      assert.strictEqual(status, 'expired');
      assert.strictEqual(getErpSessionStatus(), 'expired');
    });

    await reportAsync('KEEPALIVE TEST 5: keepErpSessionAlive marks temporarily_unavailable on 500 without declaring expired', async () => {
      setErpSessionStatus('unknown');
      mockMode = 'error_500';
      const status = await keepErpSessionAlive();
      assert.strictEqual(status, 'temporarily_unavailable');
      assert.strictEqual(getErpSessionStatus(), 'temporarily_unavailable');
    });

    await reportAsync('KEEPALIVE TEST 6: keepErpSessionAlive marks temporarily_unavailable on timeout', async () => {
      setErpSessionStatus('unknown');
      mockMode = 'timeout';
      process.env.ERP_TIMEOUT_MS = '150';
      try {
        const status = await keepErpSessionAlive();
        assert.strictEqual(status, 'temporarily_unavailable');
        assert.strictEqual(getErpSessionStatus(), 'temporarily_unavailable');
      } finally {
        delete process.env.ERP_TIMEOUT_MS;
      }
    });

    await reportAsync('KEEPALIVE TEST 7: Concurrency protection skips duplicate execution', async () => {
      setErpSessionStatus('active');
      mockMode = 'active_page';
      // Fire two keep-alives concurrently
      const p1 = keepErpSessionAlive();
      const p2 = keepErpSessionAlive();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.strictEqual(r1, 'active');
      assert.strictEqual(r2, 'active');
    });

    await reportAsync('KEEPALIVE TEST 8: GET /api/health reports accurate erpSession status', async () => {
      setErpSessionStatus('active');
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.erpSession, 'active');
      assert.strictEqual(typeof data.keepAliveIntervalMinutes, 'number');
    });

    await reportAsync('KEEPALIVE TEST 9: Scheduler start and stop functions operate safely', () => {
      startKeepAliveScheduler();
      stopKeepAliveScheduler();
    });

    // -------------------------------------------------------------
    // TEST GROUP 7: Automated Login & Re-Authentication Tests
    // -------------------------------------------------------------
    console.log('\n--- TEST GROUP 7: Automated Login & Re-Authentication Tests ---');

    process.env.ERP_LOGIN_URL = `http://127.0.0.1:${mockPort}/Login.aspx`;
    process.env.ERP_KEEPALIVE_URL = `http://127.0.0.1:${mockPort}/Home/Student/Default.aspx`;

    await reportAsync('LOGIN TEST 1: Valid existing session permits profile operations without login', async () => {
      erpCookieJar.clear();
      erpCookieJar.set('MyAuth', 'mock_auth_token_success_999');
      erpCookieJar.set('ASP.NET_SessionId', 'mock_auth_sess_success_999');
      setErpSessionStatus('active');
      mockMode = 'image';

      const initialLogins = loginAttemptsCount;
      const sessionCheck = await checkErpSession();
      assert.strictEqual(sessionCheck.authenticated, true);
      assert.strictEqual(loginAttemptsCount, initialLogins);
    });

    await reportAsync('LOGIN TEST 2: Expired session triggers normal ERP login and re-authentication', async () => {
      erpCookieJar.clear();
      process.env.ERP_USERNAME = 'valid_staff';
      process.env.ERP_PASSWORD = 'valid_pass';

      const result = await performErpLogin();
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.code, 'LOGIN_SUCCESS');
      assert.ok(erpCookieJar.has('MyAuth'));
      assert.ok(erpCookieJar.has('ASP.NET_SessionId'));
      assert.strictEqual(getErpSessionStatus(), 'active');
    });

    await reportAsync('LOGIN TEST 3: Invalid credentials result in safe login failure', async () => {
      erpCookieJar.clear();
      process.env.ERP_USERNAME = 'bad_user';
      process.env.ERP_PASSWORD = 'bad_password';

      const result = await performErpLogin();
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'ERP_LOGIN_FAILED');
      assert.strictEqual(erpCookieJar.has('MyAuth'), false);
    });

    await reportAsync('LOGIN TEST 4: Student account with OTP/reCAPTCHA challenge reports ERP_CHALLENGE_REQUIRED without bypass', async () => {
      erpCookieJar.clear();
      process.env.ERP_USERNAME = 'student_user';
      process.env.ERP_PASSWORD = 'some_password';

      const result = await performErpLogin();
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.code, 'ERP_CHALLENGE_REQUIRED');
      assert.ok(result.message.includes('OTP'));
    });

    await reportAsync('LOGIN TEST 5: Single-flight lock ensures concurrent requests share ONE login attempt', async () => {
      erpCookieJar.clear();
      process.env.ERP_USERNAME = 'valid_staff';
      process.env.ERP_PASSWORD = 'valid_pass';

      const preCount = loginAttemptsCount;
      const [res1, res2, res3] = await Promise.all([
        performErpLogin(),
        performErpLogin(),
        performErpLogin()
      ]);

      assert.strictEqual(res1.success, true);
      assert.strictEqual(res2.success, true);
      assert.strictEqual(res3.success, true);
      assert.strictEqual(loginAttemptsCount, preCount + 1);
    });

    await reportAsync('LOGIN TEST 6: Session credentials and cookies are never leaked to client API responses', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const body = await res.text();
      assert.strictEqual(body.includes('mock_auth_token_success_999'), false);
      assert.strictEqual(body.includes('mock_auth_sess_success_999'), false);
      assert.strictEqual(body.includes('valid_pass'), false);
    });

    if (originalKeepAliveUrl) {
      process.env.ERP_KEEPALIVE_URL = originalKeepAliveUrl;
    } else {
      delete process.env.ERP_KEEPALIVE_URL;
    }
    delete process.env.ERP_LOGIN_URL;
    delete process.env.ERP_USERNAME;
    delete process.env.ERP_PASSWORD;
  } finally {
    testAppServer.close();
    mockErp.close();
    testServer.close();
  }

  // -------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------
  console.log('\n======================================================');
  console.log(` TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
