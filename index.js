require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
};

if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
  console.error('Missing Firebase credentials');
  process.exit(1);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

if (!PHONE_NUMBER_ID || !ACCESS_TOKEN || !VERIFY_TOKEN) {
  console.error('Missing WhatsApp env vars');
  process.exit(1);
}
console.log('✅ WhatsApp environment variables loaded');

function normalizePhone(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
  if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
  return cleaned;
}

function getPhoneVariants(phone) {
  const norm = normalizePhone(phone);
  return [norm, '0' + norm.substring(3), '+' + norm, phone];
}

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

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send('Verification failed');
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === 'text') {
      const from = message.from;
      const text = message.text.body;
      const messageId = message.id;

      console.log(`📩 Incoming from ${from}: "${text}"`);

      const variants = getPhoneVariants(from);
      let customerId = null;
      for (const variant of variants) {
        const snapshot = await db.collection('customers').where('phoneNumbers', 'array-contains', variant).limit(1).get();
        if (!snapshot.empty) {
          customerId = snapshot.docs[0].id;
          console.log(`✅ Found customer ${customerId} with variant ${variant}`);
          break;
        }
      }

      if (customerId) {
        await db.collection('chats').doc(customerId).collection('messages').add({
          direction: 'incoming',
          text: text,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          whatsappMessageId: messageId,
          status: 'delivered',
        });
        const norm = normalizePhone(from);
        await db.collection('customers').doc(customerId).update({
          phoneNumbers: admin.firestore.FieldValue.arrayUnion(norm)
        }).catch(() => {});
        console.log(`✅ Message stored for ${customerId}`);
        res.sendStatus(200);
      } else {
        console.warn(`❌ No customer found for ${from} (variants: ${variants.join(', ')})`);
        // Optionally create a new customer record here if desired
        res.sendStatus(200); // still acknowledge to Meta
      }
    } else {
      res.sendStatus(200);
    }
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

app.post('/send-message', async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) return res.status(401).json({ error: 'Missing token' });
  try {
    await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).json({ error: `Unauthorized: ${err.message}` });
  }

  const { to, text, customerId } = req.body;
  if (!to || !text || !customerId) return res.status(400).json({ error: 'Missing fields' });

  const cleaned = normalizePhone(to);
  try {
    const apiResponse = await sendWhatsAppMessage(cleaned, text);
    await db.collection('chats').doc(customerId).collection('messages').add({
      direction: 'outgoing',
      text: text,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      whatsappMessageId: apiResponse.messages?.[0]?.id || null,
      status: 'sent',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));