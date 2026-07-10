import fs from 'node:fs';
import path from 'node:path';

const inputPath = process.argv[2] ?? 'spatials/MF_CAIRO_CO.spatial.json';
const resolvedPath = path.resolve(inputPath);
const spatial = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));

if (!Array.isArray(spatial.Portal_Dynamic)) {
    throw new Error(`Spatial is missing Portal_Dynamic: ${resolvedPath}`);
}

const obsoleteIds = new Set([
    400,
    4501, 4502, 4503, 4504, 4505,
    4506, 4507, 4508, 4509, 4510,
    4511, 4512, 4513, 4514, 4515,
    4601, 4602, 4603, 4604, 4605,
    7101, 7102, 7103, 7104,
]);
const obsoletePaths = new Set([
    'CO Components/Sector_First_Half/Capture Points/CapturePointA/LootSpawner',
]);

spatial.Portal_Dynamic = spatial.Portal_Dynamic.filter((entry) => {
    const objId = Number(entry?.ObjId);
    if (Number.isFinite(objId) && obsoleteIds.has(objId)) return false;
    return !obsoletePaths.has(entry?.id);
});

for (const entry of spatial.Portal_Dynamic) {
    if (Number(entry?.ObjId) !== 200 || entry?.type !== 'Sector') continue;
    entry.MCOMs = [];
}

fs.writeFileSync(resolvedPath, `${JSON.stringify(spatial, null, 4)}\n`, 'utf8');
console.log(`Cleaned Cairo spatial: ${resolvedPath}`);
