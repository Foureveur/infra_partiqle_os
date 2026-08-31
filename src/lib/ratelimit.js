'use strict';

/**
 * Seau à jetons en mémoire, pour la seule route exposée sans Authelia.
 * Une pousse légitime arrive toutes les 5 minutes ; 12 requêtes par minute
 * laissent largement la place aux reprises sans laisser un client anonyme
 * marteler l'endpoint.
 */
function createLimiter({ capacity = 12, refillPerSecond = 0.2 } = {}) {
  const buckets = new Map();

  return function take(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: capacity, at: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSecond);
    b.at = now;

    // Purge paresseuse : sans ça, une clé par IP anonyme fait grossir la Map
    // indéfiniment sur une route publique.
    if (buckets.size > 1024) {
      for (const [k, v] of buckets) {
        if (now - v.at > 3600_000) buckets.delete(k);
      }
    }

    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

module.exports = { createLimiter };
