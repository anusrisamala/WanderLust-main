/**
 * Database Migration: Convert legacy rupee booking monetary amounts to integer paise.
 * 
 * Usage:
 *   node scripts/migrate_bookings_to_paise.js [--dry-run]
 * 
 * Safety features:
 * - Checks `isPaise: true` flag to prevent double-conversion.
 * - Supports `--dry-run` flag to preview transformations without writing to the database.
 * - Idempotent: Can be run multiple times safely.
 */

if (process.env.NODE_ENV !== "production") {
    require("dotenv").config();
}

const mongoose = require("mongoose");
const Booking = require("../models/booking.js");

const dbUrl = process.env.ATLASDB_URL || "mongodb://127.0.0.1:27017/wanderlust";
const isDryRun = process.argv.includes("--dry-run");

async function migrate() {
    console.log(`[Migration] Connecting to MongoDB: ${dbUrl.replace(/:([^:@]{4})[^:@]*@/, ":****@")}...`);
    await mongoose.connect(dbUrl);
    console.log("[Migration] MongoDB connected successfully.");

    if (isDryRun) {
        console.log("[Migration] *** DRY RUN MODE ENABLED — No changes will be saved to MongoDB ***\n");
    }

    const allBookings = await Booking.find({});
    console.log(`[Migration] Found ${allBookings.length} total booking records in database.`);

    let migratedCount = 0;
    let skippedCount = 0;

    for (const booking of allBookings) {
        if (booking.isPaise === true) {
            console.log(`[Migration] Booking ${booking._id}: already stored in paise (totalPrice=${booking.totalPrice}). Skipping.`);
            skippedCount++;
            continue;
        }

        const oldPricePerNight = booking.pricePerNight;
        const oldBasePrice = booking.basePrice;
        const oldTaxAmount = booking.taxAmount;
        const oldTotalPrice = booking.totalPrice;
        const oldRefundAmount = booking.refundAmount;

        const newPricePerNight = oldPricePerNight != null ? Math.round(oldPricePerNight * 100) : oldPricePerNight;
        const newBasePrice = oldBasePrice != null ? Math.round(oldBasePrice * 100) : oldBasePrice;
        const newTaxAmount = oldTaxAmount != null ? Math.round(oldTaxAmount * 100) : oldTaxAmount;
        const newTotalPrice = oldTotalPrice != null ? Math.round(oldTotalPrice * 100) : oldTotalPrice;
        const newRefundAmount = oldRefundAmount != null ? Math.round(oldRefundAmount * 100) : oldRefundAmount;

        console.log(`[Migration] Migrating Booking ${booking._id}:`);
        console.log(`   pricePerNight: ₹${oldPricePerNight} -> ${newPricePerNight} paise`);
        console.log(`   basePrice:     ₹${oldBasePrice} -> ${newBasePrice} paise`);
        console.log(`   taxAmount:     ₹${oldTaxAmount} -> ${newTaxAmount} paise`);
        console.log(`   totalPrice:    ₹${oldTotalPrice} -> ${newTotalPrice} paise`);
        if (oldRefundAmount != null) {
            console.log(`   refundAmount:  ₹${oldRefundAmount} -> ${newRefundAmount} paise`);
        }

        const updateFields = { isPaise: true };
        if (newPricePerNight != null) updateFields.pricePerNight = newPricePerNight;
        if (newBasePrice != null) updateFields.basePrice = newBasePrice;
        if (newTaxAmount != null) updateFields.taxAmount = newTaxAmount;
        if (newTotalPrice != null) updateFields.totalPrice = newTotalPrice;
        if (newRefundAmount != null) updateFields.refundAmount = newRefundAmount;

        if (!isDryRun) {
            await Booking.updateOne(
                { _id: booking._id },
                { $set: updateFields }
            );
        }

        migratedCount++;
    }

    console.log("\n========================================");
    console.log(`[Migration Summary]`);
    console.log(`   Total Bookings:   ${allBookings.length}`);
    console.log(`   Migrated:         ${migratedCount}`);
    console.log(`   Already In Paise: ${skippedCount}`);
    console.log(`   Mode:             ${isDryRun ? "DRY RUN (no writes)" : "APPLIED"}`);
    console.log("========================================\n");

    await mongoose.disconnect();
    console.log("[Migration] MongoDB connection closed.");
}

migrate().catch((err) => {
    console.error("[Migration Error]:", err);
    process.exit(1);
});
