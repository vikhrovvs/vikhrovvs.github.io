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
  nodes: [], newWords: 0, previousGames: [], reusedEdges: 0,
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

// Word and edge repeats within a ladder must not count as prior appearances.
const reuseGraph = makeGraph([[2, ['a', 'b', 'a', 'c']], [8, ['b', 'a', 'd', 'a', 'b']], [10, ['e', 'f']], [20, ['b', 'f', 'a', 'c', 'e']], [30, ['a', 'b', 'c']]]);
const reuseSteps = buildComponentHistory(reuseGraph), reuseFacts = analyzeComponentHistory(reuseSteps).reuse;
assert.equal(reuseSteps[0].reusedEdges, 0);
assert.equal(reuseSteps[0].nodes.length - reuseSteps[0].newWords, 0);
assert.equal(reuseSteps[1].nodes.length - reuseSteps[1].newWords, 2);
assert.equal(reuseSteps[1].reusedEdges, 1); // a-b is repeated many times but is one pair.
assert.equal(reuseSteps[1].previousGames.length, 1); // a's repeated positions count only once.
assert.equal(reuseSteps[3].previousGames.length, 3);
assert.equal(reuseSteps[3].type, 'merge'); assert.equal(reuseSteps[3].newWords, 0);
assert.equal(reuseFacts.oldWords.maximum, 5);
assert.equal(reuseFacts.oldWords.moreThanTwo, 2);
assert.deepEqual(reuseFacts.oldWords.steps.map((s) => s.number), [20]);
assert.equal(reuseFacts.previousLadders.maximum, 3);
assert.deepEqual(reuseFacts.previousLadders.steps.map((s) => s.number), [20, 30]);
assert.equal(reuseFacts.sharedWords.maximum, 3);
assert.deepEqual(reuseFacts.sharedWords.pairs.map(({ step, previous }) => [step.number, previous.number]), [[20, 2], [30, 2], [30, 20]]);
assert.equal(reuseFacts.absence.maximum, 2); // c disappears during the two available ladders 8 and 10.
assert.equal(reuseGraph.nodes[reuseFacts.absence.returns[0].node].label, 'c');
assert.deepEqual(reuseFacts.absence.returns.map(({ previous, step }) => [previous.number, step.number]), [[2, 20]]);
const tiedReturns = analyzeComponentHistory(buildComponentHistory(makeGraph([[1, ['a', 'b']], [2, ['x', 'y']], [3, ['c', 'd']], [4, ['a', 'b']]]))).reuse.absence;
assert.equal(tiedReturns.maximum, 2); assert.equal(tiedReturns.returns.length, 2);
assert.equal(lone.reuse.oldWords.maximum, 0); assert.deepEqual(lone.reuse.oldWords.steps, []);
assert.equal(lone.reuse.absence.maximum, 0); assert.deepEqual(lone.reuse.absence.returns, []);
assert.equal(emptyFacts.reuse.sharedWords.maximum, 0); assert.deepEqual(emptyFacts.reuse.sharedWords.pairs, []);

// Independent BFS over each historical prefix verifies every point, not just the final one.
const graph = JSON.parse(fs.readFileSync(new URL('../site/ladder-graph/data/graph.json', import.meta.url)));
const history = buildComponentHistory(graph);
const originalGames = new Map();
for (const edge of graph.edges) for (const clue of edge.clues) {
  if (!originalGames.has(clue.game)) originalGames.set(clue.game, new Set());
  originalGames.get(clue.game).add(edge.a); originalGames.get(clue.game).add(edge.b);
}
const sortedGames = [...originalGames].sort(([a], [b]) => a - b), independentOldCounts = [];

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
  const currentWords = originalGames.get(step.number), earlierWords = new Set(sortedGames.filter(([number]) => number < step.number).flatMap(([, nodes]) => [...nodes]));
  const oldCount = [...currentWords].filter((node) => earlierWords.has(node)).length;
  independentOldCounts.push(oldCount);
  assert.equal(step.nodes.length - step.newWords, oldCount);
  const expectedPrevious = sortedGames.filter(([number]) => number < step.number).map(([number, nodes]) => ({ number, words: [...currentWords].filter((node) => nodes.has(node)).sort((a, b) => a - b) })).filter((item) => item.words.length);
  assert.deepEqual(step.previousGames.map(({ number, words }) => ({ number, words: [...words].sort((a, b) => a - b) })), expectedPrevious);
  assert.equal(step.reusedEdges, graph.edges.filter((edge) => edge.clues.some((clue) => clue.game === step.number) && edge.clues.some((clue) => clue.game < step.number)).length);
}
assert.equal(history.at(-1).components, graph.componentCount);
assert.equal(history.at(-1).total, graph.nodes.length);
assert.equal(history.length, graph.gameCount);
assert.deepEqual(buildComponentHistory({ ...graph, edges: [...graph.edges].reverse() }), history);
const actualFacts = analyzeComponentHistory(history);
assert.equal(actualFacts.reuse.oldWords.maximum, Math.max(...independentOldCounts));
assert.equal(actualFacts.reuse.oldWords.moreThanTwo, independentOldCounts.filter((count) => count > 2).length);
assert.deepEqual(actualFacts.reuse.oldWords.steps.map((s) => s.number), history.filter((_, i) => independentOldCounts[i] === actualFacts.reuse.oldWords.maximum).map((s) => s.number));
const independentReturns = [];
for (let node = 0; node < graph.nodes.length; node++) {
  const occurrences = sortedGames.map(([number, nodes], index) => ({ number, index, present: nodes.has(node) })).filter((item) => item.present);
  for (let i = 1; i < occurrences.length; i++) independentReturns.push({ gap: occurrences[i].index - occurrences[i - 1].index - 1, node, before: occurrences[i - 1].number, after: occurrences[i].number });
}
assert.equal(actualFacts.reuse.absence.maximum, Math.max(...independentReturns.map((item) => item.gap)));
assert.deepEqual(actualFacts.reuse.absence.returns.map(({ node, previous, step }) => [node, previous.number, step.number]).sort(), independentReturns.filter((item) => item.gap === actualFacts.reuse.absence.maximum && item.gap > 0).map(({ node, before, after }) => [node, before, after]).sort());

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
console.log(`OK: distinct old words, prior ladder overlaps, prior undirected edges, tied records and gaps between consecutive appearances`);
console.log(`OK: first events, absent events, all tied streak records, current streak at every step, thresholds and sustained majority`);
console.log(`OK: synthetic births, attachments, triple merge, repeated edges, self-loop, changing leader; BFS matches all ${history.length} historical steps`);
