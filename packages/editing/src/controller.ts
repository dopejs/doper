import type { EditTransaction } from "./edit-transactions";

const MAX_U64 = 0xffff_ffff_ffff_ffffn;

export interface TextEditingControllerOptions {
  readonly revision?: number | bigint;
  readonly selection?: { readonly anchor: number; readonly focus: number };
  readonly value: string;
}

/** Stable durable-value controller shared by component renders and Core transactions. */
export class TextEditingController {
  #lastExternalValue: string;
  #revision: bigint;
  #selection: { anchor: number; focus: number };
  #value: string;

  public constructor(options: TextEditingControllerOptions) {
    validateOptions(options);
    this.#value = options.value;
    this.#lastExternalValue = options.value;
    this.#revision = normalizeRevision(options.revision);
    this.#selection = options.selection
      ? { ...options.selection }
      : { anchor: options.value.length, focus: options.value.length };
  }

  public get revision(): bigint {
    return this.#revision;
  }

  public get selection(): Readonly<{ anchor: number; focus: number }> {
    return Object.freeze({ ...this.#selection });
  }

  public get value(): string {
    return this.#value;
  }

  /** Applies one already validated Core transition exactly once. */
  public applyTransaction(transaction: EditTransaction): void {
    if (transaction.baseRevision !== this.#revision) {
      throw new Error("edit transaction base revision does not match controller state");
    }
    if (transaction.revision <= transaction.baseRevision || transaction.revision > MAX_U64) {
      throw new RangeError("edit transaction revision is invalid");
    }
    const value =
      transaction.delta === undefined
        ? this.#value
        : applyUtf16Replacement(
            this.#value,
            transaction.delta.range.start,
            transaction.delta.range.end,
            transaction.delta.text,
          );
    validateSelection(value, transaction.selection);
    this.#value = value;
    this.#revision = transaction.revision;
    this.#selection = {
      anchor: transaction.selection.anchor,
      focus: transaction.selection.focus,
    };
  }

  /**
   * Synchronizes an application-owned value. Explicit revisions are strict;
   * revisionless stale rerenders are ignored while a local transaction awaits acknowledgement.
   */
  public synchronize(options: TextEditingControllerOptions): void {
    validateOptions(options);
    if (options.revision !== undefined) {
      const revision = normalizeRevision(options.revision);
      if (revision < this.#revision) return;
      if (revision === this.#revision) {
        if (options.value !== this.#value) {
          throw new Error("equal controller revision cannot carry a different value");
        }
        this.#lastExternalValue = options.value;
        return;
      }
      this.#replaceExternal(options.value, revision, options.selection);
      return;
    }
    if (options.value === this.#value) {
      this.#lastExternalValue = options.value;
      return;
    }
    if (options.value === this.#lastExternalValue) return;
    if (this.#revision === MAX_U64) throw new RangeError("editing controller revision overflow");
    this.#replaceExternal(options.value, this.#revision + 1n, options.selection);
  }

  #replaceExternal(
    value: string,
    revision: bigint,
    selection: TextEditingControllerOptions["selection"],
  ): void {
    this.#value = value;
    this.#lastExternalValue = value;
    this.#revision = revision;
    this.#selection = selection ? { ...selection } : { anchor: value.length, focus: value.length };
  }
}

function validateOptions(options: TextEditingControllerOptions): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("editing controller options must be an object");
  }
  if (typeof options.value !== "string")
    throw new TypeError("editing controller value must be text");
  if (options.revision !== undefined) normalizeRevision(options.revision);
  if (options.selection !== undefined) validateSelection(options.value, options.selection);
}

function normalizeRevision(value: number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("editing controller revision must be a u64");
  }
  const revision = typeof value === "bigint" ? value : BigInt(value);
  if (revision < 0n || revision > MAX_U64)
    throw new RangeError("editing controller revision must be a u64");
  return revision;
}

function validateSelection(
  value: string,
  selection: { readonly anchor: number; readonly focus: number },
): void {
  for (const offset of [selection.anchor, selection.focus]) {
    if (!Number.isInteger(offset) || offset < 0 || offset > value.length) {
      throw new RangeError("editing controller selection is outside the value");
    }
    if (!isUtf16Boundary(value, offset)) {
      throw new RangeError("editing controller selection splits a surrogate pair");
    }
  }
}

function applyUtf16Replacement(
  value: string,
  start: number,
  end: number,
  replacement: string,
): string {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    end > value.length ||
    !isUtf16Boundary(value, start) ||
    !isUtf16Boundary(value, end)
  ) {
    throw new RangeError("edit transaction delta is outside the controller value");
  }
  return value.slice(0, start) + replacement + value.slice(end);
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const next = value.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
