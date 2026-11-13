// Replay original transitions in ladder-number order, independently of the final layout.
export function buildComponentHistory(graph) {
  const games = new Map();
  for (const edge of graph.edges) for (const clue of edge.clues) {
    if (!games.has(clue.game)) games.set(clue.game, []);
    games.get(clue.game).push({ ...clue, a: edge.a, b: edge.b });
  }
  const parent = graph.nodes.map((_, i) => i), sizes = parent.map(() => 1), active = new Set(), seenEdges = new Set();
  const root = (v) => {
    let r = v;
    while (parent[r] !== r) r = parent[r];
    while (parent[v] !== v) { const next = parent[v]; parent[v] = r; v = next; }
    return r;
  };
  const wordGames = graph.nodes.map(() => []);
  let components = 0, largest = 0;
  return [...games].sort(([a], [b]) => a - b).map(([number, clues], index) => {
    clues.sort((a, b) => a.index - b.index);
    const nodes = [...new Set(clues.flatMap((clue) => [clue.a, clue.b]))];
    const touched = new Map();
    for (const node of nodes) if (active.has(node)) {
      const r = root(node);
      if (!touched.has(r)) touched.set(r, { size: sizes[r], words: [] });
      touched.get(r).words.push(node);
    }
    const joined = [...touched.values()].sort((a, b) => b.size - a.size || a.words[0] - b.words[0]);
    const overlaps = new Map();
    for (const node of nodes) for (const game of wordGames[node]) {
      if (!overlaps.has(game)) overlaps.set(game, []);
      overlaps.get(game).push(node);
    }
    const previousGames = [...overlaps].sort(([a], [b]) => a - b).map(([number, words]) => ({ number, words }));
    const gameEdges = new Set(clues.map(({ a, b }) => `${Math.min(a, b)}:${Math.max(a, b)}`));
    const reusedEdges = [...gameEdges].filter((key) => seenEdges.has(key)).length;
    for (const node of nodes) wordGames[node].push(number);
    const before = components, previousLargest = largest, newWords = nodes.filter((node) => !active.has(node));
    for (const node of newWords) { active.add(node); components++; largest = Math.max(largest, 1); }
    let newEdges = 0;
    for (const { a, b } of clues) {
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      if (!seenEdges.has(key)) { seenEdges.add(key); newEdges++; }
      let ra = root(a), rb = root(b);
      if (ra === rb) continue;
      if (sizes[ra] < sizes[rb]) [ra, rb] = [rb, ra];
      parent[rb] = ra; sizes[ra] += sizes[rb]; components--; largest = Math.max(largest, sizes[ra]);
    }
    return {
      index, number, nodes, joined, previousGames, reusedEdges, newWords: newWords.length, newEdges,
      before, components, delta: components - before, largest, previousLargest,
      total: active.size, resultSize: sizes[root(nodes[0])],
      type: !joined.length ? 'birth' : joined.length > 1 ? 'merge' : newWords.length ? 'attach' : 'internal',
    };
  });
}

const streakDefinitions = [
  { id: 'isolated', label: 'Без присоединений', note: 'Только новые отдельные компоненты: ни одного общего слова с прежним графом.', matches: (s) => s.joined.length === 0 },
  { id: 'connected', label: 'С пересечениями', note: 'Есть общие слова с прежним графом: присоединения, слияния или внутренние связи.', matches: (s) => s.joined.length > 0 },
  { id: 'attachments', label: 'Только присоединения', note: 'Новые слова присоединяются ровно к одной прежней компоненте; слияния не входят.', matches: (s) => s.type === 'attach' },
  { id: 'mergers', label: 'Слияния', note: 'Каждая лесенка объединяет хотя бы две прежние компоненты.', matches: (s) => s.type === 'merge' },
  { id: 'without-mergers', label: 'Без слияний', note: 'Новые компоненты, присоединения и внутренние связи; без объединения прежних компонент.', matches: (s) => s.type !== 'merge' },
  { id: 'growth', label: 'Рост крупнейшей', note: 'Размер крупнейшей компоненты увеличивается с каждой лесенкой.', matches: (s) => s.largest > s.previousLargest },
  { id: 'plateau', label: 'Крупнейшая не растёт', note: 'Размер крупнейшей не меняется, хотя другие компоненты могут расти.', matches: (s) => s.largest === s.previousLargest },
];

export function analyzeComponentHistory(steps) {
  const first = (predicate) => steps.find(predicate) ?? null;
  const streaks = streakDefinitions.map(({ matches, ...definition }) => {
    const lengths = [], ranges = [];
    let length = 0, maximum = 0;
    for (const [index, step] of steps.entries()) {
      length = matches(step) ? length + 1 : 0;
      lengths.push(length);
      if (length > maximum) { maximum = length; ranges.length = 0; }
      if (length && length === maximum) ranges.push({ start: index - length + 1, end: index });
    }
    return { ...definition, lengths, maximum, ranges };
  });
  const record = (value) => {
    const maximum = steps.reduce((best, step) => Math.max(best, value(step)), 0);
    return { maximum, steps: maximum ? steps.filter((step) => value(step) === maximum) : [] };
  };
  const oldWords = record((s) => s.nodes.length - s.newWords);
  oldWords.moreThanTwo = steps.filter((s) => s.nodes.length - s.newWords > 2).length;
  const previousLadders = record((s) => s.previousGames.length);
  const reusedEdges = record((s) => s.reusedEdges);
  let sharedWordsMaximum = 0, sharedWordPairs = [];
  for (const step of steps) for (const previous of step.previousGames) {
    const size = previous.words.length;
    if (size > sharedWordsMaximum) { sharedWordsMaximum = size; sharedWordPairs = []; }
    if (size === sharedWordsMaximum) sharedWordPairs.push({ step, previous });
  }
  let longestAbsence = 0, returns = [];
  const lastSeen = new Map();
  for (const [index, step] of steps.entries()) for (const node of step.nodes) {
    if (lastSeen.has(node)) {
      const previous = lastSeen.get(node), gap = index - previous.index - 1;
      if (gap > longestAbsence) { longestAbsence = gap; returns = []; }
      if (gap > 0 && gap === longestAbsence) returns.push({ step, previous: previous.step, node });
    }
    lastSeen.set(node, { step, index });
  }
  let majorityStart = steps.length;
  for (let i = steps.length - 1; i >= 0 && steps[i].largest * 2 > steps[i].total; i--) majorityStart = i;
  return {
    firstAttachment: first((s) => s.type === 'attach'),
    firstMerge: first((s) => s.type === 'merge'),
    firstTripleMerge: first((s) => s.joined.length === 3),
    largestJump: steps.reduce((best, step) => !best || step.largest - step.previousLargest > best.largest - best.previousLargest ? step : best, null),
    sustainedMajority: steps[majorityStart] ?? null,
    thresholds: [100, 500, 1000].map((size) => ({ size, step: first((s) => s.largest >= size) })),
    streaks,
    reuse: {
      oldWords, previousLadders, reusedEdges,
      sharedWords: { maximum: sharedWordsMaximum, pairs: sharedWordPairs },
      absence: { maximum: longestAbsence, returns },
    },
  };
}

const labels = { birth: 'Новая компонента', attach: 'Присоединение', merge: 'Слияние компонент', internal: 'Связи внутри компоненты' };
const colors = { birth: '#d8ff43', attach: '#99a88e', merge: '#ffb56b', internal: '#aeb5e8' };
const fmt = (n) => n.toLocaleString('ru');
const plural = (n, forms) => forms[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2];
const words = (n) => `${fmt(n)} ${plural(n, ['слово', 'слова', 'слов'])}`;
const components = (n) => `${fmt(n)} ${plural(n, ['компонента', 'компоненты', 'компонент'])}`;
const signed = (n) => n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : '0';
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const svgNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, text) => {
  const node = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};

export function initHistory(graph, showWord) {
  const $ = (id) => document.getElementById(id), steps = buildComponentHistory(graph);
  const facts = analyzeComponentHistory(steps);
  if (!steps.length) { $('history-loading').textContent = 'В архиве пока нет лесенок.'; return; }
  $('history-loading').hidden = true;
  $('history-content').hidden = false;
  let selected = steps.length - 1;
  const peak = steps.reduce((a, b) => b.components > a.components ? b : a);
  const mergers = steps.filter((s) => s.type === 'merge');
  const biggest = mergers.reduce((a, b) => !a || b.resultSize - b.joined[0].size > a.resultSize - a.joined[0].size ? b : a, null);
  selected = biggest?.index ?? selected;
  const final = steps.at(-1);
  const milestones = [
    { title: 'Пик разобщённости', value: components(peak.components), step: peak, note: `После №${peak.number} · сейчас ${final.components}` },
    { title: 'Слияния', value: `${mergers.length} ${plural(mergers.length, ['лесенка', 'лесенки', 'лесенок'])}`, step: biggest, note: biggest ? `Крупнейшее пополнение при слиянии: №${biggest.number}` : 'Пока не было слияний' },
    { title: 'Крупнейшая сейчас', value: words(final.largest), step: final, note: `${(final.largest / final.total * 100).toLocaleString('ru', { maximumFractionDigits: 1 })}% всех слов архива` },
  ];
  for (const item of milestones) {
    const button = el('button', undefined, 'history-milestone'); button.type = 'button';
    button.append(el('span', item.title), el('strong', item.value), el('small', item.note));
    button.disabled = !item.step;
    button.addEventListener('click', () => choose(item.step.index));
    $('history-milestones').append(button);
  }
  const milestoneButtons = [];
  function addFact(container, title, step, value, note) {
    const button = el('button', undefined, 'history-fact'); button.type = 'button';
    button.append(el('span', title), el('strong', step ? value : 'Пока не было'), el('small', step ? note : 'В текущем снимке архива'));
    button.disabled = !step;
    if (step) {
      button.addEventListener('click', () => {
        choose(step.index);
        const firstEvent = container === 'history-firsts';
        $(firstEvent ? 'history-first-title' : 'history-position').scrollIntoView({ block: firstEvent ? 'start' : 'center', behavior: 'instant' });
      });
      milestoneButtons.push({ button, index: step.index });
    }
    $(container).append(button);
  }
  const firstEvents = [
    ['Первое присоединение', facts.firstAttachment, 'Новые слова встретили одну прежнюю компоненту.'],
    ['Первое слияние', facts.firstMerge, 'Две или больше прежних компонент стали одной.'],
    ['Первое слияние 3 компонент', facts.firstTripleMerge, 'Три прежде раздельные компоненты соединились.'],
  ];
  for (const [title, step, note] of firstEvents) addFact('history-firsts', title, step, `№${step?.number}`, note);
  const { oldWords, previousLadders, reusedEdges, sharedWords, absence } = facts.reuse;
  const cases = (items) => `${items.length} ${plural(items.length, ['лесенка', 'лесенки', 'лесенок'])}: ${items.map((s) => `№${s.number}`).join(', ')}`;
  if (oldWords.maximum > 2) {
    const step = oldWords.steps[0];
    const freshLinks = step.reusedEdges === 0 ? ' Все её связи были новыми.' : '';
    addFact('history-records', 'Больше всего знакомых слов', step, words(oldWords.maximum), `${cases(oldWords.steps)}. Более 2 старых слов — в ${oldWords.moreThanTwo} из ${steps.length} лесенок. Считаем разные слова, уже встречавшиеся до этой лесенки.${oldWords.steps.length === 1 ? freshLinks : ''}`);
  }
  if (previousLadders.maximum > 1) {
    const step = previousLadders.steps[0];
    addFact('history-records', 'Пересечение с прежними лесенками', step, `${previousLadders.maximum} ${plural(previousLadders.maximum, ['лесенка', 'лесенки', 'лесенок'])}`, `${cases(previousLadders.steps)}.${previousLadders.steps.length === 1 ? ` Через ${words(step.nodes.length - step.newWords)}.` : ''} Считаем разные прежние задания, а не компоненты.`);
  }
  if (sharedWords.maximum > 1) {
    const { step, previous } = sharedWords.pairs[0];
    const pairs = sharedWords.pairs.map(({ step, previous }) => `№${step.number} и №${previous.number}`).join('; ');
    addFact('history-records', 'Общие слова с одной старой лесенкой', step, words(sharedWords.maximum), `${sharedWords.pairs.length} ${plural(sharedWords.pairs.length, ['пара', 'пары', 'пар'])}: ${pairs}.${sharedWords.pairs.length === 1 ? ` ${previous.words.map((node) => graph.nodes[node].label).join(', ')}.` : ''}`);
  }
  if (reusedEdges.maximum > 1) addFact('history-records', 'Больше всего повторных связей', reusedEdges.steps[0], `${reusedEdges.maximum} ${plural(reusedEdges.maximum, ['связь', 'связи', 'связей'])}`, `${cases(reusedEdges.steps)}. Разные неориентированные пары, встречавшиеся в более ранних лесенках.`);
  if (absence.maximum > 0) {
    const { step } = absence.returns[0];
    const examples = absence.returns.map(({ step, previous, node }) => `«${graph.nodes[node].label}»: №${previous.number} → №${step.number}`).join('; ');
    addFact('history-records', 'Самое долгое возвращение слова', step, `${absence.maximum} ${plural(absence.maximum, ['лесенка', 'лесенки', 'лесенок'])}`, `${absence.returns.length} ${plural(absence.returns.length, ['случай', 'случая', 'случаев'])}: ${examples}. Считаем доступные лесенки строго между двумя последовательными появлениями слова.`);
  }
  const jump = facts.largestJump, majority = facts.sustainedMajority;
  addFact('history-records', 'Самый большой скачок крупнейшей', jump, `+${jump ? words(jump.largest - jump.previousLargest) : 0}`, `№${jump?.number} · ${jump?.previousLargest} → ${jump?.largest} слов`);
  addFact('history-records', 'Устойчивое большинство', majority, `С №${majority?.number}`, 'После каждой лесенки до конца снимка больше половины слов находятся в крупнейшей компоненте.');
  for (const { size, step } of facts.thresholds) addFact('history-records', `В крупнейшей ≥ ${words(size)}`, step, `№${step?.number}`, `Впервые достигнуто: ${step ? words(step.largest) : ''}.`);

  const streakCells = [];
  const rangeLabel = (start, end) => start === end ? `№${steps[start].number}` : `№${steps[start].number}–${steps[end].number}`;
  function rangeButton(start, end) {
    const button = el('button', rangeLabel(start, end), 'history-range'); button.type = 'button';
    button.title = 'Показать конец серии';
    button.addEventListener('click', () => { choose(end); $('history-position').scrollIntoView({ block: 'center', behavior: 'instant' }); });
    return button;
  }
  for (const streak of facts.streaks) {
    const row = el('tr'); row.dataset.streak = streak.id;
    const label = el('th'); label.scope = 'row'; label.append(el('strong', streak.label), el('small', streak.note));
    const record = el('td'); record.append(el('strong', String(streak.maximum)));
    const ranges = el('div', undefined, 'history-ranges');
    for (const { start, end } of streak.ranges) ranges.append(rangeButton(start, end));
    record.append(ranges);
    const current = el('td'); streakCells.push({ streak, current });
    row.append(label, record, current); $('history-streaks').append(row);
  }
  $('history-latest').textContent = `К последней · №${final.number} →`;
  $('history-latest').addEventListener('click', () => choose(steps.length - 1));
  for (const [type, label] of Object.entries(labels)) {
    const item = el('span', undefined, 'history-legend-item');
    item.style.setProperty('--event-color', colors[type]);
    item.append(el('i'), document.createTextNode(`${label} · ${steps.filter((s) => s.type === type).length}`));
    $('history-legend').append(item);
  }
  const svg = $('history-chart');
  let x, countY, wordY, guide, countDot, wordDot;
  function renderChart(W) {
    svg.replaceChildren();
    svg.setAttribute('viewBox', `0 0 ${W} 490`);
    const left = 52, right = 18, plotWidth = W - left - right;
    x = (i) => left + plotWidth * (i + 1) / steps.length;
    const maxCount = Math.ceil(peak.components / 5) * 5;
    const maxWords = Math.ceil(final.total / 500) * 500;
    countY = (v) => 205 - v / maxCount * 155;
    wordY = (v) => 420 - v / maxWords * 155;
    const chartTitle = svgEl('title', {}, 'История графа: число компонент и рост крупнейшей после каждой лесенки');
    const description = svgEl('desc', {}, 'Верхний график — число компонент. Нижний — все слова и крупнейшая компонента. Выберите шаг ползунком или кнопками, чтобы прочитать точные значения.');
    svg.append(chartTitle, description);
    function grid(max, y, title, top) {
      svg.append(svgEl('text', { x: left, y: top, class: 'chart-heading' }, title));
      for (let tick = 0; tick <= 4; tick++) {
        const value = max * tick / 4;
        svg.append(svgEl('line', { x1: left, x2: W - right, y1: y(value), y2: y(value), class: 'chart-grid' }));
        svg.append(svgEl('text', { x: left - 12, y: y(value) + 4, 'text-anchor': 'end', class: 'chart-label' }, fmt(value)));
      }
    }
    grid(maxCount, countY, 'КОМПОНЕНТЫ СВЯЗНОСТИ', 24);
    grid(maxWords, wordY, 'СЛОВА В ГРАФЕ', 244);
    const path = (key, y) => `M${left},${y(0)}` + steps.map((s, i) => `H${x(i)}V${y(s[key])}`).join('');
    svg.append(svgEl('path', { d: `${path('total', wordY)}V420H${left}Z`, fill: '#99a88e', opacity: '.13' }));
    svg.append(svgEl('path', { d: `${path('largest', wordY)}V420H${left}Z`, fill: '#69ead7', opacity: '.16' }));
    svg.append(svgEl('path', { d: path('total', wordY), class: 'chart-line', stroke: '#87977d' }));
    svg.append(svgEl('path', { d: path('largest', wordY), class: 'chart-line', stroke: '#69ead7' }));
    svg.append(svgEl('path', { d: path('components', countY), class: 'chart-line', stroke: '#d8ff43' }));
    const cursors = svgEl('g', { 'aria-hidden': 'true' });
    guide = svgEl('line', { y1: 43, y2: 420, class: 'chart-cursor' });
    countDot = svgEl('circle', { r: 6, fill: '#d8ff43', stroke: '#11130f', 'stroke-width': 2 });
    wordDot = svgEl('circle', { r: 6, fill: '#69ead7', stroke: '#11130f', 'stroke-width': 2 });
    cursors.append(guide, countDot, wordDot);
    for (const step of steps) {
      const dot = svgEl('circle', { cx: x(step.index), cy: countY(step.components), r: step.type === 'merge' ? 3.5 : 1.8, fill: colors[step.type], class: 'chart-event' });
      dot.append(svgEl('title', {}, `№${step.number}: ${labels[step.type]}, ${step.components} компонент`));
      svg.append(dot);
    }
    svg.append(cursors);
    const interval = W < 500 ? 40 : 20;
    const ticks = [...new Set([0, ...steps.map((_, i) => i).filter((i) => (i + 1) % interval === 0 && x(steps.length - 1) - x(i) > 45), steps.length - 1])];
    for (const i of ticks) svg.append(svgEl('text', { x: x(i), y: 446, 'text-anchor': 'middle', class: 'chart-label' }, `№${steps[i].number}`));
    svg.append(svgEl('text', { x: W - right, y: 473, 'text-anchor': 'end', class: 'chart-label' }, 'Порядок добавления лесенок →'));
    choose(selected);
  }
  svg.addEventListener('click', (event) => {
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(svg.getScreenCTM().inverse());
    const W = svg.viewBox.baseVal.width;
    choose(Math.round((local.x - 52) / (W - 70) * steps.length) - 1);
  });
  $('history-slider').max = steps.length - 1;
  $('history-slider').addEventListener('input', (event) => choose(Number(event.target.value)));
  $('history-prev').addEventListener('click', () => choose(selected - 1));
  $('history-next').addEventListener('click', () => choose(selected + 1));
  $('history-filter').addEventListener('change', renderEvents);
  function renderEvents() {
    const filter = $('history-filter').value;
    const filtered = steps.filter((step) => filter === 'all' || step.type === filter);
    $('history-event-count').textContent = `${filtered.length} из ${steps.length} лесенок`;
    $('history-events').replaceChildren(...filtered.map((step) => {
      const button = el('button', undefined, 'history-event-row'); button.type = 'button'; button.dataset.step = step.index;
      button.style.setProperty('--event-color', colors[step.type]);
      button.append(el('strong', `№${step.number}`), el('span', step.type === 'merge' ? `${components(step.joined.length)} → 1` : labels[step.type]), el('small', `${signed(step.delta)} комп. · +${step.newWords} слов`));
      if (step.index === selected) button.setAttribute('aria-current', 'step');
      button.addEventListener('click', () => choose(step.index)); return button;
    }));
  }
  function choose(index) {
    selected = Math.max(0, Math.min(steps.length - 1, index));
    const step = steps[selected];
    $('history-slider').value = selected;
    $('history-slider').setAttribute('aria-valuetext', `Лесенка №${step.number}, ${step.components} компонент, крупнейшая — ${step.largest} слов`);
    $('history-position').textContent = `Лесенка №${step.number} · ${selected + 1} / ${steps.length}`;
    $('history-streak-step').textContent = `На шаге №${step.number}`;
    for (const { streak, current } of streakCells) {
      const length = streak.lengths[selected];
      current.replaceChildren(el('strong', String(length)));
      if (length) current.append(rangeButton(selected - length + 1, selected));
      else current.append(el('small', 'Нет серии'));
    }
    for (const { button, index } of milestoneButtons) {
      if (index === selected) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    }
    $('history-prev').disabled = selected === 0; $('history-next').disabled = selected === steps.length - 1;
    guide.setAttribute('x1', x(selected)); guide.setAttribute('x2', x(selected));
    countDot.setAttribute('cx', x(selected)); countDot.setAttribute('cy', countY(step.components));
    wordDot.setAttribute('cx', x(selected)); wordDot.setAttribute('cy', wordY(step.largest));
    $('history-event-type').textContent = labels[step.type]; $('history-event-type').style.color = colors[step.type];
    $('history-step-title').textContent = `Лесенка №${step.number}`;
    const source = $('history-source'); source.href = `https://interoves.com/ladder/${step.number}/`;
    const metrics = [
      ['Компонент', `${step.before} → ${step.components}`, `${signed(step.delta)} за эту лесенку`],
      ['Крупнейшая', words(step.largest), `${signed(step.largest - step.previousLargest)} за эту лесенку`],
      ['Её доля', `${(step.largest / step.total * 100).toLocaleString('ru', { maximumFractionDigits: 1 })}%`, `из ${fmt(step.total)} слов на этот момент`],
    ];
    $('history-step-metrics').replaceChildren(...metrics.map(([label, value, note]) => {
      const item = el('div'); item.append(el('dt', label), el('dd', value), el('small', note)); return item;
    }));
    $('history-explanation').textContent = step.type === 'birth'
      ? `Все ${step.newWords} слов появились впервые. Лесенка образовала отдельную компоненту.`
      : step.type === 'merge'
        ? `Лесенка встретила слова из ${step.joined.length} ранее раздельных компонент и связала их в одну. Число компонент уменьшилось на ${-step.delta}.`
        : step.type === 'attach'
          ? `Лесенка пересеклась с одной существующей компонентой и добавила ${step.newWords} новых слов. Число компонент не изменилось.`
          : 'Все слова уже находились в одной компоненте. Число компонент и размер крупнейшей не изменились.';
    const equation = $('history-equation'); equation.replaceChildren();
    for (const [i, part] of step.joined.entries()) {
      if (i) equation.append(el('span', '+', 'equation-sign'));
      const group = el('div', undefined, 'equation-part');
      group.append(el('strong', words(part.size)), el('small', part.words.map((i) => graph.nodes[i].label).join(', ')));
      equation.append(group);
    }
    if (step.newWords || !step.joined.length) {
      if (step.joined.length) equation.append(el('span', '+', 'equation-sign'));
      const group = el('div', undefined, 'equation-part new-words'); group.append(el('strong', `${step.newWords} новых`)); equation.append(group);
    }
    equation.append(el('span', '→', 'equation-sign'));
    const result = el('div', undefined, 'equation-part equation-result'); result.append(el('strong', words(step.resultSize)), el('small', 'в получившейся компоненте')); equation.append(result);
    $('history-added').textContent = `Знакомых слов: ${step.nodes.length - step.newWords} · новых: ${step.newWords}. Прежних лесенок с общими словами: ${step.previousGames.length}. Новых уникальных связей: ${step.newEdges} · уже встречавшихся: ${step.reusedEdges}. Под размерами прежних компонент — слова этой лесенки, которые уже входили в них.`;
    $('history-words').replaceChildren(...step.nodes.map((i) => {
      const button = el('button', graph.nodes[i].label); button.type = 'button'; button.title = 'Найти на полной карте';
      button.addEventListener('click', () => showWord(i)); return button;
    }));
    for (const button of $('history-events').children) {
      if (Number(button.dataset.step) === selected) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
  }
  renderEvents(); renderChart(800);
  new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    if (width > 0 && Math.abs(svg.viewBox.baseVal.width - width) > 1) renderChart(width);
  }).observe(svg.parentElement);

}
