# Barrierefreiheit und Testbarkeit

## Vom ersten Tag an in der Architektur

Canvas-Inhalte sind für Screenreader von Natur aus unsichtbar. doper behandelt Barrierefreiheit nicht als
Schicht, die nach der Veröffentlichung übergestülpt wird: Der Core pflegt einen Semantikbaum
(role / label / value / bounds / focusable), und `@dopejs/pingo-a11y` bildet ihn inkrementell auf einen
absolut positionierten DOM-Schattenbaum neben dem canvas ab.

Die Schattenelemente sind optisch transparent, existieren aber im Barrierefreiheitsbaum und in der
Tabulatorreihenfolge; ihr Fokussieren wird an die Bearbeitungssitzung der Engine weitergeleitet, sodass
Tastaturnutzende die Eingabefelder im canvas tatsächlich bedienen können.

## Semantik deklarieren

```tsx
<container semanticRole="region" semanticLabel="Zahlungsbereich">
  <text value="Zahlung" semanticRole="heading" semanticLabel="Zahlung" />
  {TextField({ semanticLabel: "Empfänger", value, revision })}
</container>
```

`editableText` besitzt standardmäßig Textbox-Semantik. Der Wert eines Passwortfelds gelangt **niemals**
in den Semantikbaum.

## E2E-Tests über Semantik

Weil der Semantikbaum in echtes DOM gespiegelt wird, können E2E-Tests über Rolle und Name auswählen
statt Pixel zu vergleichen:

```ts
import { getByRole, queryAllByRole } from "@dopejs/pingo";

const email = getByRole(document.body, "textbox", { name: "Empfänger" });
email.focus(); // wird an die Bearbeitungssitzung der Engine weitergeleitet
expect(queryAllByRole(document.body, "textbox")).toHaveLength(2);
```

Pixel-Schnappschüsse bleiben erhalten, aber als **ergänzender Nachweis** der Renderkorrektheit, nicht
als einzige Zusicherung. Diese Entscheidung verhindert, dass UI-Tests reihenweise scheitern, sobald sich
Font-Rendering oder Kantenglättung ändern.

## Den Semantikbaum beobachten

```ts
const root = await createHostedCanvasRoot(canvas, {
  onSemantics: (nodes) => inspect(nodes),
  accessibility: true, // standardmäßig aktiv; false schaltet den Schattenbaum ab
});
```

Jeder Knoten liefert `nodeId`, `role`, `label`, `value`, die `bounds` in Weltkoordinaten, `focusable`,
`focused` und das `password`-Flag. In der Frame-Diagnose lässt sich über `dirtySemanticsNodes` die
Häufigkeit semantischer Invalidierung beobachten.

## Plattformqualifizierung

Automatisiert abgedeckt sind der Export des Semantikbaums, die Abbildung auf den Schattenbaum, die
Selektoren über Rolle und Beschriftung sowie der Tastaturvertrag.
**Die Verhaltensmatrix echter Screenreader (VoiceOver, NVDA, TalkBack) gehört zur
Plattformqualifizierung**, wird getrennt verfolgt und zählt nicht als Abschlussbedingung der Entwicklung.
Diese Grenze verhindert, dass ungeprüfte Geräteergebnisse als Supportzusage ausgegeben werden.

In der [Semantik-Demo im Playground](/de/playground#/semantics) können Sie den aktuellen Semantikbaum
direkt auslesen.
