---
layout: home

hero:
  name: Pingo
  text: canvas-Rendering-Engine
  tagline: Rust/WASM-Kern + TypeScript-Schale + austauschbares Backend. Entwickelt für hochperformante Interaktion, natives virtuelles Scrollen und Texteingabe direkt im canvas.
  image:
    light: /pingo-mark.svg
    dark: /pingo-mark-dark.svg
    alt: Pingo
  actions:
    - theme: brand
      text: Erste Schritte
      link: /de/guide/getting-started
    - theme: alt
      text: Playground
      link: /de/playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/pingo

features:
  - title: Zwei Uhren — der Hauptthread blockiert, das Bild bleibt flüssig
    details: Die UI-Uhr und die Rendering-Uhr laufen unabhängig voneinander. Scrollen, Animation, Layout und Komposition laufen im Worker weiter, sodass die Darstellung auch dann durchläuft, wenn der Hauptthread 200 ms blockiert ist.
  - title: Natives virtuelles Scrollen
    details: Präfixsummenbaum, richtungsbasiertes Vorwärmen und Platzhalter-Nachfüllen liegen im Core. 20.000 Frames eines Fixtures mit einer Million Zeilen ergeben P95/P99 im Submikrosekundenbereich, und laufendes Scrollen ruft die TypeScript-Schale nie auf.
  - title: canvas-native Texteingabe
    details: Cursor, Auswahl, Ziehauswahl, Wortauswahl per Doppelklick, IME-Komposition, Position des Kandidatenfensters, Zwischenablage sowie Rückgängig/Wiederherstellen implementiert die Engine. Ihre Anwendung legt für Eingaben keine HTML-Steuerelemente mehr an.
  - title: Barrierefreiheit ist Teil der Architektur
    details: Der Core exportiert einen Semantikbaum, den der Host als DOM-Schattenbaum neben dem canvas spiegelt. Screenreader funktionieren, und E2E-Tests wählen über Rolle und Beschriftung statt über Pixelvergleiche.
  - title: Determinismus und Differenztests
    details: Versionierte Binärströme, injizierbare Uhr und Zufallsquelle, Aufzeichnung und Wiedergabe sowie Differenzorakel zwischen inkrementell und vollständig, optimiert und naiv, wasm und nativ.
  - title: Automatischer Rückfall, immer ein Ausweg
    details: SharedArrayBuffer → postMessage → Canvas2D im Hauptthread werden funktionsgleich anhand der Fähigkeiten automatisch gewählt. Die Migrationsschicht erlaubt seitenweises Ausrollen und sofortiges Zurücknehmen.
---

## In 30 Sekunden starten

```sh
pnpm add @dopejs/pingo
```

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/pingo";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `Zeile ${index}` }),
  }),
);
```

Die eine Million Zeilen wird in der TypeScript-Schale nie materialisiert, und Scrollen ruft den
Komponentenbaum nicht zurück: Fensterberechnung und Nachfüllen passieren im Core.

## Was es nicht tut

pingo ist eine Rendering-Engine, kein Browser. **Nicht abgedeckt** sind SSR und HTML-Erstdarstellung,
allgemeine CSS-Kompatibilität (Boxmodell, Kaskade, Selektoren), Adapterschichten für Mini-Programme
oder Native sowie fachliche Rich-Text-Semantik (Kollaboration, Formeln, Markdown-Befehle).

Umgekehrt **gehören** Cursor, Auswahl, IME, Zwischenablage, Rückgängig/Wiederherstellen und die
Primitiven für editierbaren Text **zur Engine**. Nichts davon wird der Anwendung zurückgegeben, damit
sie es aus DOM-Steuerelementen zusammenstückelt.

## Aktueller Stand

v0.1.0. Alle Engineering-Meilensteine P0–M5 sind abgeschlossen, und die vollautomatische Kette
`pnpm m5:check` läuft durch.

Leistung auf echten Geräten, echte Eingabemethoden und die Screenreader-Matrix gehören zur
Plattformqualifizierung und werden getrennt verfolgt. Visuelle bidi-Navigation und das
standardmäßige Aktivieren des WebGPU-Backends sind [dokumentierte Zurückstellungen](/plan).

::: tip Sprache der technischen Dokumente
Technischer Entwurf, Umsetzungsplan und ADRs liegen derzeit nur auf vereinfachtem Chinesisch vor;
alle Sprachen verlinken auf dasselbe Dokument.
:::
