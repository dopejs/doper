---
title: Journal des modifications
---

# Changelog

La politique de versions figure dans `docs/release.md` : les 10 paquets sont publiés atomiquement dans
la même version, et le semver npm et la version de l'ABI binaire sont gérés séparément.

## Unreleased

- La courbe de transfert de la molette s'aligne sur le navigateur : les crans discrets défilent en
  animation, tandis que les deltas haute précision (pavé tactile) restent appliqués 1:1 immédiatement.
  `DispatchEvent` du flux d'entrée gagne un champ de drapeaux et la version de l'ABI passe de 1 à 2.
- Le site officiel est disponible en chinois simplifié, chinois traditionnel, espagnol, français,
  allemand, russe, hébreu, arabe, japonais et coréen.

## 0.1.0

Première version publiable. Tous les jalons d'ingénierie P0–M5 sont terminés et `pnpm m5:check`
(la chaîne automatique de M0 à M5) passe au vert.

- Core Rust/WASM déterministe + couche TypeScript : schéma à source unique, flux binaires versionnés
  Mutation/Input/DisplayList et flux inverse, rejet atomique des entrées malformées.
- Rendu à deux horloges : chaîne SAB → postMessage → Canvas2D sur le thread principal ; le Worker
  continue d'afficher même quand le thread principal est bloqué 200 ms.
- Défilement virtuel natif (rejeu P95/P99 sous la microseconde sur un million de lignes) et sous-système
  de texte (shaping explicite des polices, atlas de glyphes, repli sur les polices système).
- Édition native dans le canvas : double chemin EditContext/proxy de saisie, composition IME, navigation
  du curseur au pointeur et au clavier, presse-papiers, undo/redo, masquage des mots de passe et
  scroll-into-view du curseur.
- Hit testing (BVH incrémental et tests de propriétés face à un oracle naïf) et événements en trois phases
  capture/cible/bouillonnement, avec le protocole de `preventDefault` synchrone sur les zones non passives.
- Accessibilité : export de l'arbre sémantique, projection vers l'arbre DOM fantôme, sélecteurs E2E
  sémantiques `getByRole` et transmission du focus clavier.
- Migration et industrialisation : `@dopejs/doper-compat` pour le déploiement et le retour arrière page par
  page, scanner de migration, vérification d'intégrité SHA-256 du paquet et du WASM, diagnostic et manuel
  d'exploitation.
- Prototype WebGPU isolé et comparaison sans écart face à l'oracle headless (ADR-0006 :
  Continue Experiment, désactivé par défaut).

Reports explicites : navigation visuelle bidi, placeholder des widgets, activation de WebGPU par défaut.
La qualification de plateforme (performances sur appareils réels, IME réels, lecteurs d'écran) est suivie
séparément et n'est pas promise par la version du paquet.
