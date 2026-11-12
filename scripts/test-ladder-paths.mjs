import assert from 'node:assert/strict';
import { findLongPaths } from './ladder-paths.mjs';

function check(size, edges, expected, hamiltonian) {
  const adj = Array.from({ length: size }, () => new Set());
  for (const [a, b] of edges) { adj[a].add(b); adj[b].add(a); }
  const components = [Array.from({ length: size }, (_, i) => i)];
  const [result] = findLongPaths(adj, components);
  assert.equal(result.nodes.length, expected);
  assert.equal(result.hamiltonian, hamiltonian);
  assert.equal(result.optimal, true);
  assert.equal(new Set(result.nodes).size, expected);
  result.nodes.slice(1).forEach((node, i) => assert(adj[result.nodes[i]].has(node)));
  assert.deepEqual(findLongPaths(adj, components), [result]);
}
check(1, [[0, 0]], 1, true);
check(5, [[0, 1], [1, 2], [2, 3], [3, 4]], 5, true);
check(5, [[0, 1], [0, 2], [0, 3], [0, 4]], 3, false);
check(4, [[0, 1], [1, 2], [2, 3], [3, 0]], 4, true);
const limited = findLongPaths([new Set([1, 2]), new Set([0]), new Set([0])], [[0, 1, 2]], { trials: 1, stepsPerTrial: 1 })[0];
assert.equal(limited.optimal, false);
const disconnected = findLongPaths([new Set([1]), new Set([0]), new Set()], [[0, 1], [2]]);
assert.deepEqual(disconnected.map((p) => p.nodes.length), [2, 1]);
console.log('OK: long paths cover chains, cycles, branches, isolated/disconnected nodes, budget limits and determinism');
