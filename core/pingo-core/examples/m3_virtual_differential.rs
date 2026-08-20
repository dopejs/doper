use std::fmt::Write;

use pingo_abi::{
    InputBatch, InputCommand, InputInstruction, Mutation, MutationBatch, MutationInstruction,
    NULL_NODE_ID, NodeKind, Prop,
};
use pingo_core::{CoreEngine, VirtualRefillRequest};
use pingo_scene::NodeId;

fn main() {
    let initial_mutation = mutation_frame(1, initial_mutations());
    let mut core = CoreEngine::new(160.0, 80.0).expect("valid viewport");
    let initial_display = core.commit(&initial_mutation).expect("initial frame");
    let initial_refills = core.take_virtual_refills();
    let materialization_mutation = mutation_frame(2, materialize(&initial_refills));
    let materialized_display = core
        .commit(&materialization_mutation)
        .expect("materialized frame");
    let materialized_refills = core.take_virtual_refills();
    let input = input_frame(
        1,
        vec![InputCommand::ScrollDelta {
            node_id: id(1),
            delta_x: 0.0,
            delta_y: 400.0,
            elapsed_micros: 16_667,
        }],
    );
    let input_display = core
        .input(&input)
        .expect("scroll input")
        .expect("scroll changes pixels");
    let input_refills = core.take_virtual_refills();

    println!(
        "{{\"version\":1,\"initialMutation\":\"{}\",\"initialDisplay\":\"{}\",\"initialRefills\":{},\"materializationMutation\":\"{}\",\"materializedDisplay\":\"{}\",\"materializedRefills\":{},\"input\":\"{}\",\"inputDisplay\":\"{}\",\"inputRefills\":{}}}",
        hex(&initial_mutation),
        hex(&initial_display.display_list),
        refills_json(&initial_refills),
        hex(&materialization_mutation),
        hex(&materialized_display.display_list),
        refills_json(&materialized_refills),
        hex(&input),
        hex(&input_display.display_list),
        refills_json(&input_refills),
    );
}

fn initial_mutations() -> Vec<Mutation> {
    vec![
        Mutation::CreateNode {
            node_id: id(0),
            kind: NodeKind::Root,
            parent: NULL_NODE_ID,
            before_sibling: NULL_NODE_ID,
        },
        Mutation::CreateNode {
            node_id: id(1),
            kind: NodeKind::Scroll,
            parent: id(0),
            before_sibling: NULL_NODE_ID,
        },
        Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Width,
            value: 160.0,
        },
        Mutation::SetF32 {
            node_id: id(1),
            prop: Prop::Height,
            value: 80.0,
        },
        Mutation::ConfigureVirtualList {
            node_id: id(1),
            item_count: 1_000_000,
            estimated_item_height: 20.0,
            base_overscan_viewports: 1.0,
            velocity_horizon_seconds: 0.25,
            maximum_ahead_viewports: 4.0,
        },
    ]
}

fn materialize(refills: &[VirtualRefillRequest]) -> Vec<Mutation> {
    let request = refills.first().expect("initial refill window");
    assert_eq!(request.node_id, id(1));
    let mut mutations = Vec::new();
    for item_index in request.start..request.end {
        let node_id = id(item_index + 2);
        mutations.push(Mutation::CreateNode {
            node_id,
            kind: NodeKind::Container,
            parent: id(1),
            before_sibling: NULL_NODE_ID,
        });
        mutations.push(Mutation::SetF32 {
            node_id,
            prop: Prop::Width,
            value: 160.0,
        });
        mutations.push(Mutation::SetF32 {
            node_id,
            prop: Prop::Height,
            value: if item_index % 2 == 0 { 18.0 } else { 22.0 },
        });
        mutations.push(Mutation::SetVirtualItem {
            node_id,
            item_index,
        });
    }
    mutations
}

fn mutation_frame(frame_seq: u32, mutations: Vec<Mutation>) -> Vec<u8> {
    MutationBatch {
        frame_seq,
        instructions: mutations
            .into_iter()
            .map(|mutation| MutationInstruction { flags: 0, mutation })
            .collect(),
    }
    .encode()
    .expect("valid mutation frame")
}

fn input_frame(frame_seq: u32, commands: Vec<InputCommand>) -> Vec<u8> {
    InputBatch {
        frame_seq,
        instructions: commands
            .into_iter()
            .map(|command| InputInstruction { flags: 0, command })
            .collect(),
    }
    .encode()
    .expect("valid input frame")
}

fn id(index: u32) -> u32 {
    NodeId::new(index, 1).expect("valid fixture id").raw()
}

fn hex(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut result, "{byte:02x}").expect("String writes do not fail");
    }
    result
}

fn refills_json(refills: &[VirtualRefillRequest]) -> String {
    let mut result = String::from("[");
    for (index, refill) in refills.iter().enumerate() {
        if index != 0 {
            result.push(',');
        }
        write!(
            &mut result,
            "[{}, {}, {}]",
            refill.node_id, refill.start, refill.end
        )
        .expect("String writes do not fail");
    }
    result.push(']');
    result
}
