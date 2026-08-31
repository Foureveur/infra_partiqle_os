import { esc, stat, emptyLine, unknownBlock, duration, worst } from './util.js';

export function summary(spec, state) {
  const src = state.sources?.kuma;
  const kuma = state.incidents?.kuma;
  if (!src?.ok || !kuma) return { severity: 'unknown', meta: '—', title: src?.error || 'Kuma injoignable' };

  const monitors = kuma.monitors || [];
  const down = monitors.filter((m) => !m.paused && m.up === false);
  const paused = monitors.filter((m) => m.paused);
  const severities = [];
  if (down.length) severities.push('danger');
  if (paused.length) severities.push('unknown');
  if (!severities.length) severities.push('ok');

  return {
    severity: worst(severities),
    meta: `${monitors.length - paused.length - down.length}/${monitors.length}`,
    title: down.length ? `${down.length} moniteur(s) down` : paused.length ? `${paused.length} en pause` : '',
  };
}

export function render(spec, state) {
  const src = state.sources?.kuma;
  const kuma = state.incidents?.kuma;
  if (!src?.ok || !kuma) return unknownBlock(src, 'Kuma injoignable');

  const monitors = kuma.monitors || [];
  if (!monitors.length) return emptyLine('Aucun moniteur remonté.');

  const down = monitors.filter((m) => !m.paused && m.up === false);
  const paused = monitors.filter((m) => m.paused);
  const up = monitors.filter((m) => !m.paused && m.up === true);

  const row = (m) => `
    <li class="row">
      <span class="row__name">${
        m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>` : esc(m.name)
      }</span>
      ${Number.isFinite(m.uptime24h) ? `<span class="row__value">${(m.uptime24h * 100).toFixed(1)} %</span>` : ''}
      ${Number.isFinite(m.avgResponseMs) ? `<span class="row__value">${Math.round(m.avgResponseMs)} ms</span>` : ''}
      <span class="tag" data-severity="${m.paused ? 'unknown' : m.up === false ? 'danger' : 'ok'}">${
        m.paused ? 'en pause' : m.up === false ? 'down' : 'up'
      }</span>
    </li>`;

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Down', String(down.length), { severity: down.length ? 'danger' : 'ok' })}
      ${stat('En pause', String(paused.length), { severity: paused.length ? 'unknown' : 'ok' })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Surveillés', String(up.length + down.length))}
        ${stat('Down', String(down.length), { severity: down.length ? 'danger' : 'ok' })}
        ${stat('En pause', String(paused.length), { severity: paused.length ? 'unknown' : 'ok' })}
      </div>
      ${
        paused.length
          ? `<p class="unknown-note" style="margin-top:8px"><span>${paused.length} moniteur(s) en pause : ce n’est pas du vert, c’est un trou de couverture.</span></p>`
          : ''
      }
      ${
        kuma.pausedDetection === false
          ? `<p class="unknown-note" style="margin-top:8px"><span>Couverture non vérifiable : sans page de statut Kuma, un moniteur en pause est indistinguable d’un moniteur supprimé.</span></p>`
          : ''
      }
    </div>

    <div class="d-normal">
      ${down.length ? `<ul class="rows" style="margin-top:8px">${down.map(row).join('')}</ul>` : ''}
    </div>

    <div class="d-expanded">
      <ul class="rows" style="margin-top:8px">${[...down, ...paused, ...up].map(row).join('')}</ul>
      ${
        down.length
          ? `<p class="stat__sub" style="margin-top:8px">Down depuis : ${down
              .map((m) => `${esc(m.name)} ${m.downSince ? duration((Date.now() - Date.parse(m.downSince)) / 1000) : '—'}`)
              .join(' · ')}</p>`
          : ''
      }
    </div>`;
}
