use wasm_bindgen::prelude::*;

use crate::{CoreEngine, FrameDiagnostics};

/// JavaScript-facing owner for one single-threaded Core instance.
#[wasm_bindgen]
pub struct WasmCore {
    inner: CoreEngine,
    last_diagnostics: Option<FrameDiagnostics>,
}

#[wasm_bindgen]
impl WasmCore {
    /// Creates a Core instance bounded by the initial logical viewport.
    #[wasm_bindgen(constructor)]
    pub fn new(width: f32, height: f32) -> Result<Self, JsValue> {
        CoreEngine::new(width, height)
            .map(|inner| Self {
                inner,
                last_diagnostics: None,
            })
            .map_err(js_error)
    }

    /// Atomically consumes one complete Mutation Stream and returns `DisplayList` bytes.
    pub fn commit(&mut self, bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
        let output = self.inner.commit(bytes).map_err(js_error)?;
        self.last_diagnostics = Some(output.diagnostics);
        Ok(output.display_list.to_vec())
    }

    /// Returns versioned u32 diagnostics for the most recently accepted frame.
    pub fn frame_diagnostics(&self) -> Result<Vec<u32>, JsValue> {
        self.last_diagnostics
            .map(|diagnostics| diagnostics.to_words().to_vec())
            .ok_or_else(|| JsValue::from_str("no doper frame has committed"))
    }

    /// Applies logical viewport bounds to the next frame.
    pub fn set_viewport(&mut self, width: f32, height: f32) -> Result<(), JsValue> {
        self.inner.set_viewport(width, height).map_err(js_error)
    }

    /// Reports whether this instance must be discarded after a fatal derivation failure.
    #[must_use]
    pub fn is_poisoned(&self) -> bool {
        self.inner.is_poisoned()
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
