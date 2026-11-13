// Coordinates only: small schematics, topology, and vertex styling stay intact.
export async function topologyHash(graph) {
  const text = JSON.stringify([graph.nodes.map((node) => node.id), graph.edges.map((edge) => [edge.a, edge.b])]);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function gentleLayout(graph, schematic, data) {
  if (data.schemaVersion !== 1 || data.topologySha256 !== await topologyHash(graph)) return null;
  const expected = new Set(graph.nodes.flatMap((node, i) => node.component === data.component ? [i] : []));
  const positions = schematic.positions.map((point) => ({ ...point })), seen = new Set();
  for (const [i, x, y] of data.positions) {
    if (!expected.has(i) || seen.has(i) || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid gentle coordinates');
    seen.add(i); positions[i] = { x, y };
  }
  if (seen.size !== expected.size) throw new Error('Incomplete gentle layout');
  return positions;
}
