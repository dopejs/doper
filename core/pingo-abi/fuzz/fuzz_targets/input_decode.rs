#![no_main]

use pingo_abi::InputBatch;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    let _ = InputBatch::decode(bytes);
});
