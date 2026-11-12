'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('graph'), ctx = canvas.getContext('2d');
const normalize = (s) => s.trim().toLocaleLowerCase('ru').normalize('NFC').replace(/\s+/g, ' ');
let graph, adjacency, componentStats, selected = 0, selectedEdge = null;
let visibleNodes = [], visibleEdges = [], camera = { x: 0, y: 0, scale: 1 }, width = 1, height = 1;
let drag = null, frame = 0;
let rotatingExamples = [], exampleCursor = 0;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Golden-angle hues give every connected component its own bright color.
const prominenceTier = (degree) => Math.max(0, Math.floor((degree - 1) / 2));
const componentColor = (component, alpha = 1) => `hsla(${(component * 137.508 + 80) % 360}, 82%, 68%, ${alpha})`;
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function sourceLink(number) {
  const a = element('a', `Лесенка №${number} ↗`);
  a.href = `https://interoves.com/ladder/${number}/`; a.target = '_blank'; a.rel = 'noreferrer';
  return a;
}
function plural(number, forms) {
  const n = number % 100;
  return forms[n >= 11 && n <= 14 ? 2 : number % 10 === 1 ? 0 : number % 10 >= 2 && number % 10 <= 4 ? 1 : 2];
}
function buildDegreeStatistics() {
  const groups = new Map();
  graph.nodes.forEach((node, index) => {
    if (!groups.has(node.degree)) groups.set(node.degree, []);
    groups.get(node.degree).push(index);
  });
  const maximum = Math.max(...groups.keys()), list = $('degree-list');
  for (let degree = 0; degree <= maximum; degree++) {
    const pool = groups.get(degree) || [];
    const row = element(pool.length ? 'button' : 'div', undefined, 'degree-entry');
    row.dataset.degree = degree; row.dataset.count = pool.length;
    const stat = element('span', undefined, 'degree-stat');
    const label = element('span'); label.append(element('strong', degree), document.createTextNode(` ${plural(degree, ['сосед', 'соседа', 'соседей'])}`));
    stat.append(label, element('span', `${pool.length.toLocaleString('ru')} ${plural(pool.length, ['слово', 'слова', 'слов'])}`, 'degree-count'));
    row.append(stat);
    if (pool.length) {
      row.type = 'button';
      const word = element('span', undefined, 'degree-word');
      const entry = { pool, current: Math.floor(Math.random() * pool.length), row, word, degree };
      function updateLabel() {
        const text = graph.nodes[pool[entry.current]].label;
        word.textContent = text; row.title = text;
        row.setAttribute('aria-label', `${degree} ${plural(degree, ['сосед', 'соседа', 'соседей'])}, ${pool.length} ${plural(pool.length, ['слово', 'слова', 'слов'])}. Перейти к слову ${text}`);
      }
      entry.updateLabel = updateLabel; updateLabel();
      row.append(word, element('span', '↗', 'degree-arrow'));
      row.lastChild.setAttribute('aria-hidden', 'true');
      row.addEventListener('click', () => selectWord(pool[entry.current], true));
      if (pool.length > 1) rotatingExamples.push(entry);
    } else {
      row.classList.add('is-empty'); row.append(element('span', 'Нет слов', 'degree-word'));
    }
    list.append(row);
  }
  // Only one row changes at a time; pausing under the pointer/focus keeps clicks stable.
  window.setInterval(() => {
    const panel = $('degree-panel');
    if (!rotatingExamples.length || document.hidden || panel.matches(':hover') || panel.contains(document.activeElement)) return;
    const entry = rotatingExamples[exampleCursor++ % rotatingExamples.length];
    const replace = () => {
      if (!document.hidden && !panel.matches(':hover') && !panel.contains(document.activeElement)) {
        const next = Math.floor(Math.random() * (entry.pool.length - 1));
        entry.current = next >= entry.current ? next + 1 : next;
        entry.updateLabel();
      }
      entry.word.classList.remove('is-updating');
    };
    if (reducedMotion.matches) replace();
    else { entry.word.classList.add('is-updating'); window.setTimeout(replace, 180); }
  }, 3500);
}
function buildMultiplicityStatistics() {
  const groups = new Map();
  graph.edges.forEach((edge, index) => {
    const multiplicity = edge.clues.length;
    if (!groups.has(multiplicity)) groups.set(multiplicity, []);
    groups.get(multiplicity).push(index);
  });
  for (const [multiplicity, pool] of [...groups].sort(([a], [b]) => a - b)) {
    const row = element('button', undefined, 'degree-entry multiplicity-entry'); row.type = 'button';
    row.dataset.multiplicity = multiplicity; row.dataset.count = pool.length;
    const stat = element('span', undefined, 'degree-stat');
    stat.append(element('span', `Кратность ${multiplicity}`), element('span', `${pool.length.toLocaleString('ru')} ${plural(pool.length, ['пара', 'пары', 'пар'])}`, 'degree-count'));
    const word = element('span', undefined, 'degree-word');
    const entry = { pool, current: Math.floor(Math.random() * pool.length), row, word };
    entry.updateLabel = () => {
      const edge = graph.edges[pool[entry.current]];
      const text = `${graph.nodes[edge.a].label} ↔ ${graph.nodes[edge.b].label}`;
      word.textContent = text; row.title = text;
      row.setAttribute('aria-label', `Кратность ${multiplicity}, ${pool.length} ${plural(pool.length, ['пара', 'пары', 'пар'])}. Перейти к ребру ${text}`);
    };
    entry.updateLabel(); row.append(stat, word, element('span', '↗', 'degree-arrow'));
    row.lastChild.setAttribute('aria-hidden', 'true');
    row.addEventListener('click', () => focusEdge(pool[entry.current]));
    if (pool.length > 1) rotatingExamples.push(entry);
    $('multiplicity-list').append(row);
  }
}
function summarizeComponents() {
  const summaries = new Map();
  graph.nodes.forEach((node, index) => {
    if (!summaries.has(node.component)) summaries.set(node.component, { words: 0, games: new Set(), edges: 0, clues: 0, leader: index });
    const summary = summaries.get(node.component);
    summary.words++;
    for (const number of node.games) summary.games.add(number);
    const leader = graph.nodes[summary.leader];
    if (node.degree > leader.degree || (node.degree === leader.degree && node.label.localeCompare(leader.label, 'ru') < 0)) summary.leader = index;
  });
  for (const edge of graph.edges) {
    const summary = summaries.get(graph.nodes[edge.a].component);
    summary.edges++;
    summary.clues += edge.clues.length;
  }
  return summaries;
}
function showComponent(component) {
  const summary = componentStats.get(component), leader = graph.nodes[summary.leader];
  $('component-title').textContent = `Компонента №${component + 1}`;
  $('component-dot').style.backgroundColor = componentColor(component);
  const metrics = [[summary.games.size, 'Лесенок'], [summary.words, 'Слов'], [summary.edges, 'Связей'], [summary.clues, 'Подсказок']];
  $('component-metrics').replaceChildren(...metrics.map(([value, label]) => {
    const item = element('div'); item.append(element('dt', label), element('dd', value.toLocaleString('ru'))); return item;
  }));
  $('component-scope').textContent = `Во всём архиве · ${(summary.words / graph.nodes.length * 100).toLocaleString('ru', { maximumFractionDigits: 1 })}% всех слов`;
  const button = element('button', leader.label);
  button.type = 'button'; button.addEventListener('click', () => {
    selectWord(summary.leader, true);
  });
  $('component-leader').replaceChildren(document.createTextNode('Больше всего связей: '), button, document.createTextNode(` · ${leader.degree}`));
}
function requestDraw() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }
function screen(node) { return { x: (node.x - camera.x) * camera.scale + width / 2, y: (node.y - camera.y) * camera.scale + height / 2 }; }
function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const near = new Set([selected, ...adjacency[selected].map((i) => { const e = graph.edges[i]; return e.a === selected ? e.b : e.a; })]);
  for (const e of visibleEdges) {
    const a = screen(graph.nodes[e.a]), b = screen(graph.nodes[e.b]), active = e.a === selected || e.b === selected;
    const multiplicity = e.clues.length, multiple = multiplicity > 1;
    ctx.strokeStyle = multiple ? (active ? '#ffd19b' : '#ffb56bc9') : active ? '#d8ff43b0' : '#88977b38';
    ctx.lineWidth = multiple ? 2.6 + (multiplicity - 2) * .8 + (e === selectedEdge ? 1 : 0) : active ? 1.8 : .8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    if (multiple) {
      const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
      if (x < -25 || x > width + 25 || y < -15 || y > height + 15) continue;
      const text = `×${multiplicity}`;
      ctx.font = '600 10px Manrope, sans-serif';
      const w = ctx.measureText(text).width + 12;
      ctx.fillStyle = '#302419'; ctx.strokeStyle = '#ffb56b'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - 9, w, 18, 4); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd19b'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y);
    }
  }
  const occupied = [];
  const ordered = [...visibleNodes].sort((a, b) => Number(near.has(a)) - Number(near.has(b)) || graph.nodes[a].degree - graph.nodes[b].degree);
  const labels = [];
  for (const i of ordered) {
    const n = graph.nodes[i], p = screen(n), active = i === selected || (selectedEdge && (i === selectedEdge.a || i === selectedEdge.b)), neighbor = near.has(i);
    if (p.x < -100 || p.x > width + 100 || p.y < -40 || p.y > height + 40) continue;
    const tier = prominenceTier(n.degree), hub = tier > 0;
    const radius = (hub ? 3.4 + tier * 1.65 : 2.8) + (active ? 2 : 0);
    if (hub || active) {
      ctx.shadowColor = active ? '#d8ff43' : componentColor(n.component, .65);
      ctx.shadowBlur = active ? 16 : tier * 2;
    }
    ctx.fillStyle = componentColor(n.component, active || neighbor ? 1 : hub ? Math.min(1, .55 + tier * .12) : .4);
    ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    if (hub || active) {
      ctx.strokeStyle = active ? '#d8ff43' : componentColor(n.component, Math.min(.85, .25 + tier * .13));
      ctx.lineWidth = active ? 2.5 : .6 + tier * .45;
      ctx.beginPath(); ctx.arc(p.x, p.y, radius + 2 + tier * .4, 0, Math.PI * 2); ctx.stroke();
    }
    if (active || neighbor || camera.scale > .8 || hub) labels.push({ n, p, active, neighbor, radius, tier });
  }
  labels.sort((a, b) => Number(b.active) - Number(a.active) || Number(b.neighbor) - Number(a.neighbor) || b.n.degree - a.n.degree);
  for (const { n, p, active, neighbor, radius, tier } of labels) {
    ctx.font = `${active ? 700 : tier >= 3 ? 600 : 500} ${active ? 15 : 11 + Math.min(3, tier) * .5}px Manrope, sans-serif`;
    const w = ctx.measureText(n.label).width + 10, x = p.x - w / 2, y = p.y + radius + 6;
    const box = { x, y, w, h: 20 };
    if (!active && occupied.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + 20 > r.y)) continue;
    occupied.push(box); ctx.fillStyle = active ? '#d8ff43' : '#141a12ed';
    ctx.beginPath(); ctx.roundRect(x, y, w, 20, 4); ctx.fill();
    ctx.fillStyle = active ? '#11130f' : neighbor ? '#eef4df' : '#bcc9ad'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n.label, p.x, y + 10);
  }
}
function fit() {
  if (!visibleNodes.length || width < 130 || height < 110) return;
  const points = visibleNodes.map((i) => graph.nodes[i]);
  const minX = Math.min(...points.map((n) => n.x)), maxX = Math.max(...points.map((n) => n.x));
  const minY = Math.min(...points.map((n) => n.y)), maxY = Math.max(...points.map((n) => n.y));
  camera = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, scale: Math.min(2, (width - 120) / Math.max(100, maxX - minX), (height - 100) / Math.max(100, maxY - minY)) };
  requestDraw();
}
function focusWord(index) {
  const node = graph.nodes[index];
  camera.x = node.x; camera.y = node.y;
  camera.scale = Math.max(camera.scale, .9);
  requestDraw();
}
function focusEdge(index) {
  const edge = graph.edges[index], a = graph.nodes[edge.a], b = graph.nodes[edge.b];
  selectWord(edge.a);
  selectedEdge = edge;
  camera = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, scale: Math.min(2, (width - 140) / Math.max(100, Math.abs(a.x - b.x)), (height - 140) / Math.max(100, Math.abs(a.y - b.y))) };
  $('status').textContent = `${a.label} ↔ ${b.label} · кратность ${edge.clues.length}`;
  $('status').hidden = false;
  requestDraw();
}
function selectWord(index, focus = false) {
  selected = index; selectedEdge = null; const node = graph.nodes[index];
  $('selected-word').textContent = node.label;
  $('word-meta').textContent = `${node.degree} соседей · в ${node.games.length} лесенках`;
  showComponent(node.component);
  const list = $('neighbors'); list.replaceChildren();
  const edges = adjacency[index].map((i) => graph.edges[i]);
  edges.sort((a, b) => graph.nodes[a.a === index ? a.b : a.a].label.localeCompare(graph.nodes[b.a === index ? b.b : b.a].label, 'ru'));
  for (const edge of edges) {
    const other = edge.a === index ? edge.b : edge.a;
    const card = element('div', undefined, 'neighbor'), button = element('button', `↔ ${graph.nodes[other].label}`);
    button.type = 'button'; button.addEventListener('click', () => selectWord(other, true)); card.append(button);
    if (edge.clues.length > 1) card.append(element('span', `×${edge.clues.length}`, 'edge-badge'));
    for (const clue of edge.clues) card.append(element('p', clue.text), sourceLink(clue.game));
    list.append(card);
  }
  if (!edges.length) list.append(element('p', 'У слова нет сохранённых переходов.', 'muted'));
  const url = new URL(location.href); url.searchParams.set('word', node.id); history.replaceState(null, '', url);
  $('status').hidden = true;
  if (focus) focusWord(index); else requestDraw();
}
function search() {
  const query = normalize($('search').value);
  const exact = graph.nodes.findIndex((n) => n.id === query);
  if (exact < 0) { $('status').hidden = false; $('status').textContent = `Слово «${query}» не найдено в архиве.`; return; }
  selectWord(exact, true);
}
function zoom(factor, x = width / 2, y = height / 2) {
  const wx = camera.x + (x - width / 2) / camera.scale, wy = camera.y + (y - height / 2) / camera.scale;
  camera.scale = Math.max(.025, Math.min(5, camera.scale * factor));
  camera.x = wx - (x - width / 2) / camera.scale; camera.y = wy - (y - height / 2) / camera.scale; requestDraw();
}
async function init() {
  try {
    const response = await fetch('./data/graph.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}: graph`);
    graph = await response.json();
    adjacency = graph.nodes.map(() => []);
    graph.edges.forEach((edge, i) => { adjacency[edge.a].push(i); if (edge.a !== edge.b) adjacency[edge.b].push(i); });
    componentStats = summarizeComponents();
    buildDegreeStatistics();
    buildMultiplicityStatistics();
    visibleNodes = graph.nodes.map((_, index) => index); visibleEdges = [...graph.edges].sort((a, b) => a.clues.length - b.clues.length);
    $('visible-count').textContent = `${visibleNodes.length} слов · ${visibleEdges.length} связей`;
    const stats = [[graph.gameCount, 'лесенок'], [graph.nodes.length, 'слов'], [graph.edges.length, 'связей'], [graph.clueCount, 'подсказок']];
    $('stats').replaceChildren(...stats.map(([n, text]) => { const s = element('span'); s.append(element('strong', n.toLocaleString('ru')), document.createTextNode(text)); return s; }));
    const numbers = [...new Set(graph.edges.flatMap((edge) => edge.clues.map((clue) => clue.game)))].sort((a, b) => a - b);
    const date = new Date(graph.collectedAt).toLocaleDateString('ru', { timeZone: 'Europe/Moscow' });
    $('coverage').textContent = `Снимок ${date} · №${numbers[0]}–${numbers.at(-1)} · ${graph.componentCount} компонент связности`;
    $('word-options').replaceChildren(...graph.nodes.map((n) => { const o = element('option'); o.value = n.label; return o; }));
    const initial = normalize(new URLSearchParams(location.search).get('word') || '');
    selected = initial ? graph.nodes.findIndex((n) => n.id === initial) : -1;
    if (selected < 0) selected = graph.nodes.reduce((best, n, i) => n.degree > graph.nodes[best].degree ? i : best, 0);
    new ResizeObserver(() => { const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height; canvas.width = Math.round(width * (devicePixelRatio || 1)); canvas.height = Math.round(height * (devicePixelRatio || 1)); fit(); if (initial) focusWord(selected); }).observe(canvas);
    selectWord(selected);
    $('search-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
    $('fit').addEventListener('click', fit); $('zoom-in').addEventListener('click', () => zoom(1.3)); $('zoom-out').addEventListener('click', () => zoom(1 / 1.3));
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); const rect = canvas.getBoundingClientRect(); zoom(Math.exp(-e.deltaY * .001), e.clientX - rect.left, e.clientY - rect.top); }, { passive: false });
    canvas.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, cameraX: camera.x, cameraY: camera.y, moved: false }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 4) drag.moved = true; camera.x = drag.cameraX - dx / camera.scale; camera.y = drag.cameraY - dy / camera.scale; requestDraw(); });
    canvas.addEventListener('pointerup', (e) => {
      if (drag && !drag.moved) {
        const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
        let nearest = -1, distance = 24;
        for (const i of visibleNodes) { const p = screen(graph.nodes[i]), d = Math.hypot(x - p.x, y - p.y); if (d < distance) { nearest = i; distance = d; } }
        if (nearest >= 0) selectWord(nearest);
      }
      drag = null;
    });
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('keydown', (e) => {
      const shifts = { ArrowLeft: [-70, 0], ArrowRight: [70, 0], ArrowUp: [0, -70], ArrowDown: [0, 70] };
      if (shifts[e.key]) { e.preventDefault(); camera.x += shifts[e.key][0] / camera.scale; camera.y += shifts[e.key][1] / camera.scale; requestDraw(); }
      if (e.key === '+' || e.key === '=') zoom(1.3); if (e.key === '-') zoom(1 / 1.3); if (e.key === '0') fit();
    });
    document.fonts.ready.then(requestDraw);
  } catch (error) { $('status').hidden = false; $('status').textContent = `Не удалось загрузить граф: ${error.message}. Обновите страницу.`; console.error(error); }
}
init();
