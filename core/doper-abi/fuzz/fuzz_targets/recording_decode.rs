#![no_main]

use doper_abi::ReplayRecording;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    let _ = ReplayRecording::decode(bytes);
});
