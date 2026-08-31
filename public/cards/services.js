import { esc, stat, emptyLine, worst, ago } from './util.js';

/** Un conteneur en boucle de redémarrage affiche `running` et paraît sain :
 *  c'est `restarts` qui le trahit (§3.3). */
function severityOf(s) {
  if (s.stale) return 'unknown';
  if (s.state !== 'running') return 'danger';
  if (s.health === 'unhealthy') return 'danger';
  if (s.restartsSuspect) return 'warn';
  return 'ok';
}

export function summary(spec, state) {
  const list = state.services || [];
  if (!list.length) {
    return { severity: 'unknown', meta: '—', title: 'Aucune machine n’a encore poussé sa liste de conteneurs.' };
  }
  const severities = list.map(severityOf);
  const bad = severities.filter((s) => s === 'danger').length;
  const running = list.filter((s) => s.state === 'running' && !s.stale).length;
  return {
    severity: worst(severities),
    meta: bad ? `${bad} en défaut` : `${running}/${list.length}`,
    title: '',
  };
}

export function render(spec, state) {
  const list = state.services || [];
  if (!list.length) return emptyLine('Aucun conteneur remonté pour l’instant.');

  const problems = list.filter((s) => severityOf(s) === 'danger' || severityOf(s) === 'warn');
  const stale = list.filter((s) => s.stale);

  const byMachine = new Map();
  for (const s of list) {
    if (!byMachine.has(s.machine)) byMachine.set(s.machine, []);
    byMachine.get(s.machine).push(s);
  }

  const row = (s) => `
    <li class="row">
      <span class="row__name">${
        s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)
      }</span>
      ${s.restartsSuspect ? `<span class="tag" data-severity="warn">${s.restarts} restarts</span>` : ''}
      <span class="tag" data-severity="${severityOf(s)}">${esc(s.stale ? 'figé' : s.health === 'unhealthy' ? 'unhealthy' : s.state)}</span>
    </li>`;

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Actifs', String(list.filter((s) => s.state === 'running' && !s.stale).length))}
      ${stat('En défaut', String(problems.length), { severity: problems.length ? 'danger' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Conteneurs', String(list.length))}
        ${stat('En marche', String(list.filter((s) => s.state === 'running' && !s.stale).length), { severity: 'ok' })}
        ${stat('En défaut', String(problems.length), { severity: problems.length ? 'danger' : 'ok' })}
        ${stat('Figés', String(stale.length), { severity: stale.length ? 'unknown' : 'ok' })}
      </div>
    </div>

    <div class="d-normal">
      ${
        problems.length
          ? `<ul class="rows" style="margin-top:8px">${problems.slice(0, 6).map(row).join('')}</ul>`
          : '<p class="empty" style="margin-top:8px">Rien en défaut.</p>'
      }
    </div>

    <div class="d-expanded">
      ${[...byMachine.entries()]
        .map(
          ([machine, items]) => `
        <p class="group-label">${esc(machine)} <span class="row__value">${items.length}</span></p>
        <ul class="rows">${items
          .slice()
          .sort((a, b) => (severityOf(a) === severityOf(b) ? a.name.localeCompare(b.name) : severityOf(a) === 'ok' ? 1 : -1))
          .map(row)
          .join('')}</ul>`
        )
        .join('')}
      ${stale.length ? `<p class="stat__sub" style="margin-top:8px">Figé = la machine n’a rien poussé ${ago(state.thresholds?.machineStaleSeconds)} — l’état affiché n’est plus vérifié.</p>` : ''}
    </div>`;
}
