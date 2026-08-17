# Arquitectura

## Propiedad a cada lado

```
TSX / hooks           →  Mutation Stream  →   Scene / Layout / Paint
（capa TypeScript）       binario, por lotes    （Core Rust, wasm）
                                                     ↓
Reproductor Canvas2D  ←   DisplayList      ←    Picture
```

**La capa TypeScript es dueña del árbol de componentes y el Core del Scene. No comparten objetos
mutables.** Toda la comunicación entre ambos son flujos binarios versionados: little-endian,
alineados a cuatro bytes, en forma de instrucciones. El receptor valida opcode, longitud,
alineación, identificadores y aritmética antes de tocar memoria, y una entrada malformada se
rechaza de forma atómica en lugar de aplicarse a medias.

Esta frontera no es una optimización de rendimiento sino una frontera de corrección: aunque los
bytes suelan venir del codificador de este mismo proyecto, el decodificador los trata como entrada
no confiable y está cubierto por fuzzing.

## Dos relojes

El reloj de interfaz (hilo principal) y el de renderizado (Worker) son independientes:

- El hilo principal recoge entrada, ejecuta el árbol de componentes y confirma fotogramas de Mutation.
- El Worker impulsa la física de scroll, las animaciones, el layout y la composición.

**El scroll en régimen permanente no llama a la capa TypeScript.** Los datos que faltan se dibujan
con marcadores y se completan en fotogramas posteriores. Por eso, si el código de aplicación bloquea
el hilo principal 200 ms, el scroll y las animaciones siguen fluidos; este escenario está protegido
por tests automáticos de inyección de fallos.

## Cadena de degradación

La detección de capacidades elige el transporte en orden, con tres niveles funcionalmente equivalentes:

1. **SharedArrayBuffer** — requiere aislamiento entre orígenes (COOP/COEP)
2. **postMessage** — cuando no hay SAB
3. **Canvas2D en el hilo principal** — cuando no hay Worker ni OffscreenCanvas

```ts
const root = await createHostedCanvasRoot(canvas, {
  transport: { preference: "sab" }, // es una preferencia; si no se cumple, degrada igualmente
});
console.log(root.mode); // "sab" | "post-message" | "main-thread"
```

El [Playground](/es/playground) de este sitio es el ejemplo vivo: GitHub Pages no puede enviar
cabeceras COOP/COEP, así que la versión publicada funciona por postMessage y la etiqueta de
transporte en la parte superior lo muestra tal cual.

## Modelo de invalidación

**La semántica de cada prop determina su dominio de invalidación.** Quien llama no marca nada como
sucio a mano y no existe ninguna vía de escape tipo `forceUpdate`.

Cada propiedad declara en un esquema único si afecta al layout, al pintado, al hit testing o a la
semántica. Cambiar `opacity` no provoca reflow; cambiar `width` sí. Los mapas de bits de suciedad se
mantienen por dominio y `onFrame` expone cuántos nodos sucios hay en cada uno.

La elección es «invalidación lo más estrecha posible, con tests de propiedades como red de
seguridad»: el resultado incremental debe coincidir píxel a píxel con el completo, y los tests
diferenciales reducen cualquier contraejemplo al caso mínimo que falla.

## Representación del Scene

Dentro del Core el Scene es SoA (estructura de arrays en lugar de array de estructuras):

- Los identificadores de nodo llevan **generación**: reutilizar una posición nunca revalida un
  identificador caducado.
- Tras cada commit se mantiene el **orden topológico**: los padres siempre preceden a los hijos.
- La compactación de las ediciones estructurales ocurre una vez por commit, no una vez por mutación.
- Los resultados de layout se comparan en bloque desde SoA con doble búfer, sin asignar closures ni
  listeners por nodo en la ruta caliente.

## Backend intercambiable

El Core emite un DisplayList binario y plano; el backend es sólo un reproductor. El backend Canvas2D
es un bucle sobre arrays tipados que evita asignaciones: **llamar de wasm a JS una vez por dibujo no
es una ruta de renderizado aceptable**.

El mismo DisplayList alimenta un prototipo wgpu aislado y ambas salidas se comparan píxel a píxel.
Adoptar WebGPU o no es una decisión basada en datos; véase
[ADR-0006](/adr/0006-webgpu-backend-decision).

## Determinismo

El tiempo, la aleatoriedad y los flujos de entrada son inyectables o reproducibles, y la salida del
Core no depende del orden de planificación de hilos. Un archivo `DOPR` graba los flujos de Mutation e
Input en su orden original y puede reproducirse de forma determinista sin navegador, en un entorno
headless: así un problema de producción se reproduce en local, y los flujos de edición sensibles se
excluyen explícitamente de la grabación.

## Para profundizar

Los algoritmos, las estructuras de datos y los criterios de aceptación completos están en el
[documento de diseño técnico](/design).
