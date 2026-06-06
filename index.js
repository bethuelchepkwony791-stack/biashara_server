require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');   // <-- ADDED

// ---------- Firebase Admin SDK Initialization ----------
const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
  console.error('Missing Firebase credentials in environment variables');
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin SDK initialized successfully');
} catch (err) {
  console.error('❌ Firebase initialization error:', err.message);
  process.exit(1);
}

const db = admin.firestore();
const app = express();

// ---------- CORS (must be first middleware) ----------
app.use(cors());              // <-- ADDED
app.options('*', cors());     // <-- ADDED (handles preflight OPTIONS)

app.use(express.json());

// ---------- Environment Variables for WhatsApp ----------
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || !VERIFY_TOKEN) {
  console.error('Missing WhatsApp environment variables');
  console.error('PHONE_NUMBER_ID:', !!PHONE_NUMBER_ID);
  console.error('ACCESS_TOKEN:', !!ACCESS_TOKEN);
  console.error('VERIFY_TOKEN:', !!VERIFY_TOKEN);
  process.exit(1);
} else {
  console.log('✅ WhatsApp environment variables loaded');
}

// ---------- Helper: Send WhatsApp message via Cloud API ----------
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: to,
    type: 'text',
    text: { preview_url: false, body: text },
  };
  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

// ---------- WEBHOOK: Verification (GET) ----------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified successfully');
    res.status(200).send(challenge);
  } else {
    console.warn('Webhook verification failed (invalid token or mode)');
    res.status(403).send('Verification failed');
  }
});

// ---------- WEBHOOK: Incoming messages (POST) ----------
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body;
      const whatsappMessageId = message.id;

      const customerSnapshot = await db
        .collection('customers')
        .where('phoneNumbers', 'array-contains', from)
        .limit(1)
        .get();

      if (!customerSnapshot.empty) {
        const customerId = customerSnapshot.docs[0].id;
        await db
          .collection('chats')
          .doc(customerId)
          .collection('messages')
          .add({
            direction: 'incoming',
            text: text,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
            whatsappMessageId: whatsappMessageId,
          });
        console.log(`Incoming message from ${from} stored for customer ${customerId}`);
      } else {
        console.warn(`No customer found with phone number ${from}`);
      }
    } else {
      console.log('Received non-text or status update:', JSON.stringify(body));
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.sendStatus(500);
  }
});

// ---------- Send message (called from Flutter app) ----------
app.post('/send-message', async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) {
    return res.status(401).json({ error: 'Missing authentication token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded) throw new Error('Invalid token');
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, text, customerId } = req.body;
  if (!to || !text || !customerId) {
    return res.status(400).json({ error: 'Missing required fields: to, text, customerId' });
  }

  let cleaned = to.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
  if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;

  try {
    const apiResponse = await sendWhatsAppMessage(cleaned, text);
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
    console.log(`Message sent to ${cleaned}`);
    res.json({ success: true, messageId: apiResponse.messages?.[0]?.id });
  } catch (err) {
    console.error('Send message error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to send WhatsApp message' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}).on('error', (err) => {
  console.error('❌ Server failed to start:', err);
  process.exit(1);
});