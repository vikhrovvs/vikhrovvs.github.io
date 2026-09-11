import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const [, , inputPath, outputPath = 'site/anagrams/data/graph.json'] = process.argv;
const MAX_WORDS = 20_000;
const MIN_LENGTH = 2;
const MAX_LENGTH = 14;

if (!inputPath) {
  throw new Error('Usage: node scripts/build-data.mjs <frequency.csv> [output.json]');
}

const isRussianWord = (word) =>
  word.length >= MIN_LENGTH &&
  word.length <= MAX_LENGTH &&
  /^[а-яё]+$/u.test(word);

const signature = (word) => Array.from(word).sort((a, b) => a.localeCompare(b, 'ru')).join('');

const csv = await readFile(resolve(inputPath), 'utf8');
const rows = csv.trim().split(/\r?\n/).slice(1);
const words = [];
const seen = new Set();

for (const row of rows) {
  if (words.length >= MAX_WORDS) break;
  const [rawWord, , rawIpm] = row.split(',');
  const word = rawWord.trim().toLocaleLowerCase('ru-RU').normalize('NFC');
  if (!isRussianWord(word) || seen.has(word)) continue;
  const ipm = Number(rawIpm);
  if (!Number.isFinite(ipm)) continue;
  seen.add(word);
  words.push([word, ipm]);
}

const groups = new Map();
for (const [word, ipm] of words) {
  const id = signature(word);
  const group = groups.get(id) ?? [];
  group.push([word, ipm]);
  groups.set(id, group);
}

const nodes = Array.from(groups, ([id, entries]) => {
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'));
  return {
    id,
    label: entries[0][0],
    frequency: Math.round(entries.reduce((total, entry) => total + entry[1], 0) * 100) / 100,
    words: entries,
  };
}).sort((a, b) => b.frequency - a.frequency || a.label.localeCompare(b.label, 'ru'));

const indexById = new Map(nodes.map((node, index) => [node.id, index]));
const replacementBuckets = new Map();
const edges = new Map();

const addEdge = (first, second, type) => {
  if (first === second) return;
  const a = Math.min(first, second);
  const b = Math.max(first, second);
  edges.set(`${a}:${b}`, [a, b, type]);
};

for (let index = 0; index < nodes.length; index += 1) {
  const id = nodes[index].id;
  for (let letter = 0; letter < id.length; letter += 1) {
    if (letter > 0 && id[letter] === id[letter - 1]) continue;
    const reduced = id.slice(0, letter) + id.slice(letter + 1);
    const shorter = indexById.get(reduced);
    if (shorter !== undefined) addEdge(index, shorter, 'add');

    const bucketKey = `${id.length}:${reduced}`;
    const bucket = replacementBuckets.get(bucketKey) ?? [];
    for (const other of bucket) addEdge(index, other, 'replace');
    bucket.push(index);
    replacementBuckets.set(bucketKey, bucket);
  }
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'DetCorpus: Russian Word Frequency Lists for Children',
    sourceUrl: 'https://github.com/Digital-Pushkin-Lab/Russian-Word-Frequency-Lists-for-Children',
    license: 'CC0-1.0',
    frequencyUnit: 'ipm',
    wordCount: words.length,
    nodeCount: nodes.length,
    edgeCount: edges.size,
  },
  nodes,
  edges: Array.from(edges.values()),
};

const destination = resolve(outputPath);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify(payload));
console.log(`Wrote ${nodes.length} nodes and ${edges.size} edges to ${destination}`);
