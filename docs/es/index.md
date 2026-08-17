---
layout: home

hero:
  name: doper
  text: motor de renderizado canvas
  tagline: Núcleo Rust/WASM + capa TypeScript + backend intercambiable. Diseñado para interacción de alto rendimiento, scroll virtual nativo y edición de texto dentro del canvas.
  actions:
    - theme: brand
      text: Primeros pasos
      link: /es/guide/getting-started
    - theme: alt
      text: Playground
      link: /es/playground
    - theme: alt
      text: GitHub
      link: https://github.com/dopejs/doper

features:
  - title: Dos relojes; el hilo principal se bloquea y no se pierden fotogramas
    details: El reloj de la interfaz y el de renderizado son independientes. El scroll, las animaciones, el layout y la composición avanzan dentro del Worker, así que la imagen sigue fluida aunque el hilo principal esté bloqueado 200 ms.
  - title: Scroll virtual nativo
    details: El árbol de sumas prefijas, la precarga con predicción de dirección y el relleno con marcadores viven en el Core. Reproducir 20.000 fotogramas de un fixture de un millón de filas da P95/P99 por debajo del microsegundo, y el scroll no llama nunca a la capa TypeScript.
  - title: Edición nativa en canvas
    details: Cursor, selección, arrastre, doble clic para seleccionar palabra, composición IME, posición de la ventana de candidatos, portapapeles y deshacer/rehacer los implementa el motor. Tu aplicación ya no crea controles HTML para poder escribir.
  - title: La accesibilidad es parte de la arquitectura
    details: El Core exporta un árbol semántico y el host lo refleja como un árbol DOM en la sombra junto al canvas. Los lectores de pantalla funcionan y los tests E2E seleccionan por rol y etiqueta en lugar de comparar píxeles.
  - title: Determinismo y tests diferenciales
    details: Flujos binarios versionados, reloj y fuente de aleatoriedad inyectables, grabación y reproducción, y oráculos diferenciales entre incremental y completo, optimizado y trivial, wasm y nativo.
  - title: Degradación automática, siempre hay salida
    details: SharedArrayBuffer → postMessage → Canvas2D en el hilo principal se eligen automáticamente según las capacidades, con equivalencia funcional. La capa de migración admite despliegue por página y vuelta atrás inmediata.
---

## Empezar en 30 segundos

```sh
pnpm add @dopejs/doper
```

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

const root = await createHostedCanvasRoot(document.querySelector("canvas")!);

root.render(
  createElement("virtualList", {
    width: 480,
    height: 640,
    itemCount: 1_000_000,
    estimatedItemHeight: 32,
    renderItem: (index) => createElement("text", { value: `Fila ${index}` }),
  }),
);
```

El millón de filas nunca se materializa en la capa TypeScript y el scroll no vuelve al árbol de
componentes: el cálculo de la ventana y el relleno ocurren dentro del Core.

## Lo que no hace

doper es un motor de renderizado, no un navegador. **No cubre** SSR ni primer pintado en HTML,
compatibilidad general con CSS (modelo de caja, cascada, selectores), capas de adaptación a
mini-apps o nativo, ni semántica de texto enriquecido a nivel de producto (colaboración, fórmulas,
comandos Markdown).

En cambio el motor **sí es dueño** del cursor, la selección, el IME, el portapapeles, deshacer/rehacer
y las primitivas de texto editable. Nada de eso se devuelve a la aplicación para que lo improvise
con controles DOM.

## Estado actual

v0.1.0. Todos los hitos de ingeniería P0–M5 están completos y la cadena automática `pnpm m5:check`
pasa por completo.

El rendimiento en dispositivos reales, los IME reales y la matriz de lectores de pantalla se
registran aparte como cualificación de plataforma. La navegación visual bidi y activar el backend
WebGPU por defecto son [aplazamientos documentados](/plan).

::: tip Idioma de los documentos de ingeniería
El diseño técnico, el plan de implementación y los ADR sólo existen hoy en chino simplificado; todos
los idiomas enlazan al mismo documento.
:::
