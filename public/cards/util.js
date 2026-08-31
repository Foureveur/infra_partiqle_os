/* Fonctions partagées par les rendus de cartes. */

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * Bloc « inconnu ». Une source qui a échoué n'est pas une source qui va bien :
 * on montre l'heure de la dernière valeur bonne et l'erreur, jamais une
 * pastille verte ou rouge (§3.1).
 */
export function unknownBlock(source, label = 'Données indisponibles') {
  const at = source?.at ? `dernière valeur bonne à ${timeOf(source.at)}` : 'aucune valeur connue';
  const why = source?.error ? ` — ${esc(source.error)}` : '';
  return `<div class="unknown-note" title="${esc(source?.error || '')}"><span>${esc(label)} · ${esc(at)}${why}</span></div>`;
}

export function timeOf(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function dateOf(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} j ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export function ago(seconds) {
  if (!Number.isFinite(seconds)) return 'jamais';
  if (seconds < 90) return "à l'instant";
  return `il y a ${duration(seconds)}`;
}

export function bytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function pct(v) {
  return Number.isFinite(v) ? `${Math.round(v)} %` : '—';
}

/** Seuils communs pour un pourcentage d'occupation. */
export function usageSeverity(value, warn = 80, danger = 90) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= danger) return 'danger';
  if (value >= warn) return 'warn';
  return 'ok';
}

export function stat(label, value, { severity, sub } = {}) {
  return `<div class="stat">
    <span class="stat__label">${esc(label)}</span>
    <span class="stat__value"${severity ? ` data-severity="${severity}"` : ''}>${value}</span>
    ${sub ? `<span class="stat__sub">${esc(sub)}</span>` : ''}
  </div>`;
}

export function bar(value, severity) {
  const w = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return `<div class="bar"><div class="bar__fill" data-severity="${severity}" style="width:${w}%"></div></div>`;
}

export function emptyLine(text) {
  return `<p class="empty">${esc(text)}</p>`;
}

/** Le pire de plusieurs sévérités — l'inconnu ne masque pas un danger réel. */
export function worst(list) {
  const order = ['danger', 'warn', 'unknown', 'ok'];
  for (const level of order) if (list.includes(level)) return level;
  return 'unknown';
}
