'use strict';

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function sendEmpty(res, status) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

class BodyTooLarge extends Error {}

/**
 * Lit un corps JSON en refusant tôt ce qui dépasse la limite : sur une route
 * exposée sans Authelia, on ne met pas en mémoire ce qu'on n'a pas l'intention
 * de traiter.
 */
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number.parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLarge('corps trop volumineux'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge('corps trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new SyntaxError('JSON invalide'));
      }
    });
  });
}

/** Adresse cliente : X-Forwarded-For posé par Caddy, sinon la socket. */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim().slice(0, 60);
  return (req.socket && req.socket.remoteAddress) || 'inconnu';
}

module.exports = { sendJson, sendEmpty, readJsonBody, clientIp, BodyTooLarge };
