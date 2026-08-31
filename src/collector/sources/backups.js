'use strict';

const path = require('node:path');
const { config } = require('../../lib/config');
const { readJson, readJsonSync } = require('../../lib/io');

/**
 * Sauvegardes — ce que le veilleur de chaque machine a constaté (§3.8).
 *
 * La source a changé de nature le 31/08, après lecture des scripts réels.
 * Avant : on attendait qu'un script de sauvegarde dépose un backups.json avec
 * le code de sortie de restic. C'était la mauvaise mesure — « le script s'est
 * exécuté » ne dit rien de « les données sont protégées », et c'est exactement
 * l'incident du 28/08 raconté en tête de watchdog-backups.sh : un moniteur resté
 * vert pour une copie devenue obsolète.
 *
 * Maintenant : chaque machine fait tourner un veilleur qui interroge SON dépôt
 * restic et en lit l'horodatage du dernier snapshot. L'agent de pousse relaie ce
 * constat par le canal déjà authentifié de /api/ingest. Donc : pas de nouvelle
 * route, pas de nouveau secret, et le collecteur ne touche toujours pas aux
 * clés restic — il ne lit que des dates.
 *
 * Le cloisonnement R2 (un dépôt, un jeton, un mot de passe par machine) rend
 * cette forme obligatoire de toute façon : aucun hôte ne peut plus lire les
 * dépôts des autres, donc aucun ne peut rendre compte pour eux.
 */
async function collect() {
  const table = readJsonSync(path.join(config.tablesDir, 'machines.json'), []) || [];
  const dir = path.join(config.dataDir, 'machines');
  const out = [];

  for (const spec of table) {
    const report = await readJson(path.join(dir, `${spec.id}.json`), null);
    const backup = report && report.backup ? report.backup : null;

    // `reportedAt` est celui de la POUSSE, pas du snapshot. Il sert au service à
    // savoir si le constat lui-même est encore frais : un veilleur arrêté il y a
    // trois jours annonce un dernier snapshot vieux de trois jours, ce qui est
    // vrai et inutile. Le service en fera de l'inconnu, pas du rouge.
    out.push({
      target: spec.id,
      tier: spec.tier || null,
      lastSnapshotAt: backup ? backup.lastSnapshotAt : null,
      thresholdHours: backup ? backup.thresholdHours : null,
      repoReadable: backup ? backup.repoReadable : null,
      checkedAt: backup ? backup.checkedAt : null,
      message: backup ? backup.message : null,
      // Distingue « la machine ne pousse plus » de « elle pousse, mais sans
      // veilleur greffé ». Les deux donnent de l'inconnu ; ils ne se réparent
      // pas au même endroit.
      reported: Boolean(report),
      watched: Boolean(backup),
      reportedAt: report ? report.reportedAt : null,
    });
  }

  // Un fichier backups.json déposé à la main reste honoré : c'est l'échappatoire
  // pour une cible qui n'est pas une de nos machines (un dépôt tiers, un hôte
  // mutualisé). Il complète la liste, il ne l'écrase pas.
  const extra = await readJson(path.join(config.dataDir, 'backups.json'), null);
  const extraList = Array.isArray(extra) ? extra : extra && Array.isArray(extra.backups) ? extra.backups : [];
  for (const b of extraList) {
    if (!b || typeof b !== 'object' || !b.target) continue;
    if (out.some((o) => o.target === String(b.target))) continue;
    out.push({
      target: String(b.target).slice(0, 60),
      tier: null,
      lastSnapshotAt: b.lastSnapshotAt || b.finishedAt || null,
      thresholdHours: Number.isFinite(b.thresholdHours) ? b.thresholdHours : null,
      repoReadable: b.ok === false ? false : true,
      checkedAt: b.finishedAt || null,
      message: b.message ? String(b.message).slice(0, 300) : null,
      reported: true,
      watched: true,
      reportedAt: b.finishedAt || null,
    });
  }

  return out;
}

module.exports = { collect };
