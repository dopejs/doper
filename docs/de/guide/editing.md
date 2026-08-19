# Text und Bearbeitung

## Bearbeiten ist eine Fähigkeit der Engine, kein Zusammenbau in der Anwendung

Die klassische Schwäche canvas-basierter Lösungen besteht darin, bei Eingabebedarf ein HTML-`input` über
das canvas zu legen. Daraus folgt eine ganze Kette von Problemen: versetzter Cursor, verrutschtes
IME-Kandidatenfenster, nicht synchrones Scrollen, gebrochene Barrierefreiheit.

doper behandelt Bearbeitung als erstklassige Fähigkeit des Core: Cursor, Auswahl, Ziehauswahl,
Wortauswahl per Doppelklick, Tastaturnavigation, IME-Komposition, Position des Kandidatenfensters,
Zwischenablage, Rückgängig/Wiederherstellen, Nur-Lesen und Passwort implementiert die Engine.
**Die Anwendung erzeugt, positioniert und synchronisiert kein einziges HTML-Eingabeelement.**

## Widgets verwenden

```ts
import { TextField, TextArea } from "@dopejs/pingo";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "Bestellnotiz",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## Die Primitive verwenden

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

Oder mit einem lokalen Controller:

```ts
import { useTextEditingController } from "@dopejs/pingo";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## Eingabebrücke und Rückfall

Der Hauptthread verbindet sich in dieser Reihenfolge mit dem Texteingabedienst des Betriebssystems:

1. **EditContext** — an das canvas gebunden, empfängt Text, Auswahl und Komposition und liefert der
   Eingabemethode control, selection und character bounds.
2. **Von der Engine verwalteter Eingabe-Proxy** — steht EditContext nicht zur Verfügung, hält der Host
   **genau ein** global verstecktes `textarea`, das `beforeinput`, Komposition, Bildschirmtastatur und
   Zwischenablage einheitlich behandelt.

Der zweite Punkt ist eine Plattform-Rückfallimplementierung, kein EmbedDOM-Komponentenmodell: in der
Scene existiert kein DOM, das eins zu eins zu jedem editierbaren Knoten gehört. Beide Wege bestehen
dieselben Verhaltensvertragstests.

## Versionierte Bearbeitungstransaktionen

Der Zustandsbesitz ist eindeutig: **Die TypeScript-Schale besitzt die Fachdaten, der Core den flüchtigen
Zustand der aktiven Bearbeitungssitzung.**

```
Eingabe → Core prüft base_revision → wendet sofort an und zeichnet neu → sendet rückwärts eine versionierte EditTransaction
                                                                                     ↓
                                       die Anwendung bestätigt oder schickt einen korrigierten Wert mit neuer Revision
```

Eine veraltete Transaktion überschreibt nie einen neueren Zustand. Das heißt: jeder Tastendruck erzwingt
keinen kompletten TSX-Build, und gleichzeitig gelten kontrollierte Daten und fachliche Validierung weiterhin.

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## Modell der Textpositionen

Web-Eingabe-APIs arbeiten mit UTF-16-Offsets, Rust-Zeichenketten sind UTF-8, und die Grenzen von
Graphemen, Shaping-Clustern und sichtbaren Glyphen unterscheiden sich noch einmal. Die Engine pflegt eine
explizite Zuordnung:

```
UTF-16-Offset ↔ Unicode-Skalar ↔ Graphem ↔ Shaping-Cluster ↔ Glyphe / Zeile
```

An der Protokollgrenze wird durchgehend UTF-16 verwendet, um zu EditContext und InputEvent zu passen.
**Löschen, Bewegen und Auswählen zerteilen niemals ein Graphem, eine kombinierende Sequenz, ein
ZWJ-Emoji oder einen Shaping-Cluster** — abgesichert durch Property-Tests und eine Matrix von
Kompositions-Fixtures (kombinierende Zeichen, ZWJ-Emoji, RTL, mehrteilige CJK-Kandidaten).

## Passwörter und Privatsphäre

Passworttext gelangt weder in Aufzeichnung und Wiedergabe noch in Logs, in Klartext in den Devtools oder
in Barrierefreiheitswerte; ein Passwortziel schreibt auch nicht in die Zwischenablage. Der Core gibt nur
maskierte Glyphen aus, sodass der Klartext gar nicht erst in die DisplayList gelangt. Automatische Tests
sichern das ab, und im [veröffentlichten Playground](/de/playground#/editing) können Sie das DOM auch
selbst prüfen.

## Bekannte Grenzen

- Die **visuelle bidi-Navigation** kommt zusammen mit der bidi-Textunterstützung; derzeit ist sie eine
  ausdrückliche Zurückstellung.
- Rich-Text-Schema, kollaborative Konfliktauflösung, Formeln und Markdown-Befehle gehören in höhere
  Schichten, lassen sich aber auf denselben Bearbeitungstransaktionen und derselben Selection-API aufbauen.
