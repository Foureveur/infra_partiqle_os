'use strict';

const { config } = require('../../lib/config');
const { fetchJson, fetchText } = require('../fetch');

/**
 * Kuma 1.x n'a pas d'API REST générale (§3.7). Deux voies, complémentaires :
 *
 *  1. Page de statut — donne la LISTE des moniteurs et leur uptime.
 *  2. Endpoint Prometheus — donne l'état COURANT et le temps de réponse.
 *
 * Relevé le 31/08 depuis l'extérieur : `/api/entry-page` renvoie
 * `entryPage: null`, donc aucune page de statut n'est publiée à ce jour, tandis
 * que `/metrics` répond 401 (il existe et attend la clé API). L'ordre de
 * préférence du brief est donc inversé en pratique : `/metrics` est la voie qui
 * marche tout de suite, la page de statut est celle qui enrichit.
 *
 * Détection des pauses : un moniteur en pause disparaît de /metrics mais reste
 * dans la page de statut. La différence des deux listes donne les moniteurs en
 * pause — à condition que la page de statut les contienne TOUS. Sans page de
 * statut, la détection est impossible et on le DIT (`pausedDetection: false`)
 * plutôt que de compter un trou de couverture comme un succès.
 */

function parsePrometheus(text) {
  const status = new Map();
  const duration = new Map();

  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z_]+)\{(.*)\}\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const [, metric, labelBlob, rawValue] = match;
    if (metric !== 'monitor_status' && metric !== 'monitor_response_duration_seconds') continue;

    const labels = {};
    for (const m of labelBlob.matchAll(/([a-z_]+)="((?:[^"\\]|\\.)*)"/g)) {
      labels[m[1]] = m[2].replace(/\\"/g, '"');
    }
    const name = labels.monitor_name;
    if (!name) continue;

    const value = Number.parseFloat(rawValue);
    if (metric === 'monitor_status') {
      status.set(name, { value, url: labels.monitor_url && labels.monitor_url !== 'null' ? labels.monitor_url : null });
    } else if (Number.isFinite(value)) {
      duration.set(name, value * 1000);
    }
  }
  return { status, duration };
}

async function fromMetrics() {
  const url = config.kuma.metricsUrl || `${config.kuma.statusUrl.replace(/\/$/, '')}/metrics`;
  const auth = Buffer.from(`:${config.kuma.apiKey}`).toString('base64');
  const text = await fetchText(url, { headers: { Authorization: `Basic ${auth}` }, timeoutMs: 8000 });
  return parsePrometheus(text);
}

async function fromStatusPage(slug) {
  const base = config.kuma.statusUrl.replace(/\/$/, '');
  const [page, beats] = await Promise.all([
    fetchJson(`${base}/api/status-page/${encodeURIComponent(slug)}`, { timeoutMs: 8000 }),
    fetchJson(`${base}/api/status-page/heartbeat/${encodeURIComponent(slug)}`, { timeoutMs: 8000 }),
  ]);

  const monitors = [];
  for (const group of page.publicGroupList || []) {
    for (const m of group.monitorList || []) {
      const beatList = (beats.heartbeatList || {})[String(m.id)] || [];
      const last = beatList[beatList.length - 1] || null;
      const downSince = (() => {
        // Remonte les battements jusqu'au dernier « up » : le début de la panne.
        let since = null;
        for (let i = beatList.length - 1; i >= 0; i--) {
          if (beatList[i].status === 1) break;
          since = beatList[i].time;
        }
        return since ? new Date(since.replace(' ', 'T') + 'Z').toISOString() : null;
      })();

      monitors.push({
        name: m.name,
        url: m.url || null,
        up: last ? last.status === 1 : null,
        uptime24h: (beats.uptimeList || {})[`${m.id}_24`] ?? null,
        uptime30d: (beats.uptimeList || {})[`${m.id}_720`] ?? null,
        avgResponseMs: last && Number.isFinite(last.ping) ? last.ping : null,
        downSince,
        paused: false,
      });
    }
  }
  return monitors;
}

async function collect() {
  const { statusSlug, apiKey } = config.kuma;
  if (!statusSlug && !apiKey) {
    throw new Error('ni KUMA_STATUS_SLUG ni KUMA_API_KEY ne sont configurés');
  }

  let statusMonitors = null;
  let metrics = null;
  const notes = [];

  if (statusSlug) {
    try {
      statusMonitors = await fromStatusPage(statusSlug);
    } catch (err) {
      notes.push(`page de statut « ${statusSlug} » : ${err.message}`);
    }
  }
  if (apiKey) {
    try {
      metrics = await fromMetrics();
    } catch (err) {
      notes.push(`/metrics : ${err.message}`);
    }
  }

  if (!statusMonitors && !metrics) {
    throw new Error(notes.join(' · ') || 'aucune voie Kuma exploitable');
  }

  // Voie /metrics seule : on ne connaît que les moniteurs actifs. Un moniteur
  // en pause est alors indistinguable d'un moniteur supprimé.
  if (!statusMonitors) {
    const monitors = [...metrics.status.entries()].map(([name, s]) => ({
      name,
      url: s.url,
      up: s.value === 1,
      uptime24h: null,
      uptime30d: null,
      avgResponseMs: metrics.duration.get(name) ?? null,
      downSince: null,
      paused: false,
      maintenance: s.value === 3,
    }));
    return { monitors, pausedDetection: false, notes };
  }

  // Page de statut disponible : elle fait autorité sur la liste. Les moniteurs
  // absents de /metrics sont en pause — c'est le trou de couverture à montrer.
  const monitors = statusMonitors.map((m) => {
    if (!metrics) return m;
    const live = metrics.status.get(m.name);
    if (!live) return { ...m, up: null, paused: true };
    return {
      ...m,
      up: live.value === 1,
      maintenance: live.value === 3,
      avgResponseMs: metrics.duration.get(m.name) ?? m.avgResponseMs,
      paused: false,
    };
  });

  return { monitors, pausedDetection: Boolean(metrics), notes };
}

module.exports = { collect, parsePrometheus };
