---
title: Registro de cambios
---

# Changelog

El criterio de versionado está en `docs/release.md`: los 11 paquetes se publican de forma atómica con
la misma versión, y el semver de npm y la versión del ABI binario se gestionan por separado.

## Unreleased

- La licencia del proyecto cambia de MIT a Apache-2.0 a partir de la próxima versión de npm;
  las versiones publicadas hasta v0.2.1 siguen bajo MIT.
- La curva de transferencia de la rueda se alinea con el navegador: los saltos discretos de rueda se
  animan y los deltas de alta precisión (trackpad) se siguen aplicando 1:1 al instante. `DispatchEvent`
  del Input Stream gana un campo de flags y la versión del ABI pasa de 1 a 2.
- El sitio oficial está disponible en chino simplificado, chino tradicional, español, francés, alemán,
  ruso, hebreo, árabe, japonés y coreano.

## 0.1.0

Primera versión publicable. Todos los hitos de ingeniería P0–M5 están completos y `pnpm m5:check`
(la cadena automática de M0 a M5) pasa en verde.

- Core Rust/WASM determinista + capa TypeScript: esquema de fuente única, flujos binarios versionados
  de Mutation/Input/DisplayList e inverso, y rechazo atómico de entradas malformadas.
- Renderizado con dos relojes: cadena SAB → postMessage → Canvas2D en el hilo principal; el Worker
  sigue presentando aunque el hilo principal quede bloqueado 200 ms.
- Scroll virtual nativo (reproducción P95/P99 por debajo del microsegundo con un millón de filas) y
  subsistema de texto (shaping explícito de fuentes, atlas de glifos, fallback a fuentes del sistema).
- Edición nativa en canvas: doble camino EditContext/proxy de entrada, composición IME, navegación del
  cursor con puntero y teclado, portapapeles, undo/redo, enmascarado de contraseñas y scroll-into-view
  del cursor.
- Hit testing (BVH incremental con tests de propiedades contra un oráculo trivial) y eventos en tres
  fases captura/objetivo/burbuja, con el protocolo de `preventDefault` síncrono sobre zonas no pasivas.
- Accesibilidad: exportación del árbol semántico, proyección al árbol DOM en la sombra, selectores E2E
  semánticos `getByRole` y reenvío del foco de teclado.
- Migración y puesta en producción: `@dopejs/pingo-compat` con despliegue y vuelta atrás por página,
  escáner de migración, verificación de integridad SHA-256 del paquete y del WASM, diagnóstico y
  manual de operación.
- Prototipo WebGPU aislado y comparación sin discrepancias contra el oráculo headless (ADR-0006:
  Continue Experiment, desactivado por defecto).

Aplazamientos explícitos: navegación visual bidi, placeholder en los widgets y activar WebGPU por
defecto. La cualificación de plataforma (rendimiento en dispositivos reales, IME reales, lectores de
pantalla) se registra aparte y no se promete con la versión del paquete.
