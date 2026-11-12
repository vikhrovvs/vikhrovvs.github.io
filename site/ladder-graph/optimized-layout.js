// Precomputed coordinates only; the source graph and its topology remain intact.
export async function topologyHash(graph) {
  const topology = JSON.stringify([graph.nodes.map((n) => n.id), graph.edges.map((e) => [e.a, e.b])]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(topology));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function optimizedLayout(graph, schematic, data) {
  if (data.schemaVersion !== 1 || data.topologySha256 !== await topologyHash(graph)) return null;
  const included = graph.nodes.map((n, i) => n.component === data.component ? i : -1).filter((i) => i >= 0);
  const expected = new Set(included), seen = new Set();
  const edgeCount = graph.edges.filter((e) => expected.has(e.a)).length;
  if (data.wordCount !== included.length || data.edgeCount !== edgeCount || data.positions.length !== included.length) throw new Error('Incomplete optimized layout');
  const positions = schematic.positions.map((p) => ({ ...p }));
  for (const [i, x, y] of data.positions) {
    if (!expected.has(i) || seen.has(i) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid optimized coordinates');
    seen.add(i); positions[i] = { x, y };
  }
  const shiftX = Math.max(...included.map((i) => positions[i].x)) - Math.max(...included.map((i) => graph.nodes[i].x)) + 300;
  graph.nodes.forEach((node, i) => { if (!expected.has(i)) positions[i].x += shiftX; });
  const panels = schematic.panels.map((panel) => ({ ...panel, x: panel.x + shiftX }));
  return { positions, panels, component: data.component, crossings: data.crossings, originalCrossings: data.originalCrossings };
}
