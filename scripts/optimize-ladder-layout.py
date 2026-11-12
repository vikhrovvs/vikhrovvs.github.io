"""Offline coordinate generation: NumPy and NetworkX, no browser or CI dependencies.
All words remain individual vertices; graph.json is read but never modified.
"""
import json
import math
from pathlib import Path
import numpy as np
import networkx as nx

ROOT = Path(__file__).resolve().parents[1]
graph = json.loads((ROOT / 'site/ladder-graph/data/graph.json').read_text())
nodes, edges = graph['nodes'], graph['edges']
largest = max({n['component'] for n in nodes}, key=lambda c: sum(n['component'] == c for n in nodes))
g = nx.Graph((e['a'], e['b']) for e in edges if nodes[e['a']]['component'] == largest)
anchors = sorted(n for n in g if g.degree(n) != 2)
lookup = {n: i for i, n in enumerate(anchors)}
seen, paths = set(), []
for a in anchors:
    for b in g[a]:
        if tuple(sorted((a, b))) in seen:
            continue
        path = [a, b]
        seen.add(tuple(sorted((a, b))))
        while b not in lookup:
            c = next(n for n in g[b] if n != path[-2])
            seen.add(tuple(sorted((b, c))))
            path.append(c)
            b = c
        paths.append(path)
route_edges = np.array([[lookup[p[0]], lookup[p[-1]]] for p in paths])
source_edges = np.array(list(g.edges()))

def cross(a, b):
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]

def intersections(a, b, c, d):
    return ((cross(b-a, c-a) * cross(b-a, d-a) < -1e-8)
            & (cross(d-c, a-c) * cross(d-c, b-c) < -1e-8))

def count(positions, es):
    a, b = positions[es[:, 0]], positions[es[:, 1]]
    shared = (es[:, None, :] == es[None, :, 0, None]).any(axis=2) | (es[:, None, :] == es[None, :, 1, None]).any(axis=2)
    hits = intersections(a[:, None], b[:, None], a[None, :], b[None, :]) & ~shared
    return int(np.count_nonzero(np.triu(hits, 1)))

topology = nx.Graph()
topology.add_nodes_from(range(len(anchors)))
for path in paths:
    topology.add_edge(lookup[path[0]], lookup[path[-1]], weight=1 / math.sqrt(len(path)-1))

best, best_count = None, math.inf
for seed in [7, 19, 43, 71, 103, 137]:
    pos = nx.spring_layout(topology, seed=seed, iterations=650, method='force', threshold=1e-5)
    points = np.array([pos[i] for i in topology])
    score = count(points, route_edges)
    print(f'Initial seed {seed}: {score} route crossings', flush=True)
    if score < best_count:
        best, best_count = points.copy(), score

rng = np.random.default_rng(20261113)
points = best.copy()
incident = [np.where((route_edges == i).any(axis=1))[0] for i in range(len(anchors))]
others = [np.where(~(route_edges == i).any(axis=1))[0] for i in range(len(anchors))]
directions = np.array([[math.cos(a), math.sin(a)] for a in np.arange(16) * math.pi / 8])

def local_score(i):
    e, o = route_edges[incident[i]], route_edges[others[i]]
    a, b = points[e[:, 0]], points[e[:, 1]]
    c, d = points[o[:, 0]], points[o[:, 1]]
    shared = (e[:, None, :] == o[None, :, 0, None]).any(axis=2) | (e[:, None, :] == o[None, :, 1, None]).any(axis=2)
    crossing = np.count_nonzero(intersections(a[:, None], b[:, None], c[None, :], d[None, :]) & ~shared)
    length = np.sum(np.linalg.norm(a - b, axis=1))
    distances = np.linalg.norm(points - points[i], axis=1)
    distances[i] = 1
    collision = np.sum(np.maximum(0, .012 - distances) ** 2) * 10000
    return crossing * 100 + length * .15 + collision

for sweep in range(36):
    step = .11 * (.93 ** sweep) + .003
    for i in rng.permutation(len(anchors)):
        original = points[i].copy()
        score = local_score(i)
        winner = original
        neighbors = list(topology[i])
        candidates = original + directions * step
        if neighbors:
            candidates = np.vstack([candidates, np.mean(points[neighbors], axis=0)])
        for candidate in candidates:
            points[i] = candidate
            candidate_score = local_score(i)
            if candidate_score < score - 1e-10:
                score, winner = candidate_score, candidate.copy()
        points[i] = winner
    crossings = count(points, route_edges)
    if crossings < best_count:
        best, best_count = points.copy(), crossings
    if sweep % 6 == 0:
        print(f'Crossing optimisation {sweep}: {crossings}', flush=True)

points = best
# Set physical spacing from the most crowded route; no words are removed.
lengths = np.linalg.norm(points[route_edges[:, 0]] - points[route_edges[:, 1]], axis=1)
spacing = np.median(lengths / np.array([len(p)-1 for p in paths]))
points = (points - points.min(axis=0)) * (100 / spacing) + 150

# Restore every original word, including all words inside degree-two chains.
optimized = np.array([[n['x'], n['y']] for n in nodes], dtype=float)
for index, path in enumerate(paths):
    a, b = points[lookup[path[0]]], points[lookup[path[-1]]]
    route = np.linspace(a, b, len(path))
    if any(set((p[0], p[-1])) == set((path[0], path[-1])) for p in paths[:index]):
        delta = b-a
        normal = np.array([-delta[1], delta[0]]) / max(1, np.linalg.norm(delta))
        route += np.sin(np.linspace(0, math.pi, len(path)))[:, None] * normal * 85
    for k, node in enumerate(path):
        optimized[node] = route[k]

import hashlib
topology_json = json.dumps([[n['id'] for n in nodes], [[e['a'], e['b']] for e in edges]], ensure_ascii=False, separators=(',', ':'))
original = np.array([[n['x'], n['y']] for n in nodes], dtype=float)
# The independent JS audit below also checks contacts and overlaps.
result = {'schemaVersion': 1, 'topologySha256': hashlib.sha256(topology_json.encode()).hexdigest(),
          'component': largest, 'wordCount': len(g), 'edgeCount': g.number_of_edges(),
          'originalCrossings': count(original, source_edges), 'crossings': count(optimized, source_edges),
          'positions': [[int(i), *optimized[i].round(4).tolist()] for i in sorted(g)]}
target = ROOT / 'site/ladder-graph/optimized-coordinates.json'
target.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')) + '\n')
print(f"Saved {target}. Run node scripts/test-optimized-layout.mjs --update-counts to audit and record inclusive intersection counts.")
