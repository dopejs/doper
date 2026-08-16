use std::io::{self, Read};

use doper_abi::{
    DisplayList, GlyphResourceBatch, InputBatch, MutationBatch, ReplayRecording,
    SystemTextMetricBatch,
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let stream = std::env::args()
        .nth(1)
        .ok_or("expected stream kind: mutation, input, recording, or display")?;
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let bytes = decode_hex(input.trim())?;
    let output = match stream.as_str() {
        "mutation" => MutationBatch::decode(&bytes)?.encode()?,
        "input" => InputBatch::decode(&bytes)?.encode()?,
        "recording" => ReplayRecording::decode(&bytes)?.encode()?,
        "display" => DisplayList::decode(&bytes)?.encode()?,
        "glyph" => GlyphResourceBatch::decode(&bytes)?.encode()?,
        "text-metrics" => SystemTextMetricBatch::decode(&bytes)?.encode()?,
        _ => return Err(format!("unknown stream kind {stream}").into()),
    };
    println!("{}", encode_hex(&output));
    Ok(())
}

fn decode_hex(value: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !value.len().is_multiple_of(2) {
        return Err("hex input has an odd number of digits".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|index| Ok(u8::from_str_radix(&value[index..index + 2], 16)?))
        .collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
