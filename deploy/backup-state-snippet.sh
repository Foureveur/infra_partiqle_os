#!/usr/bin/env bash
#
# À GREFFER en fin de /opt/backups/backup-core.sh (et de tout autre script de
# sauvegarde), pour qu'il laisse derrière lui un état lisible par le collecteur.
#
# ---------------------------------------------------------------------------
# À FAIRE D'ABORD, sur vps-core — ne pas coller à l'aveugle :
#
#   1. Lire les deux scripts existants :
#        cat /opt/backups/backup-core.sh
#        cat /usr/local/bin/watchdog-backups.sh
#   2. Regarder s'ils écrivent DÉJÀ un état exploitable (un fichier JSON, un
#      marqueur, une ligne de log structurée). Si oui : consommer l'existant
#      plutôt que d'ajouter une seconde source de vérité.
#   3. Sinon seulement, greffer ce qui suit.
# ---------------------------------------------------------------------------
#
# Pourquoi c'est la carte la plus facile à rater : une carte backup qui dit
# « OK » parce que le script s'est exécuté, alors qu'il a produit une archive
# vide, est un mensonge (§3.8). D'où `ok` piloté par le VRAI code de sortie de
# restic, et une taille qui reste `null` quand on ne peut pas la connaître —
# plutôt qu'un zéro qui passerait pour une mesure.
#
# Les clés restic restent détenues par Quentin : ce fragment ne les manipule pas
# et le collecteur n'ouvre jamais le dépôt.

# --- À placer TOUT EN HAUT du script de sauvegarde ---------------------------
# INFRA_BACKUP_STARTED=$(date +%s)

# --- À placer TOUT EN BAS, après la sauvegarde --------------------------------
# `RESTIC_RC` doit être le code de sortie réel de la commande restic, capturé
# juste après elle :  restic backup … ; RESTIC_RC=$?
infra_backup_report() {
  local target="${1:?cible attendue, ex. vps-core}"
  local rc="${2:-1}"
  local repo="${3:-}"
  local snapshot="${4:-}"
  local size="${5:-}"
  local message="${6:-}"

  local state_dir="/opt/studio-os/data/infra"
  local file="$state_dir/backups.json"
  local tmp="$file.tmp.$$"
  local duration=$(( $(date +%s) - ${INFRA_BACKUP_STARTED:-$(date +%s)} ))
  local ok="false"
  [ "$rc" = "0" ] && ok="true"

  mkdir -p "$state_dir" || return 1

  # jq si disponible : on met à jour l'entrée de CETTE cible sans écraser les
  # autres. Plusieurs machines peuvent écrire dans le même fichier.
  if command -v jq >/dev/null 2>&1; then
    local existing='[]'
    [ -r "$file" ] && existing="$(cat "$file")"
    printf '%s' "$existing" | jq \
      --arg target "$target" \
      --arg repo "$repo" \
      --arg finishedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson ok "$ok" \
      --arg snapshotId "$snapshot" \
      --arg size "$size" \
      --argjson durationSec "$duration" \
      --arg message "$message" \
      '(map(select(.target != $target))) + [{
         target: $target,
         repo: (if $repo == "" then null else $repo end),
         finishedAt: $finishedAt,
         ok: $ok,
         snapshotId: (if $snapshotId == "" then null else $snapshotId end),
         sizeBytes: (if $size == "" then null else ($size | tonumber) end),
         durationSec: $durationSec,
         message: (if $message == "" then null else $message end)
       }]' > "$tmp" 2>/dev/null || return 1
  else
    # Sans jq : une seule cible par fichier. Suffisant sur une machine qui ne
    # sauvegarde qu'elle-même, et honnête sur ce qu'on sait faire.
    cat > "$tmp" <<EOF
[{"target":"$target","repo":$( [ -n "$repo" ] && printf '"%s"' "$repo" || printf 'null' ),
  "finishedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","ok":$ok,
  "snapshotId":$( [ -n "$snapshot" ] && printf '"%s"' "$snapshot" || printf 'null' ),
  "sizeBytes":$( [ -n "$size" ] && printf '%s' "$size" || printf 'null' ),
  "durationSec":$duration,
  "message":$( [ -n "$message" ] && printf '"%s"' "$message" || printf 'null' )}]
EOF
  fi

  # Écriture atomique : le collecteur peut lire au même instant.
  mv -f "$tmp" "$file"
}

# Exemple d'appel, à adapter :
#
#   restic backup /etc /opt /var/lib ; RESTIC_RC=$?
#   SNAP=$(restic snapshots --last --json 2>/dev/null | jq -r '.[-1].short_id // empty')
#   infra_backup_report "vps-core" "$RESTIC_RC" "$RESTIC_REPOSITORY" "$SNAP" "" ""
#
# La taille reste vide : l'obtenir demanderait d'ouvrir le dépôt. On affiche
# l'horodatage et le code de sortie, c'est déjà l'essentiel (§3.8).
