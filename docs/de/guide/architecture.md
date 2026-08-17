# Architektur

## Besitz auf beiden Seiten

```
TSX / Hooks              →  Mutation Stream  →   Scene / Layout / Paint
（TypeScript-Schale）        binär, gebündelt      （Rust-Core, wasm）
                                                         ↓
Canvas2D-Wiedergabe      ←   DisplayList      ←      Picture
```

**Die TypeScript-Schale besitzt den Komponentenbaum, der Core besitzt die Scene. Beide teilen sich
keine veränderlichen Objekte.** Jede Kommunikation über diese Grenze läuft über versionierte
Binärströme: Little-Endian, auf vier Bytes ausgerichtet, als Instruktionen. Der Empfänger prüft Opcode,
Länge, Ausrichtung, Bezeichner und Arithmetik, bevor er Speicher anfasst; fehlerhafte Eingaben werden
atomar abgelehnt statt teilweise angewendet.

Diese Grenze ist keine Performanceoptimierung, sondern eine Korrektheitsgrenze: auch wenn die Bytes in
der Regel aus dem eigenen Encoder dieses Projekts stammen, behandelt der Decoder sie als nicht
vertrauenswürdige Eingabe und ist durch Fuzzing abgesichert.

## Zwei Uhren

Die UI-Uhr (Hauptthread) und die Rendering-Uhr (Worker) sind voneinander unabhängig:

- Der Hauptthread sammelt Eingaben, führt den Komponentenbaum aus und committet Mutation-Frames.
- Der Worker treibt Scroll-Physik, Animation, Layout und Komposition an.

**Laufendes Scrollen ruft die TypeScript-Schale nicht auf.** Fehlende Daten werden als Platzhalter
gezeichnet und in späteren Frames nachgereicht. Blockiert Anwendungscode den Hauptthread also 200 ms,
laufen Scrollen und Animation weiter — dieses Szenario wird durch automatische Fehlerinjektionstests
abgesichert.

## Rückfallkette

Die Fähigkeitserkennung wählt den Transport der Reihe nach; alle drei Stufen sind funktional gleichwertig:

1. **SharedArrayBuffer** — erfordert Cross-Origin-Isolation (COOP/COEP)
2. **postMessage** — wenn kein SAB verfügbar ist
3. **Canvas2D im Hauptthread** — wenn weder Worker noch OffscreenCanvas verfügbar sind

```ts
const root = await createHostedCanvasRoot(canvas, {
  transport: { preference: "sab" }, // nur eine Präferenz; ist sie nicht erfüllbar, wird zurückgefallen
});
console.log(root.mode); // "sab" | "post-message" | "main-thread"
```

Der [Playground](/de/playground) dieser Website ist das lebende Beispiel: GitHub Pages kann keine
COOP/COEP-Header ausliefern, deshalb läuft die veröffentlichte Fassung über postMessage, und das
Transport-Abzeichen oben auf der Seite zeigt das offen an.

## Invalidierungsmodell

**Die Semantik einer Prop bestimmt ihre Invalidierungsdomäne.** Aufrufer markieren nichts von Hand als
schmutzig, und es gibt keine Hintertür wie `forceUpdate`.

Jede Eigenschaft deklariert in einem Schema mit einer einzigen Quelle, ob sie Layout, Zeichnen,
Hit-Testing oder Semantik betrifft. `opacity` zu ändern löst kein Neulayout aus, `width` schon. Die
Dirty-Bitmaps werden je Domäne geführt, und `onFrame` legt die Zahl schmutziger Knoten pro Domäne offen.

Die Entscheidung lautet „so eng wie möglich invalidieren, mit Property-Tests als Sicherheitsnetz“: das
inkrementelle Ergebnis muss pixelgenau dem vollständigen entsprechen, und Differenztests schrumpfen
jedes Gegenbeispiel auf den kleinsten fehlschlagenden Fall.

## Darstellung der Scene

Im Core ist die Scene als SoA aufgebaut (Struktur von Arrays statt Array von Strukturen):

- Knoten-IDs tragen eine **Generation**; das Wiederverwenden eines Platzes macht eine veraltete ID nie
  wieder gültig.
- Nach dem Commit bleibt die **topologische Ordnung** erhalten: Eltern stehen immer vor ihren Kindern.
- Strukturänderungen werden einmal pro Commit verdichtet, nicht einmal pro Mutation.
- Layout-Ergebnisse werden gebündelt aus doppelt gepufferten SoA-Daten verglichen, ohne Closures oder
  Listener pro Knoten auf dem heißen Pfad.

## Austauschbares Backend

Der Core gibt eine flache, binäre DisplayList aus; das Backend ist nur ein Wiedergabegerät. Das
Canvas2D-Backend ist eine allokationssparsame Schleife über typisierte Arrays — **ein wasm→JS-Aufruf pro
Zeichenbefehl ist kein akzeptabler Rendering-Pfad**.

Dieselbe DisplayList speist auch einen isolierten wgpu-Prototypen, und beide Ausgaben werden pixelweise
verglichen. Ob WebGPU übernommen wird, ist eine datenbasierte Entscheidung; siehe
[ADR-0006](/adr/0006-webgpu-backend-decision).

## Determinismus

Zeit, Zufallsquelle und Eingabeströme sind injizierbar oder wiedergebbar, und die Ausgabe des Core hängt
nicht von der Thread-Reihenfolge ab. Ein `DOPR`-Archiv zeichnet Mutation- und Input-Ströme in
Originalreihenfolge auf und lässt sich ohne Browser in einer Headless-Umgebung deterministisch abspielen:
So lässt sich ein Produktionsproblem lokal reproduzieren, während sensible Bearbeitungsströme explizit von
der Aufzeichnung ausgenommen sind.

## Tiefer einsteigen

Die vollständigen Algorithmen, Datenstrukturen und Abnahmekriterien stehen im
[technischen Entwurfsdokument](/design).
