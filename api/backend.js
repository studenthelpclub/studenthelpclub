const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Firebase Initialize (Vercel ENV variable se)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET // e.g. your-app.appspot.com
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
    // 1. Razorpay Order Create Karna (Aapke existing Firebase collection se price lekar)
    if (action === 'create-order' && req.method === 'POST') {
      const { assignment_id } = req.body;
      const doc = await db.collection('assignments').doc(assignment_id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Assignment not found' });

      const item = doc.data();
      const order = await razorpay.orders.create({
        amount: Number(item.price) * 100, // Paise mein
        currency: 'INR',
        receipt: `shgc_${Date.now()}`
      });
      return res.status(200).json({ order_id: order.id, amount: order.amount, key: process.env.RAZORPAY_KEY_ID });
    }

    // 2. Payment Verify + Device Footprint Lock + 6 Month Validity Save Karna
    if (action === 'verify-payment' && req.method === 'POST') {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, assignment_id, phone, fingerprint } = req.body;

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid Payment Signature' });
      }

      const doc = await db.collection('assignments').doc(assignment_id).get();
      const item = doc.data();

      // 6 Mahine baad ki expiry date set karna
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      // Firebase 'orders' collection mein save karna
      await db.collection('orders').doc(razorpay_payment_id).set({
        phone,
        subject_code: item.code || item.title,
        pdf_url: item.pdfUrl || item.pdf_url, // Aapke Firebase mein jo field name hai
        payment_id: razorpay_payment_id,
        device_fingerprints: [fingerprint], // First Device Locked
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString()
      });

      return res.status(200).json({ success: true, download_url: item.pdfUrl || item.pdf_url });
    }

    // 3. My Orders: 6-Month Re-Download + Device Footprint Verification
    if (action === 'my-orders' && req.method === 'POST') {
      const { phone, fingerprint } = req.body;
      const snapshot = await db.collection('orders').where('phone', '==', phone).get();

      if (snapshot.empty) {
        return res.status(404).json({ error: 'Is mobile number par koi order nahi mila.' });
      }

      const validOrders = [];
      for (const doc of snapshot.docs) {
        const ord = doc.data();

        // Check 1: 6-Month Expiry
        if (new Date(ord.expires_at) < new Date()) {
          validOrders.push({ subject_code: ord.subject_code, status: 'Expired (6 Months Over)' });
          continue;
        }

        // Check 2: Device Digital Footprint (Max 2 devices per student)
        let devices = ord.device_fingerprints || [];
        if (!devices.includes(fingerprint)) {
          if (devices.length >= 2) {
            validOrders.push({
              subject_code: ord.subject_code,
              status: 'BLOCKED: Account sharing detected! Ye order dusre device par lock hai.'
            });
            continue;
          } else {
            devices.push(fingerprint);
            await db.collection('orders').doc(doc.id).update({ device_fingerprints: devices });
          }
        }

        validOrders.push({
          subject_code: ord.subject_code,
          status: 'Active',
          download_url: ord.pdf_url,
          expires: new Date(ord.expires_at).toLocaleDateString()
        });
      }

      return res.status(200).json({ orders: validOrders });
    }

    return res.status(400).json({ error: 'Invalid Action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
