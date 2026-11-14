"""Generate coordinates when topology changes. NumPy is a build-only dependency."""
import json
import math
import hashlib
import subprocess
import sys
from pathlib import Path
import numpy as np

root = Path(__file__).resolve().parents[1]
graph = json.loads((root / 'site/ladder-graph/data/graph.json').read_text(encoding='utf-8'))
nodes = graph['nodes']
target = root / 'site/ladder-graph/gentle-coordinates.json'
topology = json.dumps([[n['id'] for n in nodes], [[e['a'], e['b']] for e in graph['edges']]], ensure_ascii=False, separators=(',', ':'))
topology_hash = hashlib.sha256(topology.encode()).hexdigest()
if '--if-needed' in sys.argv and target.exists():
    previous = json.loads(target.read_text(encoding='utf-8'))
    if previous.get('topologySha256') == topology_hash and 'crossings' in previous:
        print('Gentle coordinates already match the graph')
        sys.exit(0)
component = max({n['component'] for n in nodes}, key=lambda c: sum(n['component'] == c for n in nodes))
ids = np.array([i for i, n in enumerate(nodes) if n['component'] == component])
edges = np.array([[e['a'],e['b']] for e in graph['edges'] if nodes[e['a']]['component'] == component])
original = np.array([[n['x'],n['y']] for n in nodes], dtype=float)
points = original.copy()
neighbors = [[] for _ in nodes]
for a,b in edges:
    neighbors[a].append(b); neighbors[b].append(a)
low, high = original[ids].min(axis=0), original[ids].max(axis=0)
pinned = {int(ids[np.argmin(original[ids,axis])]) for axis in range(2)} | {int(ids[np.argmax(original[ids,axis])]) for axis in range(2)}
incidents = {i:np.where((edges == i).any(axis=1))[0] for i in ids}
others = {i:np.where(~(edges == i).any(axis=1))[0] for i in ids}
valid = {}
for i in ids:
    e,o = edges[incidents[i]],edges[others[i]]
    valid[i] = ~((e[:,None,:] == o[None,:,0,None]).any(axis=2) | (e[:,None,:] == o[None,:,1,None]).any(axis=2))
radii = np.array([(3.4+max(0,(n['degree']-1)//2)*1.65 if n['degree']>2 else 2.8)/.16 for n in nodes])

def cross(a,b):
    return a[...,0]*b[...,1]-a[...,1]*b[...,0]

def proper(a,b,c,d):
    return (cross(b-a,c-a)*cross(b-a,d-a)<-1e-8) & (cross(d-c,a-c)*cross(d-c,b-c)<-1e-8)

def score(i):
    e,o = edges[incidents[i]],edges[others[i]]
    a,b,c,d = points[e[:,0]],points[e[:,1]],points[o[:,0]],points[o[:,1]]
    hits = np.count_nonzero(proper(a[:,None],b[:,None],c[None,:],d[None,:]) & valid[i])
    distance = np.linalg.norm(points[ids]-points[i],axis=1)
    distance[ids==i] = 1e6
    collision = np.sum(np.maximum(0,radii[ids]+radii[i]+8-distance)**2)
    length = np.linalg.norm(a-b,axis=1)
    elastic = np.sum((length-95)**2)
    displacement = np.sum((points[i]-original[i])**2)
    return hits*65 + collision*.28 + elastic*.003 + displacement*.001

def total():
    a,b = points[edges[:,0]],points[edges[:,1]]
    mask = proper(a[:,None],b[:,None],a[None,:],b[None,:])
    shared = (edges[:,None,:]==edges[None,:,0,None]).any(axis=2) | (edges[:,None,:]==edges[None,:,1,None]).any(axis=2)
    return int(np.count_nonzero(np.triu(mask & ~shared,1)))

rng=np.random.default_rng(20261113)
directions=np.array([[math.cos(a),math.sin(a)] for a in np.arange(8)*math.pi/4])
for sweep in range(12):
    step = [70,55,40,30,22,16,12,10,8,6,5,4][sweep]
    for i in rng.permutation(ids):
        if i in pinned: continue
        current=points[i].copy(); best=current; value=score(i)
        candidates=np.vstack([current+directions*step, np.mean(points[neighbors[i]],axis=0)])
        for candidate in candidates:
            candidate=np.clip(candidate,low,high)
            delta=candidate-original[i]
            if np.linalg.norm(delta)>240: candidate=original[i]+delta/np.linalg.norm(delta)*240
            points[i]=candidate
            trial=score(i)
            if trial<value-1e-8: value=trial;best=candidate.copy()
        points[i]=best
    print(f'Local sweep {sweep+1}/12: {total()} proper crossings',flush=True)

result={'component':component,'positions':[[int(i),*points[i].round(5).tolist()] for i in ids],
        'maxMovement':float(np.max(np.linalg.norm(points[ids]-original[ids],axis=1))),
        'bounds':[low.tolist(),high.tolist()]}
topology=json.dumps([[n['id'] for n in nodes],[[e['a'],e['b']] for e in graph['edges']]],ensure_ascii=False,separators=(',',':'))
result.update(schemaVersion=1,topologySha256=topology_hash)
target=root/'site/ladder-graph/gentle-coordinates.json'
target.write_text(json.dumps(result,separators=(',',':'))+'\n', encoding='utf-8')
print(f'Saved {target}',flush=True)
subprocess.run(['node', 'scripts/test-gentle-layout.mjs', '--update-counts'], cwd=root, check=True)
