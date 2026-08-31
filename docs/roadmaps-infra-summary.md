# `GET /api/infra/summary` — contrat, à implémenter côté Roadmaps

Cet endpoint **n'est pas dans ce dépôt**. Il est à ajouter dans l'application
Roadmaps ; ce document en fixe le contrat, pour que les deux côtés soient
écrits une seule fois.

Il règle deux problèmes d'un coup (§3.5 du brief) : il alimente le dashboard,
et il répond au défaut documenté « `get_roadmap` renvoie plus de 100 Ko,
au-delà de la limite exploitable » (*Correctifs de l'outillage interne*,
sous-tâche 2). Le construire, c'est cocher là-bas.

## Requête

```
GET https://roadmaps.partiqle.studio/api/infra/summary
Authorization: Bearer <jeton de service>
Accept: application/json
```

Le jeton est dans l'en-tête, **jamais dans l'URL** : une URL se retrouve dans
les journaux d'accès de Caddy, pas un en-tête. Côté Roadmaps, un jeton de
service en lecture seule suffit — cet endpoint ne doit rien pouvoir écrire.

Appelé toutes les **15 minutes**. Il doit répondre en moins de 10 secondes et
peser moins de 50 Ko : c'est tout son intérêt.

## Réponse

Le collecteur accepte deux formes. La seconde est préférable.

### Forme préférée

```jsonc
{
  "projects": [
    {
      "id": "uJX9s8vLrGbvPSWK1q17e",
      "title": "Rationalisation Infra Partiqle",
      "section": "Studio",
      "url": "https://roadmaps.partiqle.studio/r/uJX9s8vLrGbvPSWK1q17e",
      "updatedAt": "2026-08-31T09:09:18Z",
      "counts":   { "now": 8, "next": 9, "later": 6, "ideas": 2 },
      "progress": { "subtasksDone": 214, "subtasksTotal": 301 },
      "blocked": 1,
      "nextMarker": { "date": "2026-09-05", "label": "SiteGround — renouvellement automatique" }
    }
  ],
  "markers": [
    { "date": "2026-10-05", "label": "FIN SITEGROUND", "kind": "milestone", "project": "Rationalisation Infra Partiqle" },
    { "date": "2026-10-11", "label": "Expiration altais-montreuil.fr", "kind": "registrar", "project": null }
  ]
}
```

### Forme du brief, également acceptée

Un tableau nu de projets. Les échéances sont alors déduites des seuls
`nextMarker`, donc **incomplètes** : la carte Échéances ne montrera qu'un jalon
par projet. C'est pour ça que `markers` existe — le §3.6 demande « les markers
des roadmaps », pas le prochain de chaque projet.

## Champs

| champ | obligatoire | note |
|---|---|---|
| `id` | oui | identifiant de la roadmap |
| `title` | oui | |
| `section` | non | section de rangement |
| `url` | non | déduite de `id` si absente |
| `updatedAt` | non | ISO 8601 |
| `counts.{now,next,later,ideas}` | non | nombre d'items par colonne, 0 par défaut |
| `progress.subtasksDone/Total` | non | sous-tâches, tous items confondus |
| `blocked` | non | nombre d'items marqués bloqués |
| `nextMarker` | non | prochain jalon non dépassé |
| `markers[].date` | oui | `YYYY-MM-DD` ou ISO 8601 |
| `markers[].label` | oui | |
| `markers[].kind` | **fortement recommandé** | `registrar` ou `milestone` |
| `markers[].project` | non | titre du projet porteur |

### Sur `kind`, et pourquoi ça compte

Les échéances **registrar** — expirations de domaine — sont la classe la plus
dangereuse : une date manquée est irréversible. Elles remontent en tête de
carte dès J-30 et déclenchent une alerte dans le bandeau du haut.

Si Roadmaps ne fournit pas `kind`, le collecteur le devine au libellé
(`expiration`, `renouvellement`, `registrar`, `domaine`, un TLD reconnu). Cette
heuristique est délibérément large : un faux positif se voit et se corrige,
une date manquée ne se rattrape pas. **Fournir `kind` explicitement reste la
bonne solution.**

## Ce que l'endpoint NE doit PAS renvoyer

- Les descriptions et le contenu riche des items — c'est ce qui fait exploser
  `get_roadmap` au-delà de 100 Ko.
- Les métas « hébergement » et « stack » par projet : elles ne sont pas encore
  construites côté Roadmaps (planifié fin octobre), et la v1 du dashboard ne
  doit pas en dépendre. Le rattachement projet ↔ machine vient en attendant de
  la table statique `data/platforms.json`.

## Ce qui se passe tant qu'il n'existe pas

Rien ne casse. La source `roadmaps` échoue proprement, les cartes **Projets**
et **Échéances** s'affichent en gris avec le message d'erreur au survol, et le
reste de la page vit sa vie. C'est le comportement voulu : une source qui
échoue n'est pas une source qui va bien, mais elle n'emporte pas les autres.

## Vérifier une fois construit

```bash
# Depuis vps-core, avec le jeton de services/infra.env :
curl -sS -H "Authorization: Bearer $ROADMAPS_TOKEN" \
  https://roadmaps.partiqle.studio/api/infra/summary | head -c 2000

# Taille de la réponse — doit rester très en dessous de 100 Ko :
curl -sS -o /dev/null -w '%{size_download} octets\n' \
  -H "Authorization: Bearer $ROADMAPS_TOKEN" \
  https://roadmaps.partiqle.studio/api/infra/summary

# Sans jeton : doit refuser, pas servir.
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://roadmaps.partiqle.studio/api/infra/summary   # attendu : 401
```

Puis, côté dashboard, forcer une collecte et regarder la source passer au vert :

```bash
docker compose exec -T infra node src/collector/index.js
curl -sS localhost:3000/api/state | jq '.sources.roadmaps, (.deadlines | length)'
```
