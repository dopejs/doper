# Événements et hit testing

## Séparer la collecte du hit testing

Le thread principal écoute pointer/wheel/touch avec `{ passive: true }`. Les événements liés au
défilement **se contentent d'écrire le delta et l'horodatage dans un canal partagé : ni hit testing, ni
setState**.

Le hit testing a lieu dans le Core : un BVH sur des AABB en coordonnées monde, maintenu de façon
incrémentale avec le Scene (reconstruit si la topologie change, simplement ajusté si seule la géométrie
change). Après impact, le chemin root→target est construit et renvoyé à la couche TypeScript par le flux
inverse.

Des tests de propriétés garantissent que le BVH et une implémentation linéaire naïve donnent le même
résultat : le chemin optimisé dispose toujours d'un oracle comparable.

## Propagation en trois phases

Le modèle d'événements s'aligne sur le DOM : capture → cible → bouillonnement.

```tsx
<container onClickCapture={(event) => log("outer capture", event.eventPhase)}>
  <container
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
    }}
  />
</container>
```

Gestionnaires disponibles : `onPointerDown`, `onPointerUp`, `onPointerMove`, `onPointerCancel`,
`onClick`, `onWheel`, chacun avec sa version `*Capture`.

`DoperEvent` expose `target`, `currentTarget`, `eventPhase`, les coordonnées logiques locales au canvas
`x`/`y`, `deltaX`/`deltaY`, `buttons`, les touches de modification, `preventDefault()`,
`stopPropagation()` et `stopImmediatePropagation()`.

## Le problème de temporisation de preventDefault

Un écouteur passif ne peut pas appeler `preventDefault()`. C'est un point de correction à traiter
explicitement, pas un détail que l'on peut contourner.

La solution : les zones qui doivent empêcher le comportement par défaut (par exemple une zone défilante
interne) sont **calculées à l'avance par le Core**, qui synchronise vers le thread principal des
« rectangles de zone non passive ». Le thread principal bascule ces zones sur des écouteurs non passifs et
appelle `preventDefault()` de façon **synchrone** quand l'événement y tombe. Il n'existe donc aucune
situation de concurrence dépendant d'une réponse asynchrone.

## Frontières de la sémantique d'impact

La sémantique actuelle est volontairement restreinte, afin d'éviter les comportements implicites :

- En cas d'**impacts superposés**, la cible est « le dernier dessiné ». Il n'y a pour l'instant ni
  z-order, ni désactivation de l'impact via `pointer-events`, ni saut des nœuds invisibles. Introduire
  l'un de ces éléments demanderait une décision de conception explicite.
- **Impact sur l'instantané de l'image** : tous les événements d'un même lot sont résolus contre la
  géométrie de la dernière image validée. Un défilement à l'intérieur du lot qui modifie la géométrie
  n'affecte l'impact qu'à l'image suivante — cela garantit la sémantique de rollback atomique du lot et
  le rejeu déterministe.
- La saisie clavier passe par le [protocole d'entrée d'édition](/fr/guide/editing) et ne se déguise pas en
  événement d'impact.

La [démo d'événements du Playground](/fr/playground#/events) affiche en direct le journal de propagation
en trois phases.
