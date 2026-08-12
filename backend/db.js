// db.js — minimal flat-file JSON "database" for the prototype.
// Swap this module out for SQLite/Postgres/Mongo when you move past prototype stage;
// every other file only talks to the functions exported here, not to files directly.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DESIGNS_FILE = path.join(DATA_DIR, 'designs.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DESIGNS_FILE)) fs.writeFileSync(DESIGNS_FILE, '[]');
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
}
ensureStore();

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---- Designs ----
function saveDesign(design) {
  const designs = readJSON(DESIGNS_FILE);
  designs.push(design);
  writeJSON(DESIGNS_FILE, designs);
  return design;
}
function getDesign(id) {
  const designs = readJSON(DESIGNS_FILE);
  return designs.find(d => d.id === id) || null;
}
function getAllDesigns() {
  return readJSON(DESIGNS_FILE);
}

// ---- Orders (created once Shopify sends the orders/create webhook) ----
function saveOrder(order) {
  const orders = readJSON(ORDERS_FILE);
  orders.push(order);
  writeJSON(ORDERS_FILE, orders);
  return order;
}
function getAllOrders() {
  return readJSON(ORDERS_FILE);
}
function updateOrderStatus(orderRecordId, status) {
  const orders = readJSON(ORDERS_FILE);
  const rec = orders.find(o => o.recordId === orderRecordId);
  if (!rec) return null;
  rec.status = status;
  writeJSON(ORDERS_FILE, orders);
  return rec;
}

module.exports = {
  saveDesign, getDesign, getAllDesigns,
  saveOrder, getAllOrders, updateOrderStatus,
};
