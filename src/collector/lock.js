'use strict';

const fsp = require('node:fs/promises');
const log = require('../lib/log');

const STALE_MS = 10 * 60_000;

/**
 * Verrou d'exclusion du collecteur.
 *
 * La ligne de cron utilise déjà `flock -n` (§3.9) — ce verrou-ci est en plus,
 * pour que la garantie tienne quelle que soit la façon dont le collecteur est
 * lancé, y compris `npm run collect` à la main pendant qu'un cron tourne.
 * Deux collecteurs concurrents qui écrivent le même state.json, on connaît le
 * résultat.
 */
async function acquire(lockPath) {
  try {
    const handle = await fsp.open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    await handle.close();
    return { ok: true, release: () => fsp.rm(lockPath, { force: true }) };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // Verrou existant : périmé s'il date de plus de dix minutes. Un collecteur
  // tué par l'OOM killer ne doit pas bloquer la collecte pour toujours.
  try {
    const stat = await fsp.stat(lockPath);
    if (Date.now() - stat.mtimeMs > STALE_MS) {
      log.warn('collector.stale_lock', { lockPath, ageMs: Date.now() - stat.mtimeMs });
      await fsp.rm(lockPath, { force: true });
      return acquire(lockPath);
    }
  } catch {
    return acquire(lockPath);
  }

  return { ok: false, release: async () => {} };
}

module.exports = { acquire };
