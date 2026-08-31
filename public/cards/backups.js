import { esc, stat, emptyLine, unknownBlock, ago, worst, dateOf } from './util.js';

/* La carte la plus importante et la plus facile à rater. Une carte qui dit
   « OK » parce que le script s'est exécuté, alors qu'il a produit une archive
   vide, est un mensonge (§3.8).

   D'où ce qu'elle affiche : la date du DERNIER SNAPSHOT, lue dans le dépôt par
   le veilleur de chaque machine — pas le code de sortie d'un job. Et quand on
   ne sait pas, elle dit précisément ce qui manque, parce qu'un veilleur non
   greffé et une machine éteinte ne se réparent pas au même endroit. */

const LABEL = {
  ok: 'à jour',
  warn: 'vieillissante',
  danger: 'en retard',
  unknown: 'inconnu',
};

export function summary(spec, state) {
  const src = state.sources?.backups;
  const list = state.backups || [];
  if (!src?.ok || !list.length) {
    return { severity: 'unknown', meta: '—', title: src?.error || 'Aucun état de sauvegarde exploitable' };
  }
  const severity = worst(list.map((b) => b.severity));
  // Le plus VIEUX snapshot, pas le plus récent : la machine la moins bien
  // protégée est celle dont il faut s'inquiéter. Afficher le plus frais
  // masquerait derrière lui une machine oubliée depuis trois jours.
  const oldest = list.reduce((acc, b) => {
    if (!Number.isFinite(b.ageSeconds)) return acc;
    return acc === null || b.ageSeconds > acc ? b.ageSeconds : acc;
  }, null);
  const blind = list.filter((b) => b.severity === 'unknown').length;
  return {
    severity,
    meta: oldest === null ? '—' : ago(oldest),
    title: blind ? `${blind} cible(s) sur lesquelles on ne sait rien` : '',
  };
}

export function render(spec, state) {
  const src = state.sources?.backups;
  const list = state.backups || [];
  if (!src?.ok) return unknownBlock(src, 'État des sauvegardes indisponible');
  if (!list.length) return emptyLine('Aucune cible de sauvegarde déclarée.');

  const late = list.filter((b) => b.severity === 'danger' || b.severity === 'warn');
  const blind = list.filter((b) => b.severity === 'unknown');

  const row = (b) => `
    <li class="row">
      <span class="row__name">${esc(b.target)}</span>
      <span class="row__value mono">${b.lastSnapshotAt ? dateOf(b.lastSnapshotAt) : '—'}</span>
      <span class="row__value mono">${Number.isFinite(b.ageSeconds) ? ago(b.ageSeconds) : ''}</span>
      <span class="tag" data-severity="${b.severity}">${LABEL[b.severity] || b.severity}</span>
    </li>`;

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Cibles', String(list.length))}
      ${stat('En retard', String(late.length), { severity: late.length ? 'danger' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Protégées', String(list.filter((b) => b.severity === 'ok').length), { severity: 'ok' })}
        ${stat('En retard', String(late.length), { severity: late.length ? 'danger' : 'ok' })}
        ${stat('Sans nouvelle', String(blind.length), {
          severity: blind.length ? 'unknown' : 'ok',
          sub: blind.length ? 'ni vert ni rouge' : '',
        })}
      </div>
    </div>

    <div class="d-normal">
      <ul class="rows" style="margin-top:8px">${list.slice(0, 4).map(row).join('')}</ul>
    </div>

    <div class="d-expanded">
      <ul class="rows" style="margin-top:8px">${list.map(row).join('')}</ul>
      ${
        // Le motif de l'inconnu, cible par cible : c'est lui qui dit où aller.
        blind.length
          ? `<p class="group-label">Pourquoi on ne sait pas</p>
             <ul class="rows">${blind
               .map(
                 (b) => `<li class="row"><span class="row__name">${esc(b.target)}</span>
                   <span class="row__value">${esc(b.reason || 'motif inconnu')}</span></li>`
               )
               .join('')}</ul>`
          : ''
      }
      ${list
        .filter((b) => b.message)
        .map((b) => `<p class="stat__sub">${esc(b.target)} : ${esc(b.message)}</p>`)
        .join('')}
      <p class="stat__sub" style="margin-top:8px">
        La date affichée est celle du dernier snapshot présent dans le dépôt, relevée
        par le veilleur de chaque machine — pas l'heure à laquelle un script s'est
        exécuté. Le seuil rouge est celui du veilleur local (${
          list.find((b) => Number.isFinite(b.thresholdSeconds))
            ? Math.round(list.find((b) => Number.isFinite(b.thresholdSeconds)).thresholdSeconds / 3600)
            : 36
        } h par défaut), celui-là même qui déclenche son alerte Telegram.
      </p>
    </div>`;
}
