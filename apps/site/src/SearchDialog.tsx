import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { SiteLocale } from "./locales";
import type { PageSummary } from "./types";

interface SearchDialogProps {
  readonly locale: SiteLocale;
  readonly open: boolean;
  onClose: () => void;
}

function score(record: PageSummary, terms: readonly string[]): number {
  const title = record.title.toLocaleLowerCase();
  const headings = record.headings.join(" ").toLocaleLowerCase();
  const text = record.text.toLocaleLowerCase();
  let value = 0;
  for (const term of terms) {
    if (!title.includes(term) && !headings.includes(term) && !text.includes(term)) return -1;
    if (title.includes(term)) value += 12;
    if (headings.includes(term)) value += 5;
    if (text.includes(term)) value += 1;
  }
  return value;
}

export function SearchDialog({ locale, open, onClose }: SearchDialogProps): ReactNode {
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<readonly PageSummary[]>([]);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || records.length > 0) return;
    const controller = new AbortController();
    void fetch("/__pingo/search-index.json", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`search index: ${String(response.status)}`);
        return response.json() as Promise<readonly PageSummary[]>;
      })
      .then(setRecords)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [open, records.length]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, open]);

  const results = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return [];
    const local = records.filter((record) => record.localePath === locale.path);
    return local
      .map((record) => ({ record, score: score(record, terms) }))
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
  }, [locale.path, query, records]);

  if (!open) return null;
  return (
    <div className="search-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={locale.ui.searchButton}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <label className="search-field">
          <span aria-hidden="true">⌕</span>
          <input
            ref={input}
            value={query}
            placeholder={locale.ui.searchPlaceholder}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <button type="button" onClick={onClose}>
            Esc
          </button>
        </label>
        <div className="search-results">
          {error !== "" && <p className="search-empty">{error}</p>}
          {query !== "" && error === "" && results.length === 0 && (
            <p className="search-empty">{locale.ui.searchNoResults}</p>
          )}
          {results.map(({ record }) => (
            <a key={record.route} href={record.href}>
              <strong>{record.title}</strong>
              <span>{record.description || record.headings.slice(0, 2).join(" · ")}</span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
