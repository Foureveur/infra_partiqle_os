'use strict';

const path = require('node:path');
const { config } = require('../../lib/config');
const { readJsonSync } = require('../../lib/io');
const { fetchJson } = require('../fetch');

/**
 * Hostinger — CPU et bande passante des VPS, cadence 30 min (§3.9).
 *
 * Cette source est la plus fragile du lot : quota d'API, forme de réponse qui
 * peut bouger. Elle est donc lue défensivement et elle n'ajoute QUE deux champs
 * à des machines déjà décrites par leur propre pousse. Si elle tombe, la carte
 * machine perd le CPU et rien d'autre — c'est le point de recette « on coupe le
 * réseau vers l'API Hostinger : seule la carte concernée passe en inconnu ».
 */

function firstNumber(...candidates) {
  for (const value of candidates) {
    const n = typeof value === 'number' ? value : Number.parseFloat(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Les réponses de métriques varient (série temporelle ou valeur unique). */
function latestOf(node) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'number') return node;
  if (Array.isArray(node)) {
    const last = node[node.length - 1];
    if (last === undefined) return null;
    if (typeof last === 'number') return last;
    if (Array.isArray(last)) return firstNumber(last[1], last[0]);
    if (last && typeof last === 'object') return firstNumber(last.value, last.usage, last.y);
    return null;
  }
  if (typeof node === 'object') {
    return firstNumber(node.value, node.usage, node.current, node.average, node.percent, latestOf(node.data));
  }
  return null;
}

async function api(pathname) {
  const base = config.hostinger.baseUrl.replace(/\/$/, '');
  return fetchJson(`${base}${pathname}`, {
    headers: { Authorization: `Bearer ${config.hostinger.token}`, Accept: 'application/json' },
    timeoutMs: 12_000,
  });
}

async function collect() {
  if (!config.hostinger.token) throw new Error('HOSTINGER_TOKEN absent');

  const table = readJsonSync(path.join(config.tablesDir, 'machines.json'), []) || [];
  const vms = await api('/api/vps/v1/virtual-machines');
  const list = Array.isArray(vms) ? vms : vms.data || [];

  const metrics = {};
  const notes = [];

  for (const spec of table) {
    // Trois façons de rattacher une VM à une machine : l'identifiant explicite
    // de la table, l'IP relevée, le hostname. On ne devine pas au-delà.
    const vm = list.find(
      (v) =>
        (spec.hostingerId && String(v.id) === String(spec.hostingerId)) ||
        (spec.expectedIp && [v.ipv4, v.ip, ...(v.ipv4s || [])].flat().some((ip) => (ip?.address || ip) === spec.expectedIp)) ||
        (v.hostname && v.hostname === spec.id)
    );
    if (!vm) {
      notes.push(`${spec.id} : aucune VM Hostinger rattachée`);
      continue;
    }

    try {
      const raw = await api(`/api/vps/v1/virtual-machines/${vm.id}/metrics`);
      const body = raw?.data || raw || {};
      metrics[spec.id] = {
        cpuPct: latestOf(body.cpu_usage ?? body.cpu ?? body.cpuUsage),
        bandwidth: latestOf(body.outgoing_traffic ?? body.bandwidth ?? body.network),
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

module.exports = { collect };
