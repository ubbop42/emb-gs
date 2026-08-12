// scripts/simulate-order.js
// Simulates Shopify's `orders/create` webhook hitting your backend, so you
// can test the design -> order linking without a live Shopify store.
//
// Usage:
//   1. Create a design first (via the widget, or curl — see README) and
//      copy its designId.
//   2. node scripts/simulate-order.js <designId>

const crypto = require('crypto');
const http = require('http');

const designId = process.argv[2];
if (!designId) {
  console.error('Usage: node scripts/simulate-order.js <designId>');
  process.exit(1);
}

const SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'dev-secret-replace-me';
const HOST = process.env.BACKEND_HOST || 'localhost';
const PORT = process.env.BACKEND_PORT || 3000;

const order = {
  id: Date.now(),
  name: `#${Math.floor(1000 + Math.random() * 9000)}`,
  line_items: [
    {
      id: Date.now() + 1,
      title: 'Custom Embroidered Hoodie',
      quantity: 1,
      properties: [
        { name: '_design_id', value: designId },
        { name: 'Placement', value: 'left-chest' },
      ],
    },
  ],
};

const body = JSON.stringify(order);
const hmac = crypto.createHmac('sha256', SECRET).update(body).digest('base64');

const req = http.request(
  {
    hostname: HOST,
    port: PORT,
    path: '/webhooks/orders-create',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': hmac,
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => console.log(`Webhook responded ${res.statusCode}:`, data));
  }
);
req.on('error', (e) => console.error('Request failed:', e.message));
req.write(body);
req.end();
