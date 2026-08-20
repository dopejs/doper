import { useEffect, useRef, useState, type ReactNode } from "react";

import { SITE_LOCALES, type SiteLocale } from "./locales";

interface LanguageMenuProps {
  readonly locale: SiteLocale;
  readonly onChange: (path: string) => void;
}

export function LanguageMenu({ locale, onChange }: LanguageMenuProps): ReactNode {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.type === "click" && root.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };

    document.addEventListener("click", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="language-menu" ref={root}>
      <button
        className="language-menu__trigger"
        type="button"
        aria-expanded={open}
        aria-label={locale.ui.languageMenu}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
        </svg>
        <span>{locale.label}</span>
      </button>

      {open && (
        <ul className="language-menu__list">
          {SITE_LOCALES.map((candidate) => (
            <li key={candidate.lang}>
              <button
                type="button"
                lang={candidate.lang}
                aria-current={candidate.path === locale.path ? "true" : undefined}
                onClick={() => {
                  onChange(candidate.path);
                  setOpen(false);
                }}
              >
                {candidate.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
