# `GET /api/v1/infra/summary` — contrat réel

> **Cet endpoint existe déjà.** Il est implémenté dans `Foureveur/partiqle-roadmaps` :
> `src/routes/api/v1/infra/summary/+server.ts` et `src/lib/server/infra.ts`.
> Ce document décrit ce que le code fait, relevé le 31/08/2026 — pas une
> spécification à construire.

Le brief §3.5 annonçait `/api/infra/summary` avec une forme différente. Trois
écarts, tous absorbés côté collecteur (`src/collector/sources/roadmaps.js`) :

| brief | réalité |
|---|---|
| `/api/infra/summary` | **`/api/v1/infra/summary`** |
| `projects[]` | **`roadmaps[]`** |
| `counts`, `blocked` | **`itemCounts`, `statusCounts.blocked`** |

## Requête

```
GET https://roadmaps.partiqle.studio/api/v1/infra/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
Authorization: Bearer <API_TOKEN>
```

Le jeton est celui de `API_TOKEN` dans l'environnement de Roadmaps — le même que
celui du serveur MCP. `requireApiToken()` compare en temps constant et renvoie
401 sinon.

`from` / `to` bornent `markers[]` ; par défaut J-7 → J+90. `nextMarker`, lui,
n'est pas borné : il décrit l'état d'un projet, pas une tranche d'agenda.

## Réponse

```jsonc
{
  "generatedAt": "2026-08-31T14:00:00.000Z",
  "window": { "from": "2026-08-24", "to": "2026-11-29" },
  "roadmaps": [{
    "id": "uJX9s8vLrGbvPSWK1q17e",
    "title": "Rationalisation Infra Partiqle",
    "section": "Studio",
    "updatedAt": "2026-08-31T09:09:18.000Z",
    "itemCounts":   { "now": 8, "next": 9, "later": 6, "ideas": 2 },
    "statusCounts": { "planned": 3, "progress": 5, "done": 214, "blocked": 1 },
    "progress":     { "subtasksDone": 214, "subtasksTotal": 301 },
    "nextMarker":   { "date": "2026-09-05", "label": "SiteGround — renouvellement" },
    "url": "https://roadmaps.partiqle.studio/roadmap/uJX9s8vLrGbvPSWK1q17e"
  }],
  "markers": [{
    "roadmapId": "uJX9s8vLrGbvPSWK1q17e",
    "roadmapTitle": "Rationalisation Infra Partiqle",
    "date": "2026-10-11",
    "type": "milestone",
    "label": "Expiration altais-montreuil.fr"
  }],
  // présent seulement si le garde-fou a mordu
  "truncated": { "markers": "plus de 400 jalons dans la fenêtre ; resserrez ?from= / ?to=" }
}
```

Aucune description, aucun contenu riche, aucun titre de sous-tâche n'en sort.
La réponse est petite par construction — le test `scripts/test-api.mjs` du dépôt
Roadmaps échoue si elle dépasse 20 Ko. C'est ce qui règle le défaut documenté
« `get_roadmap` renvoie plus de 100 Ko ».

## Le type des jalons, et pourquoi ça compte ici

Roadmaps type ses jalons en **`milestone` | `rdv` | `payment`**. Il n'a pas de
notion de *registrar*.

Or une expiration de domaine est irréversible : c'est la classe d'échéance la
plus dangereuse du tableau de bord (§3.6), celle qui remonte en tête de carte
dès J-30 et déclenche une alerte dans le bandeau. Le collecteur la reconnaît
donc **au libellé**, via une heuristique délibérément large — `expiration`,
`renouvellement`, `registrar`, `domaine`, ou un TLD connu. Un faux positif se
voit et se corrige ; une date manquée ne se rattrape pas.

Les échéances vraiment critiques ne dépendent pas de cette heuristique : elles
sont tenues à la main dans `data/deadlines.json` du dépôt infra, avec un `kind`
explicite. Les deux sources fusionnent par date + libellé.

## `nextMarker` n'est PAS borné par la fenêtre

Le piège le plus facile de tout ce contrat, et il nous a eus jusqu'au 07/09.

- `markers[]` est un **agenda** : « qu'y a-t-il dans cette tranche de temps ».
  Sa fenêtre est un choix d'affichage, déjà appliqué par le serveur.
- `nextMarker` est un **état de projet** : « quelle est la prochaine échéance de
  cette roadmap », quelle que soit sa distance. Volontairement non borné — sinon
  un projet dont l'échéance est à six mois renverrait `null` et se lirait comme
  *inactif* alors qu'il est seulement *pas imminent*.

Le collecteur appliquait son propre horizon de 90 jours aux deux. La prochaine
échéance d'un projet lointain disparaissait donc du tableau. Sur une expiration
de domaine, c'est la pire façon de se tromper : ne rien afficher se lit comme
« rien à signaler ».

Corrigé : l'horizon ne s'applique qu'à l'agenda. La provenance est portée par
`markerOrigin`, distinct d'`origin` qui sert déjà en aval à séparer la table
tenue à la main de ce qui vient de Roadmaps.

**Conséquence à retenir :** un jalon peut apparaître dans `nextMarker` sans être
dans `markers[]`. Ce n'est pas une incohérence.

## `meta` — implémenté le 07/09, et pas sous la forme annoncée

Ce champ a longtemps été « réservé, non implémenté », avec une forme plate
prévue (`hosting: "hostinger-vps"`, `stack: ["sveltekit", …]`). **Cette forme
n'a pas survécu** à la contrainte « sondable, pas déclaratif » ajoutée le 07/09.

Chaque champ porte désormais sa déclaration ET son observation, et la synthèse
en émet une version réduite :

```jsonc
"meta": {                                  // null tant que rien n'est déclaré
  "hosting": { "provider": { "value": "Hostinger", "state": "confirmed" },
               "machine":  { "value": "vps-lab",   "state": "drift" } },
  "stack":   { "voie": …, "primary": …, "database": …, "containerized": … },
  "environments": [{ "name": "prod", "value": "https://…", "state": "confirmed" }],
  "drift": ["hosting.machine"],
  "unverified": ["stack.primary"]
}
```

`state` vaut `confirmed` · `drift` · `observed-only` · `stale` · `unverified` ·
`declarative` · `empty`. **`drift` est la partie utile** : les champs où la sonde
contredit la déclaration. C'est ça qu'il faut remonter, pas la valeur.

`meta` reste **optionnel** : `null` quand rien n'est renseigné, plutôt qu'un
squelette de `null` qui se lirait comme une méta remplie de vide. Le collecteur
doit continuer à savoir vivre sans.

Le contrat complet — forme stockée, routes d'écriture, pourquoi deux valeurs par
champ — est dans `docs/project-meta.md` du dépôt Roadmaps. C'est la référence ;
ce qui est ici n'en est que la part consommée.

## Vérifier

```bash
# Depuis vps-core, avec le jeton de services/infra.env :
docker compose exec -T infra node -e "
  const {config}=require('/app/src/lib/config');
  fetch(config.roadmaps.summaryUrl,{headers:{Authorization:'Bearer '+config.roadmaps.token}})
    .then(r=>r.json()).then(d=>console.log(d.roadmaps.length,'roadmaps,',d.markers.length,'jalons'));"

# Puis la collecte :
docker compose exec -T infra node src/collector/index.js --only=roadmaps --force
```
