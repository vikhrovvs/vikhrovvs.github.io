// Coordinates only: never duplicate a word or change the graph's topology.
export function schematicLayout(graph) {
  const { nodes, edges } = graph;
  const adjacency = nodes.map(() => []), groups = new Map();
  edges.forEach(({ a, b }) => { adjacency[a].push(b); if (a !== b) adjacency[b].push(a); });
  nodes.forEach((node, i) => {
    if (!groups.has(node.component)) groups.set(node.component, []);
    groups.get(node.component).push(i);
  });
  const positions = nodes.map(({ x, y }) => ({ x, y }));
  const panels = [];
  const largest = [...groups.values()].reduce((a, b) => a.length > b.length ? a : b);
  const small = [];
  for (const [id, indices] of groups) {
    const games = new Set(indices.flatMap((i) => nodes[i].games));
    if (indices === largest || games.size > 2) continue;
    const edgeCount = indices.reduce((sum, i) => sum + adjacency[i].length, 0) / 2;
    const local = new Map();
    const put = (i, x, y) => local.set(i, { x, y });
    // Remove leaves to distinguish trees from a single real cycle.
    const degree = new Map(indices.map((i) => [i, adjacency[i].length]));
    const queue = indices.filter((i) => degree.get(i) <= 1);
    const removed = new Set(queue);
    for (let q = 0; q < queue.length; q++) for (const next of adjacency[queue[q]]) {
      degree.set(next, degree.get(next) - 1);
      if (degree.get(next) === 1 && !removed.has(next)) { removed.add(next); queue.push(next); }
    }
    const core = indices.filter((i) => !removed.has(i));
    let kind;
    function branch(start, parent, x, y, angle) {
      let previous = parent, current = start, step = 1;
      while (current !== undefined && !local.has(current)) {
        put(current, x + Math.cos(angle) * 95 * step, y + Math.sin(angle) * 95 * step);
        const next = adjacency[current].filter((i) => i !== previous && !local.has(i));
        if (next.length > 1) return false;
        previous = current; current = next[0]; step++;
      }
      return true;
    }
    if (edgeCount === indices.length - 1) {
      const forks = indices.filter((i) => adjacency[i].length > 2);
      if (forks.length > 1) continue;
      if (!forks.length) {
        const start = indices.find((i) => adjacency[i].length <= 1);
        put(start, 0, 0);
        branch(adjacency[start][0], start, 0, 0, 0);
        kind = 'цепочка';
      } else {
        const center = forks[0]; put(center, 0, 0);
        adjacency[center].forEach((next, i, neighbors) => branch(next, center, 0, 0, -Math.PI / 4 + i * Math.PI * 2 / neighbors.length));
        kind = 'развилка';
      }
    } else if (edgeCount === indices.length && core.length >= 3 && core.every((i) => adjacency[i].filter((j) => !removed.has(j)).length === 2)) {
      const start = core.find((i) => adjacency[i].length > 2) ?? core[0];
      const order = [start];
      let previous = -1, current = start;
      do {
        const next = adjacency[current].find((i) => i !== previous && !removed.has(i));
        previous = current; current = next;
        if (current !== start) order.push(current);
      } while (current !== start);
      const radius = 95 / (2 * Math.sin(Math.PI / order.length));
      order.forEach((i, k) => { const angle = -Math.PI / 2 + k * 2 * Math.PI / order.length; put(i, Math.cos(angle) * radius, Math.sin(angle) * radius); });
      for (const i of order) {
        const p = local.get(i), tails = adjacency[i].filter((j) => removed.has(j));
        tails.forEach((next, k) => branch(next, i, p.x, p.y, Math.atan2(p.y, p.x) + (k - (tails.length - 1) / 2) * Math.PI / 2));
      }
      kind = 'цикл';
    } else continue; // More complex future components keep their original coordinates.
    if (local.size !== indices.length) continue;
    // Flatten the schematic vertically while keeping every edge straight.
    for (const p of local.values()) p.y *= .5;
    const points = [...local.values()];
    const minX = Math.min(...points.map((p) => p.x)), minY = Math.min(...points.map((p) => p.y));
    const width = Math.max(...points.map((p) => p.x)) - minX + 180;
    const height = Math.max(...points.map((p) => p.y)) - minY + 170;
    small.push({ id, indices, games: games.size, kind, local, minX, minY, width, height });
  }
  // A separate shelf of small components beside the unchanged force layout.
  const changed = new Set(small.flatMap((item) => item.indices));
  const fixed = nodes.filter((_, i) => !changed.has(i));
  const shelfX = Math.max(...fixed.map((n) => n.x)) + 180;
  let y = Math.min(...fixed.map((n) => n.y)) - 60, x = 0, rowHeight = 0;
  const shelfWidth = 2600;
  for (const item of small.sort((a, b) => a.id - b.id)) {
    if (x && x + item.width > shelfWidth) { y += rowHeight + 30; x = 0; rowHeight = 0; }
    for (const i of item.indices) {
      const p = item.local.get(i);
      positions[i] = { x: p.x - item.minX + shelfX + x + 90, y: p.y - item.minY + y + 85 };
    }
    panels.push({ ...item, x: shelfX + x, y });
    x += item.width + 30; rowHeight = Math.max(rowHeight, item.height);
  }
  return { positions, panels, components: new Set(panels.map((panel) => panel.id)) };
}
