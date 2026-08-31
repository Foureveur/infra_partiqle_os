'use strict';

const path = require('node:path');
const { config } = require('../../lib/config');
const { readJson } = require('../../lib/io');

/**
 * Sauvegardes — on lit ce que le script de sauvegarde a laissé derrière lui
 * (§3.8). Le collecteur ne touche jamais au dépôt restic : les clés sont
 * détenues par Quentin, et une page de supervision n'a aucune raison de
 * pouvoir ouvrir les sauvegardes.
 *
 * `sources.backups.at` est donc l'heure de la dernière LECTURE réussie de ce
 * fichier, pas l'heure de la sauvegarde — celle-ci est dans `finishedAt`, et
 * c'est le service qui en dérive l'âge et la sévérité.
 */
async function collect() {
  const file = path.join(config.dataDir, 'backups.json');
  const raw = await readJson(file, null);

  if (raw === null) {
    throw new Error('backups.json absent — le script de sauvegarde n’écrit pas encore son état');
  }
  const list = Array.isArray(raw) ? raw : raw.backups;
  if (!Array.isArray(list)) throw new Error('backups.json malformé (tableau attendu)');

  return list
    .filter((b) => b && typeof b === 'object' && b.target)
    .map((b) => ({
      target: String(b.target).slice(0, 60),
      repo: b.repo ? String(b.repo).slice(0, 200) : null,
      finishedAt: b.finishedAt || null,
      ok: b.ok === true,
      snapshotId: b.snapshotId ? String(b.snapshotId).slice(0, 40) : null,
      sizeBytes: Number.isFinite(b.sizeBytes) ? b.sizeBytes : null,
      durationSec: Number.isFinite(b.durationSec) ? b.durationSec : null,
      message: b.message ? String(b.message).slice(0, 300) : null,
    }));
}

module.exports = { collect };
