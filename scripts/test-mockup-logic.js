// Unit tests for the color+placement mockup resolution logic in widget.js.
// Run with: node scripts/test-mockup-logic.js
//
// widget.js runs in the browser as an IIFE but exports these two pure
// functions via module.exports when required from Node, purely so this test
// can import the exact shipped code instead of a copy that could drift.

const { buildMockupMap, resolveMockupUrl } = require('../frontend/widget.js');

const placementKeys = ['front', 'back', 'right-sleeve', 'left-sleeve'];
const images = [
  { alt: 'Black - Front', url: 'black-front.jpg' },
  { alt: 'Black - Back', url: 'black-back.jpg' },
  { alt: 'Black - Right Sleeve', url: 'black-rsleeve.jpg' },
  { alt: 'Navy - Front', url: 'navy-front.jpg' },
  { alt: 'Navy - Back', url: 'navy-back.jpg' },
  { alt: '', url: 'untagged.jpg' },
  { alt: 'Just some description', url: 'x.jpg' },
];

const map = buildMockupMap(images, placementKeys);

const assertions = [
  [resolveMockupUrl(map, 'Black', 'front', 'fallback.jpg'), 'black-front.jpg', 'exact color+placement match'],
  [resolveMockupUrl(map, 'Black', 'right-sleeve', 'fallback.jpg'), 'black-rsleeve.jpg', 'exact match with multi-word placement'],
  [resolveMockupUrl(map, 'Navy', 'left-sleeve', 'fallback.jpg'), 'navy-front.jpg', "missing shot falls back to that color's front"],
  [resolveMockupUrl(map, 'Red', 'front', 'fallback.jpg'), 'black-front.jpg', 'unknown color falls back to any color with that placement'],
  [resolveMockupUrl({}, 'Red', 'front', 'fallback.jpg'), 'fallback.jpg', 'empty map falls back to global mockup src'],
];

let pass = 0;
assertions.forEach(([actual, expected, label]) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}: got "${actual}", expected "${expected}"`);
  if (ok) pass++;
});
console.log(`\n${pass}/${assertions.length} passed`);
if (pass !== assertions.length) process.exit(1);
