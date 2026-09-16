const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");
const { isLoggedIn } = require("../middleware.js");
const bookingController = require("../controllers/bookings.js");

// Index route: My Bookings
router.get("/", isLoggedIn, wrapAsync(bookingController.index));

// Availability check endpoint
router.route("/availability")
    .get(wrapAsync(bookingController.checkAvailability))
    .post(wrapAsync(bookingController.checkAvailability));

// Show booking confirmation / details
router.get("/:id", isLoggedIn, wrapAsync(bookingController.showBooking));

// Cancel booking route
router.post("/:id/cancel", isLoggedIn, wrapAsync(bookingController.cancelBooking));

module.exports = router;

