const Booking = require("../models/booking.js");
const Listing = require("../models/listing.js");
const { TAX_CONFIG } = require("../utils/constants.js");
const {
    checkListingAvailability,
    toComparableDateTime,
    parseTimeComponents,
} = require("../utils/availability.js");
const mongoose = require("mongoose");

/**
 * Helper to validate time string format (HH:MM or HH:MM AM/PM)
 */
function isValidTimeFormat(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return false;
    const clean = timeStr.trim().toUpperCase();
    const is12h = clean.includes("AM") || clean.includes("PM");
    const timeOnly = clean.replace(/AM|PM/g, "").trim();
    const parts = timeOnly.split(":");
    if (parts.length !== 2) return false;

    if (!/^\d{1,2}$/.test(parts[0]) || !/^\d{2}$/.test(parts[1])) return false;

    const hours = Number(parts[0]);
    const minutes = Number(parts[1]);

    if (isNaN(hours) || isNaN(minutes) || minutes < 0 || minutes > 59) return false;

    if (is12h) {
        if (hours < 1 || hours > 12) return false;
    } else {
        if (hours < 0 || hours > 23) return false;
    }

    return true;
}

/**
 * Helper to parse and validate calendar date (YYYY-MM-DD or Date/ISO string)
 */
function parseDateParts(dateInput) {
    if (!dateInput) return null;
    let str = "";
    if (dateInput instanceof Date) {
        str = dateInput.toISOString().split("T")[0];
    } else {
        str = String(dateInput).trim().split("T")[0];
    }
    const parts = str.split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const [year, month, day] = parts;
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;

    const testDate = new Date(Date.UTC(year, month - 1, day));
    if (
        testDate.getUTCFullYear() !== year ||
        testDate.getUTCMonth() !== month - 1 ||
        testDate.getUTCDate() !== day
    ) {
        return null;
    }

    return {
        year,
        month,
        day,
        utc: testDate.getTime(),
    };
}

module.exports.createBooking = async (req, res) => {
    // 1. Verify user is logged in
    if (!req.user || !req.user._id) {
        req.flash("error", "You must be logged in to make a reservation.");
        return res.redirect("/login");
    }

    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid listing ID.");
        return res.redirect("/listings");
    }

    // 2. Find the Listing
    const listing = await Listing.findById(id);
    if (!listing) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect("/listings");
    }

    // Reject booking attempts on archived / soft-deleted listings
    if (listing.isActive === false) {
        req.flash("error", "This listing has been archived and is no longer accepting new reservations.");
        return res.redirect("/listings");
    }

    // 3. Validate user-provided inputs (dates, times, guests)
    const bookingPayload = req.body.booking || req.body || {};
    const { checkInDate, checkInTime, checkOutDate, checkOutTime, guests } = bookingPayload;

    if (!checkInDate || !checkInTime || !checkOutDate || !checkOutTime) {
        req.flash("error", "Please provide check-in date/time and check-out date/time.");
        return res.redirect(`/listings/${id}`);
    }

    const inDateParts = parseDateParts(checkInDate);
    const outDateParts = parseDateParts(checkOutDate);

    if (!inDateParts || !outDateParts) {
        req.flash("error", "Invalid date format provided.");
        return res.redirect(`/listings/${id}`);
    }

    if (!isValidTimeFormat(checkInTime) || !isValidTimeFormat(checkOutTime)) {
        req.flash("error", "Both check-in and check-out times must be valid times.");
        return res.redirect(`/listings/${id}`);
    }

    const inUTC = inDateParts.utc;
    const outUTC = outDateParts.utc;

    // Server-side today comparison in UTC
    const now = new Date();
    const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

    // 6. Verify check-in is not in the past
    if (inUTC < todayUTC) {
        req.flash("error", "Check-in date cannot be in the past.");
        return res.redirect(`/listings/${id}`);
    }

    // Check-out date must be on or after check-in date
    if (outUTC < inUTC) {
        req.flash("error", "Check-out date must be on or after check-in date.");
        return res.redirect(`/listings/${id}`);
    }

    // 4. Construct: requestedCheckIn and requestedCheckOut
    const reqCheckIn = toComparableDateTime(checkInDate, checkInTime);
    const reqCheckOut = toComparableDateTime(checkOutDate, checkOutTime);

    // 5. Verify checkout is after check-in
    if (!reqCheckIn || !reqCheckOut || reqCheckOut <= reqCheckIn) {
        if (outUTC === inUTC) {
            req.flash("error", "If check-in and check-out happen on the same date, check-out time must be later than check-in time.");
        } else {
            req.flash("error", "Check-out date and time must be later than check-in date and time.");
        }
        return res.redirect(`/listings/${id}`);
    }

    // Guests validation: at least 1
    const numGuests = parseInt(guests, 10);
    if (isNaN(numGuests) || numGuests < 1) {
        req.flash("error", "Number of guests must be at least 1.");
        return res.redirect(`/listings/${id}`);
    }

    // 7. Call the SAME reusable availability helper created in Task 1
    const availability = await checkListingAvailability({
        listingId: listing._id,
        checkInDate: new Date(inUTC),
        checkInTime: String(checkInTime).trim(),
        checkOutDate: new Date(outUTC),
        checkOutTime: String(checkOutTime).trim(),
    });

    // 8. If unavailable: DO NOT create the booking. Return/redirect with clear message:
    if (!availability.available) {
        req.flash("error", "Sorry, this listing is no longer available for the selected dates.");
        return res.redirect(`/listings/${id}`);
    }

    // 9. If available:
    // Calculate numberOfNights on the SERVER
    const isSameDay = (outUTC === inUTC);
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const numberOfNights = isSameDay ? 1 : Math.round((outUTC - inUTC) / MS_PER_DAY);

    if (numberOfNights < 1) {
        req.flash("error", "Booking must be for at least 1 night.");
        return res.redirect(`/listings/${id}`);
    }

    // Get pricePerNight directly from Listing (never trust client) - store as integer paise
    const pricePerNightRupees = Number(listing.price) || 0;
    const pricePerNight = Math.round(pricePerNightRupees * 100);

    // Calculate basePrice = numberOfNights × pricePerNight (in paise)
    const basePrice = numberOfNights * pricePerNight;

    // Get the server-side configured GST/tax rate
    const taxRate = TAX_CONFIG.GST_PERCENT;

    // Calculate taxAmount = basePrice × taxRate / 100 (in paise, integer rounded)
    const taxAmount = Math.round((basePrice * taxRate) / 100);

    // Calculate totalPrice = basePrice + taxAmount (in paise)
    const totalPrice = basePrice + taxAmount;

    // 10. Atomic reservation strategy:
    // Create new booking instance
    const newBooking = new Booking({
        user: req.user._id,
        listing: listing._id,
        checkInDate: new Date(inUTC),
        checkInTime: String(checkInTime).trim(),
        checkOutDate: new Date(outUTC),
        checkOutTime: String(checkOutTime).trim(),
        guests: numGuests,
        numberOfNights: numberOfNights,
        pricePerNight: pricePerNight,
        basePrice: basePrice,
        taxRate: taxRate,
        taxAmount: taxAmount,
        totalPrice: totalPrice,
        currency: "INR",
        isPaise: true,
        status: "PENDING_PAYMENT",
        paymentStatus: "PENDING",
        paymentId: null,
        paymentMethod: null,
        paidAt: null,
        razorpayOrderId: null,
        refundId: null,
        refundedAt: null,
        refundAmount: null,
    });

    let transactionExecuted = false;

    // Try MongoDB transaction (supported on MongoDB replica sets / Atlas)
    try {
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                // 1. Acquire document-level write lock on the Listing to force serial execution of concurrent booking transactions
                await Listing.findOneAndUpdate(
                    { _id: listing._id },
                    { $inc: { reservationLockVersion: 1 } },
                    { session }
                );

                const availabilityInTx = await checkListingAvailability({
                    listingId: listing._id,
                    checkInDate: new Date(inUTC),
                    checkInTime: String(checkInTime).trim(),
                    checkOutDate: new Date(outUTC),
                    checkOutTime: String(checkOutTime).trim(),
                    session,
                });

                if (!availabilityInTx.available) {
                    throw new Error("DATES_UNAVAILABLE");
                }

                await newBooking.save({ session });
                transactionExecuted = true;
            });
        } finally {
            await session.endSession();
        }
    } catch (txErr) {
        if (txErr.message === "DATES_UNAVAILABLE") {
            req.flash("error", "Sorry, this listing was just reserved for the selected dates. Please choose different dates.");
            return res.redirect(`/listings/${id}`);
        }
        // If MongoDB deployment is a standalone instance that does not support transactions,
        // use an atomic double-checked reservation lock strategy
        if (!txErr.message?.includes("Transaction") && !txErr.message?.includes("replica set")) {
            console.error("Booking transaction error:", txErr);
            req.flash("error", "An error occurred while creating your reservation. Please try again.");
            return res.redirect(`/listings/${id}`);
        }
    }

    // Fallback for standalone MongoDB (when replica set transactions are unavailable)
    if (!transactionExecuted) {
        const preCheck = await checkListingAvailability({
            listingId: listing._id,
            checkInDate: new Date(inUTC),
            checkInTime: String(checkInTime).trim(),
            checkOutDate: new Date(outUTC),
            checkOutTime: String(checkOutTime).trim(),
        });
        if (!preCheck.available) {
            req.flash("error", "Sorry, this listing is no longer available for the selected dates.");
            return res.redirect(`/listings/${id}`);
        }

        await newBooking.save();

        // Post-insert verification: check if a concurrent save created an overlap
        const postCheck = await checkListingAvailability({
            listingId: listing._id,
            checkInDate: new Date(inUTC),
            checkInTime: String(checkInTime).trim(),
            checkOutDate: new Date(outUTC),
            checkOutTime: String(checkOutTime).trim(),
            excludeBookingId: newBooking._id,
        });

        if (!postCheck.available) {
            // Race condition detected! Deterministic tie-breaking so competing requests don't mutually delete:
            // Query competing active bookings for this listing and overlapping dates
            const competing = await Booking.find({
                listing: listing._id,
                status: { $in: ["PENDING_PAYMENT", "PENDING", "AWAITING_HOST_APPROVAL", "CONFIRMED"] },
                _id: { $ne: newBooking._id },
                checkInDate: { $lte: new Date(outUTC) },
                checkOutDate: { $gte: new Date(inUTC) }
            });

            // If an earlier booking exists, this competing request yields and rolls back
            const lostRace = competing.some((b) => b._id.toString() < newBooking._id.toString());
            if (lostRace) {
                await Booking.deleteOne({ _id: newBooking._id });
                req.flash("error", "Sorry, another user just booked these dates at the exact same moment. Please choose different dates.");
                return res.redirect(`/listings/${id}`);
            }
        }
    }

    req.flash("success", "Booking created successfully! Please complete your payment.");
    res.redirect(`/bookings/${newBooking._id}/payment`);
};

module.exports.showPaymentPage = async (req, res) => {
    const { id } = req.params;

    // Check if ID is a valid MongoDB ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/bookings");
    }

    // Find booking from MongoDB and populate listing and user
    const booking = await Booking.findById(id).populate("listing").populate("user");

    if (!booking) {
        req.flash("error", "Booking you requested for does not exist!");
        return res.redirect("/bookings");
    }

    // Strict authorization: Only the logged-in user who owns the booking can access payment page
    const bookingUserId = (booking.user && booking.user._id) ? booking.user._id : booking.user;
    if (!bookingUserId || !bookingUserId.equals(req.user._id)) {
        req.flash("error", "You do not have permission to access payment for this booking.");
        return res.redirect("/bookings");
    }

    // Check payment-hold expiry (15-minute checkout window)
    const { PAYMENT_HOLD_CONFIG } = require("../utils/constants.js");
    const holdMs = PAYMENT_HOLD_CONFIG?.HOLD_MS || (15 * 60 * 1000);
    const bookingCreatedTime = booking.createdAt ? new Date(booking.createdAt).getTime() : (booking._id.getTimestamp ? booking._id.getTimestamp().getTime() : 0);
    const isExpired = (booking.status === "PENDING_PAYMENT" || booking.status === "PENDING") &&
                      booking.paymentStatus !== "PAID" &&
                      bookingCreatedTime &&
                      (Date.now() - bookingCreatedTime > holdMs);

    if (isExpired) {
        booking.status = "CANCELLED";
        await booking.save();
        req.flash("error", "Your 15-minute reservation hold has expired and the dates have been freed. Please select your dates again.");
        return res.redirect(`/listings/${booking.listing?._id || booking.listing}`);
    }

    // Calculate nights for view
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const checkInTimeVal = new Date(booking.checkInDate || booking.checkIn).getTime();
    const checkOutTimeVal = new Date(booking.checkOutDate || booking.checkOut).getTime();
    const nights = booking.numberOfNights || Math.max(1, Math.round((checkOutTimeVal - checkInTimeVal) / MS_PER_DAY));

    const { isPaymentSimulatorForced, isPaymentSimulatorAllowed } = require("../utils/razorpay.js");
    const isSimulator = isPaymentSimulatorForced() || isPaymentSimulatorAllowed();

    res.render("bookings/payment.ejs", {
        booking,
        nights,
        isSimulator,
        razorpayKeyId: isSimulator ? "rzp_test_mock_simulator" : (process.env.RAZORPAY_KEY_ID || "")
    });
};

module.exports.createPaymentOrder = async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, error: "Invalid booking ID." });
    }

    const booking = await Booking.findById(id).populate("listing").populate("user");
    if (!booking) {
        return res.status(404).json({ success: false, error: "Booking not found." });
    }

    // Strict authorization: Only the user who created the booking can pay
    const bookingUserId = (booking.user && booking.user._id) ? booking.user._id : booking.user;
    if (!bookingUserId || !bookingUserId.equals(req.user._id)) {
        return res.status(403).json({ success: false, error: "You are not authorized to create a payment order for this booking." });
    }

    // Disallow payment if booking is cancelled
    if (booking.status === "CANCELLED") {
        return res.status(400).json({ success: false, error: "Cannot create payment order for a cancelled booking." });
    }

    // Disallow payment if booking hold has expired (15-minute checkout window)
    const { PAYMENT_HOLD_CONFIG } = require("../utils/constants.js");
    const holdMs = PAYMENT_HOLD_CONFIG?.HOLD_MS || (15 * 60 * 1000);
    const bookingCreatedTime = booking.createdAt ? new Date(booking.createdAt).getTime() : (booking._id.getTimestamp ? booking._id.getTimestamp().getTime() : 0);
    const isExpired = (booking.status === "PENDING_PAYMENT" || booking.status === "PENDING") &&
                      booking.paymentStatus !== "PAID" &&
                      bookingCreatedTime &&
                      (Date.now() - bookingCreatedTime > holdMs);

    if (isExpired) {
        booking.status = "CANCELLED";
        await booking.save();
        return res.status(400).json({
            success: false,
            error: "This reservation hold has expired (15-minute checkout limit). Please rebook your dates.",
            expired: true
        });
    }

    // Disallow if already paid
    if (booking.paymentStatus === "PAID") {
        return res.status(400).json({ success: false, error: "This booking has already been paid.", alreadyPaid: true });
    }

    // Server-side booking total price validation (never trust client)
    const totalPrice = Number(booking.totalPrice);
    if (isNaN(totalPrice) || totalPrice <= 0) {
        return res.status(400).json({ success: false, error: "Invalid booking total price." });
    }

    try {
        const { getRazorpayInstance, isPaymentSimulatorAllowed, isPaymentSimulatorForced } = require("../utils/razorpay.js");
        const allowSimulator = isPaymentSimulatorAllowed();
        const forceSimulator = isPaymentSimulatorForced();

        // Amount in integer paise: ₹1 = 100 paise
        const amountInPaise = booking.isPaise ? Math.round(totalPrice) : Math.round(totalPrice * 100);
        const currency = (booking.currency || "INR").toUpperCase();

        // 1. Idempotency check: reuse existing unpaid order if valid
        if (booking.razorpayOrderId) {
            const existingOrderId = booking.razorpayOrderId;
            const isMockOrder = existingOrderId.startsWith("order_test_");

            if (forceSimulator || (isMockOrder && allowSimulator)) {
                const orderIdToUse = isMockOrder ? existingOrderId : `order_test_${Date.now()}`;
                if (!isMockOrder) {
                    booking.razorpayOrderId = orderIdToUse;
                    await booking.save();
                }
                return res.status(200).json({
                    success: true,
                    isMockMode: true,
                    orderId: orderIdToUse,
                    amount: amountInPaise,
                    currency: currency,
                    keyId: process.env.RAZORPAY_KEY_ID || "rzp_test_simulated",
                    reused: isMockOrder,
                    booking: {
                        id: booking._id,
                        title: booking.listing ? booking.listing.title : "WanderLust Stay",
                        userEmail: req.user.email || "",
                        userName: req.user.username || "",
                    }
                });
            }

            if (!isMockOrder) {
                let existingOrder = null;
                let isConfirmedInvalid = false;

                try {
                    const razorpay = getRazorpayInstance();
                    existingOrder = await razorpay.orders.fetch(existingOrderId);
                } catch (fetchErr) {
                    const statusCode = fetchErr?.statusCode || fetchErr?.error?.code || fetchErr?.status;
                    const errorDesc = (fetchErr?.error?.description || fetchErr?.message || "").toLowerCase();

                    // Razorpay returns 400 with "BAD_REQUEST_ERROR" or 404 when an order ID does not exist on gateway
                    const isNotFound = statusCode === 404 || statusCode === 400 ||
                        errorDesc.includes("does not exist") ||
                        errorDesc.includes("not found") ||
                        errorDesc.includes("invalid order");

                    if (isNotFound) {
                        console.warn(`[Razorpay] Existing order ${existingOrderId} confirmed invalid/non-existent on gateway (${errorDesc}). Proceeding to create replacement.`);
                        isConfirmedInvalid = true;
                    } else {
                        // Temporary API / network / gateway error (500, 502, 503, 504, timeout, network failure)
                        console.error(`[Razorpay] Temporary gateway error while fetching order ${existingOrderId}:`, fetchErr?.error?.description || fetchErr?.message || fetchErr);
                        return res.status(503).json({
                            success: false,
                            error: "Payment gateway is temporarily unavailable while checking your existing order. Please retry in a few moments."
                        });
                    }
                }

                if (existingOrder) {
                    if (
                        (existingOrder.status === "created" || existingOrder.status === "attempted") &&
                        existingOrder.amount === amountInPaise &&
                        existingOrder.currency === currency
                    ) {
                        return res.status(200).json({
                            success: true,
                            isMockMode: false,
                            orderId: existingOrder.id,
                            amount: existingOrder.amount,
                            currency: existingOrder.currency,
                            keyId: process.env.RAZORPAY_KEY_ID,
                            reused: true,
                            booking: {
                                id: booking._id,
                                title: booking.listing ? booking.listing.title : "WanderLust Stay",
                                userEmail: req.user.email || "",
                                userName: req.user.username || "",
                            }
                        });
                    } else if (existingOrder.status === "paid") {
                        return res.status(400).json({
                            success: false,
                            error: "This order has already been paid.",
                            alreadyPaid: true
                        });
                    } else {
                        // Status is expired or amount/currency mismatch -> confirmed invalid
                        console.warn(`[Razorpay] Existing order ${existingOrderId} confirmed unusable (status: ${existingOrder.status}, amount: ${existingOrder.amount}). Proceeding to create replacement.`);
                        isConfirmedInvalid = true;
                    }
                }

                if (!isConfirmedInvalid) {
                    return res.status(500).json({
                        success: false,
                        error: "Unable to verify existing payment order state. Please try again later."
                    });
                }
            }
        }

        // 2. Create Razorpay order
        const razorpay = getRazorpayInstance();
        const options = {
            amount: amountInPaise,
            currency: currency,
            receipt: `BOOK_${booking._id.toString().slice(-16)}`,
            notes: {
                bookingId: booking._id.toString(),
                listingTitle: booking.listing ? String(booking.listing.title).slice(0, 40) : "Stay",
            }
        };

        let order;
        let isMockMode = false;

        if (forceSimulator) {
            isMockMode = true;
            order = {
                id: `order_test_${Date.now()}`,
                amount: amountInPaise,
                currency: currency
            };
        } else {
            try {
                order = await razorpay.orders.create(options);
            } catch (apiErr) {
                // Check if Razorpay rejected authentication due to placeholder/dummy keys in .env
                const isAuthError = apiErr?.statusCode === 401 || 
                                    apiErr?.error?.description === "Authentication failed" ||
                                    process.env.RAZORPAY_KEY_ID === "rzp_test_WanderLust123";

                // Simulator mode is strictly restricted to local development with explicit ALLOW_PAYMENT_SIMULATOR=true
                if (isAuthError && allowSimulator) {
                    console.warn("[Razorpay] 401 Authentication error with configured credentials. Falling back to Razorpay Test Simulator (LOCAL DEV ONLY with ALLOW_PAYMENT_SIMULATOR=true).");
                    isMockMode = true;
                    order = {
                        id: `order_test_${Date.now()}`,
                        amount: amountInPaise,
                        currency: currency
                    };
                } else {
                    console.error("[Razorpay] Order creation failed via Gateway API:", apiErr?.error?.description || apiErr?.message || apiErr);
                    throw apiErr;
                }
            }
        }

        // 3. ATOMIC CONDITIONAL CLAIM IN MONGODB
        // Prevent concurrent requests from assigning different order IDs to the same booking
        const previousOrderId = booking.razorpayOrderId || null;
        const claimFilter = previousOrderId
            ? { _id: booking._id, razorpayOrderId: previousOrderId }
            : {
                _id: booking._id,
                $or: [
                    { razorpayOrderId: null },
                    { razorpayOrderId: "" },
                    { razorpayOrderId: { $exists: false } }
                ]
            };

        const claimedBooking = await Booking.findOneAndUpdate(
            claimFilter,
            { $set: { razorpayOrderId: order.id } },
            { new: true }
        );

        // 4. Handle losing the race condition
        if (!claimedBooking) {
            console.warn(`[Razorpay Concurrency] Atomic order claim conflict on booking ${booking._id}. Order ${order.id} lost the race.`);

            // Another concurrent request won the race. Fetch the booking again to get the winning order ID.
            const winnerBooking = await Booking.findById(booking._id);
            const winningOrderId = winnerBooking ? winnerBooking.razorpayOrderId : null;

            if (!winningOrderId) {
                return res.status(500).json({
                    success: false,
                    error: "Concurrent payment order conflict occurred. Please retry."
                });
            }

            const isWinningMock = winningOrderId.startsWith("order_test_");

            return res.status(200).json({
                success: true,
                isMockMode: isWinningMock,
                orderId: winningOrderId,
                amount: amountInPaise,
                currency: currency,
                keyId: process.env.RAZORPAY_KEY_ID,
                reused: true,
                booking: {
                    id: booking._id,
                    title: booking.listing ? booking.listing.title : "WanderLust Stay",
                    userEmail: req.user.email || "",
                    userName: req.user.username || "",
                }
            });
        }

        // 5. This request won the atomic claim
        return res.status(200).json({
            success: true,
            isMockMode,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: process.env.RAZORPAY_KEY_ID,
            reused: false,
            booking: {
                id: booking._id,
                title: booking.listing ? booking.listing.title : "WanderLust Stay",
                userEmail: req.user.email || "",
                userName: req.user.username || "",
            }
        });
    } catch (err) {
        console.error("Razorpay order creation error:", err?.error?.description || err?.message || err);
        return res.status(500).json({
            success: false,
            error: "Failed to create payment order: " + (err?.error?.description || err?.message || "Please check payment configuration.")
        });
    }
};

module.exports.verifyPayment = async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, error: "Invalid booking ID." });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
        return res.status(404).json({ success: false, error: "Booking not found." });
    }

    // Strict ownership verification
    const bookingUserId = (booking.user && booking.user._id) ? booking.user._id : booking.user;
    if (!bookingUserId || !bookingUserId.equals(req.user._id)) {
        return res.status(403).json({ success: false, error: "You are not authorized to verify this payment." });
    }

    // 1. Idempotent duplicate check: If already marked PAID, return success safely
    if (booking.paymentStatus === "PAID") {
        return res.status(200).json({
            success: true,
            message: "Payment has already been verified and recorded.",
            bookingId: booking._id,
            alreadyPaid: true
        });
    }

    // 2. If already refunded, reject payment verification
    if (booking.paymentStatus === "REFUNDED") {
        return res.status(400).json({
            success: false,
            error: "Cannot process payment for a refunded booking."
        });
    }

    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        if (booking.status === "CANCELLED") {
            return res.status(400).json({ success: false, error: "Cannot process payment for a cancelled booking." });
        }
        return res.status(400).json({ success: false, error: "Missing required payment verification details." });
    }

    const cleanPaymentId = String(razorpay_payment_id).trim();

    // 3. Prevent Payment ID reuse across different bookings
    const paymentAlreadyUsed = await Booking.findOne({
        paymentId: cleanPaymentId,
        _id: { $ne: booking._id }
    });

    if (paymentAlreadyUsed) {
        booking.paymentStatus = "FAILED";
        await booking.save();
        return res.status(400).json({
            success: false,
            error: "Payment ID has already been utilized for another booking."
        });
    }

    // 4. Verify order ID matches the order created for this specific booking
    if (!booking.razorpayOrderId || booking.razorpayOrderId !== razorpay_order_id) {
        booking.paymentStatus = "FAILED";
        await booking.save();
        return res.status(400).json({
            success: false,
            error: "Order ID mismatch. This payment does not belong to this reservation."
        });
    }

    // 5. Server-side HMAC SHA-256 signature verification
    const crypto = require("crypto");
    const secret = process.env.RAZORPAY_KEY_SECRET;
    if (!secret) {
        return res.status(500).json({ success: false, error: "Server payment configuration missing." });
    }

    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(`${razorpay_order_id}|${cleanPaymentId}`)
        .digest("hex");

    const { isPaymentSimulatorAllowed, isPaymentSimulatorForced } = require("../utils/razorpay.js");
    const allowSimulator = isPaymentSimulatorAllowed();
    const forceSimulator = isPaymentSimulatorForced();
    const isMockOrder = (booking.razorpayOrderId && booking.razorpayOrderId.startsWith("order_test_")) || forceSimulator;

    // In production/staging or when simulator is not explicitly enabled,
    // strictly enforce cryptographic HMAC SHA-256 signature verification.
    // Payment success is recorded ONLY after server-side signature verification.
    const isSignatureValid = (allowSimulator && isMockOrder)
        ? (expectedSignature === razorpay_signature || razorpay_signature === "simulated_test_signature")
        : (expectedSignature === razorpay_signature);

    if (!isSignatureValid) {
        if (booking.status === "CANCELLED") {
            return res.status(400).json({ success: false, error: "Cannot process payment for a cancelled booking." });
        }
        booking.paymentStatus = "FAILED";
        await booking.save();
        const errorMessage = (allowSimulator && isMockOrder && razorpay_signature === "simulated_failed_signature")
            ? "Simulated payment failure: Transaction declined by test simulator. Payment status marked as FAILED."
            : "Payment verification failed. Invalid payment signature.";
        return res.status(400).json({
            success: false,
            error: errorMessage
        });
    }

    // Signature is cryptographically valid: Customer's funds were captured on Razorpay!
    // Check if the booking hold had expired (15-minute checkout window) or was cancelled
    const { PAYMENT_HOLD_CONFIG } = require("../utils/constants.js");
    const holdMs = (PAYMENT_HOLD_CONFIG && PAYMENT_HOLD_CONFIG.HOLD_DURATION_MINUTES)
        ? PAYMENT_HOLD_CONFIG.HOLD_DURATION_MINUTES * 60 * 1000
        : 15 * 60 * 1000;

    const bookingCreatedTime = new Date(booking.createdAt).getTime();
    const isHoldExpired = !isNaN(bookingCreatedTime) &&
                          (Date.now() - bookingCreatedTime > holdMs);

    if (booking.status === "CANCELLED" || isHoldExpired) {
        // Late checkout payment: check if dates are still free to fulfill
        const { checkListingAvailability } = require("../utils/availability.js");
        const availCheck = await checkListingAvailability({
            listingId: booking.listing,
            checkInDate: booking.checkInDate,
            checkInTime: booking.checkInTime,
            checkOutDate: booking.checkOutDate,
            checkOutTime: booking.checkOutTime,
            excludeBookingId: booking._id,
        });

        if (availCheck.available) {
            // Dates are still available: fulfill and transition to AWAITING_HOST_APPROVAL
            booking.paymentStatus = "PAID";
            booking.paymentId = cleanPaymentId;
            booking.paymentMethod = "Razorpay";
            booking.paidAt = new Date();
            booking.status = "AWAITING_HOST_APPROVAL";
            await booking.save();

            req.flash("success", "Payment successful! Your reservation request has been submitted to the host for approval.");
            return res.status(200).json({
                success: true,
                message: "Payment verified successfully! Awaiting host approval.",
                bookingId: booking._id
            });
        } else {
            // Dates are taken by another guest! AUTOMATIC FULL REFUND VIA RAZORPAY
            const { getRazorpayInstance, isPaymentSimulatorAllowed } = require("../utils/razorpay.js");
            const razorpay = getRazorpayInstance();
            const refundAmountPaise = booking.isPaise ? Math.round(booking.totalPrice) : Math.round(Number(booking.totalPrice) * 100);
            const allowSimulator = isPaymentSimulatorAllowed();
            const isMockPayment = allowSimulator && cleanPaymentId.startsWith("pay_test_mock_");

            let refund;
            if (isMockPayment) {
                refund = { id: `rfnd_test_${Date.now()}`, amount: refundAmountPaise, status: "processed" };
            } else {
                try {
                    refund = await razorpay.payments.refund(cleanPaymentId, {
                        amount: refundAmountPaise,
                        notes: {
                            bookingId: booking._id.toString(),
                            reason: "Dates unavailable upon late payment confirmation"
                        }
                    });
                } catch (refundErr) {
                    if (allowSimulator && (refundErr?.statusCode === 401 || refundErr?.error?.description === "Authentication failed")) {
                        refund = { id: `rfnd_test_${Date.now()}`, amount: refundAmountPaise, status: "processed" };
                    } else {
                        console.error("[Late Payment Auto-Refund Error]", refundErr);
                        // Leave booking cancelled, paymentStatus FAILED for manual host/admin reconciliation
                        booking.paymentStatus = "FAILED";
                        await booking.save();
                        return res.status(500).json({
                            success: false,
                            error: "Dates are no longer available and automated refund failed. Please contact support immediately."
                        });
                    }
                }
            }

            booking.paymentStatus = "REFUNDED";
            booking.paymentId = cleanPaymentId;
            booking.refundId = refund.id;
            booking.refundedAt = new Date();
            booking.refundAmount = refundAmountPaise;
            booking.status = "CANCELLED";
            await booking.save();

            const refundAmountRupees = booking.isPaise ? booking.totalPrice / 100 : booking.totalPrice;
            return res.status(400).json({
                success: false,
                error: "Cannot process payment for a cancelled booking whose dates are no longer available. A full refund has been automatically processed to your original payment method.",
                expired: true,
                refunded: true,
                refundId: refund.id,
                refundAmount: refundAmountRupees
            });
        }
    }

    // Normal happy path: hold active, signature verified -> Transition to AWAITING_HOST_APPROVAL
    booking.paymentStatus = "PAID";
    booking.paymentId = cleanPaymentId;
    booking.paymentMethod = "Razorpay";
    booking.paidAt = new Date();
    booking.status = "AWAITING_HOST_APPROVAL";
    await booking.save();

    req.flash("success", "Payment successful! Your reservation request has been submitted to the host for approval.");

    return res.status(200).json({
        success: true,
        message: "Payment verified successfully! Awaiting host approval.",
        bookingId: booking._id
    });
};

module.exports.simulatePaymentFailure = async (req, res) => {
    const { id } = req.params;

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, error: "Invalid booking ID." });
    }

    const { isPaymentSimulatorAllowed, isPaymentSimulatorForced } = require("../utils/razorpay.js");
    const allowSimulator = isPaymentSimulatorAllowed();
    const forceSimulator = isPaymentSimulatorForced();

    if (!allowSimulator && !forceSimulator) {
        return res.status(403).json({
            success: false,
            error: "Payment simulator is strictly disabled in this environment."
        });
    }

    const booking = await Booking.findById(id);
    if (!booking) {
        return res.status(404).json({ success: false, error: "Booking not found." });
    }

    // Authorization: only the guest who created the booking (or admin) can simulate failure
    const bookingUserId = (booking.user && booking.user._id) ? booking.user._id : booking.user;
    if (!bookingUserId || (!bookingUserId.equals(req.user._id) && req.user.role !== "ADMIN")) {
        return res.status(403).json({ success: false, error: "Unauthorized access to this booking." });
    }

    if (booking.status === "CANCELLED") {
        return res.status(400).json({ success: false, error: "Cannot record payment failure for a cancelled booking." });
    }

    if (booking.paymentStatus === "PAID") {
        return res.status(400).json({ success: false, error: "Cannot fail an already paid booking." });
    }

    booking.paymentStatus = "FAILED";
    await booking.save();

    return res.status(200).json({
        success: true,
        paymentStatus: "FAILED",
        message: "Simulated payment failure recorded. Booking payment status transitioned to FAILED."
    });
};

module.exports.refundPayment = async (req, res) => {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(400).json({ success: false, error: "Invalid booking ID." });
        }
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/bookings");
    }

    const { syncCompletedBookings, toComparableDateTime } = require("../utils/availability.js");
    await syncCompletedBookings({ _id: id });

    const booking = await Booking.findById(id).populate("listing").populate("user");
    if (!booking) {
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(404).json({ success: false, error: "Booking not found." });
        }
        req.flash("error", "Booking not found.");
        return res.redirect("/bookings");
    }

    // Check if trip is already completed (status COMPLETED or checkout date in past)
    const now = new Date();
    const checkOutDT = toComparableDateTime(booking.checkOutDate || booking.checkOut, booking.checkOutTime) || new Date(booking.checkOutDate || booking.checkOut);
    const isCompletedStay = booking.status === "COMPLETED" || (checkOutDT && checkOutDT <= now);

    if (isCompletedStay) {
        if (booking.status !== "COMPLETED") {
            booking.status = "COMPLETED";
            await booking.save();
        }
        const errMsg = "This trip has already been completed. Refunds cannot be requested for completed stays.";
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(400).json({ success: false, error: errMsg });
        }
        req.flash("error", errMsg);
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Authorization: only the booking owner OR listing host can refund
    const bookingUserId = (booking.user && booking.user._id) ? booking.user._id : booking.user;
    const isOwner = bookingUserId && bookingUserId.equals(req.user._id);
    const hostId = (booking.listing && booking.listing.owner && booking.listing.owner._id) ? booking.listing.owner._id : (booking.listing ? booking.listing.owner : null);
    const isHost = hostId && hostId.equals(req.user._id);

    if (!isOwner && !isHost) {
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(403).json({ success: false, error: "You are not authorized to refund this booking." });
        }
        req.flash("error", "You do not have permission to refund this booking.");
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Idempotent duplicate check: If already REFUNDED, return safe response
    if (booking.paymentStatus === "REFUNDED") {
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(200).json({
                success: true,
                message: "This payment has already been refunded.",
                refundId: booking.refundId,
                alreadyRefunded: true
            });
        }
        req.flash("error", "This booking payment has already been refunded.");
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Check if a refund is currently in progress
    if (booking.paymentStatus === "REFUND_PENDING") {
        const errMsg = "A refund is already in progress for this reservation. Please wait.";
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(409).json({ success: false, error: errMsg, inProgress: true });
        }
        req.flash("error", errMsg);
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Precondition: Only PAID bookings can be refunded
    if (booking.paymentStatus !== "PAID") {
        const errMsg = `Cannot refund booking with payment status: ${booking.paymentStatus}. Only PAID bookings can be refunded.`;
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(400).json({ success: false, error: errMsg });
        }
        req.flash("error", errMsg);
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Precondition: Must have paymentId
    if (!booking.paymentId) {
        const errMsg = "No verified payment ID found for this booking to process refund.";
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(400).json({ success: false, error: errMsg });
        }
        req.flash("error", errMsg);
        return res.redirect(`/bookings/${booking._id}`);
    }

    // ATOMIC CONCURRENCY CLAIM:
    // Atomically transition paymentStatus: PAID -> REFUND_PENDING.
    // If two requests arrive simultaneously, only one will successfully claim this update!
    const claimedBooking = await Booking.findOneAndUpdate(
        { _id: booking._id, paymentStatus: "PAID" },
        { $set: { paymentStatus: "REFUND_PENDING" } },
        { new: true }
    );

    if (!claimedBooking) {
        const errMsg = "A refund is already in progress or has already been completed for this booking.";
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(409).json({ success: false, error: errMsg });
        }
        req.flash("error", errMsg);
        return res.redirect(`/bookings/${booking._id}`);
    }

    try {
        const { getRazorpayInstance, isPaymentSimulatorAllowed, isPaymentSimulatorForced } = require("../utils/razorpay.js");
        const razorpay = getRazorpayInstance();

        // Server-side amount in paise
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
                        refundedBy: req.user.username || req.user._id.toString(),
                        reason: req.body?.reason || "Cancellation / Guest Refund",
                    }
                });
            } catch (apiErr) {
                if (allowSimulator && (apiErr?.statusCode === 401 || apiErr?.error?.description === "Authentication failed")) {
                    console.warn("[Razorpay] 401 Authentication error during refund. Falling back to simulated test refund (LOCAL DEV ONLY with ALLOW_PAYMENT_SIMULATOR=true).");
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

        // Refund succeeded! Now finalize state: set to REFUNDED and CANCELLED to free up dates
        claimedBooking.paymentStatus = "REFUNDED";
        claimedBooking.status = "CANCELLED";
        claimedBooking.refundId = refund.id;
        claimedBooking.refundedAt = new Date();
        claimedBooking.refundAmount = claimedBooking.totalPrice;
        await claimedBooking.save();

        const refundAmountRupees = claimedBooking.isPaise ? claimedBooking.totalPrice / 100 : claimedBooking.totalPrice;
        req.flash("success", `Refund of ₹${refundAmountRupees.toLocaleString("en-IN")} processed successfully.`);

        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(200).json({
                success: true,
                message: "Refund processed successfully!",
                refundId: refund.id,
                refundAmount: refundAmountRupees,
                bookingId: claimedBooking._id
            });
        }

        const referer = req.get("Referrer");
        if (referer && (referer.includes("/bookings") || referer.includes("/dashboard"))) {
            return res.redirect(referer);
        }
        return res.redirect(`/bookings/${claimedBooking._id}`);
    } catch (err) {
        console.error("Razorpay refund error:", err?.error?.description || err?.description || err?.message || err);

        // ATOMIC CLAIM REVERT:
        // On refund failure, revert paymentStatus back to PAID so reservation and dates remain secured.
        claimedBooking.paymentStatus = "PAID";
        await claimedBooking.save();

        const errMsg = "Failed to process refund through payment gateway. Please try again later.";
        if (req.xhr || req.headers.accept?.includes("json") || req.is("json")) {
            return res.status(500).json({
                success: false,
                error: errMsg
            });
        }
        req.flash("error", errMsg);
        return res.redirect(`/bookings/${claimedBooking._id}`);
    }
};


module.exports.showBooking = async (req, res) => {
    const { id } = req.params;

    // Check if ID is a valid MongoDB ObjectId
    const mongoose = require("mongoose");
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/listings");
    }

    const booking = await Booking.findById(id).populate("listing");

    if (!booking) {
        req.flash("error", "Booking you requested for does not exist!");
        return res.redirect("/listings");
    }

    // Strict authorization: Only the user who created the booking can view it
    if (!booking.user.equals(req.user._id)) {
        req.flash("error", "You do not have permission to view this booking.");
        return res.redirect("/listings");
    }

    // Automatically sync to COMPLETED if checkout date/time has passed
    if (booking.status === "CONFIRMED") {
        const { toComparableDateTime } = require("../utils/availability.js");
        const checkOutDT = toComparableDateTime(booking.checkOutDate || booking.checkOut, booking.checkOutTime) || new Date(booking.checkOutDate || booking.checkOut);
        if (checkOutDT && checkOutDT <= new Date()) {
            booking.status = "COMPLETED";
            await booking.save();
        }
    }

    // Calculate nights for view
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const checkInTimeVal = new Date(booking.checkInDate || booking.checkIn).getTime();
    const checkOutTimeVal = new Date(booking.checkOutDate || booking.checkOut).getTime();
    const nights = booking.numberOfNights || Math.max(1, Math.round((checkOutTimeVal - checkInTimeVal) / MS_PER_DAY));

    res.render("bookings/show.ejs", { booking, nights });
};

module.exports.index = async (req, res) => {
    const { syncCompletedBookings } = require("../utils/availability.js");
    await syncCompletedBookings({ user: req.user._id });

    // Strictly retrieve all authenticated user's bookings, sorted newest first
    const allBookings = await Booking.find({ user: req.user._id })
        .populate("listing")
        .sort({ createdAt: -1 });

    const statusCounts = {
        ALL: allBookings.length,
        CONFIRMED: allBookings.filter(b => b.status === "CONFIRMED").length,
        PENDING: allBookings.filter(b => b.status === "PENDING_PAYMENT" || b.status === "PENDING" || b.status === "AWAITING_HOST_APPROVAL").length,
        COMPLETED: allBookings.filter(b => b.status === "COMPLETED").length,
        REFUNDED: allBookings.filter(b => b.paymentStatus === "REFUNDED").length,
        CANCELLED: allBookings.filter(b => b.status === "CANCELLED").length,
    };

    const currentStatus = (req.query.status || "ALL").toUpperCase();
    let filteredBookings = allBookings;

    if (currentStatus === "CONFIRMED") {
        filteredBookings = allBookings.filter(b => b.status === "CONFIRMED");
    } else if (currentStatus === "PENDING" || currentStatus === "PENDING_PAYMENT") {
        filteredBookings = allBookings.filter(b => b.status === "PENDING_PAYMENT" || b.status === "PENDING" || b.status === "AWAITING_HOST_APPROVAL");
    } else if (currentStatus === "COMPLETED") {
        filteredBookings = allBookings.filter(b => b.status === "COMPLETED");
    } else if (currentStatus === "REFUNDED") {
        filteredBookings = allBookings.filter(b => b.paymentStatus === "REFUNDED");
    } else if (currentStatus === "CANCELLED") {
        filteredBookings = allBookings.filter(b => b.status === "CANCELLED");
    }

    res.render("bookings/index.ejs", {
        bookings: filteredBookings,
        currentStatus,
        statusCounts
    });
};

module.exports.cancelBooking = async (req, res) => {
    const { id } = req.params;

    const mongoose = require("mongoose");
    if (!mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Invalid booking ID.");
        return res.redirect("/bookings");
    }

    const booking = await Booking.findById(id);

    if (!booking) {
        req.flash("error", "Booking you requested to cancel does not exist!");
        return res.redirect("/bookings");
    }

    // Authorization: only the owner of the booking can cancel it
    if (!booking.user.equals(req.user._id)) {
        req.flash("error", "You do not have permission to cancel this booking.");
        return res.redirect("/bookings");
    }

    // Check if trip is already completed (status COMPLETED or checkout date in past)
    const { toComparableDateTime } = require("../utils/availability.js");
    const checkOutDT = toComparableDateTime(booking.checkOutDate || booking.checkOut, booking.checkOutTime) || new Date(booking.checkOutDate || booking.checkOut);
    if (booking.status === "COMPLETED" || (checkOutDT && checkOutDT <= new Date())) {
        if (booking.status !== "COMPLETED") {
            booking.status = "COMPLETED";
            await booking.save();
        }
        req.flash("error", "This trip has already been completed. Completed reservations cannot be cancelled or refunded.");
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Only allow cancellation when status is PENDING_PAYMENT, PENDING, AWAITING_HOST_APPROVAL, or CONFIRMED
    const cancellableStatuses = ["PENDING_PAYMENT", "PENDING", "AWAITING_HOST_APPROVAL", "CONFIRMED"];
    if (!cancellableStatuses.includes(booking.status)) {
        req.flash("error", `This booking cannot be cancelled because its status is already ${booking.status}.`);
        return res.redirect(`/bookings/${booking._id}`);
    }

    // If a refund is already in progress, reject concurrent duplicate request
    if (booking.paymentStatus === "REFUND_PENDING") {
        req.flash("error", "A cancellation/refund is already in progress for this reservation. Please wait.");
        return res.redirect(`/bookings/${booking._id}`);
    }

    // CASE 1: UNPAID RESERVATION (no money captured, safe to immediately mark CANCELLED)
    if (booking.paymentStatus !== "PAID") {
        booking.status = "CANCELLED";
        await booking.save();
        req.flash("success", "Booking has been cancelled successfully.");
        const referer = req.get("Referrer");
        if (referer && (referer.includes("/bookings") || referer.includes("/dashboard"))) {
            return res.redirect(referer);
        }
        return res.redirect(`/bookings/${booking._id}`);
    }

    // CASE 2: PAID RESERVATION
    // ATOMIC CONCURRENCY CLAIM:
    // Transition paymentStatus from PAID -> REFUND_PENDING.
    // Booking status remains CONFIRMED (or current status), preserving dates and blocking other guests until refund succeeds.
    const claimedBooking = await Booking.findOneAndUpdate(
        { _id: booking._id, paymentStatus: "PAID" },
        { $set: { paymentStatus: "REFUND_PENDING" } },
        { new: true }
    );

    if (!claimedBooking) {
        req.flash("error", "A cancellation/refund is already in progress or has already been completed for this booking.");
        return res.redirect(`/bookings/${booking._id}`);
    }

    let refundProcessed = false;
    let refundError = null;

    if (claimedBooking.paymentId) {
        try {
            const { getRazorpayInstance, isPaymentSimulatorAllowed, isPaymentSimulatorForced } = require("../utils/razorpay.js");
            const razorpay = getRazorpayInstance();
            const refundAmountInPaise = claimedBooking.isPaise
                ? Math.round(claimedBooking.totalPrice)
                : Math.round(claimedBooking.totalPrice * 100);

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
                            refundedBy: req.user.username || req.user._id.toString(),
                            reason: "Automatic refund upon booking cancellation",
                        }
                    });
                } catch (apiErr) {
                    if (allowSimulator && (apiErr?.statusCode === 401 || apiErr?.error?.description === "Authentication failed")) {
                        console.warn("[Razorpay] 401 Authentication error during cancellation refund. Falling back to simulated test refund (LOCAL DEV ONLY with ALLOW_PAYMENT_SIMULATOR=true).");
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
            console.error("Auto-refund error upon cancellation:", err?.error?.description || err?.message || err);
            refundError = err?.error?.description || err?.message || "Gateway processing error";

            // CRITICAL: On refund failure, DO NOT mark CANCELLED! DO NOT free dates!
            // Revert paymentStatus from REFUND_PENDING back to PAID, preserving status: CONFIRMED.
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
        req.flash("success", `Booking cancelled and full refund of ₹${refundAmountRupees.toLocaleString("en-IN")} has been processed successfully.`);
    } else {
        req.flash("error", `Booking cancellation could not be completed because automatic refund failed (${refundError}). Your reservation and dates remain secured. Please try again or contact support.`);
    }

    const referer = req.get("Referrer");
    if (referer && (referer.includes("/bookings") || referer.includes("/dashboard"))) {
        return res.redirect(referer);
    }
    res.redirect(`/bookings/${claimedBooking._id}`);
};

/**
 * Availability API Endpoint Handler
 * GET /listings/:id/availability?checkInDate=...&checkInTime=...&checkOutDate=...&checkOutTime=...
 * POST /listings/:id/availability (with JSON body)
 */
module.exports.checkAvailability = async (req, res) => {
    const id = req.params.id || req.params.listingId || req.query.listingId || req.body.listingId;

    // 1. Listing ID format validation
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({
            available: false,
            message: "Invalid listing ID provided.",
            error: "Invalid listing ID provided.",
        });
    }

    // 1. Listing must exist in database
    const listing = await Listing.findById(id);
    if (!listing) {
        return res.status(404).json({
            available: false,
            message: "Listing not found.",
            error: "Listing not found.",
        });
    }

    if (listing.isActive === false) {
        return res.status(400).json({
            available: false,
            message: "This listing has been archived and is not accepting reservations.",
            error: "Listing is archived and unavailable for booking.",
        });
    }

    // Read parameters from query (for GET) or body (for POST)
    const {
        checkInDate,
        checkInTime,
        checkOutDate,
        checkOutTime,
    } = { ...req.query, ...req.body };

    // Required fields check
    if (!checkInDate || !checkInTime || !checkOutDate || !checkOutTime) {
        return res.status(400).json({
            available: false,
            message: "Please provide checkInDate, checkInTime, checkOutDate, and checkOutTime.",
            error: "Please provide checkInDate, checkInTime, checkOutDate, and checkOutTime.",
        });
    }

    // Parse date components
    const inDateParts = parseDateParts(checkInDate);
    const outDateParts = parseDateParts(checkOutDate);

    if (!inDateParts || !outDateParts) {
        return res.status(400).json({
            available: false,
            message: "Invalid date format. Expected YYYY-MM-DD.",
            error: "Invalid date format. Expected YYYY-MM-DD.",
        });
    }

    // 2. Check-in date must not be in the past
    const now = new Date();
    const todayUTC = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

    if (inDateParts.utc < todayUTC) {
        return res.status(400).json({
            available: false,
            message: "Check-in date cannot be in the past.",
            error: "Check-in date cannot be in the past.",
        });
    }

    // 3. Check-out date must be after (or on) check-in date
    if (outDateParts.utc < inDateParts.utc) {
        return res.status(400).json({
            available: false,
            message: "Check-out date cannot be earlier than check-in date.",
            error: "Check-out date cannot be earlier than check-in date.",
        });
    }

    // 5. Both times must be valid
    if (!isValidTimeFormat(checkInTime) || !isValidTimeFormat(checkOutTime)) {
        return res.status(400).json({
            available: false,
            message: "Both check-in and check-out times must be valid times (e.g., '09:00' or '09:00 AM').",
            error: "Both check-in and check-out times must be valid times (e.g., '09:00' or '09:00 AM').",
        });
    }

    // 6. The resulting checkout DateTime must be later than the resulting check-in DateTime
    const reqCheckIn = toComparableDateTime(checkInDate, checkInTime);
    const reqCheckOut = toComparableDateTime(checkOutDate, checkOutTime);

    if (!reqCheckIn || !reqCheckOut || reqCheckOut <= reqCheckIn) {
        // 4. If check-in and check-out are on the same date, checkout time must be later than check-in time
        if (outDateParts.utc === inDateParts.utc) {
            return res.status(400).json({
                available: false,
                message: "If check-in and check-out occur on the same date, check-out time must be later than check-in time.",
                error: "If check-in and check-out occur on the same date, check-out time must be later than check-in time.",
            });
        }
        return res.status(400).json({
            available: false,
            message: "Check-out date and time must be later than check-in date and time.",
            error: "Check-out date and time must be later than check-in date and time.",
        });
    }

    // Call the reusable availability logic
    const result = await checkListingAvailability({
        listingId: listing._id,
        checkInDate: new Date(inDateParts.utc),
        checkInTime: String(checkInTime).trim(),
        checkOutDate: new Date(outDateParts.utc),
        checkOutTime: String(checkOutTime).trim(),
    });

    if (result.available) {
        return res.status(200).json({
            available: true,
            message: "Listing is available for the selected dates.",
        });
    } else {
        return res.status(200).json({
            available: false,
            message: "Listing is not available for the selected dates.",
            reason: "Another reservation overlaps with your selected dates and times. Please choose different dates or times.",
        });
    }
};

/**
 * Razorpay Webhook Reconciliation Endpoint
 * Verifies x-razorpay-signature and reconciles payments and refunds asynchronously
 */
module.exports.handleRazorpayWebhook = async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;

    if (!webhookSecret) {
        console.error("Razorpay webhook error: Secret is not configured.");
        return res.status(500).json({ error: "Webhook secret missing." });
    }

    if (!signature) {
        return res.status(400).json({ error: "Missing x-razorpay-signature header." });
    }

    // Verify HMAC SHA-256 signature against raw payload
    const crypto = require("crypto");
    const rawPayload = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);
    const expectedSignature = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawPayload)
        .digest("hex");

    if (expectedSignature !== signature) {
        console.warn("Razorpay webhook signature mismatch. Rejecting request.");
        return res.status(400).json({ error: "Invalid webhook signature." });
    }

    const event = req.body.event;
    const payload = req.body.payload;

    console.log(`[Razorpay Webhook] Received verified event: ${event}`);

    try {
        if (event === "payment.captured" || event === "order.paid") {
            const paymentEntity = payload?.payment?.entity;
            const orderEntity = payload?.order?.entity;

            const orderId = paymentEntity?.order_id || orderEntity?.id;
            const paymentId = paymentEntity?.id;
            const bookingId = paymentEntity?.notes?.bookingId || orderEntity?.notes?.bookingId;

            let booking = null;
            if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
                booking = await Booking.findById(bookingId);
            } else if (orderId) {
                booking = await Booking.findOne({ razorpayOrderId: orderId });
            }

            if (booking) {
                // If already REFUNDED, ignore safely
                if (booking.paymentStatus === "REFUNDED") {
                    console.warn(`[Razorpay Webhook] Received ${event} for already REFUNDED booking ${booking._id}. Ignoring.`);
                    return res.status(200).json({ status: "ignored_booking_cancelled", bookingId: booking._id });
                }

                // 1. Order ID Verification: incoming orderId must match booking.razorpayOrderId
                if (booking.razorpayOrderId) {
                    if (!orderId || booking.razorpayOrderId !== orderId) {
                        console.warn(`[Razorpay Webhook] Order ID mismatch for booking ${booking._id}: expected ${booking.razorpayOrderId}, received ${orderId}`);
                        return res.status(400).json({ error: "Order ID mismatch in webhook payload." });
                    }
                } else if (orderId) {
                    booking.razorpayOrderId = orderId;
                }

                // 2. Amount Verification: incoming amount (in paise) must match server-calculated totalPrice
                const expectedAmountPaise = booking.isPaise ? Math.round(booking.totalPrice) : Math.round(Number(booking.totalPrice) * 100);
                const incomingAmount = paymentEntity?.amount !== undefined ? paymentEntity.amount : orderEntity?.amount;
                if (incomingAmount !== undefined && Number(incomingAmount) !== expectedAmountPaise) {
                    console.warn(`[Razorpay Webhook] Amount mismatch for booking ${booking._id}: expected ${expectedAmountPaise} paise, received ${incomingAmount} paise`);
                    return res.status(400).json({ error: "Payment amount mismatch in webhook payload." });
                }

                // 3. Currency Verification: incoming currency must match INR
                const incomingCurrency = (paymentEntity?.currency || orderEntity?.currency || "INR").toUpperCase();
                if (incomingCurrency !== "INR") {
                    console.warn(`[Razorpay Webhook] Currency mismatch for booking ${booking._id}: expected INR, received ${incomingCurrency}`);
                    return res.status(400).json({ error: "Payment currency mismatch in webhook payload." });
                }

                // Check if booking was CANCELLED (e.g. 15-minute hold expired while customer was checking out)
                if (booking.status === "CANCELLED") {
                    console.warn(`[Razorpay Webhook] Late payment captured for CANCELLED booking ${booking._id}. Checking date availability...`);
                    const { checkListingAvailability } = require("../utils/availability.js");
                    const avail = await checkListingAvailability({
                        listingId: booking.listing,
                        checkInDate: booking.checkInDate,
                        checkInTime: booking.checkInTime,
                        checkOutDate: booking.checkOutDate,
                        checkOutTime: booking.checkOutTime,
                        excludeBookingId: booking._id,
                    });

                    if (avail.available) {
                        // Dates are still available: fulfill and transition to AWAITING_HOST_APPROVAL
                        booking.status = "AWAITING_HOST_APPROVAL";
                        booking.paymentStatus = "PAID";
                        if (paymentId) booking.paymentId = paymentId;
                        booking.paidAt = new Date();
                        booking.paymentMethod = paymentEntity?.method || "Razorpay";
                        await booking.save();
                        console.log(`[Razorpay Webhook] Booking ${booking._id} dates were free; reconciled to AWAITING_HOST_APPROVAL & PAID.`);
                        return res.status(200).json({ status: "reconciled_fulfilled", bookingId: booking._id });
                    } else {
                        // Dates are taken: AUTOMATIC FULL REFUND VIA RAZORPAY IMMEDIATELY
                        console.warn(`[Razorpay Webhook] Dates for cancelled booking ${booking._id} are unavailable. Initiating automatic refund.`);
                        const { getRazorpayInstance, isPaymentSimulatorAllowed } = require("../utils/razorpay.js");
                        const razorpay = getRazorpayInstance();
                        const allowSimulator = isPaymentSimulatorAllowed();
                        const isMock = allowSimulator && paymentId && paymentId.startsWith("pay_test_mock_");

                        let refund;
                        if (isMock) {
                            refund = { id: `rfnd_test_${Date.now()}`, amount: expectedAmountPaise, status: "processed" };
                        } else {
                            try {
                                refund = await razorpay.payments.refund(paymentId, {
                                    amount: expectedAmountPaise,
                                    notes: {
                                        bookingId: booking._id.toString(),
                                        reason: "Automatic webhook refund: payment captured for cancelled booking with unavailable dates."
                                    }
                                });
                            } catch (refErr) {
                                if (allowSimulator && (refErr?.statusCode === 401 || refErr?.error?.description === "Authentication failed")) {
                                    refund = { id: `rfnd_test_${Date.now()}`, amount: expectedAmountPaise, status: "processed" };
                                } else {
                                    throw refErr;
                                }
                            }
                        }

                        booking.paymentStatus = "REFUNDED";
                        booking.status = "CANCELLED";
                        if (paymentId) booking.paymentId = paymentId;
                        booking.refundId = refund.id;
                        booking.refundedAt = new Date();
                        booking.refundAmount = booking.totalPrice;
                        await booking.save();
                        console.log(`[Razorpay Webhook] Cancelled booking ${booking._id} automatically refunded via gateway (Refund ID: ${refund.id}).`);
                        return res.status(200).json({ status: "auto_refunded_unavailable_dates", bookingId: booking._id, refundId: refund.id });
                    }
                }

                if (booking.paymentStatus !== "PAID") {
                    booking.paymentStatus = "PAID";
                    booking.status = "AWAITING_HOST_APPROVAL";
                    if (paymentId) booking.paymentId = paymentId;
                    booking.paidAt = new Date();
                    booking.paymentMethod = paymentEntity?.method || "Razorpay";
                    await booking.save();
                    console.log(`[Razorpay Webhook] Booking ${booking._id} reconciled to PAID & AWAITING_HOST_APPROVAL.`);
                }
            }
        } else if (event === "payment.failed") {
            const paymentEntity = payload?.payment?.entity;
            const orderId = paymentEntity?.order_id;
            const bookingId = paymentEntity?.notes?.bookingId;

            let booking = null;
            if (bookingId && mongoose.Types.ObjectId.isValid(bookingId)) {
                booking = await Booking.findById(bookingId);
            } else if (orderId) {
                booking = await Booking.findOne({ razorpayOrderId: orderId });
            }

            if (booking) {
                if (booking.status === "CANCELLED" || booking.paymentStatus === "REFUNDED") {
                    console.warn(`[Razorpay Webhook] Received payment.failed for already CANCELLED/REFUNDED booking ${booking._id}. Ignoring.`);
                    return res.status(200).json({ status: "ignored_booking_cancelled", bookingId: booking._id });
                }

                if (booking.razorpayOrderId && orderId && booking.razorpayOrderId !== orderId) {
                    console.warn(`[Razorpay Webhook] Order ID mismatch on payment.failed for booking ${booking._id}`);
                    return res.status(400).json({ error: "Order ID mismatch in webhook payload." });
                }

                if (booking.paymentStatus !== "PAID") {
                    booking.paymentStatus = "FAILED";
                    await booking.save();
                    console.log(`[Razorpay Webhook] Booking ${booking._id} paymentStatus marked FAILED.`);
                }
            }
        } else if (event === "refund.processed") {
            const refundEntity = payload?.refund?.entity;
            const paymentId = refundEntity?.payment_id;
            const refundId = refundEntity?.id;

            if (paymentId) {
                const booking = await Booking.findOne({ paymentId });
                if (booking && booking.paymentStatus !== "REFUNDED") {
                    booking.paymentStatus = "REFUNDED";
                    booking.status = "CANCELLED";
                    booking.refundId = refundId;
                    booking.refundedAt = new Date();
                    booking.refundAmount = refundEntity?.amount != null
                        ? (booking.isPaise ? Math.round(refundEntity.amount) : Math.round(refundEntity.amount / 100))
                        : booking.totalPrice;
                    await booking.save();
                    console.log(`[Razorpay Webhook] Booking ${booking._id} reconciled to REFUNDED & CANCELLED.`);
                }
            }
        }
        return res.status(200).json({ status: "ok" });
    } catch (webhookErr) {
        console.error("Error processing Razorpay webhook event:", webhookErr);
        return res.status(500).json({ error: "Internal webhook processing error." });
    }
};

