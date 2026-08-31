'use strict';

const { config } = require('../../lib/config');
const { fetchJson } = require('../fetch');

/**
 * Roadmaps — projets et jalons (§3.5, §3.6).
 *
 * Le contrat ci-dessous n'est pas celui du brief : il a été relevé le 31/08 en
 * lisant l'implémentation réelle dans partiqle-roadmaps
 * (src/routes/api/v1/infra/summary/+server.ts et src/lib/server/infra.ts).
 * Trois écarts, tous côté client :
 *
 *   - l'endpoint est /api/v1/infra/summary, pas /api/infra/summary ;
 *   - la liste des projets s'appelle `roadmaps`, pas `projects` ;
 *   - les compteurs sont `itemCounts` et `statusCounts`, pas `counts`/`blocked`.
 *
 * L'endpoint borne déjà `markers[]` à J-7 → J+90 et signale sa propre troncature
 * au-delà de 400 jalons.
 */

const HORIZON_DAYS = 90;
const REGISTRAR_RE = /(expiration|renouvellement|registrar|domaine|\.fr\b|\.com\b|\.studio\b|\.immo\b)/i;

function normalizeProject(p) {
  return {
    id: p.id || null,
    title: p.title || 'sans titre',
    section: p.section || null,
    url: p.url || (p.id ? `https://roadmaps.partiqle.studio/roadmap/${p.id}` : null),
    updatedAt: p.updatedAt || null,
    counts: {
      now: p.itemCounts?.now ?? 0,
      next: p.itemCounts?.next ?? 0,
      later: p.itemCounts?.later ?? 0,
      ideas: p.itemCounts?.ideas ?? 0,
    },
    progress: {
      subtasksDone: p.progress?.subtasksDone ?? 0,
      subtasksTotal: p.progress?.subtasksTotal ?? 0,
    },
    blocked: p.statusCounts?.blocked ?? 0,
    nextMarker: p.nextMarker || null,
  };
}

/**
 * Roadmaps type ses jalons en `milestone` / `rdv` / `payment` — il n'a pas de
 * notion de registrar. Or une expiration de domaine est irréversible, donc elle
 * doit se distinguer. On la reconnaît au libellé : l'heuristique est
 * délibérément large, un faux positif se voit et se corrige, une date manquée
 * ne se rattrape pas.
 */
function markerKind(marker) {
  if (REGISTRAR_RE.test(marker.label || '')) return 'registrar';
  return marker.type || 'milestone';
}

function collectMarkers(payload, projects) {
  const raw = Array.isArray(payload.markers) ? payload.markers : [];
  const fromProjects = projects
    .filter((p) => p.nextMarker && p.nextMarker.date)
    .map((p) => ({ ...p.nextMarker, roadmapTitle: p.title }));

  const seen = new Set();
  const horizon = Date.now() + HORIZON_DAYS * 86400_000;

  return [...raw, ...fromProjects]
    .filter((m) => m && m.date && m.label)
    .map((m) => ({
      date: m.date,
      label: m.label,
      kind: markerKind(m),
      project: m.roadmapTitle || null,
    }))
    .filter((m) => {
      const t = Date.parse(m.date.length === 10 ? `${m.date}T00:00:00Z` : m.date);
      if (!Number.isFinite(t)) return false;
      // On garde tout ce qui est déjà dépassé : une échéance ratée doit rester
      // visible, pas disparaître de la liste.
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

  // `roadmaps` est la forme réelle ; les deux autres sont tolérées pour ne pas
  // casser si l'endpoint évolue vers le nom du brief.
  const list = payload.roadmaps || payload.projects || (Array.isArray(payload) ? payload : null);
  if (!Array.isArray(list)) {
    throw new Error('réponse inattendue : ni roadmaps[], ni projects[], ni tableau');
  }

  const projects = list.map(normalizeProject);
  const notes = [];
  if (payload.truncated?.markers) notes.push(payload.truncated.markers);

  return {
    projects,
    deadlines: collectMarkers(Array.isArray(payload) ? {} : payload, projects),
    generatedAt: payload.generatedAt || null,
    notes,
  };
}

module.exports = { collect, markerKind };
