const Listing  = require("../models/listing");
const User = require("../models/user");

function buildQuery(q, category) {
    const conditions = [];

    if (q && q.trim()) {
        const safeQuery = q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        conditions.push({
            $or: [
                { title: { $regex: safeQuery, $options: "i" } },
                { location: { $regex: safeQuery, $options: "i" } },
                { country: { $regex: safeQuery, $options: "i" } },
                { category: { $regex: safeQuery, $options: "i" } }
            ]
        });
    }

    if (category && category.trim()) {
        conditions.push({ category: category.trim() });
    }

    if (conditions.length === 0) {
        return {};
    } else if (conditions.length === 1) {
        return conditions[0];
    } else {
        return { $and: conditions };
    }
}

module.exports.index = async (req, res) => {
    const { category, q } = req.query;
    const query = q ? q.trim() : "";
    const selectedCategory = category ? category.trim() : "";

    const filter = buildQuery(query, selectedCategory);
    const allListings = await Listing.find(filter);

    res.render("listings/index.ejs", {
        allListings,
        searchQuery: query,
        category: selectedCategory
    });
};

module.exports.searchListings = async (req, res) => {
    let { q, category } = req.query;
    const query = q ? q.trim() : "";
    const selectedCategory = category ? category.trim() : "";

    if (!query && !selectedCategory) {
        return res.redirect("/listings");
    }

    if (!query && selectedCategory) {
        return res.redirect(`/listings?category=${encodeURIComponent(selectedCategory)}`);
    }

    const filter = buildQuery(query, selectedCategory);
    const allListings = await Listing.find(filter);

    res.render("listings/index.ejs", {
        allListings,
        searchQuery: query,
        category: selectedCategory
    });
};

module.exports.renderNewForm = (req,res)=>{
    res.render("listings/new.ejs");
}

module.exports.showListing = async(req,res)=>{
    let {id} = req.params;
    const listing = await Listing.findById(id).populate({path: "reviews" , populate:{path: "author"}}).populate("owner");
    if(!listing){
        req.flash("error", "listing you requested for does not exist");
        return res.redirect("/listings");
    }

    let isWishlisted = false;
    if (req.user && req.user.wishlist) {
        isWishlisted = req.user.wishlist.some((wishlistId) => wishlistId && wishlistId.equals(listing._id));
    }

    res.render("listings/show.ejs", { listing, isWishlisted });
}


async function geocodeLocation(location) {
    if (!location) return null;
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(location)}&format=json&limit=1`,
            {
                headers: {
                    "User-Agent": "WanderLust-App"
                }
            }
        );
        const data = await response.json();
        if (data && data.length > 0) {
            return {
                latitude: parseFloat(data[0].lat),
                longitude: parseFloat(data[0].lon)
            };
        } else {
            console.log(`Geocoding failed: No coordinates found for location "${location}"`);
        }
    } catch (err) {
        console.log(`Geocoding error for location "${location}":`, err.message);
    }
    return null;
}

module.exports.createListing = async(req,res)=>{
    // if(!req.body||!req.body.listing){
    //     throw new ExpressError(400,"Send valid data for listing"); 
    // }
    // let result = listingSchema.validate(req.body);
    // console.log(result);
    // if(result.error){
    //     throw new ExpressError(400,result.error);
    // }

    //one way is..
    //let {title,description,image,price,country,location}=req.body;
    //(or)

    let url = req.file.path;
    let filename  = req.file.filename;
    let listing = { ...req.body.listing };
    delete listing.owner;
    const newListing = new Listing(listing);
    newListing.owner = req.user._id;
    newListing.image = {url, filename};

    if (newListing.location) {
        const coords = await geocodeLocation(newListing.location);
        if (coords) {
            newListing.latitude = coords.latitude;
            newListing.longitude = coords.longitude;
        }
    }

    await newListing.save();
    req.flash("success","New listing created!");
    res.redirect("/listings");
    //console.log(listing);
}

module.exports.renderEditForm = async (req,res)=>{
    let {id} = req.params;
    const listing = await Listing.findById(id);
    if(!listing){
        req.flash("error", "listing you requested for does not exist");
       return res.redirect("/listings");
    }
    let originalImageUrl = listing.image.url;
    originalImageUrl = originalImageUrl.replace("/upload", "/upload/w_250");
    res.render("listings/edit.ejs",{listing, originalImageUrl});
}

module.exports.updateListing = async(req,res)=>{
    // if(!req.body.listing){
    //     throw new ExpressError(400,"Send valid data for listing"); 
    // }
    let {id} = req.params;
    const existingListing = await Listing.findById(id);
    if (!existingListing) {
        req.flash("error", "listing you requested for does not exist");
        return res.redirect("/listings");
    }

    let updateData = { ...req.body.listing };
    delete updateData.owner;

    // Check if location changed
    if (updateData.location && updateData.location !== existingListing.location) {
        const coords = await geocodeLocation(updateData.location);
        if (coords) {
            updateData.latitude = coords.latitude;
            updateData.longitude = coords.longitude;
        }
    }

    let listing = await Listing.findByIdAndUpdate(id, updateData, { new: true });

    if(typeof req.file!== "undefined"){
        let url = req.file.path;
        let filename = req.file.filename;
        listing.image = {url,filename};
        await listing.save();
    }
    req.flash("success","Listing updated!");
    res.redirect(`/listings/${id}`);
}


module.exports.destroyListing = async(req,res)=>{
    let {id} = req.params;
    let deletedListing = await Listing.findByIdAndDelete(id);
    console.log(deletedListing);
    req.flash("success","Listing deleted!");
    const referer = req.get("Referrer");
    if (referer && referer.includes("/host/listings")) {
        return res.redirect("/host/listings");
    }
    if (referer && referer.includes("/host/dashboard")) {
        return res.redirect("/host/dashboard#my-listings");
    }
    if (referer && referer.includes("/dashboard")) {
        return res.redirect("/dashboard#my-listings");
    }
    res.redirect("/listings");
}

module.exports.toggleWishlist = async (req, res) => {
    let { id } = req.params;
    const listing = await Listing.findById(id);
    if (!listing) {
        req.flash("error", "Listing you requested for does not exist!");
        return res.redirect("/listings");
    }

    const user = await User.findById(req.user._id);
    if (!user) {
        req.flash("error", "User not found!");
        return res.redirect(`/listings/${id}`);
    }

    if (!user.wishlist) {
        user.wishlist = [];
    }

    // Safe ObjectId comparison using .equals()
    const existsIndex = user.wishlist.findIndex((wishlistId) => wishlistId && wishlistId.equals(id));

    if (existsIndex === -1) {
        user.wishlist.push(id);
        req.flash("success", "Listing added to wishlist!");
    } else {
        user.wishlist.splice(existsIndex, 1);
        req.flash("success", "Listing removed from wishlist!");
    }

    await user.save();

    const referer = req.get("Referrer");
    if (referer && referer.includes("/wishlist")) {
        return res.redirect("/wishlist");
    }

    res.redirect(`/listings/${id}`);
};