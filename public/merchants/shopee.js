/**
 * Shopee shipping-label adapter.
 *
 * Shopee shipping labels are not invoices: they carry an order number, a
 * tracking number, sender/recipient names and the ordered products, but no
 * prices or invoice dates. This adapter maps those labels to the common
 * Invoice shape with `documentType: 'shipping_label'`, leaves every monetary
 * field null, and deliberately does not run the generic invoice arithmetic
 * checks.
 *
 * Works in the browser (window.InvoiceParserShopee) and in Node (require).
 * It has no dependencies and must not require invoice-parser.js; the parser
 * passes its generic helpers into parse().
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        /** @type {any} */ (root).InvoiceParserShopee = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const ID = 'shopee';

    const SHOPEE_BRAND_RE = /\bshopee\b/i;
    const SPX_BRAND_RE = /\bSPX(?:\s*Express)?\b/i;
    const SPX_TRACKING_RE = /\bSPXID[A-Z0-9]{6,}\b/i;
    const ORDER_LABEL_RE = /\b(?:No\.?\s*Pesanan|Nomor\s+Pesanan|ID\s+Pesanan|Kode\s+Pesanan)\b/i;
    const ORDER_VALUE_RE = /\b(?:No\.?\s*Pesanan|Nomor\s+Pesanan|ID\s+Pesanan|Kode\s+Pesanan)\s*[:#]?\s*([A-Z0-9][A-Z0-9._-]*)/i;
    const TRACKING_LABEL_RE = /\b(?:No\.?\s*Resi|Nomor\s+Resi|Tracking(?:\s+(?:No\.?|Number|ID))?)\s*[:#]?\s*([A-Z0-9][A-Z0-9._-]*)/i;
    const TRACKING_TOKEN_RE = /\b(?:SPXID[A-Z0-9]{6,}|IDS\d{8,})\b/i;
    const PRODUCT_HEADER_RE = /\bNama\s*Produk\b/i;
    const PRODUCT_QUANTITY_HEADING_RE = /\b(?:Qty|Jumlah|Jml)\b/i;
    // "Qty" occasionally comes out as "ay" in a photographed label. This is
    // only consulted for a header that also has a clear No./product/SKU
    // order and independent shipping-label evidence, never on its own.
    const DAMAGED_QUANTITY_HEADING_RE = /\bay\b/i;
    const INDEX_COLUMN_RE = /(?:^|\|)\s*(?:#|No\.?)(?=\s|$)/i;
    const PRODUCT_END_RE = /^\s*(?:No\.?\s*Pesanan\b|Nomor\s+Pesanan\b|Pesan\s*:|Total\s*(?::|\bQty\b|\bJumlah\b)|WAJIB\b|Mohon\b|Catatan\b|Batas\s+(?:Kirim|Pengiriman)\b|No\.?\s*Resi\b|Penerima\b|Pengirim\b|Nama\s+Toko\b|COD\b|CASH?LESS\b|Berat\s*:|Metode\s+Pengiriman\b|Waktu\s+Pemesanan\b|Halaman\b|Powered\s+by\b|(?:SPXID|IDS)[A-Z0-9]+\s*|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\s+\d{1,2}:\d{2})/i;
    const SEPARATOR_RE = /^[\s\-_=.]+$/;
    const UNIT_PATTERN = 'pcs?|pieces?|botol|bottles?|box|boxes|pack|packs?|unit|units?|buah|lusin';
    const HEADERLESS_ITEM_RE = new RegExp(`^(.*?)\\s+(\\d{1,4})\\s*(${UNIT_PATTERN})\\.?\\s*$`, 'i');
    const HEADERLESS_PREFIX_RE = new RegExp(`^\\s*(\\d{1,4})\\s*(${UNIT_PATTERN})\\.?\\s+(\\S.*)$`, 'i');
    const DATE_ORDER_RE = /\b(?:Waktu\s+Pemesanan|Tanggal\s+Pemesanan|Order\s+Date)\s*[:.-]?/i;
    const SHIPPING_DEADLINE_RE = /\bBatas\s+(?:Kirim|Pengiriman)\s*[:.-]?/i;
    const SENDER_RE = /\bPengirim\b\s*[:#]?\s*/i;
    const STORE_RE = /\bNama\s+Toko\b\s*[:#]?\s*/i;
    const RECIPIENT_RE = /\bPenerima\b\s*[:#]?\s*/i;

    // Labels are also used as value terminators: "Pengirim: Toko Penerima:
    // Siti" must not keep "Penerima: Siti" in the vendor name. Markers are
    // matched with word boundaries, and a colon is optional because OCR
    // often drops punctuation.
    const FIELD_LABEL_PATTERN = '(?:Penerima|Pembeli|Pengirim|Penjual|Nama\\s+Toko|Alamat|Berat|'
        + 'No\\.?\\s*(?:Pesanan|Resi)|Nomor\\s+(?:Pesanan|Resi)|'
        + 'Tracking(?:\\s+(?:No\\.?|Number|ID))?|Batas\\s+(?:Kirim|Pengiriman)|'
        + 'Waktu\\s+Pemesanan|Tanggal\\s+Pemesanan|Order\\s+Date|COD|Cashless|'
        + 'Metode\\s+Pengiriman|Harga|Total|SKU|Qty|Jumlah|Jml)';
    const FIELD_BOUNDARY_RE = new RegExp(`\\s+(?=${FIELD_LABEL_PATTERN}\\b\\s*[:#]?)`, 'i');
    const LEADING_FIELD_RE = new RegExp(`^\\s*${FIELD_LABEL_PATTERN}\\b\\s*[:#]?`, 'i');
    const FIELD_WORD_RE = /^(?:Batas|Penerima|Pembeli|Pengirim|Penjual|Nama|Alamat|Berat|Metode|Waktu|Tanggal|Order|Total|Harga|SKU|Qty|Jumlah|Jml|COD|Cashless|Pesanan|Resi)$/i;

    // A monetary product table is an invoice, even when it mentions Shopee or
    // uses an SPX waybill. Shipping labels never price their product rows.
    const PRODUCT_MONEY_RE = /\b(?:Harga(?:\s+Satuan)?|Unit\s+Price|Price|Amount|Total(?:\s+Harga)?|Subtotal|Pajak|PPN|Diskon)\b/i;
    const INVOICE_MARKER_RE = /(?:^|\n)\s*(?:TAX\s+)?(?:INVOICE|FAKTUR|NOTA|RECEIPT)\b|\b(?:Invoice|Faktur)\s*(?:No|Number|Num|#)|\b(?:No|Nomor)\s*\.?\s*(?:Invoice|Faktur)\b|\b(?:Invoice\s+Date|Tanggal\s+(?:Invoice|Faktur)|Date\s+of\s+Issue)\b/i;
    const MONEY_TOTAL_RE = /^\s*(?:Grand\s+Total|Subtotal|Total(?:\s+(?:Harga|Tagihan|Amount|Amount\s+Due|Pembayaran))?|Jumlah\s+(?:Harga|Tagihan|Total)|Amount\s+Due)\s*[:.]?\s*(?:Rp\.?|IDR|USD|SGD|\$)?\s*\d[\d.,]*\s*$/i;

    /**
     * @typedef {Object} ShopeeLineItem
     * @property {string} description
     * @property {number|null} quantity
     * @property {null} unitPrice
     * @property {null} amount
     * @property {string} [sku]
     * @property {string} [variant]
     * @property {string} [unit]
     */

    /**
     * @typedef {Object} ShopeeAssignedRow
     * @property {string|null} index
     * @property {string} description
     * @property {string} sku
     * @property {string} variant
     * @property {number|null} quantity
     * @property {string|null} unit
     * @property {boolean} flattened
     */

    /**
     * @typedef {Object} ShopeeWeight
     * @property {number} value
     * @property {'g'|'kg'} unit
     */

    /**
     * @typedef {Object} ShopeeParseOptions
     * @property {'dmy'|'mdy'} [dateOrder]
     * @property {string} [currency]
     */

    /**
     * @typedef {Object} ShopeeHelpers
     * @property {(text: string, options?: ShopeeParseOptions) => any} parseGeneric
     * @property {(token: string) => number|null} parseAmount
     * @property {(text: string, dateOrder?: 'dmy'|'mdy') => {iso: string, index: number, length: number}|null} findDate
     * @property {(text: string) => string|null} detectCurrency
     * @property {(invoice: any) => string[]} checkInvoice
     */

    /**
     * @typedef {Object} ShopeeInvoice
     * @property {string|null} vendor
     * @property {string|null} billTo
     * @property {string|null} invoiceNumber
     * @property {string|null} invoiceDate
     * @property {string|null} dueDate
     * @property {string|null} currency
     * @property {ShopeeLineItem[]} lineItems
     * @property {number|null} subtotal
     * @property {number|null} discount
     * @property {number|null} taxRate
     * @property {number|null} tax
     * @property {number|null} shipping
     * @property {number|null} total
     * @property {number|null} amountDue
     * @property {string[]} warnings
     * @property {string} merchant
     * @property {'shipping_label'} documentType
     * @property {string|null} orderId
     * @property {string|null} trackingNumber
     * @property {string|null} orderDate
     * @property {string|null} shippingDeadline
     * @property {ShopeeWeight|null} weight
     * @property {string|null} courier
     * @property {string|null} payment
     */

    /**
     * @param {string} line
     * @returns {string}
     */
    function normalizeLine(line) {
        return line
            .replace(/[│┃¦]/g, ' ')
            .replace(/\t/g, '    ')
            .replace(/\u00a0/g, ' ')
            .replace(/\s+$/, '');
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
            .filter((line) => line.trim() !== '');
    }

    /**
     * @param {string} value
     * @returns {string}
     */
    function cleanText(value) {
        return String(value || '')
            .replace(/^[\s:"'“”‘’\uFFFD]+/, '')
            .replace(/[\s:"'“”‘’\uFFFD]+$/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * @param {string} value
     * @returns {string|null}
     */
    function nonEmpty(value) {
        const cleaned = cleanText(value);
        return cleaned || null;
    }

    /**
     * @param {string} left
     * @param {string} right
     * @returns {string}
     */
    function joinText(left, right) {
        return cleanText([left, right].filter(Boolean).join(' '));
    }

    /**
     * Wrapped SKU fragments are printed one above the other in the same
     * column. Concatenating them keeps leading zeros and avoids adding a
     * space that was not part of the printed identifier.
     * @param {string} left
     * @param {string} right
     * @returns {string}
     */
    function joinSku(left, right) {
        return `${left || ''}${String(right || '').trim()}`;
    }

    /**
     * @param {string} line
     * @returns {boolean}
     */
    function isProductHeader(line) {
        return PRODUCT_HEADER_RE.test(line)
            && /\b(?:Qty|Jumlah|Jml|SKU|Varian|Variasi)\b/i.test(line);
    }

    /**
     * Strong label evidence is required before a damaged "Qty" heading may be
     * inferred. This keeps generic invoices that happen to contain the word
     * "ay" from being parsed as shipping labels.
     * @param {string} source
     * @returns {boolean}
     */
    function hasStrongShippingLabelEvidence(source) {
        const text = String(source || '');
        if (!text.trim()) {
            return false;
        }
        if (!SHOPEE_BRAND_RE.test(text)
            && !SPX_BRAND_RE.test(text)
            && !SPX_TRACKING_RE.test(text)) {
            return false;
        }
        const lines = toLines(text);
        return lines.some((line) => (
            SENDER_RE.test(line)
            || RECIPIENT_RE.test(line)
            || STORE_RE.test(line)
            || ORDER_LABEL_RE.test(line)
            || /\b(?:No\.?\s*Resi|Nomor\s+Resi|Tracking(?:\s+(?:No\.?|Number|ID))?)\b/i.test(line)
            || SHIPPING_DEADLINE_RE.test(line)
            || DATE_ORDER_RE.test(line)
            || /\bBerat\b/i.test(line)
            || /\bMetode\s+Pengiriman\b/i.test(line)
            || /\b(?:COD|Cashless|CASH?LESS)\b/i.test(line)
        )) || TRACKING_TOKEN_RE.test(text);
    }

    /**
     * A photographed label can lose the "Qty" heading while keeping the table
     * structure. Accept that only when the line has an explicit row-number
     * column, a product-name column, a later SKU/variant column and a damaged
     * quantity token after all of them.
     * @param {string} line
     * @param {string} source
     * @returns {boolean}
     */
    function isDamagedProductHeader(line, source) {
        if (!DAMAGED_QUANTITY_HEADING_RE.test(line)
            || !hasStrongShippingLabelEvidence(source)) {
            return false;
        }
        const descriptionIndex = line.search(PRODUCT_HEADER_RE);
        const indexMatch = INDEX_COLUMN_RE.exec(line);
        const skuIndex = line.search(/\bSKU\b/i);
        const variantIndex = line.search(/\b(?:Varian|Variasi)\b/i);
        const lastProductColumn = Math.max(skuIndex, variantIndex);
        const quantityMatch = DAMAGED_QUANTITY_HEADING_RE.exec(line);
        return Boolean(indexMatch)
            && descriptionIndex !== -1
            && lastProductColumn > descriptionIndex
            && Boolean(quantityMatch)
            && quantityMatch.index > lastProductColumn;
    }

    /**
     * @param {string[]} lines
     * @param {string} [source]
     * @returns {{index: number, start: number, header: string, damagedQuantity: boolean}|null}
     */
    function findProductHeader(lines, source = '') {
        for (let i = 0; i < lines.length; i++) {
            if (!PRODUCT_HEADER_RE.test(lines[i])) {
                continue;
            }
            if (PRODUCT_QUANTITY_HEADING_RE.test(lines[i])) {
                return {
                    index: i,
                    start: i + 1,
                    header: lines[i],
                    damagedQuantity: false,
                };
            }
            if (lines[i + 1] && PRODUCT_QUANTITY_HEADING_RE.test(lines[i + 1])) {
                return {
                    index: i,
                    start: i + 2,
                    header: `${lines[i]}    ${lines[i + 1]}`,
                    damagedQuantity: false,
                };
            }
            if (isDamagedProductHeader(lines[i], source)) {
                return {
                    index: i,
                    start: i + 1,
                    header: lines[i],
                    damagedQuantity: true,
                };
            }
        }
        return null;
    }

    /**
     * @param {string} header
     * @param {boolean} damagedQuantity
     * @returns {{kind: string, index: number}[]}
     */
    function findColumns(header, damagedQuantity = false) {
        /** @type {{kind: string, index: number}[]} */
        const columns = [];
        /** @type {[string, RegExp][]} */
        const definitions = [
            ['index', INDEX_COLUMN_RE],
            ['description', PRODUCT_HEADER_RE],
            ['sku', /\bSKU\b/i],
            ['variant', /\b(?:Varian|Variasi)\b/i],
            ['quantity', PRODUCT_QUANTITY_HEADING_RE],
        ];
        for (const [kind, re] of definitions) {
            const match = re.exec(header);
            if (match) {
                columns.push({ kind, index: match.index });
            }
        }
        if (damagedQuantity && !columns.some((column) => column.kind === 'quantity')) {
            const match = DAMAGED_QUANTITY_HEADING_RE.exec(header);
            if (match) {
                columns.push({ kind: 'quantity', index: match.index });
            }
        }
        columns.sort((a, b) => a.index - b.index);
        return columns;
    }

    /**
     * Splits a line on runs of two or more spaces. Single spaces stay inside
     * a chunk, which keeps multi-word variants such as "RANDOM 2 ML"
     * together while still exposing the printed column gaps.
     * @param {string} line
     * @returns {{text: string, start: number}[]}
     */
    function splitGaps(line) {
        /** @type {{text: string, start: number}[]} */
        const chunks = [];
        const re = /\S+(?: \S+)*/g;
        let match;
        while ((match = re.exec(line))) {
            chunks.push({ text: match[0], start: match.index });
        }
        return chunks;
    }

    /**
     * @param {number} start
     * @param {{kind: string, index: number}[]} columns
     * @returns {string}
     */
    function nearestColumn(start, columns) {
        let best = columns[0];
        let bestDistance = Math.abs(start - best.index);
        for (const column of columns.slice(1)) {
            const distance = Math.abs(start - column.index);
            if (distance < bestDistance) {
                best = column;
                bestDistance = distance;
            }
        }
        return best.kind;
    }

    /**
     * @param {string} unit
     * @returns {string}
     */
    function normalizeUnit(unit) {
        const value = String(unit || '').toLowerCase();
        if (/^(?:pcs?|pieces?)$/.test(value)) {
            return 'Pcs';
        }
        if (/^(?:botol|bottles?)$/.test(value)) {
            return 'Botol';
        }
        if (/^(?:box|boxes)$/.test(value)) {
            return 'Box';
        }
        if (/^(?:pack|packs?)$/.test(value)) {
            return 'Pack';
        }
        if (/^(?:unit|units?)$/.test(value)) {
            return 'Unit';
        }
        if (value === 'buah') {
            return 'Buah';
        }
        if (value === 'lusin') {
            return 'Lusin';
        }
        return String(unit || '');
    }

    /**
     * @param {string} text
     * @returns {{quantity: number, unit: string|null}|null}
     */
    function parseQuantity(text) {
        const match = new RegExp(`^(\\d{1,4})(?:\\s*(?:${UNIT_PATTERN}))?\\.?$`, 'i').exec(String(text || '').trim());
        if (!match) {
            return null;
        }
        const quantity = Number(match[1]);
        if (!Number.isInteger(quantity) || quantity <= 0) {
            return null;
        }
        const unitMatch = new RegExp(`\\d{1,4}\\s*(${UNIT_PATTERN})`, 'i').exec(String(text || ''));
        return {
            quantity,
            unit: unitMatch ? normalizeUnit(unitMatch[1]) : null,
        };
    }

    /**
     * @returns {ShopeeAssignedRow}
     */
    function emptyAssigned() {
        return {
            index: null,
            description: '',
            sku: '',
            variant: '',
            quantity: null,
            unit: null,
            flattened: false,
        };
    }

    /**
     * @param {string} token
     * @returns {boolean}
     */
    function isIntegerToken(token) {
        return /^\d{1,4}[.)]?$/.test(String(token || ''));
    }

    /**
     * @param {string} token
     * @returns {boolean}
     */
    function isUnitToken(token) {
        return new RegExp(`^(?:${UNIT_PATTERN})\\.?$`, 'i').test(String(token || ''));
    }

    /**
     * A compact token with several digits is a plausible printed SKU. Size
     * tokens such as "100ml" are descriptions, not identifiers.
     * @param {string} token
     * @returns {boolean}
     */
    function looksLikeSkuToken(token) {
        const value = String(token || '');
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || !/\d/.test(value)) {
            return false;
        }
        if (/^\d+(?:[.,]\d+)?(?:ml|l|g|kg|gr|cm|mm)$/i.test(value)) {
            return false;
        }
        return (value.match(/\d/g) || []).length >= 3;
    }

    /**
     * Splitting a flattened OCR row on spaces cannot recover the printed
     * columns. Use the known header order to pull a trailing quantity and a
     * likely SKU, leaving genuinely ambiguous fields out instead of guessing.
     * @param {string} line
     * @param {{kind: string, index: number}[]} columns
     * @returns {ShopeeAssignedRow}
     */
    function assignFlattenedLine(line, columns) {
        const assigned = emptyAssigned();
        assigned.flattened = true;
        const tokens = line.trim().split(/\s+/);
        const hasIndexColumn = columns.some((column) => column.kind === 'index');
        const skuColumn = columns.find((column) => column.kind === 'sku');
        const variantColumn = columns.find((column) => column.kind === 'variant');
        const quantityColumn = columns.find((column) => column.kind === 'quantity');

        let cursor = 0;
        if (hasIndexColumn && tokens.length > 1 && /^\d{1,3}[.)]?$/.test(tokens[0])) {
            assigned.index = tokens[0].replace(/[.)]$/, '');
            cursor = 1;
        }

        // A lone numeric continuation is the wrapped SKU column, not a row
        // index. Attaching it preserves identifiers such as 8997230600863.
        if (tokens.length === 1 && skuColumn && /^\d{1,4}$/.test(tokens[0])) {
            assigned.sku = tokens[0];
            return assigned;
        }

        let quantityIndex = -1;
        if (quantityColumn && tokens.length > cursor + 1) {
            const last = tokens[tokens.length - 1];
            if (isIntegerToken(last)) {
                quantityIndex = tokens.length - 1;
            } else if (isUnitToken(last)
                && tokens.length > cursor + 2
                && isIntegerToken(tokens[tokens.length - 2])) {
                quantityIndex = tokens.length - 2;
            }
        }

        if (quantityIndex !== -1) {
            const prior = tokens.slice(cursor, quantityIndex);
            const trailing = tokens.slice(quantityIndex);
            const quantity = parseQuantity(trailing.join(' '));
            const skuLikeTrailing = looksLikeSkuToken(tokens[quantityIndex]);
            let lastSkuPosition = -1;
            for (let i = prior.length - 1; i >= 0; i--) {
                if (looksLikeSkuToken(prior[i])) {
                    lastSkuPosition = i;
                    break;
                }
            }
            const skuLikePrior = lastSkuPosition !== -1;
            // "1 Product 0123" is a numeric SKU with a missing quantity, not
            // a product with quantity 123. A multi-digit number directly
            // after a numeric SKU is likewise ambiguous with a numeric
            // variant when Qty is missing; leave the quantity uncertain.
            const ambiguousNumericVariant = Boolean(
                variantColumn && skuColumn && variantColumn.index > skuColumn.index,
            )
                && lastSkuPosition !== -1
                && tokens[quantityIndex].replace(/\D/g, '').length >= 2
                && !prior.slice(lastSkuPosition + 1).some((token) => /[A-Za-z]/.test(token));
            if (quantity && !(skuLikeTrailing && !skuLikePrior) && !ambiguousNumericVariant) {
                assigned.quantity = quantity.quantity;
                assigned.unit = quantity.unit;
            } else {
                quantityIndex = -1;
            }
        }

        const content = tokens.slice(cursor, quantityIndex === -1 ? tokens.length : quantityIndex);
        if (content.length === 0) {
            return assigned;
        }

        let skuIndex = -1;
        if (skuColumn) {
            for (let i = content.length - 1; i >= 0; i--) {
                if (looksLikeSkuToken(content[i])) {
                    skuIndex = i;
                    break;
                }
            }
        }

        if (skuIndex === -1) {
            assigned.description = cleanText(content.join(' '));
            return assigned;
        }

        assigned.sku = content[skuIndex];
        if (variantColumn && skuColumn && variantColumn.index < skuColumn.index) {
            // Description -> Variant -> SKU. Only the token immediately before
            // the SKU can be separated confidently.
            assigned.variant = skuIndex > 0 ? content[skuIndex - 1] : '';
            assigned.description = cleanText(content.slice(0, Math.max(0, skuIndex - 1)).join(' '));
        } else if (variantColumn && skuColumn && variantColumn.index > skuColumn.index) {
            // Description -> SKU -> Variant.
            assigned.description = cleanText(content.slice(0, skuIndex).join(' '));
            assigned.variant = cleanText(content.slice(skuIndex + 1).join(' '));
        } else {
            assigned.description = cleanText([
                content.slice(0, skuIndex).join(' '),
                content.slice(skuIndex + 1).join(' '),
            ].filter(Boolean).join(' '));
        }
        return assigned;
    }

    /**
     * @param {string} line
     * @param {{kind: string, index: number}[]} columns
     * @param {boolean} flattened
     * @returns {ShopeeAssignedRow}
     */
    function assignChunks(line, columns, flattened) {
        if (flattened) {
            return assignFlattenedLine(line, columns);
        }
        const chunks = splitGaps(line);

        const assigned = emptyAssigned();
        const hasIndexColumn = columns.some((column) => column.kind === 'index');
        const descriptionColumn = columns.find((column) => column.kind === 'description');
        const indexColumn = columns.find((column) => column.kind === 'index');

        /** @param {{text: string, start: number}} chunk @param {number} position @returns {string} */
        function chunkKind(chunk, position) {
            let kind = nearestColumn(chunk.start, columns);
            // A short leading number is the row index, but a wrapped SKU such
            // as "63" at the SKU column must not be mistaken for one.
            if (hasIndexColumn
                && indexColumn
                && descriptionColumn
                && position === 0
                && chunk.start < descriptionColumn.index
                && /^\d{1,3}[.)]?$/.test(chunk.text)) {
                kind = 'index';
            }
            return kind;
        }

        chunks.forEach((chunk, position) => {
            // Preserved OCR spacing can keep the row number glued to the
            // product name ("1. Product name ..."). Split just the leading
            // row index; the rest belongs to the description column. Only a
            // chunk that starts in the index column can carry a glued row
            // index: a wrapped description such as "16 sachet per box" starts
            // in the description column and must not become a second item.
            if (hasIndexColumn
                && indexColumn
                && descriptionColumn
                && position === 0
                && chunk.start < descriptionColumn.index) {
                const leadingIndex = /^(\d{1,3})[.)]?\s+(?=\S)/.exec(chunk.text);
                if (leadingIndex) {
                    assigned.index = leadingIndex[1];
                    const rest = chunk.text.slice(leadingIndex[0].length);
                    if (rest) {
                        assigned.description = joinText(assigned.description, rest);
                    }
                    return;
                }
            }
            const kind = chunkKind(chunk, position);
            if (kind === 'index') {
                const match = /^(\d{1,3})/.exec(chunk.text);
                if (match) {
                    assigned.index = match[1];
                }
                return;
            }
            if (kind === 'description') {
                assigned.description = joinText(assigned.description, chunk.text);
                return;
            }
            if (kind === 'sku') {
                assigned.sku = joinSku(assigned.sku, chunk.text);
                return;
            }
            if (kind === 'variant') {
                assigned.variant = joinText(assigned.variant, chunk.text);
                return;
            }
            const quantity = parseQuantity(chunk.text);
            if (quantity) {
                assigned.quantity = quantity.quantity;
                assigned.unit = quantity.unit;
            }
        });

        // If OCR loses the gap before the quantity column, the rightmost
        // integer can still be the quantity. Never reuse a token that the
        // existing column layout already assigned to SKU or Variant: numeric
        // SKUs and numeric variants must stay non-quantities.
        if (assigned.quantity === null && assigned.index !== null && chunks.length > 0) {
            const last = chunks[chunks.length - 1];
            if (chunkKind(last, chunks.length - 1) === 'quantity') {
                const quantity = parseQuantity(last.text);
                if (quantity) {
                    assigned.quantity = quantity.quantity;
                    assigned.unit = quantity.unit;
                }
            }
        }

        return assigned;
    }

    /**
     * @param {string[]} lines
     * @param {string} [source]
     * @returns {{items: ShopeeLineItem[], warnings: string[]}}
     */
    function extractTableItems(lines, source = '') {
        const header = findProductHeader(lines, source);
        if (!header) {
            return { items: [], warnings: [] };
        }
        const columns = findColumns(header.header, header.damagedQuantity);
        const descriptionColumn = columns.find((column) => column.kind === 'description');
        const indexColumn = columns.find((column) => column.kind === 'index');
        if (!descriptionColumn
            || !columns.some((column) => column.kind === 'quantity')) {
            return { items: [], warnings: [] };
        }
        const flattened = splitGaps(header.header).length <= 1;
        const hasIndexColumn = Boolean(indexColumn);

        /** @type {ShopeeLineItem[]} */
        const items = [];
        /** @type {Set<ShopeeLineItem>} */
        const flattenedRows = new Set();
        /** @type {string[]} */
        let pendingDescription = [];
        /** @type {ShopeeLineItem|null} */
        let lastItem = null;
        let lastItemHadInlineDescription = false;

        for (let i = header.start; i < lines.length; i++) {
            const line = lines[i];
            if (PRODUCT_END_RE.test(line)) {
                break;
            }
            if (SEPARATOR_RE.test(line) || (isProductHeader(line) && i !== header.index)) {
                continue;
            }
            if (!/[A-Za-z]{2}/.test(line) && !/\d/.test(line)) {
                continue;
            }

            const firstTextIndex = line.search(/\S/);
            const hasLeadingIndex = /^\s*\d{1,3}[.)]?\s+\S/.test(line);
            // Decoration and barcode noise can sit between the header and a
            // product row. In a gap-preserved table, real rows begin at the
            // index/description columns; text that starts left of those
            // columns and is not an indexed row is not a product.
            if (!flattened
                && descriptionColumn
                && firstTextIndex !== -1
                && firstTextIndex < descriptionColumn.index
                && !hasLeadingIndex) {
                continue;
            }

            const assigned = assignChunks(line, columns, flattened);
            const hasInlineDescription = /[A-Za-z]{2}/.test(assigned.description);
            // With an index column, an indexed row starts a product. A row
            // whose index was lost by OCR may still be a clearly populated,
            // column-aligned product row when it carries description text and
            // a quantity; accept that without letting a stray quantity in
            // noise ("... 7 24") become a product. Headerless/flattened tables
            // retain their existing fallback rules.
            const isRow = hasIndexColumn
                ? assigned.index !== null
                    || (!flattened && hasInlineDescription && assigned.quantity !== null)
                : assigned.index !== null
                    || assigned.quantity !== null
                    || (assigned.flattened && Boolean(assigned.sku) && hasInlineDescription);

            if (isRow) {
                const description = cleanText([
                    pendingDescription.join(' '),
                    assigned.description,
                ].filter(Boolean).join(' '));
                if (!description) {
                    pendingDescription = [];
                    continue;
                }
                /** @type {ShopeeLineItem} */
                const item = {
                    description,
                    quantity: assigned.quantity,
                    unitPrice: null,
                    amount: null,
                };
                if (assigned.sku) {
                    item.sku = cleanText(assigned.sku);
                }
                if (assigned.variant) {
                    item.variant = cleanText(assigned.variant);
                }
                if (assigned.unit) {
                    item.unit = assigned.unit;
                }
                items.push(item);
                if (assigned.flattened) {
                    flattenedRows.add(item);
                }
                lastItem = item;
                lastItemHadInlineDescription = hasInlineDescription;
                pendingDescription = [];
                continue;
            }

            if (assigned.description) {
                if (lastItem && lastItemHadInlineDescription) {
                    lastItem.description = joinText(lastItem.description, assigned.description);
                } else {
                    pendingDescription.push(assigned.description);
                }
            }
            if (assigned.variant && lastItem) {
                lastItem.variant = joinText(lastItem.variant || '', assigned.variant);
            }
            if (assigned.sku && lastItem) {
                lastItem.sku = joinSku(lastItem.sku || '', assigned.sku);
            }
        }

        // A flattened row has no usable column gaps, so a printed SKU or
        // variant may have been folded into the description. Do not invent a
        // split: when the header declares those columns but the final item
        // still lacks the metadata, keep the full source text in the
        // description and say explicitly that the structured fields are
        // uncertain.
        /** @type {string[]} */
        const warnings = [];
        if (flattened) {
            const metadataColumns = columns.filter((column) => (
                column.kind === 'sku' || column.kind === 'variant'
            ));
            if (metadataColumns.length > 0) {
                items.forEach((item, index) => {
                    if (!flattenedRows.has(item)) {
                        return;
                    }
                    const missingMetadata = metadataColumns.some((column) => (
                        column.kind === 'sku' ? !item.sku : !item.variant
                    ));
                    if (missingMetadata) {
                        warnings.push(`Line ${index + 1} (${item.description}): `
                            + 'SKU/variant metadata could not be separated reliably '
                            + 'from flattened product text');
                    }
                });
            }
        }
        return { items, warnings };
    }

    /**
     * Headerless labels print the quantity as a suffix, e.g.
     * "20ml Luxurious Facial Oil    2 Botol". Footer counts such as
     * "Total: 2" and "Total Qty:3" have no unit and are never products.
     * @param {string[]} lines
     * @returns {ShopeeLineItem[]}
     */
    function extractHeaderlessItems(lines) {
        /** @type {ShopeeLineItem[]} */
        const items = [];
        for (const line of lines) {
            const trimmed = line.trim();
            let description = '';
            let quantity = null;
            let unit = null;

            const suffix = HEADERLESS_ITEM_RE.exec(trimmed);
            if (suffix) {
                description = cleanText(suffix[1]);
                quantity = Number(suffix[2]);
                // The unit is the suffix captured by the pattern, not the
                // first unit word in the description ("Gift Box ... 2 Botol"
                // is measured in Botol, not Box).
                unit = normalizeUnit(suffix[3]);
            } else {
                const prefix = HEADERLESS_PREFIX_RE.exec(trimmed);
                if (prefix) {
                    description = cleanText(prefix[3]);
                    quantity = Number(prefix[1]);
                    unit = normalizeUnit(prefix[2]);
                }
            }

            if (!description || !/[A-Za-z]{2}/.test(description)) {
                continue;
            }
            if (/^(?:total|grand\s+total|jumlah(?:\s+total)?)\b/i.test(description)) {
                continue;
            }
            if (!Number.isInteger(quantity) || quantity === null || quantity <= 0) {
                continue;
            }
            /** @type {ShopeeLineItem} */
            const item = {
                description,
                quantity,
                unitPrice: null,
                amount: null,
            };
            if (unit) {
                item.unit = unit;
            }
            items.push(item);
        }
        return items;
    }

    /**
     * @param {string[]} lines
     * @param {string} [source]
     * @returns {{items: ShopeeLineItem[], warnings: string[]}}
     */
    function extractLineItems(lines, source = '') {
        const table = extractTableItems(lines, source);
        if (table.items.length > 0) {
            return table;
        }
        return { items: extractHeaderlessItems(lines), warnings: [] };
    }

    /**
     * Finds a labelled date and parses it with the caller's date order.
     * A printed timestamp or the shipping deadline is never used as a
     * fallback for the order date.
     * @param {string[]} lines
     * @param {RegExp} labelRe
     * @param {'dmy'|'mdy'} dateOrder
     * @param {ShopeeHelpers} helpers
     * @returns {string|null}
     */
    function findLabeledDate(lines, labelRe, dateOrder, helpers) {
        for (let i = 0; i < lines.length; i++) {
            const match = labelRe.exec(lines[i]);
            if (!match) {
                continue;
            }
            const rest = lines[i].slice(match.index + match[0].length);
            // Another field follows immediately on this line ("Waktu
            // Pemesanan: Batas Kirim: 13-11-2026", also without a space
            // between the markers). Its value belongs to that field, never to
            // the current one, including the next line. Check this before
            // findDate so a missing gap cannot leak the other field's value.
            if (rest.trim() && LEADING_FIELD_RE.test(rest)) {
                continue;
            }
            const boundary = FIELD_BOUNDARY_RE.exec(rest);
            const valueText = boundary ? rest.slice(0, boundary.index) : rest;
            const onLine = helpers.findDate(valueText, dateOrder);
            if (onLine) {
                return onLine.iso;
            }
            if (!lines[i + 1] || LEADING_FIELD_RE.test(lines[i + 1])) {
                continue;
            }
            const next = helpers.findDate(lines[i + 1], dateOrder);
            if (next && next.index === 0) {
                return next.iso;
            }
        }
        return null;
    }

    /**
     * @param {string[]} lines
     * @returns {string|null}
     */
    function findOrderId(lines) {
        let shortCandidate = null;
        for (const line of lines) {
            const match = ORDER_VALUE_RE.exec(line);
            if (!match) {
                continue;
            }
            const candidate = match[1].replace(/[.,;:]+$/, '');
            if (FIELD_WORD_RE.test(candidate)) {
                continue;
            }
            if (candidate.length >= 8) {
                return candidate;
            }
            if (!shortCandidate && candidate.length >= 4) {
                shortCandidate = candidate;
            }
        }
        // A standalone token is often a wrapped SKU continuation. Only an
        // explicitly labelled order number is safe to report as the order ID.
        return shortCandidate;
    }

    /**
     * @param {string[]} lines
     * @returns {string|null}
     */
    function findTrackingNumber(lines) {
        for (const line of lines) {
            const match = TRACKING_LABEL_RE.exec(line);
            if (!match) {
                continue;
            }
            const candidate = match[1].replace(/[.,;:]+$/, '');
            if (candidate.length >= 6) {
                return candidate;
            }
        }
        for (const line of lines) {
            const match = TRACKING_TOKEN_RE.exec(line);
            if (match) {
                return match[0];
            }
        }
        return null;
    }

    /**
     * @param {string[]} lines
     * @param {RegExp} labelRe
     * @returns {string|null}
     */
    function valueAfterLabel(lines, labelRe) {
        for (let i = 0; i < lines.length; i++) {
            const match = labelRe.exec(lines[i]);
            if (!match) {
                continue;
            }
            let value = lines[i].slice(match.index + match[0].length);
            // A marker at offset 0 means the current label has no value;
            // "Penerima: Pengirim: OtherStore" must not report the sender as
            // the recipient.
            const startsWithField = value.trim() !== '' && LEADING_FIELD_RE.test(value);
            if (!startsWithField) {
                const boundary = FIELD_BOUNDARY_RE.exec(value);
                if (boundary) {
                    value = value.slice(0, boundary.index);
                }
                const cleaned = nonEmpty(value);
                if (cleaned) {
                    return cleaned;
                }
            }
            if (startsWithField) {
                continue;
            }
            const nextLine = lines[i + 1];
            if (nextLine
                && !LEADING_FIELD_RE.test(nextLine)
                && !/[:\-]\s*\S/.test(nextLine)) {
                const next = nonEmpty(nextLine);
                if (next) {
                    return next;
                }
            }
        }
        return null;
    }

    /**
     * @param {string} text
     * @param {string[]} lines
     * @param {ShopeeHelpers} helpers
     * @returns {ShopeeWeight|null}
     */
    function findWeight(text, lines, helpers) {
        for (const line of lines) {
            const match = /\bBerat\s*(?:\([^)]*\))?\s*[:.-]?\s*(\d+(?:[.,]\d+)?)\s*(kg|gr|g|gram)\b/i.exec(line);
            if (!match) {
                continue;
            }
            const value = helpers.parseAmount(match[1]);
            if (value === null || value <= 0) {
                continue;
            }
            const unit = match[2].toLowerCase();
            return {
                value,
                unit: unit === 'kg' ? 'kg' : 'g',
            };
        }
        return null;
    }

    /**
     * @param {string} source
     * @returns {string|null}
     */
    function findCourier(source) {
        /** @type {[string, RegExp][]} */
        const couriers = [
            ['SPX', /\bSPX(?:\s*Express)?\b/i],
            ['ID Express', /\bID\s*Express\b/i],
            ['JNE', /\bJNE\b/i],
            ['J&T', /\bJ&T\b/i],
            ['SiCepat', /\bSiCepat\b/i],
            ['AnterAja', /\bAnterAja\b/i],
            ['Ninja Xpress', /\bNinja(?:\s+Xpress)?\b/i],
            ['Pos Indonesia', /\bPos\s+Indonesia\b/i],
        ];
        for (const [name, re] of couriers) {
            if (re.test(source)) {
                return name;
            }
        }
        return null;
    }

    /**
     * COD is a payment method here, never a total. "COD Cek Dulu: Tidak"
     * explicitly says the parcel is not COD, so it is not reported.
     * @param {string} source
     * @returns {string|null}
     */
    function findPayment(source) {
        const cod = /\bCOD\b[^\n]*/i.exec(source);
        if (cod && !/\bCOD\s+Cek\s+Dulu\s*:\s*Tidak\b/i.test(cod[0])) {
            return 'COD';
        }
        if (/\bCASH?LESS\b/i.test(source)) {
            return 'Cashless';
        }
        return null;
    }

    /**
     * A vendor ending in two one/two-letter lowercase tokens is usually
     * trailing barcode noise ("... hop i ae"). Keep the recognized text
     * unchanged, but warn instead of pretending it is a clean vendor name.
     * @param {string|null} vendor
     * @returns {boolean}
     */
    function vendorMayContainOcrNoise(vendor) {
        const tokens = cleanText(vendor).split(/\s+/).filter(Boolean);
        if (tokens.length < 3) {
            return false;
        }
        return tokens.slice(-2).every((token) => /^[a-z]{1,2}$/.test(token));
    }

    /**
     * @param {string[]} lines
     * @param {'dmy'|'mdy'} dateOrder
     * @param {ShopeeHelpers} helpers
     * @returns {ShopeeInvoice}
     */
    function buildInvoice(text, options, lines, dateOrder, helpers) {
        const source = String(text || '');
        const extracted = extractLineItems(lines, source);
        /** @type {ShopeeInvoice} */
        const invoice = {
            vendor: valueAfterLabel(lines, SENDER_RE) || valueAfterLabel(lines, STORE_RE),
            billTo: valueAfterLabel(lines, RECIPIENT_RE),
            invoiceNumber: null,
            invoiceDate: null,
            dueDate: null,
            currency: typeof options.currency === 'string' && options.currency.trim()
                ? options.currency.trim().toUpperCase()
                : helpers.detectCurrency(source) || null,
            lineItems: extracted.items,
            subtotal: null,
            discount: null,
            taxRate: null,
            tax: null,
            shipping: null,
            total: null,
            amountDue: null,
            warnings: extracted.warnings.slice(),
            merchant: ID,
            documentType: 'shipping_label',
            orderId: findOrderId(lines),
            trackingNumber: findTrackingNumber(lines),
            orderDate: findLabeledDate(lines, DATE_ORDER_RE, dateOrder, helpers),
            shippingDeadline: findLabeledDate(lines, SHIPPING_DEADLINE_RE, dateOrder, helpers),
            weight: findWeight(source, lines, helpers),
            courier: findCourier(source),
            payment: findPayment(source),
        };

        // Deliberately not helpers.checkInvoice: missing money, invoice
        // number and invoice date are normal for a shipping label.
        if (invoice.vendor && vendorMayContainOcrNoise(invoice.vendor)) {
            invoice.warnings.push('Vendor name may contain OCR noise');
        }
        if (!invoice.orderId) {
            invoice.warnings.push('Order ID not found on shipping label');
        }
        if (invoice.lineItems.length === 0) {
            invoice.warnings.push('No product lines detected on shipping label');
        }
        invoice.lineItems.forEach((item, index) => {
            if (item.quantity === null || !Number.isInteger(item.quantity) || item.quantity <= 0) {
                invoice.warnings.push(`Line ${index + 1} (${item.description}): quantity uncertain`);
            }
        });
        return invoice;
    }

    /**
     * @param {string} text
     * @returns {boolean}
     */
    function matches(text) {
        const source = String(text || '');
        if (!source.trim()) {
            return false;
        }

        const lines = toLines(source);
        const header = findProductHeader(lines, source);
        // A product table or headerless "N Pcs/Botol" rows are mandatory.
        // A courier waybill with only SPX/order text must stay generic.
        const hasHeaderlessProducts = lines.some((line) => (
            HEADERLESS_ITEM_RE.test(line.trim()) || HEADERLESS_PREFIX_RE.test(line.trim())
        ));
        if (!header && !hasHeaderlessProducts) {
            return false;
        }

        // Price columns make this an invoice, not a Shopee shipping label.
        if (header && PRODUCT_MONEY_RE.test(header.header)) {
            return false;
        }
        const hasInvoiceMarker = INVOICE_MARKER_RE.test(source);
        const hasMoneyTotal = lines.some((line) => MONEY_TOTAL_RE.test(line));
        if (hasInvoiceMarker && hasMoneyTotal) {
            return false;
        }

        // Require direct Shopee/SPX evidence. A JNE/No.Resi waybill by itself
        // is not a Shopee label even when it carries recipient furniture.
        const hasShopeeEvidence = SHOPEE_BRAND_RE.test(source)
            || SPX_BRAND_RE.test(source)
            || SPX_TRACKING_RE.test(source);
        if (!hasShopeeEvidence) {
            return false;
        }

        const hasTracking = TRACKING_TOKEN_RE.test(source)
            || lines.some((line) => /\b(?:No\.?\s*Resi|Nomor\s+Resi|Tracking(?:\s+(?:No\.?|Number|ID))?)\b/i.test(line));
        const hasRecipient = lines.some((line) => RECIPIENT_RE.test(line));
        const hasSender = lines.some((line) => SENDER_RE.test(line));
        const hasStore = lines.some((line) => STORE_RE.test(line));
        const hasDeadline = lines.some((line) => SHIPPING_DEADLINE_RE.test(line));
        const hasWeight = lines.some((line) => /\bBerat\b/i.test(line));
        const hasMethod = lines.some((line) => /\bMetode\s+Pengiriman\b/i.test(line));
        const hasPayment = lines.some((line) => /\b(?:COD|Cashless|CASH?LESS)\b/i.test(line));
        return hasTracking || hasRecipient || hasSender || hasStore
            || hasDeadline || hasWeight || hasMethod || hasPayment;
    }

    /**
     * @param {string} text
     * @param {ShopeeParseOptions} options
     * @param {ShopeeHelpers} helpers
     * @returns {ShopeeInvoice}
     */
    function parse(text, options = {}, helpers) {
        if (!helpers || typeof helpers.findDate !== 'function' || typeof helpers.parseAmount !== 'function') {
            throw new TypeError('Shopee parser requires invoice parser helpers');
        }
        const source = String(text || '');
        const lines = toLines(source);
        const dateOrder = options.dateOrder === 'mdy' ? 'mdy' : 'dmy';
        return buildInvoice(source, options, lines, dateOrder, helpers);
    }

    return { id: ID, matches, parse };
});
