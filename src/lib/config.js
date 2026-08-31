'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function str(name, fallback = null) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const config = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),

  // Tables statiques du dépôt (machines, plateformes, liens, registre de
  // cartes). Montées en LECTURE SEULE dans le conteneur, pour qu'ajouter un
  // lien reste une édition de fichier et non une reconstruction d'image (§4.2).
  tablesDir: path.resolve(str('INFRA_TABLES_DIR', path.join(ROOT, 'data'))),

  // Données produites à l'exécution : state.json, layout.<user>.json,
  // machines/<machine>.json. Volume ./data/infra du compose.
  //
  // Attention : ce n'est PAS /app/data comme l'écrit le brief §7. Les deux
  // répertoires entreraient en collision — les tables du dépôt vivent déjà dans
  // data/, et le volume les masquerait. Le compose fourni monte donc les tables
  // sur /app/data:ro et l'état sur /app/var.
  dataDir: path.resolve(str('INFRA_DATA_DIR', '/app/var')),

  port: int('PORT', 3000),
  host: str('INFRA_HOST', '0.0.0.0'),

  // Verrou interne du collecteur. Dans le volume de données, donc partagé
  // entre l'hôte et le conteneur quelle que soit la façon de lancer la collecte.
  lockPath: str('INFRA_LOCK_PATH', null),

  // Une machine silencieuse depuis plus de ça est INCONNUE, pas en bonne santé.
  // La pousse est en */5 : 15 min laissent passer deux ratés avant l'alerte.
  machineStaleSeconds: int('MACHINE_STALE_SECONDS', 900),
  // Idem pour l'ensemble du fichier : au-delà, bandeau « données figées ».
  stateStaleSeconds: int('STATE_STALE_SECONDS', 900),

  // Budget de fraîcheur PAR SOURCE — trois fois sa cadence (§3.9). Un seuil
  // unique déclarerait Roadmaps (15 min) et Hostinger (30 min) périmées à
  // chaque cycle, et on apprendrait à ignorer le gris : c'est exactement ce
  // qui rend une page de supervision inutile.
  sourceBudgets: {
    machines: int('BUDGET_MACHINES', 900),
    kuma: int('BUDGET_KUMA', 900),
    glitchtip: int('BUDGET_GLITCHTIP', 900),
    backups: int('BUDGET_BACKUPS', 900),
    roadmaps: int('BUDGET_ROADMAPS', 2700),
    hostinger: int('BUDGET_HOSTINGER', 5400),
  },

  backupWarnSeconds: int('BACKUP_WARN_SECONDS', 26 * 3600),
  backupCritSeconds: int('BACKUP_CRIT_SECONDS', 50 * 3600),

  // Seuil sous lequel on refuse d'écrire une disposition : le mobile passe en
  // une colonne et n'a rien à dire de la disposition bureau (§5.2).
  minLayoutViewport: int('MIN_LAYOUT_VIEWPORT', 768),
  maxIngestBytes: int('MAX_INGEST_BYTES', 256 * 1024),
  maxLayoutBytes: int('MAX_LAYOUT_BYTES', 128 * 1024),

  // Développement uniquement : en production l'utilisateur vient de Remote-User,
  // poussé par Authelia. Laisser vide en production.
  devUser: str('INFRA_DEV_USER', null),

  kuma: {
    statusUrl: str('KUMA_STATUS_URL', 'http://uptime-kuma:3001'),
    statusSlug: str('KUMA_STATUS_SLUG', null),
    metricsUrl: str('KUMA_METRICS_URL', null),
    apiKey: str('KUMA_API_KEY', null),
  },
  glitchtip: {
    baseUrl: str('GLITCHTIP_URL', 'http://glitchtip-web:8000'),
    org: str('GLITCHTIP_ORG', null),
    token: str('GLITCHTIP_TOKEN', null),
  },
  roadmaps: {
    summaryUrl: str('ROADMAPS_SUMMARY_URL', 'https://roadmaps.partiqle.studio/api/v1/infra/summary'),
    token: str('ROADMAPS_TOKEN', null),
  },
  hostinger: {
    baseUrl: str('HOSTINGER_URL', 'https://developers.hostinger.com'),
    token: str('HOSTINGER_TOKEN', null),
  },
};

if (!config.lockPath) config.lockPath = path.join(config.dataDir, '.collector.lock');

// Jetons de pousse : un par machine, INFRA_PUSH_TOKEN_VPS_CORE, …
// Ils ne transitent jamais par la page ; ils ne sont lus que par la route d'ingestion.
function pushTokenFor(machineId) {
  const key = 'INFRA_PUSH_TOKEN_' + machineId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return str(key, null);
}

module.exports = { config, pushTokenFor };
