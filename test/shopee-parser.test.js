'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parseInvoice } = require('../public/invoice-parser.js');

/**
 * Builds a flattened OCR line with the observed column gaps. The padding is
 * the fixture's stand-in for the horizontal spacing Tesseract emits.
 * @param {string[]} cells
 * @param {number[]} widths
 * @returns {string}
 */
function columns(cells, widths) {
    return cells
        .map((cell, index) => String(cell).padEnd(widths[index] || 0))
        .join('')
        .replace(/\s+$/, '');
}

const WIDTHS_VARIANT_SKU_QTY = [5, 40, 14, 14, 6];
const WIDTHS_SKU_VARIANT_JUMLAH = [5, 40, 14, 14, 8];
const WIDTHS_SKU_VARIASI_QTY = [5, 46, 14, 28, 6];

// Shopee sample 1: Varian -> SKU -> Qty, wrapped SKU, COD Rp 0 and a print
// timestamp. Recipient and address are sanitized.
const LABEL_ONE = [
    'Shopee',
    'STANDARD',
    'SPX EXPRESS',
    'N-112',
    'SPXID06573671839B',
    'Penerima: Siti Contoh',
    'Pengirim: Flimty Official Shop',
    'Jalan Contoh (Kirim atas Jam 1siang PAKET JANGAN',
    'DILEMPAR) (Pagar stainless), KAB. SIDOARJO,',
    'WARU, JAWA TIMUR, ID, 61256',
    'Berat: 600 gr',
    'No.Pesanan: 2611110YKEYKNA',
    'Batas Kirim: 11-11-26',
    'COD: Rp 0',
    'WAJIB VIDEO UNBOXING! SEGEL RUSAK, JANGAN TERIMA',
    columns(['No.', 'Nama Produk', 'Varian', 'SKU', 'Qty'], WIDTHS_VARIANT_SKU_QTY),
    columns(['1', 'Flimty Fiber 1 Box (16 sachet)', 'Blackcurrant', '89972306008', '1'], WIDTHS_VARIANT_SKU_QTY),
    columns(['', '', '', '63', ''], WIDTHS_VARIANT_SKU_QTY),
    'No. Pesanan: 2611110YKEYKNA',
    '11-11-2026 07:51:04',
    'Halaman: 1',
    'Powered by desty',
].join('\n');

// Shopee sample 1 as recognized by Tesseract.js 5.1.1 from the real photo
// (3000px, grayscale + percentile contrast) with the buyer details sanitized.
// The printed table header lost the space in "NamaProduk" and "Qty" came out
// as "ay"; the row number is glued to the description and the SKU is damaged.
// Do not clean this fixture: it is the regression a tidy transcription misses.
const ACTUAL_SHAPEE_OCR = [
    'TT         -                             )                           S PX              ah    |',
    'SA      S| Shopee         ND ARD    LT',
    'Sa             N-112          |        © SPXID065736718398            RE',
    'Penerima: Siti Contoh                       Pengirim: Flimty Official hop  i ae',
    ':  “man (Kirim atas Jam 1siang PAKET JANGAN                        ig oo  >',
    '|       ~ DILEMPAR) (Pagar stainless), KAB. SIDOARJO,                                 Es',
    '. WARU, JAWA TIMUR, ID, 61256    aa                         1 or      eS',
    '|             SR 0 0  WARU        Fr        Ra',
    ' Berat: 600gr ~~ No.Pesanan: 2611110YKEYKNA      3% EE',
    ' Batas Kirim: 11-11-26 COD: Rp 0   [=] by [=]  Dn   Je “ 2',
    '                                                       :          4      Bt',
    'RB BB     :                                  |                                       DIA EGR',
    '1             | mi SS',
    'DD WJ Awan VIDEO UNBOXING SEGELLAKBAN RUSAK. JANGAN TERIA [RES + +',
    'L | No. NamaProduk                      Varian           SKU          ay (AGE... Po',
    'Co Sa    <<       :        mame Ls A Ee SP pS       <  Pgs 7 24',
    '1. Flimty Fiber 1 Box (16 sachet)           Blackcurrant       Edie 00008   1           -     =  =',
    'cee wens [',
    ': |                                           Print Count: 1 a 5 ER  5 hes',
    '11-11-2026 07:51:04                   . Halaman: 1                  Powered by {J desty BREE EEE',
].join('\n');

// Shopee sample 2: SKU -> Varian -> Jumlah, a long wrapped pen description
// and a wrapped SKU. Total Qty is a footer count, not a quantity source.
const LABEL_TWO = [
    'Shopee',
    'STD',
    'SPX',
    'NO.007',
    'N-112',
    'No.Resi: SPXID066002195848',
    'Penerima: Jullia Contoh',
    '******35',
    'Jalan Contoh DN 37, wisma contoh, kepuh 62878',
    'Pengirim: toko snarmega',
    'Metode Pengiriman: PICK_UP',
    'Nama Toko: toko snarmega',
    'Waktu Pemesanan: 2026-11-11 00:01:53',
    'Berat: 75g',
    'Batas Pengiriman: 2026-11-11 23:59:59',
    'No. Pesanan: 2611110U9K801J',
    'Catatan Pembeli:',
    'WAJIB KIRIMKAN VIDEO PEMBUKAAN PAKET',
    'TANPA VIDEO UNBOXING, KOMPLAIN KURANG BARANG/RUSAK TIDAK AKAN TERIMA',
    columns(['#', 'Nama Produk', 'SKU', 'Varian', 'Jumlah'], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', 'Pulpen Gel Kokoro', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', 'Black / Zebra', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', 'Kokoro Color', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['1', '0,5mm Pulpen Gel', '0600005', 'Black', '3'], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', '', '5', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', 'Warna Hitam', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', 'Kokoro Zebra', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', '0,5mm Bolpen Gel', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    columns(['', 'Pen 0,5 mm', '', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    'Total Qty:3',
    'SPX EXPRESS',
].join('\n');

// Shopee sample 3: rotated label with SKU -> Variasi -> Qty and a wrapped
// variant/description. It has no Shopee word, so SPXID + order + product
// table + shipping furniture must be enough to match.
const LABEL_THREE = [
    'COD Cek Dulu: Tidak',
    'Batas Kirim: 13-11-2026',
    'Berat: 15 gr',
    'No.Pesanan: 2611111PEER7PH',
    'Pesanan: (2611111PEER7PH)',
    columns(['#', 'Nama Produk', 'SKU', 'Variasi', 'Qty'], WIDTHS_SKU_VARIASI_QTY),
    columns(['1', 'Velixir Decant Parfume Tester Original |', '', 'Morpheus.10ML', '1'], WIDTHS_SKU_VARIASI_QTY),
    columns(['', '', '', '(spray)', ''], WIDTHS_SKU_VARIASI_QTY),
    columns(['', 'Parfum Pria / Unisex | Aroma Mewah,', '', '', ''], WIDTHS_SKU_VARIASI_QTY),
    columns(['', 'Tahan Lama, 100% Ori', '', '', ''], WIDTHS_SKU_VARIASI_QTY),
    columns(['2', '[FREE] TESTER *request tulis di catatan', '', 'RANDOM 2 ML', '1'], WIDTHS_SKU_VARIASI_QTY),
    columns(['', '(ALL VARIANT)', '', '', ''], WIDTHS_SKU_VARIASI_QTY),
    'Pesan: (2611111PEER7PH) (SPXID06160886443B)',
    'SPXID06160886443B',
].join('\n');

// Shopee sample 4: headerless product list with Pcs/Botol suffixes, numeric
// product names/sizes and a footer "Total: 2" that is not a product count.
const LABEL_FOUR = [
    'Shopee',
    'ID Express',
    'SUB-SUB15-SDA17',
    'No. Resi: IDS7000108075725',
    'Penerima: Siti Contoh',
    'Jalan Contoh DN 37, wisma contoh, kepuh 62878',
    'Pengirim: Bio Beaute Lab Official',
    'Batas Kirim: 11-11-2026',
    'No. Pesanan: 2611110W8187WE',
    'Cashless',
    '2611110W8187WE',
    'Free Capsibright Moisturizer 2g       5 Pcs',
    'Free Mini Blemish And Pore Clearing Toner 16ml       1 Pcs',
    'Free Sachet Phyto Power Essence       1 Pcs',
    '20ml Luxurious Facial Oil       2 Botol',
    'Total: 2',
    'Mohon sertakan video saat unboxing sejak awal paket',
    '12/36 #438470',
].join('\n');

const EMPTY_LABEL = [
    'Shopee',
    'SPX',
    'No.Resi: SPXID06573671839B',
    'Penerima: Siti Contoh',
    'Pengirim: Flimty Official Shop',
    'Batas Kirim: 11-11-2026',
    'No. Pesanan: 2611110YKEYKNA',
    columns(['No.', 'Nama Produk', 'Varian', 'SKU', 'Qty'], WIDTHS_VARIANT_SKU_QTY),
].join('\n');

const UNCERTAIN_QTY_LABEL = [
    'Shopee',
    'SPX',
    'No.Resi: SPXID06573671839B',
    'Penerima: Siti Contoh',
    'Pengirim: Flimty Official Shop',
    'Batas Kirim: 11-11-2026',
    'No. Pesanan: 2611110YKEYKNA',
    columns(['No.', 'Nama Produk', 'Varian', 'SKU', 'Qty'], WIDTHS_VARIANT_SKU_QTY),
    columns(['1', 'Flimty Fiber 1 Box', 'Blackcurrant', '89972306008', ''], WIDTHS_VARIANT_SKU_QTY),
].join('\n');

const GENERIC_SHOPEE_MENTION = [
    'ACME Supplies Ltd.',
    'INVOICE',
    'Invoice No: ACME-SHOPEE-1',
    'Invoice Date: 2026-02-03',
    'Description Qty Unit Price Amount',
    'Shopee Gift Card 1 25.00 25.00',
    'Subtotal 25.00',
    'Total 25.00',
].join('\n');

const GENERIC_SPX_MENTION = [
    'ACME Supplies Ltd.',
    'INVOICE',
    'Invoice No: ACME-SPX-1',
    'Invoice Date: 2026-02-03',
    'Description Qty Unit Price Amount',
    'SPX Express handling 1 10.00 10.00',
    'Subtotal 10.00',
    'Total 10.00',
].join('\n');

const COURIER_ONLY = [
    'SPX EXPRESS',
    'No.Resi: SPXID06573671839B',
    'No. Pesanan: 2611110YKEYKNA',
].join('\n');

const TOKOPEDIA_TEXT = [
    'tokopedia',
    'Invoice',
    'Penjual : "Toko Contoh" Pembeli : "Pembeli Contoh"',
    'Nomor : INV/2026/001',
    'Tanggal : 01/08/2026',
    'INFO PRODUK JUMLAH HARGA SATUAN TOTAL HARGA',
    'ORDER RECEIPT',
    'Produk Contoh',
    '1 Rp10.000 Rp10.000',
    'SUBTOTAL HARGA PRODUK Rp10.000',
    'TOTAL TAGIHAN Rp10.000',
    'TOKOPEDIA',
].join('\n');

/**
 * @param {Record<string, any>} invoice
 */
function assertNoInvoiceMoney(invoice) {
    assert.equal(invoice.invoiceNumber, null);
    assert.equal(invoice.invoiceDate, null);
    assert.equal(invoice.dueDate, null);
    assert.equal(invoice.subtotal, null);
    assert.equal(invoice.discount, null);
    assert.equal(invoice.taxRate, null);
    assert.equal(invoice.tax, null);
    assert.equal(invoice.shipping, null);
    assert.equal(invoice.total, null);
    assert.equal(invoice.amountDue, null);
}

test('Shopee sample 1 keeps order/tracking strings, wrapped SKU and metadata', () => {
    const invoice = parseInvoice(LABEL_ONE);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'shipping_label');
    assert.equal(invoice.vendor, 'Flimty Official Shop');
    assert.equal(invoice.billTo, 'Siti Contoh');
    assert.equal(invoice.orderId, '2611110YKEYKNA');
    assert.equal(typeof invoice.orderId, 'string');
    assert.equal(invoice.trackingNumber, 'SPXID06573671839B');
    assert.equal(typeof invoice.trackingNumber, 'string');
    assert.equal(invoice.orderDate, null);
    assert.equal(invoice.shippingDeadline, '2026-11-11');
    assert.equal(invoice.currency, 'IDR');
    assert.deepEqual(invoice.weight, { value: 600, unit: 'g' });
    assert.equal(invoice.courier, 'SPX');
    assert.equal(invoice.payment, 'COD');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Flimty Fiber 1 Box (16 sachet)',
            quantity: 1,
            unitPrice: null,
            amount: null,
            variant: 'Blackcurrant',
            sku: '8997230600863',
        },
    ]);
    assertNoInvoiceMoney(invoice);
    assert.deepEqual(invoice.warnings, []);
});

test('actual OCR-shaped sample 1 recovers the header, product row and raw sender', () => {
    const invoice = parseInvoice(ACTUAL_SHAPEE_OCR);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'shipping_label');
    assert.equal(invoice.vendor, 'Flimty Official hop i ae');
    assert.equal(invoice.billTo, 'Siti Contoh');
    assert.equal(invoice.orderId, '2611110YKEYKNA');
    assert.equal(invoice.trackingNumber, 'SPXID065736718398');
    assert.equal(invoice.shippingDeadline, '2026-11-11');
    assert.equal(invoice.payment, 'COD');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Flimty Fiber 1 Box (16 sachet)',
            quantity: 1,
            unitPrice: null,
            amount: null,
            sku: 'Edie 00008',
            variant: 'Blackcurrant',
        },
    ]);
    assertNoInvoiceMoney(invoice);
    assert.deepEqual(invoice.warnings, ['Vendor name may contain OCR noise']);
});

test('damaged Qty/NamaProduk header needs real shipping-label evidence', () => {
    const generic = [
        'ACME Supplies Ltd.',
        'INVOICE',
        'Invoice No: ACME-1',
        'Invoice Date: 2026-02-03',
        'L | No. NamaProduk Varian SKU ay (AGE... Po',
        '1. Test Product Black 0123456 2 - = =',
        'Total 200',
    ].join('\n');
    const genericInvoice = parseInvoice(generic);
    assert.notEqual(genericInvoice.merchant, 'shopee');

    const jne = [
        'No.Resi: JNE0123456789',
        'Penerima: Siti Contoh',
        'L | No. NamaProduk Varian SKU ay (AGE... Po',
        '1. Test Product Black 0123456 2 - = =',
    ].join('\n');
    assert.notEqual(parseInvoice(jne).merchant, 'shopee');

    const invoiceWithMoney = [
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Penerima: Siti Contoh',
        'INVOICE',
        'L | No. NamaProduk Varian SKU ay (AGE... Po',
        '1. Test Product Black 0123456 2 100 200',
        'Total 200',
    ].join('\n');
    assert.notEqual(parseInvoice(invoiceWithMoney).merchant, 'shopee');
});

test('actual OCR noise never becomes a product, quantity or amount', () => {
    const invoice = parseInvoice(ACTUAL_SHAPEE_OCR);
    const [item] = invoice.lineItems;

    assert.equal(invoice.lineItems.length, 1);
    assert.equal(item.description, 'Flimty Fiber 1 Box (16 sachet)');
    assert.equal(item.quantity, 1);
    assert.notEqual(item.quantity, 7);
    assert.notEqual(item.quantity, 16);
    assert.notEqual(item.quantity, 24);
    assert.equal(item.unitPrice, null);
    assert.equal(item.amount, null);
    assert.equal(invoice.total, null);
    assert.equal(invoice.amountDue, null);
});

test('wrapped numeric description continuations are not row indexes', () => {
    const header = columns(['No.', 'Nama Produk', 'Varian', 'SKU', 'Qty'], WIDTHS_VARIANT_SKU_QTY);
    const invoice = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        header,
        columns(['1', 'Flimty Fiber1Box', 'Blackcurrant', '89972306008', '1'], WIDTHS_VARIANT_SKU_QTY),
        columns(['', '16 sachet per box', '', '', ''], WIDTHS_VARIANT_SKU_QTY),
        columns(['', '100 ml Bottle', '', '', ''], WIDTHS_VARIANT_SKU_QTY),
    ].join('\n'));

    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Flimty Fiber1Box 16 sachet per box 100 ml Bottle',
            quantity: 1,
            unitPrice: null,
            amount: null,
            variant: 'Blackcurrant',
            sku: '89972306008',
        },
    ]);
    assert.deepEqual(invoice.warnings, []);
});

test('an aligned product row without a recognized index still starts a new item', () => {
    const widths = [5, 40, 14, 6];
    const header = columns(['No.', 'Nama Produk', 'SKU', 'Qty'], widths);
    const invoice = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        header,
        columns(['1', 'ProductAlpha', 'ABC123', '2'], widths),
        columns(['', 'ProductBeta', 'DEF456', '3'], widths),
    ].join('\n'));

    assert.deepEqual(invoice.lineItems, [
        {
            description: 'ProductAlpha',
            quantity: 2,
            unitPrice: null,
            amount: null,
            sku: 'ABC123',
        },
        {
            description: 'ProductBeta',
            quantity: 3,
            unitPrice: null,
            amount: null,
            sku: 'DEF456',
        },
    ]);
    assert.deepEqual(invoice.warnings, []);

    // The index-less row allowance must not revive the actual 7/24 noise line.
    const actual = parseInvoice(ACTUAL_SHAPEE_OCR);
    assert.equal(actual.lineItems.length, 1);
    assert.equal(actual.lineItems[0].quantity, 1);
});

test('Shopee sample 2 handles SKU/Varian order, wrapped pen name and wrapped SKU', () => {
    const invoice = parseInvoice(LABEL_TWO);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'shipping_label');
    assert.equal(invoice.vendor, 'toko snarmega');
    assert.equal(invoice.billTo, 'Jullia Contoh');
    assert.equal(invoice.orderId, '2611110U9K801J');
    assert.equal(invoice.trackingNumber, 'SPXID066002195848');
    assert.equal(invoice.orderDate, '2026-11-11');
    assert.equal(invoice.shippingDeadline, '2026-11-11');
    assert.equal(invoice.currency, null);
    assert.deepEqual(invoice.weight, { value: 75, unit: 'g' });
    assert.equal(invoice.courier, 'SPX');
    assert.equal(invoice.payment, null);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Pulpen Gel Kokoro Black / Zebra Kokoro Color 0,5mm Pulpen Gel '
                + 'Warna Hitam Kokoro Zebra 0,5mm Bolpen Gel Pen 0,5 mm',
            quantity: 3,
            unitPrice: null,
            amount: null,
            variant: 'Black',
            sku: '06000055',
        },
    ]);
    assertNoInvoiceMoney(invoice);
    assert.deepEqual(invoice.warnings, []);
});

test('Shopee sample 3 handles a rotated table, wrapped variant and variant-only rows', () => {
    const invoice = parseInvoice(LABEL_THREE);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'shipping_label');
    assert.equal(invoice.vendor, null);
    assert.equal(invoice.billTo, null);
    assert.equal(invoice.orderId, '2611111PEER7PH');
    assert.equal(invoice.trackingNumber, 'SPXID06160886443B');
    assert.equal(invoice.orderDate, null);
    assert.equal(invoice.shippingDeadline, '2026-11-13');
    assert.equal(invoice.currency, null);
    assert.deepEqual(invoice.weight, { value: 15, unit: 'g' });
    assert.equal(invoice.courier, null);
    assert.equal(invoice.payment, null);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Velixir Decant Parfume Tester Original | Parfum Pria / Unisex | '
                + 'Aroma Mewah, Tahan Lama, 100% Ori',
            quantity: 1,
            unitPrice: null,
            amount: null,
            variant: 'Morpheus.10ML (spray)',
        },
        {
            description: '[FREE] TESTER *request tulis di catatan (ALL VARIANT)',
            quantity: 1,
            unitPrice: null,
            amount: null,
            variant: 'RANDOM 2 ML',
        },
    ]);
    assertNoInvoiceMoney(invoice);
    assert.deepEqual(invoice.warnings, []);
});

test('Shopee sample 4 parses headerless Pcs/Botol rows and ignores Total: 2', () => {
    const invoice = parseInvoice(LABEL_FOUR);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'shipping_label');
    assert.equal(invoice.vendor, 'Bio Beaute Lab Official');
    assert.equal(invoice.billTo, 'Siti Contoh');
    assert.equal(invoice.orderId, '2611110W8187WE');
    assert.equal(invoice.trackingNumber, 'IDS7000108075725');
    assert.equal(invoice.orderDate, null);
    assert.equal(invoice.shippingDeadline, '2026-11-11');
    assert.equal(invoice.currency, null);
    assert.equal(invoice.weight, null);
    assert.equal(invoice.courier, 'ID Express');
    assert.equal(invoice.payment, 'Cashless');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Free Capsibright Moisturizer 2g',
            quantity: 5,
            unitPrice: null,
            amount: null,
            unit: 'Pcs',
        },
        {
            description: 'Free Mini Blemish And Pore Clearing Toner 16ml',
            quantity: 1,
            unitPrice: null,
            amount: null,
            unit: 'Pcs',
        },
        {
            description: 'Free Sachet Phyto Power Essence',
            quantity: 1,
            unitPrice: null,
            amount: null,
            unit: 'Pcs',
        },
        {
            description: '20ml Luxurious Facial Oil',
            quantity: 2,
            unitPrice: null,
            amount: null,
            unit: 'Botol',
        },
    ]);
    assertNoInvoiceMoney(invoice);
    assert.deepEqual(invoice.warnings, []);
});

test('IDs stay strings and keep leading zeros across label spelling variants', () => {
    const withIdLabel = LABEL_ONE.replace(
        'No.Pesanan: 2611110YKEYKNA',
        'ID Pesanan: 001234567890ABC',
    );
    const invoice = parseInvoice(withIdLabel);
    assert.equal(invoice.orderId, '001234567890ABC');
    assert.equal(typeof invoice.orderId, 'string');

    const withIdsTracking = LABEL_FOUR.replace('IDS7000108075725', 'IDS000123456789');
    const trackingInvoice = parseInvoice(withIdsTracking);
    assert.equal(trackingInvoice.trackingNumber, 'IDS000123456789');
    assert.equal(typeof trackingInvoice.trackingNumber, 'string');
});

test('label dates use Waktu Pemesanan/Batas Kirim only, never the print timestamp', () => {
    const invoice = parseInvoice(LABEL_TWO);
    assert.equal(invoice.orderDate, '2026-11-11');
    assert.equal(invoice.shippingDeadline, '2026-11-11');
    assert.equal(invoice.invoiceDate, null);
    assert.equal(invoice.dueDate, null);

    const withoutOrderDate = LABEL_TWO.replace('Waktu Pemesanan: 2026-11-11 00:01:53\n', '');
    const noOrderDate = parseInvoice(withoutOrderDate);
    assert.equal(noOrderDate.orderDate, null);
    assert.equal(noOrderDate.invoiceDate, null);
    assert.equal(noOrderDate.shippingDeadline, '2026-11-11');

    const differentPrintDate = LABEL_ONE.replace('11-11-2026 07:51:04', '13-11-2026 07:51:04');
    const printOnly = parseInvoice(differentPrintDate);
    assert.equal(printOnly.orderDate, null);
    assert.equal(printOnly.invoiceDate, null);
    assert.equal(printOnly.shippingDeadline, '2026-11-11');
});

test('dateOrder is applied to ambiguous label dates', () => {
    const ambiguous = LABEL_ONE.replace('Batas Kirim: 11-11-26', 'Batas Kirim: 11/03/2026');
    assert.equal(parseInvoice(ambiguous).shippingDeadline, '2026-03-11');
    assert.equal(parseInvoice(ambiguous, { dateOrder: 'mdy' }).shippingDeadline, '2026-11-03');
});

test('currency is only explicit printed currency or the caller override', () => {
    assert.equal(parseInvoice(LABEL_TWO).currency, null);
    assert.equal(parseInvoice(LABEL_THREE).currency, null);
    assert.equal(parseInvoice(LABEL_FOUR).currency, null);
    assert.equal(parseInvoice(LABEL_TWO, { currency: 'sgd' }).currency, 'SGD');
    assert.equal(parseInvoice(LABEL_ONE).currency, 'IDR');
});

const FLAT_LABEL_CONTEXT = [
    'Shopee',
    'SPX EXPRESS',
    'No.Resi: SPXID06573671839B',
    'Penerima: Siti Contoh',
    'Pengirim: Flimty Official Shop',
    'No. Pesanan: 2611110YKEYKNA',
];

test('flattened OCR tables keep rows using header order and a trailing quantity', () => {
    const synthetic = [
        ...FLAT_LABEL_CONTEXT,
        'No. Nama Produk SKU Varian Qty',
        '1 Facial Oil 0123456 Rose 2',
    ].join('\n');
    const item = parseInvoice(synthetic).lineItems[0];
    assert.equal(item.description, 'Facial Oil');
    assert.equal(item.quantity, 2);
    assert.equal(item.sku, '0123456');
    assert.equal(item.variant, 'Rose');

    const collapsedOne = parseInvoice(LABEL_ONE.replace(/ {2,}/g, ' '));
    assert.equal(collapsedOne.merchant, 'shopee');
    assert.equal(collapsedOne.lineItems[0].quantity, 1);
    assert.match(collapsedOne.lineItems[0].description, /1 Box \(16 sachet\)/);
    assert.match(collapsedOne.lineItems[0].sku, /^8997230600863$/);
    assert.ok(!collapsedOne.warnings.some((warning) => /quantity uncertain/i.test(warning)));
    assert.ok(!collapsedOne.warnings.some((warning) => /SKU\/variant metadata/i.test(warning)));

    const collapsedTwo = parseInvoice(LABEL_TWO.replace(/ {2,}/g, ' '));
    assert.equal(collapsedTwo.merchant, 'shopee');
    assert.equal(collapsedTwo.lineItems[0].quantity, 3);
    assert.match(collapsedTwo.lineItems[0].description, /0,5mm Pulpen Gel/);
    assert.ok(!collapsedTwo.warnings.some((warning) => /SKU\/variant metadata/i.test(warning)));

    const collapsedThree = parseInvoice(LABEL_THREE.replace(/ {2,}/g, ' '));
    assert.equal(collapsedThree.merchant, 'shopee');
    assert.equal(collapsedThree.lineItems.length, 2);
    assert.deepEqual(collapsedThree.lineItems.map((row) => row.quantity), [1, 1]);
});

test('flattened sample 3 keeps variant text in descriptions and warns about ambiguous metadata', () => {
    const invoice = parseInvoice(LABEL_THREE.replace(/ {2,}/g, ' '));

    assert.equal(invoice.merchant, 'shopee');
    assert.deepEqual(invoice.lineItems.map((item) => item.quantity), [1, 1]);

    const [first, second] = invoice.lineItems;
    assert.match(first.description, /Velixir Decant Parfume Tester Original \|/);
    assert.match(first.description, /Morpheus\.10ML/);
    assert.match(first.description, /\(spray\)/);
    assert.match(first.description, /Parfum Pria \/ Unisex \| Aroma Mewah,/);
    assert.match(first.description, /Tahan Lama, 100% Ori/);
    assert.equal(first.sku, undefined);
    assert.equal(first.variant, undefined);

    assert.match(second.description, /\[FREE\] TESTER \*request tulis di catatan/);
    assert.match(second.description, /RANDOM 2 ML/);
    assert.match(second.description, /\(ALL VARIANT\)/);
    assert.equal(second.sku, undefined);
    assert.equal(second.variant, undefined);

    const metadataWarnings = invoice.warnings.filter((warning) => (
        /SKU\/variant metadata could not be separated reliably/.test(warning)
    ));
    assert.equal(metadataWarnings.length, 2);
    assert.deepEqual(invoice.warnings, metadataWarnings);
});

test('quantity fallback never reuses numeric SKU or variant tokens', () => {
    const base = [
        ...FLAT_LABEL_CONTEXT,
        columns(['#', 'Nama Produk', 'SKU', 'Varian', 'Jumlah'], WIDTHS_SKU_VARIANT_JUMLAH),
    ];
    const numericSku = parseInvoice([
        ...base,
        columns(['1', 'Product', '0123', '', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    ].join('\n'));
    assert.equal(numericSku.lineItems[0].quantity, null);
    assert.equal(numericSku.lineItems[0].sku, '0123');
    assert.ok(numericSku.warnings.some((warning) => /quantity uncertain/i.test(warning)));

    const numericVariant = parseInvoice([
        ...base,
        columns(['1', 'Product', '0042', '42', ''], WIDTHS_SKU_VARIANT_JUMLAH),
    ].join('\n'));
    assert.equal(numericVariant.lineItems[0].quantity, null);
    assert.equal(numericVariant.lineItems[0].variant, '42');
    assert.ok(numericVariant.warnings.some((warning) => /quantity uncertain/i.test(warning)));

    const flattened = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'No. Nama Produk SKU Varian Qty',
        '1 Product 0042 42',
    ].join('\n'));
    assert.equal(flattened.lineItems[0].quantity, null);
    assert.equal(flattened.lineItems[0].sku, '0042');
    assert.ok(flattened.warnings.some((warning) => /quantity uncertain/i.test(warning)));
});

test('headerless item units come from the quantity suffix, not descriptions', () => {
    const invoice = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Gift Box Facial Oil       2 Botol',
        'Box Organizer       2 Pcs',
        '2 Pcs Gift Pouch',
    ].join('\n'));
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Gift Box Facial Oil',
            quantity: 2,
            unitPrice: null,
            amount: null,
            unit: 'Botol',
        },
        {
            description: 'Box Organizer',
            quantity: 2,
            unitPrice: null,
            amount: null,
            unit: 'Pcs',
        },
        {
            description: 'Gift Pouch',
            quantity: 2,
            unitPrice: null,
            amount: null,
            unit: 'Pcs',
        },
    ]);
});

test('adjacent date fields do not leak the deadline into the order date', () => {
    const sameLine = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Waktu Pemesanan: Batas Kirim: 13-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(sameLine.orderDate, null);
    assert.equal(sameLine.shippingDeadline, '2026-11-13');

    const noSpaceSameLine = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Waktu Pemesanan:Batas Kirim:13-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(noSpaceSameLine.orderDate, null);
    assert.equal(noSpaceSameLine.shippingDeadline, '2026-11-13');

    const noSpaceMarkerThenNextLine = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Waktu Pemesanan:Batas Kirim:',
        '13-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(noSpaceMarkerThenNextLine.orderDate, null);
    assert.equal(noSpaceMarkerThenNextLine.shippingDeadline, '2026-11-13');

    const markerThenNextLine = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Waktu Pemesanan: Batas Kirim:',
        '13-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(markerThenNextLine.orderDate, null);
    assert.equal(markerThenNextLine.shippingDeadline, '2026-11-13');

    const normalSameLine = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Waktu Pemesanan: 12-11-2026',
        'Batas Kirim: 13-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(normalSameLine.orderDate, '2026-11-12');
    assert.equal(normalSameLine.shippingDeadline, '2026-11-13');

    const separateLines = parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'Waktu Pemesanan:',
        '13-11-2026',
        'Batas Kirim: 14-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(separateLines.orderDate, '2026-11-13');
    assert.equal(separateLines.shippingDeadline, '2026-11-14');
});

test('sender and recipient values stop at exact field boundaries', () => {
    const pickUp = parseInvoice([
        ...FLAT_LABEL_CONTEXT.filter((line) => !line.startsWith('Pengirim:')),
        'Metode Pengiriman: PICK_UP',
        'Nama Toko: Toko Contoh',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(pickUp.vendor, 'Toko Contoh');
    assert.ok(!/PICK_UP|an:/.test(pickUp.vendor));

    const sameLine = parseInvoice([
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Pengirim:TokoContoh Penerima SitiContoh',
        'No. Pesanan: 2611110YKEYKNA',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(sameLine.vendor, 'TokoContoh');
    assert.equal(sameLine.billTo, 'SitiContoh');

    const recipientIsMarker = parseInvoice([
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Pengirim: TokoContoh',
        'Penerima: Pengirim: OtherStore',
        'No. Pesanan: 2611110YKEYKNA',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(recipientIsMarker.vendor, 'TokoContoh');
    assert.equal(recipientIsMarker.billTo, null);

    const recipientIsMarkerNoSpace = parseInvoice([
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Pengirim: TokoContoh',
        'Penerima:Pengirim:OtherStore',
        'No. Pesanan: 2611110YKEYKNA',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(recipientIsMarkerNoSpace.vendor, 'TokoContoh');
    assert.equal(recipientIsMarkerNoSpace.billTo, null);

    const nextLineIsMarker = parseInvoice([
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Pengirim: TokoContoh',
        'Penerima:',
        'Pengirim OtherStore',
        'No. Pesanan: 2611110YKEYKNA',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(nextLineIsMarker.billTo, null);
});

test('standalone SKU continuations never become the order ID', () => {
    const invoice = parseInvoice([
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Penerima: Siti Contoh',
        'Nama Produk SKU Varian Qty',
        '1 Product 0123456',
        'PART0001',
    ].join('\n'));
    assert.equal(invoice.orderId, null);
    assert.ok(invoice.warnings.some((warning) => /Order ID not found/.test(warning)));
    assert.notEqual(invoice.orderId, invoice.lineItems[0].sku);

    const missingValue = parseInvoice([
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Penerima: Siti Contoh',
        'No. Pesanan: Batas Kirim: 13-11-2026',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n'));
    assert.equal(missingValue.orderId, null);
    assert.ok(missingValue.warnings.some((warning) => /Order ID not found/.test(warning)));
});

test('footer counts and COD amounts never become totals or quantities', () => {
    const altered = LABEL_TWO.replace('Total Qty:3', 'Total Qty:9');
    const invoice = parseInvoice(altered);
    assert.equal(invoice.lineItems[0].quantity, 3);
    assert.equal(invoice.total, null);

    const sampleFour = parseInvoice(LABEL_FOUR);
    assert.equal(sampleFour.lineItems.length, 4);
    assert.equal(sampleFour.total, null);
    assert.equal(sampleFour.payment, 'Cashless');
});

test('missing order ID, empty product table and uncertain quantity produce label warnings', () => {
    const noOrder = parseInvoice(
        LABEL_ONE
            .replace('No.Pesanan: 2611110YKEYKNA\n', '')
            .replace('No. Pesanan: 2611110YKEYKNA\n', ''),
    );
    assert.equal(noOrder.orderId, null);
    assert.ok(noOrder.warnings.some((warning) => /Order ID not found/.test(warning)));
    assert.ok(!noOrder.warnings.some((warning) => /Total not found|Invoice date not found/.test(warning)));

    const noProducts = parseInvoice(EMPTY_LABEL);
    assert.deepEqual(noProducts.lineItems, []);
    assert.ok(noProducts.warnings.some((warning) => /No product lines/.test(warning)));

    const uncertain = parseInvoice(UNCERTAIN_QTY_LABEL);
    assert.equal(uncertain.lineItems.length, 1);
    assert.equal(uncertain.lineItems[0].quantity, null);
    assert.ok(uncertain.warnings.some((warning) => /quantity uncertain/i.test(warning)));
});

test('generic invoices mentioning Shopee or SPX do not dispatch to the label parser', () => {
    const shopeeGeneric = parseInvoice(GENERIC_SHOPEE_MENTION);
    assert.equal(shopeeGeneric.merchant, undefined);
    assert.equal(shopeeGeneric.vendor, 'ACME Supplies Ltd.');
    assert.equal(shopeeGeneric.total, 25);

    const spxGeneric = parseInvoice(GENERIC_SPX_MENTION);
    assert.equal(spxGeneric.merchant, undefined);
    assert.equal(spxGeneric.vendor, 'ACME Supplies Ltd.');
    assert.equal(spxGeneric.total, 10);

    const brandingOnly = parseInvoice('Shopee\nRp 10.000');
    assert.equal(brandingOnly.merchant, undefined);
});

test('a courier-only SPX waybill without order/product structure stays generic', () => {
    const invoice = parseInvoice(COURIER_ONLY);
    assert.equal(invoice.merchant, undefined);
});

test('invoice-shaped documents with SPX tracking stay generic and keep their money', () => {
    const ordinaryInvoice = [
        'ACME Supplies Ltd.',
        'INVOICE',
        'Invoice No: ACME-SPX-200',
        'Invoice Date: 2026-02-03',
        'No. Resi: SPXID06573671839B',
        'Nama Produk Qty Harga Total',
        'Test Product 2 100 200',
        'Total 200',
    ].join('\n');
    const ordinary = parseInvoice(ordinaryInvoice);
    assert.equal(ordinary.merchant, undefined);
    assert.equal(ordinary.invoiceNumber, 'ACME-SPX-200');
    assert.equal(ordinary.total, 200);
    assert.deepEqual(ordinary.lineItems[0], {
        description: 'Test Product',
        quantity: 2,
        unitPrice: 100,
        amount: 200,
    });

    const brandedInvoice = [
        'Shopee',
        'INVOICE',
        'Invoice No: SHOPEE-INV-1',
        'Invoice Date: 2026-02-03',
        'Nama Produk Qty Harga Total',
        'Gift Card 2 50000 100000',
        'Total 100000',
    ].join('\n');
    const branded = parseInvoice(brandedInvoice);
    assert.equal(branded.merchant, undefined);
    assert.equal(branded.total, 100000);

    const jneLabel = [
        'No.Resi:JNE0123456789',
        'Penerima:TestBuyer',
        'Nama Produk Qty',
        'Test Product 2',
    ].join('\n');
    assert.equal(parseInvoice(jneLabel).merchant, undefined);

    // Sample 3 has no Shopee word, but its SPXID and label furniture are
    // still positive evidence.
    assert.equal(parseInvoice(LABEL_THREE).merchant, 'shopee');
});

test('browser UMD loading registers Shopee and Tokopedia and works with either module missing', () => {
    const tokensFile = path.join(__dirname, '..', 'public', 'merchants', 'tokopedia.js');
    const shopeeFile = path.join(__dirname, '..', 'public', 'merchants', 'shopee.js');
    const parserFile = path.join(__dirname, '..', 'public', 'invoice-parser.js');

    const complete = { self: {} };
    vm.runInNewContext(fs.readFileSync(tokensFile, 'utf8'), complete, { filename: tokensFile });
    vm.runInNewContext(fs.readFileSync(shopeeFile, 'utf8'), complete, { filename: shopeeFile });
    vm.runInNewContext(fs.readFileSync(parserFile, 'utf8'), complete, { filename: parserFile });

    assert.ok(complete.self.InvoiceParserTokopedia);
    assert.ok(complete.self.InvoiceParserShopee);
    const parser = complete.self.InvoiceParser;
    assert.ok(parser);
    assert.equal(parser.parseInvoice(TOKOPEDIA_TEXT).merchant, 'tokopedia');
    const shopee = parser.parseInvoice(LABEL_ONE);
    assert.equal(shopee.merchant, 'shopee');
    assert.equal(shopee.orderId, '2611110YKEYKNA');
    assert.equal(shopee.lineItems[0].quantity, 1);

    const actualShopee = parser.parseInvoice(ACTUAL_SHAPEE_OCR);
    assert.equal(actualShopee.merchant, 'shopee');
    assert.equal(actualShopee.lineItems.length, 1);
    assert.equal(actualShopee.lineItems[0].description, 'Flimty Fiber 1 Box (16 sachet)');
    assert.equal(actualShopee.lineItems[0].quantity, 1);

    const flattened = parser.parseInvoice([
        ...FLAT_LABEL_CONTEXT,
        'No. Nama Produk SKU Varian Qty',
        '1 Facial Oil 0123456 Rose 2',
    ].join('\n'));
    assert.equal(flattened.merchant, 'shopee');
    assert.equal(flattened.lineItems[0].quantity, 2);

    const jne = parser.parseInvoice('No.Resi:JNE0123456789\nPenerima:TestBuyer\nNama Produk Qty\nTest Product 2');
    assert.notEqual(jne.merchant, 'shopee');

    const withoutShopee = { self: {} };
    vm.runInNewContext(fs.readFileSync(tokensFile, 'utf8'), withoutShopee, { filename: tokensFile });
    vm.runInNewContext(fs.readFileSync(parserFile, 'utf8'), withoutShopee, { filename: parserFile });
    assert.ok(withoutShopee.self.InvoiceParser);
    assert.equal(withoutShopee.self.InvoiceParser.parseInvoice(TOKOPEDIA_TEXT).merchant, 'tokopedia');
    assert.notEqual(withoutShopee.self.InvoiceParser.parseInvoice(LABEL_ONE).merchant, 'shopee');
});

test('index.html loads both merchant adapters before the core parser', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const tokopediaScript = html.indexOf('merchants/tokopedia.js');
    const shopeeScript = html.indexOf('merchants/shopee.js');
    const layoutScript = html.indexOf('ocr-layout.js');
    const parserScript = html.indexOf('src="invoice-parser.js"');
    const inlineScript = html.indexOf('<script>');
    assert.ok(tokopediaScript !== -1);
    assert.ok(shopeeScript !== -1);
    assert.ok(layoutScript !== -1);
    assert.ok(parserScript !== -1);
    assert.ok(tokopediaScript < parserScript);
    assert.ok(shopeeScript < parserScript);
    assert.ok(layoutScript < inlineScript);
});
