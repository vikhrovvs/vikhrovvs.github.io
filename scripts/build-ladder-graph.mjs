import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'site/ladder-graph/data');
const archivePath = path.join(root, 'data/ladder-graph/archive.json');
if (!fs.existsSync(archivePath)) throw new Error('Local source archive is missing: data/ladder-graph/archive.json (not stored in Git)');
const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
if (archive.failures.length || archive.games.length !== archive.discovered.length) {
  throw new Error('Archive is incomplete; resolve export failures before rebuilding');
}
const normalize = (word) => word.trim().toLocaleLowerCase('ru').normalize('NFC').replace(/\s+/g, ' ');
const nodes = [], edges = [], lookup = new Map(), pairs = new Map();
function node(word) {
  const id = normalize(word);
  if (!lookup.has(id)) { lookup.set(id, nodes.length); nodes.push({ id, label: id, games: [] }); }
  return lookup.get(id);
}
const gameIds = new Set();
for (const game of archive.games) {
  if (gameIds.has(game.number)) throw new Error(`Duplicate game ${game.number}`);
  gameIds.add(game.number);
  if (game.transitions.length !== game.expectedWords - 1) throw new Error(`Incomplete game ${game.number}`);
  const indices = new Set();
  for (const clue of game.transitions) {
    if (indices.has(clue.index) || !clue.text) throw new Error(`Invalid clue in ${game.number}`);
    indices.add(clue.index);
    const a = node(clue.from), b = node(clue.to);
    const key = [Math.min(a, b), Math.max(a, b)].join(':');
    if (!pairs.has(key)) { pairs.set(key, edges.length); edges.push({ a: Math.min(a, b), b: Math.max(a, b), clues: [] }); }
    edges[pairs.get(key)].clues.push({ game: game.number, index: clue.index, from: normalize(clue.from), to: normalize(clue.to), text: clue.text });
    for (const i of new Set([a, b])) if (!nodes[i].games.includes(game.number)) nodes[i].games.push(game.number);
  }
}
const adj = nodes.map(() => new Set());
for (const { a, b } of edges) { adj[a].add(b); adj[b].add(a); }
const visited = new Set(), components = [];
for (let i = 0; i < nodes.length; i++) {
  if (visited.has(i)) continue;
  const queue = [i]; visited.add(i);
  for (let j = 0; j < queue.length; j++) for (const v of adj[queue[j]]) if (!visited.has(v)) { visited.add(v); queue.push(v); }
  components.push(queue);
}
components.sort((a, b) => b.length - a.length);
let seed = 12345;
const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
let cursorX = 0, cursorY = 0, rowHeight = 0;
const shelfWidth = Math.max(1800, Math.sqrt(nodes.length) * 145);
components.forEach((component, componentId) => {
  const included = new Set(component);
  const springs = edges.filter((e) => included.has(e.a) && included.has(e.b));
  const radius = Math.sqrt(component.length) * 65;
  for (const i of component) {
    const angle = random() * Math.PI * 2, r = Math.sqrt(random()) * radius;
    Object.assign(nodes[i], { x: Math.cos(angle) * r, y: Math.sin(angle) * r, component: componentId, degree: adj[i].size });
  }
  for (let step = 0; step < 450; step++) {
    const forces = new Map(component.map((i) => [i, { x: -nodes[i].x * .0005, y: -nodes[i].y * .0005 }]));
    for (let p = 0; p < component.length; p++) for (let q = p + 1; q < component.length; q++) {
      const a = nodes[component[p]], b = nodes[component[q]], dx = a.x - b.x || .01, dy = a.y - b.y || .01;
      const d2 = dx * dx + dy * dy + 20, d = Math.sqrt(d2), f = Math.min(10, 1100 / d2);
      const fa = forces.get(component[p]), fb = forces.get(component[q]);
      fa.x += dx / d * f; fa.y += dy / d * f; fb.x -= dx / d * f; fb.y -= dy / d * f;
    }
    for (const { a, b } of springs) {
      const dx = nodes[b].x - nodes[a].x, dy = nodes[b].y - nodes[a].y, d = Math.hypot(dx, dy) || 1;
      const f = (d - 95) * .018, fa = forces.get(a), fb = forces.get(b);
      fa.x += dx / d * f; fa.y += dy / d * f; fb.x -= dx / d * f; fb.y -= dy / d * f;
    }
    const cooling = 1 - step / 550;
    for (const i of component) { const f = forces.get(i); nodes[i].x += Math.max(-12, Math.min(12, f.x)) * cooling; nodes[i].y += Math.max(-12, Math.min(12, f.y)) * cooling; }
  }
  const minX = Math.min(...component.map((i) => nodes[i].x)), minY = Math.min(...component.map((i) => nodes[i].y));
  const width = Math.max(...component.map((i) => nodes[i].x)) - minX + 200;
  const height = Math.max(...component.map((i) => nodes[i].y)) - minY + 170;
  if (cursorX && cursorX + width > shelfWidth) { cursorY += rowHeight; cursorX = 0; rowHeight = 0; }
  for (const i of component) { nodes[i].x = Math.round(nodes[i].x - minX + cursorX + 100); nodes[i].y = Math.round(nodes[i].y - minY + cursorY + 85); }
  cursorX += width; rowHeight = Math.max(rowHeight, height);
});
const graph = { schemaVersion: 1, source: archive.source, collectedAt: archive.collectedAt, gameCount: archive.games.length, clueCount: archive.games.reduce((n, g) => n + g.transitions.length, 0), componentCount: components.length, nodes, edges };
fs.writeFileSync(path.join(folder, 'graph.json'), JSON.stringify(graph));
console.log(`${graph.gameCount} games, ${graph.clueCount} clues, ${nodes.length} words, ${edges.length} undirected edges, ${components.length} components`);
