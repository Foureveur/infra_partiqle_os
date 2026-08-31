'use strict';

const { config } = require('../../lib/config');
const { fetchJson } = require('../fetch');

/**
 * GlitchTip — issues non résolues de l'organisation (§3.7).
 *
 * Ce que l'API donne RÉELLEMENT, vérifié contre l'instance le 31/08 : chaque
 * issue porte `count` (total d'événements depuis toujours), `firstSeen` et
 * `lastSeen`. Le champ `stats` n'a qu'une clé `24h`, et elle revient VIDE quel
 * que soit `statsPeriod` — GlitchTip n'implémente pas les séries temporelles de
 * Sentry.
 *
 * La première version comptait donc des événements par fenêtre à partir de ces
 * séries : elle affichait zéro en permanence, sans jamais dire pourquoi. On
 * compte désormais des ISSUES ACTIVES par fenêtre, d'après `lastSeen`. C'est
 * mesurable, et c'est même plus parlant sur un tableau de bord : dix issues qui
 * n'ont pas bougé depuis une semaine, ce n'est pas la même chose que trois qui
 * se réveillent aujourd'hui.
 */

const PAGE_LIMIT = 100;

async function fetchIssues() {
  const base = config.glitchtip.baseUrl.replace(/\/$/, '');
  const url =
    `${base}/api/0/organizations/${encodeURIComponent(config.glitchtip.org)}/issues/` +
    `?query=${encodeURIComponent('is:unresolved')}&limit=${PAGE_LIMIT}`;
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

  const issues = await fetchIssues();
  const now = Date.now();
  const seenWithin = (iso, ms) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) && now - t <= ms;
  };

  const active24h = issues.filter((i) => seenWithin(i.lastSeen, 86_400_000));
  const active7d = issues.filter((i) => seenWithin(i.lastSeen, 7 * 86_400_000));

  const perProject = new Map();
  for (const issue of issues) {
    const project = issue.project?.slug || issue.project?.name || 'inconnu';
    perProject.set(project, (perProject.get(project) || 0) + 1);
  }

  const recent = [...issues]
    .sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0))
    .slice(0, 5)
    .map((i) => ({
      title: i.title || i.metadata?.value || i.culprit || 'sans titre',
      project: i.project?.slug || i.project?.name || null,
      lastSeen: i.lastSeen || null,
      count: Number(i.count) || null,
      url: i.permalink || i.webUrl || null,
    }));

  // Une flambée, c'est deux fois le rythme de la semaine — et seulement à
  // partir d'un volume qui veut dire quelque chose. Sans ce plancher, passer
  // de zéro à une issue déclencherait une alerte tous les jours.
  const dailyAverage = active7d.length / 7;
  const surge = active24h.length >= 3 && dailyAverage > 0 && active24h.length > dailyAverage * 2;

  return {
    unresolvedTotal: issues.length,
    active24h: active24h.length,
    active7d: active7d.length,
    // Volume d'événements des issues réveillées dans les 24 h. C'est le total
    // de CHAQUE issue depuis sa création, pas son volume des 24 h : GlitchTip
    // ne sait pas le donner. Affiché comme un ordre de grandeur, jamais comme
    // un décompte de la fenêtre.
    eventsOnActive24h: active24h.reduce((n, i) => n + (Number(i.count) || 0), 0),
    surge,
    surgeRatio: dailyAverage > 0 ? active24h.length / dailyAverage : null,
    // Au-delà de 100 issues, la liste est tronquée : on le dit plutôt que de
    // laisser croire que le total est complet.
    truncated: issues.length >= PAGE_LIMIT,
    perProject: [...perProject.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count),
    recent,
  };
}

module.exports = { collect };
