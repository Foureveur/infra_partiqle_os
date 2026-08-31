'use strict';

const { config } = require('../../lib/config');
const { fetchJson } = require('../fetch');

/**
 * Roadmaps — projets et jalons (§3.5, §3.6).
 *
 * L'endpoint est à construire côté Roadmaps ; le contrat exact est dans
 * docs/roadmaps-infra-summary.md. Deux formes sont acceptées :
 *   - `[ {projet}, … ]`                    — la forme du brief, jalons via nextMarker
 *   - `{ projects: [...], markers: [...] } — forme préférée, jalons complets
 * La seconde existe parce que deadlines[] réclame « les markers des roadmaps »,
 * pas seulement le prochain de chaque projet.
 */

const HORIZON_DAYS = 90;
const REGISTRAR_RE = /(expiration|renouvellement|registrar|domaine|\.fr\b|\.com\b|\.studio\b|\.immo\b)/i;

function normalizeProject(p) {
  return {
    id: p.id || null,
    title: p.title || 'sans titre',
    section: p.section || null,
    url: p.url || (p.id ? `https://roadmaps.partiqle.studio/r/${p.id}` : null),
    updatedAt: p.updatedAt || null,
    counts: {
      now: p.counts?.now ?? 0,
      next: p.counts?.next ?? 0,
      later: p.counts?.later ?? 0,
      ideas: p.counts?.ideas ?? 0,
    },
    progress: {
      subtasksDone: p.progress?.subtasksDone ?? 0,
      subtasksTotal: p.progress?.subtasksTotal ?? 0,
    },
    blocked: p.blocked ?? 0,
    nextMarker: p.nextMarker || null,
  };
}

/** Une expiration de domaine n'est pas un jalon comme un autre : elle est
 *  irréversible. On la reconnaît à son `kind` si Roadmaps le donne, sinon au
 *  libellé — mieux vaut un faux positif signalé qu'une date manquée. */
function markerKind(marker) {
  if (marker.kind) return marker.kind;
  return REGISTRAR_RE.test(marker.label || '') ? 'registrar' : 'milestone';
}

function collectMarkers(payload, projects) {
  const raw = Array.isArray(payload.markers) ? payload.markers : [];
  const fromProjects = projects
    .filter((p) => p.nextMarker && p.nextMarker.date)
    .map((p) => ({ ...p.nextMarker, project: p.title }));

  const seen = new Set();
  const horizon = Date.now() + HORIZON_DAYS * 86400_000;

  return [...raw, ...fromProjects]
    .filter((m) => m && m.date && m.label)
    .map((m) => ({ date: m.date, label: m.label, kind: markerKind(m), project: m.project || null }))
    .filter((m) => {
      const t = Date.parse(m.date.length === 10 ? `${m.date}T00:00:00Z` : m.date);
      if (!Number.isFinite(t)) return false;
      // On garde les 90 prochains jours, et tout ce qui est déjà dépassé : une
      // échéance ratée doit rester visible, pas disparaître de la liste.
      if (t > horizon) return false;
      const key = `${m.date}|${m.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function collect() {
  if (!config.roadmaps.token) throw new Error('ROADMAPS_TOKEN absent');

  const payload = await fetchJson(config.roadmaps.summaryUrl, {
    // Jeton de service dans l'en-tête, jamais dans l'URL (§3.5).
    headers: { Authorization: `Bearer ${config.roadmaps.token}`, Accept: 'application/json' },
    timeoutMs: 10_000,
  });

  const list = Array.isArray(payload) ? payload : payload.projects;
  if (!Array.isArray(list)) throw new Error('réponse inattendue : ni tableau ni { projects }');

  const projects = list.map(normalizeProject);
  return { projects, deadlines: collectMarkers(Array.isArray(payload) ? {} : payload, projects) };
}

module.exports = { collect, markerKind };
