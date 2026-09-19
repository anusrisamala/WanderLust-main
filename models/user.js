const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const passportLocalMongoose = require("passport-local-mongoose");
const userSchema = new Schema({
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        unique: true,
    },
    wishlist: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Listing"
        }
    ],
    role: {
        type: String,
        enum: ["USER", "HOST", "ADMIN"],
        default: "USER"
    }
});
userSchema.plugin(passportLocalMongoose);
module.exports = mongoose.model("User", userSchema);