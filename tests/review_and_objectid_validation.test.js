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
const bookingController = require(path.join(projectDir, "controllers/bookings.js"));
const userController = require(path.join(projectDir, "controllers/users.js"));

const MONGO_URL = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        jsonPayload: null,
        redirectUrl: null,
        flashMessages: [],
        renderedView: null,
        renderData: null,
        locals: {},
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
        }
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
        get(header) {
            return null;
        },
        is(type) {
            return false;
        }
    };
}

async function runTests() {
    console.log("===============================================================");
    console.log("  WANDERLUST RELIABILITY & SECURITY FIXES TEST SUITE");
    console.log("===============================================================\n");

    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(MONGO_URL, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000
        });
        console.log("✓ Connected to MongoDB.\n");
    }

    let passedTests = 0;
    let failedTests = 0;

    function recordPass(name) {
        console.log(`  ✓ PASS: ${name}`);
        passedTests++;
    }

    function recordFail(name, err) {
        console.error(`  ✗ FAIL: ${name}`, err);
        failedTests++;
    }

    let testUser = await User.findOne({ username: "test_fix_user" });
    if (!testUser) {
        testUser = await User.register(
            new User({ username: "test_fix_user", email: "test_fix@example.com", role: "HOST" }),
            "Password123!"
        );
    }

    // ==========================================
    // 1. REVIEW MODEL TIMESTAMP TESTS
    // ==========================================
    console.log("--- [1] Review Model Timestamp Fix Tests ---");

    try {
        // Test 1.1: Schema default function check
        const createdAtDef = Review.schema.path("createdAt").defaultValue;
        assert.strictEqual(
            typeof createdAtDef,
            "function",
            "Review.schema.path('createdAt').defaultValue should be a function reference (Date.now)"
        );
        assert.strictEqual(createdAtDef, Date.now, "defaultValue should be Date.now reference, NOT Date.now()");
        recordPass("Review schema uses function reference 'default: Date.now'");
    } catch (err) {
        recordFail("Review schema uses function reference 'default: Date.now'", err);
    }

    try {
        // Test 1.2: Dynamic timestamp assignment on multiple documents
        const review1 = new Review({ comment: "First review", rating: 5, author: testUser._id });
        await new Promise((r) => setTimeout(r, 60)); // 60ms delay
        const review2 = new Review({ comment: "Second review", rating: 4, author: testUser._id });

        assert(review1.createdAt instanceof Date, "review1.createdAt should be Date");
        assert(review2.createdAt instanceof Date, "review2.createdAt should be Date");
        assert(
            review2.createdAt.getTime() > review1.createdAt.getTime(),
            `review2 (${review2.createdAt.getTime()}) must be strictly later than review1 (${review1.createdAt.getTime()})`
        );
        recordPass("New reviews dynamically receive current timestamp with distinct monotonically increasing times");
    } catch (err) {
        recordFail("New reviews dynamically receive current timestamp with distinct monotonically increasing times", err);
    }

    try {
        // Test 1.3: Existing review creation & population continues to work
        const testListing = new Listing({
            title: "Review Test Villa",
            description: "Testing review timestamps",
            image: { url: "https://example.com/test.jpg", filename: "test.jpg" },
            price: 1500,
            location: "Goa",
            country: "India",
            category: "Trending",
            owner: testUser._id,
        });
        await testListing.save();

        const savedReview = new Review({
            comment: "Wonderful stay!",
            rating: 5,
            author: testUser._id
        });
        await savedReview.save();
        testListing.reviews.push(savedReview);
        await testListing.save();

        const fetched = await Listing.findById(testListing._id).populate({
            path: "reviews",
            populate: { path: "author" }
        });
        assert.strictEqual(fetched.reviews.length, 1);
        assert.strictEqual(fetched.reviews[0].comment, "Wonderful stay!");
        assert(fetched.reviews[0].createdAt instanceof Date);

        // Cleanup
        await Review.findByIdAndDelete(savedReview._id);
        await Listing.findByIdAndDelete(testListing._id);
        recordPass("Review creation, database persistence, and population work properly");
    } catch (err) {
        recordFail("Review creation, database persistence, and population work properly", err);
    }

    // ==========================================
    // 2. MONGO OBJECTID VALIDATION TESTS
    // ==========================================
    console.log("\n--- [2] MongoDB ObjectId Validation Tests ---");

    const invalidId = "invalid-mongo-id-123";

    // 2.1 Middleware isOwner with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        let nextCalled = false;
        await middleware.isOwner(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, "next() should not be called for invalid ID");
        assert.strictEqual(res.redirectUrl, "/listings", "Should redirect to /listings");
        assert(req.flashes.some(f => f.type === "error"), "Should flash an error message");
        recordPass("middleware.isOwner intercepts invalid ObjectId and redirects without CastError");
    } catch (err) {
        recordFail("middleware.isOwner intercepts invalid ObjectId", err);
    }

    // 2.2 Middleware isReviewAuthor with invalid reviewId
    try {
        const req = createMockReq({ id: "validIdButReviewInvalid", reviewId: invalidId }, {}, testUser);
        const res = createMockRes();
        let nextCalled = false;
        await middleware.isReviewAuthor(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, "next() should not be called for invalid reviewId");
        assert(res.redirectUrl !== null, "Should redirect");
        assert(req.flashes.some(f => f.type === "error"), "Should flash an error message");
        recordPass("middleware.isReviewAuthor intercepts invalid reviewId without CastError");
    } catch (err) {
        recordFail("middleware.isReviewAuthor intercepts invalid reviewId", err);
    }

    // 2.3 listingController.showListing with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await listingController.showListing(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("listingController.showListing handles invalid ObjectId gracefully");
    } catch (err) {
        recordFail("listingController.showListing handles invalid ObjectId gracefully", err);
    }

    // 2.4 listingController.renderEditForm with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await listingController.renderEditForm(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("listingController.renderEditForm handles invalid ObjectId gracefully");
    } catch (err) {
        recordFail("listingController.renderEditForm handles invalid ObjectId gracefully", err);
    }

    // 2.5 listingController.updateListing with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, { listing: { title: "Updated" } }, testUser);
        const res = createMockRes();
        await listingController.updateListing(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("listingController.updateListing handles invalid ObjectId gracefully");
    } catch (err) {
        recordFail("listingController.updateListing handles invalid ObjectId gracefully", err);
    }

    // 2.6 listingController.destroyListing with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await listingController.destroyListing(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("listingController.destroyListing handles invalid ObjectId gracefully");
    } catch (err) {
        recordFail("listingController.destroyListing handles invalid ObjectId gracefully", err);
    }

    // 2.7 listingController.toggleWishlist with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await listingController.toggleWishlist(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("listingController.toggleWishlist handles invalid ObjectId gracefully");
    } catch (err) {
        recordFail("listingController.toggleWishlist handles invalid ObjectId gracefully", err);
    }

    // 2.8 reviewController.createReview with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, { review: { comment: "Bad ID", rating: 3 } }, testUser);
        const res = createMockRes();
        await reviewController.createReview(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("reviewController.createReview handles invalid listing ID gracefully");
    } catch (err) {
        recordFail("reviewController.createReview handles invalid listing ID gracefully", err);
    }

    // 2.9 reviewController.destroyReview with invalid reviewId
    try {
        const req = createMockReq({ id: new mongoose.Types.ObjectId().toString(), reviewId: invalidId }, {}, testUser);
        const res = createMockRes();
        await reviewController.destroyReview(req, res);
        assert(res.redirectUrl !== null);
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("reviewController.destroyReview handles invalid review ID gracefully");
    } catch (err) {
        recordFail("reviewController.destroyReview handles invalid review ID gracefully", err);
    }

    // 2.10 bookingController.createBooking with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.createBooking(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("bookingController.createBooking handles invalid listing ID gracefully");
    } catch (err) {
        recordFail("bookingController.createBooking handles invalid listing ID gracefully", err);
    }

    // 2.11 bookingController.checkAvailability with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.checkAvailability(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.jsonPayload.available, false);
        recordPass("bookingController.checkAvailability returns HTTP 400 on invalid listing ID");
    } catch (err) {
        recordFail("bookingController.checkAvailability returns HTTP 400 on invalid listing ID", err);
    }

    // 2.12 bookingController.showBooking with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.showBooking(req, res);
        assert.strictEqual(res.redirectUrl, "/listings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("bookingController.showBooking handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("bookingController.showBooking handles invalid booking ID gracefully", err);
    }

    // 2.13 bookingController.showPaymentPage with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.showPaymentPage(req, res);
        assert.strictEqual(res.redirectUrl, "/bookings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("bookingController.showPaymentPage handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("bookingController.showPaymentPage handles invalid booking ID gracefully", err);
    }

    // 2.14 bookingController.createPaymentOrder with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.createPaymentOrder(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.jsonPayload.success, false);
        recordPass("bookingController.createPaymentOrder returns HTTP 400 on invalid booking ID");
    } catch (err) {
        recordFail("bookingController.createPaymentOrder returns HTTP 400 on invalid booking ID", err);
    }

    // 2.15 bookingController.verifyPayment with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.verifyPayment(req, res);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.jsonPayload.success, false);
        recordPass("bookingController.verifyPayment returns HTTP 400 on invalid booking ID");
    } catch (err) {
        recordFail("bookingController.verifyPayment returns HTTP 400 on invalid booking ID", err);
    }

    // 2.16 bookingController.cancelBooking with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await bookingController.cancelBooking(req, res);
        assert.strictEqual(res.redirectUrl, "/bookings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("bookingController.cancelBooking handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("bookingController.cancelBooking handles invalid booking ID gracefully", err);
    }

    // 2.17 userController.renderHostBookingDetails with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await userController.renderHostBookingDetails(req, res);
        assert.strictEqual(res.redirectUrl, "/host/bookings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("userController.renderHostBookingDetails handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("userController.renderHostBookingDetails handles invalid booking ID gracefully", err);
    }

    // 2.18 userController.confirmHostBooking with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await userController.confirmHostBooking(req, res);
        assert.strictEqual(res.redirectUrl, "/host/bookings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("userController.confirmHostBooking handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("userController.confirmHostBooking handles invalid booking ID gracefully", err);
    }

    // 2.19 userController.cancelHostBooking with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await userController.cancelHostBooking(req, res);
        assert.strictEqual(res.redirectUrl, "/host/bookings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("userController.cancelHostBooking handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("userController.cancelHostBooking handles invalid booking ID gracefully", err);
    }

    // 2.20 userController.completeHostBooking with invalid ID
    try {
        const req = createMockReq({ id: invalidId }, {}, testUser);
        const res = createMockRes();
        await userController.completeHostBooking(req, res);
        assert.strictEqual(res.redirectUrl, "/host/bookings");
        assert(req.flashes.some(f => f.type === "error"));
        recordPass("userController.completeHostBooking handles invalid booking ID gracefully");
    } catch (err) {
        recordFail("userController.completeHostBooking handles invalid booking ID gracefully", err);
    }

    console.log("\n===============================================================");
    console.log(`  SUMMARY: ${passedTests} passed, ${failedTests} failed`);
    console.log("===============================================================\n");

    if (failedTests > 0) {
        process.exit(1);
    }
}

runTests()
    .then(() => {
        console.log("All validation and review tests finished successfully.");
        process.exit(0);
    })
    .catch((err) => {
        console.error("Test execution fatal error:", err);
        process.exit(1);
    });
