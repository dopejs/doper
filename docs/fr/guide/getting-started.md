# Démarrage

## Installation

```sh
pnpm add @dopejs/doper
```

Votre application ne dépend que d'un paquet : `@dopejs/doper`. `@dopejs/doper-host`,
`@dopejs/doper-jsx` et les autres sont des paquets d'implémentation interne, hors contrat public ;
le [scanner de migration](/migration) refuse leur import direct.

## Monter un premier canvas

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
canvas.width = 800;
canvas.height = 600;

const root = await createHostedCanvasRoot(canvas);

root.render(
  createElement("container", {
    width: 800,
    height: 600,
    backgroundColor: "#ffffffff",
    padding: 24,
    children: createElement("text", {
      value: "Hello doper",
      fontSize: 24,
      lineHeight: 32,
      color: "#1f2329ff",
    }),
  }),
);
```

`createHostedCanvasRoot` détecte les capacités du navigateur et choisit le transport entre
SharedArrayBuffer, postMessage et Canvas2D sur le thread principal ; vous n'écrivez aucune branche
pour le repli. `root.mode` renvoie le chemin réellement retenu.

## Utiliser TSX

Configurez `tsconfig.json` :

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

Vous pouvez ensuite écrire :

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`Commande n° ${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## Éléments hôtes

Le moteur ne propose que cinq éléments intégrés, qui correspondent directement à des nœuds du Scene.
Il n'y a ni cascade CSS ni sélecteurs.

| Élément        | Rôle                                                                         |
| -------------- | ---------------------------------------------------------------------------- |
| `container`    | Regroupement générique, fond, marge intérieure, transformations              |
| `text`         | Suite de texte (shaping, retours à la ligne et géométrie du curseur du Core) |
| `scroll`       | Conteneur défilant possédé par le Core                                       |
| `virtualList`  | Liste virtuelle dont le Core planifie la fenêtre                             |
| `editableText` | Primitive de texte éditable                                                  |

`TextField` et `TextArea` sont des widgets composés au-dessus de `editableText` (bordure, état
d'erreur) et n'introduisent aucun nouveau chemin de saisie.

## État et effets

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `${count} s écoulées` });
}
```

Primitives réactives disponibles : `signal`, `computed`, `effect`, `batch`, `untracked`, ainsi que les
hooks `useState`, `useSignal`, `useMemo`, `useCallback`, `useRef`, `useEffect`.

::: warning Pas de lecture synchrone de la mise en page
La lecture synchrone de la mise en page du Worker, à la manière de `useLayoutEffect`, n'est pas prise
en charge : la mise en page se déroule sur une autre horloge. Quand vous avez besoin de son résultat,
utilisez le contrat asynchrone et n'essayez pas de lire la géométrie de façon synchrone pendant le rendu.
:::

## Observer le comportement d'exécution

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` fournit à chaque image le nombre de commandes, la taille du DisplayList en octets ainsi que,
côté Core, les compteurs de nœuds sales, la charge de mise en page et le hash de la picture. C'est la
source de première main pour analyser les performances. Plus de détails dans le [diagnostic](/diagnostics).

## Étapes suivantes

- [Architecture](/fr/guide/architecture) : comment la couche TypeScript et le Core se répartissent le travail
- [Défilement virtuel](/fr/guide/scrolling), [texte et édition](/fr/guide/editing)
- [Playground](/fr/playground) : démonstrations interactives en direct
