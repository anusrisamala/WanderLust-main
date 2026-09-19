const mongoose = require("mongoose");
const review = require("./review");
const Schema = mongoose.Schema;


const listingSchema = new Schema({
  title: {
    type: String,
    required: true,
  },
  description: String,
  image: {
    url:String,
    filename:String,
  },// defualt matlab value undifined hi ho..dusra set hum client side ke liye use kar rh h agar user ne empty string dhe diya tho
  price: Number,
  location: String,
  country: String,
  latitude: Number,
  longitude: Number,
  reviews:[
    {
      type:Schema.Types.ObjectId,
      ref:"Review",
    }
  ],
  owner:{
    type:Schema.Types.ObjectId,
    ref:"User",
  },
  category: {
    type: String,
    enum: [
      "Trending",
      "Rooms",
      "Iconic Cities",
      "Mountains",
      "Castles",
      "Amazing Pools",
      "Camping",
      "Farms",
      "Arctic",
      "Domes",
      "Boats",
    ],
    required: true,
  },
  reservationLockVersion: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true,
  },
  archivedAt: {
    type: Date,
    default: null,
  },
});

listingSchema.post("findOneAndDelete", async (listing) => {
  if (listing != null) {
    const Review = require("./review");
    const Booking = require("./booking");
    const User = require("./user");

    // 1. Delete associated reviews
    if (listing.reviews && listing.reviews.length > 0) {
      await Review.deleteMany({ _id: { $in: listing.reviews } });
    }

    // 2. Cascade delete all related bookings so none are left pointing to an unavailable listing
    await Booking.deleteMany({ listing: listing._id });

    // 3. Remove deleted listing from all user wishlists
    await User.updateMany(
      { wishlist: listing._id },
      { $pull: { wishlist: listing._id } }
    );

    // 4. Safely delete associated Cloudinary image if not shared with another listing
    if (listing.image) {
      try {
        const { deleteCloudinaryImage } = require("../cloudConfig.js");
        await deleteCloudinaryImage(listing.image, listing._id);
      } catch (err) {
        console.error("Error deleting listing image from Cloudinary:", err?.message || err);
      }
    }
  }
});
const Listing = mongoose.model("Listing", listingSchema);
module.exports = Listing;