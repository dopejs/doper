# Virtuelles Scrollen

## Warum das in der Engine passiert

Die Ausreißerlatenz DOM-basierter virtueller Listen entsteht durch die Kette: das Scroll-Ereignis geht
zurück in den Hauptthread, löst setState aus, dann Diff, dann Neulayout. Sobald der Hauptthread
beschäftigt ist, fallen Frames aus.

pingo legt die Fensterberechnung in den Core: laufendes Scrollen **ruft die TypeScript-Schale nie auf**.
Sie materialisiert nur den sichtbaren Bereich gemäß dem vom Core geplanten Vorwärmfenster; sind die Daten
noch nicht da, wird ein Platzhalter gezeichnet und in späteren Frames nachgereicht.

## Verwendung

```ts
createElement("virtualList", {
  width: 480,
  height: 640,
  itemCount: 1_000_000,
  estimatedItemHeight: 32,
  renderItem: (index: number) =>
    createElement("container", {
      width: 480,
      height: 32,
      children: createElement("text", { value: `Zeile ${index}` }),
    }),
});
```

`estimatedItemHeight` ist nur eine Anfangsschätzung. Sobald die tatsächliche Höhe gemessen ist, korrigiert
der Core die Ankerposition über einen Präfixsummenbaum (Fenwick), und die Scrollposition springt nicht.

## Einstellbare Größen

| prop                     | Wirkung                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `baseOverscanViewports`  | Symmetrischer Vorwärmbereich (in Viewport-Vielfachen)               |
| `velocityHorizonSeconds` | Projektionshorizont der Geschwindigkeit für die Richtungsvorhersage |
| `maximumAheadViewports`  | Obergrenze des Vorwärmens in eine Richtung                          |
| `scrollX` / `scrollY`    | Programmatische Scrollposition (sendet ScrollTo nur bei Änderung)   |

Die Richtungsvorhersage wärmt bei einem schnellen Wisch bevorzugt die Bewegungsrichtung vor, statt das
Budget symmetrisch auf beide Seiten zu verteilen.

## Programmatisches Scrollen

```ts
// Eine Prop-Änderung sendet genau eine ScrollTo-Mutation
root.render(createElement("virtualList", { scrollY: 500_000 * 32 /* ... */ }));
```

Oder über die API zur direkten Manipulation am Root, gedacht für eigene Gesten:

```ts
root.beginScroll(handle);
root.scrollBy(handle, 0, deltaY, elapsedMs);
root.endScroll(handle); // der Core schätzt die Schwunggeschwindigkeit
```

`handle` stammt aus dem `ref`-Callback des Elements (`NodeHandle`).

## Mausrad und Trackpad

Die **Wegstrecke** des Mausrads entspricht der des Browsers, doch die Übertragungskurve trennt sich nach
Eingabequelle: hochpräzise Deltas (Trackpad) werden sofort 1:1 angewendet, und die Trägheit liefert
weiterhin der Ereignisstrom des Betriebssystems; diskrete Rastschritte summieren sich zu einem animierten
Ziel, dem exponentiell abklingend gefolgt wird — hart auf die Inhaltsgrenzen begrenzt und ohne
Überscrollen, genau wie im Browser.

## Verschachtelung und Bearbeitung

Beginnt ein Zeigerziehen über editierbarem Text, hat die Textauswahl Vorrang vor dem Scroll-Ziehen; das
Mausrad scrollt weiterhin den nächsten scrollbaren Vorfahren. Diese Priorität ergibt sich aus der Tiefe des
Hit-Pfads und erfordert kein Zutun der Anwendung.

## Leistungsmaßstab

Der automatische Benchmark auf einem festen Fixture (eine Million Zeilen, 20.000 Frames) ist Teil des
Merge-Gates. Aktuell liegen P95/P99 der Wiedergabe im Submikrosekundenbereich, und dreißig Minuten
durchgehendes Scrollen zeigen kein unkontrolliertes Speicherwachstum.

P95/P99 auf echten Geräten und die Eingabelatenz gehören zur Plattformqualifizierung und sind keine
Abschlussbedingung der Entwicklung. Diese Trennlinie ist bewusst gezogen: Sie verhindert, dass nicht
reproduzierbare Gerätedaten die Arbeit blockieren, und ebenso, dass Entwicklungszahlen als Gerätezusage
ausgegeben werden.

In der [Scroll-Demo im Playground](/de/playground#/scroll) sehen Sie die Frame-Metriken in Echtzeit.
