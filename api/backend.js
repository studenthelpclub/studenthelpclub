const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

function initFirebase() {
  if (!admin.apps.length) {
    let rawEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!rawEnv) throw new Error('FIREBASE_SERVICE_ACCOUNT env variable is missing in Vercel!');
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(rawEnv);
    } catch (e) {
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
    // 0. SMART SHEET SYNC: 1 CARD PER SUBJECT + MERGE HINDI/ENGLISH + DELETE DUPLICATES
    // ====================================================
    if (action === 'sync-from-sheet' && req.method === 'POST') {
      const { items } = req.body;
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'No items received from Google Sheet' });
      }

      const grouped = {};
      for (const item of items) {
        const cleanCode = String(item.subjectCode || '').trim().toUpperCase();
        const mediumShort = String(item.medium || 'Hindi').trim().toLowerCase();
        const fileId = String(item.fileId || '').trim();
        const ytLink = String(item.ytLink || '').trim();

        if (!cleanCode || !fileId) continue;

        if (!grouped[cleanCode]) {
          grouped[cleanCode] = {
            subjectCode: cleanCode,
            mediums: [],
            hindiFileId: '',
            englishFileId: '',
            ytLink: '',
            hindiYtLink: '',
            englishYtLink: ''
          };
        }

        if (mediumShort.includes('eng')) {
          if (!grouped[cleanCode].mediums.includes('English Medium')) {
            grouped[cleanCode].mediums.push('English Medium');
          }
          grouped[cleanCode].englishFileId = fileId;
          if (ytLink) grouped[cleanCode].englishYtLink = ytLink;
        } else {
          if (!grouped[cleanCode].mediums.includes('Hindi Medium')) {
            grouped[cleanCode].mediums.push('Hindi Medium');
          }
          grouped[cleanCode].hindiFileId = fileId;
          if (ytLink) grouped[cleanCode].hindiYtLink = ytLink;
        }

        if (ytLink && !grouped[cleanCode].ytLink) {
          grouped[cleanCode].ytLink = ytLink;
        }
      }

      const snap = await db.collection('pdf_store').get();
      const existingByCode = {};
      snap.forEach(doc => {
        const d = doc.data();
        const code = String(d.subjectCode || '').trim().toUpperCase();
        if (!code) return;
        if (!existingByCode[code]) existingByCode[code] = [];
        existingByCode[code].push({ id: doc.id, ...d });
      });

      let batch = db.batch();
      let opCount = 0;
      let mergedSubjects = 0;
      let deletedDuplicates = 0;

      for (const code of Object.keys(grouped)) {
        const g = grouped[code];
        const existingList = existingByCode[code] || [];
        const letters = code.replace(/[^A-Z]/g, '') || 'IGNOU';

        let primaryDoc = existingList.find(d => !d.id.endsWith('_Hindi') && !d.id.endsWith('_English')) || existingList[0];
        const targetDocId = primaryDoc ? primaryDoc.id : code.replace(/[^A-Za-z0-9_-]/g, '');
        const docRef = db.collection('pdf_store').doc(targetDocId);

        const payload = {
          subjectCode: code,
          subjectName: (primaryDoc && primaryDoc.subjectName && !primaryDoc.subjectName.includes('Solved Assignment ('))
            ? primaryDoc.subjectName
            : `${code} Solved Assignment`,
          courseName: (primaryDoc && primaryDoc.courseName) ? primaryDoc.courseName : letters,
          courses: (primaryDoc && Array.isArray(primaryDoc.courses) && primaryDoc.courses.length) ? primaryDoc.courses : [letters],
          price: (primaryDoc && primaryDoc.price) ? Number(primaryDoc.price) : 25,
          mediums: g.mediums,
          medium: g.mediums[0] || 'Hindi Medium',
          sessions: ['June', 'December'],
          session: 'June',
          typedPDF: true,
          hindiFileId: g.hindiFileId || (primaryDoc && primaryDoc.hindiFileId) || '',
          englishFileId: g.englishFileId || (primaryDoc && primaryDoc.englishFileId) || '',
          fileId: g.hindiFileId || g.englishFileId || '',
          driveId: g.hindiFileId || g.englishFileId || '',
          ytLink: g.ytLink || (primaryDoc && primaryDoc.ytLink) || '',
          hindiYtLink: g.hindiYtLink || '',
          englishYtLink: g.englishYtLink || '',
          whatsapp: admin.firestore.FieldValue.delete()
        };

        batch.set(docRef, payload, { merge: true });
        opCount++;
        mergedSubjects++;

        for (const oldDoc of existingList) {
          if (oldDoc.id !== targetDocId) {
            batch.delete(db.collection('pdf_store').doc(oldDoc.id));
            opCount++;
            deletedDuplicates++;
          }
        }

        if (opCount >= 400) {
          await batch.commit();
          batch = db.batch();
          opCount = 0;
        }
      }

      if (opCount > 0) await batch.commit();

      return res.status(200).json({
        success: true,
        mergedSubjects,
        deletedDuplicates,
        message: `Synced ${mergedSubjects} unique subjects & removed ${deletedDuplicates} duplicate cards!`
      });
    }

    // 0.1 COMPLETE PROFILE (Saves Name, Mobile, Shop Owner status)
    if (action === 'complete-profile' && req.method === 'POST') {
      const { uid, email, name, mobile, isShopOwner, fingerprint, refCode } = req.body;
      const userRef = db.collection('users').doc(uid);
      const generatedRefCode = 'SHGC' + uid.substring(0, 5).toUpperCase();

      await userRef.set({
        email: email || '',
        name: name || '',
        mobile: mobile || '',
        isShopOwner: Boolean(isShopOwner),
        walletBalance: 0,
        myRefCode: generatedRefCode,
        referredBy: refCode || null,
        totalPdfsBought: 0,
        referralRewardClaimed: false,
        devices: [fingerprint || 'default'],
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      return res.status(200).json({ success: true });
    }

    // 1. DEVICE FOOTPRINT CHECK & AUTO-CREATE USER ON LOGIN
    if (action === 'verify-device' && req.method === 'POST') {
      const { uid, fingerprint } = req.body;
      if (!uid || !fingerprint) return res.status(400).json({ error: 'Invalid data' });

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        return res.status(200).json({ isNewUser: true, hasProfile: false });
      }

      const userData = userDoc.data();
      if (!userData.name || !userData.mobile) {
        return res.status(200).json({ isNewUser: false, hasProfile: false });
      }

      let devices = userData.devices || [];
      if (!devices.includes(fingerprint)) {
        if (devices.length >= 2) {
          return res.status(403).json({ error: 'Account Sharing Blocked! Max 2 devices allowed.' });
        }
        devices.push(fingerprint);
        await userRef.update({ devices });
      }

      return res.status(200).json({
        status: 'OK',
        hasProfile: true,
        walletBalance: userData.walletBalance || 0,
        myRefCode: userData.myRefCode
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

    // 3. CHECKOUT USING WALLET (Saves exact selected Medium & Session)
    if (action === 'wallet-checkout' && req.method === 'POST') {
      const { uid, itemIds, items, promoCode } = req.body;
      const cartList = Array.isArray(items) && items.length
        ? items
        : (Array.isArray(itemIds) ? itemIds.map(id => ({ id })) : []);

      if (!uid || !cartList.length) return res.status(400).json({ error: 'Cart is empty' });

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
      const user = userDoc.data();

      let total = 0;
      const purchasedItems = [];
      for (const cItem of cartList) {
        const pdfDoc = await db.collection('pdf_store').doc(cItem.id).get();
        if (pdfDoc.exists) {
          const d = pdfDoc.data();
          total += Number(d.price || 25);
          purchasedItems.push({
            docId: cItem.id,
            subjectCode: d.subjectCode || 'IGNOU',
            subjectName: d.subjectName || 'Assignment PDF',
            medium: cItem.medium || d.medium || 'Hindi Medium',
            session: cItem.session || 'June'
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
          session: item.session,
          expiresAt: expiresAt.toISOString(),
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      if (user.referredBy && !user.referralRewardClaimed && newCount >= 8) {
        const refQuery = await db.collection('users').where('myRefCode', '==', user.referredBy).limit(1).get();
        if (!refQuery.empty) {
          const referrerDoc = refQuery.docs[0];
          await referrerDoc.ref.update({ walletBalance: admin.firestore.FieldValue.increment(10) });
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

    // 4. SECURE GOOGLE DRIVE DOWNLOAD PROXY (Picks Hindi or English File ID based on Order)
    if (action === 'download-pdf' && req.method === 'POST') {
      const { uid, docId, medium } = req.body;
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

      const wantedMedium = String(medium || order.medium || 'Hindi').toLowerCase();
      let fileId = "";

      const storeDoc = await db.collection('pdf_store').doc(docId).get();
      if (storeDoc.exists) {
        const d = storeDoc.data();
        if (wantedMedium.includes('eng')) fileId = d.englishFileId || d.fileId || d.driveId;
        else fileId = d.hindiFileId || d.fileId || d.driveId;
      }

      if (!fileId) return res.status(404).json({ error: 'Drive File ID not found!' });

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
      if (!userData.myRefCode) await userRef.update({ myRefCode });

      const ordersSnap = await db.collection('orders').where('uid', '==', uid).get();
      const orders = [];

      for (const doc of ordersSnap.docs) {
        const ord = doc.data();
        let ytLink = "";
        let subName = ord.subjectName || "";
        const pdfStoreDoc = await db.collection('pdf_store').doc(ord.docId).get();
        if (pdfStoreDoc.exists) {
          const d = pdfStoreDoc.data();
          ytLink = (String(ord.medium || '').toLowerCase().includes('eng') ? d.englishYtLink : d.hindiYtLink) || d.ytLink || "";
          subName = subName || d.subjectName || "Solved Assignment PDF";
        }
        orders.push({
          docId: ord.docId,
          subjectCode: ord.subjectCode || 'IGNOU',
          subjectName: subName,
          medium: ord.medium || 'Hindi Medium',
          session: ord.session || 'June',
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
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, uid, itemIds, items } = req.body;

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Payment Signature Mismatch!' });
      }

      const cartList = Array.isArray(items) && items.length
        ? items
        : (Array.isArray(itemIds) ? itemIds.map(id => ({ id })) : []);

      const userRef = db.collection('users').doc(uid);
      const userDoc = await userRef.get();
      const user = userDoc.data();

      const expiresAt = new Date();
      expiresAt.setMonth(expiresAt.getMonth() + 6);

      const newCount = (user.totalPdfsBought || 0) + cartList.length;
      await userRef.update({ totalPdfsBought: newCount });

      for (const cItem of cartList) {
        const pdfDoc = await db.collection('pdf_store').doc(cItem.id).get();
        if (pdfDoc.exists) {
          const d = pdfDoc.data();
          await db.collection('orders').add({
            uid,
            docId: cItem.id,
            subjectCode: d.subjectCode,
            subjectName: d.subjectName || 'Assignment PDF',
            medium: cItem.medium || d.medium || 'Hindi Medium',
            session: cItem.session || 'June',
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
