'use strict';

const { config } = require('../../lib/config');
const { fetchJson } = require('../fetch');

/**
 * GlitchTip — issues non résolues de l'organisation (§3.7).
 * Le comparatif 24 h / 7 j sert à détecter une flambée : ce n'est pas le nombre
 * d'issues qui compte, c'est son accélération.
 */

function sumSeries(series, sinceMs) {
  if (!Array.isArray(series)) return 0;
  return series.reduce((total, point) => {
    if (!Array.isArray(point) || point.length < 2) return total;
    const [ts, count] = point;
    if (sinceMs && ts * 1000 < sinceMs) return total;
    return total + (Number(count) || 0);
  }, 0);
}

async function issues(statsPeriod) {
  const base = config.glitchtip.baseUrl.replace(/\/$/, '');
  const url =
    `${base}/api/0/organizations/${encodeURIComponent(config.glitchtip.org)}/issues/` +
    `?query=${encodeURIComponent('is:unresolved')}&statsPeriod=${statsPeriod}&limit=100`;
  const data = await fetchJson(url, {
    headers: { Authorization: `Bearer ${config.glitchtip.token}`, Accept: 'application/json' },
    timeoutMs: 10_000,
  });
  if (!Array.isArray(data)) throw new Error('réponse inattendue (tableau attendu)');
  return data;
}

async function collect() {
  if (!config.glitchtip.org || !config.glitchtip.token) {
    throw new Error('GLITCHTIP_ORG ou GLITCHTIP_TOKEN absent');
  }

  // Deux fenêtres : l'API Sentry/GlitchTip n'expose que les séries « 24h » et
  // « 14d ». Les 7 jours se déduisent de la seconde.
  const [day, fortnight] = await Promise.all([issues('24h'), issues('14d')]);

  const sevenDaysAgo = Date.now() - 7 * 86400_000;
  const count24h = day.reduce((n, i) => n + sumSeries(i.stats && i.stats['24h']), 0);
  const count7d = fortnight.reduce((n, i) => n + sumSeries(i.stats && i.stats['14d'], sevenDaysAgo), 0);

  const perProject = new Map();
  for (const issue of day) {
    const project = issue.project?.slug || issue.project?.name || 'inconnu';
    perProject.set(project, (perProject.get(project) || 0) + 1);
  }

  const recent = [...day]
    .sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0))
    .slice(0, 5)
    .map((i) => ({
      title: i.title || i.metadata?.value || i.culprit || 'sans titre',
      project: i.project?.slug || i.project?.name || null,
      lastSeen: i.lastSeen || null,
      count: Number(i.count) || null,
      url: i.permalink || i.webUrl || null,
    }));

  const dailyAverage = count7d / 7;
  return {
    unresolvedTotal: day.length,
    count24h,
    count7d,
    // Une flambée, c'est deux fois la moyenne quotidienne de la semaine — et
    // seulement si le volume est significatif, sinon 1 erreur au lieu de 0
    // déclencherait une alerte tous les jours.
    surge: count24h >= 10 && dailyAverage > 0 && count24h > dailyAverage * 2,
    surgeRatio: dailyAverage > 0 ? count24h / dailyAverage : null,
    perProject: [...perProject.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count),
    recent,
  };
}

module.exports = { collect };
