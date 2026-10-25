const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const querystring = require('querystring');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL || "https://djobcvbvhvojkefdrbfu.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRqb2JjdmJ2aHZvamtlZmRyYmZ1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjY3OTk0MiwiZXhwIjoyMTA4MjU1OTQyfQ.DiOvlA_8OT0zu8L8lFZFG_RjLg71LyQR6jS2TllGOvg";
const EXOSUPPLIER_API_KEY = process.env.CLASSYSMM_API_KEY || "189a288d00df24e3bed08ea4a4c95c58";
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "sk_live_742f4f5de3631e225e53b6578dd2a48797719f50";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// HEALTH CHECK
app.get('/', (req, res) => res.send('GBtech Social Backend is Live!'));

// 1. SYNC SERVICES FROM EXOSUPPLIER
app.get('/sync-services', async (req, res) => {
  try {
    const postData = `key=${encodeURIComponent(EXOSUPPLIER_API_KEY)}&action=services`;
    const options = {
      hostname: 'exosupplier.com',
      port: 443,
      path: '/api/v2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const supplierServices = await new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } 
          catch (e) { reject(new Error('Invalid response from ExoSupplier')); }
        });
      });
      request.on('error', reject);
      request.write(postData);
      request.end();
    });

    if (!Array.isArray(supplierServices)) {
      return res.status(400).json({ error: 'Failed to fetch service list from ExoSupplier.' });
    }

    const USD_TO_NGN_RATE = 1500;
    const PROFIT_MARGIN = 1.30;
    const CONVERSION_RATE = USD_TO_NGN_RATE * PROFIT_MARGIN;

    let count = 0;
    for (const item of supplierServices) {
      const ngnRate = Math.round(parseFloat(item.rate) * CONVERSION_RATE * 100) / 100;
      await supabase.from('services').upsert({
        supplier_service_id: parseInt(item.service, 10),
        name: item.name,
        category: item.category,
        rate: ngnRate,
        min: parseInt(item.min, 10),
        max: parseInt(item.max, 10),
        description: item.type || 'Standard Service',
        is_active: true,
        updated_at: new Date()
      }, { onConflict: 'supplier_service_id' });
      count++;
    }

    return res.json({ success: true, message: `Successfully synced ${count} live services from ExoSupplier.`, count });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 2. CREATE SMM ORDER
app.post('/create-order', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized: Missing token' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid or expired session' });

    const { service_id, link, quantity } = req.body;
    const numQty = parseInt(quantity, 10);

    const { data: service } = await supabase.from('services').select('*').eq('id', service_id).single();
    if (!service || !service.is_active) {
      return res.status(400).json({ error: 'Selected service is currently unavailable.' });
    }

    if (numQty < service.min || numQty > service.max) {
      return res.status(400).json({ error: `Quantity must be between ${service.min} and ${service.max}` });
    }

    const totalCharge = Math.round(((service.rate / 1000) * numQty) * 100) / 100;
    const orderRef = `ORD_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    try {
      await supabase.rpc('debit_wallet_ledger', {
        p_user_id: user.id,
        p_amount: totalCharge,
        p_reference: orderRef,
        p_description: `Order for ${service.name}`
      });
    } catch (dbErr) {
      return res.status(400).json({ error: 'Insufficient wallet balance. Please add funds to your wallet.' });
    }

    const postData = querystring.stringify({
      key: EXOSUPPLIER_API_KEY,
      action: 'add',
      service: service.supplier_service_id,
      link: link,
      quantity: numQty
    });

    const options = {
      hostname: 'exosupplier.com',
      port: 443,
      path: '/api/v2',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const supplierRes = await new Promise((resolve) => {
      const request = https.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try { resolve(JSON.parse(body)); } 
          catch (e) { resolve({ error: 'Invalid response from ExoSupplier' }); }
        });
      });
      request.on('error', () => resolve({ error: 'ExoSupplier connection failed' }));
      request.write(postData);
      request.end();
    });

    if (supplierRes.order) {
      const { data: newOrder } = await supabase.from('orders').insert({
        user_id: user.id,
        service_id: service.id,
        supplier_order_id: supplierRes.order.toString(),
        link: link,
        quantity: numQty,
        charge: totalCharge,
        status: 'pending'
      }).select().single();

      return res.json({ success: true, order: newOrder });
    } else {
      await supabase.rpc('refund_wallet_ledger', {
        p_user_id: user.id,
        p_amount: totalCharge,
        p_reference: `REF_${orderRef}`,
        p_description: `Refund: Order rejected by ExoSupplier (${supplierRes.error || 'API Error'})`
      });

      return res.status(400).json({ error: `Order failed on ExoSupplier: ${supplierRes.error || 'Error'}. Balance refunded.` });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. INITIALIZE PAYSTACK DEPOSIT
app.post('/create-payment', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid Session' });

    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (!numAmount || numAmount < 100) {
      return res.status(400).json({ error: 'Minimum deposit is ₦100' });
    }

    const reference = `GB_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    await supabase.from('payments').insert({
      user_id: user.id,
      reference,
      amount: numAmount,
      status: 'pending'
    });

    const paystackPayload = JSON.stringify({
      email: user.email,
      amount: Math.round(numAmount * 100),
      reference,
      callback_url: `${req.headers.origin || 'https://stupendous-raindrop-677dea.netlify.app'}/wallet.html?reference=${reference}`
    });

    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path: '/transaction/initialize',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': paystackPayload.length
      }
    };

    const paystackRes = await new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => resolve(JSON.parse(body)));
      });
      request.on('error', reject);
      request.write(paystackPayload);
      request.end();
    });

    if (!paystackRes.status) {
      return res.status(400).json({ error: paystackRes.message || 'Paystack initialization failed.' });
    }

    return res.json({ authorization_url: paystackRes.data.authorization_url, reference: paystackRes.data.reference });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 4. VERIFY PAYSTACK PAYMENT
app.post('/verify-payment', async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ error: 'Reference required' });

    const { data: paymentRecord } = await supabase.from('payments').select('*').eq('reference', reference).single();
    if (!paymentRecord) return res.status(404).json({ error: 'Transaction not found' });
    if (paymentRecord.status === 'success') {
      return res.json({ success: true, message: 'Payment already processed' });
    }

    const options = {
      hostname: 'api.paystack.co',
      port: 443,
      path: `/transaction/verify/${encodeURIComponent(reference)}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    };

    const verifyRes = await new Promise((resolve, reject) => {
      const request = https.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => resolve(JSON.parse(body)));
      });
      request.on('error', reject);
      request.end();
    });

    if (verifyRes.status && verifyRes.data.status === 'success') {
      const verifiedAmount = verifyRes.data.amount / 100;
      await supabase.from('payments').update({ status: 'success', paystack_reference: verifyRes.data.reference }).eq('reference', reference);
      await supabase.rpc('credit_wallet_ledger', {
        p_user_id: paymentRecord.user_id,
        p_amount: verifiedAmount,
        p_reference: reference,
        p_description: `Paystack Deposit - ${reference}`
      });
      return res.json({ success: true, amount: verifiedAmount });
    } else {
      await supabase.from('payments').update({ status: 'failed' }).eq('reference', reference);
      return res.status(400).json({ error: 'Payment verification failed' });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Backend server active on port ${PORT}`));