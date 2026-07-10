import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_OBJECTS = [
    ...[1, 2, 3, 4, 8888, 8889].map((id) => ({ id, type: 'HQ_PlayerSpawner', label: 'HQ' })),
    ...[201, 202, 203, 204, 301, 302, 303, 304].map((id) => ({ id, type: 'CapturePoint', label: 'display CapturePoint' })),
    ...[401, 402, 403, 404, 889, 901, 902, 903, 904, 7003, 9999].map((id) => ({ id, type: 'AreaTrigger', label: 'AreaTrigger' })),
    ...[2001, 2002, 2003, 2004, 2101, 2102, 2103, 2104].map((id) => ({ id, type: 'InteractPoint', label: 'InteractPoint' })),
    ...[221, 222, 223, 321, 890, 891, 5001, 5002, 5003, 5004].map((id) => ({ id, type: 'WorldIcon', label: 'WorldIcon' })),
    ...[8085, 8086].map((id) => ({ id, type: 'AI_Spawner', label: 'bot spawner' })),
    { id: 200, type: 'Sector', label: 'first-half sector' },
    { id: 300, type: 'Sector', label: 'second-half sector' },
    { id: 3100, type: 'Sector', label: 'key-anchor sector' },
    { id: 4646, type: 'FixedCamera', label: 'postmatch camera' },
    { id: 4747, type: 'FiringRange_MatDecal_01', label: 'postmatch anchor' },
];

const REQUIRED_SPATIAL_ANCHORS = [
    215, 216, 217, 218, 3101, 3102, 3103,
    1411, 1412, 1413, 1414, 1415, 1421, 1422, 1423, 1424, 1425,
    2311, 2312, 2313, 2314, 2315, 2321, 2322, 2323, 2324, 2325,
    3411, 3412, 3413, 3414, 3415, 3421, 3422, 3423, 3424, 3425,
    4311, 4312, 4313, 4314, 4315, 4321, 4322, 4323, 4324, 4325,
    1511, 1512, 1513, 1514, 3511, 3512, 3513, 3514,
];

const REQUIRED_NODE_VISUALS = [
    ...[211, 212, 213, 311].map((id) => ({ id, type: 'FX_Car_Fire_M_GS' })),
    ...[611, 612, 613, 711].map((id) => ({ id, type: 'FX_CarFire_FrameCrawl' })),
    ...[8101, 8102, 8103, 8201].map((id) => ({ id, type: 'FX_Vehicle_Car_Destruction_Death_Explosion_PTV' })),
];

const FORBIDDEN_IDS = new Set([
    400, 7001, 5101, 5102, 6001, 3111, 7101, 7102, 7103, 7104, 7201, 7202,
    331, 332, 333, 334, 335, 336, 337, 338, 339, 340,
    341, 342, 343, 344, 345, 346, 347, 348, 349,
    4501, 4502, 4503, 4504, 4505, 4506, 4507, 4508, 4509, 4510,
    4511, 4512, 4513, 4514, 4515, 4601, 4602, 4603, 4604, 4605,
]);

const FORBIDDEN_PATHS = new Set([
    'CO Components/Sector_First_Half/Capture Points/CapturePointA/LootSpawner',
]);

const REQUIRED_SPATIAL_PATHS = new Set([
    'CombatArea',
    'CombatArea/AreaTrigger',
    'Camera3D/DeployCam',
]);

function parseInput(argv) {
    const index = argv.findIndex((arg) => arg === '--input' || arg === '-i');
    if (index >= 0) return argv[index + 1];
    return argv.find((arg) => !arg.startsWith('-'));
}

function objIdOf(entry) {
    const value = Number(entry?.ObjId);
    return Number.isFinite(value) ? value : undefined;
}

function sameNumbers(actual, expected) {
    const left = [...actual].map(Number).sort((a, b) => a - b);
    const right = [...expected].map(Number).sort((a, b) => a - b);
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

const inputPath = parseInput(process.argv.slice(2));
if (!inputPath) throw new Error('Usage: node scripts/validate-authored-spatial.js --input <spatial.json>');

const resolvedPath = path.resolve(inputPath);
const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
const objects = parsed?.Portal_Dynamic;
if (!Array.isArray(objects)) throw new Error(`Missing Portal_Dynamic array: ${resolvedPath}`);

const byId = new Map();
const byPath = new Map();
const errors = [];
for (const entry of objects) {
    if (typeof entry?.id === 'string') {
        if (byPath.has(entry.id)) errors.push(`Duplicate spatial path ${entry.id}.`);
        byPath.set(entry.id, entry);
    }
    const id = objIdOf(entry);
    if (id === undefined) continue;
    const matches = byId.get(id) ?? [];
    matches.push(entry);
    byId.set(id, matches);
}

const requireObject = ({ id, type, label = 'object' }) => {
    const matches = byId.get(id) ?? [];
    if (matches.length !== 1) {
        errors.push(`${label} ${id} must appear exactly once; found ${matches.length}.`);
        return;
    }
    if (type && matches[0]?.type !== type) {
        errors.push(`${label} ${id} must be ${type}; found ${matches[0]?.type ?? 'unknown'}.`);
    }
};

for (const [id, matches] of byId) {
    if (matches.length > 1) errors.push(`ObjId ${id} is duplicated ${matches.length} times.`);
}
for (const required of REQUIRED_OBJECTS) requireObject(required);
for (const id of REQUIRED_SPATIAL_ANCHORS) requireObject({ id, type: 'FiringRange_MatDecal_01', label: 'spatial anchor' });
for (const required of REQUIRED_NODE_VISUALS) requireObject({ ...required, label: 'node visual' });

for (const id of FORBIDDEN_IDS) {
    if ((byId.get(id) ?? []).length > 0) errors.push(`Forbidden legacy ObjId ${id} is still authored.`);
}
for (const objectPath of FORBIDDEN_PATHS) {
    if (byPath.has(objectPath)) errors.push(`Forbidden legacy object is still authored: ${objectPath}`);
}
for (const objectPath of REQUIRED_SPATIAL_PATHS) {
    if (!byPath.has(objectPath)) errors.push(`Required spatial-only object is missing: ${objectPath}`);
}
if (objects.some((entry) => entry?.type === 'MCOM')) errors.push('The Cipher spatial must not contain native MCOM objects.');

for (const entry of objects) {
    for (const referenceField of ['CapturePoints', 'MCOMs', 'InfantrySpawns']) {
        for (const reference of entry?.[referenceField] ?? []) {
            if (!byPath.has(reference)) {
                errors.push(`${entry.id ?? entry.ObjId ?? 'unknown'} ${referenceField} references missing object ${reference}.`);
            }
        }
    }
}

for (const expectation of [
    { id: 200, capturePoints: [201, 202, 203, 204] },
    { id: 300, capturePoints: [301, 302, 303, 304] },
]) {
    const sector = (byId.get(expectation.id) ?? [])[0];
    if (!sector) continue;
    const cpIds = (sector.CapturePoints ?? []).map((ref) => objIdOf(byPath.get(ref))).filter(Number.isFinite);
    if (!sameNumbers(cpIds, expectation.capturePoints)) {
        errors.push(`Sector ${expectation.id} CapturePoints must be ${expectation.capturePoints.join(', ')}; found ${cpIds.join(', ') || 'none'}.`);
    }
    if ((sector.MCOMs ?? []).length > 0) errors.push(`Sector ${expectation.id} must not reference MCOMs.`);
}

for (const id of [1, 2, 3, 4, 8888, 8889]) {
    const hq = (byId.get(id) ?? [])[0];
    if (!hq) continue;
    for (const spawnRef of hq.InfantrySpawns ?? []) {
        if (!byPath.has(spawnRef)) errors.push(`HQ ${id} references missing SpawnPoint ${spawnRef}.`);
    }
}

if (errors.length > 0) {
    console.error('Cairo spatial validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
}

console.log(`Cairo spatial validation passed: ${resolvedPath}`);
