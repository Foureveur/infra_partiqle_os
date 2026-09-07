'use strict';

const path = require('node:path');
const { config } = require('../lib/config');
const { readJsonSync } = require('../lib/io');
const { acquire } = require('../collector/lock');
const log = require('../lib/log');
const { fetchJson, fetchWithTimeout } = require('../collector/fetch');
const { probeUrl } = require('./fingerprint');

/**
 * Sondes de méta projet — vérifier ce que Roadmaps déclare.
 *
 * Séparé du collecteur, et délibérément. Le collecteur RASSEMBLE : il lit des
 * sources et écrit un état local, sans jamais rien affirmer au dehors. Cette
 * sonde-ci fait l'inverse — elle sort, constate, et ÉCRIT dans un autre outil.
 * Deux métiers, deux entrées, deux cadences : mêler les deux ferait qu'une
 * page de supervision de 5 minutes irait marteler les sites clients.
 *
 * Roadmaps reste propriétaire de la donnée. On ne lui envoie que des
 * observations, par la route qui ne peut pas toucher aux déclarations. Si
 * cette sonde se trompe, elle produit un écart visible — jamais une vérité
 * silencieuse. C'est toute la différence avec le CLAUDE.md de Spacia qui
 * décrivait une infrastructure disparue.
 */

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry-run');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

/** Une pause entre deux sites : on sonde des projets clients, pas une cible. */
const DELAY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadRoadmaps() {
  if (!config.roadmaps.token) throw new Error('ROADMAPS_TOKEN absent');
  const payload = await fetchJson(config.roadmaps.summaryUrl, {
    headers: { Authorization: `Bearer ${config.roadmaps.token}`, Accept: 'application/json' },
    timeoutMs: 15_000,
  });
  return Array.isArray(payload.roadmaps) ? payload.roadmaps : [];
}

/** Base de l'API Roadmaps, déduite de l'URL de synthèse déjà configurée. */
function apiBase() {
  const u = new URL(config.roadmaps.summaryUrl);
  return `${u.origin}/api/v1`;
}

async function report(roadmapId, body) {
  const res = await fetchWithTimeout(`${apiBase()}/roadmaps/${roadmapId}/meta/probe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.roadmaps.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''}`.trim());
  return res.json();
}

async function run() {
  const lockPath = path.join(config.dataDir, '.probes.lock');
  const lock = await acquire(lockPath);
  if (!lock.ok) {
    log.warn('probes.locked', { message: 'une campagne de sondage est déjà en cours — abandon' });
    process.exitCode = 75;
    return;
  }

  try {
    const machines = readJsonSync(path.join(config.tablesDir, 'machines.json'), []) || [];
    const roadmaps = await loadRoadmaps();
    const started = Date.now();
    let probed = 0;
    let reported = 0;
    const drifts = [];

    for (const r of roadmaps) {
      if (ONLY && r.id !== ONLY && r.title !== ONLY) continue;

      // On ne sonde que ce qui a été DÉCLARÉ. Une sonde qui découvrirait des
      // environnements inventerait la structure du projet ; Roadmaps refuse
      // d'ailleurs de les créer, et c'est la bonne règle.
      const envs = (r.meta?.environments || []).filter((e) => e.value);
      if (!envs.length) continue;

      const observations = [];
      for (const env of envs) {
        if (probed) await sleep(DELAY_MS);
        const seen = await probeUrl(env.value, machines);
        probed++;
        observations.push({ name: env.name, seen });
        log.info('probes.seen', {
          roadmap: r.title,
          env: env.name,
          reachable: seen.reachable,
          status: seen.status,
          machine: seen.machine,
          provider: seen.provider,
          primary: seen.primary,
          error: seen.error || null,
        });
      }

      // La prod fait autorité pour l'hébergement du projet : c'est elle qui
      // décrit où le projet VIT. Un staging sur une autre machine est normal
      // et ne doit pas déclencher un écart sur `hosting`.
      const prod = observations.find((o) => o.name === 'prod') || observations[0];
      const body = {
        probe: 'infra-fingerprint',
        observedAt: new Date().toISOString(),
        environments: observations
          .filter((o) => o.seen.reachable)
          .map((o) => ({ name: o.name, url: o.seen.url })),
      };

      // Chaque champ n'est envoyé QUE si la sonde a conclu. Un `null` ici
      // vaudrait « j'ai regardé et il n'y a rien », ce qui est faux : la
      // plupart du temps c'est « je n'ai pas su dire ».
      const hosting = {};
      if (prod?.seen.machine) hosting.machine = prod.seen.machine;
      if (prod?.seen.provider) hosting.provider = prod.seen.provider;
      if (Object.keys(hosting).length) body.hosting = hosting;

      if (prod?.seen.primary) body.stack = { primary: prod.seen.primary };

      if (DRY) {
        log.info('probes.dry', { roadmap: r.title, body });
        continue;
      }
      if (!body.hosting && !body.stack && !body.environments.length) continue;

      try {
        const out = await report(r.id, body);
        reported++;
        if (out.drift?.length) drifts.push({ roadmap: r.title, fields: out.drift });
      } catch (err) {
        log.warn('probes.report_failed', { roadmap: r.title, error: err.message });
      }
    }

    log.info('probes.done', {
      ms: Date.now() - started,
      roadmaps: roadmaps.length,
      probed,
      reported,
      drifts,
    });

    // Les écarts sont la sortie utile de ce script. On les nomme dans le
    // journal, à charge du tableau de bord de les afficher ensuite.
    for (const d of drifts) log.warn('probes.drift', d);
  } finally {
    await lock.release();
  }
}

if (require.main === module) {
  run().catch((err) => {
    log.error('probes.failed', { error: err.message });
    process.exitCode = 1;
  });
}

module.exports = { run };
