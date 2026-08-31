'use strict';

const { config } = require('./config');

/**
 * Dérive l'état affichable à partir de state.json, À CHAQUE REQUÊTE.
 *
 * C'est le point de conception le plus important du service. Si seul le
 * collecteur décidait de la péremption, un collecteur mort servirait un fichier
 * tout vert : la pastille verte servie à partir d'une donnée périmée est pire
 * que pas de pastille du tout (§2). Ici, state.json ne porte que des
 * horodatages, et c'est le service qui compare à l'heure courante.
 *
 * Règle d'or (§3.1) : une source en échec donne INCONNU — jamais vert, jamais
 * rouge. Rouge veut dire « j'ai regardé et c'est cassé », pas « je n'ai pas pu
 * regarder ».
 */

const SOURCES = ['machines', 'kuma', 'glitchtip', 'roadmaps', 'hostinger', 'backups'];

function ageSeconds(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 1000));
}

function daysUntil(dateStr, now) {
  if (!dateStr) return null;
  const t = Date.parse(dateStr.length === 10 ? `${dateStr}T00:00:00Z` : dateStr);
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now) / 86400000);
}

function emptyState() {
  const sources = {};
  for (const s of SOURCES) sources[s] = { ok: false, at: null, error: 'aucune collecte à ce jour' };
  return {
    schema: 1,
    collectedAt: null,
    sources,
    machines: [],
    services: [],
    platforms: [],
    projects: [],
    deadlines: [],
    incidents: { kuma: null, glitchtip: null, crowdsec: [] },
    backups: [],
  };
}

function decorateSources(state, now) {
  const out = {};
  for (const name of SOURCES) {
    const src = (state.sources && state.sources[name]) || { ok: false, at: null, error: 'source absente' };
    const age = ageSeconds(src.at, now);
    const budget = config.sourceBudgets[name] ?? config.stateStaleSeconds;
    out[name] = {
      ok: src.ok === true,
      at: src.at || null,
      error: src.error || null,
      ageSeconds: age,
      budgetSeconds: budget,
      // Une source qui n'a pas été rafraîchie depuis trop longtemps est
      // périmée même si sa dernière collecte s'était bien passée. Le budget
      // est propre à chaque source : leurs cadences ne sont pas les mêmes.
      stale: src.ok !== true || age === null || age > budget,
    };
  }
  return out;
}

function decorateMachines(state, registry, now) {
  const specs = new Map(
    registry.cards.filter((c) => c.type === 'machine').map((c) => [c.machine, c])
  );
  const reported = new Map((state.machines || []).map((m) => [m.id, m]));

  return [...specs.keys()].map((id) => {
    const spec = specs.get(id);
    const m = reported.get(id) || null;
    const age = m ? ageSeconds(m.reportedAt, now) : null;
    // Le silence n'est pas une bonne nouvelle (§3.2bis.5).
    const silent = age === null || age > config.machineStaleSeconds;

    let status;
    if (silent) status = 'unknown';
    else if (m.up === false) status = 'down';
    else if (m.diskPct >= 90 || (m.containersUnhealthy || []).length > 0 || m.rebootRequired) status = 'warn';
    else status = 'ok';

    // Les champs poussés d'abord, les champs dérivés ENSUITE : une machine ne
    // doit jamais pouvoir s'auto-déclarer « ok » ou monter son propre tier en
    // glissant un champ de plus dans sa charge utile.
    return {
      ...(m || {}),
      id,
      tier: spec.tier,
      role: spec.hint,
      status,
      silent,
      reportedAt: m ? m.reportedAt : null,
      reportedAgeSeconds: age,
    };
  });
}

function decorateServices(state, machines) {
  const silent = new Set(machines.filter((m) => m.silent).map((m) => m.id));
  return (state.services || []).map((s) => ({
    ...s,
    // Un conteneur dont la machine ne parle plus n'est pas « running » :
    // il est inconnu. On ne peint pas du vert avec une donnée figée.
    stale: silent.has(s.machine),
    restartsSuspect: Number.isFinite(s.restarts) && s.restarts > 3,
  }));
}

function decorateBackups(state, sourceOk, now) {
  return (state.backups || []).map((b) => {
    const age = ageSeconds(b.finishedAt, now);
    let severity;
    if (!sourceOk || age === null) severity = 'unknown';
    else if (b.ok === false) severity = 'danger';
    else if (age > config.backupCritSeconds) severity = 'danger';
    else if (age > config.backupWarnSeconds) severity = 'warn';
    else severity = 'ok';
    return { ...b, ageSeconds: age, severity };
  });
}

function decorateDeadlines(state, sourceOk, now) {
  return (state.deadlines || [])
    .map((d) => {
      const days = daysUntil(d.date, now);
      const registrar = d.kind === 'registrar';
      let severity;
      if (!sourceOk) severity = 'unknown';
      else if (days === null) severity = 'unknown';
      else if (days < 0) severity = 'danger';
      else if (days <= (registrar ? 30 : 7)) severity = registrar ? 'danger' : 'warn';
      else if (days <= 30) severity = 'warn';
      else severity = 'ok';
      // Une expiration de domaine dans sa fenêtre d'alerte passe devant tout le
      // reste : la date manquée est irréversible (§3.6). Hors de cette fenêtre,
      // elle reprend simplement son rang chronologique — sans quoi un registrar
      // à J-83 masquerait un jalon à J-4, et on apprendrait à sauter la carte.
      const urgent = registrar && days !== null && days <= 30;
      return { ...d, daysLeft: days, registrar, urgent, severity };
    })
    .sort((a, b) => {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      return (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9);
    });
}

/**
 * Bandeau du haut : ce qui est cassé maintenant. Un incident sur un T1 y remonte,
 * un T3 reste dans sa carte (§5.3).
 */
function buildAlerts(machines, backups, deadlines, sources, kuma) {
  const alerts = [];

  for (const m of machines) {
    if (m.status === 'down' && m.tier === 'T1') {
      alerts.push({ severity: 'danger', scope: m.id, text: `${m.id} ne répond pas` });
    } else if (m.status === 'warn' && m.tier === 'T1') {
      const why = [];
      if (m.diskPct >= 90) why.push(`disque à ${Math.round(m.diskPct)} %`);
      if ((m.containersUnhealthy || []).length) why.push(`${m.containersUnhealthy.length} conteneur(s) unhealthy`);
      if (m.rebootRequired) why.push('redémarrage requis');
      alerts.push({ severity: 'warn', scope: m.id, text: `${m.id} : ${why.join(', ')}` });
    } else if (m.silent && m.tier === 'T1') {
      alerts.push({
        severity: 'unknown',
        scope: m.id,
        text: `${m.id} n'a rien poussé depuis ${m.reportedAgeSeconds === null ? 'toujours' : Math.round(m.reportedAgeSeconds / 60) + ' min'}`,
      });
    }
  }

  for (const b of backups) {
    if (b.severity === 'danger') {
      alerts.push({ severity: 'danger', scope: 'backups', text: `sauvegarde ${b.target} en retard ou en échec` });
    }
  }

  for (const d of deadlines) {
    if (d.registrar && d.severity === 'danger') {
      alerts.push({
        severity: 'danger',
        scope: 'deadlines',
        text: `${d.label} — ${d.daysLeft < 0 ? 'dépassé' : 'J-' + d.daysLeft}`,
      });
    }
  }

  if (kuma && Array.isArray(kuma.monitors)) {
    const down = kuma.monitors.filter((m) => m.up === false && !m.paused);
    if (down.length) {
      alerts.push({
        severity: 'danger',
        scope: 'kuma',
        text: down.length === 1 ? `${down[0].name} est down` : `${down.length} moniteurs down`,
      });
    }
    const paused = kuma.monitors.filter((m) => m.paused);
    if (paused.length) {
      alerts.push({
        severity: 'unknown',
        scope: 'kuma',
        text: `${paused.length} moniteur(s) en pause — trou de couverture`,
      });
    }
  }

  for (const [name, src] of Object.entries(sources)) {
    if (src.stale) {
      alerts.push({
        severity: 'unknown',
        scope: name,
        text: `source ${name} : ${src.error || 'données figées'}`,
      });
    }
  }

  const rank = { danger: 0, warn: 1, unknown: 2 };
  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function decorate(rawState, registry, now = Date.now()) {
  const state = rawState && typeof rawState === 'object' ? rawState : emptyState();
  const sources = decorateSources(state, now);

  const machines = decorateMachines(state, registry, now);
  const services = decorateServices(state, machines);
  const backups = decorateBackups(state, sources.backups.ok, now);
  const deadlines = decorateDeadlines(state, sources.roadmaps.ok, now);

  const kuma = sources.kuma.ok ? state.incidents?.kuma || null : null;
  const glitchtip = sources.glitchtip.ok ? state.incidents?.glitchtip || null : null;

  const collectedAge = ageSeconds(state.collectedAt, now);

  return {
    schema: state.schema || 1,
    serverTime: new Date(now).toISOString(),
    collectedAt: state.collectedAt || null,
    collectedAgeSeconds: collectedAge,
    // Bandeau « données figées depuis 14:32 » (§2).
    frozen: collectedAge === null || collectedAge > config.stateStaleSeconds,
    thresholds: {
      machineStaleSeconds: config.machineStaleSeconds,
      stateStaleSeconds: config.stateStaleSeconds,
      backupWarnSeconds: config.backupWarnSeconds,
      backupCritSeconds: config.backupCritSeconds,
    },
    sources,
    machines,
    services,
    platforms: state.platforms || [],
    projects: sources.roadmaps.ok ? state.projects || [] : [],
    deadlines,
    incidents: {
      kuma,
      glitchtip,
      crowdsec: (state.incidents && state.incidents.crowdsec) || [],
    },
    backups,
    alerts: buildAlerts(machines, backups, deadlines, sources, kuma),
  };
}

module.exports = { decorate, emptyState, ageSeconds, daysUntil, SOURCES };
