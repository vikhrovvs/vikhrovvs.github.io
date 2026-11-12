'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('graph'), ctx = canvas.getContext('2d');
const normalize = (s) => s.trim().toLocaleLowerCase('ru').normalize('NFC').replace(/\s+/g, ' ');
let graph, archive, adjacency, selected = 0, mode = 'all', game = null;
let visibleNodes = [], visibleEdges = [], camera = { x: 0, y: 0, scale: 1 }, width = 1, height = 1;
let drag = null, frame = 0;
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
function filteredClues(edge) { return game === null ? edge.clues : edge.clues.filter((c) => c.game === game); }
function requestDraw() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }
function screen(node) { return { x: (node.x - camera.x) * camera.scale + width / 2, y: (node.y - camera.y) * camera.scale + height / 2 }; }
function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const near = new Set([selected, ...adjacency[selected].map((i) => { const e = graph.edges[i]; return e.a === selected ? e.b : e.a; })]);
  for (const e of visibleEdges) {
    const a = screen(graph.nodes[e.a]), b = screen(graph.nodes[e.b]), active = e.a === selected || e.b === selected;
    ctx.strokeStyle = active ? '#d8ff43b0' : '#88977b38'; ctx.lineWidth = active ? 1.8 : .8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  const occupied = [];
  const ordered = [...visibleNodes].sort((a, b) => Number(near.has(a)) - Number(near.has(b)) || graph.nodes[a].degree - graph.nodes[b].degree);
  const labels = [];
  for (const i of ordered) {
    const n = graph.nodes[i], p = screen(n), active = i === selected, neighbor = near.has(i);
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
function updateView(refit = true) {
  const eligible = graph.edges.filter((e) => filteredClues(e).length);
  let included = new Set(eligible.flatMap((e) => [e.a, e.b]));
  if (mode === 'near') {
    const local = new Set([selected]); let frontier = [selected];
    for (let depth = 0; depth < 2; depth++) {
      const next = [];
      for (const i of frontier) for (const ei of adjacency[i]) {
        const edge = graph.edges[ei]; if (!filteredClues(edge).length) continue;
        const v = edge.a === i ? edge.b : edge.a;
        if (!local.has(v)) { local.add(v); next.push(v); }
      }
      frontier = next;
    }
    included = new Set([...local].filter((i) => included.has(i)));
  }
  visibleNodes = [...included]; visibleEdges = eligible.filter((e) => included.has(e.a) && included.has(e.b));
  $('visible-count').textContent = `${visibleNodes.length} слов · ${visibleEdges.length} связей`;
  $('status').hidden = visibleNodes.length > 0;
  if (!visibleNodes.length) $('status').textContent = 'В этой лесенке нет связей с выбранным словом. Выберите другое слово или весь граф.';
  for (const [id, active] of [['overview', mode === 'all'], ['neighborhood', mode === 'near']]) { $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', active); }
  if (refit) fit(); else requestDraw();
}
function selectWord(index, refit = false) {
  selected = index; const node = graph.nodes[index];
  $('selected-word').textContent = node.label;
  $('word-meta').textContent = `${node.degree} соседей · в ${node.games.length} лесенках`;
  const list = $('neighbors'); list.replaceChildren();
  const edges = adjacency[index].map((i) => graph.edges[i]).filter((e) => filteredClues(e).length);
  edges.sort((a, b) => graph.nodes[a.a === index ? a.b : a.a].label.localeCompare(graph.nodes[b.a === index ? b.b : b.a].label, 'ru'));
  for (const edge of edges) {
    const other = edge.a === index ? edge.b : edge.a;
    const card = element('div', undefined, 'neighbor'), button = element('button', `↔ ${graph.nodes[other].label}`);
    button.type = 'button'; button.addEventListener('click', () => selectWord(other, mode === 'near')); card.append(button);
    for (const clue of filteredClues(edge)) card.append(element('p', clue.text), sourceLink(clue.game));
    list.append(card);
  }
  if (!edges.length) list.append(element('p', 'У слова нет переходов в выбранной лесенке.', 'muted'));
  const url = new URL(location.href); url.searchParams.set('word', node.id); history.replaceState(null, '', url);
  updateView(refit || mode === 'near');
}
function search() {
  const query = normalize($('search').value);
  const exact = graph.nodes.findIndex((n) => n.id === query);
  if (exact < 0) { $('status').hidden = false; $('status').textContent = `Слово «${query}» не найдено в архиве.`; return; }
  if (game !== null && !graph.nodes[exact].games.includes(game)) { game = null; $('game').value = ''; }
  mode = 'near'; selectWord(exact, true);
}
function zoom(factor, x = width / 2, y = height / 2) {
  const wx = camera.x + (x - width / 2) / camera.scale, wy = camera.y + (y - height / 2) / camera.scale;
  camera.scale = Math.max(.025, Math.min(5, camera.scale * factor));
  camera.x = wx - (x - width / 2) / camera.scale; camera.y = wy - (y - height / 2) / camera.scale; requestDraw();
}
async function init() {
  try {
    [graph, archive] = await Promise.all(['graph', 'archive'].map(async (file) => {
      const response = await fetch(`./data/${file}.json`); if (!response.ok) throw new Error(`HTTP ${response.status}: ${file}`); return response.json();
    }));
    adjacency = graph.nodes.map(() => []);
    graph.edges.forEach((edge, i) => { adjacency[edge.a].push(i); if (edge.a !== edge.b) adjacency[edge.b].push(i); });
    const stats = [[graph.gameCount, 'лесенок'], [graph.nodes.length, 'слов'], [graph.edges.length, 'связей'], [graph.clueCount, 'подсказок']];
    $('stats').replaceChildren(...stats.map(([n, text]) => { const s = element('span'); s.append(element('strong', n.toLocaleString('ru')), document.createTextNode(text)); return s; }));
    const numbers = archive.games.map((g) => g.number).sort((a, b) => a - b);
    const date = new Date(graph.collectedAt).toLocaleDateString('ru', { timeZone: 'Europe/Moscow' });
    $('coverage').textContent = `Снимок ${date} · №${numbers[0]}–${numbers.at(-1)} · ${graph.componentCount} компонент связности`;
    $('word-options').replaceChildren(...graph.nodes.map((n) => { const o = element('option'); o.value = n.label; return o; }));
    for (const g of [...archive.games].reverse()) { const option = element('option', `№${g.number} · ${g.calendarLabel}`); option.value = g.number; $('game').append(option); }
    const initial = normalize(new URLSearchParams(location.search).get('word') || '');
    selected = initial ? graph.nodes.findIndex((n) => n.id === initial) : -1;
    if (selected < 0) selected = graph.nodes.reduce((best, n, i) => n.degree > graph.nodes[best].degree ? i : best, 0);
    else mode = 'near';
    new ResizeObserver(() => { const rect = canvas.getBoundingClientRect(); width = rect.width; height = rect.height; canvas.width = Math.round(width * (devicePixelRatio || 1)); canvas.height = Math.round(height * (devicePixelRatio || 1)); fit(); }).observe(canvas);
    selectWord(selected);
    $('search-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
    $('overview').addEventListener('click', () => { mode = 'all'; updateView(); });
    $('neighborhood').addEventListener('click', () => { mode = 'near'; updateView(); });
    $('game').addEventListener('change', () => { game = $('game').value ? Number($('game').value) : null; if (game !== null && !graph.nodes[selected].games.includes(game)) selected = graph.nodes.findIndex((n) => n.games.includes(game)); mode = 'all'; selectWord(selected, true); });
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
