const User = require("../models/user");
const Listing = require("../models/listing");
const Booking = require("../models/booking");

module.exports.renderSignupForm = (req, res) => {
  res.render("users/signup.ejs");
}

module.exports.signup = async (req, res, next) => {
    try {
      let { username, email, password } = req.body;
      const newUser = new User({ email, username, role: "USER" });
      const registeredUser = await User.register(newUser, password);
      console.log(registeredUser);

      req.login(registeredUser,(err)=>{
        if(err){
          return next(err);
        }
        req.flash("success", "welcome to wanderlust");
      res.redirect("/listings");
      })
      
    } catch (e) {
      req.flash("error", e.message);
      res.redirect("/signup");
    }
  }

  module.exports.renderLoginForm = (req, res) => {
  res.render("users/login.ejs");
}

module.exports.login = async (req, res) => {
    req.flash("success", "welcome back to wanderlust");
    let redirectUrl = res.locals.redirectUrl || "/listings"
    res.redirect(redirectUrl);
  }

  module.exports.logout = (req,res,next)=>{
  req.logout((err)=>{
    if(err){
      return next(err);
    }
    req.flash("success","you are logged out");
    res.redirect("/listings");
  })
}

module.exports.renderWishlist = async (req, res) => {
    const user = await User.findById(req.user._id).populate("wishlist");
    const wishlist = (user && user.wishlist ? user.wishlist : []).filter(listing => listing != null);
    res.render("users/wishlist.ejs", { wishlist });
};

const { toComparableDateTime } = require("../utils/availability.js");

module.exports.renderDashboard = async (req, res) => {
    // Strictly retrieve data using authenticated user ID
    const userId = req.user._id;

    const now = new Date();

    // Parallel database queries for optimal performance
    const [user, userListings, rawBookings] = await Promise.all([
        // Fetch user with populated wishlist items
        User.findById(userId).populate({
            path: "wishlist",
            select: "title location country image price category"
        }),
        // All listings owned by authenticated user (Listing schema ownership field: 'owner')
        Listing.find({ owner: userId })
            .select("title location country price image category")
            .sort({ _id: -1 }),
        // All bookings of the user with populated listing information, sorted newest first
        Booking.find({ user: userId })
            .populate({
                path: "listing",
                select: "title location country image price"
            })
            .sort({ createdAt: -1 })
    ]);

    // Categorize bookings according to exact project definitions:
    // - Upcoming: check-in date/time is in the future and status is not CANCELLED/COMPLETED
    // - Completed: status is COMPLETED
    // - Cancelled: status is CANCELLED
    const allBookings = rawBookings.map(b => {
        const obj = b.toObject();
        const checkInDT = toComparableDateTime(b.checkInDate || b.checkIn, b.checkInTime) || new Date(b.checkInDate || b.checkIn);
        const isFuture = checkInDT > now;

        if (b.status === "CANCELLED") {
            obj.category = "cancelled";
        } else if (b.status === "COMPLETED") {
            obj.category = "completed";
        } else if (isFuture) {
            obj.category = "upcoming";
        } else {
            // Past stay not explicitly marked COMPLETED or CANCELLED
            obj.category = "completed";
        }
        return obj;
    });

    const upcomingBookings = allBookings.filter(b => b.category === "upcoming");
    const completedBookings = allBookings.filter(b => b.category === "completed");
    const cancelledBookings = allBookings.filter(b => b.category === "cancelled");

    // Clean wishlist items
    const wishlist = (user && user.wishlist ? user.wishlist : []).filter(item => item != null);

    // 6 Precise Statistics:
    const counts = {
        totalBookings: allBookings.length,
        upcomingBookings: upcomingBookings.length,
        completedBookings: completedBookings.length,
        cancelledBookings: cancelledBookings.length,
        totalListings: userListings.length,
        wishlistCount: wishlist.length
    };

    res.render("users/dashboard.ejs", {
        user: req.user,
        counts,
        userListings,
        allBookings,
        upcomingBookings,
        completedBookings,
        cancelledBookings,
        wishlist
    });
};

module.exports.renderEditProfileForm = async (req, res) => {
    // Strictly retrieve user from authenticated session
    const user = await User.findById(req.user._id).select("username email");
    if (!user) {
        req.flash("error", "User not found.");
        return res.redirect("/login");
    }
    res.render("users/editProfile.ejs", { user });
};

module.exports.updateProfile = async (req, res, next) => {
    // SECURITY: Always target the authenticated user's ID
    const userId = req.user._id;
    let { username, email } = req.body;

    // 1. Validation: username cannot be empty
    if (!username || typeof username !== "string" || !username.trim()) {
        req.flash("error", "Username cannot be empty.");
        return res.redirect("/profile/edit");
    }

    // 2. Validation: email cannot be empty
    if (!email || typeof email !== "string" || !email.trim()) {
        req.flash("error", "Email cannot be empty.");
        return res.redirect("/profile/edit");
    }

    const cleanUsername = username.trim();
    const cleanEmail = email.trim().toLowerCase();

    // 3. Validation: validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
        req.flash("error", "Please provide a valid email address.");
        return res.redirect("/profile/edit");
    }

    // 4. Respect existing unique constraints & handle duplicate username/email gracefully
    const duplicateUsername = await User.findOne({
        username: cleanUsername,
        _id: { $ne: userId }
    });
    if (duplicateUsername) {
        req.flash("error", "Username is already taken by another user. Please choose a different one.");
        return res.redirect("/profile/edit");
    }

    const duplicateEmail = await User.findOne({
        email: cleanEmail,
        _id: { $ne: userId }
    });
    if (duplicateEmail) {
        req.flash("error", "Email is already registered by another user. Please choose a different one.");
        return res.redirect("/profile/edit");
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            req.flash("error", "User not found.");
            return res.redirect("/login");
        }

        // Only allow editing safe profile fields
        user.username = cleanUsername;
        user.email = cleanEmail;
        await user.save();

        // Re-serialize user into Passport session so session remains valid with updated username
        req.login(user, (err) => {
            if (err) {
                return next(err);
            }
            req.flash("success", "Profile updated successfully!");
            res.redirect("/dashboard");
        });
    } catch (err) {
        if (err.code === 11000) {
            if (err.keyPattern && err.keyPattern.username) {
                req.flash("error", "Username is already taken.");
            } else if (err.keyPattern && err.keyPattern.email) {
                req.flash("error", "Email is already registered.");
            } else {
                req.flash("error", "A user with that username or email already exists.");
            }
            return res.redirect("/profile/edit");
        }
        req.flash("error", err.message || "Failed to update profile.");
        res.redirect("/profile/edit");
    }
};

module.exports.renderBecomeHostForm = async (req, res) => {
    if (req.user.role === "HOST") {
        req.flash("error", "You are already registered as a host!");
        return res.redirect("/dashboard");
    }
    if (req.user.role === "ADMIN") {
        req.flash("error", "Admin accounts cannot be converted to host accounts.");
        return res.redirect("/dashboard");
    }
    res.render("users/becomeHost.ejs");
};

module.exports.becomeHost = async (req, res) => {
    if (req.user.role === "HOST") {
        req.flash("error", "You are already registered as a host!");
        return res.redirect("/dashboard");
    }
    if (req.user.role === "ADMIN") {
        req.flash("error", "Admin accounts cannot be converted to host accounts.");
        return res.redirect("/dashboard");
    }
    if (req.user.role !== "USER") {
        req.flash("error", "Invalid user role.");
        return res.redirect("/dashboard");
    }

    // SECURITY: Always target the authenticated user's ID
    const user = await User.findById(req.user._id);
    if (!user) {
        req.flash("error", "User not found.");
        return res.redirect("/login");
    }

    // Explicitly set role = "HOST" on the backend
    user.role = "HOST";
    await user.save();

    // Keep session user in sync
    req.user.role = "HOST";

    req.flash("success", "Congratulations! You are now a host on WanderLust.");
    res.redirect("/dashboard");
};
