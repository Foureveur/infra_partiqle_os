'use strict';

const { config } = require('../lib/config');
const { remoteUser } = require('../lib/auth');
const layoutStore = require('../lib/layout');
const { sendJson, readJsonBody, BodyTooLarge } = require('../lib/http');
const log = require('../lib/log');

async function handleLayout(req, res, registry, method) {
  const user = remoteUser(req);
  if (!user) {
    // Pas d'utilisateur par défaut : sans Remote-User, on ne sert la disposition
    // de personne. En production Authelia le pousse toujours (§5.1).
    return sendJson(res, 401, { error: 'authentification requise' });
  }

  try {
    if (method === 'GET') {
      const { cards, pristine, savedAt } = await layoutStore.load(user, registry);
      return sendJson(res, 200, {
        user,
        cards,
        pristine,
        savedAt,
        gridColumns: registry.gridColumns,
        minViewport: config.minLayoutViewport,
      });
    }

    if (method === 'PUT') {
      const body = await readJsonBody(req, config.maxLayoutBytes);
      if (!body || typeof body !== 'object') {
        return sendJson(res, 400, { error: 'corps JSON attendu' });
      }

      // Le bug classique de ce genre de page : le téléphone repasse la grille en
      // une colonne, la page enregistre, et la disposition bureau est perdue.
      // Le refus est ici, côté serveur, pas seulement dans le navigateur (§5.2).
      const viewport = Number.parseInt(body.viewportWidth, 10);
      if (!Number.isFinite(viewport)) {
        return sendJson(res, 400, { error: 'viewportWidth manquant' });
      }
      if (viewport < config.minLayoutViewport) {
        return sendJson(res, 409, {
          error: 'disposition non enregistrée sous ' + config.minLayoutViewport + ' px',
          reason: 'viewport-too-small',
        });
      }

      const saved = await layoutStore.save(user, body.cards, registry);
      log.info('layout.saved', { user, cards: saved.cards.length });
      return sendJson(res, 200, { user, savedAt: saved.savedAt, cards: saved.cards });
    }

    if (method === 'DELETE') {
      await layoutStore.reset(user);
      log.info('layout.reset', { user });
      const { cards } = await layoutStore.load(user, registry);
      return sendJson(res, 200, { user, cards, pristine: true, savedAt: null });
    }

    return sendJson(res, 405, { error: 'méthode non autorisée' });
  } catch (err) {
    if (err instanceof BodyTooLarge) return sendJson(res, 413, { error: err.message });
    if (err instanceof SyntaxError) return sendJson(res, 400, { error: 'JSON invalide' });
    if (err instanceof layoutStore.LayoutError) return sendJson(res, err.status, { error: err.message });
    log.error('layout.failed', { user, error: err.message });
    return sendJson(res, 500, { error: 'erreur interne' });
  }
}

module.exports = { handleLayout };
