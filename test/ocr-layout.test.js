'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const layout = require('../public/ocr-layout.js');

/** @param {string} text @param {any} bbox @returns {{text: string, bbox: any, words: any[]}} */
function line(text, bbox = [0, 100, 1000, 130]) {
    const [x0, y0, x1, y1] = bbox;
    return {
        text,
        bbox: { x0, y0, x1, y1 },
        words: [],
    };
}

/** @param {string} text @param {number[]} bbox @param {number} confidence */
function word(text, bbox, confidence = 90) {
    const [x0, y0, x1, y1] = bbox;
    return { text, bbox: { x0, y0, x1, y1 }, confidence };
}

function senderData() {
    const sender = line('Penerima: Siti Contoh Pengirim: Flimty Official hop i ae', [437, 746, 2892, 862]);
    sender.words = [
        word('Penerima:', [437, 766, 716, 812], 92),
        word('Siti', [743, 768, 866, 815], 93),
        word('Contoh', [891, 768, 1030, 815], 93),
        word('Pengirim:', [1562, 758, 1820, 817], 90),
        word('Flimty', [1842, 756, 1991, 807], 84),
        word('Official', [2014, 744, 2181, 831], 96),
        word('hop', [2232, 748, 2336, 795], 50),
        word('i', [2399, 746, 2551, 862], 39),
        word('ae', [2579, 766, 2694, 826], 8),
    ];
    return {
        text: sender.text,
        blocks: [{ paragraphs: [{ lines: [sender] }] }],
    };
}

function senderRoiData() {
    const sender = line('“Pengirim: Flimty Official Shop', [1520, 730, 2400, 880]);
    sender.words = [
        word('“Pengirim:', [1562, 758, 1820, 817], 80),
        word('Flimty', [1842, 756, 1991, 807], 90),
        word('Official', [2014, 744, 2181, 831], 89),
        word('Shop', [2214, 748, 2350, 795], 64),
        word('-', [2400, 760, 2420, 780], 8),
        word('i', [2440, 746, 2551, 862], 36),
        word('Gos', [2579, 766, 2694, 826], 32),
    ];
    return {
        text: sender.text,
        blocks: [{ paragraphs: [{ lines: [sender] }] }],
    };
}

function lowConfidenceSuffixData() {
    const sender = line('Pengirim: Toko Sinar Jaya', [100, 200, 800, 230]);
    sender.words = [
        word('Pengirim:', [100, 202, 180, 228], 95),
        word('Toko', [190, 202, 250, 228], 95),
        word('Sinar', [260, 202, 330, 228], 90),
        word('Jaya', [340, 202, 420, 228], 39),
        word('12AB34', [440, 202, 500, 228], 5),
    ];
    return {
        text: sender.text,
        blocks: [{ paragraphs: [{ lines: [sender] }] }],
    };
}

test('sender ROI is derived from word boxes and stops before low-confidence noise', () => {
    const roi = layout.findSenderRoi(senderData(), 3000, 3000);

    assert.deepEqual(roi, {
        left: 1548,
        top: 732,
        width: 802,
        height: 144,
    });
    assert.equal(layout.extractSenderLine(senderData()), 'Pengirim: Flimty Official hop');
    assert.equal(layout.findSenderRoi({ blocks: [] }, 3000, 3000), null);
});

test('sender extraction keeps the exact recognized vendor and drops trailing decoration', () => {
    assert.equal(layout.extractSenderLine(senderRoiData()), 'Pengirim: Flimty Official Shop');
    assert.equal(layout.extractSenderLine({ blocks: [] }), null);
});

test('a low-confidence legitimate sender suffix is kept by extraction and the ROI', () => {
    assert.equal(layout.extractSenderLine(lowConfidenceSuffixData()), 'Pengirim: Toko Sinar Jaya');
    assert.deepEqual(layout.findSenderRoi(lowConfidenceSuffixData(), 1000, 400), {
        left: 94,
        top: 194,
        width: 332,
        height: 42,
    });
});

test('sender replacement never shortens an already complete recognized value', () => {
    const text = [
        'Shopee',
        'Penerima: Siti Contoh Pengirim: Toko Sinar Jaya',
        'Berat: 600 gr',
    ].join('\n');

    assert.equal(layout.replaceSenderLine(text, 'Pengirim: Toko Sinar'), text);
    assert.equal(
        layout.replaceSenderLine(text, 'Pengirim: Toko Sinar Jaya'),
        text,
    );

    const decorated = 'Penerima: Siti Contoh Pengirim: Flimty Official Shop pe 2 ee';
    assert.equal(
        layout.replaceSenderLine(decorated, 'Pengirim: Flimty Official Shop'),
        'Penerima: Siti Contoh Pengirim: Flimty Official Shop',
    );
});

test('sender replacement preserves the recipient and does not delete following fields', () => {
    const text = [
        'Shopee',
        'Penerima: Siti Contoh Pengirim: Flimty Official hop i ae',
        'Berat: 600 gr',
    ].join('\n');
    assert.equal(
        layout.replaceSenderLine(text, 'Pengirim: Flimty Official Shop'),
        [
            'Shopee',
            'Penerima: Siti Contoh Pengirim: Flimty Official Shop',
            'Berat: 600 gr',
        ].join('\n'),
    );

    const anotherFieldAfter = 'Penerima: Siti Contoh Pengirim: Toko Penerima: Lain';
    assert.equal(
        layout.replaceSenderLine(anotherFieldAfter, 'Pengirim: Toko'),
        anotherFieldAfter,
    );
    assert.equal(layout.replaceSenderLine(text, 'Bukan Pengirim'), text);
});

test('array-shaped bboxes are accepted for alternate Tesseract data', () => {
    const sender = line('Pengirim: Flimty Official Shop', [10, 20, 400, 40]);
    sender.bbox = [10, 20, 400, 40];
    sender.words = [
        { text: 'Pengirim:', bbox: [10, 20, 90, 40], confidence: 90 },
        { text: 'Flimty', bbox: [100, 20, 160, 40], confidence: 90 },
        { text: 'Official', bbox: [170, 20, 230, 40], confidence: 90 },
        { text: 'Shop', bbox: [240, 20, 290, 40], confidence: 90 },
    ];
    const data = { blocks: [{ paragraphs: [{ lines: [sender] }] }] };

    assert.deepEqual(layout.findSenderRoi(data, 500, 100), {
        left: 4,
        top: 14,
        width: 292,
        height: 32,
    });
    assert.equal(layout.extractSenderLine(data), 'Pengirim: Flimty Official Shop');
});

test('browser UMD loading produces the same layout helpers as Node', () => {
    const file = path.join(__dirname, '..', 'public', 'ocr-layout.js');
    const browser = { self: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), browser, { filename: file });

    const browserLayout = browser.self.InvoiceOcrLayout;
    assert.ok(browserLayout);
    assert.equal(
        browserLayout.extractSenderLine(senderRoiData()),
        layout.extractSenderLine(senderRoiData()),
    );
    assert.deepEqual(
        JSON.parse(JSON.stringify(browserLayout.findSenderRoi(senderData(), 3000, 3000))),
        layout.findSenderRoi(senderData(), 3000, 3000),
    );
});
