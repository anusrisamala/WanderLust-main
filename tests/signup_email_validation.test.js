const path = require("path");
const assert = require("assert");
const mongoose = require("mongoose");

const projectDir = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(projectDir, ".env") });

const User = require(path.join(projectDir, "models/user.js"));
const userController = require(path.join(projectDir, "controllers/users.js"));

const MONGO_URL = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        jsonPayload: null,
        redirectUrl: null,
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
        }
    };
}

function createMockReq(body = {}) {
    const flashes = [];
    return {
        body,
        flashes,
        flash(type, msg) {
            if (arguments.length === 0) return flashes;
            flashes.push({ type, msg });
            return flashes;
        },
        login(user, cb) {
            if (cb) cb(null);
        }
    };
}

async function runTests() {
    console.log("===============================================================");
    console.log("  SIGNUP EMAIL VALIDATION & NORMALIZATION TEST SUITE");
    console.log("===============================================================\n");

    if (mongoose.connection.readyState === 0) {
        await mongoose.connect(MONGO_URL, {
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000
        });
        console.log("✓ Connected to MongoDB.\n");
    }

    // Ensure model indexes are initialized
    await User.init();

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

    // Clean up test usernames before tests
    await User.deleteMany({
        $or: [
            { username: /^test_email_norm_/ },
            { email: /^test_email_norm_/ },
            { email: "anusri_unique_test@gmail.com" }
        ]
    });

    // ==========================================
    // 1. INVALID EMAIL REJECTION TESTS
    // ==========================================
    console.log("--- [1] Invalid Email Format Rejection Tests ---");

    const invalidEmails = [
        "abc",
        "abc@",
        "@domain.com",
        "abc@domain",
        "plainaddress",
        "missingatsign.com",
        "user@.com.my",
        ""
    ];

    for (const invalidEmail of invalidEmails) {
        try {
            const req = createMockReq({
                username: `test_inv_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                email: invalidEmail,
                password: "Password123!"
            });
            const res = createMockRes();

            await userController.signup(req, res, () => {});

            assert.strictEqual(res.redirectUrl, "/signup", `Expected redirect to /signup for '${invalidEmail}'`);
            assert(
                req.flashes.some(f => f.type === "error"),
                `Expected flash error for invalid email '${invalidEmail}'`
            );
            recordPass(`Rejects invalid email format: '${invalidEmail}'`);
        } catch (err) {
            recordFail(`Rejects invalid email format: '${invalidEmail}'`, err);
        }
    }

    // ==========================================
    // 2. EMAIL NORMALIZATION TESTS
    // ==========================================
    console.log("\n--- [2] Email Normalization Tests ---");

    const testRawEmail = "   Anusri_Unique_Test@Gmail.com   ";
    const expectedNormalized = "anusri_unique_test@gmail.com";
    const testUsername = `test_email_norm_${Date.now()}`;

    try {
        const req = createMockReq({
            username: testUsername,
            email: testRawEmail,
            password: "Password123!"
        });
        const res = createMockRes();

        await userController.signup(req, res, () => {});

        assert.strictEqual(res.redirectUrl, "/listings", "Signup should succeed and redirect to /listings");
        assert(req.flashes.some(f => f.type === "success"), "Expected success flash");

        // Verify stored in DB
        const savedUser = await User.findOne({ username: testUsername });
        assert(savedUser, "User should be found in DB");
        assert.strictEqual(
            savedUser.email,
            expectedNormalized,
            `Email '${savedUser.email}' should be stored strictly normalized as '${expectedNormalized}'`
        );
        recordPass(`Normalized '${testRawEmail}' to '${expectedNormalized}'`);
    } catch (err) {
        recordFail("Email normalization during signup", err);
    }

    // ==========================================
    // 3. UNIQUE INDEX & DUPLICATE PREVENTION TESTS
    // ==========================================
    console.log("\n--- [3] Unique Email Index & Duplicate Prevention Tests ---");

    // Test 3.1: Unique index exists in MongoDB
    try {
        const indexes = await mongoose.connection.collection("users").indexes();
        const emailIndex = indexes.find(i => i.name === "email_1" || (i.key && i.key.email === 1));
        assert(emailIndex, "Unique index on 'email' must exist in MongoDB users collection");
        assert.strictEqual(emailIndex.unique, true, "email_1 index must be unique");
        recordPass("MongoDB unique index 'email_1' verified on users collection");
    } catch (err) {
        recordFail("MongoDB unique index 'email_1' verified", err);
    }

    // Test 3.2: Signup rejection when email is already registered (even with different case / whitespace)
    try {
        const reqDup = createMockReq({
            username: `test_dup_user_${Date.now()}`,
            email: "   ANUSRI_UNIQUE_TEST@GMAIL.COM  ",
            password: "Password123!"
        });
        const resDup = createMockRes();

        await userController.signup(reqDup, resDup, () => {});

        assert.strictEqual(resDup.redirectUrl, "/signup", "Expected redirect to /signup on duplicate email");
        assert(
            reqDup.flashes.some(f => f.type === "error" && f.msg.includes("email")),
            "Expected friendly flash error regarding existing email"
        );
        recordPass("Rejects signup with already-registered email across different casing & whitespace");
    } catch (err) {
        recordFail("Rejects signup with duplicate email", err);
    }

    // Test 3.3: Direct MongoDB duplicate-key insertion fails with E11000
    try {
        let duplicateKeyErrorCaught = false;
        try {
            const rawDuplicateUser = new User({
                username: `test_raw_dup_${Date.now()}`,
                email: expectedNormalized,
                role: "USER"
            });
            await rawDuplicateUser.save();
        } catch (dbErr) {
            if (dbErr.code === 11000) {
                duplicateKeyErrorCaught = true;
            }
        }
        assert.strictEqual(duplicateKeyErrorCaught, true, "MongoDB must reject duplicate email at database level with code 11000");
        recordPass("Database level unique index enforces uniqueness and rejects raw duplicate save with code 11000");
    } catch (err) {
        recordFail("Database level unique index enforcement", err);
    }

    // Test 3.4: Controller graceful handling of simulated E11000 race condition
    try {
        const originalRegister = User.register;
        User.register = async () => {
            const err = new Error("E11000 duplicate key error collection: wanderlust.users index: email_1");
            err.code = 11000;
            err.keyPattern = { email: 1 };
            throw err;
        };

        const reqRace = createMockReq({
            username: `test_race_${Date.now()}`,
            email: "race_test@example.com",
            password: "Password123!"
        });
        const resRace = createMockRes();

        await userController.signup(reqRace, resRace, () => {});

        User.register = originalRegister; // Restore

        assert.strictEqual(resRace.redirectUrl, "/signup");
        assert(
            reqRace.flashes.some(f => f.type === "error" && f.msg.includes("email")),
            "Expected graceful user-friendly error message for E11000 duplicate key error"
        );
        recordPass("signup handles E11000 duplicate-key race condition gracefully with user-friendly flash message");
    } catch (err) {
        recordFail("signup handles E11000 duplicate-key race condition", err);
    }

    // Clean up test records
    await User.deleteMany({
        $or: [
            { username: /^test_/ },
            { email: expectedNormalized }
        ]
    });

    console.log("\n===============================================================");
    console.log(`  SUMMARY: ${passedTests} passed, ${failedTests} failed`);
    console.log("===============================================================\n");

    if (failedTests > 0) {
        process.exit(1);
    }
}

runTests()
    .then(() => {
        console.log("All signup email validation and normalization tests passed successfully.");
        process.exit(0);
    })
    .catch((err) => {
        console.error("Test execution fatal error:", err);
        process.exit(1);
    });
