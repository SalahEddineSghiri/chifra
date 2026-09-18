# Chiffra

Chiffra vise à traiter des lots de factures et de relevés bancaires : extraction des données comptables, rapprochement des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. On peut créer un lot, déposer un PDF texte, suivre son traitement par le worker et consulter le texte ainsi que les champs lus automatiquement. Chaque champ présent porte sa page ; un champ absent ou ambigu reste vide avec un motif. Ces observations ne sont pas encore des factures validées ni des calculs comptables. Les scans sans couche texte reçoivent un état `NON_TRAITE` et un motif ; l'OCR, les autres formats et les analyses métier ne sont pas encore disponibles. Aucune exigence métier EX-01 à EX-08 n'est déclarée validée.

## Démarrage local

Copier `.env.example` vers `.env`, puis renseigner `POSTGRES_PASSWORD`. Les clés Azure peuvent rester vides pour la création des lots et l'extraction PDF texte. Depuis la racine du clone :

```sh
docker compose up -d --build
```

L'interface est disponible sur `http://localhost:8081`, ou sur le port défini par `WEB_PORT`. Le Compose principal démarre les services disponibles et applique les migrations avant l'API. Les tests restent facultatifs et séparés.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l'ordre des transitions et limitent chaque rôle à sa partie de l'état. Elles ne prouvent pas encore l'appel effectif d'un outil financier : cette preuve sera ajoutée avec le moteur et la persistance.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`. Le contrôle de types, la compilation et les quatre tests du contrat ont réussi dans un conteneur Docker sur un VPS Linux le 17 septembre 2026 (code de sortie 0). Cette vérification porte sur le contrat seulement ; elle ne valide pas encore l'application complète ni une autre plateforme.

## Stockage en cours de construction

Le Compose actuel définit PostgreSQL 16, Redis 7, l'API, le worker et l'interface sur un réseau propre à Chiffra. L'API et le worker utilisent la même image. Seule l'interface est publiée sur `127.0.0.1` ; PostgreSQL et Redis ne publient aucun port. Le mot de passe PostgreSQL est fourni dans `.env` à partir du champ vide de `.env.example` ; aucune valeur secrète n'est livrée. Les volumes conservent la base, Redis et les PDF entre redémarrages.

Au démarrage normal de Compose, une base neuve reçoit la migration 1, puis le service ponctuel `migrate` applique les migrations 2 à 5. Sur un volume existant, `migrate` applique seulement les migrations manquantes. La migration 1 crée les lots et les sources physiques avec une contrainte de réimport du même contenu dans un lot. La migration 2 conserve les tentatives d'extraction de texte et impose un motif pour les échecs ou les documents non traités. Une source n'est pas encore une facture métier.

La migration 3 conserve les passages extraits avec leur page ou ligne. La confiance, si elle est réellement fournie par l'outil, est exprimée en pourcentage ; sinon elle reste `NULL`. La migration 4 ajoute le nom facultatif des lots existants ; les nouveaux lots créés par l'API exigent un nom. La migration 5 conserve les champs lus dans le PDF et leur version de lecture. Au premier démarrage du nouveau worker, les PDF texte déjà traités et sans ces champs sont relus.

## PDF texte

Dans un lot ouvert, l'interface accepte un PDF de 15 Mo maximum. L'API vérifie sa signature et le dédoublonne par empreinte dans le lot ; le worker lit réellement le texte avec Poppler, page par page, puis conserve le résultat et les références de page dans PostgreSQL. Un parseur de libellés explicites relève le tiers, la date, le numéro et les montants imprimés quand ils sont reconnaissables ; il ne calcule ni total attendu ni conformité fiscale. Le texte affiché est un aperçu de 2 000 caractères. Un PDF de plus de 30 pages, sans texte ou avec une page sans texte reste `NON_TRAITE` avec un motif explicite. Cette étape ne reconnaît pas encore les images.

## Tests avec Docker

Depuis la racine du clone, cette commande lance les tests SQL dans des conteneurs Docker, sans installer PostgreSQL sur le PC :

```sh
docker compose -f compose.test.yaml up --force-recreate --abort-on-container-exit --exit-code-from sql_tests sql_tests
```

`compose.test.yaml` crée une base de test séparée, sans port publié et avec des données temporaires. Il applique les migrations 1 à 5, puis exécute `tests/sources.sql`, `tests/migrations.sql` et `tests/segments.sql`. Pour vérifier aussi la création d'un lot dans l'API et sa persistance, partir d'un environnement de test neuf :

```sh
docker compose -f compose.test.yaml down
docker compose -f compose.test.yaml build api_tests contracts_tests
docker compose -f compose.test.yaml run --rm api_tests
```

Cette seconde commande exécute également les tests SQL et les tests du contrat dont elle dépend. Elle vérifie l'upload, le traitement réel d'un PDF texte, la persistance des champs sourcés, le refus d'un doublon et l'état d'un PDF sans texte dans des conteneurs isolés. Les tests facultatifs ne touchent pas aux volumes de l'application. Le code de sortie de chaque commande est celui de ses tests. Pour retirer ensuite les conteneurs de test : `docker compose -f compose.test.yaml down`.

Les autres parcours métier et leurs vérifications seront ajoutés au fur et à mesure de leur livraison.
