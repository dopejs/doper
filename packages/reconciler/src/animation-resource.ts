import type {
  AnimatedProperty,
  AnimationEasing,
  KeyframeAnimationSpec,
  TransitionSpec,
} from "@dopejs/pingo-jsx";

const HEADER_BYTES = 8;
const TRANSITION_BYTES = 28;
const KEYFRAME_HEADER_BYTES = 40;
const MAX_RESOURCE_BYTES = 65_536;

/** Encodes the versioned immutable M7 animation resource. */
export function encodeAnimationResource(
  transition: TransitionSpec | readonly TransitionSpec[] | undefined,
  animation: KeyframeAnimationSpec | readonly KeyframeAnimationSpec[] | undefined,
): Uint8Array | undefined {
  const transitions = list(transition);
  const animations = list(animation);
  if (transitions.length === 0 && animations.length === 0) return;
  if (transitions.length > 2 || animations.length > 2) {
    throw new RangeError("at most two transition and two animation tracks are supported");
  }
  assertUnique(
    transitions.map((item) => item.property),
    "transition",
  );
  assertUnique(
    animations.map((item) => item.property),
    "animation",
  );
  let byteLength = HEADER_BYTES + transitions.length * TRANSITION_BYTES;
  for (const item of animations) {
    validateKeyframes(item);
    byteLength +=
      KEYFRAME_HEADER_BYTES + item.keyframes.length * (item.property === "opacity" ? 8 : 28);
  }
  if (byteLength > MAX_RESOURCE_BYTES)
    throw new RangeError("animation resource exceeds byte budget");
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = transitions.length;
  bytes[2] = animations.length;
  view.setUint32(4, byteLength, true);
  let offset = HEADER_BYTES;
  for (const item of transitions) {
    bytes[offset] = propertyId(item.property);
    const easing = encodeEasing(item.easing);
    bytes[offset + 1] = easing.kind;
    bytes[offset + 2] = easing.stepPosition;
    view.setUint32(offset + 4, milliseconds(item.durationMs, false), true);
    view.setInt32(offset + 8, milliseconds(item.delayMs ?? 0, true), true);
    writeParameters(view, offset + 12, easing.parameters);
    offset += TRANSITION_BYTES;
  }
  for (const item of animations) {
    bytes[offset] = propertyId(item.property);
    const easing = encodeEasing(item.easing);
    bytes[offset + 1] = easing.kind;
    bytes[offset + 2] = directionId(item.direction ?? "normal");
    bytes[offset + 3] = fillId(item.fill ?? "none");
    bytes[offset + 4] = item.playState === "paused" ? 1 : 0;
    bytes[offset + 5] = easing.stepPosition;
    view.setUint32(offset + 8, milliseconds(item.durationMs, false), true);
    view.setInt32(offset + 12, milliseconds(item.delayMs ?? 0, true), true);
    const iterations = item.iterations ?? 1;
    if (!Number.isFinite(iterations) || iterations < 0 || iterations > 1_000_000) {
      throw new RangeError("animation iterations are invalid");
    }
    view.setFloat32(offset + 16, iterations, true);
    view.setUint16(offset + 20, item.keyframes.length, true);
    writeParameters(view, offset + 24, easing.parameters);
    offset += KEYFRAME_HEADER_BYTES;
    for (const frame of item.keyframes) {
      view.setFloat32(offset, frame.offset, true);
      if (item.property === "opacity") {
        if (typeof frame.value !== "number" || frame.value < 0 || frame.value > 1) {
          throw new RangeError("opacity keyframe value must be between zero and one");
        }
        view.setFloat32(offset + 4, frame.value, true);
        offset += 8;
      } else {
        if (typeof frame.value === "number" || frame.value.length !== 6) {
          throw new TypeError("transform keyframe value must be an affine matrix");
        }
        frame.value.forEach((value, index) => {
          finite(value, "transform keyframe value");
          view.setFloat32(offset + 4 + index * 4, value, true);
        });
        offset += 28;
      }
    }
  }
  return bytes;
}

function list<T>(value: T | readonly T[] | undefined): readonly T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

function validateKeyframes(item: KeyframeAnimationSpec): void {
  if (item.keyframes.length < 2 || item.keyframes.length > 256) {
    throw new RangeError("animation requires between two and 256 keyframes");
  }
  let previous = -1;
  item.keyframes.forEach((frame, index) => {
    finite(frame.offset, "keyframe offset");
    if (frame.offset < 0 || frame.offset > 1 || frame.offset <= previous) {
      throw new RangeError("keyframe offsets must ascend uniquely from zero to one");
    }
    if (
      (index === 0 && frame.offset !== 0) ||
      (index === item.keyframes.length - 1 && frame.offset !== 1)
    ) {
      throw new RangeError("keyframe tracks must include zero and one endpoints");
    }
    previous = frame.offset;
  });
}

function milliseconds(value: number, signed: boolean): number {
  finite(value, "animation time");
  const micros = Math.round(value * 1_000);
  const minimum = signed ? -2_147_483_648 : 0;
  const maximum = signed ? 2_147_483_647 : 4_294_967_295;
  if (!Number.isSafeInteger(micros) || micros < minimum || micros > maximum) {
    throw new RangeError("animation time is outside the encoded range");
  }
  return micros;
}

function encodeEasing(value: AnimationEasing | undefined): {
  readonly kind: number;
  readonly stepPosition: number;
  readonly parameters: readonly [number, number, number, number];
} {
  const zero = [0, 0, 0, 0] as const;
  if (value === undefined || value === "ease")
    return { kind: 1, stepPosition: 0, parameters: zero };
  const presets = { "linear": 0, "ease-in": 2, "ease-out": 3, "ease-in-out": 4 } as const;
  if (typeof value === "string") return { kind: presets[value], stepPosition: 0, parameters: zero };
  if ("cubicBezier" in value) {
    const [x1, y1, x2, y2] = value.cubicBezier;
    value.cubicBezier.forEach((item) => finite(item, "cubic-bezier parameter"));
    if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1)
      throw new RangeError("cubic-bezier x values must be in range");
    return { kind: 5, stepPosition: 0, parameters: [x1, y1, x2, y2] };
  }
  if (!Number.isInteger(value.steps) || value.steps < 1 || value.steps > 1_000_000) {
    throw new RangeError("steps count is invalid");
  }
  return {
    kind: 6,
    stepPosition: value.position === "start" ? 1 : 0,
    parameters: [value.steps, 0, 0, 0],
  };
}

function writeParameters(view: DataView, offset: number, values: readonly number[]): void {
  values.forEach((value, index) => view.setFloat32(offset + index * 4, value, true));
}

function propertyId(property: AnimatedProperty): number {
  return property === "opacity" ? 1 : 2;
}
function directionId(value: NonNullable<KeyframeAnimationSpec["direction"]>): number {
  return ["normal", "reverse", "alternate", "alternate-reverse"].indexOf(value);
}
function fillId(value: NonNullable<KeyframeAnimationSpec["fill"]>): number {
  return ["none", "forwards", "backwards", "both"].indexOf(value);
}
function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`duplicate ${label} property`);
}
function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}
