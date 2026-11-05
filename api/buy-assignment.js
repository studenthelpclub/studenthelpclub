const { google } = require('googleapis');
const admin = require('firebase-admin');

// Firebase Admin Setup
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
    });
}
const db = admin.firestore();

module.exports = async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const { uid, subjectCode, courseName, price } = req.body;
    const searchCode = subjectCode.trim();

    try {
        // 1. Check User Wallet Balance
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        if (!userDoc.exists || (userDoc.data().walletBalance || 0) < price) {
            return res.status(400).json({ success: false, message: "Insufficient Balance in Wallet" });
        }

        // 2. Google Sheets API se Link Nikalna
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.SHEETS_CLIENT_EMAIL, // Vercel Variable me aapka telegram-bot wala email aayega
                private_key: process.env.SHEETS_PRIVATE_KEY.replace(/\\n/g, '\n'), // Vercel Variable se aayegi
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // Sheet ID aur Range (A:D columns lenge kyunki screenshot me D me link hai)
        const sheetId = process.env.SPREADSHEET_ID; 
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: 'Sheet1!A:D', // Agar aapki sheet ka tab name alag hai (jaise Sheet2) toh yahan badal dein
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, message: "Assignment list is empty." });
        }

        // Row by row search karna
        let fileLink = null;
        for (let i = 0; i < rows.length; i++) {
            const rowCode = rows[i][0] ? rows[i][0].trim() : "";
            if (rowCode.toUpperCase().includes(searchCode.toUpperCase())) {
                fileLink = rows[i][3]; // D column (index 3) ka link
                break;
            }
        }

        if (!fileLink) {
            return res.status(404).json({ success: false, message: `Link not found in sheet for ${subjectCode}.` });
        }

        // 3. Wallet se Paise Katna aur Order Save Karna
        await userRef.update({ walletBalance: admin.firestore.FieldValue.increment(-price) });

        const orderId = "ORD" + Math.floor(100000 + Math.random() * 900000);
        
        await db.collection("orders").add({
            orderId: orderId,
            uid: uid,
            subjectCode: subjectCode,
            courseName: courseName,
            price: price,
            driveLink: fileLink,
            purchasedAt: Date.now()
        });

        res.status(200).json({ success: true, orderId: orderId });
    } catch (error) {
        console.error("Sheets API Error:", error);
        res.status(500).json({ success: false, message: "Server error, could not fetch link." });
    }
};
