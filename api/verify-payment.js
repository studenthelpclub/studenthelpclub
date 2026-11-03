const crypto = require("crypto");
const admin = require("firebase-admin");

// Firebase Admin initialization logic yaha add karein (Service account JSON ke sath)

module.exports = async (req, res) => {
    if (req.method === "POST") {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, uid, amount } = req.body;

        const sign = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSign = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(sign.toString())
            .digest("hex");

        if (razorpay_signature === expectedSign) {
            // Firebase Firestore me user document update karne ka logic
            // db.collection('users').doc(uid).update({ walletBalance: admin.firestore.FieldValue.increment(amount) })
            res.status(200).json({ success: true, message: "Payment verified" });
        } else {
            res.status(400).json({ success: false, message: "Invalid signature" });
        }
    }
};
