import assert from 'node:assert/strict';
import fs from 'node:fs';
import { schematicLayout } from '../site/ladder-graph/layout.js';
import { optimizedLayout } from '../site/ladder-graph/optimized-layout.js';

const graph = JSON.parse(fs.readFileSync(new URL('../site/ladder-graph/data/graph.json', import.meta.url)));
const file = new URL('../site/ladder-graph/optimized-coordinates.json', import.meta.url);
const data = JSON.parse(fs.readFileSync(file));
const before = JSON.stringify(graph), schematic = schematicLayout(graph);
const result = await optimizedLayout(graph, schematic, data);
assert.ok(result, 'Optimized coordinates must match the deployed graph topology; regenerate after updating the archive');
assert.equal(JSON.stringify(graph), before, 'Source graph must remain intact');
assert.equal(result.positions.length, graph.nodes.length);
assert.equal(new Set(data.positions.map(([, x, y]) => `${x}:${y}`)).size, data.wordCount, 'Words must not overlap');
for (const panel of schematic.panels) {
  const first = panel.indices[0];
  for (const i of panel.indices) for (const axis of ['x', 'y']) {
    assert.ok(Math.abs((result.positions[i][axis] - result.positions[first][axis]) - (schematic.positions[i][axis] - schematic.positions[first][axis])) < 1e-8, 'Small-component shapes must be preserved');
  }
}
const modified = { ...graph, edges: graph.edges.slice(0, -1) };
assert.equal(await optimizedLayout(modified, schematic, data), null, 'Stale coordinates must fall back safely');
const invalid = { ...data, positions: [...data.positions.slice(1), data.positions[1]] };
await assert.rejects(optimizedLayout(graph, schematic, invalid), /Invalid/);

function intersections(positions) {
  const edges = graph.edges.filter((e) => graph.nodes[e.a].component === data.component);
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let count = 0;
  for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
    const e = edges[i], f = edges[j];
    if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
    const [a, b, c, d] = [e.a, e.b, f.a, f.b].map((n) => positions[n]);
    if (Math.min(a.x, b.x) > Math.max(c.x, d.x) + 1e-7 || Math.min(c.x, d.x) > Math.max(a.x, b.x) + 1e-7 || Math.min(a.y, b.y) > Math.max(c.y, d.y) + 1e-7 || Math.min(c.y, d.y) > Math.max(a.y, b.y) + 1e-7) continue;
    if (cross(a, b, c) * cross(a, b, d) <= 1e-7 && cross(c, d, a) * cross(c, d, b) <= 1e-7) count++;
  }
  return count;
}
const originalCount = intersections(graph.nodes), optimizedCount = intersections(result.positions);
if (process.argv.includes('--update-counts')) {
  data.originalCrossings = originalCount; data.crossings = optimizedCount;
  fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
} else {
  assert.equal(originalCount, data.originalCrossings);
  assert.equal(optimizedCount, data.crossings);
}
assert.ok(optimizedCount < originalCount, 'Optimization must reduce intersecting pairs, including touches and overlaps');
console.log(`OK: optimized layout preserves every word and small-component shape; ${originalCount} → ${optimizedCount} intersecting pairs; stale-data fallback verified`);
