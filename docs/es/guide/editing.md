# Texto y edición

## La edición es una capacidad del motor, no un apaño de la aplicación

El punto débil clásico de las soluciones sobre canvas es poner un `input` HTML encima del canvas
cuando hace falta escribir. De ahí vienen en cadena el cursor desalineado, la ventana de candidatos
del IME fuera de sitio, el scroll desincronizado y la accesibilidad rota.

doper trata la edición como una capacidad de primera clase del Core: cursor, selección, arrastre,
doble clic para seleccionar palabra, navegación con teclado, composición IME, posición de la ventana
de candidatos, portapapeles, deshacer/rehacer, sólo lectura y contraseña los implementa el motor.
**La aplicación no crea, no posiciona y no sincroniza ningún control de entrada HTML.**

## Usar los widgets

```ts
import { TextField, TextArea } from "@dopejs/pingo";

TextField({
  value: order.note,
  revision: order.revision,
  semanticLabel: "Nota del pedido",
  inputMode: "text",
  onTransaction: (transaction) => order.apply(transaction),
});

TextArea({ value: description, revision, rows: 4 });
```

## Usar la primitiva

```ts
createElement("editableText", {
  value,
  revision,
  multiline: false,
  readOnly: false,
  password: false,
  maxGraphemes: 200,
  inputMode: "email",
  onTransaction: (transaction) => apply(transaction),
  onSubmit: () => moveToNextCell(),
});
```

O con un controlador local:

```ts
import { useTextEditingController } from "@dopejs/pingo";

const editor = useTextEditingController({ value: cell.value });
createElement("editableText", { controller: editor });
```

## Puente de entrada y degradación

El hilo principal se conecta al servicio de texto del sistema operativo por orden de preferencia:

1. **EditContext** — se asocia al canvas, recibe texto, selección y composición, y ofrece al IME
   control, selection y character bounds.
2. **Proxy de entrada gestionado por el motor** — si EditContext no está disponible, el host mantiene
   **un único** `textarea` oculto global que atiende `beforeinput`, la composición, el teclado
   virtual y el portapapeles.

Lo segundo es una implementación de degradación de plataforma, no un modelo de componentes EmbedDOM:
en el Scene no existe un DOM que corresponda uno a uno con cada nodo editable. Ambos caminos pasan el
mismo conjunto de tests de contrato de comportamiento.

## Transacciones de edición versionadas

La propiedad del estado es explícita: **la capa TypeScript es dueña de los datos de negocio y el Core
del estado transitorio de la sesión de edición activa.**

```
entrada → el Core comprueba base_revision → aplica y repinta al instante → emite hacia atrás una EditTransaction versionada
                                                                                      ↓
                                        la aplicación confirma, o envía un valor corregido con una revisión nueva
```

Una transacción caducada nunca sobrescribe un estado más nuevo. Es decir: cada pulsación no obliga a
recorrer un build completo de TSX, y a la vez siguen valiendo los datos controlados y la validación de
negocio.

```ts
onTransaction: (transaction) => {
  // transaction.baseRevision / revision / delta / selection / kind
  value = applyDelta(value, transaction);
};
```

## Modelo de posiciones de texto

Las API de entrada de la web usan desplazamientos UTF-16, las cadenas de Rust son UTF-8, y las
fronteras de grafemas, clústeres de shaping y glifos visuales son distintas entre sí. El motor
mantiene la correspondencia explícita:

```
desplazamiento UTF-16 ↔ escalar Unicode ↔ grafema ↔ clúster de shaping ↔ glifo / línea
```

En la frontera del protocolo se usa UTF-16 de forma uniforme, para alinearse con EditContext y con
InputEvent. **Borrar, mover y seleccionar nunca parten un grafema, una secuencia combinante, un emoji
con ZWJ ni un clúster de shaping**, algo protegido por tests de propiedades y por una matriz de
fixtures de composición (caracteres combinantes, emoji ZWJ, RTL, candidatos CJK en varios tramos).

## Contraseñas y privacidad

El texto de contraseña no entra en la grabación y reproducción, ni en los registros, ni en el texto
plano de las devtools, ni en los valores de accesibilidad; un objetivo de contraseña tampoco escribe
en el portapapeles. El Core sólo emite glifos enmascarados, así que el texto plano ni siquiera llega
al DisplayList. Hay tests automáticos que lo comprueban y también puedes inspeccionar el DOM tú mismo
en el [Playground publicado](/es/playground#/editing).

## Límites conocidos

- La **navegación visual bidi** llegará junto con el soporte de texto bidi; hoy es un aplazamiento
  explícito.
- El esquema de texto enriquecido, la resolución de conflictos colaborativa, las fórmulas y los
  comandos Markdown corresponden a capas superiores, pero pueden construirse sobre estas mismas
  transacciones de edición y la API de selección.
