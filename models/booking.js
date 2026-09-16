const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const bookingSchema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: "User",
        required: true,
    },
    listing: {
        type: Schema.Types.ObjectId,
        ref: "Listing",
        required: true,
    },
    checkInDate: {
        type: Date,
        required: true,
    },
    checkInTime: {
        type: String,
        required: true,
    },
    checkOutDate: {
        type: Date,
        required: true,
    },
    checkOutTime: {
        type: String,
        required: true,
    },
    guests: {
        type: Number,
        required: true,
        min: 1,
    },
    numberOfNights: {
        type: Number,
        required: true,
        min: 1,
    },
    pricePerNight: {
        type: Number,
        required: true,
        min: 0,
    },
    basePrice: {
        type: Number,
        required: true,
        min: 0,
    },
    taxRate: {
        type: Number,
        required: true,
        min: 0,
    },
    taxAmount: {
        type: Number,
        required: true,
        min: 0,
    },
    totalPrice: {
        type: Number,
        required: true,
        min: 0,
    },
    status: {
        type: String,
        enum: ["PENDING", "CONFIRMED", "CANCELLED", "COMPLETED"],
        default: "PENDING",
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Booking = mongoose.model("Booking", bookingSchema);
module.exports = Booking;
