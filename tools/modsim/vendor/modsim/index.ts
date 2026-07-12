import * as modmap from './modsim.js';
export {
    AddPlayer,
    DeployPlayer,
    AllLevelObjects,
    GetInteractPoints,
    KillPlayer,
    LoadLevel,
    Loop,
    StartGameMode,
    RemovePlayer,
    Reset,
    WaitTimeout,
    SendPlayerUIButtonEvent,
    SetStrings,
    UIImageTypeToString,
    UIWidget,
    ModObject,
    PrefabObject,
    DumpUITree,
    aiSpawns,
    uiRoot,
    ArmMCOM,
    StepFrames,
    SIM_TICK_TIME
} from './modsim.js';
export { modmap };

globalThis.mod = modmap as any;
