import { renderCard, cardSummary } from './cards/index.js';

/* infra.partiqle.studio — grille pilotable.
   La disposition appartient à l'utilisateur et vit sur le serveur : aucune
   trace dans localStorage, parce qu'une disposition qui ne suit pas d'une
   machine à l'autre est une disposition qu'on refait trois fois puis qu'on
   abandonne (§5.1). */

const GRID = {
  columns: 12,
  cellHeight: 40,
  margin: 8,
  collapsedRows: 2, // en-tête seul
  mobileBreakpoint: 768,
};

const REFRESH_MS = 30_000;
const TICK_MS = 10_000;
const SAVE_DEBOUNCE_MS = 500;

const el = {
  grid: document.getElementById('grid'),
  alerts: document.getElementById('alerts'),
  freshness: document.getElementById('freshness'),
  freshnessText: document.getElementById('freshness-text'),
  saveIndicator: document.getElementById('save-indicator'),
  btnEdit: document.getElementById('btn-edit'),
  btnReset: document.getElementById('btn-reset'),
  btnDrawer: document.getElementById('btn-drawer'),
  btnTheme: document.getElementById('btn-theme'),
  drawer: document.getElementById('drawer'),
  drawerList: document.getElementById('drawer-list'),
  drawerCount: document.getElementById('drawer-count'),
  drawerClose: document.getElementById('drawer-close'),
  confirm: document.getElementById('confirm'),
  confirmOk: document.getElementById('confirm-ok'),
  confirmCancel: document.getElementById('confirm-cancel'),
  emptyNote: document.getElementById('empty-note'),
  template: document.getElementById('card-template'),
};

/** État client. `h` est TOUJOURS la hauteur dépliée : replier n'efface pas
 *  la taille que l'utilisateur avait choisie. */
const store = {
  cards: [],          // [{id,x,y,w,h,collapsed,hidden}]
  specs: new Map(),   // id -> registre serveur
  state: null,        // /api/state décoré
  skewMs: 0,          // horloge locale - horloge serveur
  editing: false,
  grid: null,
  bodies: new Map(),  // id -> élément .card__body
  heads: new Map(),   // id -> élément .card
  saveTimer: null,
};

const isMobile = () => window.innerWidth < GRID.mobileBreakpoint;

/* ---------------------------------------------------------------- réseau */

async function api(path, options) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const err = new Error(detail.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.reason = detail.reason;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------------------------------------ disposition */

function visibleCards() {
  return store.cards.filter((c) => !c.hidden);
}

function densityFor(card) {
  if (card.collapsed) return 'thumb';
  if (card.h <= 3) return 'thumb';
  if (card.h <= 7) return 'normal';
  return 'expanded';
}

function buildCardElement(card) {
  const spec = store.specs.get(card.id);
  const item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.setAttribute('gs-id', card.id);
  item.setAttribute('gs-w', String(card.w));
  item.setAttribute('gs-h', String(card.collapsed ? GRID.collapsedRows : card.h));
  item.setAttribute('gs-min-w', String(spec?.minW ?? 3));
  item.setAttribute('gs-min-h', String(GRID.collapsedRows));
  // Sans x/y (première ouverture), GridStack tasse en haut à gauche dans
  // l'ordre du DOM : la disposition par défaut est déjà juste.
  if (Number.isInteger(card.x)) item.setAttribute('gs-x', String(card.x));
  if (Number.isInteger(card.y)) item.setAttribute('gs-y', String(card.y));

  const content = document.createElement('div');
  content.className = 'grid-stack-item-content';

  const node = el.template.content.firstElementChild.cloneNode(true);
  node.dataset.cardId = card.id;
  node.dataset.tier = spec?.tier || 'T2';
  node.dataset.collapsed = String(card.collapsed);
  node.dataset.density = densityFor(card);
  node.querySelector('.card__title').textContent = spec?.title || card.id;

  node.querySelector('.card__chevron').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleCollapse(card.id);
  });
  node.querySelector('.card__hide').addEventListener('click', (e) => {
    e.stopPropagation();
    hideCard(card.id);
  });
  // Un glisser sur l'en-tête déplace la carte ; il ne doit pas aussi replier.
  node.querySelector('.card__head').addEventListener('dblclick', () => toggleCollapse(card.id));

  content.appendChild(node);
  item.appendChild(content);

  store.bodies.set(card.id, node.querySelector('.card__body'));
  store.heads.set(card.id, node);
  return item;
}

function buildGrid() {
  if (store.grid) {
    store.grid.destroy(false);
    store.grid = null;
  }
  store.bodies.clear();
  store.heads.clear();
  el.grid.innerHTML = '';

  const cards = visibleCards();
  el.emptyNote.hidden = cards.length > 0;
  for (const card of cards) el.grid.appendChild(buildCardElement(card));

  store.grid = GridStack.init(
    {
      column: GRID.columns,
      cellHeight: GRID.cellHeight,
      margin: GRID.margin,
      float: false,
      animate: true,
      // Consultation par défaut : rien ne bouge, aucun risque de déplacer une
      // carte en scrollant (§5.2).
      staticGrid: !store.editing || isMobile(),
      draggable: { handle: '.card__head' },
      resizable: { handles: 'se' },
      // Sous 768 px : une colonne, dans l'ordre y puis x de la disposition
      // enregistrée. GridStack s'en charge, on n'enregistre simplement rien.
      columnOpts: { breakpointForWindow: true, breakpoints: [{ w: GRID.mobileBreakpoint, c: 1 }] },
    },
    el.grid
  );

  store.grid.on('change', (event, items) => {
    if (!items) return;
    let touched = false;
    for (const node of items) {
      const card = store.cards.find((c) => c.id === node.id);
      if (!card) continue;
      card.x = node.x;
      card.y = node.y;
      card.w = node.w;
      // Replié, la hauteur affichée est celle de l'en-tête : elle ne doit pas
      // écraser la hauteur dépliée que l'utilisateur avait choisie.
      if (!card.collapsed) card.h = node.h;
      touched = true;
    }
    if (touched) {
      applyDensities();
      scheduleSave();
    }
  });

  renderAllBodies();
}

function applyDensities() {
  for (const card of visibleCards()) {
    const node = store.heads.get(card.id);
    if (node) node.dataset.density = densityFor(card);
  }
}

function toggleCollapse(id) {
  const card = store.cards.find((c) => c.id === id);
  if (!card) return;
  card.collapsed = !card.collapsed;

  const node = store.heads.get(id);
  const item = node?.closest('.grid-stack-item');
  if (node) node.dataset.collapsed = String(card.collapsed);
  if (item && store.grid) {
    store.grid.update(item, {
      h: card.collapsed ? GRID.collapsedRows : card.h,
      noResize: card.collapsed,
    });
  }
  applyDensities();
  scheduleSave();
}

function hideCard(id) {
  const card = store.cards.find((c) => c.id === id);
  if (!card) return;
  card.hidden = true;
  buildGrid();
  renderDrawer();
  scheduleSave();
}

function showCard(id) {
  const card = store.cards.find((c) => c.id === id);
  if (!card) return;
  card.hidden = false;
  // Elle revient sans x/y : posée là où elle ne bouscule rien.
  delete card.x;
  delete card.y;
  buildGrid();
  renderDrawer();
  scheduleSave();
}

/* ------------------------------------------------------- enregistrement */

function scheduleSave() {
  if (store.saveTimer) clearTimeout(store.saveTimer);
  store.saveTimer = setTimeout(saveLayout, SAVE_DEBOUNCE_MS);
}

async function saveLayout() {
  store.saveTimer = null;
  // Le bug classique : le téléphone repasse tout en une colonne et écrase la
  // disposition bureau. On ne tente même pas ; le serveur refuse aussi (§5.2).
  if (isMobile()) return;

  const payload = {
    viewportWidth: window.innerWidth,
    cards: store.cards.map((c) => ({
      id: c.id,
      x: Number.isInteger(c.x) ? c.x : 0,
      y: Number.isInteger(c.y) ? c.y : 0,
      w: c.w,
      h: c.h,
      collapsed: !!c.collapsed,
      hidden: !!c.hidden,
    })),
  };

  try {
    await api('/api/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    flash('disposition enregistrée');
  } catch (err) {
    if (err.reason === 'viewport-too-small') return;
    flash('enregistrement refusé : ' + err.message, 'error');
  }
}

let flashTimer = null;
function flash(text, state) {
  el.saveIndicator.textContent = text;
  el.saveIndicator.dataset.visible = '1';
  el.saveIndicator.dataset.state = state || 'ok';
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.saveIndicator.dataset.visible = '0';
  }, state === 'error' ? 6000 : 2200);
}

/* -------------------------------------------------------------- rendu data */

function renderAllBodies() {
  if (!store.state) return;
  for (const card of visibleCards()) {
    const body = store.bodies.get(card.id);
    const node = store.heads.get(card.id);
    const spec = store.specs.get(card.id);
    if (!body || !spec) continue;

    body.innerHTML = renderCard(spec, store.state);
    const summary = cardSummary(spec, store.state);
    node.querySelector('.card__pill').dataset.severity = summary.severity;
    node.querySelector('.card__pill').title = summary.title || '';
    node.querySelector('.card__meta').textContent = summary.meta || '';
  }
}

function renderAlerts() {
  const alerts = store.state?.alerts || [];
  el.alerts.hidden = alerts.length === 0;
  el.alerts.innerHTML = alerts
    .slice(0, 8)
    .map(
      (a) =>
        `<span class="alert" data-severity="${a.severity}"><span class="alert__scope">${escapeHtml(a.scope)}</span>${escapeHtml(a.text)}</span>`
    )
    .join('');
}

function renderFreshness() {
  const s = store.state;
  if (!s) return;
  const age = s.collectedAt
    ? Math.max(0, Math.round((Date.now() - store.skewMs - Date.parse(s.collectedAt)) / 1000))
    : null;
  const frozen = age === null || age > (s.thresholds?.stateStaleSeconds ?? 900);

  el.freshness.dataset.state = frozen ? 'frozen' : 'fresh';
  if (age === null) {
    el.freshnessText.textContent = 'aucune collecte à ce jour';
  } else if (frozen) {
    const at = new Date(Date.parse(s.collectedAt));
    el.freshnessText.textContent = `données figées depuis ${at.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  } else {
    el.freshnessText.textContent = age < 60 ? 'à jour' : `il y a ${Math.round(age / 60)} min`;
  }
}

async function refreshState() {
  try {
    const state = await api('/api/state');
    store.skewMs = Date.now() - Date.parse(state.serverTime);
    store.state = state;
    store.specs = new Map(state.cards.map((c) => [c.id, c]));
    renderAllBodies();
    renderAlerts();
    renderFreshness();
  } catch (err) {
    el.freshness.dataset.state = 'frozen';
    el.freshnessText.textContent = 'service injoignable';
  }
}

/* ------------------------------------------------------------- interactions */

function setEditing(on) {
  store.editing = on;
  document.body.dataset.mode = on ? 'edit' : 'view';
  el.btnEdit.setAttribute('aria-pressed', String(on));
  el.btnEdit.textContent = on ? 'Terminer' : 'Organiser';
  el.btnReset.hidden = !on;
  el.btnDrawer.hidden = !on;
  if (store.grid) store.grid.setStatic(!on || isMobile());
  renderDrawer();
}

function renderDrawer() {
  const hidden = store.cards.filter((c) => c.hidden);
  el.drawerCount.textContent = String(hidden.length);
  el.drawerList.innerHTML = hidden.length
    ? hidden
        .map((c) => {
          const spec = store.specs.get(c.id);
          return `<li class="drawer__item"><span>${escapeHtml(spec?.title || c.id)}</span>
            <button class="btn" type="button" data-show="${escapeHtml(c.id)}">Afficher</button></li>`;
        })
        .join('')
    : '<li class="empty">Aucune carte masquée.</li>';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    // Seule chose confiée au navigateur : la préférence de thème, qui est
    // propre à l'écran devant lequel on est. La disposition, elle, va au serveur.
    localStorage.setItem('infra.theme', theme);
  } catch { /* navigation privée : on s'en passe */ }
  el.btnTheme.textContent = theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function wireEvents() {
  el.btnEdit.addEventListener('click', () => setEditing(!store.editing));
  el.btnTheme.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const current = document.documentElement.dataset.theme || 'auto';
    setTheme(order[(order.indexOf(current) + 1) % order.length]);
  });

  el.btnDrawer.addEventListener('click', () => {
    const open = el.drawer.hidden;
    el.drawer.hidden = !open;
    el.btnDrawer.setAttribute('aria-expanded', String(open));
    renderDrawer();
  });
  el.drawerClose.addEventListener('click', () => {
    el.drawer.hidden = true;
    el.btnDrawer.setAttribute('aria-expanded', 'false');
  });
  el.drawerList.addEventListener('click', (e) => {
    const id = e.target.closest('[data-show]')?.dataset.show;
    if (id) showCard(id);
  });

  el.btnReset.addEventListener('click', () => { el.confirm.hidden = false; });
  el.confirmCancel.addEventListener('click', () => { el.confirm.hidden = true; });
  el.confirmOk.addEventListener('click', async () => {
    el.confirm.hidden = true;
    try {
      const fresh = await api('/api/layout', { method: 'DELETE' });
      store.cards = fresh.cards;
      buildGrid();
      renderDrawer();
      flash('disposition réinitialisée');
    } catch (err) {
      flash('réinitialisation impossible : ' + err.message, 'error');
    }
  });

  // Passer sous le seuil mobile désactive l'édition : on ne laisse pas
  // l'utilisateur croire qu'il arrange quelque chose qui sera enregistré.
  let lastMobile = isMobile();
  window.addEventListener('resize', () => {
    const now = isMobile();
    if (now !== lastMobile) {
      lastMobile = now;
      if (now && store.editing) setEditing(false);
      else if (store.grid) store.grid.setStatic(!store.editing || now);
    }
  });
}

/* -------------------------------------------------------------------- boot */

async function boot() {
  try {
    setTheme(localStorage.getItem('infra.theme') || 'auto');
  } catch { setTheme('auto'); }

  document.body.dataset.mode = 'view';
  wireEvents();

  const [layout] = await Promise.all([api('/api/layout'), refreshState()]);
  store.cards = layout.cards;
  buildGrid();
  renderDrawer();

  setInterval(refreshState, REFRESH_MS);
  // L'âge affiché avance même si le service ne répond plus : une donnée qui
  // vieillit doit se voir vieillir.
  setInterval(renderFreshness, TICK_MS);
}

boot().catch((err) => {
  el.freshnessText.textContent = 'chargement impossible : ' + err.message;
  el.freshness.dataset.state = 'frozen';
});
