# WanderLust — Full-Stack Vacation Rental Platform

WanderLust is a production-grade full-stack hospitality marketplace inspired by Airbnb, built with **Node.js, Express, MongoDB/Mongoose, and EJS**. It features atomic reservation calendar management, multi-tier booking state machines, listing lifecycle soft-deletion, and a hardened **Razorpay** payment gateway architecture with strict server-side cryptographic signature verification.

---

## Key Architecture & Features

### 1. Booking Lifecycle State Machine
WanderLust implements a real host-platform reservation flow:
$$\mathbf{PENDING\_PAYMENT} \longrightarrow \mathbf{AWAITING\_HOST\_APPROVAL} \longrightarrow \mathbf{CONFIRMED} \longrightarrow \mathbf{COMPLETED}$$

1. **Guest Reserves (`PENDING_PAYMENT`)**: The dates are locked for a 15-minute checkout window via atomic calendar availability validation.
2. **Guest Pays (`AWAITING_HOST_APPROVAL`)**: When payment is verified via Razorpay, the reservation transitions to `AWAITING_HOST_APPROVAL` and `paymentStatus: "PAID"`.
3. **Host Decides**:
   - **Confirm**: Host accepts reservation $\rightarrow$ transitions to `CONFIRMED`.
   - **Decline**: Host rejects reservation $\rightarrow$ gateway immediately issues a 100% automated refund, marking the reservation `CANCELLED` and `REFUNDED` while freeing the calendar dates.
4. **Trip Fulfillment (`COMPLETED`)**: Past confirmed reservations automatically synchronize to `COMPLETED` upon checkout date expiration.

---

### 2. Enterprise Payment & Refund Security Architecture

#### Server-Side Cryptographic Signature Verification
> **Core Principle**: Payment success is **NEVER** recorded based on client-side frontend callbacks.

In any web application, a malicious user or automated bot can inspect client-side JavaScript, intercept the browser network requests, and send fabricated HTTP requests pretending that a payment succeeded without ever spending real funds.

To eliminate this vulnerability:
1. **Order Creation**: The server initiates the transaction using the Razorpay Orders API (`amount`, `currency`, `receipt`) with server-side secrets. The server stores `razorpayOrderId` in MongoDB.
2. **Cryptographic Signature Verification**:
   When the client completes payment, Razorpay returns three values:
   - `razorpay_order_id`
   - `razorpay_payment_id`
   - `razorpay_signature`
3. **HMAC SHA-256 Hash**:
   The server independently computes:
   $$\text{expectedSignature} = \text{HMAC-SHA256}(\text{razorpay\_order\_id} + \text{"|"} + \text{razorpay\_payment\_id}, \text{RAZORPAY\_KEY\_SECRET})$$
4. **Validation**:
   The reservation transitions to `PAID` **ONLY if** `expectedSignature === razorpay_signature`. If the signature does not match, the request is immediately rejected with `HTTP 400` and logged as a tampering attempt.

#### Webhook Asynchronous Reconciliation
- An official Razorpay Webhook listener (`/bookings/webhook/razorpay`) listens for gateway events (`payment.captured`, `payment.failed`, `refund.processed`).
- Uses `crypto.timingSafeEqual` with `RAZORPAY_WEBHOOK_SECRET` to prevent timing attacks.
- Reconciles abandoned or disconnected browser checkout sessions.
- Validates that incoming payload order ID, currency, and exact amount in paise match the database record before updating state.
- Strictly refuses to revive cancelled or refunded bookings. If a late payment captures on cancelled dates that were re-booked, the system immediately issues an automated gateway refund.

#### Concurrency & Double-Refund Protection
- **Atomic `REFUND_PENDING` Claims**: Uses MongoDB `findOneAndUpdate({ _id, paymentStatus: "PAID" }, { $set: { paymentStatus: "REFUND_PENDING" } })` to ensure that two simultaneous refund requests cannot race and issue double payouts.
- **Unique Partial Indexes**: MongoDB partial indexes (`sparse`, unique where field exists) on `paymentId` and `razorpayOrderId` guarantee zero duplicate payment associations across reservations.

---

### 3. Local-Only Payment Simulation (`ALLOW_PAYMENT_SIMULATOR=true`)

For developer convenience during local offline coding and student demos:
- **Strictly Local-Only**: Mock payment simulation is permitted **ONLY** when `NODE_ENV !== "production"` **AND** `NODE_ENV !== "staging"` **AND** `ALLOW_PAYMENT_SIMULATOR=true` is explicitly configured in `.env`.
- **Demo Override**: Set `FORCE_PAYMENT_SIMULATOR=true` alongside `ALLOW_PAYMENT_SIMULATOR=true` to open the local simulator directly and exercise the full booking flow without relying on a third-party test payment method. This override remains unavailable in staging and production.
- **Production & Staging Safe Failure**:
  In production or staging, `isPaymentSimulatorAllowed()` unconditionally returns `false`. Any simulated signature or mock refund is strictly rejected. If Razorpay credentials or gateway API calls fail, the platform **never silently fakes a success**; it fails safely with structured error feedback and preserves database integrity.

---

### 4. Listing Soft Delete / Archival (`isActive: false`)

To reflect professional marketplace standards (Airbnb, Booking.com):
- When a host deletes a listing, historical bookings, payments, refunds, and reviews are **never destroyed**.
- The listing is marked `isActive: false` with an `archivedAt` timestamp.
- Archived listings are automatically excluded from public search, category filters, and explore feeds (`{ isActive: { $ne: false } }`).
- New reservations and availability checks on archived listings are cleanly blocked with user-friendly notices.
- Existing confirmed trips retain valid references for guest receipts and host earnings logs.

### 5. Enterprise Security Hardening

To defend against web application vulnerabilities (OWASP Top 10):
- **CSRF Protection (Synchronized Token Pattern)**:
  - Generates cryptographically secure 32-byte session tokens using Node.js `crypto.randomBytes(32)` and validates them via `crypto.timingSafeEqual` to prevent side-channel timing attacks.
  - Injected as hidden `_csrf` fields into all state-changing HTML forms (`POST`, `PUT`, `DELETE`) and passed via `X-CSRF-Token` headers for AJAX payment verification calls.
  - **Webhook Exemption**: External Razorpay webhooks (`/bookings/webhook/razorpay`) do not originate from user sessions; they are authenticated via cryptographic HMAC-SHA256 signature verification.
- **Helmet HTTP Security Headers**:
  - Implements `helmet()` with a tailored Content Security Policy (CSP) whitelisting only trusted CDN resources (Bootstrap, FontAwesome, Leaflet, Cloudinary, Razorpay, Google Fonts).
  - Enforces `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `Strict-Transport-Security`.
- **Targeted Rate Limiting**:
  - `authLimiter`: Max 15 requests / 15 minutes per IP on `/login` and `/signup` to mitigate credential stuffing and brute-force attacks.
  - `paymentLimiter`: Max 30 requests / 15 minutes per IP on payment endpoints to prevent automated card-testing and gateway DoS.
- **Production Cookie & Reverse Proxy Hardening**:
  - Configures `app.set("trust proxy", 1)` for deployments behind reverse proxies (Heroku, Render, AWS ALB, Nginx).
  - Renames session cookie to `__wl_sess` to prevent framework fingerprinting.
  - Enforces `httpOnly: true`, `secure: true` (in production), `sameSite: "lax"`, and `saveUninitialized: false`.

---

## Interview Talking Points: Payment Architecture & Security

When discussing this project in engineering interviews:

| Topic | Key Answer / Talking Point |
|---|---|
| **Why verify payments server-side?** | "Client-side responses are fully controllable by the user. If an app trusts `response.razorpay_payment_id` from the browser without server verification, an attacker can spoof success payloads to get free bookings. We compute an HMAC SHA-256 hash using our server-side secret key and verify the cryptographic signature before altering reservation state." |
| **How do you handle dropped connections during checkout?** | "If a user closes their tab immediately after their bank authorizes payment, the frontend redirect never fires. We implement an idempotent Razorpay webhook (`payment.captured`) with secret verification that reconciles the transaction in the background." |
| **How do you prevent double refunds?** | "We use an atomic `findOneAndUpdate` state machine transition (`PAID` $\rightarrow$ `REFUND_PENDING`). Any competing concurrent request fails to match the query and receives HTTP 409 Conflict, ensuring that gateway refunds are triggered at most once." |
| **How do you guard against mock payments leaking to production?** | "We enforce a strict environment guard (`ALLOW_PAYMENT_SIMULATOR=true`) combined with `NODE_ENV` checks. In production and staging, the simulator is completely disabled; simulated signatures are rejected with HTTP 400 and gateway errors trigger safe 500 rollbacks rather than mock fallbacks." |
| **How is CSRF prevented?** | "We use the Synchronized Token Pattern with `crypto.randomBytes(32)` tokens stored in session and validated with constant-time comparison (`crypto.timingSafeEqual`). All state-changing HTML forms submit hidden `_csrf` fields and AJAX checkout calls supply `X-CSRF-Token` headers, while gateway webhooks are exempt and authenticated via HMAC signatures." |
| **Why configure Helmet CSP?** | "Default Helmet blocks external CDN scripts, stylesheets, and images. We configured custom CSP directives specifically whitelisting Razorpay Checkout, Cloudinary CDN, Leaflet OpenStreetMap tiles, and FontAwesome, defending against XSS while keeping all interactive features working." |
| **Why tune production cookies and proxy trust?** | "We enable `trust proxy: 1` so Express reads `X-Forwarded-Proto` correctly behind load balancers. Session cookies use `httpOnly: true` (XSS prevention), `secure: true` (HTTPS only), `sameSite: 'lax'` (CSRF defense), and custom naming `__wl_sess` to avoid framework fingerprinting." |

---

## Environment Variables (`.env`)

```env
# Cloudinary (Image uploads)
CLOUD_NAME=your_cloudinary_name
CLOUD_API_KEY=your_cloudinary_api_key
CLOUD_API_SECRET=your_cloudinary_api_secret

# Database & Sessions
ATLASDB_URL=mongodb://127.0.0.1:27017/wanderlust
SECRET=your_session_secret

# Razorpay Payment Gateway
RAZORPAY_KEY_ID=rzp_test_your_key_id
RAZORPAY_KEY_SECRET=your_razorpay_key_secret
RAZORPAY_WEBHOOK_SECRET=your_webhook_secret

# Local Simulator (LOCAL ONLY — disabled in production/staging)
ALLOW_PAYMENT_SIMULATOR=true
NODE_ENV=development
```

---

## Running the Automated Test Suite

WanderLust includes an end-to-end integration and security test suite covering **40 comprehensive test scenarios**:
- Signature spoofing prevention & production guards
- Webhook HMAC validation & late-payment auto-refunds
- Concurrency race condition prevention (`REFUND_PENDING`)
- State machine transitions (`PENDING_PAYMENT` $\rightarrow$ `AWAITING_HOST_APPROVAL` $\rightarrow$ `CONFIRMED` $\rightarrow$ `COMPLETED`)
- Listing soft-deletion & history preservation
- Strict `ALLOW_PAYMENT_SIMULATOR=true` enforcement across environments

Run the test suite:
```bash
node tests/payment.test.js
```
