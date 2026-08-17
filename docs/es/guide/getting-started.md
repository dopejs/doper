# Primeros pasos

## Instalación

```sh
pnpm add @dopejs/doper
```

Tu aplicación depende de un único paquete: `@dopejs/doper`. `@dopejs/doper-host`,
`@dopejs/doper-jsx` y los demás son paquetes internos y no forman parte del contrato público;
el [escáner de migración](/migration) rechaza importarlos directamente.

## Montar el primer canvas

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

`createHostedCanvasRoot` detecta las capacidades del navegador y elige el transporte entre
SharedArrayBuffer, postMessage y Canvas2D en el hilo principal; no necesitas escribir ramas para la
degradación. `root.mode` devuelve el camino realmente elegido.

## Usar TSX

Configura `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

Después puedes escribir:

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`Pedido n.º ${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## Elementos del host

El motor sólo tiene cinco elementos integrados, que corresponden directamente a nodos del Scene.
No hay cascada CSS ni selectores.

| Elemento       | Uso                                                                     |
| -------------- | ----------------------------------------------------------------------- |
| `container`    | Agrupación general, fondo, relleno interior, transformaciones           |
| `text`         | Serie de texto (shaping, saltos y geometría del cursor vienen del Core) |
| `scroll`       | Contenedor desplazable propiedad del Core                               |
| `virtualList`  | Lista virtual cuya ventana planifica el Core                            |
| `editableText` | Primitiva de texto editable                                             |

`TextField` y `TextArea` son widgets compuestos sobre `editableText` (borde, estado de error) y no
introducen ninguna ruta de entrada nueva.

## Estado y efectos

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `Han pasado ${count} s` });
}
```

Primitivas reactivas disponibles: `signal`, `computed`, `effect`, `batch`, `untracked`, y los hooks
`useState`, `useSignal`, `useMemo`, `useCallback`, `useRef`, `useEffect`.

::: warning No hay lectura síncrona del layout
No se admite la lectura síncrona del layout del Worker al estilo de `useLayoutEffect`: el layout
ocurre en otro reloj. Cuando necesites su resultado usa el contrato asíncrono y no intentes leer
geometría de forma síncrona durante el render.
:::

## Observar el comportamiento en ejecución

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` entrega en cada fotograma el número de comandos, los bytes del DisplayList y, del lado del
Core, los contadores de nodos sucios, el trabajo de layout y el hash de la picture. Es la primera
fuente de datos para investigar rendimiento. Más detalles en [diagnóstico](/diagnostics).

## Siguientes pasos

- [Arquitectura](/es/guide/architecture): cómo se reparten el trabajo la capa TypeScript y el Core
- [Scroll virtual](/es/guide/scrolling), [texto y edición](/es/guide/editing)
- [Playground](/es/playground): demos interactivas en vivo
