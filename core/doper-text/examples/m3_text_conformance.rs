use std::{env, fs, sync::Arc};

use doper_text::{FontFace, TextEngine, TextOptions};

fn main() {
    let path = env::args()
        .nth(1)
        .expect("usage: m3_text_conformance <sfnt-font>");
    let bytes = fs::read(path).expect("read conformance font");
    let font = FontFace::from_bytes(17, 1, 0, Arc::from(bytes)).expect("valid conformance font");
    let options = TextOptions {
        font_size: 18.0,
        line_height: 24.0,
        max_width: 42.0,
    };
    let mut engine = TextEngine::new(128 * 1024);
    let supported = engine
        .layout(&font, "\u{ea60}", options)
        .expect("shape a font-owned glyph");
    assert_eq!(supported.missing_glyphs, 0, "fixture glyph must exist");
    let text = "\u{ea60}\u{ea61}\u{ea62}\u{ea63}\nA e\u{301} 👩‍💻 中文";
    let first = engine.layout(&font, text, options).expect("shape and wrap");
    assert!(first.lines.len() >= 2, "newline must create multiple lines");
    assert!(!first.glyphs.is_empty(), "font must produce glyph output");
    assert!(
        first
            .graphemes
            .iter()
            .any(|item| &first.text[item.bytes.clone()] == "👩‍💻"),
        "ZWJ sequence must remain one grapheme"
    );
    assert!(first.carets.windows(2).all(|pair| {
        pair[0].line < pair[1].line
            || (pair[0].line == pair[1].line && pair[0].utf16_offset <= pair[1].utf16_offset)
    }));
    let second = engine.layout(&font, text, options).expect("cache hit");
    assert!(
        Arc::ptr_eq(&first, &second),
        "cache must reuse immutable layout"
    );
    let metrics = engine.metrics();
    assert_eq!(metrics.hits, 1);
    assert_eq!(metrics.misses, 2);
    assert_eq!(metrics.entries, 2);
    assert!(metrics.retained_bytes <= 128 * 1024);
    println!(
        "lines={} graphemes={} clusters={} glyphs={} carets={} missing={} retained_bytes={}",
        first.lines.len(),
        first.graphemes.len(),
        first.clusters.len(),
        first.glyphs.len(),
        first.carets.len(),
        first.missing_glyphs,
        metrics.retained_bytes
    );
}
