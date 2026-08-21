use crate::codec::{
    Reader, Writer, checked_padding, finish_instruction, read_header, read_instruction_header,
    validate_encode_instruction_count,
};
use crate::{
    AbiError, INPUT_MAGIC, InputOpcode, MAX_INPUT_BYTES, MAX_INPUT_INSTRUCTIONS,
    MAX_KEYBOARD_CODE_ID, MAX_KEYBOARD_KEY_NAME_ID, MAX_RESOURCE_BYTES, MAX_WORD_BOUNDARIES,
    StreamKind,
};

/// Visual edge preference carried at the browser UTF-16 boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum InputAffinity {
    /// Prefer the preceding grapheme or line edge.
    Upstream = 0,
    /// Prefer the following grapheme or line edge.
    Downstream = 1,
}

impl InputAffinity {
    fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            0 => Ok(Self::Upstream),
            1 => Ok(Self::Downstream),
            _ => Err(AbiError::UnknownIdentifier {
                category: "input affinity",
                value: u32::from(value),
            }),
        }
    }
}

/// Caret movement direction shared by keyboard navigation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum CaretDirection {
    /// Toward the preceding boundary.
    Backward = 1,
    /// Toward the following boundary.
    Forward = 2,
    /// One visual line up, preserving the desired column.
    Up = 3,
    /// One visual line down, preserving the desired column.
    Down = 4,
    /// Start of the current visual line.
    LineStart = 5,
    /// End of the current visual line.
    LineEnd = 6,
}

impl CaretDirection {
    fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            1 => Ok(Self::Backward),
            2 => Ok(Self::Forward),
            3 => Ok(Self::Up),
            4 => Ok(Self::Down),
            5 => Ok(Self::LineStart),
            6 => Ok(Self::LineEnd),
            _ => Err(AbiError::UnknownIdentifier {
                category: "caret direction",
                value: u32::from(value),
            }),
        }
    }
}

/// Caret movement granularity for horizontal directions.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum CaretGranularity {
    /// One grapheme cluster.
    Grapheme = 0,
    /// One Unicode word.
    Word = 1,
}

impl CaretGranularity {
    fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            0 => Ok(Self::Grapheme),
            1 => Ok(Self::Word),
            _ => Err(AbiError::UnknownIdentifier {
                category: "caret granularity",
                value: u32::from(value),
            }),
        }
    }
}

/// One UTF-16 input position and its visual affinity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputPosition {
    /// UTF-16 code-unit offset.
    pub offset: u32,
    /// Visual edge preference.
    pub affinity: InputAffinity,
}

/// Directed anchor/focus selection from an input host.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InputSelection {
    /// Fixed edge.
    pub anchor: InputPosition,
    /// Moving edge and caret.
    pub focus: InputPosition,
}

/// Browser-independent event category routed through Core hit testing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u16)]
pub enum InputEventKind {
    /// Primary or auxiliary pointer press.
    PointerDown = 1,
    /// Pointer release.
    PointerUp = 2,
    /// Pointer movement.
    PointerMove = 3,
    /// Pointer stream cancellation.
    PointerCancel = 4,
    /// Synthesized activation after a compatible press/release pair.
    Click = 5,
    /// Wheel or trackpad delta.
    Wheel = 6,
    /// Pointer entered a target's hit region and bubbles.
    PointerOver = 7,
    /// Pointer left a target's hit region and bubbles.
    PointerOut = 8,
    /// Pointer entered one target or ancestor; does not bubble.
    PointerEnter = 9,
    /// Pointer left one target or ancestor; does not bubble.
    PointerLeave = 10,
    /// A node acquired explicit pointer capture.
    GotPointerCapture = 11,
    /// A node released or lost pointer capture.
    LostPointerCapture = 12,
    /// A node acquired focus; does not bubble.
    Focus = 13,
    /// A node lost focus; does not bubble.
    Blur = 14,
    /// Bubbling focus acquisition companion.
    FocusIn = 15,
    /// Bubbling focus loss companion.
    FocusOut = 16,
    /// Non-editing key press routed to the focused node.
    KeyDown = 17,
    /// Non-editing key release routed to the focused node.
    KeyUp = 18,
}

impl InputEventKind {
    pub(crate) fn decode(value: u16) -> Result<Self, AbiError> {
        match value {
            1 => Ok(Self::PointerDown),
            2 => Ok(Self::PointerUp),
            3 => Ok(Self::PointerMove),
            4 => Ok(Self::PointerCancel),
            5 => Ok(Self::Click),
            6 => Ok(Self::Wheel),
            7 => Ok(Self::PointerOver),
            8 => Ok(Self::PointerOut),
            9 => Ok(Self::PointerEnter),
            10 => Ok(Self::PointerLeave),
            11 => Ok(Self::GotPointerCapture),
            12 => Ok(Self::LostPointerCapture),
            13 => Ok(Self::Focus),
            14 => Ok(Self::Blur),
            15 => Ok(Self::FocusIn),
            16 => Ok(Self::FocusOut),
            17 => Ok(Self::KeyDown),
            18 => Ok(Self::KeyUp),
            _ => Err(AbiError::UnknownIdentifier {
                category: "input event kind",
                value: u32::from(value),
            }),
        }
    }
}

/// Browser pointer source normalized at the Host boundary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum InputPointerType {
    /// Event has no pointer source, for example a wheel sample.
    None = 0,
    /// Mouse or mouse-compatible pointing device.
    Mouse = 1,
    /// Pen or stylus.
    Pen = 2,
    /// Direct touch contact.
    Touch = 3,
}

impl InputPointerType {
    pub(crate) fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::Mouse),
            2 => Ok(Self::Pen),
            3 => Ok(Self::Touch),
            _ => Err(AbiError::UnknownIdentifier {
                category: "input pointer type",
                value: u32::from(value),
            }),
        }
    }
}

/// How a Core-owned focus transition was requested.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum InputFocusOrigin {
    /// Pointer or touch activation; does not establish `:focus-visible`.
    Pointer = 1,
    /// Keyboard navigation; establishes `:focus-visible`.
    Keyboard = 2,
    /// Application code; does not infer a visible focus ring.
    Programmatic = 3,
    /// Accessibility mirror or assistive technology.
    Accessibility = 4,
}

impl InputFocusOrigin {
    fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            1 => Ok(Self::Pointer),
            2 => Ok(Self::Keyboard),
            3 => Ok(Self::Programmatic),
            4 => Ok(Self::Accessibility),
            _ => Err(AbiError::UnknownIdentifier {
                category: "input focus origin",
                value: u32::from(value),
            }),
        }
    }
}

/// External lifecycle reason for clearing transient interaction state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum InteractionResetReason {
    /// The browser window lost activation.
    WindowBlur = 1,
    /// The owning document became hidden.
    DocumentHidden = 2,
    /// Worker or transport state was replaced after failure.
    TransportRecovery = 3,
    /// The host root is being permanently detached.
    HostUnmount = 4,
}

impl InteractionResetReason {
    fn decode(value: u8) -> Result<Self, AbiError> {
        match value {
            1 => Ok(Self::WindowBlur),
            2 => Ok(Self::DocumentHidden),
            3 => Ok(Self::TransportRecovery),
            4 => Ok(Self::HostUnmount),
            _ => Err(AbiError::UnknownIdentifier {
                category: "interaction reset reason",
                value: u32::from(value),
            }),
        }
    }
}

const MAX_SCROLL_DELTA: f32 = 1_000_000.0;
const MAX_SCROLL_DELTA_MICROS: u32 = 1_000_000;

/// Marks a wheel sample as a high-precision delta such as a trackpad gesture.
///
/// High-precision deltas are already smooth and already carry platform
/// momentum, so Core applies them one-to-one. Samples without this bit are
/// discrete wheel notches, which browsers animate rather than jump.
pub const EVENT_FLAG_PRECISE_WHEEL: u16 = 1;

/// Every event flag bit defined by this ABI version.
pub const EVENT_FLAG_MASK: u16 = EVENT_FLAG_PRECISE_WHEEL;

/// Key event flag: the press is an auto-repeat rather than a fresh one.
pub const KEY_FLAG_REPEAT: u16 = 1;

/// Every key flag bit this ABI version defines.
pub const KEY_FLAG_MASK: u16 = KEY_FLAG_REPEAT;

/// One browser-independent editing or direct-manipulation command.
#[derive(Clone, Debug, PartialEq)]
pub enum InputCommand {
    /// Replaces an explicit UTF-16 range.
    Replace {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Inclusive UTF-16 range start.
        start: u32,
        /// Exclusive UTF-16 range end.
        end: u32,
        /// Replacement UTF-8 text.
        text: String,
    },
    /// Replaces the active selection.
    Insert {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Inserted UTF-8 text.
        text: String,
    },
    /// Deletes the selection or preceding grapheme.
    DeleteBackward {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Deletes the selection or following grapheme.
    DeleteForward {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Updates the directed selection.
    SetSelection {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Directed selection in browser-facing UTF-16 offsets.
        selection: InputSelection,
    },
    /// Starts one IME composition.
    BeginComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Replaces the active composition span.
    UpdateComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Current UTF-8 composition text.
        text: String,
    },
    /// Commits composition, optionally with a final replacement.
    CommitComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
        /// Optional final UTF-8 composition text.
        text: Option<String>,
    },
    /// Restores the pre-composition state.
    CancelComposition {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Applies the latest inverse edit.
    Undo {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Reapplies the latest undone edit.
    Redo {
        /// Target editable node.
        node_id: u32,
        /// Exact Core revision observed by the producer.
        base_revision: u64,
    },
    /// Activates caret, selection, and IME geometry for an editable node.
    FocusEditable {
        /// Generation-bearing editable node.
        node_id: u32,
    },
    /// Deactivates an editable node if it currently owns focus.
    BlurEditable {
        /// Generation-bearing editable node.
        node_id: u32,
    },
    /// Requests active-editor character bounds for one UTF-16 range.
    RequestCharacterBounds {
        /// Generation-bearing editable node.
        node_id: u32,
        /// Inclusive requested UTF-16 start.
        start: u32,
        /// Exclusive requested UTF-16 end.
        end: u32,
    },
    /// Places or extends the caret from a canvas-local logical point.
    PlaceCaret {
        /// Generation-bearing editable node.
        node_id: u32,
        /// Canvas-local logical coordinates.
        position: [f32; 2],
        /// Bit 0 extends the current anchor; bit 1 selects the word.
        flags: u32,
    },
    /// Moves the caret relative to the current selection focus.
    MoveCaret {
        /// Generation-bearing editable node.
        node_id: u32,
        /// Movement direction.
        direction: CaretDirection,
        /// Movement granularity for horizontal directions.
        granularity: CaretGranularity,
        /// Extends the selection anchor instead of collapsing.
        extend: bool,
    },
    /// Supplies dictionary word boundaries for the current editing value.
    ///
    /// UAX #29 has no dictionary, so it makes every Han ideograph its own word
    /// and a double click selects one character. The browser's `Intl.Segmenter`
    /// does have one; this carries its result in so Core can keep owning the
    /// selection. `base_revision` is the session revision the boundaries were
    /// computed against, and a stale one is ignored rather than applied.
    SetWordBoundaries {
        /// Generation-bearing editable node.
        node_id: u32,
        /// Session revision the boundaries describe.
        base_revision: u64,
        /// UTF-16 offsets at which a word starts, ascending and unique.
        boundaries: Vec<u32>,
    },
    /// Starts direct manipulation of a Core-owned scroll node.
    ScrollBegin {
        /// Generation-bearing target scroll node.
        node_id: u32,
    },
    /// Applies a timed two-dimensional logical content-offset delta.
    ScrollDelta {
        /// Generation-bearing target scroll node.
        node_id: u32,
        /// Horizontal logical-pixel delta.
        delta_x: f32,
        /// Vertical logical-pixel delta.
        delta_y: f32,
        /// Time since the preceding sample, in microseconds.
        elapsed_micros: u32,
    },
    /// Ends direct manipulation and starts a Core-estimated fling.
    ScrollEnd {
        /// Generation-bearing target scroll node.
        node_id: u32,
    },
    /// Cancels direct manipulation without retaining fling velocity.
    ScrollCancel {
        /// Generation-bearing target scroll node.
        node_id: u32,
    },
    /// Starts or updates Core-owned constant-velocity scrolling; zero stops it.
    SetScrollVelocity {
        /// Generation-bearing target scroll node.
        node_id: u32,
        /// Horizontal logical pixels per second.
        velocity_x: f32,
        /// Vertical logical pixels per second.
        velocity_y: f32,
    },
    /// Immediately sets a Core-owned scroll position and cancels motion.
    ScrollTo {
        /// Generation-bearing target scroll node.
        node_id: u32,
        /// Horizontal logical content offset.
        x: f32,
        /// Vertical logical content offset.
        y: f32,
    },
    /// Immediately offsets a Core-owned scroll position and cancels motion.
    ScrollBy {
        /// Generation-bearing target scroll node.
        node_id: u32,
        /// Horizontal logical content-offset delta.
        delta_x: f32,
        /// Vertical logical content-offset delta.
        delta_y: f32,
    },
    /// Routes one pointer/wheel sample through Core world geometry.
    DispatchEvent {
        /// Host-monotonic event identifier used by the reverse result.
        event_id: u32,
        /// Event category.
        kind: InputEventKind,
        /// Event source bits; see [`EVENT_FLAG_PRECISE_WHEEL`].
        flags: u16,
        /// Canvas-local logical coordinates.
        position: [f32; 2],
        /// Wheel delta, zero for pointer events.
        delta: [f32; 2],
        /// Browser pointer button bitset.
        buttons: u32,
        /// Shift/Control/Alt/Meta bits.
        modifiers: u32,
        /// Browser pointer identity, or zero for non-pointer events.
        pointer_id: u32,
        /// Time since the previous related sample in microseconds.
        elapsed_micros: u32,
        /// Normalized pointer source, or [`InputPointerType::None`].
        pointer_type: InputPointerType,
        /// Whether this is the primary pointer of its type.
        is_primary: bool,
        /// Normalized contact pressure in the inclusive 0..=1 range.
        pressure: f32,
        /// Pen tilt in degrees for the X and Y planes.
        tilt: [f32; 2],
        /// Contact geometry in positive logical pixels.
        contact_size: [f32; 2],
    },
    /// Routes one non-editing key sample to the currently focused node.
    ///
    /// The identifiers are opaque to Core: it routes and forwards them, and the
    /// Shell turns them back into `KeyboardEvent.key`/`.code` strings. Text
    /// insertion never comes from here; see docs/e1-keyboard-events-design.md.
    DispatchKeyEvent {
        /// Host-monotonic event identifier used by the reverse result.
        event_id: u32,
        /// [`InputEventKind::KeyDown`] or [`InputEventKind::KeyUp`].
        kind: InputEventKind,
        /// Key source bits; see [`KEY_FLAG_REPEAT`].
        flags: u16,
        /// Interned `KeyboardEvent.code`, or zero when unrecognized.
        key_code: u16,
        /// Interned named `KeyboardEvent.key`, or zero for a printable key.
        key_name: u16,
        /// Unicode scalar of a single-character `key`, or zero.
        key_text: u32,
        /// Shift/Control/Alt/Meta bits.
        modifiers: u32,
        /// Time since the previous related sample in microseconds.
        elapsed_micros: u32,
    },
    /// Assigns explicit pointer capture to one live Scene node.
    SetPointerCapture {
        /// Host-monotonic identifier for the resulting lifecycle event.
        event_id: u32,
        /// Live pointer to capture.
        pointer_id: u32,
        /// Generation-bearing capture owner.
        node_id: u32,
    },
    /// Releases explicit pointer capture when owned by the supplied node.
    ReleasePointerCapture {
        /// Host-monotonic identifier for the resulting lifecycle event.
        event_id: u32,
        /// Captured pointer to release.
        pointer_id: u32,
        /// Expected generation-bearing capture owner.
        node_id: u32,
    },
    /// Moves Core focus to one live Scene node.
    FocusNode {
        /// Host-monotonic identifier for the resulting lifecycle events.
        event_id: u32,
        /// Generation-bearing focus target.
        node_id: u32,
        /// Input modality that requested focus.
        origin: InputFocusOrigin,
    },
    /// Clears Core focus when owned by the supplied node.
    BlurNode {
        /// Host-monotonic identifier for the resulting lifecycle events.
        event_id: u32,
        /// Expected generation-bearing focus owner.
        node_id: u32,
    },
    /// Clears pointer, capture, active, hover, and focus state after host loss.
    ResetInteraction {
        /// Host-monotonic identifier for generated cancellation events.
        event_id: u32,
        /// External lifecycle boundary that forced the reset.
        reason: InteractionResetReason,
    },
}

/// One input command plus versioned instruction flags.
#[derive(Clone, Debug, PartialEq)]
pub struct InputInstruction {
    /// Version 1 requires zero.
    pub flags: u8,
    /// Validated command.
    pub command: InputCommand,
}

/// A complete input transaction ending in one Commit instruction.
#[derive(Clone, Debug, PartialEq)]
pub struct InputBatch {
    /// Monotonic input transaction sequence.
    pub frame_seq: u32,
    /// Commands applied in deterministic order.
    pub instructions: Vec<InputInstruction>,
}

impl InputBatch {
    /// Decodes an untrusted input transaction without mutating editing state.
    /// Decodes without reporting what the decoder had to tolerate.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::decode_with_report`].
    pub fn decode(bytes: &[u8]) -> Result<Self, AbiError> {
        Self::decode_with_report(bytes).map(|(value, _)| value)
    }

    /// Decodes and reports what this build had to tolerate to read the stream.
    ///
    /// Instructions with an opcode this build does not know are stepped over
    /// when the producer marked them optional, and counted in the report.
    ///
    /// # Errors
    ///
    /// Returns an [`AbiError`] for a malformed, truncated, oversized, or
    /// too-old stream, and for an unknown instruction that was not marked
    /// optional.
    pub fn decode_with_report(bytes: &[u8]) -> Result<(Self, crate::DecodeReport), AbiError> {
        let mut reader = Reader::new(bytes);
        let stream = read_header(&mut reader, INPUT_MAGIC, MAX_INPUT_BYTES)?;
        let declared_count = stream.declared_count;
        let mut skipped = 0_u32;
        validate_declared_count(declared_count, reader.remaining())?;
        let capacity = usize::try_from(declared_count).map_err(|_| AbiError::ArithmeticOverflow)?;
        let mut instructions = Vec::with_capacity(capacity.saturating_sub(1));
        let mut actual_count = 0_u32;
        let mut frame_seq = None;

        while reader.remaining() != 0 {
            let header = read_instruction_header(&mut reader)?;
            let (offset, raw_opcode, flags) = (header.offset, header.opcode, header.flags);
            actual_count = actual_count
                .checked_add(1)
                .ok_or(AbiError::ArithmeticOverflow)?;
            if frame_seq.is_some() {
                return Err(AbiError::CommitNotLast { offset });
            }
            // A stream from a newer build may carry instructions this decoder has
            // never heard of. Skipping one is only safe when the producer marked it
            // optional, so an unmarked unknown instruction is still fatal.
            let Some(opcode) = InputOpcode::from_u8(raw_opcode) else {
                if header.optional() {
                    skipped = skipped.saturating_add(1);
                    reader.seek_to(header.end)?;
                    continue;
                }
                return Err(AbiError::UnknownOpcode {
                    stream: StreamKind::Input,
                    opcode: raw_opcode,
                    offset,
                });
            };
            if opcode == InputOpcode::Commit {
                frame_seq = Some(reader.read_u32()?);
                validate_instruction_size(opcode, offset, reader.offset())?;
                finish_instruction(&reader, header)?;
                continue;
            }
            let command = decode_command(opcode, &mut reader)?;
            validate_instruction_size(opcode, offset, reader.offset())?;
            instructions.push(InputInstruction { flags, command });
        }
        if actual_count != declared_count {
            return Err(AbiError::InstructionCountMismatch {
                declared: declared_count,
                actual: actual_count,
            });
        }
        Ok((
            Self {
                frame_seq: frame_seq.ok_or(AbiError::MissingCommit)?,
                instructions,
            },
            crate::DecodeReport {
                skipped_instructions: skipped,
                producer_abi_version: stream.producer_version,
            },
        ))
    }

    /// Encodes one canonical little-endian input transaction.
    pub fn encode(&self) -> Result<Vec<u8>, AbiError> {
        validate_encode_instruction_count(self.instructions.len(), 1, MAX_INPUT_INSTRUCTIONS)?;
        let mut writer = Writer::new(INPUT_MAGIC);
        for instruction in &self.instructions {
            encode_command(&mut writer, instruction)?;
        }
        let commit_offset = writer.offset();
        writer.instruction(InputOpcode::Commit as u8, 0);
        writer.u32(self.frame_seq);
        validate_instruction_size(InputOpcode::Commit, commit_offset, writer.offset())?;
        writer.finish(MAX_INPUT_BYTES)
    }
}

fn validate_declared_count(declared: u32, remaining: usize) -> Result<(), AbiError> {
    if declared > MAX_INPUT_INSTRUCTIONS {
        return Err(AbiError::InstructionCountTooLarge {
            declared,
            maximum: MAX_INPUT_INSTRUCTIONS,
        });
    }
    let maximum = u32::try_from(remaining / 4).map_err(|_| AbiError::ArithmeticOverflow)?;
    if declared > maximum {
        return Err(AbiError::InstructionCountTooLarge { declared, maximum });
    }
    Ok(())
}

fn decode_command(opcode: InputOpcode, reader: &mut Reader<'_>) -> Result<InputCommand, AbiError> {
    Ok(match opcode {
        InputOpcode::Replace => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Replace {
                node_id,
                base_revision,
                start: reader.read_u32()?,
                end: reader.read_u32()?,
                text: read_text(reader)?,
            }
        }
        InputOpcode::Insert => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Insert {
                node_id,
                base_revision,
                text: read_text(reader)?,
            }
        }
        InputOpcode::DeleteBackward => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::DeleteBackward {
                node_id,
                base_revision,
            }
        }
        InputOpcode::DeleteForward => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::DeleteForward {
                node_id,
                base_revision,
            }
        }
        InputOpcode::SetSelection => {
            let (node_id, base_revision) = read_target(reader)?;
            let anchor_offset = reader.read_u32()?;
            let focus_offset = reader.read_u32()?;
            let anchor_affinity = InputAffinity::decode(reader.read_u8()?)?;
            let focus_affinity = InputAffinity::decode(reader.read_u8()?)?;
            reader.read_zeroes(2)?;
            InputCommand::SetSelection {
                node_id,
                base_revision,
                selection: InputSelection {
                    anchor: InputPosition {
                        offset: anchor_offset,
                        affinity: anchor_affinity,
                    },
                    focus: InputPosition {
                        offset: focus_offset,
                        affinity: focus_affinity,
                    },
                },
            }
        }
        InputOpcode::BeginComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::BeginComposition {
                node_id,
                base_revision,
            }
        }
        InputOpcode::UpdateComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::UpdateComposition {
                node_id,
                base_revision,
                text: read_text(reader)?,
            }
        }
        InputOpcode::CommitComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            let has_text = reader.read_u8()?;
            reader.read_zeroes(3)?;
            let text = read_text(reader)?;
            let text = match has_text {
                0 if text.is_empty() => None,
                1 => Some(text),
                0 => {
                    return Err(AbiError::InvalidValue(
                        "absent composition text is non-empty",
                    ));
                }
                _ => {
                    return Err(AbiError::InvalidValue(
                        "invalid composition text presence flag",
                    ));
                }
            };
            InputCommand::CommitComposition {
                node_id,
                base_revision,
                text,
            }
        }
        InputOpcode::CancelComposition => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::CancelComposition {
                node_id,
                base_revision,
            }
        }
        InputOpcode::Undo => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Undo {
                node_id,
                base_revision,
            }
        }
        InputOpcode::Redo => {
            let (node_id, base_revision) = read_target(reader)?;
            InputCommand::Redo {
                node_id,
                base_revision,
            }
        }
        InputOpcode::FocusEditable => InputCommand::FocusEditable {
            node_id: reader.read_u32()?,
        },
        InputOpcode::BlurEditable => InputCommand::BlurEditable {
            node_id: reader.read_u32()?,
        },
        InputOpcode::RequestCharacterBounds => {
            let node_id = reader.read_u32()?;
            let start = reader.read_u32()?;
            let end = reader.read_u32()?;
            if start > end {
                return Err(AbiError::InvalidValue("character bounds range is reversed"));
            }
            InputCommand::RequestCharacterBounds {
                node_id,
                start,
                end,
            }
        }
        InputOpcode::PlaceCaret => {
            let node_id = reader.read_u32()?;
            let position = [reader.read_f32()?, reader.read_f32()?];
            let flags = reader.read_u32()?;
            validate_place_caret_fields(position, flags)?;
            InputCommand::PlaceCaret {
                node_id,
                position,
                flags,
            }
        }
        InputOpcode::MoveCaret => {
            let node_id = reader.read_u32()?;
            let direction = CaretDirection::decode(reader.read_u8()?)?;
            let granularity = CaretGranularity::decode(reader.read_u8()?)?;
            let extend = match reader.read_u8()? {
                0 => false,
                1 => true,
                value => {
                    return Err(AbiError::UnknownIdentifier {
                        category: "caret extend flag",
                        value: u32::from(value),
                    });
                }
            };
            reader.read_zeroes(1)?;
            InputCommand::MoveCaret {
                node_id,
                direction,
                granularity,
                extend,
            }
        }
        InputOpcode::SetWordBoundaries => {
            let node_id = reader.read_u32()?;
            let low = u64::from(reader.read_u32()?);
            let high = u64::from(reader.read_u32()?);
            let declared = reader.read_u32()?;
            if declared > MAX_WORD_BOUNDARIES {
                return Err(AbiError::InvalidValue(
                    "word boundary count is outside the supported limit",
                ));
            }
            let count = usize::try_from(declared).map_err(|_| AbiError::ArithmeticOverflow)?;
            // Reserve against the bytes that remain, never the declared count.
            let mut boundaries = Vec::with_capacity(count.min(reader.remaining() / 4));
            let mut previous: Option<u32> = None;
            for _ in 0..count {
                let offset = reader.read_u32()?;
                // Ascending and unique keeps one segmentation one byte sequence.
                if previous.is_some_and(|last| offset <= last) {
                    return Err(AbiError::InvalidValue(
                        "word boundaries must ascend without duplicates",
                    ));
                }
                previous = Some(offset);
                boundaries.push(offset);
            }
            InputCommand::SetWordBoundaries {
                node_id,
                base_revision: low | (high << 32),
                boundaries,
            }
        }
        InputOpcode::ScrollBegin => InputCommand::ScrollBegin {
            node_id: reader.read_u32()?,
        },
        InputOpcode::ScrollDelta => {
            let node_id = reader.read_u32()?;
            let delta_x = reader.read_f32()?;
            let delta_y = reader.read_f32()?;
            if delta_x.abs() > MAX_SCROLL_DELTA || delta_y.abs() > MAX_SCROLL_DELTA {
                return Err(AbiError::InvalidValue("scroll delta exceeds maximum"));
            }
            let elapsed_micros = reader.read_u32()?;
            if elapsed_micros == 0 || elapsed_micros > MAX_SCROLL_DELTA_MICROS {
                return Err(AbiError::InvalidValue(
                    "scroll delta elapsed time is invalid",
                ));
            }
            InputCommand::ScrollDelta {
                node_id,
                delta_x,
                delta_y,
                elapsed_micros,
            }
        }
        InputOpcode::ScrollEnd => InputCommand::ScrollEnd {
            node_id: reader.read_u32()?,
        },
        InputOpcode::ScrollCancel => InputCommand::ScrollCancel {
            node_id: reader.read_u32()?,
        },
        InputOpcode::SetScrollVelocity => {
            let node_id = reader.read_u32()?;
            let velocity_x = reader.read_f32()?;
            let velocity_y = reader.read_f32()?;
            if velocity_x.abs() > MAX_SCROLL_DELTA || velocity_y.abs() > MAX_SCROLL_DELTA {
                return Err(AbiError::InvalidValue("scroll velocity exceeds maximum"));
            }
            InputCommand::SetScrollVelocity {
                node_id,
                velocity_x,
                velocity_y,
            }
        }
        InputOpcode::ScrollTo => {
            let node_id = reader.read_u32()?;
            let x = reader.read_f32()?;
            let y = reader.read_f32()?;
            validate_scroll_pair(x, y, "scroll position exceeds maximum")?;
            InputCommand::ScrollTo { node_id, x, y }
        }
        InputOpcode::ScrollBy => {
            let node_id = reader.read_u32()?;
            let delta_x = reader.read_f32()?;
            let delta_y = reader.read_f32()?;
            validate_scroll_pair(delta_x, delta_y, "scroll delta exceeds maximum")?;
            InputCommand::ScrollBy {
                node_id,
                delta_x,
                delta_y,
            }
        }
        InputOpcode::DispatchEvent => {
            let event_id = reader.read_u32()?;
            let kind = InputEventKind::decode(reader.read_u16()?)?;
            let flags = reader.read_u16()?;
            let position = [reader.read_f32()?, reader.read_f32()?];
            let delta = [reader.read_f32()?, reader.read_f32()?];
            let buttons = reader.read_u32()?;
            let modifiers = reader.read_u32()?;
            let pointer_id = reader.read_u32()?;
            let elapsed_micros = reader.read_u32()?;
            let pointer_type = InputPointerType::decode(reader.read_u8()?)?;
            let is_primary = match reader.read_u8()? {
                0 => false,
                1 => true,
                value => {
                    return Err(AbiError::UnknownIdentifier {
                        category: "primary pointer flag",
                        value: u32::from(value),
                    });
                }
            };
            reader.read_zeroes(2)?;
            let pressure = reader.read_f32()?;
            let tilt = [reader.read_f32()?, reader.read_f32()?];
            let contact_size = [reader.read_f32()?, reader.read_f32()?];
            validate_event_fields(&EventFields {
                kind,
                position,
                delta,
                buttons,
                modifiers,
                pointer_id,
                elapsed_micros,
                pointer_type,
                pressure,
                tilt,
                contact_size,
            })?;
            validate_event_flags(flags)?;
            InputCommand::DispatchEvent {
                event_id,
                kind,
                flags,
                position,
                delta,
                buttons,
                modifiers,
                pointer_id,
                elapsed_micros,
                pointer_type,
                is_primary,
                pressure,
                tilt,
                contact_size,
            }
        }
        InputOpcode::DispatchKeyEvent => {
            let event_id = reader.read_u32()?;
            let kind = InputEventKind::decode(reader.read_u16()?)?;
            let flags = reader.read_u16()?;
            let key_code = reader.read_u16()?;
            let key_name = reader.read_u16()?;
            let key_text = reader.read_u32()?;
            let modifiers = reader.read_u32()?;
            let elapsed_micros = reader.read_u32()?;
            validate_key_fields(
                kind,
                flags,
                key_code,
                key_name,
                key_text,
                modifiers,
                elapsed_micros,
            )?;
            InputCommand::DispatchKeyEvent {
                event_id,
                kind,
                flags,
                key_code,
                key_name,
                key_text,
                modifiers,
                elapsed_micros,
            }
        }
        InputOpcode::SetPointerCapture | InputOpcode::ReleasePointerCapture => {
            let event_id = reader.read_u32()?;
            let pointer_id = reader.read_u32()?;
            let node_id = reader.read_u32()?;
            if pointer_id == 0 {
                return Err(AbiError::InvalidValue(
                    "pointer capture id must be non-zero",
                ));
            }
            if opcode == InputOpcode::SetPointerCapture {
                InputCommand::SetPointerCapture {
                    event_id,
                    pointer_id,
                    node_id,
                }
            } else {
                InputCommand::ReleasePointerCapture {
                    event_id,
                    pointer_id,
                    node_id,
                }
            }
        }
        InputOpcode::FocusNode => {
            let event_id = reader.read_u32()?;
            let node_id = reader.read_u32()?;
            let origin = InputFocusOrigin::decode(reader.read_u8()?)?;
            reader.read_zeroes(3)?;
            InputCommand::FocusNode {
                event_id,
                node_id,
                origin,
            }
        }
        InputOpcode::BlurNode => InputCommand::BlurNode {
            event_id: reader.read_u32()?,
            node_id: reader.read_u32()?,
        },
        InputOpcode::ResetInteraction => {
            let event_id = reader.read_u32()?;
            let reason = InteractionResetReason::decode(reader.read_u8()?)?;
            reader.read_zeroes(3)?;
            InputCommand::ResetInteraction { event_id, reason }
        }
        InputOpcode::Commit => return Err(AbiError::InvalidValue("nested input commit")),
    })
}

fn encode_command(writer: &mut Writer, instruction: &InputInstruction) -> Result<(), AbiError> {
    let offset = writer.offset();
    if instruction.flags != 0 {
        return Err(AbiError::UnsupportedFlags {
            offset,
            flags: instruction.flags,
        });
    }
    let opcode = command_opcode(&instruction.command);
    writer.instruction(opcode as u8, instruction.flags);
    match &instruction.command {
        InputCommand::Replace {
            node_id,
            base_revision,
            start,
            end,
            text,
        } => {
            write_target(writer, *node_id, *base_revision);
            writer.u32(*start);
            writer.u32(*end);
            write_text(writer, text)?;
        }
        InputCommand::Insert {
            node_id,
            base_revision,
            text,
        }
        | InputCommand::UpdateComposition {
            node_id,
            base_revision,
            text,
        } => {
            write_target(writer, *node_id, *base_revision);
            write_text(writer, text)?;
        }
        InputCommand::SetSelection {
            node_id,
            base_revision,
            selection,
        } => {
            write_target(writer, *node_id, *base_revision);
            writer.u32(selection.anchor.offset);
            writer.u32(selection.focus.offset);
            writer.u8(selection.anchor.affinity as u8);
            writer.u8(selection.focus.affinity as u8);
            writer.u16(0);
        }
        InputCommand::CommitComposition {
            node_id,
            base_revision,
            text,
        } => {
            write_target(writer, *node_id, *base_revision);
            writer.u8(u8::from(text.is_some()));
            writer.u8(0);
            writer.u16(0);
            write_text(writer, text.as_deref().unwrap_or_default())?;
        }
        InputCommand::ScrollBegin { node_id }
        | InputCommand::FocusEditable { node_id }
        | InputCommand::BlurEditable { node_id }
        | InputCommand::ScrollEnd { node_id }
        | InputCommand::ScrollCancel { node_id } => writer.u32(*node_id),
        InputCommand::RequestCharacterBounds {
            node_id,
            start,
            end,
        } => {
            if start > end {
                return Err(AbiError::InvalidValue("character bounds range is reversed"));
            }
            writer.u32(*node_id);
            writer.u32(*start);
            writer.u32(*end);
        }
        InputCommand::MoveCaret {
            node_id,
            direction,
            granularity,
            extend,
        } => {
            writer.u32(*node_id);
            writer.u8(*direction as u8);
            writer.u8(*granularity as u8);
            writer.u8(u8::from(*extend));
            writer.u8(0);
        }
        InputCommand::SetWordBoundaries {
            node_id,
            base_revision,
            boundaries,
        } => {
            let count =
                u32::try_from(boundaries.len()).map_err(|_| AbiError::ArithmeticOverflow)?;
            if count > MAX_WORD_BOUNDARIES {
                return Err(AbiError::InvalidValue(
                    "word boundary count is outside the supported limit",
                ));
            }
            if boundaries.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(AbiError::InvalidValue(
                    "word boundaries must ascend without duplicates",
                ));
            }
            writer.u32(*node_id);
            writer.u32(u32::try_from(*base_revision & 0xffff_ffff).unwrap_or(u32::MAX));
            writer.u32(u32::try_from(*base_revision >> 32).unwrap_or(u32::MAX));
            writer.u32(count);
            for offset in boundaries {
                writer.u32(*offset);
            }
        }
        InputCommand::PlaceCaret {
            node_id,
            position,
            flags,
        } => {
            validate_place_caret_fields(*position, *flags)?;
            writer.u32(*node_id);
            writer.f32(position[0])?;
            writer.f32(position[1])?;
            writer.u32(*flags);
        }
        InputCommand::ScrollDelta {
            node_id,
            delta_x,
            delta_y,
            elapsed_micros,
        } => {
            if delta_x.abs() > MAX_SCROLL_DELTA || delta_y.abs() > MAX_SCROLL_DELTA {
                return Err(AbiError::InvalidValue("scroll delta exceeds maximum"));
            }
            if *elapsed_micros == 0 || *elapsed_micros > MAX_SCROLL_DELTA_MICROS {
                return Err(AbiError::InvalidValue(
                    "scroll delta elapsed time is invalid",
                ));
            }
            writer.u32(*node_id);
            writer.f32(*delta_x)?;
            writer.f32(*delta_y)?;
            writer.u32(*elapsed_micros);
        }
        InputCommand::SetScrollVelocity {
            node_id,
            velocity_x,
            velocity_y,
        } => {
            if velocity_x.abs() > MAX_SCROLL_DELTA || velocity_y.abs() > MAX_SCROLL_DELTA {
                return Err(AbiError::InvalidValue("scroll velocity exceeds maximum"));
            }
            writer.u32(*node_id);
            writer.f32(*velocity_x)?;
            writer.f32(*velocity_y)?;
        }
        InputCommand::ScrollTo { node_id, x, y } => {
            validate_scroll_pair(*x, *y, "scroll position exceeds maximum")?;
            writer.u32(*node_id);
            writer.f32(*x)?;
            writer.f32(*y)?;
        }
        InputCommand::ScrollBy {
            node_id,
            delta_x,
            delta_y,
        } => {
            validate_scroll_pair(*delta_x, *delta_y, "scroll delta exceeds maximum")?;
            writer.u32(*node_id);
            writer.f32(*delta_x)?;
            writer.f32(*delta_y)?;
        }
        InputCommand::DispatchEvent {
            event_id,
            kind,
            flags,
            position,
            delta,
            buttons,
            modifiers,
            pointer_id,
            elapsed_micros,
            pointer_type,
            is_primary,
            pressure,
            tilt,
            contact_size,
        } => {
            validate_event_fields(&EventFields {
                kind: *kind,
                position: *position,
                delta: *delta,
                buttons: *buttons,
                modifiers: *modifiers,
                pointer_id: *pointer_id,
                elapsed_micros: *elapsed_micros,
                pointer_type: *pointer_type,
                pressure: *pressure,
                tilt: *tilt,
                contact_size: *contact_size,
            })?;
            validate_event_flags(*flags)?;
            writer.u32(*event_id);
            writer.u16(*kind as u16);
            writer.u16(*flags);
            writer.f32(position[0])?;
            writer.f32(position[1])?;
            writer.f32(delta[0])?;
            writer.f32(delta[1])?;
            writer.u32(*buttons);
            writer.u32(*modifiers);
            writer.u32(*pointer_id);
            writer.u32(*elapsed_micros);
            writer.u8(*pointer_type as u8);
            writer.u8(u8::from(*is_primary));
            writer.u16(0);
            writer.f32(*pressure)?;
            writer.f32(tilt[0])?;
            writer.f32(tilt[1])?;
            writer.f32(contact_size[0])?;
            writer.f32(contact_size[1])?;
        }
        InputCommand::DispatchKeyEvent {
            event_id,
            kind,
            flags,
            key_code,
            key_name,
            key_text,
            modifiers,
            elapsed_micros,
        } => {
            validate_key_fields(
                *kind,
                *flags,
                *key_code,
                *key_name,
                *key_text,
                *modifiers,
                *elapsed_micros,
            )?;
            writer.u32(*event_id);
            writer.u16(*kind as u16);
            writer.u16(*flags);
            writer.u16(*key_code);
            writer.u16(*key_name);
            writer.u32(*key_text);
            writer.u32(*modifiers);
            writer.u32(*elapsed_micros);
        }
        InputCommand::SetPointerCapture {
            event_id,
            pointer_id,
            node_id,
        }
        | InputCommand::ReleasePointerCapture {
            event_id,
            pointer_id,
            node_id,
        } => {
            if *pointer_id == 0 {
                return Err(AbiError::InvalidValue(
                    "pointer capture id must be non-zero",
                ));
            }
            writer.u32(*event_id);
            writer.u32(*pointer_id);
            writer.u32(*node_id);
        }
        InputCommand::FocusNode {
            event_id,
            node_id,
            origin,
        } => {
            writer.u32(*event_id);
            writer.u32(*node_id);
            writer.u8(*origin as u8);
            writer.u8(0);
            writer.u16(0);
        }
        InputCommand::BlurNode { event_id, node_id } => {
            writer.u32(*event_id);
            writer.u32(*node_id);
        }
        InputCommand::ResetInteraction { event_id, reason } => {
            writer.u32(*event_id);
            writer.u8(*reason as u8);
            writer.u8(0);
            writer.u16(0);
        }
        command => {
            let (node_id, base_revision) = command_target(command);
            write_target(writer, node_id, base_revision);
        }
    }
    validate_instruction_size(opcode, offset, writer.offset())
}

fn command_target(command: &InputCommand) -> (u32, u64) {
    match command {
        InputCommand::DeleteBackward {
            node_id,
            base_revision,
        }
        | InputCommand::DeleteForward {
            node_id,
            base_revision,
        }
        | InputCommand::BeginComposition {
            node_id,
            base_revision,
        }
        | InputCommand::CancelComposition {
            node_id,
            base_revision,
        }
        | InputCommand::Undo {
            node_id,
            base_revision,
        }
        | InputCommand::Redo {
            node_id,
            base_revision,
        } => (*node_id, *base_revision),
        _ => unreachable!("variable input commands are encoded separately"),
    }
}

fn command_opcode(command: &InputCommand) -> InputOpcode {
    match command {
        InputCommand::Replace { .. } => InputOpcode::Replace,
        InputCommand::Insert { .. } => InputOpcode::Insert,
        InputCommand::DeleteBackward { .. } => InputOpcode::DeleteBackward,
        InputCommand::DeleteForward { .. } => InputOpcode::DeleteForward,
        InputCommand::SetSelection { .. } => InputOpcode::SetSelection,
        InputCommand::BeginComposition { .. } => InputOpcode::BeginComposition,
        InputCommand::UpdateComposition { .. } => InputOpcode::UpdateComposition,
        InputCommand::CommitComposition { .. } => InputOpcode::CommitComposition,
        InputCommand::CancelComposition { .. } => InputOpcode::CancelComposition,
        InputCommand::Undo { .. } => InputOpcode::Undo,
        InputCommand::Redo { .. } => InputOpcode::Redo,
        InputCommand::FocusEditable { .. } => InputOpcode::FocusEditable,
        InputCommand::BlurEditable { .. } => InputOpcode::BlurEditable,
        InputCommand::RequestCharacterBounds { .. } => InputOpcode::RequestCharacterBounds,
        InputCommand::PlaceCaret { .. } => InputOpcode::PlaceCaret,
        InputCommand::MoveCaret { .. } => InputOpcode::MoveCaret,
        InputCommand::SetWordBoundaries { .. } => InputOpcode::SetWordBoundaries,
        InputCommand::ScrollBegin { .. } => InputOpcode::ScrollBegin,
        InputCommand::ScrollDelta { .. } => InputOpcode::ScrollDelta,
        InputCommand::ScrollEnd { .. } => InputOpcode::ScrollEnd,
        InputCommand::ScrollCancel { .. } => InputOpcode::ScrollCancel,
        InputCommand::SetScrollVelocity { .. } => InputOpcode::SetScrollVelocity,
        InputCommand::ScrollTo { .. } => InputOpcode::ScrollTo,
        InputCommand::ScrollBy { .. } => InputOpcode::ScrollBy,
        InputCommand::DispatchEvent { .. } => InputOpcode::DispatchEvent,
        InputCommand::DispatchKeyEvent { .. } => InputOpcode::DispatchKeyEvent,
        InputCommand::SetPointerCapture { .. } => InputOpcode::SetPointerCapture,
        InputCommand::ReleasePointerCapture { .. } => InputOpcode::ReleasePointerCapture,
        InputCommand::FocusNode { .. } => InputOpcode::FocusNode,
        InputCommand::BlurNode { .. } => InputOpcode::BlurNode,
        InputCommand::ResetInteraction { .. } => InputOpcode::ResetInteraction,
    }
}

fn validate_scroll_pair(x: f32, y: f32, message: &'static str) -> Result<(), AbiError> {
    if !x.is_finite() || !y.is_finite() || x.abs() > MAX_SCROLL_DELTA || y.abs() > MAX_SCROLL_DELTA
    {
        return Err(AbiError::InvalidValue(message));
    }
    Ok(())
}

fn validate_place_caret_fields(position: [f32; 2], flags: u32) -> Result<(), AbiError> {
    if position
        .iter()
        .any(|value| !value.is_finite() || value.abs() > 1_000_000_000.0)
    {
        return Err(AbiError::InvalidValue(
            "caret placement coordinate is invalid",
        ));
    }
    if flags & !0x03 != 0 {
        return Err(AbiError::InvalidValue("caret placement flags are reserved"));
    }
    Ok(())
}

/// Validates one key sample before it can reach Core routing.
///
/// Core never interprets a key, so the identifiers only have to be inside the
/// table bounds this ABI version declares; anything above them came from a
/// newer producer or a corrupt stream and is rejected outright.
#[allow(clippy::too_many_arguments)]
fn validate_key_fields(
    kind: InputEventKind,
    flags: u16,
    key_code: u16,
    key_name: u16,
    key_text: u32,
    modifiers: u32,
    elapsed_micros: u32,
) -> Result<(), AbiError> {
    if !matches!(kind, InputEventKind::KeyDown | InputEventKind::KeyUp) {
        return Err(AbiError::InvalidValue(
            "key dispatch requires a key event kind",
        ));
    }
    if flags & !KEY_FLAG_MASK != 0 {
        return Err(AbiError::InvalidValue("key flag bits are reserved"));
    }
    if key_code > MAX_KEYBOARD_CODE_ID || key_name > MAX_KEYBOARD_KEY_NAME_ID {
        return Err(AbiError::InvalidValue("key identifier is out of range"));
    }
    // Unicode scalar values exclude the surrogate range; `key` is never a lone
    // surrogate, so a stream carrying one is malformed.
    if key_text != 0 && (key_text > 0x0010_ffff || (0xd800..=0xdfff).contains(&key_text)) {
        return Err(AbiError::InvalidValue("key text is not a Unicode scalar"));
    }
    if key_name != 0 && key_text != 0 {
        return Err(AbiError::InvalidValue(
            "key cannot be both named and printable",
        ));
    }
    if modifiers & !0x0f != 0 {
        return Err(AbiError::InvalidValue("key modifier bits are reserved"));
    }
    if elapsed_micros == 0 || elapsed_micros > MAX_SCROLL_DELTA_MICROS {
        return Err(AbiError::InvalidValue("key elapsed time is invalid"));
    }
    Ok(())
}

fn validate_event_flags(flags: u16) -> Result<(), AbiError> {
    if flags & !EVENT_FLAG_MASK != 0 {
        return Err(AbiError::InvalidValue("event flag bits are reserved"));
    }
    Ok(())
}

struct EventFields {
    kind: InputEventKind,
    position: [f32; 2],
    delta: [f32; 2],
    buttons: u32,
    modifiers: u32,
    pointer_id: u32,
    elapsed_micros: u32,
    pointer_type: InputPointerType,
    pressure: f32,
    tilt: [f32; 2],
    contact_size: [f32; 2],
}

fn validate_event_fields(fields: &EventFields) -> Result<(), AbiError> {
    let EventFields {
        kind,
        position,
        delta,
        buttons,
        modifiers,
        pointer_id,
        elapsed_micros,
        pointer_type,
        pressure,
        tilt,
        contact_size,
    } = fields;
    if matches!(
        *kind,
        InputEventKind::PointerOver
            | InputEventKind::PointerOut
            | InputEventKind::PointerEnter
            | InputEventKind::GotPointerCapture
            | InputEventKind::LostPointerCapture
            | InputEventKind::Focus
            | InputEventKind::Blur
            | InputEventKind::FocusIn
            | InputEventKind::FocusOut
    ) {
        return Err(AbiError::InvalidValue(
            "synthetic event kind cannot be dispatched by the host",
        ));
    }
    if position.iter().any(|value| value.abs() > 1_000_000_000.0) {
        return Err(AbiError::InvalidValue("event coordinate exceeds maximum"));
    }
    if delta.iter().any(|value| value.abs() > MAX_SCROLL_DELTA) {
        return Err(AbiError::InvalidValue("event delta exceeds maximum"));
    }
    if buttons & !0xffff != 0 || modifiers & !0x0f != 0 {
        return Err(AbiError::InvalidValue(
            "event button or modifier bits are reserved",
        ));
    }
    if *elapsed_micros == 0 || *elapsed_micros > MAX_SCROLL_DELTA_MICROS {
        return Err(AbiError::InvalidValue("event elapsed time is invalid"));
    }
    let pointer_event = matches!(
        kind,
        InputEventKind::PointerDown
            | InputEventKind::PointerUp
            | InputEventKind::PointerMove
            | InputEventKind::PointerCancel
            | InputEventKind::PointerLeave
    );
    if pointer_event != (*pointer_id != 0 && *pointer_type != InputPointerType::None) {
        return Err(AbiError::InvalidValue(
            "pointer event identity and type are inconsistent",
        ));
    }
    if !pressure.is_finite() || !(0.0..=1.0).contains(pressure) {
        return Err(AbiError::InvalidValue("event pressure is outside 0..=1"));
    }
    if tilt
        .iter()
        .any(|value| !value.is_finite() || !(-90.0..=90.0).contains(value))
    {
        return Err(AbiError::InvalidValue("event tilt is outside -90..=90"));
    }
    if contact_size
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0 || *value > 1_000_000.0)
    {
        return Err(AbiError::InvalidValue("event contact size is invalid"));
    }
    Ok(())
}

fn read_target(reader: &mut Reader<'_>) -> Result<(u32, u64), AbiError> {
    let node_id = reader.read_u32()?;
    let low = reader.read_u32()?;
    let high = reader.read_u32()?;
    Ok((node_id, u64::from(low) | (u64::from(high) << 32)))
}

fn write_target(writer: &mut Writer, node_id: u32, revision: u64) {
    writer.u32(node_id);
    writer.u32(revision as u32);
    writer.u32((revision >> 32) as u32);
}

fn read_text(reader: &mut Reader<'_>) -> Result<String, AbiError> {
    let length = usize::try_from(reader.read_u32()?).map_err(|_| AbiError::ArithmeticOverflow)?;
    if length > MAX_RESOURCE_BYTES {
        return Err(AbiError::ResourceTooLarge {
            actual: length,
            maximum: MAX_RESOURCE_BYTES,
        });
    }
    let bytes = reader.read_bytes(length)?;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| AbiError::InvalidValue("input text is not valid UTF-8"))?
        .to_owned();
    reader.read_zeroes(checked_padding(length)?)?;
    Ok(text)
}

fn write_text(writer: &mut Writer, text: &str) -> Result<(), AbiError> {
    if text.len() > MAX_RESOURCE_BYTES {
        return Err(AbiError::ResourceTooLarge {
            actual: text.len(),
            maximum: MAX_RESOURCE_BYTES,
        });
    }
    writer.u32(u32::try_from(text.len()).map_err(|_| AbiError::ArithmeticOverflow)?);
    writer.bytes(text.as_bytes());
    writer.pad();
    Ok(())
}

fn validate_instruction_size(
    opcode: InputOpcode,
    offset: usize,
    end: usize,
) -> Result<(), AbiError> {
    let actual = end
        .checked_sub(offset)
        .ok_or(AbiError::ArithmeticOverflow)?;
    if let Some(expected) = opcode.fixed_bytes()
        && actual != expected
    {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected,
            actual,
        });
    }
    if actual < opcode.minimum_bytes() {
        return Err(AbiError::InstructionLengthMismatch {
            opcode: opcode as u8,
            offset,
            expected: opcode.minimum_bytes(),
            actual,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::{INSTRUCTION_FLAG_OPTIONAL, INSTRUCTION_HEADER_BYTES, STREAM_HEADER_BYTES};

    fn instruction(command: InputCommand) -> InputInstruction {
        InputInstruction { flags: 0, command }
    }

    #[allow(clippy::too_many_arguments)]
    fn key_command(
        kind: InputEventKind,
        flags: u16,
        key_code: u16,
        key_name: u16,
        key_text: u32,
        modifiers: u32,
        elapsed_micros: u32,
    ) -> InputCommand {
        InputCommand::DispatchKeyEvent {
            event_id: 9,
            kind,
            flags,
            key_code,
            key_name,
            key_text,
            modifiers,
            elapsed_micros,
        }
    }

    fn printable_key(kind: InputEventKind) -> InputCommand {
        key_command(kind, KEY_FLAG_REPEAT, 12, 0, 0x4e2d, 0x05, 16_667)
    }

    fn encode_key(command: InputCommand) -> Result<Vec<u8>, AbiError> {
        InputBatch {
            frame_seq: 3,
            instructions: vec![instruction(command)],
        }
        .encode()
    }

    #[test]
    fn key_events_round_trip_and_reject_impossible_payloads() {
        for kind in [InputEventKind::KeyDown, InputEventKind::KeyUp] {
            let command = printable_key(kind);
            let bytes = encode_key(command.clone()).expect("key bytes");
            let decoded = InputBatch::decode(&bytes).expect("decode");
            assert_eq!(decoded.instructions.len(), 1);
            assert_eq!(decoded.instructions[0].command, command);
        }

        // A pointer kind is not dispatchable through the key command.
        assert!(encode_key(printable_key(InputEventKind::PointerDown)).is_err());

        let down = InputEventKind::KeyDown;
        for broken in [
            key_command(down, KEY_FLAG_MASK + 1, 12, 0, 0x4e2d, 0, 16_667),
            key_command(down, 0, MAX_KEYBOARD_CODE_ID + 1, 0, 0, 0, 16_667),
            key_command(down, 0, 12, MAX_KEYBOARD_KEY_NAME_ID + 1, 0, 0, 16_667),
            // A lone surrogate is never a `KeyboardEvent.key`.
            key_command(down, 0, 12, 0, 0xd800, 0, 16_667),
            // Named and printable at once is contradictory.
            key_command(down, 0, 12, 1, 0x41, 0, 16_667),
            key_command(down, 0, 12, 0, 0x41, 0x10, 16_667),
            key_command(down, 0, 12, 0, 0x41, 0, 0),
        ] {
            assert!(encode_key(broken.clone()).is_err(), "{broken:?} encoded");
        }
    }

    #[test]
    fn a_malformed_key_instruction_is_rejected_on_decode() {
        let bytes = encode_key(printable_key(InputEventKind::KeyDown)).expect("key bytes");
        // Stream header, then the first instruction's 4-byte header.
        let payload = STREAM_HEADER_BYTES + INSTRUCTION_HEADER_BYTES;

        let mut unknown_kind = bytes.clone();
        unknown_kind[payload + 4] = 3;
        assert!(InputBatch::decode(&unknown_kind).is_err());

        let mut reserved_flag = bytes.clone();
        reserved_flag[payload + 6] = 0xff;
        assert!(InputBatch::decode(&reserved_flag).is_err());

        let mut truncated = bytes.clone();
        truncated.truncate(truncated.len() - 4);
        assert!(InputBatch::decode(&truncated).is_err());
    }

    fn sample_batch() -> InputBatch {
        let revision = 0x0123_4567_89ab_cdef;
        InputBatch {
            frame_seq: 77,
            instructions: vec![
                instruction(InputCommand::Replace {
                    node_id: 1,
                    base_revision: revision,
                    start: 2,
                    end: 4,
                    text: "替换".to_owned(),
                }),
                instruction(InputCommand::SetWordBoundaries {
                    node_id: 1,
                    base_revision: revision,
                    boundaries: vec![0, 2, 4],
                }),
                instruction(InputCommand::Insert {
                    node_id: 1,
                    base_revision: revision + 1,
                    text: "👨‍👩‍👧‍👦".to_owned(),
                }),
                instruction(InputCommand::DeleteBackward {
                    node_id: 1,
                    base_revision: revision + 2,
                }),
                instruction(InputCommand::DeleteForward {
                    node_id: 1,
                    base_revision: revision + 3,
                }),
                instruction(InputCommand::SetSelection {
                    node_id: 1,
                    base_revision: revision + 4,
                    selection: InputSelection {
                        anchor: InputPosition {
                            offset: 8,
                            affinity: InputAffinity::Upstream,
                        },
                        focus: InputPosition {
                            offset: 3,
                            affinity: InputAffinity::Downstream,
                        },
                    },
                }),
                instruction(InputCommand::BeginComposition {
                    node_id: 1,
                    base_revision: revision + 5,
                }),
                instruction(InputCommand::UpdateComposition {
                    node_id: 1,
                    base_revision: revision + 6,
                    text: "に".to_owned(),
                }),
                instruction(InputCommand::CommitComposition {
                    node_id: 1,
                    base_revision: revision + 7,
                    text: Some("日本".to_owned()),
                }),
                instruction(InputCommand::CommitComposition {
                    node_id: 1,
                    base_revision: revision + 8,
                    text: None,
                }),
                instruction(InputCommand::CancelComposition {
                    node_id: 1,
                    base_revision: revision + 9,
                }),
                instruction(InputCommand::Undo {
                    node_id: 1,
                    base_revision: revision + 10,
                }),
                instruction(InputCommand::Redo {
                    node_id: 1,
                    base_revision: revision + 11,
                }),
                instruction(InputCommand::FocusEditable { node_id: 1 }),
                instruction(InputCommand::BlurEditable { node_id: 1 }),
                instruction(InputCommand::ScrollBegin { node_id: 2 }),
                instruction(InputCommand::ScrollDelta {
                    node_id: 2,
                    delta_x: -3.5,
                    delta_y: 24.25,
                    elapsed_micros: 16_667,
                }),
                instruction(InputCommand::ScrollEnd { node_id: 2 }),
                instruction(InputCommand::ScrollCancel { node_id: 2 }),
                instruction(InputCommand::SetScrollVelocity {
                    node_id: 2,
                    velocity_x: 0.0,
                    velocity_y: 216.0,
                }),
                instruction(InputCommand::ScrollTo {
                    node_id: 2,
                    x: 120.0,
                    y: 48.0,
                }),
                instruction(InputCommand::ScrollBy {
                    node_id: 2,
                    delta_x: -20.0,
                    delta_y: 12.0,
                }),
                instruction(InputCommand::RequestCharacterBounds {
                    node_id: 1,
                    start: 0,
                    end: 4,
                }),
                instruction(InputCommand::PlaceCaret {
                    node_id: 1,
                    position: [42.5, -3.25],
                    flags: 0b11,
                }),
                instruction(InputCommand::MoveCaret {
                    node_id: 1,
                    direction: CaretDirection::Down,
                    granularity: CaretGranularity::Word,
                    extend: true,
                }),
                instruction(InputCommand::MoveCaret {
                    node_id: 1,
                    direction: CaretDirection::LineEnd,
                    granularity: CaretGranularity::Grapheme,
                    extend: false,
                }),
                instruction(InputCommand::DispatchEvent {
                    event_id: 19,
                    kind: InputEventKind::Wheel,
                    flags: 0,
                    position: [12.5, 24.0],
                    delta: [-3.0, 40.0],
                    buttons: 1,
                    modifiers: 9,
                    pointer_id: 0,
                    elapsed_micros: 16_667,
                    pointer_type: InputPointerType::None,
                    is_primary: false,
                    pressure: 0.0,
                    tilt: [0.0, 0.0],
                    contact_size: [0.0, 0.0],
                }),
                instruction(InputCommand::DispatchEvent {
                    event_id: 20,
                    kind: InputEventKind::PointerDown,
                    flags: 0,
                    position: [1.0, 2.0],
                    delta: [0.0, 0.0],
                    buttons: 1,
                    modifiers: 0,
                    pointer_id: 7,
                    elapsed_micros: 8_000,
                    pointer_type: InputPointerType::Mouse,
                    is_primary: true,
                    pressure: 0.5,
                    tilt: [0.0, 0.0],
                    contact_size: [1.0, 1.0],
                }),
                instruction(InputCommand::SetPointerCapture {
                    event_id: 21,
                    pointer_id: 7,
                    node_id: 2,
                }),
                instruction(InputCommand::ReleasePointerCapture {
                    event_id: 22,
                    pointer_id: 7,
                    node_id: 2,
                }),
                instruction(InputCommand::FocusNode {
                    event_id: 23,
                    node_id: 2,
                    origin: InputFocusOrigin::Keyboard,
                }),
                instruction(InputCommand::BlurNode {
                    event_id: 24,
                    node_id: 2,
                }),
                instruction(InputCommand::ResetInteraction {
                    event_id: 25,
                    reason: InteractionResetReason::TransportRecovery,
                }),
            ],
        }
    }

    #[test]
    fn word_boundaries_round_trip_and_reject_a_malformed_set() {
        // Variable length, so the framing has to survive an empty set as well as
        // a populated one.
        for boundaries in [vec![], vec![0], vec![0, 2, 5, 9]] {
            let batch = InputBatch {
                frame_seq: 3,
                instructions: vec![instruction(InputCommand::SetWordBoundaries {
                    node_id: 0x0010_0001,
                    base_revision: 0x0000_0007_0000_0009,
                    boundaries,
                })],
            };
            let bytes = batch.encode().expect("encode");
            assert_eq!(InputBatch::decode(&bytes), Ok(batch));
        }

        // Unsorted or duplicated would give one segmentation two byte sequences.
        for boundaries in [vec![2, 1], vec![1, 1]] {
            let batch = InputBatch {
                frame_seq: 1,
                instructions: vec![instruction(InputCommand::SetWordBoundaries {
                    node_id: 1,
                    base_revision: 0,
                    boundaries,
                })],
            };
            assert_eq!(
                batch.encode(),
                Err(AbiError::InvalidValue(
                    "word boundaries must ascend without duplicates"
                ))
            );
        }

        let encoded = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::SetWordBoundaries {
                node_id: 1,
                base_revision: 0,
                boundaries: vec![0, 2],
            })],
        }
        .encode()
        .expect("encode");
        // The count sits after the stream header, the instruction header, the
        // node id and both revision halves.
        let count_offset = 16 + 4 + 4 + 8;
        assert_eq!(
            u32::from_le_bytes(
                encoded[count_offset..count_offset + 4]
                    .try_into()
                    .expect("count")
            ),
            2
        );
        let mut over_limit = encoded.clone();
        over_limit[count_offset..count_offset + 4]
            .copy_from_slice(&(MAX_WORD_BOUNDARIES + 1).to_le_bytes());
        assert_eq!(
            InputBatch::decode(&over_limit),
            Err(AbiError::InvalidValue(
                "word boundary count is outside the supported limit"
            ))
        );

        // Under the limit but past the payload: this must fail on the read, not
        // on a reservation sized by the attacker's number.
        let mut beyond_payload = encoded.clone();
        beyond_payload[count_offset..count_offset + 4]
            .copy_from_slice(&1_000_000_u32.to_le_bytes());
        assert!(InputBatch::decode(&beyond_payload).is_err());

        let mut descending = encoded;
        descending[count_offset + 4..count_offset + 8].copy_from_slice(&9_u32.to_le_bytes());
        descending[count_offset + 8..count_offset + 12].copy_from_slice(&1_u32.to_le_bytes());
        assert_eq!(
            InputBatch::decode(&descending),
            Err(AbiError::InvalidValue(
                "word boundaries must ascend without duplicates"
            ))
        );
    }

    #[test]
    fn every_input_command_round_trips_with_exact_revisions_and_unicode() {
        let batch = sample_batch();
        let bytes = batch.encode().expect("encode input batch");
        assert_eq!(InputBatch::decode(&bytes), Ok(batch));
        assert_eq!(bytes.len() % 4, 0);
    }

    #[test]
    fn rejects_unknown_flags_opcodes_affinities_presence_and_utf8() {
        let flagged = InputBatch {
            frame_seq: 1,
            instructions: vec![InputInstruction {
                flags: 1,
                command: InputCommand::Undo {
                    node_id: 1,
                    base_revision: 0,
                },
            }],
        };
        assert!(matches!(
            flagged.encode(),
            Err(AbiError::UnsupportedFlags { flags: 1, .. })
        ));

        let mut unknown = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::Undo {
                node_id: 1,
                base_revision: 0,
            })],
        }
        .encode()
        .expect("undo bytes");
        unknown[16] = 0xfe;
        assert!(matches!(
            InputBatch::decode(&unknown),
            Err(AbiError::UnknownOpcode {
                stream: StreamKind::Input,
                opcode: 0xfe,
                offset: 16,
            })
        ));

        let mut selection = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::SetSelection {
                node_id: 1,
                base_revision: 0,
                selection: InputSelection {
                    anchor: InputPosition {
                        offset: 0,
                        affinity: InputAffinity::Upstream,
                    },
                    focus: InputPosition {
                        offset: 0,
                        affinity: InputAffinity::Downstream,
                    },
                },
            })],
        }
        .encode()
        .expect("selection bytes");
        selection[40] = 2;
        assert!(matches!(
            InputBatch::decode(&selection),
            Err(AbiError::UnknownIdentifier {
                category: "input affinity",
                value: 2,
            })
        ));

        let mut composition = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::CommitComposition {
                node_id: 1,
                base_revision: 0,
                text: Some("x".to_owned()),
            })],
        }
        .encode()
        .expect("composition bytes");
        composition[32] = 0;
        assert_eq!(
            InputBatch::decode(&composition),
            Err(AbiError::InvalidValue(
                "absent composition text is non-empty"
            ))
        );
        composition[32] = 2;
        assert_eq!(
            InputBatch::decode(&composition),
            Err(AbiError::InvalidValue(
                "invalid composition text presence flag"
            ))
        );
        composition[32] = 1;
        composition[40] = 0xff;
        assert_eq!(
            InputBatch::decode(&composition),
            Err(AbiError::InvalidValue("input text is not valid UTF-8"))
        );
    }

    #[test]
    fn rejects_invalid_caret_event_and_bounds_fields_on_encode_and_decode() {
        let encode_one = |command: InputCommand| {
            InputBatch {
                frame_seq: 1,
                instructions: vec![instruction(command)],
            }
            .encode()
        };
        assert!(
            encode_one(InputCommand::PlaceCaret {
                node_id: 1,
                position: [f32::NAN, 0.0],
                flags: 0,
            })
            .is_err()
        );
        assert!(
            encode_one(InputCommand::PlaceCaret {
                node_id: 1,
                position: [2_000_000_000.0, 0.0],
                flags: 0,
            })
            .is_err()
        );
        assert!(
            encode_one(InputCommand::PlaceCaret {
                node_id: 1,
                position: [0.0, 0.0],
                flags: 0b100,
            })
            .is_err()
        );
        assert!(
            encode_one(InputCommand::RequestCharacterBounds {
                node_id: 1,
                start: 4,
                end: 2,
            })
            .is_err()
        );
        for (buttons, modifiers, elapsed, coordinate, delta) in [
            (0x1_0000_u32, 0_u32, 1_u32, 0.0_f32, 0.0_f32),
            (0, 0x10, 1, 0.0, 0.0),
            (0, 0, 0, 0.0, 0.0),
            (0, 0, 2_000_000, 0.0, 0.0),
            (0, 0, 1, 2_000_000_000.0, 0.0),
            (0, 0, 1, 0.0, 2_000_000.0),
        ] {
            assert!(
                encode_one(InputCommand::DispatchEvent {
                    event_id: 1,
                    kind: InputEventKind::PointerMove,
                    flags: 0,
                    position: [coordinate, 0.0],
                    delta: [delta, 0.0],
                    buttons,
                    modifiers,
                    pointer_id: 1,
                    elapsed_micros: elapsed,
                    pointer_type: InputPointerType::Mouse,
                    is_primary: true,
                    pressure: 0.5,
                    tilt: [0.0, 0.0],
                    contact_size: [1.0, 1.0],
                })
                .is_err()
            );
        }
        assert!(
            encode_one(InputCommand::DispatchEvent {
                event_id: 1,
                kind: InputEventKind::PointerOver,
                flags: 0,
                position: [0.0, 0.0],
                delta: [0.0, 0.0],
                buttons: 0,
                modifiers: 0,
                pointer_id: 1,
                elapsed_micros: 1,
                pointer_type: InputPointerType::Mouse,
                is_primary: true,
                pressure: 0.0,
                tilt: [0.0, 0.0],
                contact_size: [1.0, 1.0],
            })
            .is_err(),
            "Core-synthesized lifecycle events must not enter through Host input"
        );
        for command in [
            InputCommand::SetPointerCapture {
                event_id: 1,
                pointer_id: 0,
                node_id: 1,
            },
            InputCommand::ReleasePointerCapture {
                event_id: 1,
                pointer_id: 0,
                node_id: 1,
            },
        ] {
            assert!(encode_one(command).is_err());
        }

        // Event flags: only defined bits encode, and reserved bits fail closed
        // on both sides so a newer producer cannot silently change semantics.
        let precise = InputCommand::DispatchEvent {
            event_id: 1,
            kind: InputEventKind::Wheel,
            flags: EVENT_FLAG_PRECISE_WHEEL,
            position: [4.0, 8.0],
            delta: [0.0, 40.0],
            buttons: 0,
            modifiers: 0,
            pointer_id: 0,
            elapsed_micros: 16_667,
            pointer_type: InputPointerType::None,
            is_primary: false,
            pressure: 0.0,
            tilt: [0.0, 0.0],
            contact_size: [0.0, 0.0],
        };
        let encoded = encode_one(precise.clone()).expect("precise wheel");
        assert_eq!(
            InputBatch::decode(&encoded).expect("decode").instructions[0].command,
            precise
        );
        assert!(
            encode_one(InputCommand::DispatchEvent {
                event_id: 1,
                kind: InputEventKind::Wheel,
                flags: EVENT_FLAG_MASK + 1,
                position: [4.0, 8.0],
                delta: [0.0, 40.0],
                buttons: 0,
                modifiers: 0,
                pointer_id: 0,
                elapsed_micros: 16_667,
                pointer_type: InputPointerType::None,
                is_primary: false,
                pressure: 0.0,
                tilt: [0.0, 0.0],
                contact_size: [0.0, 0.0],
            })
            .is_err(),
            "reserved event flag bits must not encode"
        );
        let flags_offset = encoded
            .windows(4)
            .position(|window| window == [InputEventKind::Wheel as u8, 0, 1, 0])
            .expect("encoded event kind and flags")
            + 2;
        for reserved in [EVENT_FLAG_MASK + 1, 0x8000] {
            let mut bytes = encoded.clone();
            bytes[flags_offset..flags_offset + 2].copy_from_slice(&reserved.to_le_bytes());
            assert!(
                InputBatch::decode(&bytes).is_err(),
                "reserved event flags {reserved} must fail closed"
            );
        }

        // Decode-side rejections for hostile caret payload bytes.
        let valid = encode_one(InputCommand::MoveCaret {
            node_id: 1,
            direction: CaretDirection::Backward,
            granularity: CaretGranularity::Grapheme,
            extend: false,
        })
        .expect("valid move caret");
        for (offset, value) in [(24_usize, 9_u8), (25, 2), (26, 3), (27, 1)] {
            let mut bytes = valid.clone();
            bytes[offset] = value;
            assert!(
                InputBatch::decode(&bytes).is_err(),
                "byte {offset} value {value} must fail closed"
            );
        }
        for direction in [
            CaretDirection::Backward,
            CaretDirection::Forward,
            CaretDirection::Up,
            CaretDirection::Down,
            CaretDirection::LineStart,
            CaretDirection::LineEnd,
        ] {
            let bytes = encode_one(InputCommand::MoveCaret {
                node_id: 1,
                direction,
                granularity: CaretGranularity::Grapheme,
                extend: true,
            })
            .expect("directional move");
            assert!(InputBatch::decode(&bytes).is_ok());
        }
        let place = encode_one(InputCommand::PlaceCaret {
            node_id: 1,
            position: [4.0, 8.0],
            flags: 0,
        })
        .expect("valid place caret");
        let mut hostile = place.clone();
        hostile[32] = 0xff;
        assert!(InputBatch::decode(&hostile).is_err());
        assert_eq!(
            AbiError::InvalidValue("caret placement flags are reserved").to_string(),
            "invalid pingo ABI stream: InvalidValue(\"caret placement flags are reserved\")"
        );
    }

    #[test]
    fn rejects_invalid_scroll_sample_bounds_on_encode_and_decode() {
        let invalid_time = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::ScrollDelta {
                node_id: 1,
                delta_x: 0.0,
                delta_y: 1.0,
                elapsed_micros: 0,
            })],
        };
        assert_eq!(
            invalid_time.encode(),
            Err(AbiError::InvalidValue(
                "scroll delta elapsed time is invalid"
            ))
        );

        let mut bytes = InputBatch {
            frame_seq: 1,
            instructions: vec![instruction(InputCommand::ScrollDelta {
                node_id: 1,
                delta_x: 0.0,
                delta_y: 1.0,
                elapsed_micros: 16_667,
            })],
        }
        .encode()
        .expect("scroll sample");
        bytes[24..28].copy_from_slice(&f32::NAN.to_le_bytes());
        assert_eq!(
            InputBatch::decode(&bytes),
            Err(AbiError::NonFiniteFloat { offset: 24 })
        );
    }

    #[test]
    fn rejects_missing_or_non_final_commit_and_hostile_declared_sizes() {
        let missing = Writer::new(INPUT_MAGIC)
            .finish(MAX_INPUT_BYTES)
            .expect("header only");
        assert_eq!(InputBatch::decode(&missing), Err(AbiError::MissingCommit));

        let mut extra = InputBatch {
            frame_seq: 1,
            instructions: Vec::new(),
        }
        .encode()
        .expect("commit");
        // One word: a header-only instruction.
        extra.extend_from_slice(&[InputOpcode::Undo as u8, 0, 1, 0]);
        extra.extend_from_slice(&1_u32.to_le_bytes());
        extra.extend_from_slice(&0_u64.to_le_bytes());
        let length = u32::try_from(extra.len()).expect("short fixture");
        extra[8..12].copy_from_slice(&length.to_le_bytes());
        extra[12..16].copy_from_slice(&2_u32.to_le_bytes());
        assert_eq!(
            InputBatch::decode(&extra),
            Err(AbiError::CommitNotLast { offset: 24 })
        );

        let mut hostile_count = InputBatch {
            frame_seq: 1,
            instructions: Vec::new(),
        }
        .encode()
        .expect("commit");
        hostile_count[12..16].copy_from_slice(&(MAX_INPUT_INSTRUCTIONS + 1).to_le_bytes());
        assert!(matches!(
            InputBatch::decode(&hostile_count),
            Err(AbiError::InstructionCountTooLarge { .. })
        ));

        let mut oversized = Writer::new(INPUT_MAGIC);
        oversized.instruction(InputOpcode::Insert as u8, 0);
        write_target(&mut oversized, 1, 0);
        oversized.u32(u32::try_from(MAX_RESOURCE_BYTES + 1).expect("bounded maximum"));
        let oversized = oversized
            .finish(MAX_INPUT_BYTES)
            .expect("short hostile stream");
        assert!(matches!(
            InputBatch::decode(&oversized),
            Err(AbiError::ResourceTooLarge { .. })
        ));
    }

    proptest! {
        #[test]
        fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..4096)) {
            let _ = InputBatch::decode(&bytes);
        }
    }
    #[test]
    fn an_unknown_input_command_is_skipped_only_when_the_producer_allowed_it() {
        // Input carries what the user did, so dropping an unmarked unknown
        // command could silently change the gesture. Dropping one the producer
        // marked skippable is the defined downgrade.
        let build = |flags: u8| {
            let canonical = sample_batch().encode().expect("sample encodes");
            let commit = canonical.len() - 8;
            let mut bytes = canonical;
            bytes.splice(commit..commit, [0xfe_u8, flags, 2, 0, 0, 0, 0, 0]);
            let length = u32::try_from(bytes.len()).expect("length");
            bytes[8..12].copy_from_slice(&length.to_le_bytes());
            let count = u32::from_le_bytes(bytes[12..16].try_into().expect("count")) + 1;
            bytes[12..16].copy_from_slice(&count.to_le_bytes());
            bytes
        };

        let (batch, report) =
            InputBatch::decode_with_report(&build(INSTRUCTION_FLAG_OPTIONAL)).expect("skipped");
        assert_eq!(report.skipped_instructions, 1);
        assert_eq!(batch, sample_batch());

        assert!(matches!(
            InputBatch::decode(&build(0)),
            Err(AbiError::UnknownOpcode { opcode: 0xfe, .. })
        ));
    }
}
