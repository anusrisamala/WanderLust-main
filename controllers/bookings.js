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

    // 3. Validate user-provided inputs (dates, times, guests)
    const { checkInDate, checkInTime, checkOutDate, checkOutTime, guests } = req.body.booking || {};

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

    // Get pricePerNight directly from Listing (never trust client)
    const pricePerNight = Number(listing.price) || 0;

    // Calculate basePrice = numberOfNights × pricePerNight
    const basePrice = numberOfNights * pricePerNight;

    // Get the server-side configured GST/tax rate
    const taxRate = TAX_CONFIG.GST_PERCENT;

    // Calculate taxAmount = basePrice × taxRate / 100 (with integer rounding)
    const taxAmount = Math.round((basePrice * taxRate) / 100);

    // Calculate totalPrice = basePrice + taxAmount
    const totalPrice = basePrice + taxAmount;

    // 10. Create and save the Booking with authenticated user
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
        status: "PENDING",
    });

    await newBooking.save();

    req.flash("success", "Booking created successfully!");
    res.redirect(`/bookings/${newBooking._id}`);
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

    // Calculate nights for view
    const MS_PER_DAY = 1000 * 60 * 60 * 24;
    const checkInTimeVal = new Date(booking.checkInDate || booking.checkIn).getTime();
    const checkOutTimeVal = new Date(booking.checkOutDate || booking.checkOut).getTime();
    const nights = booking.numberOfNights || Math.max(1, Math.round((checkOutTimeVal - checkInTimeVal) / MS_PER_DAY));

    res.render("bookings/show.ejs", { booking, nights });
};

module.exports.index = async (req, res) => {
    // Strictly retrieve only the authenticated user's bookings, sorted newest first
    const bookings = await Booking.find({ user: req.user._id })
        .populate("listing")
        .sort({ createdAt: -1 });

    res.render("bookings/index.ejs", { bookings });
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

    // Only allow cancellation when status is PENDING or CONFIRMED
    if (booking.status !== "PENDING" && booking.status !== "CONFIRMED") {
        req.flash("error", `This booking cannot be cancelled because its status is already ${booking.status}.`);
        return res.redirect(`/bookings/${booking._id}`);
    }

    // Update status to CANCELLED (preserve document in database)
    booking.status = "CANCELLED";
    await booking.save();

    req.flash("success", "Booking has been cancelled successfully.");

    const referer = req.get("Referrer");
    if (referer && referer.includes("/bookings")) {
        return res.redirect(referer);
    }
    res.redirect(`/bookings/${booking._id}`);
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

