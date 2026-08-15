#![forbid(unsafe_code)]
#![deny(missing_docs)]

//! Deterministic web-font shaping, wrapping and editing-offset geometry.

mod atlas;
mod cache;
mod error;
mod font;
mod layout;

pub use cache::{DEFAULT_CACHE_BYTES, TextCacheMetrics, TextEngine};
pub use error::TextError;
pub use font::{FontFace, MAX_FONT_BYTES};
pub use layout::{
    CaretStop, Grapheme, MAX_TEXT_BYTES, PositionedGlyph, ShapeCluster, TextLayout, TextLine,
    TextOptions,
};

#[cfg(test)]
fn conformance_font() -> std::sync::Arc<[u8]> {
    use std::{fs, path::PathBuf, sync::Arc};

    let store = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.pnpm");
    let package = fs::read_dir(&store)
        .expect("run pnpm install before the Rust conformance suite")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("playwright-core@")
        })
        .max_by_key(std::fs::DirEntry::file_name)
        .expect("playwright-core conformance package");
    let directory = package
        .path()
        .join("node_modules/playwright-core/lib/vite/traceViewer");
    let font = fs::read_dir(directory)
        .expect("Playwright trace-viewer assets")
        .filter_map(Result::ok)
        .find(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with("codicon.") && name.ends_with(".ttf")
        })
        .expect("Playwright trace-viewer SFNT fixture");
    Arc::from(fs::read(font.path()).expect("read SFNT fixture"))
}
pub use atlas::{DEFAULT_ATLAS_BYTES, GlyphAtlas, GlyphAtlasMetrics, GlyphBitmap, GlyphContent};
