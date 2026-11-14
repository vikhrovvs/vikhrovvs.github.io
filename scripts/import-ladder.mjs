import fs from 'node:fs';
import { mergeArchive } from './ladder-archive.mjs';

const target = new URL('../data/ladder-graph/archive.json', import.meta.url);
if (process.argv.length !== 3) throw new Error('Usage: node scripts/import-ladder.mjs <export.json>');
const base = JSON.parse(fs.readFileSync(target, 'utf8'));
const patch = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const merged = mergeArchive(base, patch);
// Keep a local backup; neither file is published or tracked by Git.
fs.copyFileSync(target, new URL('./archive.previous.json', target));
const temporary = new URL('./archive.next.json', target);
fs.writeFileSync(temporary, JSON.stringify(merged));
fs.renameSync(temporary, target);
console.log(`Archive updated: ${base.games.length} → ${merged.games.length} games, through ${merged.throughDate}`);
