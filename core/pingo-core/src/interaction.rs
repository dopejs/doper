use pingo_collections::OrderedMap;

use pingo_abi::{
    EventTransactionRecord, InputEventKind, InputFocusOrigin, InputPointerType,
    InteractionResetReason, NULL_NODE_ID, STYLE_INTERACTION_ACTIVE, STYLE_INTERACTION_FOCUS,
    STYLE_INTERACTION_FOCUS_VISIBLE, STYLE_INTERACTION_HOVER, StyleKeyword, StyleProperty,
};
use pingo_scene::{NodeId, Scene};

#[derive(Clone, Copy, Debug)]
pub(crate) struct PointerEventInput {
    pub event_id: u32,
    pub kind: InputEventKind,
    pub flags: u16,
    pub position: [f32; 2],
    pub delta: [f32; 2],
    pub buttons: u32,
    pub modifiers: u32,
    pub pointer_id: u32,
    pub elapsed_micros: u32,
    pub pointer_type: InputPointerType,
    pub is_primary: bool,
    pub pressure: f32,
    pub tilt: [f32; 2],
    pub contact_size: [f32; 2],
}

/// One non-editing key sample, already validated by the ABI decoder.
#[derive(Clone, Copy, Debug)]
pub(crate) struct KeyEventInput {
    pub event_id: u32,
    pub kind: InputEventKind,
    pub flags: u16,
    pub key_code: u16,
    pub key_name: u16,
    pub key_text: u32,
    pub modifiers: u32,
    pub elapsed_micros: u32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum InteractionCommand {
    Dispatch(PointerEventInput),
    DispatchKey(KeyEventInput),
    SetPointerCapture {
        event_id: u32,
        pointer_id: u32,
        node: NodeId,
    },
    ReleasePointerCapture {
        event_id: u32,
        pointer_id: u32,
        node: NodeId,
    },
    Focus {
        event_id: u32,
        node: NodeId,
        origin: InputFocusOrigin,
    },
    Blur {
        event_id: u32,
        node: NodeId,
    },
    Reset {
        event_id: u32,
        reason: InteractionResetReason,
    },
}

#[derive(Clone, Debug, Default)]
struct PointerState {
    boundary_path: Vec<NodeId>,
    active_path: Vec<NodeId>,
    last: Option<PointerEventInput>,
}

#[derive(Clone, Copy, Debug)]
struct FocusState {
    node: NodeId,
    visible: bool,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct InteractionController {
    pointers: OrderedMap<u32, PointerState>,
    captures: OrderedMap<u32, NodeId>,
    focus: Option<FocusState>,
}

#[derive(Debug, Default)]
pub(crate) struct InteractionResult {
    pub records: Vec<EventTransactionRecord>,
    pub state_changes: usize,
}

impl InteractionController {
    pub fn apply(
        &mut self,
        scene: &mut Scene,
        command: InteractionCommand,
        raw_hit_path: Option<Vec<NodeId>>,
    ) -> InteractionResult {
        let mut records = Vec::new();
        match command {
            InteractionCommand::Dispatch(input) => {
                self.dispatch(scene, input, raw_hit_path, &mut records);
            }
            InteractionCommand::DispatchKey(input) => self.dispatch_key(scene, input, &mut records),
            InteractionCommand::SetPointerCapture {
                event_id,
                pointer_id,
                node,
            } => self.set_capture(scene, event_id, pointer_id, node, &mut records),
            InteractionCommand::ReleasePointerCapture {
                event_id,
                pointer_id,
                node,
            } => self.release_capture(scene, event_id, pointer_id, node, &mut records),
            InteractionCommand::Focus {
                event_id,
                node,
                origin,
            } => self.focus(scene, event_id, node, origin, &mut records),
            InteractionCommand::Blur { event_id, node } => {
                if self.focus.is_some_and(|focus| focus.node == node) {
                    self.transition_focus(scene, event_id, None, false, &mut records);
                }
            }
            InteractionCommand::Reset { event_id, reason } => {
                let _ = reason;
                self.reset(scene, event_id, &mut records);
            }
        }
        let state_changes = self.apply_state_masks(scene);
        InteractionResult {
            records,
            state_changes,
        }
    }

    pub fn reconcile_scene(&mut self, scene: &mut Scene) -> InteractionResult {
        let mut records = Vec::new();
        let captures = self.captures.clone();
        for (pointer_id, node) in captures {
            if !eligible(scene, node) {
                self.emit_capture_lost(scene, 0, pointer_id, node, &mut records);
                self.captures.remove(&pointer_id);
            }
        }
        for pointer in self.pointers.values_mut() {
            pointer.boundary_path.retain(|node| eligible(scene, *node));
            pointer.active_path.retain(|node| eligible(scene, *node));
        }
        self.pointers.retain(|_, pointer| {
            pointer.last.is_some()
                || !pointer.boundary_path.is_empty()
                || !pointer.active_path.is_empty()
        });
        if let Some(focus) = self.focus
            && !eligible(scene, focus.node)
        {
            self.transition_focus(scene, 0, None, false, &mut records);
        }
        let state_changes = self.apply_state_masks(scene);
        InteractionResult {
            records,
            state_changes,
        }
    }

    fn dispatch(
        &mut self,
        scene: &Scene,
        input: PointerEventInput,
        raw_hit_path: Option<Vec<NodeId>>,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        let capture_path = self
            .captures
            .get(&input.pointer_id)
            .and_then(|node| scene.path_to_root(*node));
        // A canvas-boundary leave is authoritative even while capture is
        // active. It clears transient hover/active state; capture ownership
        // itself remains until release, cancel, reset, or owner invalidation.
        let route = if input.kind == InputEventKind::PointerLeave {
            Vec::new()
        } else {
            capture_path.or(raw_hit_path).unwrap_or_default()
        };
        if is_pointer_input(input.kind) {
            let previous = self
                .pointers
                .get(&input.pointer_id)
                .map(|state| state.boundary_path.clone())
                .unwrap_or_default();
            Self::boundary_events(&input, &previous, &route, records);
            let state = self.pointers.get_or_insert_default(input.pointer_id);
            state.boundary_path.clone_from(&route);
            state.last = Some(input);
            if input.kind == InputEventKind::PointerDown && input.buttons & 1 != 0 {
                state.active_path.clone_from(&route);
            } else if input.kind == InputEventKind::PointerLeave {
                state.active_path.clear();
            }
        }

        if !route.is_empty() && input.kind != InputEventKind::PointerLeave {
            records.push(event_record(input, input.kind, &route, NULL_NODE_ID));
        }

        if input.kind == InputEventKind::PointerDown {
            if let Some(target) = route.last().copied() {
                self.transition_focus(scene, input.event_id, Some(target), false, records);
            } else {
                self.transition_focus(scene, input.event_id, None, false, records);
            }
        }

        if matches!(
            input.kind,
            InputEventKind::PointerUp | InputEventKind::PointerCancel
        ) {
            if let Some(state) = self.pointers.get_mut(&input.pointer_id) {
                state.active_path.clear();
            }
            if let Some(owner) = self.captures.remove(&input.pointer_id) {
                self.emit_capture_lost(scene, input.event_id, input.pointer_id, owner, records);
            }
            if input.pointer_type == InputPointerType::Touch {
                let previous = self
                    .pointers
                    .get(&input.pointer_id)
                    .map(|state| state.boundary_path.clone())
                    .unwrap_or_default();
                Self::boundary_events(&input, &previous, &[], records);
                self.pointers.remove(&input.pointer_id);
            } else if input.kind == InputEventKind::PointerCancel {
                self.pointers.remove(&input.pointer_id);
            }
        }
    }

    /// Routes one key sample to the focused node and nowhere else.
    ///
    /// A key event has no coordinates, so there is nothing to hit test: the
    /// route is the path to whatever currently holds focus. With no focus the
    /// event is dropped rather than delivered to the root — routing it there
    /// would let any component intercept keys it was never given. Key events
    /// never move focus and never touch hover/active state; focus transitions
    /// stay with `FocusNode`/`BlurNode` and pointer presses.
    fn dispatch_key(
        &mut self,
        scene: &Scene,
        input: KeyEventInput,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        let Some(focus) = self.focus else {
            return;
        };
        let Some(path) = scene.path_to_root(focus.node) else {
            return;
        };
        if path.is_empty() {
            return;
        }
        records.push(key_record(input, &path));
    }

    fn boundary_events(
        input: &PointerEventInput,
        previous: &[NodeId],
        next: &[NodeId],
        records: &mut Vec<EventTransactionRecord>,
    ) {
        if previous == next {
            return;
        }
        let common = previous
            .iter()
            .zip(next)
            .take_while(|(left, right)| left == right)
            .count();
        let old_target = previous.last().copied().map_or(NULL_NODE_ID, NodeId::raw);
        let new_target = next.last().copied().map_or(NULL_NODE_ID, NodeId::raw);
        if !previous.is_empty() {
            records.push(event_record(
                *input,
                InputEventKind::PointerOut,
                previous,
                new_target,
            ));
            for end in (common + 1..=previous.len()).rev() {
                records.push(event_record(
                    *input,
                    InputEventKind::PointerLeave,
                    &previous[..end],
                    new_target,
                ));
            }
        }
        if !next.is_empty() {
            records.push(event_record(
                *input,
                InputEventKind::PointerOver,
                next,
                old_target,
            ));
            for end in common + 1..=next.len() {
                records.push(event_record(
                    *input,
                    InputEventKind::PointerEnter,
                    &next[..end],
                    old_target,
                ));
            }
        }
    }

    fn set_capture(
        &mut self,
        scene: &Scene,
        event_id: u32,
        pointer_id: u32,
        node: NodeId,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        if !eligible(scene, node) || !self.pointers.contains_key(&pointer_id) {
            return;
        }
        if let Some(previous) = self.captures.insert(pointer_id, node) {
            if previous == node {
                return;
            }
            self.emit_capture_lost(scene, event_id, pointer_id, previous, records);
        }
        if let (Some(path), Some(input)) = (
            scene.path_to_root(node),
            self.pointers.get(&pointer_id).and_then(|state| state.last),
        ) {
            records.push(event_record_with_id(
                input,
                event_id,
                InputEventKind::GotPointerCapture,
                &path,
                NULL_NODE_ID,
            ));
        }
    }

    fn release_capture(
        &mut self,
        scene: &Scene,
        event_id: u32,
        pointer_id: u32,
        node: NodeId,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        if self.captures.get(&pointer_id) != Some(&node) {
            return;
        }
        self.captures.remove(&pointer_id);
        self.emit_capture_lost(scene, event_id, pointer_id, node, records);
    }

    fn emit_capture_lost(
        &self,
        scene: &Scene,
        event_id: u32,
        pointer_id: u32,
        node: NodeId,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        if let (Some(path), Some(input)) = (
            scene.path_to_root(node),
            self.pointers.get(&pointer_id).and_then(|state| state.last),
        ) {
            records.push(event_record_with_id(
                input,
                event_id,
                InputEventKind::LostPointerCapture,
                &path,
                NULL_NODE_ID,
            ));
        }
    }

    fn focus(
        &mut self,
        scene: &Scene,
        event_id: u32,
        node: NodeId,
        origin: InputFocusOrigin,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        if eligible(scene, node) {
            self.transition_focus(
                scene,
                event_id,
                Some(node),
                matches!(
                    origin,
                    InputFocusOrigin::Keyboard | InputFocusOrigin::Accessibility
                ),
                records,
            );
        }
    }

    fn transition_focus(
        &mut self,
        scene: &Scene,
        event_id: u32,
        next: Option<NodeId>,
        visible: bool,
        records: &mut Vec<EventTransactionRecord>,
    ) {
        if self.focus.map(|focus| focus.node) == next {
            if let Some(focus) = self.focus.as_mut() {
                focus.visible = visible;
            }
            return;
        }
        let previous = self.focus.take();
        let previous_raw = previous.map_or(NULL_NODE_ID, |focus| focus.node.raw());
        let next_raw = next.map_or(NULL_NODE_ID, NodeId::raw);
        if let Some(previous) = previous
            && let Some(path) = scene.path_to_root(previous.node)
        {
            records.push(focus_record(
                event_id,
                InputEventKind::Blur,
                &path,
                next_raw,
            ));
            records.push(focus_record(
                event_id,
                InputEventKind::FocusOut,
                &path,
                next_raw,
            ));
        }
        if let Some(node) = next
            && let Some(path) = scene.path_to_root(node)
        {
            self.focus = Some(FocusState { node, visible });
            records.push(focus_record(
                event_id,
                InputEventKind::Focus,
                &path,
                previous_raw,
            ));
            records.push(focus_record(
                event_id,
                InputEventKind::FocusIn,
                &path,
                previous_raw,
            ));
        }
    }

    fn reset(&mut self, scene: &Scene, event_id: u32, records: &mut Vec<EventTransactionRecord>) {
        let captures = std::mem::take(&mut self.captures);
        for (pointer_id, node) in captures {
            self.emit_capture_lost(scene, event_id, pointer_id, node, records);
        }
        let pointers = std::mem::take(&mut self.pointers);
        for (_, pointer) in pointers {
            if let Some(mut input) = pointer.last {
                input.event_id = event_id;
                if !pointer.active_path.is_empty() {
                    records.push(event_record(
                        input,
                        InputEventKind::PointerCancel,
                        &pointer.active_path,
                        NULL_NODE_ID,
                    ));
                }
                Self::boundary_events(&input, &pointer.boundary_path, &[], records);
            }
        }
        self.transition_focus(scene, event_id, None, false, records);
    }

    fn apply_state_masks(&self, scene: &mut Scene) -> usize {
        let mut masks = OrderedMap::<NodeId, u8>::new();
        for pointer in self.pointers.values() {
            let hover_capable = pointer.last.is_some_and(|event| {
                matches!(
                    event.pointer_type,
                    InputPointerType::Mouse | InputPointerType::Pen
                )
            });
            if hover_capable {
                for node in &pointer.boundary_path {
                    *masks.get_or_insert_default(*node) |= STYLE_INTERACTION_HOVER;
                }
            }
            for node in &pointer.active_path {
                *masks.get_or_insert_default(*node) |= STYLE_INTERACTION_ACTIVE;
            }
        }
        if let Some(focus) = self.focus {
            *masks.get_or_insert_default(focus.node) |= STYLE_INTERACTION_FOCUS;
            if focus.visible {
                *masks.get_or_insert_default(focus.node) |= STYLE_INTERACTION_FOCUS_VISIBLE;
            }
        }
        let existing = scene.interaction_states().collect::<Vec<_>>();
        let mut changes = 0;
        for (node, previous) in existing {
            let next = masks.remove(&node).unwrap_or(0);
            if previous != next && scene.set_interaction_state(node, next) == Some(true) {
                changes += 1;
            }
        }
        for (node, state) in masks {
            if scene.set_interaction_state(node, state) == Some(true) {
                changes += 1;
            }
        }
        changes
    }
}

fn eligible(scene: &Scene, node: NodeId) -> bool {
    scene.resolve(node).is_some()
        && !scene.excluded_by_display(node)
        && scene.visible(node)
        && scene.presented_style_keyword(node, StyleProperty::PointerEvents)
            != Some(StyleKeyword::None)
}

fn is_pointer_input(kind: InputEventKind) -> bool {
    matches!(
        kind,
        InputEventKind::PointerDown
            | InputEventKind::PointerUp
            | InputEventKind::PointerMove
            | InputEventKind::PointerCancel
            | InputEventKind::PointerLeave
    )
}

fn event_record(
    input: PointerEventInput,
    kind: InputEventKind,
    path: &[NodeId],
    related_target: u32,
) -> EventTransactionRecord {
    EventTransactionRecord {
        event_id: input.event_id,
        kind,
        target: path.last().map_or(NULL_NODE_ID, |node| node.raw()),
        position: input.position,
        delta: input.delta,
        buttons: input.buttons,
        modifiers: input.modifiers,
        pointer_id: input.pointer_id,
        elapsed_micros: input.elapsed_micros,
        related_target,
        pointer_type: input.pointer_type,
        is_primary: input.is_primary,
        pressure: input.pressure,
        tilt: input.tilt,
        contact_size: input.contact_size,
        cursor: StyleKeyword::Auto,
        key_code: 0,
        key_name: 0,
        key_text: 0,
        repeat: false,
        path: path.iter().map(|node| node.raw()).collect(),
    }
}

fn event_record_with_id(
    input: PointerEventInput,
    event_id: u32,
    kind: InputEventKind,
    path: &[NodeId],
    related_target: u32,
) -> EventTransactionRecord {
    EventTransactionRecord {
        event_id,
        ..event_record(input, kind, path, related_target)
    }
}

fn key_record(input: KeyEventInput, path: &[NodeId]) -> EventTransactionRecord {
    // A key record is a focus-shaped record: no pointer identity, no geometry.
    EventTransactionRecord {
        modifiers: input.modifiers,
        elapsed_micros: input.elapsed_micros,
        key_code: input.key_code,
        key_name: input.key_name,
        key_text: input.key_text,
        repeat: input.flags & pingo_abi::KEY_FLAG_REPEAT != 0,
        ..focus_record(input.event_id, input.kind, path, NULL_NODE_ID)
    }
}

fn focus_record(
    event_id: u32,
    kind: InputEventKind,
    path: &[NodeId],
    related_target: u32,
) -> EventTransactionRecord {
    EventTransactionRecord {
        event_id,
        kind,
        target: path.last().map_or(NULL_NODE_ID, |node| node.raw()),
        position: [0.0, 0.0],
        delta: [0.0, 0.0],
        buttons: 0,
        modifiers: 0,
        pointer_id: 0,
        elapsed_micros: 1,
        related_target,
        pointer_type: InputPointerType::None,
        is_primary: false,
        pressure: 0.0,
        tilt: [0.0, 0.0],
        contact_size: [0.0, 0.0],
        cursor: StyleKeyword::Auto,
        key_code: 0,
        key_name: 0,
        key_text: 0,
        repeat: false,
        path: path.iter().map(|node| node.raw()).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pingo_abi::{
        InputFocusOrigin, Mutation, MutationBatch, MutationInstruction, NodeKind,
        STYLE_INTERACTION_ACTIVE, STYLE_INTERACTION_FOCUS, STYLE_INTERACTION_FOCUS_VISIBLE,
        STYLE_INTERACTION_HOVER,
    };

    fn id(index: u32) -> NodeId {
        NodeId::new(index, 1).expect("node id")
    }

    fn scene() -> Scene {
        let mut scene = Scene::default();
        scene
            .commit(MutationBatch {
                frame_seq: 1,
                instructions: vec![
                    MutationInstruction {
                        flags: 0,
                        mutation: Mutation::CreateNode {
                            node_id: id(0).raw(),
                            kind: NodeKind::Root,
                            parent: NULL_NODE_ID,
                            before_sibling: NULL_NODE_ID,
                        },
                    },
                    MutationInstruction {
                        flags: 0,
                        mutation: Mutation::CreateNode {
                            node_id: id(1).raw(),
                            kind: NodeKind::Container,
                            parent: id(0).raw(),
                            before_sibling: NULL_NODE_ID,
                        },
                    },
                ],
            })
            .expect("scene commit");
        scene.clear_dirty();
        scene
    }

    fn key(event_id: u32, kind: InputEventKind) -> KeyEventInput {
        KeyEventInput {
            event_id,
            kind,
            flags: 0,
            key_code: 12,
            key_name: 8,
            key_text: 0,
            modifiers: 0,
            elapsed_micros: 16_667,
        }
    }

    #[test]
    fn a_key_event_routes_to_the_focused_node_and_leaves_interaction_state_alone() {
        let mut scene = scene();
        let mut controller = InteractionController::default();
        controller.apply(
            &mut scene,
            InteractionCommand::Focus {
                event_id: 1,
                node: id(1),
                origin: InputFocusOrigin::Keyboard,
            },
            None,
        );
        let masks_before = scene.interaction_state(id(1));

        let result = controller.apply(
            &mut scene,
            InteractionCommand::DispatchKey(key(2, InputEventKind::KeyDown)),
            None,
        );

        assert_eq!(result.records.len(), 1);
        let record = &result.records[0];
        assert_eq!(record.kind, InputEventKind::KeyDown);
        assert_eq!(record.path, vec![id(0).raw(), id(1).raw()]);
        assert_eq!(record.target, id(1).raw());
        assert_eq!(record.key_code, 12);
        assert_eq!(record.key_name, 8);
        assert!(!record.repeat);
        // Keys observe; they never move focus or touch hover/active.
        assert_eq!(result.state_changes, 0);
        assert_eq!(scene.interaction_state(id(1)), masks_before);
    }

    #[test]
    fn a_key_event_with_no_focus_produces_no_record() {
        let mut scene = scene();
        let mut controller = InteractionController::default();

        let result = controller.apply(
            &mut scene,
            InteractionCommand::DispatchKey(key(1, InputEventKind::KeyUp)),
            None,
        );

        assert!(result.records.is_empty());
    }

    #[test]
    fn a_repeat_flag_reaches_the_record() {
        let mut scene = scene();
        let mut controller = InteractionController::default();
        controller.apply(
            &mut scene,
            InteractionCommand::Focus {
                event_id: 1,
                node: id(1),
                origin: InputFocusOrigin::Keyboard,
            },
            None,
        );
        let mut input = key(2, InputEventKind::KeyDown);
        input.flags = pingo_abi::KEY_FLAG_REPEAT;

        let result = controller.apply(&mut scene, InteractionCommand::DispatchKey(input), None);

        assert!(result.records[0].repeat);
    }

    fn pointer(event_id: u32, kind: InputEventKind) -> PointerEventInput {
        PointerEventInput {
            event_id,
            kind,
            flags: 0,
            position: [10.0, 20.0],
            delta: [0.0, 0.0],
            buttons: u32::from(kind == InputEventKind::PointerDown),
            modifiers: 0,
            pointer_id: 7,
            elapsed_micros: 16_667,
            pointer_type: InputPointerType::Mouse,
            is_primary: true,
            pressure: 0.5,
            tilt: [1.0, -2.0],
            contact_size: [3.0, 4.0],
        }
    }

    #[test]
    fn a_context_menu_request_routes_by_hit_test_and_leaves_state_alone() {
        let mut scene = scene();
        let mut interaction = InteractionController::default();
        let path = vec![id(0), id(1)];

        let result = interaction.apply(
            &mut scene,
            InteractionCommand::Dispatch(pointer(1, InputEventKind::ContextMenu)),
            Some(path.clone()),
        );

        // Exactly one record, along the hit path: no synthesized hover or focus
        // companions, because the user is now interacting with the menu this
        // opens rather than with the node beneath it.
        assert_eq!(
            result
                .records
                .iter()
                .map(|record| record.kind)
                .collect::<Vec<_>>(),
            vec![InputEventKind::ContextMenu]
        );
        assert_eq!(
            result.records[0].path,
            path.iter().map(|node| node.raw()).collect::<Vec<_>>()
        );
        assert_eq!(scene.interaction_state(id(0)), 0);
        assert_eq!(scene.interaction_state(id(1)), 0);

        // Nothing hit means nothing dispatched, rather than a record aimed at
        // the root that a background handler would answer.
        let missed = interaction.apply(
            &mut scene,
            InteractionCommand::Dispatch(pointer(2, InputEventKind::ContextMenu)),
            None,
        );
        assert!(missed.records.is_empty());
    }

    fn assert_reset_clears_interaction(reset: &InteractionResult, scene: &Scene) {
        assert_eq!(
            reset
                .records
                .iter()
                .map(|record| record.kind)
                .collect::<Vec<_>>(),
            vec![
                InputEventKind::PointerCancel,
                InputEventKind::PointerOut,
                InputEventKind::PointerLeave,
                InputEventKind::PointerLeave,
                InputEventKind::Blur,
                InputEventKind::FocusOut,
            ]
        );
        assert!(reset.records.iter().all(|record| record.event_id == 6));
        assert_eq!(scene.interaction_state(id(0)), 0);
        assert_eq!(scene.interaction_state(id(1)), 0);
    }

    #[test]
    fn synthesizes_boundaries_capture_focus_and_reset_in_deterministic_order() {
        let mut scene = scene();
        let mut interaction = InteractionController::default();
        let path = vec![id(0), id(1)];

        let down = interaction.apply(
            &mut scene,
            InteractionCommand::Dispatch(pointer(1, InputEventKind::PointerDown)),
            Some(path.clone()),
        );
        assert_eq!(
            down.records
                .iter()
                .map(|record| record.kind)
                .collect::<Vec<_>>(),
            vec![
                InputEventKind::PointerOver,
                InputEventKind::PointerEnter,
                InputEventKind::PointerEnter,
                InputEventKind::PointerDown,
                InputEventKind::Focus,
                InputEventKind::FocusIn,
            ]
        );
        assert_eq!(
            scene.interaction_state(id(0)),
            STYLE_INTERACTION_HOVER | STYLE_INTERACTION_ACTIVE
        );
        assert_eq!(
            scene.interaction_state(id(1)),
            STYLE_INTERACTION_HOVER | STYLE_INTERACTION_ACTIVE | STYLE_INTERACTION_FOCUS
        );

        let visible = interaction.apply(
            &mut scene,
            InteractionCommand::Focus {
                event_id: 2,
                node: id(1),
                origin: InputFocusOrigin::Keyboard,
            },
            None,
        );
        assert!(visible.records.is_empty());
        assert_eq!(
            scene.interaction_state(id(1)),
            STYLE_INTERACTION_HOVER
                | STYLE_INTERACTION_ACTIVE
                | STYLE_INTERACTION_FOCUS
                | STYLE_INTERACTION_FOCUS_VISIBLE
        );

        let captured = interaction.apply(
            &mut scene,
            InteractionCommand::SetPointerCapture {
                event_id: 3,
                pointer_id: 7,
                node: id(1),
            },
            None,
        );
        assert_eq!(captured.records.len(), 1);
        assert_eq!(captured.records[0].kind, InputEventKind::GotPointerCapture);
        assert_eq!(captured.records[0].event_id, 3);

        let routed = interaction.apply(
            &mut scene,
            InteractionCommand::Dispatch(pointer(4, InputEventKind::PointerMove)),
            Some(vec![id(0)]),
        );
        assert_eq!(
            routed
                .records
                .iter()
                .map(|record| (record.kind, record.target))
                .collect::<Vec<_>>(),
            vec![(InputEventKind::PointerMove, id(1).raw())]
        );

        let released = interaction.apply(
            &mut scene,
            InteractionCommand::ReleasePointerCapture {
                event_id: 5,
                pointer_id: 7,
                node: id(1),
            },
            None,
        );
        assert_eq!(released.records[0].kind, InputEventKind::LostPointerCapture);
        assert_eq!(released.records[0].event_id, 5);

        let reset = interaction.apply(
            &mut scene,
            InteractionCommand::Reset {
                event_id: 6,
                reason: InteractionResetReason::WindowBlur,
            },
            None,
        );
        assert_reset_clears_interaction(&reset, &scene);
    }

    #[test]
    fn canvas_leave_clears_hover_and_active_without_stealing_capture() {
        let mut scene = scene();
        let mut interaction = InteractionController::default();
        let path = vec![id(0), id(1)];
        interaction.apply(
            &mut scene,
            InteractionCommand::Dispatch(pointer(1, InputEventKind::PointerDown)),
            Some(path),
        );
        interaction.apply(
            &mut scene,
            InteractionCommand::SetPointerCapture {
                event_id: 2,
                pointer_id: 7,
                node: id(1),
            },
            None,
        );

        let left = interaction.apply(
            &mut scene,
            InteractionCommand::Dispatch(pointer(3, InputEventKind::PointerLeave)),
            Some(vec![id(0), id(1)]),
        );
        assert_eq!(
            left.records
                .iter()
                .map(|record| record.kind)
                .collect::<Vec<_>>(),
            vec![
                InputEventKind::PointerOut,
                InputEventKind::PointerLeave,
                InputEventKind::PointerLeave,
            ]
        );
        assert_eq!(scene.interaction_state(id(0)), 0);
        assert_eq!(scene.interaction_state(id(1)), STYLE_INTERACTION_FOCUS);

        let released = interaction.apply(
            &mut scene,
            InteractionCommand::ReleasePointerCapture {
                event_id: 4,
                pointer_id: 7,
                node: id(1),
            },
            None,
        );
        assert_eq!(released.records[0].kind, InputEventKind::LostPointerCapture);
        assert_eq!(released.records[0].event_id, 4);
    }
}
