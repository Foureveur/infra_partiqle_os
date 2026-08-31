'use strict';

const path = require('node:path');
const { config } = require('../../lib/config');
const { readJsonSync } = require('../../lib/io');
const { fetchJson } = require('../fetch');

/**
 * Hostinger — CPU et trafic sortant des VPS, cadence 30 min (§3.9).
 *
 * Le contrat ci-dessous a été relevé le 31/08 contre l'API réelle, pas deviné.
 * La première version se trompait sur deux points, et aucun des deux n'aurait
 * produit d'erreur visible — juste des tirets, pour toujours :
 *
 *   1. `/metrics` EXIGE `date_from` et `date_to`. Sans eux, pas de réponse.
 *   2. `usage` est une table `{ "<timestamp unix>": valeur }`, pas un nombre ni
 *      une série `[[t, v]]`. L'ancien lecteur en tirait `null`, en silence.
 *
 * Forme réelle :
 *
 *   { "cpu_usage":        { "unit": "%",       "usage": { "1788176922": 52.76 } },
 *     "ram_usage":        { "unit": "bytes",   "usage": { … } },
 *     "disk_space":       { "unit": "bytes",   "usage": { … } },
 *     "outgoing_traffic": { "unit": "bytes",   "usage": { … } },
 *     "incoming_traffic": { "unit": "bytes",   "usage": { … } },
 *     "uptime":           { "unit": "seconds", "usage": { … } } }
 *
 * On n'en garde QUE le CPU et le trafic. Le disque, la RAM et l'uptime arrivent
 * déjà par la pousse de la machine (§3.2bis), qui les mesure de l'intérieur et
 * sur tous les volumes montés — ce que l'hyperviseur ne voit pas. Deux mesures
 * du même fait finissent toujours par diverger ; on garde la meilleure.
 */

const WINDOW_SECONDS = 24 * 3600;

/**
 * `usage` est une table timestamp → valeur, et l'ordre d'un objet JSON ne se
 * décrète pas : on trie sur la clé, numériquement.
 */
function samples(node) {
  const usage = node && typeof node === 'object' ? node.usage : null;
  if (!usage || typeof usage !== 'object') return [];
  return Object.entries(usage)
    .map(([ts, value]) => [Number(ts), Number(value)])
    .filter(([ts, value]) => Number.isFinite(ts) && Number.isFinite(value))
    .sort((a, b) => a[0] - b[0]);
}

function latest(node) {
  const list = samples(node);
  return list.length ? list[list.length - 1][1] : null;
}

function average(node) {
  const list = samples(node);
  if (!list.length) return null;
  return list.reduce((sum, [, v]) => sum + v, 0) / list.length;
}

/**
 * `outgoing_traffic` monte ET descend d'un relevé à l'autre (26 Mo, 45, 15, 1,4,
 * 64…). Ce n'est donc pas un compteur cumulé de quota : c'est le volume écoulé
 * DEPUIS LE RELEVÉ PRÉCÉDENT. La somme de la fenêtre est le trafic de la
 * fenêtre ; le rapporter au quota mensuel du plan serait une invention.
 */
function sum(node) {
  const list = samples(node);
  if (!list.length) return null;
  return list.reduce((total, [, v]) => total + v, 0);
}

async function api(pathname, params) {
  const base = config.hostinger.baseUrl.replace(/\/$/, '');
  const url = new URL(base + pathname);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
  return fetchJson(url.toString(), {
    // Jeton de service dans l'en-tête, jamais dans l'URL.
    headers: { Authorization: `Bearer ${config.hostinger.token}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
}

/**
 * Trois façons de rattacher une VM à une machine, de la plus sûre à la moins
 * sûre. Le hostname Hostinger est un FQDN (`vps-lab.partiqle.studio`) : le
 * comparer nu à `vps-lab` ne matchait jamais.
 */
function matchVm(list, spec) {
  return list.find((v) => {
    if (spec.hostingerId && String(v.id) === String(spec.hostingerId)) return true;
    if (spec.expectedIp) {
      const ips = [].concat(v.ipv4 || [], v.ipv6 || []).map((ip) => (ip && ip.address) || ip);
      if (ips.includes(spec.expectedIp)) return true;
    }
    const host = v.hostname || '';
    return host === spec.id || host.startsWith(`${spec.id}.`);
  });
}

async function collect() {
  if (!config.hostinger.token) throw new Error('HOSTINGER_TOKEN absent');

  const table = readJsonSync(path.join(config.tablesDir, 'machines.json'), []) || [];
  const vms = await api('/api/vps/v1/virtual-machines');
  const list = Array.isArray(vms) ? vms : vms.data || [];

  const now = Date.now();
  const window = {
    date_from: new Date(now - WINDOW_SECONDS * 1000).toISOString(),
    date_to: new Date(now).toISOString(),
  };

  const metrics = {};
  const notes = [];

  for (const spec of table) {
    const vm = matchVm(list, spec);
    if (!vm) {
      notes.push(`${spec.id} : aucune VM Hostinger rattachée`);
      continue;
    }

    try {
      const body = await api(`/api/vps/v1/virtual-machines/${vm.id}/metrics`, window);
      metrics[spec.id] = {
        cpuPct: latest(body.cpu_usage),
        // La moyenne de la fenêtre est ce qui rend le point courant lisible :
        // 52 % ne veut rien dire, 52 % contre 8 % de moyenne veut dire beaucoup.
        cpuAvg24h: average(body.cpu_usage),
        outgoingBytes24h: sum(body.outgoing_traffic),
        // `state` vient de la liste des VM, pas d'un relevé : c'est l'avis de
        // l'hyperviseur sur la machine, utile quand elle ne pousse plus rien.
        vmState: vm.state || null,
        hostingerId: vm.id,
      };
    } catch (err) {
      notes.push(`${spec.id} : ${err.message}`);
    }
  }

  if (!Object.keys(metrics).length) {
    throw new Error(notes.join(' · ') || 'aucune métrique exploitable');
  }
  return { metrics, notes };
}

// `samples`/`latest`/`average`/`sum` sont exportés pour la recette : c'est ici
// qu'on s'est trompé deux fois, et un lecteur de métriques qui rend `null` sans
// rien dire ne se voit que si on le teste.
module.exports = { collect, samples, latest, average, sum, matchVm };
