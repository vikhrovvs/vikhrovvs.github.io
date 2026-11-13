import assert from 'node:assert/strict';
import fs from 'node:fs';
import { schematicLayout } from '../site/ladder-graph/layout.js';
import { gentleLayout } from '../site/ladder-graph/gentle-layout.js';

const graph = JSON.parse(fs.readFileSync(new URL('../site/ladder-graph/data/graph.json', import.meta.url)));
const file = new URL('../site/ladder-graph/gentle-coordinates.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file));
const before = JSON.stringify(graph), schematic = schematicLayout(graph);
const positions = await gentleLayout(graph, schematic, data);
assert.ok(positions, 'Coordinates must match the deployed graph; regenerate after updating its topology');
assert.equal(JSON.stringify(graph), before, 'Source graph must stay unchanged');
assert.equal(positions.length, graph.nodes.length);
const ids = graph.nodes.flatMap((node, i) => node.component === data.component ? [i] : []);
assert.equal(new Set(ids.map((i) => `${positions[i].x}:${positions[i].y}`)).size, ids.length);
for (const [i, node] of graph.nodes.entries()) {
  if (node.component !== data.component) assert.deepEqual(positions[i], schematic.positions[i], 'Small schematics must retain their exact coordinates');
  else assert.ok(Math.hypot(positions[i].x-node.x, positions[i].y-node.y) <= 240.0001);
}
for (const axis of ['x', 'y']) for (const op of [Math.min, Math.max]) assert.equal(op(...ids.map((i) => positions[i][axis])), op(...ids.map((i) => graph.nodes[i][axis])), 'Overview bounds must stay unchanged');
assert.equal(await gentleLayout({ ...graph, edges: graph.edges.slice(0, -1) }, schematic, data), null);
await assert.rejects(gentleLayout(graph, schematic, { ...data, positions: data.positions.slice(1) }), /Incomplete/);

function count(points) {
  const edges = graph.edges.filter((edge) => graph.nodes[edge.a].component === data.component);
  const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  let result = 0;
  for (let i=0; i<edges.length; i++) for (let j=i+1; j<edges.length; j++) {
    const e=edges[i], f=edges[j];
    if (e.a===f.a || e.a===f.b || e.b===f.a || e.b===f.b) continue;
    const [a,b,c,d]=[e.a,e.b,f.a,f.b].map((id)=>points[id]);
    if (Math.min(a.x,b.x)>Math.max(c.x,d.x)+1e-7 || Math.min(c.x,d.x)>Math.max(a.x,b.x)+1e-7 || Math.min(a.y,b.y)>Math.max(c.y,d.y)+1e-7 || Math.min(c.y,d.y)>Math.max(a.y,b.y)+1e-7) continue;
    if (cross(a,b,c)*cross(a,b,d)<=1e-7 && cross(c,d,a)*cross(c,d,b)<=1e-7) result++;
  }
  return result;
}
const original = count(graph.nodes), gentle = count(positions);
assert.ok(gentle < original);
if (process.argv.includes('--update-counts')) {
  data.originalCrossings=original; data.crossings=gentle; fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
} else { assert.equal(original,data.originalCrossings); assert.equal(gentle,data.crossings); }
console.log(`OK: ${original} → ${gentle} intersecting pairs; all words, small schematics and overview bounds preserved; stale-data fallback verified`);
