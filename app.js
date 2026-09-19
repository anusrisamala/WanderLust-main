
if (process.env.NODE_ENV != "production") {
    require("dotenv").config();
}

const express = require("express");
const app = express();
const mongoose = require("mongoose");
const path = require("path");
const methodOverride = require("method-override");
const ejsMate = require('ejs-mate');
const ExpressError = require("./utils/ExpressError.js");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const flash = require("connect-flash");
const passport = require("passport");
const localStrategy = require("passport-local");
const User = require("./models/user.js");
const { TAX_CONFIG } = require("./utils/constants.js");
const { csrfProtection, helmetConfig } = require("./utils/security.js");

// Trust first proxy when deployed behind reverse proxy (Heroku, Render, Nginx, AWS ALB)
app.set("trust proxy", 1);

// HTTP Security Headers and Content Security Policy (CSP)
app.use(helmetConfig);

app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));


app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.engine('ejs', ejsMate);
app.use(express.static(path.join(__dirname, "/public")));

const listingRouter = require("./routes/listing.js");
const reviewRouter = require("./routes/review.js");
const userRouter = require("./routes/user.js");
const bookingRouter = require("./routes/booking.js");

const MONGO_URL = "mongodb://127.0.0.1:27017/wanderlust";

const dbUrl = process.env.ATLASDB_URL || MONGO_URL;

const clientPromise = mongoose.connect(dbUrl, {
    serverSelectionTimeoutMS: 5000
})
    .then((m) => {
        console.log("Connected to MongoDB");
        return m.connection.getClient();
    })
    .catch((err) => {
        console.log("MongoDB connection error:", err);
        throw err;
    });

const store = MongoStore.create({
    clientPromise,
    crypto: {
        secret: process.env.SECRET,
    },
    touchAfter: 24 * 60 * 60,
});

store.on("error", (err) => {
    console.log("Error in MongoStore", err);
});

const isProduction = process.env.NODE_ENV === "production";
const sessionOptions = {
    store,
    name: "__wl_sess", // Custom session cookie name to avoid framework fingerprinting
    secret: process.env.SECRET || "wanderlust_default_session_secret",
    resave: false,
    saveUninitialized: false, // Prevents storing empty unauthenticated sessions
    proxy: isProduction,
    cookie: {
        expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true, // Defends against XSS cookie theft
        secure: isProduction, // HTTPS-only transmission in production
        sameSite: "lax", // Protects against cross-site request forgery
    }
};

app.use(session(sessionOptions));
app.use(flash());

// CSRF Protection Middleware (after session and before state-changing routes)
app.use(csrfProtection);

app.use(passport.initialize());
app.use(passport.session());
passport.use(new localStrategy(User.authenticate()));

passport.serializeUser(User.serializeUser());
passport.deserializeUser(User.deserializeUser());

app.use((req, res, next) => {
    res.locals.success = req.flash("success");
    res.locals.error = req.flash("error");
    res.locals.currUser = req.user;
    res.locals.taxConfig = TAX_CONFIG;
    res.locals.csrfToken = req.session?.csrfToken || "";
    next();
});

app.get("/", (req, res) => {
    res.redirect("/listings");
});

app.use("/listings", listingRouter);
app.use("/listings/:id/reviews", reviewRouter);
app.use("/bookings", bookingRouter);
app.use("/", userRouter);

app.use((req, res, next) => {
    next(new ExpressError(404, "Page Not Found!"));
});
app.use((err, req, res, next) => {
    let { statusCode = 500, message = "something went wrong" } = err;
    if (!res.locals.currUser) res.locals.currUser = req.user || null;
    if (!res.locals.success) res.locals.success = [];
    if (!res.locals.error) res.locals.error = [];
    res.status(statusCode).render("Error.ejs", { err });
})

app.listen(8080, () => {
    console.log("server is listening to port 8080");
});
