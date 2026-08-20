# Défilement virtuel

## Pourquoi le faire dans le moteur

La latence de queue des listes virtuelles en DOM vient de l'enchaînement : l'événement de défilement
remonte au thread principal, déclenche un setState, un diff, puis un recalcul de mise en page. Dès que le
thread principal est occupé, des images sautent.

pingo place le calcul de la fenêtre dans le Core : en régime établi, le défilement **n'appelle jamais la
couche TypeScript**. Celle-ci se contente de matérialiser la plage visible selon la fenêtre de préchauffe
planifiée par le Core ; si les données ne sont pas prêtes, on dessine un substitut et on complète lors
d'images ultérieures.

## Utilisation

```ts
createElement("virtualList", {
  width: 480,
  height: 640,
  itemCount: 1_000_000,
  estimatedItemHeight: 32,
  renderItem: (index: number) =>
    createElement("container", {
      width: 480,
      height: 32,
      children: createElement("text", { value: `Ligne ${index}` }),
    }),
});
```

`estimatedItemHeight` n'est qu'une estimation initiale. Une fois la hauteur réelle mesurée, le Core
corrige la position de l'ancre via un arbre de sommes préfixées (Fenwick) et la barre de défilement ne
saute pas.

## Paramètres ajustables

| prop                     | Effet                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| `baseOverscanViewports`  | Plage de préchauffe symétrique (en multiples de viewport)            |
| `velocityHorizonSeconds` | Horizon de projection de la vitesse, pour la prédiction de direction |
| `maximumAheadViewports`  | Plafond de préchauffe dans une seule direction                       |
| `scrollX` / `scrollY`    | Position programmatique (n'émet ScrollTo qu'en cas de changement)    |

La prédiction de direction préchauffe en priorité le sens du mouvement lors d'un lancer rapide, au lieu
de gaspiller le budget symétriquement des deux côtés.

## Défilement programmatique

```ts
// Un changement de prop émet une seule mutation ScrollTo
root.render(createElement("virtualList", { scrollY: 500_000 * 32 /* ... */ }));
```

Ou l'API de manipulation directe du root, prévue pour des gestes personnalisés :

```ts
root.beginScroll(handle);
root.scrollBy(handle, 0, deltaY, elapsedMs);
root.endScroll(handle); // le Core estime la vitesse du lancer
```

`handle` provient du callback `ref` de l'élément (`NodeHandle`).

## Molette et pavé tactile

La **distance** parcourue à la molette correspond à celle du navigateur, mais la courbe de transfert
dépend de la source : les deltas haute précision (pavé tactile) sont appliqués 1:1 immédiatement et
l'inertie continue d'être fournie par le flux d'événements du système ; les crans discrets de molette
s'accumulent vers une cible animée que l'on rejoint par une courbe exponentielle, strictement bornée aux
limites du contenu et sans dépassement, exactement comme dans un navigateur.

## Imbrication et édition

Quand un glissement de pointeur commence sur du texte éditable, la sélection de texte prime sur le
glissement de défilement ; la molette continue de faire défiler l'ancêtre défilant le plus proche. Cette
priorité est décidée par la profondeur du chemin de hit testing et ne demande aucune intervention de
l'application.

## Critère de performance

Le benchmark automatique sur fixture fixe (un million de lignes, 20 000 images) fait partie de la porte de
fusion. Les P95/P99 de rejeu sont aujourd'hui sous la microseconde et trente minutes de défilement continu
ne montrent pas de croissance mémoire incontrôlée.

Les P95/P99 sur appareils réels et la latence d'entrée relèvent de la qualification de plateforme et ne
constituent pas une condition de sortie d'ingénierie. Cette limite est délibérée : elle évite de bloquer le
travail avec des données d'appareil non reproductibles, et évite tout autant de faire passer des chiffres
d'ingénierie pour une promesse sur les appareils.

La [démo de défilement du Playground](/fr/playground#/scroll) affiche les métriques d'image en direct.
