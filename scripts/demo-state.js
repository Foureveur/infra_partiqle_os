#!/usr/bin/env node
'use strict';

/**
 * Écrit un state.json de démonstration, pour travailler la page sans l'infra
 * réelle. Volontairement bancal : une source en échec, une machine silencieuse,
 * un conteneur qui redémarre en boucle, une sauvegarde en retard, un moniteur
 * en pause. C'est dans cet état-là qu'une page de supervision doit être jugée —
 * tout en vert, n'importe quelle maquette fait illusion.
 *
 *   INFRA_DATA_DIR=/tmp/infra-data node scripts/demo-state.js
 */

const path = require('node:path');
const { config } = require('../src/lib/config');
const { writeJsonAtomic } = require('../src/lib/io');

const now = Date.now();
const iso = (msAgo = 0) => new Date(now - msAgo).toISOString();
const day = 86400000;

const services = [];
function svc(machine, name, opts = {}) {
  services.push({
    machine,
    name,
    stack: name.split('-')[0],
    image: opts.image || 'library/example:latest',
    state: opts.state || 'running',
    health: opts.health || 'none',
    since: iso(opts.sinceMs ?? 3 * day),
    restarts: opts.restarts ?? 0,
    url: opts.url || null,
  });
}

svc('vps-core', 'studio-os-caddy-1', { image: 'caddy:2', health: 'healthy' });
svc('vps-core', 'studio-os-authelia-1', { image: 'authelia/authelia:4', url: 'https://auth.partiqle.studio' });
svc('vps-core', 'studio-os-glitchtip-web-1', { image: 'glitchtip/glitchtip:latest', url: 'https://bugs.partiqle.studio' });
svc('vps-core', 'studio-os-uptime-kuma-1', { image: 'louislam/uptime-kuma:1', url: 'https://status.partiqle.studio', health: 'healthy' });
svc('vps-core', 'studio-os-roadmaps-1', { image: 'partiqle/roadmaps:1.4', url: 'https://roadmaps.partiqle.studio' });
svc('vps-core', 'studio-os-noma-1', { image: 'partiqle/noma:0.9', url: 'https://noma.partiqle.studio' });
svc('vps-core', 'studio-os-n8n-1', { image: 'n8nio/n8n:1', url: 'https://n8n.partiqle.studio' });
svc('vps-core', 'studio-os-naming-1', { image: 'partiqle/naming:1' });
svc('vps-core', 'studio-os-mcp-wp-1', { image: 'partiqle/mcp-wp:2', restarts: 7, sinceMs: 400000 });
svc('vps-core', 'studio-os-templates-1', { image: 'partiqle/templates:1', state: 'exited', sinceMs: 2 * 3600000 });
svc('vps-saas-01', 'immomap-app-1', { image: 'partiqle/immomap:3', url: 'https://app.immomap.partiqle.studio' });
svc('vps-saas-01', 'immomap-db-1', { image: 'postgres:16', health: 'healthy' });
svc('vps-saas-01', 'spacia-web-1', { image: 'partiqle/spacia:0.4', health: 'unhealthy' });
svc('vps-clients-01', 'cpts-web-1', { image: 'wordpress:6' });
svc('vps-clients-01', 'cpts-db-1', { image: 'mariadb:11', health: 'healthy' });

const machines = [
  {
    id: 'vps-core',
    reportedAt: iso(90_000),
    hostname: 'srv-core',
    ip: '76.13.53.158',
    up: true,
    uptimeSeconds: 41 * 86400 + 7200,
    load: [0.42, 0.51, 0.48],
    memPct: 63.4,
    diskPct: 71,
    diskFreeGB: 22.8,
    containers: { running: 9, total: 10 },
    containersUnhealthy: [],
    rebootRequired: true,
    dockerAvailable: true,
  },
  {
    id: 'vps-clients-01',
    reportedAt: iso(120_000),
    hostname: 'srv-clients-01',
    ip: '82.29.14.7',
    up: true,
    uptimeSeconds: 12 * 86400,
    load: [0.18, 0.22, 0.2],
    memPct: 41.2,
    diskPct: 44,
    diskFreeGB: 61.5,
    containers: { running: 2, total: 2 },
    containersUnhealthy: [],
    rebootRequired: false,
    dockerAvailable: true,
  },
  {
    id: 'vps-saas-01',
    reportedAt: iso(150_000),
    hostname: 'srv-saas-01',
    ip: '82.29.11.42',
    up: true,
    uptimeSeconds: 3 * 86400,
    load: [1.62, 1.44, 1.2],
    memPct: 88.7,
    diskPct: 91,
    diskFreeGB: 3.1,
    containers: { running: 3, total: 3 },
    containersUnhealthy: ['spacia-web-1'],
    rebootRequired: false,
    dockerAvailable: true,
  },
  // Silencieuse depuis 40 min : elle doit apparaître INCONNUE, pas en panne,
  // et surtout pas en bonne santé.
  {
    id: 'vps-lab',
    reportedAt: iso(40 * 60_000),
    hostname: 'srv-lab',
    ip: '82.29.9.15',
    up: true,
    uptimeSeconds: 88 * 86400,
    load: [0.05, 0.04, 0.01],
    memPct: 22.0,
    diskPct: 38,
    diskFreeGB: 95.2,
    containers: { running: 0, total: 4 },
    containersUnhealthy: [],
    rebootRequired: false,
    dockerAvailable: true,
  },
];

const state = {
  schema: 1,
  collectedAt: iso(60_000),
  sources: {
    machines: { ok: true, at: iso(60_000), error: null },
    kuma: { ok: true, at: iso(65_000), error: null },
    glitchtip: { ok: true, at: iso(70_000), error: null },
    roadmaps: { ok: true, at: iso(8 * 60_000), error: null },
    // Une source en échec : la carte doit passer en inconnu, pas en rouge.
    hostinger: { ok: false, at: iso(52 * 60_000), error: '429 rate limited' },
    // `at` = heure de la dernière LECTURE réussie de backups.json par le
    // collecteur, pas l'heure de la sauvegarde : celle-ci est dans finishedAt.
    backups: { ok: true, at: iso(62_000), error: null },
  },
  machines,
  services,
  projects: [
    {
      id: 'uJX9s8vLrGbvPSWK1q17e',
      title: 'Rationalisation Infra Partiqle',
      section: 'Studio',
      url: 'https://roadmaps.partiqle.studio/r/uJX9s8vLrGbvPSWK1q17e',
      updatedAt: iso(30 * 60_000),
      counts: { now: 8, next: 9, later: 6, ideas: 2 },
      progress: { subtasksDone: 214, subtasksTotal: 301 },
      blocked: 1,
      nextMarker: { date: '2026-09-05', label: 'SiteGround — renouvellement automatique' },
    },
    {
      id: 'kL2p9vQwErTyUiOpAsDfG',
      title: 'immomap — v2',
      section: 'Produits',
      url: 'https://roadmaps.partiqle.studio/r/kL2p9vQwErTyUiOpAsDfG',
      updatedAt: iso(2 * day),
      counts: { now: 4, next: 11, later: 8, ideas: 5 },
      progress: { subtasksDone: 61, subtasksTotal: 180 },
      blocked: 0,
      nextMarker: { date: '2026-10-09', label: 'Agent d’infra' },
    },
    {
      id: 'zX1c2v3b4n5m6qwertyu',
      title: 'Parc WordPress managé',
      section: 'Clients',
      url: 'https://roadmaps.partiqle.studio/r/zX1c2v3b4n5m6qwertyu',
      updatedAt: iso(5 * day),
      counts: { now: 3, next: 2, later: 4, ideas: 0 },
      progress: { subtasksDone: 28, subtasksTotal: 44 },
      blocked: 0,
      nextMarker: { date: '2026-09-16', label: 'Parc WP 100 % managé' },
    },
  ],
  deadlines: [
    { date: '2026-10-11', label: 'Expiration altais-montreuil.fr', kind: 'registrar', project: null },
    { date: '2026-11-23', label: 'Expiration plan Business Hostinger', kind: 'registrar', project: null },
    { date: '2026-09-05', label: 'SiteGround — renouvellement automatique', kind: 'milestone', project: 'Rationalisation Infra Partiqle' },
    { date: '2026-09-11', label: 'Core isolé', kind: 'milestone', project: 'Rationalisation Infra Partiqle' },
    { date: '2026-09-16', label: 'Parc WP 100 % managé', kind: 'milestone', project: 'Parc WordPress managé' },
    { date: '2026-09-18', label: 'Backups testés', kind: 'milestone', project: 'Rationalisation Infra Partiqle' },
    { date: '2026-10-05', label: 'FIN SITEGROUND', kind: 'milestone', project: 'Rationalisation Infra Partiqle' },
    { date: '2026-10-09', label: 'Agent d’infra', kind: 'milestone', project: 'Rationalisation Infra Partiqle' },
    { date: '2026-10-15', label: 'Messagerie hollow.immo', kind: 'milestone', project: null },
    { date: '2026-11-06', label: 'Mise en ligne de infra.partiqle.studio', kind: 'milestone', project: 'Rationalisation Infra Partiqle' },
  ],
  incidents: {
    kuma: {
      pausedDetection: true,
      monitors: [
        { name: 'os.partiqle.studio', url: 'https://os.partiqle.studio', up: true, uptime24h: 1, uptime30d: 0.9993, avgResponseMs: 142, paused: false, downSince: null },
        { name: 'roadmaps.partiqle.studio', url: 'https://roadmaps.partiqle.studio', up: true, uptime24h: 1, uptime30d: 0.9987, avgResponseMs: 210, paused: false, downSince: null },
        { name: 'bugs.partiqle.studio', url: 'https://bugs.partiqle.studio', up: true, uptime24h: 0.998, uptime30d: 0.997, avgResponseMs: 320, paused: false, downSince: null },
        { name: 'templates.partiqle.studio', url: 'https://templates.partiqle.studio', up: false, uptime24h: 0.91, uptime30d: 0.985, avgResponseMs: null, paused: false, downSince: iso(2 * 3600_000) },
        { name: 'mcp-spacia', url: 'https://mcp-spacia.partiqle.studio', up: true, uptime24h: 1, uptime30d: 0.999, avgResponseMs: 88, paused: false, downSince: null },
        // Un moniteur en pause n'est pas vert : c'est un trou de couverture.
        { name: 'bookforger-staging.partiqle.studio', url: 'https://bookforger-staging.partiqle.studio', up: null, uptime24h: null, uptime30d: null, avgResponseMs: null, paused: true, downSince: null },
      ],
    },
    glitchtip: {
      unresolvedTotal: 14,
      count24h: 96,
      count7d: 210,
      surge: true,
      surgeRatio: 3.2,
      perProject: [
        { project: 'immomap', count: 9 },
        { project: 'roadmaps', count: 3 },
        { project: 'noma', count: 2 },
      ],
      recent: [
        { title: 'TypeError: cannot read property "id" of undefined', project: 'immomap', lastSeen: iso(8 * 60_000), count: 41, url: 'https://bugs.partiqle.studio/immomap/issues/1' },
        { title: 'Timeout calling /api/search', project: 'immomap', lastSeen: iso(24 * 60_000), count: 28, url: 'https://bugs.partiqle.studio/immomap/issues/2' },
        { title: 'IntegrityError: duplicate key value', project: 'roadmaps', lastSeen: iso(70 * 60_000), count: 12, url: 'https://bugs.partiqle.studio/roadmaps/issues/3' },
        { title: 'Unhandled rejection in worker', project: 'noma', lastSeen: iso(3 * 3600_000), count: 9, url: 'https://bugs.partiqle.studio/noma/issues/4' },
        { title: '502 from upstream mcp-wp', project: 'roadmaps', lastSeen: iso(5 * 3600_000), count: 6, url: 'https://bugs.partiqle.studio/roadmaps/issues/5' },
      ],
    },
    crowdsec: [
      { machine: 'vps-core', available: true, activeDecisions: 47, recentBans: [
        { ip: '185.220.101.4', scenario: 'http-probing', until: iso(-4 * 3600_000) },
        { ip: '45.155.205.233', scenario: 'ssh-bf', until: iso(-2 * 3600_000) },
      ] },
      { machine: 'vps-clients-01', available: true, activeDecisions: 12, recentBans: [] },
      { machine: 'vps-saas-01', available: false, activeDecisions: null, recentBans: [] },
      { machine: 'vps-lab', available: false, activeDecisions: null, recentBans: [] },
    ],
  },
  backups: [
    { target: 'vps-core', repo: 'restic:sftp:backup@storage:/core', finishedAt: iso(7 * 3600_000), ok: true, snapshotId: 'a1b2c3d4', sizeBytes: 4123456789, durationSec: 412, message: null },
    { target: 'vps-clients-01', repo: 'restic:sftp:backup@storage:/clients', finishedAt: iso(29 * 3600_000), ok: true, snapshotId: 'ff31aa02', sizeBytes: 8891234567, durationSec: 903, message: null },
    // Plus de 50 h : rouge. Et un message qui dit pourquoi.
    { target: 'vps-saas-01', repo: 'restic:sftp:backup@storage:/saas', finishedAt: iso(56 * 3600_000), ok: false, snapshotId: null, sizeBytes: null, durationSec: 61, message: 'repository locked by another process' },
  ],
};

writeJsonAtomic(path.join(config.dataDir, 'state.json'), state)
  .then(() => console.log('state.json de démonstration écrit dans', config.dataDir))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
