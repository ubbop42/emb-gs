// Unit tests for the stitch-count surcharge arithmetic in widget.js.
// Run with: node scripts/test-stitch-calc.js

const { computeStitchSurcharge } = require('../frontend/widget.js');

const cases = [
  { input: [15000], expectTotal: 0, label: 'main under free allowance -> no charge' },
  { input: [20000], expectTotal: 0, label: 'main exactly at free allowance -> no charge' },
  { input: [25000], expectTotal: 2.50, label: 'main 5000 over -> 5 x $0.50' },
  { input: [20500], expectTotal: 0.50, label: 'main 500 over -> rounds up to 1 unit' },
  { input: [25000, 6000], expectTotal: 3.00, label: 'main +2.50, additional (1000 over 5000) +0.50' },
  { input: [10000, 5000, 12000], expectTotal: 3.50, label: '2nd placement exactly at its own 5000 allowance -> free; 3rd 7000 over -> 7 x .50' },
];

let pass = 0;
cases.forEach(({ input, expectTotal, label }) => {
  const { stitchSurcharge } = computeStitchSurcharge(input);
  const ok = Math.abs(stitchSurcharge - expectTotal) < 0.001;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}: got $${stitchSurcharge}, expected $${expectTotal}`);
  if (ok) pass++;
});
console.log(`\n${pass}/${cases.length} passed`);
if (pass !== cases.length) process.exit(1);
