const Razorpay = require("razorpay");

module.exports = async (req, res) => {
    if (req.method === "POST") {
        const instance = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET,
        });

        try {
            const options = {
                amount: req.body.amount * 100, // Amount paise me hota hai
                currency: "INR",
                receipt: "receipt_" + Math.random().toString(36).substring(7),
            };
            const order = await instance.orders.create(options);
            res.status(200).json(order);
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
};
