# Chiffra

Chiffra vise à traiter des lots de factures et de relevés bancaires : extraction des données comptables, rapprochement des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. Il contient le contrat d'état partagé et un Compose partiel pour PostgreSQL et Redis. Il n'y a encore ni API, ni interface, ni ingestion ; aucune exigence métier EX-01 à EX-08 n'est déclarée validée.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l'ordre des transitions et limitent chaque rôle à sa partie de l'état. Elles ne prouvent pas encore l'appel effectif d'un outil financier : cette preuve sera ajoutée avec le moteur et la persistance.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`. Le contrôle de types, la compilation et les quatre tests du contrat ont réussi dans un conteneur Docker sur un VPS Linux le 17 septembre 2026 (code de sortie 0). Cette vérification porte sur le contrat seulement ; elle ne valide pas encore l'application complète ni une autre plateforme.

## Stockage en cours de construction

Le Compose actuel définit PostgreSQL 16 et Redis 7 sur un réseau propre à Chiffra, sans port publié sur l'hôte. Le mot de passe PostgreSQL est fourni dans `.env` à partir du champ vide de `.env.example` ; aucune valeur secrète n'est livrée. Les volumes conservent les données entre redémarrages.

Sur une base neuve, `db/migrations/001_sources.sql` crée les lots et les sources physiques avec une contrainte de réimport du même contenu dans un lot. Le service ponctuel `migrate` applique ensuite la migration 2, y compris sur un volume déjà existant, et peut être relancé sans recréer les tables. La migration 2 conserve les tentatives d'extraction de texte et impose un motif pour les échecs ou les documents non traités. Une source n'est pas encore une facture métier. Ce Compose partiel ne fournit aucune interface utilisateur.

Quand l'application sera livrée, ce README décrira son démarrage et ses tests locaux depuis un clone propre, sans dépendance au poste de développement ni à un VPS particulier.
