use wasm_bindgen::prelude::*;

use pingo_abi::{VIRTUAL_REFILL_HEADER_WORDS, VIRTUAL_REFILL_RECORD_WORDS, VIRTUAL_REFILL_VERSION};

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
    pub fn new(width: f32, height: f32, ios_physics: bool) -> Result<Self, JsValue> {
        // The host knows the device; the engine should not guess. Coast distance
        // is the most visible part of "feels native" and the two families differ
        // by about three times for the same release velocity.
        let platform = if ios_physics {
            crate::ScrollPlatform::Ios
        } else {
            crate::ScrollPlatform::Android
        };
        CoreEngine::for_platform(width, height, platform)
            .map(|inner| Self {
                inner,
                last_diagnostics: None,
            })
            .map_err(js_error)
    }

    /// Atomically consumes one complete Mutation Stream and returns `DisplayList` bytes.
    pub fn commit(
        &mut self,
        bytes: &[u8],
        system_text_metrics: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, JsValue> {
        let output = self
            .inner
            .commit_with_system_text_metrics(bytes, system_text_metrics.as_deref())
            .map_err(js_error)?;
        self.last_diagnostics = Some(output.diagnostics);
        Ok(output.display_list.to_vec())
    }

    /// Refreshes Host-measured system-font metrics and returns a replacement frame if needed.
    pub fn set_system_text_metrics(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        let output = self
            .inner
            .set_system_text_metrics(bytes)
            .map_err(js_error)?;
        if let Some(output) = output {
            self.last_diagnostics = Some(output.diagnostics);
            Ok(Some(output.display_list.to_vec()))
        } else {
            Ok(None)
        }
    }

    /// Atomically consumes one Input Stream transaction.
    pub fn input(&mut self, bytes: &[u8]) -> Result<Option<Vec<u8>>, JsValue> {
        let output = self.inner.input(bytes).map_err(js_error)?;
        if let Some(output) = output {
            self.last_diagnostics = Some(output.diagnostics);
            Ok(Some(output.display_list.to_vec()))
        } else {
            Ok(None)
        }
    }

    /// Advances Core-owned animation from an injectable elapsed duration.
    pub fn advance(&mut self, elapsed_seconds: f64) -> Result<Option<Vec<u8>>, JsValue> {
        let output = self.inner.advance(elapsed_seconds).map_err(js_error)?;
        if let Some(output) = output {
            self.last_diagnostics = Some(output.diagnostics);
            Ok(Some(output.display_list.to_vec()))
        } else {
            Ok(None)
        }
    }

    /// Applies the host accessibility preference to active and future animations.
    pub fn set_reduced_motion(&mut self, reduced: bool) -> Result<Option<Vec<u8>>, JsValue> {
        let output = self.inner.set_reduced_motion(reduced).map_err(js_error)?;
        if let Some(output) = output {
            self.last_diagnostics = Some(output.diagnostics);
            Ok(Some(output.display_list.to_vec()))
        } else {
            Ok(None)
        }
    }

    /// Returns versioned u32 diagnostics for the most recently accepted frame.
    pub fn frame_diagnostics(&self) -> Result<Vec<u32>, JsValue> {
        self.last_diagnostics
            .map(|diagnostics| diagnostics.to_words().to_vec())
            .ok_or_else(|| JsValue::from_str("no pingo frame has committed"))
    }

    /// Drains versioned virtual-list refill requests for asynchronous Shell work.
    pub fn take_virtual_refills(&mut self) -> Result<Vec<u32>, JsValue> {
        let requests = self.inner.take_virtual_refills();
        let count = u32::try_from(requests.len())
            .map_err(|_| JsValue::from_str("virtual refill request count exceeds u32"))?;
        let capacity = VIRTUAL_REFILL_HEADER_WORDS
            .checked_add(
                requests
                    .len()
                    .checked_mul(VIRTUAL_REFILL_RECORD_WORDS)
                    .ok_or_else(|| JsValue::from_str("virtual refill buffer overflow"))?,
            )
            .ok_or_else(|| JsValue::from_str("virtual refill buffer overflow"))?;
        let mut words = Vec::with_capacity(capacity);
        words.push(VIRTUAL_REFILL_VERSION);
        words.push(count);
        for request in requests {
            words.extend_from_slice(&[request.node_id, request.start, request.end]);
        }
        Ok(words)
    }

    /// Drains the glyph-span resource delta required before replaying the latest DisplayList.
    pub fn take_glyph_resources(&mut self) -> Vec<u8> {
        self.inner.take_glyph_resources()
    }

    /// Enables the incremental Picture path or the inline runtime rollback path.
    pub fn set_incremental_pictures_enabled(&mut self, enabled: bool) -> Result<(), JsValue> {
        self.inner
            .set_incremental_pictures_enabled(enabled)
            .map_err(js_error)
    }

    /// Returns a pending immutable Picture transaction without acknowledging it.
    pub fn take_picture_resources(&self) -> Vec<u8> {
        self.inner.take_picture_resources()
    }

    /// Confirms that the backend atomically installed a Picture transaction.
    pub fn acknowledge_picture_resources(&mut self, frame_seq: u32) -> Result<(), JsValue> {
        self.inner
            .acknowledge_picture_resources(frame_seq)
            .map_err(js_error)
    }

    /// Drains revisioned Core-to-Host editing transactions.
    pub fn take_edit_transactions(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.take_edit_transactions().map_err(js_error)
    }

    /// Drains Core-hit-tested event propagation paths.
    pub fn take_event_transactions(&mut self) -> Result<Vec<u8>, JsValue> {
        self.inner.take_event_transactions().map_err(js_error)
    }

    /// Returns latest non-passive browser-input region words.
    pub fn non_passive_regions(&self) -> Vec<u32> {
        self.inner.non_passive_regions()
    }

    /// Returns latest active editor and requested character geometry words.
    pub fn editing_geometry(&self) -> Vec<u32> {
        self.inner.editing_geometry()
    }

    /// Serializes the committed semantic tree for the accessibility mirror.
    pub fn semantics(&self) -> Vec<u8> {
        self.inner.semantics()
    }

    /// Applies logical viewport bounds, returning a reflowed DisplayList.
    pub fn set_viewport(&mut self, width: f32, height: f32) -> Result<Option<Vec<u8>>, JsValue> {
        let output = self.inner.set_viewport(width, height).map_err(js_error)?;
        if let Some(output) = output {
            self.last_diagnostics = Some(output.diagnostics);
            Ok(Some(output.display_list.to_vec()))
        } else {
            Ok(None)
        }
    }

    /// Rebuilds DPR-sensitive glyph resources and returns a replacement DisplayList when needed.
    pub fn set_device_pixel_ratio(
        &mut self,
        device_pixel_ratio: f32,
    ) -> Result<Option<Vec<u8>>, JsValue> {
        let output = self
            .inner
            .set_device_pixel_ratio(device_pixel_ratio)
            .map_err(js_error)?;
        if let Some(output) = output {
            self.last_diagnostics = Some(output.diagnostics);
            Ok(Some(output.display_list.to_vec()))
        } else {
            Ok(None)
        }
    }

    /// Reports whether this instance must be discarded after a fatal derivation failure.
    #[must_use]
    pub fn is_poisoned(&self) -> bool {
        self.inner.is_poisoned()
    }
}

fn js_error(error: crate::CoreError) -> JsValue {
    JsValue::from_str(error.operator_code())
}
