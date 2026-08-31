import * as machine from './machine.js';
import * as services from './services.js';
import * as kuma from './kuma.js';
import * as glitchtip from './glitchtip.js';
import * as crowdsec from './crowdsec.js';
import * as backups from './backups.js';
import * as deadlines from './deadlines.js';
import * as projects from './projects.js';
import * as platforms from './platforms.js';
import * as launcher from './launcher.js';

const RENDERERS = {
  machine,
  services,
  kuma,
  glitchtip,
  crowdsec,
  backups,
  deadlines,
  projects,
  platforms,
  launcher,
};

const FALLBACK = {
  render: (spec) => `<p class="empty">Aucun rendu pour le type « ${spec.type} ».</p>`,
  summary: () => ({ severity: 'unknown', meta: '', title: '' }),
};

/**
 * Un rendu de carte qui jette ne doit pas emporter la page entière : chaque
 * carte est isolée. Une carte cassée s'affiche comme cassée, les autres vivent.
 */
export function renderCard(spec, state) {
  const mod = RENDERERS[spec.type] || FALLBACK;
  try {
    return mod.render(spec, state);
  } catch (err) {
    return `<div class="unknown-note"><span>Rendu impossible : ${String(err.message).slice(0, 120)}</span></div>`;
  }
}

export function cardSummary(spec, state) {
  const mod = RENDERERS[spec.type] || FALLBACK;
  try {
    const s = mod.summary(spec, state);
    return { severity: s.severity || 'unknown', meta: s.meta || '', title: s.title || '' };
  } catch {
    return { severity: 'unknown', meta: '', title: '' };
  }
}
