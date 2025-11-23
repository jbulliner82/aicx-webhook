// server.js
// AICX Stripe webhook -> Google Sheets founder ledger

require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();

// ======== CONFIG ========

const PORT = process.env.PORT || 8080;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_NAME = process.env.GOOGLE_SHEETS_TAB_NAME || 'Sheet1';

// Version your legal doc here
const AGREEMENT_VERSION = 'v1.0';

// Stripe client
if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY is not set in environment');
  process.exit(1);
}
const stripe = new Stripe(STRIPE_SECRET_KEY, {
  // apiVersion: '2024-06-20', // optional; you can pin a version if you want
});

// ======== GOOGLE SHEETS AUTH ========

let sheetsCredentials;

// Prefer env var with full JSON; fallback to local file for dev
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
  try {
    sheetsCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  } catch (err) {
    console.error('❌ Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY JSON:', err);
    process.exit(1);
  }
} else {
  const jsonPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON || './service-account.json';
  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    sheetsCredentials = JSON.parse(raw);
  } catch (err) {
    console.error('❌ Failed to load service account JSON from file:', err);
    process.exit(1);
  }
}

const auth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheetsClient = google.sheets({ version: 'v4', auth });

// ======== EXPRESS MIDDLEWARE ========

// Stripe requires the raw body to verify signatures
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));

// For any future JSON endpoints
app.use(express.json());

// Simple healthcheck
app.get('/', (_req, res) => {
  res.send('AICX Stripe webhook is live.');
});

// ======== HELPER: TIER & CREDITS LOGIC ========

// Try to resolve tier from metadata or amount
function resolveTier(session) {
  if (session.metadata && session.metadata.tier) {
    return session.metadata.tier;
  }

  const amountTotal = (session.amount_total || 0) / 100; // Stripe uses cents

  if (amountTotal >= 5000) return 'Titan';
  if (amountTotal >= 2000) return 'Gold';
  if (amountTotal >= 750) return 'Silver';
  if (amountTotal >= 250) return 'Bronze';
  return 'Unknown';
}

// Map known amounts to credits; fallback to multiplier
function resolveCredits(tier, amountTotal) {
  // amountTotal is in USD (not cents)
  const rounded = Math.round(amountTotal);

  switch (rounded) {
    case 250:
      return 325;   // Bronze
    case 750:
      return 1050;  // Silver
    case 2000:
      return 3000;  // Gold
    case 5000:
      return 8000;  // Titan
    default:
      // Fallback: 1.3x multiplier if something odd comes through
      return Math.round(amountTotal * 1.3);
  }
}

// ======== GOOGLE SHEETS APPEND ========

async function appendToSheet(founder) {
  // Sheet layout:
  // A: Timestamp UTC
  // B: Local Time
  // C: Email
  // D: Tier
  // E: AmountPaidUSD
  // F: Credits
  // G: Session ID
  // H: Customer ID
  // I: Notes
  // J: Status (manual; leave blank)
  // K: Agreement Version

  const row = [
    founder.timestampUtc,         // A
    founder.timestampLocal,       // B
    founder.email || '',          // C
    founder.tier || '',           // D
    founder.amountTotal || 0,     // E
    founder.credits || 0,         // F
    founder.sessionId || '',      // G
    founder.customerId || '',     // H
    founder.notes || '',          // I
    '',                           // J (Status left blank; you manage manually)
    founder.agreementVersion || ''// K
  ];

  console.log('📝 Appending row to Sheet:', row);

  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [row],
    },
  });

  console.log('✅ Successfully appended founder to Google Sheet');
}

// ======== STRIPE WEBHOOK HANDLER ========

async function handleCheckoutCompleted(session) {
  try {
    const email =
      (session.customer_details && session.customer_details.email) ||
      session.customer_email ||
      '';

    const amountTotal = (session.amount_total || 0) / 100; // cents -> USD
    const tier = resolveTier(session);
    const credits = resolveCredits(tier, amountTotal);

    const now = new Date();
    const timestampUtc = now.toISOString();
    const timestampLocal = now.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
    });

    const founderRecord = {
      timestampUtc,
      timestampLocal,
      email,
      tier,
      amountTotal,
      credits,
      sessionId: session.id,
      customerId: session.customer || '',
      notes: '',
      agreementVersion: AGREEMENT_VERSION,
    };

    console.log('✅ Checkout session completed:', session.id);
    console.log('📝 Logging founder:', founderRecord);

    await appendToSheet(founderRecord);
  } catch (err) {
    console.error('❌ Error handling checkout completion:', err);
    throw err;
  }
}

app.post('/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  if (!STRIPE_WEBHOOK_SECRET) {
    console.error('❌ STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).send('Webhook secret not configured');
  }

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Error verifying Stripe webhook signature:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session);
        break;
      }
      default:
        // Ignore events we don't care about
        console.log(`ℹ️ Ignoring event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('❌ Error processing webhook event:', err);
    res.status(500).send('Internal Server Error');
  }
});

// ======== START SERVER ========

app.listen(PORT, () => {
  console.log(`🚀 AICX Stripe webhook server listening on port ${PORT}`);
});
