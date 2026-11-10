const { createClient } = require('@supabase/supabase-js');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

module.exports = async (req, res) => {
  const { action } = req.query;

  try {
    // 1. Saare Assignments Dikhana (Public)
    if (action === 'list') {
      const { data, error } = await supabase
        .from('assignments')
        .select('id, code, title, course, medium, session, price')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json(data);
    }

    // 2. Razorpay Order Create Karna
    if (action === 'create-order' && req.method === 'POST') {
      const { assignment_id } = req.body;
      const { data: item } = await supabase.from('assignments').select('*').eq('id', assignment_id).single();
      if (!item) return res.status(404).json({ error: 'Assignment not found' });

      const order = await razorpay.orders.create({
        amount: item.price * 100, // Paise mein
        currency: 'INR',
        receipt: `shgc_${Date.now()}`
      });
      return res.status(200).json({ order_id: order.id, amount: order.amount, key: process.env.RAZORPAY_KEY_ID, item });
    }

    // 3. Payment Verify + First Device Footprint Lock Karna
    if (action === 'verify-payment' && req.method === 'POST') {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, assignment_id, phone, fingerprint } = req.body;

      const body = razorpay_order_id + "|" + razorpay_payment_id;
      const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid Payment Signature' });
      }

      const { data: item } = await supabase.from('assignments').select('*').eq('id', assignment_id).single();

      // Order save karo aur Device Footprint lock karo
      const { data: orderData, error } = await supabase.from('orders').insert([{
        phone,
        subject_code: item.code,
        pdf_path: item.pdf_path,
        payment_id: razorpay_payment_id,
        device_fingerprints: [fingerprint],
        download_count: 1
      }]).select().single();

      if (error) throw error;

      // Private Bucket se 60-sec Instant Download Stream Link nikalo
      const { data: signedUrl } = await supabase.storage.from('pdfs').createSignedUrl(item.pdf_path, 120);
      return res.status(200).json({ success: true, download_url: signedUrl.signedUrl, order_id: orderData.id });
    }

    // 4. My Orders (6-Month Re-Download + Strict Device Footprint Check)
    if (action === 'my-orders' && req.method === 'POST') {
      const { phone, fingerprint } = req.body;
      const { data: orders } = await supabase.from('orders').select('*').eq('phone', phone);

      if (!orders || orders.length === 0) {
        return res.status(404).json({ error: 'Is mobile number par koi order nahi mila.' });
      }

      const validOrders = [];
      for (const ord of orders) {
        // Check 6-Month Expiry
        if (new Date(ord.expires_at) < new Date()) {
          validOrders.push({ subject_code: ord.subject_code, status: 'Expired (6 Months Over)' });
          continue;
        }

        let devices = ord.device_fingerprints || [];
        // Check Device Footprint (Max 2 devices allowed per buyer)
        if (!devices.includes(fingerprint)) {
          if (devices.length >= 2) {
            validOrders.push({
              subject_code: ord.subject_code,
              status: 'BLOCKED: Account sharing detected! Ye order dusre device par lock hai.'
            });
            continue;
          } else {
            devices.push(fingerprint);
            await supabase.from('orders').update({ device_fingerprints: devices }).eq('id', ord.id);
          }
        }

        const { data: signedUrl } = await supabase.storage.from('pdfs').createSignedUrl(ord.pdf_path, 120);
        validOrders.push({
          subject_code: ord.subject_code,
          status: 'Active',
          download_url: signedUrl.signedUrl,
          expires: new Date(ord.expires_at).toLocaleDateString()
        });
      }

      return res.status(200).json({ orders: validOrders });
    }

    // 5. Admin Panel: Add Assignment
    if (action === 'admin-add' && req.method === 'POST') {
      const { admin_password, code, title, course, medium, session, price, pdf_path } = req.body;
      if (admin_password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Wrong Admin Password!' });
      }
      const { error } = await supabase.from('assignments').insert([{ code, title, course, medium, session, price: Number(price), pdf_path }]);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Invalid Action' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
