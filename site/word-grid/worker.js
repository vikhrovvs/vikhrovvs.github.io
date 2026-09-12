import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide.mjs';

let solverPromise;

async function getSolver() {
  if (!solverPromise) {
    solverPromise = (async () => {
      self.postMessage({ type: 'progress', stage: 'loading' });
      const [pyodide, response] = await Promise.all([
        loadPyodide(),
        fetch('./solver.py?v=1'),
      ]);
      if (!response.ok) throw new Error('Не удалось загрузить Python-алгоритм.');
      const source = await response.text();
      pyodide.runPython(source);
      const solveJson = pyodide.globals.get('solve_json');
      self.postMessage({ type: 'progress', stage: 'ready' });
      return solveJson;
    })();
  }
  return solverPromise;
}

self.addEventListener('message', async (event) => {
  if (event.data?.type !== 'solve') return;
  const requestId = event.data.requestId;
  try {
    const solveJson = await getSolver();
    self.postMessage({ type: 'progress', stage: 'solving', requestId });
    const resultProxy = solveJson(event.data.words, event.data.timeLimitSeconds ?? 20);
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
