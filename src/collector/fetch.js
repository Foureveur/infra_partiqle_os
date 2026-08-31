'use strict';

/**
 * Appels sortants du collecteur — jamais du service. Chaque appel a un délai
 * maximal : une source lente ne doit pas retenir les autres, et surtout pas
 * faire dépasser le cycle de 5 minutes.
 */
async function fetchWithTimeout(url, { timeoutMs = 8000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText || ''}`.trim() + ` sur ${shortUrl(url)}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`réponse non-JSON sur ${shortUrl(url)}`);
  }
}

async function fetchText(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''}`.trim() + ` sur ${shortUrl(url)}`);
  return res.text();
}

/** Une URL dans un message d'erreur ne doit jamais trimballer de jeton. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return String(url).split('?')[0];
  }
}

module.exports = { fetchJson, fetchText, fetchWithTimeout, shortUrl };
