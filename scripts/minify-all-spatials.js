/**
 * Cross-platform script to run spatial-minifier.js on every build-input JSON file in ./spatials.
 * Outputs to ./dist/spatials/ with the same filenames after clearing stale JSON artifacts.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const spatialsDir = path.join(rootDir, 'spatials');
const distSpatialsDir = path.join(rootDir, 'dist', 'spatials');

fs.mkdirSync(distSpatialsDir, { recursive: true });

for (const file of fs.readdirSync(distSpatialsDir).filter((f) => f.endsWith('.json'))) {
    fs.unlinkSync(path.join(distSpatialsDir, file));
}

const files = fs.readdirSync(spatialsDir).filter((f) => f.endsWith('.json'));

if (files.length === 0) {
    console.log('No JSON files found in spatials/');
    process.exit(0);
}

let hadError = false;

for (const file of files) {
    const inputPath = path.join(spatialsDir, file);
    const outPath = path.join(distSpatialsDir, file);

    const result = spawnSync(process.execPath, ['spatial-minifier.js', '--out', outPath, '--input', inputPath], {
        cwd: __dirname,
        stdio: 'inherit',
    });

    if (result.status !== 0) {
        hadError = true;
    }
}

process.exit(hadError ? 1 : 0);
