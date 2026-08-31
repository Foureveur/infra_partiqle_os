'use strict';

/**
 * Journal en JSON sur stdout : docker logs le récupère, la stack le lit comme
 * les autres services. Aucune valeur de jeton n'est jamais journalisée — seuls
 * le fait du refus et la machine visée le sont.
 */
function emit(level, event, fields = {}) {
  const line = { ts: new Date().toISOString(), level, event, ...fields };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + '\n');
}

module.exports = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
