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

A document needs a product table or headerless unit-quantity rows plus Shopee
or SPX branding or a tracking number to match. Generic invoices that merely
mention Shopee or SPX stay with the generic parser, as does a courier-only
waybill without order/product structure.

Shopee labels are often printed in small type and photographed sideways or
with glare. OCR rotation correction, deskew and glare removal are not part of
the pipeline (images only get grayscale and contrast stretch), so a rotated or
glared photo can produce unusable text. Straighten and re-photograph the label
before upload when the preview text is poor. The automated tests use sanitized
transcriptions of four observed layouts; they verify parsing of those
transcriptions, not full recognition of every image.

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
│   └── merchants/
│       ├── shopee.js            Shopee shipping-label adapter
│       └── tokopedia.js         Tokopedia invoice/shipping-receipt adapter
└── test/
    ├── invoice-parser.test.js   parser tests
    ├── shopee-parser.test.js    Shopee fixtures, dispatch and UMD tests
    ├── tokopedia-parser.test.js Tokopedia fixtures, dispatch and UMD tests
    └── scan-camera.test.js      camera lifecycle and capture tests (mocked browser)
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
