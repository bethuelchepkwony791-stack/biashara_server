require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

// ---------- Firebase Admin SDK ----------
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
  console.error('Missing Firebase credentials');
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin SDK initialized');
} catch (err) {
  console.error('❌ Firebase init error:', err.message);
  process.exit(1);
}

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

// ---------- Environment Variables ----------
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || !VERIFY_TOKEN) {
  console.error('Missing WhatsApp env vars');
  process.exit(1);
}
console.log('✅ WhatsApp environment variables loaded');

// ---------- Normalize phone number to a standard format (254XXXXXXXXX) ----------
function normalizePhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
  if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
  return cleaned;
}

// Generate alternative formats for searching
function getPhoneVariants(phone) {
  const normalized = normalizePhone(phone);
  const withLeadingZero = '0' + normalized.substring(3);
  const withPlus = '+' + normalized;
  return [normalized, withLeadingZero, withPlus, phone]; // also original
}

// ---------- Helper: Send WhatsApp message ----------
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: { preview_url: false, body: text },
  };
  try {
    const response = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    });
    return response.data;
  } catch (err) {
    console.error('WhatsApp API error:', err.response?.data || err.message);
    throw new Error(`WhatsApp API error: ${err.response?.data?.error?.message || err.message}`);
  }
}

// ---------- Webhook verification ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Verification failed');
  }
});

// ---------- Incoming messages (robust phone matching) ----------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (message && message.type === 'text') {
      const rawFrom = message.from;  // e.g., "254712345678" (no plus)
      const text = message.text.body;
      const messageId = message.id;

      console.log(`📩 Incoming message from ${rawFrom}: "${text}"`);

      // Get all possible phone number variants
      const variants = getPhoneVariants(rawFrom);
      console.log(`Searching for variants: ${variants.join(', ')}`);

      // Find customer where phoneNumbers contains any of the variants
      let customerDoc = null;
      for (const variant of variants) {
        const snapshot = await db
          .collection('customers')
          .where('phoneNumbers', 'array-contains', variant)
          .limit(1)
          .get();
        if (!snapshot.empty) {
          customerDoc = snapshot.docs[0];
          console.log(`✅ Found customer with variant: ${variant}`);
          break;
        }
      }

      if (customerDoc) {
        const customerId = customerDoc.id;
        // Store the incoming message
        await db
          .collection('chats')
          .doc(customerId)
          .collection('messages')
          .add({
            direction: 'incoming',
            text: text,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            whatsappMessageId: messageId,
            status: 'delivered',
          });
        console.log(`✅ Incoming message stored for customer ${customerId}`);

        // Optionally, ensure the customer's phoneNumbers includes the normalized version
        const currentPhones = customerDoc.data().phoneNumbers || [];
        const normalized = normalizePhone(rawFrom);
        if (!currentPhones.includes(normalized)) {
          await customerDoc.ref.update({
            phoneNumbers: admin.firestore.FieldValue.arrayUnion(normalized)
          });
          console.log(`📞 Added normalized phone ${normalized} to customer ${customerId}`);
        }
      } else {
        console.warn(`❌ No customer found for phone ${rawFrom}`);
        // You could create a new customer record here if desired
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

// ---------- Send message endpoint (already robust) ----------
app.post('/send-message', async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) return res.status(401).json({ error: 'Missing token' });
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, text, customerId } = req.body;
  if (!to || !text || !customerId) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const normalizedTo = normalizePhone(to);
  try {
    const apiResponse = await sendWhatsAppMessage(normalizedTo, text);
    await db
      .collection('chats')
      .doc(customerId)
      .collection('messages')
      .add({
        direction: 'outgoing',
        text: text,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        whatsappMessageId: apiResponse.messages?.[0]?.id || null,
        status: 'sent',
      });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Health check ----------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}).on('error', (err) => {
  console.error('❌ Server failed to start:', err);
  process.exit(1);
});