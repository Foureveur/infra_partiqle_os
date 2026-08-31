import { esc, stat, bar, pct, bytes, duration, ago, usageSeverity, unknownBlock } from './util.js';

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
      ${
        // L'avis de l'hyperviseur ne rend PAS la machine saine — elle reste
        // inconnue — mais il tranche la seule question utile à cet instant :
        // faut-il rallumer la VM, ou aller réparer l'agent qui s'est tu ?
        m?.vmState
          ? `<div class="d-mid"><p class="unknown-note" style="margin-top:8px"><span>Hostinger voit la VM
             <span class="mono">${esc(m.vmState)}</span> — ${
               m.vmState === 'running'
                 ? "c'est donc l'agent de pousse qui ne parle plus, pas la machine qui est éteinte."
                 : "la machine elle-même n'est pas en marche."
             }</span></p></div>`
          : ''
      }
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
        ${stat('Disque', pct(m.diskPct), {
          severity: disk,
          // Le montage n'est affiché que s'il n'est pas la racine : sinon c'est
          // du bruit, et quand il l'est, c'est l'information qui manque.
          sub: [
            Number.isFinite(m.diskFreeGB) ? `${m.diskFreeGB} Go libres` : '',
            m.diskMount && m.diskMount !== '/' ? `sur ${m.diskMount}` : '',
          ].filter(Boolean).join(' · '),
        })}
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
            ? `<li class="row">
                 <span class="row__name">CPU (Hostinger)</span>
                 <span class="row__value mono" data-severity="${
                   // Une CPU élevée n'est alarmante que rapportée à l'habitude
                   // de la machine : trois fois sa moyenne du jour, et au moins
                   // 40 %, c'est un changement de régime — pas un pic.
                   Number.isFinite(m.cpuAvg24h) && m.cpuAvg24h > 0 && m.cpuPct >= 40 && m.cpuPct > m.cpuAvg24h * 3
                     ? 'warn'
                     : ''
                 }">${pct(m.cpuPct)}</span>
                 ${
                   Number.isFinite(m.cpuAvg24h)
                     ? `<span class="stat__sub">moy. 24 h ${pct(m.cpuAvg24h)}</span>`
                     : ''
                 }
               </li>`
            : ''
        }
        ${
          Number.isFinite(m.outgoingBytes24h)
            ? `<li class="row"><span class="row__name">Trafic sortant 24 h</span><span class="row__value mono">${bytes(m.outgoingBytes24h)}</span></li>`
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
      ${
        (m.filesystems || []).length > 1
          ? `<p class="group-label">Volumes</p>
             <ul class="rows">${m.filesystems
               .slice()
               .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
               .map((f) => `<li class="row"><span class="row__name mono">${esc(f.mount)}</span>
                  <span class="row__value">${f.sizeGB} Go</span>
                  <span class="tag" data-severity="${usageSeverity(f.pct)}">${pct(f.pct)}</span></li>`)
               .join('')}</ul>`
          : ''
      }
    </div>`;
}
