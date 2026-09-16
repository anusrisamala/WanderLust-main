const mongoose = require("mongoose");
const Listing = require("../models/listing.js");

const MONGO_URL = "mongodb://127.0.0.1:27017/wanderlust";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
    await mongoose.connect(MONGO_URL);
    console.log("Connected to database");
}

async function migrateCoordinates() {
    try {
        await main();

        const listingsToUpdate = await Listing.find({
            $or: [
                { latitude: { $exists: false } },
                { latitude: null },
                { longitude: { $exists: false } },
                { longitude: null }
            ]
        });

        console.log(`Found ${listingsToUpdate.length} listings without coordinates\n`);

        let updated = 0;
        let skipped = 0;
        let failed = 0;

        for (const listing of listingsToUpdate) {
            if (!listing.location || listing.location.trim() === "") {
                console.log(`Skipping listing ID ${listing._id} ("${listing.title}"): Missing location field\n`);
                skipped++;
                continue;
            }

            console.log(`Processing: ${listing.location}`);

            try {
                const response = await fetch(
                    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(listing.location)}&format=json&limit=1`,
                    {
                        headers: {
                            "User-Agent": "WanderLust-App"
                        }
                    }
                );

                const data = await response.json();

                if (data && data.length > 0) {
                    const lat = parseFloat(data[0].lat);
                    const lon = parseFloat(data[0].lon);

                    console.log(`Coordinates found: ${lat}, ${lon}`);

                    await Listing.updateOne(
                        { _id: listing._id },
                        {
                            $set: {
                                latitude: lat,
                                longitude: lon
                            }
                        }
                    );

                    console.log("Updated successfully\n");
                    updated++;
                } else {
                    console.log(`Coordinates not found for "${listing.location}". Skipping.\n`);
                    skipped++;
                }
            } catch (err) {
                console.log(`Error geocoding "${listing.location}": ${err.message}\n`);
                failed++;
            }

            // 1-second delay between requests to respect Nominatim rate limits
            await delay(1000);
        }

        console.log("Migration completed");
        console.log(`Updated: ${updated}`);
        console.log(`Skipped: ${skipped}`);
        console.log(`Failed: ${failed}`);
    } catch (err) {
        console.error("Migration error:", err);
    } finally {
        await mongoose.connection.close();
        console.log("Database connection closed");
    }
}

migrateCoordinates();
