// Copyright 2026 DeepL SE (https://www.deepl.com)
// Use of this source code is governed by an MIT
// license that can be found in the LICENSE file.

const https = require('https');
const http = require('http');

const BASE_URL = process.env.DEEPL_SERVER_URL || 'http://localhost:3000';
const AUTH_KEY = process.env.DEEPL_AUTH_KEY || 'test:fx';

// Sends an authenticated GET request and returns { status, data }.
// data is the parsed JSON body on 200, null otherwise.
function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'languages-test',
          Authorization: `DeepL-Auth-Key ${AUTH_KEY}`,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = body ? JSON.parse(body) : null; } catch { data = null; }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Sends an authenticated POST with a JSON body and returns { status, data }.
// data is the parsed JSON body when there is one, null otherwise.
function post(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'User-Agent': 'languages-test',
          Authorization: `DeepL-Auth-Key ${AUTH_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = responseBody ? JSON.parse(responseBody) : null; } catch { data = null; }
          resolve({ status: res.statusCode, data });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { get, post };
