const User = require("../models/user");
const Listing = require("../models/listing");
const Booking = require("../models/booking");
const mongoose = require("mongoose");

module.exports.renderSignupForm = (req, res) => {
  res.render("users/signup.ejs");
}

module.exports.signup = async (req, res, next) => {
    try {
      let { username, email, password } = req.body;

      // 1. Validate required fields
      if (!username || typeof username !== "string" || !username.trim()) {
        req.flash("error", "Username is required.");
        return res.redirect("/signup");
      }
      if (!email || typeof email !== "string" || !email.trim()) {
        req.flash("error", "Email is required.");
        return res.redirect("/signup");
      }
      if (!password || typeof password !== "string" || !password.trim()) {
        req.flash("error", "Password is required.");
        return res.redirect("/signup");
      }

      // 2. Normalize email and username
      const cleanUsername = username.trim();
      const normalizedEmail = email.trim().toLowerCase();

      // 3. Strict email validation
      // Rejects: 'abc', 'abc@', '@domain.com', 'abc@domain', 'user@.com.my', etc.
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*\.[a-zA-Z]{2,}$/;
      if (!emailRegex.test(normalizedEmail)) {
        req.flash("error", "Please provide a valid email address.");
        return res.redirect("/signup");
      }

      // 4. Pre-check for duplicate email to provide immediate feedback
      const existingUserByEmail = await User.findOne({ email: normalizedEmail });
      if (existingUserByEmail) {
        req.flash("error", "An account with this email address already exists.");
        return res.redirect("/signup");
      }

      const newUser = new User({ email: normalizedEmail, username: cleanUsername, role: "USER" });
      const registeredUser = await User.register(newUser, password);

      req.login(registeredUser,(err)=>{
        if(err){
          return next(err);
        }
        req.flash("success", "welcome to wanderlust");
        res.redirect("/listings");
      });
      
    } catch (e) {
      // 5. Handle duplicate-key race conditions and passport errors gracefully
      if (e.code === 11000) {
        if (e.keyPattern && e.keyPattern.email) {
          req.flash("error", "An account with this email address already exists.");
          return res.redirect("/signup");
        }
        if (e.keyPattern && e.keyPattern.username) {
          req.flash("error", "A user with the given username is already registered.");
          return res.redirect("/signup");
        }
        req.flash("error", "An account with these details already exists.");
        return res.redirect("/signup");
      }
      req.flash("error", e.message);
      res.redirect("/signup");
    }
  }

  module.exports.renderLoginForm = (req, res) => {
  res.render("users/login.ejs");
}

module.exports.login = async (req, res) => {
    req.flash("success", "welcome back to wanderlust");
    let redirectUrl = res.locals.redirectUrl || "/listings"
    res.redirect(redirectUrl);
  }

  module.exports.logout = (req,res,next)=>{
  req.logout((err)=>{
    if(err){
      return next(err);
    }
    req.flash("success","you are logged out");
    res.redirect("/listings");
  })
}

module.exports.renderWishlist = async (req, res) => {
    const user = await User.findById(req.user._id).populate("wishlist");
    const wishlist = (user && user.wishlist ? user.wishlist : []).filter(listing => listing != null);
    res.render("users/wishlist.ejs", { wishlist });
};

const { toComparableDateTime, syncCompletedBookings } = require("../utils/availability.js");

module.exports.renderDashboard = async (req, res) => {
    // Strictly retrieve data using authenticated user ID
    const userId = req.user._id;

    // Automatically synchronize past confirmed stays to persisted COMPLETED status
    await syncCompletedBookings({ user: userId });

    const now = new Date();

    // Parallel database queries for optimal performance
    const [user, userListings, rawBookings] = await Promise.all([
        // Fetch user with populated wishlist items
        User.findById(userId).populate({
            path: "wishlist",
            select: "title location country image price category"
        }),
        // All listings owned by authenticated user (Listing schema ownership field: 'owner')
        Listing.find({ owner: userId })
            .select("title location country price image category")
            .sort({ _id: -1 }),
        // All bookings of the user with populated listing information, sorted newest first
        Booking.find({ user: userId })
            .populate({
                path: "listing",
                select: "title location country image price"
            })
            .sort({ createdAt: -1 })
    ]);

    // Categorize bookings according to exact project definitions:
    // - Upcoming: check-in date/time is in the future and status is not CANCELLED/COMPLETED
    // - Completed: status is COMPLETED
    // - Cancelled: status is CANCELLED
    const allBookings = rawBookings.map(b => {
        const obj = b.toObject();
        const checkInDT = toComparableDateTime(b.checkInDate || b.checkIn, b.checkInTime) || new Date(b.checkInDate || b.checkIn);
        const isFuture = checkInDT > now;

        if (b.status === "CANCELLED") {
            obj.category = "cancelled";
        } else if (b.status === "COMPLETED") {
            obj.category = "completed";
        } else if (isFuture) {
            obj.category = "upcoming";
        } else {
            // Past stay not explicitly marked COMPLETED or CANCELLED
            obj.category = "completed";
        }
        return obj;
    });

    const upcomingBookings = allBookings.filter(b => b.category === "upcoming");
    const completedBookings = allBookings.filter(b => b.category === "completed");
    const cancelledBookings = allBookings.filter(b => b.category === "cancelled");

    // Clean wishlist items
    const wishlist = (user && user.wishlist ? user.wishlist : []).filter(item => item != null);

    // 6 Precise Statistics:
    const counts = {
        totalBookings: allBookings.length,
        upcomingBookings: upcomingBookings.length,
        completedBookings: completedBookings.length,
        cancelledBookings: cancelledBookings.length,
        totalListings: userListings.length,
        wishlistCount: wishlist.length
    };

    res.render("users/dashboard.ejs", {
        user: req.user,
        counts,
        userListings,
        allBookings,
        upcomingBookings,
        completedBookings,
        cancelledBookings,
        wishlist
    });
};

module.exports.renderEditProfileForm = async (req, res) => {
    // Strictly retrieve user from authenticated session
    const user = await User.findById(req.user._id).select("username email");
    if (!user) {
        req.flash("error", "User not found.");
        return res.redirect("/login");
    }
    res.render("users/editProfile.ejs", { user });
};

module.exports.updateProfile = async (req, res, next) => {
    // SECURITY: Always target the authenticated user's ID
    const userId = req.user._id;
    let { username, email } = req.body;

    // 1. Validation: username cannot be empty
    if (!username || typeof username !== "string" || !username.trim()) {
        req.flash("error", "Username cannot be empty.");
        return res.redirect("/profile/edit");
    }

    // 2. Validation: email cannot be empty
    if (!email || typeof email !== "string" || !email.trim()) {
        req.flash("error", "Email cannot be empty.");
        return res.redirect("/profile/edit");
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    // 3. Validation: validate email format
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9]+([.-][a-zA-Z0-9]+)*\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(cleanEmail)) {
        req.flash("error", "Please provide a valid email address.");
        return res.redirect("/profile/edit");
    }

    // 4. Respect existing unique constraints & handle duplicate username/email gracefully
    const duplicateUsername = await User.findOne({
        username: cleanUsername,
        _id: { $ne: userId }
    });
    if (duplicateUsername) {
        req.flash("error", "Username is already taken by another user. Please choose a different one.");
        return res.redirect("/profile/edit");
    }

    const duplicateEmail = await User.findOne({
        email: cleanEmail,
        _id: { $ne: userId }
    });
    if (duplicateEmail) {
        req.flash("error", "Email is already registered by another user. Please choose a different one.");
        return res.redirect("/profile/edit");
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/login");
        }

        // Only allow editing safe profile fields
        user.username = cleanUsername;
        user.email = cleanEmail;
        await user.save();

        // Re-serialize user into Passport session so session remains valid with updated username
        req.login(user, (err) => {
            if (err) {
                return next(err);
            }
            req.flash("success", "Profile updated successfully!");
            res.redirect("/dashboard");
        });
    } catch (err) {
        if (err.code === 11000) {
            if (err.keyPattern && err.keyPattern.username) {
                req.flash("error", "Username is already taken.");
            } else if (err.keyPattern && err.keyPattern.email) {
                req.flash("error", "Email is already registered.");
            } else {
                req.flash("error", "A user with that username or email already exists.");
            }
            return res.redirect("/profile/edit");
        }
        req.flash("error", err.message || "Failed to update profile.");
        res.redirect("/profile/edit");
    }
};

module.exports.renderBecomeHostForm = async (req, res) => {
    if (req.user.role === "HOST") {
        req.flash("error", "You are already registered as a host!");
        return res.redirect("/dashboard");
    }
    if (req.user.role === "ADMIN") {
        req.flash("error", "Admin accounts cannot be converted to host accounts.");
        return res.redirect("/dashboard");
    }
    res.render("users/becomeHost.ejs");
};

module.exports.becomeHost = async (req, res) => {
    if (req.user.role === "HOST") {
        req.flash("error", "You are already registered as a host!");
        return res.redirect("/dashboard");
    }
    if (req.user.role === "ADMIN") {
        req.flash("error", "Admin accounts cannot be converted to host accounts.");
        return res.redirect("/dashboard");
    }
    if (req.user.role !== "USER") {
        req.flash("error", "Invalid user role.");
        return res.redirect("/dashboard");
    }

    // SECURITY: Always target the authenticated user's ID
    const user = await User.findById(req.user._id);
    if (!user) {
        req.flash("error", "User not found.");
        return res.redirect("/login");
    }

    // Explicitly set role = "HOST" on the backend
    user.role = "HOST";
    await user.save();

    // Keep session user in sync
    req.user.role = "HOST";

    req.flash("success", "Congratulations! You are now a host on WanderLust.");
    res.redirect("/host/dashboard");
};

module.exports.renderHostDashboard = async (req, res) => {
    // SECURITY: Always target the authenticated host's ID
    const hostId = req.user._id;
    const now = new Date();

    // 1. Find listings where owner equals req.user._id
    const hostListings = await Listing.find({ owner: hostId })
        .select("title location country price image category")
        .sort({ _id: -1 });

    // 2. Extract listing IDs
    const hostListingIds = hostListings.map(listing => listing._id);

    // Automatically synchronize past confirmed stays to persisted COMPLETED status in MongoDB
    await syncCompletedBookings({ listing: { $in: hostListingIds } });

    // 3. Find bookings where booking.listing belongs to those listing IDs
    const hostBookings = await Booking.find({ listing: { $in: hostListingIds } })
        .populate({
            path: "user",
            select: "username email"
        })
        .populate({
            path: "listing",
            select: "title location country image price"
        })
        .sort({ createdAt: -1 });

    // Calculate Host Overview metrics strictly for host's received bookings
    let upcomingCount = 0;
    let pendingCount = 0;
    let confirmedCount = 0;
    let cancelledCount = 0;
    let completedCount = 0;

    for (const b of hostBookings) {
        if (b.status === "AWAITING_HOST_APPROVAL" || b.status === "PENDING_PAYMENT" || b.status === "PENDING") pendingCount++;
        else if (b.status === "CONFIRMED") confirmedCount++;
        else if (b.status === "CANCELLED") cancelledCount++;
        else if (b.status === "COMPLETED") completedCount++;

        const checkInDT = toComparableDateTime(b.checkInDate, b.checkInTime) || new Date(b.checkInDate);
        if (checkInDT > now && (b.status === "CONFIRMED" || b.status === "AWAITING_HOST_APPROVAL" || b.status === "PENDING_PAYMENT" || b.status === "PENDING")) {
            upcomingCount++;
        }
    }

    const counts = {
        totalListings: hostListings.length,
        totalBookings: hostBookings.length,
        pendingBookings: pendingCount,
        confirmedBookings: confirmedCount,
        upcomingBookings: upcomingCount,
        completedBookings: completedCount,
        cancelledBookings: cancelledCount
    };

    const recentBookings = hostBookings.slice(0, 5);
    const previewListings = hostListings.slice(0, 6);

    res.render("host/dashboard.ejs", {
        user: req.user,
        counts,
        hostListings,
        previewListings,
        hostBookings,
        recentBookings
    });
};

module.exports.renderHostListings = async (req, res) => {
    // SECURITY: Strictly target authenticated host ID
    const hostId = req.user._id;

    // Fetch listings owned by authenticated host (including active/archived state)
    const hostListings = await Listing.find({ owner: hostId })
        .select("title description location country price image category isActive")
        .sort({ _id: -1 });

    res.render("host/listings.ejs", {
        user: req.user,
        hostListings
    });
};

module.exports.renderHostBookings = async (req, res) => {
    // SECURITY: Strictly target authenticated host ID
    const hostId = req.user._id;

    // 1. Find all listings owned by authenticated host using exact schema 'owner' field
    const hostListings = await Listing.find({ owner: hostId }).select("_id");
    const hostListingIds = hostListings.map(l => l._id);

    // Automatically synchronize past confirmed stays to persisted COMPLETED status in MongoDB
    await syncCompletedBookings({ listing: { $in: hostListingIds } });

    // 2. Determine filter status (AWAITING_HOST_APPROVAL, CONFIRMED, PENDING_PAYMENT, CANCELLED, COMPLETED, or ALL)
    const { status } = req.query;
    const validStatuses = ["AWAITING_HOST_APPROVAL", "CONFIRMED", "PENDING_PAYMENT", "CANCELLED", "COMPLETED", "PENDING"];
    const currentStatus = (typeof status === "string" && validStatuses.includes(status.trim().toUpperCase()))
        ? status.trim().toUpperCase()
        : "ALL";

    // 3. Construct query: strictly restrict to host's own listing IDs
    const filterQuery = { listing: { $in: hostListingIds } };
    if (currentStatus === "AWAITING_HOST_APPROVAL") {
        filterQuery.$or = [
            { status: "AWAITING_HOST_APPROVAL" },
            { status: "PENDING", paymentStatus: "PAID" }
        ];
    } else if (currentStatus === "PENDING_PAYMENT") {
        filterQuery.$or = [
            { status: "PENDING_PAYMENT" },
            { status: "PENDING", paymentStatus: { $ne: "PAID" } }
        ];
    } else if (currentStatus === "PENDING") {
        filterQuery.status = { $in: ["AWAITING_HOST_APPROVAL", "PENDING_PAYMENT", "PENDING"] };
    } else if (currentStatus !== "ALL") {
        filterQuery.status = currentStatus;
    }

    // 4. Fetch host-owned bookings, sorted newest first
    // Only retrieve necessary guest info (username, email)
    const hostBookings = await Booking.find(filterQuery)
        .populate({
            path: "listing",
            select: "title image location country price"
        })
        .populate({
            path: "user",
            select: "username email"
        })
        .sort({ createdAt: -1 });

    // 5. Calculate status counts for filter badges across all host's bookings
    const allHostBookings = await Booking.find({ listing: { $in: hostListingIds } }).select("status paymentStatus");
    const statusCounts = {
        ALL: allHostBookings.length,
        AWAITING_HOST_APPROVAL: allHostBookings.filter(b => b.status === "AWAITING_HOST_APPROVAL" || (b.status === "PENDING" && b.paymentStatus === "PAID")).length,
        CONFIRMED: allHostBookings.filter(b => b.status === "CONFIRMED").length,
        PENDING_PAYMENT: allHostBookings.filter(b => b.status === "PENDING_PAYMENT" || (b.status === "PENDING" && b.paymentStatus !== "PAID")).length,
        CANCELLED: allHostBookings.filter(b => b.status === "CANCELLED").length,
        COMPLETED: allHostBookings.filter(b => b.status === "COMPLETED").length,
        PENDING: allHostBookings.filter(b => b.status === "AWAITING_HOST_APPROVAL" || b.status === "PENDING_PAYMENT" || b.status === "PENDING").length,
    };

    res.render("host/bookings.ejs", {
        user: req.user,
        hostBookings,
        currentStatus,
        statusCounts
    });
};

module.exports.renderHostBookingDetails = async (req, res) => {
    const { id } = req.params;

    // 1. Validate booking ID format
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/host/bookings");
    }

    // 2. Fetch booking and populate listing (including owner) and guest user details
    const booking = await Booking.findById(id)
        .populate({
            path: "listing",
            select: "title image location country price owner"
        })
        .populate({
            path: "user",
            select: "username email"
        });

    if (!booking) {
        req.flash("error", "Booking you requested for does not exist!");
        return res.redirect("/host/bookings");
    }

    // 3. STRICT HOST AUTHORIZATION:
    // Verify that the booking belongs to a listing owned by the authenticated host (req.user._id)
    // Do NOT authorize only by checking booking._id
    // Disallow Host A from viewing Host B's booking by manipulating booking ID
    if (!booking.listing || !booking.listing.owner || !booking.listing.owner.equals(req.user._id)) {
        req.flash("error", "You do not have permission to view this booking.");
        return res.redirect("/host/bookings");
    }

    // Automatically sync to COMPLETED if checkout date/time has passed
    if (booking.status === "CONFIRMED") {
        const checkOutDT = toComparableDateTime(booking.checkOutDate, booking.checkOutTime) || new Date(booking.checkOutDate);
        if (checkOutDT && checkOutDT <= new Date()) {
            booking.status = "COMPLETED";
            await booking.save();
        }
    }

    // 4. Calculate nights for display
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const checkInTimeVal = new Date(booking.checkInDate).getTime();
    const checkOutTimeVal = new Date(booking.checkOutDate).getTime();
    const nights = booking.numberOfNights || Math.max(1, Math.round((checkOutTimeVal - checkInTimeVal) / MS_PER_DAY));

    res.render("host/bookingShow.ejs", {
        user: req.user,
        booking,
        nights
    });
};

module.exports.confirmHostBooking = async (req, res) => {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/host/bookings");
    }

    const booking = await Booking.findById(id).populate({
        path: "listing",
        select: "owner title"
    });

    if (!booking) {
        req.flash("error", "Booking you requested for does not exist!");
        return res.redirect("/host/bookings");
    }

    // STRICT CRITICAL AUTHORIZATION:
    // Verify that the booking belongs to a listing owned by the authenticated host (req.user._id)
    if (!booking.listing || !booking.listing.owner || !booking.listing.owner.equals(req.user._id)) {
        req.flash("error", "You do not have permission to manage this booking.");
        return res.redirect("/host/bookings");
    }

    // STRICT VALID STATUS TRANSITIONS:
    // Only PENDING -> CONFIRMED is allowed for confirmation
    if (booking.status === "CONFIRMED") {
        req.flash("error", "This booking is already confirmed.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    if (booking.status === "CANCELLED") {
        req.flash("error", "Cannot confirm a cancelled booking.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    if (booking.status === "COMPLETED") {
        req.flash("error", "Cannot confirm a completed booking.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    if (booking.status !== "AWAITING_HOST_APPROVAL" && booking.status !== "PENDING") {
        req.flash("error", `Cannot confirm booking with status ${booking.status}. Only bookings awaiting host approval can be confirmed.`);
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    // STRICT PAYMENT REQUIREMENT:
    // A booking must be PAID before the host can confirm it. This prevents bypassing the 15-minute payment hold on unpaid reservations.
    if (booking.paymentStatus !== "PAID") {
        req.flash("error", "Cannot confirm an unpaid booking. The guest must complete payment before host confirmation.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    booking.status = "CONFIRMED";
    await booking.save();

    req.flash("success", "Booking has been confirmed successfully!");

    const referer = req.get("Referrer");
    if (referer && referer.includes("/host/bookings") && !referer.includes(booking._id.toString())) {
        return res.redirect(referer);
    }
    res.redirect(`/host/bookings/${booking._id}`);
};

module.exports.cancelHostBooking = async (req, res) => {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/host/bookings");
    }

    const booking = await Booking.findById(id).populate({
        path: "listing",
        select: "owner title"
    });

    if (!booking) {
        req.flash("error", "Booking you requested for does not exist!");
        return res.redirect("/host/bookings");
    }

    // STRICT CRITICAL AUTHORIZATION:
    // Verify that the booking belongs to a listing owned by the authenticated host (req.user._id)
    if (!booking.listing || !booking.listing.owner || !booking.listing.owner.equals(req.user._id)) {
        req.flash("error", "You do not have permission to manage this booking.");
        return res.redirect("/host/bookings");
    }

    // STRICT VALID STATUS TRANSITIONS:
    // For this version, only PENDING -> CANCELLED is allowed for the host.
    if (booking.status === "CANCELLED") {
        req.flash("error", "This booking is already cancelled.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    if (booking.status === "CONFIRMED") {
        req.flash("error", "Confirmed bookings cannot be cancelled directly by the host in this version.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    if (booking.status === "COMPLETED") {
        req.flash("error", "Cannot cancel a completed booking.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    const cancellableByHost = ["AWAITING_HOST_APPROVAL", "PENDING_PAYMENT", "PENDING"];
    if (!cancellableByHost.includes(booking.status)) {
        req.flash("error", `Cannot cancel/decline booking with status ${booking.status}.`);
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    // If refund is already in progress, reject concurrent duplicate request
    if (booking.paymentStatus === "REFUND_PENDING") {
        req.flash("error", "A cancellation/refund is already in progress for this reservation. Please wait.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    // CASE 1: UNPAID BOOKING (no payment captured, safe to immediately mark CANCELLED)
    if (booking.paymentStatus !== "PAID") {
        booking.status = "CANCELLED";
        await booking.save();
        req.flash("success", "Booking request has been cancelled.");
        const referer = req.get("Referrer");
        if (referer && referer.includes("/host/bookings") && !referer.includes(booking._id.toString())) {
            return res.redirect(referer);
        }
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    // CASE 2: PAID BOOKING
    // ATOMIC CONCURRENCY CLAIM:
    const claimedBooking = await Booking.findOneAndUpdate(
        { _id: booking._id, paymentStatus: "PAID" },
        { $set: { paymentStatus: "REFUND_PENDING" } },
        { new: true }
    );

    if (!claimedBooking) {
        req.flash("error", "A cancellation/refund is already in progress or has already been completed for this booking.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    let refundProcessed = false;
    let refundError = null;

    if (claimedBooking.paymentId) {
        try {
            const { getRazorpayInstance, isPaymentSimulatorAllowed, isPaymentSimulatorForced } = require("../utils/razorpay.js");
            const razorpay = getRazorpayInstance();
            const refundAmountInPaise = claimedBooking.isPaise ? Math.round(claimedBooking.totalPrice) : Math.round(claimedBooking.totalPrice * 100);

            const allowSimulator = isPaymentSimulatorAllowed();
            let refund;
            const isMockPayment = allowSimulator && claimedBooking.paymentId && claimedBooking.paymentId.startsWith("pay_test_mock_");

            if (isMockPayment) {
                refund = {
                    id: `rfnd_test_${Date.now()}`,
                    amount: refundAmountInPaise,
                    currency: "INR",
                    status: "processed"
                };
            } else {
                if (!allowSimulator && claimedBooking.paymentId && claimedBooking.paymentId.startsWith("pay_test_mock_")) {
                    throw new Error("Mock payment refunds are strictly prohibited without ALLOW_PAYMENT_SIMULATOR=true in local development.");
                }
                try {
                    refund = await razorpay.payments.refund(claimedBooking.paymentId, {
                        amount: refundAmountInPaise,
                        notes: {
                            bookingId: claimedBooking._id.toString(),
                            refundedBy: `host:${req.user?.username || req.user?._id?.toString() || "host"}`,
                            reason: "Automatic refund upon host cancellation",
                        }
                    });
                } catch (apiErr) {
                    if (allowSimulator && (apiErr?.statusCode === 401 || apiErr?.error?.description === "Authentication failed")) {
                        console.warn("[Razorpay] 401 Authentication error during host cancellation refund. Falling back to simulated test refund (LOCAL DEV ONLY with ALLOW_PAYMENT_SIMULATOR=true).");
                        refund = {
                            id: `rfnd_test_${Date.now()}`,
                            amount: refundAmountInPaise,
                            currency: "INR",
                            status: "processed"
                        };
                    } else {
                        throw apiErr;
                    }
                }
            }

            // CRITICAL: Finalize cancellation and free dates ONLY after a confirmed successful refund!
            claimedBooking.status = "CANCELLED";
            claimedBooking.paymentStatus = "REFUNDED";
            claimedBooking.refundId = refund.id;
            claimedBooking.refundedAt = new Date();
            claimedBooking.refundAmount = claimedBooking.totalPrice;
            await claimedBooking.save();
            refundProcessed = true;
        } catch (err) {
            console.error("Auto-refund error upon host cancellation:", err?.error?.description || err?.message || err);
            refundError = err?.error?.description || err?.message || "Gateway processing error";

            // CRITICAL: On refund failure, DO NOT mark CANCELLED! Revert to PAID and keep reservation intact.
            claimedBooking.paymentStatus = "PAID";
            await claimedBooking.save();
        }
    } else {
        claimedBooking.status = "CANCELLED";
        await claimedBooking.save();
        refundProcessed = true;
    }

    if (refundProcessed) {
        const refundAmountRupees = claimedBooking.isPaise ? claimedBooking.totalPrice / 100 : claimedBooking.totalPrice;
        req.flash("success", `Booking request has been cancelled and a full refund of ₹${refundAmountRupees.toLocaleString("en-IN")} was initiated for the guest.`);
    } else {
        req.flash("error", `Could not cancel booking because the automatic refund failed (${refundError}). Dates remain reserved.`);
    }

    const referer = req.get("Referrer");
    if (referer && referer.includes("/host/bookings") && !referer.includes(booking._id.toString())) {
        return res.redirect(referer);
    }
    res.redirect(`/host/bookings/${booking._id}`);
};

module.exports.completeHostBooking = async (req, res) => {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/host/bookings");
    }

    const booking = await Booking.findById(id).populate({
        path: "listing",
        select: "owner title"
    });

    if (!booking) {
        req.flash("error", "Booking you requested for does not exist!");
        return res.redirect("/host/bookings");
    }

    // STRICT CRITICAL AUTHORIZATION:
    // Verify that the booking belongs to a listing owned by the authenticated host (req.user._id)
    if (!booking.listing || !booking.listing.owner || !booking.listing.owner.equals(req.user._id)) {
        req.flash("error", "You do not have permission to manage this booking.");
        return res.redirect("/host/bookings");
    }

    if (booking.status === "COMPLETED") {
        req.flash("error", "This booking is already marked as completed.");
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    if (booking.status !== "CONFIRMED") {
        req.flash("error", `Only confirmed bookings can be marked as completed (current status: ${booking.status}).`);
        return res.redirect(`/host/bookings/${booking._id}`);
    }

    booking.status = "COMPLETED";
    await booking.save();

    req.flash("success", "Booking has been marked as completed successfully!");

    const referer = req.get("Referrer");
    if (referer && referer.includes("/host/bookings") && !referer.includes(booking._id.toString())) {
        return res.redirect(referer);
    }
    res.redirect(`/host/bookings/${booking._id}`);
};