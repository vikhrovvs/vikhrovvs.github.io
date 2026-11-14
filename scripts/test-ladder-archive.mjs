import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { yesterday, validateArchive, mergeArchive } from './ladder-archive.mjs';

assert.equal(yesterday(new Date('2026-11-13T20:59:59Z')), '2026-11-12');
assert.equal(yesterday(new Date('2026-11-13T21:00:00Z')), '2026-11-13');
assert.equal(yesterday(new Date('2027-01-01T00:00:00Z')), '2026-12-31');
assert.equal(yesterday(new Date('2024-03-01T00:00:00Z')), '2024-02-29');
const game = (number, day) => ({ number, calendarLabel: `${day} ноябрь 2026`, url: `https://interoves.com/ladder/${number}/`, expectedWords: 3, transitions: [{ index: 0, from: 'А', to: 'Б', text: 'А → Б' }, { index: 1, from: 'Б', to: 'В', text: 'Б → В' }] });
const archive = (games) => ({ schemaVersion: 1, source: 'https://interoves.com/ladder/', collectedAt: '2026-11-14T10:00:00Z', discovered: games.map((g) => g.number), games, failures: [] });
const base = archive([game(1, 12)]), patch = { ...archive([game(2, 13)]), afterNumber: 1 };
assert.equal(mergeArchive(base, patch, '2026-11-13').games.length, 2);
assert.throws(() => mergeArchive(base, { ...patch, afterNumber: 0 }, '2026-11-13'), /base/);
assert.throws(() => mergeArchive(base, archive([game(2, 13)]), '2026-11-13'), /lost/);
assert.throws(() => mergeArchive(base, { ...archive([game(3, 13)]), afterNumber: 1 }, '2026-11-13'), /missing/);
assert.throws(() => validateArchive(archive([game(3, 14)]), '2026-11-13'), /D−1/);
assert.throws(() => validateArchive({ ...patch, discovered: [2, 2] }, '2026-11-13'), /match/);
assert.throws(() => validateArchive(archive([{ ...game(2, 13), transitions: [{ index: 1, from: 'А', to: 'Б', text: 'text' }] }]), '2026-11-13'), /Incomplete/);
const broken = structuredClone(patch); broken.games[0].transitions[1].from = 'Г';
assert.throws(() => validateArchive(broken, '2026-11-13'), /chain/);

// Execute the actual standalone browser exporter with a simulated calendar/session.
const source = fs.readFileSync(new URL('./export-ladder.browser.js', import.meta.url), 'utf8');
async function exported(throughDate, fail = false) {
  const requested = [], clicks = [];
  const link = (href, label) => ({ getAttribute: (name) => name === 'href' ? href : label });
  const calendar = { querySelector: () => true, querySelectorAll: (selector) => selector.includes('month=') ? [link('/ladder/?month=2026-10', '')] : [link('/ladder/128/', '12 ноябрь 2026, Лесенка №128'), link('/ladder/129/', '13 ноябрь 2026, Лесенка №129'), link('/ladder/130/', '14 ноябрь 2026, Лесенка №130')] };
  const olderCalendar = { querySelectorAll: (selector) => selector.includes('month=') ? [link('/ladder/?month=2026-09', '')] : [] };
  const oldestCalendar = { querySelectorAll: () => [] };
  const clue = { dataset: { hintIndex: '0', prevWord: 'А', nextWord: 'Б' }, querySelector: () => ({ cloneNode: () => ({ querySelectorAll: () => [], textContent: 'А → Б' }) }) };
  const taskPage = { querySelector: () => fail ? null : { dataset: { raddleNWords: '2' } }, querySelectorAll: () => [clue] };
  const window = { ladderExportOptions: { afterNumber: 128, throughDate }, ladderArchiveExport: { stale: true } };
  const context = { window, location: { origin: 'https://interoves.com' }, Intl, Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-14T10:00:00Z'])); } }, URL: class extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} }, Blob,
    DOMParser: class { parseFromString(text) { return ({ calendar, olderCalendar, oldestCalendar })[text] || taskPage; } },
    fetch: async (url) => { requested.push(url); return { ok: true, url: new URL(url, 'https://interoves.com').href, text: async () => url === '/ladder/' ? 'calendar' : url.includes('month=2026-10') ? 'olderCalendar' : url.includes('month=2026-09') ? 'oldestCalendar' : 'task' }; },
    document: { createElement: () => ({ click: () => clicks.push(true) }) }, console: { log() {} }, setTimeout: (callback) => { callback(); } };
  await vm.runInNewContext(source, context);
  return { requested, clicks, data: window.ladderArchiveExport };
}
const result = await exported('2026-11-13');
assert.deepEqual(Array.from(result.data.discovered), [129]);
assert.equal(result.clicks.length, 1);
assert.equal(result.requested.some((url) => url.endsWith('/130/')), false);
assert.ok(result.requested.includes('/ladder/?month=2026-09'), 'Follow month links beyond the first page');
const noNew = await exported('2026-11-12');
assert.equal(noNew.data, undefined); assert.equal(noNew.clicks.length, 0);
await assert.rejects(exported('2026-11-14'), /D−1/);
await assert.rejects(exported('2026-11-13', true), /Incomplete export/);
console.log('OK: Moscow D−1 boundaries, incremental merge, malformed/incomplete/future exports, browser date filtering and failure without download');
