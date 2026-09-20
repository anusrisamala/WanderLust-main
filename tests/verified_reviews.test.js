const path = require("path");
const assert = require("assert");
const mongoose = require("mongoose");

const projectDir = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(projectDir, ".env") });

// Models
const Review = require(path.join(projectDir, "models/review.js"));
const Listing = require(path.join(projectDir, "models/listing.js"));
const User = require(path.join(projectDir, "models/user.js"));
const Booking = require(path.join(projectDir, "models/booking.js"));

// Middleware & Controllers
const middleware = require(path.join(projectDir, "middleware.js"));
const listingController = require(path.join(projectDir, "controllers/listings.js"));
const reviewController = require(path.join(projectDir, "controllers/reviews.js"));

const MONGO_URL = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";

function createMockRes(currUser = null) {
    return {
        statusCode: 200,
        headers: {},
        jsonPayload: null,
        redirectUrl: null,
        flashMessages: [],
        renderedView: null,
        renderData: null,
        locals: { currUser },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.jsonPayload = payload;
            return this;
        },
        send(payload) {
            this.jsonPayload = payload;
            return this;
        },
        redirect(url) {
            this.redirectUrl = url;
            return this;
        },
        render(view, data) {
            this.renderedView = view;
            this.renderData = data;
            return this;
        },
    };
}

function createMockReq(params = {}, body = {}, user = null, query = {}) {
    const flashes = [];
    return {
        params,
        body,
        query,
        user,
        xhr: false,
        headers: { accept: "text/html" },
        flashes,
        flash(type, msg) {
            if (arguments.length === 0) return flashes;
            flashes.push({ type, msg });
            return flashes;
        },
        get() {
            return null;
        },
        is() {
            return false;
        },
    };
}

let passedTests = 0;
let failedTests = 0;

function recordPass(testName) {
    console.log(`  ✓ PASS: ${testName}`);
    passedTests++;
}

function recordFail(testName, error) {
    console.error(`  ✗ FAIL: ${testName}`);
    console.error(`    -> ${error.message}`);
    failedTests++;
}

async function runVerifiedReviewTests() {
    console.log("===============================================================");
    console.log("  WANDERLUST VERIFIED GUEST REVIEWS TEST SUITE");
    console.log("===============================================================");

    await mongoose.connect(MONGO_URL);
    console.log("\n✓ Connected to MongoDB.\n");

    // Create unique test users
    const timestamp = Date.now();
    const hostUser = new User({
        username: `review_host_${timestamp}`,
        email: `review_host_${timestamp}@example.com`,
        role: "HOST",
    });
    await hostUser.save();

    const guestUser = new User({
        username: `review_guest_${timestamp}`,
        email: `review_guest_${timestamp}@example.com`,
        role: "USER",
    });
    await guestUser.save();

    const strangerUser = new User({
        username: `review_stranger_${timestamp}`,
        email: `review_stranger_${timestamp}@example.com`,
        role: "USER",
    });
    await strangerUser.save();

    // Create a test listing
    const testListing = new Listing({
        title: `Verified Stay Villa ${timestamp}`,
        description: "Luxury property for testing verified review controls",
        image: { url: "https://example.com/villa.jpg", filename: "villa.jpg" },
        price: 2500,
        location: "Udaipur",
        country: "India",
        category: "Trending",
        owner: hostUser._id,
        reviews: [],
    });
    await testListing.save();

    const listingId = testListing._id.toString();

    // -------------------------------------------------------------
    // Test 1: Stranger without bookings cannot review (isVerifiedGuest middleware)
    // -------------------------------------------------------------
    try {
        const req = createMockReq({ id: listingId }, { review: { rating: 5, comment: "Fake review" } }, strangerUser);
        const res = createMockRes(strangerUser);
        let nextCalled = false;
        await middleware.isVerifiedGuest(req, res, () => { nextCalled = true; });

        assert.strictEqual(nextCalled, false, "next() should NOT be called for unverified stranger");
        assert.strictEqual(res.redirectUrl, `/listings/${listingId}`);
        assert(req.flashes.some(f => f.type === "error" && f.msg.includes("Only verified guests")));
        recordPass("Stranger without bookings cannot pass isVerifiedGuest middleware");
    } catch (err) {
        recordFail("Stranger without bookings cannot pass isVerifiedGuest middleware", err);
    }

    // -------------------------------------------------------------
    // Test 2: Stranger without bookings cannot review (controller safeguard)
    // -------------------------------------------------------------
    try {
        const req = createMockReq({ id: listingId }, { review: { rating: 5, comment: "Direct bypass attempt" } }, strangerUser);
        const res = createMockRes(strangerUser);
        await reviewController.createReview(req, res);

        assert.strictEqual(res.redirectUrl, `/listings/${listingId}`);
        assert(req.flashes.some(f => f.type === "error" && f.msg.includes("Only verified guests")));

        const reloaded = await Listing.findById(listingId);
        assert.strictEqual(reloaded.reviews.length, 0, "No review should be created in database");
        recordPass("reviewController.createReview rejects stranger without bookings even if middleware bypassed");
    } catch (err) {
        recordFail("reviewController.createReview rejects stranger without bookings even if middleware bypassed", err);
    }

    // -------------------------------------------------------------
    // Test 3: Listing owner cannot review their own listing
    // -------------------------------------------------------------
    try {
        const req = createMockReq({ id: listingId }, { review: { rating: 5, comment: "I love my own house" } }, hostUser);
        const res = createMockRes(hostUser);
        let nextCalled = false;
        await middleware.isVerifiedGuest(req, res, () => { nextCalled = true; });

        assert.strictEqual(nextCalled, false, "Owner should not pass isVerifiedGuest");
        assert.strictEqual(res.redirectUrl, `/listings/${listingId}`);
        assert(req.flashes.some(f => f.type === "error" && f.msg.includes("Hosts cannot review their own listings")));
        recordPass("Host is prevented from reviewing their own listing");
    } catch (err) {
        recordFail("Host is prevented from reviewing their own listing", err);
    }

    // -------------------------------------------------------------
    // Test 4: Guest with upcoming future booking cannot review yet
    // -------------------------------------------------------------
    const futureCheckIn = new Date();
    futureCheckIn.setDate(futureCheckIn.getDate() + 5);
    const futureCheckOut = new Date();
    futureCheckOut.setDate(futureCheckOut.getDate() + 8);

    const upcomingBooking = new Booking({
        user: guestUser._id,
        listing: testListing._id,
        checkInDate: futureCheckIn,
        checkInTime: "14:00",
        checkOutDate: futureCheckOut,
        checkOutTime: "11:00",
        guests: 2,
        numberOfNights: 3,
        pricePerNight: 250000,
        basePrice: 750000,
        taxRate: 5,
        taxAmount: 37500,
        totalPrice: 787500,
        status: "CONFIRMED",
        paymentStatus: "PAID",
        isPaise: true,
    });
    await upcomingBooking.save();

    try {
        const req = createMockReq({ id: listingId }, { review: { rating: 5, comment: "Excited to visit soon" } }, guestUser);
        const res = createMockRes(guestUser);
        let nextCalled = false;
        await middleware.isVerifiedGuest(req, res, () => { nextCalled = true; });

        assert.strictEqual(nextCalled, false, "Upcoming stay guest should not pass isVerifiedGuest yet");
        assert.strictEqual(res.redirectUrl, `/listings/${listingId}`);
        assert(req.flashes.some(f => f.type === "error" && f.msg.includes("stay is completed")));
        recordPass("Guest with upcoming reservation is blocked until stay is completed");
    } catch (err) {
        recordFail("Guest with upcoming reservation is blocked until stay is completed", err);
    }

    // -------------------------------------------------------------
    // Test 5: Guest with COMPLETED booking successfully creates verified review
    // -------------------------------------------------------------
    const pastCheckIn = new Date();
    pastCheckIn.setDate(pastCheckIn.getDate() - 5);
    const pastCheckOut = new Date();
    pastCheckOut.setDate(pastCheckOut.getDate() - 2);

    const completedBooking1 = new Booking({
        user: guestUser._id,
        listing: testListing._id,
        checkInDate: pastCheckIn,
        checkInTime: "14:00",
        checkOutDate: pastCheckOut,
        checkOutTime: "11:00",
        guests: 2,
        numberOfNights: 3,
        pricePerNight: 250000,
        basePrice: 750000,
        taxRate: 5,
        taxAmount: 37500,
        totalPrice: 787500,
        status: "COMPLETED",
        paymentStatus: "PAID",
        isPaise: true,
    });
    await completedBooking1.save();

    let createdReviewId = null;
    try {
        const req = createMockReq(
            { id: listingId },
            { _csrf: "mock_valid_csrf_token", review: { rating: 5, comment: "Absolute dream vacation, host was lovely!" } },
            guestUser
        );
        const res = createMockRes(guestUser);

        let validateCalled = false;
        middleware.validateReview(req, res, () => { validateCalled = true; });
        assert.strictEqual(validateCalled, true, "validateReview should succeed when _csrf is present in req.body");

        let nextCalled = false;
        await middleware.isVerifiedGuest(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true, "isVerifiedGuest should call next() for guest with completed booking");
        assert(req.eligibleBooking, "req.eligibleBooking should be set");
        assert.strictEqual(req.eligibleBooking._id.toString(), completedBooking1._id.toString());

        await reviewController.createReview(req, res);
        assert.strictEqual(res.redirectUrl, `/listings/${listingId}#reviews`);
        assert(req.flashes.some(f => f.type === "success" && f.msg.includes("verified review")));

        const updatedListing = await Listing.findById(listingId).populate("reviews");
        assert.strictEqual(updatedListing.reviews.length, 1);
        const savedReview = updatedListing.reviews[0];
        assert.strictEqual(savedReview.rating, 5);
        assert.strictEqual(savedReview.comment, "Absolute dream vacation, host was lovely!");
        assert.strictEqual(savedReview.isVerifiedGuest, true, "Review must be marked isVerifiedGuest: true");
        assert.strictEqual(savedReview.booking.toString(), completedBooking1._id.toString(), "Review must link to the completed booking");
        createdReviewId = savedReview._id.toString();

        recordPass("Guest with COMPLETED booking submits verified review with isVerifiedGuest flag and booking link");
    } catch (err) {
        recordFail("Guest with COMPLETED booking submits verified review with isVerifiedGuest flag and booking link", err);
    }

    // -------------------------------------------------------------
    // Test 6: Duplicate review on same completed stay is strictly blocked
    // -------------------------------------------------------------
    try {
        const req = createMockReq({ id: listingId }, { review: { rating: 4, comment: "Trying to post a second review" } }, guestUser);
        const res = createMockRes(guestUser);

        let nextCalled = false;
        await middleware.isVerifiedGuest(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, "Second review for single completed booking must be blocked");
        assert.strictEqual(res.redirectUrl, `/listings/${listingId}`);
        assert(req.flashes.some(f => f.type === "error" && f.msg.includes("already submitted a review")));

        // Also test controller safety
        const req2 = createMockReq({ id: listingId }, { review: { rating: 4, comment: "Direct controller attempt" } }, guestUser);
        const res2 = createMockRes(guestUser);
        await reviewController.createReview(req2, res2);
        assert.strictEqual(res2.redirectUrl, `/listings/${listingId}`);
        assert(req2.flashes.some(f => f.type === "error" && f.msg.includes("already submitted a review")));

        const listingCheck = await Listing.findById(listingId);
        assert.strictEqual(listingCheck.reviews.length, 1, "Review count should remain 1");
        recordPass("Duplicate review for the same completed stay is strictly blocked");
    } catch (err) {
        recordFail("Duplicate review for the same completed stay is strictly blocked", err);
    }

    // -------------------------------------------------------------
    // Test 7: Second completed booking at same property unlocks a second review
    // -------------------------------------------------------------
    const pastCheckIn2 = new Date();
    pastCheckIn2.setDate(pastCheckIn2.getDate() - 15);
    const pastCheckOut2 = new Date();
    pastCheckOut2.setDate(pastCheckOut2.getDate() - 12);

    const completedBooking2 = new Booking({
        user: guestUser._id,
        listing: testListing._id,
        checkInDate: pastCheckIn2,
        checkInTime: "14:00",
        checkOutDate: pastCheckOut2,
        checkOutTime: "11:00",
        guests: 2,
        numberOfNights: 3,
        pricePerNight: 250000,
        basePrice: 750000,
        taxRate: 5,
        taxAmount: 37500,
        totalPrice: 787500,
        status: "COMPLETED",
        paymentStatus: "PAID",
        isPaise: true,
    });
    await completedBooking2.save();

    try {
        const req = createMockReq({ id: listingId }, { review: { rating: 4, comment: "Second stay was also great!" } }, guestUser);
        const res = createMockRes(guestUser);

        let nextCalled = false;
        await middleware.isVerifiedGuest(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true, "Second completed booking should permit a second review");
        assert.strictEqual(req.eligibleBooking._id.toString(), completedBooking2._id.toString());

        await reviewController.createReview(req, res);
        const updatedListing = await Listing.findById(listingId);
        assert.strictEqual(updatedListing.reviews.length, 2, "Listing now has 2 reviews");
        recordPass("Guest who completes a second stay can submit a second review");
    } catch (err) {
        recordFail("Guest who completes a second stay can submit a second review", err);
    }

    // -------------------------------------------------------------
    // Test 8: showListing computes correct review eligibility flags
    // -------------------------------------------------------------
    try {
        // 8a. Host viewing their listing
        const reqHost = createMockReq({ id: listingId }, {}, hostUser);
        const resHost = createMockRes(hostUser);
        await listingController.showListing(reqHost, resHost);
        assert.strictEqual(resHost.renderData.isListingOwner, true);
        assert.strictEqual(resHost.renderData.canReview, false);

        // 8b. Guest with all completed stays reviewed
        const reqGuest = createMockReq({ id: listingId }, {}, guestUser);
        const resGuest = createMockRes(guestUser);
        await listingController.showListing(reqGuest, resGuest);
        assert.strictEqual(resGuest.renderData.hasReviewed, true);
        assert.strictEqual(resGuest.renderData.canReview, false);

        // 8c. Stranger with no bookings
        const reqStranger = createMockReq({ id: listingId }, {}, strangerUser);
        const resStranger = createMockRes(strangerUser);
        await listingController.showListing(reqStranger, resStranger);
        assert.strictEqual(resStranger.renderData.canReview, false);
        assert.strictEqual(resStranger.renderData.hasReviewed, false);
        assert.strictEqual(resStranger.renderData.hasUpcomingStay, false);

        recordPass("listingController.showListing computes accurate review eligibility state flags");
    } catch (err) {
        recordFail("listingController.showListing computes accurate review eligibility state flags", err);
    }

    // -------------------------------------------------------------
    // Test 9: Deleting a review allows the guest to review that stay again
    // -------------------------------------------------------------
    try {
        const reqDel = createMockReq({ id: listingId, reviewId: createdReviewId }, {}, guestUser);
        const resDel = createMockRes(guestUser);
        await reviewController.destroyReview(reqDel, resDel);

        const listingAfterDel = await Listing.findById(listingId);
        assert.strictEqual(listingAfterDel.reviews.length, 1);

        // Check showListing: canReview should now be true again because completedBookings (2) > reviews (1)
        const reqGuest = createMockReq({ id: listingId }, {}, guestUser);
        const resGuest = createMockRes(guestUser);
        await listingController.showListing(reqGuest, resGuest);
        assert.strictEqual(resGuest.renderData.canReview, true, "canReview should be true after deleting review");

        recordPass("Deleting a review frees up the booking slot allowing re-review");
    } catch (err) {
        recordFail("Deleting a review frees up the booking slot allowing re-review", err);
    }

    // Cleanup test documents
    try {
        await Review.deleteMany({ author: guestUser._id });
        await Booking.deleteMany({ listing: testListing._id });
        await Listing.findByIdAndDelete(testListing._id);
        await User.deleteMany({ _id: { $in: [hostUser._id, guestUser._id, strangerUser._id] } });
    } catch (cleanupErr) {
        console.warn("Notice: Test cleanup encountered:", cleanupErr.message);
    }

    console.log("\n===============================================================");
    console.log(`  SUMMARY: ${passedTests} passed, ${failedTests} failed`);
    console.log("===============================================================");

    await mongoose.disconnect();
    if (failedTests > 0) {
        process.exit(1);
    }
}

runVerifiedReviewTests().catch((err) => {
    console.error("Fatal test execution error:", err);
    process.exit(1);
});
