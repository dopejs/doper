# Texte et édition

## L'édition est une capacité du moteur, pas un assemblage applicatif

Le défaut classique des solutions à base de canvas consiste à poser un `input` HTML au-dessus du canvas
dès qu'il faut saisir du texte. S'ensuit une cascade de problèmes : curseur décalé, fenêtre de candidats
IME mal placée, défilement désynchronisé, accessibilité rompue.

pingo traite l'édition comme une capacité de premier ordre du Core : curseur, sélection, sélection par
glissement, double-clic pour sélectionner un mot, navigation clavier, composition IME, position de la
fenêtre de candidats, presse-papiers, annuler/rétablir, lecture seule et mot de passe sont implémentés
par le moteur.
**L'application ne crée, ne positionne et ne synchronise aucun contrôle de saisie HTML.**

## Utiliser les widgets

```ts
import { TextField, TextArea } from "@dopejs/pingo";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "Note de commande",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## Utiliser la primitive

```ts
createElement("editableText", {
  value,
  revision,
  multiline: false,
  readOnly: false,
  password: false,
  maxGraphemes: 200,
  inputMode: "email",
  onTransaction: (transaction) => apply(transaction),
  onSubmit: () => moveToNextCell(),
});
```

Ou avec un contrôleur local :

```ts
import { useTextEditingController } from "@dopejs/pingo";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## Pont de saisie et repli

Le thread principal se connecte au service de saisie du système d'exploitation par ordre de préférence :

1. **EditContext** — associé au canvas, il reçoit texte, sélection et composition, et fournit à l'IME
   control, selection et character bounds.
2. **Proxy de saisie géré par le moteur** — si EditContext n'est pas disponible, l'hôte maintient
   **un seul** `textarea` masqué global qui traite `beforeinput`, la composition, le clavier virtuel et
   le presse-papiers.

Le second point est une implémentation de repli propre à la plateforme, pas un modèle de composants
EmbedDOM : il n'existe pas dans le Scene de DOM correspondant un à un à chaque nœud éditable. Les deux
chemins passent la même série de tests de contrat comportemental.

## Transactions d'édition versionnées

La propriété de l'état est explicite : **la couche TypeScript possède les données métier, le Core possède
l'état transitoire de la session d'édition active.**

```
saisie → le Core vérifie base_revision → applique et repeint aussitôt → émet en retour une EditTransaction versionnée
                                                                                    ↓
                                     l'application confirme, ou renvoie une valeur corrigée avec une nouvelle révision
```

Une transaction périmée n'écrase jamais un état plus récent. Autrement dit, chaque frappe n'impose pas un
build TSX complet, tout en préservant les données contrôlées et la validation métier.

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## Modèle de positions de texte

Les API de saisie du web utilisent des décalages UTF-16, les chaînes Rust sont en UTF-8, et les frontières
de graphèmes, de clusters de shaping et de glyphes visuels diffèrent encore. Le moteur maintient une
correspondance explicite :

```
décalage UTF-16 ↔ scalaire Unicode ↔ graphème ↔ cluster de shaping ↔ glyphe / ligne
```

À la frontière du protocole, l'UTF-16 est utilisé uniformément pour s'aligner sur EditContext et
InputEvent. **La suppression, le déplacement et la sélection ne coupent jamais un graphème, une séquence
combinante, un emoji ZWJ ni un cluster de shaping** — c'est garanti par des tests de propriétés et par une
matrice de fixtures de composition (caractères combinants, emoji ZWJ, RTL, candidats CJK en plusieurs segments).

## Mots de passe et confidentialité

Le texte d'un mot de passe n'entre ni dans l'enregistrement et le rejeu, ni dans les journaux, ni en clair
dans les devtools, ni dans les valeurs d'accessibilité ; une cible de type mot de passe n'écrit pas non plus
dans le presse-papiers. Le Core n'émet que des glyphes masqués, si bien que le texte en clair n'atteint même
pas le DisplayList. Des tests automatiques l'affirment, et vous pouvez aussi inspecter le DOM vous-même dans
le [Playground publié](/fr/playground#/editing).

## Limites connues

- La **navigation visuelle bidi** sera livrée avec la prise en charge du texte bidi ; c'est aujourd'hui un
  report explicite.
- Le schéma de texte riche, la résolution de conflits collaborative, les formules et les commandes Markdown
  relèvent des couches supérieures, mais peuvent se construire sur ces mêmes transactions d'édition et sur
  l'API de sélection.
