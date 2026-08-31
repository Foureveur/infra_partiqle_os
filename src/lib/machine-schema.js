'use strict';

/**
 * Normalise un rapport poussé par une machine (§3.2bis).
 *
 * Principe : liste blanche stricte. Ce qui n'est pas décrit ici n'entre pas dans
 * state.json. Une machine ne doit pouvoir écrire que sa propre ligne, et rien
 * d'autre que des champs prévus — c'est la contrepartie d'un endpoint hors
 * Authelia.
 */

const MAX_SERVICES = 500;
const MAX_UNHEALTHY = 100;
const MAX_BANS = 20;
const STATES = new Set(['running', 'exited', 'restarting', 'created', 'paused', 'dead', 'removing']);
const HEALTHS = new Set(['healthy', 'unhealthy', 'starting', 'none']);

class SchemaError extends Error {}

function str(v, max = 200) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function num(v, min = -1e12, max = 1e12) {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return Math.round(n * 100) / 100;
}

function int(v, min = 0, max = 1e12) {
  const n = typeof v === 'number' ? Math.trunc(v) : Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function bool(v) {
  return v === true ? true : v === false ? false : null;
}

function isoDate(v) {
  const s = str(v, 40);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalizeService(raw, machineId) {
  if (!raw || typeof raw !== 'object') return null;
  const name = str(raw.name, 120);
  if (!name) return null;
  const state = str(raw.state, 20);
  const health = str(raw.health, 20);
  return {
    machine: machineId,
    name,
    stack: str(raw.stack, 60),
    image: str(raw.image, 200),
    state: state && STATES.has(state) ? state : 'unknown',
    health: health && HEALTHS.has(health) ? health : 'none',
    since: isoDate(raw.since),
    restarts: int(raw.restarts, 0, 1e6) ?? 0,
  };
}

function normalizeCrowdsec(raw) {
  if (!raw || typeof raw !== 'object') return { available: false, activeDecisions: null, recentBans: [] };
  // cscli absent = source ABSENTE, pas source en erreur (§3.7).
  if (raw.available !== true) {
    return { available: false, activeDecisions: null, recentBans: [] };
  }
  const bans = Array.isArray(raw.recentBans) ? raw.recentBans.slice(0, MAX_BANS) : [];
  return {
    available: true,
    activeDecisions: int(raw.activeDecisions, 0, 1e7),
    recentBans: bans
      .map((b) => (b && typeof b === 'object'
        ? { ip: str(b.ip, 60), scenario: str(b.scenario, 120), until: str(b.until, 40) }
        : null))
      .filter((b) => b && b.ip),
  };
}

/**
 * @param {string} machineId  machine visée par l'URL — fait autorité sur tout
 *                            ce que la charge utile pourrait prétendre.
 */
function normalizeReport(raw, machineId) {
  if (!raw || typeof raw !== 'object') throw new SchemaError('corps JSON attendu');

  const m = raw.machine && typeof raw.machine === 'object' ? raw.machine : {};
  const load = Array.isArray(m.load) ? m.load.slice(0, 3).map((v) => num(v, 0, 10000)) : [];

  const services = Array.isArray(raw.services)
    ? raw.services.slice(0, MAX_SERVICES).map((s) => normalizeService(s, machineId)).filter(Boolean)
    : [];

  const unhealthy = Array.isArray(m.containersUnhealthy)
    ? m.containersUnhealthy.slice(0, MAX_UNHEALTHY).map((v) => str(v, 120)).filter(Boolean)
    : [];

  const containers = m.containers && typeof m.containers === 'object'
    ? { running: int(m.containers.running, 0, 1e5), total: int(m.containers.total, 0, 1e5) }
    : { running: null, total: null };

  return {
    // L'horodatage vient du serveur : une machine dont l'horloge dérive ne doit
    // pas pouvoir se déclarer éternellement fraîche — ni éternellement périmée.
    reportedAt: new Date().toISOString(),
    reporterClaimedAt: isoDate(raw.reportedAt),
    machine: {
      id: machineId,
      hostname: str(m.hostname, 120),
      ip: str(m.ip, 60),
      up: true, // la pousse est arrivée : par construction, la machine répond.
      uptimeSeconds: int(m.uptimeSeconds, 0, 1e10),
      load: load.length === 3 && load.every((v) => v !== null) ? load : null,
      memPct: num(m.memPct, 0, 100),
      diskPct: num(m.diskPct, 0, 100),
      diskFreeGB: num(m.diskFreeGB, 0, 1e7),
      containers,
      containersUnhealthy: unhealthy,
      rebootRequired: bool(m.rebootRequired) ?? false,
      dockerAvailable: bool(m.dockerAvailable) ?? services.length > 0,
      agentVersion: str(raw.agentVersion, 40),
    },
    services,
    crowdsec: normalizeCrowdsec(raw.crowdsec),
  };
}

module.exports = { normalizeReport, SchemaError };
