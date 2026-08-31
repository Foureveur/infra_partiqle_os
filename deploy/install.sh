#!/usr/bin/env bash
#
# Installeur de infra.partiqle.studio sur vps-core.
#
# Pensé pour être lancé en UNE commande depuis le Mac, sans collage multi-ligne :
#
#   ssh vps-core 'bash /opt/studio-os/services/infra/deploy/install.sh --check'
#   ssh vps-core 'bash /opt/studio-os/services/infra/deploy/install.sh --apply'
#
# --check ne modifie RIEN : il dit ce qu'il ferait. C'est le mode par défaut.
# --apply exécute. Le script est idempotent : le relancer ne casse rien et ne
# duplique rien.
#
# Ce qu'il fait :
#   1. vérifie les préalables (compose, Caddyfile, réseau, docker)
#   2. crée services/infra.env avec quatre jetons de pousse s'il n'existe pas
#   3. crée data/infra et lui donne les droits du conteneur (uid 1000)
#   4. insère le service `infra` dans docker-compose.yml s'il en est absent
#   5. sauvegarde le Caddyfile et y ajoute le vhost s'il en est absent
#   6. démarre le service, VALIDE la config Caddy, puis recharge
#   7. installe infra-report.sh sur cette machine et ses deux crons
#
# Si la validation Caddy échoue, le Caddyfile est RESTAURÉ et rien n'est
# rechargé : une erreur de config ici coupe tous les sous-domaines, pas
# seulement celui-ci.
#
set -uo pipefail

STUDIO="${STUDIO_OS_DIR:-/opt/studio-os}"
SERVICE_DIR="$STUDIO/services/infra"
ENV_FILE="$STUDIO/services/infra.env"
COMPOSE_FILE="$STUDIO/docker-compose.yml"
CADDYFILE="$STUDIO/config/caddy/Caddyfile"
DATA_DIR="$STUDIO/data/infra"
STAMP="$(date +%Y%m%d)"
VHOST="infra.partiqle.studio"

MODE="check"
WITH_REPORT=1
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --check|--dry-run) MODE="check" ;;
    --no-report) WITH_REPORT=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "argument inconnu : $arg" >&2; exit 2 ;;
  esac
done

CHANGES=0
PROBLEMS=0

say()   { printf '%s\n' "$*"; }
step()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
todo()  { CHANGES=$((CHANGES+1)); printf '  \033[33m→\033[0m %s\n' "$*"; }
done_() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip()  { printf '  \033[90m·\033[0m %s\n' "$*"; }
bad()   { PROBLEMS=$((PROBLEMS+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }

# En mode --check, act() n'exécute rien.
act() {
  if [ "$MODE" = "apply" ]; then "$@"; else return 0; fi
}

DC="docker compose"
DOCKER_BIN="$(command -v docker 2>/dev/null)"
[ -n "$DOCKER_BIN" ] || DC=""
if [ -n "$DC" ] && ! docker compose version >/dev/null 2>&1; then
  command -v docker-compose >/dev/null 2>&1 && DC="docker-compose"
fi

# ---------------------------------------------------------------- préalables
step "Préalables"

if [ ! -d "$STUDIO" ]; then
  bad "$STUDIO est introuvable — ce script doit tourner sur vps-core"
  exit 1
fi
done_ "$STUDIO présent"

[ -f "$COMPOSE_FILE" ] && done_ "docker-compose.yml présent" || { bad "docker-compose.yml introuvable"; exit 1; }
[ -f "$CADDYFILE" ]    && done_ "Caddyfile présent"          || { bad "Caddyfile introuvable ($CADDYFILE)"; exit 1; }
[ -d "$SERVICE_DIR" ]  && done_ "le dépôt est en place dans services/infra" || {
  bad "services/infra absent — cloner d'abord :"
  say  "      cd $STUDIO/services && git clone https://github.com/Foureveur/infra_partiqle_os.git infra"
  exit 1
}
[ -n "$DC" ] && done_ "docker compose disponible" || bad "docker compose introuvable"

# Le nom du réseau doit correspondre à celui de la stack, pas à ce qu'on suppose.
NET="$(awk '/^networks:/{f=1;next} f&&/^  [a-z0-9_-]+:/{gsub(/[ :]/,"");print;exit}' "$COMPOSE_FILE")"
if [ -n "$NET" ]; then
  done_ "réseau de la stack : $NET"
  [ "$NET" = "studio-net" ] || bad "le fragment fourni référence « studio-net » — à ajuster en « $NET »"
else
  skip "réseau non détecté automatiquement — à vérifier à la main"
fi

# ------------------------------------------------------------------ secrets
step "Secrets — services/infra.env"

gen_env() {
  # Sous-shell : sans lui, cet umask contaminerait tout le reste du script et
  # les fichiers créés plus bas hériteraient de 0600 (bug vu en production).
  (
  umask 077
  {
    sed -n '1,/^INFRA_PUSH_TOKEN_VPS_CORE=/p' "$SERVICE_DIR/.env.example" | sed '$d'
    echo "INFRA_PUSH_TOKEN_VPS_CORE=$(openssl rand -hex 32)"
    echo "INFRA_PUSH_TOKEN_VPS_SAAS_01=$(openssl rand -hex 32)"
    echo "INFRA_PUSH_TOKEN_VPS_CLIENTS_01=$(openssl rand -hex 32)"
    echo "INFRA_PUSH_TOKEN_VPS_LAB=$(openssl rand -hex 32)"
    sed -n '/^INFRA_PUSH_TOKEN_VPS_LAB=/,$p' "$SERVICE_DIR/.env.example" | tail -n +2
  } > "$ENV_FILE"
  )
  chmod 600 "$ENV_FILE"
}

if [ -f "$ENV_FILE" ]; then
  skip "infra.env existe déjà — laissé tel quel"
  for v in KUMA_STATUS_SLUG KUMA_API_KEY GLITCHTIP_ORG GLITCHTIP_TOKEN ROADMAPS_TOKEN HOSTINGER_TOKEN; do
    grep -qE "^$v=.+" "$ENV_FILE" || skip "  $v vide — sa carte restera grise (c'est prévu)"
  done
else
  todo "créer infra.env (0600) avec quatre jetons de pousse générés"
  act gen_env && [ "$MODE" = "apply" ] && done_ "infra.env créé"
fi

# ------------------------------------------------------------------- volume
step "Volume d'état"

if [ -d "$DATA_DIR" ] && [ "$(stat -c '%u' "$DATA_DIR" 2>/dev/null)" = "1000" ]; then
  skip "data/infra existe et appartient bien à l'uid 1000"
else
  # Sans ce chown, le service démarre mais aucune disposition ne s'enregistre :
  # le conteneur tourne en `node` (uid 1000), pas en root.
  todo "créer $DATA_DIR/machines et le donner à l'uid 1000"
  act mkdir -p "$DATA_DIR/machines"
  act chown -R 1000:1000 "$DATA_DIR"
  act chmod 750 "$DATA_DIR"
  [ "$MODE" = "apply" ] && done_ "volume prêt"
fi

# ------------------------------------------------------------------ compose
step "docker-compose.yml"

if grep -qE '^\s{2}infra:' "$COMPOSE_FILE"; then
  skip "le service « infra » y est déjà déclaré"
else
  todo "insérer le service « infra » (sauvegarde : docker-compose.yml.bak-infra-$STAMP)"
  insert_compose() {
    cp "$COMPOSE_FILE" "$COMPOSE_FILE.bak-infra-$STAMP"
    awk -v frag="$SERVICE_DIR/deploy/compose.infra.snippet.yml" '
      { print }
      !done && /^services:/ {
        while ((getline line < frag) > 0) if (line !~ /^#/ && line != "") print line
        close(frag); done = 1
      }
    ' "$COMPOSE_FILE.bak-infra-$STAMP" > "$COMPOSE_FILE"
  }
  act insert_compose
  if [ "$MODE" = "apply" ]; then
    if grep -qE '^\s{2}infra:' "$COMPOSE_FILE"; then
      done_ "service inséré"
    else
      bad "insertion ratée — restauration"
      cp "$COMPOSE_FILE.bak-infra-$STAMP" "$COMPOSE_FILE"
    fi
  fi
fi

# ------------------------------------------------------------------- Caddy
step "Caddyfile"

if grep -q "$VHOST" "$CADDYFILE"; then
  skip "le vhost $VHOST y est déjà"
else
  todo "ajouter le vhost $VHOST (sauvegarde : Caddyfile.bak-infra-$STAMP)"
  add_vhost() {
    cp "$CADDYFILE" "$CADDYFILE.bak-infra-$STAMP"
    printf '\n' >> "$CADDYFILE"
    grep -v '^#' "$SERVICE_DIR/deploy/Caddyfile.infra" >> "$CADDYFILE"
  }
  act add_vhost
  [ "$MODE" = "apply" ] && done_ "vhost ajouté"
fi

# ---------------------------------------------------------------- démarrage
step "Démarrage"

if [ "$MODE" != "apply" ]; then
  todo "$DC up -d --build infra   (jamais sans nom de service)"
  todo "$DC exec caddy caddy validate, puis reload"
else
  cd "$STUDIO" || exit 1
  # --build est obligatoire, pas une précaution : src/ est COPIÉ dans l'image,
  # pas monté. Sans lui, mettre à jour le dépôt sur l'hôte ne change rien au
  # code qui tourne, et on débogue une version qu'on ne lit pas.
  if $DC up -d --build infra; then
    done_ "conteneur infra construit et démarré"
  else
    bad "le démarrage a échoué — voir : $DC logs infra"
  fi

  # Valider AVANT de recharger. Une config Caddy cassée coupe TOUS les
  # sous-domaines, pas seulement celui-ci.
  if $DC exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    done_ "config Caddy valide"
    if $DC exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
      done_ "Caddy rechargé"
    else
      bad "rechargement refusé — la config précédente reste active"
    fi
  else
    bad "config Caddy INVALIDE — restauration de la sauvegarde, rien n'est rechargé"
    [ -f "$CADDYFILE.bak-infra-$STAMP" ] && cp "$CADDYFILE.bak-infra-$STAMP" "$CADDYFILE"
    $DC exec -T caddy caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
      && say "      le Caddyfile restauré est valide — aucun sous-domaine impacté"
  fi
fi

# ------------------------------------------------- pousse locale de vps-core
if [ "$WITH_REPORT" = "1" ]; then
  step "Pousse locale (vps-core)"

  if [ -f /usr/local/bin/infra-report.sh ] && [ -f /etc/infra-report.env ]; then
    skip "infra-report.sh et sa configuration sont déjà en place"
  else
    todo "installer infra-report.sh et /etc/infra-report.env (écriture locale, sans jeton ni réseau)"
    install_report() {
      install -m 0755 "$SERVICE_DIR/deploy/infra-report.sh" /usr/local/bin/infra-report.sh
      cat > /etc/infra-report.env <<EOF
INFRA_MACHINE=vps-core
INFRA_INGEST_FILE=$DATA_DIR/machines/vps-core.json
EOF
      chmod 600 /etc/infra-report.env
    }
    act install_report
    [ "$MODE" = "apply" ] && done_ "script de pousse installé"
  fi

  if crontab -l 2>/dev/null | grep -q 'infra-report.sh'; then
    skip "cron de pousse déjà présent"
  else
    todo "ajouter le cron de pousse (toutes les 5 min, sous flock)"
    act bash -c "(crontab -l 2>/dev/null; echo '*/5 * * * * flock -n /run/infra-report.lock /usr/local/bin/infra-report.sh >> /var/log/infra-report.log 2>&1') | crontab -"
    if [ "$MODE" = "apply" ]; then
      crontab -l 2>/dev/null | grep -q 'infra-report.sh' \
        && done_ "cron de pousse installé" || bad "cron de pousse NON installé"
    fi
  fi

  if crontab -l 2>/dev/null | grep -q 'infra/src/collector'; then
    skip "cron de collecte déjà présent"
  else
    todo "ajouter le cron de collecte (toutes les 5 min, sous flock)"
    # Chemin absolu : « docker » seul n'est pas résolu par le PATH de cron.
    act bash -c "(crontab -l 2>/dev/null; echo \"*/5 * * * * flock -n /run/infra-collect.lock $DOCKER_BIN compose -f $COMPOSE_FILE exec -T infra node src/collector/index.js >> /var/log/infra-collect.log 2>&1\") | crontab -"
    if [ "$MODE" = "apply" ]; then
      crontab -l 2>/dev/null | grep -q 'infra/src/collector\|src/collector/index.js' \
        && done_ "cron de collecte installé" || bad "cron de collecte NON installé"
    fi
  fi

  if [ "$MODE" = "apply" ]; then
    if /usr/local/bin/infra-report.sh >/dev/null 2>&1; then
      chmod 644 "$DATA_DIR"/machines/*.json 2>/dev/null
      done_ "première pousse écrite"
    else
      bad "la première pousse a échoué — bash -x /usr/local/bin/infra-report.sh"
    fi
    $DC -f "$COMPOSE_FILE" exec -T infra node src/collector/index.js >/dev/null 2>&1 \
      && done_ "première collecte effectuée" || skip "collecte à relancer une fois le conteneur prêt"
  fi
fi

# ------------------------------------------------------------------ verdict
step "Verdict"

if [ "$MODE" != "apply" ]; then
  say "Mode --check : rien n'a été modifié. $CHANGES action(s) à effectuer."
  [ "$PROBLEMS" -gt 0 ] && say "$PROBLEMS point(s) à régler d'abord (voir les ✗)."
  say ""
  say "Pour exécuter :"
  say "  ssh vps-core 'bash $SERVICE_DIR/deploy/install.sh --apply'"
else
  say "Terminé. $PROBLEMS problème(s)."
  say ""
  say "Vérifier :"
  say "  curl -I https://$VHOST                 # redirection Authelia attendue"
  say "  $DC -f $COMPOSE_FILE logs --tail=20 infra"
  say ""
  say "Puis ouvrir https://$VHOST — les cartes sans jeton restent grises,"
  say "c'est voulu. Étapes 4 à 7 de DEPLOY.md pour les brancher."
fi

[ "$PROBLEMS" -eq 0 ]
