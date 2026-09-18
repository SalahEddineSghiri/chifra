# Chiffra

Chiffra vise à traiter des lots de factures et de relevés bancaires : extraction des données comptables, rapprochement des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. Il contient le contrat d'état partagé et un Compose partiel pour PostgreSQL et Redis. Il n'y a encore ni API, ni interface, ni ingestion ; aucune exigence métier EX-01 à EX-08 n'est déclarée validée.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l'ordre des transitions et limitent chaque rôle à sa partie de l'état. Elles ne prouvent pas encore l'appel effectif d'un outil financier : cette preuve sera ajoutée avec le moteur et la persistance.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`. Le contrôle de types, la compilation et les quatre tests du contrat ont réussi dans un conteneur Docker sur un VPS Linux le 17 septembre 2026 (code de sortie 0). Cette vérification porte sur le contrat seulement ; elle ne valide pas encore l'application complète ni une autre plateforme.

## Stockage en cours de construction

Le Compose actuel définit PostgreSQL 16 et Redis 7 sur un réseau propre à Chiffra, sans port publié sur l'hôte. Le mot de passe PostgreSQL est fourni dans `.env` à partir du champ vide de `.env.example` ; aucune valeur secrète n'est livrée. Les volumes conservent les données entre redémarrages.

Au démarrage normal de Compose, une base neuve reçoit la migration 1, puis le service ponctuel `migrate` applique la migration 2. Sur un volume existant, `migrate` applique seulement les migrations manquantes. La migration 1 crée les lots et les sources physiques avec une contrainte de réimport du même contenu dans un lot. La migration 2 conserve les tentatives d'extraction de texte et impose un motif pour les échecs ou les documents non traités. Une source n'est pas encore une facture métier. Ce Compose partiel ne fournit aucune interface utilisateur.

## Tests SQL avec Docker

Depuis la racine du clone, cette commande lance les tests SQL dans des conteneurs Docker, sans installer PostgreSQL sur le PC :

```sh
docker compose -f compose.test.yaml up --force-recreate --abort-on-container-exit --exit-code-from sql_tests
```

`compose.test.yaml` crée une base de test séparée, sans port publié et avec des données temporaires. Il applique les migrations 1 et 2, puis exécute `tests/sources.sql` et `tests/migrations.sql`. Ces tests sont séparés du démarrage normal et ne touchent pas aux volumes de l'application. Le code de sortie de la commande est celui des tests. Pour retirer ensuite les conteneurs de test : `docker compose -f compose.test.yaml down`.

Quand l'application sera livrée, ce README décrira son démarrage et ses tests locaux depuis un clone propre, sans dépendance au poste de développement ni à un VPS particulier.
