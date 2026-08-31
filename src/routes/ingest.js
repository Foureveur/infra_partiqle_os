'use strict';

const path = require('node:path');
const { config } = require('../lib/config');
const { checkPushToken } = require('../lib/auth');
const { writeJsonAtomic } = require('../lib/io');
const { normalizeReport, SchemaError } = require('../lib/machine-schema');
const { sendJson, sendEmpty, readJsonBody, clientIp, BodyTooLarge } = require('../lib/http');
const { createLimiter } = require('../lib/ratelimit');
const log = require('../lib/log');

const limiter = createLimiter({ capacity: 12, refillPerSecond: 0.2 });

/**
 * POST /api/ingest/<machine> — le seul point d'entrée hors Authelia (§3.2bis.4).
 *
 * Il est donc traité comme exposé : écriture seule, chemin fixe, jeton par
 * machine, corps plafonné, aucune réponse avec du contenu. Le jeton de vps-lab
 * ne peut pas écrire l'état de vps-core — la machine visée par l'URL fait
 * autorité, et le jeton doit correspondre à CETTE machine.
 */
async function handleIngest(req, res, registry, machineId) {
  const ip = clientIp(req);

  const known = registry.cards.some((c) => c.type === 'machine' && c.machine === machineId);
  if (!known) {
    log.warn('ingest.unknown_machine', { machine: machineId.slice(0, 40), ip });
    return sendJson(res, 404, { error: 'machine inconnue' });
  }

  if (!limiter(`${ip}:${machineId}`)) {
    log.warn('ingest.rate_limited', { machine: machineId, ip });
    return sendJson(res, 429, { error: 'trop de requêtes' });
  }

  const auth = checkPushToken(req, machineId);
  if (!auth.ok) {
    // On ne dit pas au client lequel des deux a échoué, et on ne journalise
    // jamais la valeur présentée.
    log.warn('ingest.rejected', { machine: machineId, ip, reason: auth.reason });
    return sendJson(res, 401, { error: 'non autorisé' });
  }

  let body;
  try {
    body = await readJsonBody(req, config.maxIngestBytes);
  } catch (err) {
    if (err instanceof BodyTooLarge) return sendJson(res, 413, { error: 'corps trop volumineux' });
    return sendJson(res, 400, { error: 'JSON invalide' });
  }

  let report;
  try {
    report = normalizeReport(body, machineId);
  } catch (err) {
    if (err instanceof SchemaError) return sendJson(res, 400, { error: err.message });
    throw err;
  }

  const file = path.join(config.dataDir, 'machines', `${machineId}.json`);
  await writeJsonAtomic(file, report);
  log.info('ingest.accepted', {
    machine: machineId,
    services: report.services.length,
    crowdsec: report.crowdsec.available,
  });

  // Pas de corps : rien à renvoyer à un client non authentifié par Authelia.
  return sendEmpty(res, 204);
}

module.exports = { handleIngest };
