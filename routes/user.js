const express = require("express");
const wrapAsync = require("../utils/wrapAsync");
const router = express.Router();
const User = require("../models/user.js");
const passport = require("passport");
const { savedRedirectUrl, isLoggedIn, isHost } = require("../middleware.js");

const userController = require("../controllers/users.js");

router.route("/signup")
  .get( userController.renderSignupForm )

  .post(
    wrapAsync(userController.signup),
  );

router.route("/login")
  .get( userController.renderLoginForm)
  .post(
  savedRedirectUrl,
  passport.authenticate("local", {
    failureRedirect: "/login",
    failureFlash: true,
  }),
  userController.login
);

router.get("/logout", userController.logout);

router.get("/dashboard", isLoggedIn, wrapAsync(userController.renderDashboard));

router.get("/host/dashboard", isHost, wrapAsync(userController.renderHostDashboard));

router.get("/host/listings", isHost, wrapAsync(userController.renderHostListings));

router.get("/host/bookings", isHost, wrapAsync(userController.renderHostBookings));

router.get("/host/bookings/:id", isHost, wrapAsync(userController.renderHostBookingDetails));

router.post("/host/bookings/:id/confirm", isHost, wrapAsync(userController.confirmHostBooking));

router.post("/host/bookings/:id/cancel", isHost, wrapAsync(userController.cancelHostBooking));

router.get("/profile", isLoggedIn, (req, res) => {
    res.redirect("/dashboard#profile-section");
});

router.get("/profile/edit", isLoggedIn, wrapAsync(userController.renderEditProfileForm));

router.post("/profile", isLoggedIn, wrapAsync(userController.updateProfile));

router.get("/wishlist", isLoggedIn, wrapAsync(userController.renderWishlist));

router.route("/become-host")
    .get(isLoggedIn, wrapAsync(userController.renderBecomeHostForm))
    .post(isLoggedIn, wrapAsync(userController.becomeHost));

module.exports = router;


