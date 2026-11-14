'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { parseInvoice } = require('../public/invoice-parser.js');

// Sanitized form of the browser textContentToLines() shape for the observed
// Shopee "Nota Pesanan" PDFs. Buyer names, address and phone are fixtures.
// The column gaps are two spaces, as produced by the PDF text reclaim.
const RECEIPT_FIVE = [
    'Nota Pesanan',
    'Nama Pembeli:  Siti Contoh  Nama Penjual:  MSL Gadget',
    'Alamat Pembeli:',
    'Perumahan Contoh, Jalan Contoh Blok DN No. 37, KAB. SIDOARJO, WARU, JAWA',
    'TIMUR, ID, 61256',
    'No. Handphone Pembeli:  628000000000',
    'No. Pesanan  Tanggal Transaksi  Metode Pembayaran  Jasa Kirim',
    '261107NAU80G6E  07/11/2026  Saldo ShopeePay  Instant',
    'Rincian Pesanan',
    'No.  Produk  Variasi  Harga Produk  Kuantitas  Subtotal',
    'UGREEN Kabel HDMI to HDMI 2.1 Ultra HD 8  2 METER',
    '1  Rp89.000  1  Rp89.000',
    'K 60Hz eARC High Speed 48Gbps  45432',
    'Subtotal  Rp89.000',
    'Total Kuantitas (Aktif)  1 produk',
    'Subtotal Pesanan  Rp89.000',
    'Biaya Layanan  Rp1.900',
    'Diskon Voucher Shopee  -Rp4.450',
    '150 Koin Shopee Ditukarkan  -Rp150',
    'Promosi Metode Pembayaran  -Rp500',
    'Total Pembayaran  Rp85.800',
    'Biaya-biaya yang ditagihkan oleh Shopee (jika',
    'ada) sudah termasuk PPN',
    'PT Shopee International Indonesia',
    'Trinity Tower 21st Floor',
    'Jalan H.R. Rasuna Said Kaveling C22,',
    'Blok IIB RT.000 RW.000, Karet Kuningan,',
    'Setiabudi, Kota Adm. Jakarta Selatan,',
    'DKI Jakarta.',
    'NPWP: 0736666900031000',
    '1 of 1',
    'End of receipt',
].join('\n');

const RECEIPT_SIX_PAGE_ONE = [
    'Nota Pesanan',
    'Nama Pembeli:  Siti Contoh  Nama Penjual:  HSG-STORE',
    'Alamat Pembeli:',
    'Perumahan Contoh, Jalan Contoh Blok DN No. 37, KAB. SIDOARJO, WARU, JAWA',
    'TIMUR, ID, 61256',
    'No. Handphone Pembeli:  628000000000',
    'No. Pesanan  Tanggal Transaksi  Metode Pembayaran  Jasa Kirim',
    '261026M53EE241  26/10/2026  Saldo ShopeePay  Same Day',
    'Rincian Pesanan',
    'No.  Produk  Variasi  Harga Produk  Kuantitas  Subtotal',
    'Sayuran Brokoli Hijau Beku / Frozen Kemasan',
    '1  Rp38.000  1  Rp38.000',
    '1kg',
    'Fresh Baby Potatoes / Kentang Baby / Kentan',
    '2  1 kg  Rp15.000  1  Rp15.000',
    'g Rendang Segar',
    'Timun / Ketimun / Mentimun Segar / Fresh Uk',
    '3  500 gr  Rp9.000  1  Rp9.000',
    'uran Kecil / Lalap / Acar',
    'Subtotal  Rp62.000',
    'Total Kuantitas (Aktif)  3 produk',
    'Subtotal Pesanan  Rp62.000',
    'Subtotal Pengiriman  Rp6.500',
    'Biaya Layanan  Rp1.013',
    'Diskon Voucher Shopee  -Rp3.100',
    '19 Koin Shopee Ditukarkan  -Rp19',
    'Promosi Metode Pembayaran  -Rp326',
    'Total Pembayaran  Rp66.068',
    '1 of 2',
    'Continue to next page',
].join('\n');

const RECEIPT_SIX_PAGE_TWO = [
    'Nota Pesanan',
    'Biaya-biaya yang ditagihkan oleh Shopee (jika',
    'ada) sudah termasuk PPN',
    'PT Shopee International Indonesia',
    'Trinity Tower 21st Floor',
    'Jalan H.R. Rasuna Said Kaveling C22,',
    'Blok IIB RT.000 RW.000, Karet Kuningan,',
    'Setiabudi, Kota Adm. Jakarta Selatan,',
    'DKI Jakarta.',
    'NPWP: 0736666900031000',
    '2 of 2',
    'End of receipt',
].join('\n');

const RECEIPT_SIX = `${RECEIPT_SIX_PAGE_ONE}\f${RECEIPT_SIX_PAGE_TWO}`;

const RECEIPT_SEVEN = [
    'Nota Pesanan',
    'Nama Pembeli:  Siti Contoh  Nama Penjual:  Tokyo 1',
    'Alamat Pembeli:',
    'Perumahan Contoh, Jalan Contoh Blok DN No. 37, KAB. SIDOARJO, WARU, JAWA',
    'TIMUR, ID, 61256',
    'No. Handphone Pembeli:  628000000000',
    'No. Pesanan  Tanggal Transaksi  Metode Pembayaran  Jasa Kirim',
    '261029UB555PC0  29/10/2026  Saldo ShopeePay  Reguler',
    'Rincian Pesanan',
    'No.  Produk  Variasi  Harga Produk  Kuantitas  Subtotal',
    'Tokyo 1 Tatakan Silikon Tahan Panas-Silicone',
    '1  Rp28.900  1  Rp28.900',
    'Pot Stand 14cm (182234)',
    'Subtotal  Rp28.900',
    'Total Kuantitas (Aktif)  1 produk',
    'Subtotal Pesanan  Rp28.900',
    'Biaya Layanan  Rp910',
    'Diskon Voucher Shopee  -Rp4.784',
    '16 Koin Shopee Ditukarkan  -Rp16',
    'Promosi Metode Pembayaran  -Rp239',
    'Total Pembayaran  Rp24.771',
    'Biaya-biaya yang ditagihkan oleh Shopee (jika',
    'ada) sudah termasuk PPN',
    'PT Shopee International Indonesia',
    'Trinity Tower 21st Floor',
    'Jalan H.R. Rasuna Said Kaveling C22,',
    'Blok IIB RT.000 RW.000, Karet Kuningan,',
    'Setiabudi, Kota Adm. Jakarta Selatan,',
    'DKI Jakarta.',
    'NPWP: 0736666900031000',
    '1 of 1',
    'End of receipt',
].join('\n');

const GENERIC_SHOPEE_INVOICE = [
    'ACME Supplies Ltd.',
    'INVOICE',
    'Invoice No: ACME-SHOPEE-RECEIPT-1',
    'Invoice Date: 2026-02-03',
    'Description Qty Unit Price Amount',
    'Shopee Gift Card 1 25.00 25.00',
    'Subtotal 25.00',
    'Total 25.00',
].join('\n');

test('Shopee receipt sample 5 maps buyer contact, full wrapped item and totals', () => {
    const invoice = parseInvoice(RECEIPT_FIVE);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'invoice_receipt');
    assert.equal(invoice.vendor, 'MSL Gadget');
    assert.equal(invoice.billTo, 'Siti Contoh');
    assert.equal(invoice.buyerAddress,
        'Perumahan Contoh, Jalan Contoh Blok DN No. 37, KAB. SIDOARJO, WARU, JAWA TIMUR, ID, 61256');
    assert.equal(invoice.buyerPhone, '628000000000');
    assert.equal(typeof invoice.buyerPhone, 'string');
    assert.equal(invoice.invoiceNumber, '261107NAU80G6E');
    assert.equal(typeof invoice.invoiceNumber, 'string');
    assert.equal(invoice.invoiceDate, '2026-11-07');
    assert.equal(invoice.dueDate, null);
    assert.equal(invoice.orderId, null);
    assert.equal(invoice.orderDate, null);
    assert.equal(invoice.currency, 'IDR');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'UGREEN Kabel HDMI to HDMI 2.1 Ultra HD 8K 60Hz eARC High Speed 48Gbps',
            quantity: 1,
            unitPrice: 89000,
            amount: 89000,
            variant: '2 METER 45432',
        },
    ]);
    assert.equal(invoice.subtotal, 89000);
    assert.equal(invoice.serviceFee, 1900);
    assert.equal(invoice.discount, 5100);
    assert.equal(invoice.taxRate, null);
    assert.equal(invoice.tax, null);
    assert.equal(invoice.shipping, null);
    assert.equal(invoice.total, 85800);
    assert.equal(invoice.amountDue, null);
    assert.deepEqual(invoice.warnings, []);
});

test('Shopee receipt sample 6 handles wrapped products, page footer and the truthful missing-shipping warning', () => {
    const invoice = parseInvoice(RECEIPT_SIX);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'invoice_receipt');
    assert.equal(invoice.vendor, 'HSG-STORE');
    assert.equal(invoice.invoiceNumber, '261026M53EE241');
    assert.equal(invoice.invoiceDate, '2026-10-26');
    assert.equal(invoice.lineItems.length, 3);
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Sayuran Brokoli Hijau Beku / Frozen Kemasan 1kg',
            quantity: 1,
            unitPrice: 38000,
            amount: 38000,
        },
        {
            // "1 kg" is printed in the Variasi column, not the Produk column.
            description: 'Fresh Baby Potatoes / Kentang Baby / Kentang Rendang Segar',
            quantity: 1,
            unitPrice: 15000,
            amount: 15000,
            variant: '1 kg',
        },
        {
            // "500 gr" is likewise a Variasi value, not part of the name.
            description: 'Timun / Ketimun / Mentimun Segar / Fresh Ukuran Kecil / Lalap / Acar',
            quantity: 1,
            unitPrice: 9000,
            amount: 9000,
            variant: '500 gr',
        },
    ]);
    assert.equal(invoice.subtotal, 62000);
    assert.equal(invoice.serviceFee, 1013);
    assert.equal(invoice.discount, 3445);
    assert.equal(invoice.shipping, null);
    assert.equal(invoice.tax, null);
    assert.equal(invoice.taxRate, null);
    assert.equal(invoice.total, 66068);
    assert.deepEqual(invoice.warnings, [
        'Subtotal, discount, tax and shipping give 59568, but total is 66068',
    ]);
    assert.ok(invoice.warnings.every((warning) => !/[Nn]PWP|6\.500|6500/.test(warning)));
});

test('Shopee receipt sample 7 keeps the full description without inventing a variant or SKU', () => {
    const invoice = parseInvoice(RECEIPT_SEVEN);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'invoice_receipt');
    assert.equal(invoice.vendor, 'Tokyo 1');
    assert.equal(invoice.invoiceNumber, '261029UB555PC0');
    assert.equal(invoice.invoiceDate, '2026-10-29');
    assert.deepEqual(invoice.lineItems, [
        {
            description: 'Tokyo 1 Tatakan Silikon Tahan Panas-Silicone Pot Stand 14cm (182234)',
            quantity: 1,
            unitPrice: 28900,
            amount: 28900,
        },
    ]);
    assert.equal(invoice.lineItems[0].variant, undefined);
    assert.equal(invoice.lineItems[0].sku, undefined);
    assert.equal(invoice.subtotal, 28900);
    assert.equal(invoice.serviceFee, 910);
    assert.equal(invoice.discount, 5039);
    assert.equal(invoice.total, 24771);
    assert.deepEqual(invoice.warnings, []);
});

test('inline numeric-row descriptions are parsed with and without a Variasi column', () => {
    const wrappedFive = [
        'UGREEN Kabel HDMI to HDMI 2.1 Ultra HD 8  2 METER',
        '1  Rp89.000  1  Rp89.000',
        'K 60Hz eARC High Speed 48Gbps  45432',
    ].join('\n');
    const inlineFive = RECEIPT_FIVE.replace(
        wrappedFive,
        '1  UGREEN Kabel HDMI  Rp89.000  1  Rp89.000',
    );
    const withoutVariant = parseInvoice(inlineFive);
    assert.equal(withoutVariant.lineItems.length, 1);
    assert.deepEqual(withoutVariant.lineItems, [
        {
            description: 'UGREEN Kabel HDMI',
            quantity: 1,
            unitPrice: 89000,
            amount: 89000,
        },
    ]);
    assert.equal(withoutVariant.subtotal, 89000);
    assert.deepEqual(withoutVariant.warnings, []);

    const wrappedSixItem = [
        'Fresh Baby Potatoes / Kentang Baby / Kentan',
        '2  1 kg  Rp15.000  1  Rp15.000',
        'g Rendang Segar',
    ].join('\n');
    const inlineSix = RECEIPT_SIX.replace(
        wrappedSixItem,
        '2  Fresh Baby Potatoes  1 kg  Rp15.000  1  Rp15.000',
    );
    const withVariant = parseInvoice(inlineSix);
    assert.equal(withVariant.lineItems.length, 3);
    assert.deepEqual(withVariant.lineItems[1], {
        description: 'Fresh Baby Potatoes',
        quantity: 1,
        unitPrice: 15000,
        amount: 15000,
        variant: '1 kg',
    });
    assert.equal(withVariant.lineItems[0].description,
        'Sayuran Brokoli Hijau Beku / Frozen Kemasan 1kg');
    assert.equal(withVariant.lineItems[2].description,
        'Timun / Ketimun / Mentimun Segar / Fresh Ukuran Kecil / Lalap / Acar');
    assert.deepEqual(withVariant.warnings, [
        'Subtotal, discount, tax and shipping give 59568, but total is 66068',
    ]);
});

test('mixed wrapped and inline product rows keep every item separate', () => {
    const wrappedItem = [
        'Fresh Baby Potatoes / Kentang Baby / Kentan',
        '2  1 kg  Rp15.000  1  Rp15.000',
        'g Rendang Segar',
    ].join('\n');
    const mixed = RECEIPT_SIX.replace(
        wrappedItem,
        '2  Fresh Baby Potatoes / Kentang Baby / Kentang Rendang Segar  1 kg  Rp15.000  1  Rp15.000',
    );
    const invoice = parseInvoice(mixed);

    assert.equal(invoice.lineItems.length, 3);
    assert.deepEqual(invoice.lineItems.map((item) => item.description), [
        'Sayuran Brokoli Hijau Beku / Frozen Kemasan 1kg',
        'Fresh Baby Potatoes / Kentang Baby / Kentang Rendang Segar',
        'Timun / Ketimun / Mentimun Segar / Fresh Ukuran Kecil / Lalap / Acar',
    ]);
    assert.equal(invoice.lineItems[1].variant, '1 kg');
    assert.equal(invoice.lineItems[0].variant, undefined);
    assert.equal(invoice.lineItems[2].variant, '500 gr');
    assert.equal(invoice.subtotal, 62000);
    assert.equal(invoice.total, 66068);
});

test('long wrapped text stays with the previous product before an inline row', () => {
    const wrappedItem = [
        '1kg',
        'Fresh Baby Potatoes / Kentang Baby / Kentan',
        '2  1 kg  Rp15.000  1  Rp15.000',
        'g Rendang Segar',
    ].join('\n');
    const inlineBlock = [
        'dibungkus rapi untuk menjaga kesegaran',
    ];

    const withoutVariant = parseInvoice(RECEIPT_SIX.replace(
        wrappedItem,
        [...inlineBlock, '2  Fresh Baby Potatoes  Rp15.000  1  Rp15.000'].join('\n'),
    ));
    assert.equal(withoutVariant.lineItems.length, 3);
    assert.equal(withoutVariant.lineItems[0].description,
        'Sayuran Brokoli Hijau Beku / Frozen Kemasan dibungkus rapi untuk menjaga kesegaran');
    assert.deepEqual(withoutVariant.lineItems[1], {
        description: 'Fresh Baby Potatoes',
        quantity: 1,
        unitPrice: 15000,
        amount: 15000,
    });
    assert.deepEqual(withoutVariant.warnings, [
        'Subtotal, discount, tax and shipping give 59568, but total is 66068',
    ]);

    const withVariant = parseInvoice(RECEIPT_SIX.replace(
        wrappedItem,
        [...inlineBlock, '2  Fresh Baby Potatoes  1 kg  Rp15.000  1  Rp15.000'].join('\n'),
    ));
    assert.equal(withVariant.lineItems.length, 3);
    assert.equal(withVariant.lineItems[0].description,
        'Sayuran Brokoli Hijau Beku / Frozen Kemasan dibungkus rapi untuk menjaga kesegaran');
    assert.deepEqual(withVariant.lineItems[1], {
        description: 'Fresh Baby Potatoes',
        quantity: 1,
        unitPrice: 15000,
        amount: 15000,
        variant: '1 kg',
    });
    assert.deepEqual(withVariant.warnings, [
        'Subtotal, discount, tax and shipping give 59568, but total is 66068',
    ]);
});

test('a wrapped next-product description is not claimed by the previous row', () => {
    const wrappedItem = [
        '1kg',
        'Fresh Baby Potatoes / Kentang Baby / Kentan',
        '2  1 kg  Rp15.000  1  Rp15.000',
        'g Rendang Segar',
    ].join('\n');
    const nextWrapped = [
        'dibungkus rapi untuk menjaga kesegaran',
        'Fresh Baby Potatoes',
        '2  Rp15.000  1  Rp15.000',
    ].join('\n');
    const invoice = parseInvoice(RECEIPT_SIX.replace(wrappedItem, nextWrapped));

    assert.equal(invoice.lineItems.length, 3);
    assert.equal(invoice.lineItems[0].description,
        'Sayuran Brokoli Hijau Beku / Frozen Kemasan dibungkus rapi untuk menjaga kesegaran');
    assert.deepEqual(invoice.lineItems[1], {
        description: 'Fresh Baby Potatoes',
        quantity: 1,
        unitPrice: 15000,
        amount: 15000,
    });
    assert.deepEqual(invoice.warnings, [
        'Subtotal, discount, tax and shipping give 59568, but total is 66068',
    ]);
});

test('ambiguous text ownership is preserved with an explicit warning', () => {
    const wrappedItem = [
        '1kg',
        'Fresh Baby Potatoes / Kentang Baby / Kentan',
        '2  1 kg  Rp15.000  1  Rp15.000',
        'g Rendang Segar',
    ].join('\n');
    const ambiguous = [
        'dibungkus rapi untuk menjaga kesegaran',
        '2  1 kg  Rp15.000  1  Rp15.000',
    ].join('\n');
    const invoice = parseInvoice(RECEIPT_SIX.replace(wrappedItem, ambiguous));

    assert.equal(invoice.lineItems.length, 3);
    assert.equal(invoice.lineItems[0].description,
        'Sayuran Brokoli Hijau Beku / Frozen Kemasan dibungkus rapi untuk menjaga kesegaran');
    assert.deepEqual(invoice.lineItems[1], {
        description: '1 kg',
        quantity: 1,
        unitPrice: 15000,
        amount: 15000,
    });
    assert.equal(invoice.lineItems[1].variant, undefined);
    assert.ok(invoice.warnings.some((warning) => /could not be split reliably/.test(warning)));
    assert.ok(invoice.warnings.some((warning) => /59568/.test(warning)));
});

test('receipt labels stop at adjacent fields and use the caller date/currency options', () => {
    const tightContact = RECEIPT_FIVE.replace(
        'Nama Pembeli:  Siti Contoh  Nama Penjual:  MSL Gadget',
        'Nama Pembeli: Siti Contoh Nama Penjual: MSL Gadget',
    );
    const invoice = parseInvoice(tightContact);
    assert.equal(invoice.billTo, 'Siti Contoh');
    assert.equal(invoice.vendor, 'MSL Gadget');

    assert.equal(parseInvoice(RECEIPT_FIVE, { dateOrder: 'mdy' }).invoiceDate, '2026-07-11');
    assert.equal(parseInvoice(RECEIPT_FIVE, { currency: 'sgd' }).currency, 'SGD');
});

test('receipt matching requires Shopee receipt structure, not branding or title alone', () => {
    const generic = parseInvoice(GENERIC_SHOPEE_INVOICE);
    assert.equal(generic.merchant, undefined);
    assert.equal(generic.total, 25);

    const withoutShopee = RECEIPT_FIVE
        .replace(/\bShopee\b/g, 'Marketplace')
        .replace(/ShopeePay/g, 'Wallet');
    assert.equal(parseInvoice(withoutShopee).merchant, undefined);

    const noProductTable = [
        'Shopee',
        'Nota Pesanan',
        'Nama Pembeli: Siti Contoh',
        'Nama Penjual: Toko Contoh',
        'No. Pesanan: 261107NAU80G6E',
        'Subtotal Pesanan  Rp89.000',
        'Total Pembayaran  Rp89.000',
    ].join('\n');
    assert.equal(parseInvoice(noProductTable).merchant, undefined);
});

test('existing Shopee shipping labels stay labels after receipt support', () => {
    const label = [
        'Shopee',
        'SPX',
        'No.Resi: SPXID06573671839B',
        'Penerima: Siti Contoh',
        'Pengirim: Toko Contoh',
        'Batas Kirim: 11-11-2026',
        'No. Pesanan: 2611110YKEYKNA',
        'Nama Produk  Qty',
        'Test Product  1',
    ].join('\n');
    const invoice = parseInvoice(label);

    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'shipping_label');
    assert.equal(invoice.orderId, '2611110YKEYKNA');
    assert.equal(invoice.lineItems[0].quantity, 1);
    assert.equal(invoice.total, null);
    assert.equal(invoice.serviceFee, undefined);
});

test('browser UMD loading parses Shopee receipts', () => {
    const shopeeFile = path.join(__dirname, '..', 'public', 'merchants', 'shopee.js');
    const parserFile = path.join(__dirname, '..', 'public', 'invoice-parser.js');
    const browser = { self: {} };

    vm.runInNewContext(fs.readFileSync(shopeeFile, 'utf8'), browser, { filename: shopeeFile });
    vm.runInNewContext(fs.readFileSync(parserFile, 'utf8'), browser, { filename: parserFile });

    assert.ok(browser.self.InvoiceParserShopee);
    const invoice = browser.self.InvoiceParser.parseInvoice(RECEIPT_FIVE);
    assert.equal(invoice.merchant, 'shopee');
    assert.equal(invoice.documentType, 'invoice_receipt');
    assert.equal(invoice.invoiceNumber, '261107NAU80G6E');
    assert.equal(invoice.lineItems.length, 1);
    assert.equal(invoice.lineItems[0].quantity, 1);
    assert.equal(invoice.total, 85800);
});
