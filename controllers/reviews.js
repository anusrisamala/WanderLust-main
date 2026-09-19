const mongoose = require("mongoose");
const Listing  = require("../models/listing");
const Review  = require("../models/review");

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
    let newReview = new Review(req.body.review);
    newReview.author = req.user._id;
    listing.reviews.push(newReview);

    await newReview.save();
    await listing.save();
    req.flash("success","New Review created!");
    res.redirect(`/listings/${listing._id}`);
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