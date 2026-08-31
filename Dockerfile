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

ENV NODE_ENV=production \
    INFRA_DATA_DIR=/app/var \
    INFRA_TABLES_DIR=/app/data \
    PORT=3000

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
