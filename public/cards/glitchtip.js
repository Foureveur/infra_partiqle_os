import { esc, stat, emptyLine, unknownBlock, ago, timeOf } from './util.js';

export function summary(spec, state) {
  const src = state.sources?.glitchtip;
  const gt = state.incidents?.glitchtip;
  if (!src?.ok || !gt) return { severity: 'unknown', meta: '—', title: src?.error || 'GlitchTip injoignable' };

  const total = gt.unresolvedTotal ?? 0;
  const severity = gt.surge ? 'danger' : total > 0 ? 'warn' : 'ok';
  return { severity, meta: `${total}`, title: gt.surge ? 'Flambée sur 24 h' : '' };
}

export function render(spec, state) {
  const src = state.sources?.glitchtip;
  const gt = state.incidents?.glitchtip;
  if (!src?.ok || !gt) return unknownBlock(src, 'GlitchTip injoignable');

  const issues = gt.recent || [];
  const perProject = gt.perProject || [];

  return `
    <div class="d-thumb-only stat-row">
      ${stat('Non résolues', String(gt.unresolvedTotal ?? 0), { severity: gt.surge ? 'danger' : (gt.unresolvedTotal ? 'warn' : 'ok') })}
    </div>

    <div class="d-mid">
      <div class="stat-row">
        ${stat('Non résolues', String(gt.unresolvedTotal ?? 0), { severity: gt.unresolvedTotal ? 'warn' : 'ok' })}
        ${stat('24 h', String(gt.count24h ?? '—'), { severity: gt.surge ? 'danger' : undefined })}
        ${stat('7 j', String(gt.count7d ?? '—'))}
      </div>
      ${
        gt.surge
          ? `<p style="margin-top:8px"><span class="tag" data-severity="danger">flambée</span>
             <span class="stat__sub">les 24 h pèsent ${gt.surgeRatio ? gt.surgeRatio.toFixed(1) : '—'}× la moyenne des 7 jours</span></p>`
          : ''
      }
    </div>

    <div class="d-normal">
      ${
        issues.length
          ? `<ul class="rows" style="margin-top:8px">${issues
              .slice(0, 3)
              .map(
                (i) => `<li class="row">
                  <span class="row__name">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</span>
                  <span class="row__value">${esc(i.count ?? '')}</span>
                </li>`
              )
              .join('')}</ul>`
          : '<p class="empty" style="margin-top:8px">Aucune erreur non résolue.</p>'
      }
    </div>

    <div class="d-expanded">
      ${
        perProject.length
          ? `<p class="group-label">Par projet</p>
             <ul class="rows">${perProject
               .map((p) => `<li class="row"><span class="row__name">${esc(p.project)}</span><span class="row__value mono">${p.count}</span></li>`)
               .join('')}</ul>`
          : ''
      }
      ${
        issues.length
          ? `<p class="group-label">Les 5 plus récentes</p>
             <ul class="rows">${issues
               .slice(0, 5)
               .map(
                 (i) => `<li class="row">
                    <span class="row__name">${i.url ? `<a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title)}</span>
                    <span class="row__value">${esc(i.project || '')}</span>
                    <span class="row__value mono">${i.lastSeen ? timeOf(i.lastSeen) : ''}</span>
                    <span class="row__value mono">×${esc(i.count ?? 1)}</span>
                  </li>`
               )
               .join('')}</ul>`
          : emptyLine('Rien à afficher.')
      }
      <p class="stat__sub" style="margin-top:8px">Collecté ${ago(src.ageSeconds)}.</p>
    </div>`;
}
