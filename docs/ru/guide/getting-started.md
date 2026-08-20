# Быстрый старт

## Установка

```sh
pnpm add @dopejs/pingo
```

Приложение зависит ровно от одного пакета — `@dopejs/pingo`. `@dopejs/pingo-host`,
`@dopejs/pingo-jsx` и остальные являются внутренними пакетами реализации и не входят в публичный
контракт: [сканер миграции](/migration) отклоняет их прямой импорт.

## Первый холст

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/pingo";

const canvas = document.querySelector<HTMLCanvasElement>("#app")!;
canvas.width = 800;
canvas.height = 600;

const root = await createHostedCanvasRoot(canvas);

root.render(
  createElement("container", {
    width: 800,
    height: 600,
    backgroundColor: "#ffffffff",
    padding: 24,
    children: createElement("text", {
      value: "Hello pingo",
      fontSize: 24,
      lineHeight: 32,
      color: "#1f2329ff",
    }),
  }),
);
```

`createHostedCanvasRoot` определяет возможности браузера и выбирает транспорт между SharedArrayBuffer,
postMessage и Canvas2D в главном потоке — писать ветвления ради отката не нужно. Фактически выбранный
путь возвращает `root.mode`.

## Использование TSX

Настройте `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/pingo"
  }
}
```

После этого можно писать так:

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`Заказ № ${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## Элементы хоста

В движке всего пять встроенных элементов, и все они напрямую соответствуют узлам Scene. Ни каскада CSS,
ни селекторов здесь нет.

| Элемент        | Назначение                                                         |
| -------------- | ------------------------------------------------------------------ |
| `container`    | Общая группировка, фон, внутренние отступы, преобразования         |
| `text`         | Текстовый прогон (шейпинг, переносы и геометрию каретки даёт ядро) |
| `scroll`       | Прокручиваемый контейнер, принадлежащий ядру                       |
| `virtualList`  | Виртуальный список, окно которого планирует ядро                   |
| `editableText` | Примитив редактируемого текста                                     |

`TextField` и `TextArea` — это виджеты поверх `editableText` (рамка, состояние ошибки); они не вводят
никакого нового пути ввода.

## Состояние и эффекты

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/pingo";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `Прошло ${count} с` });
}
```

Доступные реактивные примитивы: `signal`, `computed`, `effect`, `batch`, `untracked`, а также хуки
`useState`, `useSignal`, `useMemo`, `useCallback`, `useRef`, `useEffect`.

::: warning Синхронного чтения раскладки нет
Синхронное чтение раскладки Worker в духе `useLayoutEffect` не поддерживается: раскладка живёт на
других часах. Когда нужен её результат, используйте асинхронный контракт и не пытайтесь читать
геометрию синхронно во время рендера.
:::

## Наблюдение за работой

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

`onFrame` на каждом кадре даёт число команд, размер DisplayList в байтах, а со стороны ядра — счётчики
грязных узлов, объём работы раскладки и хеш picture. Это первичные данные для разбора
производительности. Подробнее в разделе [диагностика](/diagnostics).

## Следующие шаги

- [Архитектура](/ru/guide/architecture): как оболочка и ядро делят работу
- [Виртуальная прокрутка](/ru/guide/scrolling), [текст и редактирование](/ru/guide/editing)
- [Playground](/ru/playground): интерактивные живые демонстрации
