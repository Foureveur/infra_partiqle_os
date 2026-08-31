import { esc, stat, emptyLine, worst } from './util.js';

/* CrowdSec est collecté en local par infra-report.sh, machine par machine.
   `cscli` absent n'est pas une erreur : c'est une source ABSENTE (§3.7). */

export function summary(spec, state) {
  const entries = state.incidents?.crowdsec || [];
  const present = entries.filter((e) => e.available);
  if (!present.length) return { severity: 'unknown', meta: '—', title: 'cscli absent ou machines silencieuses' };
  const total = present.reduce((n, e) => n + (e.activeDecisions || 0), 0);
  const severities = entries.map((e) => (e.available ? 'ok' : 'unknown'));
  return { severity: worst(severities), meta: String(total), title: '' };
}

export function render(spec, state) {
  const entries = state.incidents?.crowdsec || [];
  if (!entries.length) return emptyLine('Aucune machine n’a encore remonté CrowdSec.');

  const present = entries.filter((e) => e.available);
  const absent = entries.filter((e) => !e.available);
  const total = present.reduce((n, e) => n + (e.activeDecisions || 0), 0);
  const bans = present.flatMap((e) => (e.recentBans || []).map((b) => ({ ...b, machine: e.machine }))).slice(0, 5);

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Décisions', String(total))}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Décisions actives', String(total))}
        ${stat('Machines couvertes', `${present.length}<span class="stat__sub">/${entries.length}</span>`, {
          severity: absent.length ? 'unknown' : 'ok',
        })}
      </div>
      ${
        absent.length
          ? `<p class="unknown-note" style="margin-top:8px"><span>Sans CrowdSec exploitable : ${esc(
              absent.map((e) => e.machine).join(', ')
            )}</span></p>`
          : ''
      }
    </div>

    <div class="d-expanded">
      <p class="group-label">Par machine</p>
      <ul class="rows">
        ${present
          .map(
            (e) => `<li class="row"><span class="row__name">${esc(e.machine)}</span>
              <span class="row__value mono">${e.activeDecisions ?? '—'}</span></li>`
          )
          .join('')}
      </ul>
      ${
        bans.length
          ? `<p class="group-label">Derniers bannissements</p>
             <ul class="rows">${bans
               .map(
                 (b) => `<li class="row"><span class="row__name mono">${esc(b.ip)}</span>
                   <span class="row__value">${esc(b.scenario || '')}</span>
                   <span class="row__value">${esc(b.machine)}</span></li>`
               )
               .join('')}</ul>`
          : ''
      }
    </div>`;
}
