// Shared validation for local imports and deployment. Dates are calendar dates in Moscow.
export function yesterday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (name) => parts.find((p) => p.type === name).value;
  return new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')) - 1)).toISOString().slice(0, 10);
}

export function gameDate(game) {
  const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const match = game.calendarLabel?.match(/^(\d{1,2}) ([а-яё]+) (\d{4})$/u);
  if (!match || !months.includes(match[2])) throw new Error(`Invalid calendar date for #${game.number}`);
  const date = `${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || (game.date && game.date !== date)) throw new Error(`Inconsistent date for #${game.number}`);
  return date;
}

export function validateArchive(archive, cutoff = yesterday()) {
  if (archive.schemaVersion !== 1 || archive.source !== 'https://interoves.com/ladder/' || !Array.isArray(archive.failures) || archive.failures.length || !archive.games?.length) throw new Error('Incomplete or unsupported archive');
  const ids = archive.games.map((g) => g.number);
  if (!Array.isArray(archive.discovered) || archive.discovered.length !== ids.length || new Set(ids).size !== ids.length || new Set(archive.discovered).size !== ids.length || archive.discovered.some((id) => !ids.includes(id))) throw new Error('Discovered games do not match exported games');
  if (!Number.isFinite(Date.parse(archive.collectedAt))) throw new Error('Invalid collection timestamp');
  for (const game of archive.games) {
    if (!Number.isInteger(game.number) || game.number < 1 || game.url !== `https://interoves.com/ladder/${game.number}/`) throw new Error('Invalid game identity');
    if (gameDate(game) > cutoff) throw new Error(`Game #${game.number} is newer than D−1 (${cutoff})`);
    if (!Number.isInteger(game.expectedWords) || game.expectedWords < 2 || game.transitions?.length !== game.expectedWords - 1) throw new Error(`Incomplete game #${game.number}`);
    for (const [index, clue] of game.transitions.entries()) {
      if (clue.index !== index || ![clue.from, clue.to, clue.text].every((s) => typeof s === 'string' && s.trim())) throw new Error(`Invalid clue in #${game.number}`);
      if (index && clue.from !== game.transitions[index - 1].to) throw new Error(`Broken chain in #${game.number}`);
    }
  }
  return archive;
}

export function mergeArchive(base, patch, cutoff = yesterday()) {
  validateArchive(base, cutoff); validateArchive(patch, cutoff);
  const games = new Map(base.games.map((g) => [g.number, g]));
  // Incremental exports declare their base to prevent silently skipping a missing day.
  if (patch.afterNumber !== undefined && patch.afterNumber !== Math.max(...games.keys())) throw new Error('Patch base does not match the local archive');
  if (patch.afterNumber === undefined && base.games.some((g) => !patch.discovered.includes(g.number))) throw new Error('Full export lost existing games');
  for (const game of patch.games) games.set(game.number, game);
  const ordered = [...games.values()].sort((a, b) => a.number - b.number);
  if (ordered.some((game, index) => game.number !== index + 1)) throw new Error('Archive has missing ladder numbers');
  return validateArchive({ schemaVersion: 1, source: base.source, collectedAt: patch.collectedAt, throughDate: cutoff, discovered: ordered.map((g) => g.number), games: ordered, failures: [] }, cutoff);
}
