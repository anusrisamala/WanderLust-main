const Booking = require("../models/booking.js");
const { PAYMENT_HOLD_CONFIG } = require("./constants.js");

/**
 * Parses time string (24h format like "14:00" or 12h format like "02:00 PM")
 * into numeric hours and minutes.
 */
function parseTimeComponents(timeStr) {
    if (!timeStr || typeof timeStr !== "string") {
        return { hours: 0, minutes: 0 };
    }
    const cleanStr = timeStr.trim().toUpperCase();
    const isPM = cleanStr.includes("PM");
    const isAM = cleanStr.includes("AM");

    const timeOnly = cleanStr.replace(/AM|PM/g, "").trim();
    const parts = timeOnly.split(":").map(Number);
    let hours = isNaN(parts[0]) ? 0 : parts[0];
    const minutes = isNaN(parts[1]) ? 0 : parts[1];

    if (isPM && hours < 12) {
        hours += 12;
    } else if (isAM && hours === 12) {
        hours = 0;
    }

    return { hours, minutes };
}

/**
 * Combines a Date/string and a time string into a comparable UTC Date object.
 */
function toComparableDateTime(dateInput, timeStr) {
    if (!dateInput) return null;

    let year, month, day;

    if (dateInput instanceof Date) {
        year = dateInput.getUTCFullYear();
        month = dateInput.getUTCMonth();
        day = dateInput.getUTCDate();
    } else if (typeof dateInput === "string") {
        const datePart = dateInput.split("T")[0];
        const parts = datePart.split("-").map(Number);
        if (parts.length !== 3 || parts.some(isNaN)) return null;
        year = parts[0];
        month = parts[1] - 1;
        day = parts[2];
    } else {
        return null;
    }

    const { hours, minutes } = parseTimeComponents(timeStr);
    return new Date(Date.UTC(year, month, day, hours, minutes, 0, 0));
}

/**
 * Determines whether two booking intervals overlap.
 * 
 * An overlap exists when:
 *   requestedCheckIn < existingCheckOut
 *   AND
 *   requestedCheckOut > existingCheckIn
 * 
 * Note: A booking that ends exactly when another starts (touching boundaries)
 * does NOT overlap because < and > are strict inequalities.
 */
function checkIntervalOverlap(requestedIn, requestedOut, existingIn, existingOut) {
    return requestedIn < existingOut && requestedOut > existingIn;
}

/**
 * Reusable backend service for checking listing booking availability.
 * 
 * Accepts flexible argument patterns:
 * 1. checkListingAvailability({ listingId, checkInDate, checkInTime, checkOutDate, checkOutTime, excludeBookingId })
 * 2. checkListingAvailability(listingId, requestedCheckIn, requestedCheckOut, excludeBookingId)
 *    where requestedCheckIn/Out can be:
 *    - { date, time }
 *    - Date instance
 *    - ISO string
 * 3. checkListingAvailability(listingId, inDate, inTime, outDate, outTime, excludeBookingId)
 * 
 * @returns {Promise<{ available: boolean, conflictingBooking?: object }>}
 */
async function checkListingAvailability(arg1, arg2, arg3, arg4, arg5, arg6) {
    let listingId;
    let reqCheckIn;
    let reqCheckOut;
    let excludeBookingId = null;

    // Pattern 1: Single configuration object
    if (typeof arg1 === "object" && arg1 !== null && arg1.listingId) {
        listingId = arg1.listingId;
        excludeBookingId = arg1.excludeBookingId || arg1.bookingId || null;

        if (arg1.requestedCheckIn && arg1.requestedCheckOut) {
            reqCheckIn = arg1.requestedCheckIn instanceof Date
                ? arg1.requestedCheckIn
                : toComparableDateTime(arg1.requestedCheckIn.date, arg1.requestedCheckIn.time);
            reqCheckOut = arg1.requestedCheckOut instanceof Date
                ? arg1.requestedCheckOut
                : toComparableDateTime(arg1.requestedCheckOut.date, arg1.requestedCheckOut.time);
        } else {
            reqCheckIn = toComparableDateTime(arg1.checkInDate, arg1.checkInTime);
            reqCheckOut = toComparableDateTime(arg1.checkOutDate, arg1.checkOutTime);
        }
    }
    // Pattern 3: (listingId, inDate, inTime, outDate, outTime, excludeBookingId)
    else if (arguments.length >= 5) {
        listingId = arg1;
        reqCheckIn = toComparableDateTime(arg2, arg3);
        reqCheckOut = toComparableDateTime(arg4, arg5);
        excludeBookingId = arg6 || null;
    }
    // Pattern 2: (listingId, requestedCheckIn, requestedCheckOut, excludeBookingId)
    else {
        listingId = arg1;
        excludeBookingId = arg4 || null;

        if (arg2 instanceof Date) {
            reqCheckIn = arg2;
        } else if (typeof arg2 === "object" && arg2 !== null && arg2.date) {
            reqCheckIn = toComparableDateTime(arg2.date, arg2.time);
        } else {
            reqCheckIn = toComparableDateTime(arg2, "00:00");
        }

        if (arg3 instanceof Date) {
            reqCheckOut = arg3;
        } else if (typeof arg3 === "object" && arg3 !== null && arg3.date) {
            reqCheckOut = toComparableDateTime(arg3.date, arg3.time);
        } else {
            reqCheckOut = toComparableDateTime(arg3, "00:00");
        }
    }

    let session = (typeof arg1 === "object" && arg1 !== null && arg1.session) ? arg1.session : null;

    if (!listingId || !reqCheckIn || !reqCheckOut || isNaN(reqCheckIn.getTime()) || isNaN(reqCheckOut.getTime())) {
        return {
            available: false,
            error: "Invalid input parameters for availability check",
        };
    }

    // Automatic Payment-Hold Expiry (15-minute checkout window):
    // Abandoned unpaid PENDING bookings older than 15 minutes are automatically released and marked CANCELLED
    const holdMs = PAYMENT_HOLD_CONFIG?.HOLD_MS || (15 * 60 * 1000);
    const holdCutoff = new Date(Date.now() - holdMs);

    // 1. Cancel expired unpaid pending bookings to permanently free the dates in the database
    const expiredCleanupQuery = {
        listing: listingId,
        status: { $in: ["PENDING_PAYMENT", "PENDING"] },
        paymentStatus: { $nin: ["PAID", "REFUND_PENDING"] },
        $or: [
            { createdAt: { $lt: holdCutoff } },
            { createdAt: { $exists: false } },
        ],
    };

    try {
        if (session) {
            await Booking.updateMany(expiredCleanupQuery, { $set: { status: "CANCELLED" } }, { session });
        } else {
            await Booking.updateMany(expiredCleanupQuery, { $set: { status: "CANCELLED" } });
        }
    } catch (cleanupErr) {
        console.warn("[Availability] Automatic expiry cleanup notice:", cleanupErr.message);
    }

    // 2. Query active bookings blocking this listing:
    // CONFIRMED bookings, bookings awaiting host approval, bookings with refund pending,
    // and active pending payment bookings within the 15-minute payment hold window
    const query = {
        listing: listingId,
        $or: [
            { status: "CONFIRMED" },
            { status: "AWAITING_HOST_APPROVAL" },
            { paymentStatus: "REFUND_PENDING" },
            {
                status: { $in: ["PENDING_PAYMENT", "PENDING"] },
                $or: [
                    { paymentStatus: "PAID" },
                    { createdAt: { $gte: holdCutoff } },
                ],
            },
        ],
    };

    // Optionally exclude the current booking (for future booking updates/edits)
    if (excludeBookingId) {
        query._id = { $ne: excludeBookingId };
    }

    const existingBookingsQuery = Booking.find(query);
    if (session) {
        existingBookingsQuery.session(session);
    }
    const existingBookings = await existingBookingsQuery;

    for (const booking of existingBookings) {
        const existingCheckIn = toComparableDateTime(booking.checkInDate || booking.checkIn, booking.checkInTime);
        const existingCheckOut = toComparableDateTime(booking.checkOutDate || booking.checkOut, booking.checkOutTime);

        if (!existingCheckIn || !existingCheckOut) continue;

        // Check for interval overlap
        if (checkIntervalOverlap(reqCheckIn, reqCheckOut, existingCheckIn, existingCheckOut)) {
            return {
                available: false,
                conflictingBooking: {
                    id: booking._id,
                    checkIn: existingCheckIn,
                    checkOut: existingCheckOut,
                    status: booking.status,
                },
            };
        }
    }

    return {
        available: true,
    };
}

/**
 * Synchronizes past confirmed bookings to persisted COMPLETED status in MongoDB.
 * Any booking with status === 'CONFIRMED' whose checkout date/time is in the past
 * is automatically transitioned to status === 'COMPLETED'.
 */
async function syncCompletedBookings(filter = {}) {
    try {
        const now = new Date();
        const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

        // Candidates are confirmed bookings whose checkOutDate is today or earlier
        const candidates = await Booking.find({
            ...filter,
            status: "CONFIRMED",
            checkOutDate: { $lte: todayUTC }
        });

        const completedIds = [];
        for (const b of candidates) {
            const checkOutDT = toComparableDateTime(b.checkOutDate || b.checkOut, b.checkOutTime) || new Date(b.checkOutDate || b.checkOut);
            if (checkOutDT && checkOutDT <= now) {
                completedIds.push(b._id);
            }
        }

        if (completedIds.length > 0) {
            await Booking.updateMany(
                { _id: { $in: completedIds } },
                { $set: { status: "COMPLETED" } }
            );
        }
    } catch (err) {
        console.warn("[syncCompletedBookings] Notice:", err.message);
    }
}

module.exports = {
    checkListingAvailability,
    toComparableDateTime,
    checkIntervalOverlap,
    parseTimeComponents,
    syncCompletedBookings,
};
