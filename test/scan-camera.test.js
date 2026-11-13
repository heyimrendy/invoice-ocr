'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const InvoiceOcrLayout = require('../public/ocr-layout.js');

function inlineScript() {
    const match = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match, 'index.html should contain an inline script');
    return match[1];
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeStream() {
    const track = {
        kind: 'video',
        readyState: 'live',
        stopCount: 0,
        stop() {
            this.stopCount++;
            this.readyState = 'ended';
        },
    };
    return {
        track,
        getTracks() {
            return [track];
        },
        getVideoTracks() {
            return [track];
        },
    };
}

class FakeClassList {
    constructor() {
        this.names = new Set();
    }

    add(...names) {
        for (const name of names) {
            this.names.add(name);
        }
    }

    remove(...names) {
        for (const name of names) {
            this.names.delete(name);
        }
    }

    toggle(name, force) {
        if (force === undefined) {
            if (this.names.has(name)) {
                this.names.delete(name);
                return false;
            }
            this.names.add(name);
            return true;
        }
        if (force) {
            this.names.add(name);
        } else {
            this.names.delete(name);
        }
        return Boolean(force);
    }

    contains(name) {
        return this.names.has(name);
    }
}

class FakeElement {
    constructor(id = '', tagName = 'div') {
        this.id = id;
        this.tagName = tagName.toUpperCase();
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.textContent = '';
        this.style = {};
        this.classList = new FakeClassList();
        this.listeners = new Map();
        this.children = [];
        this.files = [];
        this.srcObject = null;
        this.videoWidth = 0;
        this.videoHeight = 0;
        this.readyState = 0;
        this.clickCount = 0;
        this.pauseCount = 0;
        this.playCount = 0;
        this.playMode = 'resolve';
        this.resolvePlay = null;
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, []);
        }
        this.listeners.get(type).push(listener);
    }

    removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        this.listeners.set(type, listeners.filter((item) => item !== listener));
    }

    dispatch(type, event = {}) {
        const payload = { type, target: this, ...event };
        for (const listener of this.listeners.get(type) || []) {
            listener(payload);
        }
    }

    click() {
        this.clickCount++;
        this.dispatch('click');
    }

    pause() {
        this.pauseCount++;
    }

    play() {
        this.playCount++;
        if (this.playMode === 'pending') {
            return new Promise((resolve) => {
                this.resolvePlay = resolve;
            });
        }
        return Promise.resolve();
    }

    replaceChildren(...children) {
        this.children = children;
    }

    scrollIntoView() {}
}

class FakeCanvas extends FakeElement {
    constructor(blobMode = 'immediate') {
        super('', 'canvas');
        this.blobMode = blobMode;
        this.toBlobCalls = [];
        this.pendingBlob = null;
        this.context = {
            fillStyle: '',
            drawCalls: [],
            fillRect() {},
            drawImage(...args) {
                this.drawCalls.push(args);
            },
            getImageData(x, y, width, height) {
                return { data: new Uint8ClampedArray(width * height * 4) };
            },
            putImageData() {},
        };
    }

    getContext() {
        return this.context;
    }

    toBlob(callback, type, quality) {
        this.toBlobCalls.push({ type, quality });
        if (this.blobMode === 'manual') {
            this.pendingBlob = () => callback(new Blob(['jpeg'], { type }));
            return;
        }
        if (this.blobMode === 'error') {
            callback(null);
            return;
        }
        callback(new Blob(['jpeg'], { type }));
    }
}

function createHarness(options = {}) {
    const elementIds = [
        'drop', 'file', 'preview', 'scan', 'camera', 'camera-video', 'camera-status',
        'capture', 'camera-cancel', 'lang', 'date-order', 'currency', 'sample', 'status',
        'bar-fill', 'status-text', 'result', 'warnings', 'json', 'text', 'copy', 'download',
    ];
    const elements = new Map();
    for (const id of elementIds) {
        const tag = id === 'file' || id === 'currency' ? 'input' : id === 'text' ? 'textarea' : 'div';
        elements.set(id, new FakeElement(id, tag));
    }
    elements.get('camera-video').tagName = 'VIDEO';
    elements.get('preview').hidden = true;
    elements.get('camera').hidden = true;
    elements.get('capture').disabled = true;
    elements.get('status').hidden = true;
    elements.get('result').hidden = true;
    elements.get('warnings').hidden = true;
    elements.get('lang').value = 'eng+ind';
    elements.get('date-order').value = 'dmy';

    const documentListeners = new Map();
    const windowListeners = new Map();
    const created = [];
    const bitmaps = [];
    const objectUrls = [];
    const errorLogs = [];
    const media = {
        calls: [],
        gum: async () => {
            throw new Error('getUserMedia was not configured for this test');
        },
    };
    const ocr = {
        createWorkerCalls: [],
        recognizeCalls: [],
        setParametersCalls: [],
        /** @type {(params: Record<string, string>) => Promise<boolean>} */
        setParametersImpl: async () => true,
        recognizeImpl: async () => ({ data: { text: 'Invoice No: SCAN-1\nTotal $10.00' } }),
    };
    const parser = {
        calls: [],
    };

    const document = {
        hidden: false,
        getElementById(id) {
            return elements.get(id) || null;
        },
        createElement(tag) {
            const element = tag === 'canvas'
                ? new FakeCanvas(document.blobMode)
                : new FakeElement('', tag);
            created.push(element);
            return element;
        },
        addEventListener(type, listener) {
            if (!documentListeners.has(type)) {
                documentListeners.set(type, []);
            }
            documentListeners.get(type).push(listener);
        },
        blobMode: 'immediate',
    };

    const window = {
        isSecureContext: true,
        addEventListener(type, listener) {
            if (!windowListeners.has(type)) {
                windowListeners.set(type, []);
            }
            windowListeners.get(type).push(listener);
        },
    };

    const navigator = {
        clipboard: {
            async writeText() {},
        },
        mediaDevices: {
            getUserMedia(constraints) {
                media.calls.push(constraints);
                return media.gum(constraints);
            },
        },
    };

    const Tesseract = {
        async createWorker(lang, oem, options) {
            ocr.createWorkerCalls.push({ lang, oem, options });
            return {
                async setParameters(params) {
                    ocr.setParametersCalls.push(params);
                    return ocr.setParametersImpl(params);
                },
                async recognize(input, recognizeOptions) {
                    ocr.recognizeCalls.push({ input, options: recognizeOptions });
                    return ocr.recognizeImpl(input, recognizeOptions);
                },
                async terminate() {},
            };
        },
    };

    const InvoiceParser = {
        parseInvoice(text) {
            parser.calls.push(text);
            return { warnings: [] };
        },
    };

    const URL = {
        createObjectURL(blob) {
            const url = `blob:mock-${objectUrls.length + 1}`;
            objectUrls.push({ blob, url });
            return url;
        },
        revokeObjectURL() {},
    };

    const context = vm.createContext({
        window,
        document,
        navigator,
        Tesseract,
        InvoiceParser,
        InvoiceOcrLayout: options.layout,
        URL,
        Blob,
        File,
        createImageBitmap: async (blob) => {
            bitmaps.push(blob);
            return { width: 64, height: 36, close() {} };
        },
        console: {
            error(...args) {
                errorLogs.push(args);
            },
            log() {},
        },
        setTimeout,
        clearTimeout,
    });
    vm.runInContext(inlineScript(), context, { filename: 'index-inline.js' });

    function fireWindow(type, event = {}) {
        for (const listener of windowListeners.get(type) || []) {
            listener({ type, ...event });
        }
    }

    function fireDocument(type, event = {}) {
        for (const listener of documentListeners.get(type) || []) {
            listener({ type, ...event });
        }
    }

    function readyVideo({ width = 640, height = 360 } = {}) {
        const video = elements.get('camera-video');
        video.videoWidth = width;
        video.videoHeight = height;
        video.readyState = 3;
        video.dispatch('loadedmetadata');
        video.dispatch('canplay');
    }

    return {
        elements,
        document,
        window,
        navigator,
        media,
        ocr,
        parser,
        created,
        bitmaps,
        objectUrls,
        errorLogs,
        fireWindow,
        fireDocument,
        readyVideo,
    };
}

async function flush(rounds = 5) {
    for (let i = 0; i < rounds; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
}

// A compact whole-image OCR result: the sender line includes the recipient,
// low-confidence trailing decoration and the word boxes the layout helper
// needs. The damaged "hop  i ae" value mirrors the observed Shopee photo.
const SHOPEE_OCR_SENDER_LINE = 'Penerima: Siti Contoh        Pengirim: Flimty Official hop  i ae';
const SHOPEE_OCR_TEXT = [
    'Shopee',
    'SPXID065736718398',
    'No. Pesanan: 2611110YKEYKNA',
    SHOPEE_OCR_SENDER_LINE,
    'Batas Kirim: 11-11-26',
    'L | No. NamaProduk                      Varian           SKU          ay',
    '1. Flimty Fiber 1 Box (16 sachet)           Blackcurrant       Edie 00008   1',
].join('\n');
const SHOPEE_OCR_REPLACED_TEXT = SHOPEE_OCR_TEXT.replace(
    'Pengirim: Flimty Official hop  i ae',
    'Pengirim: Flimty Official Shop',
);
const SHOPEE_OCR_DATA = {
    text: SHOPEE_OCR_TEXT,
    blocks: [{
        paragraphs: [{
            lines: [{
                text: SHOPEE_OCR_SENDER_LINE,
                bbox: { x0: 8, y0: 26, x1: 155, y1: 40 },
                words: [
                    { text: 'Penerima:', bbox: { x0: 8, y0: 28, x1: 30, y1: 38 }, confidence: 95 },
                    { text: 'Siti', bbox: { x0: 32, y0: 28, x1: 44, y1: 38 }, confidence: 95 },
                    { text: 'Contoh', bbox: { x0: 46, y0: 28, x1: 60, y1: 38 }, confidence: 95 },
                    { text: 'Pengirim:', bbox: { x0: 75, y0: 28, x1: 95, y1: 38 }, confidence: 95 },
                    { text: 'Flimty', bbox: { x0: 97, y0: 28, x1: 112, y1: 38 }, confidence: 90 },
                    { text: 'Official', bbox: { x0: 114, y0: 28, x1: 128, y1: 38 }, confidence: 90 },
                    { text: 'hop', bbox: { x0: 130, y0: 28, x1: 139, y1: 38 }, confidence: 50 },
                    { text: 'i', bbox: { x0: 141, y0: 28, x1: 143, y1: 38 }, confidence: 15 },
                    { text: 'ae', bbox: { x0: 145, y0: 28, x1: 150, y1: 38 }, confidence: 5 },
                ],
            }],
        }],
    }],
};
const SHOPEE_SENDER_RETRY_TEXT = 'Pengirim: Flimty Official Shop';
const SHOPEE_SENDER_RETRY_DATA = {
    text: `${SHOPEE_SENDER_RETRY_TEXT}\n`,
    lines: [{
        text: SHOPEE_SENDER_RETRY_TEXT,
        bbox: [69, 28, 137, 38],
        words: [
            { text: 'Pengirim:', bbox: [69, 28, 89, 38], confidence: 90 },
            { text: 'Flimty', bbox: [91, 28, 106, 38], confidence: 90 },
            { text: 'Official', bbox: [108, 28, 122, 38], confidence: 90 },
            { text: 'Shop', bbox: [124, 28, 137, 38], confidence: 90 },
        ],
    }],
};

const SHOPEE_LOW_CONF_SENDER_TEXT = [
    'Shopee',
    'SPXID065736718398',
    'No. Pesanan: 2611110YKEYKNA',
    'Penerima: Siti Contoh        Pengirim: Toko Sinar Jaya',
    'Batas Kirim: 11-11-26',
    'L | No. NamaProduk                      Varian           SKU          ay',
    '1. Product 0123456 Black 1',
].join('\n');
const SHOPEE_LOW_CONF_SENDER_DATA = {
    text: SHOPEE_LOW_CONF_SENDER_TEXT,
    blocks: [{
        paragraphs: [{
            lines: [{
                text: 'Penerima: Siti Contoh        Pengirim: Toko Sinar Jaya',
                bbox: { x0: 8, y0: 26, x1: 155, y1: 40 },
                words: [
                    { text: 'Penerima:', bbox: { x0: 8, y0: 28, x1: 30, y1: 38 }, confidence: 95 },
                    { text: 'Siti', bbox: { x0: 32, y0: 28, x1: 44, y1: 38 }, confidence: 95 },
                    { text: 'Contoh', bbox: { x0: 46, y0: 28, x1: 60, y1: 38 }, confidence: 95 },
                    { text: 'Pengirim:', bbox: { x0: 75, y0: 28, x1: 95, y1: 38 }, confidence: 95 },
                    { text: 'Toko', bbox: { x0: 97, y0: 28, x1: 110, y1: 38 }, confidence: 95 },
                    { text: 'Sinar', bbox: { x0: 112, y0: 28, x1: 128, y1: 38 }, confidence: 90 },
                    { text: 'Jaya', bbox: { x0: 130, y0: 28, x1: 143, y1: 38 }, confidence: 39 },
                ],
            }],
        }],
    }],
};
const SHOPEE_TRUNCATED_SENDER_RETRY_DATA = {
    text: 'Pengirim: Toko Sinar\n',
    lines: [{
        text: 'Pengirim: Toko Sinar',
        bbox: [69, 28, 128, 38],
        words: [
            { text: 'Pengirim:', bbox: [69, 28, 89, 38], confidence: 90 },
            { text: 'Toko', bbox: [91, 28, 110, 38], confidence: 90 },
            { text: 'Sinar', bbox: [112, 28, 128, 38], confidence: 90 },
        ],
    }],
};

test('capture uses the full native frame and feeds a named File to the existing OCR flow', async () => {
    const h = createHarness();
    const stream = makeStream();
    h.media.gum = async () => stream;

    h.elements.get('scan').click();
    await flush();

    assert.equal(h.media.calls.length, 1);
    assert.equal(h.media.calls[0].audio, false);
    assert.equal(h.media.calls[0].video.facingMode.ideal, 'environment');
    assert.equal(h.media.calls[0].video.width.ideal, 1920);
    assert.equal(h.media.calls[0].video.height.ideal, 1080);
    assert.equal(h.elements.get('camera').hidden, false);
    assert.equal(h.elements.get('capture').disabled, true);

    h.readyVideo({ width: 640, height: 360 });
    assert.equal(h.elements.get('capture').disabled, false);

    h.elements.get('capture').click();
    await flush();

    const captureCanvas = h.created.find((element) => element.tagName === 'CANVAS' && element.toBlobCalls.length > 0);
    assert.ok(captureCanvas, 'capture should draw a canvas');
    assert.equal(captureCanvas.width, 640);
    assert.equal(captureCanvas.height, 360);
    assert.deepEqual(captureCanvas.context.drawCalls[0].slice(1), [0, 0, 640, 360]);
    assert.equal(captureCanvas.context.drawCalls[0][0], h.elements.get('camera-video'));
    assert.equal(captureCanvas.toBlobCalls[0].type, 'image/jpeg');

    assert.equal(stream.track.stopCount, 1);
    assert.equal(h.elements.get('camera-video').srcObject, null);
    assert.equal(h.elements.get('camera').hidden, true);
    assert.equal(h.elements.get('capture').disabled, true);

    assert.equal(h.bitmaps.length, 1);
    const capturedFile = h.bitmaps[0];
    assert.ok(capturedFile instanceof File);
    assert.match(capturedFile.name, /^scan-\d+\.jpg$/);
    assert.equal(capturedFile.type, 'image/jpeg');

    assert.equal(h.elements.get('preview').hidden, false);
    assert.equal(h.elements.get('preview').src, 'blob:mock-1');
    assert.equal(h.objectUrls[0].blob, capturedFile);

    assert.equal(h.ocr.createWorkerCalls.length, 1);
    assert.equal(h.ocr.createWorkerCalls[0].lang, 'eng+ind');
    assert.equal(h.ocr.setParametersCalls.length, 1);
    assert.equal(h.ocr.setParametersCalls[0].preserve_interword_spaces, '1');
    assert.equal(h.ocr.recognizeCalls.length, 1);
    assert.equal(h.elements.get('result').hidden, false);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
    assert.ok(h.elements.get('json').textContent.length > 0);
});

function uploadMockImage(harness, name = 'shopee.jpg') {
    const upload = new File(['fake image'], name, { type: 'image/jpeg' });
    harness.elements.get('file').files = [upload];
    harness.elements.get('file').dispatch('change');
}

test('Shopee sender re-read uses the whole OCR data, then replaces only the visible sender', async () => {
    const h = createHarness({ layout: InvoiceOcrLayout });
    h.ocr.recognizeImpl = async (input, options) => (
        options && options.rectangle
            ? { data: SHOPEE_SENDER_RETRY_DATA }
            : { data: SHOPEE_OCR_DATA }
    );

    uploadMockImage(h);
    await flush();

    assert.equal(h.ocr.createWorkerCalls.length, 1);
    assert.equal(h.ocr.setParametersCalls.length, 1);
    assert.deepEqual({ ...h.ocr.setParametersCalls[0] }, { preserve_interword_spaces: '1' });
    assert.equal(h.ocr.recognizeCalls.length, 2);
    assert.equal(h.ocr.recognizeCalls[0].options, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(h.ocr.recognizeCalls[1].options)), {
        rectangle: { left: 69, top: 20, width: 76, height: 26 },
    });
    assert.equal(h.elements.get('text').value, SHOPEE_OCR_REPLACED_TEXT);
    assert.equal(h.elements.get('text').value.includes('hop  i ae'), false);
    assert.equal(h.parser.calls.at(-1), SHOPEE_OCR_REPLACED_TEXT);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
    assert.equal(h.elements.get('result').hidden, false);
});

test('a failed optional sender re-read keeps the original OCR text', async () => {
    const h = createHarness({ layout: InvoiceOcrLayout });
    h.ocr.recognizeImpl = async (input, options) => {
        if (options && options.rectangle) {
            throw new Error('sender re-read failed');
        }
        return { data: SHOPEE_OCR_DATA };
    };

    uploadMockImage(h);
    await flush();

    assert.equal(h.ocr.recognizeCalls.length, 2);
    assert.equal(h.elements.get('text').value, SHOPEE_OCR_TEXT);
    assert.equal(h.parser.calls.at(-1), SHOPEE_OCR_TEXT);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
    assert.equal(h.elements.get('status-text').classList.contains('error'), false);
    assert.equal(h.elements.get('result').hidden, false);
});

test('a truncated sender retry does not delete a low-confidence legitimate suffix', async () => {
    const h = createHarness({ layout: InvoiceOcrLayout });
    h.ocr.recognizeImpl = async (input, options) => (
        options && options.rectangle
            ? { data: SHOPEE_TRUNCATED_SENDER_RETRY_DATA }
            : { data: SHOPEE_LOW_CONF_SENDER_DATA }
    );

    uploadMockImage(h);
    await flush();

    assert.equal(h.ocr.recognizeCalls.length, 2);
    assert.match(h.elements.get('text').value, /Pengirim: Toko Sinar Jaya/);
    assert.equal(h.elements.get('text').value, SHOPEE_LOW_CONF_SENDER_TEXT);
    assert.equal(h.parser.calls.at(-1), SHOPEE_LOW_CONF_SENDER_TEXT);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
});

test('ordinary invoices never take the Shopee sender re-read', async () => {
    const h = createHarness({ layout: InvoiceOcrLayout });
    h.ocr.recognizeImpl = async () => ({
        data: { text: 'ACME Supplies Ltd.\nINVOICE\nInvoice No: ACME-SHOPEE-1\nShopee Gift Card 1 25.00' },
    });

    uploadMockImage(h, 'invoice.jpg');
    await flush();

    assert.equal(h.ocr.recognizeCalls.length, 1);
    assert.equal(h.ocr.recognizeCalls[0].options, undefined);
    assert.equal(h.elements.get('text').value, 'ACME Supplies Ltd.\nINVOICE\nInvoice No: ACME-SHOPEE-1\nShopee Gift Card 1 25.00');
    assert.equal(h.elements.get('status-text').textContent, 'Done');
});

test('unsupported worker parameters do not fail otherwise valid OCR', async () => {
    const h = createHarness({ layout: InvoiceOcrLayout });
    h.ocr.setParametersImpl = async () => {
        throw new Error('setParameters is unavailable');
    };

    uploadMockImage(h, 'invoice.jpg');
    await flush();

    assert.equal(h.ocr.setParametersCalls.length, 1);
    assert.deepEqual({ ...h.ocr.setParametersCalls[0] }, { preserve_interword_spaces: '1' });
    assert.equal(h.ocr.recognizeCalls.length, 1);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
    assert.equal(h.elements.get('result').hidden, false);
});

test('capture stays disabled until video dimensions and a usable frame are ready', async () => {
    const h = createHarness();
    const stream = makeStream();
    h.media.gum = async () => stream;

    h.elements.get('scan').click();
    await flush();
    assert.equal(h.elements.get('capture').disabled, true);

    const video = h.elements.get('camera-video');
    video.videoWidth = 640;
    video.videoHeight = 360;
    video.readyState = 1;
    video.dispatch('loadedmetadata');
    assert.equal(h.elements.get('capture').disabled, true);

    const canvasCount = h.created.length;
    h.elements.get('capture').click();
    await flush();
    assert.equal(h.created.length, canvasCount, 'an early capture must not create a canvas');
    assert.equal(h.ocr.createWorkerCalls.length, 0);

    video.readyState = 2;
    video.dispatch('canplay');
    assert.equal(h.elements.get('capture').disabled, false);

    h.elements.get('camera-cancel').click();
    assert.equal(stream.track.stopCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);
    assert.equal(h.elements.get('camera-video').srcObject, null);

    // A new session must not trust dimensions left over from the previous stream.
    h.media.gum = async () => makeStream();
    h.elements.get('scan').click();
    await flush();
    assert.equal(video.videoWidth, 640);
    assert.equal(video.readyState, 2);
    assert.equal(h.elements.get('capture').disabled, true);

    h.readyVideo();
    assert.equal(h.elements.get('capture').disabled, false);
    h.elements.get('camera-cancel').click();
});

test('cancelling while permission is pending stops the late stream without opening OCR', async () => {
    const h = createHarness();
    const request = deferred();
    h.media.gum = () => request.promise;

    h.elements.get('scan').click();
    await flush();
    assert.equal(h.media.calls.length, 1);
    assert.equal(h.elements.get('camera').hidden, false);

    h.elements.get('camera-cancel').click();
    assert.equal(h.elements.get('camera').hidden, true);

    const stream = makeStream();
    request.resolve(stream);
    await flush();

    assert.equal(stream.track.stopCount, 1);
    assert.equal(h.elements.get('camera-video').srcObject, null);
    assert.equal(h.elements.get('camera').hidden, true);
    assert.equal(h.elements.get('capture').disabled, true);
    assert.equal(h.ocr.createWorkerCalls.length, 0);
    assert.equal(h.elements.get('result').hidden, true);
});

test('cancelling while play is pending ignores the late play result', async () => {
    const h = createHarness();
    const stream = makeStream();
    h.media.gum = async () => stream;
    const video = h.elements.get('camera-video');
    video.playMode = 'pending';

    h.elements.get('scan').click();
    await flush();
    assert.equal(video.srcObject, stream);
    assert.equal(h.elements.get('capture').disabled, true);

    h.elements.get('camera-cancel').click();
    assert.equal(h.elements.get('camera').hidden, true);
    assert.equal(video.srcObject, null);

    video.resolvePlay();
    await flush();

    assert.equal(stream.track.stopCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);
    assert.equal(h.elements.get('camera-status').textContent, '');
    assert.equal(h.ocr.createWorkerCalls.length, 0);
});

test('cancelling during encoding drops the late blob and never starts OCR', async () => {
    const h = createHarness();
    const stream = makeStream();
    h.media.gum = async () => stream;
    h.document.blobMode = 'manual';

    h.elements.get('scan').click();
    await flush();
    h.readyVideo();
    h.elements.get('capture').click();
    await flush();

    const captureCanvas = h.created.find((element) => element.tagName === 'CANVAS' && element.toBlobCalls.length > 0);
    assert.ok(captureCanvas);
    assert.equal(captureCanvas.pendingBlob instanceof Function, true);
    assert.equal(stream.track.stopCount, 1);
    assert.equal(h.elements.get('camera').hidden, false);

    h.elements.get('capture').click();
    await flush();
    const captureCanvases = h.created.filter((element) => element.tagName === 'CANVAS' && element.toBlobCalls.length > 0);
    assert.equal(captureCanvases.length, 1, 'a second capture must not start while one is encoding');

    h.elements.get('camera-cancel').click();
    assert.equal(h.elements.get('camera').hidden, true);

    captureCanvas.pendingBlob();
    await flush();

    assert.equal(h.ocr.createWorkerCalls.length, 0);
    assert.equal(h.elements.get('result').hidden, true);
    assert.equal(h.elements.get('camera').hidden, true);
    assert.equal(h.elements.get('camera-video').srcObject, null);
});

test('denied camera permission shows guidance and leaves uploads working', async () => {
    const h = createHarness();
    h.media.gum = async () => {
        const error = new Error('Permission denied');
        error.name = 'NotAllowedError';
        throw error;
    };

    h.elements.get('scan').click();
    await flush();

    const cameraStatus = h.elements.get('camera-status');
    assert.equal(h.elements.get('camera').hidden, false);
    assert.match(cameraStatus.textContent, /permission was denied/i);
    assert.match(cameraStatus.textContent, /upload/i);
    assert.equal(cameraStatus.classList.contains('error'), true);
    assert.equal(h.elements.get('capture').disabled, true);
    assert.equal(h.elements.get('camera-video').srcObject, null);

    h.elements.get('drop').click();
    assert.equal(h.elements.get('file').clickCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);

    const upload = new File(['fake image'], 'bill.png', { type: 'image/png' });
    h.elements.get('file').files = [upload];
    h.elements.get('file').dispatch('change');
    await flush();

    assert.equal(h.ocr.createWorkerCalls.length, 1);
    assert.equal(h.elements.get('result').hidden, false);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
});

test('missing or busy camera devices give actionable guidance', async () => {
    const cases = [
        { name: 'NotFoundError', pattern: /No camera was found/i },
        { name: 'NotReadableError', pattern: /unavailable or in use/i },
    ];
    for (const item of cases) {
        const h = createHarness();
        h.media.gum = async () => {
            const error = new Error(item.name);
            error.name = item.name;
            throw error;
        };

        h.elements.get('scan').click();
        await flush();

        const cameraStatus = h.elements.get('camera-status');
        assert.match(cameraStatus.textContent, item.pattern);
        assert.match(cameraStatus.textContent, /upload|photo/i);
        assert.equal(cameraStatus.classList.contains('error'), true);

        h.elements.get('drop').click();
        assert.equal(h.elements.get('file').clickCount, 1);
        assert.equal(h.elements.get('camera').hidden, true);
    }
});

test('unsupported camera API shows guidance and keeps uploads available', async () => {
    const h = createHarness();
    h.navigator.mediaDevices = undefined;

    h.elements.get('scan').click();
    await flush();

    const cameraStatus = h.elements.get('camera-status');
    assert.equal(h.elements.get('camera').hidden, false);
    assert.match(cameraStatus.textContent, /does not support camera capture/i);
    assert.match(cameraStatus.textContent, /upload/i);
    assert.equal(h.elements.get('capture').disabled, true);

    h.elements.get('drop').click();
    assert.equal(h.elements.get('file').clickCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);
});

test('insecure origins get HTTPS/localhost guidance without requesting the camera', async () => {
    const h = createHarness();
    h.window.isSecureContext = false;

    h.elements.get('scan').click();
    await flush();

    const cameraStatus = h.elements.get('camera-status');
    assert.match(cameraStatus.textContent, /HTTPS or localhost/i);
    assert.match(cameraStatus.textContent, /phone/i);
    assert.match(cameraStatus.textContent, /upload/i);
    assert.equal(cameraStatus.classList.contains('error'), true);
    assert.equal(h.media.calls.length, 0);
    assert.equal(h.elements.get('camera').hidden, false);
});

test('pagehide, hidden visibility, Escape and repeated cancels release every stream', async () => {
    const h = createHarness();
    const streams = [];
    h.media.gum = async () => {
        const stream = makeStream();
        streams.push(stream);
        return stream;
    };

    h.elements.get('scan').click();
    await flush();
    assert.equal(streams.length, 1);
    h.fireWindow('pagehide');
    assert.equal(streams[0].track.stopCount, 1);
    assert.equal(h.elements.get('camera-video').srcObject, null);
    assert.equal(h.elements.get('camera').hidden, true);

    h.elements.get('scan').click();
    await flush();
    assert.equal(streams.length, 2);
    h.document.hidden = true;
    h.fireDocument('visibilitychange');
    assert.equal(streams[1].track.stopCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);
    h.document.hidden = false;

    h.elements.get('scan').click();
    await flush();
    assert.equal(streams.length, 3);
    h.fireWindow('keydown', { key: 'Escape' });
    assert.equal(streams[2].track.stopCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);

    h.elements.get('scan').click();
    await flush();
    assert.equal(streams.length, 4);
    h.elements.get('camera-cancel').click();
    assert.equal(streams[3].track.stopCount, 1);
    assert.equal(h.elements.get('camera').hidden, true);
});

test('camera cannot open while a file is already being processed', async () => {
    const h = createHarness();
    const recognition = deferred();
    h.ocr.recognizeImpl = () => recognition.promise;

    const upload = new File(['fake image'], 'busy.png', { type: 'image/png' });
    h.elements.get('file').files = [upload];
    h.elements.get('file').dispatch('change');
    await flush();

    assert.equal(h.elements.get('scan').disabled, true);
    assert.equal(h.ocr.createWorkerCalls.length, 1);

    h.elements.get('scan').click();
    await flush();
    assert.equal(h.media.calls.length, 0);

    recognition.resolve({ data: { text: 'Invoice No: BUSY-1' } });
    await flush();
    assert.equal(h.elements.get('scan').disabled, false);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
});

test('a file upload during pending capture encoding wins without a second OCR run', async () => {
    const h = createHarness();
    const stream = makeStream();
    h.media.gum = async () => stream;
    h.document.blobMode = 'manual';

    h.elements.get('scan').click();
    await flush();
    h.readyVideo();
    h.elements.get('capture').click();
    await flush();

    const captureCanvas = h.created.find((element) => element.tagName === 'CANVAS' && element.toBlobCalls.length > 0);
    assert.ok(captureCanvas);

    const upload = new File(['fake image'], 'upload.png', { type: 'image/png' });
    h.elements.get('file').files = [upload];
    h.elements.get('file').dispatch('change');
    await flush();

    assert.equal(h.ocr.createWorkerCalls.length, 1);
    assert.equal(h.elements.get('camera').hidden, true);

    captureCanvas.pendingBlob();
    await flush();

    assert.equal(h.ocr.createWorkerCalls.length, 1);
    assert.equal(h.ocr.recognizeCalls.length, 1);
    assert.equal(h.elements.get('result').hidden, false);
});
