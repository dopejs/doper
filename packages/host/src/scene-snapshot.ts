import {
  NULL_NODE_ID,
  decodeMutationBatch,
  encodeMutationBatch,
  type Mutation,
  type NodeKind,
  type Prop,
  type ResourceKind,
} from "@dopejs/doper-reconciler";

interface SnapshotResource {
  readonly bytes: Uint8Array;
  readonly kind: ResourceKind;
  readonly order: number;
}

interface SnapshotNode {
  readonly children: number[];
  readonly f32: Map<Prop, number>;
  flags: number;
  readonly kind: NodeKind;
  parent: number;
  readonly refs: Map<Prop, number>;
  scroll: { behavior: number; x: number; y: number } | undefined;
  textRun: { stringId: number; styleId: number } | undefined;
  readonly vec4: Map<Prop, readonly [number, number, number, number]>;
  virtualItemIndex: number | undefined;
  virtualList:
    | {
        itemCount: number;
        estimatedItemHeight: number;
        baseOverscanViewports: number;
        velocityHorizonSeconds: number;
        maximumAheadViewports: number;
      }
    | undefined;
}

/** Compact current-state oracle used to reconstruct a fresh Core after Worker loss. */
export class MutationSceneSnapshot {
  readonly #nodes = new Map<number, SnapshotNode>();
  readonly #resources = new Map<number, SnapshotResource>();
  #frameSeq: number | undefined;
  #nextResourceOrder = 1;
  #rootId: number | undefined;

  public get frameSeq(): number | undefined {
    return this.#frameSeq;
  }

  public get nodeCount(): number {
    return this.#nodes.size;
  }

  public get resourceCount(): number {
    return this.#resources.size;
  }

  /** Applies one validated transaction with an undo log so failures leave no partial snapshot. */
  public apply(bytes: Uint8Array): void {
    this.applyAfterAccepted(bytes, () => undefined);
  }

  /** Rolls back validated state too when the external sink rejects the same transaction. */
  public applyAfterAccepted(bytes: Uint8Array, accept: () => void): void {
    const batch = decodeMutationBatch(bytes);
    if (this.#frameSeq !== undefined && !isNewerSequence(batch.frameSeq, this.#frameSeq)) {
      throw new Error("snapshot frame sequence is not newer");
    }
    const previousFrameSeq = this.#frameSeq;
    const previousRootId = this.#rootId;
    const previousResourceOrder = this.#nextResourceOrder;
    const nodeUndo = new Map<number, SnapshotNode | undefined>();
    const resourceUndo = new Map<number, SnapshotResource | undefined>();
    const touchNode = (nodeId: number): SnapshotNode => {
      const current = this.#nodes.get(nodeId);
      if (current === undefined) throw new Error(`snapshot node ${String(nodeId)} does not exist`);
      if (!nodeUndo.has(nodeId)) {
        nodeUndo.set(nodeId, current);
        const copy = cloneNode(current);
        this.#nodes.set(nodeId, copy);
        return copy;
      }
      return current;
    };
    const rememberNode = (nodeId: number): void => {
      if (!nodeUndo.has(nodeId)) nodeUndo.set(nodeId, this.#nodes.get(nodeId));
    };
    const rememberResource = (resourceId: number): void => {
      if (!resourceUndo.has(resourceId)) {
        resourceUndo.set(resourceId, this.#resources.get(resourceId));
      }
    };

    try {
      for (const mutation of batch.mutations) {
        this.applyMutation(mutation, touchNode, rememberNode, rememberResource);
      }
      this.#frameSeq = batch.frameSeq;
      this.assertTopology();
      accept();
    } catch (cause) {
      for (const [nodeId, previous] of nodeUndo) {
        if (previous === undefined) this.#nodes.delete(nodeId);
        else this.#nodes.set(nodeId, previous);
      }
      for (const [resourceId, previous] of resourceUndo) {
        if (previous === undefined) this.#resources.delete(resourceId);
        else this.#resources.set(resourceId, previous);
      }
      this.#frameSeq = previousFrameSeq;
      this.#rootId = previousRootId;
      this.#nextResourceOrder = previousResourceOrder;
      throw cause;
    }
  }

  /** Emits one canonical full-state transaction accepted by an empty replacement Core. */
  public encode(): Uint8Array {
    const frameSeq = this.#frameSeq;
    if (frameSeq === undefined) throw new Error("cannot encode an empty uninitialized snapshot");
    this.assertTopology();
    const mutations: Mutation[] = [];
    const resources = [...this.#resources.entries()].sort(
      ([firstId, first], [secondId, second]) => first.order - second.order || firstId - secondId,
    );
    for (const [resourceId, resource] of resources) {
      mutations.push({
        bytes: resource.bytes,
        kind: resource.kind,
        resourceId,
        type: "defineResource",
      });
    }
    for (const nodeId of this.topology()) {
      const node = required(this.#nodes.get(nodeId), "snapshot topology node");
      mutations.push({
        beforeSibling: NULL_NODE_ID,
        kind: node.kind,
        nodeId,
        parent: node.parent,
        type: "createNode",
      });
      for (const [prop, value] of sortedEntries(node.f32)) {
        mutations.push({ nodeId, prop, type: "setF32", value });
      }
      for (const [prop, value] of sortedEntries(node.vec4)) {
        mutations.push({ nodeId, prop, type: "setVec4", value });
      }
      for (const [prop, resourceId] of sortedEntries(node.refs)) {
        mutations.push({ nodeId, prop, resourceId, type: "setRef" });
      }
      if (node.flags !== 0) {
        mutations.push({ clear: 0, nodeId, set: node.flags, type: "setFlags" });
      }
      if (node.textRun !== undefined) {
        mutations.push({ nodeId, type: "setTextRun", ...node.textRun });
      }
      if (node.scroll !== undefined) {
        mutations.push({ nodeId, type: "scrollTo", ...node.scroll });
      }
      if (node.virtualList !== undefined) {
        mutations.push({ nodeId, type: "configureVirtualList", ...node.virtualList });
      }
      if (node.virtualItemIndex !== undefined) {
        mutations.push({ nodeId, itemIndex: node.virtualItemIndex, type: "setVirtualItem" });
      }
    }
    return encodeMutationBatch({ frameSeq, mutations });
  }

  private applyMutation(
    mutation: Mutation,
    touchNode: (nodeId: number) => SnapshotNode,
    rememberNode: (nodeId: number) => void,
    rememberResource: (resourceId: number) => void,
  ): void {
    switch (mutation.type) {
      case "defineResource":
        if (this.#resources.has(mutation.resourceId)) {
          throw new Error(`snapshot resource ${String(mutation.resourceId)} already exists`);
        }
        rememberResource(mutation.resourceId);
        this.#resources.set(mutation.resourceId, {
          bytes: mutation.bytes.slice(),
          kind: mutation.kind,
          order: this.#nextResourceOrder++,
        });
        return;
      case "releaseResource":
        if (!this.#resources.has(mutation.resourceId)) {
          throw new Error(`snapshot resource ${String(mutation.resourceId)} does not exist`);
        }
        rememberResource(mutation.resourceId);
        this.#resources.delete(mutation.resourceId);
        return;
      case "createNode": {
        if (this.#nodes.has(mutation.nodeId)) {
          throw new Error(`snapshot node ${String(mutation.nodeId)} already exists`);
        }
        if (mutation.parent === NULL_NODE_ID) {
          if (this.#rootId !== undefined) throw new Error("snapshot cannot contain multiple roots");
          if (mutation.beforeSibling !== NULL_NODE_ID) {
            throw new Error("snapshot root cannot have a sibling");
          }
          this.#rootId = mutation.nodeId;
        } else {
          const parent = touchNode(mutation.parent);
          insertChild(parent.children, mutation.nodeId, mutation.beforeSibling);
        }
        rememberNode(mutation.nodeId);
        this.#nodes.set(mutation.nodeId, emptyNode(mutation.kind, mutation.parent));
        return;
      }
      case "removeNode": {
        const node = touchNode(mutation.nodeId);
        if (node.parent === NULL_NODE_ID) this.#rootId = undefined;
        else removeChild(touchNode(node.parent).children, mutation.nodeId);
        const stack = [mutation.nodeId];
        while (stack.length > 0) {
          const nodeId = stack.pop();
          if (nodeId === undefined) continue;
          const removed = required(this.#nodes.get(nodeId), "snapshot removed node");
          stack.push(...removed.children);
          rememberNode(nodeId);
          this.#nodes.delete(nodeId);
        }
        return;
      }
      case "reparent": {
        const node = touchNode(mutation.nodeId);
        if (node.parent === NULL_NODE_ID) throw new Error("snapshot root cannot be reparented");
        const oldParent = touchNode(node.parent);
        const newParent = touchNode(mutation.newParent);
        removeChild(oldParent.children, mutation.nodeId);
        insertChild(newParent.children, mutation.nodeId, mutation.beforeSibling);
        node.parent = mutation.newParent;
        return;
      }
      case "setF32":
        touchNode(mutation.nodeId).f32.set(mutation.prop, mutation.value);
        return;
      case "setVec4":
        touchNode(mutation.nodeId).vec4.set(mutation.prop, [...mutation.value]);
        return;
      case "setRef":
        touchNode(mutation.nodeId).refs.set(mutation.prop, mutation.resourceId);
        return;
      case "setFlags": {
        const node = touchNode(mutation.nodeId);
        node.flags = ((node.flags | mutation.set) & ~mutation.clear) >>> 0;
        return;
      }
      case "clearProp": {
        const node = touchNode(mutation.nodeId);
        node.f32.delete(mutation.prop);
        node.vec4.delete(mutation.prop);
        node.refs.delete(mutation.prop);
        return;
      }
      case "setTextRun":
        touchNode(mutation.nodeId).textRun = {
          stringId: mutation.stringId,
          styleId: mutation.styleId,
        };
        return;
      case "scrollTo":
        touchNode(mutation.nodeId).scroll = {
          behavior: mutation.behavior,
          x: mutation.x,
          y: mutation.y,
        };
        return;
      case "configureVirtualList":
        touchNode(mutation.nodeId).virtualList = {
          itemCount: mutation.itemCount,
          estimatedItemHeight: mutation.estimatedItemHeight,
          baseOverscanViewports: mutation.baseOverscanViewports,
          velocityHorizonSeconds: mutation.velocityHorizonSeconds,
          maximumAheadViewports: mutation.maximumAheadViewports,
        };
        return;
      case "setVirtualItem":
        touchNode(mutation.nodeId).virtualItemIndex = mutation.itemIndex;
    }
  }

  private topology(): number[] {
    if (this.#rootId === undefined) return [];
    const result: number[] = [];
    const stack = [this.#rootId];
    while (stack.length > 0) {
      const nodeId = stack.pop();
      if (nodeId === undefined) continue;
      result.push(nodeId);
      const node = required(this.#nodes.get(nodeId), "snapshot node");
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child !== undefined) stack.push(child);
      }
    }
    return result;
  }

  private assertTopology(): void {
    if (this.#nodes.size === 0) {
      if (this.#rootId !== undefined) throw new Error("empty snapshot retains a root");
      return;
    }
    if (this.#rootId === undefined) throw new Error("non-empty snapshot has no root");
    const topology = this.topology();
    if (topology.length !== this.#nodes.size || new Set(topology).size !== topology.length) {
      throw new Error("snapshot topology is disconnected or cyclic");
    }
    for (const nodeId of topology) {
      const node = required(this.#nodes.get(nodeId), "snapshot node");
      for (const childId of node.children) {
        const child = required(this.#nodes.get(childId), "snapshot child");
        if (child.parent !== nodeId) throw new Error("snapshot parent/child links disagree");
      }
    }
  }
}

function emptyNode(kind: NodeKind, parent: number): SnapshotNode {
  return {
    children: [],
    f32: new Map(),
    flags: 0,
    kind,
    parent,
    refs: new Map(),
    scroll: undefined,
    textRun: undefined,
    vec4: new Map(),
    virtualItemIndex: undefined,
    virtualList: undefined,
  };
}

function cloneNode(node: SnapshotNode): SnapshotNode {
  return {
    children: [...node.children],
    f32: new Map(node.f32),
    flags: node.flags,
    kind: node.kind,
    parent: node.parent,
    refs: new Map(node.refs),
    scroll: node.scroll === undefined ? undefined : { ...node.scroll },
    textRun: node.textRun === undefined ? undefined : { ...node.textRun },
    vec4: new Map(node.vec4),
    virtualItemIndex: node.virtualItemIndex,
    virtualList: node.virtualList === undefined ? undefined : { ...node.virtualList },
  };
}

function insertChild(children: number[], nodeId: number, beforeSibling: number): void {
  if (children.includes(nodeId)) throw new Error("snapshot child is already attached");
  if (beforeSibling === NULL_NODE_ID) {
    children.push(nodeId);
    return;
  }
  const index = children.indexOf(beforeSibling);
  if (index < 0) throw new Error("snapshot beforeSibling does not belong to the parent");
  children.splice(index, 0, nodeId);
}

function removeChild(children: number[], nodeId: number): void {
  const index = children.indexOf(nodeId);
  if (index < 0) throw new Error("snapshot parent does not contain child");
  children.splice(index, 1);
}

function sortedEntries<T>(map: Map<Prop, T>): Array<[Prop, T]> {
  return [...map.entries()].sort(([first], [second]) => Number(first) - Number(second));
}

function isNewerSequence(candidate: number, previous: number): boolean {
  const distance = (candidate - previous) >>> 0;
  return distance !== 0 && distance < 0x8000_0000;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is missing`);
  return value;
}
