import test from "node:test";
import assert from "node:assert/strict";
import { graphScope } from "../src/graphScope.ts";

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
