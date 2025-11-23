require('dotenv').config();
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const stripeLib = require('stripe');
const { google } = require('googleapis');

const app = express();

// --- Stripe setup ---
const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// We need raw body for Stripe signature verification
app.post(
  '/stripe-webhook',
  bodyParser.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        endpointSecret
      );
    } catch (err) {
      console.error('❌ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      console.log('✅ Checkout session completed:', session.id);

      try {
        await handleCheckoutCompleted(session);
        res.status(200).send('Received and processed');
      } catch (err) {
        console.error('❌ Error handling checkout completion:', err);
        res.status(500).send('Server error');
      }
    } else {
      // Ignore other events for now
      res.status(200).send('Event ignored');
    }
  }
);

// --- Map Stripe price IDs to tiers & credits ---
// TODO: replace these with your actual Stripe price IDs
const TIER_CONFIG = {
  'price_1SWcyzHeOH2hxFO3a1RWyyv1': {
    tier: 'Bronze',
    contribution: 250,
    credits: 325
  },
  'price_1SWd8MHeOH2hxFO3PycEn43V': {
    tier: 'Silver',
    contribution: 750,
    credits: 1050
  },
  'price_1SWdDaHeOH2hxFO31X6W21AK': {
    tier: 'Gold',
    contribution: 2000,
    credits: 3000
  },
  'price_1SWdGPHeOH2hxFO3ZsLDEvhK': {
    tier: 'Titan',
    contribution: 5000,
    credits: 8000
  }
};

// --- Google Sheets client setup ---
let sheetsCredentials;

// Prefer env var, fall back to file for local dev
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
  sheetsCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
} else {
  sheetsCredentials = JSON.parse(
    fs.readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON || './service-account.json', 'utf8')
  );
}

const auth = new google.auth.GoogleAuth({
  credentials: sheetsCredentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheetsClient = google.sheets({ version: 'v4', auth });

// --- Handler for completed checkout sessions ---
async function handleCheckoutCompleted(session) {
  // Fetch line items to get price ID
  const lineItems = await stripe.checkout.sessions.listLineItems(
    session.id,
    { limit: 10 }
  );

  if (!lineItems.data || lineItems.data.length === 0) {
    throw new Error('No line items found on session');
  }

  const firstItem = lineItems.data[0];
  const priceId = firstItem.price.id;

  const config = TIER_CONFIG[priceId];
  if (!config) {
    throw new Error(`Unknown price ID: ${priceId}`);
  }

  const email = session.customer_details?.email || session.customer_email || 'unknown';
  const amountTotal = session.amount_total / 100; // in USD
  const timestamp = new Date().toISOString();
  const tier = config.tier;
  const credits = config.credits;
  const sessionId = session.id;
  const customerId = session.customer || '';

  console.log('📝 Logging founder:', {
    timestamp,
    email,
    tier,
    amountTotal,
    credits,
    sessionId,
    customerId
  });

  await appendToSheet({
    timestamp,
    email,
    tier,
    amountTotal,
    credits,
    sessionId,
    customerId
  });
}

// Append a row to Google Sheets
async function appendToSheet({
  timestamp,
  email,
  tier,
  amountTotal,
  credits,
  sessionId,
  customerId
}) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || 'Sheet1';
  const range = `${tabName}!A:H`;

  const values = [
    [
      timestamp,
      email,
      tier,
      amountTotal,
      credits,
      sessionId,
      customerId,
      ''
    ]
  ];

  const resource = {
    values
  };

  const res = await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    resource
  });

  console.log('✅ Appended to sheet:', res.data.updates?.updatedRange);
}

app.get('/', (req, res) => {
  res.send('AICX Stripe webhook is live.');
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 AICX webhook server listening on port ${port}`);
});
