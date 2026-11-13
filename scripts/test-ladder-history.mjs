import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildComponentHistory, analyzeComponentHistory } from '../site/ladder-graph/history.js';

function makeGraph(games) {
  const nodes = [], lookup = new Map(), edges = new Map();
  const id = (word) => {
    if (!lookup.has(word)) { lookup.set(word, nodes.length); nodes.push({ label: word }); }
    return lookup.get(word);
  };
  for (const [number, words] of games) for (let i = 1; i < words.length; i++) {
    const a = id(words[i - 1]), b = id(words[i]), key = [Math.min(a, b), Math.max(a, b)].join(':');
    if (!edges.has(key)) edges.set(key, { a, b, clues: [] });
    edges.get(key).clues.push({ game: number, index: i - 1, from: words[i - 1], to: words[i] });
  }
  return { nodes, edges: [...edges.values()] };
}
const fixture = makeGraph([[8, ['c', 'd']], [2, ['a', 'b']], [10, ['e', 'f']], [11, ['b', 'c', 'e']], [12, ['a', 'g', 'b']], [14, ['a', 'b']], [20, ['h', 'h']]]);
const steps = buildComponentHistory(fixture);
assert.deepEqual(steps.map((s) => s.number), [2, 8, 10, 11, 12, 14, 20]);
assert.deepEqual(steps.map((s) => s.components), [1, 2, 3, 1, 1, 1, 2]);
assert.deepEqual(steps.map((s) => s.type), ['birth', 'birth', 'birth', 'merge', 'attach', 'internal', 'birth']);
assert.deepEqual(steps[3].joined.map((c) => c.size), [2, 2, 2]);
assert.equal(steps[3].delta, -2); assert.equal(steps[3].largest, 6);
assert.equal(steps[4].largest, 7); assert.equal(steps[5].newEdges, 0);
assert.equal(steps[6].resultSize, 1); assert.equal(steps[6].largest, 7);
assert.deepEqual(buildComponentHistory({ nodes: [], edges: [] }), []);
const changingLeader = buildComponentHistory(makeGraph([[1, ['a', 'b', 'c']], [2, ['d', 'e']], [3, ['d', 'f', 'g']]]));
assert.deepEqual(changingLeader.map((s) => s.largest), [3, 3, 4]);

const facts = analyzeComponentHistory(steps);
assert.equal(facts.firstAttachment.number, 12);
assert.equal(facts.firstMerge.number, 11);
assert.equal(facts.firstTripleMerge.number, 11);
assert.equal(facts.largestJump.number, 11);
assert.equal(facts.sustainedMajority.number, 11); // Earlier majorities are interrupted.
assert.ok(facts.thresholds.every(({ step }) => step === null));
const mergerRuns = facts.streaks.find((s) => s.id === 'mergers');
assert.equal(mergerRuns.maximum, 1);
assert.deepEqual(mergerRuns.lengths, [0, 0, 0, 1, 0, 0, 0]);
const lone = analyzeComponentHistory(buildComponentHistory(makeGraph([[10, ['a', 'b']]])));
assert.equal(lone.firstAttachment, null); assert.equal(lone.firstMerge, null); assert.equal(lone.firstTripleMerge, null);
assert.equal(lone.sustainedMajority.number, 10);
const emptyFacts = analyzeComponentHistory([]);
assert.equal(emptyFacts.largestJump, null); assert.equal(emptyFacts.sustainedMajority, null);
assert.ok(emptyFacts.streaks.every((s) => s.maximum === 0 && s.ranges.length === 0 && s.lengths.length === 0));
const tiedSteps = ['birth', 'birth', 'merge', 'merge', 'attach', 'merge', 'merge', 'attach'].map((type, index) => ({
  type, index, number: (index + 1) * 10, joined: Array(type === 'birth' ? 0 : type === 'merge' ? 2 : 1),
  largest: 100 + index * 200, previousLargest: index ? 100 + (index - 1) * 200 : 0, total: 200 + index * 300,
}));
const tiedFacts = analyzeComponentHistory(tiedSteps);
assert.deepEqual(tiedFacts.streaks.find((s) => s.id === 'mergers').ranges, [{ start: 2, end: 3 }, { start: 5, end: 6 }]);
assert.equal(tiedFacts.streaks.find((s) => s.id === 'attachments').lengths.at(-1), 1);
assert.equal(tiedFacts.streaks.find((s) => s.id === 'growth').maximum, 8);
assert.deepEqual(tiedFacts.thresholds.map(({ step }) => step.number), [10, 30, 60]);
// Equal growth records choose the earliest step; numbering gaps do not inflate streaks.
assert.equal(tiedFacts.largestJump.number, 20);

// Independent BFS over each historical prefix verifies every point, not just the final one.
const graph = JSON.parse(fs.readFileSync(new URL('../site/ladder-graph/data/graph.json', import.meta.url)));
const history = buildComponentHistory(graph);
for (const step of history) {
  const adj = new Map();
  for (const edge of graph.edges) if (edge.clues.some((c) => c.game <= step.number)) {
    if (!adj.has(edge.a)) adj.set(edge.a, new Set());
    if (!adj.has(edge.b)) adj.set(edge.b, new Set());
    adj.get(edge.a).add(edge.b); adj.get(edge.b).add(edge.a);
  }
  const visited = new Set(), sizes = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const queue = [start]; visited.add(start);
    for (const node of queue) for (const next of adj.get(node)) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    sizes.push(queue.length);
  }
  assert.equal(step.components, sizes.length, `component count at ${step.number}`);
  assert.equal(step.largest, Math.max(...sizes), `largest at ${step.number}`);
  assert.equal(step.total, visited.size);
  assert.equal(step.delta, 1 - step.joined.length);
  assert.equal(step.resultSize, step.joined.reduce((sum, c) => sum + c.size, step.newWords));
}
assert.equal(history.at(-1).components, graph.componentCount);
assert.equal(history.at(-1).total, graph.nodes.length);
assert.equal(history.length, graph.gameCount);
assert.deepEqual(buildComponentHistory({ ...graph, edges: [...graph.edges].reverse() }), history);
const actualFacts = analyzeComponentHistory(history);
for (const streak of actualFacts.streaks) {
  const predicates = {
    isolated: (s) => s.joined.length === 0, connected: (s) => s.joined.length > 0,
    attachments: (s) => s.type === 'attach', mergers: (s) => s.type === 'merge',
    'without-mergers': (s) => s.type !== 'merge', growth: (s) => s.largest > s.previousLargest,
    plateau: (s) => s.largest === s.previousLargest,
  };
  const expected = history.map((_, i) => {
    let length = 0;
    for (let j = i; j >= 0 && predicates[streak.id](history[j]); j--) length++;
    return length;
  });
  assert.deepEqual(streak.lengths, expected);
  assert.equal(streak.maximum, Math.max(...expected));
  assert.deepEqual(streak.ranges, expected.flatMap((length, i) => length === streak.maximum && length ? [{ start: i - length + 1, end: i }] : []));
}
console.log(`OK: first events, absent events, all tied streak records, current streak at every step, thresholds and sustained majority`);
console.log(`OK: synthetic births, attachments, triple merge, repeated edges, self-loop, changing leader; BFS matches all ${history.length} historical steps`);
