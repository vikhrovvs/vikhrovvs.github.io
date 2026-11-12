import assert from 'node:assert/strict';
import fs from 'node:fs';
import { schematicLayout } from '../site/ladder-graph/layout.js';

const graph = JSON.parse(fs.readFileSync(new URL('../site/ladder-graph/data/graph.json', import.meta.url)));
const before = JSON.stringify(graph);
const layout = schematicLayout(graph);
assert.equal(JSON.stringify(graph), before, 'Layout must not mutate source graph');
assert.deepEqual(schematicLayout(graph).positions, layout.positions, 'Layout must be deterministic');
assert.equal(layout.positions.length, graph.nodes.length);
const largest = [...new Set(graph.nodes.map((n) => n.component))].sort((a, b) => graph.nodes.filter((n) => n.component === b).length - graph.nodes.filter((n) => n.component === a).length)[0];
for (const [i, node] of graph.nodes.entries()) {
  assert.ok(Number.isFinite(layout.positions[i].x) && Number.isFinite(layout.positions[i].y));
  if (node.component === largest) assert.deepEqual(layout.positions[i], { x: node.x, y: node.y }, 'Large component must retain its coordinates');
}
function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
for (const panel of layout.panels) {
  const edges = graph.edges.filter((e) => graph.nodes[e.a].component === panel.id);
  const points = panel.indices.map((i) => layout.positions[i]);
  assert.equal(new Set(points.map((p) => `${p.x}:${p.y}`)).size, panel.indices.length, 'Distinct words must not overlap');
  if (panel.kind === 'цепочка') assert.equal(new Set(points.map((p) => p.y)).size, 1, 'A chain must be straight');
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const a = edges[i], b = edges[j];
    if ([a.a, a.b].some((n) => n === b.a || n === b.b)) continue;
    const [u, v, w, z] = [a.a, a.b, b.a, b.b].map((n) => layout.positions[n]);
    assert.ok(!(cross(u, v, w) * cross(u, v, z) < -1e-5 && cross(w, z, u) * cross(w, z, v) < -1e-5), `Crossing in component ${panel.id}`);
  }
}
console.log(`OK: ${layout.panels.length} small-component schematics are deterministic, preserve all words, and have no edge crossings; large component unchanged`);
