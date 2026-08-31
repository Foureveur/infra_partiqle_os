# Déploiement — `infra.partiqle.studio`

Runbook à exécuter **sur `vps-core`**. Chaque étape est indépendante et
laisse le système fonctionnel : on peut s'arrêter après la 2 et avoir une page
utilisable avec des cartes grises.

> **Vérifier avant d'affirmer.** Tous les chemins ci-dessous ont été relevés le
> 31/08/2026, mais l'infra bouge. Relire l'existant avant d'écrire.

---

## Voie rapide : l'installeur

Les étapes 0 à 3 sont automatisées par `deploy/install.sh`. Trois commandes
depuis le Mac, chacune sur **une seule ligne** — donc aucun risque qu'un bloc
collé s'exécute en local au lieu du serveur :

```bash
ssh vps-core 'cd /opt/studio-os/services && git clone https://github.com/Foureveur/infra_partiqle_os.git infra'
ssh vps-core 'bash /opt/studio-os/services/infra/deploy/install.sh --check'
ssh vps-core 'bash /opt/studio-os/services/infra/deploy/install.sh --apply'
```

`--check` ne modifie rien : il dit ce qu'il ferait et signale ce qui cloche
(réseau compose portant un autre nom, docker absent…). Le script est
idempotent : le relancer ne duplique rien.

Il sauvegarde `docker-compose.yml` et le `Caddyfile` avant de les toucher, et
**valide la config Caddy avant de recharger** — si elle est invalide, il
restaure la sauvegarde et ne recharge rien. Une config Caddy cassée couperait
tous les sous-domaines, pas seulement celui-ci.

Restent à faire à la main ensuite : les étapes 4 à 7 (Kuma, GlitchTip,
Roadmaps, Hostinger, sauvegardes), qui demandent des jetons, et la pousse sur
les trois autres VPS (étape 3, seconde moitié).

Le reste de ce document détaille chaque étape, pour la faire soi-même ou pour
comprendre ce que l'installeur fabrique.

---

## 0. Poser le code

```bash
cd /opt/studio-os/services
git clone https://github.com/Foureveur/infra_partiqle_os.git infra
cd infra && git checkout claude/infra-partiqle-dashboard-95azo6
```

Rien à installer : le service n'a aucune dépendance npm. Les polices et
GridStack sont déjà vendorisés dans `public/vendor/`.

---

## 1. Secrets

```bash
install -m 0600 /opt/studio-os/services/infra/.env.example \
                /opt/studio-os/services/infra.env
$EDITOR /opt/studio-os/services/infra.env
```

Générer les quatre jetons de pousse — **un par machine**, jamais un jeton
partagé : c'est ce qui fait que le jeton de `vps-lab` ne peut pas écrire l'état
de `vps-core`.

```bash
for m in VPS_CORE VPS_SAAS_01 VPS_CLIENTS_01 VPS_LAB; do
  echo "INFRA_PUSH_TOKEN_$m=$(openssl rand -hex 32)"
done
```

Les autres jetons (Kuma, GlitchTip, Roadmaps, Hostinger) peuvent rester vides
pour l'instant : leurs cartes seront grises, le reste marchera.

---

## 2. Service et Caddy

### Compose

Coller le fragment de `deploy/compose.infra.snippet.yml` dans
`/opt/studio-os/docker-compose.yml`, sous `services:`.

Avant de coller, **vérifier le motif du service `naming`** : nom exact du
réseau, et forme des limites de ressources (`deploy.resources` vs
`mem_limit`/`cpus`). Suivre ce que fait la stack, pas ce que dit ce fichier.

### Caddyfile

```bash
cd /opt/studio-os/config/caddy
cp Caddyfile Caddyfile.bak-infra-$(date +%Y%m%d)   # convention du lieu : 8 sauvegardes datées existent déjà
$EDITOR Caddyfile                                   # coller deploy/Caddyfile.infra
```

Le point à ne pas rater : le matcher `@ingest` est déclaré **avant** le `handle`
général. Sinon la pousse des machines se fait rediriger vers la page de login
d'Authelia et aucune machine ne remonte jamais.

Vérifier aussi qu'aucune règle `access_control` d'Authelia
(`/opt/studio-os/config/authelia/configuration.yml`) n'attrape
`*.partiqle.studio` plus permissivement avant `infra.` :

```bash
grep -n -A20 'access_control' /opt/studio-os/config/authelia/configuration.yml
```

### Droits sur le volume d'état

Le conteneur tourne en `node` (uid 1000), pas en root. Un volume monté prend
les droits de l'hôte et écrase ceux posés par le Dockerfile : sans ce `chown`,
le service démarre mais **aucune disposition ne s'enregistre** et le collecteur
échoue en écriture.

```bash
mkdir -p /opt/studio-os/data/infra/machines
chown -R 1000:1000 /opt/studio-os/data/infra
chmod 750 /opt/studio-os/data/infra
```

### Démarrage

```bash
cd /opt/studio-os
docker compose up -d infra          # JAMAIS sans nom de service
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec caddy caddy reload   --config /etc/caddy/Caddyfile
```

> **`docker compose up -d` sans nom de service** est l'erreur qui a recréé
> immomap sans ses secrets le 30/08 et provoqué 4 minutes de coupure. Toujours
> nommer le service.

### Contrôles

```bash
curl -I https://infra.partiqle.studio            # attendu : redirection Authelia, pas la page
curl -sS https://infra.partiqle.studio | grep -iE 'bearer|token|secret|api[-_]key'   # attendu : rien
docker compose logs --tail=20 infra
```

Le certificat est émis par Caddy au premier accès. Le DNS résout déjà
(joker `*.partiqle.studio` → `76.13.53.158`), mais le Caddyfile n'a **aucun
vhost joker** : sans le bloc ci-dessus, `infra.partiqle.studio` échoue au
handshake TLS. Vérifié depuis l'extérieur le 31/08.

---

## 3. Pousse des machines

Commencer par `vps-core`, en local. Si ça marche là, le réseau est le seul
delta pour les trois autres.

### Sur `vps-core`

```bash
install -m 0755 /opt/studio-os/services/infra/deploy/infra-report.sh /usr/local/bin/infra-report.sh
install -m 0600 /opt/studio-os/services/infra/deploy/infra-report.env.example /etc/infra-report.env
$EDITOR /etc/infra-report.env      # INFRA_MACHINE=vps-core + INFRA_INGEST_FILE (voir le fichier)

mkdir -p /opt/studio-os/data/infra/machines
/usr/local/bin/infra-report.sh && cat /opt/studio-os/data/infra/machines/vps-core.json | head -20
```

### Sur `vps-saas-01`, `vps-clients-01`, `vps-lab`

Même chose, mais en pousse HTTP : `INFRA_INGEST_URL` + le `INFRA_PUSH_TOKEN`
**de cette machine**.

```bash
/usr/local/bin/infra-report.sh; echo "code de sortie : $?"
```

`jq` est facultatif mais recommandé : sans lui, CrowdSec remonte le nombre de
décisions sans le détail des bannissements.

### Crons

Voir `deploy/crontab.md` — un cron de pousse sur chacune des quatre machines,
un cron de collecte sur `vps-core`. `flock` est obligatoire dans les deux cas.

### Contrôles

```bash
# La pousse d'une machine ne doit pas pouvoir en écrire une autre :
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Authorization: Bearer $INFRA_PUSH_TOKEN_VPS_LAB" \
  -H 'Content-Type: application/json' --data '{}' \
  https://infra.partiqle.studio/api/ingest/vps-core         # attendu : 401

# Sans jeton, refus — et surtout pas une redirection vers Authelia :
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' --data '{}' \
  https://infra.partiqle.studio/api/ingest/vps-core         # attendu : 401

docker compose exec -T infra node src/collector/index.js
docker compose exec -T infra node -e "
  const s=require('/app/var/state.json');
  console.log(s.machines.map(m=>m.id+' '+(m.reportedAt||'jamais')).join('\n'));"
```

---

## 4. Kuma et GlitchTip

### Kuma — créer une page de statut

Relevé le 31/08 : `https://status.partiqle.studio/api/entry-page` renvoie
`entryPage: null`, donc **aucune page de statut n'existe**. Il faut en créer une
— ce qui a de la valeur en soi, indépendamment de ce projet.

1. Kuma → **Status Pages** → **New Status Page**, slug `infra`.
2. Y ajouter **tous** les moniteurs. C'est ce qui rend les moniteurs en pause
   détectables : ils restent sur la page de statut mais disparaissent de
   `/metrics`, et c'est la différence des deux listes qui révèle le trou de
   couverture. Un moniteur oublié sur la page de statut est un moniteur dont on
   ne saura jamais qu'il est en pause.
3. Kuma → **Profil** → **Clés d'API** → nouvelle clé (lecture seule).
4. Renseigner `KUMA_STATUS_SLUG=infra` et `KUMA_API_KEY=…`.

Vérifié le 31/08 : `/metrics` répond **401**, donc l'endpoint existe et attend
la clé. Si la page de statut n'est pas créée, la voie `/metrics` seule
fonctionne quand même — mais la carte affichera « couverture non vérifiable »
au lieu de faire semblant de savoir.

### GlitchTip

1. GlitchTip → **Profil** → **Auth Tokens** → nouveau jeton, portées
   `org:read` et `event:read`.
2. Relever le slug de l'organisation (visible dans l'URL de l'UI).
3. Renseigner `GLITCHTIP_ORG` et `GLITCHTIP_TOKEN`.

```bash
docker compose up -d infra
docker compose exec -T infra node src/collector/index.js
docker compose exec -T infra node -e "
  const s=require('/app/var/state.json'); console.log(JSON.stringify(s.sources,null,1));"
```

---

## 5. Roadmaps

L'endpoint `GET /api/infra/summary` est à construire dans le dépôt Roadmaps.
Contrat complet, champs, pièges et commandes de vérification :
**`docs/roadmaps-infra-summary.md`**.

Tant qu'il n'existe pas, les cartes Projets et Échéances restent grises. Rien
d'autre n'est affecté.

---

## 6. Hostinger

Il ne reste qu'à renseigner `HOSTINGER_TOKEN` : les quatre `hostingerId` de
`data/machines.json` ont été relevés le 31/08 contre l'API réelle, et le
rattachement se fait aussi par IP ou par hostname si un identifiant change.

Le jeton se crée dans hPanel → *Compte* → *API* → *Générer un jeton*. La lecture
seule suffit : le collecteur ne fait que des `GET`.

### Ce que la source lit, et ce qu'elle ne lit pas

`GET /api/vps/v1/virtual-machines/<id>/metrics` **exige** `date_from` et
`date_to` — sans eux, pas de réponse. Le collecteur demande les 24 dernières
heures. La réponse a cette forme :

```jsonc
{ "cpu_usage":        { "unit": "%",     "usage": { "<timestamp unix>": 52.76, … } },
  "outgoing_traffic": { "unit": "bytes", "usage": { … } },
  "ram_usage": …, "disk_space": …, "incoming_traffic": …, "uptime": … }
```

`usage` est une **table timestamp → valeur**, pas une série `[[t, v]]`.
L'ordre des clés d'un objet JSON ne se décrète pas : le lecteur trie.

On n'en garde que deux choses :

- **CPU** : la dernière valeur, plus la moyenne des 24 h. Seule la seconde rend
  la première lisible — 52 %, ce n'est une anomalie que face à 8 % d'habitude.
- **Trafic sortant** : la somme de la fenêtre. Ce compteur monte *et descend*
  d'un relevé à l'autre : c'est un volume par intervalle, pas un cumul de quota.
  Le rapporter au quota mensuel du plan serait une invention.

Le disque, la RAM et l'uptime **ne sont pas repris** : la pousse de la machine
les mesure déjà de l'intérieur, sur tous les volumes montés — ce que
l'hyperviseur ne voit pas. Deux mesures du même fait finissent par diverger.

En revanche `state` (l'avis de l'hyperviseur) est conservé, et c'est utile
précisément quand la machine se tait : il ne la rend pas saine — elle reste
inconnue — mais il tranche entre « VM éteinte » et « agent de pousse mort ».

Les tables étant montées en lecture seule depuis
`/opt/studio-os/services/infra/data`, éditer `machines.json` sur l'hôte suffit —
pas de reconstruction d'image, pas de redémarrage : le registre est relu à
chaque requête.

---

## 7. Sauvegardes

```bash
cat /opt/backups/backup-core.sh
cat /usr/local/bin/watchdog-backups.sh
```

**D'abord regarder** s'ils écrivent déjà un état exploitable. Si oui, le
consommer plutôt que d'ajouter une seconde source de vérité. Sinon seulement,
greffer `deploy/backup-state-snippet.sh` — il contient les instructions.

Tant que `/opt/studio-os/data/infra/backups.json` n'existe pas, la carte
Sauvegardes est grise, avec le message « le script de sauvegarde n'écrit pas
encore son état ». Elle ne dit **jamais** que tout va bien.

---

## Recette (§10 du brief)

Automatisé — à lancer depuis le dépôt :

```bash
npm run smoke
```

Couvre : aller-retour de disposition, refus sous le seuil mobile sans écraser
la disposition bureau, carte inconnue refusée, 401 sans `Remote-User`, les
quatre refus d'ingestion, le verrou de collecte concurrente, `state.json`
jamais tronqué, machine muette ⇒ inconnue, conteneurs d'une machine muette
marqués figés, aucune valeur de jeton servie, remontée de chemin refusée.

À passer à la main sur `vps-core` :

- [ ] Déplacer une carte, la redimensionner, recharger **depuis un autre
      navigateur** : la disposition est là.
- [ ] Replier trois cartes, recharger : elles sont repliées.
- [ ] Ouvrir sur téléphone puis revenir sur le bureau : la disposition bureau
      est intacte.
- [ ] Arrêter le collecteur 20 minutes : la page s'affiche, bandeau de
      fraîcheur, **aucune carte verte à tort**.
- [ ] Couper le réseau vers l'API Hostinger : seule cette carte passe en
      inconnu, le reste vit.
- [ ] Arrêter un conteneur non critique : il apparaît `exited` en moins de
      6 minutes.
- [ ] `curl -I https://infra.partiqle.studio` sans session ⇒ redirection
      Authelia.
- [ ] Arrêter `infra-report.sh` sur une machine : au bout de 15 minutes elle
      passe **inconnue**, pas verte.
- [ ] La page se charge en moins d'une seconde, sans requête sortante depuis le
      navigateur (onglet Réseau : tout doit venir de `infra.partiqle.studio`).
- [ ] Le compte à rebours de `FIN SITEGROUND — 05/10` est visible sans faire
      défiler.

---

## Diagnostic

| symptôme | piste |
|---|---|
| Page blanche, 502 | `docker compose logs infra` — cause la plus fréquente : `data/cards.json` malformé, le service refuse de démarrer exprès |
| 401 sur `/api/layout` depuis le navigateur | Authelia ne pousse pas `Remote-User` : vérifier `copy_headers` dans le bloc Caddy |
| Toutes les machines inconnues | aucun cron de pousse, ou `@ingest` déclaré après le `handle` général |
| Une machine inconnue | `journalctl` / `/var/log/infra-report.log` sur CETTE machine, puis `bash -x /usr/local/bin/infra-report.sh` |
| Bandeau « données figées » permanent | le cron de collecte ne tourne pas : `grep infra-collect /var/log/syslog`, ou verrou périmé dans `/opt/studio-os/data/infra/.collector.lock` |
| Une carte grise | c'est voulu tant que sa source n'est pas configurée. `curl … /api/state \| jq .sources` donne l'erreur exacte |
| La disposition ne s'enregistre pas | fenêtre sous 768 px, ou volume `./data/infra` non accessible en écriture par l'utilisateur `node` du conteneur |
