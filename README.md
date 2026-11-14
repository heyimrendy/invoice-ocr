# invoice-ocr

Drop an invoice (image or PDF) or scan it with your camera, then get structured JSON back.
OCR runs in the browser with Tesseract.js, so the file never leaves your device.

## Run

```
node server.js
```

Open http://localhost:3000. Use `PORT=8080 node server.js` (or `$env:PORT=8080` in PowerShell) to change the port.
The first run needs internet: Tesseract.js, its language data and pdf.js load from a CDN.

## Scan with the camera

1. Open the page over HTTPS or at http://localhost:3000 and click **Scan invoice**.
2. Allow camera access when the browser asks, then point the camera at the invoice and fill the frame.
3. Wait for the live preview, then hold the invoice steady and click **Capture**. The camera stops as soon as the frame is captured.
4. The captured photo goes through the same local OCR, preview, JSON, copy and download flow as an uploaded file.

Uploading, drag-and-drop, paste and the sample text still work as before. **Cancel** closes the camera and releases it; switching to an upload also releases the camera.

Camera access is only available on secure origins. `http://localhost` counts as secure, but opening this page from a phone at a plain `http://<LAN-IP>:3000` address does not, so the camera will be blocked there. To test on a phone, serve the page over HTTPS (for example with a local HTTPS proxy or tunnel) or upload a photo instead.

## Merchant-specific parsing

`parseInvoice` automatically dispatches to a registered merchant adapter when its
matcher recognises the text. Unknown documents keep using the generic parser, so
existing integrations do not need to change.

The built-in Tokopedia adapter (`public/merchants/tokopedia.js`) recognises
Tokopedia order receipts and PDFs. When a PDF contains a separate **SHIPPING
RECEIPT** page, the adapter drops that whole page before parsing. When flattened
text is supplied instead of form-feed separated pages, it removes the shipping
section (including any Reference/date header printed just before the shipping
heading). Shipping charges that appear on the order invoice itself, such as
`Total ongkos kirim`, are kept and included in the arithmetic check. A
shipping-receipt-only input therefore returns an empty invoice with an explicit
"shipping receipt ignored" warning instead of inventing products or totals.

Tokopedia results add these optional fields while keeping the common schema:

- `merchant`: always `"tokopedia"` for matched documents.
- `shippingDiscount`, `insurance`, `serviceFee`: merchant-specific charges used
  by the arithmetic check when present.
- `vouchers`: voucher metadata that cannot be allocated safely. For example,
  `BEBASONGKIR30` marked `Untuk 2 invoice` is preserved with `applied: false`
  and a warning, but is not subtracted from `discount`.

`discount` remains the product discount, and `shipping` remains the gross
shipping charge. Print timestamps are ignored; `invoiceDate` comes from the
`Tanggal Pembelian` / `Tanggal` label on the invoice page. Order IDs are kept as
strings so an 18-digit order number is never rounded by JavaScript numbers.
The adapter only handles the transcribed Tokopedia layouts it knows; new
merchant layouts should get their own module rather than weakening generic
extraction.

### Shopee shipping labels

The built-in Shopee adapter (`public/merchants/shopee.js`) recognises Shopee
and SPX shipping labels. These labels are not invoices, so a matched document
returns the common shape with `merchant: "shopee"` and
`documentType: "shipping_label"` instead of pretending to be an invoice.
Invoice-specific fields stay null: `invoiceNumber`, `invoiceDate`, `dueDate`,
`subtotal`, `discount`, `taxRate`, `tax`, `shipping`, `total` and `amountDue`.
The adapter does not run the generic invoice arithmetic or missing-invoice
checks. It warns when the order ID or product lines cannot be found, a line
quantity is uncertain, or flattened OCR text prevents assigning printed SKU or
variant metadata.

Labels add these fields:

- `orderId` and `trackingNumber`: kept as strings, so leading zeros and long
  order numbers survive.
- `orderDate`: from a printed `Waktu Pemesanan`, `Tanggal Pemesanan` or
  `Order Date` label.
- `shippingDeadline`: from `Batas Kirim` / `Batas Pengiriman`.
- `weight`: `{ value, unit }` with unit `g` or `kg`; `gr` and `gram` become `g`.
- `courier` and `payment`: only reported when explicitly printed. Recognised
  couriers include SPX, ID Express, JNE, J&T, SiCepat, AnterAja, Ninja Xpress
  and Pos Indonesia; payment is `COD`, `Cashless` or null. `COD Cek Dulu:
  Tidak` is not treated as COD.

`orderDate` and `shippingDeadline` are independent: the print timestamp and the
deadline are never used as fallbacks for the order date, and print timestamps
are ignored. Ambiguous dates follow the caller's `dateOrder` option (default
`dmy`). `invoiceDate` and `dueDate` remain null rather than duplicating label
dates into invoice fields. `currency` is only set from an explicitly printed
currency (for example `Rp` in a COD line) or the caller's `currency` override;
it is null otherwise.

Product lines keep `description`, `quantity`, `unitPrice: null` and
`amount: null`. When printed, `sku`, `variant` and `unit` are added. The
adapter handles the observed table layouts (`Nama Produk` with `Varian`/`SKU`
and `Qty`/`Jumlah` in printed column order) and headerless lines with a
quantity and unit such as `2 Botol` or `5 Pcs`. Wrapped descriptions, variants
and SKUs are joined by column; a wrapped SKU keeps its digits together. Footer
text such as `Total Qty:3` or `Total: 2` is a count, never a product quantity,
and COD amounts such as `COD: Rp 0` are payment metadata, never totals. A label
whose product quantity cannot be read keeps `quantity: null` and adds a
warning.

When OCR collapses the printed column gaps to single spaces, the adapter can
still recover row boundaries and trailing quantities from the header order, but
it cannot reliably separate multi-word variants or SKUs from the description.
Such a row keeps the full printed product text in `description`, omits the
structured `sku` and `variant` values rather than inventing a split, and adds a
warning that the metadata could not be separated reliably. Rows whose column
gaps survive continue to expose structured `sku` and `variant` values.

The browser OCR asks Tesseract.js to preserve interword spaces
(`preserve_interword_spaces: '1'`) so those printed gaps have a better chance
of surviving. If a worker does not expose `setParameters`, OCR continues with
the flattened-table fallback above.

For a photographed Shopee label, the browser also makes at most one extra OCR
pass restricted to the sender line. It runs only when the recognized text looks
like a positive Shopee label match (Shopee branding, a `Pengirim` field, a
product table and shipping-label evidence). The pass uses the sender word box
from the first recognition, requires a valid box inside the image, and replaces
only the visible recognized sender text before parsing. It never guesses or
rewrites letters: if the retry fails, the original OCR text is kept. Ordinary
invoices, PDF text layers and labels without that evidence never take the extra
pass. This sender retry does not correct misread SKUs, order numbers or tracking
numbers; those are reported as recognized.

A document needs a product table or headerless unit-quantity rows plus Shopee
or SPX branding or a tracking number to match. Generic invoices that merely
mention Shopee or SPX stay with the generic parser, as does a courier-only
waybill without order/product structure.

Shopee labels are often printed in small type and photographed sideways or
with glare. OCR rotation correction, deskew and glare removal are not part of
the pipeline (images only get grayscale and contrast stretch), so a rotated or
glared photo can produce unusable text. Straighten and re-photograph the label
before upload when the preview text is poor. The automated tests use sanitized
transcriptions of four observed layouts plus a raw OCR-shaped sample 1 fixture
with the damaged header and sender text seen from a real photo. They verify
parsing and the targeted sender replacement, not guaranteed recognition of
every image or every SKU/tracking digit.

### Shopee order receipts (Nota Pesanan)

The same Shopee adapter also recognises digital Shopee `Nota Pesanan` order
receipts. Matching needs Shopee evidence, the receipt title, buyer or seller
labels, a `No. Pesanan` field and the printed
`No. Produk Variasi Harga Produk Kuantitas Subtotal` product table. A generic
invoice that merely mentions Shopee, or a receipt title without that structure,
stays with the generic parser.

Receipt results use `documentType: "invoice_receipt"` and map:

- `vendor` from `Nama Penjual` and `billTo` from `Nama Pembeli`.
  `buyerAddress` and `buyerPhone` come from their labelled blocks; the phone is
  kept as a string rather than converted to a number.
- `invoiceNumber` from `No. Pesanan` (kept as a string), and `invoiceDate` from
  `Tanggal Transaksi`. The order number is not duplicated into `orderId`.
  `orderDate`, `dueDate` and `amountDue` stay null because the receipt does not
  print those labels.
- `lineItems` with the full product description, quantity, unit price, amount
  and, when the Variasi column is populated, `variant`. SKU and unit are not
  invented.
- `subtotal` from `Subtotal Pesanan`, `serviceFee` from `Biaya Layanan`,
  `discount` as the sum of the absolute voucher, Shopee-coin and payment
  promotion amounts, and `total` from `Total Pembayaran`.
- `currency` from the printed `Rp` amounts or the caller's currency override.

Shipping and tax are deliberately not mapped. `Subtotal Pengiriman`, the
PPN/NPWP footer, contact/address blocks outside the mapped buyer fields and
page markers such as `1 of 2` / `End of receipt` never become line items or
totals, so `shipping`, `tax` and `taxRate` stay null even when a shipping
subtotal is printed. The adapter still runs the normal invoice arithmetic
check. Sample 6 prints `Subtotal Pengiriman Rp6.500`; because that amount is
intentionally omitted, the check truthfully reports
`Subtotal, discount, tax and shipping give 59568, but total is 66068`. The
adapter does not fabricate a shipping value just to silence that warning.

The receipt table relies on the two-space column gaps produced by the app's
PDF text layer. Wrapped description and variant lines are joined in column
order, with only clear mid-word PDF breaks repaired; ordinary word boundaries
keep their space. Text between numeric rows is buffered and assigned against
both adjacent rows: a capitalized multi-word title can start the next product,
while a lowercase or numeric remainder stays with the previous product. A
short product may print its description inline on the numeric row; a lone
cell becomes the description when no wrapped next-product description is
present, while a lone cell after a wrapped next-product description is the
Variasi value. When both the wrapped text and a lone inline cell look like
product titles, or when a needed next description cannot be identified, the
text is preserved with an explicit warning instead of silently inventing a
variant. When OCR collapses all gaps, the middle text is kept whole instead of
guessing which words belong to Produk or Variasi. The sanitized fixtures in
`test/shopee-receipt-parser.test.js` cover the three observed receipts,
inline and mixed wrapped/inline rows, long continuations, ambiguous ownership
warnings, multi-page footers, contact boundaries, skipped fields, narrow
matching and the browser UMD path.

### Adding a merchant adapter

The parser is a plain browser script (also CommonJS). Load an adapter before
`invoice-parser.js`, or require/register it in Node:

```js
const { registerMerchantParser, parseInvoice } = require('./public/invoice-parser.js');

registerMerchantParser({
    id: 'acme',
    matches(text) {
        return /\bACME INVOICE\b/i.test(text);
    },
    parse(text, options, helpers) {
        const invoice = helpers.parseGeneric(text, options);
        invoice.merchant = 'acme';
        invoice.warnings = helpers.checkInvoice(invoice);
        return invoice;
    },
});
```

The adapter contract is `{ id, matches(text), parse(text, options, helpers) }`.
`helpers` provides `parseGeneric`, `parseAmount`, `findDate`, `detectCurrency`
and `checkInvoice`. Adapters must call `helpers.parseGeneric`, never the public
`parseInvoice`, to avoid recursive dispatch. IDs must be unique; registering a
duplicate ID throws, and matchers run in registration order with the first match
winning. In the browser an adapter can expose itself as a global and be passed
explicitly by the parser wrapper, as the built-in Tokopedia and Shopee modules
do; it does not need to require the parser.

## Test

```
node --test
```

## Layout

```
invoice-ocr/
├── server.js                    static file server for ./public (no dependencies)
├── package.json
├── jsconfig.json                JSDoc type checking in VS Code (checkJs)
├── public/
│   ├── index.html               UI: upload, camera capture, OCR, JSON output
│   ├── invoice-parser.js        OCR text -> invoice JSON (browser and Node)
│   ├── ocr-layout.js            sender word-box ROI and text replacement helpers
│   └── merchants/
│       ├── shopee.js            Shopee shipping-label and receipt adapter
│       └── tokopedia.js         Tokopedia invoice/shipping-receipt adapter
└── test/
    ├── invoice-parser.test.js   parser tests
    ├── ocr-layout.test.js       OCR layout helper tests
    ├── shopee-parser.test.js    Shopee label fixtures, dispatch and UMD tests
    ├── shopee-receipt-parser.test.js Shopee receipt fixtures and regressions
    ├── tokopedia-parser.test.js Tokopedia fixtures, dispatch and UMD tests
    └── scan-camera.test.js      camera lifecycle, capture and OCR pipeline tests
```

`public/` is a plain static site. To host it somewhere else (Cloudflare Pages, GitHub Pages, Netlify), upload just that folder.

## Output

```json
{
    "vendor": "ACME Supplies Ltd.",
    "billTo": "Globex Corporation",
    "invoiceNumber": "INV-2026-0042",
    "invoiceDate": "2026-11-03",
    "dueDate": "2026-12-03",
    "currency": "USD",
    "lineItems": [
        { "description": "Widget A", "quantity": 10, "unitPrice": 12.5, "amount": 125 }
    ],
    "subtotal": 474.98,
    "discount": null,
    "taxRate": 10,
    "tax": 47.5,
    "shipping": 20,
    "total": 542.48,
    "amountDue": null,
    "warnings": []
}
```

`warnings` lists arithmetic mismatches (quantity × price, line items vs subtotal, subtotal + tax vs total), which usually mean OCR misread a digit.

## Using the parser elsewhere

```js
const { parseInvoice } = require('./public/invoice-parser.js');
const invoice = parseInvoice(ocrText, { dateOrder: 'dmy', currency: 'IDR' });
```
