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

async function handleState(req, res, registry) {
  const now = Date.now();
  const raw = await readJson(path.join(config.dataDir, 'state.json'), null);
  const state = decorate(raw, registry, now);

  state.platforms = platformsWithReview(now);
  state.links = readJsonSync(path.join(config.tablesDir, 'links.json'), { groups: [] });
  state.cards = registry.cards;

  sendJson(res, 200, state);
}

module.exports = { handleState };
