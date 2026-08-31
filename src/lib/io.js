'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Écriture atomique : fichier temporaire voisin, fsync, puis rename.
 * Jamais d'écriture en place sur un fichier que le service est en train de lire
 * (§3.9). Le rename est atomique sur le même système de fichiers, donc un lecteur
 * voit toujours soit l'ancienne version complète, soit la nouvelle.
 */
async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const body = JSON.stringify(value, null, 2) + '\n';
  let handle;
  try {
    handle = await fsp.open(tmp, 'w', 0o640);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/** Lit un JSON. Renvoie `fallback` si le fichier est absent OU illisible. */
async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Version synchrone, pour les tables statiques chargées au démarrage. */
function readJsonSync(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

module.exports = { writeJsonAtomic, readJson, readJsonSync };
