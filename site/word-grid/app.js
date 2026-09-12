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

let worker;
let requestId = 0;
let latestResult = null;
let selectedWordIndex = -1;

function parseVisibleWords(value) {
  return value
    .split(/[\n,;]+/u)
    .map((word) => word.trim())
    .filter(Boolean);
}

function pluralizeWords(count) {
  const ending = count % 10 === 1 && count % 100 !== 11 ? 'слово' :
    count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14) ? 'слова' : 'слов';
  return `${count} ${ending}`;
}

function updateWordCount() {
  wordCount.textContent = pluralizeWords(new Set(parseVisibleWords(wordsInput.value).map((word) => word.toLocaleLowerCase('ru-RU'))).size);
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

function resetBoard() {
  boardGrid.innerHTML = Array.from({ length: 16 }, () => '<span>·</span>').join('');
  boardGrid.setAttribute('aria-label', 'Пустой квадрат 4 на 4');
  pathOverlay.replaceChildren();
  wordPaths.replaceChildren();
  resultStats.textContent = '';
  latestResult = null;
  selectedWordIndex = -1;
}

function ensureWorker() {
  if (worker) return worker;
  const nextWorker = new Worker('./worker.js?v=1', { type: 'module' });
  worker = nextWorker;
  nextWorker.addEventListener('message', handleWorkerMessage);
  nextWorker.addEventListener('error', () => {
    nextWorker.terminate();
    if (worker === nextWorker) worker = null;
    setBusy(false);
    setStatus('failed', 'ошибка загрузки', 'Не удалось запустить Python в браузере. Проверьте соединение и попробуйте ещё раз.');
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
  if (Number.isFinite(stats.essential_words)) {
    details.push(`${stats.essential_words} существенных ограничений`);
  }
  if (stats.removed_words > 0) details.push(`${stats.removed_words} вложенных отброшено`);
  resultStats.textContent = details.join(' · ');
}

function boardPoint(cell) {
  const row = Math.floor(cell / 4);
  const column = cell % 4;
  return [50 + column * 100, 50 + row * 100];
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

function renderSolution(result) {
  latestResult = result;
  boardGrid.innerHTML = result.board
    .map((letter) => `<span data-used="true">${escapeHtml(letter)}</span>`)
    .join('');
  boardGrid.setAttribute('aria-label', `Найденный квадрат: ${result.board.join(', ')}`);
  wordPaths.innerHTML = result.words
    .map(({ word }, index) => `<button class="word-chip" type="button" data-word-index="${index}" aria-pressed="false">${escapeHtml(word)}</button>`)
    .join('');
  renderStats(result.stats);
  highlightWord(0);
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function handleWorkerMessage(event) {
  const data = event.data ?? {};
  if (data.requestId !== undefined && data.requestId !== requestId) return;

  if (data.type === 'progress') {
    if (data.stage === 'loading') {
      setStatus('solving', 'загрузка Python', 'Первый запуск загружает Python-среду. Следующие поиски начнутся сразу.');
    } else if (data.stage === 'ready' || data.stage === 'solving') {
      setStatus('solving', 'идёт поиск', 'Ограничения распространяются по клеткам; невозможные ветви отсекаются сразу.');
    }
    return;
  }

  if (data.type === 'error') {
    event.currentTarget.terminate();
    if (worker === event.currentTarget) worker = null;
    setBusy(false);
    setStatus('failed', 'ошибка', data.message || 'Не удалось выполнить поиск.');
    return;
  }

  if (data.type !== 'result') return;
  setBusy(false);
  const result = data.result;
  if (result.status === 'solved') {
    setStatus('solved', 'решение найдено', result.message);
    renderSolution(result);
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
  resetBoard();
  setBusy(true);
  setStatus('solving', 'подготовка', 'Проверяем слова и готовим точный поиск.');
  ensureWorker().postMessage({
    type: 'solve',
    requestId,
    words: wordsInput.value,
    timeLimitSeconds: 20,
  });
});

stopButton.addEventListener('click', () => {
  requestId += 1;
  worker?.terminate();
  worker = null;
  setBusy(false);
  setStatus('idle', 'поиск остановлен', 'Поиск остановлен. Введённые слова сохранены.');
});

wordPaths.addEventListener('click', (event) => {
  const button = event.target.closest('[data-word-index]');
  if (button) highlightWord(Number(button.dataset.wordIndex));
});

wordsInput.addEventListener('input', updateWordCount);
updateWordCount();
