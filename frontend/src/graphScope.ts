import type { GraphEdge } from "./types";

/** Apply the visible selection before walking, so a path cannot cross a hidden node. */
export function graphScope(
  edges: GraphEdge[],
  allowed: Set<string>,
  selected: string,
  scope: "ego" | "all",
  hops: number,
  direction: "both" | "in" | "out",
) {
  const candidates = edges.filter(
    (edge) => allowed.has(edge.src) && allowed.has(edge.dst),
  );
  if (scope === "all") return { nodes: new Set(allowed), edges: candidates };
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
