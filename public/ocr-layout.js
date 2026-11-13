/**
 * Spatial helpers for the browser OCR pipeline.
 *
 * Tesseract's flat text output can lose the wide gaps that separate columns
 * on a photographed shipping label. The word boxes are still available in
 * `data.blocks`, so this module uses them for a small, targeted second pass
 * over the sender line instead of re-running OCR over the whole image.
 *
 * Works in the browser (window.InvoiceOcrLayout) and in Node (require).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        /** @type {any} */ (root).InvoiceOcrLayout = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const SENDER_WORD_RE = /Pengirim\b/i;
    const SENDER_VALUE_WORD_RE = /Pengirim\b\s*[:#,]?\s*(.*)$/i;
    const FIELD_LABEL_PATTERN = '(?:Penerima|Pembeli|Pengirim|Penjual|Nama\\s+Toko|Alamat|Berat|'
        + 'No\\.?\\s*(?:Pesanan|Resi)|Nomor\\s+(?:Pesanan|Resi)|'
        + 'Tracking(?:\\s+(?:No\\.?|Number|ID))?|Batas\\s+(?:Kirim|Pengiriman)|'
        + 'Waktu\\s+Pemesanan|Tanggal\\s+Pemesanan|Order\\s+Date|Metode\\s+Pengiriman|'
        + 'COD|Cashless|Total|Harga|SKU|Qty|Jumlah|Jml)';
    const ADJACENT_FIELD_RE = new RegExp(`^(?:${FIELD_LABEL_PATTERN})\\b`, 'i');
    const OTHER_FIELD_RE = new RegExp(`\\b(?:${FIELD_LABEL_PATTERN})\\b`, 'i');
    const PRECEDING_FIELD_RE = new RegExp(`(?:${FIELD_LABEL_PATTERN})\\b\\s*[:#]?\\s*$`, 'i');
    const FIELD_BOUNDARY_RE = new RegExp(`\\s+(?=(?:${FIELD_LABEL_PATTERN})\\b\\s*[:#]?)`, 'i');
    const MIN_WORD_CONFIDENCE = 40;

    /**
     * @typedef {Object} OcrWord
     * @property {string} text
     * @property {number[]|{x0: number, y0: number, x1: number, y1: number}} [bbox]
     * @property {number} [confidence]
     */

    /**
     * @typedef {Object} OcrLine
     * @property {string} text
     * @property {number[]|{x0: number, y0: number, x1: number, y1: number}} [bbox]
     * @property {OcrWord[]} [words]
     */

    /**
     * @param {any} data
     * @returns {OcrLine[]}
     */
    function collectLines(data) {
        /** @type {OcrLine[]} */
        const lines = [];
        if (data && Array.isArray(data.blocks)) {
            for (const block of data.blocks) {
                for (const paragraph of block.paragraphs || []) {
                    for (const line of paragraph.lines || []) {
                        if (line) {
                            lines.push(line);
                        }
                    }
                }
            }
        }
        if (lines.length === 0 && data && Array.isArray(data.lines)) {
            return data.lines;
        }
        return lines;
    }

    /**
     * Tesseract.js exposes boxes as {x0, y0, x1, y1}; tests may provide the
     * equivalent four-number array.
     * @param {any} value
     * @returns {{x0: number, y0: number, x1: number, y1: number}|null}
     */
    function boxOf(value) {
        const box = value && value.bbox;
        if (!box) {
            return null;
        }
        const coords = Array.isArray(box)
            ? { x0: box[0], y0: box[1], x1: box[2], y1: box[3] }
            : { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
        return Object.values(coords).every((value) => Number.isFinite(value)) ? coords : null;
    }

    /**
     * @param {string} value
     * @returns {string}
     */
    function cleanWord(value) {
        return String(value || '')
            .replace(/^[^\p{L}\p{N}]+/u, '')
            .replace(/[^\p{L}\p{N})]+$/u, '')
            .trim();
    }

    /**
     * Low confidence alone is not evidence of noise: a photographed sender
     * name can contain a poorly recognized but genuine suffix ("Jaya").
     * Keep words with a plausible alphabetic shape even below the confidence
     * threshold; symbols, one/two-letter fragments and digit-heavy barcode
     * noise are excluded by shape instead.
     * @param {OcrWord} word
     * @returns {boolean}
     */
    function isUsableValueWord(word) {
        const text = cleanWord(word && word.text);
        if (!text) {
            return false;
        }
        if (typeof word.confidence !== 'number' || word.confidence >= MIN_WORD_CONFIDENCE) {
            return true;
        }
        return /^\p{L}{3,}$/u.test(text);
    }

    /**
     * @param {any} data
     * @returns {{line: OcrLine, words: OcrWord[], labelIndex: number}|null}
     */
    function findSenderLine(data) {
        for (const line of collectLines(data)) {
            const words = Array.isArray(line.words) ? line.words.filter(Boolean) : [];
            const labelIndex = words.findIndex((word) => SENDER_WORD_RE.test(String(word.text || '')));
            if (labelIndex !== -1) {
                return { line, words, labelIndex };
            }
        }
        return null;
    }

    /**
     * @param {OcrWord[]} words
     * @param {number} labelIndex
     * @returns {string[]}
     */
    function valueWords(words, labelIndex) {
        const values = [];
        for (let i = labelIndex; i < words.length; i++) {
            const word = words[i];
            const raw = String(word.text || '');
            if (i > labelIndex && ADJACENT_FIELD_RE.test(raw.trim())) {
                break;
            }
            const labelMatch = SENDER_VALUE_WORD_RE.exec(raw);
            const text = cleanWord(i === labelIndex && labelMatch ? labelMatch[1] : raw);
            if (!text) {
                if (i > labelIndex) {
                    break;
                }
                continue;
            }
            if (i > labelIndex && !isUsableValueWord(word)) {
                break;
            }
            values.push(text);
        }
        return values;
    }

    /**
     * Builds a rectangle around the printed sender field from its word boxes.
     * The right edge stops before an adjacent printed field or low-confidence
     * decoration that follows the vendor name, so the second pass is not
     * distracted by barcode noise.
     * @param {any} data
     * @param {number} width
     * @param {number} height
     * @returns {{left: number, top: number, width: number, height: number}|null}
     */
    function findSenderRoi(data, width, height) {
        const found = findSenderLine(data);
        if (!found) {
            return null;
        }
        const { line, words, labelIndex } = found;
        const labelWord = words[labelIndex];
        const labelBox = boxOf(labelWord);
        if (!labelBox) {
            return null;
        }
        const boxes = words.map(boxOf).filter(Boolean);
        const lineBox = boxOf(line) || {
            x0: Math.min(...boxes.map((box) => box.x0)),
            y0: Math.min(...boxes.map((box) => box.y0)),
            x1: Math.max(...boxes.map((box) => box.x1)),
            y1: Math.max(...boxes.map((box) => box.y1)),
        };
        const lineHeight = Math.max(1, lineBox.y1 - lineBox.y0);
        // A tight margin keeps the narrow sender line isolated. Too much
        // vertical context brings barcode noise into the retry.
        const padding = Math.max(6, Math.min(24, Math.round(lineHeight * 0.12)));

        let lastBox = labelBox;
        for (let i = labelIndex + 1; i < words.length; i++) {
            const word = words[i];
            const wordBox = boxOf(word);
            if (!wordBox || !cleanWord(word.text)
                || ADJACENT_FIELD_RE.test(String(word.text || '').trim())
                || !isUsableValueWord(word)) {
                break;
            }
            lastBox = wordBox;
        }

        const left = Math.max(0, Math.round(labelBox.x0 - padding));
        const top = Math.max(0, Math.round(lineBox.y0 - padding));
        const right = Math.min(width, Math.round(lastBox.x1 + padding));
        const bottom = Math.min(height, Math.round(lineBox.y1 + padding));
        if (right <= left || bottom <= top) {
            return null;
        }
        return {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
    }

    /**
     * @param {any} data
     * @returns {string|null}
     */
    function extractSenderLine(data) {
        const found = findSenderLine(data);
        if (!found) {
            return null;
        }
        const value = valueWords(found.words, found.labelIndex).join(' ');
        return value ? `Pengirim: ${value}` : null;
    }

    /**
     * Normalizes a sender value for a conservative prefix comparison.
     * @param {string} value
     * @returns {string[]}
     */
    function senderTokens(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim()
            .split(/\s+/)
            .filter(Boolean);
    }

    /**
     * A retry can recognize only the first part of an already complete value
     * when the ROI ends early. Replacing "Toko Sinar Jaya" with "Toko Sinar"
     * would destroy a correct suffix, so keep the original in that case.
     * @param {string} current
     * @param {string} replacement
     * @returns {boolean}
     */
    function isDestructiveSenderPrefix(current, replacement) {
        const currentTokens = senderTokens(current);
        const replacementTokens = senderTokens(replacement);
        if (replacementTokens.length === 0
            || replacementTokens.length >= currentTokens.length
            || !replacementTokens.every((token, index) => token === currentTokens[index])) {
            return false;
        }
        // Short/digit-only trailing tokens are decoration ("Shop pe 2 ee") and
        // may safely be dropped by a cleaner retry. A substantive alphabetic
        // suffix such as "Jaya" may be part of the vendor name, so a shorter
        // replacement is treated as a risky truncation.
        return currentTokens
            .slice(replacementTokens.length)
            .some((token) => /^\p{L}{3,}$/u.test(token));
    }

    /**
     * Replaces only the sender value on its original line, preserving the
     * recipient, following labelled fields and the surrounding layout.
     * @param {string} text
     * @param {string} senderLine
     * @returns {string}
     */
    function replaceSenderLine(text, senderLine) {
        const replacement = String(senderLine || '').trim();
        if (/[\r\n]/.test(replacement)
            || !/^Pengirim\b\s*[:#,]?\s*\S/i.test(replacement)) {
            return String(text || '');
        }
        const lines = String(text || '').split('\n');
        for (let i = 0; i < lines.length; i++) {
            const match = /\bPengirim\b\s*[:#,]?\s*/i.exec(lines[i]);
            if (!match) {
                continue;
            }
            const prefix = lines[i].slice(0, match.index);
            // "Penerima: Pengirim: Other" contains a sender-shaped value on
            // the recipient line. Only the actual printed sender field moves.
            if (PRECEDING_FIELD_RE.test(prefix)) {
                continue;
            }
            const rest = lines[i].slice(match.index + match[0].length);
            // Never consume the next line: the replacement is a single field
            // and the original sender line has no same-line value to replace.
            if (!rest.trim()) {
                continue;
            }
            const boundary = FIELD_BOUNDARY_RE.exec(rest);
            if (!boundary && OTHER_FIELD_RE.test(rest)) {
                continue;
            }
            const currentValue = boundary ? rest.slice(0, boundary.index) : rest;
            const replacementMatch = SENDER_VALUE_WORD_RE.exec(replacement);
            const replacementValue = replacementMatch ? replacementMatch[1] : '';
            if (isDestructiveSenderPrefix(currentValue, replacementValue)) {
                continue;
            }
            const tail = boundary ? rest.slice(boundary.index) : '';
            lines[i] = `${prefix}${replacement}${tail}`;
            break;
        }
        return lines.join('\n');
    }

    return {
        findSenderRoi,
        extractSenderLine,
        replaceSenderLine,
    };
});
