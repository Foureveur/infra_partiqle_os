'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { config } = require('../../lib/config');
const { readJson, readJsonSync } = require('../../lib/io');

/**
 * Fusionne les fichiers poussés par chaque machine (§3.2bis.6). Aucune sortie
 * réseau : le collecteur ne fait que réunir ce que les machines ont déposé.
 *
 * Note : cette source est « ok » dès qu'on a pu lire le répertoire, même si une
 * machine est muette. Le silence d'UNE machine est porté par cette machine
 * (champ reportedAt, dérivé en `unknown` par le service), pas par la source
 * entière — sinon une machine éteinte rendrait les trois autres grises.
 */
async function collect() {
  const table = readJsonSync(path.join(config.tablesDir, 'machines.json'), []) || [];
  const dir = path.join(config.dataDir, 'machines');

  const machines = [];
  const services = [];
  const crowdsec = [];

  for (const spec of table) {
    const report = await readJson(path.join(dir, `${spec.id}.json`), null);

    if (!report || !report.machine) {
      // Aucune pousse reçue : on inscrit la machine sans données. Le service
      // la rendra INCONNUE — jamais absente de la page, sinon on ne verrait pas
      // qu'elle manque.
      machines.push({ id: spec.id, reportedAt: null, up: null });
      crowdsec.push({ machine: spec.id, available: false, activeDecisions: null, recentBans: [] });
      continue;
    }

    machines.push({ ...report.machine, id: spec.id, reportedAt: report.reportedAt });
    for (const svc of report.services || []) services.push(svc);
    crowdsec.push({ machine: spec.id, ...(report.crowdsec || { available: false, activeDecisions: null, recentBans: [] }) });
  }

  return { machines, services, crowdsec };
}

/** Utilisé par le smoke test et le diagnostic. */
async function listPushed() {
  try {
    return await fsp.readdir(path.join(config.dataDir, 'machines'));
  } catch {
    return [];
  }
}

module.exports = { collect, listPushed };
