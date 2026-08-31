import { esc, emptyLine } from './util.js';

/* Le launcher est une carte comme les autres : déplaçable, redimensionnable,
   et son contenu est une liste éditable dans data/links.json — ajouter un lien
   ne demande pas de toucher au code (§4.2). */

/** Rapproche un lien d'un moniteur Kuma, par indice explicite ou par hôte. */
function healthOf(link, monitors) {
  if (!monitors || !monitors.length) return null;
  const hint = (link.monitorHint || '').toLowerCase();
  let host = '';
  try { host = new URL(link.url).host.toLowerCase(); } catch { /* lien non absolu */ }

  const match = monitors.find((m) => {
    const name = (m.name || '').toLowerCase();
    let mHost = '';
    try { mHost = new URL(m.url).host.toLowerCase(); } catch { /* moniteur sans url */ }
    return (hint && (name === hint || mHost === hint)) || (host && mHost === host);
  });
  if (!match) return null;
  return match.paused ? 'unknown' : match.up === false ? 'danger' : 'ok';
}

export function summary(spec, state) {
  const groups = state.links?.groups || [];
  const count = groups.reduce((n, g) => n + g.links.length, 0);
  return { severity: 'ok', meta: String(count), title: '' };
}

export function render(spec, state) {
  const groups = state.links?.groups || [];
  if (!groups.length) return emptyLine('Aucun lien déclaré dans data/links.json.');

  const monitors = state.sources?.kuma?.ok ? state.incidents?.kuma?.monitors || [] : [];

  const chip = (link, external) => {
    const health = external ? null : healthOf(link, monitors);
    return `<a class="chip" href="${esc(link.url)}" target="_blank" rel="noopener"${external ? ' data-external="1"' : ''}>
      ${health ? `<span class="chip__dot" data-severity="${health}"></span>` : ''}
      ${esc(link.label)}${link.until ? ` <span class="row__value">→ ${esc(link.until)}</span>` : ''}
    </a>`;
  };

  const group = (g) => `
    <p class="group-label">${esc(g.label)}</p>
    <div class="chips">${g.links.map((l) => chip(l, g.external)).join('')}</div>`;

  const primary = groups.filter((g) => g.id === 'piloter' || g.id === 'surveiller');
  const rest = groups.filter((g) => !primary.includes(g));

  return `
    <div class="d-thumb-only">
      <div class="chips">${(groups[0]?.links || []).slice(0, 6).map((l) => chip(l, false)).join('')}</div>
    </div>

    <div class="d-mid">${primary.map(group).join('')}</div>

    <div class="d-expanded">${rest.map(group).join('')}</div>`;
}
