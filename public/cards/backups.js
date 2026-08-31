import { esc, stat, emptyLine, unknownBlock, ago, bytes, duration, worst, dateOf } from './util.js';

/* La carte la plus importante et la plus facile à rater. Une carte qui dit
   « OK » parce que le script s'est exécuté, alors qu'il a produit une archive
   vide, est un mensonge (§3.8). D'où : on affiche l'âge, la taille et le code
   de sortie — et on ne prétend rien quand on ne sait pas. */

export function summary(spec, state) {
  const src = state.sources?.backups;
  const list = state.backups || [];
  if (!src?.ok || !list.length) {
    return { severity: 'unknown', meta: '—', title: src?.error || 'Aucun état de sauvegarde exploitable' };
  }
  const severity = worst(list.map((b) => b.severity));
  const newest = list.reduce((a, b) => (a === null || (b.ageSeconds ?? 1e9) < a ? b.ageSeconds ?? 1e9 : a), null);
  return { severity, meta: ago(newest), title: '' };
}

export function render(spec, state) {
  const src = state.sources?.backups;
  const list = state.backups || [];
  if (!src?.ok) return unknownBlock(src, 'État des sauvegardes indisponible');
  if (!list.length) return emptyLine('Aucune sauvegarde déclarée. Le script n’écrit pas encore backups.json.');

  const late = list.filter((b) => b.severity === 'danger' || b.severity === 'warn');

  const row = (b) => `
    <li class="row">
      <span class="row__name">${esc(b.target)}</span>
      <span class="row__value mono">${b.finishedAt ? dateOf(b.finishedAt) : '—'}</span>
      <span class="row__value mono">${ago(b.ageSeconds)}</span>
      ${Number.isFinite(b.sizeBytes) ? `<span class="row__value mono">${bytes(b.sizeBytes)}</span>` : ''}
      <span class="tag" data-severity="${b.severity}">${
        b.severity === 'unknown' ? 'inconnu' : b.ok === false ? 'échec' : b.severity === 'ok' ? 'à jour' : 'en retard'
      }</span>
    </li>`;

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Cibles', String(list.length))}
      ${stat('En retard', String(late.length), { severity: late.length ? 'danger' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Cibles', String(list.length))}
        ${stat('À jour', String(list.filter((b) => b.severity === 'ok').length), { severity: 'ok' })}
        ${stat('En retard ou en échec', String(late.length), { severity: late.length ? 'danger' : 'ok' })}
      </div>
    </div>

    <div class="d-normal">
      <ul class="rows" style="margin-top:8px">${list.slice(0, 4).map(row).join('')}</ul>
    </div>

    <div class="d-expanded">
      <ul class="rows" style="margin-top:8px">${list.map(row).join('')}</ul>
      ${list
        .filter((b) => b.message)
        .map((b) => `<p class="stat__sub">${esc(b.target)} : ${esc(b.message)}</p>`)
        .join('')}
      <p class="stat__sub" style="margin-top:8px">
        Seuils : orange au-delà de ${Math.round((state.thresholds?.backupWarnSeconds ?? 93600) / 3600)} h,
        rouge au-delà de ${Math.round((state.thresholds?.backupCritSeconds ?? 180000) / 3600)} h.
        Durée de la dernière exécution : ${
          list[0] && Number.isFinite(list[0].durationSec) ? duration(list[0].durationSec) : '—'
        }.
      </p>
    </div>`;
}
