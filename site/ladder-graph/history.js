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
      index, number, nodes, joined, newWords: newWords.length, newEdges,
      before, components, delta: components - before, largest, previousLargest,
      total: active.size, resultSize: sizes[root(nodes[0])],
      type: !joined.length ? 'birth' : joined.length > 1 ? 'merge' : newWords.length ? 'attach' : 'internal',
    };
  });
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
    $('history-added').textContent = `Новых слов: ${step.newWords} · новых уникальных связей: ${step.newEdges}. Под размерами прежних компонент — слова этой лесенки, которые уже входили в них.`;
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
