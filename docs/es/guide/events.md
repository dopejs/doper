# Eventos y hit testing

## Separar la captura del hit testing

El hilo principal escucha pointer/wheel/touch con `{ passive: true }`. Los eventos relacionados con
el scroll **sólo escriben el delta y la marca de tiempo en un canal compartido: no hacen hit testing
ni disparan setState**.

El hit testing ocurre en el Core: un BVH sobre AABB en coordenadas de mundo que se mantiene de forma
incremental junto al Scene (se reconstruye si cambia la topología y sólo se hace refit si cambia la
geometría). Tras el impacto se construye la ruta root→target y se devuelve a la capa TypeScript por el
flujo inverso.

Tests de propiedades garantizan que el BVH y una implementación lineal trivial dan el mismo resultado:
la ruta optimizada siempre tiene un oráculo con el que compararse.

## Propagación en tres fases

El modelo de eventos se alinea con el DOM: captura → objetivo → burbuja.

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

Manejadores disponibles: `onPointerDown`, `onPointerUp`, `onPointerMove`, `onPointerCancel`,
`onClick`, `onWheel`, cada uno con su versión `*Capture`.

`DoperEvent` ofrece `target`, `currentTarget`, `eventPhase`, las coordenadas lógicas locales al canvas
`x`/`y`, `deltaX`/`deltaY`, `buttons`, las teclas modificadoras, `preventDefault()`,
`stopPropagation()` y `stopImmediatePropagation()`.

## El problema de temporización de preventDefault

Un listener pasivo no puede llamar a `preventDefault()`. Es un punto de corrección que hay que
resolver explícitamente, no un detalle que se pueda esquivar.

La solución: las zonas que deben impedir el comportamiento por defecto (por ejemplo un área
desplazable interna) las **calcula el Core por adelantado** y sincroniza hacia el hilo principal como
«rectángulos de zona no pasiva». El hilo principal cambia esas zonas a listeners no pasivos y llama a
`preventDefault()` de forma **síncrona** cuando el evento cae dentro. Así no existe ninguna condición
de carrera que dependa de una respuesta asíncrona.

## Fronteras de la semántica de impacto

La semántica actual es deliberadamente estrecha para evitar comportamientos implícitos:

- En **impactos solapados** el objetivo es «el último que se pintó». De momento no hay z-order, ni
  desactivar el impacto con `pointer-events`, ni saltarse nodos invisibles. Introducir cualquiera de
  esas cosas requiere una decisión de diseño explícita.
- **Impacto contra la instantánea del fotograma**: todos los eventos de un mismo lote se resuelven
  contra la geometría del último fotograma confirmado. Un scroll dentro del lote que cambie la
  geometría no afecta al impacto hasta el fotograma siguiente; esto garantiza la semántica de
  reversión atómica del lote y la reproducción determinista.
- La entrada de teclado va por el [protocolo de entrada de edición](/es/guide/editing) y no se disfraza
  de evento de impacto.

En la [demo de eventos del Playground](/es/playground#/events) se ve en vivo el registro de la
propagación en tres fases.
