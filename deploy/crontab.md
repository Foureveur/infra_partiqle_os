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
