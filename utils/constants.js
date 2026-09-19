// Central configuration constants for WanderLust
const TAX_CONFIG = {
    GST_PERCENT: 5,       // Configurable GST percentage (e.g. 5%)
    GST_RATE: 0.05,       // Decimal rate multiplier for calculation
};

const PAYMENT_HOLD_CONFIG = {
    HOLD_MINUTES: 15,
    HOLD_MS: 15 * 60 * 1000,
};

module.exports = {
    TAX_CONFIG,
    PAYMENT_HOLD_CONFIG,
};
