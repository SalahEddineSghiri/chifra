# Chiffra

Chiffra vise à traiter des lots de factures et de relevés bancaires : extraction des données comptables, rapprochement des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. On peut créer un lot, déposer un PDF ou une image JPG, suivre son traitement par le worker et consulter le texte ainsi que les champs lus automatiquement. Le texte natif des PDF reste prioritaire ; Tesseract traite les pages scannées et les JPG sur CPU. Chaque champ présent porte sa page ; un champ absent ou ambigu reste vide avec un motif. Ces observations ne sont pas encore des factures validées ni des calculs comptables.

EX-01 et EX-02 restent partielles : les PDF texte, les PDF scannés et les JPG sont couverts, avec une limite de 15 Mo et 30 pages par PDF. Les CSV, XLSX, relevés bancaires, lots fermés de 50 pièces et contrôles sur le corpus complet restent à réaliser. Les calculs futurs devront rester déterministes et sourcés conformément à EX-07. Une pièce sans texte exploitable après OCR reste explicitement `NON_TRAITE`, conformément à EX-08.

## Démarrage local

Copier `.env.example` vers `.env`, puis renseigner `POSTGRES_PASSWORD`. Les clés Azure peuvent rester vides pour les fonctionnalités disponibles. Depuis la racine du clone :

```sh
docker compose up -d --build
```

L’interface est disponible sur `http://localhost:8081`, ou sur le port défini par `WEB_PORT`. Le Compose principal applique les migrations avant l’API et démarre PostgreSQL, Redis, l’API, le worker et le service web avec Nginx. Les tests restent facultatifs et séparés.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Une valeur lue identifie aussi la méthode et la version de son extraction. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l’ordre des transitions et limitent chaque rôle à sa partie de l’état. Elles ne prouvent pas encore l’appel effectif d’un outil financier.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`.

## Stockage

Le Compose définit PostgreSQL 16, Redis 7, l’API, le worker et l’interface sur un réseau propre à Chiffra. L’API et le worker utilisent la même image avec des processus distincts. Seule l’interface est publiée sur `127.0.0.1` ; PostgreSQL et Redis ne publient aucun port. Les volumes conservent la base, Redis et les sources entre redémarrages.

Au démarrage, une base neuve reçoit la migration 1, puis le service ponctuel `migrate` applique les migrations 2 à 6. Sur un volume existant, il applique seulement les migrations manquantes. Les tables séparent les sources physiques, extractions versionnées, segments avec page, observations et provenance des observations. Une source n’est pas encore une facture métier.

La confiance reste `NULL`, car le parcours actuel ne collecte pas une mesure suffisamment fiable pour la publier. Le motif d’un état terminal est conservé. Au premier démarrage de cette version, le worker reprend les traitements interrompus et les anciens PDF qui attendaient l’OCR.

## PDF et JPG

Dans un lot ouvert, l’interface accepte un PDF ou un JPG de 15 Mo maximum. L’API vérifie le format réel et dédoublonne le contenu dans le lot. Les JPEG sont limités à 40 millions de pixels et 20 000 pixels par côté. Le worker lit d’abord le texte PDF avec Poppler puis applique Tesseract 5 en français et anglais uniquement aux pages sans texte et aux JPG. Le rendu d’une page PDF est limité à 3 500 pixels par côté.

Le worker traite au plus deux sources en parallèle par défaut, avec une valeur configurable de 1 à 4. Chaque commande OCR dispose de 60 secondes et le rendu d’une page de 45 secondes. Une erreur technique est retentée trois fois avec attente progressive ; une sortie sans texte exploitable devient `NON_TRAITE`. Une extraction lisible reste `DONE` même si ses champs sont absents, ambigus ou arithmétiquement incohérents. Le parseur relève seulement les valeurs imprimées et ne calcule aucun total attendu ni conformité fiscale.

## Tests avec Docker

Cette commande exécute uniquement les migrations et tests SQL dans une base isolée :

```sh
docker compose -f compose.test.yaml up --force-recreate --abort-on-container-exit --exit-code-from sql_tests sql_tests
```

Pour exécuter les tests du contrat, de l’API, du worker et le parcours OCR complet à travers Nginx :

```sh
docker compose -f compose.test.yaml down -v
docker compose -f compose.test.yaml build
docker compose -f compose.test.yaml run --rm e2e_tests
```

La dernière commande exécute aussi les tests SQL, du contrat et du serveur dont elle dépend. Elle vérifie un PDF texte, un PDF scanné, des JPG lisibles, ambigus et illisibles, une erreur technique OCR après trois tentatives, ainsi que la reprise idempotente. Le test final charge un JPG par le Nginx du service web et vérifie l’API, le worker, les champs attendus et leur stockage PostgreSQL. Ces tests utilisent leurs propres services et volume. Pour les retirer :

```sh
docker compose -f compose.test.yaml down -v
```

Les parcours CSV/XLSX, le rapprochement bancaire, les contrôles comptables et fiscaux, l’agent, l’Explainer et la revue humaine seront ajoutés dans les étapes fonctionnelles suivantes.
