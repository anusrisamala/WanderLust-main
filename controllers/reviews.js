const mongoose = require("mongoose");
const Listing  = require("../models/listing");
const Review  = require("../models/review");
const Booking = require("../models/booking");
const { syncCompletedBookings } = require("../utils/availability");

module.exports.createReview = async(req,res)=>{
    let { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Listing not found");
        return res.redirect("/listings");
    }
    let listing = await Listing.findById(id);
    if (!listing) {
        req.flash("error", "Listing not found");
        return res.redirect("/listings");
    }

    const currentUserId = (res.locals.currUser && res.locals.currUser._id) || (req.user && req.user._id);

    // Host cannot review their own listing
    if (listing.owner && currentUserId && listing.owner.equals(currentUserId)) {
        req.flash("error", "Hosts cannot review their own listings.");
        return res.redirect(`/listings/${id}`);
    }

    // Determine eligible completed booking (from middleware or direct call)
    let eligibleBooking = req.eligibleBooking;
    if (!eligibleBooking && currentUserId) {
        await syncCompletedBookings({ listing: id, user: currentUserId });
        const completedBookings = await Booking.find({
            listing: id,
            user: currentUserId,
            status: "COMPLETED",
        }).sort({ checkOutDate: -1 });

        if (!completedBookings || completedBookings.length === 0) {
            const hasUpcoming = await Booking.exists({
                listing: id,
                user: currentUserId,
                status: { $in: ["CONFIRMED", "AWAITING_HOST_APPROVAL", "PENDING_PAYMENT", "PENDING"] },
            });
            if (hasUpcoming) {
                req.flash("error", "You can only leave a review after your stay is completed.");
            } else {
                req.flash("error", "Only verified guests who have completed a stay can review this listing.");
            }
            return res.redirect(`/listings/${id}`);
        }

        const existingReviews = await Review.find({
            _id: { $in: listing.reviews },
            author: currentUserId,
        });

        if (existingReviews.length >= completedBookings.length) {
            req.flash("error", "You have already submitted a review for your stay at this listing.");
            return res.redirect(`/listings/${id}`);
        }

        const reviewedBookingIds = new Set(
            existingReviews.map((r) => (r.booking ? r.booking.toString() : null)).filter(Boolean)
        );
        eligibleBooking = completedBookings.find(
            (b) => !reviewedBookingIds.has(b._id.toString())
        ) || completedBookings[0];
    }

    let newReview = new Review(req.body.review);
    newReview.author = currentUserId;
    if (eligibleBooking) {
        newReview.booking = eligibleBooking._id;
        newReview.isVerifiedGuest = true;
    }
    listing.reviews.push(newReview);

    await newReview.save();
    await listing.save();
    req.flash("success","Thank you for sharing your verified review!");
    res.redirect(`/listings/${listing._id}#reviews`);
}

module.exports.destroyReview = async(req,res)=>{
    let {id, reviewId} = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id) || !reviewId || !mongoose.Types.ObjectId.isValid(reviewId)) {
        req.flash("error", "Invalid listing or review ID");
        return res.redirect(id && mongoose.Types.ObjectId.isValid(id) ? `/listings/${id}` : "/listings");
    }
    await Listing.findByIdAndUpdate(id,{$pull:{reviews:reviewId}});
    await Review.findByIdAndDelete(reviewId);
    req.flash("success","Review deleted!");
    res.redirect(`/listings/${id}`);
}