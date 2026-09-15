import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide.mjs';

const PYTHON_FILES = [
  'grid_model.py',
  'complexity.py',
  'csp.py',
  'subset_selection.py',
  'solver.py',
];

let solverPromise;

async function getSolver() {
  if (!solverPromise) {
    solverPromise = (async () => {
      self.postMessage({ type: 'progress', stage: 'loading' });
      const [pyodide, responses] = await Promise.all([
        loadPyodide(),
        Promise.all(PYTHON_FILES.map((filename) => fetch(`./${filename}?v=8`))),
      ]);
      if (responses.some((response) => !response.ok)) {
        throw new Error('Не удалось загрузить Python-алгоритм.');
      }
      const sources = await Promise.all(responses.map((response) => response.text()));
      PYTHON_FILES.forEach((filename, index) => {
        pyodide.FS.writeFile(`/home/pyodide/${filename}`, sources[index], { encoding: 'utf8' });
      });
      pyodide.runPython(`
import sys
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
from solver import evaluate_json, maximise_and_enumerate_json
      `);
      const enumerateJson = pyodide.globals.get('maximise_and_enumerate_json');
      const evaluateJson = pyodide.globals.get('evaluate_json');
      self.postMessage({ type: 'progress', stage: 'ready' });
      return { enumerateJson, evaluateJson };
    })();
  }
  return solverPromise;
}

self.addEventListener('message', async (event) => {
  if (!['solve', 'evaluate'].includes(event.data?.type)) return;
  const requestId = event.data.requestId;
  try {
    const solver = await getSolver();
    if (event.data.type === 'evaluate') {
      const resultProxy = solver.evaluateJson(event.data.board, event.data.words);
      const result = JSON.parse(String(resultProxy));
      resultProxy.destroy?.();
      self.postMessage({ type: 'evaluation-result', requestId, result });
      return;
    }
    self.postMessage({
      type: 'progress',
      stage: 'enumerating',
      requestId,
    });
    const onUpdate = (payload) => {
      self.postMessage({
        type: 'enumeration-update',
        requestId,
        update: JSON.parse(String(payload)),
      });
    };
    const resultProxy = solver.enumerateJson(
      event.data.words,
      event.data.timeLimitSeconds ?? 20,
      event.data.maxSolutions ?? 100000,
      event.data.displayLimit ?? 200,
      onUpdate,
      event.data.topLimit ?? 100,
    );
    const result = JSON.parse(String(resultProxy));
    resultProxy.destroy?.();
    self.postMessage({ type: 'result', requestId, result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
