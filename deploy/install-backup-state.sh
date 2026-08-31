#!/usr/bin/env bash
#
# Greffe le rapport d'état de sauvegarde sur watchdog-backups.sh.
#
#   bash install-backup-state.sh            # --check : ne change rien
#   bash install-backup-state.sh --apply
#
# Idempotent : relancé, il détecte la greffe existante et ne fait rien.
# L'original est sauvegardé suivant la convention en place
# (watchdog-backups.sh.bak-infra-<date>) AVANT toute modification, et la
# syntaxe est vérifiée APRÈS : si `bash -n` refuse le résultat, on restaure.
set -uo pipefail

WATCHDOG="${WATCHDOG:-/usr/local/bin/watchdog-backups.sh}"
# Doit rester d'accord avec le défaut du snippet ET avec celui d'infra-report.sh :
# trois endroits, un seul chemin. En cas de doute, c'est celui-ci qui est lu par
# la vérification finale, donc celui qui dira la vérité.
STATE_DIR="${INFRA_STATE_DIR:-/var/lib/infra-report}"
STATE_FILE="$STATE_DIR/backup.json"
MARKER='# --- infra : état lisible par le tableau de bord'
MODE="check"
[ "${1:-}" = "--apply" ] && MODE="apply"

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m·\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

printf '\n\033[1mÉtat de sauvegarde — %s\033[0m\n\n' "$(hostname)"

[ -r "$WATCHDOG" ] || die "$WATCHDOG introuvable ou illisible."

if grep -qF "$MARKER" "$WATCHDOG"; then
  ok "déjà greffé — rien à faire"
  [ -r "$STATE_FILE" ] \
    && ok "état présent : $(cat "$STATE_FILE")" \
    || warn "pas encore d'état : le veilleur n'a pas retourné depuis la greffe"
  exit 0
fi

# Point d'insertion : la ligne de trace, qui s'exécute dans les DEUX cas —
# sauvegarde saine comme sauvegarde en retard. Se greffer plus bas raterait
# précisément le cas qu'on veut voir.
ANCHOR="$(grep -n "printf 'veilleur sauvegardes" "$WATCHDOG" | head -1 | cut -d: -f1)"
[ -n "$ANCHOR" ] || die "point d'ancrage introuvable — le veilleur a changé, ne pas greffer à l'aveugle."
ok "point d'ancrage : ligne $ANCHOR"

SNIPPET="$(dirname "$0")/backup-state-snippet.sh"
[ -r "$SNIPPET" ] || die "$SNIPPET introuvable."
# On ne prend que le bloc exécutable, pas l'exégèse en tête de fichier.
BLOCK="$(sed -n "/^${MARKER}/,\$p" "$SNIPPET")"
[ -n "$BLOCK" ] || die "bloc non trouvé dans $SNIPPET"

if [ "$MODE" = "check" ]; then
  say ""
  say "À FAIRE (rien n'a été modifié) :"
  say "  · sauvegarder $WATCHDOG"
  say "  · insérer le rapport d'état après la ligne $ANCHOR"
  say "  · vérifier la syntaxe, puis lancer le veilleur une fois"
  say ""
  say "Relancer avec --apply pour exécuter."
  exit 0
fi

BAK="$WATCHDOG.bak-infra-$(date +%Y%m%d)"
cp -p "$WATCHDOG" "$BAK" || die "sauvegarde impossible"
ok "original sauvegardé : $BAK"

TMP="$(mktemp)" || die "mktemp"
{
  sed -n "1,${ANCHOR}p" "$WATCHDOG"
  printf '\n%s\n' "$BLOCK"
  sed -n "$((ANCHOR + 1)),\$p" "$WATCHDOG"
} > "$TMP"

if ! bash -n "$TMP" 2>/dev/null; then
  rm -f "$TMP"
  die "le résultat ne passe pas bash -n — rien n'a été modifié, l'original est intact."
fi
ok "syntaxe vérifiée"

cat "$TMP" > "$WATCHDOG" || { cp -p "$BAK" "$WATCHDOG"; rm -f "$TMP"; die "écriture impossible — original restauré"; }
rm -f "$TMP"
ok "greffe posée"

printf '\n\033[1mVérification\033[0m\n\n'
if "$WATCHDOG" >/dev/null 2>&1 || [ $? -eq 1 ]; then :; fi
if [ -r "$STATE_FILE" ]; then
  ok "état écrit"
  say "$(cat "$STATE_FILE")"
else
  # On restaure : une greffe qui ne produit rien n'a rien à faire dans un
  # script dont dépendent les alertes Telegram.
  cp -p "$BAK" "$WATCHDOG"
  die "aucun état produit — original restauré. Lancer $WATCHDOG à la main pour voir l'erreur."
fi

printf '\n  La sauvegarde de cette machine remontera à la prochaine pousse (5 min).\n\n'
