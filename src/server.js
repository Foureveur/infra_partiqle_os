'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { config } = require('./lib/config');
const { loadRegistry } = require('./lib/cards');
const { sendJson } = require('./lib/http');
const log = require('./lib/log');

const { handleState } = require('./routes/state');
const { handleLayout } = require('./routes/layout');
const { handleIngest } = require('./routes/ingest');
const { serveStatic } = require('./routes/static');

const INGEST_RE = /^\/api\/ingest\/([A-Za-z0-9._-]{1,40})$/;

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // Le registre est relu à chaque requête : les tables du dépôt sont éditables
  // à la main sur la machine, ajouter un lien ne doit pas demander de
  // redémarrer le conteneur (§4.2).
  const registry = loadRegistry();

  const ingest = INGEST_RE.exec(pathname);
  if (ingest) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'méthode non autorisée' });
    return handleIngest(req, res, registry, ingest[1]);
  }

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, at: new Date().toISOString() });
  }

  if (pathname === '/api/state') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'méthode non autorisée' });
    return handleState(req, res, registry);
  }

  if (pathname === '/api/layout') {
    return handleLayout(req, res, registry, method);
  }

  if (method === 'GET' || method === 'HEAD') {
    if (await serveStatic(req, res, pathname)) return;
  }

  return sendJson(res, 404, { error: 'introuvable' });
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    if (res.statusCode >= 400) {
      log.warn('http', { method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - started });
    }
  });
  route(req, res).catch((err) => {
    log.error('unhandled', { path: req.url, error: err.message, stack: err.stack });
    if (!res.headersSent) sendJson(res, 500, { error: 'erreur interne' });
    else res.end();
  });
});

// Une requête qui traîne ne doit pas immobiliser un worker : le service ne fait
// aucun appel sortant, tout ce qu'il sert vient du disque local.
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

async function start() {
  await fsp.mkdir(path.join(config.dataDir, 'machines'), { recursive: true });
  loadRegistry(); // échoue tôt et bruyamment si data/cards.json est cassé
  server.listen(config.port, config.host, () => {
    log.info('listening', {
      port: config.port,
      dataDir: config.dataDir,
      devUser: config.devUser ? 'actif' : 'non',
    });
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.info('shutdown', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

if (require.main === module) {
  start().catch((err) => {
    log.error('start.failed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { server, start };
