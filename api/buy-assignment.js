const { google } = require('googleapis');
const admin = require('firebase-admin');

// Private Key Format Fixer
const formatKey = (key) => {
    if (!key) return "";
    return key.replace(/\\n/g, '\n');
};

// Firebase Admin Setup
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
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
    // CORS Setup
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Always ensure JSON response
    res.setHeader('Content-Type', 'application/json');

    if (req.method !== "POST") {
        return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }

    const { uid, subjectCode, courseName, price } = req.body;
    
    if (!uid || !subjectCode) {
         return res.status(400).json({ success: false, message: "User ID ya Subject Code missing hai." });
    }

    const searchCode = subjectCode.trim();

    try {
        // 1. Check User Wallet Balance
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ success: false, message: "User database me nahi mila." });
        }

        const currentBalance = userDoc.data().walletBalance || 0;
        if (currentBalance < price) {
            return res.status(400).json({ success: false, message: `Insufficient Balance! Aapke paas ₹${currentBalance} hain, par chahiye ₹${price}.` });
        }

        // 2. Google Sheets API setup
        if (!process.env.SHEETS_CLIENT_EMAIL || !process.env.SHEETS_PRIVATE_KEY) {
            return res.status(500).json({ success: false, message: "Vercel Variables missing: SHEETS_CLIENT_EMAIL ya SHEETS_PRIVATE_KEY." });
        }

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.SHEETS_CLIENT_EMAIL,
                private_key: formatKey(process.env.SHEETS_PRIVATE_KEY),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // Sheet ID Check
        const sheetId = process.env.SPREADSHEET_ID; 
        if (!sheetId) {
            return res.status(500).json({ success: false, message: "Vercel Variable missing: SPREADSHEET_ID." });
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
                fileLink = rows[i][3]; // D column
                break;
            }
        }

        if (!fileLink) {
            return res.status(404).json({ success: false, message: `${subjectCode} ka link Google Sheet me nahi mila.` });
        }

        // 3. Deduct Wallet & Save Order
        await userRef.update({ walletBalance: admin.firestore.FieldValue.increment(-price) });

        const orderId = "ORD" + Math.floor(100000 + Math.random() * 900000);
        
        await db.collection("orders").add({
            orderId: orderId,
            uid: uid,
            subjectCode: subjectCode,
            courseName: courseName || "N/A",
            price: price,
            driveLink: fileLink,
            purchasedAt: Date.now()
        });

        return res.status(200).json({ success: true, orderId: orderId });
        
    } catch (error) {
        console.error("API Error Details:", error);
        return res.status(500).json({ success: false, message: "Server API error: " + error.message });
    }
};
