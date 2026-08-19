---
title: Änderungsprotokoll
---

# Changelog

Die Versionspolitik steht in `docs/release.md`: Alle 10 Pakete werden atomar in derselben Version
veröffentlicht, npm-Semver und die Version des binären ABI werden getrennt verwaltet.

## Unreleased

- Die Übertragungskurve des Mausrads folgt jetzt dem Browser: diskrete Rastschritte scrollen animiert,
  während hochpräzise Deltas (Trackpad) weiterhin sofort 1:1 angewendet werden. `DispatchEvent` des
  Input Stream erhält ein Flags-Feld, und die ABI-Version steigt von 1 auf 2.
- Die offizielle Website gibt es auf vereinfachtem Chinesisch, traditionellem Chinesisch, Spanisch,
  Französisch, Deutsch, Russisch, Hebräisch, Arabisch, Japanisch und Koreanisch.

## 0.1.0

Erste veröffentlichungsfähige Version. Alle Engineering-Meilensteine P0–M5 sind abgeschlossen, und
`pnpm m5:check` (die automatische Kette von M0 bis M5) läuft vollständig grün.

- Deterministischer Rust/WASM-Core + TypeScript-Schale: Schema mit einer einzigen Quelle, versionierte
  binäre Mutation-/Input-/DisplayList-/Rückkanalströme, atomare Ablehnung fehlerhafter Eingaben.
- Rendering mit zwei Uhren: Kette SAB → postMessage → Canvas2D im Hauptthread; der Worker stellt weiter
  dar, auch wenn der Hauptthread 200 ms blockiert.
- Natives virtuelles Scrollen (Wiedergabe im Submikrosekundenbereich bei P95/P99 mit einer Million
  Zeilen) und Text-Subsystem (explizites Font-Shaping, Glyph-Atlas, Rückfall auf Systemschriften).
- canvas-native Bearbeitung: zwei Wege über EditContext und Eingabe-Proxy, IME-Komposition,
  Cursor-Navigation per Zeiger und Tastatur, Zwischenablage, Undo/Redo, Passwortmaskierung und
  Scroll-into-View des Cursors.
- Hit-Testing (inkrementelles BVH mit Property-Tests gegen ein naives Orakel) und dreiphasige Events
  Capture/Ziel/Bubble samt Protokoll für synchrones `preventDefault` in nicht passiven Regionen.
- Barrierefreiheit: Export des Semantikbaums, Spiegelung in den DOM-Schattenbaum, semantische
  E2E-Selektoren über `getByRole` und Weiterleitung des Tastaturfokus.
- Migration und Produktivbetrieb: `@dopejs/pingo-compat` für seitenweises Ausrollen und Zurücknehmen,
  Migrationsscanner, SHA-256-Integritätsprüfung von Paket und WASM, Diagnose und Betriebshandbuch.
- Isolierter WebGPU-Prototyp mit abweichungsfreiem Vergleich gegen das Headless-Orakel (ADR-0006:
  Continue Experiment, standardmäßig deaktiviert).

Ausdrücklich zurückgestellt: visuelle bidi-Navigation, Platzhalter in den Widgets, WebGPU standardmäßig
aktiv. Die Plattformqualifizierung (Leistung auf echten Geräten, echte Eingabemethoden, Screenreader)
wird getrennt verfolgt und nicht über die Paketversion zugesagt.
