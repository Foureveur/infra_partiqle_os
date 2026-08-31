import { esc, stat, emptyLine } from './util.js';

/* Table statique du dépôt : aucune API, donc aucune fraîcheur à collecter.
   La seule chose qui se périme ici est la date de vérification (§3.4). */

export function summary(spec, state) {
  const list = state.platforms || [];
  const review = list.filter((p) => p.needsReview);
  return {
    severity: review.length ? 'warn' : 'ok',
    meta: `${list.length}`,
    title: review.length ? `${review.length} à revoir` : '',
  };
}

function row(p) {
  return `<li class="row">
    <span class="row__name"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>
      <span class="row__value">${esc(p.detail || '')}</span></span>
    ${p.status === 'sortie' ? '<span class="tag" data-severity="warn">en sortie</span>' : ''}
    ${p.status === 'prévu' ? '<span class="tag" data-severity="unknown">prévu</span>' : ''}
    ${p.needsReview ? '<span class="tag" data-severity="warn">à revoir</span>' : ''}
    <span class="row__value mono">${esc(p.verifiedAt || '—')}</span>
  </li>`;
}

export function render(spec, state) {
  const list = state.platforms || [];
  if (!list.length) return emptyLine('Table des plateformes vide.');
  const review = list.filter((p) => p.needsReview);

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Plateformes', String(list.length))}
      ${stat('À revoir', String(review.length), { severity: review.length ? 'warn' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Plateformes', String(list.length))}
        ${stat('À revoir', String(review.length), { severity: review.length ? 'warn' : 'ok' })}
      </div>
    </div>

    <div class="d-normal">
      <ul class="rows" style="margin-top:8px">${list.slice(0, 5).map(row).join('')}</ul>
    </div>

    <div class="d-expanded">
      <ul class="rows" style="margin-top:8px">${list.map(row).join('')}</ul>
      <p class="stat__sub" style="margin-top:8px">
        Table éditée à la main : <span class="mono">data/platforms.json</span>.
        « À revoir » = vérification datant de plus de 90 jours.
      </p>
      ${list
        .filter((p) => p.note)
        .map((p) => `<p class="stat__sub">${esc(p.name)} : ${esc(p.note)}</p>`)
        .join('')}
    </div>`;
}
