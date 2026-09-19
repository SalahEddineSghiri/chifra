# Chiffra

Chiffra traite progressivement des lots de factures et de relevés bancaires : extraction des données comptables, import CSV bancaire, rapprochement déterministe des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. On peut créer un lot, sélectionner plusieurs PDF, JPG ou XLSX en une fois, suivre chaque traitement par le worker, consulter les champs lus automatiquement et importer un relevé bancaire CSV. Chaque fichier garde son propre statut et une erreur d'envoi n'empêche pas les autres fichiers sélectionnés. Le texte natif des PDF reste prioritaire ; Tesseract traite les pages scannées et les JPG sur CPU en français, arabe et anglais. Les XLSX structurés sont lus directement, sans OCR. Chaque champ conserve sa valeur brute, sa valeur normalisée, sa page ou ligne, la méthode et la version d'extraction. Un champ absent reste vide avec un motif. Un champ ambigu reste vide, conserve tous ses candidats et exige explicitement une revue humaine. Ces observations ne sont pas encore des factures validées ni des calculs comptables.

EX-01 et EX-02 restent à valider sur le corpus complet : la sélection multiple, les PDF texte, les PDF scannés, les JPG, les XLSX d'achats et les relevés bancaires CSV au format fourni sont couverts. Un test d'intégration soumet 50 documents et contrôle leurs états terminaux. Les fichiers sources sont limités à 15 Mo et les PDF à 30 pages ; un XLSX ou relevé CSV est limité à 5 000 lignes. La fermeture explicite du lot crée les pièces métier, relie les représentations concordantes et conserve les conflits pour revue. Les calculs futurs restent déterministes et sourcés conformément à EX-07. Une pièce sans texte exploitable après OCR reste explicitement `NON_TRAITE`, conformément à EX-08.

## Démarrage local

Copier `.env.example` vers `.env`, puis renseigner `POSTGRES_PASSWORD`. Les clés Azure peuvent rester vides pour l'ingestion, le rapprochement et l'audit déterministes. Elles sont requises uniquement au lancement de l'analyse agentique. Depuis la racine du clone :

```sh
docker compose up -d --build
```

L’interface est disponible sur `http://localhost:8081`, ou sur le port défini par `WEB_PORT`. Le Compose principal applique les migrations avant l’API et démarre PostgreSQL, Redis, l’API, le worker et le service web avec Nginx. Les tests restent facultatifs et séparés.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Une valeur lue conserve aussi sa forme brute, les normalisations appliquées, la méthode et la version de son extraction. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l’ordre des transitions et limitent chaque rôle à sa partie de l’état. Elles ne prouvent pas encore l’appel effectif d’un outil financier.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`.

## Stockage

Le Compose définit PostgreSQL 16, Redis 7, l’API, le worker et l’interface sur un réseau propre à Chiffra. L’API et le worker utilisent la même image avec des processus distincts. Seule l’interface est publiée sur `127.0.0.1` ; PostgreSQL et Redis ne publient aucun port. Les volumes conservent la base, Redis et les sources entre redémarrages.

Au démarrage, une base neuve reçoit la migration 1, puis le service ponctuel `migrate` applique les migrations 2 à 12. Sur un volume existant, il applique seulement les migrations manquantes. Les tables séparent les sources physiques, extractions versionnées, segments avec page ou ligne, observations, pièces métier, relations entre représentations, preuves de calcul, allocations bancaires, résultats d'audit et traces agentiques.

La confiance reste `NULL`, car le parcours actuel ne collecte pas une mesure suffisamment fiable pour la publier. Le motif d’un état terminal est conservé. Au premier démarrage de cette version, le worker reprend les traitements interrompus et recalcule les observations créées par une ancienne version du parseur.

## PDF et JPG

L’image serveur embarque les modèles officiels `tessdata_best` français, arabe et anglais, figés à la révision `e12c65a915945e4c28e237a9b52bc4a8f39a0cec`, avec leur licence Apache 2.0. Le téléchargement se fait à la construction Docker ; aucun modèle n’est téléchargé au traitement. Le moteur LSTM (`--oem 1`) utilise la segmentation `--psm 6`. Ces modèles privilégient la précision avec un coût CPU supérieur ; chaque processus Tesseract est limité à un thread. Leur précision sur les fixtures arabes et mixtes doit être confirmée par les tests Docker, sans déduire une validation du seul choix de modèle.

Au démarrage, les observations utilisant un ancien modèle OCR sont recalculées. Les extractions précédentes restent conservées et les observations référencent la nouvelle extraction ; une nouvelle reprise avec la même version ne crée pas de doublon.

Dans un lot ouvert, l’interface sélectionne plusieurs PDF, JPG ou XLSX et affiche leur progression d'envoi. L'API reçoit chaque fichier séparément pour isoler les erreurs et les reprises. Chaque fichier est limité à 15 Mo. L’API vérifie le format réel et dédoublonne le contenu dans le lot. Les JPEG sont limités à 40 millions de pixels et 20 000 pixels par côté. Le worker lit d’abord le texte PDF avec Poppler puis applique Tesseract 5 en français, arabe et anglais uniquement aux pages sans texte et aux JPG. Le rendu d’une page PDF est limité à 3 500 pixels par côté. L'interface utilise la direction automatique et Unicode bidi pour rendre lisibles le texte arabe et les contenus mixtes.

Le worker traite au plus deux sources en parallèle par défaut, avec une valeur configurable de 1 à 4. Chaque commande OCR dispose de 60 secondes et le rendu d’une page de 45 secondes. Une erreur technique est retentée trois fois avec attente progressive ; une sortie sans texte exploitable devient `NON_TRAITE`. Une extraction lisible reste `DONE` même si ses champs sont absents, ambigus ou arithmétiquement incohérents. Le parseur relève seulement les valeurs imprimées et ne calcule aucun total attendu ni conformité fiscale.

Les chiffres occidentaux, arabo-indiens et persans ainsi que les séparateurs décimaux et de milliers pris en charge sont normalisés en chaînes décimales. Les composantes de date reconnues sur un chiffre sont complétées par un zéro avec une transformation explicite. La valeur OCR brute et la liste des transformations restent stockées. La reconnaissance des glyphes arabo-indiens dépend de la qualité de l'image et du moteur : une séquence mal reconnue reste absente ou observée telle quelle, sans reconstruction supposée. La reconnaissance d'un texte arabe ne garantit pas l'extraction complète des champs métier : le statut des observations et les candidats permettent de conserver les absences et ambiguïtés.

Le parseur `labels-v4` reconnaît les libellés comptables couverts en français, anglais et arabe. Il distingue le montant TVA du taux, y compris lorsque le texte OCR place le taux après le montant (`1560.00 20%`). Les marques Unicode de direction sont ignorées pour reconnaître les libellés ; le texte source reste conservé. Un libellé absent n'est pas reconstitué. L’OCR arabe reste partiel sur la fixture actuelle : le numéro et la TVA ne sont pas attribués lorsque leurs libellés sont mal reconnus ou absents. Son scénario Docker est conservé mais marqué comme reporté ; il ne bloque plus la validation française et anglaise demandée pour cette étape. Les tests unitaires du parseur ne remplacent pas les tests Docker avec Tesseract réel.

## XLSX d'achats

Le worker accepte une feuille contenant les colonnes `id`, `numero`, `fournisseur`, `ice`, `date`, `compte`, `taux_tva`, `ht`, `tva` et `ttc`. Les cellules numériques sont lues comme chaînes exactes, puis normalisées avec `decimal.js` ; les montants JSON utilisent deux décimales et la valeur brute reste stockée. Les espaces retirés d'une cellule texte sont signalés par la normalisation `WHITESPACE_TRIMMED`. Chaque ligne garde son numéro réel, même en présence de lignes vides, sa méthode `TABULAR`, sa version de parseur et le motif de chaque champ absent ou invalide. Une feuille valide reste `DONE` même si une ligne est partielle. Une archive XLSX illisible ou une structure différente devient `NON_TRAITE` avec un motif.

Le XLSX reste une source physique distincte. À la fermeture du lot, son identifiant de ligne sert uniquement à trouver une pièce individuelle candidate. La liaison est confirmée si le numéro, le fournisseur, la date et les montants concordent ; les montants sont comparés avec `decimal.js`. Un champ essentiel absent, une valeur différente ou plusieurs fichiers portant le même identifiant impose une revue. Les deux représentations restent consultables et ne créent qu'une pièce métier candidate, ce qui empêche leur double comptage silencieux.

## Fermeture et consolidation d'un lot

Le bouton « Fermer et consolider le lot » devient utilisable quand les dépôts sont terminés. L'API refuse la fermeture tant qu'une source est `RECEIVED` ou `PROCESSING`. Une fermeture réussie bloque les nouveaux fichiers et relevés, crée des pièces avec montants PostgreSQL `numeric`, affiche les sources associées et sépare les pièces prêtes de celles à revoir. Répéter la fermeture ne recrée aucune pièce.

## Relevés bancaires CSV

L’application accepte l’en-tête fourni `date,libelle,debit_mad,credit_mad,solde_mad`. L’import est atomique et un même contenu ne peut être ajouté deux fois dans un lot. Le contenu CSV original et son empreinte SHA-256 sont conservés. Les montants sont normalisés avec `decimal.js`, stockés en `numeric(18,2)` et échangés comme chaînes ; leurs valeurs CSV brutes restent conservées. Le solde de chaque ligne est contrôlé par rapport à la ligne précédente, sans inventer de solde initial.

La classification sépare les candidats d'achats, les salaires, les frais bancaires, les règlements clients et les opérations à qualifier. Les exclusions et les lignes `OTHER` restent visibles dans le résultat.

## Rapprochement bancaire EX-03

Après fermeture du lot, le bouton « Lancer le rapprochement » place le travail dans BullMQ ; le worker exécute le moteur déterministe `reconciliation-v1` et l'interface suit son état sans bloquer la requête HTTP. Le code utilise `decimal.js` et les montants restent des chaînes décimales dans l'API. Il rapproche uniquement les factures `READY` avec des débits candidats, à partir du fournisseur observé, de la référence éventuelle, d'une fenêtre de 60 jours et du résiduel disponible. Il accepte un paiement partiel ou une combinaison exacte unique de trois pièces au maximum. La recherche combinatoire est limitée à 20 pièces candidates ; au-delà, la ligne passe en revue humaine.

Un montant identique ne suffit pas pour associer une pièce. Plusieurs fournisseurs, références ou regroupements possibles produisent `REVIEW_REQUIRED` sans allocation. Les pièces déjà en revue et les avoirs restent hors calcul automatique tant qu'une règle de rattachement n'est pas validée. Le taux affiché donne explicitement les lignes entièrement rapprochées sur les lignes de paiement éligibles ; les exclusions et opérations à qualifier ne sont pas cachées dans le dénominateur.

Chaque exécution réussie conserve la version du moteur, ses entrées complètes, sa sortie, les décisions par ligne, les résiduels et les allocations dans une seule transaction PostgreSQL. Les travaux interrompus sont repris au démarrage du worker et une erreur technique dispose de trois tentatives. Répéter ou lancer simultanément la même version sur un lot renvoie le même calcul sans doubler les allocations. Le calcul ne fait aucun appel LLM et ne déclare aucune exécution d'outil sans preuve persistée.

L'identifiant de preuve est affiché dans l'interface. Cette commande rejoue le moteur pur sur les entrées enregistrées et compare la sortie sans écrire d'allocation, en remplaçant `<preuve>` par cet identifiant :

```sh
docker compose exec -T api node dist/server/replay-reconciliation.js <preuve>
```

Le résultat contient `"verified":true` lorsque la sortie rejouée est identique à la preuve persistée.

## Contrôles comptables et fiscaux EX-04

Après consolidation, le bouton « Lancer les contrôles » crée un travail BullMQ. Le worker exécute le moteur pur `audit-v2` avec les référentiels versionnés de `reference-data/v1`. L'API reste disponible pendant le traitement. Une demande répétée ou simultanée réutilise le même travail et la même preuve ; un travail technique en échec peut être relancé sans dupliquer les résultats. Le rejeu conserve la compatibilité avec les preuves `audit-v1`.

Les contrôles distinguent la cohérence interne HT, taux imprimé, TVA et TTC de la conformité au taux fournisseur fourni. Ils couvrent aussi les mentions obligatoires, la période du 1er janvier au 30 juin 2026, les fournisseurs inconnus, le plan comptable, les montants strictement supérieurs à dix fois la moyenne fournisseur, les doublons exacts ou probables et les conflits de sources. Les valeurs observées restent séparées des valeurs de référence. Un taux ou un montant absent rend uniquement le contrôle concerné non évaluable ; aucune valeur n'est complétée.

Les écarts monétaires conservent leur signe et leur valeur absolue. L'interface affiche la pièce et ses sources, le référentiel appliqué, les versions du moteur et des règles, la convention d'arrondi et l'identifiant de preuve. Elle ne produit pas de total financier global par addition des anomalies d'une même pièce. L'application des avoirs à leur facture d'origine, la décision humaine et les explications agentiques restent des étapes ultérieures.

Cette commande rejoue une preuve d'audit sans modifier les résultats :

```sh
docker compose exec -T api node dist/server/replay-audit.js <preuve>
```

Le résultat contient `"verified":true` lorsque les entrées, les référentiels disponibles et la sortie recalculée correspondent à la preuve persistée.

## Orchestration agentique

Après le rapprochement et l'audit, le bouton « Analyser les preuves » lance un travail BullMQ dans le worker. LangGraph exécute successivement les rôles Ingestor, Orchestrator, Reconciler, Auditor et Explainer. Le Reconciler et l'Auditor lisent les preuves PostgreSQL existantes sans recalculer ni modifier les allocations. GPT-5.5 intervient uniquement lorsque les faits comportent une ambiguïté, une anomalie ou une source illisible ; GPT-4.1 produit une explication structurée reliée à un identifiant de preuve. Les sorties sont validées, mises en cache et tracées avec le modèle, le motif de sélection, la durée et l'usage de jetons. Deux tentatives au maximum sont autorisées, sans bascule automatique d'un accès Azure vers l'autre.

Les clés restent uniquement dans l'environnement du worker. Une configuration absente produit un échec explicite de cette tâche sans empêcher le démarrage de l'application ni les moteurs déterministes. Les documents illisibles et les ambiguïtés apparaissent comme motifs de revue humaine. L'enregistrement d'une décision humaine reste une étape ultérieure.

Pour vérifier une fois chaque accès Azure avec une petite sortie structurée, après avoir configuré `.env` :

```sh
docker compose exec -T worker npm run test:llm
```

La commande affiche uniquement les modèles, la validation, l'utilisation éventuelle du cache et la durée. Elle n'affiche ni clé ni contenu comptable.

## Données et référentiels fournis

Les documents privés du handoff ne sont pas nécessaires au démarrage de la version actuelle et ne sont pas inclus dans le dépôt. Leur usage actuel et futur est explicite :

| Élément fourni | Consulté pendant le développement | Importé dans l'application | Utilisé à l'exécution | Intégration prévue |
|---|---|---|---|---|
| README du jeu de données | Oui, pour inventorier le corpus et ses scénarios | Non | Non | Guide de couverture et de recette du corpus |
| Pièces comptables | Oui, avec chargements manuels de pièces de recette | Non | Seulement lorsqu'un utilisateur les dépose | Tests de régression d'ingestion sur le corpus |
| Relevés bancaires | Oui, format et scénarios contrôlés | Uniquement lorsqu'un utilisateur dépose un CSV | Oui, import versionné, montants exacts, classification, contrôle du solde et rapprochement EX-03 | Enrichissement des scénarios du corpus |
| `plan-comptable.csv` | Oui | Oui, dans `reference-data/v1` | Oui, validation des comptes dans EX-04 | Élargissement selon les besoins du corpus |
| `referentiel-fournisseurs.csv` | Oui | Oui, dans `reference-data/v1` | Oui, identification exacte, taux, compte et moyenne dans EX-04 | Propositions soumises à revue humaine |
| `regles-fiscales.md` | Oui | Oui, dans `reference-data/v1` | Oui, version et empreinte vérifiées ; règles EX-04 exécutées par le moteur déterministe | Avoirs et décisions humaines |

Les tests OCR utilisent des fixtures synthétiques suivies dans `tests/fixtures`, décrites dans leur README. Le code ne dépend ni de `DOC-001`, ni d'un nom de fichier du corpus. Les trois référentiels nécessaires à EX-04 sont inclus dans l'image serveur, validés au démarrage et identifiés par leur empreinte SHA-256. Les observations extraites restent séparées des informations de référence ; un référentiel ne complète jamais silencieusement une valeur absente sur la pièce.

## Tests avec Docker

Cette commande exécute uniquement les migrations et tests SQL dans une base isolée :

```sh
docker compose -f compose.test.yaml up --force-recreate --abort-on-container-exit --exit-code-from sql_tests sql_tests
```

Pour exécuter les tests du contrat, de l’API, du worker et les parcours OCR et bancaire à travers Nginx :

```sh
docker compose -f compose.test.yaml down -v
docker compose -f compose.test.yaml build
docker compose -f compose.test.yaml run --rm e2e_tests
```

La dernière commande exécute aussi les tests SQL, du contrat et du serveur dont elle dépend. Elle vérifie un lot synthétique de 50 documents, un PDF texte, un PDF scanné français, des JPG français, anglais, ambigu et illisible, un XLSX d'achats, la consolidation sans double comptage, une erreur technique OCR après trois tentatives, ainsi que la reprise idempotente. Le scénario arabe est conservé mais reporté. Les tests EX-03 couvrent le regroupement de trois factures, un acompte et son solde, la limite de 60 jours, les associations ambiguës, les exclusions, les avoirs hors calcul, la borne de recherche et deux lancements concurrents. Les tests EX-04 chargent les référentiels réellement livrés et couvrent les écarts fiscaux positifs et négatifs, la cohérence interne, les bornes de période, les fournisseurs et montants inconnus, le seuil aberrant, les comptes et les doublons sans fusion. Le test final charge un JPG français, un XLSX et un relevé CSV par le Nginx du service web, ferme le lot, lance le rapprochement et l'audit, puis vérifie l'API, le worker, les preuves et le stockage PostgreSQL. Ces tests utilisent leurs propres services et volume. Pour les retirer :

```sh
docker compose -f compose.test.yaml down -v
```

Le rapprochement EX-03, les contrôles comptables et fiscaux EX-04 et la première orchestration LangGraph sont disponibles. L'application des avoirs et la décision de revue humaine seront ajoutées dans les étapes fonctionnelles suivantes.
