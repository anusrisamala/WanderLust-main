const path = require("path");
const assert = require("assert");
const mongoose = require("mongoose");

const projectDir = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(projectDir, ".env") });

const Listing = require(path.join(projectDir, "models/listing.js"));
const User = require(path.join(projectDir, "models/user.js"));
const { cloudinary, deleteCloudinaryImage } = require(path.join(projectDir, "cloudConfig.js"));
const listingController = require(path.join(projectDir, "controllers/listings.js"));

const MONGO_URL = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";

function createMockRes() {
    return {
        statusCode: 200,
        headers: {},
        jsonPayload: null,
        redirectUrl: null,
        flashes: [],
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

function createMockReq(params = {}, body = {}, user = null, file = undefined) {
    const flashes = [];
    return {
        params,
        body,
        user,
        file,
        flashes,
        flash(type, msg) {
            if (arguments.length === 0) return flashes;
            flashes.push({ type, msg });
            return flashes;
        },
        get(header) {
            return null;
        }
    };
}

async function runTests() {
    console.log("===============================================================");
    console.log("  CLOUDINARY IMAGE DELETION & SAFETY TEST SUITE");
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

    let testUser = await User.findOne({ username: "test_cloudinary_user" });
    if (!testUser) {
        testUser = await User.register(
            new User({ username: "test_cloudinary_user", email: "test_cld@example.com", role: "HOST" }),
            "Password123!"
        );
    }

    // Intercept cloudinary.uploader.destroy to track deletion attempts in tests
    const destroyedPublicIds = [];
    let simulateDestroyError = false;
    const originalDestroy = cloudinary.uploader.destroy;

    cloudinary.uploader.destroy = async (publicId) => {
        if (simulateDestroyError) {
            throw new Error("Simulated Cloudinary API gateway timeout / network error");
        }
        destroyedPublicIds.push(publicId);
        return { result: "ok" };
    };

    try {
        // ==========================================
        // 1. HELPER SAFETY & FILTERING TESTS
        // ==========================================
        console.log("--- [1] Helper Safety & Filtering Tests ---");

        // Test 1.1: Ignores null, undefined, empty string
        destroyedPublicIds.length = 0;
        assert.strictEqual(await deleteCloudinaryImage(null), false);
        assert.strictEqual(await deleteCloudinaryImage(undefined), false);
        assert.strictEqual(await deleteCloudinaryImage(""), false);
        assert.strictEqual(await deleteCloudinaryImage({ filename: "" }), false);
        assert.strictEqual(destroyedPublicIds.length, 0);
        recordPass("deleteCloudinaryImage ignores null, undefined, and empty string");

        // Test 1.2: Ignores 'listingimage' (seed data placeholder)
        assert.strictEqual(await deleteCloudinaryImage("listingimage"), false);
        assert.strictEqual(await deleteCloudinaryImage({ filename: "listingimage" }), false);
        assert.strictEqual(destroyedPublicIds.length, 0);
        recordPass("deleteCloudinaryImage protects seed placeholder 'listingimage'");

        // Test 1.3: Ignores external Unsplash URLs
        assert.strictEqual(await deleteCloudinaryImage({
            filename: "http://example.com/pic.jpg",
            url: "http://example.com/pic.jpg"
        }), false);
        assert.strictEqual(await deleteCloudinaryImage({
            filename: "https://images.unsplash.com/photo-12345",
            url: "https://images.unsplash.com/photo-12345"
        }), false);
        assert.strictEqual(destroyedPublicIds.length, 0);
        recordPass("deleteCloudinaryImage ignores external HTTP/Unsplash URLs");

        // Test 1.4: Guard against deleting image that belongs to another listing
        const sharedFilename = "wanderlust_DEV/shared_pool_image_999";
        const listingA = new Listing({
            title: "Listing A (Shared Image)",
            description: "Sharing image with Listing B",
            image: { url: `https://res.cloudinary.com/demo/image/upload/${sharedFilename}.jpg`, filename: sharedFilename },
            price: 2000,
            location: "Delhi",
            country: "India",
            category: "Rooms",
            owner: testUser._id
        });
        const listingB = new Listing({
            title: "Listing B (Shared Image)",
            description: "Sharing image with Listing A",
            image: { url: `https://res.cloudinary.com/demo/image/upload/${sharedFilename}.jpg`, filename: sharedFilename },
            price: 2500,
            location: "Mumbai",
            country: "India",
            category: "Rooms",
            owner: testUser._id
        });
        await listingA.save();
        await listingB.save();

        destroyedPublicIds.length = 0;
        // Attempt to delete shared image from listingA while listingB still exists
        const resultShared = await deleteCloudinaryImage(sharedFilename, listingA._id);
        assert.strictEqual(resultShared, false, "Should return false when image belongs to another listing");
        assert.strictEqual(destroyedPublicIds.length, 0, "Cloudinary destroy should NOT be called for shared image");
        recordPass("deleteCloudinaryImage does not delete an image that belongs to another listing");

        // Clean up listingB, then deletion for listingA should succeed
        await Listing.deleteOne({ _id: listingB._id });
        const resultUnique = await deleteCloudinaryImage(sharedFilename, listingA._id);
        assert.strictEqual(resultUnique, true);
        assert.strictEqual(destroyedPublicIds.length, 1);
        assert.strictEqual(destroyedPublicIds[0], sharedFilename);
        recordPass("deleteCloudinaryImage deletes unique image once no other listing references it");
        await Listing.deleteOne({ _id: listingA._id });

        // Test 1.5: Handles Cloudinary API failure safely without crashing
        destroyedPublicIds.length = 0;
        simulateDestroyError = true;
        let threwError = false;
        try {
            const failResult = await deleteCloudinaryImage("wanderlust_DEV/test_err_img");
            assert.strictEqual(failResult, false);
        } catch (err) {
            threwError = true;
        }
        simulateDestroyError = false;
        assert.strictEqual(threwError, false, "deleteCloudinaryImage must catch errors safely without throwing");
        recordPass("deleteCloudinaryImage handles Cloudinary gateway errors safely without crashing");

        // ==========================================
        // 2. IMAGE REPLACEMENT TESTS (updateListing)
        // ==========================================
        console.log("\n--- [2] Image Replacement Tests (updateListing) ---");

        const oldFilename = "wanderlust_DEV/original_photo_101";
        const newFilename = "wanderlust_DEV/replacement_photo_102";

        const editListing = new Listing({
            title: "Edit Photo Villa",
            description: "Testing image replacement",
            image: { url: `https://res.cloudinary.com/demo/image/upload/${oldFilename}.jpg`, filename: oldFilename },
            price: 3500,
            location: "Manali",
            country: "India",
            category: "Mountains",
            owner: testUser._id
        });
        await editListing.save();

        destroyedPublicIds.length = 0;

        // Simulate replacing image via updateListing
        const mockReq = createMockReq(
            { id: editListing._id.toString() },
            { listing: { title: "Edit Photo Villa (Updated)" } },
            testUser,
            {
                path: `https://res.cloudinary.com/demo/image/upload/${newFilename}.jpg`,
                filename: newFilename
            }
        );
        const mockRes = createMockRes();

        await listingController.updateListing(mockReq, mockRes);

        // Verify database references the NEW image correctly
        const updatedInDb = await Listing.findById(editListing._id);
        assert.strictEqual(updatedInDb.image.filename, newFilename, "Database must reference new image filename");
        assert.strictEqual(updatedInDb.image.url, `https://res.cloudinary.com/demo/image/upload/${newFilename}.jpg`);

        // Verify OLD image was deleted
        assert.strictEqual(destroyedPublicIds.length, 1, "Exactly one image should be destroyed");
        assert.strictEqual(destroyedPublicIds[0], oldFilename, "Old image filename must be deleted from Cloudinary");

        // CRITICAL CHECK: Verify the NEW image was NOT deleted accidentally
        assert(!destroyedPublicIds.includes(newFilename), "New image must NOT be accidentally deleted!");
        recordPass("Image replacement deletes old image, updates DB to new image, and never deletes new image");

        // Test 2.2: Cloudinary deletion failure during update does NOT crash or break listing update
        const anotherNewFilename = "wanderlust_DEV/another_photo_103";
        simulateDestroyError = true;
        const mockReqFail = createMockReq(
            { id: editListing._id.toString() },
            { listing: { title: "Edit Photo Villa (Safe Fail)" } },
            testUser,
            {
                path: `https://res.cloudinary.com/demo/image/upload/${anotherNewFilename}.jpg`,
                filename: anotherNewFilename
            }
        );
        const mockResFail = createMockRes();

        let updateThrew = false;
        try {
            await listingController.updateListing(mockReqFail, mockResFail);
        } catch (err) {
            updateThrew = true;
        }
        simulateDestroyError = false;

        assert.strictEqual(updateThrew, false, "updateListing must not throw even if Cloudinary delete fails");
        const safeFailInDb = await Listing.findById(editListing._id);
        assert.strictEqual(safeFailInDb.image.filename, anotherNewFilename, "Database is safely updated despite Cloudinary failure");
        assert.strictEqual(mockResFail.redirectUrl, `/listings/${editListing._id}`);
        recordPass("Cloudinary deletion failure during image update is handled safely without crashing");

        // ==========================================
        // 3. ARCHIVING / DELETION CLEANUP TESTS
        // ==========================================
        console.log("\n--- [3] Archiving & Deletion Cleanup Tests ---");

        // Test 3.1: Archiving listing triggers Cloudinary image deletion
        destroyedPublicIds.length = 0;
        const archiveListing = new Listing({
            title: "Listing to Archive",
            description: "Testing image deletion on archive",
            image: { url: "https://res.cloudinary.com/demo/image/upload/wanderlust_DEV/archive_img_777.jpg", filename: "wanderlust_DEV/archive_img_777" },
            price: 1800,
            location: "Kerala",
            country: "India",
            category: "Trending",
            owner: testUser._id
        });
        await archiveListing.save();

        const reqArchive = createMockReq({ id: archiveListing._id.toString() }, {}, testUser);
        const resArchive = createMockRes();

        await listingController.destroyListing(reqArchive, resArchive);

        assert.strictEqual(destroyedPublicIds.length, 1);
        assert.strictEqual(destroyedPublicIds[0], "wanderlust_DEV/archive_img_777");
        const archivedInDb = await Listing.findById(archiveListing._id);
        assert.strictEqual(archivedInDb.isActive, false, "Listing is soft-deleted / archived");
        recordPass("Archiving a listing deletes its associated Cloudinary image");

        // Test 3.2: Hard deleting listing (findOneAndDelete post hook) deletes image
        destroyedPublicIds.length = 0;
        const hardDeleteListing = new Listing({
            title: "Listing to Hard Delete",
            description: "Testing image deletion on findOneAndDelete",
            image: { url: "https://res.cloudinary.com/demo/image/upload/wanderlust_DEV/hard_delete_888.jpg", filename: "wanderlust_DEV/hard_delete_888" },
            price: 2100,
            location: "Udaipur",
            country: "India",
            category: "Castles",
            owner: testUser._id
        });
        await hardDeleteListing.save();

        await Listing.findByIdAndDelete(hardDeleteListing._id);
        assert.strictEqual(destroyedPublicIds.length, 1);
        assert.strictEqual(destroyedPublicIds[0], "wanderlust_DEV/hard_delete_888");
        recordPass("Hard-deleting a listing via findByIdAndDelete triggers Cloudinary image cleanup");

        // Clean up test records
        await Listing.deleteOne({ _id: editListing._id });
        await Listing.deleteOne({ _id: archiveListing._id });

    } finally {
        // Restore original cloudinary uploader destroy method
        cloudinary.uploader.destroy = originalDestroy;
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
        console.log("All Cloudinary image deletion tests passed successfully.");
        process.exit(0);
    })
    .catch((err) => {
        console.error("Test execution fatal error:", err);
        process.exit(1);
    });
