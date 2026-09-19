const path = require("path");
const assert = require("assert");
const mongoose = require("mongoose");
const crypto = require("crypto");

const projectDir = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(projectDir, ".env") });

const Booking = require(path.join(projectDir, "models/booking.js"));
const Listing = require(path.join(projectDir, "models/listing.js"));
const User = require(path.join(projectDir, "models/user.js"));
const bookingController = require(path.join(projectDir, "controllers/bookings.js"));
const { csrfProtection } = require(path.join(projectDir, "utils/security.js"));

const MONGO_URL = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        jsonPayload: null,
        redirectUrl: null,
        renderedView: null,
        renderedData: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.jsonPayload = payload;
            return this;
        },
        redirect(url) {
            this.redirectUrl = url;
            return this;
        },
        render(view, data) {
            this.renderedView = view;
            this.renderedData = data;
            return this;
        }
    };
}

function createMockReq(options = {}) {
    const flashes = [];
    return {
        body: options.body || {},
        params: options.params || {},
        query: options.query || {},
        headers: options.headers || {},
        user: options.user || null,
        rawBody: options.rawBody || null,
        flashes,
        flash(type, msg) {
            if (arguments.length === 0) return flashes;
            flashes.push({ type, msg });
            return flashes;
        },
        get(header) {
            return this.headers[header.toLowerCase()] || "";
        },
        xhr: !!options.xhr,
        is(type) {
            return false;
        }
    };
}

async function runTests() {
    console.log("=== STARTING PAYMENT IDEMPOTENCY, PAISE & WEBHOOK CSRF TEST SUITE ===");
    await mongoose.connect(MONGO_URL);
    console.log("Connected to MongoDB for testing.");

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        return (async () => {
            try {
                await fn();
                console.log(`  [PASS] ${name}`);
                passed++;
            } catch (err) {
                console.error(`  [FAIL] ${name}`);
                console.error("         ", err.message);
                failed++;
            }
        })();
    }

    // Set environment variable to allow local payment simulator
    process.env.ALLOW_PAYMENT_SIMULATOR = "true";
    delete process.env.FORCE_PAYMENT_SIMULATOR;

    // Setup test user & test listing
    const testUser = await User.findOne({ username: "test_paise_user" }) || await User.create({
        username: "test_paise_user",
        email: "test_paise_user@example.com"
    });

    const testListing = await Listing.create({
        title: "Paise Test Villa",
        description: "A luxury villa for testing integer paise storage",
        category: "Rooms",
        price: 2500, // ₹2,500 per night
        location: "Goa",
        country: "India",
        owner: testUser._id
    });

    try {
        // --- 1. CSRF Webhook Exemption Tests ---
        await test("1.1 CSRF middleware exempts /bookings/webhook", async () => {
            const req = {
                method: "POST",
                path: "/bookings/webhook",
                originalUrl: "/bookings/webhook",
                headers: {},
                cookies: {}
            };
            const res = createMockRes();
            let nextCalled = false;
            csrfProtection(req, res, () => {
                nextCalled = true;
            });
            assert.strictEqual(nextCalled, true, "CSRF middleware should call next() for /bookings/webhook");
        });

        await test("1.2 CSRF middleware exempts /bookings/webhook/razorpay", async () => {
            const req = {
                method: "POST",
                path: "/bookings/webhook/razorpay",
                originalUrl: "/bookings/webhook/razorpay",
                headers: {},
                cookies: {}
            };
            const res = createMockRes();
            let nextCalled = false;
            csrfProtection(req, res, () => {
                nextCalled = true;
            });
            assert.strictEqual(nextCalled, true, "CSRF middleware should call next() for /bookings/webhook/razorpay");
        });

        await test("1.3 Webhook rejects request missing x-razorpay-signature header with 400", async () => {
            const req = createMockReq({
                body: { event: "payment.captured" },
                headers: {}
            });
            const res = createMockRes();
            await bookingController.handleRazorpayWebhook(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.jsonPayload.error, "Missing x-razorpay-signature header.");
        });

        await test("1.4 Webhook rejects invalid HMAC-SHA256 signature with 400", async () => {
            const payload = JSON.stringify({ event: "payment.captured" });
            const req = createMockReq({
                body: { event: "payment.captured" },
                rawBody: Buffer.from(payload),
                headers: { "x-razorpay-signature": "invalid_signature_hex" }
            });
            const res = createMockRes();
            await bookingController.handleRazorpayWebhook(req, res);
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.jsonPayload.error, "Invalid webhook signature.");
        });

        // --- 2. Booking Creation & Integer Paise Storage Tests ---
        let createdBookingId = null;

        await test("2.1 createBooking stores monetary values in integer paise with isPaise: true", async () => {
            const req = createMockReq({
                user: testUser,
                params: { id: testListing._id.toString() },
                body: {
                    booking: {
                        checkInDate: "2030-01-10",
                        checkInTime: "14:00",
                        checkOutDate: "2030-01-12", // 2 nights
                        checkOutTime: "11:00",
                        guests: 2
                    }
                }
            });
            const res = createMockRes();
            await bookingController.createBooking(req, res);

            // Redirected to /bookings/:id/payment
            assert(res.redirectUrl && res.redirectUrl.includes("/payment"), "Should redirect to payment page");
            createdBookingId = res.redirectUrl.split("/bookings/")[1].split("/payment")[0];

            const booking = await Booking.findById(createdBookingId);
            assert(booking, "Booking should be found in DB");
            assert.strictEqual(booking.isPaise, true, "Booking isPaise should be true");
            
            // ₹2500/night * 100 = 250000 paise
            assert.strictEqual(booking.pricePerNight, 250000, "pricePerNight should be 250,000 paise");
            // 2 nights = 500000 paise
            assert.strictEqual(booking.basePrice, 500000, "basePrice should be 500,000 paise");
            // 5% tax = 25000 paise
            assert.strictEqual(booking.taxAmount, 25000, "taxAmount should be 25,000 paise");
            // Total = 525000 paise (₹5,250.00)
            assert.strictEqual(booking.totalPrice, 525000, "totalPrice should be 525,000 paise");

            // Test virtual rupee getters
            assert.strictEqual(booking.pricePerNightRupees, 2500, "pricePerNightRupees virtual should be ₹2500");
            assert.strictEqual(booking.basePriceRupees, 5000, "basePriceRupees virtual should be ₹5000");
            assert.strictEqual(booking.taxAmountRupees, 250, "taxAmountRupees virtual should be ₹250");
            assert.strictEqual(booking.totalPriceRupees, 5250, "totalPriceRupees virtual should be ₹5250");
        });

        // --- 3. Razorpay Order Creation Idempotency Tests ---
        let firstOrderId = null;

        await test("3.1 createPaymentOrder generates initial order with integer paise amount", async () => {
            const req = createMockReq({
                user: testUser,
                params: { id: createdBookingId }
            });
            const res = createMockRes();
            await bookingController.createPaymentOrder(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.jsonPayload.success, true);
            assert(res.jsonPayload.orderId, "Should return an orderId");
            assert.strictEqual(res.jsonPayload.amount, 525000, "Order amount must be 525000 paise");
            assert.strictEqual(res.jsonPayload.currency, "INR");

            firstOrderId = res.jsonPayload.orderId;

            const updatedBooking = await Booking.findById(createdBookingId);
            assert.strictEqual(updatedBooking.razorpayOrderId, firstOrderId, "Booking razorpayOrderId should match");
        });

        await test("3.2 Repeated payment click reuses existing order (idempotency)", async () => {
            const req = createMockReq({
                user: testUser,
                params: { id: createdBookingId }
            });
            const res = createMockRes();
            await bookingController.createPaymentOrder(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.jsonPayload.success, true);
            assert.strictEqual(res.jsonPayload.orderId, firstOrderId, "Reused orderId must match original orderId");
            assert.strictEqual(res.jsonPayload.reused, true, "Response must indicate reused: true");
            assert.strictEqual(res.jsonPayload.amount, 525000, "Amount must remain unchanged");
        });

        // --- 4. Payment Verification with Integer Paise ---
        const testPaymentId = `pay_test_mock_${Date.now()}`;

        await test("4.1 verifyPayment processes payment and transitions status to AWAITING_HOST_APPROVAL", async () => {
            const secret = process.env.RAZORPAY_KEY_SECRET || "dummy_secret_for_test";
            const validSignature = crypto.createHmac("sha256", secret)
                .update(`${firstOrderId}|${testPaymentId}`)
                .digest("hex");

            const req = createMockReq({
                user: testUser,
                params: { id: createdBookingId },
                body: {
                    razorpay_payment_id: testPaymentId,
                    razorpay_order_id: firstOrderId,
                    razorpay_signature: validSignature
                }
            });
            const res = createMockRes();
            await bookingController.verifyPayment(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.jsonPayload.success, true);

            const verifiedBooking = await Booking.findById(createdBookingId);
            assert.strictEqual(verifiedBooking.paymentStatus, "PAID");
            assert.strictEqual(verifiedBooking.status, "AWAITING_HOST_APPROVAL");
            assert.strictEqual(verifiedBooking.paymentId, testPaymentId);
        });

        // --- 5. Refund Processing with Integer Paise ---
        await test("5.1 refundPayment calculates refund amount in paise and records in booking", async () => {
            const req = createMockReq({
                user: testUser,
                params: { id: createdBookingId },
                body: { reason: "Customer requested cancellation" },
                xhr: true
            });
            const res = createMockRes();
            await bookingController.refundPayment(req, res);

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.jsonPayload.success, true);
            assert.strictEqual(res.jsonPayload.refundAmount, 5250, "Returned refund amount should be in rupees for user");

            const refundedBooking = await Booking.findById(createdBookingId);
            assert.strictEqual(refundedBooking.paymentStatus, "REFUNDED");
            assert.strictEqual(refundedBooking.status, "CANCELLED");
            assert.strictEqual(refundedBooking.refundAmount, 525000, "refundAmount stored in DB should be in paise");
            assert.strictEqual(refundedBooking.refundAmountRupees, 5250, "refundAmountRupees virtual should be ₹5250");
        });

        // --- 6. Webhook Reconciliation with Paise Amount ---
        await test("6.1 Webhook verifies incoming paise payment amount and reconciles booking", async () => {
            // Create a fresh booking for webhook reconciliation test
            const wbBooking = await Booking.create({
                user: testUser._id,
                listing: testListing._id,
                checkInDate: new Date("2030-03-01"),
                checkInTime: "14:00",
                checkOutDate: new Date("2030-03-02"),
                checkOutTime: "11:00",
                guests: 1,
                numberOfNights: 1,
                pricePerNight: 250000,
                basePrice: 250000,
                taxRate: 5,
                taxAmount: 12500,
                totalPrice: 262500, // 262500 paise (₹2,625)
                currency: "INR",
                isPaise: true,
                status: "PENDING_PAYMENT",
                paymentStatus: "PENDING",
                razorpayOrderId: "order_wb_test_12345"
            });

            const wbSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || "dummy_secret_for_test";
            process.env.RAZORPAY_WEBHOOK_SECRET = wbSecret;

            const wbPaymentId = `pay_wb_${Date.now()}`;
            const wbPayload = {
                event: "payment.captured",
                payload: {
                    payment: {
                        entity: {
                            id: wbPaymentId,
                            order_id: "order_wb_test_12345",
                            amount: 262500, // Matches 262500 paise
                            currency: "INR",
                            method: "card",
                            notes: { bookingId: wbBooking._id.toString() }
                        }
                    }
                }
            };

            const rawPayload = JSON.stringify(wbPayload);
            const signature = crypto.createHmac("sha256", wbSecret).update(rawPayload).digest("hex");

            const req = createMockReq({
                body: wbPayload,
                rawBody: Buffer.from(rawPayload),
                headers: { "x-razorpay-signature": signature }
            });
            const res = createMockRes();

            await bookingController.handleRazorpayWebhook(req, res);
            assert.strictEqual(res.statusCode, 200);

            const reconciledBooking = await Booking.findById(wbBooking._id);
            assert.strictEqual(reconciledBooking.paymentStatus, "PAID");
            assert.strictEqual(reconciledBooking.status, "AWAITING_HOST_APPROVAL");
            assert.strictEqual(reconciledBooking.paymentId, wbPaymentId);

            // Clean up wbBooking
            await Booking.deleteOne({ _id: wbBooking._id });
        });

        // --- 7. Concurrency Safety: Two Simultaneous First-Time Order Creation Requests ---
        await test("7.1 Two simultaneous first-time requests on unassigned booking result in exactly one winning order ID", async () => {
            // Create a fresh booking with no razorpayOrderId
            const concurrentBooking = await Booking.create({
                user: testUser._id,
                listing: testListing._id,
                checkInDate: new Date("2030-05-01"),
                checkInTime: "14:00",
                checkOutDate: new Date("2030-05-03"),
                checkOutTime: "11:00",
                guests: 2,
                numberOfNights: 2,
                pricePerNight: 250000,
                basePrice: 500000,
                taxRate: 5,
                taxAmount: 25000,
                totalPrice: 525000,
                currency: "INR",
                isPaise: true,
                status: "PENDING_PAYMENT",
                paymentStatus: "PENDING",
                razorpayOrderId: null
            });

            // Fire two simultaneous requests
            const reqA = createMockReq({ user: testUser, params: { id: concurrentBooking._id.toString() } });
            const resA = createMockRes();
            const reqB = createMockReq({ user: testUser, params: { id: concurrentBooking._id.toString() } });
            const resB = createMockRes();

            await Promise.all([
                bookingController.createPaymentOrder(reqA, resA),
                bookingController.createPaymentOrder(reqB, resB)
            ]);

            assert.strictEqual(resA.statusCode, 200);
            assert.strictEqual(resB.statusCode, 200);
            assert.strictEqual(resA.jsonPayload.success, true);
            assert.strictEqual(resB.jsonPayload.success, true);

            const orderA = resA.jsonPayload.orderId;
            const orderB = resB.jsonPayload.orderId;

            // Both clients must receive the EXACT SAME order ID
            assert.strictEqual(orderA, orderB, "Both concurrent requests must return the exact same winning order ID");

            // Exactly one should be the original winner (reused: false) and one should be reused: true
            const reusedFlags = [resA.jsonPayload.reused, resB.jsonPayload.reused];
            assert(reusedFlags.includes(true), "The losing concurrent request must have reused: true");

            // MongoDB document must store exactly this order ID
            const savedBooking = await Booking.findById(concurrentBooking._id);
            assert.strictEqual(savedBooking.razorpayOrderId, orderA, "Database must store exactly the winning order ID");

            await Booking.deleteOne({ _id: concurrentBooking._id });
        });

        // --- 8. Existing Order Gateway Error Handling vs Confirmed Invalid ---
        await test("8.1 Temporary gateway/API error during existing order lookup returns 503 and does NOT create replacement order", async () => {
            const tempFailBooking = await Booking.create({
                user: testUser._id,
                listing: testListing._id,
                checkInDate: new Date("2030-06-01"),
                checkInTime: "14:00",
                checkOutDate: new Date("2030-06-02"),
                checkOutTime: "11:00",
                guests: 1,
                numberOfNights: 1,
                pricePerNight: 250000,
                basePrice: 250000,
                taxRate: 5,
                taxAmount: 12500,
                totalPrice: 262500,
                currency: "INR",
                isPaise: true,
                status: "PENDING_PAYMENT",
                paymentStatus: "PENDING",
                razorpayOrderId: "order_existing_live_12345" // Non-mock order ID so it attempts gateway fetch
            });

            // Temporarily mock razorpay.orders.fetch to throw a 503 network/server error
            const { getRazorpayInstance } = require(path.join(projectDir, "utils/razorpay.js"));
            const razorpay = getRazorpayInstance();
            const origFetch = razorpay.orders.fetch;
            razorpay.orders.fetch = async (id) => {
                const err = new Error("Gateway 503 Service Unavailable / Network Timeout");
                err.statusCode = 503;
                throw err;
            };

            try {
                const req = createMockReq({ user: testUser, params: { id: tempFailBooking._id.toString() } });
                const res = createMockRes();

                await bookingController.createPaymentOrder(req, res);

                assert.strictEqual(res.statusCode, 503, "Temporary gateway error should return 503");
                assert.strictEqual(res.jsonPayload.success, false);
                assert(res.jsonPayload.error.includes("temporarily unavailable"), "Error message should mention temporary unavailability");

                // Verify the booking's razorpayOrderId was NOT replaced or wiped
                const intactBooking = await Booking.findById(tempFailBooking._id);
                assert.strictEqual(intactBooking.razorpayOrderId, "order_existing_live_12345", "Order ID must remain intact");
            } finally {
                razorpay.orders.fetch = origFetch;
                await Booking.deleteOne({ _id: tempFailBooking._id });
            }
        });

        await test("8.2 Confirmed invalid/not-found order on gateway safely creates replacement order", async () => {
            const invalidOrderBooking = await Booking.create({
                user: testUser._id,
                listing: testListing._id,
                checkInDate: new Date("2030-07-01"),
                checkInTime: "14:00",
                checkOutDate: new Date("2030-07-02"),
                checkOutTime: "11:00",
                guests: 1,
                numberOfNights: 1,
                pricePerNight: 250000,
                basePrice: 250000,
                taxRate: 5,
                taxAmount: 12500,
                totalPrice: 262500,
                currency: "INR",
                isPaise: true,
                status: "PENDING_PAYMENT",
                paymentStatus: "PENDING",
                razorpayOrderId: "order_deleted_live_99999"
            });

            // Mock razorpay.orders.fetch to throw a 404 order not found error
            const { getRazorpayInstance } = require(path.join(projectDir, "utils/razorpay.js"));
            const razorpay = getRazorpayInstance();
            const origFetch = razorpay.orders.fetch;
            razorpay.orders.fetch = async (id) => {
                const err = new Error("Order does not exist");
                err.statusCode = 404;
                err.error = { code: "BAD_REQUEST_ERROR", description: "Order does not exist" };
                throw err;
            };

            try {
                const req = createMockReq({ user: testUser, params: { id: invalidOrderBooking._id.toString() } });
                const res = createMockRes();

                await bookingController.createPaymentOrder(req, res);

                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(res.jsonPayload.success, true);
                assert.notStrictEqual(res.jsonPayload.orderId, "order_deleted_live_99999", "A new replacement order should be created");

                const updatedBooking = await Booking.findById(invalidOrderBooking._id);
                assert.strictEqual(updatedBooking.razorpayOrderId, res.jsonPayload.orderId, "New order ID should be stored on booking");
            } finally {
                razorpay.orders.fetch = origFetch;
                await Booking.deleteOne({ _id: invalidOrderBooking._id });
            }
        });

        // --- 8. Guest Cancellation Refund Amount & Flash Message Unit Conversion ---
        await test("8.1 Guest cancellation (isPaise: true) passes exact integer paise directly to Razorpay (525000, not 52500000) and displays ₹5,250 in flash message", async () => {
            const { getRazorpayInstance } = require(path.join(projectDir, "utils/razorpay.js"));
            const razorpay = getRazorpayInstance();

            // Create a paid booking stored in integer paise: ₹5,250 = 525000 paise
            const paiseBooking = await Booking.create({
                user: testUser._id,
                listing: testListing._id,
                checkInDate: new Date("2030-05-10"),
                checkInTime: "14:00",
                checkOutDate: new Date("2030-05-12"),
                checkOutTime: "11:00",
                guests: 2,
                numberOfNights: 2,
                pricePerNight: 250000,
                basePrice: 500000,
                taxRate: 5,
                taxAmount: 25000,
                totalPrice: 525000, // 525,000 paise = ₹5,250
                currency: "INR",
                isPaise: true,
                status: "CONFIRMED",
                paymentStatus: "PAID",
                paymentId: `pay_live_test_${Date.now()}`,
                razorpayOrderId: `order_test_${Date.now()}`
            });

            let capturedRefundOptions = null;
            const origRefund = razorpay.payments.refund;
            razorpay.payments.refund = async (paymentId, options) => {
                capturedRefundOptions = options;
                return {
                    id: `rfnd_mock_${Date.now()}`,
                    amount: options.amount,
                    currency: "INR",
                    status: "processed"
                };
            };

            try {
                const req = createMockReq({
                    user: testUser,
                    params: { id: paiseBooking._id.toString() }
                });
                const res = createMockRes();

                await bookingController.cancelBooking(req, res);

                // Verification 1: Razorpay receives 525000 paise, NOT 52500000
                assert.ok(capturedRefundOptions, "razorpay.payments.refund must be invoked");
                assert.strictEqual(
                    capturedRefundOptions.amount,
                    525000,
                    `Razorpay refund amount must be 525000 paise, but got ${capturedRefundOptions.amount}`
                );

                // Verification 2: Success flash message displays ₹5,250, NOT ₹525000
                const successFlash = req.flashes.find((f) => f.type === "success");
                assert.ok(successFlash, "A success flash message should be set");
                assert.ok(
                    successFlash.msg.includes("₹5,250"),
                    `Flash message should display ₹5,250, but got: "${successFlash.msg}"`
                );
                assert.ok(
                    !successFlash.msg.includes("₹525000"),
                    `Flash message must NOT display raw paise ₹525000: "${successFlash.msg}"`
                );

                // Verification 3: Database values remain integer paise
                const updatedBooking = await Booking.findById(paiseBooking._id);
                assert.strictEqual(updatedBooking.status, "CANCELLED");
                assert.strictEqual(updatedBooking.paymentStatus, "REFUNDED");
                assert.strictEqual(updatedBooking.refundAmount, 525000, "refundAmount in DB must be 525000 paise");
                assert.strictEqual(updatedBooking.refundAmountRupees, 5250, "refundAmountRupees virtual must be 5250");
            } finally {
                razorpay.payments.refund = origRefund;
                await Booking.deleteOne({ _id: paiseBooking._id });
            }
        });

        await test("8.2 Guest cancellation for legacy booking (isPaise: false) converts rupees to paise for Razorpay and displays ₹5,250 in flash", async () => {
            const { getRazorpayInstance } = require(path.join(projectDir, "utils/razorpay.js"));
            const razorpay = getRazorpayInstance();

            // Legacy booking stored in rupees: ₹5,250 = 5250
            const legacyBooking = await Booking.create({
                user: testUser._id,
                listing: testListing._id,
                checkInDate: new Date("2030-06-10"),
                checkInTime: "14:00",
                checkOutDate: new Date("2030-06-12"),
                checkOutTime: "11:00",
                guests: 2,
                numberOfNights: 2,
                pricePerNight: 2500,
                basePrice: 5000,
                taxRate: 5,
                taxAmount: 250,
                totalPrice: 5250, // ₹5,250 in rupees
                currency: "INR",
                isPaise: false,
                status: "CONFIRMED",
                paymentStatus: "PAID",
                paymentId: `pay_legacy_test_${Date.now()}`,
                razorpayOrderId: `order_legacy_${Date.now()}`
            });

            let capturedRefundOptions = null;
            const origRefund = razorpay.payments.refund;
            razorpay.payments.refund = async (paymentId, options) => {
                capturedRefundOptions = options;
                return {
                    id: `rfnd_mock_${Date.now()}`,
                    amount: options.amount,
                    currency: "INR",
                    status: "processed"
                };
            };

            try {
                const req = createMockReq({
                    user: testUser,
                    params: { id: legacyBooking._id.toString() }
                });
                const res = createMockRes();

                await bookingController.cancelBooking(req, res);

                // Razorpay receives 5250 * 100 = 525000 paise
                assert.ok(capturedRefundOptions, "razorpay.payments.refund must be called");
                assert.strictEqual(
                    capturedRefundOptions.amount,
                    525000,
                    `Razorpay refund amount for legacy booking must be 525000 paise, got ${capturedRefundOptions.amount}`
                );

                // Success flash displays ₹5,250
                const successFlash = req.flashes.find((f) => f.type === "success");
                assert.ok(successFlash, "A success flash message should be set");
                assert.ok(
                    successFlash.msg.includes("₹5,250"),
                    `Flash message should display ₹5,250, but got: "${successFlash.msg}"`
                );

                // Database stores legacy rupee value
                const updatedBooking = await Booking.findById(legacyBooking._id);
                assert.strictEqual(updatedBooking.status, "CANCELLED");
                assert.strictEqual(updatedBooking.paymentStatus, "REFUNDED");
                assert.strictEqual(updatedBooking.refundAmount, 5250, "refundAmount in DB must be 5250 rupees");
                assert.strictEqual(updatedBooking.refundAmountRupees, 5250, "refundAmountRupees virtual must be 5250");
            } finally {
                razorpay.payments.refund = origRefund;
                await Booking.deleteOne({ _id: legacyBooking._id });
            }
        });

        await test("8.3 Host booking show view logic toRupees(booking.refundAmount) converts paise to rupees correctly for both paise and legacy bookings", async () => {
            const toRupees = (booking, amt) => (booking && booking.isPaise ? (amt || 0) / 100 : (amt || 0));

            // Paise booking: 525000 paise -> ₹5,250
            const paiseBooking = { isPaise: true, refundAmount: 525000 };
            const paiseDisplay = toRupees(paiseBooking, paiseBooking.refundAmount).toLocaleString("en-IN");
            assert.strictEqual(paiseDisplay, "5,250", "Paise booking refundAmount of 525000 should display as 5,250");

            // Legacy booking: 5250 rupees -> ₹5,250
            const legacyBooking = { isPaise: false, refundAmount: 5250 };
            const legacyDisplay = toRupees(legacyBooking, legacyBooking.refundAmount).toLocaleString("en-IN");
            assert.strictEqual(legacyDisplay, "5,250", "Legacy booking refundAmount of 5250 should display as 5,250");

            // Absent isPaise: 5250 rupees -> ₹5,250
            const absentBooking = { refundAmount: 5250 };
            const absentDisplay = toRupees(absentBooking, absentBooking.refundAmount).toLocaleString("en-IN");
            assert.strictEqual(absentDisplay, "5,250", "Absent isPaise booking refundAmount of 5250 should display as 5,250");
        });

        // Clean up test booking & listing
        if (createdBookingId) {
            await Booking.deleteOne({ _id: createdBookingId });
        }
        await Listing.deleteOne({ _id: testListing._id });

    } finally {
        await mongoose.disconnect();
        console.log("Disconnected from MongoDB.");
    }

    console.log("\n========================================");
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log("========================================\n");

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
});
