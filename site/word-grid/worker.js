import { loadPyodide } from 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/pyodide.mjs';

let solverPromise;

async function getSolver() {
  if (!solverPromise) {
    solverPromise = (async () => {
      self.postMessage({ type: 'progress', stage: 'loading' });
      const [pyodide, response] = await Promise.all([
        loadPyodide(),
        fetch('./solver.py?v=6'),
      ]);
      if (!response.ok) throw new Error('Не удалось загрузить Python-алгоритм.');
      const source = await response.text();
      pyodide.runPython(source);
      const enumerateJson = pyodide.globals.get('enumerate_json');
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
