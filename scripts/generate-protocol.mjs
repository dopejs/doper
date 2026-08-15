import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { format } from "prettier";

const root = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(root, "schemas/protocol.v1.json");
const check = process.argv.includes("--check");

const schema = JSON.parse(await readFile(schemaPath, "utf8"));
validateSchema(schema);
const typeScriptOutput = await format(renderTypeScript(schema), { parser: "typescript" });

const outputs = new Map([
  [path.join(root, "core/doper-abi/src/generated.rs"), renderRust(schema).replace(/\n+$/u, "\n")],
  [path.join(root, "packages/reconciler/src/generated.ts"), typeScriptOutput],
  [path.join(root, "packages/editing/src/generated.ts"), typeScriptOutput],
  [path.join(root, "packages/backend-canvas2d/src/generated.ts"), typeScriptOutput],
  [path.join(root, "packages/host/src/generated.ts"), typeScriptOutput],
]);

let stale = false;
for (const [file, contents] of outputs) {
  if (check) {
    const current = await readFile(file, "utf8").catch(() => "");
    if (current !== contents) {
      console.error(`${path.relative(root, file)} is stale; run pnpm protocol:generate`);
      stale = true;
    }
  } else {
    await writeFile(file, contents);
  }
}

if (stale) process.exitCode = 1;

function validateSchema(value) {
  if (value.schemaVersion !== 1 || value.abiVersion !== 1) {
    throw new Error("unsupported protocol schema or ABI version");
  }
  if (value.endianness !== "little" || value.alignment !== 4) {
    throw new Error("protocol must remain little-endian and four-byte aligned");
  }
  if (
    !Number.isInteger(value.nodeId.indexBits) ||
    !Number.isInteger(value.nodeId.generationBits) ||
    value.nodeId.indexBits + value.nodeId.generationBits !== 32 ||
    value.nodeId.indexBits < 1 ||
    value.nodeId.generationBits < 1 ||
    value.nodeId.null !== 0xffff_ffff
  ) {
    throw new Error("NodeId must partition 32 bits and reserve u32::MAX as null");
  }
  validateNamedFields(value.streamHeader, "stream header");
  validateNamedFields(value.instructionHeader, "instruction header");
  validateNamedFields(value.recordHeader, "record header");
  if (wireSize(value.streamHeader.map((field) => field.type)) !== 16) {
    throw new Error("stream header must remain 16 bytes in ABI v1");
  }
  if (wireSize(value.instructionHeader.map((field) => field.type)) !== 4) {
    throw new Error("instruction header must remain 4 bytes in ABI v1");
  }
  if (wireSize(value.recordHeader.map((field) => field.type)) !== 8) {
    throw new Error("record header must remain 8 bytes in ABI v1");
  }
  for (const limit of [
    "resourceBytes",
    "mutationInstructions",
    "inputInstructions",
    "displayInstructions",
    "recordingRecords",
  ]) {
    if (!Number.isInteger(value.limits[limit]) || value.limits[limit] <= 0) {
      throw new Error(`${limit} must be a positive integer`);
    }
  }
  validateEntries(value.streams.mutation.commands, "mutation opcode", 0xff);
  validateEntries(value.streams.input.commands, "input opcode", 0xff);
  validateEntries(value.streams.displayList.commands, "display-list opcode", 0xff);
  validateEntries(value.nodeKinds, "node kind", 0xffff);
  validateEntries(value.resourceKinds, "resource kind", 0xffff);
  validateEntries(value.props, "prop", 0xffff);
  validateEntries(value.recording.recordKinds, "record kind", 0xff);
  if (!Number.isInteger(value.recording.maxBytes) || value.recording.maxBytes <= 0) {
    throw new Error("recording maxBytes must be a positive integer");
  }
  if (
    !Number.isInteger(value.frameDiagnostics.version) ||
    value.frameDiagnostics.version < 1 ||
    value.frameDiagnostics.version > 0xffff_ffff
  ) {
    throw new Error("frame diagnostics must declare a positive u32 encoding version");
  }
  validateNamedFields(value.frameDiagnostics.fields, "frame diagnostics");
  if (
    value.frameDiagnostics.fields.length === 0 ||
    value.frameDiagnostics.fields.some((field) => field.type !== "u32")
  ) {
    throw new Error("frame diagnostics must be a non-empty packed u32 array");
  }

  const domains = new Set(["layout", "paint", "paintSelf", "hit", "semantics"]);
  const valueTypes = new Set(["f32", "vec4", "ref"]);
  const resourceKinds = new Set(value.resourceKinds.map((kind) => kind.name));
  if (value.resourceLayouts.version !== 1 || !Array.isArray(value.resourceLayouts.layouts)) {
    throw new Error("resource layouts must declare encoding version 1");
  }
  const resourceLayoutNames = new Set();
  const resourceLayoutVariants = new Set();
  for (const layout of value.resourceLayouts.layouts) {
    if (!/^[A-Z][A-Za-z0-9]*$/u.test(layout.name) || resourceLayoutNames.has(layout.name)) {
      throw new Error(`invalid or duplicate resource layout ${String(layout.name)}`);
    }
    if (!resourceKinds.has(layout.resourceKind)) {
      throw new Error(`unknown resource kind for layout ${layout.name}`);
    }
    if (!Number.isInteger(layout.variant) || layout.variant < 1 || layout.variant > 0xff) {
      throw new Error(`invalid resource variant for layout ${layout.name}`);
    }
    const variantKey = `${layout.resourceKind}:${String(layout.variant)}`;
    if (resourceLayoutVariants.has(variantKey)) {
      throw new Error(`duplicate resource variant ${variantKey}`);
    }
    resourceLayoutNames.add(layout.name);
    resourceLayoutVariants.add(variantKey);
    validateNamedFields(layout.fields, `${layout.name} resource`);
  }
  for (const prop of value.props) {
    if (!valueTypes.has(prop.valueType)) throw new Error(`unknown value type for ${prop.name}`);
    if (!Array.isArray(prop.invalidation)) {
      throw new Error(`prop ${prop.name} must declare invalidation metadata`);
    }
    for (const domain of prop.invalidation) {
      if (!domains.has(domain)) throw new Error(`unknown invalidation domain ${domain}`);
    }
    if (prop.resourceKind !== undefined) {
      if (prop.valueType !== "ref" || !resourceKinds.has(prop.resourceKind)) {
        throw new Error(`invalid resource kind for ${prop.name}`);
      }
    }
  }

  for (const command of [
    ...value.streams.mutation.commands,
    ...value.streams.input.commands,
    ...value.streams.displayList.commands,
  ]) {
    validateNamedFields(command.fields, command.name);
  }
}

function validateEntries(entries, label, max) {
  const names = new Set();
  const ids = new Set();
  for (const entry of entries) {
    const id = entry.opcode ?? entry.id;
    if (!/^[A-Z][A-Za-z0-9]*$/u.test(entry.name)) {
      throw new Error(`invalid ${label} name ${entry.name}`);
    }
    if (!Number.isInteger(id) || id < 0 || id > max) {
      throw new Error(`invalid ${label} id for ${entry.name}`);
    }
    if (names.has(entry.name) || ids.has(id)) throw new Error(`duplicate ${label} ${entry.name}`);
    names.add(entry.name);
    ids.add(id);
  }
}

function validateNamedFields(fields, label) {
  if (!Array.isArray(fields)) throw new Error(`${label} fields must be an array`);
  const names = new Set();
  for (const field of fields) {
    if (typeof field === "string") continue;
    if (!/^[a-z][A-Za-z0-9]*$/u.test(field.name) || names.has(field.name)) {
      throw new Error(`invalid or duplicate ${label} field ${String(field.name)}`);
    }
    names.add(field.name);
  }
  const types = fields.map((field) => (typeof field === "string" ? field : field.type));
  const variableIndex = types.indexOf("bytes");
  if (variableIndex >= 0) {
    if (types.lastIndexOf("bytes") !== variableIndex || types[variableIndex + 1] !== "align4") {
      throw new Error(`${label} variable bytes must occur once and be followed by align4`);
    }
    if (variableIndex + 2 !== types.length) {
      throw new Error(`${label} cannot contain fields after variable byte alignment`);
    }
  } else if (types.includes("align4")) {
    throw new Error(`${label} align4 requires a preceding bytes field`);
  }
  wireSize(types);
}

function wireSize(types) {
  const sizes = { u8: 1, u16: 2, pad16: 2, u32: 4, f32: 4, bytes: 0, align4: 0 };
  return types.reduce((total, type) => {
    const size = sizes[type];
    if (size === undefined) throw new Error(`unknown wire field type ${String(type)}`);
    return total + size;
  }, 0);
}

function commandLayout(command, instructionHeaderBytes) {
  const types = command.fields.map((field) => (typeof field === "string" ? field : field.type));
  const variable = types.includes("bytes");
  const minimumBytes = instructionHeaderBytes + wireSize(types);
  return { fixedBytes: variable ? null : minimumBytes, minimumBytes };
}

function namedFieldOffsets(fields) {
  let offset = 0;
  const result = [];
  for (const field of fields) {
    const type = typeof field === "string" ? field : field.type;
    if (typeof field !== "string") result.push({ name: field.name, offset });
    offset += wireSize([type]);
  }
  return result;
}

function renderRust(value) {
  const streamHeaderBytes = wireSize(value.streamHeader.map((field) => field.type));
  const instructionHeaderBytes = wireSize(value.instructionHeader.map((field) => field.type));
  const recordHeaderBytes = wireSize(value.recordHeader.map((field) => field.type));
  const propMasks = value.props
    .map((prop) => {
      const mask = prop.invalidation.reduce(
        (result, domain) =>
          result | { layout: 1, paint: 2, paintSelf: 4, hit: 8, semantics: 16 }[domain],
        0,
      );
      return `            Self::${prop.name} => Invalidation::from_bits(${mask}),`;
    })
    .join("\n");
  const propTypes = value.props
    .map((prop) => {
      const type = { f32: "F32", vec4: "Vec4", ref: "Ref" }[prop.valueType];
      return `            Self::${prop.name} => PropValueType::${type},`;
    })
    .join("\n");
  const propResourceKinds = value.props
    .map(
      (prop) =>
        `            Self::${prop.name} => ${prop.resourceKind === undefined ? "None" : `Some(ResourceKind::${prop.resourceKind})`},`,
    )
    .join("\n");

  return `// @generated by scripts/generate-protocol.mjs. Do not edit.\n\npub const ABI_VERSION: u16 = ${value.abiVersion};\npub const PROTOCOL_ALIGNMENT: usize = ${value.alignment};\npub const STREAM_HEADER_BYTES: usize = ${streamHeaderBytes};\npub const INSTRUCTION_HEADER_BYTES: usize = ${instructionHeaderBytes};\npub const RECORD_HEADER_BYTES: usize = ${recordHeaderBytes};\npub const NODE_ID_INDEX_BITS: u32 = ${value.nodeId.indexBits};\npub const NODE_ID_GENERATION_BITS: u32 = ${value.nodeId.generationBits};\npub const NULL_NODE_ID: u32 = ${value.nodeId.null};\npub const MUTATION_MAGIC: u32 = ${magicNumber(value.streams.mutation.magic)};\npub const INPUT_MAGIC: u32 = ${magicNumber(value.streams.input.magic)};\npub const DISPLAY_LIST_MAGIC: u32 = ${magicNumber(value.streams.displayList.magic)};\npub const RECORDING_MAGIC: u32 = ${magicNumber(value.recording.magic)};\npub const MAX_MUTATION_BYTES: usize = ${value.streams.mutation.maxBytes};\npub const MAX_INPUT_BYTES: usize = ${value.streams.input.maxBytes};\npub const MAX_DISPLAY_LIST_BYTES: usize = ${value.streams.displayList.maxBytes};\npub const MAX_RECORDING_BYTES: usize = ${value.recording.maxBytes};\npub const MAX_RESOURCE_BYTES: usize = ${value.limits.resourceBytes};\npub const MAX_MUTATION_INSTRUCTIONS: u32 = ${value.limits.mutationInstructions};\npub const MAX_INPUT_INSTRUCTIONS: u32 = ${value.limits.inputInstructions};\npub const MAX_DISPLAY_INSTRUCTIONS: u32 = ${value.limits.displayInstructions};\npub const MAX_RECORDING_RECORDS: u32 = ${value.limits.recordingRecords};\n${renderRustPackedU32Layout("FRAME_DIAGNOSTICS", value.frameDiagnostics)}\n${renderRustResourceLayouts(value.resourceLayouts)}\n${renderRustEnum("RecordingRecordKind", value.recording.recordKinds, "u8", "id")}${renderRustEnum("MutationOpcode", value.streams.mutation.commands, "u8", "opcode")}${renderRustLayouts("MutationOpcode", value.streams.mutation.commands, instructionHeaderBytes)}${renderRustEnum("InputOpcode", value.streams.input.commands, "u8", "opcode")}${renderRustLayouts("InputOpcode", value.streams.input.commands, instructionHeaderBytes)}${renderRustEnum("DisplayOpcode", value.streams.displayList.commands, "u8", "opcode")}${renderRustLayouts("DisplayOpcode", value.streams.displayList.commands, instructionHeaderBytes)}${renderRustEnum("NodeKind", value.nodeKinds, "u16", "id")}${renderRustEnum("ResourceKind", value.resourceKinds, "u16", "id")}${renderRustEnum("Prop", value.props, "u16", "id")}impl Prop {\n    #[must_use]\n    pub const fn invalidation(self) -> Invalidation {\n        match self {\n${propMasks}\n        }\n    }\n\n    #[must_use]\n    pub const fn value_type(self) -> PropValueType {\n        match self {\n${propTypes}\n        }\n    }\n\n    #[must_use]\n    pub const fn resource_kind(self) -> Option<ResourceKind> {\n        match self {\n${propResourceKinds}\n        }\n    }\n}\n\n`;
}

function renderRustPackedU32Layout(prefix, layout) {
  const offsets = layout.fields
    .map(
      (field, index) =>
        `pub const ${prefix}_${screamingSnake(field.name)}_INDEX: usize = ${index};`,
    )
    .join("\n");
  return `pub const ${prefix}_VERSION: u32 = ${layout.version};\npub const ${prefix}_WORDS: usize = ${layout.fields.length};\n${offsets}`;
}

function renderRustResourceLayouts(resourceLayouts) {
  const constants = resourceLayouts.layouts
    .map((layout) => {
      const { fixedBytes, minimumBytes } = commandLayout(layout, 0);
      const name = screamingSnake(layout.name);
      const offsets = namedFieldOffsets(layout.fields)
        .map(
          (field) =>
            `pub const ${name}_${screamingSnake(field.name)}_OFFSET: usize = ${field.offset};`,
        )
        .join("\n");
      return `pub const ${name}_RESOURCE_VARIANT: u8 = ${layout.variant};\npub const ${name}_RESOURCE_FIXED_BYTES: Option<usize> = ${fixedBytes === null ? "None" : `Some(${fixedBytes})`};\npub const ${name}_RESOURCE_MINIMUM_BYTES: usize = ${minimumBytes};\n${offsets}`;
    })
    .join("\n");
  return `pub const RESOURCE_ENCODING_VERSION: u8 = ${resourceLayouts.version};\n${constants}\n`;
}

function renderRustEnum(name, entries, repr, key) {
  const variants = entries.map((entry) => `    ${entry.name} = ${entry[key]},`).join("\n");
  const cases = entries
    .map((entry) => `            ${entry[key]} => Some(Self::${entry.name}),`)
    .join("\n");
  return `#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]\n#[repr(${repr})]\npub enum ${name} {\n${variants}\n}\n\nimpl ${name} {\n    #[must_use]\n    pub const fn from_${repr}(value: ${repr}) -> Option<Self> {\n        match value {\n${cases}\n            _ => None,\n        }\n    }\n}\n\n`;
}

function renderRustLayouts(name, entries, instructionHeaderBytes) {
  const fixedCases = entries
    .map((entry) => {
      const { fixedBytes } = commandLayout(entry, instructionHeaderBytes);
      return `            Self::${entry.name} => ${fixedBytes === null ? "None" : `Some(${fixedBytes})`},`;
    })
    .join("\n");
  const minimumCases = entries
    .map((entry) => {
      const { minimumBytes } = commandLayout(entry, instructionHeaderBytes);
      return `            Self::${entry.name} => ${minimumBytes},`;
    })
    .join("\n");
  return `impl ${name} {\n    #[must_use]\n    pub const fn fixed_bytes(self) -> Option<usize> {\n        match self {\n${fixedCases}\n        }\n    }\n\n    #[must_use]\n    pub const fn minimum_bytes(self) -> usize {\n        match self {\n${minimumCases}\n        }\n    }\n}\n\n`;
}

function renderTypeScript(value) {
  const streamHeaderBytes = wireSize(value.streamHeader.map((field) => field.type));
  const instructionHeaderBytes = wireSize(value.instructionHeader.map((field) => field.type));
  const recordHeaderBytes = wireSize(value.recordHeader.map((field) => field.type));
  const domains = { layout: 1, paint: 2, paintSelf: 4, hit: 8, semantics: 16 };
  const props = value.props
    .map((prop) => {
      const mask = prop.invalidation.reduce((result, domain) => result | domains[domain], 0);
      return `  ${prop.id}: { name: "${prop.name}", valueType: "${prop.valueType}", resourceKind: ${prop.resourceKind === undefined ? "null" : `ResourceKind.${prop.resourceKind}`}, invalidation: ${mask} },`;
    })
    .join("\n");
  return `// @generated by scripts/generate-protocol.mjs. Do not edit.\n\nexport const ABI_VERSION = ${value.abiVersion} as const;\nexport const PROTOCOL_ALIGNMENT = ${value.alignment} as const;\nexport const STREAM_HEADER_BYTES = ${streamHeaderBytes} as const;\nexport const INSTRUCTION_HEADER_BYTES = ${instructionHeaderBytes} as const;\nexport const RECORD_HEADER_BYTES = ${recordHeaderBytes} as const;\nexport const NODE_ID_INDEX_BITS = ${value.nodeId.indexBits} as const;\nexport const NODE_ID_GENERATION_BITS = ${value.nodeId.generationBits} as const;\nexport const NULL_NODE_ID = ${value.nodeId.null} as const;\nexport const MUTATION_MAGIC = ${magicNumber(value.streams.mutation.magic)} as const;\nexport const INPUT_MAGIC = ${magicNumber(value.streams.input.magic)} as const;\nexport const DISPLAY_LIST_MAGIC = ${magicNumber(value.streams.displayList.magic)} as const;\nexport const RECORDING_MAGIC = ${magicNumber(value.recording.magic)} as const;\nexport const MAX_MUTATION_BYTES = ${value.streams.mutation.maxBytes} as const;\nexport const MAX_INPUT_BYTES = ${value.streams.input.maxBytes} as const;\nexport const MAX_DISPLAY_LIST_BYTES = ${value.streams.displayList.maxBytes} as const;\nexport const MAX_RECORDING_BYTES = ${value.recording.maxBytes} as const;\nexport const MAX_RESOURCE_BYTES = ${value.limits.resourceBytes} as const;\nexport const MAX_MUTATION_INSTRUCTIONS = ${value.limits.mutationInstructions} as const;\nexport const MAX_INPUT_INSTRUCTIONS = ${value.limits.inputInstructions} as const;\nexport const MAX_DISPLAY_INSTRUCTIONS = ${value.limits.displayInstructions} as const;\nexport const MAX_RECORDING_RECORDS = ${value.limits.recordingRecords} as const;\n${renderTsPackedU32Layout("FRAME_DIAGNOSTICS", value.frameDiagnostics)}\n${renderTsResourceLayouts(value.resourceLayouts)}\n${renderTsEnum("RecordingRecordKind", value.recording.recordKinds, "id")}${renderTsEnum("MutationOpcode", value.streams.mutation.commands, "opcode")}${renderTsLayouts("MUTATION_LAYOUTS", "MutationOpcode", value.streams.mutation.commands, instructionHeaderBytes)}${renderTsEnum("InputOpcode", value.streams.input.commands, "opcode")}${renderTsLayouts("INPUT_LAYOUTS", "InputOpcode", value.streams.input.commands, instructionHeaderBytes)}${renderTsEnum("DisplayOpcode", value.streams.displayList.commands, "opcode")}${renderTsLayouts("DISPLAY_LAYOUTS", "DisplayOpcode", value.streams.displayList.commands, instructionHeaderBytes)}${renderTsEnum("NodeKind", value.nodeKinds, "id")}${renderTsEnum("ResourceKind", value.resourceKinds, "id")}${renderTsEnum("Prop", value.props, "id")}export const enum Invalidation {\n  None = 0,\n  Layout = 1,\n  Paint = 2,\n  PaintSelf = 4,\n  Hit = 8,\n  Semantics = 16,\n}\n\nexport const PROP_METADATA = {\n${props}\n} as const;\n`;
}

function renderTsPackedU32Layout(prefix, layout) {
  const offsets = layout.fields
    .map(
      (field, index) =>
        `export const ${prefix}_${screamingSnake(field.name)}_INDEX = ${index} as const;`,
    )
    .join("\n");
  return `export const ${prefix}_VERSION = ${layout.version} as const;\nexport const ${prefix}_WORDS = ${layout.fields.length} as const;\n${offsets}`;
}

function renderTsResourceLayouts(resourceLayouts) {
  const constants = resourceLayouts.layouts
    .map((layout) => {
      const { fixedBytes, minimumBytes } = commandLayout(layout, 0);
      const name = screamingSnake(layout.name);
      const offsets = namedFieldOffsets(layout.fields)
        .map(
          (field) =>
            `export const ${name}_${screamingSnake(field.name)}_OFFSET = ${field.offset} as const;`,
        )
        .join("\n");
      const fixed = fixedBytes === null ? "null" : `${fixedBytes} as const`;
      return `export const ${name}_RESOURCE_VARIANT = ${layout.variant} as const;\nexport const ${name}_RESOURCE_FIXED_BYTES = ${fixed};\nexport const ${name}_RESOURCE_MINIMUM_BYTES = ${minimumBytes} as const;\n${offsets}`;
    })
    .join("\n");
  return `export const RESOURCE_ENCODING_VERSION = ${resourceLayouts.version} as const;\n${constants}\n`;
}

function renderTsEnum(name, entries, key) {
  const variants = entries.map((entry) => `  ${entry.name} = ${entry[key]},`).join("\n");
  return `export enum ${name} {\n${variants}\n}\n\n`;
}

function renderTsLayouts(constantName, enumName, entries, instructionHeaderBytes) {
  const layouts = entries
    .map((entry) => {
      const layout = commandLayout(entry, instructionHeaderBytes);
      return `  [${enumName}.${entry.name}]: { fixedBytes: ${layout.fixedBytes === null ? "null" : layout.fixedBytes}, minimumBytes: ${layout.minimumBytes} },`;
    })
    .join("\n");
  return `export const ${constantName} = {\n${layouts}\n} as const;\n\n`;
}

function magicNumber(magic) {
  if (!/^[\x20-\x7e]{4}$/u.test(magic)) throw new Error(`invalid magic ${magic}`);
  return (
    (magic.charCodeAt(0) |
      (magic.charCodeAt(1) << 8) |
      (magic.charCodeAt(2) << 16) |
      (magic.charCodeAt(3) << 24)) >>>
    0
  );
}

function screamingSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toUpperCase();
}
