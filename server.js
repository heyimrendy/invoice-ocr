'use strict';

/**
 * Minimal static file server for ./public (no dependencies).
 * Usage: node server.js   (set PORT to change the port, default 3000)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/** @type {Record<string, string>} */
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function sendText(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
}

const server = http.createServer((req, res) => {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
        sendText(res, 400, 'Bad request');
        return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, relative);

    // Never serve anything outside ./public.
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
        sendText(res, 403, 'Forbidden');
        return;
    }
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) {
        sendText(res, 404, 'Not found');
        return;
    }
    fs.readFile(file, (error, data) => {
        if (error) {
            sendText(res, error.code === 'ENOENT' ? 404 : 500, error.code === 'ENOENT' ? 'Not found' : 'Could not read file');
            return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Invoice OCR running at http://localhost:${PORT}`);
});
