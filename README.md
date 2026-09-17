# Chiffra

Chiffra vise à traiter des lots de factures et de relevés bancaires : extraction des données comptables, rapprochement des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. Cette première tranche technique contient uniquement le contrat d'état partagé. Il n'y a encore ni API, ni interface, ni ingestion, ni Docker Compose ; aucune exigence métier EX-01 à EX-08 n'est déclarée validée.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l'ordre des transitions et limitent chaque rôle à sa partie de l'état. Elles ne prouvent pas encore l'appel effectif d'un outil financier : cette preuve sera ajoutée avec le moteur et la persistance.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`. Le lockfile initial et les tests du contrat attendent encore une exécution réelle dans Docker. Ce jalon reste `IMPLEMENTE_NON_VERIFIE`.

Quand l'application sera livrée, ce README décrira son démarrage et ses tests locaux depuis un clone propre, sans dépendance au poste de développement ni à un VPS particulier.
