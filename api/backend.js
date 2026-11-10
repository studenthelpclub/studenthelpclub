const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// CRASH-PROOF FIREBASE INITIALIZATION
function initFirebase() {
  if (!admin.apps.length) {
    let rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!rawEnv) throw new Error('FIREBASE_SERVICE_ACCOUNT env variable is missing in Vercel!');
    
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(rawEnv);
    } catch (e) {
      // Fix multi-line paste issue in Vercel Env Variables
      const cleaned = rawEnv.replace(/\n/g, '\\n').replace(/\\n\s*"/g, '\n"').replace(/{\\n/g, '{\n').replace(/\\n}/g, '\n}');
      serviceAccount = JSON.parse(cleaned);
    }
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  return admin.firestore();
}

module.exports = async (req, res) => {
  // Allow Google Sheet & Frontend Calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const db = initFirebase();
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID || 'missing_key',
      key_secret: process.env.RAZORPAY_KEY_SECRET || 'missing_secret'
    });

    // ====================================================
    // 0. GOOGLE SHEET -> FIREBASE BULK SYNC (Replaces whatsapp with fileId)
    // ====================================================
    if (action === 'sync-from-sheet' && req.method === 'POST') {
      const { items } = req.body;
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'No items received from Google Sheet' });
      }

      // Ek baar mein saare existing pdf_store documents load karo
      const snap = await db.collection('pdf_store').get();
      const existingDocs = [];
      snap.forEach(doc => existingDocs.push({ id: doc.id, ...doc.data() }));

      let batch = db.batch();
      let opCount = 0;
      let updatedCount = 0;
      let createdCount = 0;

      for (const item of items) {
        const cleanCode = String(item.subjectCode || '').trim().toUpperCase();
        const mediumShort = String(item.medium || 'Hindi').trim(); // "Hindi" or "English"
        const mediumFull = mediumShort.toLowerCase().includes('eng') ? 'English Medium' : 'Hindi Medium';
        const fileId = String(item.fileId || '').trim();
        const ytLink = String(item.ytLink || '').trim();

        if (!cleanCode || !fileId) continue;

        // Check karo ki pdf_store mein ye Subject Code pehle se hai ya nahi
        const matches = existingDocs.filter(
          d => String(d.subjectCode || '').trim().toUpperCase() === cleanCode
        );

        // Match medium if exists, OR pick doc that has no medium yet
        let targetDoc = matches.find(d => {
          const m = String(d.medium || '').toLowerCase();
          return m.includes(mediumShort.toLowerCase());
        });

        if (!targetDoc && matches.length > 0) {
          // Agar purane document mein medium set nahi hai, toh pehla match update karo
          targetDoc = matches.find(d => !d.medium || d._usedForSync !== true);
        }

        if (targetDoc) {
          targetDoc._usedForSync = true;
          const docRef = db.collection('pdf_store').doc(targetDoc.id);
          const updateData = {
            fileId: fileId,
            driveId: fileId,
            medium: mediumFull,
            whatsapp: admin.firestore.FieldValue.delete() // WhatsApp link hataya
          };
          if (ytLink) updateData.ytLink = ytLink;

          batch.update(docRef, updateData);
          updatedCount++;
          opCount++;
        } else {
          // Agar ye Subject Code + Medium naya hai toh naya document banao
          const letters = cleanCode.replace(/[^A-Z]/g, '') || 'IGNOU';
          const customDocId = `${cleanCode}_${mediumShort}`.replace(/[^A-Za-z0-9_-]/g, '');
          const newDocRef = db.collection('pdf_store').doc(customDocId);
          batch.set(newDocRef, {
            subjectCode: cleanCode,
            subjectName: `${cleanCode} Solved Assignment (${mediumShort})`,
            courseName: letters,
            courses: [letters],
            medium: mediumFull,
            price: 25,
            session: '2026-27',
            sessions: ['June', 'January'],
            typedPDF: true,
            handwrittenPDF: false,
            fileId: fileId,
            driveId: fileId,
            ytLink: ytLink,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          createdCount++;
          opCount++;
        }

        // Firestore Batch limit is 500
        if (opCount >= 400) {
          await batch.commit();
          batch = db.batch();
          opCount = 0;
        }
      }

      if (opCount > 0) await batch.commit();

      return res.status(200).json({
        success: true,
        updated: updatedCount,
        created: createdCount,
        message: `Updated ${updatedCount} existing PDFs (replaced whatsapp with fileId) & Added ${createdCount} new PDFs!`
      });
    }

    // 1. DEVICE FOOTPRINT CHECK & AUTO-CREATE USER ON LOGIN
    if (action === 'verify-device' && req.method === 'POST') {
      const { uid, fingerprint, refCode } = req.body;
      if (!uid || !fingerprint) return res.status(400).json({ error: 'Invalid data' });

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      const generatedRefCode = 'SHGC' + uid.substring(0, 5).toUpperCase();

      if (!userDoc.exists) {
        await userRef.set({
          walletBalance: 0,
          myRefCode: generatedRefCode,
          referredBy: refCode || null,
          totalPdfsBought: 0,
          referralRewardClaimed: false,
          devices: [fingerprint],
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return res.status(200).json({ status: 'OK', walletBalance: 0, myRefCode: generatedRefCode });
      }

      const userData = userDoc.data();
      let devices = userData.devices || [];
      let myRefCode = userData.myRefCode || generatedRefCode;

      if (!userData.myRefCode) {
        await userRef.update({ myRefCode });
      }

      if (!devices.includes(fingerprint)) {
        if (devices.length >= 2) {
          return res.status(403).json({ error: 'Account Sharing Blocked! Max 2 devices allowed.' });
        }
        devices.push(fingerprint);
        await userRef.update({ devices });
      }

      return res.status(200).json({
        status: 'OK',
        walletBalance: userData.walletBalance || 0,
        myRefCode: myRefCode
      });
    }

    // 2. VALIDATE DAILY DYNAMIC PROMO CODE
    if (action === 'verify-promo' && req.method === 'POST') {
      const { code, cartTotal } = req.body;
      if (!code) return res.status(400).json({ error: 'Enter promo code' });

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

    // 3. CHECKOUT USING WALLET
    if (action === 'wallet-checkout' && req.method === 'POST') {
      const { uid, fingerprint, itemIds, promoCode } = req.body;
      if (!uid || !itemIds || !itemIds.length) return res.status(400).json({ error: 'Cart is empty' });

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
      const user = userDoc.data();

      let total = 0;
      const purchasedItems = [];
      for (const id of itemIds) {
        const pdfDoc = await db.collection('pdf_store').doc(id).get();
        if (pdfDoc.exists) {
          const d = pdfDoc.data();
          total += Number(d.price || 25);
          purchasedItems.push({
            docId: id,
            subjectCode: d.subjectCode || 'IGNOU',
            subjectName: d.subjectName || 'Assignment PDF',
            medium: d.medium || 'Hindi Medium'
          });
        }
      }

      if (promoCode) {
        const pDoc = await db.collection('promo_codes').doc(promoCode.toUpperCase()).get();
        if (pDoc.exists && pDoc.data().active && total >= (pDoc.data().minAmount || 0)) {
          total = Math.max(0, total - Number(pDoc.data().discount));
        }
      }

      if (Number(user.walletBalance || 0) < total) {
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
          medium: item.medium,
          expiresAt: expiresAt.toISOString(),
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      // 8-PDF REFERRAL MILESTONE BONUS (₹10)
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

    // 4. SECURE GOOGLE DRIVE DOWNLOAD PROXY (Matches by docId OR subjectCode + medium)
    if (action === 'download-pdf' && req.method === 'POST') {
      const { uid, docId } = req.body;
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) return res.status(403).json({ error: 'User not found' });

      const orderSnap = await db.collection('orders')
        .where('uid', '==', uid)
        .where('docId', '==', docId)
        .get();

      if (orderSnap.empty) return res.status(403).json({ error: 'Order not found!' });
      const order = orderSnap.docs[0].data();
      if (new Date(order.expiresAt) < new Date()) {
        return res.status(403).json({ error: '6 Months Download Validity Expired!' });
      }

      let fileId = "";

      // Attempt 1: Direct docId match in pdf_store
      const storeDoc = await db.collection('pdf_store').doc(docId).get();
      if (storeDoc.exists) {
        const d = storeDoc.data();
        fileId = d.fileId || d.driveId || d.pdfId;
      }

      // Attempt 2: Match by subjectCode + medium in pdf_store
      if (!fileId && order.subjectCode) {
        const querySnap = await db.collection('pdf_store')
          .where('subjectCode', '==', order.subjectCode)
          .get();

        if (!querySnap.empty) {
          for (const doc of querySnap.docs) {
            const d = doc.data();
            const fId = d.fileId || d.driveId;
            if (fId) {
              fileId = fId;
              if (!order.medium || String(d.medium || '').toLowerCase().includes(String(order.medium).toLowerCase().split(' ')[0])) {
                break;
              }
            }
          }
        }
      }

      if (!fileId) {
        return res.status(404).json({
          error: `Is subject (${order.subjectCode}) ka Drive File ID aapki Google Sheet mein nahi mila!`
        });
      }

      const directDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
      return res.status(200).json({ downloadUrl: directDownloadUrl });
    }

    // 5. DASHBOARD DATA
    if (action === 'dashboard-data' && req.method === 'POST') {
      const { uid, fingerprint } = req.body;
      if (!uid) return res.status(400).json({ error: 'UID missing' });

      const userRef = db.collection('users').doc(uid);
      let userDoc = await userRef.get();
      const generatedRefCode = 'SHGC' + uid.substring(0, 5).toUpperCase();

      if (!userDoc.exists) {
        await userRef.set({
          walletBalance: 0,
          myRefCode: generatedRefCode,
          referredBy: null,
          totalPdfsBought: 0,
          referralRewardClaimed: false,
          devices: [fingerprint || 'default'],
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        userDoc = await userRef.get();
      }

      const userData = userDoc.data();
      let myRefCode = userData.myRefCode || generatedRefCode;
      if (!userData.myRefCode) {
        await userRef.update({ myRefCode });
      }

      const ordersSnap = await db.collection('orders').where('uid', '==', uid).get();
      const orders = [];

      for (const doc of ordersSnap.docs) {
        const ord = doc.data();
        let ytLink = "";
        let subName = ord.subjectName || "";
        const pdfStoreDoc = await db.collection('pdf_store').doc(ord.docId).get();
        if (pdfStoreDoc.exists) {
          const d = pdfStoreDoc.data();
          ytLink = d.ytLink || "";
          subName = subName || d.subjectName || d.rawTitle || "Solved Assignment PDF";
        }
        orders.push({
          docId: ord.docId,
          subjectCode: ord.subjectCode || 'IGNOU',
          subjectName: subName,
          medium: ord.medium || 'Hindi/English',
          expiresAt: ord.expiresAt || new Date().toISOString(),
          ytLink: ytLink
        });
      }

      return res.status(200).json({
        walletBalance: userData.walletBalance || 0,
        myRefCode: myRefCode,
        orders: orders
      });
    }

    // 6. CREATE RAZORPAY CART ORDER
    if (action === 'create-cart-order' && req.method === 'POST') {
      const { itemIds, promoCode } = req.body;
      let total = 0;
      for (const id of itemIds) {
        const pdfDoc = await db.collection('pdf_store').doc(id).get();
        if (pdfDoc.exists) total += Number(pdfDoc.data().price || 25);
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
            subjectName: d.subjectName || d.rawTitle || 'Assignment PDF',
            medium: d.medium || '',
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
      if (!amount || Number(amount) < 10) return res.status(400).json({ error: 'Minimum amount is ₹10' });

      const order = await razorpay.orders.create({
        amount: Number(amount) * 100,
        currency: 'INR',
        receipt: `wallet_${Date.now()}`
      });
      return res.status(200).json({ order_id: order.id, amount: order.amount, key: process.env.RAZORPAY_KEY_ID });
    }

    // 9. VERIFY WALLET RECHARGE
    if (action === 'verify-wallet-recharge' && req.method === 'POST') {
      const { razorpay_payment_id, uid, amount } = req.body;
      if (!uid || !amount) return res.status(400).json({ error: 'Invalid details' });

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
    console.error('Backend Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
