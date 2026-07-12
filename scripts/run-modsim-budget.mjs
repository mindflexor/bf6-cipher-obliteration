import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
const reportLog = console.log.bind(console);
const reportError = console.error.bind(console);

execFileSync(process.execPath, [
  tsc, 'tools/modsim/vendor/modsim/index.ts', '--outDir', 'tools/modsim/.build',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
  '--skipLibCheck', '--esModuleInterop', '--types', 'bf6-portal-mod-types', '--declaration', 'false',
], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, [
  tsc, 'dist/bundle.ts', '--outDir', 'tools/modsim/.run', '--module', 'NodeNext',
  '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck',
  '--types', 'bf6-portal-mod-types', '--declaration', 'false',
], { cwd: root, stdio: 'inherit' });
const runBundlePath = path.join(root, 'tools/modsim/.run/bundle.js');
fs.appendFileSync(runBundlePath, `
export function __modsimGetLastRuntimeError(){ return cipherTransitionLastError; }
export function __modsimEnterPostmatch(){ enterPostmatchFromLive(team1); }
`);
const sim = await import(pathToFileURL(path.join(root, 'tools/modsim/.build/index.js')).href + `?t=${Date.now()}`);
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const apiNames = new Set(
  [...fs.readFileSync(path.join(root, 'dist/bundle.ts'), 'utf8').matchAll(/(?:\(mod as any\)|mod)\.([A-Za-z0-9_$]+)\s*\(/g)]
    .map((match) => match[1])
);
const frames = [];
let activeFrame = { scenario: 'module-import', tick: 0, total: 0, byApi: {}, byFunction: {}, byAncestor: {} };
let scriptExecutionDepth = 1;

function finishFrame() {
  frames.push(activeFrame);
}

function beginFrame(scenario, tick) {
  if (activeFrame.total > 0) finishFrame();
  activeFrame = { scenario, tick, total: 0, byApi: {}, byFunction: {}, byAncestor: {} };
}

const objectCache = new Map();
function objectFor(id = 0, type = 'Object') {
  const key = `${type}/${id}`;
  if (!objectCache.has(key)) {
    objectCache.set(key, {
      type, ObjId: Number(id) || 0,
      position: { type: 'Vector', x: Number(id) % 17, y: 0, z: Math.floor(Number(id) / 17) },
    });
  }
  return objectCache.get(key);
}

function fallback(api, args) {
  if (api === 'Message') return String(args[0] ?? '');
  if (api === 'GetObjId') return args[0]?.ObjId ?? 0;
  if (api === 'GetSoldierState') return false;
  if (api.startsWith('Is') || api.startsWith('Has') || api.startsWith('Can')) return api === 'IsPlayerValid';
  if (api === 'GetObjectPosition') return args[0]?.position ?? objectFor(0).position;
  if (api === 'GetObjectTransform') return { position: args[0]?.position ?? objectFor(0).position };
  if (api.startsWith('Get') || api.startsWith('Create') || api.startsWith('Spawn')) {
    return objectFor(args[0], api.replace(/^(Get|Create|Spawn)/, '') || 'Object');
  }
  if (api === 'CountOf') return args[0]?.array?.length ?? args[0]?.length ?? 0;
  if (api === 'ValueInArray') return args[0]?.array?.[args[1]] ?? args[0]?.[args[1]];
  return undefined;
}

const enumProxy = new Proxy({}, { get: (_target, property) => String(property) });
function getBundleCallers() {
  const lines = (new Error().stack ?? '').split('\n').slice(1);
  return lines
    .filter((line) => line.replaceAll('\\', '/').includes('tools/modsim/.run/bundle.js'))
    .map((line) => line.match(/at\s+([^\s(]+)/)?.[1] ?? '<bundle>');
}
const countedMod = new Proxy(sim.modmap, {
  get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value === 'function') {
      return (...args) => {
        const callers = scriptExecutionDepth > 0 ? getBundleCallers() : [];
        const caller = callers[0];
        if (caller) {
          const api = String(property);
          activeFrame.total += 1;
          activeFrame.byApi[api] = (activeFrame.byApi[api] ?? 0) + 1;
          activeFrame.byFunction[caller] = (activeFrame.byFunction[caller] ?? 0) + 1;
          for (const ancestor of new Set(callers.slice(1))) activeFrame.byAncestor[ancestor] = (activeFrame.byAncestor[ancestor] ?? 0) + 1;
        }
        return Reflect.apply(value, target, args);
      };
    }
    if (value !== undefined) return value;
    if (apiNames.has(String(property))) {
      return (...args) => {
        const api = String(property);
        const callers = scriptExecutionDepth > 0 ? getBundleCallers() : [];
        const caller = callers[0];
        if (caller) {
          activeFrame.total += 1;
          activeFrame.byApi[api] = (activeFrame.byApi[api] ?? 0) + 1;
          activeFrame.byFunction[caller] = (activeFrame.byFunction[caller] ?? 0) + 1;
          for (const ancestor of new Set(callers.slice(1))) activeFrame.byAncestor[ancestor] = (activeFrame.byAncestor[ancestor] ?? 0) + 1;
        }
        return fallback(api, args);
      };
    }
    return enumProxy;
  },
});
globalThis.mod = countedMod;

const loadedScript = await import(pathToFileURL(runBundlePath).href + `?t=${Date.now()}`);
scriptExecutionDepth = 0;
finishFrame();

let simulationTick = 0;
let ongoingScenario = 'startup-settle-16p';
const script = {};
for (const [name, value] of Object.entries(loadedScript)) {
  if (typeof value !== 'function' || (!name.startsWith('On') && !name.startsWith('Ongoing'))) {
    script[name] = value;
    continue;
  }
  script[name] = (...args) => {
    scriptExecutionDepth += 1;
    try { return value(...args); }
    finally { scriptExecutionDepth -= 1; }
  };
}
const originalOngoing = script.OngoingGlobal;
script.OngoingGlobal = () => {
  simulationTick += 1;
  beginFrame(ongoingScenario, simulationTick);
  return originalOngoing();
};

const objects = [];
for (let id = 1; id <= 6; id++) objects.push({ ...objectFor(id, 'HQ_PlayerSpawner'), type: 'HQ_PlayerSpawner', Team: id % 2 ? 'Team1' : 'Team2' });
for (let id = 1; id <= 4200; id++) {
  if (id <= 40 || (id >= 3000 && id <= 3200) || (id >= 4000 && id <= 4100)) {
    objects.push({ ...objectFor(id, 'SpatialObject'), type: 'SpatialObject' });
  }
}
for (let id = 11; id <= 14; id++) objects.push({ ...objectFor(id, 'PlayerSpawner'), type: 'PlayerSpawner', SpawnPoints: [] });
for (const id of [1001, 1002, 1003, 1004, 1011, 1012, 1013, 1014, 2001, 2002, 2003, 2004]) objects.push({ ...objectFor(id, 'InteractPoint'), type: 'InteractPoint' });
for (const id of [201, 202, 203, 204, 301, 302, 303, 304]) objects.push({ ...objectFor(id, 'CapturePoint'), type: 'CapturePoint' });

beginFrame('level-load', 0);
sim.LoadLevel(script, { Portal_Dynamic: objects });
finishFrame();

beginFrame('join-burst-16p', 0);
const players = [];
for (let i = 0; i < 16; i++) players.push(sim.AddPlayer());
finishFrame();

beginFrame('game-start-16p', 0);
sim.StartGameMode();
finishFrame();

await sim.StepFrames(360);
beginFrame('all-ready-event-burst-16p', simulationTick);
for (const player of players) {
  const readyId = player.team === 1 ? 2002 : 2004;
  script.OnPlayerInteract(player, objectFor(readyId, 'InteractPoint'));
}
finishFrame();
ongoingScenario = 'ready-to-live-16p';
await sim.StepFrames(600);
beginFrame('postmatch-entry-16p', simulationTick);
scriptExecutionDepth += 1;
try { loadedScript.__modsimEnterPostmatch(); }
finally { scriptExecutionDepth -= 1; }
finishFrame();
ongoingScenario = 'postmatch-16p';
await sim.StepFrames(600);
if (activeFrame.total > 0) finishFrame();

const uniqueFrames = frames.filter((frame, index) => index === 0 || frame !== frames[index - 1]);
let failed = false;
for (const frame of uniqueFrames) {
  if (frame.total >= 500) {
    reportError(`Portal hard limit reached: ${frame.scenario} tick ${frame.tick}: ${frame.total}`);
    failed = true;
  }
  if (frame.total > 400) {
    reportError(`Managed frame budget exceeded: ${frame.scenario} tick ${frame.tick}: ${frame.total}`);
    failed = true;
  }
}

const peak = uniqueFrames.reduce((best, frame) => frame.total > best.total ? frame : best, uniqueFrames[0]);
reportLog(`ModSim budget: ${uniqueFrames.length} frames, peak ${peak.total} calls (${peak.scenario} tick ${peak.tick})`);
reportLog(`Peak APIs: ${Object.entries(peak.byApi).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => `${name}=${count}`).join(', ')}`);
for (const scenario of [...new Set(uniqueFrames.map((frame) => frame.scenario))]) {
  const scenarioPeak = uniqueFrames.filter((frame) => frame.scenario === scenario)
    .reduce((best, frame) => frame.total > best.total ? frame : best);
  reportLog(`  ${scenario}: peak ${scenarioPeak.total} calls at tick ${scenarioPeak.tick}`);
}
for (const frame of uniqueFrames.filter((item) => item.total > 400).sort((a, b) => b.total - a.total).slice(0, 6)) {
  reportLog(`  violation ${frame.scenario}/${frame.tick}: ${Object.entries(frame.byApi).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name}=${count}`).join(', ')}`);
  reportLog(`    functions: ${Object.entries(frame.byFunction).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([name, count]) => `${name}=${count}`).join(', ')}`);
  reportLog(`    ancestors: ${Object.entries(frame.byAncestor).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([name, count]) => `${name}=${count}`).join(', ')}`);
}
if (failed && typeof loadedScript.__modsimGetLastRuntimeError === 'function') {
  reportLog(`Last runtime error: ${loadedScript.__modsimGetLastRuntimeError()}`);
}
if (failed) process.exit(1);
