const form = document.querySelector('#solver-form');
const wordsInput = document.querySelector('#words-input');
const wordCount = document.querySelector('#word-count');
const solveButton = document.querySelector('#solve-button');
const solveLabel = document.querySelector('#solve-label');
const stopButton = document.querySelector('#stop-button');
const runtimeNote = document.querySelector('#runtime-note');
const modeInputs = [...document.querySelectorAll('[name="search-mode"]')];
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

const TIME_LIMIT_SECONDS = 20;
const DISPLAY_LIMIT = 200;
const MAX_SOLUTIONS = 100000;

let worker;
let requestId = 0;
let latestResult = null;
let selectedWordIndex = -1;
let activeMode = 'one';
let solutions = [];
let currentSolutionIndex = -1;
let reportedCount = 0;

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

function selectedMode() {
  return modeInputs.find((input) => input.checked)?.value ?? 'one';
}

function updateWordCount() {
  const words = [...new Set(parseVisibleWords(wordsInput.value).map((word) => word.toLocaleLowerCase('ru-RU').normalize('NFC')))];
  const letters = new Set(words.join('')).size;
  wordCount.textContent = `${words.length} ${pluralForm(words.length, ['слово', 'слова', 'слов'])} · ${letters} ${pluralForm(letters, ['буква', 'буквы', 'букв'])}`;
  wordCount.dataset.complete = String(letters === 16);
}

function updateModeCopy() {
  const enumerateAll = selectedMode() === 'all';
  solveLabel.textContent = enumerateAll ? 'Найти все решения' : 'Найти квадрат';
  runtimeNote.textContent = enumerateAll
    ? 'Первое решение появится сразу; полный подсчёт продолжится до 20 секунд.'
    : 'Python загрузится только после запуска поиска.';
}

function setStatus(state, label, message) {
  statusBadge.dataset.state = state;
  statusBadge.textContent = label;
  if (message) resultMessage.textContent = message;
}

function setBusy(isBusy) {
  wordsInput.disabled = isBusy;
  solveButton.disabled = isBusy;
  modeInputs.forEach((input) => { input.disabled = isBusy; });
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
  const shouldShow = activeMode === 'all' && solutions.length > 0;
  solutionNavigation.hidden = !shouldShow;
  if (!shouldShow) return;
  solutionPosition.textContent = String(currentSolutionIndex + 1);
  storedSolutions.textContent = solutions.length.toLocaleString('ru-RU');
  previousSolution.disabled = currentSolutionIndex <= 0;
  nextSolution.disabled = currentSolutionIndex >= solutions.length - 1;
}

function resetBoard() {
  boardGrid.innerHTML = Array.from({ length: 16 }, () => '<span>·</span>').join('');
  boardGrid.setAttribute('aria-label', 'Пустой квадрат 4 на 4');
  pathOverlay.replaceChildren();
  wordPaths.replaceChildren();
  resultStats.textContent = '';
  solutionSummary.hidden = true;
  solutionNavigation.hidden = true;
  latestResult = null;
  selectedWordIndex = -1;
  solutions = [];
  currentSolutionIndex = -1;
  reportedCount = 0;
}

function handleWorkerFailure(message, failedWorker) {
  failedWorker?.terminate();
  if (worker === failedWorker) worker = null;
  setBusy(false);
  if (activeMode === 'all' && reportedCount > 0) {
    updateSolutionCount({ exact: false });
    setStatus('partial', 'подсчёт прерван', `Найдено решений: не менее ${reportedCount.toLocaleString('ru-RU')}. ${message}`);
  } else {
    setStatus('failed', 'ошибка', message);
  }
}

function ensureWorker() {
  if (worker) return worker;
  const nextWorker = new Worker('./worker.js?v=2', { type: 'module' });
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
  const { word, path } = latestResult.words[index];
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
  resultMessage.textContent = `«${word}»: ${path.map((cell) => cell + 1).join(' → ')}.`;
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
    .map(({ word }, wordIndex) => `<button class="word-chip" type="button" data-word-index="${wordIndex}" aria-pressed="false">${escapeHtml(word)}</button>`)
    .join('');
  updateNavigation();
  highlightWord(0);
}

function acceptEnumerationUpdate(update) {
  reportedCount = Math.max(reportedCount, update.count ?? 0);
  updateSolutionCount({ exact: false, running: true });
  if (update.event !== 'solution') return;
  solutions.push(update.solution);
  if (solutions.length === 1) {
    renderSolutionAt(0);
    setStatus('solving', 'считаем дальше');
  } else {
    updateNavigation();
  }
}

function finishEnumeration(result) {
  reportedCount = result.count ?? reportedCount;
  renderStats(result.stats);
  if (reportedCount > 0) {
    updateSolutionCount({ exact: result.exact });
    const state = result.exact ? 'solved' : 'partial';
    const label = result.exact ? 'все решения найдены' : 'показана нижняя граница';
    setStatus(state, label, result.message);
    updateNavigation();
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
  const result = data.result;
  if (activeMode === 'all') {
    finishEnumeration(result);
  } else if (result.status === 'solved') {
    solutions = [result];
    reportedCount = 1;
    setStatus('solved', 'решение найдено', result.message);
    renderSolutionAt(0);
    renderStats(result.stats);
  } else {
    resetBoard();
    renderStats(result.stats);
    const label = result.status === 'timeout' ? 'нужно больше времени' :
      result.status === 'invalid' ? 'проверьте ввод' : 'решения нет';
    setStatus('failed', label, result.message);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  requestId += 1;
  activeMode = selectedMode();
  resetBoard();
  setBusy(true);
  setStatus('solving', 'подготовка', 'Проверяем слова и готовим точный поиск.');
  ensureWorker().postMessage({
    type: 'solve',
    requestId,
    mode: activeMode,
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
  if (activeMode === 'all' && reportedCount > 0) {
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
wordsInput.addEventListener('input', updateWordCount);
modeInputs.forEach((input) => input.addEventListener('change', updateModeCopy));
updateWordCount();
updateModeCopy();
