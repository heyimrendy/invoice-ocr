'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    parseInvoice,
    registerMerchantParser,
} = require('../public/invoice-parser.js');

const MODERN_INVOICE = [
    '585086236919498040',
    'Penjual : "Onemed Official" Pembeli : "Rina Contoh"',
    'Tanggal Pembelian : "18 Juli 2026"',
    'Alamat Pengiriman : "Rina Contoh"((+62)8110000000)',
    'Jl. Contoh No. 1, Kota Contoh, 12345',
    'INFO PRODUK JUMLAH HARGA SATUAN TOTAL HARGA',
    'ORDER RECEIPT',
    'One Wipe Box isi 50 pcs Tissue Desinfektan',
    'OneMed',
    'Berat: 800 gr',
    '1 Rp36.500 Rp36.500',
    'SUBTOTAL HARGA PRODUK Rp36.500',
    'Voucher dari platform -Rp10.950',
    'Total ongkos kirim Rp9.500',
    'Voucher ongkir platform -Rp9.500',
    'Asuransi pengiriman Rp300',
    'Biaya jasa aplikasi Rp1.000',
    'TOTAL BELANJA Rp26.850',
    'TOTAL TAGIHAN Rp26.850',
    'Asuransi Pengiriman Tokopedia',
    'Metode Pembayaran:',
    'GoPay',
    'TOKOPEDIA',
    'NPWP: 0000000000000000',
    '11/11/26, 7:47 AM Invoice | Tokopedia',
    'https://www.tokopedia.com/invoice?id=585086236919498040',
].join('\n');

const SHIPPING_RECEIPT = [
    'S H I P P I N G  R E C E I P T',
    'Reference No. 585086236919498040 - 1',
    '18 Juli 2026',
    'RINCIAN PENGIRIMAN',
    'Penerima',
    'Orang Lain',
    'Pengirim',
    'Onemed Official',
    'Deskripsi',
    'One Wipe Box isi 50 pcs Tissue Desinfektan OneMed',
    'Berat: 800 gr Jml: 1',
    'RINCIAN PENGIRIMAN BIAYA',
    'Ongkos Kirim Rp9.500',
    'Diskon Ongkos Kirim -Rp9.500',
    'TOTAL Rp0',
    'TOKOPEDIA',
    'NPWP: 1111111111111111',
    'https://www.tokopedia.com/invoice?id=999999999999999999',
].join('\n');

const OLD_INVOICE = [
    'tokopedia',
    'Cetak',
    'Invoice',
    'Penjual Bandung Super Grosir        Pembayaran Mandiri e-cash',
    'Nomor INV/20170414/XVII/IV/78342975',
    'Tanggal 14 April 2017',
    '',
    'Nama Produk        Jumlah Barang  Berat  Harga Barang  Subtotal',
    'Smartfren Andromax M3Y 4G Free',
    'Perdana Kuota 30Gb',
    '1                  0.3 kg          Rp 250.000     Rp 250.000',
    'Subtotal                                          Rp 250.000',
    'JNE - Reguler      0.3 kg                         Rp 22.000',
    'Subtotal                                          Rp 22.000',
    '             Total                                Rp 272.000',
    '             Voucher & TopPoints (Untuk 2 invoice)',
    '             BEBASONGKIR30                        (Rp 30.000)',
    '             Subtotal                             (Rp 30.000)',
].join('\n');

const MULTI_PRODUCT = [
    'tokopedia',
    'Invoice',
    'Penjual : "Toko Multi" Pembeli : "Pembeli Uji"',
    'Nomor : INV/2026/001',
    'Tanggal : 01/08/2026',
    'INFO PRODUK JUMLAH HARGA SATUAN TOTAL HARGA',
    'ORDER RECEIPT',
    'Produk Pertama 50 pcs',
    'Varian A',
    '2 Rp10.000 Rp20.000',
    'Produk Kedua',
    '1 Rp5.000 Rp5.000',
    'SUBTOTAL HARGA PRODUK Rp25.000',
    'TOTAL TAGIHAN Rp25.000',
    'TOKOPEDIA',
].join('\n');

// Matches the line shape produced by the app's textContentToLines() for the
// modern Tokopedia PDF text layer: the description is inline with the numeric
// columns and the brand wraps onto the line after the row.
const PDFJS_LAYOUT_INVOICE = [
    '11/11/26, 7:47 AM  Invoice | Tokopedia',
    'O R D E R R E C E I P T',
    '585086236919498040',
    'Penjual  :  Onemed Official  Pembeli  :  Rina Contoh',
    'Tanggal Pembelian  :  18 Juli 2026',
    'Alamat Pengiriman  :  Rina Contoh  (  (+  62  )  8110000000  )',
    'INFO PRODUK  JUMLAH  HARGA SATUAN  TOTAL HARGA',
    'One Wipe Box isi 50 pcs Tissue Desinfektan  1  Rp36.500  Rp36.500',
    'OneMed',
    'Berat  :  800 gr',
    'SUBTOTAL HARGA PRODUK  Rp36.500',
    'Voucher dari platform  -  Rp10.950',
    'Total ongkos kirim  Rp9.500',
    'Voucher ongkir platform  -  Rp9.500',
    'Asuransi pengiriman  Rp300',
    'Biaya jasa aplikasi  Rp1.000',
    'TOTAL BELANJA  Rp26.850',
    'TOTAL TAGIHAN  Rp26.850',
    'TOKOPEDIA',
    'https://www.tokopedia.com/invoice?id=585086236919498040',
].join('\n');

const WRAPPED_MULTI_PRODUCT = [
    'tokopedia',
    'Invoice',
    'Penjual : "Toko Multi" Pembeli : "Pembeli Uji"',
    'Nomor : INV/2026/004',
    'Tanggal : 01/08/2026',
    'INFO PRODUK JUMLAH HARGA SATUAN TOTAL HARGA',
    'Produk Pertama 50 pcs  2  Rp10.000  Rp20.000',
    'Merek Pertama',
    'Produk Kedua  1  Rp5.000  Rp5.000',
    'Merek Kedua',
    'SUBTOTAL HARGA PRODUK Rp25.000',
    'TOTAL TAGIHAN Rp25.000',
    'TOKOPEDIA',
].join('\n');

const OLD_INLINE_INVOICE = [
    'tokopedia',
    'Cetak',
    'Invoice',
    'Penjual Bandung Super Grosir        Pembayaran Mandiri e-cash',
    'Nomor INV/20170414/XVII/IV/78342975',
    'Tanggal 14 April 2017',
    'Nama Produk        Jumlah Barang  Berat  Harga Barang  Subtotal',
    'Smartfren Andromax M3Y 4G Free Perdana Kuota 30Gb  1  0.3 kg  Rp 250.000  Rp 250.000',
    'Subtotal                                          Rp 250.000',
    'JNE - Reguler      0.3 kg                         Rp 22.000',
    'Subtotal                                          Rp 22.000',
    '             Total                                Rp 272.000',
    '             Voucher & TopPoints (Untuk 2 invoice)',
    '             BEBASONGKIR30                        (Rp 30.000)',
    '             Subtotal                             (Rp 30.000)',
].join('\n');

const TOTAL_NAMED_PRODUCT = [
    'tokopedia',
    'Invoice',
    'Penjual : "Toko Multi" Pembeli : "Pembeli Uji"',
    'Nomor : INV/2026/003',
    'Tanggal : 01/08/2026',
    'INFO PRODUK',
    'JUMLAH  HARGA SATUAN',
    'TOTAL HARGA',
    'Total Quartz 9000',
    '1 Rp50.000 Rp50.000',
    'Produk Kedua 50 pcs',
    '2 Rp10.000 Rp20.000',
    'Brand Kedua',
    'Berat: 100 gr',
    'SUBTOTAL HARGA PRODUK Rp70.000',
    'TOTAL TAGIHAN Rp70.000',
    'TOKOPEDIA',
].join('\n');

// The screenshot layout prints a product's description and weight above its
// numeric columns. The pending description must survive the metadata line.
const LEADING_DESCRIPTION_WEIGHT_INVOICE = [
    'tokopedia',
    'Invoice',
    'Penjual : "Toko Multi" Pembeli : "Pembeli Uji"',
    'Nomor : INV/2026/005',
    'Tanggal : 01/08/2026',
    'INFO PRODUK JUMLAH HARGA SATUAN TOTAL HARGA',
    'Produk Pertama',
    '1 Rp50.000 Rp50.000',
    'Produk Kedua',
    'Berat: 100 gr',
    '2 Rp10.000 Rp20.000',
    'SUBTOTAL HARGA PRODUK Rp70.000',
    'TOTAL TAGIHAN Rp70.000',
    'TOKOPEDIA',
].join('\n');

const GENERIC_TOKOPEDIA_MENTION = [
    'ACME Supplies Ltd.',
    'INVOICE',
    'Invoice No: ACME-TOKOPEDIA-1',
    'Invoice Date: 2026-02-03',
    'Description Qty Unit Price Amount',
    'Tokopedia Gift Card 1 25.00 25.00',
    'Subtotal 25.00',
    'Total 25.00',
].join('\n');

function addressHeaderBeforeShipping() {
    return [
        'Reference No. 585086236919498040 - 1',
        '19 Juli 2026',
        SHIPPING_RECEIPT,
    ].join('\n');
}

test('modern Tokopedia order invoice maps products and extra charges', () => {
    const invoice = parseInvoice(MODERN_INVOICE);
    assert.equal(invoice.merchant, 'tokopedia');
    assert.equal(invoice.vendor, 'Onemed Official');
    assert.equal(invoice.billTo, 'Rina Contoh');
    assert.equal(invoice.invoiceNumber, '585086236919498040');
    assert.equal(typeof invoice.invoiceNumber, 'string');
    assert.equal(invoice.invoiceDate, '2026-07-18');
    assert.equal(invoice.currency, 'IDR');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'One Wipe Box isi 50 pcs Tissue Desinfektan OneMed',
            quantity: 1,
            unitPrice: 36500,
            amount: 36500,
        },
    ]);
    assert.equal(invoice.subtotal, 36500);
    assert.equal(invoice.discount, 10950);
    assert.equal(invoice.shipping, 9500);
    assert.equal(invoice.shippingDiscount, 9500);
    assert.equal(invoice.insurance, 300);
    assert.equal(invoice.serviceFee, 1000);
    assert.equal(invoice.total, 26850);
    assert.deepEqual(invoice.warnings, []);
});

test('PDF.js text rows keep an inline description and append a wrapped brand', () => {
    const invoice = parseInvoice(PDFJS_LAYOUT_INVOICE);
    assert.equal(invoice.merchant, 'tokopedia');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'One Wipe Box isi 50 pcs Tissue Desinfektan OneMed',
            quantity: 1,
            unitPrice: 36500,
            amount: 36500,
        },
    ]);
    assert.equal(invoice.subtotal, 36500);
    assert.equal(invoice.discount, 10950);
    assert.equal(invoice.shipping, 9500);
    assert.equal(invoice.shippingDiscount, 9500);
    assert.equal(invoice.insurance, 300);
    assert.equal(invoice.serviceFee, 1000);
    assert.equal(invoice.total, 26850);
    assert.deepEqual(invoice.warnings, []);
});

test('shipping pages are ignored before and after the invoice, with or without form feeds', () => {
    const baseline = parseInvoice(MODERN_INVOICE);
    const header = addressHeaderBeforeShipping();

    assert.deepEqual(parseInvoice(`${MODERN_INVOICE}\f${SHIPPING_RECEIPT}`), baseline);
    assert.deepEqual(parseInvoice(`${SHIPPING_RECEIPT}\f${MODERN_INVOICE}`), baseline);
    assert.deepEqual(parseInvoice(`${MODERN_INVOICE}\f${header}`), baseline);
    assert.deepEqual(parseInvoice(`${MODERN_INVOICE}\n${header}`), baseline);
    assert.deepEqual(parseInvoice(`${header}\n${MODERN_INVOICE}`), baseline);
});

test('a shipping receipt alone produces an empty invoice with an explicit warning', () => {
    const invoice = parseInvoice(SHIPPING_RECEIPT);
    assert.equal(invoice.merchant, 'tokopedia');
    assert.equal(invoice.vendor, null);
    assert.equal(invoice.billTo, null);
    assert.equal(invoice.invoiceNumber, null);
    assert.equal(invoice.invoiceDate, null);
    assert.equal(invoice.currency, null);
    assert.deepEqual(invoice.lineItems, []);
    assert.equal(invoice.subtotal, null);
    assert.equal(invoice.shipping, null);
    assert.equal(invoice.total, null);
    assert.equal(invoice.warnings.length, 1);
    assert.match(invoice.warnings[0], /shipping receipt ignored/i);
    assert.match(invoice.warnings[0], /no invoice/i);
});

test('old Tokopedia screenshot keeps only the product row and flags a shared voucher', () => {
    const invoice = parseInvoice(OLD_INVOICE);
    assert.equal(invoice.merchant, 'tokopedia');
    assert.equal(invoice.vendor, 'Bandung Super Grosir');
    assert.equal(invoice.billTo, null);
    assert.equal(invoice.invoiceNumber, 'INV/20170414/XVII/IV/78342975');
    assert.equal(typeof invoice.invoiceNumber, 'string');
    assert.equal(invoice.invoiceDate, '2017-04-14');
    assert.equal(invoice.currency, 'IDR');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Smartfren Andromax M3Y 4G Free Perdana Kuota 30Gb',
            quantity: 1,
            unitPrice: 250000,
            amount: 250000,
        },
    ]);
    assert.equal(invoice.subtotal, 250000);
    assert.equal(invoice.shipping, 22000);
    assert.equal(invoice.total, 272000);
    assert.equal(invoice.discount, null);
    assert.deepEqual(invoice.vouchers, [
        {
            code: 'BEBASONGKIR30',
            amount: 30000,
            note: 'Untuk 2 invoice',
            applied: false,
        },
    ]);
    assert.match(invoice.warnings.join('\n'), /Untuk 2 invoice/);
    assert.match(invoice.warnings.join('\n'), /not applied/i);
    assert.ok(!invoice.lineItems.some((item) => /JNE|Reguler/i.test(item.description)));
});

test('old screenshot rows allow an inline description and ignore the weight column', () => {
    const invoice = parseInvoice(OLD_INLINE_INVOICE);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Smartfren Andromax M3Y 4G Free Perdana Kuota 30Gb',
            quantity: 1,
            unitPrice: 250000,
            amount: 250000,
        },
    ]);
    assert.equal(invoice.subtotal, 250000);
    assert.equal(invoice.shipping, 22000);
    assert.equal(invoice.total, 272000);
    assert.ok(!invoice.lineItems.some((item) => /JNE|Reguler|0\.3 kg/i.test(item.description)));
});

test('multiple wrapped product lines stay separate and keep pcs in descriptions', () => {
    const invoice = parseInvoice(MULTI_PRODUCT);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Produk Pertama 50 pcs Varian A',
            quantity: 2,
            unitPrice: 10000,
            amount: 20000,
        },
        {
            description: 'Produk Kedua',
            quantity: 1,
            unitPrice: 5000,
            amount: 5000,
        },
    ]);
    assert.equal(invoice.invoiceDate, '2026-08-01');
    assert.equal(invoice.invoiceNumber, 'INV/2026/001');
    assert.deepEqual(invoice.warnings, []);
});

test('wrapped descriptions after multiple inline rows stay with their product', () => {
    const invoice = parseInvoice(WRAPPED_MULTI_PRODUCT);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Produk Pertama 50 pcs Merek Pertama',
            quantity: 2,
            unitPrice: 10000,
            amount: 20000,
        },
        {
            description: 'Produk Kedua Merek Kedua',
            quantity: 1,
            unitPrice: 5000,
            amount: 5000,
        },
    ]);
    assert.equal(invoice.subtotal, 25000);
    assert.equal(invoice.total, 25000);
    assert.deepEqual(invoice.warnings, []);
});

test('TOTAL HARGA headers and Total-named products do not end the product table', () => {
    const invoice = parseInvoice(TOTAL_NAMED_PRODUCT);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Total Quartz 9000',
            quantity: 1,
            unitPrice: 50000,
            amount: 50000,
        },
        {
            description: 'Produk Kedua 50 pcs Brand Kedua',
            quantity: 2,
            unitPrice: 10000,
            amount: 20000,
        },
    ]);
    assert.equal(invoice.subtotal, 70000);
    assert.equal(invoice.total, 70000);
    assert.deepEqual(invoice.warnings, []);
});

test('weight metadata before the next row keeps that row\'s pending description', () => {
    const invoice = parseInvoice(LEADING_DESCRIPTION_WEIGHT_INVOICE);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Produk Pertama',
            quantity: 1,
            unitPrice: 50000,
            amount: 50000,
        },
        {
            description: 'Produk Kedua',
            quantity: 2,
            unitPrice: 10000,
            amount: 20000,
        },
    ]);
    assert.equal(invoice.subtotal, 70000);
    assert.equal(invoice.total, 70000);
    assert.deepEqual(invoice.warnings, []);
});

test('genuine modern arithmetic mismatches are still reported', () => {
    const broken = MODERN_INVOICE.replace('TOTAL TAGIHAN Rp26.850', 'TOTAL TAGIHAN Rp27.000');
    const invoice = parseInvoice(broken);
    assert.ok(
        invoice.warnings.some((warning) => warning.includes('26850') && warning.includes('27000')),
        invoice.warnings.join('\n'),
    );
});

test('branding and rupiah amounts alone do not trigger the Tokopedia adapter', () => {
    const merchantOnly = parseInvoice('tokopedia\nRp 10.000');
    assert.equal(merchantOnly.merchant, undefined);

    const generic = parseInvoice([
        'ACME Supplies Ltd.',
        'INVOICE',
        'Invoice No: GEN-1',
        'Invoice Date: 2026-01-02',
        'Description Qty Unit Price Amount',
        'Widget 1 10.00 10.00',
        'Subtotal 10.00',
        'Total 10.00',
    ].join('\n'));
    assert.equal(generic.merchant, undefined);
    assert.equal(generic.vendor, 'ACME Supplies Ltd.');
});

test('a generic invoice that mentions Tokopedia keeps the generic parser', () => {
    const invoice = parseInvoice(GENERIC_TOKOPEDIA_MENTION);
    assert.equal(invoice.merchant, undefined);
    assert.equal(invoice.vendor, 'ACME Supplies Ltd.');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Tokopedia Gift Card',
            quantity: 1,
            unitPrice: 25,
            amount: 25,
        },
    ]);
    assert.equal(invoice.total, 25);
});

test('generic parsing treats form feeds as line boundaries', () => {
    const page1 = [
        'ACME Supplies Ltd.',
        'INVOICE',
        'Invoice No: GEN-FEED',
        'Invoice Date: 2026-01-02',
    ].join('\n');
    const page2 = [
        'Description Qty Unit Price Amount',
        'Widget 1 10.00 10.00',
        'Subtotal 10.00',
        'Total 10.00',
    ].join('\n');
    assert.deepEqual(parseInvoice(`${page1}\f${page2}`), parseInvoice(`${page1}\n${page2}`));
});

test('registerMerchantParser validates adapters and Node dispatch works', () => {
    // @ts-expect-error intentionally malformed adapter is rejected at runtime
    assert.throws(() => registerMerchantParser({ id: 'missing-functions' }), /must define matches/);
    assert.throws(
        // @ts-expect-error intentionally incomplete adapter is rejected at runtime
        () => registerMerchantParser({ id: 'tokopedia', matches() {}, parse() {} }),
        /already registered/,
    );

    const adapter = {
        id: 'node-test-merchant',
        matches(text) {
            return text.includes('NODE TEST MERCHANT');
        },
        parse(text, options, helpers) {
            assert.equal(typeof helpers.parseGeneric, 'function');
            assert.equal(typeof helpers.parseAmount, 'function');
            assert.equal(typeof helpers.findDate, 'function');
            assert.equal(typeof helpers.detectCurrency, 'function');
            assert.equal(typeof helpers.checkInvoice, 'function');
            const invoice = helpers.parseGeneric(text, options);
            invoice.merchant = this.id;
            return invoice;
        },
    };
    assert.equal(registerMerchantParser(adapter), adapter);
    const invoice = parseInvoice('NODE TEST MERCHANT\nInvoice No: NODE-1\nTotal $5.00');
    assert.equal(invoice.merchant, 'node-test-merchant');
});

test('browser UMD loading and registration match the CommonJS behaviour', () => {
    const sandbox = { self: {} };
    const merchantsFile = path.join(__dirname, '..', 'public', 'merchants', 'tokopedia.js');
    const parserFile = path.join(__dirname, '..', 'public', 'invoice-parser.js');
    vm.runInNewContext(fs.readFileSync(merchantsFile, 'utf8'), sandbox, { filename: merchantsFile });
    vm.runInNewContext(fs.readFileSync(parserFile, 'utf8'), sandbox, { filename: parserFile });

    assert.ok(sandbox.self.InvoiceParserTokopedia);
    const parser = sandbox.self.InvoiceParser;
    assert.ok(parser);

    const modern = parser.parseInvoice(MODERN_INVOICE);
    assert.equal(modern.merchant, 'tokopedia');
    assert.equal(modern.total, 26850);
    assert.equal(modern.invoiceNumber, '585086236919498040');
    assert.equal(modern.vendor, 'Onemed Official');
    assert.equal(modern.billTo, 'Rina Contoh');

    const pdfRows = parser.parseInvoice(PDFJS_LAYOUT_INVOICE);
    assert.equal(pdfRows.lineItems.length, 1);
    assert.equal(pdfRows.lineItems[0].description, 'One Wipe Box isi 50 pcs Tissue Desinfektan OneMed');
    assert.equal(pdfRows.lineItems[0].quantity, 1);
    assert.equal(pdfRows.lineItems[0].unitPrice, 36500);
    assert.equal(pdfRows.lineItems[0].amount, 36500);
    assert.equal(pdfRows.total, 26850);
    assert.equal(parser.parseInvoice(SHIPPING_RECEIPT).lineItems.length, 0);

    const adapter = {
        id: 'browser-test-merchant',
        matches(text) {
            return text.includes('BROWSER TEST MERCHANT');
        },
        parse(text, options, helpers) {
            const invoice = helpers.parseGeneric(text, options);
            invoice.merchant = 'browser-test-merchant';
            return invoice;
        },
    };
    parser.registerMerchantParser(adapter);
    const custom = parser.parseInvoice('BROWSER TEST MERCHANT\nInvoice No: B-1\nTotal $5.00');
    assert.equal(custom.merchant, 'browser-test-merchant');
});

test('index.html loads the merchant adapter first and preserves PDF page boundaries', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const merchantScript = html.indexOf('merchants/tokopedia.js');
    const parserScript = html.indexOf('src="invoice-parser.js"');
    assert.ok(merchantScript !== -1);
    assert.ok(merchantScript < parserScript);
    assert.ok(html.includes("chunks.join('\\f')"));
});
