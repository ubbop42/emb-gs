// server.js — Custom Embroidery backend (prototype)
//
// Zero external dependencies on purpose: `node server.js` and you're running.
// In production you'd likely rebuild this on Express/Fastify + a real DB + the
// Shopify Node API library, but the ROUTES and DATA MODEL below are the real
// design — that's the part worth prototyping first.
//
// Responsibilities:
//   1. Receive a finished design from the storefront widget (POST /api/designs)
//   2. Let the widget/theme snippet fetch a design back (GET /api/designs/:id)
//   3. Receive Shopify's "order created" webhook, match line items to designs
//      by the hidden line-item property _design_id, and store them for the
//      production/embroidery team (POST /webhooks/orders-create)
//   4. Serve a tiny admin dashboard so the production team can see every
//      order's design without touching Shopify admin at all (GET /admin)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { randomUUID } = crypto;
const db = require('./db');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
// Set this to the Webhook Signing Secret shown when you create the webhook
// in your Shopify Partner Dashboard / Admin > Notifications.
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || 'dev-secret-replace-me';

// Must match frontend/widget.js's PLACEMENT_BY_PRODUCT / PRICE_PER_ADDITIONAL_PLACEMENT.
// Kept here too so the backend can validate incoming designs instead of trusting the client.
const PLACEMENT_BY_PRODUCT = {
  hoodie: ['front', 'back', 'right-sleeve', 'left-sleeve'],
  tshirt: ['front', 'back', 'right-sleeve', 'left-sleeve'],
  polo: ['front', 'back', 'right-sleeve', 'left-sleeve'],
  babysuit: ['front', 'back', 'right-sleeve', 'left-sleeve'],
  hat: ['front', 'left-panel', 'right-panel'],
};
const PRICE_PER_ADDITIONAL_PLACEMENT = 3;

// Stitch-pricing constants — keep in sync with frontend/widget.js.
const FREE_STITCHES_MAIN = 20000;
const FREE_STITCHES_ADDITIONAL = 5000;
const STITCH_RATE_PER_1000 = 0.50;

// Mirrors widget.js's computeStitchSurcharge exactly, so the backend never
// just trusts the client's own math for what actually gets billed.
function computeStitchSurcharge(stitchCounts) {
  let total = 0;
  let units = 0; // total number of $0.50 "1,000 stitch" units across all placements — used as the addon product's cart quantity
  stitchCounts.forEach((stitches, idx) => {
    const freeAllowance = idx === 0 ? FREE_STITCHES_MAIN : FREE_STITCHES_ADDITIONAL;
    const over = Math.max(0, stitches - freeAllowance);
    const thousands = Math.ceil(over / 1000);
    units += thousands;
    total = +(total + thousands * STITCH_RATE_PER_1000).toFixed(2);
  });
  return { stitchSurcharge: total, units };
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- helpers ----------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*', // storefront JS runs on your-shop.myshopify.com, a different origin than this server
    'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Hmac-Sha256, X-Shopify-Topic',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function serveStatic(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) { // 25MB cap for base64 image payloads
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Saves a "data:image/png;base64,...." string to /uploads and returns the filename.
function saveDataUrlImage(dataUrl, prefix) {
  if (!dataUrl) return null;
  const match = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  const ext = match[1].split('/')[1].replace('jpeg', 'jpg');
  const filename = `${prefix}-${randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), Buffer.from(match[2], 'base64'));
  return filename;
}

// Verifies the request really came from Shopify.
// Docs: https://shopify.dev/docs/apps/build/webhooks/subscribe/https#step-3-validate-the-webhook
function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false; // length mismatch etc.
  }
}

// ---------- route handlers ----------

async function handleCreateDesign(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJSON(res, 400, { error: 'invalid JSON' });
  }

  const { productType, placements } = payload;
  if (!productType || !Array.isArray(placements) || placements.length === 0) {
    return sendJSON(res, 400, { error: 'productType and a non-empty placements[] are required' });
  }

  const allowed = PLACEMENT_BY_PRODUCT[productType];
  if (!allowed) {
    return sendJSON(res, 400, { error: `unknown productType "${productType}"` });
  }

  // Validate every placement is a legal, non-duplicate option for this product type —
  // don't trust the client to have enforced the max-placement rules.
  const seen = new Set();
  for (const p of placements) {
    if (!allowed.includes(p.placement)) {
      return sendJSON(res, 400, { error: `placement "${p.placement}" is not valid for productType "${productType}"` });
    }
    if (seen.has(p.placement)) {
      return sendJSON(res, 400, { error: `duplicate placement "${p.placement}"` });
    }
    seen.add(p.placement);
  }

  const id = randomUUID();
  const savedPlacements = placements.map((p) => ({
    placement: p.placement,
    elements: p.elements || [],
    previewFile: saveDataUrlImage(p.previewImage, `preview-${p.placement}`),
    originalFile: saveDataUrlImage(p.originalImage, `original-${p.placement}`),
  }));

  const extraPlacementCount = Math.max(0, savedPlacements.length - 1);
  const placementFee = extraPlacementCount * PRICE_PER_ADDITIONAL_PLACEMENT;

  // Stitch counts come from the widget's client-side estimate (see README —
  // this is a documented trust boundary for the prototype; hardening this
  // means recomputing stitch estimates server-side from the artwork itself
  // instead of trusting the reported number).
  const stitchCounts = savedPlacements.map((p) => (p.elements[0] && p.elements[0].estimatedStitches) || 0);
  const { stitchSurcharge, units: stitchSurchargeUnits } = computeStitchSurcharge(stitchCounts);

  const additionalCharge = +(placementFee + stitchSurcharge).toFixed(2);

  const design = {
    id,
    productType,           // 'hat' | 'tshirt' | 'hoodie' | 'polo' | 'babysuit'
    placements: savedPlacements,
    placementFee,
    stitchSurcharge,
    additionalCharge,      // computed server-side — the source of truth for what should be billed
    createdAt: new Date().toISOString(),
  };
  db.saveDesign(design);

  sendJSON(res, 201, {
    designId: id,
    additionalCharge,
    placementFeeUnits: extraPlacementCount,   // cart quantity for the $3 placement-fee addon product
    stitchSurchargeUnits,                     // cart quantity for the $0.50 stitch-surcharge addon product
    placements: savedPlacements.map(p => ({
      placement: p.placement,
      previewUrl: p.previewFile ? `/uploads/${p.previewFile}` : null,
    })),
  });
}

function handleGetDesign(req, res, id) {
  const design = db.getDesign(id);
  if (!design) return sendJSON(res, 404, { error: 'design not found' });
  sendJSON(res, 200, {
    ...design,
    placements: design.placements.map(p => ({
      ...p,
      previewUrl: p.previewFile ? `/uploads/${p.previewFile}` : null,
      originalUrl: p.originalFile ? `/uploads/${p.originalFile}` : null,
    })),
  });
}

async function handleOrdersWebhook(req, res) {
  const raw = await readBody(req);
  const hmac = req.headers['x-shopify-hmac-sha256'];

  if (!verifyShopifyHmac(raw, hmac)) {
    console.warn('Rejected webhook: bad HMAC (expected if you are testing with the sample script below and a mismatched secret)');
    return sendJSON(res, 401, { error: 'invalid signature' });
  }

  let order;
  try {
    order = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJSON(res, 400, { error: 'invalid JSON' });
  }

  const lineItems = order.line_items || [];
  const linked = [];

  for (const item of lineItems) {
    const props = item.properties || []; // Shopify sends line item properties as [{name,value}, ...]
    const designProp = props.find(p => p.name === '_design_id');
    if (!designProp) continue; // not a customized product

    const design = db.getDesign(designProp.value);
    const record = {
      recordId: randomUUID(),
      shopifyOrderId: String(order.id),
      shopifyOrderNumber: order.name || order.order_number,
      lineItemId: String(item.id),
      productTitle: item.title,
      quantity: item.quantity,
      designId: designProp.value,
      designFound: !!design,
      status: 'received', // received -> in_production -> completed
      createdAt: new Date().toISOString(),
    };
    db.saveOrder(record);
    linked.push(record);
  }

  console.log(`Order ${order.name || order.id}: linked ${linked.length} customized line item(s)`);
  sendJSON(res, 200, { ok: true, linked: linked.length });
}

function handleAdminOrders(req, res) {
  const orders = db.getAllOrders();
  const enriched = orders.map(o => {
    const design = db.getDesign(o.designId);
    return {
      ...o,
      additionalCharge: design ? design.additionalCharge : 0,
      placementFee: design ? design.placementFee : 0,
      stitchSurcharge: design ? design.stitchSurcharge : 0,
      placements: design ? design.placements.map(p => ({
        placement: p.placement,
        elements: p.elements,
        previewUrl: p.previewFile ? `/uploads/${p.previewFile}` : null,
        originalUrl: p.originalFile ? `/uploads/${p.originalFile}` : null,
      })) : [],
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  sendJSON(res, 200, enriched);
}

async function handleUpdateOrderStatus(req, res, recordId) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: 'invalid JSON' }); }
  const updated = db.updateOrderStatus(recordId, body.status);
  if (!updated) return sendJSON(res, 404, { error: 'not found' });
  sendJSON(res, 200, updated);
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') { // CORS preflight
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Shopify-Hmac-Sha256, X-Shopify-Topic',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    // ---- widget assets, served straight from /frontend so there's no build step ----
    if (p === '/widget.js' && req.method === 'GET') {
      return serveStatic(res, path.join(FRONTEND_DIR, 'widget.js'), 'application/javascript');
    }
    if (p === '/widget.css' && req.method === 'GET') {
      return serveStatic(res, path.join(FRONTEND_DIR, 'widget.css'), 'text/css');
    }

    // ---- uploaded/generated images ----
    if (p.startsWith('/uploads/') && req.method === 'GET') {
      const file = path.join(UPLOADS_DIR, path.basename(p));
      const ext = path.extname(file).slice(1);
      return serveStatic(res, file, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
    }

    // ---- design capture API (called by the widget) ----
    if (p === '/api/designs' && req.method === 'POST') {
      return await handleCreateDesign(req, res);
    }
    if (p.startsWith('/api/designs/') && req.method === 'GET') {
      return handleGetDesign(req, res, p.split('/')[3]);
    }

    // ---- Shopify webhook ----
    if (p === '/webhooks/orders-create' && req.method === 'POST') {
      return await handleOrdersWebhook(req, res);
    }

    // ---- admin dashboard (production team) ----
    if (p === '/admin' && req.method === 'GET') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'admin.html'), 'text/html');
    }
    if (p === '/admin/api/orders' && req.method === 'GET') {
      return handleAdminOrders(req, res);
    }
    if (p.startsWith('/admin/api/orders/') && req.method === 'POST') {
      return await handleUpdateOrderStatus(req, res, p.split('/')[4]);
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'server error', detail: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Embroidery customizer backend running at http://localhost:${PORT}`);
  console.log(`Admin dashboard:  http://localhost:${PORT}/admin`);
  console.log(`Widget script:    http://localhost:${PORT}/widget.js`);
});
