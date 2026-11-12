/**
 * Tokopedia invoice adapter.
 *
 * Tokopedia PDFs and screenshots contain an order invoice and may append a
 * separate shipping receipt. This module keeps the generic parser clean:
 * it recognises Tokopedia documents, drops shipping-receipt pages/sections,
 * and maps the remaining order receipt to the common Invoice shape.
 *
 * Works in the browser (window.InvoiceParserTokopedia) and in Node (require).
 * It has no dependencies and must not require invoice-parser.js; the parser
 * passes its generic helpers into parse().
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        /** @type {any} */ (root).InvoiceParserTokopedia = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ID = 'tokopedia';
    const BRAND_RE = /\btokopedia\b/i;
    // PDF text extraction may insert spaces between every letter.
    const SHIPPING_HEADING_RE = /\bS\s*H\s*I\s*P\s*P\s*I\s*N\s*G\s+R\s*E\s*C\s*E\s*I\s*P\s*T\b/i;
    const ORDER_RECEIPT_RE = /\bO\s*R\s*D\s*E\s*R\s+R\s*E\s*C\s*E\s*I\s*P\s*T\b/i;
    const NUMBER_RE = /(?<![\w.,/-])-?\d+(?:[.,]\d+)*(?![\w/])/g;
    const PRODUCT_HEADER_RE = /^(?:INFO\s+PRODUK|Nama\s+Produk)\b/i;
    // A product may legitimately be named "Total Quartz 9000", so a bare
    // "Total" prefix is not a boundary. Only labelled totals count, and the
    // amount check below keeps table headers such as "TOTAL HARGA" inside
    // the product section.
    const PRODUCT_END_RE = /^(?:SUBTOTAL(?:\s+HARGA\s+PRODUK)?\b|TOTAL\s+(?:BELANJA|TAGIHAN|BAYAR|PEMBAYARAN|PESANAN|HARGA(?:\s+PRODUK)?|JUMLAH|ONGKOS\s+KIRIM|PENGIRIMAN)\b|TOTAL\s*[:.]?\s*(?=(?:Rp|IDR|\d))|Voucher\b|Diskon\b|Potongan\b|Asuransi\b|Biaya\b)/i;
    const DATE_LABEL_RE = /\b(?:Tanggal\s+Pembelian|Tanggal\s+Pesanan|Tanggal\s+Invoice|Tanggal|Tgl\.?|Invoice\s+Date|Order\s+Date|Date)\b\s*[:.\-]?/i;

    /**
     * @typedef {Object} TokopediaLineItem
     * @property {string} description
     * @property {number|null} quantity
     * @property {number|null} unitPrice
     * @property {number|null} amount
     */

    /**
     * @typedef {Object} TokopediaVoucher
     * @property {string|null} code
     * @property {number|null} amount
     * @property {string|null} note
     * @property {boolean} applied
     */

    /**
     * @typedef {Object} TokopediaParseOptions
     * @property {'dmy'|'mdy'} [dateOrder]
     * @property {string} [currency]
     */

    /**
     * @typedef {Object} TokopediaHelpers
     * @property {(text: string, options?: TokopediaParseOptions) => any} parseGeneric
     * @property {(token: string) => number|null} parseAmount
     * @property {(text: string, dateOrder?: 'dmy'|'mdy') => {iso: string, index: number, length: number}|null} findDate
     * @property {(text: string) => string|null} detectCurrency
     * @property {(invoice: any) => string[]} checkInvoice
     */

    /**
     * @typedef {Object} TokopediaInvoice
     * @property {string|null} vendor
     * @property {string|null} billTo
     * @property {string|null} invoiceNumber
     * @property {string|null} invoiceDate
     * @property {string|null} dueDate
     * @property {string|null} currency
     * @property {TokopediaLineItem[]} lineItems
     * @property {number|null} subtotal
     * @property {number|null} discount
     * @property {number|null} taxRate
     * @property {number|null} tax
     * @property {number|null} shipping
     * @property {number|null} total
     * @property {number|null} amountDue
     * @property {string[]} warnings
     * @property {string} merchant
     * @property {number} [shippingDiscount]
     * @property {number} [insurance]
     * @property {number} [serviceFee]
     * @property {TokopediaVoucher[]} [vouchers]
     */

    /**
     * @param {string} line
     * @returns {string}
     */
    function normalizeLine(line) {
        return line
            .replace(/[|│┃¦]/g, ' ')
            .replace(/[ \t\u00a0]+/g, ' ')
            .trim();
    }

    /**
     * @param {string} text
     * @returns {string[]}
     */
    function toLines(text) {
        return String(text || '')
            .replace(/\r/g, '')
            .replace(/\f/g, '\n')
            .split('\n')
            .map(normalizeLine)
            .filter(Boolean);
    }

    /**
     * Removes Rp/IDR and other currency tokens so the remaining numbers can be
     * located by position.
     * @param {string} line
     * @returns {string}
     */
    function stripCurrencySymbols(line) {
        return String(line)
            .replace(/\bR[pP](?![A-Za-z])\.?/g, ' ')
            .replace(/\b(?:IDR|USD|SGD|AUD|EUR|GBP|MYR|THB|JPY|VND|PHP|INR)\b/g, ' ')
            .replace(/[$€£¥₫₱฿₹]/g, ' ')
            .replace(/,-/g, ' ');
    }

    /**
     * @param {string} line
     * @param {TokopediaHelpers} helpers
     * @returns {number|null}
     */
    function lastAmount(line, helpers) {
        const clean = stripCurrencySymbols(line).replace(/\d+(?:[.,]\d+)?\s*%/g, ' ');
        const matches = [...clean.matchAll(NUMBER_RE)];
        if (matches.length === 0) {
            return null;
        }
        return helpers.parseAmount(matches[matches.length - 1][0]);
    }

    /**
     * @param {string} line
     * @returns {boolean}
     */
    function isUrlLine(line) {
        return /^(?:https?:\/\/|www\.)/i.test(line) || /tokopedia\.com\/invoice/i.test(line);
    }

    /**
     * Lines that belong to the shipping-receipt header (reference number,
     * print timestamp, page number, date or URL). In flattened text these can
     * appear before the SHIPPING RECEIPT heading itself.
     * @param {string} line
     * @returns {boolean}
     */
    function isShippingHeaderLine(line) {
        return /^Reference\s*(?:No\.?|Number|#)\b/i.test(line)
            || isUrlLine(line)
            || /^\d+\s*\/\s*\d+\s*$/.test(line)
            || /^\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4},\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\b/i.test(line)
            || /^\d{1,2}\s+[A-Za-z]+\s+\d{4}\s*$/.test(line);
    }

    /**
     * Heuristic used only for flattened (no form-feed) text: finds where an
     * invoice page starts again after a shipping-receipt section.
     * @param {string[]} lines
     * @param {number} index
     * @returns {boolean}
     */
    function isInvoiceStart(lines, index) {
        const line = lines[index];
        const nearby = lines.slice(index, index + 8).join(' ');
        if (/^\d{12,}$/.test(line) && (/\b(?:Penjual|Pembeli)\b/i.test(nearby) || ORDER_RECEIPT_RE.test(nearby))) {
            return true;
        }
        if (/^Penjual\b/i.test(line) || ORDER_RECEIPT_RE.test(line)) {
            return true;
        }
        if (/^Invoice\b/i.test(line) && /\b(?:Penjual|Nomor|Tanggal)\b/i.test(nearby)) {
            return true;
        }
        return false;
    }

    /**
     * Drops shipping-receipt pages when PDF boundaries are available as form
     * feeds, or cuts shipping sections out of flattened text.
     * @param {string} text
     * @returns {{text: string, removedShipping: boolean}}
     */
    function removeShippingReceipts(text) {
        const source = String(text || '').replace(/\r/g, '');
        let removedShipping = false;

        if (source.includes('\f')) {
            const kept = [];
            for (const page of source.split('\f')) {
                if (SHIPPING_HEADING_RE.test(page)) {
                    removedShipping = true;
                    continue;
                }
                kept.push(page);
            }
            return { text: kept.join('\n'), removedShipping };
        }

        const lines = toLines(source);
        const remove = new Array(lines.length).fill(false);
        for (let i = 0; i < lines.length; i++) {
            if (!SHIPPING_HEADING_RE.test(lines[i])) {
                continue;
            }
            removedShipping = true;

            // Include a Reference/date/URL header printed just before the
            // heading in flattened text, but never preceding invoice totals.
            let start = i;
            while (start > 0 && isShippingHeaderLine(lines[start - 1])) {
                start--;
            }

            // A shipping receipt normally runs to the end of the text. When
            // shipping comes first, keep the invoice page that follows it.
            let end = lines.length;
            for (let j = i + 1; j < lines.length; j++) {
                if (isInvoiceStart(lines, j)) {
                    end = j;
                    break;
                }
            }
            for (let j = start; j < end; j++) {
                remove[j] = true;
            }
        }

        return {
            text: lines.filter((line, index) => !remove[index]).join('\n'),
            removedShipping,
        };
    }

    /**
     * @param {string[]} lines
     * @returns {boolean}
     */
    function hasInvoiceContent(lines) {
        for (const line of lines) {
            if (isUrlLine(line)) {
                continue;
            }
            if (ORDER_RECEIPT_RE.test(line)
                || /^\s*(?:invoice|faktur|nota)\s*$/i.test(line)
                || /\b(?:invoice|faktur|nota)\s*(?:no\.?|number|num\.?|#)\b/i.test(line)) {
                return true;
            }
        }
        const all = lines.join('\n');
        return /\bPenjual\b/i.test(all) && /\b(?:Nomor|Tanggal|Pembeli)\b/i.test(all);
    }

    /**
     * @param {string} value
     * @returns {string|null}
     */
    function cleanName(value) {
        const cleaned = value
            .replace(/^[\s:;,*"'“”‘’\uFFFD]+/, '')
            .replace(/[\s:;,*"'“”‘’\uFFFD]+$/, '')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned || null;
    }

    /**
     * @param {string[]} lines
     * @param {RegExp} labelRe
     * @returns {string|null}
     */
    function valueAfterLabel(lines, labelRe) {
        for (const line of lines) {
            const match = labelRe.exec(line);
            if (!match) {
                continue;
            }
            let value = line.slice(match.index + match[0].length).trim();
            value = value.split(/\s+(?=(?:Pembeli|Pembayaran|Alamat|Nomor|Tanggal|Metode)\b)/i)[0];
            const cleaned = cleanName(value);
            if (cleaned) {
                return cleaned;
            }
        }
        return null;
    }

    /**
     * Invoice and order IDs stay strings: an 18-digit order number cannot be
     * represented exactly as a JavaScript number.
     * @param {string[]} lines
     * @returns {string|null}
     */
    function findInvoiceNumber(lines) {
        for (const line of lines) {
            if (isUrlLine(line)) {
                const urlId = /[?&]id=([A-Za-z0-9_-]+)/i.exec(line);
                if (urlId) {
                    return urlId[1];
                }
                continue;
            }
            const labeled = /^(?:Nomor|No\.?|Order\s+ID|Invoice\s+ID|Invoice\s+No\.?|No\.?\s+Pesanan|Nomor\s+Pesanan)\b\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9/_.-]*\d[A-Z0-9/_.-]*)/i.exec(line);
            if (labeled) {
                return labeled[1].replace(/[.,;:]+$/, '');
            }
        }
        for (const line of lines) {
            if (/^\d{12,}$/.test(line)) {
                return line;
            }
        }
        return null;
    }

    /**
     * @param {string[]} lines
     * @param {'dmy'|'mdy'} dateOrder
     * @param {TokopediaHelpers} helpers
     * @returns {string|null}
     */
    function findInvoiceDate(lines, dateOrder, helpers) {
        for (let i = 0; i < lines.length; i++) {
            const match = DATE_LABEL_RE.exec(lines[i]);
            if (!match) {
                continue;
            }
            const rest = lines[i].slice(match.index + match[0].length);
            const onLine = helpers.findDate(rest, dateOrder);
            if (onLine) {
                return onLine.iso;
            }
            if (lines[i + 1]) {
                const next = helpers.findDate(lines[i + 1], dateOrder);
                if (next && next.index === 0) {
                    return next.iso;
                }
            }
        }
        return null;
    }

    /**
     * Parses a product table row. Product rows may have their description
     * inline (the PDF.js layout) or only in the numeric columns (the old
     * screenshot layout). The Berat (weight) column is discarded by skipping
     * numbers immediately followed by a weight/volume unit.
     * @param {string} line
     * @param {TokopediaHelpers} helpers
     * @returns {{description: string, quantity: number, unitPrice: number, amount: number}|null}
     */
    function parseProductRow(line, helpers) {
        const clean = stripCurrencySymbols(line);
        /** @type {{value: number, index: number}[]} */
        const tokens = [];
        for (const match of clean.matchAll(NUMBER_RE)) {
            const after = clean.slice(match.index + match[0].length);
            if (/^\s*(?:kg|gr|g|gram|ml|l|liter|cm|mm)\b/i.test(after)) {
                continue;
            }
            const value = helpers.parseAmount(match[0]);
            if (value !== null) {
                tokens.push({ value, index: match.index });
            }
        }
        if (tokens.length < 3) {
            return null;
        }
        // Read the three rightmost numbers as quantity, unit price and amount.
        // Any digits in the product name (for example "50 pcs" or "9000")
        // remain part of the description.
        const columns = tokens.slice(-3);
        return {
            description: cleanName(clean.slice(0, columns[0].index)) || '',
            quantity: columns[0].value,
            unitPrice: columns[1].value,
            amount: columns[2].value,
        };
    }

    /**
     * @param {string} line
     * @returns {boolean}
     */
    function isProductMetadata(line) {
        return ORDER_RECEIPT_RE.test(line)
            || /^(?:INFO\s+PRODUK|Nama\s+Produk|Deskripsi\b|JUMLAH\b|HARGA\b|TOTAL\s+HARGA\b|Berat\s*:|Jumlah\s*:|Alamat\b|Tanggal\b|Penjual\b|Pembeli\b|Metode\b|Pembayaran\b)/i.test(line);
    }

    /**
     * A total label is a table boundary only when it carries a monetary
     * amount. This keeps a separate "TOTAL HARGA" column header (and product
     * names such as "Total Quartz 9000") inside the product section.
     * @param {string} line
     * @param {TokopediaHelpers} helpers
     * @returns {boolean}
     */
    function isProductTableEnd(line, helpers) {
        return PRODUCT_END_RE.test(line) && lastAmount(line, helpers) !== null;
    }

    /**
     * @param {string[]} lines
     * @param {TokopediaHelpers} helpers
     * @returns {TokopediaLineItem[]}
     */
    function extractLineItems(lines, helpers) {
        const headerIndex = lines.findIndex((line) => PRODUCT_HEADER_RE.test(line));
        if (headerIndex === -1) {
            return [];
        }

        let end = lines.length;
        for (let i = headerIndex + 1; i < lines.length; i++) {
            if (isProductTableEnd(lines[i], helpers)) {
                end = i;
                break;
            }
        }

        /** @type {TokopediaLineItem[]} */
        const items = [];
        /** @type {string[]} */
        let pending = [];
        let lastRowHadInlineDescription = false;
        const flushPending = () => {
            if (items.length === 0 || pending.length === 0) {
                return;
            }
            const extra = cleanName(pending.join(' '));
            if (extra) {
                items[items.length - 1].description = cleanName(
                    `${items[items.length - 1].description} ${extra}`,
                ) || items[items.length - 1].description;
            }
            pending = [];
        };

        for (let i = headerIndex + 1; i < end; i++) {
            const line = lines[i];
            const row = parseProductRow(line, helpers);
            if (row) {
                // When rows carry their descriptions inline, lines between
                // two rows continue the previous product (the PDF.js layout
                // puts the brand there). Otherwise they describe the next row.
                if (lastRowHadInlineDescription && row.description) {
                    flushPending();
                }
                const description = cleanName([pending.join(' '), row.description].filter(Boolean).join(' ')) || '';
                if (description) {
                    items.push({
                        description,
                        quantity: row.quantity,
                        unitPrice: row.unitPrice,
                        amount: row.amount,
                    });
                }
                lastRowHadInlineDescription = row.description !== '';
                pending = [];
                continue;
            }
            if (isProductMetadata(line)) {
                // After an inline row, pending text is the wrapped remainder of
                // that product (the PDF.js layout prints the brand below it).
                // After a row without an inline description, pending text is
                // the next product's description, which the screenshot layout
                // prints above its weight and numeric columns; keep it pending.
                if (lastRowHadInlineDescription) {
                    flushPending();
                }
                continue;
            }
            pending.push(line);
        }
        // A description can wrap onto the line(s) after its numeric row, as
        // in the PDF.js text layer where the brand name appears below it.
        flushPending();
        return items;
    }

    /**
     * @param {string[]} lines
     * @param {TokopediaHelpers} helpers
     * @returns {{
     *   subtotal: number|null,
     *   discount: number|null,
     *   taxRate: number|null,
     *   tax: number|null,
     *   shipping: number|null,
     *   shippingDiscount: number|null,
     *   insurance: number|null,
     *   serviceFee: number|null,
     *   total: number|null
     * }}
     */
    function extractTotals(lines, helpers) {
        let subtotal = null;
        let discount = null;
        let taxRate = null;
        let tax = null;
        let shipping = null;
        let shippingDiscount = null;
        let insurance = null;
        let serviceFee = null;
        let totalTagihan = null;
        let totalBelanja = null;
        let genericTotal = null;

        for (const line of lines) {
            const value = lastAmount(line, helpers);

            if (subtotal === null && /^SUBTOTAL(?:\s+HARGA\s+PRODUK)?\b/i.test(line)) {
                subtotal = value;
            }

            if (/^(?:Voucher\s+ongkir(?:\s+platform)?|Diskon\s+(?:ongkos\s+kirim|ongkir|pengiriman))\b/i.test(line)) {
                if (value !== null) {
                    shippingDiscount = (shippingDiscount || 0) + Math.abs(value);
                }
                continue;
            }

            if (/^(?:Voucher\s+dari\s+platform|Diskon(?:\s+Produk)?|Potongan(?:\s+Harga)?)\b/i.test(line)) {
                if (value !== null) {
                    discount = (discount || 0) + Math.abs(value);
                }
                continue;
            }

            if (/^(?:Total\s+)?(?:Ongkos\s+Kirim|Ongkos\s+Pengiriman|Biaya\s+Kirim|Biaya\s+Pengiriman|Shipping)\b/i.test(line)) {
                if (value !== null) {
                    shipping = value;
                }
                continue;
            }

            if (/^Asuransi(?:\s+Pengiriman)?\b/i.test(line)) {
                if (value !== null) {
                    insurance = value;
                }
                continue;
            }

            if (/^Biaya\s+Jasa\s+Aplikasi\b/i.test(line)) {
                if (value !== null) {
                    serviceFee = value;
                }
                continue;
            }

            if (/^(?:PPN|Pajak|Tax|VAT)\b/i.test(line)) {
                if (value !== null) {
                    tax = value;
                    const rate = /(\d+(?:[.,]\d+)?)\s*%/.exec(line);
                    if (rate) {
                        taxRate = helpers.parseAmount(rate[1]);
                    }
                }
                continue;
            }

            if (/^TOTAL\s+TAGIHAN\b/i.test(line)) {
                totalTagihan = value;
                continue;
            }
            if (/^TOTAL\s+BELANJA\b/i.test(line)) {
                totalBelanja = value;
                continue;
            }
            if (/^Total\b/i.test(line) && !/^Total\s+(?:Harga|Ongkos|Belanja|Tagihan|Pembayaran|Pengiriman)\b/i.test(line)) {
                genericTotal = value;
            }
        }

        // Old screenshots list the courier and its price as a block after the
        // product subtotal, without a "shipping" label.
        if (shipping === null) {
            const subtotalIndex = lines.findIndex((line) => /^SUBTOTAL(?:\s+HARGA\s+PRODUK)?\b/i.test(line));
            const start = subtotalIndex === -1 ? 0 : subtotalIndex + 1;
            for (let i = start; i < lines.length; i++) {
                if (!/^(?:JNE|J&T|SiCepat|AnterAja|Ninja|Pos\s+Indonesia|J&T\s+Express)\b/i.test(lines[i])) {
                    continue;
                }
                let value = lastAmount(lines[i], helpers);
                if (value === null && lines[i + 1]) {
                    value = lastAmount(lines[i + 1], helpers);
                }
                if (value !== null) {
                    shipping = value;
                    break;
                }
            }
        }

        const total = [totalTagihan, totalBelanja, genericTotal].find((value) => value !== null) ?? null;
        return { subtotal, discount, taxRate, tax, shipping, shippingDiscount, insurance, serviceFee, total };
    }

    /**
     * A voucher marked "Untuk 2 invoice" cannot be allocated safely. Keep it
     * as metadata instead of silently subtracting it from this invoice.
     * @param {string[]} lines
     * @param {TokopediaHelpers} helpers
     * @returns {{vouchers: TokopediaVoucher[], warnings: string[]}}
     */
    function extractVouchers(lines, helpers) {
        /** @type {TokopediaVoucher[]} */
        const vouchers = [];
        /** @type {string[]} */
        const warnings = [];
        for (let i = 0; i < lines.length; i++) {
            if (!/^Voucher\s*&\s*TopPoints\b/i.test(lines[i])) {
                continue;
            }
            const noteMatch = /\(([^)]*\binvoice\b[^)]*)\)/i.exec(lines[i]);
            const note = noteMatch ? noteMatch[1].trim() : null;
            let code = null;
            let amount = null;
            for (let j = i + 1; j < lines.length && j <= i + 4; j++) {
                if (/^Voucher\s*&/i.test(lines[j])) {
                    break;
                }
                if (code === null) {
                    const codeMatch = /^([A-Z][A-Z0-9._-]{2,})(?=\s|$)/.exec(lines[j]);
                    if (codeMatch) {
                        code = codeMatch[1];
                    }
                }
                const value = lastAmount(lines[j], helpers);
                if (amount === null && value !== null) {
                    amount = Math.abs(value);
                }
                if (code !== null && amount !== null) {
                    break;
                }
            }
            vouchers.push({ code, amount, note, applied: false });
            const label = [code, amount !== null ? `Rp${amount}` : null].filter(Boolean).join(' ');
            warnings.push(
                `Voucher${label ? ` ${label}` : ''} is marked "${note || 'for multiple invoices'}"; `
                + 'it was not applied to this invoice because the amount is ambiguous.',
            );
        }
        return { vouchers, warnings };
    }

    /**
     * @param {boolean} removedShipping
     * @param {TokopediaParseOptions} options
     * @returns {TokopediaInvoice}
     */
    function emptyInvoice(removedShipping, options) {
        return {
            vendor: null,
            billTo: null,
            invoiceNumber: null,
            invoiceDate: null,
            dueDate: null,
            currency: options.currency || null,
            lineItems: [],
            subtotal: null,
            discount: null,
            taxRate: null,
            tax: null,
            shipping: null,
            total: null,
            amountDue: null,
            warnings: [
                removedShipping
                    ? 'Shipping receipt ignored: no invoice found in the supplied Tokopedia text.'
                    : 'No invoice found in the supplied Tokopedia text.',
            ],
            merchant: ID,
        };
    }

    /**
     * @param {string} text
     * @returns {boolean}
     */
    function matches(text) {
        const source = String(text || '');
        if (!BRAND_RE.test(source)) {
            return false;
        }
        // Strong document-level signals from both known Tokopedia layouts.
        if (SHIPPING_HEADING_RE.test(source)
            || ORDER_RECEIPT_RE.test(source)
            || /tokopedia\.com\/invoice\b/i.test(source)) {
            return true;
        }
        // Old order-invoice layout: Penjual/Nomor plus its invoice furniture.
        if (/\bPenjual\b/i.test(source)
            && /\bNomor\b/i.test(source)
            && /\b(?:Tanggal|Pembayaran|Nama\s+Produk|Cetak)\b/i.test(source)) {
            return true;
        }
        // Modern layout when OCR drops the ORDER RECEIPT heading: keep the
        // Tokopedia-specific seller/buyer and total structure, so a generic
        // invoice that merely mentions Tokopedia does not dispatch here.
        return /\bINFO\s+PRODUK\b/i.test(source)
            && /\bTOTAL\s+(?:BELANJA|TAGIHAN)\b/i.test(source)
            && /\b(?:Penjual|Pembeli|Tanggal\s+Pembelian)\b/i.test(source);
    }

    /**
     * @param {string} text
     * @param {TokopediaParseOptions} options
     * @param {TokopediaHelpers} helpers
     * @returns {TokopediaInvoice}
     */
    function parse(text, options = {}, helpers) {
        if (!helpers || typeof helpers.parseGeneric !== 'function' || typeof helpers.checkInvoice !== 'function') {
            throw new TypeError('Tokopedia parser requires invoice parser helpers');
        }

        const stripped = removeShippingReceipts(text);
        const lines = toLines(stripped.text);
        if (!hasInvoiceContent(lines)) {
            return emptyInvoice(stripped.removedShipping, options);
        }

        const dateOrder = options.dateOrder === 'mdy' ? 'mdy' : 'dmy';
        const totals = extractTotals(lines, helpers);
        const voucherData = extractVouchers(lines, helpers);

        /** @type {TokopediaInvoice} */
        const invoice = {
            vendor: valueAfterLabel(lines, /\bPenjual\s*:?/i),
            billTo: valueAfterLabel(lines, /\bPembeli\s*:?/i),
            invoiceNumber: findInvoiceNumber(lines),
            invoiceDate: findInvoiceDate(lines, dateOrder, helpers),
            dueDate: null,
            currency: options.currency || helpers.detectCurrency(stripped.text),
            lineItems: extractLineItems(lines, helpers),
            subtotal: totals.subtotal,
            discount: totals.discount,
            taxRate: totals.taxRate,
            tax: totals.tax,
            shipping: totals.shipping,
            total: totals.total,
            amountDue: null,
            warnings: [],
            merchant: ID,
        };
        if (totals.shippingDiscount !== null) {
            invoice.shippingDiscount = totals.shippingDiscount;
        }
        if (totals.insurance !== null) {
            invoice.insurance = totals.insurance;
        }
        if (totals.serviceFee !== null) {
            invoice.serviceFee = totals.serviceFee;
        }
        if (voucherData.vouchers.length > 0) {
            invoice.vouchers = voucherData.vouchers;
        }

        invoice.warnings = helpers.checkInvoice(invoice).concat(voucherData.warnings);
        return invoice;
    }

    return { id: ID, matches, parse };
});
