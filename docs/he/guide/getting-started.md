# התחלה מהירה

## התקנה

```sh
pnpm add @dopejs/doper
```

היישום תלוי בחבילה אחת בלבד: `@dopejs/doper`. החבילות `@dopejs/doper-host`, `@dopejs/doper-jsx`
והאחרות הן חבילות מימוש פנימיות שאינן חלק מהחוזה הציבורי, ו[סורק ההגירה](/migration) דוחה ייבוא ישיר
שלהן.

## הרכבת ה-canvas הראשון

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

‏`createHostedCanvasRoot` מזהה את יכולות הדפדפן ובוחר את נתיב ההעברה מבין SharedArrayBuffer,
‏postMessage ו-Canvas2D בתהליכון הראשי; אינך צריך לכתוב הסתעפויות עבור הנסיגה. הנתיב שנבחר בפועל מוחזר
ב-`root.mode`.

## שימוש ב-TSX

הגדר את `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@dopejs/doper"
  }
}
```

לאחר מכן אפשר לכתוב:

```tsx
function OrderRow({ index }: { index: number }) {
  return (
    <container width={480} height={32} padding={[6, 12, 6, 12]}>
      <text value={`הזמנה מס׳ ${index}`} fontSize={13} lineHeight={20} />
    </container>
  );
}

root.render(<OrderRow index={1} />);
```

## רכיבי המארח

למנוע יש חמישה רכיבים מובנים בלבד, וכולם מתאימים ישירות לצמתי Scene. אין מפל CSS ואין בוררים.

| רכיב           | תפקיד                                                       |
| -------------- | ----------------------------------------------------------- |
| `container`    | קיבוץ כללי, רקע, ריפוד פנימי, טרנספורמציות                  |
| `text`         | רצף טקסט (עיצוב, שבירת שורות וגיאומטריית סמן מגיעים מהליבה) |
| `scroll`       | מכולה נגללת שבבעלות הליבה                                   |
| `virtualList`  | רשימה וירטואלית שהליבה מתכננת את החלון שלה                  |
| `editableText` | פרימיטיב של טקסט ניתן לעריכה                                |

‏`TextField` ו-`TextArea` הם רכיבים המורכבים מעל `editableText` (מסגרת, מצב שגיאה) ואינם מכניסים שום
נתיב קלט חדש.

## מצב ותופעות לוואי

```ts
import { signal, useEffect, useSignal, useState } from "@dopejs/doper";

function Counter() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return createElement("text", { value: `עברו ${count} שניות` });
}
```

הפרימיטיבים הריאקטיביים הזמינים: `signal`, `computed`, `effect`, `batch`, `untracked`, ולצדם ההוקים
‏`useState`, `useSignal`, `useMemo`, `useCallback`, `useRef`, `useEffect`.

::: warning אין קריאה סינכרונית של הפריסה
קריאה סינכרונית של פריסת ה-Worker בסגנון `useLayoutEffect` אינה נתמכת — הפריסה מתרחשת על שעון אחר.
כשדרושה התוצאה, השתמש בחוזה האסינכרוני ואל תנסה לקרוא גיאומטריה באופן סינכרוני בזמן הרינדור.
:::

## מעקב אחר ההתנהגות בזמן ריצה

```ts
const root = await createHostedCanvasRoot(canvas, {
  onFrame: (report) => {
    console.log(report.commands, report.displayListBytes, report.core?.sceneNodes);
  },
  onHostError: (error) => report(error),
});
```

‏`onFrame` מספק בכל פריים את מספר הפקודות, את גודל ה-DisplayList בבתים, ומצד הליבה את מוני הצמתים
המלוכלכים, את נפח עבודת הפריסה ואת גיבוב ה-picture. זהו מקור המידע הראשוני לניתוח ביצועים. פרטים נוספים
ב[אבחון](/diagnostics).

## הצעד הבא

- [סקירת ארכיטקטורה](/he/guide/architecture): כיצד המעטפת והליבה מחלקות את העבודה
- [גלילה וירטואלית](/he/guide/scrolling), [טקסט ועריכה](/he/guide/editing)
- [Playground](/he/playground): הדגמות חיות שאפשר להפעיל
