#![no_main]

use doper_abi::DisplayList;
use libfuzzer_sys::fuzz_target;

fuzz_target!(|bytes: &[u8]| {
    let _ = DisplayList::decode(bytes);
});
