import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const activeRoots = [
    'src/squad-obliteration/runtime',
    'src/squad-obliteration/config',
    'src/squad-obliteration/modules',
    'src/squad-obliteration/state',
    'src/squad-obliteration/events',
    'src/squad-obliteration/services',
    'src/strings.json',
];

function collectFiles(relativePath) {
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute)) return [];
    const stat = fs.statSync(absolute);
    if (stat.isFile()) return [absolute];
    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
        collectFiles(path.join(relativePath, entry.name))
    );
}

const files = activeRoots.flatMap(collectFiles).filter((file) => /\.(?:ts|json)$/.test(file));
const rules = [
    ['native CapturePoint gameplay event', /OnCapturePoint(?:Captured|Lost|Capturing)|OnPlayer(?:Enter|Exit)CapturePoint/i],
    ['native CapturePoint polling or timing', /GetPlayersOnPoint|GetCaptureProgress|SetCapturePointCapturingTime|SetCapturePointNeutralizationTime|SetMaxCaptureMultiplier/i],
    ['capture UI state or widget', /FriendlyCap|OpponentCap|EnemyCap|CapProgress|ActiveFlag/i],
    ['native MCOM or Rush logic', /MCOM|MCom|Rush_/],
    ['Domination naming', /Domination/i],
    ['obsolete Squad Obliteration naming', /Squad Obliteration/i],
    ['legacy PlayerSpawner route', /PlayerSpawner/i],
    ['parallel event or timer runtime', /bf6-portal-utils\/(?:events|timers)|\bTimers\./i],
    ['commented or callable legacy runtime', /Legacy_Mode|legacy synchronous/i],
    ['forbidden absent Cairo id', /\b(?:7001|5101|5102|6001|3111)\b/],
    ['forbidden absent Cairo VFX id', /\b(?:33[1-9]|34[0-9])\b/],
];

const failures = [];
for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);
    for (const [label, pattern] of rules) {
        for (let index = 0; index < lines.length; index += 1) {
            if (pattern.test(lines[index])) {
                failures.push(`${path.relative(root, file)}:${index + 1}: ${label}: ${lines[index].trim()}`);
            }
        }
    }
}

const bundlePath = path.join(root, 'dist', 'bundle.ts');
if (fs.existsSync(bundlePath)) {
    const bundleStat = fs.statSync(bundlePath);
    const newestSourceMtime = Math.max(...files.map((file) => fs.statSync(file).mtimeMs));
    if (bundleStat.mtimeMs >= newestSourceMtime) {
        if (bundleStat.size >= 942_672) {
            failures.push(`dist/bundle.ts is ${bundleStat.size} bytes; expected smaller than the 942672-byte baseline.`);
        }
        const bundleText = fs.readFileSync(bundlePath, 'utf8');
        for (const [label, pattern] of rules) {
            if (pattern.test(bundleText)) failures.push(`dist/bundle.ts: ${label}`);
        }
    }
}

if (failures.length > 0) {
    console.error(`Cipher-only guard failed with ${failures.length} violation(s):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log(`Cipher-only guard passed across ${files.length} active source files.`);
}
