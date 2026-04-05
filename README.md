# LifeBand Backend API

Production-ready REST API for the **LifeBand** system — a wearable medical ID band that stores emergency health information accessible via QR code scan, with no app install required.

---

## What is LifeBand?

LifeBand is a physical wearable band engraved with a QR code. When scanned (by a paramedic, doctor, or bystander), it instantly displays the wearer's emergency profile:

- Blood group
- Emergency contact
- Allergies, medications, medical conditions
- Doctor's notes

The backend handles the complete lifecycle:
- **Admin** generates band batches → downloads QR code ZIPs → sends to manufacturer
- **User** scans band → registers it with their email (OTP verified) → fills medical profile
- **Anyone** scans the band in an emergency → reads the profile instantly, no login required

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Database | MongoDB Atlas (Mongoose ODM) |
| Authentication | OTP (Fast2SMS) + JWT |
| QR Generation | `qrcode` |
| ZIP Packaging | `archiver` |
| HTTP Client | `axios` |

---

## Project Structure

```
backend/
├── src/
│   ├── server.js               # Entry point — DB connect → HTTP server
│   ├── app.js                  # Express app, middleware, error handling
│   ├── config/
│   │   └── db.js               # MongoDB Atlas connection
│   ├── models/
│   │   ├── Band.js             # Physical band (bandId, isRegistered)
│   │   ├── BandSeries.js       # Manufacturing batch tracking
│   │   ├── Owner.js            # Band ownership (hashed email)
│   │   ├── EmergencyProfile.js # Medical profile data
│   │   ├── OtpSession.js       # OTP sessions with TTL auto-expiry
│   │   └── AdminUser.js        # Admin email allowlist
│   ├── middleware/
│   │   └── adminAuth.js        # JWT Bearer token validation
│   ├── routes/
│   │   ├── public.js           # Public endpoints (scan, register, emergency)
│   │   ├── profile.js          # OTP-protected profile editing
│   │   └── admin.js            # JWT-protected admin panel
│   ├── services/
│   │   ├── otpService.js       # OTP lifecycle (send, verify, expire)
│   │   ├── smsProvider.js      # Fast2SMS OTP route integration
│   │   └── bandService.js      # Band generation, QR creation, ZIP packaging
│   └── utils/
│       ├── hash.js             # SHA-256 email hashing + JWT helpers
│       └── otp.js              # OTP generation, expiry, timing-safe compare
├── storage/
│   └── series/                 # Permanent ZIP archives (gitignored)
├── .env.example                # Environment variable template
├── .gitignore
├── package.json
└── README.md
```

---

## API Reference

### Public Routes — No authentication required

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `GET` | `/health` | — | Liveness check |
| `GET` | `/i/:bandId` | — | Scan a band — returns profile or registration prompt |
| `GET` | `/emergency/:bandId` | — | Read-only emergency profile lookup |
| `POST` | `/register/request-otp` | `{ emailAddress }` | Send OTP for registration |
| `POST` | `/register/complete` | `{ bandId, emailAddress, otp, name, bloodGroup, emergencyContact, allergies, medicalConditions, medications, notes }` | Verify OTP → lock band → create profile |

### Profile Routes — OTP-verified, ownership-checked

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/profile/request-otp` | `{ emailAddress }` | Send OTP for profile edit |
| `POST` | `/profile/update` | `{ bandId, emailAddress, otp, ...editableFields }` | Verify OTP + ownership → update profile |

> **Editable fields:** `allergies`, `medicalConditions`, `medications`, `notes`, `emergencyContact`
> **Immutable fields:** `bandId`, `bloodGroup`, `name`, `emailHash` — never changed after registration.

### Admin Routes — JWT Bearer token required

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/admin/request-otp` | `{ emailAddress }` | Send admin OTP (rate-limited: 5/hr/IP) |
| `POST` | `/admin/login` | `{ emailAddress, otp }` | Verify OTP → check AdminUser → issue JWT |
| `GET` | `/admin/dashboard` | — | Band counts + latest series |
| `GET` | `/admin/series` | — | All manufacturing series (newest first) |
| `POST` | `/admin/generate-series` | `{ count }` | Generate bands + QR PNGs + ZIP (max 500/batch) |
| `GET` | `/admin/download/:seriesId` | — | Stream ZIP file for a series |

---

## Authentication Flows

### User Registration
```
POST /register/request-otp   → OTP sent to email
POST /register/complete      → OTP verified → band locked atomically
                             → Owner + EmergencyProfile created
```

### Profile Editing
```
POST /profile/request-otp   → OTP sent to email
POST /profile/update        → OTP verified → ownership confirmed
                            → only whitelisted fields updated
```

### Admin Login
```
POST /admin/request-otp     → OTP sent (rate-limited: 5/hr/IP)
POST /admin/login           → OTP verified → AdminUser lookup
                            → JWT issued (7d default)
Authorization: Bearer <token>  → all /admin/* routes
```

---

## Security Design

| Concern | Implementation |
|---|---|
| Email privacy | SHA-256 hashed before storage — never stored in plaintext |
| OTP brute-force | Max 5 attempts → session deleted → user must re-request |
| OTP replay | Session consumed on first successful verify (one-time use) |
| OTP timing attack | `crypto.timingSafeEqual` comparison |
| Band double-registration | Atomic `findOneAndUpdate({ isRegistered: false })` — MongoDB-level lock |
| Admin enumeration | Same error message whether email is unknown admin or wrong OTP |
| JWT forgery | HS256 signed with `JWT_SECRET` (32+ char random string) |
| Admin OTP abuse | `express-rate-limit`: 5 requests/hour/IP |
| Body injection | 10kb body limit; profile updates use explicit field whitelist |
| Security headers | `X-Content-Type-Options`, `X-Frame-Options`, `CSP`, `Referrer-Policy` |
| Internal error leaking | Production 500s return generic message; SMS/DB errors never reach client |

---

## Band ID Format

```
LB-000001
LB-000002
...
LB-999999
```

- Regex: `^LB-\d{6}$` — exactly 6 digits, fixed permanently
- QR URL: `https://lifeband.in/i/LB-000001`
- **This URL format is permanent infrastructure** — printed on physical bands, never change it

---

## Setup

### Prerequisites
- Node.js 18+
- MongoDB Atlas account
- Fast2SMS account (free tier works)

### 1. Clone and install

```bash
git clone https://github.com/Ritikreacts/lifeband-backend.git
cd lifeband-backend
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
NODE_ENV=development
PORT=5000

MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/lifeband

HASH_SECRET=<random-32-char-string>
JWT_SECRET=<random-32-char-string>
JWT_EXPIRY=7d

OTP_TTL_MINUTES=5
MAX_OTP_ATTEMPTS=5

FAST2SMS_API_KEY=<your-fast2sms-api-key>
SMS_ENABLED=false        # set to "true" for real SMS delivery

QR_BASE_URL=https://lifeband.in/i
MAX_BANDS_PER_BATCH=500
STORAGE_DIR=./storage/series
```

> **SMS_ENABLED=false** means OTPs are printed to server console (safe for development). Set to `true` in production.

### 3. Seed the first admin

There is no admin signup endpoint (by design). Add the first admin directly via MongoDB Atlas:

```js
// In Atlas Data Explorer → lifeband → adminusers → Insert Document
{
  "emailHash": "<sha256 of lowercase email>",
  "createdAt": { "$date": "2026-01-01T00:00:00Z" }
}
```

Or run a quick Node script:
```js
const crypto = require("crypto");
const email  = "admin@example.com"; // your admin email
const hash   = crypto.createHash("sha256").update(email.toLowerCase()).digest("hex");
console.log(hash); // paste this as emailHash in Atlas
```

### 4. Run

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm run start
```

Server starts on `http://localhost:5000`.

---

## Admin Manufacturing Flow

```
1. POST /admin/request-otp   → OTP to admin email
2. POST /admin/login         → receive JWT
3. POST /admin/generate-series { count: 100 }
   → 100 bands created (LB-000001 to LB-000100)
   → 100 QR PNG files generated
   → ZIP packaged at storage/series/LB-000001-000100.zip
   → response includes downloadUrl
4. GET /admin/download/:seriesId → download ZIP
5. Send ZIP to manufacturer → bands engraved → shipped
```

> Series records are **append-only**. There is no delete endpoint — this is intentional, as printed bands are permanent infrastructure.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `production` hides stack traces |
| `PORT` | No | `5000` | HTTP server port |
| `MONGODB_URI` | **Yes** | — | MongoDB Atlas connection string |
| `JWT_SECRET` | **Yes** | — | JWT signing secret (32+ chars) |
| `JWT_EXPIRY` | No | `7d` | Admin token lifetime |
| `HASH_SECRET` | No | — | Legacy HMAC key (unused in current version) |
| `FAST2SMS_API_KEY` | Yes (prod) | — | Fast2SMS dev API key |
| `SMS_ENABLED` | No | `false` | `"true"` fires real SMS; anything else = console log |
| `OTP_TTL_MINUTES` | No | `5` | OTP expiry window |
| `MAX_OTP_ATTEMPTS` | No | `5` | Failed attempts before session is locked |
| `QR_BASE_URL` | No | `https://lifeband.in/i` | Base URL baked into QR codes — **never change after printing** |
| `MAX_BANDS_PER_BATCH` | No | `500` | Maximum bands per admin generation request |
| `STORAGE_DIR` | No | `./storage/series` | Permanent ZIP storage path |

---

## License

Private — All rights reserved. Not open source.
