import { esc, emptyLine, unknownBlock, worst } from './util.js';

/* Les échéances registrar sont la classe la plus dangereuse : une date manquée
   est irréversible. Elles passent en tête, avec un compte à rebours en jours et
   un seuil d'alerte à J-30 (§3.6). */

export function summary(spec, state) {
  const src = state.sources?.roadmaps;
  const list = state.deadlines || [];
  if (!src?.ok) return { severity: 'unknown', meta: '—', title: src?.error || 'Roadmaps injoignable' };
  if (!list.length) return { severity: 'ok', meta: '0', title: '' };
  const next = list.find((d) => (d.daysLeft ?? 1e9) >= 0);
  return {
    severity: worst(list.map((d) => d.severity)),
    meta: next ? `J-${next.daysLeft}` : 'dépassé',
    title: next ? next.label : '',
  };
}

function countdown(d) {
  if (d.daysLeft === null) return '<span class="countdown" data-severity="unknown">—</span>';
  if (d.daysLeft < 0) {
    return `<span class="countdown" data-severity="danger"><span class="countdown__n">dépassé</span> de ${-d.daysLeft} j</span>`;
  }
  return `<span class="countdown" data-severity="${d.severity}"><span class="countdown__n">J-${d.daysLeft}</span></span>`;
}

function row(d) {
  return `<li class="row">
    ${countdown(d)}
    <span class="row__name">${esc(d.label)}${d.registrar ? ' <span class="tag" data-severity="danger">registrar</span>' : ''}</span>
    <span class="row__value mono">${esc(d.date || '')}</span>
  </li>`;
}

export function render(spec, state) {
  const src = state.sources?.roadmaps;
  if (!src?.ok) return unknownBlock(src, 'Échéances indisponibles');

  const list = state.deadlines || [];
  if (!list.length) return emptyLine('Aucune échéance dans les 90 prochains jours.');

  const overdue = list.filter((d) => (d.daysLeft ?? 0) < 0);
  const soon = list.filter((d) => (d.daysLeft ?? 1e9) >= 0);

  return `
    <div class="d-thumb-only">
      <ul class="rows">${list.slice(0, 2).map(row).join('')}</ul>
    </div>

    <div class="d-normal">
      ${overdue.length ? `<p class="group-label">Dépassées</p><ul class="rows">${overdue.map(row).join('')}</ul>` : ''}
      <ul class="rows">${soon.slice(0, 6).map(row).join('')}</ul>
    </div>

    <div class="d-expanded">
      ${overdue.length ? `<p class="group-label">Dépassées</p><ul class="rows">${overdue.map(row).join('')}</ul>` : ''}
      <p class="group-label">Les 90 prochains jours</p>
      <ul class="rows">${soon.map(row).join('')}</ul>
    </div>`;
}
