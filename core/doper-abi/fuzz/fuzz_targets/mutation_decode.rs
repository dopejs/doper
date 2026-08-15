#![no_main]

use doper_abi::MutationBatch;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    let _ = MutationBatch::decode(bytes);
});
