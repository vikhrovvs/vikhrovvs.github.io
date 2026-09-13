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
const MAX_SOLUTIONS = 100000;

let worker;
let requestId = 0;
let latestResult = null;
let selectedWordIndex = -1;
let solutions = [];
let currentSolutionIndex = -1;
let reportedCount = 0;
let bestSolutionIndex = -1;
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
  const shouldShow = solutions.length > 0;
  solutionNavigation.hidden = !shouldShow;
  if (!shouldShow) return;
  solutionPosition.textContent = String(currentSolutionIndex + 1);
  storedSolutions.textContent = solutions.length.toLocaleString('ru-RU');
  previousSolution.disabled = currentSolutionIndex <= 0;
  nextSolution.disabled = currentSolutionIndex >= solutions.length - 1;
}

function updateHighlights() {
  const hasBest = bestSolutionIndex >= 0 && solutions.length > 0;
  solutionHighlights.hidden = !hasBest;
  if (!hasBest) return;

  const bestIsFirst = bestSolutionIndex === 0;
  firstSolutionButton.textContent = bestIsFirst
    ? `Первое · ${enumerationExact ? 'самое запутанное' : 'лучшее пока'}`
    : 'Первое найденное';
  firstSolutionButton.setAttribute('aria-pressed', String(currentSolutionIndex === 0));
  bestSolutionButton.hidden = bestIsFirst;
  bestSolutionButton.textContent = enumerationExact ? 'Самое запутанное' : 'Лучшее из найденных';
  bestSolutionButton.setAttribute('aria-pressed', String(currentSolutionIndex === bestSolutionIndex));
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
  solutions = [];
  currentSolutionIndex = -1;
  reportedCount = 0;
  bestSolutionIndex = -1;
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
  const nextWorker = new Worker('./worker.js?v=3', { type: 'module' });
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

function renderSolutionAt(index) {
  const result = solutions[index];
  if (!result) return;
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
  const previousBestIndex = bestSolutionIndex;
  let index = solutions.findIndex((candidate) => boardKey(candidate) === boardKey(solution));
  if (index < 0) {
    index = DISPLAY_LIMIT;
    if (solutions.length > DISPLAY_LIMIT) {
      solutions[index] = solution;
    } else {
      solutions.push(solution);
    }
  }
  bestSolutionIndex = index;
  if (currentSolutionIndex === previousBestIndex && previousBestIndex === DISPLAY_LIMIT) {
    renderSolutionAt(bestSolutionIndex);
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
  solutions.push(update.solution);
  if (update.best_so_far) registerBestSolution(update.solution);
  if (solutions.length === 1) {
    renderSolutionAt(0);
    setStatus('solving', 'считаем дальше');
  } else {
    updateNavigation();
  }
}

function finishEnumeration(result) {
  reportedCount = result.count ?? reportedCount;
  enumerationExact = Boolean(result.exact);
  registerBestSolution(result.best_solution);
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
firstSolutionButton.addEventListener('click', () => renderSolutionAt(0));
bestSolutionButton.addEventListener('click', () => renderSolutionAt(bestSolutionIndex));
wordsInput.addEventListener('input', updateWordCount);
updateWordCount();
