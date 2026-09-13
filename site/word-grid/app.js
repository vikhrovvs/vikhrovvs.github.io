const form = document.querySelector('#solver-form');
const wordsInput = document.querySelector('#words-input');
const wordCount = document.querySelector('#word-count');
const solveButton = document.querySelector('#solve-button');
const stopButton = document.querySelector('#stop-button');
const statusBadge = document.querySelector('#status-badge');
const resultMessage = document.querySelector('#result-message');
const resultStats = document.querySelector('#result-stats');
const boardGrid = document.querySelector('#board-grid');
const pathOverlay = document.querySelector('#path-overlay');
const wordPaths = document.querySelector('#word-paths');
const solutionSummary = document.querySelector('#solution-summary');
const solutionCount = document.querySelector('#solution-count');
const solutionCountLabel = document.querySelector('#solution-count-label');
const solutionNavigation = document.querySelector('#solution-navigation');
const solutionPosition = document.querySelector('#solution-position');
const storedSolutions = document.querySelector('#stored-solutions');
const navigationKind = document.querySelector('#navigation-kind');
const previousSolution = document.querySelector('#previous-solution');
const nextSolution = document.querySelector('#next-solution');
const solutionComplexity = document.querySelector('#solution-complexity');
const minimumComplexity = document.querySelector('#minimum-complexity');
const averageComplexity = document.querySelector('#average-complexity');
const solutionHighlights = document.querySelector('#solution-highlights');
const firstSolutionButton = document.querySelector('#first-solution');
const bestSolutionButton = document.querySelector('#best-solution');

const TIME_LIMIT_SECONDS = 20;
const DISPLAY_LIMIT = 200;
const TOP_LIMIT = 100;
const MAX_SOLUTIONS = 100000;

let worker;
let requestId = 0;
let latestResult = null;
let selectedWordIndex = -1;
let gallerySolutions = [];
let rankedSolutions = [];
let liveBestSolution = null;
let currentCollection = 'gallery';
let currentSolutionIndex = -1;
let reportedCount = 0;
let enumerationExact = false;

function parseVisibleWords(value) {
  return value
    .split(/[\n,;]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
}

function pluralForm(count, forms) {
  if (count % 10 === 1 && count % 100 !== 11) return forms[0];
  if (count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14)) return forms[1];
  return forms[2];
}

function solutionLabel(count, running) {
  const form = pluralForm(count, ['one', 'few', 'many']);
  if (running) {
    if (form === 'one') return 'решение уже найдено';
    if (form === 'few') return 'решения уже найдены';
    return 'решений уже найдено';
  }
  return form === 'one'
    ? 'уникальное решение'
    : `уникальных ${form === 'few' ? 'решения' : 'решений'}`;
}

function updateWordCount() {
  const words = [...new Set(parseVisibleWords(wordsInput.value).map((word) => word.toLocaleLowerCase('ru-RU').normalize('NFC')))];
  const letters = new Set(words.join('')).size;
  wordCount.textContent = `${words.length} ${pluralForm(words.length, ['слово', 'слова', 'слов'])} · ${letters} ${pluralForm(letters, ['буква', 'буквы', 'букв'])}`;
  wordCount.dataset.complete = String(letters === 16);
}

function setStatus(state, label, message) {
  statusBadge.dataset.state = state;
  statusBadge.textContent = label;
  if (message) resultMessage.textContent = message;
}

function setBusy(isBusy) {
  wordsInput.disabled = isBusy;
  solveButton.disabled = isBusy;
  stopButton.hidden = !isBusy;
}

function updateSolutionCount({ exact = false, running = false } = {}) {
  solutionSummary.hidden = reportedCount === 0;
  if (!reportedCount) return;
  solutionCount.textContent = exact || running
    ? reportedCount.toLocaleString('ru-RU')
    : `≥ ${reportedCount.toLocaleString('ru-RU')}`;
  solutionCountLabel.textContent = solutionLabel(reportedCount, running);
}

function updateNavigation() {
  const collection = currentSolutions();
  const shouldShow = collection.length > 0 && currentCollection !== 'best';
  solutionNavigation.hidden = !shouldShow;
  if (!shouldShow) return;
  solutionPosition.textContent = String(currentSolutionIndex + 1);
  storedSolutions.textContent = collection.length.toLocaleString('ru-RU');
  navigationKind.textContent = currentCollection === 'ranked' ? 'в топе' : 'показанных';
  previousSolution.disabled = currentSolutionIndex <= 0;
  nextSolution.disabled = currentSolutionIndex >= collection.length - 1;
}

function updateHighlights() {
  const first = gallerySolutions[0];
  const rankedBest = rankedSolutions[0];
  const best = rankedBest ?? liveBestSolution;
  const hasFirst = Boolean(first);
  const hasBest = Boolean(best);
  solutionHighlights.hidden = !hasFirst || !hasBest;
  if (!hasFirst || !hasBest) return;

  const bestIsFirst = boardKey(first) === boardKey(best);
  const onlyRankedSolutionIsFirst = rankedSolutions.length === 1 && bestIsFirst;
  firstSolutionButton.textContent = onlyRankedSolutionIsFirst
    ? `Первое · ${enumerationExact ? 'самое запутанное' : 'лучшее среди найденных'}`
    : !rankedSolutions.length && bestIsFirst
      ? 'Первое · лучшее пока'
      : 'Первое найденное';
  firstSolutionButton.setAttribute(
    'aria-pressed',
    String(currentCollection === 'gallery' && currentSolutionIndex === 0),
  );
  bestSolutionButton.hidden = onlyRankedSolutionIsFirst || (!rankedSolutions.length && bestIsFirst);
  bestSolutionButton.textContent = rankedSolutions.length
    ? `${enumerationExact ? 'Топ запутанных' : 'Топ среди найденных'} · ${rankedSolutions.length}`
    : 'Лучшее пока';
  bestSolutionButton.setAttribute(
    'aria-pressed',
    String(currentCollection === 'ranked' || currentCollection === 'best'),
  );
}

function resetBoard() {
  boardGrid.innerHTML = Array.from({ length: 16 }, () => '<span>·</span>').join('');
  boardGrid.setAttribute('aria-label', 'Пустой квадрат 4 на 4');
  pathOverlay.replaceChildren();
  wordPaths.replaceChildren();
  resultStats.textContent = '';
  solutionSummary.hidden = true;
  solutionComplexity.hidden = true;
  solutionHighlights.hidden = true;
  solutionNavigation.hidden = true;
  latestResult = null;
  selectedWordIndex = -1;
  gallerySolutions = [];
  rankedSolutions = [];
  liveBestSolution = null;
  currentCollection = 'gallery';
  currentSolutionIndex = -1;
  reportedCount = 0;
  enumerationExact = false;
}

function handleWorkerFailure(message, failedWorker) {
  failedWorker?.terminate();
  if (worker === failedWorker) worker = null;
  setBusy(false);
  if (reportedCount > 0) {
    updateSolutionCount({ exact: false });
    setStatus('partial', 'подсчёт прерван', `Найдено решений: не менее ${reportedCount.toLocaleString('ru-RU')}. ${message}`);
  } else {
    setStatus('failed', 'ошибка', message);
  }
}

function ensureWorker() {
  if (worker) return worker;
  const nextWorker = new Worker('./worker.js?v=4', { type: 'module' });
  worker = nextWorker;
  nextWorker.addEventListener('message', handleWorkerMessage);
  nextWorker.addEventListener('error', () => {
    handleWorkerFailure('Не удалось запустить Python в браузере. Проверьте соединение и попробуйте ещё раз.', nextWorker);
  });
  return nextWorker;
}

function formatElapsed(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds} мс`;
  return `${(milliseconds / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} с`;
}

function formatComplexity(value) {
  return Number(value ?? 0).toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function renderStats(stats) {
  if (!stats) {
    resultStats.textContent = '';
    return;
  }
  const details = [formatElapsed(stats.elapsed_ms ?? 0)];
  if (Number.isFinite(stats.nodes)) details.push(`${stats.nodes.toLocaleString('ru-RU')} узлов поиска`);
  if (Number.isFinite(stats.unique_letters)) {
    details.push(`${stats.unique_letters} ${pluralForm(stats.unique_letters, ['уникальная буква', 'уникальные буквы', 'уникальных букв'])}`);
  }
  if (Number.isFinite(stats.essential_words)) {
    details.push(`${stats.essential_words} ${pluralForm(stats.essential_words, ['существенное ограничение', 'существенных ограничения', 'существенных ограничений'])}`);
  }
  if (stats.removed_words > 0) details.push(`${stats.removed_words} вложенных отброшено`);
  resultStats.textContent = details.join(' · ');
}

function boardPoint(cell) {
  const row = Math.floor(cell / 4);
  const column = cell % 4;
  return [50 + column * 100, 50 + row * 100];
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function highlightWord(index) {
  if (!latestResult?.words?.[index]) return;
  selectedWordIndex = index;
  const { word, path, complexity } = latestResult.words[index];
  const pathSteps = new Map(path.map((cell, step) => [cell, step + 1]));
  [...boardGrid.children].forEach((cell, cellIndex) => {
    const step = pathSteps.get(cellIndex);
    cell.dataset.path = String(step !== undefined);
    cell.querySelector('small')?.remove();
    if (step !== undefined) {
      const marker = document.createElement('small');
      marker.textContent = step;
      cell.append(marker);
    }
  });

  [...wordPaths.children].forEach((button, buttonIndex) => {
    button.setAttribute('aria-pressed', String(buttonIndex === index));
  });

  const points = path.map((cell) => boardPoint(cell).join(',')).join(' ');
  pathOverlay.innerHTML = `<polyline points="${points}"></polyline>`;
  const details = complexity
    ? ` Запутанность ${formatComplexity(complexity.score)}: ${complexity.turns} ${pluralForm(complexity.turns, ['смена', 'смены', 'смен'])} направления, ${complexity.direction_types} ${pluralForm(complexity.direction_types, ['тип', 'типа', 'типов'])} движения, ${complexity.diagonal_steps} ${pluralForm(complexity.diagonal_steps, ['диагональный шаг', 'диагональных шага', 'диагональных шагов'])}.`
    : '';
  resultMessage.textContent = `«${word}»: ${path.map((cell) => cell + 1).join(' → ')}.${details}`;
}

function currentSolutions() {
  if (currentCollection === 'ranked') return rankedSolutions;
  if (currentCollection === 'best') return liveBestSolution ? [liveBestSolution] : [];
  return gallerySolutions;
}

function renderSolutionAt(index, collection = currentCollection) {
  const candidates = collection === 'ranked'
    ? rankedSolutions
    : collection === 'best'
      ? liveBestSolution ? [liveBestSolution] : []
      : gallerySolutions;
  const result = candidates[index];
  if (!result) return;
  currentCollection = collection;
  currentSolutionIndex = index;
  latestResult = result;
  boardGrid.innerHTML = result.board
    .map((letter) => `<span data-used="${String(Boolean(letter))}"${letter ? '' : ' aria-label="Пустая клетка"'}>${escapeHtml(letter)}</span>`)
    .join('');
  boardGrid.setAttribute('aria-label', `Найденный квадрат: ${result.board.map((letter) => letter || 'пусто').join(', ')}`);
  wordPaths.innerHTML = result.words
    .map(({ word, complexity }, wordIndex) => `<button class="word-chip" type="button" data-word-index="${wordIndex}" aria-pressed="false"><span>${escapeHtml(word)}</span><small>${formatComplexity(complexity?.score)}</small></button>`)
    .join('');
  if (result.complexity) {
    minimumComplexity.textContent = formatComplexity(result.complexity.minimum);
    averageComplexity.textContent = formatComplexity(result.complexity.average);
    solutionComplexity.hidden = false;
  } else {
    solutionComplexity.hidden = true;
  }
  updateNavigation();
  updateHighlights();
  highlightWord(0);
}

function boardKey(solution) {
  return solution.board.join('\u0001');
}

function registerBestSolution(solution) {
  if (!solution) return;
  const wasViewingBest = currentCollection === 'best';
  liveBestSolution = solution;
  if (wasViewingBest) {
    renderSolutionAt(0, 'best');
    return;
  }
  updateNavigation();
  updateHighlights();
}

function acceptEnumerationUpdate(update) {
  reportedCount = Math.max(reportedCount, update.count ?? 0);
  updateSolutionCount({ exact: false, running: true });
  if (update.event === 'best') {
    registerBestSolution(update.solution);
    return;
  }
  if (update.event !== 'solution') return;
  gallerySolutions.push(update.solution);
  if (update.best_so_far) registerBestSolution(update.solution);
  if (gallerySolutions.length === 1) {
    renderSolutionAt(0, 'gallery');
    setStatus('solving', 'считаем дальше');
  } else {
    updateNavigation();
  }
}

function finishEnumeration(result) {
  reportedCount = result.count ?? reportedCount;
  enumerationExact = Boolean(result.exact);
  const wasViewingBest = currentCollection === 'best';
  rankedSolutions = Array.isArray(result.top_solutions) ? result.top_solutions : [];
  liveBestSolution = rankedSolutions[0] ?? result.best_solution ?? liveBestSolution;
  if (wasViewingBest && rankedSolutions.length) {
    renderSolutionAt(0, 'ranked');
  }
  renderStats(result.stats);
  if (reportedCount > 0) {
    updateSolutionCount({ exact: result.exact });
    const state = result.exact ? 'solved' : 'partial';
    const label = result.exact ? 'все решения найдены' : 'показана нижняя граница';
    setStatus(state, label, result.message);
    updateNavigation();
    updateHighlights();
    return;
  }

  resetBoard();
  renderStats(result.stats);
  const label = result.status === 'timeout' ? 'нужно больше времени' :
    result.status === 'invalid' ? 'проверьте ввод' : 'решения нет';
  setStatus('failed', label, result.message);
}

function handleWorkerMessage(event) {
  const data = event.data ?? {};
  if (data.requestId !== undefined && data.requestId !== requestId) return;

  if (data.type === 'progress') {
    if (data.stage === 'loading') {
      setStatus('solving', 'загрузка Python', 'Первый запуск загружает Python-среду. Следующие поиски начнутся сразу.');
    } else if (data.stage === 'enumerating') {
      setStatus('solving', 'ищем первое решение', 'Первое найденное поле появится сразу, затем подсчёт продолжится.');
    } else if (data.stage === 'ready' || data.stage === 'solving') {
      setStatus('solving', 'идёт поиск', 'Ограничения распространяются по клеткам; невозможные ветви отсекаются сразу.');
    }
    return;
  }

  if (data.type === 'enumeration-update') {
    acceptEnumerationUpdate(data.update);
    return;
  }

  if (data.type === 'error') {
    handleWorkerFailure(data.message || 'Не удалось выполнить поиск.', event.currentTarget);
    return;
  }

  if (data.type !== 'result') return;
  setBusy(false);
  finishEnumeration(data.result);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  requestId += 1;
  resetBoard();
  setBusy(true);
  setStatus('solving', 'подготовка', 'Проверяем слова и готовим точный поиск.');
  ensureWorker().postMessage({
    type: 'solve',
    requestId,
    words: wordsInput.value,
    timeLimitSeconds: TIME_LIMIT_SECONDS,
    displayLimit: DISPLAY_LIMIT,
    topLimit: TOP_LIMIT,
    maxSolutions: MAX_SOLUTIONS,
  });
});

stopButton.addEventListener('click', () => {
  requestId += 1;
  worker?.terminate();
  worker = null;
  setBusy(false);
  if (reportedCount > 0) {
    updateSolutionCount({ exact: false });
    setStatus('partial', 'поиск остановлен', `Найдено уникальных решений: не менее ${reportedCount.toLocaleString('ru-RU')}.`);
  } else {
    setStatus('idle', 'поиск остановлен', 'Поиск остановлен. Введённые слова сохранены.');
  }
});

wordPaths.addEventListener('click', (event) => {
  const button = event.target.closest('[data-word-index]');
  if (button) highlightWord(Number(button.dataset.wordIndex));
});

previousSolution.addEventListener('click', () => renderSolutionAt(currentSolutionIndex - 1));
nextSolution.addEventListener('click', () => renderSolutionAt(currentSolutionIndex + 1));
firstSolutionButton.addEventListener('click', () => renderSolutionAt(0, 'gallery'));
bestSolutionButton.addEventListener('click', () => {
  renderSolutionAt(0, rankedSolutions.length ? 'ranked' : 'best');
});
wordsInput.addEventListener('input', updateWordCount);
updateWordCount();
