# infra.partiqle.studio

Le premier onglet ouvert le matin. Il répond à trois questions, dans cet ordre :

1. **Est-ce que quelque chose est cassé maintenant ?**
2. **Où en sont mes projets ?**
3. **Où est-ce que je clique pour aller travailler ?**

Ce n'est pas un outil de supervision de plus. Kuma surveille, GlitchTip
collecte les erreurs, Roadmaps porte les projets. `infra.` **agrège et donne
accès** — il n'a aucune donnée à lui, sauf la disposition des cartes.

## Les deux idées qui tiennent tout le reste

**La disposition appartient à l'utilisateur.** Il n'y a pas de grille figée
décidée par le développeur. Chaque bloc est une carte déplaçable et
redimensionnable, et l'arrangement est persisté **côté serveur** — pas dans
`localStorage`, parce qu'une disposition qui ne suit pas d'une machine à
l'autre est une disposition qu'on refait trois fois puis qu'on abandonne.
Conséquence : chaque carte a trois rendus selon sa hauteur — vignette, normale,
étendue — parce qu'on ne conçoit pas une carte « qui fait 4 colonnes ».

**Une source qui échoue n'est pas une source qui va bien.** C'est le seul
défaut de conception qui rendrait cette page nuisible plutôt qu'utile. Un bloc
dont la collecte a échoué s'affiche en **inconnu** — gris, creux, hachuré, avec
l'heure de la dernière valeur bonne et l'erreur au survol. Jamais vert, jamais
rouge. Rouge veut dire « j'ai regardé et c'est cassé », pas « je n'ai pas pu
regarder ».

Et la fraîcheur est recalculée **par le service, à chaque requête** — pas
inscrite par le collecteur. Si seul le collecteur décidait de la péremption, un
collecteur mort servirait un fichier tout vert. La page vieillit ce qu'elle
affiche même quand plus rien ne l'alimente.

## Architecture

```
  4 VPS ──── infra-report.sh (cron 5 min, flock) ──┐
                                                    │ POST /api/ingest/<machine>
                                                    │ jeton par machine, hors Authelia
                                                    ▼
  collecteur (cron 5 min sur core) ──> lit machines/*.json + Kuma, GlitchTip,
                                        Roadmaps, Hostinger, backups.json
                                        └─> écrit state.json (atomique, sous verrou)
                                                    │
  service infra (Node, sans dépendance) ────────────┘ lit un fichier, rien d'autre
      GET  /api/state    state.json + fraîcheur dérivée à la volée
      GET  /api/layout   disposition de l'utilisateur (clé : Remote-User)
      PUT  /api/layout   l'enregistre — refusée sous 768 px
      POST /api/ingest/<machine>   écriture seule, jeton par machine
      GET  /             la page
                                                    │
  Caddy + Authelia ─────────────────────────────────┘
```

**Modèle en pousse, pas en tirage.** `vps-core` n'a aucune clé SSH vers les
trois autres VPS, et ne doit pas en avoir : c'est la machine exposée sur
Internet. Lui donner les clés du parc pour afficher un pourcentage de disque
serait la seule décision de ce projet qui augmente la surface d'attaque. Chaque
machine s'annonce et ne peut écrire que sa propre ligne. La contrepartie est
explicite : **une machine qui n'a pas poussé depuis 15 minutes est inconnue** —
le silence n'est pas une bonne nouvelle.

Le service ne fait **jamais** d'appel réseau sortant pendant une requête. Il
sert un fichier. Le navigateur non plus n'appelle aucune API tierce : la
politique de sécurité du contenu (`connect-src 'self'`) le garantit
mécaniquement, pas seulement par discipline d'écriture.

## Le voir tourner en local

Aucune dépendance à installer, aucun jeton, aucun Docker. Node 20 ou plus suffit.

```bash
git clone https://github.com/Foureveur/infra_partiqle_os.git
cd infra_partiqle_os
git checkout claude/infra-partiqle-dashboard-95azo6

npm run demo     # écrit un état de démonstration dans ./var
npm run dev      # http://localhost:3000
```

Puis : bouton **Organiser** en haut à droite, déplacer une carte par son
en-tête, la redimensionner par le coin bas-droite, replier par le chevron,
masquer par la croix. Recharger : tout est retrouvé. C'est le serveur qui garde
la disposition, dans `./var/layout.local.json`.

```bash
npm run smoke    # la recette automatisable — 27 assertions
```

`npm run dev` fixe `INFRA_DEV_USER`, qui remplace l'en-tête `Remote-User` que
pousse Authelia en production. **Le laisser vide en production** : sans lui et
sans Authelia, `/api/layout` répond 401 plutôt que de servir la disposition de
quelqu'un. `npm start` est la commande de production, sans ce contournement.

L'état de démonstration est volontairement bancal — une source en échec, une
machine silencieuse, un conteneur qui redémarre en boucle, une sauvegarde en
retard, un moniteur en pause. C'est dans cet état-là qu'une page de supervision
se juge ; tout en vert, n'importe quelle maquette fait illusion.

## Structure

| chemin | rôle |
|---|---|
| `src/server.js` | routeur HTTP, sans dépendance |
| `src/lib/freshness.js` | dérive l'état affichable — **le module à lire en premier** |
| `src/lib/layout.js` | validation et persistance de la disposition |
| `src/routes/ingest.js` | la seule route hors Authelia, traitée comme exposée |
| `src/collector/` | orchestrateur (cadences, verrou) et une source par fichier |
| `data/` | tables éditables à la main : machines, plateformes, liens, cartes |
| `public/cards/` | un module de rendu par type de carte |
| `deploy/` | Caddyfile, fragment compose, script de pousse, crons |
| `docs/roadmaps-infra-summary.md` | contrat de l'endpoint à construire côté Roadmaps |

Ajouter un lien au launcher, une plateforme, ou changer le tier d'une machine :
éditer le fichier dans `data/`. Les tables sont montées en lecture seule dans
le conteneur et relues à chaque requête — pas de redémarrage, pas de
reconstruction d'image.

## Déploiement

Voir **[DEPLOY.md](DEPLOY.md)** — runbook pas à pas, contrôles à chaque étape,
recette et tableau de diagnostic.

## Ce qui n'est pas dans la v1

Aucune **action** depuis la page (la v1 lit ; le jour où elle écrit, elle change
de classe de risque). Pas d'**historique**. Pas de **multi-utilisateur** — la
clé par `Remote-User` est là pour ne pas se fermer la porte. Pas de **métas
hébergement/stack** venant de Roadmaps. Pas de **détection d'incohérences**.
Pas de **notifications** : Kuma et GlitchTip notifient déjà, en ajouter une
troisième source c'est fabriquer de la fatigue d'alerte.

## Tiers

Vendorisé dans `public/vendor/`, jamais de CDN — cette page doit s'afficher
même quand ce qui est cassé, c'est le réseau.

- [GridStack.js](https://gridstackjs.com/) 13.2.0 — MIT
- Bricolage Grotesque, Source Serif 4, JetBrains Mono — SIL Open Font License 1.1

`npm run vendor` rafraîchit le tout ; le résultat est commité.
