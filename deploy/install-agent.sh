#!/usr/bin/env bash
#
# install-agent.sh — installe la pousse sur une machine DISTANTE
# (vps-saas-01, vps-clients-01, vps-lab). Pour vps-core, c'est install.sh
# qui s'en charge, en écriture locale sans réseau ni jeton.
#
# Depuis le Mac, une commande par machine — les deux scripts sont convoyés
# depuis vps-core, la machine cible n'a besoin d'aucun accès à GitHub :
#
#   ssh vps-core 'tar -C /opt/studio-os/services/infra/deploy -cz infra-report.sh install-agent.sh' \
#     | ssh vps-saas-01 'tar -xz -C /tmp && INFRA_MACHINE=vps-saas-01 INFRA_PUSH_TOKEN=<jeton> bash /tmp/install-agent.sh'
#
# Le jeton est celui de CETTE machine, tiré de services/infra.env sur vps-core.
# Un jeton ne vaut que pour sa machine : celui de vps-lab ne peut pas écrire
# l'état de vps-core.
#
set -uo pipefail

: "${INFRA_MACHINE:?INFRA_MACHINE non défini (vps-saas-01 | vps-clients-01 | vps-lab)}"
: "${INFRA_PUSH_TOKEN:?INFRA_PUSH_TOKEN non défini — le prendre dans services/infra.env sur vps-core}"
INFRA_INGEST_URL="${INFRA_INGEST_URL:-https://infra.partiqle.studio}"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
ko()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
inf() { printf '  \033[90m·\033[0m %s\n' "$1"; }

printf '\n\033[1mPousse — %s\033[0m\n' "$INFRA_MACHINE"

# --- Le script ---------------------------------------------------------------
if [ ! -f "$SRC_DIR/infra-report.sh" ]; then
  ko "infra-report.sh introuvable à côté de ce script ($SRC_DIR)"
  exit 1
fi
install -m 0755 "$SRC_DIR/infra-report.sh" /usr/local/bin/infra-report.sh || { ko "installation impossible"; exit 1; }
ok "infra-report.sh installé"

# --- La configuration --------------------------------------------------------
# 0600 root : le jeton de cette machine ne doit être lisible que par root.
( umask 077
  cat > /etc/infra-report.env <<EOF
INFRA_MACHINE=$INFRA_MACHINE
INFRA_INGEST_URL=$INFRA_INGEST_URL
INFRA_PUSH_TOKEN=$INFRA_PUSH_TOKEN
EOF
)
chmod 600 /etc/infra-report.env
ok "/etc/infra-report.env écrit (0600)"

# --- Le cron -----------------------------------------------------------------
if crontab -l 2>/dev/null | grep -q 'infra-report.sh'; then
  inf "cron déjà présent — inchangé"
else
  (crontab -l 2>/dev/null; \
   echo '*/5 * * * * flock -n /run/infra-report.lock /usr/local/bin/infra-report.sh >> /var/log/infra-report.log 2>&1') \
   | crontab -
  crontab -l 2>/dev/null | grep -q 'infra-report.sh' \
    && ok "cron installé (toutes les 5 min, sous flock)" || ko "cron NON installé"
fi

# --- Outils facultatifs ------------------------------------------------------
command -v docker >/dev/null 2>&1 || inf "docker absent : la carte n'affichera pas de conteneurs"
command -v cscli  >/dev/null 2>&1 || inf "cscli absent : CrowdSec sera « source absente », pas une erreur"
command -v jq     >/dev/null 2>&1 || inf "jq absent : CrowdSec remontera le nombre de décisions sans le détail"
command -v flock  >/dev/null 2>&1 || ko  "flock absent : installer util-linux, le verrou est obligatoire"

# --- Première pousse ---------------------------------------------------------
# On la fait tout de suite : c'est le seul moyen de savoir que le jeton, le
# réseau et la route d'ingestion fonctionnent, plutôt que de le découvrir dans
# quinze minutes quand la machine sera déclarée silencieuse.
printf '\n\033[1mPremière pousse\033[0m\n'
OUT="$(/usr/local/bin/infra-report.sh 2>&1)"
RC=$?
if [ "$RC" = "0" ]; then
  ok "acceptée par $INFRA_INGEST_URL"
  printf '\n  La machine doit apparaître sur infra.partiqle.studio dans les 5 minutes\n  (le temps du prochain passage du collecteur sur vps-core).\n\n'
else
  ko "refusée — la machine restera INCONNUE tant que ce n'est pas réglé"
  printf '%s\n' "$OUT" | sed 's/^/      /'
  printf '\n  Pistes : jeton pris dans la mauvaise variable de infra.env (il y en a une\n  par machine) · pas de route sortante vers %s · route /api/ingest/* déclarée\n  APRÈS le handle général dans le Caddyfile, donc happée par Authelia.\n\n' "$INFRA_INGEST_URL"
  exit 1
fi
