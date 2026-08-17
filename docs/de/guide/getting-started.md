# Erste Schritte

## Installation

```sh
pnpm add @dopejs/doper
```

Ihre Anwendung hängt nur von einem Paket ab: `@dopejs/doper`. `@dopejs/doper-host`,
`@dopejs/doper-jsx` und die übrigen sind interne Implementierungspakete und nicht Teil des
öffentlichen Vertrags — der [Migrationsscanner](/migration) lehnt ihren direkten Import ab.

## Das erste Canvas einhängen

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

`createHostedCanvasRoot` erkennt die Browserfähigkeiten und wählt den Transport zwischen
SharedArrayBuffer, postMessage und Canvas2D im Hauptthread; Sie schreiben keine Verzweigungen für den
Rückfall. `root.mode` liefert den tatsächlich gewählten Weg.

## TSX verwenden

Konfigurieren Sie `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

Danach können Sie schreiben:

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`Bestellung Nr. ${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## Host-Elemente

Die Engine kennt nur fünf eingebaute Elemente, die direkt Scene-Knoten entsprechen. Es gibt weder
CSS-Kaskade noch Selektoren.

| Element        | Zweck                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `container`    | Allgemeine Gruppierung, Hintergrund, Innenabstand, Transformationen   |
| `text`         | Textlauf (Shaping, Umbruch und Cursor-Geometrie stammen aus dem Core) |
| `scroll`       | Vom Core verwalteter scrollbarer Container                            |
| `virtualList`  | Virtuelle Liste, deren Fenster der Core plant                         |
| `editableText` | Primitive für editierbaren Text                                       |

`TextField` und `TextArea` sind Widgets, die auf `editableText` aufsetzen (Rahmen, Fehlerzustand); sie
führen keinen neuen Eingabepfad ein.

## Zustand und Effekte

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `${count} s vergangen` });
}
```

Verfügbare reaktive Primitiven: `signal`, `computed`, `effect`, `batch`, `untracked` sowie die Hooks
`useState`, `useSignal`, `useMemo`, `useCallback`, `useRef`, `useEffect`.

::: warning Kein synchrones Lesen des Layouts
Synchrones Lesen des Worker-Layouts im Stil von `useLayoutEffect` wird nicht unterstützt — das Layout
läuft auf einer anderen Uhr. Wenn Sie das Ergebnis brauchen, nutzen Sie den asynchronen Vertrag und
versuchen Sie nicht, Geometrie während des Renderns synchron zu lesen.
:::

## Laufzeitverhalten beobachten

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` liefert pro Frame die Anzahl der Befehle, die Bytegröße der DisplayList sowie auf Core-Seite
die Zähler schmutziger Knoten, den Layout-Aufwand und den Picture-Hash. Das ist die primäre Datenquelle
für Performanceanalysen. Mehr dazu unter [Diagnose](/diagnostics).

## Nächste Schritte

- [Architektur](/de/guide/architecture): wie sich TypeScript-Schale und Core die Arbeit teilen
- [Virtuelles Scrollen](/de/guide/scrolling), [Text und Bearbeitung](/de/guide/editing)
- [Playground](/de/playground): interaktive Live-Demos
