/**
 * cva-lite: class-variance-authority for pingo-ui.
 *
 * Class emission order is deterministic: base, then variant axes in config
 * key order, then compound variants in array order. Empty strings contribute
 * nothing. Cascade precedence comes from stylesheet source order, never from
 * class position in the className string.
 */

export type CvaProps = Readonly<Record<string, string | boolean | undefined>>;

export interface CvaCompound {
  readonly when: CvaProps;
  readonly className: string;
}

export interface CvaConfig {
  readonly base?: string;
  readonly variants?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly compoundVariants?: readonly CvaCompound[];
  readonly defaultVariants?: CvaProps;
}

export function cva(config: CvaConfig): (props?: CvaProps) => string {
  const variants = config.variants ?? {};
  const defaults = config.defaultVariants ?? {};
  const compounds = config.compoundVariants ?? [];
  return (props = {}) => {
    const classes: string[] = [];
    if (config.base !== undefined && config.base !== "") classes.push(config.base);
    const resolved: Record<string, string | boolean | undefined> = {};
    for (const axis of Object.keys(variants)) {
      const value = props[axis] ?? defaults[axis];
      resolved[axis] = value;
      if (value === undefined || value === false) continue;
      const className = variants[axis]?.[String(value)];
      if (className !== undefined && className !== "") classes.push(className);
    }
    for (const compound of compounds) {
      const matches = Object.entries(compound.when).every(([axis, expected]) => {
        const actual = resolved[axis] ?? props[axis] ?? defaults[axis];
        return String(actual) === String(expected);
      });
      if (matches && compound.className !== "") classes.push(compound.className);
    }
    return classes.join(" ");
  };
}
