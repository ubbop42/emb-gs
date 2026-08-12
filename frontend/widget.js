/**
 * Embroidery Customizer Widget — multi-placement, color-aware, embroidery-look
 * preview, physical-size image scaling, background removal, stitch-count pricing
 * -------------------------------------------------------------------------------
 * Drop-in, framework-free widget for a Shopify product page.
 *
 * Placement rules:
 *   - hoodie / tshirt / polo / babysuit: up to 4 placements
 *       (front, back, right sleeve, left sleeve)
 *   - hat: up to 3 placements (front, left panel, right panel)
 *
 * Pricing (two independent charges, both billed as real cart line items —
 * see wireCheckoutHandoff — never just decorative):
 *   1. Placement fee: 1st placement is included; every placement after that
 *      is +$3 flat.
 *   2. Stitch surcharge: the "main" placement (canonical order — front
 *      first, i.e. whichever comes first in PLACEMENT_BY_PRODUCT) gets
 *      20,000 free stitches. Every additional placement gets 5,000 free
 *      stitches EACH. $0.50 per 1,000 stitches (or part thereof) over that
 *      placement's own free allowance.
 *   Both are recomputed and returned by the BACKEND on save (see
 *   POST /api/designs) and it's those server-confirmed numbers — not the
 *   client's live estimate — that get billed at checkout.
 *
 * Stitch count is an ENGINEERED APPROXIMATION, not a real digitizer's
 * output: area (from the physical size the shopper picked) × an estimated
 * ink/thread coverage ratio × a typical fill-stitch density constant. Good
 * enough to price fairly and consistently; see README for why exact counts
 * need real digitizing software.
 *
 * Image size: shopper picks the LONGER side's physical size, 3"–12", via a
 * slider. The shorter side scales automatically to preserve aspect ratio.
 * `data-px-per-inch` calibrates inches to the mockup photo's native pixel
 * resolution — see README for how to set it per store.
 *
 * Background removal: a simple corner-sampled chroma-key heuristic (not ML
 * segmentation) — good for logos shot on a plain/solid backdrop. See
 * `removeBackgroundHeuristic`.
 */
(function () {
  const FONTS = [
    { label: 'Classic Serif', value: '"Times New Roman", serif' },
    { label: 'Bold Sans', value: '"Arial Black", Arial, sans-serif' },
    { label: 'Script', value: '"Brush Script MT", cursive' },
    { label: 'Monospace', value: '"Courier New", monospace' },
    { label: 'Clean Sans', value: 'Helvetica, Arial, sans-serif' },
  ];
  const SIZES = [
    { label: 'Small (0.5")', px: 12 },
    { label: 'Medium (1")', px: 24 },
    { label: 'Large (2")', px: 48 },
    { label: 'XL (3")', px: 96 },
  ];
  const TEXT_PX_PER_INCH = 24; // approximate — backs out a physical height from the preset px sizes above, for stitch estimation only

  const IMAGE_MIN_INCHES = 3;
  const IMAGE_MAX_INCHES = 11;
  const IMAGE_DEFAULT_INCHES = 4;

  // The list length for each product type IS the max placement count —
  // hoodie/tshirt/polo/babysuit top out at 4 because that's every option
  // offered; hat tops out at 3 for the same reason. No separate cap needed.
  // Order matters: index 0 is always the "main" placement for stitch pricing.
  const PLACEMENT_BY_PRODUCT = {
    hoodie: ['front', 'back', 'right-sleeve', 'left-sleeve'],
    tshirt: ['front', 'back', 'right-sleeve', 'left-sleeve'],
    polo: ['front', 'back', 'right-sleeve', 'left-sleeve'],
    babysuit: ['front', 'back', 'right-sleeve', 'left-sleeve'],
    hat: ['front', 'left-panel', 'right-panel'],
  };
  const PLACEMENT_LABELS = {
    'front': 'Front', 'back': 'Back',
    'right-sleeve': 'Right sleeve', 'left-sleeve': 'Left sleeve',
    'left-panel': 'Left panel', 'right-panel': 'Right panel',
  };
  const PRICE_PER_ADDITIONAL_PLACEMENT = 3; // keep in sync with the placement addon product's price in Shopify

  // Stitch-pricing constants — keep in sync with backend/server.js.
  const FREE_STITCHES_MAIN = 20000;
  const FREE_STITCHES_ADDITIONAL = 5000;
  const STITCH_RATE_PER_1000 = 0.50; // keep in sync with the stitch addon product's price in Shopify
  const STITCH_DENSITY_PER_SQIN = 2100; // rough rule-of-thumb for average fill/satin embroidery density
  const TEXT_COVERAGE_FACTOR = 0.7; // approx ink coverage fraction of a text bounding box for typical lettering

  // ---------------------------------------------------------------------
  // Pure logic — exported at the bottom for the Node test suite so tests
  // can never drift from the shipped code.
  // ---------------------------------------------------------------------

  // Turns [{alt:"Black - Front", url}, ...] into { Black: { front: url, ... }, ... }.
  function buildMockupMap(productImages, placementKeys) {
    const map = {};
    (productImages || []).forEach(({ alt, url }) => {
      if (!alt || !url) return;
      const parts = alt.split(/\s*-\s*/);
      if (parts.length < 2) return;
      const color = parts[0].trim();
      const placement = parts.slice(1).join('-').trim().toLowerCase().replace(/\s+/g, '-');
      if (!color || !placementKeys.includes(placement)) return;
      if (!map[color]) map[color] = {};
      map[color][placement] = url;
    });
    return map;
  }

  function resolveMockupUrl(map, color, placement, fallbackSrc) {
    const colorSet = map[color];
    if (colorSet && colorSet[placement]) return colorSet[placement];
    if (colorSet && colorSet.front) return colorSet.front;
    for (const c of Object.keys(map)) {
      if (map[c][placement]) return map[c][placement];
    }
    return fallbackSrc || null;
  }

  // stitchCounts: array in canonical placement order, index 0 = main placement.
  function computeStitchSurcharge(stitchCounts) {
    let total = 0;
    const perPlacement = [];
    stitchCounts.forEach((stitches, idx) => {
      const freeAllowance = idx === 0 ? FREE_STITCHES_MAIN : FREE_STITCHES_ADDITIONAL;
      const over = Math.max(0, stitches - freeAllowance);
      const thousands = Math.ceil(over / 1000);
      const charge = +(thousands * STITCH_RATE_PER_1000).toFixed(2);
      total = +(total + charge).toFixed(2);
      perPlacement.push({ stitches, freeAllowance, over, thousands, charge });
    });
    return { stitchSurcharge: total, perPlacement };
  }

  // Given the longer-side target (inches) and an image's pixel dimensions,
  // returns {w,h} in whatever pixel space `pxPerInch`/`scaleFactor` describe
  // (native mockup resolution when scaleFactor=1, on-screen canvas otherwise).
  function imageTargetDimsPx(imgW, imgH, sizeInches, pxPerInch, scaleFactor) {
    const targetLongSide = sizeInches * pxPerInch * scaleFactor;
    const isWide = imgW >= imgH;
    const w = isWide ? targetLongSide : targetLongSide * (imgW / imgH);
    const h = isWide ? targetLongSide * (imgH / imgW) : targetLongSide;
    return { w, h };
  }

  function estimateTextStitches(el) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${el.size}px ${el.font}`;
    const metrics = measure.measureText(el.text);
    const widthIn = metrics.width / TEXT_PX_PER_INCH;
    const heightIn = ((metrics.actualBoundingBoxAscent || el.size * 0.8) + (metrics.actualBoundingBoxDescent || el.size * 0.25)) / TEXT_PX_PER_INCH;
    const areaSqIn = widthIn * heightIn * TEXT_COVERAGE_FACTOR;
    return Math.round(areaSqIn * STITCH_DENSITY_PER_SQIN);
  }

  // Samples a small downscaled copy of the image to estimate what fraction
  // of its bounding box is non-transparent ("ink coverage").
  function computeOpaqueCoverage(imgOrCanvas) {
    const SAMPLE = 32;
    const c = document.createElement('canvas');
    c.width = SAMPLE; c.height = SAMPLE;
    const cx = c.getContext('2d');
    cx.drawImage(imgOrCanvas, 0, 0, SAMPLE, SAMPLE);
    const data = cx.getImageData(0, 0, SAMPLE, SAMPLE).data;
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 16) opaque++;
    }
    return opaque / (SAMPLE * SAMPLE);
  }

  function estimateImageStitches(el) {
    const dims = imgDims(el.img);
    const isWide = dims.w >= dims.h;
    const wIn = isWide ? el.sizeInches : el.sizeInches * (dims.w / dims.h);
    const hIn = isWide ? el.sizeInches * (dims.h / dims.w) : el.sizeInches;
    const coverage = el.__coverageRatio != null ? el.__coverageRatio : computeOpaqueCoverage(el.img);
    return Math.round(wIn * hIn * coverage * STITCH_DENSITY_PER_SQIN);
  }

  function imgDims(imgOrCanvas) {
    return {
      w: imgOrCanvas.naturalWidth || imgOrCanvas.width,
      h: imgOrCanvas.naturalHeight || imgOrCanvas.height,
    };
  }

  // ---------------------------------------------------------------------
  // Background removal — simple corner-sampled chroma-key heuristic.
  // Not ML segmentation: works well for logos on a plain/solid backdrop,
  // struggles with busy photo backgrounds. See README for upgrade path.
  // ---------------------------------------------------------------------
  function removeBackgroundHeuristic(imgOrCanvas, tolerance) {
    tolerance = tolerance || 32;
    const { w, h } = imgDims(imgOrCanvas);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.drawImage(imgOrCanvas, 0, 0, w, h);
    const imageData = cx.getImageData(0, 0, w, h);
    const px = imageData.data;

    const idx = (x, y) => (y * w + x) * 4;
    const corners = [idx(0, 0), idx(w - 1, 0), idx(0, h - 1), idx(w - 1, h - 1)];
    let r = 0, g = 0, b = 0;
    corners.forEach((i) => { r += px[i]; g += px[i + 1]; b += px[i + 2]; });
    r /= corners.length; g /= corners.length; b /= corners.length;

    const softBand = tolerance * 0.8;
    for (let i = 0; i < px.length; i += 4) {
      const dr = px[i] - r, dg = px[i + 1] - g, db = px[i + 2] - b;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < tolerance) {
        px[i + 3] = 0;
      } else if (dist < tolerance + softBand) {
        const t = (dist - tolerance) / softBand;
        px[i + 3] = Math.round(px[i + 3] * Math.min(1, Math.max(0, t)));
      }
    }
    cx.putImageData(imageData, 0, 0);
    return c;
  }

  // ---------------------------------------------------------------------
  // Embroidery-look rendering helpers
  // ---------------------------------------------------------------------

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#333333');
    if (!m) return { r: 51, g: 51, b: 51 };
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  function applyStitchTexture(ctx, w, h, threadColor) {
    const { r, g, b } = hexToRgb(threadColor);
    const light = `rgba(${Math.min(255, r + 80)},${Math.min(255, g + 80)},${Math.min(255, b + 80)},0.30)`;
    const dark = `rgba(${Math.max(0, r - 80)},${Math.max(0, g - 80)},${Math.max(0, b - 80)},0.30)`;
    ctx.save();
    ctx.globalCompositeOperation = 'source-atop';
    ctx.lineWidth = 1.1;
    const spacing = 3;
    let toggle = false;
    for (let offset = -h; offset < w + h; offset += spacing) {
      ctx.strokeStyle = toggle ? light : dark;
      ctx.beginPath();
      ctx.moveTo(offset, 0);
      ctx.lineTo(offset - h, h);
      ctx.stroke();
      toggle = !toggle;
    }
    ctx.restore();
  }

  function buildEmbroideredTextLayer(el) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = `${el.size}px ${el.font}`;
    const metrics = measure.measureText(el.text);
    const width = Math.max(1, metrics.width);
    const ascent = metrics.actualBoundingBoxAscent || el.size * 0.8;
    const descent = metrics.actualBoundingBoxDescent || el.size * 0.25;
    const pad = Math.ceil(el.size * 0.2) + 3;
    const w = Math.ceil(width + pad * 2);
    const h = Math.ceil(ascent + descent + pad * 2);

    const layer = document.createElement('canvas');
    layer.width = w; layer.height = h;
    const lctx = layer.getContext('2d');
    lctx.font = `${el.size}px ${el.font}`;
    lctx.textBaseline = 'alphabetic';
    lctx.textAlign = 'left';
    const baseX = pad;
    const baseY = pad + ascent;

    lctx.fillStyle = 'rgba(0,0,0,0.35)';
    lctx.fillText(el.text, baseX + 1.4, baseY + 1.4);
    lctx.fillStyle = 'rgba(255,255,255,0.30)';
    lctx.fillText(el.text, baseX - 1, baseY - 1);
    lctx.fillStyle = el.color;
    lctx.fillText(el.text, baseX, baseY);

    applyStitchTexture(lctx, w, h, el.color);

    const { r, g, b } = hexToRgb(el.color);
    lctx.strokeStyle = `rgba(${Math.max(0, r - 90)},${Math.max(0, g - 90)},${Math.max(0, b - 90)},0.6)`;
    lctx.lineWidth = 0.6;
    lctx.strokeText(el.text, baseX, baseY);

    return { canvas: layer, w, h };
  }

  function buildEmbroideredImageLayer(el, targetW, targetH) {
    const w = Math.max(1, Math.round(targetW));
    const h = Math.max(1, Math.round(targetH));
    const layer = document.createElement('canvas');
    layer.width = w; layer.height = h;
    const lctx = layer.getContext('2d');

    lctx.filter = 'contrast(1.15) saturate(1.3)';
    lctx.drawImage(el.img, 0, 0, w, h);
    lctx.filter = 'none';

    applyStitchTexture(lctx, w, h, '#8a8a8a'); // neutral thread tone; artwork can be multi-color
    lctx.strokeStyle = 'rgba(0,0,0,0.25)';
    lctx.lineWidth = 1;
    lctx.strokeRect(0.5, 0.5, w - 1, h - 1); // approximates a satin-stitch border; see README for a real silhouette-trace extension

    return { canvas: layer, w, h };
  }

  // opts: { displayScale, pxPerInch } — displayScale=1 means "native mockup resolution".
  function drawEmbroideredElement(destCtx, el, opts) {
    if (!el) return;
    let layer;
    if (el.type === 'text' && el.text) {
      layer = buildEmbroideredTextLayer(el);
    } else if (el.type === 'image' && el.img) {
      const dims = imgDims(el.img);
      const { w: targetW, h: targetH } = imageTargetDimsPx(dims.w, dims.h, el.sizeInches, opts.pxPerInch, opts.displayScale);
      layer = buildEmbroideredImageLayer(el, targetW, targetH);
    } else {
      return;
    }
    destCtx.save();
    destCtx.shadowColor = 'rgba(0,0,0,0.35)';
    destCtx.shadowBlur = 3;
    destCtx.shadowOffsetX = 1;
    destCtx.shadowOffsetY = 1;
    destCtx.drawImage(layer.canvas, el.x - layer.w / 2, el.y - layer.h / 2);
    destCtx.restore();
  }

  function init(root) {
    const productType = root.dataset.productType || 'tshirt';
    const backendUrl = (root.dataset.backendUrl || '').replace(/\/$/, '');
    const formSelector = root.dataset.formSelector || "form[action*='/cart/add']";
    const basePrice = parseFloat(root.dataset.basePrice || '0');
    const addonVariantId = root.dataset.addonVariantId || null; // placement fee product ($3/unit)
    const stitchAddonVariantId = root.dataset.stitchAddonVariantId || null; // stitch surcharge product ($0.50/unit)
    const fallbackMockup = root.dataset.mockupSrc || '';
    // How many native mockup-photo pixels equal one real inch on the garment.
    // Calibrate once per store by measuring a known reference in your mockup
    // photos (e.g. a hoodie's chest width) — see README.
    const pxPerInch = parseFloat(root.dataset.pxPerInch || '75');

    let productImages = [];
    try { productImages = JSON.parse(root.dataset.productImages || '[]'); } catch { /* ignore */ }
    let variantColorMap = {};
    try { variantColorMap = JSON.parse(root.dataset.variantColorMap || '{}'); } catch { /* ignore */ }

    const placementKeys = PLACEMENT_BY_PRODUCT[productType] || ['front'];
    const mockupMap = buildMockupMap(productImages, placementKeys);

    root.innerHTML = buildMarkup(placementKeys);
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const chipsEl = root.querySelector('.ec-chips');
    const priceEl = root.querySelector('.ec-price-summary');
    const stitchLabelEl = root.querySelector('.ec-stitch-label');
    const colorLabelEl = root.querySelector('.ec-color-label');
    const statusEl = root.querySelector('.ec-status');
    const confirmBtn = root.querySelector('.ec-confirm-btn');

    // designs[placementKey] =
    //   { type:'text', text, font, size, color, x, y }
    // | { type:'image', img, sizeInches, x, y, originalDataUrl, bgRemoved, __coverageRatio }
    const designs = {};
    let activePlacement = placementKeys[0];
    let currentColor = root.dataset.initialColor || Object.keys(mockupMap)[0] || null;
    let dragging = false;
    let dragOffset = { x: 0, y: 0 };

    const imageCache = new Map();
    function loadMockupImage(color, placement) {
      const url = resolveMockupUrl(mockupMap, color, placement, fallbackMockup);
      const cacheKey = url || `${color}::${placement}`;
      if (imageCache.has(cacheKey)) return imageCache.get(cacheKey);
      const promise = new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(img);
        img.src = url || '';
      });
      imageCache.set(cacheKey, promise);
      return promise;
    }

    let activeMockupImg = null;
    async function ensureActiveMockup() {
      activeMockupImg = await loadMockupImage(currentColor, activePlacement);
    }

    function hasContent(key) {
      const d = designs[key];
      if (!d) return false;
      if (d.type === 'text') return !!d.text && d.text.trim().length > 0;
      if (d.type === 'image') return !!d.img;
      return false;
    }

    function activeKeysInOrder() {
      return placementKeys.filter(hasContent); // already canonical order -> index 0 is "main"
    }

    function estimateStitchesFor(key) {
      const el = designs[key];
      if (!el) return 0;
      if (el.type === 'text') return estimateTextStitches(el);
      if (el.type === 'image') return estimateImageStitches(el);
      return 0;
    }

    function computeChargeBreakdown() {
      const keys = activeKeysInOrder();
      const stitchCounts = keys.map(estimateStitchesFor);
      const { stitchSurcharge, perPlacement } = computeStitchSurcharge(stitchCounts);
      const extraPlacements = Math.max(0, keys.length - 1);
      const placementFee = extraPlacements * PRICE_PER_ADDITIONAL_PLACEMENT;
      return { keys, stitchCounts, perPlacement, stitchSurcharge, extraPlacements, placementFee, total: +(placementFee + stitchSurcharge).toFixed(2) };
    }

    function updatePriceSummary() {
      const b = computeChargeBreakdown();
      const count = b.keys.length;
      const parts = [`${count} placement${count === 1 ? '' : 's'} selected`];
      if (b.placementFee > 0) parts.push(`placement fee $${b.placementFee.toFixed(2)}`);
      if (b.stitchSurcharge > 0) parts.push(`stitch surcharge $${b.stitchSurcharge.toFixed(2)}`);
      if (basePrice > 0) parts.push(`- est. total $${(basePrice + b.total).toFixed(2)}`);
      priceEl.textContent = parts.join(' | ');
      confirmBtn.disabled = count === 0;
    }

    function updateStitchLabel() {
      const el = designs[activePlacement];
      if (!el || !hasContent(activePlacement)) {
        stitchLabelEl.textContent = '';
        return;
      }
      const keys = activeKeysInOrder();
      const idx = keys.indexOf(activePlacement);
      const stitches = estimateStitchesFor(activePlacement);
      const freeAllowance = idx === 0 ? FREE_STITCHES_MAIN : FREE_STITCHES_ADDITIONAL;
      const over = Math.max(0, stitches - freeAllowance);
      const thousands = Math.ceil(over / 1000);
      const charge = thousands * STITCH_RATE_PER_1000;
      const roleLabel = idx === 0 ? 'main placement' : 'additional placement';
      stitchLabelEl.textContent = over > 0
        ? `~${stitches.toLocaleString()} stitches (${roleLabel}, ${freeAllowance.toLocaleString()} free) -> +$${charge.toFixed(2)}`
        : `~${stitches.toLocaleString()} stitches (${roleLabel}, within ${freeAllowance.toLocaleString()} free)`;
    }

    function updateColorLabel() {
      colorLabelEl.textContent = currentColor ? `Viewing: ${currentColor}` : '';
      colorLabelEl.style.display = currentColor ? '' : 'none';
    }

    function resizeCanvasToStage() {
      const naturalW = (activeMockupImg && activeMockupImg.naturalWidth) || 800;
      const naturalH = (activeMockupImg && activeMockupImg.naturalHeight) || 800;
      const maxWidth = root.querySelector('.ec-stage').clientWidth;
      const scale = maxWidth / naturalW;
      canvas.width = naturalW * scale;
      canvas.height = naturalH * scale;
    }

    function render() {
      resizeCanvasToStage();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (activeMockupImg && activeMockupImg.complete && activeMockupImg.naturalWidth) {
        ctx.drawImage(activeMockupImg, 0, 0, canvas.width, canvas.height);
      }
      const naturalW = (activeMockupImg && activeMockupImg.naturalWidth) || canvas.width;
      const displayScale = canvas.width / naturalW;
      drawEmbroideredElement(ctx, designs[activePlacement], { displayScale, pxPerInch });
    }

    // ---- drag to reposition the active placement's design ----
    canvas.addEventListener('pointerdown', (e) => {
      const el = designs[activePlacement];
      if (!el) return;
      dragging = true;
      const r = canvas.getBoundingClientRect();
      dragOffset = { x: e.clientX - r.left - el.x, y: e.clientY - r.top - el.y };
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const el = designs[activePlacement];
      if (!el) return;
      const r = canvas.getBoundingClientRect();
      el.x = Math.max(0, Math.min(canvas.width, e.clientX - r.left - dragOffset.x));
      el.y = Math.max(0, Math.min(canvas.height, e.clientY - r.top - dragOffset.y));
      render();
    });
    window.addEventListener('pointerup', () => { dragging = false; });

    // ---- placement chips ----
    function renderChips() {
      chipsEl.querySelectorAll('.ec-chip').forEach((chip) => {
        const key = chip.dataset.placement;
        chip.classList.toggle('active', key === activePlacement);
        chip.classList.toggle('filled', hasContent(key));
      });
    }
    chipsEl.querySelectorAll('.ec-chip').forEach((chip) => {
      chip.addEventListener('click', async (e) => {
        if (e.target.classList.contains('ec-chip-remove')) return;
        activePlacement = chip.dataset.placement;
        syncEditorToActivePlacement();
        renderChips();
        await ensureActiveMockup();
        render();
        updateStitchLabel();
      });
      const removeBtn = chip.querySelector('.ec-chip-remove');
      removeBtn.addEventListener('click', () => {
        delete designs[chip.dataset.placement];
        if (activePlacement === chip.dataset.placement) render();
        renderChips();
        updatePriceSummary();
        updateStitchLabel();
      });
    });

    // ---- tabs: text vs image (apply to whichever placement is active) ----
    const tabButtons = root.querySelectorAll('.ec-tab');
    tabButtons.forEach(btn => btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      root.querySelectorAll('.ec-panel').forEach(p => p.classList.add('hidden'));
      root.querySelector(`.ec-panel[data-panel="${btn.dataset.tab}"]`).classList.remove('hidden');
    }));

    // ---- text controls ----
    const textInput = root.querySelector('.ec-text-input');
    const fontSelect = root.querySelector('.ec-font-select');
    const sizeSelect = root.querySelector('.ec-size-select');
    const colorInput = root.querySelector('.ec-color-input');

    function syncTextElement() {
      const prev = designs[activePlacement];
      if (!textInput.value) {
        if (prev && prev.type === 'text') delete designs[activePlacement];
        render(); renderChips(); updatePriceSummary(); updateStitchLabel();
        return;
      }
      designs[activePlacement] = {
        type: 'text',
        text: textInput.value,
        font: fontSelect.value,
        size: parseInt(sizeSelect.value, 10),
        color: colorInput.value,
        x: prev && prev.type === 'text' ? prev.x : canvas.width / 2,
        y: prev && prev.type === 'text' ? prev.y : canvas.height / 2,
      };
      render(); renderChips(); updatePriceSummary(); updateStitchLabel();
    }
    [textInput, fontSelect, sizeSelect, colorInput].forEach(el =>
      el.addEventListener('input', syncTextElement)
    );

    // ---- image upload + background removal + size (inches) control ----
    const fileInput = root.querySelector('.ec-file-input');
    const removeBgCheckbox = root.querySelector('.ec-remove-bg-checkbox');
    const imageSizeInput = root.querySelector('.ec-image-size-input');
    const imageSizeLabel = root.querySelector('.ec-image-size-label');

    function updateImageSizeLabel() {
      imageSizeLabel.textContent = `Embroidery size (longer side): ${parseFloat(imageSizeInput.value).toFixed(1)}"`;
    }

    function applyBackgroundRemovalIfChecked(rawImg, el) {
      if (removeBgCheckbox.checked) {
        el.img = removeBackgroundHeuristic(rawImg);
        el.bgRemoved = true;
      } else {
        el.img = rawImg;
        el.bgRemoved = false;
      }
      el.__coverageRatio = computeOpaqueCoverage(el.img);
    }

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const originalDataUrl = reader.result;
        const rawImg = new Image();
        rawImg.onload = () => {
          const el = {
            type: 'image',
            img: null,
            rawImg,
            sizeInches: IMAGE_DEFAULT_INCHES,
            x: canvas.width / 2,
            y: canvas.height / 2,
            originalDataUrl,
          };
          applyBackgroundRemovalIfChecked(rawImg, el);
          designs[activePlacement] = el;
          imageSizeInput.value = String(IMAGE_DEFAULT_INCHES);
          updateImageSizeLabel();
          render(); renderChips(); updatePriceSummary(); updateStitchLabel();
        };
        rawImg.src = originalDataUrl;
      };
      reader.readAsDataURL(file);
    });

    removeBgCheckbox.addEventListener('change', () => {
      const el = designs[activePlacement];
      if (!el || el.type !== 'image' || !el.rawImg) return;
      applyBackgroundRemovalIfChecked(el.rawImg, el);
      render(); updatePriceSummary(); updateStitchLabel();
    });

    imageSizeInput.addEventListener('input', () => {
      updateImageSizeLabel();
      const el = designs[activePlacement];
      if (el && el.type === 'image') {
        el.sizeInches = parseFloat(imageSizeInput.value);
        render();
        updatePriceSummary();
        updateStitchLabel();
      }
    });

    function syncEditorToActivePlacement() {
      const d = designs[activePlacement];
      if (d && d.type === 'text') {
        tabButtons[0].click();
        textInput.value = d.text;
        fontSelect.value = d.font;
        sizeSelect.value = String(d.size);
        colorInput.value = d.color;
      } else if (d && d.type === 'image') {
        tabButtons[1].click();
        textInput.value = '';
        imageSizeInput.value = String(d.sizeInches);
        removeBgCheckbox.checked = !!d.bgRemoved;
        updateImageSizeLabel();
      } else {
        textInput.value = '';
        imageSizeInput.value = String(IMAGE_DEFAULT_INCHES);
        removeBgCheckbox.checked = false;
        updateImageSizeLabel();
      }
    }

    // ---- render a given placement (mockup + embroidered design) to its own flattened PNG ----
    async function renderPlacementToDataURL(key) {
      const img = await loadMockupImage(currentColor, key);
      const naturalW = (img && img.naturalWidth) || canvas.width;
      const naturalH = (img && img.naturalHeight) || canvas.height;
      const temp = document.createElement('canvas');
      temp.width = naturalW;
      temp.height = naturalH;
      const tctx = temp.getContext('2d');
      if (img && img.complete && img.naturalWidth) tctx.drawImage(img, 0, 0, naturalW, naturalH);

      const scaleFactor = naturalW / canvas.width;
      const el = designs[key];
      if (el) {
        const scaledEl = { ...el, x: el.x * scaleFactor, y: el.y * scaleFactor };
        if (el.type === 'text') scaledEl.size = el.size * scaleFactor;
        // el.sizeInches is a physical measurement (resolution-independent) — no scaling needed for images.
        drawEmbroideredElement(tctx, scaledEl, { displayScale: 1, pxPerInch });
      }
      return temp.toDataURL('image/png');
    }

    // ---- confirm & save all placements, then hand off to Shopify's cart ----
    confirmBtn.addEventListener('click', async () => {
      const keys = activeKeysInOrder();
      if (keys.length === 0) {
        statusEl.textContent = 'Add a design to at least one placement first.';
        return;
      }
      confirmBtn.disabled = true;
      statusEl.textContent = 'Saving your design...';

      const placements = [];
      for (const key of keys) {
        const el = designs[key];
        const stitches = estimateStitchesFor(key);
        const summary = el.type === 'text'
          ? { type: 'text', text: el.text, font: el.font, size: el.size, color: el.color, estimatedStitches: stitches }
          : { type: 'image', sizeInches: el.sizeInches, bgRemoved: !!el.bgRemoved, estimatedStitches: stitches };
        placements.push({
          placement: key,
          elements: [summary],
          previewImage: await renderPlacementToDataURL(key),
          originalImage: el.type === 'image' ? el.originalDataUrl : null,
        });
      }

      try {
        const resp = await fetch(`${backendUrl}/api/designs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productType, placements }),
        });
        if (!resp.ok) throw new Error(`backend returned ${resp.status}`);
        const data = await resp.json(); // { designId, additionalCharge, placementFeeUnits, stitchSurchargeUnits, placements }

        const propsSummary = keys.map(k => {
          const el = designs[k];
          const label = PLACEMENT_LABELS[k] || k;
          return el.type === 'text' ? `${label}: "${el.text}"` : `${label}: uploaded artwork${el.bgRemoved ? ' (bg removed)' : ''}`;
        }).join(' | ');

        injectLineItemProperties(formSelector, {
          '_design_id': data.designId,
          'Embroidery placements': propsSummary,
          ...(currentColor ? { 'Color': currentColor } : {}),
          ...(data.placementFeeUnits > 0 ? { 'Additional placements': String(data.placementFeeUnits) } : {}),
          ...(data.additionalCharge > 0 ? { 'Embroidery surcharge': `$${data.additionalCharge.toFixed(2)}` } : {}),
        });

        wireCheckoutHandoff(formSelector, data.placementFeeUnits, data.stitchSurchargeUnits, addonVariantId, stitchAddonVariantId, statusEl);

        statusEl.textContent = data.additionalCharge > 0
          ? `Design saved! +$${data.additionalCharge.toFixed(2)} in embroidery surcharges will be added at checkout.`
          : 'Design saved! You can now add this to your cart.';
        root.querySelectorAll(formSelector + ' [type="submit"]').forEach(b => b.disabled = false);
      } catch (err) {
        console.error(err);
        statusEl.textContent = 'Could not save design - please try again.';
      } finally {
        confirmBtn.disabled = false;
      }
    });

    // ---- stay in sync with the theme's own color/variant picker ----
    function wireColorSync() {
      const form = document.querySelector(formSelector);
      if (!form || Object.keys(variantColorMap).length === 0) return;
      form.addEventListener('change', async () => {
        const formData = new FormData(form);
        const variantId = formData.get('id');
        const color = variantColorMap[variantId];
        if (color && color !== currentColor) {
          currentColor = color;
          updateColorLabel();
          await ensureActiveMockup();
          render();
        }
      });
      document.addEventListener('variant:change', async (e) => {
        const variant = e.detail && e.detail.variant;
        if (!variant) return;
        const color = variantColorMap[String(variant.id)];
        if (color && color !== currentColor) {
          currentColor = color;
          updateColorLabel();
          await ensureActiveMockup();
          render();
        }
      });
    }

    window.addEventListener('resize', () => render());
    wireColorSync();
    updateImageSizeLabel();
    ensureActiveMockup().then(() => { renderChips(); updateColorLabel(); render(); updatePriceSummary(); updateStitchLabel(); });
  }

  // Adds the main product AND up to two addon products (placement fee,
  // stitch surcharge) to the cart in one request via the Ajax Cart API, using
  // the exact unit counts the BACKEND returned — not a client recomputation —
  // so the actual charge always matches what the server validated.
  function wireCheckoutHandoff(formSelector, placementFeeUnits, stitchSurchargeUnits, addonVariantId, stitchAddonVariantId, statusEl) {
    const form = document.querySelector(formSelector);
    if (!form) return;
    if (placementFeeUnits === 0 && stitchSurchargeUnits === 0) return; // native submit is fine, nothing extra to bill

    if ((placementFeeUnits > 0 && !addonVariantId) || (stitchSurchargeUnits > 0 && !stitchAddonVariantId)) {
      console.warn('Embroidery widget: a surcharge applies but the matching addon variant id is not configured - it will not be billed. See README.');
      return;
    }
    if (form.dataset.ecHandoffWired) return; // avoid stacking listeners across re-confirms
    form.dataset.ecHandoffWired = '1';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      statusEl.textContent = 'Adding to cart...';

      const formData = new FormData(form);
      const mainVariantId = formData.get('id');
      const qty = parseInt(formData.get('quantity') || '1', 10);
      const properties = {};
      for (const [key, value] of formData.entries()) {
        const m = /^properties\[(.+)\]$/.exec(key);
        if (m) properties[m[1]] = value;
      }

      const items = [{ id: mainVariantId, quantity: qty, properties }];
      if (placementFeeUnits > 0) items.push({ id: addonVariantId, quantity: placementFeeUnits * qty });
      if (stitchSurchargeUnits > 0) items.push({ id: stitchAddonVariantId, quantity: stitchSurchargeUnits * qty });

      try {
        const resp = await fetch('/cart/add.js', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items }),
        });
        if (!resp.ok) throw new Error(`cart add returned ${resp.status}`);
        window.location.href = '/cart';
      } catch (err) {
        console.error(err);
        statusEl.textContent = 'Could not add to cart - please try again.';
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  function injectLineItemProperties(formSelector, props) {
    const form = document.querySelector(formSelector);
    if (!form) {
      console.warn('Embroidery widget: could not find product form with selector', formSelector);
      return;
    }
    Object.entries(props).forEach(([name, value]) => {
      const inputName = `properties[${name}]`;
      let input = form.querySelector(`input[name="${CSS.escape(inputName)}"]`);
      if (!input) {
        input = document.createElement('input');
        input.type = 'hidden';
        input.name = inputName;
        form.appendChild(input);
      }
      input.value = value;
    });
  }

  function buildMarkup(placementKeys) {
    return `
      <div class="ec-widget">
        <div class="ec-stage">
          <canvas></canvas>
          <p class="ec-color-label"></p>
        </div>
        <div class="ec-controls">
          <div class="ec-field-label">Embroidery placements</div>
          <div class="ec-chips">
            ${placementKeys.map(key => `
              <button type="button" class="ec-chip" data-placement="${key}">
                ${PLACEMENT_LABELS[key] || key}
                <span class="ec-chip-remove" title="Remove design from this placement">&times;</span>
              </button>
            `).join('')}
          </div>
          <p class="ec-hint">First placement is the main placement (20,000 free stitches). Each additional placement is +$${PRICE_PER_ADDITIONAL_PLACEMENT.toFixed(2)} plus its own 5,000 free stitches.</p>

          <div class="ec-tabs">
            <button type="button" class="ec-tab active" data-tab="text">Add text</button>
            <button type="button" class="ec-tab" data-tab="image">Upload image</button>
          </div>

          <div class="ec-panel" data-panel="text">
            <label class="ec-field">Text
              <input type="text" class="ec-text-input" maxlength="30" placeholder="e.g. Est. 1998" />
            </label>
            <label class="ec-field">Font
              <select class="ec-font-select">
                ${FONTS.map(f => `<option value='${f.value}'>${f.label}</option>`).join('')}
              </select>
            </label>
            <label class="ec-field">Size
              <select class="ec-size-select">
                ${SIZES.map(s => `<option value="${s.px}">${s.label}</option>`).join('')}
              </select>
            </label>
            <label class="ec-field">Thread color
              <input type="color" class="ec-color-input" value="#1a1a1a" />
            </label>
          </div>

          <div class="ec-panel hidden" data-panel="image">
            <label class="ec-field">Upload artwork
              <input type="file" class="ec-file-input" accept="image/png,image/jpeg,image/svg+xml" />
            </label>
            <label class="ec-checkbox-field">
              <input type="checkbox" class="ec-remove-bg-checkbox" />
              Remove background (best for logos on a plain/solid background)
            </label>
            <label class="ec-field">
              <span class="ec-image-size-label">Embroidery size (longer side): 5.0"</span>
              <input type="range" class="ec-image-size-input" min="${IMAGE_MIN_INCHES}" max="${IMAGE_MAX_INCHES}" step="0.5" value="${IMAGE_DEFAULT_INCHES}" />
            </label>
            <p class="ec-hint">PNG/JPG/SVG. High-contrast logos embroider best. Drag the design on the mockup to position it.</p>
          </div>

          <p class="ec-stitch-label"></p>
          <p class="ec-price-summary"></p>
          <button type="button" class="ec-confirm-btn" disabled>Confirm design(s)</button>
          <p class="ec-status"></p>
        </div>
      </div>
    `;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('#embroidery-customizer, .embroidery-customizer').forEach(init);
    });
  }

  // Exposed for the pure-logic test suite (scripts/test-*.js) — harmless in production.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildMockupMap, resolveMockupUrl, computeStitchSurcharge, imageTargetDimsPx };
  }
})();
