# Crons

## Sur `vps-core` — le collecteur

Un seul cron toutes les 5 minutes. Il décide en interne quelles sources sont
dues (§3.9) : machines et backups à chaque passage, Kuma et GlitchTip toutes
les 5 min, Roadmaps toutes les 15, Hostinger toutes les 30.

```cron
*/5 * * * * flock -n /run/infra-collect.lock docker compose -f /opt/studio-os/docker-compose.yml exec -T infra node src/collector/index.js >> /var/log/infra-collect.log 2>&1
```

`flock -n` est **obligatoire**. Deux collecteurs concurrents qui écrivent le
même `state.json`, on connaît le résultat — c'est ce qui a corrompu la migration
polaris le 29/08. Le collecteur pose en plus son propre verrou dans le volume de
données, pour que la garantie tienne aussi quand on le lance à la main.

> Lancer le collecteur **dans** le conteneur évite d'installer Node sur l'hôte et
> garantit qu'il voit exactement le même environnement que le service. Si vous
> préférez le lancer sur l'hôte, la commande est
> `INFRA_DATA_DIR=/opt/studio-os/data/infra node /opt/studio-os/services/infra/src/collector/index.js`,
> avec `services/infra.env` chargé.

Rotation du journal, à poser dans `/etc/logrotate.d/infra` :

```
/var/log/infra-collect.log /var/log/infra-report.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    copytruncate
}
```

## Sur les **quatre** VPS — la pousse

```cron
*/5 * * * * flock -n /run/infra-report.lock /usr/local/bin/infra-report.sh >> /var/log/infra-report.log 2>&1
```

Décaler les machines de quelques minutes n'est pas nécessaire : chaque pousse
écrit son propre fichier, il n'y a pas de contention.

Rappel : une machine qui n'a pas poussé depuis 15 minutes devient **inconnue**,
pas en panne et surtout pas saine. Si vous arrêtez volontairement une machine,
c'est ce que la page doit dire.

## Sauvegardes — inchangées

Les deux crons existants restent tels quels :

```cron
0 3 * * * /opt/backups/backup-core.sh >> /var/log/backup-core.log 2>&1
0 8 * * * /usr/local/bin/watchdog-backups.sh >> /var/log/watchdog-backups.log 2>&1
```

Seul le contenu de `backup-core.sh` change, et seulement s'il n'écrit pas déjà
un état exploitable : voir `deploy/backup-state-snippet.sh`.

## Forcer une collecte

Après avoir renseigné un jeton dans `services/infra.env`, la source concernée
n'est pas forcément *due* : elle sera reconduite avec son ancienne erreur, et on
croit à tort que la configuration n'a pas pris. Deux options :

```bash
# Tout, en ignorant les cadences
docker compose exec -T infra node src/collector/index.js --force

# Une seule source, pour isoler un problème
docker compose exec -T infra node src/collector/index.js --only=kuma --force
```

Sources : `machines`, `backups`, `kuma`, `glitchtip`, `roadmaps`, `hostinger`.

## Mettre à jour le code

`src/` et `public/` sont **copiés dans l'image** au build, ils ne sont pas
montés. Récupérer le dépôt sur l'hôte ne suffit donc pas : sans reconstruction,
le conteneur continue de faire tourner l'ancien code, et on débogue une version
qu'on ne lit pas.

```bash
ssh vps-core 'curl -fsSL https://codeload.github.com/Foureveur/infra_partiqle_os/tar.gz/refs/heads/claude/infra-partiqle-dashboard-95azo6 \
  | tar -xz -C /opt/studio-os/services/infra --strip-components=1 \
  && cd /opt/studio-os && docker compose up -d --build infra'
```

### L'agent de pousse ne suit PAS ce rafraîchissement

Même piège, un cran plus loin, et il s'est déjà refermé une fois (31/08 : les
sauvegardes sont restées « veilleur non greffé » alors que la greffe était
posée). `install-agent.sh` **copie** `infra-report.sh` vers `/usr/local/bin/` ;
c'est cette copie que le cron exécute. Mettre à jour le dépôt sur `vps-core` ne
met à jour aucun des quatre agents.

Après toute modification de `deploy/infra-report.sh`, réinstaller partout :

```bash
# vps-core (le dépôt est déjà à jour sur cette machine)
ssh vps-core 'install -m 0755 /opt/studio-os/services/infra/deploy/infra-report.sh /usr/local/bin/infra-report.sh && /usr/local/bin/infra-report.sh'

# les trois autres
for M in vps-saas-01 vps-clients-01 vps-lab; do
  ssh vps-core 'tar -C /opt/studio-os/services/infra/deploy -cz infra-report.sh' \
    | ssh "$M" 'tar -xz -C /tmp && install -m 0755 /tmp/infra-report.sh /usr/local/bin/infra-report.sh && /usr/local/bin/infra-report.sh'
done
```

`AGENT_VERSION` remonte dans `state.json` (`machines[].agentVersion`) : c'est là
qu'on voit une machine restée en arrière.

```bash
docker compose exec -T infra node -e "
  require('/app/var/state.json').machines.forEach(m=>console.log(m.id, m.agentVersion||'—'));"
```

### Ce qui, lui, ne demande rien

Seul `data/` fait exception : les tables (liens, plateformes, machines, cartes)
sont montées en lecture seule et relues à chaque requête. Ajouter un lien ne
demande donc ni build ni redémarrage.
