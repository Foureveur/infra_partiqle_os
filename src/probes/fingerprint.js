'use strict';

const dns = require('node:dns').promises;
const { fetchWithTimeout, shortUrl } = require('../collector/fetch');

/**
 * Empreinte d'un environnement : ce qu'on peut CONSTATER de l'extérieur.
 *
 * Règle de conduite de tout ce fichier : on ne rapporte que ce qu'on a vu.
 * Un doute ne devient jamais une valeur. Une sonde qui invente est pire
 * qu'une sonde absente, parce qu'elle produit un « confirmé » — et c'est
 * exactement ce qu'on cherche à ne plus jamais avoir (panne Spacia du 07/09).
 *
 * D'où : chaque détection ci-dessous renvoie `null` quand elle hésite, et
 * l'appelant n'envoie que les champs non nuls.
 */

/** Une seule requête par environnement. On ne martèle pas les sites clients. */
const TIMEOUT_MS = 10_000;
const MAX_BODY = 200 * 1024;

/**
 * Correspondance IP → fournisseur.
 *
 * Volontairement pauvre et fondée sur des faits vérifiés, pas sur des plages
 * devinées : Cloudflare et Vercel s'annoncent dans leurs en-têtes, ce qui est
 * plus sûr qu'un test d'appartenance à un bloc CIDR qui bouge. Pour Hostinger,
 * on ne conclut QUE si l'IP est l'une des nôtres — auquel cas on le sait de
 * source sûre, par data/machines.json.
 */
function providerFromHeaders(headers) {
  const server = (headers.get('server') || '').toLowerCase();
  const powered = (headers.get('x-powered-by') || '').toLowerCase();
  if (server.includes('cloudflare')) return 'Cloudflare';
  if (headers.get('x-vercel-id') || server.includes('vercel')) return 'Vercel';
  if (headers.get('x-webflow-id') || server.includes('webflow')) return 'Webflow';
  if (powered.includes('siteground') || headers.get('x-sg-cachehit') !== null) return 'SiteGround';
  return null;
}

/**
 * La voie, telle qu'un site la laisse voir.
 *
 * WordPress s'annonce de trois façons indépendantes ; il en faut UNE seule,
 * mais on ne conclut pas « pas WordPress » sur leur absence — beaucoup de
 * sites masquent ces marqueurs. L'absence de preuve reste `null`.
 *
 * On ne cherche pas à distinguer Elementor du reste : le libellé du brief est
 * « WordPress + Elementor », et affirmer Elementor depuis l'extérieur demande
 * de lire le HTML de rendu, ce qui casse dès qu'une page est mise en cache
 * autrement. On rapporte donc WordPress, et l'écart avec « WordPress +
 * Elementor » serait un faux positif — c'est pourquoi cette détection ne sert
 * QUE `stack.primary`, jamais `stack.voie`.
 */
function primaryFromBody(headers, body, wpJsonSeen) {
  const powered = (headers.get('x-powered-by') || '').toLowerCase();
  if (wpJsonSeen) return 'WordPress';
  if (/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i.test(body)) return 'WordPress';
  if (/\/wp-content\/|\/wp-includes\//i.test(body)) return 'WordPress';
  if (/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i.test(body)) {
    const m = body.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)/i);
    const value = (m && m[1]) || '';
    if (/webflow/i.test(value)) return 'Webflow';
    if (/astro/i.test(value)) return 'Astro';
    if (/hugo|jekyll|eleventy/i.test(value)) return value.split(/\s+/)[0];
  }
  if (/id="__next"|\/_next\/static\//.test(body)) return 'Next';
  if (/data-sveltekit-|\/_app\/immutable\//.test(body)) return 'SvelteKit';
  if (powered.includes('express')) return 'Express';
  return null;
}

/** Résolution DNS. Un échec est un fait, pas une erreur à faire remonter. */
async function resolveIps(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

/**
 * Sonde un environnement. Ne jette jamais : un site injoignable est une
 * observation, et c'en est une utile.
 */
async function probeUrl(rawUrl, machines) {
  const out = { url: rawUrl, reachable: false, status: null, provider: null, primary: null, machine: null, ips: [] };

  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { ...out, error: 'URL illisible' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return { ...out, error: 'protocole non sondable' };
  }

  out.ips = await resolveIps(target.hostname);
  // Rattachement machine : uniquement sur une IP que NOUS connaissons. On ne
  // devine pas un hébergeur à partir d'une plage — on le sait, ou on se tait.
  const known = machines.find((m) => m.expectedIp && out.ips.includes(m.expectedIp));
  if (known) {
    out.machine = known.id;
    out.provider = 'Hostinger'; // nos quatre VPS y sont, c'est un fait de la table
  }

  let res;
  try {
    res = await fetchWithTimeout(target.toString(), {
      timeoutMs: TIMEOUT_MS,
      headers: { 'user-agent': 'infra.partiqle.studio probe (+contact: quentin@partiqle.studio)' },
    });
  } catch (err) {
    return { ...out, error: err.name === 'AbortError' ? 'délai dépassé' : err.message };
  }

  out.reachable = true;
  out.status = res.status;
  if (!out.provider) out.provider = providerFromHeaders(res.headers);

  // Le corps ne sert qu'à l'empreinte : on le borne, un site peut peser lourd.
  let body = '';
  try {
    const text = await res.text();
    body = text.slice(0, MAX_BODY);
  } catch {
    body = '';
  }

  // Un /wp-json qui répond est la preuve la plus franche de WordPress. On ne
  // la cherche que si le corps n'a rien dit : une requête de plus par site,
  // et seulement quand elle change quelque chose.
  let wpJson = false;
  if (!/wp-content|generator["'][^>]*WordPress/i.test(body)) {
    try {
      const probe = await fetchWithTimeout(new URL('/wp-json/', target).toString(), { timeoutMs: 5000 });
      wpJson = probe.ok;
    } catch {
      wpJson = false;
    }
  }

  out.primary = primaryFromBody(res.headers, body, wpJson);
  return out;
}

module.exports = { probeUrl, providerFromHeaders, primaryFromBody, shortUrl };
