'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInvoice, parseAmount, findDate } = require('../public/invoice-parser.js');

const ENGLISH = `
ACME Supplies Ltd.
123 Market Street, Springfield
INVOICE
Invoice No: INV-2026-0042
Invoice Date: November 3, 2026
Due Date: December 3, 2026

Bill To:
Globex Corporation
742 Evergreen Terrace

Description Qty Unit Price Amount
Widget A 10 $12.50 $125.00
Widget B (large) 2 $99.99 $199.98
Installation service 1 $150.00 $150.00
Subtotal $474.98
Tax (10%) $47.50
Shipping $20.00
Total $542.48
Notes: Thank you for your business
`;

const INDONESIAN = `
PT Maju Jaya Abadi
Jl. Sudirman No. 12, Jakarta
NPWP: 01.234.567.8-012.000
FAKTUR
No. Faktur: INV/2026/11/0087
Tanggal: 05/11/2026
Jatuh Tempo: 20/11/2026
Kepada:
CV Sinar Terang
No Nama Barang Qty Harga Jumlah
1 Kertas A4 80gr 10 Rp 55.000 Rp 550.000
2 Tinta Printer Hitam 3 Rp 125.500 Rp 376.500
3 Ongkos Pasang 1 Rp 1.000.000 Rp 1.000.000
Subtotal Rp 1.926.500
Diskon Rp 26.500
PPN 11% Rp 209.000
Total Rp 2.109.000
Terbilang: Dua juta seratus sembilan ribu rupiah
`;

// Table borders, a phone number and "TOTAL DUE" instead of "Total".
const NOISY = `
| SUNRISE TRADING CO |
Tel: +62 21 555 1234
INVOICE # 2026-1187
Date: 2026-10-30
Terms: Net 30

BILL TO: Budi Santoso
Item | Quantity | Price | Total
Consulting hours | 12 | 85.00 | 1,020.00
Server hosting (monthly) | 1 | 49.00 | 49.00
Domain renewal | 2 | 15.00 | 30.00

Sub Total 1,099.00
VAT 0.00
TOTAL DUE $1,099.00
`;

test('parseAmount handles both number styles', () => {
    assert.equal(parseAmount('1,234.56'), 1234.56);
    assert.equal(parseAmount('1.234,56'), 1234.56);
    assert.equal(parseAmount('1.234.567'), 1234567);
    assert.equal(parseAmount('55.000'), 55000);
    assert.equal(parseAmount('12.5'), 12.5);
    assert.equal(parseAmount('0.125'), 0.125);
    assert.equal(parseAmount('1,5'), 1.5);
    assert.equal(parseAmount('-26.500'), -26500);
    assert.equal(parseAmount('abc'), null);
});

test('findDate reads common formats', () => {
    assert.equal(findDate('Nov 3, 2026').iso, '2026-11-03');
    assert.equal(findDate('3 November 2026').iso, '2026-11-03');
    assert.equal(findDate('20 Agustus 2026').iso, '2026-08-20');
    assert.equal(findDate('2026-10-30').iso, '2026-10-30');
    assert.equal(findDate('25/12/2026').iso, '2026-12-25');
    assert.equal(findDate('11/03/2026', 'dmy').iso, '2026-03-11');
    assert.equal(findDate('11/03/2026', 'mdy').iso, '2026-11-03');
    assert.equal(findDate('31/02/2026'), null);
});

test('English invoice with US number format', () => {
    const inv = parseInvoice(ENGLISH);
    assert.equal(inv.vendor, 'ACME Supplies Ltd.');
    assert.equal(inv.billTo, 'Globex Corporation');
    assert.equal(inv.invoiceNumber, 'INV-2026-0042');
    assert.equal(inv.invoiceDate, '2026-11-03');
    assert.equal(inv.dueDate, '2026-12-03');
    assert.equal(inv.currency, 'USD');
    assert.deepEqual(inv.lineItems, [
        { description: 'Widget A', quantity: 10, unitPrice: 12.5, amount: 125 },
        { description: 'Widget B (large)', quantity: 2, unitPrice: 99.99, amount: 199.98 },
        { description: 'Installation service', quantity: 1, unitPrice: 150, amount: 150 },
    ]);
    assert.equal(inv.subtotal, 474.98);
    assert.equal(inv.taxRate, 10);
    assert.equal(inv.tax, 47.5);
    assert.equal(inv.shipping, 20);
    assert.equal(inv.total, 542.48);
    assert.deepEqual(inv.warnings, []);
});

test('Indonesian invoice with Rp and dd/mm/yyyy', () => {
    const inv = parseInvoice(INDONESIAN);
    assert.equal(inv.vendor, 'PT Maju Jaya Abadi');
    assert.equal(inv.billTo, 'CV Sinar Terang');
    assert.equal(inv.invoiceNumber, 'INV/2026/11/0087');
    assert.equal(inv.invoiceDate, '2026-11-05');
    assert.equal(inv.dueDate, '2026-11-20');
    assert.equal(inv.currency, 'IDR');
    assert.equal(inv.lineItems.length, 3);
    assert.deepEqual(inv.lineItems[0], { description: 'Kertas A4 80gr', quantity: 10, unitPrice: 55000, amount: 550000 });
    assert.deepEqual(inv.lineItems[2], { description: 'Ongkos Pasang', quantity: 1, unitPrice: 1000000, amount: 1000000 });
    assert.equal(inv.subtotal, 1926500);
    assert.equal(inv.discount, 26500);
    assert.equal(inv.taxRate, 11);
    assert.equal(inv.tax, 209000);
    assert.equal(inv.total, 2109000);
    assert.deepEqual(inv.warnings, []);
});

test('noisy OCR text with table borders', () => {
    const inv = parseInvoice(NOISY);
    assert.equal(inv.vendor, 'SUNRISE TRADING CO');
    assert.equal(inv.billTo, 'Budi Santoso');
    assert.equal(inv.invoiceNumber, '2026-1187');
    assert.equal(inv.invoiceDate, '2026-10-30');
    assert.equal(inv.currency, 'USD');
    assert.equal(inv.lineItems.length, 3);
    assert.deepEqual(inv.lineItems[0], { description: 'Consulting hours', quantity: 12, unitPrice: 85, amount: 1020 });
    assert.equal(inv.subtotal, 1099);
    assert.equal(inv.tax, 0);
    assert.equal(inv.total, 1099);
    assert.equal(inv.amountDue, 1099);
    assert.deepEqual(inv.warnings, []);
});

test('OCR digit errors produce warnings', () => {
    const broken = ENGLISH.replace('$199.98', '$109.98');
    const inv = parseInvoice(broken);
    assert.ok(inv.warnings.some((w) => w.includes('quantity × unit price')), inv.warnings.join('\n'));
    assert.ok(inv.warnings.some((w) => w.includes('subtotal')), inv.warnings.join('\n'));
});

test('no table header: falls back to rows with several numbers', () => {
    const inv = parseInvoice(`Corner Cafe
Invoice 8841
Date 12/05/2026
Coffee beans 2 18.00 36.00
Paper cups 5 4.00 20.00
Total 56.00`);
    assert.equal(inv.invoiceNumber, '8841');
    assert.equal(inv.lineItems.length, 2);
    assert.deepEqual(inv.lineItems[1], { description: 'Paper cups', quantity: 5, unitPrice: 4, amount: 20 });
    assert.equal(inv.total, 56);
});

test('empty input does not throw', () => {
    const inv = parseInvoice('');
    assert.equal(inv.vendor, null);
    assert.deepEqual(inv.lineItems, []);
    assert.ok(inv.warnings.length > 0);
});
