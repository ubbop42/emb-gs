# Custom Embroidery Customizer — Shopify Prototype

Lets customers upload artwork or type text (with preset fonts/sizes) on a hat,
t-shirt, hoodie, or polo, see it live on the actual product photo, and have
the finished design land in your backend automatically the moment they place
the order — ready for your production/embroidery team to pull up and digitize.

## Placements & pricing

- **Hoodie / t-shirt / polo / babysuit:** up to 4 embroidery placements —
  front, back, right sleeve, left sleeve.
- **Hat:** up to 3 placements — front, left panel, right panel.
- The **first placement is included** in the product's price. **Every
  placement after that adds $3.** (E.g. front + back + right sleeve on a
  hoodie = 3 placements = +$6.)
- This limit isn't a UI restriction bolted on top — each product type
  literally only offers that many placement options, so "up to 4" / "up to
  3" falls out naturally rather than needing separate cap logic.
- The backend re-validates every placement against the allowed list per
  product type and rejects anything invalid or duplicated — the price and
  placement rules aren't just trusted from the browser.

**How the $3 upcharge actually gets billed:** Shopify line item properties
(what carries the design reference through checkout) are metadata only —
they can't change price on their own, and doing that natively needs either
Shopify Plus (Scripts) or Shopify Functions. Instead, this prototype adds a
second real line item to the cart: N units of a plain "$3 Additional
Embroidery Placement" product, where N = placements beyond the first. That
keeps it working on any Shopify plan. See "Installing into an actual
Shopify store" below for the one-time setup step this needs.

## Embroidery-look rendering

Text and uploaded artwork aren't drawn as flat shapes — the widget renders
them onto their own transparent offscreen canvas first, gives them a soft
bevel (dark + light offset passes, so edges look raised) and a diagonal
"twisted thread" stitch texture composited with `source-atop` (so the
texture only touches the design pixels, never the product photo behind
it), then drops the result onto the product mockup with a subtle shadow for
depth. It's a visual approximation for the customer-facing preview — not a
real digitizing simulation — and it **never touches the original uploaded
artwork file**, which is stored and handed to your production team
untouched for actual embroidery digitizing.

## Image sizing, background removal, and stitch-count pricing

**Physical size, not percent:** uploaded artwork is sized by its **longer
side**, 3"–12", via a slider — the shorter side scales automatically to
preserve aspect ratio. This is resolution-independent (stored as
`sizeInches`, a real physical measurement), so it stays correct regardless
of browser window size. `data-px-per-inch` on the widget calibrates inches
to your mockup photos' native pixel resolution — measure a known reference
in one of your product photos (e.g. a hoodie's chest width) once per store
and set that value; it defaults to 75.

**Background removal:** a checkbox next to the image upload runs a simple
corner-sampled chroma-key heuristic — it samples the four corner pixels of
the uploaded image as "the background color" and makes similar-colored
pixels transparent, with a soft-edged falloff band to avoid jagged edges.
This is **not ML segmentation** — it works well for logos shot on a plain,
solid backdrop, and won't cleanly separate a subject from a busy photo
background. Verified with a Playwright test using a red-circle-on-white-
square test image: the white square correctly disappears, leaving just the
circle. The original, unprocessed upload is still stored and sent to your
production team untouched regardless of whether this toggle is used —
background removal only affects the on-screen preview and stitch estimate.

**Stitch-count calculator ("simple engineered" — not a real digitizer):**
- Text: estimated ink coverage (~40% of the letters' bounding box, a typical
  rule of thumb for block lettering) × a fill-stitch density constant
  (1,500 stitches/sq inch, another common rule of thumb).
- Images: the same density constant × the artwork's actual **opaque pixel
  ratio** (sampled from a small downscaled copy of the image — so a sparse
  logo gets a lower estimate than a solid block, and running background
  removal first correctly lowers the estimate too, since transparent pixels
  no longer count as coverage) × the physical area from the inches the
  shopper picked.
- **Pricing:** the *main* placement (first one, canonical order — front is
  main whenever it's selected) gets 20,000 free stitches. *Every additional
  placement* gets its own 5,000 free stitches. $0.50 per 1,000 stitches (or
  part thereof) over that placement's own allowance. Verified with 6 unit
  test cases covering exact-threshold, partial-thousand rounding, and
  multi-placement scenarios (`scripts/test-stitch-calc.js`).
- **Billing integrity:** the widget shows a live estimate as the shopper
  edits, but the numbers that actually get billed come from the
  **backend's** response to `POST /api/designs` (`placementFeeUnits` /
  `stitchSurchargeUnits`) — the server recomputes the stitch surcharge from
  the reported stitch counts and is the source of truth used for the cart
  line items, not whatever the client last displayed.
- **Known limitation:** the backend currently trusts the *stitch count* the
  widget reports (recomputing font metrics and image-pixel coverage
  server-side would need a canvas-capable Node environment, e.g.
  `node-canvas`) — see "What to extend first."

## Color-aware mockup photos

Each product photo's **alt text** drives everything — tag it as
`"{Color} - {Placement}"`, e.g. `"Black - Front"`, `"Navy - Back"`. The
theme snippet just dumps every product image as raw `{alt, url}` JSON; the
widget's JavaScript (`buildMockupMap` / `resolveMockupUrl` in
`frontend/widget.js`) parses that convention and builds the
color → placement → photo map itself. No per-color Liquid branching, and no
code changes needed when you add a new color — just upload photos with the
right alt text.

Resolution order when the widget needs an image for a given color +
placement: exact match → that color's front photo (if e.g. you only have a
front shot for a color) → any other color's photo for that placement → the
widget's global fallback image. This means a store can start with just
front photos for every color and backfill back/sleeve shots later without
anything breaking in the meantime.

**Staying in sync with the theme's own color picker:** rather than
depending on any specific theme's JS internals, the widget listens for the
plain, native `change` event that always fires when a variant radio/select
changes, reads the resulting variant ID from the product form, and looks it
up in a `variantId → color` map the Liquid snippet generates
(`data-variant-color-map`). It also listens for the `variant:change` custom
event some newer themes (e.g. Dawn) dispatch, as a belt-and-suspenders
fallback. Verified with a Playwright test that changes a variant picker and
confirms the mockup photo actually swaps.

**At bigger catalog scale:** hand-tagging alt text on hundreds of products
gets tedious. Same JSON shape (`{alt, url}` pairs, or restructure to
`{color: {placement: url}}` directly), swap the source — e.g. a structured
JSON metafield populated via a bulk-editing tool like Matrixify — and
nothing in `widget.js` needs to change.

## Why this architecture

Building a full embedded Shopify admin app (OAuth, Polaris UI, App Bridge)
is real work and isn't needed to prove out the core idea. The two things
that actually make this work are Shopify-native and don't require an app at
all:

1. **Line item properties** — Shopify lets your storefront JS attach arbitrary
   custom key/value data to a cart item (`properties[...]`). It rides through
   checkout to the order automatically. That's how the widget hands off the
   design reference.
2. **Webhooks** — Shopify can POST you the full order the instant it's placed
   (`orders/create`). That's how your backend finds out a customized item was
   ordered and pulls the matching design.

So the whole system is: **storefront widget → your backend → webhook →
production dashboard**, with zero Shopify app review process required to get
a working version live. (When you're ready to add richer admin-side features —
editing designs from inside Shopify admin, order tagging, fulfillment holds —
*that's* when you'd graduate to a proper embedded app; see "What to extend
first" below.)

## Stack

- **Backend:** plain Node.js (`http` + `crypto` + `fs`, zero npm dependencies)
  so it runs anywhere with just `node server.js`. Flat JSON files stand in for
  a database — swap for Postgres/SQLite when you're past prototyping.
- **Frontend widget:** vanilla JS + HTML5 Canvas, no build step, no framework.
  Ships as a single `<script>` tag.
- **Shopify integration surface:** a Liquid snippet + one webhook.

```
embroidery-app/
├── backend/
│   ├── server.js         # HTTP server: design API, webhook receiver, admin API
│   ├── db.js              # flat-file JSON storage (swap for real DB later)
│   ├── data/               # designs.json / orders.json live here
│   ├── uploads/            # saved preview + original artwork images
│   └── public/admin.html   # production team dashboard
├── frontend/
│   ├── widget.js          # the embeddable customizer (canvas + upload + text)
│   └── widget.css
├── theme-snippet/
│   └── product-customizer.liquid   # how to embed it in a Shopify theme
├── scripts/
│   └── simulate-order.js  # fires a fake, correctly-signed orders/create webhook
└── README.md
```

## How it works, end to end

1. Customer lands on a product page tagged `embroiderable:hoodie` (or
   whatever your tag/metafield convention is).
2. The widget draws the product photo on a `<canvas>`, then lets them either
   type text (choosing from preset fonts/sizes/thread color) or upload an
   image — dragging it into position live on top of the mockup.
3. On **Confirm design**, the widget flattens the canvas to a PNG and POSTs
   `{ productType, view, elements, previewImage, originalImage }` to
   `POST /api/designs`. The backend saves it and returns a `designId`.
4. The widget writes `designId` (plus a human-readable summary) into hidden
   `properties[...]` inputs on Shopify's own add-to-cart form, then enables
   the Add to Cart button.
5. Customer checks out normally through Shopify.
6. Shopify fires `orders/create` to `POST /webhooks/orders-create`. The
   backend verifies the HMAC signature, scans line items for the
   `_design_id` property, and links the order to the stored design.
7. Your production team opens `/admin` and sees every order with a live
   preview thumbnail, the original uploaded artwork (for digitizing), text/
   font details, and a status dropdown (Received → In production →
   Completed).

## Running it locally

Requires only Node.js (18+; tested on 22). No `npm install` needed.

```bash
cd backend
node server.js
# Embroidery customizer backend running at http://localhost:3000
# Admin dashboard:  http://localhost:3000/admin
# Widget script:    http://localhost:3000/widget.js
```

### Try the widget without a Shopify store

Create a throwaway HTML file anywhere and open it in a browser:

```html
<link rel="stylesheet" href="http://localhost:3000/widget.css">
<form action="/cart/add" method="post">
  <div id="embroidery-customizer"
       data-product-type="hoodie"
       data-mockup-src="https://YOUR-IMAGE-URL/hoodie-front.jpg"
       data-backend-url="http://localhost:3000"
       data-form-selector="form[action*='/cart/add']"></div>
  <button type="submit" disabled>Add to cart</button>
</form>
<script src="http://localhost:3000/widget.js" defer></script>
```

Type some text or upload an image, drag it into place, hit **Confirm
design** — you'll see the Add to Cart button enable and hidden `properties[...]`
inputs appear in the form (inspect the DOM to see them).

### Test the color+placement mockup resolution logic

```bash
node scripts/test-mockup-logic.js
```

This imports the actual functions from `frontend/widget.js` (not a copy), so
it can't silently drift from the shipped code. Covers exact matches, the
same-color fallback, the cross-color fallback, and the global-fallback case.

### Test the stitch-count surcharge arithmetic

```bash
node scripts/test-stitch-calc.js
```

Also imports straight from `frontend/widget.js`. Covers the free-allowance
edge cases (exactly at the threshold, just over it), partial-thousand
rounding, and multi-placement scenarios where main and additional
placements have different free allowances.

### Test the order → design linking without a real Shopify order

```bash
# 1. grab a designId, e.g. from the browser test above, or via curl:
curl -X POST http://localhost:3000/api/designs \
  -H "Content-Type: application/json" \
  -d '{"productType":"hoodie","view":"left-chest","elements":[{"type":"text","text":"Est. 1998"}],"previewImage":"data:image/png;base64,iVBORw0KGgo="}'

# 2. fire a correctly-signed fake webhook referencing it:
node scripts/simulate-order.js <designId>

# 3. see it show up:
open http://localhost:3000/admin
```

## Installing into an actual Shopify store

1. **Host the backend** somewhere with a public HTTPS URL (Render, Fly.io,
   Railway, a small VPS — anything that can run Node). Update
   `data-backend-url` and the two `<script>`/`<link>` URLs in
   `theme-snippet/product-customizer.liquid` accordingly.
2. **Create two addon products:**
   - "Additional Embroidery Placement" — price $3.00, matches
     `PRICE_PER_ADDITIONAL_PLACEMENT` in both `widget.js` and `server.js`.
   - "Embroidery Stitch Surcharge" — price $0.50, matches
     `STITCH_RATE_PER_1000` in both files.
   Both: uncheck "Track quantity"/inventory, set Draft/hidden so neither
   shows up in your storefront on its own (they're only ever added
   programmatically). Copy their **variant IDs** into `addon_variant_id` and
   `stitch_addon_variant_id` in `product-customizer.liquid`.
3. **Calibrate `data-px-per-inch`.** Measure a known real-world dimension
   against your mockup photos' pixel width (e.g. if a hoodie is 22" wide
   chest-to-chest and that spans 1650px in your photo, that's 75px/inch) and
   set it in the snippet. This only affects how big an "X inch" embroidery
   looks in the live preview — it doesn't affect stitch pricing, which is
   based on the inches value directly.
4. **Tag your customizable products** — the snippet reads a tag like
   `embroiderable:hoodie` / `embroiderable:tshirt` / `embroiderable:hat` /
   `embroiderable:polo` / `embroiderable:babysuit`. Add these in Shopify
   Admin → Products, or via a metafield if you'd rather.
5. **Add per-placement product photos** (optional but recommended) — one
   photo per angle (front/back/sleeves, or front/left-panel/right-panel for
   hats), with the placement name in the image alt text, so the live preview
   shows the actual angle instead of reusing the front photo for everything.
   The snippet's matching logic is a starting point — adjust it to however
   you organize product photos.
5. **Add the snippet** to your product template: Online Store → Themes →
   Edit code → paste `product-customizer.liquid` into `snippets/`, then
   `{% render 'product-customizer' %}` inside `sections/main-product.liquid`.
6. **Register the webhook.** Simplest path: Shopify Admin → Settings →
   Notifications → Webhooks → "Create webhook" → Event: `Order creation`,
   Format: JSON, URL: `https://your-backend.example.com/webhooks/orders-create`.
   Copy the **signing secret** it shows you into `SHOPIFY_WEBHOOK_SECRET` in
   your backend's environment.
   (For a distributable app instead of a single-store setup, you'd register
   this webhook via the Shopify API during OAuth install instead of doing it
   by hand per store.)
7. Restart the backend with that env var set:
   `SHOPIFY_WEBHOOK_SECRET=whsec_xxx node server.js`

## What to extend first

Roughly in priority order for going from prototype to something you'd
actually run production orders through:

1. **Real database.** Flat JSON files will corrupt under concurrent writes.
   Swap `db.js` for SQLite (`better-sqlite3`) or Postgres — every other file
   only calls the functions `db.js` exports, so this is a contained change.
2. **Multiple elements per placement.** Each placement currently holds one
   design (text *or* image). If you want a customer to combine, say, a logo
   *and* text on the same "front" placement, extend each placement's state
   to hold an array of elements instead of one.
3. **Server-side stitch count verification.** The backend currently trusts
   the stitch count the widget reports in `estimatedStitches` — it recomputes
   the *pricing* from that number, but not the number itself. A shopper who
   tampered with the client JS could under-report stitches and underpay.
   Closing this needs a canvas-capable Node environment (e.g. `node-canvas`
   or a headless-browser render step) so the backend can independently
   measure font metrics / image pixel coverage from the stored artwork
   before finalizing a price — worth doing before this handles real money
   at scale, even though `/api/designs` already validates everything else
   (placements, product type) server-side.
4. **Better background removal.** The current chroma-key heuristic sample
   the four corners and thresholds by color distance — good for logos on a
   flat, solid backdrop, but it'll misfire on photos with gradients, shadows,
   or busy backgrounds. A real fix means either an ML segmentation model/API
   or at least a more robust classical approach (flood-fill from the edges
   instead of pure color-distance, so a large flat-colored *subject* near
   the edge isn't mistaken for background).
5. **Real embroidery constraints beyond stitch count.** A max colors-per-
   design limit, and DPI/vector checks on uploads (embroidery digitizers
   want vector or high-res source art, not a 200px JPEG) — reject or warn at
   upload time rather than finding out after digitizing.
6. **Auth on `/admin` and the design API.** Both are wide open right now.
   Put `/admin*` behind basic auth or a real login, and consider signing
   `/api/designs` requests so random people can't spam your uploads folder.
7. **Design edit/re-order flow.** Let a customer revisit a saved design from
   their account or order history (e.g., "buy again" on a past customization).
8. **Move to Shopify's Files API for artwork storage** instead of local disk,
   so uploads survive redeploys and scale past one server's disk.
9. **Real silhouette outline for embroidered images.** The image stitch
   texture currently outlines a rectangle around the artwork rather than
   tracing its actual (often transparent-background) shape — fine for a
   prototype, but a proper alpha-channel edge trace would look more like a
   genuine satin-stitch border.
10. **If you want in-Shopify-admin controls** (approve/reject designs, hold
    fulfillment until digitizing is done, order tagging) — that's the point
    where a proper embedded app (Remix + Polaris, OAuth-installed) pays off
    over the webhook-only approach used here.
