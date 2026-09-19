# Chiffra

Chiffra traite progressivement des lots de factures et de relevés bancaires : extraction des données comptables, import CSV bancaire, rapprochement des paiements, contrôles fiscaux, anomalies sourcées et revue humaine.

Le projet est en construction. On peut créer un lot, déposer un PDF ou une image JPG, suivre son traitement par le worker, consulter les champs lus automatiquement et importer un relevé bancaire CSV. Le texte natif des PDF reste prioritaire ; Tesseract traite les pages scannées et les JPG sur CPU en français, arabe et anglais. Chaque champ conserve sa valeur brute, sa valeur normalisée, sa page, la méthode et la version d'extraction. Un champ absent reste vide avec un motif. Un champ ambigu reste vide, conserve tous ses candidats et exige explicitement une revue humaine. Ces observations ne sont pas encore des factures validées ni des calculs comptables.

EX-01 et EX-02 restent partielles : les PDF texte, les PDF scannés, les JPG et les relevés bancaires CSV au format fourni sont couverts. Les PDF/JPG sont limités à 15 Mo et 30 pages par PDF ; un relevé CSV est limité à 2 Mo et 5 000 lignes. Les XLSX, lots fermés de 50 pièces et contrôles sur le corpus complet restent à réaliser. Les calculs futurs devront rester déterministes et sourcés conformément à EX-07. Une pièce sans texte exploitable après OCR reste explicitement `NON_TRAITE`, conformément à EX-08.

## Démarrage local

Copier `.env.example` vers `.env`, puis renseigner `POSTGRES_PASSWORD`. Les clés Azure peuvent rester vides pour les fonctionnalités disponibles. Depuis la racine du clone :

```sh
docker compose up -d --build
```

L’interface est disponible sur `http://localhost:8081`, ou sur le port défini par `WEB_PORT`. Le Compose principal applique les migrations avant l’API et démarre PostgreSQL, Redis, l’API, le worker et le service web avec Nginx. Les tests restent facultatifs et séparés.

## Contrat livré

`packages/contracts/src/index.ts` sépare contrôle du traitement, observations sourcées, références, résultats calculés et revue. Les montants et taux sont des chaînes décimales ; une observation inconnue vaut `null` et porte un motif. Une valeur lue conserve aussi sa forme brute, les normalisations appliquées, la méthode et la version de son extraction. Les objets refusent les champs supplémentaires. Les gardes `accept*` imposent l’ordre des transitions et limitent chaque rôle à sa partie de l’état. Elles ne prouvent pas encore l’appel effectif d’un outil financier.

Node 24 LTS remplace Node 20 recommandé par le cahier, car Node 20 est arrivé en fin de support. TypeScript utilise `strict: true`.

## Stockage

Le Compose définit PostgreSQL 16, Redis 7, l’API, le worker et l’interface sur un réseau propre à Chiffra. L’API et le worker utilisent la même image avec des processus distincts. Seule l’interface est publiée sur `127.0.0.1` ; PostgreSQL et Redis ne publient aucun port. Les volumes conservent la base, Redis et les sources entre redémarrages.

Au démarrage, une base neuve reçoit la migration 1, puis le service ponctuel `migrate` applique les migrations 2 à 6. Sur un volume existant, il applique seulement les migrations manquantes. Les tables séparent les sources physiques, extractions versionnées, segments avec page, observations et provenance des observations. Une source n’est pas encore une facture métier.

La confiance reste `NULL`, car le parcours actuel ne collecte pas une mesure suffisamment fiable pour la publier. Le motif d’un état terminal est conservé. Au premier démarrage de cette version, le worker reprend les traitements interrompus et recalcule les observations créées par une ancienne version du parseur.

## PDF et JPG

L’image serveur embarque les modèles officiels `tessdata_best` français, arabe et anglais, figés à la révision `e12c65a915945e4c28e237a9b52bc4a8f39a0cec`, avec leur licence Apache 2.0. Le téléchargement se fait à la construction Docker ; aucun modèle n’est téléchargé au traitement. Le moteur LSTM (`--oem 1`) utilise la segmentation `--psm 6`. Ces modèles privilégient la précision avec un coût CPU supérieur ; chaque processus Tesseract est limité à un thread. Leur précision sur les fixtures arabes et mixtes doit être confirmée par les tests Docker, sans déduire une validation du seul choix de modèle.

Au démarrage, les observations utilisant un ancien modèle OCR sont recalculées. Les extractions précédentes restent conservées et les observations référencent la nouvelle extraction ; une nouvelle reprise avec la même version ne crée pas de doublon.

Dans un lot ouvert, l’interface accepte un PDF ou un JPG de 15 Mo maximum. L’API vérifie le format réel et dédoublonne le contenu dans le lot. Les JPEG sont limités à 40 millions de pixels et 20 000 pixels par côté. Le worker lit d’abord le texte PDF avec Poppler puis applique Tesseract 5 en français, arabe et anglais uniquement aux pages sans texte et aux JPG. Le rendu d’une page PDF est limité à 3 500 pixels par côté. L'interface utilise la direction automatique et Unicode bidi pour rendre lisibles le texte arabe et les contenus mixtes.

Le worker traite au plus deux sources en parallèle par défaut, avec une valeur configurable de 1 à 4. Chaque commande OCR dispose de 60 secondes et le rendu d’une page de 45 secondes. Une erreur technique est retentée trois fois avec attente progressive ; une sortie sans texte exploitable devient `NON_TRAITE`. Une extraction lisible reste `DONE` même si ses champs sont absents, ambigus ou arithmétiquement incohérents. Le parseur relève seulement les valeurs imprimées et ne calcule aucun total attendu ni conformité fiscale.

Les chiffres occidentaux, arabo-indiens et persans ainsi que les séparateurs décimaux et de milliers pris en charge sont normalisés en chaînes décimales. Les composantes de date reconnues sur un chiffre sont complétées par un zéro avec une transformation explicite. La valeur OCR brute et la liste des transformations restent stockées. La reconnaissance des glyphes arabo-indiens dépend de la qualité de l'image et du moteur : une séquence mal reconnue reste absente ou observée telle quelle, sans reconstruction supposée. La reconnaissance d'un texte arabe ne garantit pas l'extraction complète des champs métier : le statut des observations et les candidats permettent de conserver les absences et ambiguïtés.

Le parseur `labels-v4` reconnaît les libellés comptables couverts en français, anglais et arabe. Il distingue le montant TVA du taux, y compris lorsque le texte OCR place le taux après le montant (`1560.00 20%`). Les marques Unicode de direction sont ignorées pour reconnaître les libellés ; le texte source reste conservé. Un libellé absent n'est pas reconstitué. L’OCR arabe reste partiel sur la fixture actuelle : le numéro et la TVA ne sont pas attribués lorsque leurs libellés sont mal reconnus ou absents. Les tests unitaires du parseur ne remplacent pas les tests Docker avec Tesseract réel.

## Relevés bancaires CSV

L’application accepte l’en-tête fourni `date,libelle,debit_mad,credit_mad,solde_mad`. L’import est atomique et un même contenu ne peut être ajouté deux fois dans un lot. Le contenu CSV original et son empreinte SHA-256 sont conservés. Les montants sont normalisés avec `decimal.js`, stockés en `numeric(18,2)` et échangés comme chaînes ; leurs valeurs CSV brutes restent conservées. Le solde de chaque ligne est contrôlé par rapport à la ligne précédente, sans inventer de solde initial.

La classification actuelle est une préparation explicite au rapprochement : salaires, frais bancaires et règlements clients identifiables sont exclus des candidats d’achats ; les virements débit restants sont seulement marqués comme candidats. Une ligne `OTHER` reste visible. Aucune allocation facture-paiement ni décision de rapprochement n’est créée dans cette tranche.

## Données et référentiels fournis

Les documents privés du handoff ne sont pas nécessaires au démarrage de la version actuelle et ne sont pas inclus dans le dépôt. Leur usage actuel et futur est explicite :

| Élément fourni | Consulté pendant le développement | Importé dans l'application | Utilisé à l'exécution | Intégration prévue |
|---|---|---|---|---|
| README du jeu de données | Oui, pour inventorier le corpus et ses scénarios | Non | Non | Guide de couverture et de recette du corpus |
| Pièces comptables | Oui, avec chargements manuels de pièces de recette | Non | Seulement lorsqu'un utilisateur les dépose | Tests de régression d'ingestion sur le corpus |
| Relevés bancaires | Oui, format et scénarios contrôlés | Uniquement lorsqu'un utilisateur dépose un CSV | Oui, import versionné, montants exacts, classification et contrôle du solde | Rapprochement avec les factures dans la tranche EX-03 suivante |
| `plan-comptable.csv` | Oui | Non | Non | Référentiel versionné pour les propositions comptables |
| `referentiel-fournisseurs.csv` | Oui | Non | Non | Référentiel versionné pour les contrôles et propositions fournisseur |
| `regles-fiscales.md` | Oui | Non | Non | Règles fiscales déterministes, identifiées et versionnées |

Les tests OCR utilisent des fixtures synthétiques suivies dans `tests/fixtures`, décrites dans leur README. Le code ne dépend ni de `DOC-001`, ni d'un nom de fichier du corpus. Lorsqu'un référentiel deviendra nécessaire à l'exécution, sa version exploitable et son chargement reproductible devront être ajoutés au dépôt. Les observations extraites resteront séparées des informations de référence ; un référentiel ne complétera jamais silencieusement une valeur absente sur la pièce.

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

La dernière commande exécute aussi les tests SQL, du contrat et du serveur dont elle dépend. Elle vérifie un PDF texte, des PDF scannés français et arabe, des JPG français, anglais, arabe, mixte, ambigu et illisible, une erreur technique OCR après trois tentatives, ainsi que la reprise idempotente. Les fixtures synthétiques anglaise et française passent par l’API et le worker. Les cas arabe et mixte vérifient explicitement leur résultat partiel actuel sans compléter les champs absents. Le test final charge un JPG français et un relevé CSV par le Nginx du service web, puis vérifie l’API, le worker, les valeurs brutes et normalisées, la classification bancaire et leur stockage PostgreSQL. Ces tests utilisent leurs propres services et volume. Pour les retirer :

```sh
docker compose -f compose.test.yaml down -v
```

L’import des relevés CSV prépare EX-03 sans créer encore d’allocation. Le rapprochement bancaire, les parcours XLSX, les contrôles comptables et fiscaux, l’agent, l’Explainer et la revue humaine seront ajoutés dans les étapes fonctionnelles suivantes.
