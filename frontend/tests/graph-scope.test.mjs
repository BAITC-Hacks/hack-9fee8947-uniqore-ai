import test from "node:test";
import assert from "node:assert/strict";
import cytoscape from "cytoscape";
import { applyFilterHighlight, graphScope } from "../src/graphScope.ts";

const edge = (src, dst) => ({ id: `${src}:${dst}`, src, dst });
const edges = [
  edge("a", "b"),
  edge("b", "a"),
  edge("c", "a"),
  edge("c", "b"),
  edge("b", "d"),
];
const allowed = new Set(["a", "b", "c", "d", "isolated"]);
const ids = (view) => view.edges.map((edge) => edge.id).sort();

test("outgoing one-hop view omits reciprocal and neighboring incoming edges", () => {
  const view = graphScope(edges, allowed, "a", "ego", 1, "out");
  assert.deepEqual([...view.nodes].sort(), ["a", "b"]);
  assert.deepEqual(ids(view), ["a:b"]);
});
test("incoming view shows only edges that lead into the selected client", () => {
  const view = graphScope(edges, allowed, "a", "ego", 1, "in");
  assert.deepEqual([...view.nodes].sort(), ["a", "b", "c"]);
  assert.deepEqual(ids(view), ["b:a", "c:a"]);
});
test("two-hop traversal follows direction and preserves real cycles", () => {
  const view = graphScope(edges, allowed, "a", "ego", 2, "out");
  assert.deepEqual([...view.nodes].sort(), ["a", "b", "d"]);
  assert.deepEqual(ids(view), ["a:b", "b:a", "b:d"]);
});
test("filtered-out intermediates cannot connect otherwise disconnected clients", () => {
  const view = graphScope(edges, new Set(["a", "d"]), "a", "ego", 2, "out");
  assert.deepEqual([...view.nodes], ["a"]);
  assert.equal(view.edges.length, 0);
});
test("all directions retains contextual edges within the neighborhood", () => {
  assert.deepEqual(ids(graphScope(edges, allowed, "a", "ego", 1, "both")), [
    "a:b",
    "b:a",
    "c:a",
    "c:b",
  ]);
});
test("isolated, hidden selection and whole-network views have explicit coverage", () => {
  assert.deepEqual(
    [...graphScope(edges, allowed, "isolated", "ego", 2, "both").nodes],
    ["isolated"],
  );
  assert.equal(
    graphScope(edges, allowed, "missing", "ego", 2, "both").nodes.size,
    0,
  );
  assert.deepEqual(
    ids(graphScope(edges, allowed, "a", "all", 1, "in")),
    edges.map((e) => e.id).sort(),
  );
});

test("highlight mode keeps all nodes, isolates and edges regardless of filters or traversal", () => {
  for (const matches of [new Set(), new Set(["a"]), allowed]) {
    const view = graphScope(edges, matches, "a", "ego", 1, "in", allowed);
    assert.deepEqual([...view.nodes].sort(), [...allowed].sort());
    assert.deepEqual(ids(view), edges.map((item) => item.id).sort());
  }
});

test("changing highlighted matches preserves positions, topology, pan, zoom and investigation classes", () => {
  const cy = cytoscape({
    headless: true,
    elements: [
      ...[...allowed].map((id, index) => ({
        data: {
          id,
          size: 18,
          color: "#3876DB",
          shape: id === "a" ? "diamond" : "ellipse",
        },
        position: { x: index * 80, y: index % 2 ? 70 : 0 },
        classes: id === "a" ? "chosen boundary" : "",
      })),
      ...edges.map((item) => ({
        data: { id: item.id, source: item.src, target: item.dst },
        classes: item.id === "a:b" ? "inspected-edge inactive" : "",
      })),
    ],
    layout: { name: "preset" },
  });
  try {
    cy.pan({ x: 18, y: -25 });
    cy.zoom(0.25);
    const positions = cy
      .nodes()
      .map((node) => ({ id: node.id(), ...node.position() }));
    const viewport = { pan: { ...cy.pan() }, zoom: cy.zoom() };
    const assertPreserved = () => {
      assert.equal(cy.nodes().length, allowed.size);
      assert.equal(cy.edges().length, edges.length);
      assert.deepEqual(
        cy.nodes().map((node) => ({ id: node.id(), ...node.position() })),
        positions,
      );
      assert.deepEqual({ pan: cy.pan(), zoom: cy.zoom() }, viewport);
      assert.equal(cy.getElementById("a").hasClass("chosen"), true);
      assert.equal(cy.getElementById("a").hasClass("boundary"), true);
      assert.equal(cy.getElementById("a").data("shape"), "diamond");
      assert.equal(cy.getElementById("a").data("color"), "#3876DB");
      assert.equal(cy.getElementById("a:b").hasClass("inspected-edge"), true);
      assert.equal(cy.getElementById("a:b").hasClass("inactive"), true);
    };
    applyFilterHighlight(cy, new Set(["b", "d"]), true);
    assert.deepEqual(
      cy
        .nodes(".filter-match")
        .map((node) => node.id())
        .sort(),
      ["b", "d"],
    );
    assert.deepEqual(
      cy.edges(".filter-match-edge").map((edge) => edge.id()),
      ["b:d"],
    );
    assert.equal(cy.nodes(".filter-muted").length, 3);
    assert.equal(cy.getElementById("a").hasClass("filter-selected"), true);
    assert.ok(cy.getElementById("b").data("highlightSize") * cy.zoom() >= 7);
    assertPreserved();

    applyFilterHighlight(cy, new Set(), true);
    assert.equal(cy.nodes(".filter-match").length, 0);
    assert.equal(cy.nodes(".filter-muted").length, allowed.size);
    assert.equal(cy.edges(".filter-muted").length, edges.length);
    assertPreserved();

    applyFilterHighlight(cy, allowed, true);
    assert.equal(cy.nodes(".filter-match").length, allowed.size);
    assert.equal(cy.elements(".filter-muted").length, 0);
    assert.equal(cy.nodes(".filter-emphasis").length, 0);
    assertPreserved();

    applyFilterHighlight(cy, new Set(["isolated"]), false);
    assert.equal(
      cy.elements(
        ".filter-match, .filter-match-edge, .filter-muted, .filter-emphasis, .filter-selected",
      ).length,
      0,
    );
    assertPreserved();
  } finally {
    cy.destroy();
  }
});
