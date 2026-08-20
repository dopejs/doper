import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { format, resolveConfig } from "prettier";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(repositoryRoot, "schemas/style.v1.json");
const check = process.argv.includes("--check");
const schema = JSON.parse(await readFile(schemaPath, "utf8"));

const grammarTypes = {
  "align-items": '"baseline" | "center" | "flex-end" | "flex-start" | "stretch"',
  "border": "string",
  "border-style": '"none" | "solid"',
  "box-border-style": "string",
  "box-color-current": "string",
  "box-length-auto": "string | number",
  "box-non-negative-length": "string | number",
  "box-sizing": '"border-box" | "content-box"',
  "color": "PingoStyleColor",
  "color-current": 'PingoStyleColor | "currentColor"',
  "cursor":
    '"auto" | "crosshair" | "default" | "grab" | "grabbing" | "not-allowed" | "pointer" | "text"',
  "display": '"flex" | "none"',
  "flex-direction": '"column" | "column-reverse" | "row" | "row-reverse"',
  "font-family": "string",
  "font-style": '"italic" | "normal"',
  "font-weight": 'number | "bold" | "normal"',
  "justify-content":
    '"center" | "flex-end" | "flex-start" | "space-around" | "space-between" | "space-evenly"',
  "length": "PingoStyleLength",
  "length-auto": 'PingoStyleLength | "auto"',
  "length-none": 'PingoStyleLength | "none"',
  "line-height": 'number | PingoStyleLength | "normal"',
  "non-negative-length": "PingoStyleLength",
  "non-negative-length-normal": 'PingoStyleLength | "normal"',
  "object-fit": '"contain" | "cover" | "fill" | "none" | "scale-down"',
  "opacity": "number",
  "overflow": '"auto" | "clip" | "hidden" | "scroll" | "visible"',
  "overflow-wrap": '"anywhere" | "break-word" | "normal"',
  "overscroll-behavior": '"auto" | "contain" | "none"',
  "pair-non-negative-length-normal": "string | number",
  "pair-overflow": "string",
  "pointer-events": '"auto" | "none"',
  "position": "string",
  "positive-length": "PingoStyleLength",
  "text-align": '"center" | "end" | "justify" | "left" | "right" | "start"',
  "text-overflow": '"clip" | "ellipsis"',
  "touch-action": '"auto" | "manipulation" | "none" | "pan-x" | "pan-y"',
  "transform": "string",
  "visibility": '"hidden" | "visible"',
  "white-space": '"normal" | "nowrap" | "pre" | "pre-line" | "pre-wrap"',
};

validateSchema(schema);
const prettierConfig =
  (await resolveConfig(path.join(repositoryRoot, "packages/style/src/generated.ts"))) ?? {};
const typescriptOutput = await format(renderTypeScript(schema), {
  ...prettierConfig,
  parser: "typescript",
});
const rustOutput = renderRust(schema);
const documentationOutput = await format(renderDocumentation(schema), {
  ...prettierConfig,
  parser: "markdown",
});
const outputs = new Map([
  [path.join(repositoryRoot, "packages/style/src/generated.ts"), typescriptOutput],
  [path.join(repositoryRoot, "core/pingo-abi/src/style_generated.rs"), rustOutput],
  [path.join(repositoryRoot, "docs/style-support.md"), documentationOutput],
]);

let stale = false;
for (const [filename, contents] of outputs) {
  if (check) {
    const current = await readFile(filename, "utf8").catch(() => "");
    if (current !== contents) {
      console.error(`${path.relative(repositoryRoot, filename)} is stale; run pnpm style:generate`);
      stale = true;
    }
  } else {
    await writeFile(filename, contents);
  }
}
if (stale) process.exitCode = 1;

function validateSchema(value) {
  if (value.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/u.test(value.cssSubsetVersion)) {
    throw new Error("style schema must declare schemaVersion 1 and a semantic subset version");
  }
  if (value.propertyIdBits !== 16) throw new Error("style property ids must remain u16");
  if (
    !Array.isArray(value.reservedPropertyIds) ||
    value.reservedPropertyIds.some((id) => !Number.isInteger(id) || id < 1 || id > 0xffff) ||
    new Set(value.reservedPropertyIds).size !== value.reservedPropertyIds.length
  ) {
    throw new Error("reserved style property ids must be unique u16 values");
  }
  for (const reserved of value.reservedPropertyIds) {
    if (typeof value.reservedPropertyIdReasons?.[String(reserved)] !== "string") {
      throw new Error(
        `reserved style property id ${reserved} must explain why it cannot be reused`,
      );
    }
  }
  validateUniqueStrings(value.nodeTypes, "node type");
  validateUniqueStrings(value.invalidationDomains, "invalidation domain");
  validateUniqueStrings(value.animationTypes, "animation type");
  const nodes = new Set(value.nodeTypes);
  const domains = new Set(value.invalidationDomains);
  const animations = new Set(value.animationTypes);
  const featureNames = new Set();
  const featureBits = new Set();
  for (const feature of value.features) {
    if (!/^[a-z][a-z0-9-]*$/u.test(feature.name) || featureNames.has(feature.name)) {
      throw new Error(`invalid or duplicate style feature ${String(feature.name)}`);
    }
    if (!Number.isInteger(feature.bit) || feature.bit < 0 || feature.bit > 31) {
      throw new Error(`invalid feature bit for ${feature.name}`);
    }
    if (featureBits.has(feature.bit)) throw new Error(`duplicate style feature bit ${feature.bit}`);
    featureNames.add(feature.name);
    featureBits.add(feature.bit);
  }

  const ids = new Set();
  const cssNames = new Set();
  const jsNames = new Set();
  for (const property of value.properties) {
    if (!Number.isInteger(property.id) || property.id < 1 || property.id > 0xffff) {
      throw new Error(`invalid property id for ${String(property.jsName)}`);
    }
    if (ids.has(property.id)) throw new Error(`duplicate style property id ${property.id}`);
    validateCssName(property.cssName, "property");
    validateJsName(property.jsName, "property");
    if (cssNames.has(property.cssName) || jsNames.has(property.jsName)) {
      throw new Error(`duplicate style property ${property.cssName}/${property.jsName}`);
    }
    if (!(property.grammar in grammarTypes)) {
      throw new Error(`unknown grammar ${property.grammar} for ${property.jsName}`);
    }
    if (!animations.has(property.animation)) {
      throw new Error(`unknown animation type for ${property.jsName}`);
    }
    if (!featureNames.has(property.feature)) {
      throw new Error(`unknown feature for ${property.jsName}`);
    }
    validateSubset(property.appliesTo, nodes, `${property.jsName} appliesTo`);
    validateSubset(property.invalidation, domains, `${property.jsName} invalidation`);
    validateUniqueStrings(property.affects, `${property.jsName} affect`);
    if (typeof property.inherited !== "boolean" || typeof property.canonical !== "string") {
      throw new Error(`incomplete metadata for ${property.jsName}`);
    }
    ids.add(property.id);
    cssNames.add(property.cssName);
    jsNames.add(property.jsName);
  }
  for (const reserved of value.reservedPropertyIds) {
    if (ids.has(reserved)) throw new Error(`reserved style property id ${reserved} is in use`);
  }

  for (const shorthand of value.shorthands) {
    validateCssName(shorthand.cssName, "shorthand");
    validateJsName(shorthand.jsName, "shorthand");
    if (cssNames.has(shorthand.cssName) || jsNames.has(shorthand.jsName)) {
      throw new Error(`shorthand collides with a longhand: ${shorthand.jsName}`);
    }
    if (!(shorthand.grammar in grammarTypes)) {
      throw new Error(`unknown shorthand grammar ${shorthand.grammar}`);
    }
    validateUniqueStrings(shorthand.longhands, `${shorthand.jsName} longhand`);
    for (const longhand of shorthand.longhands) {
      if (!jsNames.has(longhand)) {
        throw new Error(`unknown ${shorthand.jsName} longhand ${longhand}`);
      }
    }
    cssNames.add(shorthand.cssName);
    jsNames.add(shorthand.jsName);
  }
}

function validateUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label}s must be non-empty`);
  const unique = new Set(values);
  if (unique.size !== values.length || values.some((value) => typeof value !== "string")) {
    throw new Error(`${label}s must be unique strings`);
  }
}

function validateSubset(values, allowed, label) {
  validateUniqueStrings(values, label);
  for (const value of values) {
    if (!allowed.has(value)) throw new Error(`unknown ${label} ${value}`);
  }
}

function validateCssName(name, label) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new Error(`invalid ${label} CSS name ${String(name)}`);
  }
}

function validateJsName(name, label) {
  if (typeof name !== "string" || !/^[a-z][A-Za-z0-9]*$/u.test(name)) {
    throw new Error(`invalid ${label} JS name ${String(name)}`);
  }
}

function renderTypeScript(value) {
  const maximumPropertyId = Math.max(
    ...value.properties.map((property) => property.id),
    ...value.reservedPropertyIds,
  );
  const nodeType = value.nodeTypes.map((node) => JSON.stringify(node)).join(" | ");
  const propertyFields = value.properties
    .map((property) => `  readonly ${property.jsName}?: ${styleDeclarationType(property.grammar)};`)
    .join("\n");
  const shorthandFields = value.shorthands
    .map(
      (shorthand) => `  readonly ${shorthand.jsName}?: ${styleDeclarationType(shorthand.grammar)};`,
    )
    .join("\n");
  const properties = value.properties
    .map(
      (property) =>
        `  ${JSON.stringify(property.jsName)}: ${JSON.stringify({
          id: property.id,
          cssName: property.cssName,
          jsName: property.jsName,
          initial: property.initial,
          inherited: property.inherited,
          grammar: property.grammar,
          canonical: property.canonical,
          invalidation: property.invalidation,
          animation: property.animation,
          appliesTo: property.appliesTo,
          feature: property.feature,
          affects: property.affects,
          percentageReference: property.percentageReference,
          engineSupport: "planned-m6-b",
        })},`,
    )
    .join("\n");
  const shorthands = value.shorthands
    .map((shorthand) => `  ${JSON.stringify(shorthand.jsName)}: ${JSON.stringify(shorthand)},`)
    .join("\n");
  const features = value.features
    .map((feature) => `  ${JSON.stringify(feature.name)}: ${2 ** feature.bit},`)
    .join("\n");
  const invalidationDomains = value.invalidationDomains
    .map((domain) => `  ${JSON.stringify(domain)},`)
    .join("\n");
  return `// @generated by scripts/generate-style.mjs. Do not edit.

export const CSS_SUBSET_VERSION = ${JSON.stringify(value.cssSubsetVersion)} as const;
export const STYLE_PROPERTY_MAX_ID = ${maximumPropertyId} as const;
export const STYLE_RESERVED_PROPERTY_IDS = ${JSON.stringify(value.reservedPropertyIds)} as const;
export type PingoStyleNodeType = ${nodeType};
export type PingoStyleLength = number | \`\${number}px\` | \`\${number}%\`;
export type PingoStyleColor = \`#\${string}\` | "transparent";
export type PingoGlobalStyleKeyword = "inherit" | "initial" | "unset";

/** Supported M6 declaration syntax. Shorthands are expanded in the Shell. */
export interface PingoStyle {
${propertyFields}
${shorthandFields}
}

export const STYLE_PROPERTIES = {
${properties}
} as const;

export const STYLE_SHORTHANDS = {
${shorthands}
} as const;

export const STYLE_FEATURE_BITS = {
${features}
} as const;

export const STYLE_INVALIDATION_DOMAINS = [
${invalidationDomains}
] as const;

export type StylePropertyName = keyof typeof STYLE_PROPERTIES;
export type StyleShorthandName = keyof typeof STYLE_SHORTHANDS;
export type StyleDeclarationName = keyof PingoStyle;
export type StylePropertyMetadata = (typeof STYLE_PROPERTIES)[StylePropertyName];
export type StyleInvalidationDomain = (typeof STYLE_INVALIDATION_DOMAINS)[number];
`;
}

function renderRust(value) {
  const maximumPropertyId = Math.max(
    ...value.properties.map((property) => property.id),
    ...value.reservedPropertyIds,
  );
  const variants = value.properties
    .map((property) => `    ${pascalCase(property.jsName)} = ${property.id},`)
    .join("\n");
  const fromId = value.properties
    .map((property) => `            ${property.id} => Some(Self::${pascalCase(property.jsName)}),`)
    .join("\n");
  const cssNames = value.properties
    .map(
      (property) =>
        `            Self::${pascalCase(property.jsName)} => ${JSON.stringify(property.cssName)},`,
    )
    .join("\n");
  const inherited = value.properties
    .map(
      (property) =>
        `            Self::${pascalCase(property.jsName)} => ${String(property.inherited)},`,
    )
    .join("\n");
  const invalidation = value.properties
    .map((property) => {
      const bits = property.invalidation.reduce(
        (mask, domain) => mask | (1 << value.invalidationDomains.indexOf(domain)),
        0,
      );
      return `            Self::${pascalCase(property.jsName)} => ${bits},`;
    })
    .join("\n");
  const grammarNames = [...new Set(value.properties.map((property) => property.grammar))];
  const canonicalNames = [...new Set(value.properties.map((property) => property.canonical))];
  const grammars = renderRustPlainEnum("StyleValueGrammar", grammarNames);
  const canonicals = renderRustPlainEnum("StyleCanonicalValue", canonicalNames);
  const animations = renderRustPlainEnum("StyleAnimationType", value.animationTypes);
  const nodeTypes = renderRustPlainEnum("StyleNodeType", value.nodeTypes);
  const grammarMatches = value.properties
    .map(
      (property) =>
        `            Self::${pascalCase(property.jsName)} => StyleValueGrammar::${pascalCase(property.grammar)},`,
    )
    .join("\n");
  const canonicalMatches = value.properties
    .map(
      (property) =>
        `            Self::${pascalCase(property.jsName)} => StyleCanonicalValue::${pascalCase(property.canonical)},`,
    )
    .join("\n");
  const animationMatches = value.properties
    .map(
      (property) =>
        `            Self::${pascalCase(property.jsName)} => StyleAnimationType::${pascalCase(property.animation)},`,
    )
    .join("\n");
  const appliesToMatches = value.properties
    .map((property) => {
      const bits = property.appliesTo.reduce(
        (mask, node) => mask | (1 << value.nodeTypes.indexOf(node)),
        0,
      );
      return `            Self::${pascalCase(property.jsName)} => ${bits},`;
    })
    .join("\n");
  const featureMatches = value.properties
    .map((property) => {
      const feature = value.features.find((candidate) => candidate.name === property.feature);
      return `            Self::${pascalCase(property.jsName)} => ${2 ** feature.bit},`;
    })
    .join("\n");
  const initialMatches = value.properties
    .map(
      (property) =>
        `            Self::${pascalCase(property.jsName)} => ${JSON.stringify(JSON.stringify(property.initial))},`,
    )
    .join("\n");
  const featureConstants = value.features
    .map(
      (feature) =>
        `pub const STYLE_FEATURE_${feature.name.replaceAll("-", "_").toUpperCase()}: u32 = ${2 ** feature.bit};`,
    )
    .join("\n");
  const invalidationConstants = value.invalidationDomains
    .map(
      (domain, bit) =>
        `pub const STYLE_INVALIDATION_${domain.replaceAll(/(?=[A-Z])/gu, "_").toUpperCase()}: u8 = ${2 ** bit};`,
    )
    .join("\n");
  const allFeatureBits = value.features.reduce((bits, feature) => bits | (2 ** feature.bit), 0);
  return `// @generated by scripts/generate-style.mjs. Do not edit.

pub const CSS_SUBSET_VERSION: &str = ${JSON.stringify(value.cssSubsetVersion)};
pub const STYLE_PROPERTY_COUNT: usize = ${value.properties.length};
pub const STYLE_PROPERTY_MAX_ID: u16 = ${maximumPropertyId};
pub const STYLE_RESERVED_PROPERTY_IDS: &[u16] = &[${value.reservedPropertyIds.join(", ")}];
pub const STYLE_ALL_FEATURE_BITS: u32 = ${allFeatureBits};
${featureConstants}
${invalidationConstants}

${nodeTypes}
${grammars}
${canonicals}
${animations}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum StyleProperty {
${variants}
}

impl StyleProperty {
    #[must_use]
    pub const fn from_u16(value: u16) -> Option<Self> {
        match value {
${fromId}
            _ => None,
        }
    }

    #[must_use]
    pub const fn css_name(self) -> &'static str {
        match self {
${cssNames}
        }
    }

    #[must_use]
    pub const fn inherited(self) -> bool {
        match self {
${inherited}
        }
    }

    #[must_use]
    pub const fn invalidation_bits(self) -> u8 {
        match self {
${invalidation}
        }
    }

    #[must_use]
    pub const fn grammar(self) -> StyleValueGrammar {
        match self {
${grammarMatches}
        }
    }

    #[must_use]
    pub const fn canonical_value(self) -> StyleCanonicalValue {
        match self {
${canonicalMatches}
        }
    }

    #[must_use]
    pub const fn animation_type(self) -> StyleAnimationType {
        match self {
${animationMatches}
        }
    }

    #[must_use]
    pub const fn applies_to_bits(self) -> u8 {
        match self {
${appliesToMatches}
        }
    }

    #[must_use]
    pub const fn feature_bits(self) -> u32 {
        match self {
${featureMatches}
        }
    }

    #[must_use]
    pub const fn initial_json(self) -> &'static str {
        match self {
${initialMatches}
        }
    }
}
`;
}

function renderDocumentation(value) {
  const rows = value.properties
    .map(
      (property) =>
        `| \`${property.cssName}\` | \`${property.jsName}\` | \`${property.grammar}\` | ${property.inherited ? "yes" : "no"} | ${property.invalidation.join(", ")} | ${property.animation} | Resolver only; Core planned for M6-B |`,
    )
    .join("\n");
  return `<!-- @generated by scripts/generate-style.mjs. Do not edit. -->
# CSS subset support

Subset version: **${value.cssSubsetVersion}**

M6-A parses and computes the declarations below. This table does not claim that the current
Core consumes them yet; engine integration is an M6-B exit condition.

| CSS property | TypeScript name | grammar | inherited | invalidation | animation | engine status |
| --- | --- | --- | --- | --- | --- | --- |
${rows}
`;
}

function pascalCase(value) {
  return value
    .split(/[-_]/u)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function renderRustPlainEnum(name, entries) {
  const variants = entries.map((entry) => `    ${pascalCase(entry)},`).join("\n");
  return `#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ${name} {
${variants}
}`;
}

function styleDeclarationType(grammar) {
  const base = grammarTypes[grammar];
  return /\bstring\b/u.test(base) ? base : `${base} | PingoGlobalStyleKeyword`;
}
