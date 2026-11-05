const { google } = require('googleapis');
const admin = require('firebase-admin');

const formatKey = (key) => {
    if (!key) return "";
    return key.replace(/\\n/g, '\n');
};

if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID || "ignou-web",
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: formatKey(process.env.FIREBASE_PRIVATE_KEY)
            })
        });
    } catch (error) {
        console.error("Firebase Init Error:", error);
    }
}
const db = admin.firestore();

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
        const body = req.body || {};
        const { uid, subjectCode, courseName, price } = body;
        
        if (!uid || !subjectCode) {
             return res.status(400).json({ success: false, message: "User ID ya Subject Code missing hai." });
        }

        const searchCode = subjectCode.trim();

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

        // 2. Google Sheets API setup
        if (!process.env.SHEETS_CLIENT_EMAIL || !process.env.SHEETS_PRIVATE_KEY) {
            return res.status(500).json({ success: false, message: "Vercel Error: SHEETS_CLIENT_EMAIL ya SHEETS_PRIVATE_KEY missing hai." });
        }

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.SHEETS_CLIENT_EMAIL,
                private_key: formatKey(process.env.SHEETS_PRIVATE_KEY),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const sheetId = process.env.SPREADSHEET_ID; 
        if (!sheetId) {
            return res.status(500).json({ success: false, message: "Vercel Error: SPREADSHEET_ID missing hai." });
        }

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:D', 
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Google Sheet khali hai ya read nahi ho pa rahi." });
        }

        // Search Logic
        let fileLink = null;
        for (let i = 0; i < rows.length; i++) {
            const rowCode = rows[i][0] ? rows[i][0].toString().trim().toUpperCase() : "";
            if (rowCode.includes(searchCode.toUpperCase())) {
                fileLink = rows[i][3]; // D column (Link)
                break;
            }
        }

        if (!fileLink) {
            return res.status(404).json({ success: false, message: `${subjectCode} ka link Google Sheet me nahi mila.` });
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
        console.error("API Catch Error:", error);
        return res.status(500).json({ success: false, message: "Server Error: " + error.message });
    }
};
