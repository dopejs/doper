// Representative migrated page: renders through the compat boundary with a
// page-granular legacy fallback. This fixture is the input for the automated
// migration scanner and the shadow/rollback drills.
import { createElement, TextField, type DoperNode } from "@dopejs/pingo";
import { mountCompatPage, type LegacyRenderer } from "@dopejs/pingo-compat";

export function renderOrdersPage(): DoperNode {
  return createElement("container", {
    width: 640,
    children: [
      createElement("text", { value: "Orders", fontSize: 20, semanticRole: "heading" }),
      TextField({ semanticLabel: "Search orders", value: "", inputMode: "search" }),
      createElement("virtualList", {
        itemCount: 10_000,
        estimatedItemHeight: 32,
        height: 480,
        renderItem: (index: number) => createElement("text", { value: `Order #${String(index)}` }),
      }),
    ],
  });
}

export function mountOrdersPage(
  container: HTMLElement,
  legacy: LegacyRenderer,
  enabled: boolean,
): ReturnType<typeof mountCompatPage> {
  return mountCompatPage({
    pageId: "orders",
    container,
    render: renderOrdersPage,
    legacy,
    enabled,
    onFallback: (reason) => {
      // Rollout observability hook; business code reports, never rethrows.
      console.warn("doper fallback", reason);
    },
  });
}
