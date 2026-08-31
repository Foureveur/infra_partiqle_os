'use strict';

const crypto = require('node:crypto');
const { config, pushTokenFor } = require('./config');

const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;

/**
 * L'utilisateur vient de l'en-tête Remote-User poussé par Authelia
 * (copy_headers dans le Caddyfile), jamais d'un paramètre client (§5.1).
 *
 * Caddy remplace cet en-tête par la réponse d'Authelia sur les routes couvertes
 * par forward_auth, donc un client ne peut pas le forger là où il compte. La
 * seule route hors Authelia est /api/ingest/*, qui ne lit jamais Remote-User.
 *
 * Renvoie null si l'en-tête est absent ou invalide : en production on répond
 * alors 401 plutôt que de servir la disposition d'un utilisateur par défaut.
 */
function remoteUser(req) {
  const raw = req.headers['remote-user'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && USER_RE.test(value)) return value;
  if (config.devUser && USER_RE.test(config.devUser)) return config.devUser;
  return null;
}

/** Comparaison à temps constant, tolérante aux longueurs différentes. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Vérifie le jeton de pousse d'une machine. Le jeton est lié à la machine :
 * celui de vps-lab ne peut pas écrire l'état de vps-core (§3.2bis.3).
 */
function checkPushToken(req, machineId) {
  const expected = pushTokenFor(machineId);
  if (!expected) return { ok: false, reason: 'aucun jeton configuré pour cette machine' };

  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return { ok: false, reason: 'en-tête Authorization absent' };
  }
  const presented = header.slice(7).trim();
  if (!presented || !safeEqual(presented, expected)) {
    return { ok: false, reason: 'jeton refusé' };
  }
  return { ok: true };
}

module.exports = { remoteUser, checkPushToken, safeEqual };
