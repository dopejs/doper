//! Minimal Rust/WASM payload used by the M0 cold-start probe.
//!
//! This deliberately avoids `wasm-bindgen` so the measurement captures the
//! minimum Rust runtime cost instead of JS binding glue.

/// ABI version for the standalone probe module.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pingo_probe_abi_version() -> u32 {
    1
}

/// A deterministic, non-trivial call used to verify successful instantiation.
// SAFETY: This crate owns this globally unique probe export name.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
pub extern "C" fn pingo_probe_mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x7FEB_352D);
    value ^= value >> 15;
    value = value.wrapping_mul(0x846C_A68B);
    value ^ (value >> 16)
}

#[cfg(test)]
mod tests {
    use super::{pingo_probe_abi_version, pingo_probe_mix};

    #[test]
    fn reports_expected_abi_version() {
        assert_eq!(pingo_probe_abi_version(), 1);
    }

    #[test]
    fn mixer_is_deterministic_and_non_identity() {
        assert_eq!(pingo_probe_mix(42), pingo_probe_mix(42));
        assert_ne!(pingo_probe_mix(42), 42);
    }
}
