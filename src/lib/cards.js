'use strict';

const path = require('node:path');
const { config } = require('./config');
const { readJsonSync } = require('./io');

const GRID_COLUMNS = 12;

/**
 * Registre des cartes = cartes statiques (data/cards.json) + une carte par
 * machine dérivée de data/machines.json. C'est la seule source de vérité pour :
 *  - la disposition par défaut à la première ouverture,
 *  - la validation des PUT /api/layout (un id inconnu est refusé).
 *
 * Rechargé à chaque appel : ces tables sont éditables à la main sur la machine,
 * et ajouter un lien ou une plateforme ne doit pas demander de redémarrer.
 */
function loadRegistry() {
  const spec = readJsonSync(path.join(config.tablesDir, 'cards.json'), null);
  const machines = readJsonSync(path.join(config.tablesDir, 'machines.json'), []) || [];
  if (!spec || !Array.isArray(spec.cards)) {
    throw new Error('data/cards.json illisible ou malformé');
  }

  const tierWidth = spec.tierWidth || { T1: 6, T2: 4, T3: 3 };
  const widthFor = (tier) => tierWidth[tier] || tierWidth.T2 || 4;
  const mc = spec.machineCard || { h: 6, minW: 3, minH: 2, orderBase: 30 };

  const cards = spec.cards.map((c) => ({
    id: c.id,
    title: c.title,
    type: c.type,
    tier: c.tier || 'T2',
    source: c.source || 'static',
    w: c.w || widthFor(c.tier),
    h: c.h || 6,
    minW: c.minW || 3,
    minH: c.minH || 2,
    order: c.order ?? 500,
    hint: c.hint || null,
  }));

  machines.forEach((m, i) => {
    cards.push({
      id: `machines.${m.id}`,
      title: m.id,
      type: 'machine',
      machine: m.id,
      tier: m.tier || 'T2',
      source: 'machines',
      w: widthFor(m.tier),
      h: mc.h,
      minW: mc.minW,
      minH: mc.minH,
      order: (mc.orderBase ?? 30) + i,
      hint: m.shortRole || null,
    });
  });

  cards.sort((a, b) => a.order - b.order);
  return { cards, byId: new Map(cards.map((c) => [c.id, c])), gridColumns: GRID_COLUMNS };
}

/**
 * Disposition par défaut : pas de x/y. GridStack tasse en haut à gauche dans
 * l'ordre déclaré, ce qui donne une disposition déjà juste — Échéances puis
 * Disponibilité en tête, machines ensuite (§5.3).
 */
function defaultLayout(registry) {
  return registry.cards.map((c) => ({
    id: c.id,
    w: c.w,
    h: c.h,
    collapsed: false,
    hidden: false,
  }));
}

module.exports = { loadRegistry, defaultLayout, GRID_COLUMNS };
