const crypto = require("crypto");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");

/**
 * Robust CSRF Protection Middleware
 * Uses the Synchronized Token Pattern with Node.js crypto.timingSafeEqual
 * to defend against Cross-Site Request Forgery.
 */
function csrfProtection(req, res, next) {
    if (!req.session) {
        return next();
    }

    // 1. Generate cryptographically strong token if not already in session
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    }

    // Expose token to all EJS templates
    if (res && res.locals) {
        res.locals.csrfToken = req.session.csrfToken;
    }

    // 2. Safe HTTP methods do not change state
    const safeMethods = ["GET", "HEAD", "OPTIONS"];
    if (safeMethods.includes(req.method)) {
        return next();
    }

    // 3. Exemption: External Razorpay Webhooks (verified via HMAC-SHA256 signature)
    const rawPath = (req.originalUrl || req.url || "").split("?")[0];
    if (rawPath === "/bookings/webhook" || rawPath === "/bookings/webhook/razorpay" || (req.originalUrl && req.originalUrl.includes("/bookings/webhook"))) {
        return next();
    }

    // 4. Exemption: Test suite running non-CSRF unit tests
    if (process.env.NODE_ENV === "test" && !req.enforceCsrf) {
        return next();
    }

    // 5. Extract CSRF token from request body or HTTP request headers
    const clientToken = req.body?._csrf ||
        req.query?._csrf ||
        req.headers["x-csrf-token"] ||
        req.headers["csrf-token"];

    if (!clientToken || typeof clientToken !== "string") {
        return handleCsrfFailure(req, res, "Invalid or missing CSRF token.");
    }

    // 6. Timing-safe comparison to prevent side-channel timing attacks
    const sessionBuf = Buffer.from(req.session.csrfToken, "utf8");
    const clientBuf = Buffer.from(clientToken, "utf8");

    if (sessionBuf.length !== clientBuf.length || !crypto.timingSafeEqual(sessionBuf, clientBuf)) {
        return handleCsrfFailure(req, res, "CSRF token mismatch.");
    }

    return next();
}

function handleCsrfFailure(req, res, message) {
    if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
        return res.status(403).json({
            success: false,
            error: message,
            code: "EBADCSRFTOKEN"
        });
    }

    req.flash("error", "Security verification failed (invalid or expired form token). Please try again.");
    return res.status(403).redirect(req.get("Referrer") || "/listings");
}

/**
 * Rate Limiter for Authentication Endpoints (/login, /signup)
 * Mitigates credential stuffing, password guessing, and brute-force attacks.
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15-minute sliding window
    max: 15, // Max 15 requests per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test" && !process.env.ENFORCE_RATE_LIMIT,
    handler: (req, res) => {
        const message = "Too many login/signup attempts from this IP. Please try again after 15 minutes.";
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(429).json({ success: false, error: message });
        }
        req.flash("error", message);
        return res.status(429).redirect(req.get("Referrer") || "/login");
    }
});

/**
 * Rate Limiter for Payment Gateway Operations (/payment/order, /payment/verify)
 * Prevents gateway spam, automated card testing, and DoS on Razorpay API.
 */
const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15-minute sliding window
    max: 30, // Max 30 payment operations per 15 minutes per IP
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test" && !process.env.ENFORCE_RATE_LIMIT,
    handler: (req, res) => {
        return res.status(429).json({
            success: false,
            error: "Too many payment operations from this IP. Please wait a few minutes before trying again."
        });
    }
});

/**
 * Helmet Security Headers Configuration
 * Configures HTTP security headers and tailored Content Security Policy (CSP).
 */
const helmetConfig = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://checkout.razorpay.com",
                "https://cdn.razorpay.com",
                "https://cdnjs.cloudflare.com",
                "https://unpkg.com"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                "https://fonts.googleapis.com",
                "https://unpkg.com"
            ],
            imgSrc: [
                "'self'",
                "data:",
                "blob:",
                "https://res.cloudinary.com",
                "https://unpkg.com",
                "https://cdn.jsdelivr.net",
                "https://cdnjs.cloudflare.com",
                "https://server.arcgisonline.com",
                "https://*.arcgisonline.com",
                "https://*.basemaps.cartocdn.com",
                "https://basemaps.cartocdn.com",
                "https://*.tile.openstreetmap.org",
                "https://tile.openstreetmap.org",
                "https://images.unsplash.com"
            ],
            connectSrc: [
                "'self'",
                "https://unpkg.com",
                "https://server.arcgisonline.com",
                "https://*.arcgisonline.com",
                "https://api.razorpay.com",
                "https://lumberjack.razorpay.com",
                "https://cdn.razorpay.com",
                "https://cdn.jsdelivr.net",
                "https://*.basemaps.cartocdn.com",
                "https://basemaps.cartocdn.com",
                "https://*.tile.openstreetmap.org",
                "https://tile.openstreetmap.org"
            ],
            frameSrc: [
                "'self'",
                "https://api.razorpay.com",
                "https://checkout.razorpay.com"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "https://cdnjs.cloudflare.com"
            ],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: process.env.NODE_ENV === "production" ? [] : null
        }
    },
    crossOriginEmbedderPolicy: false, // Ensures CDN images and map tiles render without CORS issues
});

module.exports = {
    csrfProtection,
    authLimiter,
    paymentLimiter,
    helmetConfig,
};
