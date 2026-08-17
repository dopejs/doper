# البداية السريعة

## التثبيت

```sh
pnpm add @dopejs/doper
```

يعتمد تطبيقك على حزمة واحدة فقط هي `@dopejs/doper`. أمّا `@dopejs/doper-host` و`@dopejs/doper-jsx`
وغيرهما فهي حزم تنفيذ داخلية خارج العقد العلني، و[ماسح الترحيل](/migration) يرفض استيرادها مباشرة.

## تركيب أوّل canvas

```ts
import { createElement, createHostedCanvasRoot } from "@dopejs/doper";

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
      value: "Hello doper",
      fontSize: 24,
      lineHeight: 32,
      color: "#1f2329ff",
    }),
  }),
);
```

تكتشف `createHostedCanvasRoot` قدرات المتصفّح وتختار مسار النقل بين SharedArrayBuffer وpostMessage
وCanvas2D على الخيط الرئيسي، فلا تحتاج إلى كتابة تفرّعات من أجل التراجع. وتعيد `root.mode` المسار الذي
جرى اختياره فعلًا.

## استخدام TSX

اضبط `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

عندها يمكنك أن تكتب:

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`الطلب رقم ${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## عناصر المضيف

في المحرّك خمسة عناصر مدمجة فقط، وكلّها تقابل عقد Scene مباشرة؛ لا تتالي CSS ولا محدِّدات.

| العنصر         | الغرض                                                  |
| -------------- | ------------------------------------------------------ |
| `container`    | تجميع عام وخلفية وحشو داخلي وتحويلات                   |
| `text`         | مقطع نصّي (التشكيل والالتفاف وهندسة المؤشّر من النواة) |
| `scroll`       | حاوية قابلة للتمرير تملكها النواة                      |
| `virtualList`  | قائمة افتراضية تخطّط النواة نافذتها                    |
| `editableText` | بدائية النصّ القابل للتحرير                            |

أمّا `TextField` و`TextArea` فهما عنصران مركَّبان فوق `editableText` (إطار وحالة خطأ) ولا يُدخلان أيّ
مسار إدخال جديد.

## الحالة والتأثيرات الجانبية

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `مرّت ${count} ثانية` });
}
```

البدائيات التفاعلية المتاحة: `signal` و`computed` و`effect` و`batch` و`untracked`، إضافةً إلى الخطّافات
‏`useState` و`useSignal` و`useMemo` و`useCallback` و`useRef` و`useEffect`.

::: warning لا قراءة متزامنة للتخطيط
القراءة المتزامنة لتخطيط الـ Worker على طريقة `useLayoutEffect` غير مدعومة، لأنّ التخطيط يجري على ساعة
أخرى. استخدم العقد اللامتزامن عند الحاجة إلى نتيجة التخطيط، ولا تحاول قراءة الهندسة بشكل متزامن أثناء
العرض.
:::

## مراقبة السلوك أثناء التشغيل

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

تعطي `onFrame` في كلّ إطار عدد الأوامر وحجم DisplayList بالبايت، ومن جهة النواة عدّادات العقد المتّسخة
وحجم عمل التخطيط وبصمة picture؛ وهي المصدر الأوّل لتحليل الأداء. للمزيد انظر [التشخيص](/diagnostics).

## الخطوة التالية

- [نظرة عامة على البنية](/ar/guide/architecture): كيف يقتسم الغلاف والنواة العمل
- [التمرير الافتراضي](/ar/guide/scrolling) و[النصّ والتحرير](/ar/guide/editing)
- [Playground](/ar/playground): عروض حيّة قابلة للتفاعل
