const mongoose = require("mongoose");
const Listing = require("./models/listing");
const Review = require("./models/review");
const Booking = require("./models/booking");
const { syncCompletedBookings } = require("./utils/availability");
const {listingSchema, reviewSchema} = require("./schema.js");
const ExpressError = require("./utils/ExpressError.js");

module.exports.isLoggedIn = (req,res,next)=>{
    console.log(req.user);
    if(!req.isAuthenticated()){
        req.session.redirectUrl = req.originalUrl;
        req.flash("error" , "you must be logged in to create listing!");
        return res.redirect("/login");
    }
    next();
}

module.exports.savedRedirectUrl = (req,res,next)=>{
    if(req.session.redirectUrl){
        res.locals.redirectUrl = req.session.redirectUrl;
    }
    next();
}

module.exports.isOwner = async(req,res,next)=>{
    let {id} = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect("/listings");
    }
    let listing = await Listing.findById(id);
    if (!listing) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect("/listings");
    }
    const currentUserId = (res.locals.currUser && res.locals.currUser._id) || (req.user && req.user._id);
    if(!listing.owner || !currentUserId || !listing.owner.equals(currentUserId)){
        req.flash("error","You are not the owner of this listing");
        return res.redirect(`/listings/${id}`);
    }
    next();
}

module.exports.validateListing = (req,res,next)=>{
    let {error} = listingSchema.validate(req.body, { allowUnknown: true });
    if(error){
        let errMsg = error.details.map((el)=> el.message).join(",");
        throw new ExpressError(400,errMsg);
    }else{
        next();
    }
}

module.exports.validateReview = (req,res,next)=>{
    let {error} = reviewSchema.validate(req.body, { allowUnknown: true });
    if(error){
        let errMsg = error.details.map((el)=> el.message).join(",");
        throw new ExpressError(400,errMsg);
    }else{
        next();
    }
}

module.exports.isReviewAuthor = async(req,res,next)=>{
    let {id, reviewId} = req.params;
    if (!reviewId || !mongoose.Types.ObjectId.isValid(reviewId)) {
        req.flash("error", "Review you requested for does not exist");
        return res.redirect(id && mongoose.Types.ObjectId.isValid(id) ? `/listings/${id}` : "/listings");
    }

    let review = await Review.findById(reviewId);
    if(!review){
        req.flash("error", "Review you requested for does not exist");
        return res.redirect(id && mongoose.Types.ObjectId.isValid(id) ? `/listings/${id}` : "/listings");
    }

    if(!review.author || !review.author.equals(res.locals.currUser._id)){
        req.flash("error","You are not the author of this review");
        return res.redirect(id && mongoose.Types.ObjectId.isValid(id) ? `/listings/${id}` : "/listings");
    }

    next();
}

module.exports.isHost = (req, res, next) => {
    if (!req.isAuthenticated()) {
        req.session.redirectUrl = req.originalUrl;
        req.flash("error", "You must be logged in!");
        return res.redirect("/login");
    }
    if (req.user.role !== "HOST") {
        req.flash("error", "Access denied. Only hosts can access this resource.");
        return res.redirect("/dashboard");
    }
    next();
};

module.exports.isVerifiedGuest = async (req, res, next) => {
    let { id } = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect("/listings");
    }

    const listing = await Listing.findById(id);
    if (!listing) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect("/listings");
    }

    const currentUserId = (res.locals.currUser && res.locals.currUser._id) || (req.user && req.user._id);
    if (!currentUserId) {
        req.flash("error", "You must be logged in to review a listing!");
        return res.redirect("/login");
    }

    // Host cannot review their own listing
    if (listing.owner && listing.owner.equals(currentUserId)) {
        req.flash("error", "Hosts cannot review their own listings.");
        return res.redirect(`/listings/${id}`);
    }

    // Automatically synchronize any past confirmed reservations to COMPLETED
    await syncCompletedBookings({ listing: id, user: currentUserId });

    // Fetch all completed bookings for this user at this listing
    const completedBookings = await Booking.find({
        listing: id,
        user: currentUserId,
        status: "COMPLETED",
    }).sort({ checkOutDate: -1 });

    if (!completedBookings || completedBookings.length === 0) {
        // Check if user has an active or upcoming booking
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

    // Fetch existing reviews on this listing authored by the user
    const existingReviews = await Review.find({
        _id: { $in: listing.reviews },
        author: currentUserId,
    });

    if (existingReviews.length >= completedBookings.length) {
        req.flash("error", "You have already submitted a review for your stay at this listing.");
        return res.redirect(`/listings/${id}`);
    }

    // Find a completed booking that is not yet linked to an existing review
    const reviewedBookingIds = new Set(
        existingReviews.map((r) => (r.booking ? r.booking.toString() : null)).filter(Boolean)
    );
    const eligibleBooking = completedBookings.find(
        (b) => !reviewedBookingIds.has(b._id.toString())
    ) || completedBookings[0];

    req.eligibleBooking = eligibleBooking;
    next();
};