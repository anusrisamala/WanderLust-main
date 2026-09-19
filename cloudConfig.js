const cloudinary = require("cloudinary").v2;
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const mongoose = require("mongoose");

cloudinary.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.CLOUD_API_KEY,
    api_secret: process.env.CLOUD_API_SECRET,
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: "wanderlust_DEV",
        allowedFormats: ["png", "jpg", "jpeg"],
    },
});

/**
 * Safely delete an image from Cloudinary if it is not shared by another listing.
 * @param {string|object} imageOrFilename - Either a Cloudinary public_id string or an image object { url, filename }
 * @param {string|mongoose.Types.ObjectId} [excludeListingId] - Optional listing ID to exclude when checking for shared usage
 * @returns {Promise<boolean>} True if deleted, false if skipped or failed
 */
async function deleteCloudinaryImage(imageOrFilename, excludeListingId = null) {
    if (!imageOrFilename) return false;

    let filename = null;
    let url = null;
    if (typeof imageOrFilename === "string") {
        filename = imageOrFilename;
    } else if (typeof imageOrFilename === "object") {
        filename = imageOrFilename.filename;
        url = imageOrFilename.url;
    }

    if (!filename || typeof filename !== "string" || filename.trim() === "") {
        return false;
    }

    filename = filename.trim();

    // Do not attempt to delete default placeholder seed filenames or direct HTTP URLs
    if (filename === "listingimage" || filename.startsWith("http://") || filename.startsWith("https://")) {
        return false;
    }

    // If url is present and does not point to Cloudinary, skip
    if (url && typeof url === "string" && !url.includes("cloudinary.com") && !url.includes("res.cloudinary")) {
        return false;
    }

    try {
        // Guard: Do not delete an image that belongs to or is shared by another listing
        const Listing = mongoose.models.Listing || require("./models/listing.js");
        const query = { "image.filename": filename };
        if (excludeListingId) {
            query._id = { $ne: excludeListingId };
        }
        const isShared = await Listing.exists(query);
        if (isShared) {
            console.log(`[Cloudinary] Skipped deletion: Image '${filename}' is in use by another listing.`);
            return false;
        }

        const result = await cloudinary.uploader.destroy(filename);
        console.log(`[Cloudinary] Image '${filename}' deleted successfully:`, result);
        return true;
    } catch (err) {
        // Safe catch: Cloudinary failure must not crash or break application flows
        console.error(`[Cloudinary] Safe catch: failed to delete image '${filename}':`, err?.message || err);
        return false;
    }
}

module.exports = {
    cloudinary,
    storage,
    deleteCloudinaryImage,
};