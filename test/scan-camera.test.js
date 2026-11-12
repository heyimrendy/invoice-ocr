'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

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

function createHarness() {
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
        recognizeImpl: async () => ({ data: { text: 'Invoice No: SCAN-1\nTotal $10.00' } }),
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
                async recognize(input) {
                    ocr.recognizeCalls.push(input);
                    return ocr.recognizeImpl(input);
                },
                async terminate() {},
            };
        },
    };

    const InvoiceParser = {
        parseInvoice() {
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
    assert.equal(h.ocr.recognizeCalls.length, 1);
    assert.equal(h.elements.get('result').hidden, false);
    assert.equal(h.elements.get('status-text').textContent, 'Done');
    assert.ok(h.elements.get('json').textContent.length > 0);
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
