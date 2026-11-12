/* Run in Chrome DevTools Console on https://interoves.com/ladder/.
 * Reads the archive with the existing browser session; never exports credentials,
 * player results, or raw HTML. Does not submit answers or change account state.
 */
(async () => {
  if (location.origin !== 'https://interoves.com') throw new Error('Open interoves.com first');
  const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
  const read = async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    return parse(await response.text());
  };
  const catalog = await read('/ladder/');
  const monthUrls = new Set(['/ladder/', ...Array.from(catalog.querySelectorAll('a[href*="/ladder/?month="]'), (a) => a.getAttribute('href'))]);
  const entries = new Map();
  for (const month of monthUrls) {
    const page = month === '/ladder/' ? catalog : await read(month);
    for (const a of page.querySelectorAll('a[data-daily-archive-day]')) {
      const match = a.getAttribute('href').match(/^\/ladder\/(\d+)\/$/);
      if (match) entries.set(Number(match[1]), { number: Number(match[1]), url: a.href, calendarLabel: a.getAttribute('aria-label').split(',')[0] });
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
  const archive = { schemaVersion: 1, source: 'https://interoves.com/ladder/', collectedAt: new Date().toISOString(), discovered: [...entries.keys()].sort((a, b) => a - b), games, failures };
  window.ladderArchiveExport = archive;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
  a.download = 'interoves-ladder-archive.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  console.log(`LADDER EXPORT COMPLETE: ${games.length}/${entries.size} games, ${failures.length} failures`);
})();
