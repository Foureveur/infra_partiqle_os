import { esc, stat, bar, pct, duration, ago, usageSeverity, unknownBlock } from './util.js';

function find(state, id) {
  return (state.machines || []).find((m) => m.id === id) || null;
}

export function summary(spec, state) {
  const m = find(state, spec.machine);
  if (!m || m.status === 'unknown') {
    return {
      severity: 'unknown',
      meta: m?.reportedAgeSeconds ? ago(m.reportedAgeSeconds) : 'silencieuse',
      title: "La machine n'a rien poussé depuis trop longtemps — état inconnu, pas sain.",
    };
  }
  const severity = m.status === 'down' ? 'danger' : m.status === 'warn' ? 'warn' : 'ok';
  return { severity, meta: duration(m.uptimeSeconds), title: spec.hint || '' };
}

export function render(spec, state) {
  const m = find(state, spec.machine);

  if (!m || m.silent) {
    // Le silence n'est pas une bonne nouvelle (§3.2bis.5).
    return `
      ${unknownBlock(
        { at: m?.reportedAt || null, error: m?.reportedAt ? 'aucune pousse récente' : 'aucune pousse reçue' },
        'Machine silencieuse'
      )}
      <div class="d-expanded">
        <p class="stat__sub">Seuil : ${Math.round((state.thresholds?.machineStaleSeconds ?? 900) / 60)} min sans pousse ⇒ inconnue.
        Vérifier <span class="mono">infra-report.sh</span> et son cron sur cette machine.</p>
      </div>`;
  }

  const disk = usageSeverity(m.diskPct);
  const mem = usageSeverity(m.memPct, 85, 95);
  const unhealthy = m.containersUnhealthy || [];

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Disque', pct(m.diskPct), { severity: disk })}
      ${stat('Conteneurs', `${m.containers?.running ?? '—'}`, { severity: unhealthy.length ? 'warn' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Disque', pct(m.diskPct), { severity: disk, sub: Number.isFinite(m.diskFreeGB) ? `${m.diskFreeGB} Go libres` : '' })}
        ${stat('Mémoire', pct(m.memPct), { severity: mem })}
        ${stat('Charge', m.load ? m.load[0].toFixed(2) : '—', { sub: m.load ? m.load.slice(1).map((v) => v.toFixed(2)).join(' · ') : '' })}
        ${stat('Conteneurs', `${m.containers?.running ?? '—'}<span class="stat__sub">/${m.containers?.total ?? '—'}</span>`, {
          severity: unhealthy.length ? 'warn' : 'ok',
        })}
      </div>
      ${bar(m.diskPct, disk)}
      <p class="stat__sub" style="margin:6px 0 0">
        ${esc(m.hostname || '—')} · ${esc(m.ip || 'IP inconnue')}
        ${m.rebootRequired ? ' · <span class="tag" data-severity="warn">redémarrage requis</span>' : ''}
        ${unhealthy.length ? ` · <span class="tag" data-severity="warn">${unhealthy.length} unhealthy</span>` : ''}
      </p>
    </div>

    <div class="d-expanded">
      <ul class="rows" style="margin-top:10px">
        <li class="row"><span class="row__name">Hôte</span><span class="row__value mono">${esc(m.hostname || '—')}</span></li>
        <li class="row"><span class="row__name">IP</span><span class="row__value mono">${esc(m.ip || '—')}</span></li>
        <li class="row"><span class="row__name">Uptime</span><span class="row__value mono">${duration(m.uptimeSeconds)}</span></li>
        <li class="row"><span class="row__name">Dernière pousse</span><span class="row__value mono">${ago(m.reportedAgeSeconds)}</span></li>
        ${
          Number.isFinite(m.cpuPct)
            ? `<li class="row"><span class="row__name">CPU (Hostinger)</span><span class="row__value mono">${pct(m.cpuPct)}</span></li>`
            : ''
        }
      </ul>
      ${
        m.rebootRequired
          ? '<p style="margin:8px 0 0"><span class="tag" data-severity="warn">redémarrage requis</span></p>'
          : ''
      }
      ${
        unhealthy.length
          ? `<p style="margin:8px 0 0"><span class="tag" data-severity="warn">${unhealthy.length} conteneur(s) unhealthy</span>
             <span class="row__value mono">${esc(unhealthy.slice(0, 4).join(', '))}</span></p>`
          : ''
      }
      ${
        !m.dockerAvailable
          ? '<p style="margin:8px 0 0"><span class="tag" data-severity="unknown">docker non interrogeable</span></p>'
          : ''
      }
    </div>`;
}
