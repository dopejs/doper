# Accessibilité et testabilité

## Dans l'architecture dès le premier jour

Le contenu d'un canvas est par nature invisible pour un lecteur d'écran. doper ne traite pas
l'accessibilité comme une couche ajoutée après la mise en production : le Core maintient un arbre
sémantique (role / label / value / bounds / focusable) et `@dopejs/doper-a11y` le projette de façon
incrémentale en un arbre DOM fantôme, positionné en absolu à côté du canvas.

Les éléments fantômes sont visuellement transparents mais présents dans l'arbre d'accessibilité et dans
l'ordre de tabulation ; les focaliser transmet le focus à la session d'édition du moteur, si bien qu'une
personne au clavier peut réellement manipuler les champs à l'intérieur du canvas.

## Déclarer la sémantique

```tsx
<container semanticRole="region" semanticLabel="Panneau de paiement">
  <text value="Paiement" semanticRole="heading" semanticLabel="Paiement" />
  {TextField({ semanticLabel: "Destinataire", value, revision })}
</container>
```

`editableText` possède par défaut la sémantique textbox. La valeur d'un champ mot de passe **n'entre
jamais** dans l'arbre sémantique.

## Des tests E2E fondés sur la sémantique

Comme l'arbre sémantique est reflété en DOM réel, les tests E2E peuvent cibler par rôle et par nom plutôt
que comparer des pixels :

```ts
import { getByRole, queryAllByRole } from "@dopejs/doper";

const email = getByRole(document.body, "textbox", { name: "Destinataire" });
email.focus(); // transmis à la session d'édition du moteur
expect(queryAllByRole(document.body, "textbox")).toHaveLength(2);
```

Les captures de pixels restent en place, mais comme **preuve complémentaire** de la justesse du rendu,
pas comme unique assertion. Ce choix évite que les tests d'interface tombent en masse dès que le rendu des
polices ou l'anticrénelage change.

## Observer l'arbre sémantique

```ts
const root = await createHostedCanvasRoot(canvas, {
  onSemantics: (nodes) => inspect(nodes),
  accessibility: true, // activé par défaut ; false désactive l'arbre fantôme
});
```

Chaque nœud fournit `nodeId`, `role`, `label`, `value`, les `bounds` en coordonnées monde, `focusable`,
`focused` et l'indicateur `password`. Dans le diagnostic d'image, `dirtySemanticsNodes` permet d'observer
la fréquence d'invalidation sémantique.

## Qualification de plateforme

L'automatisation couvre l'export de l'arbre sémantique, la projection vers l'arbre fantôme, les sélecteurs
par rôle et libellé, ainsi que le contrat clavier.
**La matrice de comportement des lecteurs d'écran réels (VoiceOver, NVDA, TalkBack) relève de la
qualification de plateforme**, suivie séparément et non comptée comme condition de sortie d'ingénierie.
Cette limite évite de faire passer des conclusions d'appareil non vérifiées pour une promesse de support.

La [démo de sémantique du Playground](/fr/playground#/semantics) permet de lire directement l'arbre
sémantique courant.
