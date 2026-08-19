---
layout: home

hero:
  name: Pingo
  text: moteur de rendu canvas
  tagline: Cœur Rust/WASM + couche TypeScript + backend interchangeable. Conçu pour l'interaction haute performance, le défilement virtuel natif et l'édition de texte dans le canvas.
  actions:
    - theme: brand
      text: Démarrage
      link: /fr/guide/getting-started
    - theme: alt
      text: Playground
      link: /fr/playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/pingo

features:
  - title: Deux horloges — le thread principal se fige, l'image ne saute pas
    details: L'horloge de l'interface et celle du rendu sont indépendantes. Le défilement, les animations, la mise en page et la composition se poursuivent dans le Worker, si bien que l'affichage reste continu même quand le thread principal est bloqué 200 ms.
  - title: Défilement virtuel natif
    details: L'arbre de sommes préfixées, la préchauffe avec prédiction de direction et le remplissage par substituts vivent dans le Core. Rejouer 20 000 images d'un fixture d'un million de lignes donne des P95/P99 sous la microseconde, et le défilement n'appelle jamais la couche TypeScript.
  - title: Édition native dans le canvas
    details: Curseur, sélection, sélection par glissement, double-clic pour sélectionner un mot, composition IME, position de la fenêtre de candidats, presse-papiers et annuler/rétablir sont implémentés par le moteur. Votre application ne crée plus de contrôles HTML pour saisir du texte.
  - title: L'accessibilité fait partie de l'architecture
    details: Le Core exporte un arbre sémantique que l'hôte reflète en arbre DOM fantôme à côté du canvas. Les lecteurs d'écran fonctionnent et les tests E2E ciblent par rôle et libellé plutôt que de comparer des pixels.
  - title: Déterminisme et tests différentiels
    details: Flux binaires versionnés, horloge et source d'aléa injectables, enregistrement et rejeu, ainsi que des oracles différentiels entre incrémental et complet, optimisé et naïf, wasm et natif.
  - title: Repli automatique, toujours une issue
    details: SharedArrayBuffer → postMessage → Canvas2D sur le thread principal sont choisis automatiquement selon les capacités, à fonctionnalités équivalentes. La couche de migration permet un déploiement page par page et un retour arrière immédiat.
---

## Démarrer en 30 secondes

```sh
pnpm add @dopejs/doper
```

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `Ligne ${index}` }),
  }),
);
```

Le million de lignes n'est jamais matérialisé côté TypeScript et le défilement ne rappelle pas
l'arbre de composants : le calcul de la fenêtre et le remplissage se font dans le Core.

## Ce qu'il ne fait pas

doper est un moteur de rendu, pas un navigateur. Il **ne traite pas** le SSR ni le premier rendu
HTML, la compatibilité CSS générale (modèle de boîte, cascade, sélecteurs), les couches d'adaptation
mini-applications ou natif, ni la sémantique de texte riche métier (collaboration, formules,
commandes Markdown).

En revanche le moteur **possède bel et bien** le curseur, la sélection, l'IME, le presse-papiers,
l'annulation/rétablissement et les primitives de texte éditable. Rien de tout cela n'est renvoyé à
l'application pour être bricolé avec des contrôles DOM.

## État actuel

v0.1.0. Tous les jalons d'ingénierie P0–M5 sont terminés et la chaîne automatique `pnpm m5:check`
passe intégralement.

Les performances sur appareils réels, les IME réels et la matrice de lecteurs d'écran relèvent de la
qualification de plateforme et sont suivis séparément. La navigation visuelle bidi et l'activation
par défaut du backend WebGPU sont des [reports documentés](/plan).

::: tip Langue des documents d'ingénierie
La conception technique, le plan de mise en œuvre et les ADR n'existent aujourd'hui qu'en chinois
simplifié ; toutes les langues pointent vers le même document.
:::
