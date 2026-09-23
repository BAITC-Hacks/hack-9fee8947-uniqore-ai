import type { Core } from "cytoscape";
import type { GraphEdge } from "./types";

/** Apply the visible selection before walking, so a path cannot cross a hidden node. */
export function graphScope(
  edges: GraphEdge[],
  allowed: Set<string>,
  selected: string,
  scope: "ego" | "all",
  hops: number,
  direction: "both" | "in" | "out",
  fullNetwork?: ReadonlySet<string>,
) {
  // Highlighting is a presentation of the complete network, never a traversal filter.
  const included = fullNetwork ?? allowed;
  const candidates = edges.filter(
    (edge) => included.has(edge.src) && included.has(edge.dst),
  );
  if (fullNetwork || scope === "all")
    return { nodes: new Set(included), edges: candidates };
  const nodes = new Set<string>(allowed.has(selected) ? [selected] : []);
  let frontier = new Set(nodes);
  const walked = new Set<string>();
  for (let hop = 0; hop < hops && frontier.size; hop++) {
    const next = new Set<string>();
    for (const edge of candidates) {
      if (direction !== "in" && frontier.has(edge.src)) {
        walked.add(edge.id);
        if (!nodes.has(edge.dst)) next.add(edge.dst);
      }
      if (direction !== "out" && frontier.has(edge.dst)) {
        walked.add(edge.id);
        if (!nodes.has(edge.src)) next.add(edge.src);
      }
    }
    next.forEach((gid) => nodes.add(gid));
    frontier = next;
  }
  return {
    nodes,
    edges: candidates.filter(
      (edge) =>
        nodes.has(edge.src) &&
        nodes.has(edge.dst) &&
        (direction === "both" || walked.has(edge.id)),
    ),
  };
}

/** Change emphasis in place: preserve topology, manual positions and the viewport. */
export function applyFilterHighlight(
  cy: Core,
  allowed: ReadonlySet<string>,
  enabled: boolean,
) {
  const zoom = Math.max(cy.zoom(), 0.01);
  const allMatch = cy
    .nodes()
    .toArray()
    .every((node) => allowed.has(node.id()));
  cy.batch(() => {
    cy.nodes().forEach((node) => {
      const matched = allowed.has(node.id());
      node.data(
        "highlightSize",
        Math.max(Number(node.data("size")) || 17, 7 / zoom),
      );
      node.data(
        "selectedSize",
        Math.max(Number(node.data("size")) || 17, 12 / zoom),
      );
      node.data("highlightPadding", 2 / zoom);
      node.data("highlightBorderWidth", 1 / zoom);
      node.data("selectedBorderWidth", 2 / zoom);
      node.data("selectedFontSize", Math.max(12, 10 / zoom));
      node.toggleClass("filter-match", enabled && matched);
      node.toggleClass("filter-emphasis", enabled && matched && !allMatch);
      node.toggleClass("filter-muted", enabled && !matched);
      node.toggleClass("filter-selected", enabled && node.hasClass("chosen"));
    });
    cy.edges().forEach((edge) => {
      const matched =
        allowed.has(edge.source().id()) && allowed.has(edge.target().id());
      edge.toggleClass("filter-match-edge", enabled && matched);
      edge.toggleClass("filter-muted", enabled && !matched);
    });
  });
}
