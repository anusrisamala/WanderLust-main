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
        set: (v) => (v != null ? Math.round(v) : v),
    },
    basePrice: {
        type: Number,
        required: true,
        min: 0,
        set: (v) => (v != null ? Math.round(v) : v),
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
        set: (v) => (v != null ? Math.round(v) : v),
    },
    totalPrice: {
        type: Number,
        required: true,
        min: 0,
        set: (v) => (v != null ? Math.round(v) : v),
    },
    status: {
        type: String,
        enum: ["PENDING_PAYMENT", "AWAITING_HOST_APPROVAL", "CONFIRMED", "CANCELLED", "COMPLETED", "PENDING"],
        default: "PENDING_PAYMENT",
    },
    paymentStatus: {
        type: String,
        enum: ["PENDING", "PAID", "FAILED", "REFUND_PENDING", "REFUNDED", "REFUND_FAILED"],
        default: "PENDING",
    },
    paymentId: {
        type: String,
        default: null,
    },
    paymentMethod: {
        type: String,
        default: null,
    },
    paidAt: {
        type: Date,
        default: null,
    },
    razorpayOrderId: {
        type: String,
        default: null,
    },
    refundId: {
        type: String,
        default: null,
    },
    refundedAt: {
        type: Date,
        default: null,
    },
    refundAmount: {
        type: Number,
        default: null,
        set: (v) => (v != null ? Math.round(v) : null),
    },
    isPaise: {
        type: Boolean,
        default: false,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Rupee virtuals for UI display (converts integer paise back to rupees)
bookingSchema.virtual("totalPriceRupees").get(function () {
    const val = this.totalPrice || 0;
    return this.isPaise ? val / 100 : val;
});

bookingSchema.virtual("basePriceRupees").get(function () {
    const val = this.basePrice != null ? this.basePrice : this.totalPrice || 0;
    return this.isPaise ? val / 100 : val;
});

bookingSchema.virtual("taxAmountRupees").get(function () {
    const val = this.taxAmount || 0;
    return this.isPaise ? val / 100 : val;
});

bookingSchema.virtual("pricePerNightRupees").get(function () {
    const val = this.pricePerNight || 0;
    return this.isPaise ? val / 100 : val;
});

bookingSchema.virtual("refundAmountRupees").get(function () {
    if (this.refundAmount == null) return null;
    return this.isPaise ? this.refundAmount / 100 : this.refundAmount;
});

bookingSchema.set("toJSON", { virtuals: true });
bookingSchema.set("toObject", { virtuals: true });

// Concurrency & replay security: unique indexes on non-null string identifiers
bookingSchema.index(
    { razorpayOrderId: 1 },
    {
        unique: true,
        partialFilterExpression: { razorpayOrderId: { $type: "string" } }
    }
);

bookingSchema.index(
    { paymentId: 1 },
    {
        unique: true,
        partialFilterExpression: { paymentId: { $type: "string" } }
    }
);

bookingSchema.index(
    { refundId: 1 },
    {
        unique: true,
        partialFilterExpression: { refundId: { $type: "string" } }
    }
);

const Booking = mongoose.model("Booking", bookingSchema);
module.exports = Booking;
