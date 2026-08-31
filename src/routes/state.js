'use strict';

const path = require('node:path');
const { config } = require('../lib/config');
const { readJson, readJsonSync } = require('../lib/io');
const { decorate } = require('../lib/freshness');
const { sendJson } = require('../lib/http');

const REVIEW_AFTER_DAYS = 90;

/**
 * Les plateformes ne sont pas collectées : c'est une table du dépôt, éditée à la
 * main (§3.4). Elles sont donc servies directement, avec la seule chose qui se
 * périme ici : la date de dernière vérification.
 */
function platformsWithReview(now) {
  const table = readJsonSync(path.join(config.tablesDir, 'platforms.json'), []) || [];
  return table.map((p) => {
    const t = Date.parse(p.verifiedAt || '');
    const days = Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
    return {
      ...p,
      verifiedDaysAgo: days,
      needsReview: days === null || days > REVIEW_AFTER_DAYS,
    };
  });
}

/**
 * Échéances : table du dépôt + jalons remontés par Roadmaps.
 *
 * La table existe parce que les expirations de domaine sont la classe la plus
 * dangereuse — une date manquée est irréversible (§3.6) — et qu'elles ne
 * peuvent pas attendre que /api/infra/summary soit construit côté Roadmaps.
 * Chaque entrée garde son origine : une entrée de table reste fiable quand la
 * source Roadmaps est en échec, une entrée Roadmaps devient inconnue.
 */
function mergedDeadlines(raw) {
  const table = readJsonSync(path.join(config.tablesDir, 'deadlines.json'), null);
  const fromTable = (table?.deadlines || []).map((d) => ({ ...d, origin: 'table' }));
  const fromRoadmaps = (raw?.deadlines || []).map((d) => ({ ...d, origin: 'roadmaps' }));

  const seen = new Set();
  return [...fromTable, ...fromRoadmaps].filter((d) => {
    const key = `${d.date}|${d.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function handleState(req, res, registry) {
  const now = Date.now();
  const raw = await readJson(path.join(config.dataDir, 'state.json'), null);
  if (raw) raw.deadlines = mergedDeadlines(raw);
  const state = decorate(raw ? raw : { deadlines: mergedDeadlines(null) }, registry, now);

  state.platforms = platformsWithReview(now);
  state.links = readJsonSync(path.join(config.tablesDir, 'links.json'), { groups: [] });
  state.cards = registry.cards;

  sendJson(res, 200, state);
}

module.exports = { handleState };
