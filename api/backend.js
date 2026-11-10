const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

if (!admin.apps.length) {
  // Service Account ko code ke andar rakhne ke bajaye Environment Variable se padhenge
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
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
    // 1. DEVICE FOOTPRINT CHECK ON LOGIN
    if (action === 'verify-device' && req.method === 'POST') {
      const { uid, fingerprint, refCode } = req.body;
      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        const myRefCode = 'SHGC' + Math.random().toString(36).substring(2, 7).toUpperCase();
        await userRef.set({
          walletBalance: 0,
          myRefCode,
          referredBy: refCode || null,
          totalPdfsBought: 0,
          referralRewardClaimed: false,
          devices: [fingerprint],
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.status(200).json({ status: 'OK', walletBalance: 0, myRefCode });
      }

      const userData = userDoc.data();
      let devices = userData.devices || [];

      if (!devices.includes(fingerprint)) {
        if (devices.length >= 2) {
          return res.status(403).json({
            error: 'Account Sharing Detected! Aapka account maximum 2 devices par lock hai.'
          });
        }
        devices.push(fingerprint);
        await userRef.update({ devices });
      }

      return res.status(200).json({
        status: 'OK',
        walletBalance: userData.walletBalance || 0,
        myRefCode: userData.myRefCode
      });
    }

    // 2. VALIDATE DAILY DYNAMIC PROMO CODE
    if (action === 'verify-promo' && req.method === 'POST') {
      const { code, cartTotal } = req.body;
      const promoDoc = await db.collection('promo_codes').doc(code.toUpperCase()).get();

      if (!promoDoc.exists || !promoDoc.data().active) {
        return res.status(400).json({ error: 'Invalid ya Expired Promo Code!' });
      }
      const promo = promoDoc.data();
      if (cartTotal < (promo.minAmount || 0)) {
        return res.status(400).json({ error: `Ye code minimum ₹${promo.minAmount} ke order par lagta hai.` });
      }
      return res.status(200).json({ discount: Number(promo.discount), code: code.toUpperCase() });
    }

    // 3. CHECKOUT USING WALLET (With 8-PDF Referral Engine)
    if (action === 'wallet-checkout' && req.method === 'POST') {
      const { uid, fingerprint, itemIds, promoCode } = req.body;

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      const user = userDoc.data();

      if (!user.devices || !user.devices.includes(fingerprint)) {
        return res.status(403).json({ error: 'Unauthorized Device Footprint!' });
      }

      let total = 0;
      const purchasedItems = [];
      for (const id of itemIds) {
        const pdfDoc = await db.collection('pdf_store').doc(id).get();
        if (pdfDoc.exists) {
          const d = pdfDoc.data();
          total += Number(d.price);
          purchasedItems.push({ docId: id, subjectCode: d.subjectCode, subjectName: d.subjectName, price: d.price });
        }
      }

      if (promoCode) {
        const pDoc = await db.collection('promo_codes').doc(promoCode.toUpperCase()).get();
        if (pDoc.exists && pDoc.data().active && total >= (pDoc.data().minAmount || 0)) {
          total = Math.max(0, total - Number(pDoc.data().discount));
        }
      }

      if ((user.walletBalance || 0) < total) {
        return res.status(400).json({ error: 'Wallet mein balance kam hai! Pehle Add Money karein.' });
      }

      const newCount = (user.totalPdfsBought || 0) + purchasedItems.length;
      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      await userRef.update({
        walletBalance: admin.firestore.FieldValue.increment(-total),
        totalPdfsBought: newCount
      });

      await db.collection('wallet_history').add({
        uid,
        type: 'DEBIT',
        amount: total,
        reason: `Purchased ${purchasedItems.length} PDF(s)`,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      for (const item of purchasedItems) {
        await db.collection('orders').add({
          uid,
          docId: item.docId,
          subjectCode: item.subjectCode,
          subjectName: item.subjectName,
          expiresAt: expiresAt.toISOString(),
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      if (user.referredBy && !user.referralRewardClaimed && newCount >= 8) {
        const refQuery = await db.collection('users').where('myRefCode', '==', user.referredBy).limit(1).get();
        if (!refQuery.empty) {
          const referrerDoc = refQuery.docs[0];
          await referrerDoc.ref.update({
            walletBalance: admin.firestore.FieldValue.increment(10)
          });
          await db.collection('wallet_history').add({
            uid: referrerDoc.id,
            type: 'CREDIT',
            amount: 10,
            reason: `Referral Bonus: User completed 8 PDF purchases!`,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
          await userRef.update({ referralRewardClaimed: true });
        }
      }

      return res.status(200).json({ success: true });
    }

    // 4. SECURE GOOGLE DRIVE DOWNLOAD PROXY
    if (action === 'download-pdf' && req.method === 'POST') {
      const { uid, fingerprint, docId } = req.body;
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists || !userDoc.data().devices.includes(fingerprint)) {
        return res.status(403).json({ error: 'Device Lock Mismatch! Access Denied.' });
      }

      const orderSnap = await db.collection('orders')
        .where('uid', '==', uid)
        .where('docId', '==', docId)
        .get();

      if (orderSnap.empty) return res.status(403).json({ error: 'Order not found!' });
      const order = orderSnap.docs[0].data();
      if (new Date(order.expiresAt) < new Date()) {
        return res.status(403).json({ error: '6 Months Download Validity Expired!' });
      }

      const linkDoc = await db.collection('secret_pdf_links').doc(docId).get();
      if (!linkDoc.exists) return res.status(404).json({ error: 'PDF Link not found!' });
      
      const driveFileId = linkDoc.data().fileId || linkDoc.data().driveFileId;
      const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${driveFileId}`;

      return res.status(200).json({ downloadUrl: directDownloadUrl });
    }

    // 5. DASHBOARD DATA
    if (action === 'dashboard-data' && req.method === 'POST') {
      const { uid, fingerprint } = req.body;
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

      const userData = userDoc.data();
      if (!userData.devices || !userData.devices.includes(fingerprint)) {
        return res.status(403).json({ error: 'Device Mismatch!' });
      }

      const ordersSnap = await db.collection('orders').where('uid', '==', uid).get();
      const orders = [];

      for (const doc of ordersSnap.docs) {
        const ord = doc.data();
        let ytLink = "";
        const pdfStoreDoc = await db.collection('pdf_store').doc(ord.docId).get();
        if (pdfStoreDoc.exists) {
          ytLink = pdfStoreDoc.data().ytLink || "";
        }
        orders.push({
          docId: ord.docId,
          subjectCode: ord.subjectCode,
          subjectName: ord.subjectName,
          medium: ord.medium,
          expiresAt: ord.expiresAt,
          ytLink: ytLink
        });
      }

      return res.status(200).json({
        walletBalance: userData.walletBalance || 0,
        myRefCode: userData.myRefCode || '',
        orders: orders
      });
    }

    // 6. CREATE RAZORPAY CART ORDER
    if (action === 'create-cart-order' && req.method === 'POST') {
      const { itemIds, promoCode } = req.body;
      let total = 0;
      for (const id of itemIds) {
        const pdfDoc = await db.collection('pdf_store').doc(id).get();
        if (pdfDoc.exists) total += Number(pdfDoc.data().price);
      }

      if (promoCode) {
        const pDoc = await db.collection('promo_codes').doc(promoCode.toUpperCase()).get();
        if (pDoc.exists && pDoc.data().active && total >= (pDoc.data().minAmount || 0)) {
          total = Math.max(0, total - Number(pDoc.data().discount));
        }
      }

      const order = await razorpay.orders.create({
        amount: total * 100,
        currency: 'INR',
        receipt: `shgc_cart_${Date.now()}`
      });

      return res.status(200).json({ order_id: order.id, amount: order.amount, key: process.env.RAZORPAY_KEY_ID });
    }

    // 7. VERIFY RAZORPAY CART PAYMENT
    if (action === 'verify-cart-payment' && req.method === 'POST') {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, uid, itemIds } = req.body;

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment Signature Mismatch!' });
      }

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      const user = userDoc.data();

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      const newCount = (user.totalPdfsBought || 0) + itemIds.length;
      await userRef.update({ totalPdfsBought: newCount });

      for (const id of itemIds) {
        const pdfDoc = await db.collection('pdf_store').doc(id).get();
        if (pdfDoc.exists) {
          const d = pdfDoc.data();
          await db.collection('orders').add({
            uid,
            docId: id,
            subjectCode: d.subjectCode,
            subjectName: d.subjectName,
            expiresAt: expiresAt.toISOString(),
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      }

      return res.status(200).json({ success: true });
    }

    // 8. CREATE WALLET RECHARGE ORDER
    if (action === 'create-wallet-order' && req.method === 'POST') {
      const { amount } = req.body;
      const order = await razorpay.orders.create({
        amount: Number(amount) * 100,
        currency: 'INR',
        receipt: `wallet_${Date.now()}`
      });
      return res.status(200).json({ order_id: order.id, amount: order.amount, key: process.env.RAZORPAY_KEY_ID });
    }

    // 9. VERIFY WALLET RECHARGE
    if (action === 'verify-wallet-recharge' && req.method === 'POST') {
      const { razorpay_order_id, razorpay_payment_id, uid, amount } = req.body;

      const userRef = db.collection('users').doc(uid);
      await userRef.update({
        walletBalance: admin.firestore.FieldValue.increment(Number(amount))
      });

      await db.collection('wallet_history').add({
        uid,
        type: 'CREDIT',
        amount: Number(amount),
        reason: `Wallet Recharge via Razorpay (${razorpay_payment_id})`,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid Action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
