# Scroll virtual

## Por qué se hace dentro del motor

La latencia de cola de las listas virtuales en DOM viene de la cadena: el evento de scroll vuelve al
hilo principal, dispara setState, hay diff y reflow. En cuanto el hilo principal se ocupa, se pierden
fotogramas.

doper mete el cálculo de la ventana en el Core: el scroll en régimen permanente **no llama nunca a la
capa TypeScript**. Ésta sólo materializa el rango visible siguiendo la ventana de precarga que
planifica el Core; si los datos aún no están, se dibuja un marcador y se completa en fotogramas
posteriores.

## Uso

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
      children: createElement("text", { value: `Fila ${index}` }),
    }),
});
```

`estimatedItemHeight` es sólo una estimación inicial. Cuando se mide la altura real, el Core corrige
la posición del ancla mediante un árbol de sumas prefijas (Fenwick) y la barra de scroll no salta.

## Parámetros ajustables

| prop                     | Efecto                                                               |
| ------------------------ | -------------------------------------------------------------------- |
| `baseOverscanViewports`  | Rango de precarga simétrico (múltiplos del viewport)                 |
| `velocityHorizonSeconds` | Horizonte de proyección de velocidad para la predicción de dirección |
| `maximumAheadViewports`  | Límite de precarga en una sola dirección                             |
| `scrollX` / `scrollY`    | Posición programática (sólo emite ScrollTo cuando cambia)            |

La predicción de dirección precarga preferentemente hacia donde va el movimiento en un desplazamiento
rápido, en vez de gastar el presupuesto por igual a ambos lados.

## Scroll programático

```ts
// Un cambio de prop emite una única mutación ScrollTo
root.render(createElement("virtualList", { scrollY: 500_000 * 32 /* ... */ }));
```

O bien la API de manipulación directa del root, pensada para gestos propios:

```ts
root.beginScroll(handle);
root.scrollBy(handle, 0, deltaY, elapsedMs);
root.endScroll(handle); // el Core estima la velocidad del impulso
```

`handle` procede del callback `ref` del elemento (`NodeHandle`).

## Rueda y trackpad

La **distancia** de la rueda coincide con la del navegador, pero la curva de transferencia se separa
según la fuente: los deltas de alta precisión (trackpad) se aplican 1:1 de inmediato y la inercia la
sigue aportando el flujo de eventos del sistema operativo; los saltos discretos de rueda se acumulan
en un destino animado al que se llega con una curva exponencial, limitada estrictamente a los bordes
del contenido y sin overscroll, igual que en el navegador.

## Anidamiento y edición

Cuando un arrastre de puntero empieza sobre texto editable, la selección de texto tiene prioridad
sobre el arrastre de scroll; la rueda sigue desplazando el ancestro desplazable más cercano. Esta
prioridad se decide por la profundidad de la ruta de hit testing y no requiere intervención de la
aplicación.

## Criterio de rendimiento

El benchmark automático sobre un fixture fijo (un millón de filas, 20.000 fotogramas) forma parte de
la puerta de mezcla. Hoy el P95/P99 de reproducción está por debajo del microsegundo y treinta
minutos de scroll continuo no muestran crecimiento de memoria descontrolado.

El P95/P99 en dispositivos reales y la latencia de entrada pertenecen a la cualificación de
plataforma y no son condición de salida de ingeniería. La línea es deliberada: evita bloquear el
trabajo con datos de dispositivo no reproducibles y evita también presentar cifras de ingeniería
como una promesa sobre dispositivos.

En la [demo de scroll del Playground](/es/playground#/scroll) se ven las métricas de fotograma en vivo.
