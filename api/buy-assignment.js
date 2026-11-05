const admin = require('firebase-admin');

const formatKey = (key) => {
    if (!key) return "";
    return key.replace(/\\n/g, '\n').replace(/"/g, '').trim();
};

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }

    try {
        const privateKey = formatKey(process.env.SHEETS_PRIVATE_KEY || process.env.FIREBASE_PRIVATE_KEY);
        const clientEmail = process.env.SHEETS_CLIENT_EMAIL || process.env.FIREBASE_CLIENT_EMAIL;
        const projectId = process.env.FIREBASE_PROJECT_ID || "ignou-web";

        if (!privateKey || !clientEmail) {
            return res.status(500).json({ success: false, message: "Error: Firebase Credentials missing in Vercel." });
        }

        // Firebase Initialization
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: projectId,
                    clientEmail: clientEmail,
                    privateKey: privateKey
                })
            });
        }
        const db = admin.firestore();

        const body = req.body || {};
        const { uid, subjectCode, courseName, price, driveLink } = body;
        
        if (!uid || !subjectCode) {
             return res.status(400).json({ success: false, message: "User ID ya Subject Code missing hai." });
        }

        // 1. Check User Wallet Balance
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: "User database me nahi mila." });
        }

        const currentBalance = userDoc.data().walletBalance || 0;
        const itemPrice = Number(price) || 50;

        if (currentBalance < itemPrice) {
            return res.status(400).json({ success: false, message: `Insufficient Balance! Aapke paas ₹${currentBalance} hain, par chahiye ₹${itemPrice}.` });
        }

        // 2. Get Drive Link directly from Firestore store or fallback
        let fileLink = driveLink;
        if (!fileLink) {
            // Firestore ke pdf_store se dhoondh lenge agar body me nahi aaya
            const storeSnap = await db.collection('pdf_store').where("subjectCode", "==", subjectCode).get();
            if (!storeSnap.empty) {
                fileLink = storeSnap.docs[0].data().driveLink || storeSnap.docs[0].data().link;
            }
        }

        if (!fileLink) {
            fileLink = "https://wa.me/919776986830?text=Hello,%20mainey%20" + subjectCode + "%20buy%20kiya%20hai%20lekin%20link%20nahi%20mila.";
        }

        // 3. Deduct Wallet & Save Order
        await userRef.update({ walletBalance: admin.firestore.FieldValue.increment(-itemPrice) });

        const orderId = "ORD" + Math.floor(100000 + Math.random() * 900000);
        
        await db.collection("orders").add({
            orderId: orderId,
            uid: uid,
            subjectCode: subjectCode,
            courseName: courseName || "N/A",
            price: itemPrice,
            driveLink: fileLink,
            purchasedAt: Date.now()
        });

        return res.status(200).json({ success: true, orderId: orderId });
        
    } catch (error) {
        console.error("API Execution Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
};
