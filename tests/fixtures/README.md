# Fixtures OCR synthétiques

Ces images sont générées pour les tests automatisés. Elles ne font pas partie du corpus officiel fourni avec le sujet et ne représentent aucune entreprise réelle.

| Fichier | Cas vérifié | Valeurs attendues principales |
|---|---|---|
| `ocr-invoice.jpg` | Facture française lisible | FA-2026-0001, HT 7800.00, TVA 1560.00, TTC 9360.00 |
| `ocr-ambiguous.jpg` | Deux HT différents | HT ambigu, TTC 9000.00 |
| `ocr-arabic.jpg` | Libellés arabes et valeurs occidentales sur lignes séparées | AR-2026-0001, date 2026-01-03, HT 7800.00, TVA 1560.00, TTC 9360.00 |
| `ocr-mixed.jpg` | Libellés français, nom et mention arabes, valeurs occidentales | MX-2026-0001, date 2026-01-04, HT 7800.00, TVA 1560.00, TTC 9360.00 |
| `ocr-blank.jpg` | Image sans texte exploitable | `NON_TRAITE` |

Les assertions comparent le texte OCR réellement produit et les champs extraits. Le parseur ne contient aucune condition liée à ces noms de fichiers. Les chiffres arabo-indiens sont vérifiés séparément par les tests du parseur afin de distinguer leur normalisation déterministe de la qualité de reconnaissance du moteur OCR.
