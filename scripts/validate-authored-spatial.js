import fs from 'fs';
import path from 'path';

const EXPECTED_OBJECTIVE_MCOM_IDS = [7101, 7102, 7201, 7202];
const EXPECTED_CAPTURE_POINT_IDS = [201, 202, 301, 302];
const EXPECTED_NEUTRAL_CAPTURE_POINT_IDS = [203, 204, 303, 304];
const EXPECTED_OBJECTIVE_TRIGGER_IDS = [401, 402, 502, 503];
const EXPECTED_OBJECTIVE_COUNTER_WORLD_ICON_IDS = [221, 222, 322, 323];
const EXPECTED_LIVE_HQ_IDS = [1, 2, 3, 4];
const EXPECTED_PRESENCE_TRIGGER_IDS = [901, 902, 903, 904];
const EXPECTED_SPAWN_ANCHOR_IDS = [
    1411, 1412, 1413, 1414, 1415, 1421, 1422, 1423, 1424, 1425,
    2311, 2312, 2313, 2314, 2315, 2321, 2322, 2323, 2324, 2325,
    3411, 3412, 3413, 3414, 3415, 3421, 3422, 3423, 3424, 3425,
    4311, 4312, 4313, 4314, 4315, 4321, 4322, 4323, 4324, 4325,
];
const EXPECTED_POSTMATCH_OBJECTS = [
    { id: 4747, type: 'FiringRange_MatDecal_01', label: 'Postmatch runtime spawn parent' },
    { id: 4646, type: 'FixedCamera', label: 'Postmatch fixed camera' },
];
const FORBIDDEN_AUTHORING_POSTMATCH_OBJECT_IDS = [
    4545, 4546, 4547, 4548, 4550, 4551, 4552, 4553, 4554, 4555, 4556, 4557, 4558, 4559,
];
const EXPECTED_OBJECTIVE_SECTORS = [
    { sectorId: 200, capturePointIds: [201, 202], mcomIds: [7101, 7102] },
    { sectorId: 300, capturePointIds: [301, 302], mcomIds: [7201, 7202] },
    { sectorId: 210, capturePointIds: [203, 204], mcomIds: [] },
    { sectorId: 310, capturePointIds: [303, 304], mcomIds: [] },
];

function parseArgs(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--input' || arg === '-i') {
            return argv[i + 1];
        }
        if (!arg.startsWith('-')) {
            return arg;
        }
    }
    return undefined;
}

function getObjectObjId(entry) {
    const raw = entry?.ObjId;
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) ? value : undefined;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function sortedNumeric(values) {
    return [...values].sort((a, b) => a - b);
}

function sameNumberSet(actual, expected) {
    if (actual.length !== expected.length) return false;
    const actualSorted = sortedNumeric(actual);
    const expectedSorted = sortedNumeric(expected);
    for (let i = 0; i < actualSorted.length; i++) {
        if (actualSorted[i] !== expectedSorted[i]) return false;
    }
    return true;
}

function formatObjectRef(entry) {
    const objId = getObjectObjId(entry);
    const name = typeof entry?.name === 'string' ? entry.name : 'unknown';
    const type = typeof entry?.type === 'string' ? entry.type : 'unknown';
    return `${name}/${type}/${objId ?? 'no-objid'}`;
}

function fail(errors) {
    console.error('Authored spatial validation failed:');
    for (const error of errors) {
        console.error(`- ${error}`);
    }
    process.exit(1);
}

const inputPath = parseArgs(process.argv.slice(2));
if (!inputPath) {
    console.error('Usage: node scripts/validate-authored-spatial.js --input <path-to-spatial.json>');
    process.exit(1);
}

const resolvedInputPath = path.resolve(inputPath);
if (!fs.existsSync(resolvedInputPath)) {
    console.error(`Spatial export not found: ${resolvedInputPath}`);
    process.exit(1);
}

const raw = fs.readFileSync(resolvedInputPath, 'utf8');
const parsed = JSON.parse(raw);
const objects = Array.isArray(parsed?.Portal_Dynamic) ? parsed.Portal_Dynamic : undefined;
if (!objects) {
    console.error('Spatial export is missing the Portal_Dynamic array.');
    process.exit(1);
}

const objectsByPath = new Map();
const objectsByObjId = new Map();
for (const entry of objects) {
    if (typeof entry?.id === 'string') {
        objectsByPath.set(entry.id, entry);
    }
    const objId = getObjectObjId(entry);
    if (objId === undefined) continue;
    const list = objectsByObjId.get(objId) ?? [];
    list.push(entry);
    objectsByObjId.set(objId, list);
}

const errors = [];

function validateObjectIds(ids, expectedType, label) {
    for (const id of ids) {
        const matches = objectsByObjId.get(id) ?? [];
        if (matches.length !== 1) {
            errors.push(`${label} ObjId ${id} must appear exactly once, found ${matches.length}.`);
            continue;
        }
        if (expectedType && matches[0]?.type !== expectedType) {
            errors.push(`${label} ObjId ${id} must resolve to ${expectedType}, found ${formatObjectRef(matches[0])}.`);
        }
    }
}

function validateObjectiveTriggerIds(ids) {
    for (const id of ids) {
        const matches = objectsByObjId.get(id) ?? [];
        if (matches.length < 1) {
            errors.push(`Objective trigger ObjId ${id} must appear at least once, found ${matches.length}.`);
            continue;
        }

        const activeMatches = matches.filter((entry) => {
            const objectPath = typeof entry?.id === 'string' ? entry.id : '';
            return !objectPath.toLowerCase().includes('neutral');
        });
        if (activeMatches.length !== 1) {
            errors.push(`Objective trigger ObjId ${id} must have exactly one active trigger, found ${activeMatches.length}.`);
        }

        for (const match of matches) {
            if (match?.type !== 'AreaTrigger') {
                errors.push(`Objective trigger ObjId ${id} must resolve to AreaTrigger, found ${formatObjectRef(match)}.`);
            }
        }
    }
}

for (const mcomId of EXPECTED_OBJECTIVE_MCOM_IDS) {
    const matches = objectsByObjId.get(mcomId) ?? [];
    if (matches.length !== 1) {
        errors.push(`ObjId ${mcomId} must appear exactly once, found ${matches.length}.`);
        continue;
    }
    if (matches[0]?.type !== 'MCOM') {
        errors.push(`ObjId ${mcomId} must resolve to an MCOM, found ${formatObjectRef(matches[0])}.`);
    }
}

for (const capturePointId of EXPECTED_CAPTURE_POINT_IDS) {
    const matches = objectsByObjId.get(capturePointId) ?? [];
    if (matches.length !== 1) {
        errors.push(`Capture point ObjId ${capturePointId} must appear exactly once, found ${matches.length}.`);
        continue;
    }
    if (matches[0]?.type !== 'CapturePoint') {
        errors.push(
            `Capture point ObjId ${capturePointId} must resolve to a CapturePoint, found ${formatObjectRef(matches[0])}.`
        );
    }
}

for (const capturePointId of EXPECTED_NEUTRAL_CAPTURE_POINT_IDS) {
    const matches = objectsByObjId.get(capturePointId) ?? [];
    if (matches.length !== 1) {
        errors.push(`Neutral capture point ObjId ${capturePointId} must appear exactly once, found ${matches.length}.`);
        continue;
    }
    if (matches[0]?.type !== 'CapturePoint') {
        errors.push(
            `Neutral capture point ObjId ${capturePointId} must resolve to a CapturePoint, found ${formatObjectRef(matches[0])}.`
        );
    }
}

validateObjectiveTriggerIds(EXPECTED_OBJECTIVE_TRIGGER_IDS);
validateObjectIds(EXPECTED_OBJECTIVE_COUNTER_WORLD_ICON_IDS, 'WorldIcon', 'Objective counter world icon');
validateObjectIds(EXPECTED_LIVE_HQ_IDS, 'HQ_PlayerSpawner', 'Live HQ');
validateObjectIds(EXPECTED_PRESENCE_TRIGGER_IDS, 'AreaTrigger', 'Presence-grid trigger');
validateObjectIds(EXPECTED_SPAWN_ANCHOR_IDS, undefined, 'Spawn anchor');
for (const expected of EXPECTED_POSTMATCH_OBJECTS) {
    validateObjectIds([expected.id], expected.type, expected.label);
}
for (const id of FORBIDDEN_AUTHORING_POSTMATCH_OBJECT_IDS) {
    const matches = objectsByObjId.get(id) ?? [];
    if (matches.length > 0) {
        errors.push(`Runtime-spawned postmatch prop ObjId ${id} must not be authored in the spatial, found ${matches.length}.`);
    }
}

for (const expectedSector of EXPECTED_OBJECTIVE_SECTORS) {
    const sectorMatches = objectsByObjId.get(expectedSector.sectorId) ?? [];
    if (sectorMatches.length !== 1 || sectorMatches[0]?.type !== 'Sector') {
        errors.push(`Sector ${expectedSector.sectorId} must resolve exactly once as a Sector, found ${sectorMatches.length}.`);
        continue;
    }

    const sector = sectorMatches[0];
    const resolvedCapturePointIds = asArray(sector.CapturePoints)
        .map((ref) => getObjectObjId(objectsByPath.get(ref)))
        .filter((value) => value !== undefined);
    if (!sameNumberSet(resolvedCapturePointIds, expectedSector.capturePointIds)) {
        errors.push(
            `Sector ${expectedSector.sectorId} must reference CapturePoint ObjIds ${expectedSector.capturePointIds.join(', ')}, found ${resolvedCapturePointIds.join(', ') || 'none'}.`
        );
    }

    const resolvedMcomIds = asArray(sector.MCOMs)
        .map((ref) => getObjectObjId(objectsByPath.get(ref)))
        .filter((value) => value !== undefined);
    if (!sameNumberSet(resolvedMcomIds, expectedSector.mcomIds)) {
        errors.push(
            `Sector ${expectedSector.sectorId} must reference MCOM ObjIds ${expectedSector.mcomIds.join(', ')}, found ${resolvedMcomIds.join(', ') || 'none'}.`
        );
    }
}

if (errors.length > 0) {
    fail(errors);
}

console.log(`Authored spatial validation passed for ${resolvedInputPath}`);
