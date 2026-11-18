# ABES Student Profile Viewer

A secure, production-grade Node.js / Express web portal that retrieves verified student profile photos from the authorized ABES ERP endpoint (`https://erp.abes.ac.in/Services/ProfilePic.aspx?ID=<ROLL_NUMBER>`).

---

## 1. Overview & Architecture

The application acts as a secure, authenticated proxy between the client browser and the ABES ERP system:

1. **Client Interface**: A clean, responsive single-page web interface where the user submits an ABES student roll number.
2. **Backend Proxy (`server.js`)**: Validates the roll number format, verifies rate limits, and attaches pre-authorized ERP authentication cookies server-side.
3. **Upstream ERP**: Receives the authenticated request and delivers the student photo.
4. **Validation Layer**: The server inspects the upstream response status, content type, and binary header. If ERP redirects to login (session expired) or returns HTML, it gracefully informs the client without rendering broken images or leaking upstream details.
5. **Zero Client-Side Secrets**: Browser clients never have access to or awareness of ERP authentication cookies (`MyAuth`, `ASP.NET_SessionId`).

```
[ Browser Client ]
       │
       ▼ (Roll Number: "ROLL_NUMBER")
[ Express Backend Proxy ] ─── Attaches Server-Side Secrets (ERP_MYAUTH, ERP_ASP_NET_SESSION_ID)
       │
       ▼ (HTTPS with authorized Cookies)
[ ABES ERP Server (erp.abes.ac.in) ]
       │
       ▼ (Image Stream: image/jpeg)
[ Express Backend Proxy ] ─── Validates MIME type, content size, rejects HTML/login redirects
       │
       ▼ (Sanitized Image Buffer)
[ Browser Client Display ]
```

---

## 2. Security Design Principles

- **No Credential Exposure**: ERP authentication cookies (`MyAuth`, `ASP.NET_SessionId`) are strictly stored in environment variables, never logged to stdout/stderr, never included in API responses, and never accessible in client-side code.
- **Strict Input Whitelisting**: Roll numbers are validated using a strict regex whitelist (`/^[A-Za-z0-9_-]{3,30}$/`). Spaces, directory traversal sequences (`..`), SQL injection characters, and special characters are rejected before any request is made.
- **Fixed Upstream Target**: Upstream requests are strictly constrained to `https://erp.abes.ac.in/Services/ProfilePic.aspx?ID=...`. No arbitrary URL fetching or open proxy endpoints are permitted.
- **Rate Limiting**: Includes a built-in per-IP rate limiter (default: 30 requests per minute per IP) to prevent automated scraping and abuse.
- **Timeout Protection**: All upstream ERP requests use an `AbortController` timeout (default: 10 seconds) to avoid thread starvation or hanging connections.
- **Response Validation**: Prevents MIME-confusion attacks and handles session expiration by inspecting `Content-Type` headers and redirect targets before returning any data.
- **Git Security**: `.gitignore` is pre-configured to ensure `.env`, `node_modules/`, and `*.log` are never committed to version control.

---

## 3. Project Structure

```
abes-profile-viewer/
├── server.js            # Express server, rate limiter, security headers & ERP proxy logic
├── package.json         # Node.js project manifest & scripts
├── .env                 # Server-side environment secrets (ignored by Git)
├── .env.example         # Environment template with dummy placeholders
├── .gitignore           # Ignores .env, node_modules/, *.log
├── public/              # Static frontend assets
│   ├── index.html       # Clean, accessible UI with institutional branding
│   ├── style.css        # Responsive modern CSS
│   └── app.js           # Client-side validation, error handling, photo display
├── test/
│   └── api.test.js      # Automated test suite (unit, integration & mock tests)
└── README.md            # Comprehensive documentation
```

---

## 4. Requirements

- **Node.js**: v18.0.0 or later (Node.js v20+ or v24+ recommended; includes native global `fetch`)
- **npm**: v8.0.0 or later
- **Authorized ABES ERP Session**: An active account session provided by the authorized account holder.

---

## 5. Installation & Setup

1. **Navigate to the project folder:**
   ```bash
   cd abes-profile-viewer
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Copy `.env.example` to create your local `.env`:
   ```bash
   cp .env.example .env
   ```

   ```ini
   PORT=3000

   # Server-side ERP Login Credentials (for automated authentication):
   ERP_USERNAME=
   ERP_PASSWORD=

   # Or pre-authorized browser session cookies:
   ERP_MYAUTH=
   ERP_ASP_NET_SESSION_ID=

   # Keep-Alive Configuration:
   ERP_KEEPALIVE_ENABLED=true
   ERP_KEEPALIVE_INTERVAL_MINUTES=10

   # Security & Performance:
   ERP_TIMEOUT_MS=10000
   RATE_LIMIT_WINDOW_MS=60000
   RATE_LIMIT_MAX=30
   API_KEY=
   CORS_ORIGIN=*
   ```

> **IMPORTANT**: Never commit your `.env` file to GitHub or any public repository.

---

## 6. How to Obtain Authorized ERP Session Cookies

This application is strictly for authorized use by students and staff accessing their own ERP profiles.

1. In Google Chrome, Microsoft Edge, or Firefox, log in to your official ABES ERP account at `https://erp.abes.ac.in/`.
2. Press `F12` (or right-click and select **Inspect**) to open Developer Tools.
3. Go to the **Application** tab (or **Storage** tab in Firefox).
4. Under **Cookies**, select `https://erp.abes.ac.in`.
5. Locate the two cookies:
   - `MyAuth`
   - `ASP.NET_SessionId`
6. Copy their values and paste them into your server's `.env` file for `ERP_MYAUTH` and `ERP_ASP_NET_SESSION_ID`.

---

## 7. Running the Application

### Start Production Server
```bash
npm start
```

Open your browser and navigate to:
```
http://localhost:3000
```

---

## 8. Running the Test Suite

The project includes a comprehensive automated test suite testing input validation, security rules, live integration, and simulated mock ERP edge cases (such as session expiration, 500 errors, non-image responses, and timeouts):

```bash
npm test
```

---

## 9. API Reference

### Health Check Endpoint
```http
GET /api/health
```
**Response (200 OK):**
```json
{
  "status": "ok",
  "sessionConfigured": true,
  "erpSession": "active",
  "keepAliveIntervalMinutes": 10,
  "lastKeepAlive": "2026-10-06T15:35:00.000Z",
  "rateLimitMax": 30,
  "windowSeconds": 60,
  "apiKeyProtected": false
}
```

### Profile Photo Endpoints

#### Option 1: Direct Binary Image Stream (Ideal for `<img>` tags)
```http
GET /api/profile/:rollNumber
```

**Parameters:**
- `rollNumber` (string, required): Student roll number. Whitelist: letters, digits, hyphens, underscores (3–30 characters).

**Success Response (200 OK):**
- Headers:
  - `Content-Type`: `image/jpeg` (or `image/png`)
  - `Content-Length`: `<byte_count>`
  - `Cache-Control`: `private, no-cache, no-store, must-revalidate`
  - `X-Content-Type-Options`: `nosniff`
  - `Access-Control-Allow-Origin`: `*`
- Body: Binary image stream.

#### Option 2: JSON Response with Base64 Data URL (Ideal for React, Next.js, Flutter)
```http
GET /api/profile/:rollNumber?format=json
# Or alias:
GET /api/profile/:rollNumber/json
```

**Success Response (200 OK):**
```json
{
  "success": true,
  "rollNumber": "ROLL_NUMBER",
  "contentType": "image/jpeg",
  "sizeBytes": 2819,
  "base64": "/9j/4AAQSkZJRg...",
  "dataUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
}
```

---

## 10. API Key Authentication (Optional & Recommended)

You can secure your backend with an API key just like professional web APIs.

### How to Enable:
1. In your Railway dashboard, open the **Variables** tab.
2. Add a new variable:
   * **Key:** `API_KEY`
   * **Value:** Any secure string of your choice (e.g. `abes_live_3a86eb7e7d0d7bc20394f6a8c41594d8`)
   *(You can also set multiple keys separated by commas for key rotation: `key1,key2`)*

### How Clients Pass the API Key:
Clients can provide the key using **any of these three industry-standard methods**:

1. **Custom Header (Standard):**
   ```http
   x-api-key: your_api_key_here
   ```
2. **Bearer Token:**
   ```http
   Authorization: Bearer your_api_key_here
   ```
3. **Query Parameter (Useful for `<img>` tags):**
   ```http
   GET /api/profile/ROLL_NUMBER?api_key=your_api_key_here
   ```

*(Note: The built-in frontend on Railway continues working seamlessly without needing a key).*

---

## 11. Building a New Frontend (Integration Guide)

All `/api/*` endpoints have **CORS enabled** (`Access-Control-Allow-Origin: *` or configurable via `CORS_ORIGIN`).

### React / Next.js Component Example:
```jsx
import { useState } from 'react';

const API_KEY = 'your_api_key_here'; // Configure your key

export default function StudentPhotoViewer() {
  const [roll, setRoll] = useState('');
  const [photoUrl, setPhotoUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchPhoto = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`https://abes-profile-viewer-production.up.railway.app/api/profile/${roll}?format=json`, {
        headers: {
          'x-api-key': API_KEY
        }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch photo');
      setPhotoUrl(data.dataUrl);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <input value={roll} onChange={(e) => setRoll(e.target.value)} placeholder="Enter Roll Number" />
      <button onClick={fetchPhoto} disabled={loading}>{loading ? 'Loading...' : 'Search'}</button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {photoUrl && <img src={photoUrl} alt="Student" style={{ width: 160, borderRadius: 8 }} />}
    </div>
  );
}
```

### Direct HTML `<img>` Tag Example:
```html
<img 
  src="https://abes-profile-viewer-production.up.railway.app/api/profile/ROLL_NUMBER" 
  alt="Student Profile" 
  onerror="this.style.display='none'"
/>
```

### Flutter / Dart Example:
```dart
final url = Uri.parse('https://abes-profile-viewer-production.up.railway.app/api/profile/$rollNumber?format=json');
final response = await http.get(url);
if (response.statusCode == 200) {
  final data = jsonDecode(response.body);
  final imageBytes = base64Decode(data['base64']);
  // Display Image.memory(imageBytes)
}
```

### cURL:
```bash
# Download image directly
curl -o student.jpg "https://abes-profile-viewer-production.up.railway.app/api/profile/ROLL_NUMBER"

# Or get JSON
curl "https://abes-profile-viewer-production.up.railway.app/api/profile/ROLL_NUMBER?format=json"
```

---

**Error Responses:**
- `400 Bad Request`:
  ```json
  { "error": "Invalid roll number format. Only letters, numbers, hyphens, and underscores are allowed." }
  ```
- `401 Unauthorized` (Session Expired / Invalid):
  ```json
  { "error": "ERP session has expired or is invalid. Please refresh the authorized ERP cookies on the server." }
  ```
- `404 Not Found`:
  ```json
  { "error": "Profile image not found for roll number: ROLL_NUMBER" }
  ```
- `429 Too Many Requests`:
  ```json
  { "error": "Rate limit exceeded. Maximum 30 requests per minute allowed. Please try again in 45 seconds." }
  ```
- `502 Bad Gateway`:
  ```json
  { "error": "ERP returned an unexpected response format instead of an image." }
  ```
- `504 Gateway Timeout`:
  ```json
  { "error": "ERP request timed out after 10 seconds. The upstream server may be offline or unreachable." }
  ```

---

## 10. Automated ERP Session Management & Re-Authentication Flow

The backend manages the ABES ERP authentication lifecycle server-side so clients only supply a roll number.

### Architectural Flow:
1. **Client Submits Roll Number**: The browser frontend sends only `{ rollNumber: "..." }`. The frontend NEVER stores or receives any ERP credentials, cookies, or session tokens.
2. **Session Pre-Check (`checkErpSession()`)**: The backend verifies if the current session in the server-side cookie jar (`erpCookieJar`) is active.
3. **Automated Re-Authentication (`performErpLogin()`)**:
   - If the session is invalid or expired, the backend initiates an authenticated login flight.
   - **Single-Flight Lock**: If multiple profile requests arrive while the session is expired, only **one** login attempt is made. All concurrent requests await the shared flight.
   - Extracts ASP.NET Web Forms parameters (`__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION`, form fields `txtuser`, `txtPassword`, `btnStaff`).
4. **Cookie Jar Storage (`ErpCookieJar`)**: Newly captured cookies (`MyAuth`, `ASP.NET_SessionId`, etc.) are parsed, validated for expiration, and stored strictly server-side.
5. **Session Validation & Fetch**: The newly established session is verified, and the profile photo is streamed to the client.

### Security Restrictions & Two-Factor Challenges (OTP / reCAPTCHA):
- Live inspection of `https://erp.abes.ac.in/Login.aspx` reveals that student logins mandate an **OTP** (`txtOTP`, `btnOTP`) and **Google reCAPTCHA v2** (`6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI`).
- In strict adherence to security rules, **no attempt is made to bypass OTP, CAPTCHA, or Cloudflare challenges**.
- If an account enforces an OTP/reCAPTCHA challenge, the backend cleanly reports:
  ```json
  {
    "error": "ABES ERP enforces a mandatory OTP / reCAPTCHA security challenge for this account...",
    "code": "ERP_CHALLENGE_REQUIRED"
  }
  ```
- In such environments, administrators supply pre-authenticated session cookies (`ERP_MYAUTH`, `ERP_ASP_NET_SESSION_ID`) or machine accounts with direct credential access.

---

## 11. ERP Session Keep-Alive & Permanent Expiration Prevention

The ABES ERP system runs on Microsoft IIS / ASP.NET Web Forms. ASP.NET implements a **sliding expiration timeout** for session state (typically 5 to 15 minutes of inactivity). If no requests are received during this window, IIS drops the session. Once dropped, that session cookie is invalidated on the server.

To guarantee that your deployed session **never expires**, the application runs a high-frequency background keep-alive heartbeat and self-healing engine:

### How It Works:
1. **High-Frequency Sliding Heartbeat (Every 60 Seconds)**:
   - The scheduler runs every **60 seconds** (`ERP_KEEPALIVE_INTERVAL_SECONDS=60`, default 1 minute).
   - This touches the ASP.NET session state handler continuously, resetting the IIS sliding expiration timer back to 0 every minute.
   - The session never reaches the inactivity threshold and stays alive 24/7/365.
2. **Instant Startup Touch (2 Seconds)**:
   - When the container boots on Railway or restarts after a deploy, the initial keep-alive ping runs in **2 seconds** (`ERP_KEEPALIVE_STARTUP_DELAY_MS=2000`) rather than 30 seconds, immediately refreshing the session.
3. **Automated Self-Healing / Auto-Reauthentication**:
   - If `ERP_USERNAME` and `ERP_PASSWORD` are configured in Railway environment variables:
     When any session drop or expiration is detected, the server automatically executes a background re-authentication flight (`performErpLogin()`), retrieves fresh cookies, and restores `erpSessionStatus = 'active'` seamlessly without downtime.
4. **Transparent In-Flight Retry**:
   - If an upstream request momentarily encounters an expired session while user requests arrive, the server transparently re-authenticates and retries the fetch within the same request cycle.
5. **Railway Container Anti-Sleep / Anti-Idling**:
   - Railway deployments automatically provide `RAILWAY_PUBLIC_DOMAIN` or `RAILWAY_STATIC_URL`.
   - The server detects this domain and dispatches an internal self-heartbeat ping to `/api/health` every 5 minutes, preventing Railway from putting the container into a cold sleep state.
6. **In-Memory Cookie Sliding Extension**:
   - The server's `ErpCookieJar` actively slides and preserves session cookies in memory upon every successful request, preventing premature local eviction.

### Configuration
| Variable | Default | Description |
| :--- | :--- | :--- |
| `ERP_KEEPALIVE_INTERVAL_SECONDS` | `60` | Heartbeat interval in seconds (default: 60s) |
| `ERP_KEEPALIVE_INTERVAL_MINUTES` | `1` | Heartbeat interval in minutes (default: 1m) |
| `ERP_KEEPALIVE_STARTUP_DELAY_MS` | `2000` | Delay before initial keep-alive run (default: 2000ms) |
| `ERP_TIMEOUT_MS` | `10000` | Timeout in milliseconds for upstream ERP requests |
| `ERP_KEEPALIVE_URL` | `https://erp.abes.ac.in/Home/Student/Default.aspx` | Approved lightweight ERP page |
| `SELF_PING_INTERVAL_MINUTES` | `5` | Anti-sleep self-ping interval for cloud containers |

---

## 12. Free Deployment Guides

The application is completely self-contained and compatible with any platform supporting Node.js.

### Option A: Render (Recommended Free Tier)
1. Push your repository to GitHub (**ensure `.env` is NOT committed**).
2. Go to [render.com](https://render.com) and create a new **Web Service**.
3. Connect your repository.
4. Set the following configuration:
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Go to the **Environment** tab in Render:
   - Add `ERP_MYAUTH` = `<your_cookie_value>`
   - Add `ERP_ASP_NET_SESSION_ID` = `<your_cookie_value>`
   - (Optional) `PORT` = `3000`
6. Click **Deploy**.

### Option B: Railway (Permanent 24/7 Deployment)
1. Sign up on [railway.app](https://railway.app).
2. Click **New Project** &rarr; **Deploy from GitHub repo**.
3. Select your repository.
4. In the service settings, go to **Variables** and configure either:
   - **Recommended (100% Zero-Touch Permanent Autorenewal)**:
     - `ERP_USERNAME` = `<your_erp_username>`
     - `ERP_PASSWORD` = `<your_erp_password>`
     *(The server logs in automatically and continuously self-heals in the background)*
   - **Alternative (Pre-Authorized Session Cookies)**:
     - `ERP_MYAUTH` = `<your_myauth_cookie>`
     - `ERP_ASP_NET_SESSION_ID` = `<your_asp_net_session_id_cookie>`
     - `ERP_KEEPALIVE_INTERVAL_SECONDS` = `60`
     *(The 60-second keep-alive heartbeat will keep the ASP.NET sliding session alive continuously)*
5. Deploy. Railway automatically sets `RAILWAY_PUBLIC_DOMAIN`, enabling container anti-sleep heartbeats.

### Option C: Fly.io
1. Install Fly CLI: `curl -L https://fly.io/install.sh | sh`
2. Run `fly launch` in the project root.
3. Set secrets securely using Fly CLI:
   ```bash
   fly secrets set ERP_MYAUTH="your_myauth_value" ERP_ASP_NET_SESSION_ID="your_session_value"
   ```
4. Run `fly deploy`.

---

## 13. Troubleshooting

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| **"ERP session has expired or is invalid"** | The ASP.NET session expired on ABES ERP. | Log in to ABES ERP in your browser, copy fresh `MyAuth` and `ASP.NET_SessionId` cookie values, and update them in `.env`. Restart the server. |
| **"Server is not configured with valid ERP session credentials"** | Environment variables are missing or empty. | Check that `.env` exists in `abes-profile-viewer/` and contains non-empty `ERP_MYAUTH` and `ERP_ASP_NET_SESSION_ID`. |
| **"Invalid roll number format"** | Roll number contains spaces or unsupported symbols. | Enter roll number containing only letters, numbers, `-`, or `_` (e.g., `ROLL_NUMBER`). |
| **"Rate limit exceeded"** | More than 30 requests sent within 1 minute from the same IP. | Wait for the cooldown window (shown in message) or adjust `RATE_LIMIT_MAX` in `.env`. |
| **"ERP request timed out"** | Upstream `erp.abes.ac.in` server is slow, unreachable, or undergoing maintenance. | Verify that you can open `https://erp.abes.ac.in` in your browser. Increase `ERP_TIMEOUT_MS` if required. |

---

## 14. Security & Compliance Notice

- This software is designed exclusively for authorized student/staff reference.
- It does **not** bypass, alter, or manipulate authentication, CAPTCHA, or security controls.
- It strictly re-uses an active session established legally by the authenticated user.
- Photos are streamed in real time without being permanently persisted or cataloged into a database.
