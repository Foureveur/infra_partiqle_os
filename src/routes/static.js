'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { config } = require('../lib/config');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Politique de sécurité du contenu : tout vient de cette origine, rien d'autre.
 * C'est ce qui garantit mécaniquement le point de recette « la page se charge
 * sans requête sortante depuis le navigateur » — et pas seulement par
 * discipline d'écriture.
 *
 * `style-src` accepte les styles en ligne, et seulement lui : GridStack
 * positionne chaque carte par un attribut `style`, une grille pilotable sans
 * style en ligne n'existe pas. Ce qui compte ici reste verrouillé —
 * `script-src 'self'` interdit tout script injecté, `connect-src 'self'`
 * interdit toute requête sortante, et un style ne peut exfiltrer nulle part.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(config.publicDir, path.normalize(rel));

  // Après normalisation, tout ce qui sort de public/ est refusé.
  if (!full.startsWith(config.publicDir + path.sep) && full !== config.publicDir) {
    res.writeHead(403).end();
    return true;
  }

  let data;
  try {
    const stat = await fsp.stat(full);
    if (!stat.isFile()) return false;
    data = await fsp.readFile(full);
  } catch {
    return false;
  }

  const ext = path.extname(full).toLowerCase();
  const immutable = rel.startsWith('/vendor/');
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(data);
  return true;
}

module.exports = { serveStatic, CSP };
