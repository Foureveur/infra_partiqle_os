FROM node:22-alpine

# Aucune dépendance à installer : le service n'utilise que la bibliothèque
# standard de Node. Pas de npm install, donc pas de surface d'approvisionnement,
# et une image qui tient dans les 256 Mo alloués.
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY data ./data
COPY scripts ./scripts

# /app/var reçoit le volume d'état (state.json, layout.*.json, machines/).
# /app/data porte les tables du dépôt, montées en lecture seule par le compose.
RUN mkdir -p /app/var/machines && chown -R node:node /app/var

# ── Retirer les gestionnaires de paquets ─────────────────────────────────────
# Relevé le 07/09/2026 par Trivy : les 11 failles Node de cette image — dont sa
# SEULE CRITICAL (CVE-2026-59873, bombe gzip dans node-tar) — vivent toutes dans
# usr/local/lib/node_modules/npm/. Aucune dans notre code : `app/package.json`
# ressort à zéro, le service n'ayant aucune dépendance.
#
# Autrement dit on transportait un gestionnaire de paquets qu'on ne lance
# jamais, et on payait ses failles. L'image démarre `node src/server.js`, en
# uid 1000, sans jamais invoquer npm — ni au build (rien à installer) ni au
# run. Ce qui n'est pas là ne peut pas être vulnérable.
#
# Le HEALTHCHECK et le CMD n'utilisent que le binaire `node`, qui reste.
# Les 2 HIGH restantes sont dans libcrypto3/libssl3 (CVE-2026-14456, déni de
# service QUIC). Alpine a le correctif en 3.5.8-r0 ; node:22-alpine n'a pas
# encore reconstruit dessus. On rattrape ces deux paquets et rien d'autre : un
# `apk upgrade` général changerait des choses qu'on n'a pas demandées.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg \
           /opt/yarn-v* \
 && apk upgrade --no-cache libcrypto3 libssl3

ENV NODE_ENV=production \
    INFRA_DATA_DIR=/app/var \
    INFRA_TABLES_DIR=/app/data \
    PORT=3000

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
