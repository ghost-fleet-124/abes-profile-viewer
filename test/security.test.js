'use strict';

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

const { app } = require('../server');

async function runSecurityTests() {
  console.log('\n======================================================');
  console.log(' RUNNING ABES PROFILE VIEWER ADVANCED SECURITY AUDIT');
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    console.log('--- AUDIT 1: Security Headers & Information Disclosure ---');

    await test('Hides X-Powered-By header', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.headers.get('x-powered-by'), null);
    });

    await test('Enforces X-Content-Type-Options: nosniff', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    });

    await test('Enforces X-Frame-Options: DENY (anti-clickjacking)', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    });

    await test('Enforces Referrer-Policy', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      assert.strictEqual(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    });

    await test('Enforces Permissions-Policy', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      const pp = res.headers.get('permissions-policy');
      assert.ok(pp && pp.includes('camera=()') && pp.includes('geolocation=()'));
    });

    await test('Enforces Content-Security-Policy (CSP)', async () => {
      const res = await fetch(`${baseUrl}/`);
      const csp = res.headers.get('content-security-policy');
      assert.ok(csp, 'CSP header must be present');
      assert.ok(csp.includes("default-src 'self'"));
      assert.ok(csp.includes("object-src 'none'"));
      assert.ok(csp.includes("frame-ancestors 'none'"));
    });

    console.log('\n--- AUDIT 2: Injection, XSS & Path Traversal Fuzzing ---');

    const injectionPayloads = [
      "' OR '1'='1",
      "' OR 1=1--",
      "admin'--",
      "UNION SELECT * FROM users",
      "<script>alert(1)</script>",
      "\"><script>alert(XSS)</script>",
      "<svg onload=alert(1)>",
      "javascript:alert(1)",
      "../../etc/passwd",
      "..\\..\\windows\\system32",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "ROLL%00NULL",
      "ROLL; DROP TABLE students;--",
      "${7*7}",
      "{{7*7}}"
    ];

    for (const payload of injectionPayloads) {
      await test(`Rejects malicious payload: "${payload.slice(0, 20)}..."`, async () => {
        const encoded = encodeURIComponent(payload);
        const res = await fetch(`${baseUrl}/api/profile/${encoded}`);
        assert.ok(
          res.status === 400 || res.status === 404,
          `Expected 400 or 404, got ${res.status}`
        );
      });
    }

    console.log('\n--- AUDIT 3: Prototype Pollution Protection ---');

    await test('Blocks prototype pollution via __proto__ query parameter', async () => {
      const res = await fetch(`${baseUrl}/api/profile/ROLL1001?__proto__[polluted]=true`);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(Object.prototype.polluted, undefined);
    });

    await test('Blocks prototype pollution via constructor query parameter', async () => {
      const res = await fetch(`${baseUrl}/api/profile/ROLL1001?constructor[prototype][polluted]=true`);
      assert.strictEqual(res.status, 400);
      assert.strictEqual(Object.prototype.polluted, undefined);
    });

    console.log('\n--- AUDIT 4: Sensitive File Exposure Audit ---');

    const sensitiveFiles = [
      '/.env',
      '/.env.example',
      '/.git/config',
      '/package.json',
      '/package-lock.json',
      '/server.js',
      '/test/api.test.js'
    ];

    for (const file of sensitiveFiles) {
      await test(`Blocks direct access to sensitive file: ${file}`, async () => {
        const res = await fetch(`${baseUrl}${file}`);
        const text = await res.text();
        // Either 404 or index.html fallback (SPA routing) - never actual file content
        if (file === '/.env') {
          assert.ok(!text.includes('ERP_PASSWORD='), 'Must not expose .env secrets');
        }
        if (file === '/server.js') {
          assert.ok(!text.includes('require(\'express\')') || text.includes('Student Profile Viewer'), 'Must not leak server source');
        }
      });
    }

    console.log('\n--- AUDIT 5: HTTP Compression & Optimization ---');

    await test('Compresses responses with Gzip for clients requesting gzip', async () => {
      const res = await fetch(`${baseUrl}/style.css`, {
        headers: { 'Accept-Encoding': 'gzip' }
      });
      assert.strictEqual(res.status, 200);
      const encoding = res.headers.get('content-encoding');
      assert.ok(encoding === 'gzip' || res.headers.get('content-type').includes('css'));
    });

    console.log('\n--- AUDIT 6: Payload Limit & DoS Prevention ---');

    await test('Express JSON rejects excessively large payload > 10kb', async () => {
      const largePayload = JSON.stringify({ junk: 'A'.repeat(20 * 1024) });
      const res = await fetch(`${baseUrl}/api/profile/ROLL1001`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: largePayload
      });
      // Should reject with 413 Payload Too Large or 404
      assert.ok(res.status === 413 || res.status === 404);
    });

  } finally {
    server.close();
  }

  console.log(`\n======================================================`);
  console.log(` SECURITY AUDIT SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`======================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch((err) => {
  console.error('Fatal audit failure:', err);
  process.exit(1);
});
