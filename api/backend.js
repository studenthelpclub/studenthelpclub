const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

module.exports = async (req, res) => {
  const { action } = req.query;

  try {
    // 1. Create Razorpay Order (Aapke pdf_store se exact price lekar)
    if (action === 'create-order' && req.method === 'POST') {
      const { docId } = req.body; // e.g., "09EfflwJBfcypdzSRODZ"
      const doc = await db.collection('pdf_store').doc(docId).get();
      if (!doc.exists) return res.status(404).json({ error: 'Assignment not found' });

      const item = doc.data();
      const order = await razorpay.orders.create({
        amount: Number(item.price) * 100, // 25 Rs -> 2500 paise
        currency: 'INR',
        receipt: `shgc_${Date.now()}`
      });

      return res.status(200).json({
        order_id: order.id,
        amount: order.amount,
        key: process.env.RAZORPAY_KEY_ID,
        subjectCode: item.subjectCode,
        subjectName: item.subjectName
      });
    }

    // 2. Verify Payment + Lock Device Digital Footprint + Save for 6 Months
    if (action === 'verify-payment' && req.method === 'POST') {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, docId, phone, fingerprint } = req.body;

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment Verification Failed!' });
      }

      // pdf_store se details aur secret pdf_links se PDF URL nikalo
      const itemDoc = await db.collection('pdf_store').doc(docId).get();
      const item = itemDoc.data();
      
      const secretDoc = await db.collection('pdf_links').doc(docId).get();
      const pdfUrl = secretDoc.exists ? secretDoc.data().pdfUrl : item.pdfUrl;

      // 6 Months Expiry
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      // Save Order in Firestore 'orders' collection
      await db.collection('orders').doc(razorpay_payment_id).set({
        phone,
        docId,
        subjectCode: item.subjectCode,
        subjectName: item.subjectName,
        session: item.session,
        price: item.price,
        pdfUrl: pdfUrl,
        paymentId: razorpay_payment_id,
        device_fingerprints: [fingerprint], // 1st Device Locked
        expiresAt: expiresAt.toISOString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(200).json({ success: true, download_url: pdfUrl });
    }

    // 3. My Orders: Re-download for 6 Months (Strict Device Lock Check)
    if (action === 'my-orders' && req.method === 'POST') {
      const { phone, fingerprint } = req.body;
      const snapshot = await db.collection('orders').where('phone', '==', phone).get();

      if (snapshot.empty) {
        return res.status(404).json({ error: 'Is mobile number par koi order nahi mila.' });
      }

      const results = [];
      for (const doc of snapshot.docs) {
        const ord = doc.data();

        // 6-Month Expiry Check
        if (new Date(ord.expiresAt) < new Date()) {
          results.push({
            subjectCode: ord.subjectCode,
            subjectName: ord.subjectName,
            status: 'EXPIRED',
            message: '6 Mahine ki validity khatam ho chuki hai.'
          });
          continue;
        }

        // Device Digital Footprint Check (Max 2 Devices Allowed: e.g., Phone + Laptop)
        let devices = ord.device_fingerprints || [];
        if (!devices.includes(fingerprint)) {
          if (devices.length >= 2) {
            results.push({
              subjectCode: ord.subjectCode,
              subjectName: ord.subjectName,
              status: 'BLOCKED',
              message: 'Account Sharing Blocked! Ye PDF original buyer ke device par lock hai.'
            });
            continue;
          } else {
            devices.push(fingerprint);
            await db.collection('orders').doc(doc.id).update({ device_fingerprints: devices });
          }
        }

        results.push({
          subjectCode: ord.subjectCode,
          subjectName: ord.subjectName,
          status: 'ACTIVE',
          download_url: ord.pdfUrl,
          expiresOn: new Date(ord.expiresAt).toLocaleDateString('en-IN')
        });
      }

      return res.status(200).json({ orders: results });
    }

    return res.status(400).json({ error: 'Invalid Request' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
