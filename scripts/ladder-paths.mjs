// Bounded, deterministic multi-start DFS. Only exhaustive search or full coverage proves optimality.
export function findLongPaths(adjacency, components, { trials = 128, stepsPerTrial = 30000 } = {}) {
  let seed = 928371;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
  const shuffle = (values) => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  };
  return components.map((component, componentId) => {
    let best = [], exhaustive = true;
    const starts = shuffle(component);
    // Low-degree starts tend to include long dangling branches.
    starts.sort((a, b) => adjacency[a].size - adjacency[b].size);
    const count = Math.min(trials, starts.length);
    for (let trial = 0; trial < count; trial++) {
      const order = new Map(component.map((i) => [i, shuffle([...adjacency[i]].filter((j) => j !== i))]));
      const used = new Set(), path = [];
      let remaining = stepsPerTrial, stopped = false;
      function visit(node) {
        if (remaining-- <= 0) { stopped = true; return; }
        used.add(node); path.push(node);
        if (path.length > best.length) best = [...path];
        if (best.length < component.length) for (const next of order.get(node)) {
          if (!used.has(next)) visit(next);
          if (stopped || best.length === component.length) break;
        }
        used.delete(node); path.pop();
      }
      visit(starts[trial]);
      if (stopped) exhaustive = false;
      if (best.length === component.length) break;
    }
    const hamiltonian = best.length === component.length;
    return { component: componentId, nodes: best, hamiltonian, optimal: hamiltonian || (exhaustive && count === component.length) };
  });
}
