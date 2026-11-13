/**
 * Invoice text -> structured JSON.
 *
 * Works in the browser (window.InvoiceParser) and in Node (require).
 * Understands English and Indonesian invoices, Tokopedia order receipts and
 * Shopee shipping labels, and both the 1,234.56 and 1.234,56 number styles.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node: load the built-in merchant modules without creating a cycle.
        // Merchant modules never require this file; they only receive helpers.
        module.exports = factory(
            require('./merchants/tokopedia.js'),
            require('./merchants/shopee.js'),
        );
    } else {
        // Browser: merchant scripts must load first and expose these globals.
        // Either adapter is optional; parseInvoice still works without it.
        /** @type {any} */ (root).InvoiceParser = factory(
            /** @type {any} */ (root).InvoiceParserTokopedia,
            /** @type {any} */ (root).InvoiceParserShopee,
        );
    }
})(typeof self !== 'undefined' ? self : this, function (builtInTokopedia, builtInShopee) {
    'use strict';

    /**
     * @typedef {Object} LineItem
     * @property {string} description
     * @property {number|null} quantity
     * @property {number|null} unitPrice
     * @property {number|null} amount
     * @property {string} [sku]        optional merchant-specific metadata
     * @property {string} [variant]    optional merchant-specific metadata
     * @property {string} [unit]       optional merchant-specific metadata
     */

    /**
     * @typedef {Object} Invoice
     * @property {string|null} vendor
     * @property {string|null} billTo
     * @property {string|null} invoiceNumber
     * @property {string|null} invoiceDate  ISO yyyy-mm-dd
     * @property {string|null} dueDate      ISO yyyy-mm-dd
     * @property {string|null} currency     ISO 4217 code
     * @property {LineItem[]} lineItems
     * @property {number|null} subtotal
     * @property {number|null} discount
     * @property {number|null} taxRate      percent, e.g. 11
     * @property {number|null} tax
     * @property {number|null} shipping
     * @property {number|null} total
     * @property {number|null} amountDue
     * @property {string[]} warnings
     * @property {string} [merchant]        set by a merchant adapter
     * @property {number} [shippingDiscount] optional merchant-specific extra
     * @property {number} [insurance]        optional merchant-specific extra
     * @property {number} [serviceFee]       optional merchant-specific extra
     * @property {Voucher[]} [vouchers]      optional merchant-specific metadata
     * @property {string} [documentType]     e.g. "shipping_label" for non-invoices
     * @property {string|null} [orderId]     optional merchant-specific order ID
     * @property {string|null} [trackingNumber] optional shipment tracking number
     * @property {string|null} [orderDate]   ISO yyyy-mm-dd order date
     * @property {string|null} [shippingDeadline] ISO yyyy-mm-dd hand-off deadline
     * @property {{value: number, unit: string}|null} [weight] optional shipment weight
     * @property {string|null} [courier]     optional explicitly printed courier
     * @property {string|null} [payment]     optional explicitly printed payment method
     */

    /**
     * @typedef {Object} Voucher
     * @property {string|null} code
     * @property {number|null} amount
     * @property {string|null} note
     * @property {boolean} applied
     */

    /**
     * @typedef {Object} ParseOptions
     * @property {'dmy'|'mdy'} [dateOrder]  how to read ambiguous 03/04/2026 (default dmy)
     * @property {string} [currency]        force a currency code
     */

    /**
     * @typedef {Object} MerchantParserHelpers
     * @property {(text: string, options?: ParseOptions) => Invoice} parseGeneric
     * @property {(token: string) => number|null} parseAmount
     * @property {(text: string, dateOrder?: 'dmy'|'mdy') => {iso: string, index: number, length: number}|null} findDate
     * @property {(text: string) => string|null} detectCurrency
     * @property {(invoice: Invoice) => string[]} checkInvoice
     */

    /**
     * A merchant-specific parser. Matchers run in registration order; the
     * first `true` match wins. Adapters must not call the public parseInvoice
     * function (which could dispatch recursively); use `helpers.parseGeneric`.
     * @typedef {Object} MerchantParser
     * @property {string} id
     * @property {(text: string) => boolean} matches
     * @property {(text: string, options: ParseOptions, helpers: MerchantParserHelpers) => Invoice} parse
     */

    // ------------------------------------------------------------------
    // Numbers
    // ------------------------------------------------------------------

    /**
     * Parses a number written as 1,234.56 or 1.234,56 (or 1.234.567, 1 234).
     * @param {string} token
     * @returns {number|null}
     */
    function parseAmount(token) {
        let s = String(token).replace(/[^\d.,-]/g, '');
        const negative = s.startsWith('-');
        s = s.replace(/-/g, '');
        if (!/\d/.test(s)) {
            return null;
        }

        const lastDot = s.lastIndexOf('.');
        const lastComma = s.lastIndexOf(',');
        let decimalIndex = -1;

        if (lastDot !== -1 && lastComma !== -1) {
            // Both present: whichever comes last is the decimal separator.
            decimalIndex = Math.max(lastDot, lastComma);
        } else if (lastDot !== -1 || lastComma !== -1) {
            const separator = lastDot !== -1 ? '.' : ',';
            const parts = s.split(separator);
            const tail = parts[parts.length - 1];
            // 1.234.567 or 1,234 -> thousands. 12.5 or 0.125 -> decimal.
            const isThousands = parts.length > 2
                || (tail.length === 3 && parts[0] !== '0' && parts[0].length <= 3);
            if (!isThousands) {
                decimalIndex = s.lastIndexOf(separator);
            }
        }

        let value;
        if (decimalIndex === -1) {
            value = Number(s.replace(/[.,]/g, ''));
        } else {
            const whole = s.slice(0, decimalIndex).replace(/[.,]/g, '') || '0';
            const fraction = s.slice(decimalIndex + 1).replace(/[.,]/g, '');
            value = Number(`${whole}.${fraction}`);
        }
        if (!Number.isFinite(value)) {
            return null;
        }
        return negative ? -value : value;
    }

    const AMOUNT_RE = /(?<![\w.,/-])-?\d+(?:[.,]\d+)*(?![\w/])/g;
    const PURE_AMOUNT_RE = /^-?\d+(?:[.,]\d+)*$/;
    const CURRENCY_TOKEN_RE = /(?<![A-Za-z])(?:S|A|US)\$|\bR[pP](?![A-Za-z])\.?|\b(?:IDR|USD|SGD|AUD|EUR|GBP|MYR|THB|JPY|VND|PHP|INR)\b|\bRM(?=\s?\d)|[$€£¥₫₱฿₹]/g;
    const UNIT_SUFFIX_RE = /(\d)\s*(?:pcs?|pieces?|units?|ea|each|hrs?|hours?|kg|lbs?|boxes|box|sets?|packs?|buah|lusin)\b/gi;

    /**
     * Removes currency symbols so only the numbers remain.
     * @param {string} line
     * @returns {string}
     */
    function stripCurrency(line) {
        return line
            .replace(CURRENCY_TOKEN_RE, ' ')
            .replace(/,-/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Rightmost number on a line, ignoring percentages like "11%".
     * @param {string} clean line already passed through stripCurrency
     * @returns {number|null}
     */
    function lastAmount(clean) {
        const withoutPercent = clean.replace(/\d+(?:[.,]\d+)?\s*%/g, ' ');
        const matches = [...withoutPercent.matchAll(AMOUNT_RE)];
        if (matches.length === 0) {
            return null;
        }
        return parseAmount(matches[matches.length - 1][0]);
    }

    // ------------------------------------------------------------------
    // Currency
    // ------------------------------------------------------------------

    /** @type {[string, RegExp][]} */
    const CURRENCIES = [
        ['SGD', /(?<![A-Za-z])S\$|\bSGD\b/g],
        ['AUD', /(?<![A-Za-z])A\$|\bAUD\b/g],
        ['USD', /US\$|(?<![A-Za-z])\$|\bUSD\b/g],
        ['IDR', /\bR[pP](?![A-Za-z])|\bIDR\b/g],
        ['EUR', /€|\bEUR\b/g],
        ['GBP', /£|\bGBP\b/g],
        ['MYR', /\bRM(?=\s?\d)|\bMYR\b/g],
        ['THB', /฿|\bTHB\b/g],
        ['JPY', /¥|\bJPY\b/g],
        ['VND', /₫|\bVND\b/g],
        ['PHP', /₱|\bPHP\b/g],
        ['INR', /₹|\bINR\b/g],
    ];

    /**
     * @param {string} text
     * @returns {string|null}
     */
    function detectCurrency(text) {
        let best = null;
        let bestCount = 0;
        for (const [code, re] of CURRENCIES) {
            const count = (text.match(re) || []).length;
            if (count > bestCount) {
                best = code;
                bestCount = count;
            }
        }
        return best;
    }

    // ------------------------------------------------------------------
    // Dates
    // ------------------------------------------------------------------

    /** @type {Record<string, number>} */
    const MONTHS = {
        jan: 1, january: 1, januari: 1,
        feb: 2, february: 2, februari: 2, pebruari: 2,
        mar: 3, march: 3, maret: 3,
        apr: 4, april: 4,
        may: 5, mei: 5,
        jun: 6, june: 6, juni: 6,
        jul: 7, july: 7, juli: 7,
        aug: 8, august: 8, agu: 8, agt: 8, agustus: 8,
        sep: 9, sept: 9, september: 9,
        oct: 10, october: 10, okt: 10, oktober: 10,
        nov: 11, november: 11, nop: 11, nopember: 11,
        dec: 12, december: 12, des: 12, desember: 12,
    };
    const MONTH_PATTERN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

    const DATE_PATTERNS = [
        { re: /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/, order: 'ymd' },
        { re: /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\b/, order: 'numeric' },
        {
            re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(${MONTH_PATTERN})(?![a-z])\\.?,?[\\s-]+(\\d{4}|\\d{2})\\b`, 'i'),
            order: 'dmonthy',
        },
        {
            re: new RegExp(`\\b(${MONTH_PATTERN})(?![a-z])\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'),
            order: 'mondy',
        },
    ];

    /**
     * @param {RegExpExecArray} m
     * @param {string} order
     * @param {'dmy'|'mdy'} dateOrder
     * @returns {string|null}
     */
    function toIsoDate(m, order, dateOrder) {
        let year;
        let month;
        let day;
        switch (order) {
            case 'ymd':
                year = Number(m[1]);
                month = Number(m[2]);
                day = Number(m[3]);
                break;
            case 'numeric': {
                const a = Number(m[1]);
                const b = Number(m[2]);
                year = Number(m[3]);
                if (a > 12) {
                    day = a;
                    month = b;
                } else if (b > 12) {
                    month = a;
                    day = b;
                } else if (dateOrder === 'mdy') {
                    month = a;
                    day = b;
                } else {
                    day = a;
                    month = b;
                }
                break;
            }
            case 'dmonthy':
                day = Number(m[1]);
                month = MONTHS[m[2].toLowerCase()];
                year = Number(m[3]);
                break;
            default:
                month = MONTHS[m[1].toLowerCase()];
                day = Number(m[2]);
                year = Number(m[3]);
                break;
        }
        if (year < 100) {
            year += 2000;
        }
        if (!month || year < 1990 || year > 2100) {
            return null;
        }
        const check = new Date(Date.UTC(year, month - 1, day));
        if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
            return null;
        }
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    /**
     * Finds the first date in a piece of text.
     * @param {string} text
     * @param {'dmy'|'mdy'} [dateOrder]
     * @returns {{iso: string, index: number, length: number}|null}
     */
    function findDate(text, dateOrder = 'dmy') {
        let best = null;
        for (const { re, order } of DATE_PATTERNS) {
            const m = re.exec(text);
            if (!m || (best && m.index >= best.index)) {
                continue;
            }
            const iso = toIsoDate(m, order, dateOrder);
            if (iso) {
                best = { iso, index: m.index, length: m[0].length };
            }
        }
        return best;
    }

    const DATE_LABEL_RE = /\b(?:invoice\s*date|date\s*of\s*issue|issue\s*date|date\s*issued|billing\s*date|bill\s*date|tanggal\s*(?:invoice|faktur|nota)|tgl\.?\s*(?:invoice|faktur|nota)|tanggal|tgl\.?|date)\b\s*[:.\-]?/i;
    const DUE_LABEL_RE = /\b(?:due\s*date|payment\s*due|date\s*due|due\s*on|due|pay\s*by|tanggal\s*jatuh\s*tempo|tgl\.?\s*jatuh\s*tempo|jatuh\s*tempo)\b\s*[:.\-]?/i;

    /**
     * @param {string[]} lines
     * @param {RegExp} labelRe
     * @param {'dmy'|'mdy'} dateOrder
     * @param {RegExp|null} skipRe lines matching this are ignored
     * @returns {string|null}
     */
    function findLabeledDate(lines, labelRe, dateOrder, skipRe) {
        for (let i = 0; i < lines.length; i++) {
            if (skipRe && skipRe.test(lines[i])) {
                continue;
            }
            const m = labelRe.exec(lines[i]);
            if (!m) {
                continue;
            }
            const here = findDate(lines[i].slice(m.index + m[0].length), dateOrder);
            if (here) {
                return here.iso;
            }
            const next = lines[i + 1] ? findDate(lines[i + 1], dateOrder) : null;
            if (next && next.index === 0) {
                return next.iso;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Header fields
    // ------------------------------------------------------------------

    const INVOICE_NO_RE = /\b(?:invoice|inv|faktur|receipt|nota|kwitansi)\s*(?:no\.?|number|num\.?|nomor|#|id)?\s*[:.#-]?\s*(?=[A-Z0-9\-/_.]*\d)([A-Z0-9][A-Z0-9\-/_.]*)/i;
    const INVOICE_NO_FALLBACK_RE = /(?:^|\n)\s*(?:no|nomor)\.?\s*[:#]\s*([A-Z0-9][A-Z0-9\-/_.]{3,})/i;

    /**
     * @param {string} text
     * @returns {string|null}
     */
    function findInvoiceNumber(text) {
        const m = INVOICE_NO_RE.exec(text) || INVOICE_NO_FALLBACK_RE.exec(text);
        return m ? m[1].replace(/[.,;:]+$/, '') : null;
    }

    const BILL_TO_RE = /^(?:bill(?:ed)?\s*to|invoice\s*to|sold\s*to|customer(?:\s*name)?|client|kepada|pelanggan|ditagihkan\s*kepada|penerima)\b\s*[:-]?\s*(.*)$/i;

    /**
     * @param {string[]} lines
     * @returns {string|null}
     */
    function findBillTo(lines) {
        for (let i = 0; i < lines.length; i++) {
            const m = BILL_TO_RE.exec(lines[i]);
            if (!m) {
                continue;
            }
            const rest = m[1].trim();
            if (rest) {
                if (/^(?:id|no|number|#)\b/i.test(rest)) {
                    continue;
                }
                return rest;
            }
            if (lines[i + 1]) {
                return lines[i + 1];
            }
        }
        return null;
    }

    const SKIP_VENDOR_RE = /^(?:(?:tax\s+)?invoice|faktur(?:\s+pajak)?|receipt|bill|nota|kwitansi|page\s*\d|original|copy|duplicate)\b|@|https?:|www\.|^\W*$/i;
    const FROM_RE = /^(?:from|seller|vendor|supplier|dari|penjual)\s*[:-]\s*(.+)$/i;

    /**
     * @param {string[]} lines
     * @returns {string|null}
     */
    function guessVendor(lines) {
        const head = lines.slice(0, 10);
        for (const line of head) {
            const m = FROM_RE.exec(line);
            if (m) {
                return m[1].trim();
            }
        }
        for (const line of head.slice(0, 8)) {
            if (/[A-Za-z]{2,}/.test(line) && !SKIP_VENDOR_RE.test(line) && line.length <= 80) {
                return line;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Totals
    // ------------------------------------------------------------------

    /** @type {Record<string, RegExp>} order matters: first match wins */
    const TOTAL_LABELS = {
        subtotal: /^(?:sub\s*-?\s*total|net\s*total|total\s*before\s*tax|jumlah\s*sebelum\s*pajak|dpp)\b/i,
        discount: /^(?:total\s*)?(?:discount|diskon|potongan)\b/i,
        tax: /^(?:total\s*)?(?:sales\s*tax|tax|vat|gst|ppn|pajak)\b(?!\s*(?:invoice|id\b|no\b|number|reg|registration|#))/i,
        shipping: /^(?:shipping|freight|delivery|postage|handling|ongkir|ongkos\s*kirim|biaya\s*kirim)\b/i,
        amountDue: /^(?:amount\s*due|balance\s*due|total\s*due|sisa\s*tagihan|sisa\s*pembayaran|outstanding)\b/i,
        grandTotal: /^(?:grand\s*total|total\s*amount|total\s*payable|amount\s*payable|net\s*payable|total\s*tagihan|total\s*bayar|total\s*pembayaran|jumlah\s*tagihan|invoice\s*total|total\s*invoice)\b/i,
        total: /^(?:total|jumlah\s*total|jumlah)\b/i,
    };

    /**
     * @param {string[]} lines
     * @returns {{values: Record<string, number|null>, taxRate: number|null}}
     */
    function findTotals(lines) {
        /** @type {Record<string, number|null>} */
        const values = {
            subtotal: null,
            discount: null,
            tax: null,
            shipping: null,
            amountDue: null,
            grandTotal: null,
            total: null,
        };
        let taxRate = null;

        lines.forEach((line, i) => {
            const clean = stripCurrency(line);
            const key = Object.keys(TOTAL_LABELS).find((k) => TOTAL_LABELS[k].test(clean));
            if (!key) {
                return;
            }
            let source = clean;
            let value = lastAmount(clean);
            if (value === null && lines[i + 1] && PURE_AMOUNT_RE.test(stripCurrency(lines[i + 1]))) {
                source = stripCurrency(lines[i + 1]);
                value = lastAmount(source);
            }
            if (value === null) {
                return;
            }
            values[key] = value;
            if (key === 'tax') {
                const rate = /(\d+(?:[.,]\d+)?)\s*%/.exec(clean);
                if (rate) {
                    taxRate = parseAmount(rate[1]);
                }
            }
        });

        return { values, taxRate };
    }

    // ------------------------------------------------------------------
    // Line items
    // ------------------------------------------------------------------

    /** @type {[string, RegExp][]} */
    const COLUMN_PATTERNS = [
        ['amount', /\b(?:line\s*total|total\s*price|total\s*amount|total\s*harga|jumlah\s*harga|sub\s*total|subtotal|amount|total)\b/i],
        ['unitPrice', /\b(?:unit\s*price|unit\s*cost|harga\s*satuan|harga|price|rate|cost)\b/i],
        ['quantity', /\b(?:qty|quantity|qnty|kuantitas|kuantiti|jml|jumlah\s*barang|hours|hrs)\b/i],
        ['description', /\b(?:description|item|items|product|products|details|particulars|deskripsi|nama\s*barang|nama\s*item|nama\s*produk|barang|uraian|keterangan)\b/i],
    ];

    const FOOTER_RE = /^(?:notes?|terms?|payment\s*(?:terms?|info|method|instructions?|details)|bank|catatan|terbilang|thank|please|remit|account|rekening|a\/n)\b/i;
    const META_RE = /\b(?:invoice|faktur|date|tanggal|tgl|due|tel|telp|phone|hp|fax|email|npwp|iban|swift|bic|rekening|account|www|http|page)\b/i;

    /**
     * Detects whether a line is a table header; returns the column layout.
     * @param {string} line
     * @returns {{layout: string[], hasIndexCol: boolean}|null}
     */
    function parseHeader(line) {
        if (line.length > 140) {
            return null;
        }
        let masked = line;
        /** @type {{kind: string, index: number}[]} */
        const found = [];
        for (const [kind, re] of COLUMN_PATTERNS) {
            const m = re.exec(masked);
            if (m) {
                found.push({ kind, index: m.index });
                masked = masked.slice(0, m.index) + ' '.repeat(m[0].length) + masked.slice(m.index + m[0].length);
            }
        }
        // Indonesian "Jumlah" is either the quantity or the line total.
        const jumlah = /\bjumlah\b/i.exec(masked);
        if (jumlah) {
            const hasAmount = found.some((f) => f.kind === 'amount');
            const hasQuantity = found.some((f) => f.kind === 'quantity');
            if (!hasAmount) {
                found.push({ kind: 'amount', index: jumlah.index });
            } else if (!hasQuantity) {
                found.push({ kind: 'quantity', index: jumlah.index });
            }
        }
        found.sort((a, b) => a.index - b.index);
        const numeric = found.filter((f) => f.kind !== 'description');
        const hasDescription = found.some((f) => f.kind === 'description');
        if (!((hasDescription && numeric.length >= 1) || numeric.length >= 3)) {
            return null;
        }
        return {
            layout: numeric.map((f) => f.kind),
            hasIndexCol: /^(?:no\.?|#|nr\.?|sl\.?)\s/i.test(line),
        };
    }

    /**
     * @param {number[]} values
     * @returns {string[]}
     */
    function guessKinds(values) {
        switch (values.length) {
            case 1:
                return ['amount'];
            case 2:
                return Number.isInteger(values[0]) && values[0] > 0 && values[0] < 1000
                    ? ['quantity', 'amount']
                    : ['unitPrice', 'amount'];
            default:
                return ['quantity', 'unitPrice', 'amount'];
        }
    }

    /**
     * Turns one table row into a line item, reading numbers from the right.
     * @param {string} line
     * @param {{layout: string[], hasIndexCol: boolean, minNumbers: number}} opts
     * @returns {LineItem|null}
     */
    function parseRow(line, opts) {
        const clean = stripCurrency(line).replace(UNIT_SUFFIX_RE, '$1');
        const matches = [...clean.matchAll(AMOUNT_RE)];
        if (matches.length === 0) {
            return null;
        }

        // Walk backwards while the numbers are only separated by whitespace.
        let first = matches.length;
        for (let i = matches.length - 1; i >= 0; i--) {
            const end = matches[i].index + matches[i][0].length;
            const stop = i === matches.length - 1 ? clean.length : matches[i + 1].index;
            if (clean.slice(end, stop).trim() !== '') {
                break;
            }
            first = i;
        }
        first = Math.max(first, matches.length - (opts.layout.length || 3));
        const tail = matches.slice(first);
        if (tail.length < opts.minNumbers) {
            return null;
        }

        let description = clean.slice(0, tail[0].index).trim();
        if (opts.hasIndexCol) {
            description = description.replace(/^\d{1,3}[.)]?\s+/, '');
        }
        description = description.replace(/^[\s\-–:.)]+|[\s\-–:.(]+$/g, '').trim();
        if (!/[A-Za-z]{2}/.test(description)) {
            return null;
        }

        const values = tail.map((m) => parseAmount(m[0]));
        const kinds = opts.layout.length
            ? opts.layout.slice(-tail.length)
            : guessKinds(/** @type {number[]} */ (values));
        /** @type {LineItem} */
        const item = { description, quantity: null, unitPrice: null, amount: null };
        kinds.forEach((kind, i) => {
            if (kind === 'quantity' || kind === 'unitPrice' || kind === 'amount') {
                item[kind] = values[i];
            }
        });
        return item;
    }

    /**
     * @param {string[]} lines
     * @returns {LineItem[]}
     */
    function extractLineItems(lines) {
        let header = null;
        let headerIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            header = parseHeader(lines[i]);
            if (header) {
                headerIndex = i;
                break;
            }
        }

        const start = header ? headerIndex + 1 : 0;
        let end = lines.length;
        for (let i = start; i < lines.length; i++) {
            const clean = stripCurrency(lines[i]);
            if (Object.values(TOTAL_LABELS).some((re) => re.test(clean)) || FOOTER_RE.test(clean)) {
                end = i;
                break;
            }
        }

        /** @type {LineItem[]} */
        const items = [];
        for (let i = start; i < end; i++) {
            const line = lines[i];
            if (header && parseHeader(line)) {
                continue; // header repeated on a following page
            }
            if (!header && (META_RE.test(line) || findDate(line))) {
                continue;
            }
            const item = parseRow(line, {
                layout: header ? header.layout : [],
                hasIndexCol: header ? header.hasIndexCol : false,
                minNumbers: header ? 1 : 2,
            });
            if (item) {
                items.push(item);
            } else if (header && items.length > 0 && /[A-Za-z]{2}/.test(line) && !META_RE.test(line)) {
                // Wrapped description: continues the previous row.
                items[items.length - 1].description += ` ${line}`;
            }
        }
        return items;
    }

    // ------------------------------------------------------------------
    // Sanity checks
    // ------------------------------------------------------------------

    const round2 = (n) => Math.round(n * 100) / 100;
    const close = (a, b) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.002);

    /**
     * @param {Invoice} invoice
     * @returns {string[]}
     */
    function checkInvoice(invoice) {
        const warnings = [];
        if (!invoice.invoiceNumber) {
            warnings.push('Invoice number not found');
        }
        if (!invoice.invoiceDate) {
            warnings.push('Invoice date not found');
        }
        if (invoice.total === null) {
            warnings.push('Total not found');
        }
        if (invoice.lineItems.length === 0) {
            warnings.push('No line items detected');
        }

        invoice.lineItems.forEach((item, i) => {
            if (item.quantity !== null && item.unitPrice !== null && item.amount !== null
                && !close(item.quantity * item.unitPrice, item.amount)) {
                warnings.push(`Line ${i + 1} (${item.description}): quantity × unit price does not equal amount`);
            }
        });

        const amounts = invoice.lineItems.map((item) => item.amount);
        if (invoice.subtotal !== null && amounts.length > 0 && amounts.every((a) => a !== null)) {
            const sum = round2(/** @type {number[]} */ (amounts).reduce((x, y) => x + y, 0));
            if (!close(sum, invoice.subtotal)) {
                warnings.push(`Line items add up to ${sum}, but subtotal is ${invoice.subtotal}`);
            }
        }

        if (invoice.subtotal !== null && invoice.total !== null) {
            const expected = round2(
                invoice.subtotal
                - Math.abs(invoice.discount || 0)
                + (invoice.tax || 0)
                + (invoice.shipping || 0)
                - Math.abs(invoice.shippingDiscount || 0)
                + (invoice.insurance || 0)
                + (invoice.serviceFee || 0),
            );
            if (!close(expected, invoice.total)) {
                warnings.push(`Subtotal, discount, tax and shipping give ${expected}, but total is ${invoice.total}`);
            }
        }
        return warnings;
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * @param {string} text
     * @returns {string[]}
     */
    function toLines(text) {
        return String(text || '')
            .replace(/\r/g, '')
            .replace(/\f/g, '\n')
            .split('\n')
            .map((line) => line.replace(/[|│┃¦]/g, ' ').replace(/[ \t\u00a0]+/g, ' ').trim())
            .filter(Boolean);
    }

    /** @type {MerchantParser[]} */
    const merchantParsers = [];
    /** @type {Set<string>} */
    const merchantParserIds = new Set();

    /**
     * Registers a merchant parser. Registration order is matcher priority:
     * the first matcher that returns true handles the document. IDs must be
     * unique; registering the same ID twice throws instead of silently
     * replacing an existing adapter.
     * @param {MerchantParser} parser
     * @returns {MerchantParser}
     */
    function registerMerchantParser(parser) {
        if (!parser || typeof parser !== 'object') {
            throw new TypeError('Merchant parser must be an object');
        }
        if (typeof parser.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(parser.id)) {
            throw new TypeError('Merchant parser id must be a non-empty string such as "tokopedia"');
        }
        if (typeof parser.matches !== 'function') {
            throw new TypeError(`Merchant parser "${parser.id}" must define matches(text)`);
        }
        if (typeof parser.parse !== 'function') {
            throw new TypeError(`Merchant parser "${parser.id}" must define parse(text, options, helpers)`);
        }
        if (merchantParserIds.has(parser.id)) {
            throw new Error(`Merchant parser "${parser.id}" is already registered`);
        }
        merchantParsers.push(parser);
        merchantParserIds.add(parser.id);
        return parser;
    }

    /** @type {MerchantParserHelpers} */
    const merchantHelpers = {
        parseGeneric: parseGenericInvoice,
        parseAmount,
        findDate,
        detectCurrency,
        checkInvoice,
    };

    /**
     * Converts OCR (or PDF) text into structured data. If a registered
     * merchant adapter matches, that adapter parses the text; otherwise the
     * original generic parser handles it.
     * @param {string} text
     * @param {ParseOptions} [options]
     * @returns {Invoice}
     */
    function parseInvoice(text, options = {}) {
        const source = String(text || '');
        for (const parser of merchantParsers) {
            let matches = false;
            try {
                matches = parser.matches(source) === true;
            } catch {
                // A broken matcher must not prevent a different merchant or
                // the generic fallback from handling the document.
                matches = false;
            }
            if (matches) {
                return parser.parse(source, options, merchantHelpers);
            }
        }
        return parseGenericInvoice(source, options);
    }

    /**
     * Original layout-independent parser. Merchant adapters call this through
     * helpers.parseGeneric, never through the public parseInvoice.
     * @param {string} text
     * @param {ParseOptions} [options]
     * @returns {Invoice}
     */
    function parseGenericInvoice(text, options = {}) {
        const dateOrder = options.dateOrder === 'mdy' ? 'mdy' : 'dmy';
        const lines = toLines(text);
        const fullText = lines.join('\n');
        const { values, taxRate } = findTotals(lines);

        const dueDate = findLabeledDate(lines, DUE_LABEL_RE, dateOrder, null);
        let invoiceDate = findLabeledDate(lines, DATE_LABEL_RE, dateOrder, DUE_LABEL_RE);
        if (!invoiceDate) {
            const anyDate = findDate(fullText, dateOrder);
            invoiceDate = anyDate && anyDate.iso !== dueDate ? anyDate.iso : null;
        }

        /** @type {Invoice} */
        const invoice = {
            vendor: guessVendor(lines),
            billTo: findBillTo(lines),
            invoiceNumber: findInvoiceNumber(fullText),
            invoiceDate,
            dueDate,
            currency: options.currency || detectCurrency(fullText),
            lineItems: extractLineItems(lines),
            subtotal: values.subtotal,
            discount: values.discount,
            taxRate,
            tax: values.tax,
            shipping: values.shipping,
            total: [values.grandTotal, values.total, values.amountDue].find((v) => v !== null) ?? null,
            amountDue: values.amountDue,
            warnings: [],
        };
        invoice.warnings = checkInvoice(invoice);
        return invoice;
    }

    if (builtInTokopedia) {
        registerMerchantParser(builtInTokopedia);
    }
    if (builtInShopee) {
        registerMerchantParser(builtInShopee);
    }

    return { parseInvoice, parseAmount, findDate, detectCurrency, registerMerchantParser };
});
