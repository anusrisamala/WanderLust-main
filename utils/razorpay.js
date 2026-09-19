const Razorpay = require("razorpay");

let razorpayInstance = null;

/**
 * Factory function to retrieve configured Razorpay instance.
 * Ensures credentials remain strictly server-side.
 */
function getRazorpayInstance() {
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;

    if (!key_id || !key_secret) {
        throw new Error("Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET) are missing.");
    }

    if (!razorpayInstance) {
        razorpayInstance = new Razorpay({
            key_id,
            key_secret,
        });
    }

    return razorpayInstance;
}

/**
 * Helper to check if payment simulator is explicitly allowed.
 * Simulator is STRICTLY restricted to local development environments
 * and only when ALLOW_PAYMENT_SIMULATOR=true is explicitly set in environment.
 * In production or staging environments, this always returns false.
 */
function isPaymentSimulatorAllowed() {
    const env = (process.env.NODE_ENV || "development").toLowerCase();
    const isProdOrStaging = env === "production" || env === "staging";
    if (isProdOrStaging) {
        return false;
    }
    return String(process.env.ALLOW_PAYMENT_SIMULATOR).trim().toLowerCase() === "true";
}

/**
 * Explicit local-demo override. This lets developers exercise the complete
 * application booking state machine when a payment provider test account has
 * unavailable methods. It can never be enabled in production or staging.
 */
function isPaymentSimulatorForced() {
    return isPaymentSimulatorAllowed() &&
        String(process.env.FORCE_PAYMENT_SIMULATOR).trim().toLowerCase() === "true";
}

module.exports = {
    getRazorpayInstance,
    isPaymentSimulatorAllowed,
    isPaymentSimulatorForced,
};
