# Events und Hit-Testing

## Erfassung und Hit-Testing getrennt

Der Hauptthread lauscht auf pointer/wheel/touch mit `{ passive: true }`. Scroll-bezogene Ereignisse
**schreiben nur Delta und Zeitstempel in einen gemeinsamen Kanal: kein Hit-Testing, kein setState**.

Das Hit-Testing findet im Core statt: ein BVH über Welt-AABBs, das inkrementell mit der Scene gepflegt
wird (bei Topologieänderung neu gebaut, bei reiner Geometrieänderung nur nachjustiert). Nach dem Treffer
wird der Pfad root→target gebildet und über den Rückkanal an die TypeScript-Schale zurückgegeben.

Property-Tests garantieren, dass BVH und eine naive lineare Implementierung dasselbe Ergebnis liefern —
der optimierte Pfad hat immer ein vergleichbares Orakel.

## Ausbreitung in drei Phasen

Das Ereignismodell folgt dem DOM: Capture → Ziel → Bubble.

```tsx
<container onClickCapture={(event) => log("outer capture", event.eventPhase)}>
  <container
    onPointerDown={(event) => {
      event.preventDefault();
      event.stopPropagation();
    }}
  />
</container>
```

Verfügbare Handler: `onPointerDown`, `onPointerUp`, `onPointerMove`, `onPointerCancel`, `onClick`,
`onWheel`, jeweils mit passender `*Capture`-Variante.

`PingoEvent` bietet `target`, `currentTarget`, `eventPhase`, die canvas-lokalen logischen Koordinaten
`x`/`y`, `deltaX`/`deltaY`, `buttons`, die Modifikatortasten sowie `preventDefault()`,
`stopPropagation()` und `stopImmediatePropagation()`.

## Das Timing-Problem von preventDefault

Ein passiver Listener darf `preventDefault()` nicht aufrufen. Das ist ein Korrektheitspunkt, der
ausdrücklich gelöst werden muss, und kein Detail, das man umgehen kann.

Die Lösung: Bereiche, die das Standardverhalten unterbinden müssen (etwa ein innerer scrollbarer
Bereich), berechnet der **Core im Voraus** und synchronisiert „Rechtecke nicht passiver Regionen“ zum
Hauptthread. Dieser stellt genau diese Bereiche auf nicht passive Listener um und ruft
`preventDefault()` **synchron** auf, sobald ein Ereignis darin liegt. Damit existiert kein Wettlauf, der
von einer asynchronen Antwort abhinge.

## Grenzen der Treffersemantik

Die aktuelle Semantik ist bewusst eng gefasst, um implizites Verhalten zu vermeiden:

- Bei **überlappenden Treffern** ist das Ziel „das zuletzt Gezeichnete“. Z-Order, das Abschalten von
  Treffern über `pointer-events` und das Überspringen unsichtbarer Knoten gibt es vorerst nicht. Jede
  dieser Ergänzungen erfordert eine ausdrückliche Entwurfsentscheidung.
- **Treffer gegen den Frame-Schnappschuss**: Alle Ereignisse eines Bündels werden gegen die Geometrie
  des zuletzt committeten Frames aufgelöst. Ändert Scrollen innerhalb des Bündels die Geometrie, wirkt
  sich das erst im nächsten Frame auf Treffer aus — das sichert die atomare Rollback-Semantik des
  Bündels und die deterministische Wiedergabe.
- Tastatureingaben laufen über das [Bearbeitungs-Eingabeprotokoll](/de/guide/editing) und geben sich
  nicht als Trefferereignis aus.

In der [Event-Demo im Playground](/de/playground#/events) sehen Sie das Protokoll der dreiphasigen
Ausbreitung in Echtzeit.
