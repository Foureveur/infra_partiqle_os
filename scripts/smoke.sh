#!/usr/bin/env bash
#
# Recette automatisable (§10). Ce script couvre les points vérifiables sans
# l'infra réelle ; les autres sont dans DEPLOY.md, à passer sur vps-core.
#
# Usage : npm run smoke
#
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$(mktemp -d)"
PORT="${SMOKE_PORT:-3199}"
BASE="http://127.0.0.1:${PORT}"
PASS=0
FAIL=0

export INFRA_DATA_DIR="$DATA"
export PORT
export INFRA_PUSH_TOKEN_VPS_CORE="jeton-core-$$"
export INFRA_PUSH_TOKEN_VPS_LAB="jeton-lab-$$"

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$DATA"
}
trap cleanup EXIT

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
ko()   { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
head2() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# `Remote-User` n'est jamais pris d'un paramètre client : on le pousse comme
# Authelia le ferait.
AS_USER=(-H 'Remote-User: quentin')

cd "$ROOT"
node src/server.js > "$DATA/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 40); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.15
done
curl -sf "$BASE/healthz" >/dev/null || { echo "le service n'a pas démarré"; cat "$DATA/server.log"; exit 1; }

# ---------------------------------------------------------------- disposition
head2 "Disposition"

LAYOUT="$(curl -sS "${AS_USER[@]}" "$BASE/api/layout")"
CARD_COUNT="$(printf '%s' "$LAYOUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).cards.length))')"
[ "$CARD_COUNT" -ge 10 ] && ok "disposition par défaut servie ($CARD_COUNT cartes)" || ko "disposition par défaut" "$CARD_COUNT cartes"

PUT_BODY='{"viewportWidth":1440,"cards":[{"id":"launcher","x":3,"y":7,"w":5,"h":9,"collapsed":true,"hidden":false}]}'
CODE="$(curl -sS -o "$DATA/put.json" -w '%{http_code}' -X PUT "${AS_USER[@]}" \
  -H 'Content-Type: application/json' --data "$PUT_BODY" "$BASE/api/layout")"
[ "$CODE" = "200" ] && ok "PUT /api/layout accepté" || ko "PUT /api/layout" "HTTP $CODE"

ROUND="$(curl -sS "${AS_USER[@]}" "$BASE/api/layout" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c=JSON.parse(s).cards.find(c=>c.id==="launcher");
  console.log(JSON.stringify([c.x,c.y,c.w,c.h,c.collapsed]));
})')"
[ "$ROUND" = "[3,7,5,9,true]" ] && ok "aller-retour fidèle (position, taille, repli)" || ko "aller-retour" "$ROUND"

# Une carte ajoutée au registre doit apparaître chez un utilisateur qui a déjà
# une disposition, sans l'obliger à réinitialiser.
MERGED="$(curl -sS "${AS_USER[@]}" "$BASE/api/layout" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).cards.length))')"
[ "$MERGED" -eq "$CARD_COUNT" ] && ok "cartes du registre absentes du fichier réintégrées ($MERGED)" \
  || ko "réintégration des cartes du registre" "$MERGED au lieu de $CARD_COUNT"

# ------------------------------------------------------------------- refus
head2 "Refus attendus"

CODE="$(curl -sS -o "$DATA/mob.json" -w '%{http_code}' -X PUT "${AS_USER[@]}" \
  -H 'Content-Type: application/json' \
  --data '{"viewportWidth":400,"cards":[{"id":"launcher","x":0,"y":0,"w":12,"h":6,"collapsed":false,"hidden":false}]}' \
  "$BASE/api/layout")"
[ "$CODE" = "409" ] && ok "écriture refusée sous le seuil mobile (409)" || ko "refus mobile" "HTTP $CODE"

AFTER="$(curl -sS "${AS_USER[@]}" "$BASE/api/layout" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const c=JSON.parse(s).cards.find(c=>c.id==="launcher"); console.log(JSON.stringify([c.x,c.y,c.w,c.h]));})')"
[ "$AFTER" = "[3,7,5,9]" ] && ok "la disposition bureau est intacte après la tentative mobile" \
  || ko "disposition bureau écrasée par le mobile" "$AFTER"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "${AS_USER[@]}" \
  -H 'Content-Type: application/json' \
  --data '{"viewportWidth":1440,"cards":[{"id":"../../etc/passwd","x":0,"y":0,"w":4,"h":4,"collapsed":false,"hidden":false}]}' \
  "$BASE/api/layout")"
[ "$CODE" = "400" ] && ok "carte inconnue refusée (400)" || ko "carte inconnue" "HTTP $CODE"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/api/layout")"
[ "$CODE" = "401" ] && ok "sans Remote-User, /api/layout répond 401" || ko "layout sans utilisateur" "HTTP $CODE"

# ---------------------------------------------------------------- ingestion
head2 "Ingestion — la seule route hors Authelia"

PUSH='{"reportedAt":"2026-08-31T09:00:00Z","machine":{"hostname":"srv-core","ip":"76.13.53.158","uptimeSeconds":1000,"load":[0.1,0.2,0.3],"memPct":50,"diskPct":42,"diskFreeGB":10,"containers":{"running":3,"total":4},"containersUnhealthy":[],"rebootRequired":false,"dockerAvailable":true},"services":[{"name":"studio-os-caddy-1","image":"caddy:2","state":"running","health":"healthy","since":"2026-08-28T11:02:00Z","restarts":0,"stack":"studio-os"}],"crowdsec":{"available":true,"activeDecisions":7,"recentBans":[]}}'

CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data "$PUSH" "$BASE/api/ingest/vps-core")"
[ "$CODE" = "401" ] && ok "pousse sans jeton refusée (401)" || ko "pousse sans jeton" "HTTP $CODE"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $INFRA_PUSH_TOKEN_VPS_LAB" -H 'Content-Type: application/json' \
  --data "$PUSH" "$BASE/api/ingest/vps-core")"
[ "$CODE" = "401" ] && ok "jeton de vps-lab refusé sur /api/ingest/vps-core (401)" \
  || ko "cloisonnement des jetons" "HTTP $CODE"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $INFRA_PUSH_TOKEN_VPS_CORE" -H 'Content-Type: application/json' \
  --data "$PUSH" "$BASE/api/ingest/vps-inexistante")"
[ "$CODE" = "404" ] && ok "machine inconnue refusée (404)" || ko "machine inconnue" "HTTP $CODE"

CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $INFRA_PUSH_TOKEN_VPS_CORE" -H 'Content-Type: application/json' \
  --data "$PUSH" "$BASE/api/ingest/vps-core")"
[ "$CODE" = "204" ] && ok "pousse légitime acceptée (204, sans corps)" || ko "pousse légitime" "HTTP $CODE"

BIG="$(node -e 'process.stdout.write(JSON.stringify({machine:{hostname:"x".repeat(300000)}}))')"
CODE="$(printf '%s' "$BIG" | curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $INFRA_PUSH_TOKEN_VPS_CORE" -H 'Content-Type: application/json' \
  --data @- "$BASE/api/ingest/vps-core")"
[ "$CODE" = "413" ] && ok "corps surdimensionné refusé (413)" || ko "plafond de taille" "HTTP $CODE"

# -------------------------------------------------------------- collecteur
head2 "Collecteur"

node src/collector/index.js > "$DATA/collect.log" 2>&1
node -e 'JSON.parse(require("fs").readFileSync(process.env.INFRA_DATA_DIR+"/state.json","utf8"))' \
  && ok "state.json écrit et valide" || ko "state.json"

# Verrou : vérifié de façon déterministe. Lancer deux collecteurs en parallèle
# ne prouve rien ici — une collecte dure 15 ms et les deux processus ne se
# croisent pas forcément. On pose donc le verrou à la main et on exige le refus.
printf '{"pid":999999,"at":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DATA/.collector.lock"
node src/collector/index.js > "$DATA/locked.log" 2>&1
RC=$?
[ "$RC" = "75" ] && ok "collecte refusée quand le verrou est tenu (code 75)" \
  || ko "verrou" "code de sortie $RC au lieu de 75"

rm -f "$DATA/.collector.lock"
node src/collector/index.js > "$DATA/unlocked.log" 2>&1
[ $? = "0" ] && ok "collecte reprise une fois le verrou levé" || ko "reprise après verrou"

# Un verrou périmé (collecteur tué par l'OOM killer) ne doit pas bloquer pour
# toujours : au-delà de dix minutes il est repris.
printf '{"pid":999999}' > "$DATA/.collector.lock"
touch -d '30 minutes ago' "$DATA/.collector.lock" 2>/dev/null || touch -t "$(date -d '30 minutes ago' +%Y%m%d%H%M 2>/dev/null)" "$DATA/.collector.lock"
node src/collector/index.js > "$DATA/stale.log" 2>&1
[ $? = "0" ] && ok "verrou périmé repris au bout de 10 min" || ko "verrou périmé" "la collecte reste bloquée"
node -e 'JSON.parse(require("fs").readFileSync(process.env.INFRA_DATA_DIR+"/state.json","utf8"))' \
  && ok "state.json jamais tronqué après les scénarios de verrou" || ko "state.json tronqué"

# --------------------------------------------------------------- fraîcheur
head2 "Fraîcheur — le silence n'est pas une bonne nouvelle"

STATE="$(curl -sS "$BASE/api/state")"
CORE_STATUS="$(printf '%s' "$STATE" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).machines.find(m=>m.id==="vps-core").status))')"
[ "$CORE_STATUS" = "ok" ] && ok "machine fraîchement poussée : ok" || ko "machine fraîche" "statut $CORE_STATUS"

# On vieillit artificiellement la pousse de 20 minutes.
node -e '
const fs=require("fs"), p=process.env.INFRA_DATA_DIR+"/machines/vps-core.json";
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.reportedAt=new Date(Date.now()-20*60000).toISOString();
fs.writeFileSync(p,JSON.stringify(j));'
node src/collector/index.js > /dev/null 2>&1

AGED="$(curl -sS "$BASE/api/state" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
const m=j.machines.find(m=>m.id==="vps-core");
const svc=j.services.filter(x=>x.machine==="vps-core");
console.log(m.status+"|"+(svc.length?svc[0].stale:"n/a"));})')"
[ "${AGED%%|*}" = "unknown" ] && ok "machine muette depuis 20 min : INCONNUE, pas verte" \
  || ko "machine muette" "statut ${AGED%%|*}"
[ "${AGED##*|}" = "true" ] && ok "ses conteneurs sont marqués figés, pas « running »" \
  || ko "conteneurs d'une machine muette" "stale=${AGED##*|}"

FROZEN="$(curl -sS "$BASE/api/state" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
const bad=Object.entries(j.sources).filter(([,v])=>!v.ok).map(([k])=>k);
console.log(bad.join(","));})')"
[ -n "$FROZEN" ] && ok "sources non configurées en échec explicite : $FROZEN" || ko "sources en échec"

GREEN="$(curl -sS "$BASE/api/state" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
// Aucune source en échec ne doit produire de donnée présentée comme bonne.
const kuma=j.incidents.kuma, gt=j.incidents.glitchtip;
console.log(((!j.sources.kuma.ok && kuma!==null)||(!j.sources.glitchtip.ok && gt!==null))?"FUITE":"propre");})')"
[ "$GREEN" = "propre" ] && ok "une source en échec ne laisse filtrer aucune donnée « bonne »" \
  || ko "fuite de données d'une source en échec"

# ------------------------------------------------------------------ secrets
head2 "Secrets"

PAGE="$(curl -sS "$BASE/")"
if printf '%s' "$PAGE" | grep -iEq 'bearer|token|secret|api[-_]key'; then
  ko "un secret ou un mot suspect apparaît dans le HTML servi"
else
  ok "aucun jeton dans le HTML servi"
fi
# On cherche les VALEURS des jetons, pas les mots. Un message d'erreur qui
# nomme la variable manquante (« KUMA_API_KEY absent ») est utile et sans
# danger ; c'est la valeur qui ne doit jamais sortir.
if curl -sS "$BASE/api/state" \
  | grep -qE "$INFRA_PUSH_TOKEN_VPS_CORE|$INFRA_PUSH_TOKEN_VPS_LAB|Bearer [A-Za-z0-9]"; then
  ko "une valeur de jeton apparaît dans /api/state"
else
  ok "aucune valeur de jeton dans /api/state"
fi

if curl -sS "${AS_USER[@]}" "$BASE/api/layout" \
  | grep -qE "$INFRA_PUSH_TOKEN_VPS_CORE|$INFRA_PUSH_TOKEN_VPS_LAB"; then
  ko "une valeur de jeton apparaît dans /api/layout"
else
  ok "aucune valeur de jeton dans /api/layout"
fi

CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/../../etc/passwd")"
[ "$CODE" = "404" ] || [ "$CODE" = "403" ] && ok "remontée de chemin refusée (HTTP $CODE)" \
  || ko "remontée de chemin" "HTTP $CODE"

# ------------------------------------------------------------------ verdict
printf '\n\033[1m%d réussis, %d échoués\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
