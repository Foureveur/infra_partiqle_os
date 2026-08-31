#!/usr/bin/env bash
#
# infra-report.sh — chaque VPS s'annonce à infra.partiqle.studio (§3.2bis).
#
# Modèle en POUSSE : vps-core n'a aucune clé SSH vers les autres machines, et
# ne doit pas en avoir. Donner à la machine exposée sur Internet les clés des
# trois autres pour afficher un pourcentage de disque serait un mauvais échange.
# Chaque machine ne peut écrire que sa propre ligne.
#
# Installation : /usr/local/bin/infra-report.sh, mode 0755
# Configuration : /etc/infra-report.env, mode 0600, propriétaire root
# Cron :
#   */5 * * * * flock -n /run/infra-report.lock /usr/local/bin/infra-report.sh \
#               >> /var/log/infra-report.log 2>&1
#
set -uo pipefail

ENV_FILE="${INFRA_REPORT_ENV:-/etc/infra-report.env}"
AGENT_VERSION="1.0.0"

if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

: "${INFRA_MACHINE:?INFRA_MACHINE non défini (vps-core | vps-saas-01 | vps-clients-01 | vps-lab)}"

log() { printf '%s infra-report[%s] %s\n' "$(date -Is)" "$INFRA_MACHINE" "$*" >&2; }

# --- Verrou -----------------------------------------------------------------
# Le cron pose déjà un flock ; celui-ci couvre les lancements à la main.
LOCK="/run/infra-report.self.lock"
exec 9>"$LOCK" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
  flock -n 9 || { log "déjà en cours — abandon"; exit 0; }
fi

# --- Petites aides ----------------------------------------------------------
json_string() {
  # Échappement JSON d'une chaîne quelconque, sans dépendance.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g' \
    | awk 'BEGIN{ORS=""} {gsub(/\t/,"\\t"); print (NR>1 ? "\\n" : "") $0}'
}
q() { printf '"%s"' "$(json_string "${1:-}")"; }
num() { case "${1:-}" in ''|*[!0-9.-]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

# --- Mesures système --------------------------------------------------------
HOSTNAME_V="$(hostname 2>/dev/null || echo unknown)"
UPTIME_V="$(cut -d. -f1 /proc/uptime 2>/dev/null || echo '')"
read -r LOAD1 LOAD5 LOAD15 _ < /proc/loadavg 2>/dev/null || { LOAD1=''; LOAD5=''; LOAD15=''; }

MEM_PCT="$(free -b 2>/dev/null | awk '/^Mem:/{ if ($2>0) printf "%.1f", ($2-$7)*100/$2 }')"
DISK_PCT="$(df -P / 2>/dev/null | awk 'NR==2{gsub(/%/,"",$5); print $5}')"
DISK_FREE_GB="$(df -P / 2>/dev/null | awk 'NR==2{printf "%.1f", $4/1048576}')"

REBOOT_REQUIRED=false
[ -f /var/run/reboot-required ] && REBOOT_REQUIRED=true

# IP publique : facultative. Si le réseau sortant est coupé, on ne bloque pas
# la pousse pour autant — mieux vaut un rapport sans IP que pas de rapport.
PUBLIC_IP="${INFRA_PUBLIC_IP:-}"
if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP="$(curl -s -m 5 https://api.ipify.org 2>/dev/null || true)"
fi

# --- Docker -----------------------------------------------------------------
DOCKER_AVAILABLE=false
CONTAINERS_RUNNING=''
CONTAINERS_TOTAL=''
UNHEALTHY_JSON='[]'
SERVICES_JSON='[]'

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER_AVAILABLE=true
  CONTAINERS_RUNNING="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
  CONTAINERS_TOTAL="$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"

  UNHEALTHY_LIST="$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null)"
  if [ -n "$UNHEALTHY_LIST" ]; then
    UNHEALTHY_JSON="$(printf '%s\n' "$UNHEALTHY_LIST" \
      | awk 'BEGIN{ORS=""; print "["} {printf "%s\"%s\"", (NR>1?",":""), $0} END{print "]"}')"
  fi

  IDS="$(docker ps -aq 2>/dev/null)"
  if [ -n "$IDS" ]; then
    # Un seul appel à docker inspect : 30 conteneurs, ce n'est pas 30 processus.
    # `restarts` est le signal à ne pas rater — un conteneur qui redémarre en
    # boucle affiche `running` et paraît sain (§3.3).
    SERVICES_JSON="$(docker inspect \
      --format '{"name":{{json .Name}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"since":{{json .State.StartedAt}},"restarts":{{.RestartCount}},"stack":{{json (index .Config.Labels "com.docker.compose.project")}}}' \
      $IDS 2>/dev/null \
      | sed 's#^{"name":"/#{"name":"#' \
      | awk 'BEGIN{ORS=""; print "["} {printf "%s%s", (NR>1?",":""), $0} END{print "]"}')"
    [ -z "$SERVICES_JSON" ] && SERVICES_JSON='[]'
  fi
fi

# --- CrowdSec ---------------------------------------------------------------
# cscli absent n'est PAS une erreur : c'est une source absente (§3.7).
CROWDSEC_JSON='{"available":false,"activeDecisions":null,"recentBans":[]}'
if command -v cscli >/dev/null 2>&1; then
  DECISIONS="$(cscli decisions list -o json 2>/dev/null || true)"
  if [ -n "$DECISIONS" ] && [ "$DECISIONS" != "null" ]; then
    if command -v jq >/dev/null 2>&1; then
      CROWDSEC_JSON="$(printf '%s' "$DECISIONS" | jq -c '
        { available: true,
          activeDecisions: ([.[]?.decisions[]?] | length),
          recentBans: ( [ .[]? | .decisions[]? | {ip: .value, scenario: .scenario, until: .duration} ]
                        | .[0:5] ) }' 2>/dev/null || printf '%s' "$CROWDSEC_JSON")"
    else
      # Sans jq on sait compter, pas détailler. On le dit en remontant une liste
      # vide plutôt qu'en inventant.
      COUNT="$(printf '%s' "$DECISIONS" | grep -o '"scenario"' | wc -l | tr -d ' ')"
      CROWDSEC_JSON="{\"available\":true,\"activeDecisions\":$COUNT,\"recentBans\":[]}"
    fi
  else
    CROWDSEC_JSON='{"available":true,"activeDecisions":0,"recentBans":[]}'
  fi
fi

# --- Charge utile -----------------------------------------------------------
LOAD_JSON='null'
if [ -n "$LOAD1" ]; then LOAD_JSON="[$(num "$LOAD1"),$(num "$LOAD5"),$(num "$LOAD15")]"; fi

PAYLOAD="$(cat <<JSON
{
  "reportedAt": $(q "$(date -u +%Y-%m-%dT%H:%M:%SZ)"),
  "agentVersion": $(q "$AGENT_VERSION"),
  "machine": {
    "hostname": $(q "$HOSTNAME_V"),
    "ip": $([ -n "$PUBLIC_IP" ] && q "$PUBLIC_IP" || printf 'null'),
    "uptimeSeconds": $(num "$UPTIME_V"),
    "load": $LOAD_JSON,
    "memPct": $(num "$MEM_PCT"),
    "diskPct": $(num "$DISK_PCT"),
    "diskFreeGB": $(num "$DISK_FREE_GB"),
    "containers": { "running": $(num "$CONTAINERS_RUNNING"), "total": $(num "$CONTAINERS_TOTAL") },
    "containersUnhealthy": $UNHEALTHY_JSON,
    "rebootRequired": $REBOOT_REQUIRED,
    "dockerAvailable": $DOCKER_AVAILABLE
  },
  "services": $SERVICES_JSON,
  "crowdsec": $CROWDSEC_JSON
}
JSON
)"

# --- Remise ------------------------------------------------------------------
if [ -n "${INFRA_INGEST_FILE:-}" ]; then
  # vps-core écrit en local : même volume que le service, pas de réseau, pas de
  # jeton (§3.2bis.6). Écriture atomique, comme partout ailleurs.
  TMP="${INFRA_INGEST_FILE}.tmp.$$"
  printf '%s\n' "$PAYLOAD" > "$TMP" || { log "écriture impossible dans $TMP"; exit 1; }
  mv -f "$TMP" "$INFRA_INGEST_FILE" || { log "renommage impossible vers $INFRA_INGEST_FILE"; rm -f "$TMP"; exit 1; }
  log "état écrit dans $INFRA_INGEST_FILE"
  exit 0
fi

: "${INFRA_INGEST_URL:?INFRA_INGEST_URL non défini}"
: "${INFRA_PUSH_TOKEN:?INFRA_PUSH_TOKEN non défini}"

HTTP_CODE="$(printf '%s' "$PAYLOAD" | curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 10 \
  -X POST \
  -H "Authorization: Bearer ${INFRA_PUSH_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data @- \
  "${INFRA_INGEST_URL%/}/api/ingest/${INFRA_MACHINE}" 2>/dev/null)"

case "$HTTP_CODE" in
  204|200) exit 0 ;;
  401) log "pousse refusée (401) — jeton invalide pour $INFRA_MACHINE"; exit 1 ;;
  404) log "pousse refusée (404) — machine inconnue du service"; exit 1 ;;
  429) log "pousse limitée (429) — trop de requêtes"; exit 1 ;;
  000|'') log "service injoignable"; exit 1 ;;
  *) log "pousse échouée (HTTP $HTTP_CODE)"; exit 1 ;;
esac
