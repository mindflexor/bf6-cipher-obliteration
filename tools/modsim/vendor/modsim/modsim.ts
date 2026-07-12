interface ModVariable {
    isGlobal: boolean;
    index: number;
    object?: ModObject;
}

export interface Vector {
    type: 'Vector';
    x: number;
    y: number;
    z: number;
}

export interface Transform {
    type: 'Transform';
    position: Vector;
    rotation: Vector;
}

export interface ModObject {
    type: string;
    ObjId: number;
    id?: string; // should be unique
    position?: Vector;
    right?: Vector;
    up?: Vector;
    front?: Vector;
    name?: string;
}

// Import weapon-related and audio enums from separate files
import {
    PrimaryWeapons,
    SecondaryWeapons,
    Weapons,
    WeaponAttachments,
    RuntimeSpawn_Common,
    RuntimeSpawn_Abbasid,
    RuntimeSpawn_Aftermath,
    VoiceOverEvents2D,
    VoiceOverFlags,
    MusicEvents,
    MusicPackages,
    MusicParams,
} from './enums/index.js';
export {
    PrimaryWeapons,
    SecondaryWeapons,
    Weapons,
    WeaponAttachments,
    RuntimeSpawn_Common,
    RuntimeSpawn_Abbasid,
    RuntimeSpawn_Aftermath,
    VoiceOverEvents2D,
    VoiceOverFlags,
    MusicEvents,
    MusicPackages,
    MusicParams,
};

export enum Gadgets {
    CallIn_Air_Strike = 200,
    CallIn_Ammo_Drop,
    CallIn_Anti_Vehicle_Drop,
    CallIn_Artillery_Strike,
    CallIn_Mobile_Redeploy,
    CallIn_Smoke_Screen,
    CallIn_UAV_Overwatch,
    CallIn_Weapon_Drop,
    Class_Adrenaline_Injector,
    Class_Motion_Sensor,
    Class_Repair_Tool,
    Class_Supply_Bag,
    Deployable_Cover,
    Deployable_Deploy_Beacon,
    Deployable_EOD_Bot,
    Deployable_Grenade_Intercept_System,
    Deployable_Missile_Intercept_System,
    Deployable_Portable_Mortar,
    Deployable_Recon_Drone,
    Deployable_Vehicle_Supply_Crate,
    Launcher_Aim_Guided,
    Launcher_Air_Defense,
    Launcher_Auto_Guided,
    Launcher_Breaching_Projectile,
    Launcher_High_Explosive,
    Launcher_Incendiary_Airburst,
    Launcher_Long_Range,
    Launcher_Smoke_Grenade,
    Launcher_Thermobaric_Grenade,
    Launcher_Unguided_Rocket,
    Melee_Combat_Knife,
    Melee_Hunting_Knife,
    Melee_Sledgehammer,
    Misc_Acoustic_Sensor_AV_Mine,
    Misc_Anti_Personnel_Mine,
    Misc_Anti_Vehicle_Mine,
    Misc_Assault_Ladder,
    Misc_Defibrillator,
    Misc_Demolition_Charge,
    Misc_Incendiary_Round_Shotgun,
    Misc_Laser_Designator,
    Misc_Sniper_Decoy,
    Misc_Supply_Pouch,
    Misc_Tracer_Dart,
    Misc_Tripwire_Sensor_AV_Mine,
    Throwable_Anti_Vehicle_Grenade,
    Throwable_Flash_Grenade,
    Throwable_Fragmentation_Grenade,
    Throwable_Incendiary_Grenade,
    Throwable_Mini_Frag_Grenade,
    Throwable_Proximity_Detector,
    Throwable_Smoke_Grenade,
    Throwable_Stun_Grenade,
    Throwable_Throwing_Knife,
}

export enum OpenGadgets {
    UnguidedRocketLauncher = 600,
}

export enum MeleeWeapons {
    Sledgehammer = 300,
    KaBar,
}

export enum Throwables {
    ThrowingKnife = 400,
    FragGrenade,
    IncendiaryGrenade,
    SmokeGrenade,
    ProximityGrenade,
    ImpactGrenade,
    AntiTankGrenade,
    ConcussionGrenade,
    FlashGrenade,
    MiniV40,
}

export enum MiscGadgets {
    SoftArmor = 500,
    CeramicArmor,
    AntiVehicleCallin,
    PowerWeaponsCallin,
    SupplyCallin,
    WeaponCallin,
    AirStrikeCallin,
    ArtilleryStrikeCallin,
    KineticStrikeCallin,
    MobileRespawnCallin,
    SmokescreenCallin,
    UAVCallin,
}

export enum Maps {
    Abbasid,
    Aftermath,
    Badlands,
    Battery,
    Capstone,
    Dumbo,
    Eastwood,
    Firestorm,
    Granite_ClubHouse,
    Granite_MainStreet,
    Granite_Marina,
    Granite_TechCampus,
    Limestone,
    Outskirts,
    Sand,
    Tungsten,
}

enum MedGadgetTypes {
    MedKit = 600,
    MedicCrate,
}

export enum VehicleStateVector {
    FacingDirection,
    LinearVelocity,
    VehiclePosition,
}

const spawnerType = 'AI_Spawner';
const spawnPointType = 'SpawnPoint';
const hqType = 'HQ_PlayerSpawner';
const playerSpawnerType = 'PlayerSpawner';
const worldIconType = 'WorldIcon';
const mcomType = 'MCOM';
const interactPointType = 'InteractPoint';
const capturePointType = 'CapturePoint';
const sectorType = 'Sector';
const volumeType = 'PolygonVolume';

interface Team extends ModObject {
    type: 'Team';
}

interface Squad extends ModObject {
    type: 'Squad';
}

export interface UIWidget {
    type: 'UIWidget';
    uiType: 'Container' | 'Button' | 'Text' | 'Image' | 'Checkbox';
    name: string;
    children: UIWidget[];
    visible: boolean;
    textLabel?: string;
    textColor?: Vector;
    position?: Vector;
    size?: Vector;
    padding?: number;
    anchor?: UIAnchor;
    parent?: UIWidget;
    zIndex?: number;
    textOffset?: Vector;
    textSize?: number;
    textAlpha?: number;
    textAnchor?: UIAnchor;
    bgFill?: UIBgFill;
    bgOffset?: Vector;
    bgSize?: number;
    bgAnchor?: UIAnchor;
    bgColor?: Vector;
    bgAlpha?: number;
    textAlignment?: number;
    buttonEnabled?: boolean;
    buttonColorBase?: Vector;
    buttonAlphaBase?: number;
    buttonColorDisabled?: Vector;
    buttonAlphaDisabled?: number;
    buttonColorPressed?: Vector;
    buttonAlphaPressed?: number;
    buttonColorHover?: Vector;
    buttonAlphaHover?: number;
    buttonColorFocused?: Vector;
    buttonColorFocusedAlpha?: number;
    imageType?: UIImageType;
    restrict?: Player | Team;
    depth?: UIDepth;
}

type InventoryType =
    | PrimaryWeapons
    | SecondaryWeapons
    | OpenGadgets
    | MeleeWeapons
    | Throwables
    | MiscGadgets
    | undefined;

export interface Controllable {}
export interface Soldier extends Controllable {
    type: 'Soldier';
    weaponsSlots: { [slot: number]: Weapons | Gadgets | null };
    weapon?: Weapons | Gadgets | null;
}

export interface Vehicle extends Controllable {
    type: 'Vehicle';
}

export interface Player extends ModObject {
    type: 'Player';
    team: number;
    isAlive: boolean;
    isAISoldier: boolean;
    isInteracting: boolean;
    linearVelocity: Vector;
    position?: Vector;
    facingDirection: Vector;
    eyePosition: Vector;
    currentHealth: number;
    maxHealth: number;
    normalizedHealth: number;
    currentWeaponAmmo: number;
    currentWeaponMagazineAmmo: number;
    inventory: InventoryType[];
    soldier?: Soldier;
    vehicle?: Vehicle;
    speed: number;
    armorType: ArmorTypes;
    aiMoveSpeed?: MoveSpeed;
    aiStance?: Stance;
    deployEnabled?: boolean;
    soldierClass?: SoldierClass;
}

interface MCOM extends ModObject {
    type: 'MCOM';
    Enabled: boolean;
    FuseTime: number;
    // computed
    fuseTimer: number;
}

interface Message {
    type: 'Message';
    format: string;
    text: string;
}

interface WorldIcon {
    type: 'WorldIcon';
    id: number;
    position?: Vector;
    team: number;
    image?: UIImageType;
    enableImage?: boolean;
    enableText?: boolean;
    color?: Vector;
    text?: string;
}

interface SpawnPoint extends ModObject {
    type: 'SpawnPoint';
    position: Vector;
    team: number;
}

interface HeadQuarters extends ModObject {
    type: 'HeadQuarters';
    name: string;
    ObjId: number;
    Team: string;
    AltTeam: string;
    team: number;
    position: Vector;
    InfantrySpawns: string[];
    HQEnabled: boolean;
}

interface PlayerSpawner extends ModObject {
    type: 'PlayerSpawner';
    name: string;
    ObjId: number;
    SpawnPoints: string[];
}

interface InteractPoint extends ModObject {
    type: 'InteractPoint';
    enabled: boolean;
}

interface Spawner extends ModObject {
    type: 'Spawner';
}

interface CapturePoint extends ModObject {
    type: 'CapturePoint';
    currentOwnerTeam: Team;
    previousOwnerTeam: Team;
    capturingTime: number;
    neutralizationTime: number;
    maxCaptureMultiplier: number;
    // computed
    captureRadius: number; // warning, not the real behavior
    currentPlayersInArea: number[];
    captureProgress: number; // warning, not the real behavior
}

interface Sector extends ModObject {
    type: 'Sector';
    SectorEnabled: boolean;
    CapturePoints: string[]; //?
    MCOMs: string[]; //?
}

export interface PrefabObject extends ModObject {
    type: 'Prefab';
    prefab: mod.RuntimeSpawn_Common | mod.RuntimeSpawn_Abbasid;
}

export interface VFX extends PrefabObject {
    enabled: boolean;
}

type SFX = PrefabObject;

interface PolygonVolume {
    type: 'PolygonVolume';
    id: string;
}

class ModArray {
    array: mod.Any[] = [];
}

const allPlayers: ModArray = {
    array: [],
};

const allCapturePoints: ModArray = {
    array: [],
};

const allVehicles = new ModArray();

export let winningTeam: Team | null = null;

export const uiRoot: UIWidget = {
    type: 'UIWidget',
    uiType: 'Container',
    name: 'Root',
    visible: true,
    children: [],
    position: { type: 'Vector', x: 0, y: 0, z: 0 },
};

const initialGameModeTime = -1000;
let gameModeTime = initialGameModeTime; // -1000 hacky way to use gameModeTime for Wait before the game mode starts
let gameModeTimeLimit = 20 * 60;
let gameModeTimePaused = false;
let gameModeTargetScore = 100;
let gameModeScore = Array(16).fill(0);

let scoreboardType;

let mcoms: { [id: number]: MCOM } = {};
let aiSpawners: { [id: number]: Spawner } = {};
let spawnPoints: { [id: string]: SpawnPoint } = {};
let interactPoints: { [id: string]: InteractPoint } = {};
let hqs: { [id: number]: HeadQuarters } = {};
let playerSpawners: { [id: number]: PlayerSpawner } = {};
let worldIcons: { [id: number]: WorldIcon } = {};
let capturePoints: { [id: number]: CapturePoint } = {};
let sectors: { [id: number]: Sector } = {};

let volumes: { [id: string]: PolygonVolume } = {};

const zero = CreateVector(0, 0, 0);

export enum RestrictedInputs {
    Zoom,
    Jump,
    Sprint,
    Interact,
    Reload,
    CycleFire,
    SelectPrimary,
    SelectSecondary,
    SelectCharacterGadget,
    SelectOpenGadget,
    MoveLeftRight,
    FireWeapon,
    CameraPitch,
    CameraYaw,
    Prone,
    SelectThrowable,
    MoveForwardBack,
    SelectMelee,
    Crouch,
    CyclePrimary,
}

export enum UIBgFill {
    None,
    Solid,
    Blur,
    OutlineThick,
    OutlineThin,
    GradientTop,
    GradientBottom,
    GradientLeft,
    GradientRight,
}

export enum UIAnchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

export enum Stance {
    Stand,
    Crouch,
    Prone,
}

export enum MoveSpeed {
    InvestigateSlowWalk,
    InvestigateWalk,
    Patrol,
    Walk,
    Run,
    InvestigateRun,
    Sprint,
}

export enum UIImageType {
    None,
    TEMP_PortalIcon,
    CrownSolid,
    CrownOutline,
    C4,
    ATMine,
    MedicBag,
    Panzerfaust3,
    DeployableCover,
    TUGS,
    SupplyBag,
    Defibrillator,
    AmmoCrate,
    PistolAmmo,
    RifleAmmo,
    SelfHeal,
    SpawnBeacon,
    QuestionMark,
    KORD6P67,
    M240B,
    SVChChukavin,
    SVD,
    M24,
    M4A2,
    Cobra_RCE,
    AKS74U,
    Mossberg,
    M98B,
    M39EMR,
    M249,
    M416,
    MP7A2,
    XM8C,
    XM8,
    XM8LMG,
    MP9,
    PKP,
    SCARH,
    PP2000,
    AN94,
    P90,
    AK12,
}

export function UIImageTypeToString(type: UIImageType): string {
    return UIImageType[type];
}

export enum InventoryModifiers {
    M4A1_SCP_RMR,
    M4A1_SCP_TrijiconMRO,
    M4A1_SCP_TrijiconSDO,
    M4A1_SCP_TrijiconVCOG,
    M4A1_SCP_NX81,
    M4A1_SCP_Mark4M2,
    M4A1_SCP_VortexM157,
    M4A1_SCP_VZOR3,
    M4A1_SCP_1P781P,
    M4A1_SCP_Tango6T,
    M4A1_BTM_MSBS,
    M4A1_FlashHider,
    M4A1_BRL_ExtendedBarrel,
    M4A1_MAG_FastReload,
    M4A1_SCP_XPS3,
    MPX_BTM_EvoHandStop,
    MPX_MAG_ExtendedMag,
    MPX_FastDeploy,
    MPX_MoveAccuracy,
    'MPX_SCP_OPK-7Extended',
    M2010_SCP_Mark4M5A2,
    M2010_MAG_ExtendedMag,
    M2010_MZL_AACTitanQD,
    M2010_GRP_CVLIFE,
}

export enum UIDepth {
    BelowGameUI,
    AboveGameUI,
}

export enum UIButtonEvent {
    ButtonDown,
    ButtonUp,
    FocusIn,
    FocusOut,
    HoverIn,
    HoverOut,
}

export enum SoldierStateBool {
    IsAlive,
    IsBeingRevived,
    IsCrouching,
    IsDead,
    IsFiring,
    IsInAir,
    IsInteracting,
    IsInWater,
    IsJumping,
    IsManDown,
    IsOnGround,
    IsParachuting,
    IsProne,
    IsReloading,
    IsReviving,
    IsSprinting,
    IsStanding,
    IsVaulting,
    IsZooming,
    IsAISoldier,
    IsInVehicle,
}

export enum SoldierStateVector {
    GetLinearVelocity = 50,
    GetPosition,
    GetFacingDirection,
    EyePosition,
}

export enum SoldierStateNumber {
    CurrentHealth = 100,
    Speed,
    MaxHealth,
    NormalizedHealth,
    CurrentWeaponAmmo,
    CurrentWeaponMagazineAmmo,
}

export enum SpawnModes {
    Deploy,
    AutoSpawn,
    Spectating,
}

export enum SoldierClass {
    Assault,
    Recon,
    Engineer,
    Support,
}

export enum VehicleList {
    Abrams,
    Leopard,
    Cheetah,
    CV90,
    Gepard,
    Stationary_BGM71TOW,
    Stationary_GDF009,
    M2MG,
    UH60,
    MH6M,
    Eurocopter,
    AH6M,
    Helicopter_AH64E,
    CWS_SPIKE,
    CWS_HMG,
    CWS_AGL,
    CWS,
    Vector,
    Quadbike,
    PTV,
    Marauder,
    Flyer60,
    RHIB,
    MQ9,
    JAS39,
    F22,
    F16,
}

export enum ScoreboardType {
    NotSet,
    DefaultFFA,
    Off,
    CustomTwoTeams,
    CustomFFA,
}

export enum InventorySlots {
    PrimaryWeapon = 1000,
    SecondaryWeapon,
    GadgetOne,
    GadgetTwo,
    Throwable,
    MeleeWeapon,
    ClassGadget,
    MiscGadget,
}

export enum ArmorTypes {
    NoArmor,
    SoftArmor,
    CeramicArmor,
}

export enum WorldIconImages {
    Skull,
    Assist,
    SquadPing,
    Alert,
    Explosion,
    BombArmed,
    Hazard,
    Flag,
    Bomb,
    Diffuse,
    EMP,
    DangerPing,
    FilledPing,
    Cross,
    Triangle,
    Eye,
}

export enum Types {
    String,
    Number,
    Boolean,
    Player,
    Team,
    Vector,
    Camera,
    WaypointPath,
    Object,
    Array,
    Message,
    Variable,
    Squad,
    ModBuilderEnum,
    WeaponUnlock,
    DeathType,
    CapturePoint,
    Vehicle,
    AreaTrigger,
    Objective,
    ActionStation,
    VFX,
    InteractPoint,
    SpatialObject,
    ScreenEffect,
    Spawner,
    SFX,
    UIWidget,
    HQ,
    Sector,
    DamageType,
    PrefabSpawner,
    RingOfFire,
    SpawnPoint,
    MCOM,
    ScoreboardType,
    WorldIcon,
    VehicleSpawner,
    Transform,
    EmplacementSpawner,
    Enum_RestrictedInputs,
    Enum_InventorySlots,
    Enum_ResupplyTypes,
    Enum_Cameras,
    Enum_SoldierStateBool,
    Enum_SoldierStateNumber,
    Enum_SoldierStateVector,
    Enum_PrimaryWeapons,
    Enum_SecondaryWeapons,
    Enum_OpenGadgets,
    Enum_Throwables,
    Enum_MeleeWeapons,
    Enum_MedGadgetTypes,
    Enum_Factions,
    Enum_PlayerDeathTypes,
    Enum_Maps,
    Enum_VehicleStateVector,
    Enum_CapturePoints,
    Enum_VFXTypes,
    Enum_VE,
    Enum_SFX,
    Enum_AwarenessState,
    Enum_UIAnchor,
    Enum_PlayerDamageTypes,
    Enum_UIImageType,
    Enum_UIButtonEvent,
    Enum_ClassGadgets,
    Enum_InventoryModifiers,
    Enum_VoiceOverEvents2D,
    Enum_SoundEvents2D,
    Enum_WorldIconImages,
    Enum_Types,
    Enum_UIBgFill,
    Enum_PlayerFilterTypes,
    Enum_SoundEvents3D,
    Enum_VoiceOverEvents3D,
    Enum_SpawnModes,
    Enum_ScoreboardType,
    Enum_MiscGadgets,
    Enum_ArmorTypes,
    Enum_ArmorDurability,
    Enum_UIDepth,
    Enum_VehicleList,
    Enum_AmmoTypes,
    Enum_ActionStationAnimation,
    Enum_Stance,
    Enum_MoveSpeed,
    Enum_SoldierClass,
    Enum_RuntimeSpawn_Common,
    Enum_RuntimeSpawn_Granite_ResidentialNorth,
    Enum_RuntimeSpawn_Abbasid,
    Enum_RuntimeSpawn_Aftermath,
    Enum_RuntimeSpawn_Badlands,
    Enum_RuntimeSpawn_Battery,
    Enum_RuntimeSpawn_Capstone,
    Enum_RuntimeSpawn_Dumbo,
    Enum_RuntimeSpawn_Eastwood,
    Enum_RuntimeSpawn_FireStorm,
    Enum_RuntimeSpawn_Limestone,
    Enum_RuntimeSpawn_Outskirts,
    Enum_RuntimeSpawn_Tungsten,
    Enum_RuntimeSpawn_Granite_Downtown,
    Enum_RuntimeSpawn_Granite_Marina,
    Enum_RuntimeSpawn_Granite_MilitaryRnD,
    Enum_RuntimeSpawn_Granite_MilitaryStorage,
    Enum_RuntimeSpawn_Granite_TechCenter,
    Enum_RuntimeSpawn_Sand,
    Enum_SpotStatus,
    Enum_StationaryEmplacements,
}

export enum Cameras {
    FirstPerson,
    Free,
    ThirdPerson,
}

export function GetObjId(obj: ModObject) {
    return obj.ObjId;
}

export function GetObjectPosition(obj: ModObject) {
    if (obj) return obj.position;
    console.warn('GetObjectPosition called with undefined obj');
    return zero;
}

export function rotationMatrixToEuler(right: Vector, up: Vector, front: Vector): Vector {
    const pitch = Math.asin(-front.y);
    const yaw = Math.atan2(right.y, up.y);
    const roll = Math.atan2(front.x, front.z);
    
    return CreateVector(pitch, yaw, roll);
}

export function eulerToRotationMatrix(euler: Vector): { right: Vector; up: Vector; front: Vector } {
    const e = euler as any;
    const pitch = e.x;
    const yaw = e.y;
    const roll = e.z;
    
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    
    return {
        right: CreateVector(
            cy * cr + sy * sp * sr,
            cp * sr,
            -sy * cr + cy * sp * sr
        ),
        up: CreateVector(
            -cy * sr + sy * sp * cr,
            cp * cr,
            sy * sr + cy * sp * cr
        ),
        front: CreateVector(
            sy * cp,
            -sp,
            cy * cp
        )
    };
}

export function GetObjectRotation(obj: ModObject) {
    if (!obj) {
        console.warn('GetObjectRotation called with undefined obj');
        return zero;
    }
    
    if (!obj.right || !obj.up || !obj.front) {
        return zero;
    }
    
    return rotationMatrixToEuler(obj.right, obj.up, obj.front);
}

const teams: Team[] = [];

export function GetTeam(playerOrTeamNumber: Player | number) {
    if (typeof playerOrTeamNumber === 'number') {
        while (teams.length <= playerOrTeamNumber) {
            teams.push({ type: 'Team', ObjId: teams.length });
        }
        return teams[playerOrTeamNumber];
    } else {
        const player = playerOrTeamNumber as unknown as Player;
        while (teams.length <= player.team) {
            teams.push({ type: 'Team', ObjId: teams.length });
        }
        return teams[player.team];
    }
}

export function EndGameMode(player: Player) {
    const team = GetTeam(player);
    winningTeam = team;
}

export function GetSpawner(spawnerNumber: number) {
    const spawner = aiSpawners[spawnerNumber];
    return spawner;
}

export var aiSpawns: mod.Spawner[] = [];
export var aiUnspawns: Player[] = [];

export function SpawnAIFromAISpawner(spawner: mod.Spawner) {
    aiSpawns.push(spawner);
}

function UnspawnAllAIsFromAISpawner(spawner: mod.Spawner) {
    const simSpawner = spawner as any;
    if (simSpawner.spawnedList) {
        for (let i = 0; i < simSpawner.spawnedList.length; i++) {
            const grunt = simSpawner.spawnedList[i];
            grunt.isDead = true;
            grunt.isSpawned = false;
            aiUnspawns.push(grunt);
        }
        simSpawner.spawnedList = [];
    }
}

export function CreateAI() {
    if (aiSpawns.length == 0) return undefined;
    const spawner = aiSpawns[0] as any;
    spawner.spawned = true;
    aiSpawns.splice(0, 1);
    const grunt = CreatePlayer();
    allPlayers.array.push(grunt);
    grunt.isAISoldier = true;
    if (spawner.AlternateSpawns) {
        const alternateSpawns = spawner.AlternateSpawns as string[];
        const randomIndex = Math.floor(Math.random() * alternateSpawns.length);
        const randomSpawn = alternateSpawns[randomIndex];
        const spawnPoint = spawnPoints[randomSpawn];
        grunt.position = spawnPoint.position;
    } else {
        grunt.position = spawner.position;
    }
    const simSpawner = spawner as any;
    if (!simSpawner.spawnedList) simSpawner.spawnedList = [];
    simSpawner.spawnedList.push(grunt);
    const onSpawnerSpawned = modscript.OnSpawnerSpawned;
    if (onSpawnerSpawned) onSpawnerSpawned(grunt, spawner);
    return grunt;
}

export function DestroyAI() {
    if (aiUnspawns.length == 0) return undefined;
    const grunt = aiUnspawns[0];
    aiUnspawns.splice(0, 1);
    return grunt;
}

let modscript: any;
let gameModeStarted = false;

export var SIM_TICK_TIME = 1 / 30; // Portal server cadence

export async function Loop(loopSeconds: number, waitTimeout: number = SIM_TICK_TIME) {
    const ticks = Math.floor(loopSeconds / SIM_TICK_TIME);
    const onPlayerLeaveGame = modscript.OnPlayerLeaveGame;
    const ongoingGlobal = modscript.OngoingGlobal;
    const ongoingPlayer = modscript.OngoingPlayer;
    const ongoingTeam = modscript.OngoingTeam;
    const ongoingHQ = modscript.OngoingHQ;
    const ongoingSector = modscript.OngoingSector;
    const ongoingMCOM = modscript.OngoingMCOM;

    let winDelay = 20;
    for (let t = 0; t < ticks; t++) {
        if (!gameModeTimePaused) {
            gameModeTime += SIM_TICK_TIME;
        }
        let aiSoldier = CreateAI();
        if (aiSoldier) {
            mod.DeployPlayer(aiSoldier as unknown as mod.Player);
        }
        aiSoldier = DestroyAI();
        if (aiSoldier) {
            if (onPlayerLeaveGame) onPlayerLeaveGame(aiSoldier.ObjId);
            RemovePlayer(aiSoldier);
        }
        if (ongoingGlobal) ongoingGlobal();
        if (ongoingPlayer) {
            let allPlayers = mod.AllPlayers();
            let playerCount = mod.CountOf(allPlayers);
            for (let i = 0; i < playerCount; i++) {
                let player = mod.ValueInArray(allPlayers, i);
                ongoingPlayer(player);
            }
        }
        if (ongoingTeam) {
            for (let i = 0; i < 3; i++) {
                let team = mod.GetTeam(i);
                ongoingTeam(team);
            }
        }
        if (ongoingHQ) {
            for (const id in hqs) {
                const hq = hqs[id];
                ongoingHQ(hq);
            }
        }
        if (ongoingSector) {
            for (const id in sectors) {
                const sector = sectors[id];
                ongoingSector(sector);
            }
        }
        if (ongoingMCOM) {
            for (const id in mcoms) {
                const mcom = mcoms[id];
                ongoingMCOM(mcom);
            }
        }
        const localWinningTeam = winningTeam;
        if (!localWinningTeam) {
            UpdateCapturePoints();
            UpdateMCOMs();
            UpdateWinningTeam();
        }
        if (localWinningTeam && winDelay-- == 0) {
            break;
        }
        await WaitTimeout(waitTimeout);
        resolveWaits();
    }
    // console.debug("Loop finished");
}

/** Deterministic frame stepping used by the Cipher call-budget harness. */
export async function StepFrames(frameCount: number) {
    const frames = Math.max(0, Math.floor(frameCount));
    await Loop(frames * SIM_TICK_TIME, 0);
}

function UpdateWinningTeam() {
    const onGameModeEnding = modscript.OnGameModeEnding;

    if (gameModeTime >= gameModeTimeLimit) {
        winningTeam = GetTeam(0);
        console.log('Game ended due to timeout');
        if (onGameModeEnding) onGameModeEnding();
        return;
    }
    // see if any team scored enough points to win
    for (const teamNum in gameModeScore) {
        const score = gameModeScore[teamNum];
        if (score >= gameModeTargetScore) {
            winningTeam = GetTeam(parseInt(teamNum));
            console.log('Game ended due to score limit reached by team ' + winningTeam);
            if (onGameModeEnding) onGameModeEnding();
            break;
        }
    }
}

const captureThreshold = 10;

function UpdateCapturePoints() {
    // for each capture point, check if any players are in the area
    for (const cp of Object.values(capturePoints)) {
        const playersInArea: number[] = [];
        let team1Count = 0;
        let team2Count = 0;
        for (let j = 0; j < allPlayers.array.length; j++) {
            const player = allPlayers.array[j];
            if (!player.isAlive) continue;
            const distSq = GetDistanceSquared(player.position, cp.position!);
            if (distSq <= cp.captureRadius * cp.captureRadius) {
                playersInArea.push(player.ObjId);
                if (mod.GetObjId(mod.GetTeam(player)) == 1) {
                    team1Count++;
                } else if (mod.GetObjId(mod.GetTeam(player)) == 2) {
                    team2Count++;
                }
            }
        }
        // compare playersInArea to cp.currentPlayersInArea
        const enteredPlayers = playersInArea.filter((x) => !cp.currentPlayersInArea.includes(x));
        const exitedPlayers = cp.currentPlayersInArea.filter((x) => !playersInArea.includes(x));
        cp.currentPlayersInArea = playersInArea;
        // call capturing event
        if (playersInArea.length > 0) {
            const onCapturePointCapturing = modscript.OnCapturePointCapturing;
            if (onCapturePointCapturing) onCapturePointCapturing(cp);
        }
        // call enter events
        if (enteredPlayers.length > 0) {
            const onPlayerEnterCapturePoint = modscript.OnPlayerEnterCapturePoint;
            for (const playerId of enteredPlayers) {
                if (onPlayerEnterCapturePoint) onPlayerEnterCapturePoint(allPlayers.array[playerId], cp);
            }
        }
        // call exit events
        if (exitedPlayers.length > 0) {
            const onPlayerExitCapturePoint = modscript.OnPlayerExitCapturePoint;
            for (const playerId of exitedPlayers) {
                if (onPlayerExitCapturePoint) onPlayerExitCapturePoint(allPlayers.array[playerId], cp);
            }
        }
        if (team1Count === team2Count) continue; // No progress when balanced
        // Capture point progress: positive = Team 1, negative = Team 2, 0 = neutral
        const captureRate = 0.1;
        const neutralTeam = GetTeam(0);
        const team1 = GetTeam(1);
        const team2 = GetTeam(2);
        // Update progress based on player advantage
        const previousProgress = cp.captureProgress;
        const playerDifference = team1Count - team2Count;
        cp.captureProgress += playerDifference * captureRate;
        // Check for neutralization (progress crossed zero)
        if ((previousProgress > 0 && cp.captureProgress <= 0) || 
            (previousProgress < 0 && cp.captureProgress >= 0)) {
            cp.captureProgress = 0;
            if (!Equals(cp.currentOwnerTeam, neutralTeam)) {
                cp.previousOwnerTeam = cp.currentOwnerTeam;
                cp.currentOwnerTeam = neutralTeam;
                const onCapturePointLost = modscript.OnCapturePointLost;
                if (onCapturePointLost) onCapturePointLost(cp);
            }
        }
        // Check for Team 1 capture
        else if (cp.captureProgress >= captureThreshold) {
            cp.captureProgress = captureThreshold;
            if (!Equals(cp.currentOwnerTeam, team1)) {
                cp.previousOwnerTeam = cp.currentOwnerTeam;
                cp.currentOwnerTeam = team1;
                const onCapturePointCaptured = modscript.OnCapturePointCaptured;
                if (onCapturePointCaptured) onCapturePointCaptured(cp);
            }
        }
        // Check for Team 2 capture
        else if (cp.captureProgress <= -captureThreshold) {
            cp.captureProgress = -captureThreshold;
            if (!Equals(cp.currentOwnerTeam, team2)) {
                cp.previousOwnerTeam = cp.currentOwnerTeam;
                cp.currentOwnerTeam = team2;
                const onCapturePointCaptured = modscript.OnCapturePointCaptured;
                if (onCapturePointCaptured) onCapturePointCaptured(cp);
            }
        }
    }
}

function UpdateMCOMs() {
    for (const mcom of Object.values(mcoms)) {
        for (let j = 0; j < allPlayers.array.length; j++) {
            // if mcom is enabled decrement fuse timer
            if (mcom.Enabled && mcom.fuseTimer > 0) {
                mcom.fuseTimer -= SIM_TICK_TIME;
                if (mcom.fuseTimer <= 0) {
                    mcom.fuseTimer = 0;
                    // explode mcom
                    const onMCOMExploded = modscript.OnMCOMExploded;
                    if (onMCOMExploded) onMCOMExploded(mcom);
                }
            }
        }
    }
}

// test only
export function ArmMCOM(mcom: MCOM) {
    mcom.fuseTimer = mcom.FuseTime;
    const onMCOMArmed = modscript.OnMCOMExploded;
    if (onMCOMArmed) onMCOMArmed(mcom);
}

function GetDistanceSquared(a: Vector, b: Vector): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

export function GetPlayersOnPoint(capturePoint: CapturePoint) {
    const cp = capturePoints[capturePoint.ObjId];
    const players = EmptyArray();
    for (const playerId of cp.currentPlayersInArea) {
        const player = allPlayers.array[playerId];
        if (player) {
            players.array.push(player);
        }
    }
    return players;
}

export function Reset() {
    allPlayers.array = [];
    createdPlayers = [];
    winningTeam = null;
    gameModeTime = initialGameModeTime;
    gameModeStarted = false;
    aiSpawns = [];
    mcoms = {};
    volumes = {};
    matchTimeElapsed = 0;

    // Clear UI tree
    if (uiRoot && uiRoot.children) {
        uiRoot.children = [];
    }
}

export function Message(format: string, ...args: any[]) {
    if (winningTeam) console.log('Calling Message after winning team has been set');
    // Portal accepts missing/custom string-table keys during development. The
    // unsupported simulator used to throw here, aborting otherwise valid phase
    // profiling before the frame budget could be measured.
    let text = format ?? '';
    for (let i = 0; i < args.length; i++) {
        if (typeof args[i] === 'string') {
            text = text.replace(/{}/, args[i]);
        } else if (typeof args[i] === 'number') {
            text = text.replace(/{}/, args[i].toString());
        }
    }
    // console.log(format);
    const m = {
        type: 'Message',
        format: format,
        text: text,
    } as Message;
    return m;
}

export function DisplayNotificationMessage(message: Message, target?: Player | Team) {
    let targetInfo = 'all players';
    if (target) {
        if ((target as Team).type === 'Team') {
            targetInfo = `Team ${GetObjId(target as unknown as Team)}`;
        } else {
            targetInfo = `Player ${GetObjId(target as unknown as Player)}`;
        }
    }
    console.log(`DisplayNotificationMessage: "${message.text}" -> ${targetInfo}`);
}

export function SendErrorReport(message: Message) {
    console.warn(`[ErrorReport] ${message.text || message.format}`);
}

export function GetUIRoot() {
    return uiRoot;
}

export function CreateVector(x: number, y: number, z: number): Vector {
    return {
        type: 'Vector',
        x,
        y,
        z,
    } as Vector;
}

export function CreateTransform(position: Vector, rotation: Vector) {
    return {
        type: 'Transform',
        position,
        rotation,
    } as Transform;
}

export function SetObjectTransform(object: mod.Object, transform: Transform) {
    const obj = object as any;
    obj.position = transform.position;
    
    if (transform.rotation) {
        const matrix = eulerToRotationMatrix(transform.rotation);
        obj.right = matrix.right;
        obj.up = matrix.up;
        obj.front = matrix.front;
    }
}

const STRING_TYPE = 'string';
const NUMBER_TYPE = 'number';
const VECTOR_TYPE = 'Vector';
const UIWIDGET_TYPE = 'UIWidget';
const UIANCHOR_TYPE = 'number';
const MESSAGE_TYPE = 'Message';
const PLAYER_TYPE = 'Player';
const TEAM_TYPE = 'Team';
const BOOLEAN_TYPE = 'boolean';
const UIBGFILL_TYPE = 'number';
const UIDEPTH_TYPE = 'number';

const AddUIText5ArgTypes = [STRING_TYPE, VECTOR_TYPE, VECTOR_TYPE, UIANCHOR_TYPE, MESSAGE_TYPE];
const AddUIText6ArgTypes = [
    STRING_TYPE,
    VECTOR_TYPE,
    VECTOR_TYPE,
    UIANCHOR_TYPE,
    MESSAGE_TYPE,
    [PLAYER_TYPE, TEAM_TYPE],
];
const AddUIText15ArgTypes = [
    STRING_TYPE,
    VECTOR_TYPE,
    VECTOR_TYPE,
    UIANCHOR_TYPE,
    UIWIDGET_TYPE,
    BOOLEAN_TYPE,
    NUMBER_TYPE,
    VECTOR_TYPE,
    NUMBER_TYPE,
    UIBGFILL_TYPE,
    MESSAGE_TYPE,
    NUMBER_TYPE,
    VECTOR_TYPE,
    NUMBER_TYPE,
    UIANCHOR_TYPE,
];
const AddUIText16ArgTypes = [
    STRING_TYPE,
    VECTOR_TYPE,
    VECTOR_TYPE,
    UIANCHOR_TYPE,
    UIWIDGET_TYPE,
    BOOLEAN_TYPE,
    NUMBER_TYPE,
    VECTOR_TYPE,
    NUMBER_TYPE,
    UIBGFILL_TYPE,
    MESSAGE_TYPE,
    NUMBER_TYPE,
    VECTOR_TYPE,
    NUMBER_TYPE,
    UIANCHOR_TYPE,
    [PLAYER_TYPE, TEAM_TYPE],
];
const AddUIText17ArgTypes = [
    STRING_TYPE,
    VECTOR_TYPE,
    VECTOR_TYPE,
    UIANCHOR_TYPE,
    UIWIDGET_TYPE,
    BOOLEAN_TYPE,
    NUMBER_TYPE,
    VECTOR_TYPE,
    NUMBER_TYPE,
    UIBGFILL_TYPE,
    MESSAGE_TYPE,
    NUMBER_TYPE,
    VECTOR_TYPE,
    NUMBER_TYPE,
    UIANCHOR_TYPE,
    UIDEPTH_TYPE,
    [PLAYER_TYPE, TEAM_TYPE],
];
const parentTypes: { [key: string]: string[] } = {
    UIContainer: [UIWIDGET_TYPE],
};

function argsMatch(args: IArguments, types: any[]) {
    if (args.length !== types.length) {
        return false;
    }
    for (let i = 0; i < args.length; i++) {
        const type = types[i];
        const arg = args[i];
        let argType = typeof arg;
        if (argType === 'object') {
            const objectType = arg['type'];
            if (objectType) {
                argType = objectType;
            }
        }
        if (Array.isArray(type)) {
            if (!type.includes(argType)) {
                return false;
            }
        } else if (argType !== type) {
            const parentTypeList = parentTypes[argType];
            if (!parentTypeList || !parentTypeList.includes(type)) return false;
        }
    }
    return true;
}

export function AddUIText(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    arg4: UIWidget | Message,
    arg5: boolean | Player | Team,
    arg6: number,
    arg7: Vector,
    arg8: number,
    arg9: UIBgFill,
    arg10: Message,
    arg11: number,
    arg12: Vector,
    arg13: number,
    arg14: UIAnchor,
    ...rest: any[]
) {
    if (argsMatch(arguments, AddUIText5ArgTypes)) {
        AddUIText5(name, position, size, anchor, arg4 as unknown as Message);
        return;
    }
    if (argsMatch(arguments, AddUIText6ArgTypes)) {
        AddUIText6(name, position, size, anchor, arg4 as unknown as Message, arg5 as unknown as Player | Team);
        return;
    }
    let parent = arg4 as unknown as UIWidget;
    if (!parent) {
        parent = uiRoot;
    }
    if (argsMatch(arguments, AddUIText15ArgTypes)) {
        AddUIText15(
            name,
            position,
            size,
            anchor,
            parent,
            arg5 as boolean,
            arg6,
            arg7,
            arg8,
            arg9,
            arg10,
            arg11,
            arg12,
            arg13,
            arg14
        );
    } else if (argsMatch(arguments, AddUIText16ArgTypes)) {
        let restrict = rest[0];
        AddUIText16(
            name,
            position,
            size,
            anchor,
            parent,
            arg5 as boolean,
            arg6,
            arg7,
            arg8,
            arg9,
            arg10,
            arg11,
            arg12,
            arg13,
            arg14,
            restrict
        );
    } else if (argsMatch(arguments, AddUIText17ArgTypes)) {
        AddUIText17(
            name,
            position,
            size,
            anchor,
            parent,
            arg5 as boolean,
            arg6,
            arg7,
            arg8,
            arg9,
            arg10,
            arg11,
            arg12,
            arg13,
            arg14,
            rest[0],
            rest[1]
        );
    } else {
        try {
            console.error(`AddUIText: Invalid arguments: ${JSON.stringify(arguments)}`);
        } catch (e) {
            console.error(`AddUIText: Invalid arguments: ${arguments}`);
            argsMatch(arguments, AddUIText5ArgTypes);
            argsMatch(arguments, AddUIText6ArgTypes);
            argsMatch(arguments, AddUIText15ArgTypes);
            argsMatch(arguments, AddUIText16ArgTypes);
            argsMatch(arguments, AddUIText17ArgTypes);
        }
    }
}

function AddUIText5(name: string, position: Vector, size: Vector, anchor: UIAnchor, message: Message) {
    console.log('AddUIText5');
    uiRoot.children.push({
        type: 'UIWidget',
        uiType: 'Text',
        visible: true,
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: uiRoot,
        children: [],
    });
}

function AddUIText6(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    message: Message,
    receiver: Player | Team
) {
    console.log('AddUIText6');
    uiRoot.children.push({
        type: 'UIWidget',
        uiType: 'Text',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: uiRoot,
        visible: true,
        textLabel: message.text,
        children: [],
        restrict: receiver,
    });
}

function AddUIText15(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    parent: UIWidget,
    visible: boolean,
    padding: number,
    bgColor: Vector,
    bgAlpha: number,
    bgFill: UIBgFill,
    message: Message,
    textSize: number,
    textColor: Vector,
    textAlpha: number,
    textAnchor: UIAnchor
) {
    console.log('AddUIText15');
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Text',
        name: name,
        position: position as unknown as Vector,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: visible,
        padding: padding,
        bgColor: bgColor,
        bgAlpha: bgAlpha,
        textSize: textSize,
        textColor: textColor,
        textAlpha: textAlpha,
        textAnchor: textAnchor,
        bgFill: bgFill,
        textLabel: message.text,
        children: [],
    });
}

export function AddUIText16(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    parent: UIWidget,
    visible: boolean,
    padding: number,
    bgColor: Vector,
    bgAlpha: number,
    bgFill: UIBgFill,
    message: Message,
    textSize: number,
    textColor: Vector,
    textAlpha: number,
    textAnchor: UIAnchor,
    receiver: Player | Team
) {
    console.log('AddUIText16');
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Text',
        name: name,
        position: position as unknown as Vector,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: visible,
        padding: padding,
        bgColor: bgColor,
        bgAlpha: bgAlpha,
        textSize: textSize,
        textColor: textColor,
        textAlpha: textAlpha,
        textAnchor: textAnchor,
        bgFill: bgFill,
        textLabel: message.text,
        restrict: receiver,
        children: [],
    });
}

// Creates a new UI Text Widget.
function AddUIText17(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    parent: UIWidget,
    visible: boolean,
    padding: number,
    bgColor: Vector,
    bgAlpha: number,
    bgFill: UIBgFill,
    message: Message,
    textSize: number,
    textColor: Vector,
    textAlpha: number,
    textAnchor: UIAnchor,
    depth: UIDepth,
    receiver: Player | Team
) {
    console.log('AddUIText17');
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Text',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: visible,
        textSize: textSize,
        bgFill: bgFill,
        textLabel: message.text,
        depth: depth,
        restrict: receiver,
        children: [],
    });
}

export function AddUIContainer(
    arg0: string,
    arg1: Vector,
    arg2: Vector,
    arg3: UIAnchor,
    parent?: UIWidget,
    arg5?: boolean,
    arg6?: number,
    arg7?: Vector,
    arg8?: number,
    arg9?: UIBgFill,
    ...rest: any[]
) {
    if (!parent) {
        parent = uiRoot;
    }
    // use defined arguments to decide which version of AddUIContainer to call
    if (arguments.length === 4) {
        AddUIContainer4(arg0, arg1, arg2, arg3);
    } else if (arguments.length === 5) {
        AddUIContainer5(arg0, arg1, arg2, arg3, arguments[4]);
    } else if (arguments.length === 10) {
        AddUIContainer10(arg0, arg1, arg2, arg3, parent, arg5!, arg6!, arg7!, arg8!, arg9!);
    } else if (arguments.length === 11) {
        AddUIContainer11(arg0, arg1, arg2, arg3, parent, arg5!, arg6!, arg7!, arg8!, arg9!, rest[0]);
    } else if (arguments.length === 12) {
        AddUIContainer12(arg0, arg1, arg2, arg3, parent, arg5!, arg6!, arg7!, arg8!, arg9!, rest[0], rest[1]);
    } else {
        console.error(`AddUIContainer: Invalid arguments: ${JSON.stringify(arguments)}`);
    }
}

function AddUIContainer4(name: string, position: Vector, size: Vector, anchor: UIAnchor) {
    const parent = uiRoot;
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Container',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: true,
        children: [],
    });
}

function AddUIContainer5(name: string, position: Vector, size: Vector, anchor: UIAnchor, receiver: Player | Team) {
    const parent = uiRoot;
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Container',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: true,
        restrict: receiver,
        children: [],
    });
}

function AddUIContainer10(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    parent: UIWidget,
    visible: boolean,
    padding: number,
    bgColor: Vector,
    bgAlpha: number,
    bgFill: UIBgFill
) {
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Container',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: visible,
        padding: padding,
        bgColor: bgColor,
        bgAlpha: bgAlpha,
        bgFill: bgFill,
        children: [],
    });
}

function AddUIContainer11(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    parent: UIWidget,
    visible: boolean,
    padding: number,
    bgColor: Vector,
    bgAlpha: number,
    bgFill: UIBgFill,
    receiverOrDepth: Player | Team | UIDepth
) {
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Container',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: visible,
        padding: padding,
        bgColor: bgColor,
        bgAlpha: bgAlpha,
        bgFill: bgFill,
        restrict: receiverOrDepth as Player,
        depth: receiverOrDepth as UIDepth,
        children: [],
    });
}

function AddUIContainer12(
    name: string,
    position: Vector,
    size: Vector,
    anchor: UIAnchor,
    parent: UIWidget,
    visible: boolean,
    padding: number,
    bgColor: Vector,
    bgAlpha: number,
    bgFill: UIBgFill,
    depth: UIDepth,
    receiver: Player | Team
) {
    parent.children.push({
        type: 'UIWidget',
        uiType: 'Container',
        name: name,
        position: position,
        size: size,
        anchor: anchor,
        parent: parent,
        visible: visible,
        padding: padding,
        bgColor: bgColor,
        bgAlpha: bgAlpha,
        bgFill: bgFill,
        depth: depth,
        restrict: receiver,
        children: [],
    });
}

export function AddUIButton(
    arg0: string,
    arg1: Vector,
    arg2: Vector,
    arg3: UIAnchor,
    parent: UIWidget,
    arg5: boolean,
    arg6: number,
    arg7: Vector,
    arg8: number,
    arg9: UIBgFill,
    arg10: boolean,
    arg11: Vector,
    arg12: number,
    arg13: Vector,
    arg14: number,
    arg15: Vector,
    arg16: number,
    arg17: Vector,
    arg18: number,
    arg19: Vector,
    arg20?: number,
    arg21?: mod.UIDepth,
    arg22?: Player | Team
) {
    if (!parent) {
        parent = uiRoot;
    }
    let properties: UIWidget = {
        type: 'UIWidget',
        uiType: 'Button',
        name: arg0,
        position: arg1,
        size: arg2,
        anchor: arg3,
        parent: parent,
        visible: arg5,
        padding: arg6,
        bgColor: arg7,
        bgAlpha: arg8,
        bgFill: arg9,
        buttonEnabled: arg10,
        buttonColorBase: arg11,
        buttonAlphaBase: arg12,
        buttonColorDisabled: arg13,
        buttonAlphaDisabled: arg14,
        buttonColorPressed: arg15,
        buttonAlphaPressed: arg16,
        buttonColorHover: arg17,
        buttonAlphaHover: arg18,
        buttonColorFocused: arg19,
        buttonColorFocusedAlpha: arg20,
        children: [],
    };
    if (arg21) {
        console.log('AddUIButton fixme');
    }
    parent.children.push(properties);
}

export function AddUIImage(
    arg0: string,
    arg1: Vector,
    arg2: Vector,
    arg3: UIAnchor,
    parent: UIWidget,
    arg5: boolean,
    arg6: number,
    arg7: Vector,
    arg8: number,
    arg9: UIBgFill,
    arg10: UIImageType,
    arg11: mod.Vector,
    arg12: number,
    arg13: UIDepth,
    arg14?: Player | Team
) {
    if (!parent) {
        parent = uiRoot;
    }
    let properties: UIWidget = {
        type: 'UIWidget',
        uiType: 'Image',
        name: arg0,
        position: arg1,
        size: arg2,
        anchor: arg3,
        parent: parent,
        visible: arg5,
        padding: arg6,
        bgColor: arg7,
        bgAlpha: arg8,
        bgFill: arg9,
        imageType: arg10,
        imageColor: arg11,
        imageAlpha: arg12,
    } as any;
    if (arg14) {
        properties['restrict'] = arg14;
    }
    parent.children.push(properties);
}

export function SetUIWidgetDepth(widget: UIWidget, depth: UIDepth) {
    if (!widget) {
        console.warn('SetUIWidgetDepth widget is not defined');
        return;
    }
    widget.depth = depth;
}

export function GetUIWidgetName(widget: UIWidget): string {
    return widget.name;
}

export function SetUIWidgetPosition(widget: UIWidget, position: Vector) {
    if (!widget) {
        console.warn('SetUIWidgetPosition widget is not defined');
        return;
    }
    widget.position = position;
}

export function SetUIButtonEnabled(widget: mod.UIWidget, enabled: boolean) {
    const w = widget as any;
    w.buttonEnabled = enabled;
}

export function DeleteAllUIWidgets() {
    let root = uiRoot as any;
    root.children = [];
}

let unInputEnabled: boolean = false;

export function EnableUIInputMode(enable: boolean) {
    unInputEnabled = enable;
}

function deleteWidgetAndChildren(widget: UIWidget) {
    if (!widget.children || widget.children.length === 0) {
        return false;
    }
    for (let child of widget.children) {
        deleteWidgetAndChildren(child);
        DeleteUIWidget(child);
    }
    widget.children = [];
    console.log(`Deleted all children of UIWidget: ${widget.name}`);
    return true;
}

function deleteUIWidgetRecursive(parent: UIWidget, widget: UIWidget): boolean {
    if (!parent.children) {
        return false;
    }
    for (let child of parent.children) {
        if (child === widget) {
            deleteWidgetAndChildren(widget);
            const index = parent.children.indexOf(child);
            if (index > -1) {
                parent.children.splice(index, 1);
                console.log(`Deleted UIWidget: ${widget.name}`);
            }
            return true;
        }
        let found = deleteUIWidgetRecursive(child, widget);
        if (found) return true;
    }
    return false;
}

export function DeleteUIWidget(widget: UIWidget) {
    if (!widget) {
        console.warn(`DeleteUIWidget: widget is undefined or null`);
        return;
    }
    if (!deleteUIWidgetRecursive(uiRoot, widget)) {
        if (widget.name) console.error(`Failed to delete UIWidget: ${widget.name}`);
        else {
            console.error(`Failed to delete UIWidget: (unnamed)`);
        }
    }
}

function FindUIWidgetWithNameRecursive(node: UIWidget, name: string): UIWidget | null {
    if (!node.children) {
        return null;
    }
    for (let child of node.children) {
        if (child.name === name) {
            return child;
        }
        let grandchild = FindUIWidgetWithNameRecursive(child, name);
        if (grandchild) {
            return grandchild;
        }
    }
    return null;
}

export function FindUIWidgetWithName(name: string) {
    const w = FindUIWidgetWithNameRecursive(uiRoot, name);
    if (!w) console.warn(`FindUIWidgetWithNameRecursive: Widget with name "${name}" not found`);
    return w;
}

export function SetUIWidgetName(widget: UIWidget, name: string) {
    if (!widget) {
        console.warn('SetUIWidgetName widget is not defined');
        return;
    }
    widget.name = name;
}

export function SetUIWidgetVisible(widget: UIWidget, visible: boolean) {
    if (!widget) {
        console.warn('SetUIWidgetVisible widget is not defined');
        return;
    }
    widget.visible = visible;
}

export function SetUIWidgetSize(widget: UIWidget, size: Vector) {
    if (!widget) {
        console.warn('SetUIWidgetSize widget is not defined');
        return;
    }
    widget.size = size;
}

export function SetUITextLabel(widget: UIWidget, label: Message) {
    if (!widget) {
        console.warn('SetUITextLabel widget is not defined');
        return;
    }
    widget.textLabel = (label as unknown as Message).text;
}

export function SetUITextColor(widget: UIWidget, color: Vector) {
    if (!widget) {
        console.warn('SetUITextColor widget is not defined');
        return;
    }
    widget.textColor = color;
}

export function SetUITextAlpha(widget: UIWidget, alpha: number) {
    if (!widget) {
        console.warn('SetUITextAlpha widget is not defined');
        return;
    }
    widget.textAlpha = alpha;
}

export function DumpUITree(player: Player | null = null, widget: UIWidget | null = null, indent: string = '') {
    if (!widget) {
        widget = uiRoot;
        if (player) {
            console.log(`=============== UI Widget Tree (Player ${(player as any).ObjId}) ===============`);
        } else {
            console.log('=============== UI Widget Tree ===============');
        }
    }

    // Check if this widget should be visible to the specified player
    if (widget.restrict && player) {
        const restrictType = (widget.restrict as any).type;
        const restrictId = (widget.restrict as any).ObjId;
        const playerId = (player as any).ObjId;

        // If restricted to a player and it's not this player, skip it
        if (restrictType === 'Player' && restrictId !== playerId) {
            return;
        }

        // If restricted to a team, check if player is on that team
        if (restrictType === 'Team') {
            // For now, skip team checking - we'd need player.team
            // Could add this logic later if needed
        }
    }

    const name = widget.name || '(unnamed)';
    const type = widget.uiType || 'Unknown';
    const visible = widget.visible ? 'visible' : 'HIDDEN';

    // Build detailed info string
    let details: string[] = [];

    // Position and size
    if (widget.position) {
        details.push(`pos:[${widget.position.x},${widget.position.y}]`);
    }
    if (widget.size) {
        details.push(`size:[${widget.size.x},${widget.size.y}]`);
    }

    // Anchor
    if (widget.anchor !== undefined) {
        const anchorNames = [
            'TopLeft',
            'TopCenter',
            'TopRight',
            'CenterLeft',
            'Center',
            'CenterRight',
            'BottomLeft',
            'BottomCenter',
            'BottomRight',
        ];
        details.push(`anchor:${anchorNames[widget.anchor] || widget.anchor}`);
    }

    // Text content
    if (widget.textLabel !== undefined) {
        details.push(`text:"${widget.textLabel}"`);
    }
    if (widget.textSize !== undefined) {
        details.push(`textSize:${widget.textSize}`);
    }

    // Colors
    if (widget.bgColor) {
        details.push(
            `bgColor:[${widget.bgColor.x.toFixed(2)},${widget.bgColor.y.toFixed(2)},${widget.bgColor.z.toFixed(2)}]`
        );
    }
    if (widget.bgAlpha !== undefined && widget.bgAlpha !== 1) {
        details.push(`bgAlpha:${widget.bgAlpha}`);
    }
    if (widget.textColor) {
        details.push(
            `textColor:[${widget.textColor.x.toFixed(2)},${widget.textColor.y.toFixed(2)},${widget.textColor.z.toFixed(2)}]`
        );
    }

    // Background fill
    if (widget.bgFill !== undefined) {
        const fillNames = ['None', 'Solid', 'Outline', 'OutlineThick', 'Blur'];
        details.push(`bgFill:${fillNames[widget.bgFill] || widget.bgFill}`);
    }

    // Depth
    if (widget.depth !== undefined) {
        const depthNames = ['BelowGameUI', 'GameUI', 'AboveGameUI'];
        details.push(`depth:${depthNames[widget.depth] || widget.depth}`);
    }

    // Padding
    if (widget.padding !== undefined && widget.padding !== 0) {
        details.push(`padding:${widget.padding}`);
    }

    // Child count (filtered)
    let visibleChildCount = 0;
    if (widget.children) {
        for (let child of widget.children) {
            // Check if child would be visible to the specified player
            if (child.restrict && player) {
                const restrictType = (child.restrict as any).type;
                const restrictId = (child.restrict as any).ObjId;
                const playerId = (player as any).ObjId;
                if (restrictType === 'Player' && restrictId !== playerId) {
                    continue; // Skip this child
                }
            }
            visibleChildCount++;
        }
    }
    if (visibleChildCount > 0) {
        details.push(`children:${visibleChildCount}`);
    }

    // Build the output line
    const detailsStr = details.length > 0 ? ` | ${details.join(', ')}` : '';
    console.log(`${indent}[${type}] "${name}" (${visible})${detailsStr}`);

    // Recursively dump children
    if (widget.children) {
        for (let child of widget.children) {
            DumpUITree(player, child, indent + '  ');
        }
    }

    if (!indent) {
        console.log('==============================================');
    }
}

export function SetGameModeTimeLimit(limit: number) {
    gameModeTimeLimit = limit;
}

export function GetGameModeTimeLimit() {
    return gameModeTimeLimit;
}

export function PauseGameModeTime(paused: boolean) {
    gameModeTimePaused = paused;
}

export function GetRoundTime() {
    return gameModeTime;
}

export function GetGameModeScore(teamOrPlayer: Team | Player) {
    let team: Team;
    if ((teamOrPlayer as Team).type === 'Team') {
        team = teamOrPlayer as Team;
    } else {
        const player = teamOrPlayer as unknown as Player;
        team = GetTeam(player);
    }
    const teamNum = GetObjId(team);
    return gameModeScore[teamNum] || 0;
}

export function SetScoreboardType(type: mod.ScoreboardType) {
    scoreboardType = type;
}

export function SetSpawnMode(spawnMode: SpawnModes) {
    console.warn('SetSpawnMode not fully implemented');
}

export function SetScoreboardHeader(header: Message) {
    if (header.type !== 'Message') {
        console.error(`SetScoreboardHeader: header is not a Message`);
        return;
    }
    console.warn(`SetScoreboardHeader not simulated`);
}

export function SetScoreboardColumnNames(...columnNames: Message[]) {
    for (let i = 0; i < columnNames.length; i++) {
        if (columnNames[i].type !== 'Message') {
            console.error(`SetScoreboardColumnNames: columnNames[${i}] is not a Message`);
            return;
        }
    }
    console.warn(`SetScoreboardColumnNames not simulated`);
}

export function SetScoreboardColumnWidths(...columnWidths: number[]) {
    console.warn(`SetScoreboardColumnWidths not simulated`);
}

export function SetScoreboardSorting(columnNum: number, ascending?: boolean) {
    console.warn(`SetScoreboardSorting not simulated`);
}

export function SetScoreboardPlayerValues(
    player: Player,
    column1Value: number,
    column2Value: number,
    column3Value: number,
    column4Value: number,
    column5Value: number
) {
    console.warn(`SetScoreboardPlayerValues not simulated`);
}

export function SkipManDown(player: Player) {
    console.warn(`modsim SkipManDown not implemented yet`);
}

// todo: remove this
function EnableDefaultGameModeWinCondition(enable: boolean) {}

export function GetMCOM(mcomId: number) {
    const mcom = mcoms[mcomId];
    if (!mcom) console.warn(`GetMCOM: mcoms[${mcomId}] is undefined`);
    return mcom;
}

export function GetSpatialObject(spatialObjectId: number) {
    const obj = modSimObjects[spatialObjectId];
    if (!obj) console.warn(`GetSpatialObject: modSimObjects[${spatialObjectId}] is undefined`);
    return obj;
}

export function EnableGameModeObjective(objective: CapturePoint | HeadQuarters | Sector | MCOM, enable: boolean) {
    if (!objective) {
        console.warn(`EnableGameModeObjective: objective is undefined`);
        return;
    }
    switch (objective.type) {
        case 'Sector':
            const sector = objective as Sector;
            sector.SectorEnabled = enable;
            break;
        case 'MCOM':
            const mcom = objective as MCOM;
            mcom.Enabled = enable;
            break;
        default:
            console.warn('EnableGameModeObjective: objective type not supported');
            break;
    }
}

export function SetMCOMFuseTime(mcom: MCOM, fuseTime: number) {
    if (!mcom) {
        console.warn(`SetMCOMFuseTime: mcom is undefined`);
        return;
    }
    mcom.FuseTime = fuseTime;
}

export function GetCapturePoint(id: number) {
    const cp = capturePoints[id];
    if (!cp) console.warn(`GetCapturePoint: capturePoints[${id}] is undefined`);
    return cp;
}

export function GetCurrentOwnerTeam(capturePoint: CapturePoint) {
    return capturePoint.currentOwnerTeam;
}

export function GetPreviousOwnerTeam(capturePoint: CapturePoint) {
    return capturePoint.previousOwnerTeam;
}

export function SetCapturePointCapturingTime(capturePoint: CapturePoint, capturingTime: number) {
    capturePoint.capturingTime = capturingTime;
}

export function SetCapturePointNeutralizationTime(capturePoint: CapturePoint, neutralizationTime: number) {
    capturePoint.neutralizationTime = neutralizationTime;
}

export function SetCapturePointOwner(capturePoint: CapturePoint, team: Team) {
    capturePoint.currentOwnerTeam = team;
}

export function SetMaxCaptureMultiplier(capturePoint: CapturePoint, multiplier: number) {
    capturePoint.maxCaptureMultiplier = multiplier;
}

export function GetCaptureProgress(capturePoint: CapturePoint) {
    return Math.abs(capturePoint.captureProgress) / captureThreshold;
}

export function GetOwnerProgressTeam(capturePoint: CapturePoint) {
    if (capturePoint.captureProgress > 0) {
        return GetTeam(1);
    } else if (capturePoint.captureProgress < 0) {
        return GetTeam(2);
    } else {
        return capturePoint.currentOwnerTeam;
    }
}

export function GetHQ(id: number) {
    const hq = hqs[id];
    if (!hq) console.warn(`GetHQ: hqs[${id}] is undefined`);
    return hq;
}

export function EnableHQ(hq: HeadQuarters, enable: boolean) {
    if (!hq) {
        console.warn(`EnableHQ: hq is undefined`);
        return;
    }
    hq.HQEnabled = enable;
}

export function GetSector(number: number) {
    const sector = sectors[number];
    if (!sector) console.warn(`GetSector: sectors[${number}] is undefined`);
    return sector;
}

export function AISetUnspawnOnDead() {
    console.warn(`AISetUnspawnOnDead not implemented`);
}

export function AIDefendPositionBehavior(
    player: Player,
    defendPosition: Vector,
    minDistance: number,
    maxDistance: number
) {
    const angle = Math.random() * Math.PI * 2;
    const distance = minDistance + Math.random() * (maxDistance - minDistance);
    const offsetX = Math.cos(angle) * distance;
    const offsetZ = Math.sin(angle) * distance;
    const newPosition: Vector = {
        type: 'Vector',
        x: defendPosition.x + offsetX,
        y: defendPosition.y,
        z: defendPosition.z + offsetZ,
    };
    console.log('AIDefendPositionBehavior: moving AI to position ', newPosition);
    player.position = newPosition;
}

export function AIMoveToBehavior(player: Player, position: Vector) {
    console.log('AIMoveToBehavior: moving AI to position ', position);
    player.position = position;
}

export function AISetMoveSpeed(player: Player, moveSpeed: MoveSpeed) {
    player.aiMoveSpeed = moveSpeed;
}

export function AISetStance(player: Player, stance: Stance) {
    player.aiStance = stance;
}

export function WaitTimeout(timeMs: number) {
    return new Promise<void>((resolve) => {
        setTimeout(() => {
            resolve();
        }, timeMs);
    });
}

interface WaitCallback {
    endTick: number;
    resolve: () => void;
}

const waitCallbacks: WaitCallback[] = [];

function resolveWaits() {
    for (let i = waitCallbacks.length - 1; i >= 0; i--) {
        const callback = waitCallbacks[i];
        if (callback.endTick <= gameModeTime) {
            callback.resolve();
            waitCallbacks.splice(i, 1); // Remove the resolved callback
        }
    }
}

export function Wait(delay: number) {
    return new Promise<void>((resolve) => {
        waitCallbacks.push({
            endTick: gameModeTime + delay,
            resolve: resolve,
        });
    });
}

export function GetSoldierState(
    player: mod.Player,
    state: SoldierStateBool | SoldierStateVector | SoldierStateNumber
): boolean | mod.Vector | number {
    let p = player as unknown as Player;
    if (state in SoldierStateBool) {
        switch (state) {
            case SoldierStateBool.IsAlive:
                return p.isAlive;
            case SoldierStateBool.IsAISoldier:
                return p.isAISoldier;
            case SoldierStateBool.IsInteracting:
                return p.isInteracting;
            case SoldierStateBool.IsInVehicle:
                return p.vehicle !== null;
            default:
                throw new Error(`State ${state} not implemented`);
        }
    } else if (state in SoldierStateVector) {
        switch (state) {
            case SoldierStateVector.GetLinearVelocity:
                return p.linearVelocity as unknown as mod.Vector;
            case SoldierStateVector.GetPosition:
                return p.position as unknown as mod.Vector;
            case SoldierStateVector.GetFacingDirection:
                return p.facingDirection as unknown as mod.Vector;
            case SoldierStateVector.EyePosition:
                return p.eyePosition as unknown as mod.Vector;
            default:
                throw new Error(`State ${state} not implemented`);
        }
    } else if (state in SoldierStateNumber) {
        switch (state) {
            case SoldierStateNumber.CurrentHealth:
                return p.currentHealth;
            case SoldierStateNumber.Speed:
                return p.speed;
            case SoldierStateNumber.MaxHealth:
                return p.maxHealth;
            case SoldierStateNumber.NormalizedHealth:
                return p.normalizedHealth;
            case SoldierStateNumber.CurrentWeaponAmmo:
                return p.currentWeaponAmmo;
            case SoldierStateNumber.CurrentWeaponMagazineAmmo:
                return p.currentWeaponMagazineAmmo;
            default:
                throw new Error(`State ${state} not implemented`);
        }
    }
    return false;
}

export function SetTeam(player: Player, team: Team) {
    player.team = team.ObjId;
}

export function EnableAllPlayerDeploy(enable: boolean) {
    for (const player of allPlayers.array) {
        player.deployEnabled = enable;
    }
}

export function DeployPlayer(player: Player) {
    if (!player.deployEnabled) {
        // This function can force deployment even if deployEnabled is false, but for now we'll just log a warning
        console.warn(`DeployPlayer: Deployment is disabled for player ${player.name}`);
    }

    player.isAlive = true;

    const playerTeamNum = player.team;

    player.soldier = {
        type: 'Soldier',
        weaponsSlots: {},
    };

    if (player.soldierClass === undefined) {
        player.soldierClass = SoldierClass.Assault;
    }

    let teamHq: HeadQuarters | undefined;
    for (const hq in hqs) {
        const hqObj = hqs[hq];
        if (hqObj.team === playerTeamNum) {
            teamHq = hqObj;
            break;
        }
    }
    if (teamHq) {
        if (teamHq.InfantrySpawns.length > 0) {
            const randomSpawnPointIndex = Math.floor(Math.random() * teamHq.InfantrySpawns.length);
            const spawnPointId = teamHq.InfantrySpawns[randomSpawnPointIndex];
            const spawnPoint = spawnPoints[spawnPointId];

            player.position = spawnPoint.position;
        } else {
            player.position = teamHq.position;
        }
    } else {
        console.warn(`DeployPlayer: No HQ found for team ${playerTeamNum}, deploying at origin`);
        player.position = CreateVector(0, 0, 0);
    }
    if (modscript.OnPlayerDeployed) {
        modscript.OnPlayerDeployed(player);
    } else {
        console.info('OnPlayerDeployed not defined by script');
    }
}

export function EnablePlayerDeploy(player: Player, enable: boolean) {
    player.deployEnabled = enable;
}

export function UndeployPlayer(player: Player) {
    player.isAlive = false;
    player.position = undefined;

    if (modscript.OnPlayerUndeploy) {
        modscript.OnPlayerUndeploy(player);
    } else {
        console.info('OnPlayerUndeploy not defined by script');
    }
}

export function IsSoldierClass(player: Player, soldierClass: SoldierClass) {
    return player.soldierClass === soldierClass;
}


export function ForceRevive(player: mod.Player) {
    let playerObj = player as unknown as Player;
    playerObj.isAlive = true;
}

export function Kill(player: Player) {
    player.isAlive = false;
    player.currentHealth = 0;
    player.position = undefined;

    // TODO:
    // What should killer be? For now, just set to the same as victim
    // How are deathType and weaponUnlock determined? How do we create these objects?

    // Trigger OnPlayerDied event if defined
    if (modscript.OnPlayerDied) {
        // killer is same as victim for now (suicide/environmental death)
        modscript.OnPlayerDied(player, player, undefined, undefined);
    }
}

export function SetPlayerMaxHealth(player: mod.Player, maxHealth: number) {
    let playerObj = player as unknown as Player;
    playerObj.maxHealth = maxHealth;
}

export function SetAIToHumanDamageModifier(modifier: number) {
    console.log(`SetAIToHumanDamageModifier called with modifier: ${modifier}`);
}

export function SpotTarget(
    targetPlayer: Player,
    durationOrSpotterOrSpotStatus?: any,
    durationOrSpotStatus?: any,
    spotStatus?: any
) {
    let duration: number | undefined;
    let spotter: Player | undefined;
    let status: any;

    if (typeof durationOrSpotterOrSpotStatus === 'number') {
        duration = durationOrSpotterOrSpotStatus;
        status = durationOrSpotStatus;
    } else if (
        durationOrSpotterOrSpotStatus &&
        typeof durationOrSpotterOrSpotStatus === 'object' &&
        'ObjId' in durationOrSpotterOrSpotStatus
    ) {
        spotter = durationOrSpotterOrSpotStatus as Player;
        duration = durationOrSpotStatus as number;
        status = spotStatus;
    } else {
        status = durationOrSpotterOrSpotStatus;
    }

    const targetId = targetPlayer.ObjId;
    const spotterId = spotter ? spotter.ObjId : 'all';
    const durationStr = duration !== undefined ? `${duration}s` : 'indefinite';
    const statusStr = status !== undefined ? `status=${status}` : '';

    console.log(`SpotTarget: Player ${targetId} spotted by ${spotterId} for ${durationStr} ${statusStr}`);
}

export function SetUITextSize(widget: mod.UIWidget, size: number) {
    const w = widget as any;
    w.textSize = size;
}

export function SetUITextAnchor(widget: mod.UIWidget, anchor: UIAnchor) {
    const w = widget as any;
    w.textAnchor = anchor;
}

export function SetUIWidgetBgColor(w: UIWidget, color: Vector) {
    if (!w) {
        console.warn('SetUIWidgetBgColor widget is not defined');
        return;
    }
    w.bgColor = color;
}

export function SetUIWidgetBgFill(w: UIWidget, fill: UIBgFill) {
    if (!w) {
        console.warn('SetUIWidgetBgFill widget is not defined');
        return;
    }
    w.bgFill = fill;
}

export function SetUIWidgetBgAlpha(w: UIWidget, alpha: number) {
    if (!w) {
        console.warn('SetUIWidgetBgAlpha widget is not defined');
        return;
    }
    w.bgAlpha = alpha;
}

export let matchTimeElapsed: number = 0;

export function GetMatchTimeElapsed() {
    return Math.max(0, gameModeTime);
}

export function GetMatchTimeRemaining() {
    return gameModeTimeLimit - Math.max(0, gameModeTime);
}

let createdPlayers: number[] = [];

export function CreatePlayer() {
    if (createdPlayers.length == 0) {
        for (let i = 0; i < 64; i++) {
            createdPlayers.push(i);
        }
        createdPlayers.reverse();
    }

    let id = createdPlayers.pop()!;
    let team = (id % 2) + 1;
    let p: Player = {
        type: 'Player',
        ObjId: id,
        name: `Player${id}`,
        id: '',
        team: team,
        isAlive: false,
        isAISoldier: false,
        isInteracting: false,
        linearVelocity: CreateVector(0, 0, 0),
        position: undefined,
        facingDirection: CreateVector(0, 0, 0),
        eyePosition: CreateVector(0, 0, 0),
        currentHealth: 100,
        maxHealth: 100,
        normalizedHealth: 1,
        currentWeaponAmmo: 30,
        currentWeaponMagazineAmmo: 30,
        inventory: [],
        soldier: undefined,
        vehicle: undefined,
        speed: 0,
        armorType: ArmorTypes.NoArmor,
        deployEnabled: true,
    };
    return p;
}

export function EmptyArray() {
    return new ModArray();
}

export function CountOf(allPlayers: ModArray) {
    return allPlayers.array.length;
}

export function ValueInArray(array: ModArray, i: number) {
    return array.array[i];
}

export function AppendToArray(array: ModArray, value: mod.Any) {
    const newArray = new ModArray();
    newArray.array = array.array.slice();
    newArray.array.push(value);
    return newArray;
}

export function AddPlayerObsolete(player: Player) {
    allPlayers.array.push(player);
}

export function RemovePlayer(player: Player) {
    const index = allPlayers.array.indexOf(player);
    if (index > -1) {
        allPlayers.array.splice(index, 1);
    }
}

export function KillPlayer(
    player: Player,
    otherPlayer?: Player,
    deathType?: mod.DeathType,
    weaponUnlock?: mod.WeaponUnlock
) {
    let playerObj = player as any;
    playerObj.isAlive = false;
    const onPlayerDied = modscript.OnPlayerDied;
    const onPlayerUndeploy = modscript.OnPlayerUndeploy;
    const onPlayerEarnedKill = modscript.OnPlayerEarnedKill;
    if (onPlayerDied) onPlayerDied(player, otherPlayer, deathType, weaponUnlock);
    if (otherPlayer && onPlayerEarnedKill) onPlayerEarnedKill(otherPlayer, player, deathType, weaponUnlock);
    if (onPlayerUndeploy) onPlayerUndeploy(player);
}

export function AllPlayers() {
    return allPlayers;
}

export function AllCapturePoints() {
    return allCapturePoints;
}

export function AllVehicles() {
    return allVehicles;
}

export function IsVehicleOccupied(vehicle: Vehicle) {
    return false;
}

export function Teleport(player: Player, position: Vector, facing: number) {
    if (!player.isAlive) {
        console.warn(`Teleport: player ${player.ObjId} is not alive, cannot teleport`);
        return;
    }
    player.position = position;
}

export function YComponentOf(v: Vector) {
    return v.y;
}

export function XComponentOf(v: Vector) {
    return v.x;
}

export function ZComponentOf(v: Vector) {
    return v.z;
}

let objIdSeqNum = 0;
const modSimObjects: { [objId: number]: any } = {};

export function SpawnObject(
    prefabAll: mod.RuntimeSpawn_Common | mod.RuntimeSpawn_Abbasid,
    position: Vector,
    rotation: Vector,
    scale?: Vector
) {
    const prefab = prefabAll as number;
    const objId = objIdSeqNum++;
    let obj = {
        type: 'Prefab',
        position: position,
        rotation: rotation,
        scale: scale,
        ObjId: objId,
        id: '',
        name: '',
        prefab: prefab,
    };
    switch (prefab) {
        case mod.RuntimeSpawn_Common.InteractPoint:
            const interactPoint = obj as unknown as InteractPoint;
            interactPoint.type = 'InteractPoint';
            interactPoint.enabled = true;
            interactPoints[objId] = interactPoint;
            break;
        default:
            modSimObjects[objId] = obj;
            break;
    }
    return obj;
}

export function UnspawnObject(obj: ModObject) {
    const objId = obj.ObjId;
    if (modSimObjects[objId]) delete modSimObjects[objId];
    if (interactPoints[objId]) delete interactPoints[objId];
}

export function LoadLevel(script: any, mapData: any) {
    modscript = script;
    if (!mapData.Portal_Dynamic) {
        console.warn('Portal_Dynamic not found in map data');
        return;
    }
    const entityTypes = [volumeType];
    mapData.Portal_Dynamic.forEach((obj: any) => {
        // see if obj.type is in entityTypes
        if (entityTypes.indexOf(obj.type) !== -1) {
            console.log('Loading entity type:', obj.type);
        } else {
            if (obj.ObjId === undefined) {
                obj.ObjId = 0;
            }
            if (obj.position) obj.position = CreateVector(obj.position.x, obj.position.y, obj.position.z);
            if (obj.right) obj.right = CreateVector(obj.right.x, obj.right.y, obj.right.z);
            if (obj.up) obj.up = CreateVector(obj.up.x, obj.up.y, obj.up.z);
            if (obj.front) obj.front = CreateVector(obj.front.x, obj.front.y, obj.front.z);
        }
        switch (obj.type) {
            case spawnerType:
                obj.type = 'Spawner';
                aiSpawners[obj.ObjId] = obj;
                break;
            case spawnPointType:
                // Spawn points are entities indexed by their string ID
                spawnPoints[obj.id] = obj;
                break;
            case hqType:
                obj.type = 'HeadQuarters';
                if (obj.Team)
                    if (obj.Team === 'TeamNeutral') obj.team = 0;
                    else obj.team = parseInt(obj.Team.replace('Team', ''), 10);
                else obj.team = 1;
                if (!obj.InfantrySpawns) {
                    obj.InfantrySpawns = [];
                }
                if (!obj.HQEnabled) obj.HQEnabled = true;
                hqs[obj.ObjId] = obj;
                break;
            case playerSpawnerType:
                obj.type = 'PlayerSpawner';
                if (!obj.SpawnPoints) {
                    obj.SpawnPoints = [];
                }
                playerSpawners[obj.ObjId] = obj;
                break;
            case interactPointType:
                const interactPoint = obj as InteractPoint;
                interactPoint.type = 'InteractPoint';
                interactPoints[obj.ObjId] = interactPoint;
                break;
            case worldIconType:
                worldIcons[obj.ObjId] = obj;
                break;
            case mcomType:
                const mcom = obj as MCOM;
                mcoms[obj.ObjId] = mcom;
                break;
            case capturePointType:
                const capturePoint = obj as CapturePoint;
                capturePoints[obj.ObjId] = capturePoint;
                capturePoint.captureRadius = 10; // hardcoded for now
                capturePoint.currentPlayersInArea = [];
                capturePoint.captureProgress = 0;
                capturePoint.currentOwnerTeam = GetTeam(0)
                allCapturePoints.array.push(capturePoint);
                break;
            case sectorType:
                const sector = obj as Sector;
                sectors[obj.ObjId] = sector;
                if (!obj.SectorEnabled) obj.SectorEnabled = true;
                break;
            case volumeType:
                const volume = obj as PolygonVolume;
                volumes[volume.id] = volume;
                break;
            default:
                modSimObjects[obj.ObjId] = obj;
                break;
        }
    });
}

export function* AllLevelObjects() {
    // Iterate through spawners
    for (const objId in aiSpawners) {
        const obj = aiSpawners[objId];
        if (obj) {
            yield obj as ModObject;
        }
    }
    // Iterate through interact points
    for (const objId in interactPoints) {
        const obj = interactPoints[objId];
        if (obj) {
            yield obj as ModObject;
        }
    }
    // Iterate through spawn points
    for (const objId in spawnPoints) {
        const obj = spawnPoints[objId];
        if (obj) {
            yield obj as SpawnPoint;
        }
    }
    // Iterate through player objects
    for (const player of allPlayers.array) {
        yield player as ModObject;
    }
    // Iterate through MCOMS
    for (const mcomId in mcoms) {
        const mcom = mcoms[mcomId];
        if (mcom) {
            yield mcom as ModObject;
        }
    }
    // Iterate through Capture Points
    for (const objId in capturePoints) {
        const cp = capturePoints[objId];
        if (cp) {
            yield cp as ModObject;
        }
    }
    // Iterate through regular objects
    for (const objId in modSimObjects) {
        const obj = modSimObjects[objId];
        if (obj) {
            yield obj as ModObject;
        }
    }
}

export function* GetInteractPoints() {
    // Iterate through interact points
    for (const objId in interactPoints) {
        const obj = interactPoints[objId];
        if (obj) {
            yield obj;
        }
    }
}

export function AddPlayer() {
    const player = CreatePlayer();
    allPlayers.array.push(player);
    const onPlayerJoinGame = (modscript as any)['OnPlayerJoinGame'];
    if (onPlayerJoinGame) {
        console.log('Calling OnPlayerJoinGame');
        onPlayerJoinGame(player);
    } else {
        console.log('OnPlayerJoinGame not found');
    }
    return player;
}

export function StartGameMode() {
    gameModeStarted = true;
    gameModeTime = 0;
    const onGameModeStarted = modscript.OnGameModeStarted;
    if (onGameModeStarted) {
        const result = onGameModeStarted();
        if (result && typeof result.then === 'function') {
            result.then(() => {
                console.log('Game mode started');
            });
        } else {
            console.log('Game mode started');
        }
    } else {
        console.log('OnGameModeStarted not found');
    }
}

export function SendPlayerUIButtonEvent(player: mod.Player, widget: UIWidget, eventType: mod.UIButtonEvent) {
    if (modscript.OnPlayerUIButtonEvent) {
        modscript.OnPlayerUIButtonEvent(player, widget, eventType);
    } else {
        console.warn('OnPlayerUIButtonEvent not defined');
    }
}

export function GetInteractPoint(objId: number) {
    return interactPoints[objId];
}

export function EnableInteractPoint(interactPoint: InteractPoint, enable: boolean) {
    interactPoint.enabled = enable;
}

export function GetWorldIcon(objId: number) {
    const worldIcon = worldIcons[objId];
    return worldIcon;
}

export function SetWorldIconPosition(worldIcon: WorldIcon, position: Vector) {
    if (!worldIcon) {
        console.warn('SetWorldIconPosition: worldIcon is undefined');
        return;
    }
    worldIcon.position = position;
}

export function SetWorldIconText(worldIcon: WorldIcon, newText: Message) {
    if (!worldIcon) {
        console.warn('SetWorldIconText: worldIcon is undefined');
        return;
    }
    worldIcon.text = (newText as unknown as Message).text;
}

export function SetWorldIconColor(worldIcon: WorldIcon, newColor: Vector) {
    if (!worldIcon) {
        console.warn('SetWorldIconColor: worldIcon is undefined');
        return;
    }
    worldIcon.color = newColor;
}

export function SetWorldIconImage(worldIcon: WorldIcon, image: UIImageType) {
    if (!worldIcon) {
        console.warn('SetWorldIconImage: worldIcon is undefined');
        return;
    }
    worldIcon.image = image;
}

export function EnableWorldIconImage(worldIcon: WorldIcon, enableImage: boolean) {
    if (!worldIcon) {
        console.warn('EnableWorldIconImage: worldIcon is undefined');
        return;
    }
    worldIcon.enableImage = enableImage;
}

export function EnableWorldIconText(worldIcon: WorldIcon, enableText: boolean) {
    if (!worldIcon) {
        console.warn('EnableWorldIconText: worldIcon is undefined');
        return;
    }
    worldIcon.enableText = enableText;
}

export function SetWorldIconOwner(worldIcon: WorldIcon, owner: Team) {
    if (!worldIcon) {
        console.warn('SetWorldIconOwner: worldIcon is undefined');
        return;
    }
    worldIcon.team = owner.ObjId;
}

export function SpawnPlayerFromSpawnPoint(p: mod.Player, objId: number) {
    const player = p as unknown as Player;

    if (!player.deployEnabled) {
        console.warn(`SpawnPlayerFromSpawnPoint: Deployment is disabled for player ${player.name}`);
    }

    player.isAlive = true;

    player.soldier = {
        type: 'Soldier',
        weaponsSlots: {},
    };

    const playerSpawner = playerSpawners[objId];

    if (playerSpawner && playerSpawner.SpawnPoints.length > 0) {
        // Select a random spawn point from the PlayerSpawner
        const randomIndex = Math.floor(Math.random() * playerSpawner.SpawnPoints.length);
        const spawnPointStringId = playerSpawner.SpawnPoints[randomIndex];
        const spawnPoint = spawnPoints[spawnPointStringId];

        if (spawnPoint) {
            player.position = spawnPoint.position;
        } else {
            console.warn(
                `SpawnPlayerFromSpawnPoint: No spawn point found with string ID ${spawnPointStringId}, deploying at origin`
            );
            player.position = CreateVector(0, 0, 0);
        }
    } else {
        console.warn(`SpawnPlayerFromSpawnPoint: No PlayerSpawner found with ID ${objId}, deploying at origin`);
        player.position = CreateVector(0, 0, 0);
    }

    if (modscript.OnPlayerDeployed) {
        modscript.OnPlayerDeployed(player);
    } else {
        console.info('OnPlayerDeployed not defined by script');
    }
}

export function CameraSetActive(camera: mod.Cameras, player: mod.Player) {
    const c = camera as any;
    c.active = true;
    c.player = player;
}

export function GlobalVariable(n: number) {
    return {
        isGlobal: true,
        index: n,
    } as ModVariable;
}

export function ObjectVariable(object: mod.Object, n: number) {
    return {
        isGlobal: false,
        index: n,
        object: object as unknown as ModObject,
    } as ModVariable;
}

const globalVariables: any[] = [];
const playerVariables: any[] = [];
const teamVariables: any[] = [];

const objectVariablesMap: { [key: string]: any[] } = {
    Player: playerVariables,
    Team: teamVariables,
};

export function SetVariable(variable: ModVariable, value: any) {
    if (variable.isGlobal) {
        while (globalVariables.length <= variable.index) {
            globalVariables.push(undefined);
        }
        globalVariables[variable.index] = value;
    } else {
        const objectVariables = objectVariablesMap[variable.object!.type];
        while (objectVariables.length <= variable.index) {
            objectVariables.push(undefined);
        }
        objectVariables[variable.index] = value;
    }
}

export function GetVariable(variable: ModVariable) {
    if (variable.isGlobal) {
        return globalVariables[variable.index];
    } else {
        const type = variable.object!.type;
        const objectVariables = objectVariablesMap[type];
        if (variable.index >= objectVariables.length) {
            return undefined;
        }
        return objectVariables[variable.index];
    }
}

let targetScore: number = 100;

export function SetGameModeTargetScore(score: number) {
    targetScore = score;
}

export function Equals(a: mod.Any, b: mod.Any) {
    if (typeof a === 'object' && typeof b === 'object') {
        const aObj = a as ModObject;
        const bObj = b as ModObject;
        return a.ObjId === b.ObjId && aObj.type === bObj.type;
    }
    return a === b;
}

export function And(a: boolean, b: boolean) {
    return a && b;
}

export function Or(a: boolean, b: boolean) {
    return a || b;
}

export function Not(a: boolean) {
    return !a;
}

export function Subtract(a: number, b: number) {
    return a - b;
}

export function RoundToInteger(value: number) {
    return Math.round(value);
}

export function Modulo(a: number, b: number) {
    return a % b;
}

export function Divide(a: number, b: number) {
    return a / b;
}

export function Floor(value: number) {
    return Math.floor(value);
}

export function Multiply(a: number, b: number) {
    return a * b;
}

export function Add(a: number, b: number) {
    return a + b;
}

export function NotEqualTo(a: mod.Any, b: mod.Any) {
    return !Equals(a, b);
}

export function RandomValueInArray(array: ModArray) {
    if (array.array.length === 0) {
        return null;
    }
    const randomIndex = Math.floor(Math.random() * array.array.length);
    return array.array[randomIndex];
}

export function ClosestPlayerTo(arg0: Vector, team?: Team) {
    const allPlayers = mod.AllPlayers();
    const playerCount = mod.CountOf(allPlayers);
    let closestDist = Infinity;
    let closestPayer = undefined as unknown as Player;
    for (let i = 0; i < playerCount; i++) {
        const player = mod.ValueInArray(allPlayers, i);
        if (team && player.team !== team.ObjId) continue;
        const distance = mod.DistanceBetween(arg0 as unknown as mod.Vector, player.position);
        if (distance < closestDist) {
            closestDist = distance;
            closestPayer = player;
        }
    }
    return closestPayer;
}

export function IsPlayerValid(player: mod.Player) {
    if (!player) return false;
    return true;
}

export function SetPlayerArmorType(player: Player, armorType: ArmorTypes) {
    player.armorType = armorType;
}

export function RemovePlayerInventoryAtSlot(player: Player, slot: mod.InventorySlots) {
    player.inventory[slot] = undefined;
}

export enum InventoryEnum {
    PrimaryWeapons,
    SecondaryWeapons,
    OpenGadgets,
    MeleeWeapons,
    Throwables,
    MiscGadgets,
    MedGadgets,
}

export function ReplacePlayerInventory(
    player: Player,
    weapon: PrimaryWeapons | SecondaryWeapons | OpenGadgets | MeleeWeapons | Throwables | MiscGadgets | MedGadgetTypes
) {
    const weaponNum = weapon as unknown as number;
    let inventoryEnum: InventoryEnum;
    if (weaponNum < 100) inventoryEnum = InventoryEnum.PrimaryWeapons;
    else if (weaponNum < 200) {
        inventoryEnum = InventoryEnum.SecondaryWeapons;
    } else if (weaponNum < 300) {
        inventoryEnum = InventoryEnum.OpenGadgets;
    } else if (weaponNum < 400) {
        inventoryEnum = InventoryEnum.MeleeWeapons;
    } else if (weaponNum < 500) {
        inventoryEnum = InventoryEnum.Throwables;
    } else if (weaponNum < 600) {
        inventoryEnum = InventoryEnum.MiscGadgets;
    } else if (weaponNum < 700) {
        inventoryEnum = InventoryEnum.MedGadgets;
    } else {
        console.error(`ReplacePlayerInventory: Unknown weapon enum ${weapon}`);
        return;
    }
    // I doubt this slot logic is correct
    let slot: InventorySlots;
    switch (inventoryEnum) {
        case InventoryEnum.PrimaryWeapons:
            slot = InventorySlots.PrimaryWeapon;
            break;
        case InventoryEnum.SecondaryWeapons:
            slot = InventorySlots.SecondaryWeapon;
            break;
        case InventoryEnum.OpenGadgets:
            slot = InventorySlots.GadgetOne;
            break;
        case InventoryEnum.MeleeWeapons:
            slot = InventorySlots.MeleeWeapon;
            break;
        case InventoryEnum.Throwables:
            slot = InventorySlots.GadgetOne;
            break;
        case InventoryEnum.MiscGadgets:
            slot = InventorySlots.GadgetTwo;
            break;
        case InventoryEnum.MedGadgets:
            slot = InventorySlots.ClassGadget;
            break;
        default:
            console.error(`ReplacePlayerInventory: Unknown inventory enum ${inventoryEnum}`);
            return;
    }
    player.inventory[slot] = weaponNum;
}

export function SetInventoryAmmo(player: Player) {
    console.warn('SetInventoryAmmo not implemented');
}

export function SetInventoryMagazineAmmo(player: Player) {
    console.warn('SetInventoryMagazineAmmo not implemented');
}

export function ForceSwitchInventory(player: Player, inventorySlot: InventorySlots) {
    console.warn('ForceSwitchInventory not implemented');
    const soldier = player.soldier;
    if (!soldier) {
        console.warn('ForceSwitchInventory: player has no soldier');
        return;
    }
    const weaponInSlot = soldier.weaponsSlots[inventorySlot];
    if (weaponInSlot === null || weaponInSlot === undefined) {
        console.warn(`ForceSwitchInventory: No weapon in slot ${inventorySlot}`);
        return;
    }
    console.log(
        `ForceSwitchInventory: Player ${GetObjId(player)} switched to weapon ${weaponInSlot} in slot ${inventorySlot}`
    );
    soldier.weapon = weaponInSlot;
}

export function DistanceBetween(v1: Vector, v2: Vector) {
    if (!v1) {
        console.warn('DistanceBetween: v1 is undefined');
        v1 = CreateVector(0, 0, 0);
    }
    if (!v2) {
        console.warn('DistanceBetween: v2 is undefined');
        v2 = CreateVector(0, 0, 0);
    }
    const dx = v1.x - v2.x;
    const dy = 0; // Only sim 2d for now. v1.y - v2.y;
    const dz = v1.z - v2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function LessThan(a: number, b: number) {
    return a < b;
}

export function LessThanEqualTo(a: number, b: number) {
    return a <= b;
}

export function GreaterThan(a: number, b: number) {
    return a > b;
}

export function IsType(value: mod.Any, type: Types): boolean {
    if (typeof value === 'string') {
        return type == Types.String;
    }
    if (typeof value === 'number') {
        return type == Types.Number;
    }
    switch (value.type) {
        case 'Vector':
            return type == Types.Vector;
        case 'Team':
            return type == Types.Team;
        case 'Player':
            return type == Types.Player;
        case 'UIWidget':
            return type == Types.UIWidget;
        case 'Objective':
            return type == Types.Objective;
        default:
            console.error(`IsType: Unknown type ${value.type}`);
            break;
    }
    return false;
}

export function SetCameraTypeForAll(cameraType: Cameras) {
    console.warn('SetCameraTypeForAll not implemented');
}

export function SetSpectateOnDeath(spectateOnDeath: boolean) {
    console.warn('SetSpectateOnDeath not implemented');
}

export function RayCast(start: Vector, end: Vector) {
    console.warn('RayCast not implemented');
}

export function PlaySound(sfx: SFX, amplitude: number, playerOrTeam: Player | Team) {
    console.warn('PlaySound not implemented');
}

export function GetVehicleState(vehicle: Vehicle, vehicleState: VehicleStateVector) {
    if (vehicleState in VehicleStateVector) {
        return zero;
    } else {
        throw new Error(`GetVehicleState: State ${vehicleState} not implemented`);
    }
}

export function SetGameModeScore(playerOrTeam: Player | Team, newScore: number) {
    let team = playerOrTeam as Team;
    if ('Player' in playerOrTeam) {
        let player = playerOrTeam as Player;
        team = GetTeam(player.team);
    }
    const teamNum = team.ObjId;
    gameModeScore[teamNum] = newScore;
}

export function PlayVO(voiceOver: any, event: VoiceOverEvents2D, flag: VoiceOverFlags) {
    console.warn('PlayVO not implemented');
}

export function IsCurrentMap(map: Maps) {
    console.warn('IsCurrentMap not implemented');
    return false;
}

interface WeaponPackage {
    attachments: WeaponAttachments[];
}

export function CreateNewWeaponPackage() {
    return { attachments: [] };
}

export function AddAttachmentToWeaponPackage(attachment: WeaponAttachments, weaponPackage: WeaponPackage) {
    if (weaponPackage && weaponPackage.attachments) {
        weaponPackage.attachments.push(attachment);
    }
}

export function RemoveEquipment(player: Player, slotOrWeaponOrGadget: Weapons | Gadgets | InventorySlots) {
    console.log(`RemoveEquipment called for player ${GetObjId(player)}`);
    const soldier = player.soldier;
    if (!soldier) {
        console.warn('RemoveEquipment: player has no soldier');
        return;
    }
    const enumValue = slotOrWeaponOrGadget as number;
    if (enumValue in InventorySlots) {
        soldier.weaponsSlots[slotOrWeaponOrGadget as number] = null;
    } else {
        console.warn('RemoveEquipment: slotOrWeaponOrGadget is not an InventorySlots enum');
    }
}

export function AddEquipment(
    player: Player,
    weaponOrGadget: Weapons | Gadgets,
    slotOrWeaponPackage?: InventorySlots | WeaponPackage,
    desiredInventorySlot?: InventorySlots
) {
    console.log(`AddEquipment called for player ${GetObjId(player)}`);
    const soldier = player.soldier;
    if (!soldier) {
        console.warn('AddEquipment: player has no soldier');
        return;
    }
    const slotValue = slotOrWeaponPackage as number;
    if (slotValue in InventorySlots) {
        soldier.weaponsSlots[slotValue] = weaponOrGadget as number;
    } else {
        const slot = InventorySlots.PrimaryWeapon; // default slot
        soldier.weaponsSlots[slot] = weaponOrGadget as number;
    }
}

export function EnableVFX(vfx: VFX, enable: boolean) {
    console.log(`EnableVFX called for VFX ${vfx.prefab} with enable=${enable}`);
    vfx.enabled = enable;
}

export function MoveVFX(vfx: VFX, position: Vector, rotation: Vector) {
    console.log(`MoveVFX called for VFX ${vfx.prefab} to position=${position} rotation=${rotation}`);
    vfx.position = position;
    
    const matrix = eulerToRotationMatrix(rotation);
    vfx.right = matrix.right;
    vfx.up = matrix.up;
    vfx.front = matrix.front;
}

export function LoadMusic(musicPackage: MusicPackages) {
    console.log(`LoadMusic called for music package ${MusicPackages[musicPackage]}`);
}

export function PlayMusic(musicEvent: MusicEvents, playerOrTeamOrSquad?: Player | Team | Squad) {
    console.log(`PlayMusic called for music event ${MusicEvents[musicEvent]}`);
}

export function SetMusicParam(musicParam: MusicParams, paramValue: number) {
    console.log(`SetMusicParam called for music param ${MusicParams[musicParam]} with value=${paramValue}`);
}

export function ForcePlayerToSeat(player: Player, vehicle: Vehicle, seatNumber: number) {
    console.log(`ForcePlayerToSeat called for player ${GetObjId(player)} to seat ${seatNumber}`);
}

export function AISetTarget(aiPlayer: Player, targetPlayer?: Player) {
    console.log(
        `AISetTarget called for AI player ${GetObjId(aiPlayer)} with target ${targetPlayer ? GetObjId(targetPlayer) : 'none'}`
    );
}

export let stringkeys: any = {};

export function SetStrings(strings: { [key: string]: string }) {
    stringkeys = strings;
}
