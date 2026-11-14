/* Run in Chrome DevTools Console on https://interoves.com/ladder/.
 * Reads the archive with the existing browser session; never exports credentials,
 * player results, or raw HTML. Does not submit answers or change account state.
 */
(async () => {
  if (location.origin !== 'https://interoves.com') throw new Error('Open interoves.com first');
  delete window.ladderArchiveExport;
  // Optional incremental export: window.ladderExportOptions = { afterNumber: 128 }.
  // Calendar days use Moscow time, independently of the computer's timezone.
  const options = window.ladderExportOptions || {};
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (name) => parts.find((p) => p.type === name).value;
  const cutoff = new Date(Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day')) - 1)).toISOString().slice(0, 10);
  const throughDate = options.throughDate || cutoff;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDate) || throughDate > cutoff || !Number.isInteger(options.afterNumber ?? 0) || (options.afterNumber ?? 0) < 0) throw new Error('Invalid export options or date newer than D−1');
  const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const read = async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok || new URL(response.url).origin !== location.origin || new URL(response.url).pathname.includes('login')) throw new Error(`Unavailable or logged out: ${url}`);
    return parse(await response.text());
  };
  const catalog = await read('/ladder/');
  if (!catalog.querySelector('a[href*="/logout/"]')) throw new Error('Log in to Interoves before exporting');
  const monthUrls = new Set(['/ladder/']);
  const entries = new Map();
  for (const month of monthUrls) {
    const page = month === '/ladder/' ? catalog : await read(month);
    // Follow the month chain: the first page need not link every historical month.
    for (const a of page.querySelectorAll('a[href*="/ladder/?month="]')) {
      const url = new URL(a.getAttribute('href'), location.origin);
      if (url.origin === location.origin && /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '')) monthUrls.add(`${url.pathname}${url.search}`);
    }
    for (const a of page.querySelectorAll('a[data-daily-archive-day]')) {
      const match = a.getAttribute('href').match(/^\/ladder\/(\d+)\/$/);
      if (!match) continue;
      const calendarLabel = a.getAttribute('aria-label').split(',')[0];
      const dateMatch = calendarLabel.match(/^(\d{1,2}) ([а-яё]+) (\d{4})$/u);
      if (!dateMatch || !months.includes(dateMatch[2])) throw new Error(`Unrecognized calendar date: ${calendarLabel}`);
      const date = `${dateMatch[3]}-${String(months.indexOf(dateMatch[2]) + 1).padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
      if (date <= throughDate && Number(match[1]) > (options.afterNumber ?? 0)) entries.set(Number(match[1]), { number: Number(match[1]), url: new URL(a.getAttribute('href'), location.origin).href, calendarLabel, date });
    }
  }
  const games = [], failures = [];
  for (const entry of [...entries.values()].sort((a, b) => a.number - b.number)) {
    try {
      const page = await read(entry.url);
      const task = page.querySelector('.new-raddle-task');
      if (!task) throw new Error('No accessible ladder task');
      const transitions = [...page.querySelectorAll('.new-raddle-clue[data-hint-index]')].map((clue) => {
        const index = Number(clue.dataset.hintIndex);
        // A few completed clues omit the reference word in their prose. Its
        // exact value is still present in the corresponding solved table row.
        const from = clue.dataset.prevWord || clue.querySelector('.new-raddle-clue-ref')?.textContent
          || page.querySelector(`tr[data-word-index="${index}"]`)?.textContent.trim().split('\n')[0].trim();
        const to = clue.dataset.nextWord || clue.querySelector('.new-raddle-clue-next')?.textContent;
        const text = clue.querySelector('.new-raddle-clue__text').cloneNode(true);
        for (const ref of text.querySelectorAll('.new-raddle-clue-ref')) ref.textContent = from;
        for (const next of text.querySelectorAll('.new-raddle-clue-next')) next.textContent = to;
        return { index, from, to, text: text.textContent.replace(/\s+/g, ' ').trim(), template: clue.dataset.blankTemplate || '' };
      }).sort((a, b) => a.index - b.index);
      const expectedWords = Number(task.dataset.raddleNWords);
      if (!transitions.length || transitions.length !== expectedWords - 1) throw new Error(`Expected ${expectedWords - 1} clues, got ${transitions.length}`);
      if (transitions.some((t) => !t.from || !t.to || !t.text)) throw new Error('Incomplete clue');
      games.push({ ...entry, expectedWords, transitions });
      console.log(`Ladder export: ${games.length}/${entries.size}, #${entry.number}, ${transitions.length} clues`);
    } catch (error) { failures.push({ number: entry.number, error: error.message }); }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (failures.length) throw new Error(`Incomplete export: ${JSON.stringify(failures)}`);
  if (!games.length) { console.log(`No new ladders through ${throughDate}`); return; }
  const archive = { schemaVersion: 1, source: 'https://interoves.com/ladder/', collectedAt: new Date().toISOString(), throughDate, ...(options.afterNumber !== undefined ? { afterNumber: options.afterNumber } : {}), discovered: [...entries.keys()].sort((a, b) => a - b), games, failures };
  window.ladderArchiveExport = archive;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
  a.download = 'interoves-ladder-archive.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  console.log(`LADDER EXPORT COMPLETE: ${games.length}/${entries.size} games, ${failures.length} failures`);
})();
