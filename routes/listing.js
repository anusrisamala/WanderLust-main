const express = require("express");
const router = express.Router();
const wrapAsync = require("../utils/wrapAsync.js");

const Listing = require("../models/listing.js");
const {isLoggedIn, isOwner, validateListing, isHost} = require("../middleware.js");

const listingController = require("../controllers/listings.js");
const bookingController = require("../controllers/bookings.js");
const multer = require('multer')
const {storage} = require("../cloudConfig.js");
const upload = multer({storage})

router
    .route("/")
    //index route
    .get(wrapAsync(listingController.index))
    //create route
    .post(isHost,upload.single("listing[image]") ,validateListing,wrapAsync(listingController.createListing))
    // .post(upload.single("listing[image]"),(req,res)=>{
    //     res.send(req.file);
    // })

//new route
router.get("/new",isHost,listingController.renderNewForm);

//search route
router.get("/search", wrapAsync(listingController.searchListings));

// general availability check route (with listingId in query or body)
router.route("/availability")
    .get(wrapAsync(bookingController.checkAvailability))
    .post(wrapAsync(bookingController.checkAvailability));

router.route("/:id")
    //show route
    .get(wrapAsync(listingController.showListing))
    //update
    .put(isLoggedIn,isOwner,upload.single("listing[image]"), validateListing,wrapAsync(listingController.updateListing))
    //delete route
    .delete(isLoggedIn ,isOwner, wrapAsync(listingController.destroyListing))
    

// availability check route for listing
router.route("/:id/availability")
    .get(wrapAsync(bookingController.checkAvailability))
    .post(wrapAsync(bookingController.checkAvailability));

//wishlist toggle route
router.post("/:id/wishlist", isLoggedIn, wrapAsync(listingController.toggleWishlist));

//booking creation route
router.post("/:id/bookings", isLoggedIn, wrapAsync(bookingController.createBooking));

//edit route
router.get("/:id/edit",isLoggedIn ,isOwner, wrapAsync(listingController.renderEditForm))


module.exports = router;