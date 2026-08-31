'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');
const { config } = require('./config');
const { readJson, writeJsonAtomic } = require('./io');
const { defaultLayout, GRID_COLUMNS } = require('./cards');

const MAX_ROWS = 500;
const MAX_CARD_HEIGHT = 40;

class LayoutError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Un utilisateur ne devient un nom de fichier qu'après ce filtre. */
function layoutPathFor(user) {
  if (typeof user !== 'string' || !/^[A-Za-z0-9._@-]{1,64}$/.test(user) || user.includes('..')) {
    throw new LayoutError(400, 'identifiant utilisateur invalide');
  }
  return path.join(config.dataDir, `layout.${user}.json`);
}

function intIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Valide une disposition venue du navigateur. Sévère volontairement : un id
 * inconnu, une largeur hors grille ou un booléen approximatif est un refus, pas
 * une correction silencieuse — sauf pour les tailles minimales, qu'on rabote.
 */
function validate(cards, registry) {
  if (!Array.isArray(cards)) throw new LayoutError(400, 'cards doit être un tableau');
  if (cards.length > registry.cards.length + 8) throw new LayoutError(400, 'trop de cartes');

  const seen = new Set();
  return cards.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new LayoutError(400, `carte ${i} invalide`);
    const spec = registry.byId.get(raw.id);
    if (!spec) throw new LayoutError(400, `carte inconnue : ${String(raw.id).slice(0, 64)}`);
    if (seen.has(raw.id)) throw new LayoutError(400, `carte en double : ${raw.id}`);
    seen.add(raw.id);

    if (typeof raw.collapsed !== 'boolean' || typeof raw.hidden !== 'boolean') {
      throw new LayoutError(400, `collapsed/hidden doivent être des booléens (${raw.id})`);
    }
    const w = clamp(intIn(raw.w, 1, GRID_COLUMNS) ? raw.w : spec.w, spec.minW, GRID_COLUMNS);
    const h = clamp(intIn(raw.h, 1, MAX_CARD_HEIGHT) ? raw.h : spec.h, spec.minH, MAX_CARD_HEIGHT);
    const x = intIn(raw.x, 0, GRID_COLUMNS - 1) ? Math.min(raw.x, GRID_COLUMNS - w) : 0;
    const y = intIn(raw.y, 0, MAX_ROWS) ? raw.y : 0;

    return { id: raw.id, x, y, w, h, collapsed: raw.collapsed, hidden: raw.hidden };
  });
}

/**
 * Fusionne une disposition enregistrée avec le registre courant : une carte
 * ajoutée à data/cards.json apparaît chez un utilisateur qui a déjà une
 * disposition, et une carte supprimée disparaît. Sans ça, ajouter une carte
 * obligerait chaque utilisateur à réinitialiser.
 */
function reconcile(saved, registry) {
  const known = new Map((saved || []).map((c) => [c.id, c]));
  const merged = [];
  let appended = 0;

  for (const spec of registry.cards) {
    const existing = known.get(spec.id);
    if (existing) {
      merged.push(existing);
    } else {
      // Nouvelle carte : sans x/y, GridStack la place en bas, là où elle ne
      // bouscule rien de ce que l'utilisateur a déjà arrangé.
      merged.push({ id: spec.id, w: spec.w, h: spec.h, collapsed: false, hidden: false });
      appended++;
    }
  }
  return { cards: merged, appended };
}

async function load(user, registry) {
  const file = layoutPathFor(user);
  const saved = await readJson(file, null);
  if (!saved || !Array.isArray(saved.cards)) {
    return { cards: defaultLayout(registry), pristine: true, savedAt: null };
  }
  let cards;
  try {
    cards = validate(saved.cards, registry);
  } catch {
    // Un fichier corrompu ou écrit par une version antérieure du registre ne
    // doit pas rendre la page inaccessible : on retombe sur le défaut.
    return { cards: defaultLayout(registry), pristine: true, savedAt: null };
  }
  const { cards: merged } = reconcile(cards, registry);
  return { cards: merged, pristine: false, savedAt: saved.savedAt || null };
}

async function save(user, cards, registry) {
  const file = layoutPathFor(user);
  const validated = validate(cards, registry);
  const payload = { schema: 1, savedAt: new Date().toISOString(), cards: validated };
  await writeJsonAtomic(file, payload);
  return payload;
}

async function reset(user) {
  const file = layoutPathFor(user);
  await fsp.rm(file, { force: true });
}

module.exports = { load, save, reset, validate, layoutPathFor, LayoutError };
