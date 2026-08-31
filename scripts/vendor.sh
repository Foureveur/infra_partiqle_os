#!/usr/bin/env bash
# Récupère les dépendances front servies localement (GridStack + polices).
# Le résultat est COMMITÉ dans le dépôt : la page doit s'afficher même quand
# ce qui est cassé, c'est le réseau. Ce script ne sert qu'à rafraîchir.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/public/vendor"
GRIDSTACK_VERSION="13.2.0"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

vendor_gridstack() {
  echo "→ GridStack $GRIDSTACK_VERSION"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -sSL -m 120 -o "$tmp/gs.tgz" \
    "https://registry.npmjs.org/gridstack/-/gridstack-${GRIDSTACK_VERSION}.tgz"
  tar -xzf "$tmp/gs.tgz" -C "$tmp"
  mkdir -p "$VENDOR/gridstack"
  cp "$tmp/package/dist/gridstack-all.js" \
     "$tmp/package/dist/gridstack-all.js.LICENSE.txt" \
     "$tmp/package/dist/gridstack.min.css" \
     "$tmp/package/LICENSE" "$VENDOR/gridstack/"
}

# vendor_font <nom lisible> <famille Google> <axes> <préfixe fichier>
vendor_font() {
  local label="$1" family="$2" axis="$3" slug="$4"
  echo "→ $label"
  mkdir -p "$VENDOR/fonts"
  local css; css="$(curl -sSL -m 60 -A "$UA" \
    "https://fonts.googleapis.com/css2?family=${family}:${axis}&display=swap")"
  # On ne garde que le sous-ensemble latin : le bloc qui précède chaque src est
  # commenté par Google avec le nom du sous-ensemble.
  local n=0
  while read -r url; do
    [ -z "$url" ] && continue
    n=$((n + 1))
    curl -sSL -m 60 -o "$VENDOR/fonts/${slug}-${n}.woff2" "$url"
  done <<< "$(printf '%s\n' "$css" \
    | awk '/\/\* latin \*\//{keep=1} /\/\* /{ if ($0 !~ /latin \*\//) keep=0 } keep' \
    | grep -oE 'https://[^)]+\.woff2' | awk '!seen[$0]++')"
  echo "   $n fichier(s) woff2"
}

vendor_gridstack
vendor_font "Bricolage Grotesque" "Bricolage+Grotesque" "opsz,wght@12..96,600;12..96,700" "bricolage"
vendor_font "Source Serif 4"      "Source+Serif+4"      "opsz,wght@8..60,400;8..60,600"   "source-serif"
vendor_font "JetBrains Mono"      "JetBrains+Mono"      "wght@400;600"                    "jetbrains-mono"

echo
echo "Vendorisé dans $VENDOR — pensez à committer le résultat."
