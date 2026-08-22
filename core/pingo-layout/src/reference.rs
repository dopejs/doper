//! Naive recursive reference layout kept as a differential oracle.
//!
//! This module deliberately re-derives the layout algorithm: it recurses
//! instead of driving an explicit stack, keeps per-node results in a map
//! instead of topology-aligned SoA buffers, has no incremental path, no
//! relayout boundaries and no double buffering, and never skips work. The
//! production engine is compared against it by property tests, so it must not
//! be "fixed" by copying the engine — a disagreement is a bug report, and which
//! side is wrong has to be decided from the specification in
//! `docs/e5-flex-grow-design.md`.
//!
//! What it does share with the engine are the leaf-level style readers
//! (`style_padding`, `outer_dimension`, and friends). Those are direct property
//! lookups with no algorithmic content; duplicating them would only add a second
//! place for the same typo. The oracle's value is in the traversal, sizing and
//! flex resolution, all of which are written here from scratch.
//!
//! Virtual lists are out of scope: their geometry comes from a Core-owned
//! external index rather than from layout, so an oracle cannot reproduce them.

use std::collections::HashMap;

use pingo_abi::{NodeKind, Prop, StyleKeyword, StyleProperty};
use pingo_scene::{NodeId, Scene};

use crate::engine::{
    DIRECTION_ROW, EdgeInsets, PercentBasis, flex_basis_main, has_requested_dimension,
    intersect_constraints, justify_spacing, outer_dimension, percentage_basis,
    resolve_style_length, style_border, style_margin, style_padding, subtract_insets,
};
use crate::{BoxConstraints, IntrinsicMeasurer, LayoutError, Point, Size};

/// Per-node geometry produced by the reference implementation.
///
/// Offsets are relative to the parent's border box, matching
/// [`crate::LayoutSnapshot`].
#[derive(Clone, Debug, Default)]
pub struct ReferenceLayout {
    geometry: HashMap<NodeId, (Point, Size)>,
}

impl ReferenceLayout {
    /// Returns the offset and size computed for one node.
    #[must_use]
    pub fn geometry(&self, node: NodeId) -> Option<(Point, Size)> {
        self.geometry.get(&node).copied()
    }
}

/// Lays out a whole Scene from scratch with no incremental machinery.
///
/// # Errors
///
/// Returns the same validation failures as [`crate::LayoutEngine`], plus
/// [`LayoutError::SceneInvariant`] when the Scene contains a virtual list.
pub fn reference_layout(
    scene: &Scene,
    constraints: BoxConstraints,
    measurer: &mut impl IntrinsicMeasurer,
) -> Result<ReferenceLayout, LayoutError> {
    let mut out = ReferenceLayout::default();
    let Some(root) = scene.ids().first().copied() else {
        return Ok(out);
    };
    if scene.parent(root).is_none() && scene.kind(root) != Some(NodeKind::Root) {
        return Err(LayoutError::SceneInvariant("first node is not the root"));
    }
    if scene.display_none(root) {
        zero(scene, root, &mut out);
        return Ok(out);
    }
    let size = layout_node(
        scene,
        root,
        constraints,
        PercentBasis {
            width: constraints.max_width,
            height: constraints.max_height,
        },
        None,
        measurer,
        &mut out,
    )?;
    out.geometry.insert(root, (Point::ZERO, size));
    Ok(out)
}

/// Everything a container needs to know about one in-flow child.
struct Item {
    node: NodeId,
    constraints: BoxConstraints,
    basis: PercentBasis,
    margin: EdgeInsets,
    min_main: f32,
    max_main: f32,
    grow: f32,
    shrink: f32,
    auto_main_start: bool,
    auto_main_end: bool,
    auto_cross_start: bool,
    auto_cross_end: bool,
    size: Size,
}

/// The container properties the sizing and arrangement steps both read.
struct Box2 {
    node: NodeId,
    insets: EdgeInsets,
    own: BoxConstraints,
    child_constraints: BoxConstraints,
    percent: PercentBasis,
    fixed_width: Option<f32>,
    fixed_height: Option<f32>,
    row: bool,
    reverse: bool,
    justify: StyleKeyword,
    align: StyleKeyword,
    gap: f32,
}

fn layout_node(
    scene: &Scene,
    node: NodeId,
    constraints: BoxConstraints,
    basis: PercentBasis,
    flex_axis_row: Option<bool>,
    measurer: &mut impl IntrinsicMeasurer,
    out: &mut ReferenceLayout,
) -> Result<Size, LayoutError> {
    if scene.virtual_list(node).is_some() {
        return Err(LayoutError::SceneInvariant(
            "reference layout does not model virtual lists",
        ));
    }
    let container = describe(scene, node, constraints, basis, flex_axis_row)?;

    let mut items = Vec::new();
    let mut out_of_flow = Vec::new();
    let mut child = scene.first_child(node);
    let has_children = child.is_some();
    while let Some(current) = child {
        child = scene.next_sibling(current);
        if scene.display_none(current) {
            zero(scene, current, out);
            continue;
        }
        if scene.out_of_flow(current) {
            out_of_flow.push(child_item(scene, &container, current)?);
            continue;
        }
        items.push(child_item(scene, &container, current)?);
    }

    for item in &mut items {
        item.size = layout_node(
            scene,
            item.node,
            item.constraints,
            item.basis,
            Some(container.row),
            measurer,
            out,
        )?;
    }

    let intrinsic = if has_children {
        Size::ZERO
    } else {
        let measured = measurer.measure(scene, node, container.child_constraints);
        if !measured.is_valid() {
            return Err(LayoutError::InvalidIntrinsicSize {
                node,
                size: measured,
            });
        }
        container.child_constraints.constrain(measured)
    };

    let mut size = container_size(&container, &items, intrinsic);
    // Naive second pass: whenever any main extent changes, every child is laid
    // out again. The production engine only revisits the children that changed,
    // which is exactly the optimisation this oracle exists to check.
    if resolve_flex(scene, &container, &mut items, size)? {
        for item in &mut items {
            item.size = layout_node(
                scene,
                item.node,
                item.constraints,
                item.basis,
                Some(container.row),
                measurer,
                out,
            )?;
        }
        size = container_size(&container, &items, intrinsic);
    }
    arrange(&container, &items, size, out);
    // Out of flow: laid out against the container's padding box and placed
    // there, never touching the flow totals.
    for item in &mut out_of_flow {
        item.size = layout_node(
            scene,
            item.node,
            item.constraints,
            item.basis,
            Some(container.row),
            measurer,
            out,
        )?;
        let offset = out_of_flow_offset(scene, &container, item);
        out.geometry.insert(item.node, (offset, item.size));
    }
    Ok(size)
}

/// Where an out-of-flow child sits inside its container's padding box.
fn out_of_flow_offset(scene: &Scene, container: &Box2, item: &Item) -> Point {
    let x = axis_offset(
        scene,
        item.node,
        container.percent.width,
        item.size.width + item.margin.horizontal(),
        StyleProperty::Left,
        StyleProperty::Right,
    ) + item.margin.left;
    let y = axis_offset(
        scene,
        item.node,
        container.percent.height,
        item.size.height + item.margin.vertical(),
        StyleProperty::Top,
        StyleProperty::Bottom,
    ) + item.margin.top;
    Point::new(container.insets.left + x, container.insets.top + y)
}

fn axis_offset(
    scene: &Scene,
    node: NodeId,
    available: f32,
    outer: f32,
    start: StyleProperty,
    end: StyleProperty,
) -> f32 {
    if let Some(value) = resolve_style_length(scene.style_length(node, start, 0), available)
        && value.is_finite()
    {
        return value;
    }
    if available.is_finite()
        && let Some(value) = resolve_style_length(scene.style_length(node, end, 0), available)
        && value.is_finite()
    {
        return available - value - outer;
    }
    0.0
}

/// Distributes main-axis free space and tightens the affected constraints.
///
/// Returns whether any child's main extent changed.
fn resolve_flex(
    scene: &Scene,
    container: &Box2,
    items: &mut [Item],
    size: Size,
) -> Result<bool, LayoutError> {
    if items.is_empty() {
        return Ok(false);
    }
    let content_main = if container.row {
        size.width - container.insets.horizontal()
    } else {
        size.height - container.insets.vertical()
    }
    .max(0.0);
    let gaps = container.gap * (items.len() - 1) as f32;
    let margins = items
        .iter()
        .map(|item| {
            if container.row {
                item.margin.horizontal()
            } else {
                item.margin.vertical()
            }
        })
        .sum::<f32>();
    let available = content_main - gaps - margins;
    let base = items
        .iter()
        .map(|item| main_of(container, item.size))
        .collect::<Vec<_>>();
    let free = available - base.iter().sum::<f32>();
    if !free.is_finite() || free.abs() <= 1.0 / 1024.0 {
        return Ok(false);
    }
    let growing = free > 0.0;
    if !growing && scene.scrollable_axis(container.node, container.row) {
        return Ok(false);
    }
    let factor = |item: &Item| if growing { item.grow } else { item.shrink };
    if items.iter().all(|item| factor(item) <= 0.0) {
        return Ok(false);
    }

    let mut target = base.clone();
    let mut frozen = vec![false; items.len()];
    for (index, item) in items.iter().enumerate() {
        let factor = if growing { item.grow } else { item.shrink };
        // No factor in this direction means the item keeps the size its own
        // layout produced; the flex step never resizes an inflexible item.
        if factor <= 0.0 {
            frozen[index] = true;
        } else if growing && base[index] >= item.max_main {
            target[index] = item.max_main;
            frozen[index] = true;
        } else if !growing && base[index] <= item.min_main {
            target[index] = item.min_main;
            frozen[index] = true;
        }
    }

    let mut rounds = 0;
    while frozen.iter().any(|value| !value) {
        rounds += 1;
        if rounds > items.len() + 1 {
            return Err(LayoutError::SceneInvariant(
                "flex main-axis distribution did not converge",
            ));
        }
        let mut factor_sum = 0.0_f32;
        let mut scaled_sum = 0.0_f32;
        let mut fixed = 0.0_f32;
        for (index, item) in items.iter().enumerate() {
            if frozen[index] {
                fixed += target[index];
            } else {
                fixed += base[index];
                factor_sum += factor(item);
                scaled_sum += item.shrink * base[index];
            }
        }
        if factor_sum <= 0.0 {
            for (index, value) in frozen.iter_mut().enumerate() {
                if !*value {
                    target[index] = base[index];
                    *value = true;
                }
            }
            break;
        }
        let mut remaining = available - fixed;
        if growing && factor_sum < 1.0 {
            let magnitude = free * factor_sum;
            if magnitude.abs() < remaining.abs() {
                remaining = magnitude;
            }
        }
        for (index, item) in items.iter().enumerate() {
            if frozen[index] {
                continue;
            }
            target[index] = if growing {
                base[index] + remaining * (item.grow / factor_sum)
            } else if scaled_sum > 0.0 {
                base[index] - remaining.abs() * ((item.shrink * base[index]) / scaled_sum)
            } else {
                base[index]
            };
        }
        let mut violations = vec![0.0_f32; items.len()];
        let mut total = 0.0_f32;
        for (index, item) in items.iter().enumerate() {
            if frozen[index] {
                continue;
            }
            let clamped = target[index].clamp(item.min_main, item.max_main).max(0.0);
            violations[index] = clamped - target[index];
            target[index] = clamped;
            total += violations[index];
        }
        let settled = total.abs() <= 1.0 / 1024.0;
        for index in 0..items.len() {
            if frozen[index] {
                continue;
            }
            if settled
                || (total > 0.0 && violations[index] > 0.0)
                || (total < 0.0 && violations[index] < 0.0)
            {
                frozen[index] = true;
            }
        }
    }

    let mut changed = false;
    for (index, item) in items.iter_mut().enumerate() {
        if (target[index] - base[index]).abs() <= 1.0 / 1024.0 {
            continue;
        }
        changed = true;
        if container.row {
            item.constraints.min_width = target[index];
            item.constraints.max_width = target[index];
        } else {
            item.constraints.min_height = target[index];
            item.constraints.max_height = target[index];
        }
    }
    Ok(changed)
}

fn main_of(container: &Box2, size: Size) -> f32 {
    if container.row {
        size.width
    } else {
        size.height
    }
}

/// Sums outer main extents and gaps, and takes the widest outer cross extent.
fn content_totals(container: &Box2, items: &[Item]) -> (f32, f32) {
    let mut main = 0.0_f32;
    let mut cross = 0.0_f32;
    for (ordinal, item) in items.iter().enumerate() {
        if ordinal > 0 {
            main += container.gap;
        }
        let (outer_main, outer_cross) = if container.row {
            (
                item.margin.horizontal() + item.size.width,
                item.margin.vertical() + item.size.height,
            )
        } else {
            (
                item.margin.vertical() + item.size.height,
                item.margin.horizontal() + item.size.width,
            )
        };
        main += outer_main;
        cross = cross.max(outer_cross);
    }
    (main, cross)
}

fn container_size(container: &Box2, items: &[Item], intrinsic: Size) -> Size {
    let (main, cross) = content_totals(container, items);
    let natural = if container.row {
        Size::new(
            main + intrinsic.width + container.insets.horizontal(),
            cross.max(intrinsic.height) + container.insets.vertical(),
        )
    } else {
        Size::new(
            cross.max(intrinsic.width) + container.insets.horizontal(),
            main + intrinsic.height + container.insets.vertical(),
        )
    };
    let requested = Size::new(
        container.fixed_width.unwrap_or(natural.width),
        container.fixed_height.unwrap_or(natural.height),
    );
    container.own.constrain(requested)
}

fn describe(
    scene: &Scene,
    node: NodeId,
    constraints: BoxConstraints,
    basis: PercentBasis,
    flex_axis_row: Option<bool>,
) -> Result<Box2, LayoutError> {
    let width_basis = percentage_basis(basis.width, constraints.min_width);
    let height_basis = percentage_basis(basis.height, constraints.min_height);
    let padding = style_padding(scene, node, width_basis)?;
    let border = style_border(scene, node, width_basis)?;
    let insets = padding.add(border);
    let border_box =
        scene.style_keyword(node, StyleProperty::BoxSizing, 0) == Some(StyleKeyword::BorderBox);
    let bound = |property, prop, vertical: bool, fallback: f32| -> Result<f32, LayoutError> {
        Ok(outer_dimension(
            scene,
            node,
            prop,
            property,
            if vertical { height_basis } else { width_basis },
            if vertical {
                insets.vertical()
            } else {
                insets.horizontal()
            },
            border_box,
        )?
        .unwrap_or(fallback))
    };
    let min_width = bound(StyleProperty::MinWidth, Prop::MinWidth, false, 0.0)?;
    let min_height = bound(StyleProperty::MinHeight, Prop::MinHeight, true, 0.0)?;
    let max_width = bound(
        StyleProperty::MaxWidth,
        Prop::MaxWidth,
        false,
        f32::INFINITY,
    )?;
    let max_height = bound(
        StyleProperty::MaxHeight,
        Prop::MaxHeight,
        true,
        f32::INFINITY,
    )?;
    if min_width > max_width {
        return Err(LayoutError::ContradictoryStyle {
            node,
            min_prop: Prop::MinWidth,
            min: min_width,
            max_prop: Prop::MaxWidth,
            max: max_width,
        });
    }
    if min_height > max_height {
        return Err(LayoutError::ContradictoryStyle {
            node,
            min_prop: Prop::MinHeight,
            min: min_height,
            max_prop: Prop::MaxHeight,
            max: max_height,
        });
    }
    let own = intersect_constraints(constraints, min_width, max_width, min_height, max_height);
    let flex_basis = flex_axis_row.and_then(|row| {
        flex_basis_main(
            scene,
            node,
            if row { width_basis } else { height_basis },
            if row {
                insets.horizontal()
            } else {
                insets.vertical()
            },
            border_box,
        )
        .map(|value| (row, value))
    });
    let mut fixed_width = outer_dimension(
        scene,
        node,
        Prop::Width,
        StyleProperty::Width,
        width_basis,
        insets.horizontal(),
        border_box,
    )?;
    let mut fixed_height = outer_dimension(
        scene,
        node,
        Prop::Height,
        StyleProperty::Height,
        height_basis,
        insets.vertical(),
        border_box,
    )?;
    if let Some((row, value)) = flex_basis {
        if row {
            fixed_width = Some(value);
        } else {
            fixed_height = Some(value);
        }
    }
    let direction = scene
        .style_keyword(node, StyleProperty::FlexDirection, 0)
        .unwrap_or(StyleKeyword::Column);
    let direction_prop = scene.f32_prop(node, Prop::Direction);
    let row = direction_prop.is_some_and(|value| value == DIRECTION_ROW)
        || (direction_prop.is_none()
            && matches!(direction, StyleKeyword::Row | StyleKeyword::RowReverse));
    let reverse = direction_prop.is_none()
        && matches!(
            direction,
            StyleKeyword::RowReverse | StyleKeyword::ColumnReverse
        );
    let outer_width = fixed_width.map_or(own.max_width, |width| {
        own.constrain(Size::new(width, own.min_height)).width
    });
    let outer_height = fixed_height.map_or(own.max_height, |height| {
        own.constrain(Size::new(own.min_width, height)).height
    });
    let content_width = subtract_insets(outer_width, insets.horizontal());
    let content_height = subtract_insets(outer_height, insets.vertical());
    let percent = PercentBasis {
        width: content_width,
        height: content_height,
    };
    let child_constraints = BoxConstraints {
        min_width: 0.0,
        max_width: if scene.scrollable_axis(node, true) {
            f32::INFINITY
        } else {
            content_width
        },
        min_height: 0.0,
        max_height: if scene.scrollable_axis(node, false) || !row {
            f32::INFINITY
        } else {
            content_height
        },
    };
    let gap_property = if row {
        StyleProperty::ColumnGap
    } else {
        StyleProperty::RowGap
    };
    let gap_basis = if row {
        fixed_width.unwrap_or(width_basis)
    } else {
        fixed_height.unwrap_or(height_basis)
    };
    let gap = match scene
        .f32_prop(node, Prop::Gap)
        .or_else(|| resolve_style_length(scene.style_length(node, gap_property, 0), gap_basis))
    {
        Some(value) if value.is_finite() && value >= 0.0 => value,
        Some(value) => {
            return Err(LayoutError::InvalidStyle {
                node,
                prop: Prop::Gap,
                value,
            });
        }
        None => 0.0,
    };
    Ok(Box2 {
        node,
        insets,
        own,
        child_constraints,
        percent,
        fixed_width,
        fixed_height,
        row,
        reverse,
        justify: scene
            .style_keyword(node, StyleProperty::JustifyContent, 0)
            .unwrap_or(StyleKeyword::FlexStart),
        align: scene
            .style_keyword(node, StyleProperty::AlignItems, 0)
            .unwrap_or(StyleKeyword::FlexStart),
        gap,
    })
}

fn child_item(scene: &Scene, container: &Box2, node: NodeId) -> Result<Item, LayoutError> {
    let margin_basis = container_margin_basis(container);
    let margins = style_margin(scene, node, margin_basis)?;
    let out_of_flow = scene.out_of_flow(node);
    let mut constraints = if out_of_flow {
        BoxConstraints {
            min_width: 0.0,
            max_width: subtract_insets(container.percent.width, margins.values.horizontal()),
            min_height: 0.0,
            max_height: subtract_insets(container.percent.height, margins.values.vertical()),
        }
    } else {
        container.child_constraints
    };
    if !out_of_flow {
        constraints.max_width = subtract_insets(constraints.max_width, margins.values.horizontal());
        constraints.max_height = subtract_insets(constraints.max_height, margins.values.vertical());
    }
    let basis = if out_of_flow {
        container.percent
    } else {
        PercentBasis {
            width: subtract_insets(container.percent.width, margins.values.horizontal()),
            height: subtract_insets(container.percent.height, margins.values.vertical()),
        }
    };
    if out_of_flow {
        if has_requested_dimension(scene, node, Prop::Width, StyleProperty::Width) {
            constraints.max_width = f32::INFINITY;
        } else if let Some(span) = inset_span(scene, node, basis.width, true) {
            constraints.min_width = span;
            constraints.max_width = span;
        }
        if has_requested_dimension(scene, node, Prop::Height, StyleProperty::Height) {
            constraints.max_height = f32::INFINITY;
        } else if let Some(span) = inset_span(scene, node, basis.height, false) {
            constraints.min_height = span;
            constraints.max_height = span;
        }
    }
    let child_width_basis = percentage_basis(basis.width, constraints.min_width);
    let child_height_basis = percentage_basis(basis.height, constraints.min_height);
    // align-items does not reach an out-of-flow child; its cross size comes
    // from its own box and its insets.
    if !out_of_flow && container.align == StyleKeyword::Stretch {
        if container.row {
            if !has_requested_dimension(scene, node, Prop::Height, StyleProperty::Height)
                && constraints.max_height.is_finite()
            {
                constraints.min_height = constraints.max_height;
            }
        } else if !has_requested_dimension(scene, node, Prop::Width, StyleProperty::Width)
            && constraints.max_width.is_finite()
        {
            constraints.min_width = constraints.max_width;
        }
    }
    let (auto_main_start, auto_main_end, auto_cross_start, auto_cross_end) = if container.row {
        (
            margins.auto.left,
            margins.auto.right,
            margins.auto.top,
            margins.auto.bottom,
        )
    } else {
        (
            margins.auto.top,
            margins.auto.bottom,
            margins.auto.left,
            margins.auto.right,
        )
    };
    let axis_insets = style_padding(scene, node, child_width_basis)?.add(style_border(
        scene,
        node,
        child_width_basis,
    )?);
    let border_box =
        scene.style_keyword(node, StyleProperty::BoxSizing, 0) == Some(StyleKeyword::BorderBox);
    let (min_property, max_property, min_prop, max_prop, bound_basis, bound_insets) =
        if container.row {
            (
                StyleProperty::MinWidth,
                StyleProperty::MaxWidth,
                Prop::MinWidth,
                Prop::MaxWidth,
                child_width_basis,
                axis_insets.horizontal(),
            )
        } else {
            (
                StyleProperty::MinHeight,
                StyleProperty::MaxHeight,
                Prop::MinHeight,
                Prop::MaxHeight,
                child_height_basis,
                axis_insets.vertical(),
            )
        };
    let min_main = outer_dimension(
        scene,
        node,
        min_prop,
        min_property,
        bound_basis,
        bound_insets,
        border_box,
    )?
    .unwrap_or(0.0);
    let max_main = outer_dimension(
        scene,
        node,
        max_prop,
        max_property,
        bound_basis,
        bound_insets,
        border_box,
    )?
    .unwrap_or(f32::INFINITY);
    Ok(Item {
        node,
        constraints,
        basis,
        margin: margins.values,
        min_main,
        max_main: max_main.max(min_main),
        grow: scene
            .style_f32(node, StyleProperty::FlexGrow, 0)
            .unwrap_or(0.0)
            .max(0.0),
        shrink: scene
            .style_f32(node, StyleProperty::FlexShrink, 0)
            .unwrap_or(0.0)
            .max(0.0),
        auto_main_start,
        auto_main_end,
        auto_cross_start,
        auto_cross_end,
        size: Size::ZERO,
    })
}

/// The extent both insets pin down, when neither is `auto`.
fn inset_span(scene: &Scene, node: NodeId, available: f32, horizontal: bool) -> Option<f32> {
    if !available.is_finite() {
        return None;
    }
    let (start, end) = if horizontal {
        (StyleProperty::Left, StyleProperty::Right)
    } else {
        (StyleProperty::Top, StyleProperty::Bottom)
    };
    let start = resolve_style_length(scene.style_length(node, start, 0), available)?;
    let end = resolve_style_length(scene.style_length(node, end, 0), available)?;
    if !start.is_finite() || !end.is_finite() {
        return None;
    }
    Some((available - start - end).max(0.0))
}

/// Inline basis every direct child resolves percentage margins against.
fn container_margin_basis(container: &Box2) -> f32 {
    percentage_basis(
        container.percent.width,
        container.child_constraints.min_width,
    )
}

fn arrange(container: &Box2, items: &[Item], size: Size, out: &mut ReferenceLayout) {
    if items.is_empty() {
        return;
    }
    let insets = container.insets;
    let (content_main, content_cross) = if container.row {
        (
            (size.width - insets.horizontal()).max(0.0),
            (size.height - insets.vertical()).max(0.0),
        )
    } else {
        (
            (size.height - insets.vertical()).max(0.0),
            (size.width - insets.horizontal()).max(0.0),
        )
    };
    let (used_main, _) = content_totals(container, items);
    let auto_edges = items
        .iter()
        .map(|item| usize::from(item.auto_main_start) + usize::from(item.auto_main_end))
        .sum::<usize>();
    let free = (content_main - used_main).max(0.0);
    let auto_share = if auto_edges == 0 {
        0.0
    } else {
        free / auto_edges as f32
    };
    let distributable = if auto_edges == 0 { free } else { 0.0 };
    let (leading, distributed_gap) = justify_spacing(container.justify, distributable, items.len());

    let mut cursor = leading;
    for (ordinal, item) in items.iter().enumerate() {
        if ordinal > 0 {
            cursor += container.gap + distributed_gap;
        }
        let (raw_leading, raw_trailing, cross_start, cross_end) = if container.row {
            (
                item.margin.left,
                item.margin.right,
                item.margin.top,
                item.margin.bottom,
            )
        } else {
            (
                item.margin.top,
                item.margin.bottom,
                item.margin.left,
                item.margin.right,
            )
        };
        let leading_margin = if item.auto_main_start {
            auto_share
        } else {
            raw_leading
        };
        let trailing_margin = if item.auto_main_end {
            auto_share
        } else {
            raw_trailing
        };
        let (child_main, child_cross) = if container.row {
            (item.size.width, item.size.height)
        } else {
            (item.size.height, item.size.width)
        };
        let outer_main = leading_margin + child_main + trailing_margin;
        let main = if container.reverse {
            content_main - cursor - outer_main + leading_margin
        } else {
            cursor + leading_margin
        };
        let cross_free = (content_cross - child_cross - cross_start - cross_end).max(0.0);
        let cross = cross_start
            + if item.auto_cross_start || item.auto_cross_end {
                match (item.auto_cross_start, item.auto_cross_end) {
                    (true, true) => cross_free * 0.5,
                    (true, false) => cross_free,
                    (false, true) | (false, false) => 0.0,
                }
            } else {
                match container.align {
                    StyleKeyword::Center => cross_free * 0.5,
                    StyleKeyword::End | StyleKeyword::FlexEnd => cross_free,
                    _ => 0.0,
                }
            };
        let offset = if container.row {
            Point::new(insets.left + main, insets.top + cross)
        } else {
            Point::new(insets.left + cross, insets.top + main)
        };
        out.geometry.insert(item.node, (offset, item.size));
        cursor += outer_main;
    }
}

fn zero(scene: &Scene, root: NodeId, out: &mut ReferenceLayout) {
    out.geometry.insert(root, (Point::ZERO, Size::ZERO));
    let mut child = scene.first_child(root);
    while let Some(node) = child {
        zero(scene, node, out);
        child = scene.next_sibling(node);
    }
}

#[cfg(test)]
mod tests {
    use pingo_abi::{
        Mutation, MutationBatch, MutationInstruction, NULL_NODE_ID, ResourceKind,
        STYLE_ALL_FEATURE_BITS, STYLE_COMPUTED_ENCODING_VARIANT, STYLE_COMPUTED_ENCODING_VERSION,
        STYLE_LENGTH_AUTO, STYLE_LENGTH_PERCENT, STYLE_LENGTH_PX, STYLE_VALUE_F32,
        STYLE_VALUE_KEYWORD, STYLE_VALUE_LENGTH,
    };
    use proptest::prelude::*;

    use super::*;
    use crate::{LayoutEngine, ZeroIntrinsicMeasurer};

    /// One node's style knobs, derived deterministically from generated bytes.
    type Spec = [u8; 16];

    fn id(index: u32) -> NodeId {
        NodeId::new(index, 1).expect("id")
    }

    fn px(value: f32) -> Vec<u8> {
        let mut bytes = vec![STYLE_LENGTH_PX, 0, 0, 0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    fn percent(value: f32) -> Vec<u8> {
        let mut bytes = vec![STYLE_LENGTH_PERCENT, 0, 0, 0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    fn number(value: f32) -> Vec<u8> {
        value.to_le_bytes().to_vec()
    }

    fn auto() -> Vec<u8> {
        let mut bytes = vec![STYLE_LENGTH_AUTO, 0, 0, 0];
        bytes.extend_from_slice(&0.0_f32.to_le_bytes());
        bytes
    }

    fn keyword(value: StyleKeyword) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4);
        bytes.extend_from_slice(&(value as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u16.to_le_bytes());
        bytes
    }

    fn computed_style(entries: &mut [(StyleProperty, u8, Vec<u8>)]) -> Vec<u8> {
        entries.sort_by_key(|(property, _, _)| *property as u16);
        let payload_bytes = entries
            .iter()
            .map(|(_, _, payload)| 8 + payload.len().next_multiple_of(4))
            .sum::<usize>();
        let mut bytes = vec![0; 16];
        bytes[0] = STYLE_COMPUTED_ENCODING_VERSION;
        bytes[1] = STYLE_COMPUTED_ENCODING_VARIANT;
        bytes[4..8].copy_from_slice(&STYLE_ALL_FEATURE_BITS.to_le_bytes());
        bytes[8..12].copy_from_slice(&(entries.len() as u32).to_le_bytes());
        bytes[12..16].copy_from_slice(&(payload_bytes as u32).to_le_bytes());
        for (property, tag, payload) in entries.iter() {
            bytes.extend_from_slice(&(*property as u16).to_le_bytes());
            bytes.push(0);
            bytes.push(*tag);
            bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
            bytes.extend_from_slice(&0_u16.to_le_bytes());
            bytes.extend_from_slice(payload);
            bytes.resize(bytes.len().next_multiple_of(4), 0);
        }
        bytes
    }

    fn length(selector: u8, magnitude: u8) -> Option<(u8, Vec<u8>)> {
        match selector % 4 {
            0 => Some((STYLE_VALUE_LENGTH, px(f32::from(magnitude % 200)))),
            1 => Some((STYLE_VALUE_LENGTH, percent(f32::from(magnitude % 101)))),
            _ => None,
        }
    }

    fn declarations(spec: Spec) -> Vec<(StyleProperty, u8, Vec<u8>)> {
        let mut entries = Vec::new();
        if spec[0].is_multiple_of(19) {
            entries.push((
                StyleProperty::Display,
                STYLE_VALUE_KEYWORD,
                keyword(StyleKeyword::None),
            ));
        }
        if let Some((tag, payload)) = length(spec[1], spec[2]) {
            entries.push((StyleProperty::Width, tag, payload));
        }
        if let Some((tag, payload)) = length(spec[3], spec[4]) {
            entries.push((StyleProperty::Height, tag, payload));
        }
        if !spec[5].is_multiple_of(3) {
            let padding = px(f32::from(spec[5] % 21));
            for property in [
                StyleProperty::PaddingTop,
                StyleProperty::PaddingRight,
                StyleProperty::PaddingBottom,
                StyleProperty::PaddingLeft,
            ] {
                entries.push((property, STYLE_VALUE_LENGTH, padding.clone()));
            }
        }
        match spec[6] % 5 {
            0 => {
                let margin = px(f32::from(spec[6] % 19));
                for property in [StyleProperty::MarginTop, StyleProperty::MarginLeft] {
                    entries.push((property, STYLE_VALUE_LENGTH, margin.clone()));
                }
            }
            1 => {
                let margin = percent(f32::from(spec[6] % 17));
                for property in [StyleProperty::MarginRight, StyleProperty::MarginBottom] {
                    entries.push((property, STYLE_VALUE_LENGTH, margin.clone()));
                }
            }
            _ => {}
        }
        let direction = match spec[7] % 4 {
            0 => StyleKeyword::Row,
            1 => StyleKeyword::Column,
            2 => StyleKeyword::RowReverse,
            _ => StyleKeyword::ColumnReverse,
        };
        entries.push((
            StyleProperty::FlexDirection,
            STYLE_VALUE_KEYWORD,
            keyword(direction),
        ));
        let justify = match spec[8] % 6 {
            0 => StyleKeyword::FlexStart,
            1 => StyleKeyword::Center,
            2 => StyleKeyword::FlexEnd,
            3 => StyleKeyword::SpaceBetween,
            4 => StyleKeyword::SpaceAround,
            _ => StyleKeyword::SpaceEvenly,
        };
        entries.push((
            StyleProperty::JustifyContent,
            STYLE_VALUE_KEYWORD,
            keyword(justify),
        ));
        let align = match spec[9] % 4 {
            0 => StyleKeyword::FlexStart,
            1 => StyleKeyword::Center,
            2 => StyleKeyword::FlexEnd,
            _ => StyleKeyword::Stretch,
        };
        entries.push((
            StyleProperty::AlignItems,
            STYLE_VALUE_KEYWORD,
            keyword(align),
        ));
        let gap = px(f32::from(spec[10] % 17));
        entries.push((StyleProperty::RowGap, STYLE_VALUE_LENGTH, gap.clone()));
        entries.push((StyleProperty::ColumnGap, STYLE_VALUE_LENGTH, gap));
        if !spec[11].is_multiple_of(4) {
            let (property, value) = match spec[11] % 4 {
                1 => (StyleProperty::OverflowX, StyleKeyword::Hidden),
                2 => (StyleProperty::OverflowY, StyleKeyword::Scroll),
                _ => (StyleProperty::OverflowY, StyleKeyword::Auto),
            };
            entries.push((property, STYLE_VALUE_KEYWORD, keyword(value)));
        }
        if spec[2].is_multiple_of(7) {
            entries.push((
                StyleProperty::MaxWidth,
                STYLE_VALUE_LENGTH,
                px(f32::from(spec[4] % 250) + 1.0),
            ));
        }
        if spec[4].is_multiple_of(11) {
            entries.push((
                StyleProperty::MinHeight,
                STYLE_VALUE_LENGTH,
                px(f32::from(spec[2] % 60)),
            ));
        }
        if !spec[12].is_multiple_of(3) {
            entries.push((
                StyleProperty::FlexGrow,
                STYLE_VALUE_F32,
                number(f32::from(spec[12] % 5) / 2.0),
            ));
        }
        if !spec[13].is_multiple_of(4) {
            entries.push((
                StyleProperty::FlexShrink,
                STYLE_VALUE_F32,
                number(f32::from(spec[13] % 4)),
            ));
        }
        match spec[14] % 5 {
            0 => entries.push((
                StyleProperty::FlexBasis,
                STYLE_VALUE_LENGTH,
                px(f32::from(spec[15] % 180)),
            )),
            1 => entries.push((
                StyleProperty::FlexBasis,
                STYLE_VALUE_LENGTH,
                percent(f32::from(spec[15] % 101)),
            )),
            2 => entries.push((StyleProperty::FlexBasis, STYLE_VALUE_LENGTH, auto())),
            _ => {}
        }
        if spec[15].is_multiple_of(13) {
            entries.push((
                StyleProperty::MaxHeight,
                STYLE_VALUE_LENGTH,
                px(f32::from(spec[13] % 200) + 1.0),
            ));
        }
        if spec[13].is_multiple_of(17) {
            entries.push((
                StyleProperty::MinWidth,
                STYLE_VALUE_LENGTH,
                px(f32::from(spec[15] % 70)),
            ));
        }
        if spec[11].is_multiple_of(7) {
            entries.push((
                StyleProperty::Position,
                STYLE_VALUE_KEYWORD,
                keyword(StyleKeyword::Absolute),
            ));
            for (index, property) in [
                StyleProperty::Top,
                StyleProperty::Right,
                StyleProperty::Bottom,
                StyleProperty::Left,
            ]
            .into_iter()
            .enumerate()
            {
                let knob = spec[(12 + index) % 16];
                match knob % 4 {
                    0 => entries.push((property, STYLE_VALUE_LENGTH, px(f32::from(knob % 60)))),
                    1 => {
                        entries.push((property, STYLE_VALUE_LENGTH, percent(f32::from(knob % 61))))
                    }
                    _ => {}
                }
            }
        }
        entries
    }

    fn build_scene(specs: &[Spec]) -> (Scene, Vec<NodeId>) {
        let mut scene = Scene::new();
        let mut nodes = Vec::with_capacity(specs.len());
        let mut mutations = Vec::new();
        for (index, spec) in specs.iter().copied().enumerate() {
            let node = id(index as u32);
            nodes.push(node);
            let parent = (index > 0).then(|| nodes[usize::from(spec[0]) % index]);
            mutations.push(Mutation::CreateNode {
                node_id: node.raw(),
                kind: if index == 0 {
                    NodeKind::Root
                } else {
                    NodeKind::Container
                },
                parent: parent.map_or(NULL_NODE_ID, NodeId::raw),
                before_sibling: NULL_NODE_ID,
            });
            let mut entries = declarations(spec);
            if entries.is_empty() {
                continue;
            }
            let resource_id = index as u32 + 1;
            mutations.push(Mutation::DefineResource {
                resource_id,
                kind: ResourceKind::ComputedStyle,
                bytes: computed_style(&mut entries),
            });
            mutations.push(Mutation::SetRef {
                node_id: node.raw(),
                prop: Prop::ComputedStyle,
                resource_id,
            });
        }
        scene
            .commit(MutationBatch {
                frame_seq: 1,
                instructions: mutations
                    .into_iter()
                    .map(|mutation| MutationInstruction { flags: 0, mutation })
                    .collect(),
            })
            .expect("valid scene mutation");
        (scene, nodes)
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(192))]

        #[test]
        fn the_engine_agrees_with_the_reference_layout(
            specs in prop::collection::vec(prop::array::uniform16(any::<u8>()), 1..24),
            viewport_width in 1.0_f32..1_200.0,
            viewport_height in 1.0_f32..1_200.0,
        ) {
            let (scene, nodes) = build_scene(&specs);
            let constraints =
                BoxConstraints::tight(Size::new(viewport_width, viewport_height)).expect("viewport");
            let mut engine = LayoutEngine::new();
            let engine_result = engine.layout(&scene, constraints, &mut ZeroIntrinsicMeasurer);
            let reference = reference_layout(&scene, constraints, &mut ZeroIntrinsicMeasurer);
            match (engine_result, reference) {
                (Ok(_), Ok(reference)) => {
                    for node in nodes {
                        let actual = engine.snapshot().geometry(node).expect("engine geometry");
                        let expected = reference.geometry(node).expect("reference geometry");
                        prop_assert!(
                            close(actual.0.x, expected.0.x)
                                && close(actual.0.y, expected.0.y)
                                && close(actual.1.width, expected.1.width)
                                && close(actual.1.height, expected.1.height),
                            "node {node:?}: engine {actual:?} reference {expected:?}"
                        );
                    }
                }
                (Err(engine_error), Err(reference_error)) => {
                    prop_assert_eq!(engine_error, reference_error);
                }
                (engine_result, reference) => {
                    prop_assert!(false, "disagreement: {engine_result:?} vs {reference:?}");
                }
            }
        }
    }

    fn close(left: f32, right: f32) -> bool {
        (left - right).abs() <= 1e-3 * left.abs().max(right.abs()).max(1.0)
    }
}
