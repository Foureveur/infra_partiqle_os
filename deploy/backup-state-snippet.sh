#!/usr/bin/env bash
#
# Bloc à insérer dans /usr/local/bin/watchdog-backups.sh, juste après la ligne
# `printf 'veilleur sauvegardes ...'`. `deploy/install-backup-state.sh` le fait
# pour toi, de façon idempotente et en sauvegardant l'original.
#
# ---------------------------------------------------------------------------
# POURQUOI ICI, ET PAS DANS backup-core.sh
#
# La première version de ce fichier proposait de greffer un rapport en fin de
# script de sauvegarde, avec le code de sortie de restic. C'était une erreur, et
# la lecture des scripts existants (31/08) l'a montrée : enregistrer « restic a
# rendu 0 » revient à dire qu'une sauvegarde va bien parce que le script s'est
# exécuté. C'est précisément le mensonge que le §3.8 interdit.
#
# watchdog-backups.sh, lui, fait la bonne chose : il interroge le DÉPÔT et lit
# l'horodatage du dernier snapshot. C'est la seule mesure qui distingue « le job
# a tourné » de « les données sont protégées ». Le commentaire en tête de ce
# veilleur raconte d'ailleurs l'incident qui l'a fait naître — un moniteur resté
# vert pour une copie devenue obsolète.
#
# On se branche donc sur le veilleur, et on ne touche pas au script de
# sauvegarde. Les clés restic restent détenues par Quentin : le veilleur les a
# déjà, le collecteur ne les voit jamais.
# ---------------------------------------------------------------------------

# --- infra : état lisible par le tableau de bord ----------------------------
# On écrit l'HORODATAGE du dernier snapshot, jamais son âge. C'est le service
# qui dérive l'âge à chaque requête (§3.1) : sans quoi un veilleur mort
# continuerait de servir un « sauvegardé il y a 2 h » gravé dans le fichier, et
# la carte resterait verte pour toujours.
infra_backup_state() {
  dir="${INFRA_STATE_DIR:-/var/lib/infra-report}"
  file="$dir/backup.json"
  tmp="$file.tmp.$$"

  mkdir -p "$dir" 2>/dev/null || return 0

  # `ts` vide = dépôt injoignable, vide, ou identifiants invalides. On le dit
  # explicitement plutôt que d'omettre la date : une date absente et un dépôt
  # illisible ne se soignent pas pareil.
  if [ -n "${ts:-}" ]; then
    snapshot="\"$(date -u -d "@$ts" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)\""
    readable=true
  else
    snapshot=null
    readable=false
  fi

  # Le message n'est intéressant que quand ça va mal ; sinon il ajoute du bruit.
  if [ "${ETAT:-1}" = 1 ]; then
    message="\"$(printf '%s' "${MSG:-}" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')\""
  else
    message=null
  fi

  printf '{"target":"%s","lastSnapshotAt":%s,"thresholdHours":%s,"repoReadable":%s,"checkedAt":"%s","message":%s}\n' \
    "${H:-$(hostname)}" "$snapshot" "${MAX_AGE_H:-36}" "$readable" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$message" \
    > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 0; }

  # Mode explicite, jamais l'umask de l'appelant : le veilleur tourne en root,
  # infra-report.sh peut ne pas y être. Un 0600 root rendrait la sauvegarde
  # « inconnue » alors qu'elle est saine — un mensonge par omission.
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  return 0
}
# `|| true` : le veilleur alerte sur Telegram, c'est sa mission. Il ne doit
# jamais échouer à cause d'un tableau de bord.
infra_backup_state || true
# --- fin infra ---------------------------------------------------------------
