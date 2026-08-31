import { esc, stat, emptyLine, unknownBlock, bar, dateOf } from './util.js';

export function summary(spec, state) {
  const src = state.sources?.roadmaps;
  const list = state.projects || [];
  if (!src?.ok) return { severity: 'unknown', meta: '—', title: src?.error || 'Roadmaps injoignable' };
  const blocked = list.reduce((n, p) => n + (p.blocked || 0), 0);
  return {
    severity: blocked ? 'warn' : 'ok',
    meta: `${list.length}`,
    title: blocked ? `${blocked} élément(s) bloqué(s)` : '',
  };
}

function progressOf(p) {
  const done = p.progress?.subtasksDone ?? 0;
  const total = p.progress?.subtasksTotal ?? 0;
  return total > 0 ? Math.round((done / total) * 100) : null;
}

function row(p) {
  const pctDone = progressOf(p);
  return `<li class="row" style="flex-wrap:wrap">
    <span class="row__name">${
      p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)
    }</span>
    ${p.blocked ? `<span class="tag" data-severity="warn">${p.blocked} bloqué</span>` : ''}
    <span class="row__value mono">${pctDone === null ? '—' : pctDone + ' %'}</span>
    <span style="flex-basis:100%">${bar(pctDone ?? 0, pctDone === null ? 'unknown' : 'ok')}</span>
  </li>`;
}

export function render(spec, state) {
  const src = state.sources?.roadmaps;
  if (!src?.ok) {
    return `${unknownBlock(src, 'Projets indisponibles')}
      <div class="d-expanded"><p class="stat__sub">La v1 dépend de <span class="mono">GET /api/infra/summary</span>
      côté Roadmaps. Tant que cet endpoint n’existe pas, cette carte reste grise — pas verte.</p></div>`;
  }

  const list = state.projects || [];
  if (!list.length) return emptyLine('Aucun projet remonté par Roadmaps.');

  const blocked = list.reduce((n, p) => n + (p.blocked || 0), 0);
  const now = list.reduce((n, p) => n + (p.counts?.now || 0), 0);

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Projets', String(list.length))}
      ${stat('Bloqués', String(blocked), { severity: blocked ? 'warn' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Projets', String(list.length))}
        ${stat('En cours', String(now))}
        ${stat('Bloqués', String(blocked), { severity: blocked ? 'warn' : 'ok' })}
      </div>
    </div>

    <div class="d-normal">
      <ul class="rows" style="margin-top:8px">${list.slice(0, 4).map(row).join('')}</ul>
    </div>

    <div class="d-expanded">
      <ul class="rows" style="margin-top:8px">${list.map(row).join('')}</ul>
      <p class="group-label">Prochain jalon par projet</p>
      <ul class="rows">
        ${list
          .filter((p) => p.nextMarker)
          .map(
            (p) => `<li class="row"><span class="row__name">${esc(p.title)}</span>
              <span class="row__value">${esc(p.nextMarker.label)}</span>
              <span class="row__value mono">${dateOf(p.nextMarker.date)}</span></li>`
          )
          .join('') || '<li class="empty">Aucun jalon à venir.</li>'}
      </ul>
    </div>`;
}
