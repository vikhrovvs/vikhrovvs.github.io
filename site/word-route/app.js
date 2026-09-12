const loading = document.querySelector('#loading');
const routePanel = document.querySelector('#route-panel');
const playfield = document.querySelector('#playfield');
const rulesPanel = document.querySelector('#rules-panel');
const routeList = document.querySelector('#route-list');
const neighborsElement = document.querySelector('#neighbors');
const setupDialog = document.querySelector('#setup-dialog');
const finishDialog = document.querySelector('#finish-dialog');
const toast = document.querySelector('#toast');

const state = {
  nodes: [], adjacency: [], wordIndex: new Map(),
  start: -1, target: -1, route: [], shortestPath: [],
  mode: 'daily', sourceWord: '', targetWord: '', seed: 0, distance: 0,
};

// Daily-диапазон вынесен отдельно, чтобы его можно было менять без правок алгоритма.
const DAILY_DISTANCE_MIN = 4;
const DAILY_DISTANCE_MAX = 8;

const normalizeWord = (value) => value.trim().toLocaleLowerCase('ru-RU').normalize('NFC');
const escapeHtml = (value) => value.replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const dayKey = () => new Date().toISOString().slice(0, 10);
const hashString = (value) => {
  let hash = 2166136261;
  for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
};
const randomFromSeed = (seed) => {
  let value = seed >>> 0;
  return () => { value += 0x6D2B79F5; let next = value; next = Math.imul(next ^ next >>> 15, next | 1); next ^= next + Math.imul(next ^ next >>> 7, next | 61); return ((next ^ next >>> 14) >>> 0) / 4294967296; };
};
const nodeWords = (index) => state.nodes[index].words.map(([word]) => word);
const displayWord = (index, preferred = '') => nodeWords(index).includes(preferred) ? preferred : state.nodes[index].label;

function buildIndexes(edges) {
  state.adjacency = Array.from({ length: state.nodes.length }, () => []);
  state.nodes.forEach((node, index) => node.words.forEach(([word]) => state.wordIndex.set(normalizeWord(word), index)));
  edges.forEach(([first, second, type]) => {
    state.adjacency[first].push([second, type]);
    state.adjacency[second].push([first, type]);
  });
}

function shortestPath(start, target, maxDepth = Infinity) {
  if (start === target) return [start];
  const parent = new Int32Array(state.nodes.length); parent.fill(-2); parent[start] = -1;
  const depth = new Uint16Array(state.nodes.length);
  const queue = new Int32Array(state.nodes.length); let head = 0; let tail = 0; queue[tail++] = start;
  while (head < tail) {
    const current = queue[head++];
    if (depth[current] >= maxDepth) continue;
    for (const [neighbor] of state.adjacency[current]) {
      if (parent[neighbor] !== -2) continue;
      parent[neighbor] = current; depth[neighbor] = depth[current] + 1;
      if (neighbor === target) {
        const path = [target]; let cursor = target;
        while (parent[cursor] !== -1) { cursor = parent[cursor]; path.push(cursor); }
        return path.reverse();
      }
      queue[tail++] = neighbor;
    }
  }
  return null;
}

function nodesAtDistance(start, wantedDistance) {
  const seen = new Int16Array(state.nodes.length); seen.fill(-1); seen[start] = 0;
  const queue = new Int32Array(state.nodes.length); let head = 0; let tail = 0; queue[tail++] = start;
  const matches = [];
  while (head < tail) {
    const current = queue[head++]; const depth = seen[current];
    if (depth === wantedDistance) { matches.push(current); continue; }
    for (const [neighbor] of state.adjacency[current]) {
      if (seen[neighbor] !== -1) continue;
      seen[neighbor] = depth + 1; queue[tail++] = neighbor;
    }
  }
  return matches;
}

function isFriendlyEndpoint(index) {
  const node = state.nodes[index];
  return state.adjacency[index].length >= 2 && state.adjacency[index].length <= 30 && node.label.length >= 3 && node.label.length <= 9 && node.frequency >= 12;
}

function generatePair(distance, seed) {
  const random = randomFromSeed(seed);
  const candidates = state.nodes.map((_, index) => index).filter(isFriendlyEndpoint);
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const start = candidates[Math.floor(random() * candidates.length)];
    const targets = nodesAtDistance(start, distance).filter(isFriendlyEndpoint);
    if (!targets.length) continue;
    const target = targets[Math.floor(random() * targets.length)];
    return { start, target, path: shortestPath(start, target) };
  }
  throw new Error('Не получилось подобрать слова на таком расстоянии. Попробуйте другое число.');
}

function currentIndex() { return state.route[state.route.length - 1]; }
function relationLabel(type) { return type === 'add' ? '± буква' : 'замена'; }

function configureGame(config) {
  Object.assign(state, config);
  state.route = [state.start];
  state.shortestPath = config.path ?? shortestPath(state.start, state.target) ?? [];
  state.distance = Math.max(0, state.shortestPath.length - 1);
  render();
}

function renderRoute() {
  routeList.innerHTML = state.route.map((index, position) => {
    const label = displayWord(index, position === 0 ? state.sourceWord : position === state.route.length - 1 && index === state.target ? state.targetWord : '');
    const count = state.nodes[index].words.length;
    return `<li><button class="route-step ${position === state.route.length - 1 ? 'current' : ''}" data-route-position="${position}" type="button"><strong>${escapeHtml(label)}</strong><small>${count > 1 ? `${count} слова` : position === 0 ? 'старт' : 'ход'}</small></button></li>`;
  }).join('');
  document.querySelector('#undo').disabled = state.route.length === 1;
}

function render() {
  const current = currentIndex(); const node = state.nodes[current];
  document.querySelector('#mode-label').textContent = state.mode === 'daily' ? 'Игра дня' : state.mode === 'random' ? `Случайная · ${state.distance} шагов` : 'Своя игра';
  document.querySelector('#start-word').textContent = displayWord(state.start, state.sourceWord);
  document.querySelector('#target-word').textContent = displayWord(state.target, state.targetWord);
  document.querySelector('#current-word').textContent = displayWord(current, current === state.start ? state.sourceWord : current === state.target ? state.targetWord : '');
  document.querySelector('#current-anagrams').innerHTML = nodeWords(current).map((word) => `<span>${escapeHtml(word)}</span>`).join('');
  renderRoute();
  const visited = new Set(state.route);
  const neighbors = [...state.adjacency[current]].sort(([first], [second]) => {
    if (first === state.target) return -1; if (second === state.target) return 1;
    return state.nodes[second].frequency - state.nodes[first].frequency;
  });
  document.querySelector('#neighbor-count').textContent = neighbors.length;
  neighborsElement.innerHTML = neighbors.map(([index, type]) => {
    const words = nodeWords(index); const secondary = words.filter((word) => word !== state.nodes[index].label);
    return `<button class="neighbor ${index === state.target ? 'target' : ''} ${visited.has(index) ? 'visited' : ''}" data-neighbor="${index}" type="button"><span class="edge-type">${relationLabel(type)}</span><strong>${escapeHtml(state.nodes[index].label)}</strong><small>${secondary.length ? secondary.map(escapeHtml).join(' · ') : `${state.adjacency[index].length} соседей`}</small></button>`;
  }).join('');
  if (!neighbors.length) neighborsElement.innerHTML = '<p>У этой вершины нет соседей. Вернитесь на шаг назад.</p>';
  if (current === state.target) showFinish();
}

function moveTo(index) {
  const previousPosition = state.route.lastIndexOf(index);
  if (previousPosition >= 0) state.route = state.route.slice(0, previousPosition + 1);
  else state.route.push(index);
  render();
}

function showFinish() {
  const moves = state.route.length - 1; const minimum = state.distance;
  document.querySelector('#finish-title').textContent = moves === minimum ? 'Идеальный маршрут!' : 'Финиш!';
  document.querySelector('#finish-score').textContent = `${moves} ${moves === 1 ? 'ход' : moves < 5 ? 'хода' : 'ходов'} · минимум ${minimum}`;
  document.querySelector('#shortest-route').innerHTML = state.shortestPath.map((index, position) => `<span>${escapeHtml(displayWord(index, position === 0 ? state.sourceWord : position === state.shortestPath.length - 1 ? state.targetWord : ''))}</span>${position < state.shortestPath.length - 1 ? '<i>→</i>' : ''}`).join('');
  if (!finishDialog.open) finishDialog.showModal();
}

function showToast(message) {
  toast.textContent = message; toast.hidden = false;
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { toast.hidden = true; }, 2200);
}

async function copyLink() {
  try { await navigator.clipboard.writeText(window.location.href); showToast('Ссылка скопирована'); }
  catch { showToast('Не удалось скопировать ссылку'); }
}

function setUrl(params) {
  const url = new URL('./', window.location.href); Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value)); window.location.href = url;
}

function loadFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const from = normalizeWord(params.get('from') ?? ''); const to = normalizeWord(params.get('to') ?? '');
  if (from || to) {
    if (!from || !to) throw new Error('В ссылке нужны оба параметра: from и to.');
    const start = state.wordIndex.get(from); const target = state.wordIndex.get(to);
    if (start === undefined || target === undefined) throw new Error(`Слова «${start === undefined ? from : to}» нет в словаре.`);
    const path = shortestPath(start, target);
    if (!path) throw new Error('Эти слова находятся в разных компонентах графа — маршрута между ними нет.');
    configureGame({ start, target, path, mode:'custom', sourceWord:from, targetWord:to }); return;
  }
  if (params.has('distance')) {
    const distance = Math.max(1, Math.min(12, Number.parseInt(params.get('distance'), 10) || 6));
    const seed = Number.parseInt(params.get('seed'), 10) >>> 0;
    const pair = generatePair(distance, seed || hashString(`random-${distance}`));
    configureGame({ ...pair, mode:'random', sourceWord:'', targetWord:'', seed }); return;
  }
  const date = dayKey(); const seed = hashString(`word-route-${date}`); const random = randomFromSeed(seed); const distance = DAILY_DISTANCE_MIN + Math.floor(random() * (DAILY_DISTANCE_MAX - DAILY_DISTANCE_MIN + 1));
  const pair = generatePair(distance, seed);
  configureGame({ ...pair, mode:'daily', sourceWord:'', targetWord:'', seed });
}

function showLoadError(error) {
  loading.innerHTML = `<strong>Маршрут не найден</strong><small>${escapeHtml(error.message)}</small><button class="secondary-button" id="error-setup" type="button">Создать другую игру</button>`;
  document.querySelector('#error-setup').addEventListener('click', () => setupDialog.showModal());
}

neighborsElement.addEventListener('click', (event) => { const button = event.target.closest('[data-neighbor]'); if (button) moveTo(Number(button.dataset.neighbor)); });
routeList.addEventListener('click', (event) => { const button = event.target.closest('[data-route-position]'); if (!button) return; state.route = state.route.slice(0, Number(button.dataset.routePosition) + 1); render(); });
document.querySelector('#undo').addEventListener('click', () => { if (state.route.length > 1) { state.route.pop(); render(); } });
document.querySelector('#restart').addEventListener('click', () => { state.route = [state.start]; render(); });
document.querySelector('#finish-restart').addEventListener('click', () => { finishDialog.close(); state.route = [state.start]; render(); });
document.querySelector('#finish-close').addEventListener('click', () => finishDialog.close());
document.querySelector('#open-setup').addEventListener('click', () => setupDialog.showModal());
document.querySelector('#close-setup').addEventListener('click', () => setupDialog.close());
document.querySelector('#copy-link').addEventListener('click', copyLink);
document.querySelector('#finish-share').addEventListener('click', copyLink);

document.querySelector('#start-custom').addEventListener('click', () => {
  const from = normalizeWord(document.querySelector('#from-input').value); const to = normalizeWord(document.querySelector('#to-input').value); const status = document.querySelector('#custom-status');
  if (!from || !to) { status.textContent = 'Введите оба слова.'; return; }
  if (!state.wordIndex.has(from) || !state.wordIndex.has(to)) { status.textContent = `Слова «${!state.wordIndex.has(from) ? from : to}» нет в словаре.`; return; }
  const path = shortestPath(state.wordIndex.get(from), state.wordIndex.get(to));
  if (!path) { status.textContent = 'Между этими словами нет маршрута.'; return; }
  setUrl({ from, to });
});

document.querySelector('#start-random').addEventListener('click', () => {
  const distance = Math.max(1, Math.min(12, Number.parseInt(document.querySelector('#distance-input').value, 10) || 6));
  const values = new Uint32Array(1); crypto.getRandomValues(values); setUrl({ distance, seed:values[0] });
});

window.addEventListener('popstate', () => window.location.reload());

async function initialize() {
  try {
    const response = await fetch('../anagrams/data/graph.json'); if (!response.ok) throw new Error('Не удалось загрузить словарь.');
    const data = await response.json(); state.nodes = data.nodes; buildIndexes(data.edges); loadFromUrl();
    document.querySelector('#daily-date').textContent = state.mode === 'daily' ? new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(`${dayKey()}T12:00:00Z`)) : `Кратчайшее расстояние: ${state.distance}`;
    loading.hidden = true; routePanel.hidden = false; playfield.hidden = false; rulesPanel.hidden = false;
  } catch (error) { showLoadError(error); }
}

initialize();
