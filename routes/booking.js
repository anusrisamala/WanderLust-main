const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn } = require("../middleware.js");
const { paymentLimiter } = require("../utils/security.js");
const bookingController = require("../controllers/bookings.js");

// Index route: My Bookings
router.get("/", isLoggedIn, wrapAsync(bookingController.index));

// Availability check endpoint
router.route("/availability")
    .get(wrapAsync(bookingController.checkAvailability))
    .post(wrapAsync(bookingController.checkAvailability));

// Payment / checkout page
router.get("/:id/payment", isLoggedIn, wrapAsync(bookingController.showPaymentPage));

// Create Razorpay payment order
router.post("/:id/create-payment-order", paymentLimiter, isLoggedIn, wrapAsync(bookingController.createPaymentOrder));

// Verify Razorpay payment signature & update booking
router.post("/:id/verify-payment", paymentLimiter, isLoggedIn, wrapAsync(bookingController.verifyPayment));

// Simulate failed payment (local development only)
router.post("/:id/simulate-payment-failure", paymentLimiter, isLoggedIn, wrapAsync(bookingController.simulatePaymentFailure));

// Process refund for a paid booking
router.post("/:id/refund", isLoggedIn, wrapAsync(bookingController.refundPayment));

// Razorpay Webhook Endpoint for asynchronous payment & refund reconciliation
router.post("/webhook", wrapAsync(bookingController.handleRazorpayWebhook));
router.post("/webhook/razorpay", wrapAsync(bookingController.handleRazorpayWebhook));

// Show booking confirmation / details
router.get("/:id", isLoggedIn, wrapAsync(bookingController.showBooking));

// Cancel booking route
router.post("/:id/cancel", isLoggedIn, wrapAsync(bookingController.cancelBooking));

module.exports = router;

