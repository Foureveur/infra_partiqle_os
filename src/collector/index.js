#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { config } = require('../lib/config');
const { readJson, writeJsonAtomic } = require('../lib/io');
const log = require('../lib/log');
const { acquire } = require('./lock');

const machinesSource = require('./sources/machines');
const kumaSource = require('./sources/kuma');
const glitchtipSource = require('./sources/glitchtip');
const roadmapsSource = require('./sources/roadmaps');
const hostingerSource = require('./sources/hostinger');
const backupsSource = require('./sources/backups');

/**
 * Collecteur — un seul cron toutes les 5 minutes, qui décide en interne quelles
 * sources sont dues (§3.9). Écriture atomique d'un unique state.json.
 *
 * Deux invariants tiennent tout le reste :
 *  1. Une source qui échoue n'emporte pas les autres, et ne devient jamais
 *     verte : on garde son dernier bloc bon, avec ok=false et l'erreur.
 *  2. Le fichier ne contient que des horodatages. C'est le service qui décide
 *     de la péremption, à chaque requête — sinon un collecteur mort servirait
 *     un fichier tout vert.
 */

// Options de ligne de commande. `--force` ignore les cadences, `--only=<source>`
// n'en lance qu'une. Sans ça, après avoir renseigné un jeton, on relance le
// collecteur, la source n'est pas due, elle est reconduite avec son ANCIENNE
// erreur — et on croit que la configuration n'a pas pris. Piège vécu.
const ARGS = process.argv.slice(2);
const FORCE = ARGS.includes('--force');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;

const CADENCES = {
  machines: 0, // fichiers locaux, à chaque passage
  kuma: 5 * 60,
  glitchtip: 5 * 60,
  backups: 0, // lecture d'un fichier local
  roadmaps: 15 * 60,
  hostinger: 30 * 60,
};

function isDue(name, lastRuns, now) {
  const cadence = CADENCES[name] ?? 300;
  if (cadence === 0) return true;
  const last = Date.parse(lastRuns[name] || '');
  if (!Number.isFinite(last)) return true;
  // Marge de 30 s : sinon un cron qui démarre une seconde trop tôt saute un tour
  // et la source tourne une fois sur deux.
  return now - last >= (cadence - 30) * 1000;
}

/**
 * Reconstruit les blocs par source à partir du state.json précédent.
 *
 * On ne stocke PAS les blocs bruts en plus dans le fichier : ce serait chaque
 * donnée deux fois, et deux copies finissent toujours par diverger. Le fichier
 * reste la seule représentation, et on sait la relire par morceaux.
 */
function blocksFromState(previous) {
  if (!previous) return {};
  return {
    machines: {
      machines: previous.machines || [],
      services: previous.services || [],
      crowdsec: previous.incidents?.crowdsec || [],
    },
    kuma: previous.incidents?.kuma || null,
    glitchtip: previous.incidents?.glitchtip || null,
    roadmaps: { projects: previous.projects || [], deadlines: previous.deadlines || [] },
    backups: previous.backups || [],
    // Les métriques Hostinger sont déjà fondues dans machines[] : on les en
    // ressort pour pouvoir les reconduire quand la source n'est pas due.
    hostinger: {
      metrics: Object.fromEntries(
        (previous.machines || [])
          .filter((m) => m.cpuPct !== undefined && m.cpuPct !== null)
          .map((m) => [
            m.id,
            {
              cpuPct: m.cpuPct,
              cpuAvg24h: m.cpuAvg24h ?? null,
              outgoingBytes24h: m.outgoingBytes24h ?? null,
              vmState: m.vmState ?? null,
              hostingerId: m.hostingerId ?? null,
            },
          ])
      ),
    },
  };
}

async function run() {
  const started = Date.now();
  const lockPath = config.lockPath;
  const lock = await acquire(lockPath);
  if (!lock.ok) {
    log.warn('collector.locked', { lockPath, message: 'une collecte est déjà en cours — abandon' });
    process.exitCode = 75; // EX_TEMPFAIL : le cron suivant réessaiera
    return;
  }

  try {
    const statePath = path.join(config.dataDir, 'state.json');
    const runsPath = path.join(config.dataDir, '.collector-runs.json');

    const previous = await readJson(statePath, null);
    const previousBlocks = blocksFromState(previous);
    const lastRuns = (await readJson(runsPath, {})) || {};
    const now = Date.now();

    const sources = {};
    const blocks = {};

    // Une source par entrée : sa fonction, et ce qu'elle nourrit dans state.json.
    const definitions = [
      { name: 'machines', run: () => machinesSource.collect() },
      { name: 'backups', run: () => backupsSource.collect() },
      { name: 'kuma', run: () => kumaSource.collect() },
      { name: 'glitchtip', run: () => glitchtipSource.collect() },
      { name: 'roadmaps', run: () => roadmapsSource.collect() },
      { name: 'hostinger', run: () => hostingerSource.collect() },
    ];

    const results = await Promise.all(
      definitions.map(async (def) => {
        if (ONLY && def.name !== ONLY) return { name: def.name, skipped: true };
        if (!FORCE && !isDue(def.name, lastRuns, now)) {
          return { name: def.name, skipped: true };
        }
        try {
          const data = await def.run();
          return { name: def.name, ok: true, at: new Date().toISOString(), data };
        } catch (err) {
          log.warn('collector.source_failed', { source: def.name, error: err.message });
          return { name: def.name, ok: false, error: err.message };
        }
      })
    );

    for (const result of results) {
      const name = result.name;
      const prevBlock = previousBlocks[name] ?? null;

      if (result.skipped) {
        // Non due : on reconduit tel quel, horodatage compris. La source n'est
        // ni plus fraîche ni plus périmée qu'au passage précédent.
        sources[name] = {
          ok: previous?.sources?.[name]?.ok ?? false,
          at: previous?.sources?.[name]?.at ?? null,
          error: previous?.sources?.[name]?.error ?? null,
        };
        blocks[name] = prevBlock;
        continue;
      }

      if (result.ok) {
        sources[name] = { ok: true, at: result.at, error: null };
        blocks[name] = result.data;
        lastRuns[name] = result.at;
      } else {
        // Échec : dernier bloc bon conservé, mais ok=false et l'erreur visible.
        // Le service en fera de l'INCONNU — jamais du vert, jamais du rouge.
        sources[name] = { ok: false, at: previous?.sources?.[name]?.at ?? null, error: result.error };
        blocks[name] = prevBlock;
        lastRuns[name] = new Date().toISOString(); // on a essayé : pas de rafale
      }
    }

    const machines = blocks.machines?.machines || [];
    const hostingerMetrics = blocks.hostinger?.metrics || {};

    // Une machine qui n'a JAMAIS poussé n'est pas dans machines[] — or c'est
    // exactement celle dont on aimerait savoir si l'hyperviseur la voit tourner.
    // On lui crée donc une entrée nue : sans `reportedAt`, elle reste
    // silencieuse et donc INCONNUE, mais elle peut enfin dire « la VM tourne,
    // c'est l'agent qui ne parle plus » plutôt que rien du tout.
    for (const [id, extra] of Object.entries(hostingerMetrics)) {
      if (!machines.some((m) => m.id === id)) machines.push({ id, reportedAt: null });
    }

    for (const machine of machines) {
      const extra = hostingerMetrics[machine.id];
      if (extra) {
        // Les métriques Hostinger COMPLÈTENT la pousse de la machine, elles ne
        // la remplacent pas : disque, RAM et uptime restent ceux mesurés de
        // l'intérieur, qui voient tous les volumes montés.
        machine.cpuPct = extra.cpuPct;
        machine.cpuAvg24h = extra.cpuAvg24h;
        machine.outgoingBytes24h = extra.outgoingBytes24h;
        machine.vmState = extra.vmState;
        machine.hostingerId = extra.hostingerId;
      }
    }

    const state = {
      schema: 1,
      collectedAt: new Date().toISOString(),
      sources,
      machines,
      services: blocks.machines?.services || [],
      platforms: [], // table statique, servie directement par le service (§3.4)
      projects: blocks.roadmaps?.projects || [],
      deadlines: blocks.roadmaps?.deadlines || [],
      incidents: {
        kuma: blocks.kuma || null,
        glitchtip: blocks.glitchtip || null,
        crowdsec: blocks.machines?.crowdsec || [],
      },
      backups: blocks.backups || [],
    };

    await writeJsonAtomic(statePath, state);
    await writeJsonAtomic(runsPath, lastRuns);

    log.info('collector.done', {
      ms: Date.now() - started,
      ...(FORCE ? { force: true } : {}),
      ...(ONLY ? { only: ONLY } : {}),
      ran: results.filter((r) => !r.skipped).map((r) => r.name),
      failed: results.filter((r) => r.ok === false).map((r) => r.name),
      machines: machines.length,
      services: state.services.length,
    });
  } finally {
    await lock.release();
  }
}

if (require.main === module) {
  run().catch((err) => {
    log.error('collector.failed', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { run, isDue, CADENCES };
