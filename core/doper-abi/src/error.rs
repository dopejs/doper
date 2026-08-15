use core::fmt;

/// Identifies the protocol being decoded.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamKind {
    /// Shell-to-Core mutation stream.
    Mutation,
    /// Host-to-Core editing input stream.
    Input,
    /// Core-to-backend display list.
    DisplayList,
    /// Ordered mutation and editing replay recording.
    Recording,
}

/// A deterministic validation failure for an untrusted binary stream.
#[allow(missing_docs)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AbiError {
    /// Input exceeds the protocol's configured memory budget.
    TooLarge { actual: usize, maximum: usize },
    /// Input length or an instruction boundary is not four-byte aligned.
    Misaligned { offset: usize },
    /// Input ended before a complete field could be read.
    Truncated {
        offset: usize,
        needed: usize,
        available: usize,
    },
    /// Stream magic does not identify the expected protocol.
    WrongMagic { expected: u32, actual: u32 },
    /// The peer uses an unsupported ABI version.
    UnsupportedVersion { expected: u16, actual: u16 },
    /// Header size is not the canonical size for this ABI.
    InvalidHeaderLength { actual: u16 },
    /// Declared and actual stream lengths differ.
    LengthMismatch { declared: usize, actual: usize },
    /// A reserved field or padding byte is non-zero.
    NonZeroReserved { offset: usize },
    /// An opcode is not defined for the stream version.
    UnknownOpcode {
        stream: StreamKind,
        opcode: u8,
        offset: usize,
    },
    /// Instruction flags contain bits not defined by this ABI version.
    UnsupportedFlags { offset: usize, flags: u8 },
    /// Instruction count does not match the decoded stream.
    InstructionCountMismatch { declared: u32, actual: u32 },
    /// Declared count cannot fit in the remaining bytes even with empty commands.
    InstructionCountTooLarge { declared: u32, maximum: u32 },
    /// Codec consumption disagrees with the generated instruction layout.
    InstructionLengthMismatch {
        opcode: u8,
        offset: usize,
        expected: usize,
        actual: usize,
    },
    /// A generated enum identifier is unknown.
    UnknownIdentifier { category: &'static str, value: u32 },
    /// A property was encoded with the wrong wire instruction.
    WrongPropertyEncoding {
        prop: u16,
        expected: &'static str,
        actual: &'static str,
    },
    /// A floating-point field contains NaN or infinity.
    NonFiniteFloat { offset: usize },
    /// A variable-sized field exceeds its local resource budget.
    ResourceTooLarge { actual: usize, maximum: usize },
    /// Integer arithmetic would overflow while parsing or encoding.
    ArithmeticOverflow,
    /// Transactional streams must end in exactly one Commit command.
    MissingCommit,
    /// No command may follow Commit.
    CommitNotLast { offset: usize },
    /// DisplayList Restore would underflow the graphics state stack.
    RestoreUnderflow { offset: usize },
    /// DisplayList ended with unmatched Save commands.
    UnbalancedState { depth: u32 },
    /// Encoding an in-memory value would violate the ABI.
    InvalidValue(&'static str),
}

impl fmt::Display for AbiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "invalid doper ABI stream: {self:?}")
    }
}

impl std::error::Error for AbiError {}
