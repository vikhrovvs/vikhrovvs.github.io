const canvas = document.querySelector('#graph-canvas');
const context = canvas.getContext('2d');
const loading = document.querySelector('#loading');
const searchForm = document.querySelector('#search-form');
const wordInput = document.querySelector('#word-input');
const suggestions = document.querySelector('#suggestions');
const detailsContent = document.querySelector('#details-content');
const visibleCount = document.querySelector('#visible-count');
const searchStatus = document.querySelector('#search-status');
const tooltip = document.querySelector('#tooltip');
const toast = document.querySelector('#toast');
const anagramLeadersList = document.querySelector('#anagram-leaders-list');

const state = {
  data: null,
  nodes: [],
  edges: [],
  adjacency: [],
  wordIndex: new Map(),
  signatureIndex: new Map(),
  visibleNodes: [],
  visibleEdges: [],
  selected: -1,
  hovered: -1,
  camera: { x: 0, y: 0, scale: 1, fitScale: 1 },
  pointer: null,
  dragDistance: 0,
  animation: 0,
  anagramLeaders: [],
  anagramLeaderCursor: 0,
  anagramLeaderTimer: 0,
};

const COLORS = {
  node: '#ece9df',
  nodeDim: '#6e7668',
  selected: '#d8ff43',
  added: '#ffb56b',
  ink: '#11130f',
  add: '#ffb56b',
  replace: '#93b8ff',
};

const NEIGHBORHOOD_LIMITS = {
  firstRing: 24,
  total: 72,
};
const MAX_ZOOM = 4;

const normalizeWord = (value) => value.trim().toLocaleLowerCase('ru-RU').normalize('NFC');
const signature = (word) => Array.from(word).sort((a, b) => a.localeCompare(b, 'ru')).join('');
const formatIpm = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: value < 10 ? 2 : 0 }).format(value);
const escapeHtml = (value) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function multisetDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return Infinity;
  let first = 0;
  let second = 0;
  let difference = 0;
  while (first < a.length || second < b.length) {
    if (first >= a.length) { difference += b.length - second; break; }
    if (second >= b.length) { difference += a.length - first; break; }
    if (a[first] === b[second]) { first += 1; second += 1; continue; }
    if (a[first].localeCompare(b[second], 'ru') < 0) { difference += 1; first += 1; }
    else { difference += 1; second += 1; }
    if (difference > 2) return difference;
  }
  return difference;
}

function edgeType(a, b) {
  const distance = multisetDistance(a, b);
  if (a.length === b.length && distance === 2) return 'replace';
  if (Math.abs(a.length - b.length) === 1 && distance === 1) return 'add';
  return null;
}

function nodeRadius(node) {
  const frequencyRadius = Math.min(48, 15 + Math.log10(node.frequency + 1) * 7.4);
  const labelRadius = node.words.length > 1 ? 22 + (node.words.length - 2) * 4 : 18;
  return Math.max(labelRadius, frequencyRadius);
}

function buildIndexes() {
  state.adjacency = Array.from({ length: state.nodes.length }, () => []);
  state.wordIndex.clear();
  state.signatureIndex.clear();

  state.nodes.forEach((node, index) => {
    state.signatureIndex.set(node.id, index);
    node.words.forEach(([word]) => state.wordIndex.set(word, index));
  });
  state.edges.forEach(([a, b, type]) => {
    state.adjacency[a].push([b, type]);
    state.adjacency[b].push([a, type]);
  });
}

function wordForm(value, forms) {
  const modulo100 = value % 100;
  const modulo10 = value % 10;
  if (modulo100 >= 11 && modulo100 <= 14) return forms[2];
  if (modulo10 === 1) return forms[0];
  if (modulo10 >= 2 && modulo10 <= 4) return forms[1];
  return forms[2];
}

function randomAlternative(items, current) {
  const alternatives = items.filter((item) => item.nodeIndex !== current?.nodeIndex || item.word !== current?.word);
  const pool = alternatives.length ? alternatives : items;
  return pool[Math.floor(Math.random() * pool.length)];
}

function updateAnagramLeader(entry) {
  entry.current = randomAlternative(entry.samples, entry.current);
  const button = anagramLeadersList.querySelector(`[data-size="${entry.size}"]`);
  if (!button) return;
  button.dataset.node = entry.current.nodeIndex;
  button.dataset.word = entry.current.word;
  button.setAttribute('aria-label', `${entry.size} ${wordForm(entry.size, ['слово', 'слова', 'слов'])} в узле, ${entry.nodeCount} ${wordForm(entry.nodeCount, ['такой узел', 'таких узла', 'таких узлов'])}: ${entry.current.word}`);
  const word = button.querySelector('.leader-word');
  word.classList.remove('is-changing');
  void word.offsetWidth;
  word.textContent = entry.current.word;
  word.classList.add('is-changing');
}

function buildAnagramLeaders() {
  const bySize = new Map();
  state.nodes.forEach((node, nodeIndex) => {
    if (node.words.length < 2 || node.added) return;
    const size = node.words.length;
    if (!bySize.has(size)) bySize.set(size, []);
    node.words.forEach(([word]) => bySize.get(size).push({ nodeIndex, word }));
  });

  state.anagramLeaders = [...bySize]
    .sort(([first], [second]) => second - first)
    .map(([size, samples]) => {
      const nodeCount = new Set(samples.map((sample) => sample.nodeIndex)).size;
      return { size, nodeCount, samples, current: randomAlternative(samples) };
    });

  anagramLeadersList.innerHTML = state.anagramLeaders.map((entry) => `
    <button class="leader-item" type="button" data-size="${entry.size}" data-node="${entry.current.nodeIndex}" data-word="${escapeHtml(entry.current.word)}" aria-label="${entry.size} ${wordForm(entry.size, ['слово', 'слова', 'слов'])} в узле, ${entry.nodeCount} ${wordForm(entry.nodeCount, ['такой узел', 'таких узла', 'таких узлов'])}: ${escapeHtml(entry.current.word)}">
      <span class="leader-stat"><strong>${entry.size}</strong> ${wordForm(entry.size, ['слово', 'слова', 'слов'])} в узле&nbsp; | &nbsp;<strong>${entry.nodeCount}</strong> ${wordForm(entry.nodeCount, ['такой узел', 'таких узла', 'таких узлов'])}</span>
      <span class="leader-word">${escapeHtml(entry.current.word)}</span>
      <span class="leader-arrow" aria-hidden="true">↗</span>
    </button>`).join('');

  clearInterval(state.anagramLeaderTimer);
  state.anagramLeaderTimer = window.setInterval(() => {
    if (!state.anagramLeaders.length || document.hidden || anagramLeadersList.matches(':hover') || anagramLeadersList.contains(document.activeElement)) return;
    const entry = state.anagramLeaders[state.anagramLeaderCursor % state.anagramLeaders.length];
    state.anagramLeaderCursor += 1;
    updateAnagramLeader(entry);
  }, 1800);
}

function createNeighborhood(centerIndex) {
  const included = new Set([centerIndex]);
  const levels = new Map([[centerIndex, 0]]);
  const first = [...state.adjacency[centerIndex]]
    .sort((a, b) => state.nodes[b[0]].frequency - state.nodes[a[0]].frequency)
    .slice(0, NEIGHBORHOOD_LIMITS.firstRing);

  first.forEach(([index]) => { included.add(index); levels.set(index, 1); });
  const secondCandidates = [];
  first.forEach(([index]) => {
    state.adjacency[index].forEach(([neighbor]) => {
      if (!included.has(neighbor)) secondCandidates.push(neighbor);
    });
  });
  [...new Set(secondCandidates)]
    .sort((a, b) => state.nodes[b].frequency - state.nodes[a].frequency)
    .slice(0, Math.max(0, NEIGHBORHOOD_LIMITS.total - included.size))
    .forEach((index) => { included.add(index); levels.set(index, 2); });

  const visible = [...included];
  const visibleLookup = new Map(visible.map((index, localIndex) => [index, localIndex]));
  const angleOffset = ((centerIndex * 1.6180339887) % 1) * Math.PI * 2;
  state.visibleNodes = visible.map((index, order) => {
    const level = levels.get(index);
    const levelNodes = visible.filter((candidate) => levels.get(candidate) === level);
    const levelOrder = levelNodes.indexOf(index);
    const radius = level === 0 ? 0 : level === 1 ? 245 : 470;
    const angle = angleOffset + (levelOrder / Math.max(1, levelNodes.length)) * Math.PI * 2 + level * .22;
    return {
      index,
      level,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      targetX: Math.cos(angle) * radius,
      targetY: Math.sin(angle) * radius,
      radius: nodeRadius(state.nodes[index]),
    };
  });
  state.visibleEdges = state.edges
    .filter(([a, b]) => visibleLookup.has(a) && visibleLookup.has(b))
    .map(([a, b, type]) => ({ a: visibleLookup.get(a), b: visibleLookup.get(b), type }));

  settleLayout();
  fitView();
  visibleCount.textContent = `${state.visibleNodes.length} вершин рядом`;
}

function settleLayout() {
  const nodes = state.visibleNodes;
  for (let step = 0; step < 130; step += 1) {
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      node.x += (node.targetX - node.x) * .018;
      node.y += (node.targetY - node.y) * .018;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const other = nodes[j];
        let dx = other.x - node.x;
        let dy = other.y - node.y;
        let distance = Math.hypot(dx, dy) || 1;
        const wanted = node.radius + other.radius + 34;
        if (distance < wanted) {
          const push = (wanted - distance) * .12;
          dx /= distance; dy /= distance;
          node.x -= dx * push; node.y -= dy * push;
          other.x += dx * push; other.y += dy * push;
        }
      }
    }
    state.visibleEdges.forEach((edge) => {
      const a = nodes[edge.a]; const b = nodes[edge.b];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 1;
      const wanted = edge.type === 'add' ? 160 : 185;
      const pull = (distance - wanted) * .006;
      a.x += dx / distance * pull; a.y += dy / distance * pull;
      b.x -= dx / distance * pull; b.y -= dy / distance * pull;
    });
    if (nodes[0]) { nodes[0].x *= .82; nodes[0].y *= .82; }
  }
  separateOverlappingNodes(nodes);
}

function separateOverlappingNodes(nodes) {
  for (let step = 0; step < 80; step += 1) {
    let largestOverlap = 0;
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const node = nodes[i];
        const other = nodes[j];
        let dx = other.x - node.x;
        let dy = other.y - node.y;
        let distance = Math.hypot(dx, dy);
        if (distance < .001) {
          const angle = (i * 2.399 + j * 1.618) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        }
        const overlap = node.radius + other.radius + 12 - distance;
        if (overlap <= 0) continue;
        largestOverlap = Math.max(largestOverlap, overlap);
        const directionX = dx / distance;
        const directionY = dy / distance;
        if (node.level === 0) {
          other.x += directionX * overlap;
          other.y += directionY * overlap;
        } else if (other.level === 0) {
          node.x -= directionX * overlap;
          node.y -= directionY * overlap;
        } else {
          const push = overlap * .51;
          node.x -= directionX * push;
          node.y -= directionY * push;
          other.x += directionX * push;
          other.y += directionY * push;
        }
      }
    }
    if (largestOverlap < .05) break;
  }
}

function resizeCanvas() {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function screenPosition(node) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: bounds.width / 2 + state.camera.x + node.x * state.camera.scale,
    y: bounds.height / 2 + state.camera.y + node.y * state.camera.scale,
  };
}

function draw() {
  cancelAnimationFrame(state.animation);
  const bounds = canvas.getBoundingClientRect();
  context.clearRect(0, 0, bounds.width, bounds.height);
  context.save();

  state.visibleEdges.forEach((edge) => {
    const first = screenPosition(state.visibleNodes[edge.a]);
    const second = screenPosition(state.visibleNodes[edge.b]);
    context.beginPath();
    context.moveTo(first.x, first.y);
    context.lineTo(second.x, second.y);
    context.strokeStyle = edge.type === 'add' ? COLORS.add : COLORS.replace;
    context.globalAlpha = edge.type === 'add' ? .42 : .25;
    context.lineWidth = edge.type === 'add' ? 1.15 : .85;
    context.setLineDash(edge.type === 'add' ? [5, 6] : []);
    context.stroke();
  });
  context.setLineDash([]);
  context.globalAlpha = 1;

  state.visibleNodes
    .slice()
    .sort((a, b) => b.level - a.level)
    .forEach((layoutNode) => drawNode(layoutNode));
  context.restore();
}

function drawNode(layoutNode) {
  const node = state.nodes[layoutNode.index];
  const point = screenPosition(layoutNode);
  const radius = layoutNode.radius * state.camera.scale;
  const selected = layoutNode.index === state.selected;
  const hovered = layoutNode.index === state.hovered;
  const fill = node.added ? COLORS.added : selected ? COLORS.selected : COLORS.node;
  const dim = layoutNode.level === 2 && !hovered;

  if (selected) {
    context.beginPath();
    context.arc(point.x, point.y, radius + 9, 0, Math.PI * 2);
    context.strokeStyle = COLORS.selected;
    context.globalAlpha = .24;
    context.lineWidth = 1;
    context.stroke();
  }

  context.beginPath();
  context.arc(point.x, point.y, radius, 0, Math.PI * 2);
  context.fillStyle = dim ? COLORS.nodeDim : fill;
  context.globalAlpha = dim ? .72 : 1;
  context.fill();
  context.globalAlpha = 1;
  if (hovered && !selected) {
    context.strokeStyle = COLORS.selected;
    context.lineWidth = 2;
    context.stroke();
  }

  drawNodeWords(node, point, radius);
}

function fitFontSize(word, maximum, maximumWidth, weight, family) {
  context.font = `${weight} ${maximum}px ${family}`;
  const measuredWidth = context.measureText(word).width || 1;
  return Math.min(maximum, maximum * maximumWidth / measuredWidth);
}

function drawNodeWords(node, point, radius) {
  const words = node.words.slice(0, 4).map(([word]) => word);
  const secondaryCount = words.length - 1;
  const zoomRatio = state.camera.scale / state.camera.fitScale;
  const fittedRadius = radius / zoomRatio;
  const verticalBudget = fittedRadius * 1.42;
  const primaryMaximum = Math.min(17, verticalBudget / (1.08 + secondaryCount * .76));
  const maximumWidth = fittedRadius * 1.45;
  const fittedPrimarySize = Math.max(3.5, fitFontSize(words[0], primaryMaximum, maximumWidth, 600, 'Onest, sans-serif'));
  const fittedSecondaryMaximum = fittedPrimarySize * .68;
  const fittedSecondarySizes = words.slice(1).map((word) =>
    Math.max(3, fitFontSize(word, fittedSecondaryMaximum, maximumWidth, 500, 'Manrope, sans-serif')),
  );
  const primarySize = fittedPrimarySize * zoomRatio;
  const secondarySizes = fittedSecondarySizes.map((size) => size * zoomRatio);
  const primaryLineHeight = primarySize * 1.08;
  const secondaryLineHeights = secondarySizes.map((size) => size * 1.12);
  const blockHeight = primaryLineHeight + secondaryLineHeights.reduce((total, height) => total + height, 0);
  let y = point.y - blockHeight / 2 + primaryLineHeight / 2;

  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = COLORS.ink;
  context.globalAlpha = 1;
  context.font = `600 ${primarySize}px Onest, sans-serif`;
  context.fillText(words[0], point.x, y);

  words.slice(1).forEach((word, index) => {
    const lineHeight = secondaryLineHeights[index];
    y += primaryLineHeight / 2 + lineHeight / 2;
    context.globalAlpha = .68;
    context.font = `500 ${secondarySizes[index]}px Manrope, sans-serif`;
    context.fillText(word, point.x, y);
    y += lineHeight / 2 - primaryLineHeight / 2;
  });
  context.globalAlpha = 1;
}

function fitView() {
  if (!state.visibleNodes.length) return;
  const bounds = canvas.getBoundingClientRect();
  const xs = state.visibleNodes.map((node) => node.x);
  const ys = state.visibleNodes.map((node) => node.y);
  const width = Math.max(300, Math.max(...xs) - Math.min(...xs) + 150);
  const height = Math.max(260, Math.max(...ys) - Math.min(...ys) + 150);
  state.camera.scale = Math.max(.34, Math.min(1, Math.min((bounds.width - 70) / width, (bounds.height - 110) / height)));
  state.camera.fitScale = state.camera.scale;
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  state.camera.x = -centerX * state.camera.scale;
  state.camera.y = -centerY * state.camera.scale;
  draw();
}

function zoomAt(factor, x, y) {
  const bounds = canvas.getBoundingClientRect();
  const oldScale = state.camera.scale;
  const newScale = Math.max(.25, Math.min(MAX_ZOOM, oldScale * factor));
  const worldX = (x - bounds.width / 2 - state.camera.x) / oldScale;
  const worldY = (y - bounds.height / 2 - state.camera.y) / oldScale;
  state.camera.scale = newScale;
  state.camera.x = x - bounds.width / 2 - worldX * newScale;
  state.camera.y = y - bounds.height / 2 - worldY * newScale;
  draw();
}

function nodeAt(clientX, clientY) {
  const bounds = canvas.getBoundingClientRect();
  const x = clientX - bounds.left;
  const y = clientY - bounds.top;
  return state.visibleNodes
    .slice()
    .sort((a, b) => a.level - b.level)
    .find((node) => {
      const point = screenPosition(node);
      return Math.hypot(point.x - x, point.y - y) <= Math.max(15, node.radius * state.camera.scale + 4);
    });
}

function showDetails(index) {
  const node = state.nodes[index];
  const neighbors = [...state.adjacency[index]]
    .sort((a, b) => state.nodes[b[0]].frequency - state.nodes[a[0]].frequency)
    .slice(0, 12);
  detailsContent.innerHTML = `
    <h1>${escapeHtml(node.label)}</h1>
    <p class="signature" title="Отсортированный набор букв">${escapeHtml(node.id.split('').join(' · '))}</p>
    <div class="frequency-card">
      <span>Суммарная частота</span>
      <small>упоминаний на миллион</small>
      <strong>${formatIpm(node.frequency)}</strong>
    </div>
    ${node.added ? '<span class="new-badge">Временная вершина</span>' : ''}
    <section class="detail-section">
      <h2>Слова в вершине · ${node.words.length}</h2>
      <ol class="word-list">
        ${node.words.map(([word, ipm]) => `<li><span>${escapeHtml(word)}</span><small>${formatIpm(ipm)} ipm</small></li>`).join('')}
      </ol>
    </section>
    <section class="detail-section neighbors">
      <h2>Ближайшие вершины · ${state.adjacency[index].length}</h2>
      <div class="neighbor-list">
        ${neighbors.map(([neighbor, type]) => `<button type="button" data-node="${neighbor}"><span>${escapeHtml(state.nodes[neighbor].label)}</span><span class="edge-badge">${type === 'add' ? '± буква' : 'замена'}</span><small>${formatIpm(state.nodes[neighbor].frequency)}</small></button>`).join('') || '<span class="details-placeholder">Связей пока нет</span>'}
      </div>
    </section>`;
  detailsContent.querySelectorAll('[data-node]').forEach((button) => {
    button.addEventListener('click', () => selectNode(Number(button.dataset.node), true));
  });
}

function selectNode(index, rebuild = true) {
  state.selected = index;
  state.hovered = -1;
  if (rebuild) createNeighborhood(index);
  showDetails(index);
  const node = state.nodes[index];
  wordInput.value = node.label;
  searchStatus.textContent = node.added ? 'Временная вершина' : `Есть в словаре · ${node.words.length} ${node.words.length === 1 ? 'слово' : 'слова'}`;
  draw();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function addWord(word) {
  const id = signature(word);
  const existing = state.signatureIndex.get(id);
  if (existing !== undefined) {
    const node = state.nodes[existing];
    node.words.push([word, 0]);
    state.wordIndex.set(word, existing);
    selectNode(existing, true);
    showToast(`«${word}» добавлено в существующую вершину-анаграмму`);
    return existing;
  }

  const index = state.nodes.length;
  const node = { id, label: word, frequency: .05, words: [[word, 0]], added: true };
  state.nodes.push(node);
  state.adjacency.push([]);
  state.wordIndex.set(word, index);
  state.signatureIndex.set(id, index);

  for (let other = 0; other < index; other += 1) {
    const type = edgeType(id, state.nodes[other].id);
    if (!type) continue;
    state.edges.push([other, index, type]);
    state.adjacency[other].push([index, type]);
    state.adjacency[index].push([other, type]);
  }
  selectNode(index, true);
  showToast(state.adjacency[index].length ? `Новая вершина связана с ${state.adjacency[index].length} соседями` : 'Новая вершина добавлена без связей');
  return index;
}

function submitWord(rawWord) {
  const word = normalizeWord(rawWord);
  suggestions.hidden = true;
  if (!word || !/^[а-яё]+$/u.test(word)) {
    searchStatus.textContent = 'Нужны только русские буквы';
    showToast('Введите слово русскими буквами без пробелов и дефисов');
    wordInput.focus();
    return null;
  }
  const existing = state.wordIndex.get(word);
  if (existing !== undefined) {
    selectNode(existing, true);
    return existing;
  }
  return addWord(word);
}

function updateSuggestions() {
  if (!state.data) return;
  const query = normalizeWord(wordInput.value);
  if (query.length < 2) { suggestions.hidden = true; return; }
  const matches = [];
  for (const [word, index] of state.wordIndex) {
    if (word.startsWith(query)) matches.push([word, index]);
    if (matches.length === 6) break;
  }
  if (!matches.length || (matches.length === 1 && matches[0][0] === query)) { suggestions.hidden = true; return; }
  suggestions.innerHTML = matches.map(([word, index]) => `<button type="button" role="option" data-word="${escapeHtml(word)}"><span>${escapeHtml(word)}</span><small>${state.nodes[index].words.length > 1 ? `${state.nodes[index].words.length} анаграммы` : `${formatIpm(state.nodes[index].frequency)} ipm`}</small></button>`).join('');
  suggestions.hidden = false;
  suggestions.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => submitWord(button.dataset.word)));
}

function registerWebMcp() {
  if (!document.modelContext?.registerTool) return;
  const lifecycle = new AbortController();
  Promise.resolve(document.modelContext.registerTool({
    name: 'find_or_add_russian_word',
    title: 'Найти слово в Словографе',
    description: 'Находит русское слово в словаре анаграмм или временно добавляет его в граф, затем открывает локальное окружение вершины.',
    inputSchema: { type: 'object', properties: { word: { type: 'string', minLength: 1, maxLength: 24 } }, required: ['word'], additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      const word = normalizeWord(input?.word ?? '');
      if (!/^[а-яё]+$/u.test(word)) throw new Error('Слово должно состоять из русских букв.');
      const existed = state.wordIndex.has(word);
      const index = submitWord(word);
      if (index === null) throw new Error('Не удалось обработать слово.');
      return { word, existed, vertex: state.nodes[index].label, anagrams: state.nodes[index].words.map(([item]) => item), neighbors: state.adjacency[index].length };
    },
  }, { signal: lifecycle.signal })).catch(() => undefined);
}

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const bounds = canvas.getBoundingClientRect();
  zoomAt(event.deltaY < 0 ? 1.12 : .89, event.clientX - bounds.left, event.clientY - bounds.top);
}, { passive: false });

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  state.pointer = { x: event.clientX, y: event.clientY };
  state.dragDistance = 0;
});
canvas.addEventListener('pointermove', (event) => {
  if (state.pointer) {
    const dx = event.clientX - state.pointer.x;
    const dy = event.clientY - state.pointer.y;
    state.camera.x += dx; state.camera.y += dy;
    state.dragDistance += Math.abs(dx) + Math.abs(dy);
    state.pointer = { x: event.clientX, y: event.clientY };
    tooltip.hidden = true;
    draw();
    return;
  }
  const found = nodeAt(event.clientX, event.clientY);
  const next = found?.index ?? -1;
  if (next !== state.hovered) { state.hovered = next; draw(); }
  if (found) {
    const node = state.nodes[found.index];
    tooltip.innerHTML = `<strong>${escapeHtml(node.label)}</strong><span>${node.words.length} ${node.words.length === 1 ? 'слово' : 'слова'} · ${formatIpm(node.frequency)} ipm</span>`;
    tooltip.style.left = `${Math.min(window.innerWidth - 230, event.clientX + 14)}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - 58)}px`;
    tooltip.hidden = false;
  } else tooltip.hidden = true;
});
canvas.addEventListener('pointerup', (event) => {
  if (state.dragDistance < 8) {
    const found = nodeAt(event.clientX, event.clientY);
    if (found) selectNode(found.index, found.index !== state.selected);
  }
  state.pointer = null;
});
canvas.addEventListener('pointercancel', () => { state.pointer = null; });
canvas.addEventListener('pointerleave', () => { if (!state.pointer) { state.hovered = -1; tooltip.hidden = true; draw(); } });

searchForm.addEventListener('submit', (event) => { event.preventDefault(); submitWord(wordInput.value); });
anagramLeadersList.addEventListener('click', (event) => {
  const button = event.target.closest('.leader-item');
  if (!button) return;
  selectNode(Number(button.dataset.node), true);
  wordInput.value = button.dataset.word;
});
wordInput.addEventListener('input', updateSuggestions);
wordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { suggestions.hidden = true; wordInput.blur(); }
  if (event.key === 'ArrowDown' && !suggestions.hidden) { event.preventDefault(); suggestions.querySelector('button')?.focus(); }
});
document.addEventListener('click', (event) => { if (!searchForm.contains(event.target)) suggestions.hidden = true; });
document.querySelector('#zoom-in').addEventListener('click', () => zoomAt(1.22, canvas.clientWidth / 2, canvas.clientHeight / 2));
document.querySelector('#zoom-out').addEventListener('click', () => zoomAt(.82, canvas.clientWidth / 2, canvas.clientHeight / 2));
document.querySelector('#fit-view').addEventListener('click', fitView);

const aboutButton = document.querySelector('#about-button');
const aboutPopover = document.querySelector('#about-popover');
function toggleAbout(open) { aboutPopover.hidden = !open; aboutButton.setAttribute('aria-expanded', String(open)); }
aboutButton.addEventListener('click', () => toggleAbout(aboutPopover.hidden));
document.querySelector('#about-close').addEventListener('click', () => toggleAbout(false));

new ResizeObserver(resizeCanvas).observe(canvas);

async function initialize() {
  try {
    const response = await fetch('./data/graph.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.nodes = state.data.nodes;
    state.edges = state.data.edges;
    buildIndexes();
    buildAnagramLeaders();
    const defaultIndex = state.wordIndex.get('кот') ?? 0;
    selectNode(defaultIndex, true);
    loading.classList.add('is-hidden');
    setTimeout(() => { loading.hidden = true; }, 350);
    registerWebMcp();
  } catch (error) {
    loading.innerHTML = `<strong>Не удалось загрузить словарь</strong><small>Откройте сайт через локальный сервер или GitHub Pages.</small>`;
    console.error(error);
  }
}

initialize();
