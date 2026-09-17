
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

app.use(express.json());


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

// const MONGO_URL = "mongodb://127.0.0.1:27017/wanderlust";
// const dbUrl = process.env.ATLASDB_URL || MONGO_URL;

// const clientPromise = mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 3000 })
//     .then((m) => {
//         console.log("Connected to MongoDB Atlas");
//         return m.connection.getClient();
//     })
//     .catch(async (err) => {
//         console.warn("MongoDB Atlas connection failed (IP may not be whitelisted). Falling back to local MongoDB...");
//         const m = await mongoose.connect(MONGO_URL);
//         console.log("Connected to local MongoDB");
//         return m.connection.getClient();
//     });

// const MONGO_URL = "mongodb://127.0.0.1:27017/wanderlust";

// const dbUrl = process.env.ATLASDB_URL || MONGO_URL;

// console.log("MongoDB URL being used:", dbUrl);

// const clientPromise = mongoose.connect(dbUrl, {
//     serverSelectionTimeoutMS: 5000
// })
//     .then((m) => {
//         console.log("Connected to MongoDB");
//         return m.connection.getClient();
//     })
//     .catch((err) => {
//         console.log("❌ MongoDB connection error:");
//         console.log(err);
//         throw err;
//     });
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

const sessionOptions = {
    store,
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
    }
}

app.use(session(sessionOptions));
app.use(flash());

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
    next();
})

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
