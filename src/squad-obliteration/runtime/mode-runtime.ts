/* =================================================================================================
   Mind Flexor - Squad Obliteration Game Mode Script
   -------------------------------------------------------------------------------------------------
   

   Description:
     - Implements a 3-flag Domination / Conquest-Small style mode:
         * Prematch ready-up flow (team switch + ready interactions)
         * Countdown -> Pre-live -> Live -> Postmatch state machine
         * Ticket system with bleed for 2/3 flag control + death ticket loss (after first live deploy)
         * Capture UI (flag letters, on-point counts, progress bar) + remaining time + postmatch overlay
         * Dynamic HQ routing based on flag ownership and "threatened" flags
         * Safe-spawn recycling (enemy proximity check) with squad-spawn bypass probing
         * Capture audio (ticks, contested VO, captured stingers) + countdown heartbeat + match start stinger
         * Optional damage zone (AreaTrigger -> periodic damage)

   Usage / Notes:
     - This script assumes specific CapturePoint IDs, HQ IDs, InteractPoint IDs, WorldIcon IDs,
       and Godot PlayerSpawner ObjIds already placed in your level.
     - Keep IDs in sync with your map placement.

   Licensing / Credits:
     - Licensed under MIT (see root LICENSE).
     - Primary mode implementation: Enoc Bernal (mindflexor).
     - Credits: BattlefieldDad, Mancour, uberdubersoldat, and dfk_7677 for legacy logic inspiration.
     - Template and utilities foundation credit: Michael De Luca.

   Version:
     - v0.07
================================================================================================= */

import { BOMB_CONFIG } from '../config/bomb.ts';
import { SQUAD_OBJECTIVE_CONFIGS } from '../config/objectives.ts';
import { RULES } from '../config/rules.ts';
import { WORLD_IDS } from '../config/world-ids.ts';
import { modlib } from '../utils/mod-compat.ts';
import { PerformanceStats } from 'bf6-portal-utils/performance-stats/index.ts';
import { Timers } from 'bf6-portal-utils/timers/index.ts';

/* =================================================================================================
   1) CORE CONFIGURATION
================================================================================================= */

const VERSION = [2, 0, 0];

const TICK_RATE = 30;                    // OngoingGlobal is treated as 30 ticks/sec

const USE_ENGINE_TIME_SCHEDULER = true;
const DEBUG_PERF_TELEMETRY = false;
const ENABLE_CARRIER_SUBTICK = true;
const DEBUG_CARRIER_SUBTICK = false;
const ICON_FOLLOW_INTERVAL_SECONDS = 0.05; // 20 Hz
const FAST_INTERVAL_SECONDS = 0.10; // 10 Hz
const SLOW_INTERVAL_SECONDS = 0.30; // 3.3 Hz
const ENDGAME_AUDIO_INTERVAL_SECONDS = 0.50; // 2 Hz
const VISUAL_SUBTICK_ENGINE_CLOSE_TOLERANCE_SECONDS = 1.0;
const VISUAL_SUBTICK_BLEND_ELAPSED_WEIGHT = 0.7;
const VISUAL_SUBTICK_BLEND_REMAINING_WEIGHT = 0.3;
const VISUAL_SUBTICK_COARSE_STEP_THRESHOLD_SECONDS = 0.9;
const VISUAL_SUBTICK_FINE_STEP_THRESHOLD_SECONDS = 0.25;
const VISUAL_SUBTICK_ESTIMATED_HZ_MIN = 10;
const VISUAL_SUBTICK_ESTIMATED_HZ_MAX = 120;
const VISUAL_SUBTICK_DEBUG_LOG_INTERVAL_SECONDS = 5;

// Performance throttles (reduce per-tick work to avoid server Hz drops)
const LIVE_FAST_UPDATE_INTERVAL_TICKS = mod.Max(1, mod.Floor(FAST_INTERVAL_SECONDS * TICK_RATE)); // ~10 Hz
const LIVE_SLOW_UPDATE_INTERVAL_TICKS = mod.Max(1, mod.Floor(SLOW_INTERVAL_SECONDS * TICK_RATE));  // ~3.3 Hz
const LIVE_ENDGAME_AUDIO_INTERVAL_TICKS = mod.Max(1, mod.Floor(ENDGAME_AUDIO_INTERVAL_SECONDS * TICK_RATE)); // ~2 Hz
const INITIAL_TICKETS = 0;
const WIN_SCORE = RULES.matchScoreCap;
const HALF_SCORE_CAP = RULES.halfScoreCap;
const CIPHER_KEYS_TO_DESTROY_OBJECTIVE = RULES.cipherKeysToDestroyObjective;
const CIPHER_COUNTER_Y_OFFSET_METERS = 5.5;
const CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS = 30;
const CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS = 5;
const CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS = 2.0;

const ROUND_TIME = RULES.halfTimeSeconds;                // seconds
const OVERTIME_TIME = RULES.suddenDeathSeconds;              // seconds
const TOTAL_TICKS = ROUND_TIME * TICK_RATE;
const LIVE_ENGINE_TIME_LIMIT_SAFETY_SECONDS = 7200;
const LIVE_TIMER_INTRO_SECONDS = 3.0;
const LIVE_TIMER_DEFAULT_POS_X = 123.99;
const LIVE_TIMER_DEFAULT_POS_Y = 698.56;
const LIVE_TIMER_DEFAULT_WIDTH = 130;
const LIVE_TIMER_DEFAULT_HEIGHT = 34;
const LIVE_TIMER_DEFAULT_TEXT_POS_X = -6;
const LIVE_TIMER_DEFAULT_TEXT_POS_Y = 6;
const LIVE_TIMER_DEFAULT_TEXT_WIDTH = 130;
const LIVE_TIMER_DEFAULT_TEXT_HEIGHT = 34;
const LIVE_TIMER_DEFAULT_TEXT_SIZE = 24;
const LIVE_TIMER_INTRO_WIDTH = 676;
const LIVE_TIMER_INTRO_HEIGHT = 176;
const LIVE_TIMER_INTRO_POS_X = 0;
const LIVE_TIMER_INTRO_POS_Y = -222;
const LIVE_TIMER_INTRO_LABEL_POS_X = 0;
const LIVE_TIMER_INTRO_LABEL_POS_Y = -52;
const LIVE_TIMER_INTRO_LABEL_WIDTH = 438;
const LIVE_TIMER_INTRO_LABEL_HEIGHT = 50;
const LIVE_TIMER_INTRO_LABEL_TEXT_SIZE = 46;
const LIVE_TIMER_INTRO_LABEL_TEXT_COLOR: [number, number, number] = [0.4392, 0.9216, 1];
const LIVE_TIMER_INTRO_VALUE_POS_X = 0;
const LIVE_TIMER_INTRO_VALUE_POS_Y = 14;
const LIVE_TIMER_INTRO_VALUE_WIDTH = 100;
const LIVE_TIMER_INTRO_VALUE_HEIGHT = 50;
const LIVE_TIMER_INTRO_VALUE_TEXT_SIZE = 55;
const LIVE_TIMER_INTRO_VALUE_TEXT_COLOR: [number, number, number] = [1, 0.5137, 0.3804];

const COUNT_DOWN_TIME = 5;              // ready-up delay before forced undeploy into pre-live
const PRELIVE_TIME = 15;                // seconds (pre-live freeze)
const POSTMATCH_TIME = 20;              // seconds

const REDEPLOY_TIME = RULES.redeployTimeSeconds; // live redeploy time
const DEATH_TICKET_LOSS = 0;           // tickets after first live deploy

const BLEED_TWO_FLAGS = 0;           // per second
const BLEED_THREE_FLAGS = 0;           // per second
const BLEED_ONE_FLAG = 0;

// Damage smoothing (applies in OnPlayerDamaged)
const ENABLE_DAMAGE_SMOOTHING = false;   // set to false to disable smoothing
const ENABLE_DYNAMIC_HQ_ROUTING = false;
// Master switch for string-table-backed debug/warn world logs listed in squadoblistrings.
const ENABLE_STRINGKEY_DEBUG_WORLD_LOGS = false;


const CAPTURE_TIME = 0.5;                 // seconds to capture neutral -> owned
const NEUTRALIZE_TIME = 0.5;              // seconds to neutralize owned -> neutral
const CAPTURE_MULTIPLIER_FOR_2_PLAYERS = 0;     // 2 players => 2x speed => time / 2
const CAPTURE_MULTIPLIER_MAX = 1;               // cap it (keep BF4-ish, avoids insane speeds)
const OBJECTIVE_CAPTURE_LOCKED_CAPTURE_TIME = 9999;
const OBJECTIVE_CAPTURE_LOCKED_NEUTRALIZE_TIME = 9999;
const OBJECTIVE_INTERACT_HOLD_SECONDS = RULES.objectiveInteractHoldSeconds;
const OBJECTIVE_INTERACT_HOLD_TICKS = OBJECTIVE_INTERACT_HOLD_SECONDS * TICK_RATE;
const OBJECTIVE_SCORE_HOLD_SECONDS = RULES.objectiveArmedDestroySeconds;
const OBJECTIVE_SCORE_HOLD_TICKS = OBJECTIVE_SCORE_HOLD_SECONDS * TICK_RATE;
const DEBUG_OBJECTIVE_DELAYED_AWARD = false;
const DEBUG_OBJECTIVE_NATIVE_EVENT_FLOW = false;

const COLOR_NEUTRAL = mod.CreateVector(0.65, 0.65, 0.65);
const COLOR_FRIENDLY = mod.CreateVector(0.10, 0.55, 1.00);

// Enemy: bright flat red
const COLOR_ENEMY = mod.CreateVector(
    1,
    72 / 255,
    58 / 255
);
/* Capture progress float tolerances */
const PROGRESS_EPSILON = 0.02;
const PROGRESS_FULL = 1 - PROGRESS_EPSILON;
const PROGRESS_EMPTY = PROGRESS_EPSILON;

/* =================================================================================================
   2) TEAM / PHASE STATE
================================================================================================= */

const teamNeutral: mod.Team = mod.GetTeam(0);
const team1: mod.Team = mod.GetTeam(1);
const team2: mod.Team = mod.GetTeam(2);

/*
  Game status:
    -1: not started
     0: prematch
     1: redeploy countdown
     2: pre-live
     3: live
     4: postmatch
*/
let gameStatus: number = -1;

let gameModeStarted: boolean = false;

let serverTickCount: number = 0;
let phaseTickCount: number = 0;
let countDown: number = COUNT_DOWN_TIME;
let lastTicketBleedTimeElapsed = 0;
let currentFrameNowSec = 0;
let currentFrameHasEngineNowSec = false;
const CIPHER_HOT_LANE_FALLBACK_AFTER_SECONDS = (1 / TICK_RATE) + 0.02;
let lastCipherHotLaneRunAtSec = 0;
let cipherHotLaneFallbackWarned = false;
let phaseCountdownDeadlineAtSec = 0;
let phaseCountdownLastShownSeconds = -1;
let phaseCountdownTickDeadline = 0;
let phaseCountdownTimeSource: "engine" | "tick" | "unset" = "unset";

let schedulerNextLiveFastUpdateAtSec = 0;
let schedulerNextLiveSlowUpdateAtSec = 0;
let schedulerNextLiveEndgameAudioAtSec = 0;
let schedulerNextLiveIconFollowAtSec = 0;
let schedulerNextLiveHqSafetyAtSec = 0;
let liveGameModeLimitAtSec = 0;
let liveClockStarted = false;
let liveClockCountdownStartAtSec = 0;
let liveClockDeadlineAtSec = 0;
let liveClockCurrentPhaseDurationSeconds = 0;
let liveClockOvertimeActive = false;
let liveClockOvertimeConsumed = false;
let liveClockTimeoutHoldActive = false;
let liveTimerIntroActive = false;
let liveTimerIntroEndsAtSec = 0;
let liveTimerIntroDisplaySeconds: number = ROUND_TIME;

let initialization: boolean[] = [false, false, false, false, false];

/* Tickets are stored as [team1Tickets, team2Tickets] */
let serverScores: number[] = [INITIAL_TICKETS, INITIAL_TICKETS];

type CipherHalfIndex = 1 | 2;
type CipherMatchStage = "half1" | "half2" | "suddenDeath";
type CipherMapSide = "north" | "south";
type CipherHorizontalVariant = "west" | "east";
type CipherPresenceZone = "northWest" | "northEast" | "southWest" | "southEast";
type CipherHalfTransitionReason = "scoreCap" | "timeExpired";
type CipherSecondHalfTransitionStage = "none" | "deploy" | "countdown";

let cipherCurrentHalf: CipherHalfIndex = 1;
let cipherMatchStage: CipherMatchStage = "half1";
let cipherHalfScores: number[] = [0, 0];
let cipherObjectiveKeyCountByCpId: { [cpId: number]: number } = {};
let cipherCounterWorldIconLastShownByCpId: { [cpId: number]: number | undefined } = {};
let cipherCounterRuntimeWorldIconObjectByKey: { [key: string]: mod.Object | undefined } = {};
let cipherCounterRuntimeWorldIconHandleByKey: { [key: string]: mod.WorldIcon | undefined } = {};
let cipherCounterRuntimeWorldIconLastStateByKey: { [key: string]: string | undefined } = {};
let cipherCounterRuntimeWorldIconMissingWarnedByKey: { [key: string]: boolean } = {};
let cipherSuddenDeathEliminatedByPlayerId: { [playerId: number]: boolean } = {};
let cipherSuddenDeathUndeployIgnoreUntilSec = 0;
let cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
let cipherPendingScoreTransitionTeam: mod.Team = teamNeutral;
let cipherSecondHalfTransitionActive = false;
let cipherSecondHalfTransitionStage: CipherSecondHalfTransitionStage = "none";
let cipherSecondHalfDeployRequiredByPlayerId: { [playerId: number]: boolean } = {};
let cipherSecondHalfDeployReadyByPlayerId: { [playerId: number]: boolean } = {};
let cipherSecondHalfFrozenByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionTeleportedByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionCountdownSeconds = 0;
let cipherTransitionDeployTitleKey: any = undefined;
let cipherTransitionDeployTitleFallback = "";
let cipherTransitionStartsTitleKey: any = undefined;
let cipherTransitionStartsTitleFallback = "";
let cipherTransitionSubtitleFallback = "";
let cipherSuddenDeathTransitionActive = false;

let postmatchEndStep = 0;
let postmatchEndStepTick = 0;
let postmatchEndStepAtSec = 0;
let postmatchWinnerTeam: mod.Team = teamNeutral;
let transitionFallbackActive = false;
let transitionFallbackNextAllowedTick = 0;
let transitionWarnedByKey: { [key: string]: boolean } = {};
let liveTransitionCheckpointSeenByKey: { [key: string]: boolean } = {};
let hqEnableWarnedById: { [hqId: number]: boolean } = {};
let prematchUiGuardWarnedByKey: { [key: string]: boolean } = {};
const TRANSITION_FALLBACK_RETRY_COOLDOWN_TICKS = mod.Max(1, mod.Floor(2 * TICK_RATE));
let transitionSpawnRequestedByPlayerId: { [playerId: number]: boolean } = {};
let transitionSpawnLastAttemptTickByPlayerId: { [playerId: number]: number } = {};
let transitionSpawnInFlightByPlayerId: { [playerId: number]: boolean } = {};
let transitionSpawnWarnedByKey: { [key: string]: boolean } = {};
let objectiveEngineWarnedByKey: { [key: string]: boolean } = {};
const TRANSITION_SPAWN_MIN_RETRY_TICKS = mod.Max(1, mod.Floor(0.1 * TICK_RATE));
const TRANSITION_SPAWN_INFLIGHT_TIMEOUT_TICKS = mod.Max(1, mod.Floor(1.5 * TICK_RATE));
const DEBUG_TRANSITION_SPAWN_DIAGNOSTICS = false;
const PREMATCH_SWITCH_DEBOUNCE_TICKS = 6;
const PRELIVE_TEAM_SWITCH_STABILIZE_TICKS = 10;
const PRELIVE_TEAM_SWITCH_STABILIZE_SECONDS = PRELIVE_TEAM_SWITCH_STABILIZE_TICKS / TICK_RATE;
let prematchSwitchLastHandledTickByPlayerId: { [playerId: number]: number } = {};
let prematchSwitchDebounceWarnedByPlayerId: { [playerId: number]: boolean } = {};
let lastPrematchTeamSwitchTick = -999999;
let lastPrematchTeamSwitchAtSec = -999999;
let lastPrematchTeamSwitchTickByPlayerId: { [playerId: number]: number } = {};
let prematchStabilizationGateWarnedBySwitchTick: { [switchTick: string]: boolean } = {};
let preliveTeamSanityWarnedByPlayerId: { [playerId: number]: boolean } = {};
let prematchHqMapValidationWarnedByKey: { [key: string]: boolean } = {};
let prematchReadyPlayersByTeam: [number, number] = [0, 0];
let prematchTotalPlayersByTeam: [number, number] = [0, 0];
let prematchAllPlayersReady = false;

const POSTMATCH_END_STEP_ADVANCE_TICKS = 1;
const POSTMATCH_END_STEP_ADVANCE_SECONDS = POSTMATCH_END_STEP_ADVANCE_TICKS / TICK_RATE;

/* =================================================================================================
   3) WORLD IDS (HQ / CAPTURE POINTS / INTERACT / ICONS / DAMAGE ZONE)
================================================================================================= */

/* Initial HQs (countdown + prelive + live fallback routing) */
const TEAM1_INITIAL_HQ = 1;
const TEAM2_INITIAL_HQ = 2;

/* Prematch ready-up HQs */
const TEAM1_READYUP_HQ = 8888;
const TEAM2_READYUP_HQ = 8889;
let resolvedPrematchHqTeam1Id: number = TEAM1_READYUP_HQ;
let resolvedPrematchHqTeam2Id: number = TEAM2_READYUP_HQ;
let prematchHqFallbackActive = false;

/* Legacy live HQs (disabled during live routing) */
const TEAM1_LIVE_HQ = 3;
const TEAM2_LIVE_HQ = 4;

/* Per-flag HQs */
const TEAM1_FLAG_A_HQ = 5;
const TEAM1_FLAG_B_HQ = 6;
const TEAM1_FLAG_C_HQ = 7;

const TEAM2_FLAG_A_HQ = 8;
const TEAM2_FLAG_B_HQ = 9;
const TEAM2_FLAG_C_HQ = 10;

/* Two-flag combos */
const TEAM1_AB_HQ = 11;
const TEAM1_AC_HQ = 12;
const TEAM1_BC_HQ = 13;

const TEAM2_AB_HQ = 14;
const TEAM2_AC_HQ = 15;
const TEAM2_BC_HQ = 16;

/* All three flags */
const TEAM1_ABC_HQ = 17;
const TEAM2_ABC_HQ = 18;

/* No flags */
const TEAM1_NO_FLAG_HQ = 19;
const TEAM2_NO_FLAG_HQ = 20;

/* CapturePoint IDs */
const CP_A_ID = 201;
const CP_B_ID = 202;
const CP_C_ID = 203;
const CP_NORTH_B_NEUTRAL_ID = 204;
const CP_T2_B_ID = 301;
const CP_T2_C_ID = 302;
const CP_T2_A_NEUTRAL_ID = 303;
const CP_T2_B_NEUTRAL_ID = 304;
const AUTHORED_OBJECTIVE_NATIVE_SECTOR_ID = 200;
const AUTHORED_LEGACY_CAPTURE_POINT_SECTOR_ID = 300;
const AUTHORED_NORTH_NEUTRAL_SECTOR_ID = 210;
const AUTHORED_SOUTH_NEUTRAL_SECTOR_ID = 310;
const NORTH_OBJECTIVE_CP_IDS: number[] = [CP_A_ID, CP_B_ID];
const SOUTH_OBJECTIVE_CP_IDS: number[] = [CP_T2_B_ID, CP_T2_C_ID];
const TEAM1_DEFENDER_CP_IDS: number[] = NORTH_OBJECTIVE_CP_IDS;
const TEAM2_DEFENDER_CP_IDS: number[] = SOUTH_OBJECTIVE_CP_IDS;
const ALL_OBJECTIVE_CP_IDS: number[] = TEAM1_DEFENDER_CP_IDS.concat(TEAM2_DEFENDER_CP_IDS);
const OBJECTIVE_REGISTRATION_ORDER: number[] = [CP_A_ID, CP_B_ID, CP_T2_B_ID, CP_T2_C_ID];
const OBJECTIVE_NEUTRAL_CP_IDS: number[] = [
  CP_C_ID,
  CP_NORTH_B_NEUTRAL_ID,
  CP_T2_A_NEUTRAL_ID,
  CP_T2_B_NEUTRAL_ID,
];
const OBJECTIVE_NEUTRAL_CP_ID_BY_ACTIVE_CP_ID: { [cpId: number]: number } = {
  [CP_A_ID]: CP_C_ID,
  [CP_B_ID]: CP_NORTH_B_NEUTRAL_ID,
  [CP_T2_B_ID]: CP_T2_A_NEUTRAL_ID,
  [CP_T2_C_ID]: CP_T2_B_NEUTRAL_ID,
};
const OBJECTIVE_ACTIVE_CP_ID_BY_NEUTRAL_CP_ID: { [cpId: number]: number } = {
  [CP_C_ID]: CP_A_ID,
  [CP_NORTH_B_NEUTRAL_ID]: CP_B_ID,
  [CP_T2_A_NEUTRAL_ID]: CP_T2_B_ID,
  [CP_T2_B_NEUTRAL_ID]: CP_T2_C_ID,
};

type ObjectiveLetter = "A" | "B" | "C" | "D" | "E" | "F";
type TopHudLane = "A" | "B" | "C" | "D" | "E" | "F";
type ObjectiveAttemptKind = "arm" | "disarm";
type ObjectiveDefinition = {
  cpId: number;
  mcomId: number;
  lane: ObjectiveLetter;
  displayLane: ObjectiveLetter;
  defendingTeam: mod.Team;
  countsForRouting: boolean;
};

const OBJECTIVE_DEFINITIONS: ObjectiveDefinition[] = SQUAD_OBJECTIVE_CONFIGS.map((config) => ({
  cpId: config.cpId,
  mcomId: config.mcomId,
  lane: config.lane,
  displayLane: config.displayLane ?? config.lane,
  defendingTeam: config.defendingTeamId === 1 ? team1 : team2,
  countsForRouting: config.countsForRouting,
}));

let objectiveDefByCpId: { [cpId: number]: ObjectiveDefinition } = {};
let objectiveDefByMcomId: { [mcomId: number]: ObjectiveDefinition } = {};
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const def = OBJECTIVE_DEFINITIONS[i];
  objectiveDefByCpId[def.cpId] = def;
  objectiveDefByMcomId[def.mcomId] = def;
}

function getCipherObjectiveSide(cpId: number): CipherMapSide | undefined {
  if (NORTH_OBJECTIVE_CP_IDS.indexOf(cpId) >= 0) return "north";
  if (SOUTH_OBJECTIVE_CP_IDS.indexOf(cpId) >= 0) return "south";
  return undefined;
}

function getCipherSideDefendingTeam(side: CipherMapSide): mod.Team {
  if (cipherCurrentHalf === 1) {
    return side === "north" ? team1 : team2;
  }
  return side === "north" ? team2 : team1;
}

function getObjectiveDefendingTeamForCurrentHalf(cpId: number): mod.Team {
  const side = getCipherObjectiveSide(cpId);
  if (side) return getCipherSideDefendingTeam(side);
  const def = objectiveDefByCpId[cpId];
  return def ? def.defendingTeam : teamNeutral;
}

function getCipherTeamSideForCurrentHalf(team: mod.Team): CipherMapSide | undefined {
  if (cipherCurrentHalf === 1) {
    if (mod.Equals(team, team1)) return "north";
    if (mod.Equals(team, team2)) return "south";
    return undefined;
  }

  if (mod.Equals(team, team1)) return "south";
  if (mod.Equals(team, team2)) return "north";
  return undefined;
}

// Dynamic HQ routing only. This does not control native objective letter labels.
const ROUTING_OBJECTIVE_CP_IDS: number[] = ALL_OBJECTIVE_CP_IDS;
const TOP_HUD_LANES: TopHudLane[] = ["A", "B", "E", "F"];

/* Prematch InteractPoints (switch team + ready) */
const IP_T1_SWITCH = 2001;
const IP_T1_READY = 2002;
const IP_T2_SWITCH = 2003;
const IP_T2_READY = 2004;

/* Live spectator InteractPoint */
const IP_SPECTATOR = 6001;
const OBJECTIVE_INTERACT_POINT_ID_BY_CP_ID: { [cpId: number]: number } =
  WORLD_IDS.interactPoints.objectiveByCapturePoint;
const OBJECTIVE_CP_ID_BY_INTERACT_POINT_ID: { [interactId: number]: number } = {};
const OBJECTIVE_AREA_TRIGGER_ID_BY_CP_ID: { [cpId: number]: number } =
  WORLD_IDS.areaTriggers.objectiveByCapturePoint;
const OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID: { [triggerId: number]: number } = {};
const OBJECTIVE_AREA_TRIGGER_IDS: number[] = [];
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
  const triggerId = OBJECTIVE_AREA_TRIGGER_ID_BY_CP_ID[cpId];
  if (!(triggerId > 0)) continue;
  OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID[triggerId] = cpId;
  if (OBJECTIVE_AREA_TRIGGER_IDS.indexOf(triggerId) >= 0) continue;
  OBJECTIVE_AREA_TRIGGER_IDS.push(triggerId);
}
const OBJECTIVE_INTERACT_POINT_IDS: number[] = [];
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
  const interactId = OBJECTIVE_INTERACT_POINT_ID_BY_CP_ID[cpId];
  if (!(interactId > 0)) continue;
  OBJECTIVE_CP_ID_BY_INTERACT_POINT_ID[interactId] = cpId;
  if (OBJECTIVE_INTERACT_POINT_IDS.indexOf(interactId) >= 0) continue;
  OBJECTIVE_INTERACT_POINT_IDS.push(interactId);
}

/* Prematch WorldIcons */
const WORLDICON_T1_SWITCH = 5001;
const WORLDICON_T1_READY = 5002;
const WORLDICON_T2_SWITCH = 5003;
const WORLDICON_T2_READY = 5004;

/* Damage zone AreaTrigger */
const DAMAGE_TRIGGER_ID = WORLD_IDS.areaTriggers.damage;
const RESTRICTED_AREA_TRIGGER = WORLD_IDS.areaTriggers.restricted;
const COMBAT_BOUNDARY_TRIGGER_ID = WORLD_IDS.areaTriggers.combatBoundary;
const TEAM1_HQ_PROTECTION_TRIGGER_ID = WORLD_IDS.areaTriggers.team1HqProtection;
const TEAM2_HQ_PROTECTION_TRIGGER_ID = WORLD_IDS.areaTriggers.team2HqProtection;
const PREMATCH_HEALTH_AREA_TRIGGER_ID = WORLD_IDS.areaTriggers.prematchHealth;
const PREMATCH_HEALTH_NORMAL_MAX = 100;
const PREMATCH_HEALTH_OUTSIDE_MAX = 100;
const PREMATCH_HEALTH_FULL_HEAL_AMOUNT = 9999;
const RESTRICTED_AREA_LETHAL_CONFIRM_DELAY_MS = 1;
const RESTRICTED_AREA_UI_ACTIVATION_DELAY_SECONDS = 0.66;
const RESTRICTED_AREA_TRIGGER_IDS: number[] = [
  RESTRICTED_AREA_TRIGGER,
  TEAM1_HQ_PROTECTION_TRIGGER_ID,
  TEAM2_HQ_PROTECTION_TRIGGER_ID,
];
const BOMB_LOOT_GADGET: mod.Gadgets = mod.Gadgets.Misc_PortalGadget;
const BOMB_PICKUP_TRIGGER_ID = BOMB_CONFIG.pickupTriggerId;
const BOMB_USE_PICKUP_AREA_TRIGGER_AUTHORITY = false;
const BOMB_ANCHOR_SECTOR_ID = BOMB_CONFIG.anchorSectorId;
const BOMB_ANCHOR_CAPTURE_POINT_IDS = BOMB_CONFIG.anchorCapturePointIds;
const BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID = BOMB_CONFIG.quadBikeSpawnCapturePointId;

type BombBaseSlotConfig = {
  anchorCapturePointId: number;
};

const BOMB_BASE_SLOT_CONFIGS: BombBaseSlotConfig[] = BOMB_ANCHOR_CAPTURE_POINT_IDS.map((anchorCapturePointId) => ({
  anchorCapturePointId,
}));
const BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS: number[] = [];
for (let i = 0; i < BOMB_ANCHOR_CAPTURE_POINT_IDS.length; i++) {
  const cpId = BOMB_ANCHOR_CAPTURE_POINT_IDS[i];
  if (cpId <= 0) continue;
  if (BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS.indexOf(cpId) >= 0) continue;
  BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS.push(cpId);
}
if (
  BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID > 0 &&
  BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS.indexOf(BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID) < 0
) {
  BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS.push(BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID);
}
const BOMB_DEFAULT_BASE_SLOT_INDEX = 0;
const BOMB_RUNTIME_LOOT_SPAWNER_ASSET: mod.RuntimeSpawn_Common = mod.RuntimeSpawn_Common.LootSpawner;
const BOMB_RUNTIME_LOOT_SPAWNER_SCALE = mod.CreateVector(1, 1, 1);
const BOMB_QUAD_BIKE_RUNTIME_SPAWNER_ASSET: mod.RuntimeSpawn_Common = mod.RuntimeSpawn_Common.VehicleSpawner;
const BOMB_QUAD_BIKE_VEHICLE_TYPE: mod.VehicleList = mod.VehicleList.Quadbike;
const BOMB_QUAD_BIKE_ROTATION_FALLBACK = mod.CreateVector(0, 0, 0);
const BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS = BOMB_CONFIG.playerDroppedRelocationDelaySeconds;
const BOMB_PLAYER_DROPPED_EXPLOSION_RESPAWN_DELAY_SECONDS = BOMB_CONFIG.playerDroppedExplosionRespawnDelaySeconds;
const BOMB_PLAYER_DROPPED_EXPLOSION_DAMAGE_RADIUS_METERS = BOMB_CONFIG.playerDroppedExplosionDamageRadiusMeters;
const BOMB_PLAYER_DROPPED_EXPLOSION_DAMAGE = BOMB_CONFIG.playerDroppedExplosionDamage;
const CIPHER_KEY_DELIVERY_RESPAWN_DELAY_SECONDS = BOMB_CONFIG.cipherKeyDeliveryRespawnDelaySeconds;
const BOMB_LIVE_START_INITIAL_SPAWN_DELAY_SECONDS = BOMB_CONFIG.liveStartInitialSpawnDelaySeconds;
const BOMB_DYNAMIC_RETRY_DELAY_SECONDS = BOMB_CONFIG.dynamicSpawnRetryDelaySeconds;
const BOMB_BASE_FIRST_PICKUP_RADIUS_METERS = 2;
const BOMB_DROPPED_RECLAIM_RADIUS_METERS = 2;
const BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS = 3;
const BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_TICKS = mod.Max(
  1,
  mod.Floor(BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS * TICK_RATE)
);
const BOMB_DROP_WORLDICON_ASSET: mod.RuntimeSpawn_Common = mod.RuntimeSpawn_Common.WorldIcon;
const BOMB_DROP_WORLDICON_IMAGE: mod.WorldIconImages = mod.WorldIconImages.Bomb;
const BOMB_DROP_WORLDICON_COLOR = mod.CreateVector(1, 1, 1);
const BOMB_WORLDICON_TEXT_FALLBACK = "CIPHER KEY";
const BOMB_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK = "CIPHER KEY\n0{}:{}{}";
const BOMB_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK = "CIPHER KEY\n{}:{}{}";
const BOMB_DROP_ROTATION = mod.CreateVector(0, 0, 0);
const BOMB_NEUTRAL_LOOP_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Gauntlet_Mission_Circuit_TerminalSpotLoop_SimpleLoop3D;
const BOMB_CARRIER_LOOP_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Gauntlet_Mission_Heist_AltCacheCarrierBeep_SimpleLoop3D;
const BOMB_DROP_ONE_SHOT_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_BR_Mission_DemoCrew_BombPlace_OneShot3D;
const BOMB_SPAWN_STINGER_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Wreckage_BombBeeping_OneShot2D;
const BOMB_NEUTRAL_LOOP_VOLUME = 0.2;
const BOMB_CARRIER_LOOP_VOLUME = 0.24;
const BOMB_DROP_ONE_SHOT_VOLUME = 0.75;
const BOMB_SPAWN_STINGER_VOLUME = 1.0;
const BOMB_SOUND_ATTENUATION_RANGE = 120;
const BOMB_DROP_ONE_SHOT_CLEANUP_SECONDS = 2.5;
const BOMB_CARRIER_LOOP_REANCHOR_DISTANCE_METERS = 3;
const BOMB_CARRIER_LOOP_REANCHOR_COOLDOWN_SECONDS = 0.35;
const CARRIER_PULSE_FREQ_HZ = 1.4;
const CARRIER_PULSE_ALPHA_MIN = 0.35;
const CARRIER_PULSE_ALPHA_MAX = 1.0;
const BOMB_CARRIER_ICON_ASSET: mod.RuntimeSpawn_Common = mod.RuntimeSpawn_Common.WorldIcon;
const BOMB_CARRIER_ICON_IMAGE: mod.WorldIconImages = mod.WorldIconImages.Bomb;
const BOMB_CARRIER_ICON_FRIENDLY_COLOR = COLOR_FRIENDLY;
const BOMB_CARRIER_ICON_ENEMY_COLOR = COLOR_ENEMY;
const BOMB_CARRIER_ICON_BLINK_ON_SECONDS = 3;
const BOMB_CARRIER_ICON_BLINK_OFF_SECONDS = 3;
const BOMB_CARRIER_ICON_BLINK_ON_TICKS = mod.Max(1, mod.Floor(BOMB_CARRIER_ICON_BLINK_ON_SECONDS * TICK_RATE));
const BOMB_CARRIER_ICON_BLINK_OFF_TICKS = mod.Max(1, mod.Floor(BOMB_CARRIER_ICON_BLINK_OFF_SECONDS * TICK_RATE));
const BOMB_CARRIER_ICON_BLINK_CYCLE_TICKS = BOMB_CARRIER_ICON_BLINK_ON_TICKS + BOMB_CARRIER_ICON_BLINK_OFF_TICKS;
const BOMB_CARRIER_ICON_BLINK_CYCLE_SECONDS = BOMB_CARRIER_ICON_BLINK_ON_SECONDS + BOMB_CARRIER_ICON_BLINK_OFF_SECONDS;
const BOMB_CARRIER_ICON_HEIGHT_OFFSET_METERS = 1.5;
const BOMB_CARRIER_ICON_HARD_SNAP_DISTANCE_METERS = 4;
const BOMB_CARRIER_DROP_Y_EPSILON_METERS = 0.15;
const BOMB_CARRIER_DROP_STABLE_SECONDS = 1.0;
const BOMB_SPAWN_CONTEXT_BASE_PICKUP = "base_lootspawner";
const BOMB_SPAWN_CONTEXT_DROPPED_PICKUP = "dropped_lootspawner";
const BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON = "dropped_worldicon";
const BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON_REASSERT = "dropped_worldicon_reassert";
const BOMB_CARRIER_INVENTORY_SLOT = mod.InventorySlots.GadgetOne;
const BOMB_DEPLOY_LOADOUT_APPLY_DELAY_SECONDS = 0.5;
const BOMB_DEPLOY_LOADOUT_SLOT_SETTLE_SECONDS = 0.1;
const BOMB_GADGET_ONE_RESTORE_INSERT_SETTLE_SECONDS = 0.5;
const DEBUG_BOMB_PICKUP = false;

const OBJECTIVE_MCOM_ID_BY_CP_ID: { [cpId: number]: number } = {};
const OBJECTIVE_CP_ID_BY_MCOM_ID: { [mcomId: number]: number } = {};
let objectiveResolvedMcomIdByCpId: { [cpId: number]: number | undefined } = {};
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const def = OBJECTIVE_DEFINITIONS[i];
  OBJECTIVE_MCOM_ID_BY_CP_ID[def.cpId] = def.mcomId;
  OBJECTIVE_CP_ID_BY_MCOM_ID[def.mcomId] = def.cpId;
  objectiveResolvedMcomIdByCpId[def.cpId] = def.mcomId;
}
const EXPECTED_OBJECTIVE_MCOM_IDS: number[] = OBJECTIVE_DEFINITIONS.map((def) => def.mcomId);

const DAMAGE_PER_PULSE = 8;
const DAMAGE_INTERVAL_SECONDS = 0.25;
const DAMAGE_ZONE_PULSE_INTERVAL_MS = mod.Max(1, mod.Floor(DAMAGE_INTERVAL_SECONDS * 1000));

/* Fire VFX enabled at match start */ 
const FIRE_IDS = [
  331, 332, 333, 334, 335, 336, 337, 338, 339, 340,
  341, 342, 343, 344, 345, 346, 347, 348, 349,
];
const fireVfx: mod.VFX[] = FIRE_IDS.map((id) => mod.GetVFX(id));
const OBJECTIVE_AWARD_CP_IDS: number[] = [
  CP_A_ID,
  CP_B_ID,
  CP_T2_B_ID,
  CP_T2_C_ID,
];
const OBJECTIVE_AWARD_VFX_IDS: number[] = [8101, 8102, 8203, 8202];
const objectiveAwardVfx: mod.VFX[] = OBJECTIVE_AWARD_VFX_IDS.map((id) => mod.GetVFX(id));
const OBJECTIVE_ARMED_WORLDICON_ID_BY_CP_ID: { [cpId: number]: number } = {
  [CP_A_ID]: 221,
  [CP_B_ID]: 222,
  [CP_T2_B_ID]: 323,
  [CP_T2_C_ID]: 322,
};
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_NAME = "FX_Car_Fire_M_GS";
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_IDS: number[] = [211, 212, 313, 312];
const objectiveAwardPersistentFirePrimaryVfx: mod.VFX[] = OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_IDS.map((id) =>
  mod.GetVFX(id)
);
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_NAME = "FX_CarFire_FrameCrawl";
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_VFX_IDS: number[] = [611, 612, 713, 712];
const objectiveAwardPersistentFireSecondaryVfx: mod.VFX[] = OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_VFX_IDS.map((id) =>
  mod.GetVFX(id)
);
const OBJECTIVE_AWARD_BURST_ENABLED = true;
const OBJECTIVE_AWARD_BURST_LIFETIME_SECONDS = 4.0;
const OBJECTIVE_AWARD_BURST_TEAM1_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.FX_Gadget_C4_Explosives_Detonation;
const OBJECTIVE_AWARD_BURST_TEAM2_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.FX_Gadget_C4_Explosives_Detonation;
const OBJECTIVE_AWARD_EXPLOSION_ONESHOT_ENABLED = true;
const OBJECTIVE_AWARD_EXPLOSION_ONESHOT_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.FX_Vehicle_Car_Destruction_Death_Explosion_PTV;
const OBJECTIVE_AWARD_PERSISTENT_FIRE_ENABLED = true;
const OBJECTIVE_AWARD_BURST_ROTATION = mod.CreateVector(0, 0, 0);

type ObjectiveMcomSfxRole = "alarmSimple" | "alarmLeadout" | "arming" | "arm" | "defused" | "defusing";
type ObjectiveMcomSfxConfig = {
  anchorObjectId: number;
  alarmSimple: mod.RuntimeSpawn_Common;
  alarmLeadout: mod.RuntimeSpawn_Common;
  arming: mod.RuntimeSpawn_Common;
  arm: mod.RuntimeSpawn_Common;
  defused: mod.RuntimeSpawn_Common;
  defusing: mod.RuntimeSpawn_Common;
};

const OBJECTIVE_AWARD_ALARM_LEADOUT_SECONDS = OBJECTIVE_SCORE_HOLD_SECONDS;
const OBJECTIVE_MCOM_SFX_VOLUME = 1.0;
const OBJECTIVE_MCOM_SFX_ATTENUATION_RANGE = 120;
const OBJECTIVE_MCOM_SFX_SPAWN_ROTATION = mod.CreateVector(0, 0, 0);
const OBJECTIVE_ATTEMPT_PLAYER_SFX_VOLUME = 1.0;
const OBJECTIVE_ATTEMPT_PLAYER_SFX_ATTENUATION_RANGE = 8;
const OBJECTIVE_ATTEMPT_PLAYER_SFX_CLEANUP_SECONDS = 2.5;
const OBJECTIVE_MCOM_SFX_ROLES: ObjectiveMcomSfxRole[] = [
  "alarmSimple",
  "alarmLeadout",
  "arming",
  "arm",
  "defused",
  "defusing",
];
const OBJECTIVE_ATTEMPT_ARM_COMPLETE_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Armed_OneShot3D;
const OBJECTIVE_ATTEMPT_DEFUSE_COMPLETE_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Defused_OneShot3D;
const OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Alarm_SimpleLoop3D;
const OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Alarm_Leadout_SimpleLoop3D;
const OBJECTIVE_MCOM_SFX_ARMING_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Arm_SimpleLoop3D;
const OBJECTIVE_MCOM_SFX_ARM_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Armed_OneShot3D;
const OBJECTIVE_MCOM_SFX_DEFUSED_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Defused_OneShot3D;
const OBJECTIVE_MCOM_SFX_DEFUSING_ASSET: mod.RuntimeSpawn_Common =
  mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Defusing_SimpleLoop3D;

const OBJECTIVE_MCOM_SFX_BY_CP_ID: { [cpId: number]: ObjectiveMcomSfxConfig } = {
  [CP_A_ID]: {
    anchorObjectId: 4501,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_B_ID]: {
    anchorObjectId: 4506,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_T2_B_ID]: {
    anchorObjectId: 4611,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_T2_C_ID]: {
    anchorObjectId: 4606,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
};


/* =================================================================================================
   4) DYNAMIC ROUTING + SAFE SPAWN (GODOT PLAYERSPAWNERS)
================================================================================================= */

type DynamicRouteKey = "A" | "B" | "C" | "AB" | "AC" | "BC" | "ABC" | "NO";

/*
  Godot PlayerSpawner ObjId mapping.
  Fill arrays with the ObjIds you placed in Godot.
*/
const TEAM1_SPAWNERS_BY_ROUTE: Record<DynamicRouteKey, number[]> = {
  A: [9101],
  B: [9102],
  C: [9103],
  AB: [9104],
  AC: [9105],
  BC: [9106],
  ABC: [9107],
  NO: [9108],
};

const TEAM2_SPAWNERS_BY_ROUTE: Record<DynamicRouteKey, number[]> = {
  A: [9201],
  B: [9202],
  C: [9203],
  AB: [9204],
  AC: [9205],
  BC: [9206],
  ABC: [9207],
  NO: [9208],
};

/* Current HQ routing for each team (safe-spawn and spawn routing use this) */
let currentDynamicHqTeam1: number = TEAM1_INITIAL_HQ;
let currentDynamicHqTeam2: number = TEAM2_INITIAL_HQ;

/* Player routing + safe-spawn state */
let lastDynamicHqForPlayer: { [playerId: number]: number } = {};
// Pending route chosen at deploy time; only committed after a successful safe-spawn check.
let pendingDynamicHqForPlayer: { [playerId: number]: number | undefined } = {};
let safeSpawnSpawnerIndex: { [playerId: number]: number } = {};
let liveBaseHqsUnlocked = false;


let safeSpawnUnsafePending: { [playerId: number]: boolean } = {};
let safeSpawnUnsafeSpawnerObjId: { [playerId: number]: number } = {};
let safeSpawnUnsafeHqObjIdByPlayerId: { [playerId: number]: number } = {};
let safeSpawnForcedRedeploys: { [playerId: number]: number } = {};
let safeSpawnPendingCheck: { [playerId: number]: boolean } = {};
let safeSpawnForcedUndeploy: { [playerId: number]: boolean } = {};
let lastLiveHqSpawnPointObjIdByPlayerId: { [playerId: number]: number } = {};
let lastForcedSafeSpawnHqObjIdByPlayerId: { [playerId: number]: number } = {};

/* HQ DESYNC FIX: detect "spawned at HQ spawner object origin" and recycle spawn */
let hqDesyncForcedRedeploys: { [playerId: number]: number } = {};

const HQ_DESYNC_SPAWNER_EPSILON_METERS = 0.5; // treat "0 meters" as <= this threshold (float-safe)
const HQ_DESYNC_MAX_FORCED_REDEPLOYS = 2;     // safety: prevent infinite loops


/* Safe spawn tuning */
const SAFE_SPAWN_CHECK_DELAY_SECONDS = 0.1;
const SAFE_SPAWN_ENEMY_RADIUS_METERS = 8;

// This is the number of unsafe attempts allowed before we stop forcing recycle attempts.
const SAFE_SPAWN_MAX_FORCED_REDEPLOYS = 5;
const LIVE_SAFE_SPAWN_TEAM1_HQ_IDS: number[] = [TEAM1_INITIAL_HQ, TEAM1_LIVE_HQ];
const LIVE_SAFE_SPAWN_TEAM2_HQ_IDS: number[] = [TEAM2_INITIAL_HQ, TEAM2_LIVE_HQ];
const HQ_TO_PLAYERSPAWNER_ID: { [hqId: number]: number } = {
  1: 11,
  2: 12,
  3: 13,
  4: 14,
};
const LIVE_SAFE_SPAWN_TEAM1_PLAYERSPAWNER_IDS: number[] = [11, 13];
const LIVE_SAFE_SPAWN_TEAM2_PLAYERSPAWNER_IDS: number[] = [12, 14];
const LAST_HQ_RECORD_THRESHOLD_METERS = 10;

const CIPHER_PRESENCE_TRIGGER_ZONE_BY_ID: { [triggerId: number]: CipherPresenceZone } = {
  901: "northWest",
  902: "northEast",
  903: "southWest",
  904: "southEast",
};
const CIPHER_NORTH_EAST_ANCHORS: number[] = [1411, 1412, 1413, 1414, 1415, 1421, 1422, 1423, 1424, 1425];
const CIPHER_NORTH_WEST_ANCHORS: number[] = [2311, 2312, 2313, 2314, 2315, 2321, 2322, 2323, 2324, 2325];
const CIPHER_SOUTH_EAST_ANCHORS: number[] = [3411, 3412, 3413, 3414, 3415, 3421, 3422, 3423, 3424, 3425];
const CIPHER_SOUTH_WEST_ANCHORS: number[] = [4311, 4312, 4313, 4314, 4315, 4321, 4322, 4323, 4324, 4325];
const CIPHER_ANCHOR_COOLDOWN_SECONDS = 12;
const CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS = 18;

type CipherVectorSnapshot = { x: number; y: number; z: number };
type CipherQueuedSpawnAnchor = {
  anchorObjectId: number;
  side: CipherMapSide;
  variant: CipherHorizontalVariant;
};
type CipherSpawnJobKind = "queue-anchor" | "teleport-deployed";
type CipherSpawnJob = {
  kind: CipherSpawnJobKind;
  playerId: number;
  createdAtSec: number;
  attempt: number;
};

let cipherPresenceZoneActivePlayersByZone: { [zone: string]: { [playerId: number]: mod.Team } } = {};
let cipherPresenceZonesByPlayerId: { [playerId: number]: { [zone: string]: boolean } } = {};
let cipherAnchorPositionByObjectId: { [objectId: number]: mod.Vector | undefined } = {};
let cipherAnchorPositionSnapshotByObjectId: { [objectId: number]: CipherVectorSnapshot | undefined } = {};
let cipherCapturePointPositionByObjectId: { [objectId: number]: mod.Vector | undefined } = {};
let cipherCapturePointPositionSnapshotByObjectId: { [objectId: number]: CipherVectorSnapshot | undefined } = {};
let cipherPlayerPositionSnapshotByPlayerId: { [playerId: number]: CipherVectorSnapshot | undefined } = {};
let cipherAnchorCooldownUntilSecByObjectId: { [objectId: number]: number } = {};
let cipherAnchorRoundRobinIndexByKey: { [key: string]: number } = {};
let cipherVariantTieFlipBySide: { [side: string]: number } = {};
let cipherQueuedAnchorByPlayerId: { [playerId: number]: CipherQueuedSpawnAnchor | undefined } = {};
let cipherPendingSpawnJobs: CipherSpawnJob[] = [];
let cipherUrgentSpawnJobs: CipherSpawnJob[] = [];
const CIPHER_SPAWN_JOBS_PER_TICK = 1;
const CIPHER_SPAWN_RETRY_WINDOW_SECONDS = 0.75;



/* Squad-spawn bypass probing */
const SQUAD_SPAWN_DISTANCE = 8;
const SQUAD_SPAWN_PROBE_WINDOW_SECONDS = 0.25;
const SQUAD_SPAWN_PROBE_INTERVAL_SECONDS = 0.05;
const SQUAD_SPAWN_BYPASS_LIFETIME_SECONDS = 1.0;

let squadSpawnBypass: { [playerId: number]: boolean } = {};

function routeKeyFromHqId(hqId: number): DynamicRouteKey {
  // Team 1 routes
  if (hqId === TEAM1_FLAG_A_HQ) return "A";
  if (hqId === TEAM1_FLAG_B_HQ) return "B";
  if (hqId === TEAM1_FLAG_C_HQ) return "C";
  if (hqId === TEAM1_AB_HQ) return "AB";
  if (hqId === TEAM1_AC_HQ) return "AC";
  if (hqId === TEAM1_BC_HQ) return "BC";
  if (hqId === TEAM1_ABC_HQ) return "ABC";
  if (hqId === TEAM1_NO_FLAG_HQ) return "NO";

  // Team 2 routes
  if (hqId === TEAM2_FLAG_A_HQ) return "A";
  if (hqId === TEAM2_FLAG_B_HQ) return "B";
  if (hqId === TEAM2_FLAG_C_HQ) return "C";
  if (hqId === TEAM2_AB_HQ) return "AB";
  if (hqId === TEAM2_AC_HQ) return "AC";
  if (hqId === TEAM2_BC_HQ) return "BC";
  if (hqId === TEAM2_ABC_HQ) return "ABC";
  if (hqId === TEAM2_NO_FLAG_HQ) return "NO";

  return "NO";
}

function getObjectiveDef(cpId: number): ObjectiveDefinition | undefined {
  return objectiveDefByCpId[cpId];
}

function getObjectiveDefByMcomId(mcomId: number): ObjectiveDefinition | undefined {
  return objectiveDefByMcomId[mcomId];
}

function refreshObjectiveResolvedMcomAliases(context: string): void {
  objectiveDefByMcomId = {};
  objectiveResolvedMcomIdByCpId = {};

  for (const mcomIdKey in OBJECTIVE_CP_ID_BY_MCOM_ID) {
    delete OBJECTIVE_CP_ID_BY_MCOM_ID[mcomIdKey];
  }

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    objectiveDefByMcomId[def.mcomId] = def;
    OBJECTIVE_CP_ID_BY_MCOM_ID[def.mcomId] = def.cpId;
    objectiveResolvedMcomIdByCpId[def.cpId] = def.mcomId;
  }

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    const configuredMcomId = def.mcomId;
    let resolvedMcomId = configuredMcomId;

    try {
      resolvedMcomId = mod.GetObjId(mod.GetMCOM(configuredMcomId));
    } catch (_err) {}

    objectiveResolvedMcomIdByCpId[def.cpId] = resolvedMcomId;
    objectiveDefByMcomId[resolvedMcomId] = def;
    OBJECTIVE_CP_ID_BY_MCOM_ID[resolvedMcomId] = def.cpId;

    if (resolvedMcomId !== configuredMcomId) {
      emitObjectiveNativeEventFlow(
        mod.Message(
          "[OBJECTIVE MCOM ALIAS] cp/lane/configured/resolved/context {}",
          String(def.cpId) +
            "/" +
            def.lane +
            "/" +
            String(configuredMcomId) +
            "/" +
            String(resolvedMcomId) +
            "/" +
            context
        )
      );
    }
  }
}

function getObjectiveResolvedMcomIdByCpId(cpId: number): number | undefined {
  return objectiveResolvedMcomIdByCpId[cpId];
}

function resolveObjectiveCpIdFromMcomEvent(eventMCOM: mod.MCOM): number | undefined {
  return OBJECTIVE_CP_ID_BY_MCOM_ID[getObjIdSafe(eventMCOM)];
}

function logObjectiveNativeEventFlow(phase: string, eventMCOM: mod.MCOM, cpId: number | undefined): void {
  if (!DEBUG_OBJECTIVE_NATIVE_EVENT_FLOW) return;

  const rawMcomId = getObjIdSafe(eventMCOM);
  const def = cpId !== undefined ? getObjectiveDef(cpId) : undefined;
  const configuredMcomId = cpId !== undefined ? OBJECTIVE_MCOM_ID_BY_CP_ID[cpId] ?? -1 : -1;
  const resolvedMcomId = cpId !== undefined ? getObjectiveResolvedMcomIdByCpId(cpId) ?? configuredMcomId : -1;
  const pendingActive = cpId !== undefined && isObjectivePendingAwardActive(cpId) ? 1 : 0;
  const disabledAfterAward = cpId !== undefined && isObjectiveDisabledAfterAward(cpId) ? 1 : 0;

  emitObjectiveNativeEventFlow(
    mod.Message(
      "[OBJECTIVE EVENT] phase/raw/cp/lane/configured/resolved/pending/disabled/carrier {}",
      phase +
        "/" +
        String(rawMcomId) +
        "/" +
        String(cpId ?? -1) +
        "/" +
        String(def?.lane ?? "?") +
        "/" +
        String(configuredMcomId) +
        "/" +
        String(resolvedMcomId) +
        "/" +
        String(pendingActive) +
        "/" +
        String(disabledAfterAward) +
        "/" +
        String(bombCarrierPlayerId ?? -1)
    )
  );
}

let objectivePendingAwardStartTickByCpId: { [cpId: number]: number | undefined } = {};
let objectivePendingAwardStartAtSecByCpId: { [cpId: number]: number | undefined } = {};
let objectivePendingAwardDeadlineAtSecByCpId: { [cpId: number]: number | undefined } = {};
let objectivePendingAwardTeamByCpId: { [cpId: number]: mod.Team } = {};
let objectivePendingAwardTokenByCpId: { [cpId: number]: number | undefined } = {};
let objectiveCaptureInteractEnabledByCpId: { [cpId: number]: boolean } = {};
let objectiveCaptureAttemptEnabledByCpId: { [cpId: number]: boolean } = {};
let objectiveCaptureAttemptTeamByCpId: { [cpId: number]: mod.Team } = {};
let objectiveCaptureAttemptKindByCpId: { [cpId: number]: ObjectiveAttemptKind } = {};
let objectiveCaptureAttemptTokenByCpId: { [cpId: number]: number } = {};
let objectiveCaptureAttemptStartTickByCpId: { [cpId: number]: number | undefined } = {};
let objectiveCaptureAttemptStartAtSecByCpId: { [cpId: number]: number | undefined } = {};
let objectiveCaptureAttemptPlayerIdByCpId: { [cpId: number]: number | undefined } = {};
let objectiveDestroyExplosionPositionByCpId: { [cpId: number]: mod.Vector | undefined } = {};
let objectiveDisabledAfterAwardByCpId: { [cpId: number]: boolean } = {};
let objectiveDisabledOwnerTeamByCpId: { [cpId: number]: mod.Team } = {};
let objectiveAwardBurstActiveByCpId: { [cpId: number]: mod.VFX | mod.Object | undefined } = {};
let objectiveAwardBurstTokenByCpId: { [cpId: number]: number } = {};
let objectiveAwardBurstMissingAnchorWarnedByCpId: { [cpId: number]: boolean } = {};
let objectiveAwardPersistentFireMissingWarnedByKey: { [key: string]: boolean } = {};
let objectiveArmedWorldIconMissingWarnedByCpId: { [cpId: number]: boolean } = {};
let objectiveArmedWorldIconLastShownSecondsByCpId: { [cpId: number]: number | undefined } = {};
let objectiveCapturePointObjectiveEnabledByCpId: { [cpId: number]: boolean | undefined } = {};
let objectiveMcomObjectiveEnabledByCpId: { [cpId: number]: boolean | undefined } = {};
let objectiveMcomSfxHandleByKey: { [key: string]: any } = {};
let objectiveMcomSfxUnavailableByKey: { [key: string]: boolean } = {};
let objectiveMcomSfxMissingWarnedByKey: { [key: string]: boolean } = {};
let objectiveMcomSfxEnabledByKey: { [key: string]: boolean } = {};
let bombAnchorSectorMissingWarned = false;
let bombAnchorCapturePointMissingWarnedById: { [cpId: number]: boolean } = {};
let bombBaseWorldIconMissingWarnedById: { [worldIconId: number]: boolean } = {};
let bombDroppedWorldIconMissingWarned = false;
let bombBasePickupObjectSpawnWarned = false;
let bombDroppedPickupObjectSpawnWarned = false;
let bombPickupObjectUnspawnWarned = false;
let bombBasePositionResolveWarned = false;
let bombBaseReturnRespawnFailedWarned = false;
let bombStaticLootSpawnerMissingWarnedById: { [spawnerId: number]: boolean } = {};
let bombBaseSlotPositionMissingWarnedById: { [spawnerId: number]: boolean } = {};
let bombBaseFirstPickupAnchorUnavailableWarnedById: { [spawnerId: number]: boolean } = {};
let bombUnspawnAllLootWarned = false;
let bombSpawnValidationDebugByContext: { [context: string]: BombSpawnValidationDebugState | undefined } = {};
let bombBaseSpatialConfigValidated = false;

type BombRestoreEquipment = { kind: "gadget"; gadget: mod.Gadgets };

type BombPickupDelta = {
  replacedEquipment?: BombRestoreEquipment;
  replacedSlot: mod.InventorySlots;
};

type BombRestoreAmmoState = {
  sourceSlot: mod.InventorySlots;
  ammo: number;
  magazineAmmo: number;
};

type RuntimeCommonObjectSpawnValidation = {
  object: mod.Object | undefined;
  objId: number;
  reason: string;
};

type RuntimeLootSpawnerSpawnValidation = {
  object: mod.Object | undefined;
  spawner: mod.LootSpawner | undefined;
  objId: number;
  reason: string;
  position: mod.Vector | undefined;
};

type ValidatedObjectPositionResult = {
  position: mod.Vector | undefined;
  objId: number;
  reason: string;
};

type CapturePointTransformResult = {
  capturePoint: mod.CapturePoint | undefined;
  objId: number;
  position: mod.Vector | undefined;
  rotation: mod.Vector | undefined;
  reason: string;
};

type BombSpawnValidationDebugState = {
  resultPath: string;
  objId: number;
};

type RuntimeSfxSourceSpawnValidation = {
  spawned: unknown;
  object: mod.Object | undefined;
  handle: mod.SFX | undefined;
  objId: number;
  reason: string;
};

type BombDynamicLane = "AE" | "BF";
type BombDroppedSourceKind = "none" | "carrier_drop";
type BombCarrierVerticalState = "stable" | "rising" | "falling";
type BombBeepMode = "none" | "base" | "dropped" | "carrier";
type BombSpawnAnnouncementMode = "new_location_found" | "bomb_located";
type BombDynamicLaneMidpoint = {
  lane: BombDynamicLane;
  midpoint: mod.Vector;
};
type BombBaseAnchorCandidate = {
  slotIndex: number;
  anchorCapturePointId: number;
  anchorPos: mod.Vector;
  distanceSquared: number;
  totalPlayerDistanceMeters?: number;
  nearestPlayerDistanceMeters?: number;
};
type BombDynamicSpawnGeometry = {
  geometryCenter: mod.Vector;
  safestLaneMidpoint: BombDynamicLaneMidpoint | undefined;
  finalSeed: mod.Vector;
};
type BombDynamicSpawnStrategy = "player_biased" | "live_start_center";
let bombCarrierPlayerId: number | undefined = undefined;
let bombCarrierReplacedSlotByPlayerId: { [playerId: number]: mod.InventorySlots | undefined } = {};
let bombCarrierPreviousEquipmentByPlayerId: { [playerId: number]: BombRestoreEquipment | undefined } = {};
let bombCarrierRestoreAmmoByPlayerId: { [playerId: number]: BombRestoreAmmoState | undefined } = {};
let bombCarrierDeployRestoreEquipmentByPlayerId: { [playerId: number]: BombRestoreEquipment | undefined } = {};
let bombDeployLoadoutApplyTokenByPlayerId: { [playerId: number]: number } = {};
let bombDeployLoadoutApplyTokenCounter = 0;
let bombCarrierRestoreInsertTokenByPlayerId: { [playerId: number]: number } = {};
let bombCarrierRestoreInsertTokenCounter = 0;
let bombPickupTriggerInitialPosition: mod.Vector | undefined = undefined;
let bombStaticLootSpawnerInitialPosition: mod.Vector | undefined = undefined;
let bombPickupTriggerEnabled = false;
let bombBaseRuntimeLootSpawnerObject: mod.Object | undefined = undefined;
let bombBaseRuntimeLootSpawnerHandle: mod.LootSpawner | undefined = undefined;
let bombBaseRuntimeLootSpawnerObjectId: number | undefined = undefined;
let bombBaseRuntimeWorldIconObject: mod.Object | undefined = undefined;
let bombBaseRuntimeWorldIconHandle: mod.WorldIcon | undefined = undefined;
let bombQuadBikeRuntimeSpawnerObject: mod.Object | undefined = undefined;
let bombQuadBikeRuntimeSpawnerHandle: mod.VehicleSpawner | undefined = undefined;
let bombQuadBikeLiveSpawnAttempted = false;
let bombQuadBikeAnchorMissingWarned = false;
let bombActiveBaseSlotIndex = BOMB_DEFAULT_BASE_SLOT_INDEX;
let bombBaseCachedPosition: mod.Vector | undefined = undefined;
let bombBaseLandingAnchorPosition: mod.Vector | undefined = undefined;
let bombDroppedRuntimeLootSpawnerObject: mod.Object | undefined = undefined;
let bombDroppedRuntimeLootSpawnerHandle: mod.LootSpawner | undefined = undefined;
let bombDroppedWorldIconObject: mod.Object | undefined = undefined;
let bombDroppedWorldIconHandle: mod.WorldIcon | undefined = undefined;
let bombCarrierFriendlyIconObject: mod.Object | undefined = undefined;
let bombCarrierFriendlyIconHandle: mod.WorldIcon | undefined = undefined;
let bombCarrierEnemyIconObject: mod.Object | undefined = undefined;
let bombCarrierEnemyIconHandle: mod.WorldIcon | undefined = undefined;
let bombCarrierEnemyBlinkStartAtSec = 0;
let bombCarrierLastSourcePos: mod.Vector | undefined = undefined;
let bombCarrierFriendlyLastPos: mod.Vector | undefined = undefined;
let bombCarrierEnemyLastPos: mod.Vector | undefined = undefined;
let bombCarrierTrackedY: number | undefined = undefined;
let bombCarrierVerticalState: BombCarrierVerticalState = "stable";
let bombCarrierStableYSinceSec = 0;
let bombCarrierSawRisingY = false;
let bombCarrierSawFallingY = false;
let bombCarrierPendingManualDrop = false;
let bombCarrierManualDropArmed = false;
let bombNoticeToken = 0;
let bombNoticeVisibleUntilSec = 0;
let bombNoticeMessageKey: any = undefined;
let bombNoticeFallbackText = "BOMB HAS BEEN DROPPED";
let bombNoticeMessageKeyByPlayerId: { [playerId: number]: any } = {};
let bombNoticeFallbackTextByPlayerId: { [playerId: number]: string | undefined } = {};
let bombNoticeVisibleUntilSecByPlayerId: { [playerId: number]: number | undefined } = {};
let bombNoticeTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let bombCarrierUiStateVersion = 0;
let bombDroppedPickupAnchorPosition: mod.Vector | undefined = undefined;
let bombDroppedLastCarrierPlayerId: number | undefined = undefined;
let bombDroppedLastCarrierBlockedUntilSec = 0;
let bombDroppedSourceKind: BombDroppedSourceKind = "none";
let bombReturnToBaseToken = 0;
let bombDroppedReturnDeadlineAtSec = 0;
let bombDroppedWorldIconLastShownSeconds = -1;
let bombDeferredBaseSpawnToken = 0;
let bombBeepMode: BombBeepMode = "none";
let bombBeepNextPulseAtSec = 0;
let bombBeepFixedAnchorPos: mod.Vector | undefined = undefined;
let bombBeepPulseSpawned: unknown = undefined;
let bombBeepPulseObject: mod.Object | undefined = undefined;
let bombBeepPulseHandle: mod.SFX | undefined = undefined;
let bombBeepLastPlayPos: mod.Vector | undefined = undefined;
let bombDropOneShotSpawned: unknown = undefined;
let bombDropOneShotObject: mod.Object | undefined = undefined;
let bombDropOneShotHandle: mod.SFX | undefined = undefined;
let bombDropOneShotCleanupToken = 0;
let lastKnownLivePositionByPlayerId: { [playerId: number]: mod.Vector | undefined } = {};
let visualSubtickLastOutputSec = 0;
let visualSubtickLastPreferredSec = -1;
let visualSubtickLastPreferredFloorSec = -1;
let visualSubtickPreferredFloorTick = 0;
let visualSubtickEstimatedHz = TICK_RATE;
let visualSubtickCoarseStepCount = 0;
let visualSubtickFineStepCount = 0;
let visualSubtickFallbackFrameCount = 0;
let visualSubtickLastMode = "fallback";
let visualSubtickLastDebugLogAtSec = 0;
let carrierIconVisualErrorSumMeters = 0;
let carrierIconVisualErrorMaxMeters = 0;
let carrierIconVisualErrorSamples = 0;
let perfTelemetryLastSampleAtSec = 0;
let perfTelemetryLastFrameAtSec = -1;
let perfTelemetrySmoothedHz = 0;
let perfTelemetryFrameCount = 0;
let perfTelemetryFastLaneRuns = 0;
let perfTelemetrySlowLaneRuns = 0;
let perfTelemetryIconLaneRuns = 0;
let perfTelemetryEndgameLaneRuns = 0;
let perfTelemetryDamageLaneRuns = 0;
let perfTelemetryBombPickupScanMaxCandidates = 0;
let bombPickupTriggerMissingWarned = false;
let bombPickupTriggerMoveWarned = false;
let bombBaseBeepLoopMissingWarned = false;
let bombDroppedBeepLoopMissingWarned = false;
let bombCarrierBeepLoopMissingWarned = false;
let bombCarrierIconMissingWarned = false;
let bombCarrierIconOwnerWarned = false;
let objectiveLastSuccessfulArmPositionByCpId: { [cpId: number]: mod.Vector | undefined } = {};
let objectiveLastSuccessfulArmerPlayerIdByCpId: { [cpId: number]: number | undefined } = {};

function logBombPickupDebug(message: any): void {
  if (!DEBUG_BOMB_PICKUP) return;
  emitStringKeyDebugWorldLog(message);
}

function shouldEmitStringKeyDebugWorldLogs(): boolean {
  return ENABLE_STRINGKEY_DEBUG_WORLD_LOGS;
}

function emitStringKeyDebugWorldLog(message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  mod.DisplayHighlightedWorldLogMessage(message);
}

function emitLiveTransitionCheckpoint(_step: string): void {
  // Disabled in production builds; this previously emitted visible world-log debug messages.
}

function emitObjectiveNativeEventFlow(message: any): void {
  if (!DEBUG_OBJECTIVE_NATIVE_EVENT_FLOW) return;
  mod.DisplayHighlightedWorldLogMessage(message);
}

function getObjIdSafe(target: unknown): number {
  if (target === undefined || target === null) return -1;
  try {
    const id = Number(mod.GetObjId(target as any));
    return Number.isFinite(id) ? id : -1;
  } catch (_err) {
    return -1;
  }
}

function getSpawnedTypePathForDebug(spawned: unknown): string {
  if (mod.IsType(spawned, mod.Types.Object)) return "object";
  if (mod.IsType(spawned, mod.Types.VFX)) return "non_object_type_vfx";
  if (mod.IsType(spawned, mod.Types.SFX)) return "non_object_type_sfx";
  return "non_object_type";
}

function setBombSpawnValidationDebugState(context: string, resultPath: string, objId: number): void {
  bombSpawnValidationDebugByContext[context] = {
    resultPath,
    objId,
  };

  if (!DEBUG_BOMB_PICKUP) return;
  logBombPickupDebug(
    mod.Message(
      "[BOMB DEBUG] spawn_validate ctx/path/objId/tick {}",
      context + "/" + resultPath + "/" + String(objId) + "/" + String(serverTickCount)
    )
  );
}

function getBombSpawnValidationDebugState(context: string): BombSpawnValidationDebugState {
  const state = bombSpawnValidationDebugByContext[context];
  if (state) return state;
  return {
    resultPath: "unknown",
    objId: -1,
  };
}

function resolveObjectFromUnknown(target: unknown): RuntimeCommonObjectSpawnValidation {
  if (target === undefined || target === null) {
    return {
      object: undefined,
      objId: -1,
      reason: "missing_handle",
    };
  }

  if (mod.IsType(target, mod.Types.Object)) {
    const object = target as mod.Object;
    return {
      object,
      objId: getObjIdSafe(object),
      reason: "object",
    };
  }

  const objId = getObjIdSafe(target);
  if (objId < 0) {
    return {
      object: undefined,
      objId: -1,
      reason: getSpawnedTypePathForDebug(target),
    };
  }

  try {
    const spatialObject = mod.GetSpatialObject(objId);
    if (mod.IsType(spatialObject, mod.Types.Object)) {
      return {
        object: spatialObject as mod.Object,
        objId,
        reason: "objid_spatial_object",
      };
    }
  } catch (_errSpatialByObjId) {}

  return {
    object: undefined,
    objId,
    reason: "objid_resolve_failed",
  };
}

function spawnRuntimeCommonObjectSafe(
  asset: mod.RuntimeSpawn_Common,
  pos: mod.Vector,
  rot: mod.Vector,
  context: string,
  scale?: mod.Vector
): RuntimeCommonObjectSpawnValidation {
  let spawned: unknown = undefined;
  try {
    if (scale) {
      spawned = mod.SpawnObject(asset, pos, rot, scale) as unknown;
    } else {
      spawned = mod.SpawnObject(asset, pos, rot) as unknown;
    }
  } catch (_errSpawnObject) {
    setBombSpawnValidationDebugState(context, "spawn_exception", -1);
    return {
      object: undefined,
      objId: -1,
      reason: "spawn_exception",
    };
  }

  if (spawned === undefined || spawned === null) {
    setBombSpawnValidationDebugState(context, "spawn_return_undefined", -1);
    return {
      object: undefined,
      objId: -1,
      reason: "spawn_return_undefined",
    };
  }

  const resolved = resolveObjectFromUnknown(spawned);
  setBombSpawnValidationDebugState(context, resolved.reason, resolved.objId);
  return resolved;
}

function unspawnObjectSafe(target: unknown, context: string, warnOnFailure: boolean = true): boolean {
  const resolved = resolveObjectFromUnknown(target);
  if (!resolved.object) {
    if (warnOnFailure) {
      warnBombPickupObjectUnspawnFailureOnce(
        context + " invalid handle (" + resolved.reason + ", objId=" + String(resolved.objId) + ")"
      );
    }
    return false;
  }

  try {
    mod.UnspawnObject(resolved.object);
    return true;
  } catch (_err) {
    if (warnOnFailure) {
      warnBombPickupObjectUnspawnFailureOnce(
        context + " failed (" + resolved.reason + ", objId=" + String(resolved.objId) + ")"
      );
    }
    return false;
  }
}

function getObjectPositionSafeValidated(target: unknown, _context: string): ValidatedObjectPositionResult {
  const resolved = resolveObjectFromUnknown(target);
  if (!resolved.object) {
    return {
      position: undefined,
      objId: resolved.objId,
      reason: resolved.reason,
    };
  }

  try {
    return {
      position: mod.GetObjectPosition(resolved.object),
      objId: resolved.objId,
      reason: "ok",
    };
  } catch (_err) {
    return {
      position: undefined,
      objId: resolved.objId,
      reason: "get_position_failed",
    };
  }
}

function warnBombPickupTriggerMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombPickupTriggerMissingWarned) return;
  bombPickupTriggerMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB TRIGGER] Trigger {} unavailable ({})", BOMB_PICKUP_TRIGGER_ID, reason)
  );
}

function warnBombPickupTriggerMoveFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombPickupTriggerMoveWarned) return;
  bombPickupTriggerMoveWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB TRIGGER] Trigger {} move failed ({})", BOMB_PICKUP_TRIGGER_ID, reason)
  );
}

function resolveBombPickupTriggerSafe(): mod.AreaTrigger | undefined {
  if (!BOMB_USE_PICKUP_AREA_TRIGGER_AUTHORITY) return undefined;
  try {
    return mod.GetAreaTrigger(BOMB_PICKUP_TRIGGER_ID);
  } catch (_err) {
    warnBombPickupTriggerMissingOnce("GetAreaTrigger failed");
    return undefined;
  }
}

function getBombBaseSlotConfig(slotIndex: number): BombBaseSlotConfig | undefined {
  if (slotIndex < 0 || slotIndex >= BOMB_BASE_SLOT_CONFIGS.length) return undefined;
  return BOMB_BASE_SLOT_CONFIGS[slotIndex];
}

function getBombBaseSlotIndexOrDefault(slotIndex: number): number {
  if (slotIndex >= 0 && slotIndex < BOMB_BASE_SLOT_CONFIGS.length) return slotIndex;
  return BOMB_DEFAULT_BASE_SLOT_INDEX;
}

function getActiveBombBaseSlotConfig(): BombBaseSlotConfig {
  const idx = getBombBaseSlotIndexOrDefault(bombActiveBaseSlotIndex);
  const cfg = getBombBaseSlotConfig(idx);
  if (cfg) return cfg;
  return BOMB_BASE_SLOT_CONFIGS[BOMB_DEFAULT_BASE_SLOT_INDEX];
}

function warnBombAnchorSectorMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombAnchorSectorMissingWarned) return;
  bombAnchorSectorMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BASE] Anchor sector {} unavailable ({})", BOMB_ANCHOR_SECTOR_ID, reason)
  );
}

function warnBombAnchorCapturePointMissingOnce(anchorCapturePointId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombAnchorCapturePointMissingWarnedById[anchorCapturePointId] === true) return;
  bombAnchorCapturePointMissingWarnedById[anchorCapturePointId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BASE] Anchor CapturePoint {} unavailable ({})", anchorCapturePointId, reason)
  );
}

function warnBombQuadBikeAnchorMissingOnce(capturePointId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombQuadBikeAnchorMissingWarned) return;
  bombQuadBikeAnchorMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[QUAD BIKE] Required spawn CapturePoint {} unavailable ({})",
      capturePointId,
      reason
    )
  );
}

function warnBombUnspawnAllLootFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombUnspawnAllLootWarned) return;
  bombUnspawnAllLootWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB FLOW] UnspawnAllLoot failed ({})", reason)
  );
}

function ensureBombAnchorSectorAvailable(context: string): boolean {
  try {
    mod.GetSector(BOMB_ANCHOR_SECTOR_ID);
    return true;
  } catch (_err) {
    warnBombAnchorSectorMissingOnce("GetSector failed");
    setBombSpawnValidationDebugState(getBombDynamicLandingDebugContext(context), "anchor_sector_missing", BOMB_ANCHOR_SECTOR_ID);
    return false;
  }
}

function resolveCapturePointTransformById(
  capturePointId: number,
  warnMissingOnce?: (capturePointId: number, reason: string) => void
): CapturePointTransformResult {
  let capturePoint: mod.CapturePoint | undefined = undefined;

  try {
    capturePoint = mod.GetCapturePoint(capturePointId);
  } catch (_err) {
    if (warnMissingOnce) warnMissingOnce(capturePointId, "GetCapturePoint failed");
    return {
      capturePoint: undefined,
      objId: -1,
      position: undefined,
      rotation: undefined,
      reason: "capture_point_missing",
    };
  }

  const objId = getObjIdSafe(capturePoint);

  let position: mod.Vector | undefined = undefined;
  try {
    position = mod.GetObjectPosition(capturePoint);
  } catch (_err) {
    if (warnMissingOnce) warnMissingOnce(capturePointId, "GetObjectPosition failed");
    return {
      capturePoint,
      objId,
      position: undefined,
      rotation: undefined,
      reason: "position_unavailable",
    };
  }

  try {
    return {
      capturePoint,
      objId,
      position,
      rotation: mod.GetObjectRotation(capturePoint as unknown as mod.Object),
      reason: "ok",
    };
  } catch (_err) {
    return {
      capturePoint,
      objId,
      position,
      rotation: undefined,
      reason: "rotation_unavailable",
    };
  }
}

function tryResolveQuadBikeSpawnCapturePointTransform(): CapturePointTransformResult | undefined {
  if (BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID <= 0) return undefined;

  const transform = resolveCapturePointTransformById(
    BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID,
    warnBombQuadBikeAnchorMissingOnce
  );
  if (!transform.position) return undefined;

  const origin = mod.CreateVector(0, 0, 0);
  const distanceFromOrigin = mod.DistanceBetween(transform.position, origin);
  if (!Number.isFinite(distanceFromOrigin) || distanceFromOrigin <= 0.01) {
    warnBombQuadBikeAnchorMissingOnce(BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID, "position_invalid");
    return undefined;
  }

  return transform;
}

function validateRequiredQuadBikeAnchorConfigurationOnce(): void {
  if (BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID <= 0) return;
  void tryResolveQuadBikeSpawnCapturePointTransform();
}

function tryGetBombAnchorCapturePointTransformById(
  anchorCapturePointId: number,
  context: string
): CapturePointTransformResult {
  const result = resolveCapturePointTransformById(anchorCapturePointId, warnBombAnchorCapturePointMissingOnce);
  if (!result.position) {
    setBombSpawnValidationDebugState(
      context,
      result.reason === "capture_point_missing" ? "anchor_cp_missing" : "anchor_cp_position_unavailable",
      anchorCapturePointId
    );
  }
  return result;
}

function tryGetBombAnchorCapturePointPositionById(
  anchorCapturePointId: number,
  context: string
): mod.Vector | undefined {
  return tryGetBombAnchorCapturePointTransformById(anchorCapturePointId, context).position;
}

function getBombBaseSlotSpatialPosition(slotIndex: number): mod.Vector | undefined {
  const cfg = getBombBaseSlotConfig(slotIndex);
  if (!cfg) return undefined;
  return tryGetBombAnchorCapturePointPositionById(cfg.anchorCapturePointId, "bomb_base_slot_spatial_position");
}

function validateBombBaseSlotSpatialConfigOnce(): void {
  if (bombBaseSpatialConfigValidated) return;
  bombBaseSpatialConfigValidated = true;

  const zero = mod.CreateVector(0, 0, 0);
  const invalidSlotIds: string[] = [];

  for (let i = 0; i < BOMB_BASE_SLOT_CONFIGS.length; i++) {
    const cfg = getBombBaseSlotConfig(i);
    if (!cfg) {
      invalidSlotIds.push("slot" + String(i));
      continue;
    }

    const pos = getBombBaseSlotSpatialPosition(i);
    if (!pos) {
      invalidSlotIds.push(String(cfg.anchorCapturePointId));
      continue;
    }

    const fromOrigin = mod.DistanceBetween(pos, zero);
    if (!Number.isFinite(fromOrigin) || fromOrigin <= 0.01) {
      invalidSlotIds.push(String(cfg.anchorCapturePointId));
    }
  }

  if (invalidSlotIds.length <= 0) return;
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[BOMB BASE] Anchor CapturePoint config invalid/zero-vector for {}",
      invalidSlotIds.join(",")
    )
  );
}

function tryGetStaticBombLootSpawnerPosition(): mod.Vector | undefined {
  const cfg = getActiveBombBaseSlotConfig();
  return tryGetBombAnchorCapturePointPositionById(cfg.anchorCapturePointId, "bomb_anchor_position");
}

function warnBombBaseFirstPickupAnchorUnavailableOnce(spawnerId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombBaseFirstPickupAnchorUnavailableWarnedById[spawnerId] === true) return;
  bombBaseFirstPickupAnchorUnavailableWarnedById[spawnerId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[BOMB BASE PICKUP] Base slot anchor for LootSpawner {} unavailable ({}); first-pickup radius is fail-closed",
      spawnerId,
      reason
    )
  );
}

function tryGetActiveBasePickupAnchor(): mod.Vector | undefined {
  const anchor = bombBaseLandingAnchorPosition ?? bombBaseCachedPosition;
  if (!anchor) {
    warnBombBaseFirstPickupAnchorUnavailableOnce(-1, "dynamic base anchor unavailable");
    return undefined;
  }

  bombStaticLootSpawnerInitialPosition = anchor;
  bombBaseCachedPosition = anchor;
  return anchor;
}

function moveObjectToAbsolutePositionSafe(targetObject: mod.Object, targetPosition: mod.Vector, context: string): boolean {
  try {
    const currentPosition = mod.GetObjectPosition(targetObject);
    const delta = mod.Subtract(targetPosition, currentPosition);
    mod.MoveObject(targetObject, delta);
    return true;
  } catch (_err) {
    if (context === "bomb_trigger") {
      warnBombPickupTriggerMoveFailureOnce("MoveObject/GetObjectPosition failed");
    }
    return false;
  }
}

function cacheBombPickupWorldAnchorPositions(): void {
  if (BOMB_USE_PICKUP_AREA_TRIGGER_AUTHORITY && !bombPickupTriggerInitialPosition) {
    const trigger = resolveBombPickupTriggerSafe();
    if (trigger) {
      try {
        bombPickupTriggerInitialPosition = mod.GetObjectPosition(trigger);
      } catch (_err) {
        warnBombPickupTriggerMissingOnce("GetObjectPosition failed");
      }
    }
  }

  if (!bombStaticLootSpawnerInitialPosition) {
    bombStaticLootSpawnerInitialPosition = bombBaseLandingAnchorPosition ?? bombBaseCachedPosition;
  }

  const fallbackPos =
    bombBaseLandingAnchorPosition ??
    bombBaseCachedPosition ??
    bombStaticLootSpawnerInitialPosition ??
    bombPickupTriggerInitialPosition;
  if (fallbackPos) {
    if (!bombBaseCachedPosition) bombBaseCachedPosition = fallbackPos;
  }
}

function setBombPickupTriggerEnabled(enabled: boolean): void {
  bombPickupTriggerEnabled = enabled;
  if (!BOMB_USE_PICKUP_AREA_TRIGGER_AUTHORITY) return;

  const trigger = resolveBombPickupTriggerSafe();
  if (!trigger) {
    bombPickupTriggerEnabled = false;
    return;
  }

  try {
    mod.EnableAreaTrigger(trigger, enabled);
  } catch (_err) {
    warnBombPickupTriggerMissingOnce("EnableAreaTrigger failed");
    bombPickupTriggerEnabled = false;
  }
}

function moveBombPickupTriggerToPosition(targetPosition: mod.Vector, enableAfterMove: boolean): boolean {
  bombBaseCachedPosition = targetPosition;
  if (!BOMB_USE_PICKUP_AREA_TRIGGER_AUTHORITY) {
    setBombPickupTriggerEnabled(enableAfterMove);
    return true;
  }

  const trigger = resolveBombPickupTriggerSafe();
  if (!trigger) {
    bombPickupTriggerEnabled = false;
    return false;
  }

  const moved = moveObjectToAbsolutePositionSafe(
    trigger as unknown as mod.Object,
    targetPosition,
    "bomb_trigger"
  );
  if (!moved) return false;

  setBombPickupTriggerEnabled(enableAfterMove);
  return true;
}

function tryUnspawnAllLootForBombFlow(context: string): void {
  try {
    mod.UnspawnAllLoot();
  } catch (_err) {
    warnBombUnspawnAllLootFailureOnce(context);
  }
}

function logObjectiveDelayedAward(message: any): void {
  if (!DEBUG_OBJECTIVE_DELAYED_AWARD) return;
  emitStringKeyDebugWorldLog(message);
}

function hasEquipmentSafe(player: mod.Player, gadget: mod.Gadgets): boolean {
  const modAny = mod as any;
  try {
    if (typeof modAny.HasEquipment !== "function") return false;
    return modAny.HasEquipment(player, gadget) === true;
  } catch (_err) {
    return false;
  }
}

function isInventorySlotActiveSafe(player: mod.Player, slot: mod.InventorySlots): boolean {
  const modAny = mod as any;
  try {
    if (typeof modAny.IsInventorySlotActive !== "function") return false;
    return modAny.IsInventorySlotActive(player, slot) === true;
  } catch (_err) {
    return false;
  }
}

function getInventoryAmmoSafe(player: mod.Player, slot: mod.InventorySlots): number {
  const modAny = mod as any;
  try {
    if (typeof modAny.GetInventoryAmmo !== "function") return -1;
    const value = Number(modAny.GetInventoryAmmo(player, slot));
    if (!Number.isFinite(value)) return -1;
    return value;
  } catch (_err) {
    return -1;
  }
}

function getInventoryMagazineAmmoSafe(player: mod.Player, slot: mod.InventorySlots): number {
  const modAny = mod as any;
  try {
    if (typeof modAny.GetInventoryMagazineAmmo !== "function") return -1;
    const value = Number(modAny.GetInventoryMagazineAmmo(player, slot));
    if (!Number.isFinite(value)) return -1;
    return value;
  } catch (_err) {
    return -1;
  }
}

function setInventoryAmmoSafe(player: mod.Player, slot: mod.InventorySlots, ammo: number): void {
  const modAny = mod as any;
  try {
    if (typeof modAny.SetInventoryAmmo !== "function") return;
    modAny.SetInventoryAmmo(player, slot, ammo);
  } catch (_err) {}
}

function setInventoryMagazineAmmoSafe(player: mod.Player, slot: mod.InventorySlots, ammo: number): void {
  const modAny = mod as any;
  try {
    if (typeof modAny.SetInventoryMagazineAmmo !== "function") return;
    modAny.SetInventoryMagazineAmmo(player, slot, ammo);
  } catch (_err) {}
}

function addEquipmentToSlotSafe(player: mod.Player, gadget: mod.Gadgets, slot: mod.InventorySlots): void {
  try {
    (mod as any).AddEquipment(player, gadget, slot);
    return;
  } catch (_errWithSlot) {}

  try {
    (mod as any).AddEquipment(player, gadget);
  } catch (_errNoSlot) {}
}

function removeEquipmentSlotSafe(player: mod.Player, slot: mod.InventorySlots): void {
  try {
    (mod as any).RemoveEquipment(player, slot);
  } catch (_err) {}
}

function addRestoreEquipmentToSlotSafe(
  player: mod.Player,
  equipment: BombRestoreEquipment,
  slot: mod.InventorySlots
): void {
  addEquipmentToSlotSafe(player, equipment.gadget, slot);
}

function removeBombEquipmentSafe(player: mod.Player, preferredSlot?: mod.InventorySlots): void {
  try {
    (mod as any).RemoveEquipment(player, BOMB_LOOT_GADGET);
    return;
  } catch (_errByGadget) {}

  if (preferredSlot !== undefined) {
    try {
      (mod as any).RemoveEquipment(player, BOMB_LOOT_GADGET, preferredSlot);
      return;
    } catch (_errByGadgetAndSlot) {}

    try {
      (mod as any).RemoveEquipment(player, preferredSlot);
      return;
    } catch (_errByPreferredSlot) {}
  }

  try {
    (mod as any).RemoveEquipment(player, BOMB_LOOT_GADGET, BOMB_CARRIER_INVENTORY_SLOT);
    return;
  } catch (_errByCarrierSlot) {}
}

function warnBombBaseWorldIconMissingOnce(worldIconId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombBaseWorldIconMissingWarnedById[worldIconId] === true) return;
  bombBaseWorldIconMissingWarnedById[worldIconId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB ICON] Missing/invalid base WorldIcon id {} ({})", worldIconId, reason)
  );
}

function getBombWorldIconTextMessage(): any {
  return getStringMessageWithFallback((mod.stringkeys as any).BOMB, BOMB_WORLDICON_TEXT_FALLBACK);
}

function formatBombWorldIconTimerLabel(totalSeconds: number): any {
  let safeSeconds = totalSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds < 0) safeSeconds = 0;
  safeSeconds = mod.Floor(safeSeconds);
  const minutes = mod.Floor(safeSeconds / 60);
  const totalSecondsRemainder = mod.Floor(safeSeconds % 60);
  const seconds1 = totalSecondsRemainder % 10;
  const seconds10 = mod.Floor(totalSecondsRemainder / 10);
  if (minutes < 10) {
    return mod.Message(BOMB_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK, minutes, seconds10, seconds1);
  }
  return mod.Message(BOMB_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK, minutes, seconds10, seconds1);
}

function setBombBaseWorldIconEnabledById(worldIconId: number, enabled: boolean): boolean {
  try {
    const icon = mod.GetWorldIcon(worldIconId);
    mod.SetWorldIconImage(icon, BOMB_DROP_WORLDICON_IMAGE);
    mod.SetWorldIconColor(icon, BOMB_DROP_WORLDICON_COLOR);
    mod.SetWorldIconText(icon, getBombWorldIconTextMessage());
    mod.EnableWorldIconText(icon, enabled);
    mod.EnableWorldIconImage(icon, enabled);
    return true;
  } catch (_err) {
    warnBombBaseWorldIconMissingOnce(worldIconId, "GetWorldIcon/configure failed");
    return false;
  }
}

function setAllBaseWorldIconsEnabled(enabled: boolean): void {
  void enabled;
}

function setActiveBaseWorldIcon(slotIndex: number | undefined): void {
  void slotIndex;
  setAllBaseWorldIconsEnabled(false);
}

function configureBombWorldIconSafe(icon: mod.WorldIcon, enableImage: boolean): boolean {
  try {
    mod.SetWorldIconImage(icon, BOMB_DROP_WORLDICON_IMAGE);
    mod.SetWorldIconColor(icon, BOMB_DROP_WORLDICON_COLOR);
    mod.SetWorldIconText(icon, getBombWorldIconTextMessage());
    mod.EnableWorldIconText(icon, enableImage);
    mod.EnableWorldIconImage(icon, enableImage);
    return true;
  } catch (_err) {
    return false;
  }
}

function clearBombBaseRuntimeWorldIcon(): void {
  if (bombBaseRuntimeWorldIconHandle) {
    try {
      mod.EnableWorldIconText(bombBaseRuntimeWorldIconHandle, false);
    } catch (_errText) {}
    try {
      mod.EnableWorldIconImage(bombBaseRuntimeWorldIconHandle, false);
    } catch (_err) {}
  }

  if (bombBaseRuntimeWorldIconObject) {
    unspawnObjectSafe(bombBaseRuntimeWorldIconObject, "base runtime world icon object", false);
  } else if (bombBaseRuntimeWorldIconHandle) {
    unspawnObjectSafe(bombBaseRuntimeWorldIconHandle as unknown, "base runtime world icon handle", false);
  }

  bombBaseRuntimeWorldIconObject = undefined;
  bombBaseRuntimeWorldIconHandle = undefined;
}

function clearBombQuadBikeRuntimeSpawner(): void {
  if (bombQuadBikeRuntimeSpawnerObject) {
    unspawnObjectSafe(bombQuadBikeRuntimeSpawnerObject, "quad bike runtime spawner object", false);
  } else if (bombQuadBikeRuntimeSpawnerHandle) {
    unspawnObjectSafe(bombQuadBikeRuntimeSpawnerHandle as unknown, "quad bike runtime spawner handle", false);
  }

  bombQuadBikeRuntimeSpawnerObject = undefined;
  bombQuadBikeRuntimeSpawnerHandle = undefined;
}

function tryResolveDroppedBombAnchorPosition(): mod.Vector | undefined {
  return bombDroppedPickupAnchorPosition;
}

function resolveDroppedBombAudioAnchorPosition(): mod.Vector | undefined {
  return bombDroppedPickupAnchorPosition;
}

function resolveBaseBombAudioAnchorPosition(): mod.Vector | undefined {
  if (bombBaseLandingAnchorPosition) {
    bombStaticLootSpawnerInitialPosition = bombBaseLandingAnchorPosition;
    bombBaseCachedPosition = bombBaseLandingAnchorPosition;
    return bombBaseLandingAnchorPosition;
  }

  const cfg = getBombBaseSlotConfig(bombActiveBaseSlotIndex);
  if (cfg) {
    const anchorPos = tryGetBombAnchorCapturePointPositionById(
      cfg.anchorCapturePointId,
      "bomb_base_audio_anchor_cp_" + String(cfg.anchorCapturePointId)
    );
    if (anchorPos) {
      bombBaseLandingAnchorPosition = anchorPos;
      bombStaticLootSpawnerInitialPosition = anchorPos;
      bombBaseCachedPosition = anchorPos;
      return anchorPos;
    }
  }

  if (bombBaseCachedPosition) return bombBaseCachedPosition;

  warnBombBasePositionResolveFailureOnce("base audio anchor unavailable");
  return undefined;
}

function tryResolveBaseRuntimeWorldIconAnchorPosition(): mod.Vector | undefined {
  const anchor = bombBaseLandingAnchorPosition ?? bombBaseCachedPosition;
  if (anchor) {
    bombStaticLootSpawnerInitialPosition = anchor;
    bombBaseCachedPosition = anchor;
    return anchor;
  }

  warnBombBasePositionResolveFailureOnce("dynamic base anchor unavailable");
  return undefined;
}

function ensureDroppedBombRuntimeWorldIconVisibleIfNeeded(): void {
  if (!hasDroppedBombRuntimeObjects()) return;
  const anchorPos = tryResolveDroppedBombAnchorPosition();
  if (!anchorPos) return;

  let runtimeIcon = bombDroppedWorldIconHandle;
  if (!runtimeIcon && bombDroppedWorldIconObject) {
    runtimeIcon = resolveRuntimeWorldIconHandle(bombDroppedWorldIconObject as unknown);
    if (runtimeIcon) {
      bombDroppedWorldIconHandle = runtimeIcon;
    }
  }

  if (!runtimeIcon) {
    if (bombDroppedWorldIconObject) {
      unspawnObjectSafe(bombDroppedWorldIconObject, "dropped world icon reassert stale object", false);
      bombDroppedWorldIconObject = undefined;
    }

    let runtimeIconSpawned: unknown = undefined;
    try {
      runtimeIconSpawned = mod.SpawnObject(BOMB_DROP_WORLDICON_ASSET, anchorPos, BOMB_DROP_ROTATION) as unknown;
    } catch (_errWorldIconSpawn) {
      setBombSpawnValidationDebugState(BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON_REASSERT, "spawn_exception", -1);
      warnBombDropRuntimeWorldIconMissingOnce("reassert SpawnObject failed");
      return;
    }

    const runtimeIconObject = resolveObjectFromUnknown(runtimeIconSpawned);
    setBombSpawnValidationDebugState(
      BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON_REASSERT,
      runtimeIconObject.reason,
      runtimeIconObject.objId
    );
    if (runtimeIconObject.object) {
      bombDroppedWorldIconObject = runtimeIconObject.object;
    }

    runtimeIcon = resolveRuntimeWorldIconHandle(runtimeIconSpawned);
    if (!runtimeIcon) {
      warnBombDropRuntimeWorldIconMissingOnce("reassert resolve handle failed");
      return;
    }

    bombDroppedWorldIconHandle = runtimeIcon;
  }

  if (bombDroppedWorldIconObject) {
    moveObjectToAbsolutePositionSafe(
      bombDroppedWorldIconObject,
      anchorPos,
      "dropped_worldicon_reassert_move"
    );
  }

  if (!configureBombWorldIconSafe(runtimeIcon, true)) {
    warnBombDropRuntimeWorldIconMissingOnce("reassert configure icon failed");
  }
}

function hasBaseBombAuthorityOrPending(): boolean {
  return (
    bombPickupTriggerEnabled ||
    bombBaseRuntimeLootSpawnerObject !== undefined ||
    bombBaseRuntimeLootSpawnerHandle !== undefined
  );
}

function spawnOrReassertBaseBombRuntimeWorldIcon(anchorPos: mod.Vector, enableImage: boolean): boolean {
  let runtimeIcon = bombBaseRuntimeWorldIconHandle;
  if (!runtimeIcon && bombBaseRuntimeWorldIconObject) {
    runtimeIcon = resolveRuntimeWorldIconHandle(bombBaseRuntimeWorldIconObject as unknown);
    if (runtimeIcon) {
      bombBaseRuntimeWorldIconHandle = runtimeIcon;
    }
  }

  if (!runtimeIcon) {
    if (bombBaseRuntimeWorldIconObject) {
      unspawnObjectSafe(bombBaseRuntimeWorldIconObject, "base world icon reassert stale object", false);
      bombBaseRuntimeWorldIconObject = undefined;
    }

    let runtimeIconSpawned: unknown = undefined;
    try {
      runtimeIconSpawned = mod.SpawnObject(BOMB_DROP_WORLDICON_ASSET, anchorPos, BOMB_DROP_ROTATION) as unknown;
    } catch (_errWorldIconSpawn) {
      setBombSpawnValidationDebugState(BOMB_SPAWN_CONTEXT_BASE_PICKUP + "_runtime_worldicon", "spawn_exception", -1);
      warnBombBaseWorldIconMissingOnce(-1, "runtime SpawnObject failed");
      return false;
    }

    const runtimeIconObject = resolveObjectFromUnknown(runtimeIconSpawned);
    if (runtimeIconObject.object) {
      bombBaseRuntimeWorldIconObject = runtimeIconObject.object;
    }

    runtimeIcon = resolveRuntimeWorldIconHandle(runtimeIconSpawned);
    if (!runtimeIcon) {
      warnBombBaseWorldIconMissingOnce(-1, "runtime resolve handle failed");
      return false;
    }

    bombBaseRuntimeWorldIconHandle = runtimeIcon;
  }

  if (bombBaseRuntimeWorldIconObject) {
    moveObjectToAbsolutePositionSafe(bombBaseRuntimeWorldIconObject, anchorPos, "base_worldicon_reassert_move");
  }

  if (!configureBombWorldIconSafe(runtimeIcon, enableImage)) {
    warnBombBaseWorldIconMissingOnce(-1, "runtime configure icon failed");
    return false;
  }

  try {
    mod.EnableWorldIconImage(runtimeIcon, enableImage);
  } catch (_errEnableImage) {
    warnBombBaseWorldIconMissingOnce(-1, "runtime enable image failed");
    return false;
  }

  return true;
}

function ensureBaseBombRuntimeWorldIconVisibleIfNeeded(): void {
  setAllBaseWorldIconsEnabled(false);

  const baseAvailable =
    bombCarrierPlayerId === undefined &&
    !hasDroppedBombRuntimeObjects() &&
    hasBaseBombAuthorityOrPending();

  if (!baseAvailable) {
    clearBombBaseRuntimeWorldIcon();
    return;
  }

  const baseAnchorPos = tryResolveBaseRuntimeWorldIconAnchorPosition();
  if (!baseAnchorPos) {
    clearBombBaseRuntimeWorldIcon();
    return;
  }

  bombStaticLootSpawnerInitialPosition = baseAnchorPos;
  bombBaseCachedPosition = baseAnchorPos;
  spawnOrReassertBaseBombRuntimeWorldIcon(baseAnchorPos, bombPickupTriggerEnabled);
}

function setBombBaseAvailabilityState(hasBaseBomb: boolean): void {
  // Beep-source invariant: base, dropped, and carrier loops are mutually exclusive.
  setAllBaseWorldIconsEnabled(false);

  if (!hasBaseBomb) {
    clearBombBaseBeepLoop();
    clearBombBaseRuntimeWorldIcon();
    return;
  }

  const basePos = resolveBaseBombAudioAnchorPosition();
  if (!basePos) {
    clearBombBaseBeepLoop();
    clearBombBaseRuntimeWorldIcon();
    return;
  }

  clearBombDroppedBeepLoop();
  clearBombCarrierBeepLoop();
  bombBaseCachedPosition = basePos;
  spawnOrReassertBaseBombRuntimeWorldIcon(basePos, bombPickupTriggerEnabled);
  startBombBaseBeepLoopAtPosition(basePos);
}

function hasDroppedBombRuntimeObjects(): boolean {
  return (
    bombDroppedRuntimeLootSpawnerObject !== undefined ||
    bombDroppedRuntimeLootSpawnerHandle !== undefined ||
    bombDroppedWorldIconObject !== undefined ||
    bombDroppedWorldIconHandle !== undefined
  );
}

function clearDroppedBombAnchorReclaimState(): void {
  bombDroppedPickupAnchorPosition = undefined;
  bombDroppedLastCarrierPlayerId = undefined;
  bombDroppedLastCarrierBlockedUntilSec = 0;
  bombDroppedSourceKind = "none";
}

function clearDroppedBombRuntimeObjects(): void {
  clearBombDroppedBeepLoop();
  clearBombDroppedRuntimeLootSpawner();
  bombDroppedReturnDeadlineAtSec = 0;
  bombDroppedWorldIconLastShownSeconds = -1;

  if (bombDroppedWorldIconHandle) {
    try {
      mod.EnableWorldIconText(bombDroppedWorldIconHandle, false);
    } catch (_errText) {}
    try {
      mod.EnableWorldIconImage(bombDroppedWorldIconHandle, false);
    } catch (_err) {}
  }

  if (bombDroppedWorldIconObject) {
    unspawnObjectSafe(bombDroppedWorldIconObject, "dropped world icon object", false);
  } else if (bombDroppedWorldIconHandle) {
    unspawnObjectSafe(bombDroppedWorldIconHandle as unknown, "dropped world icon handle", false);
  }

  bombDroppedWorldIconObject = undefined;
  bombDroppedWorldIconHandle = undefined;
  clearDroppedBombAnchorReclaimState();
}

function updateDroppedBombWorldIconCountdown(): void {
  if (!hasDroppedBombRuntimeObjects()) {
    bombDroppedWorldIconLastShownSeconds = -1;
    return;
  }

  let runtimeIcon = bombDroppedWorldIconHandle;
  if (!runtimeIcon && bombDroppedWorldIconObject) {
    runtimeIcon = resolveRuntimeWorldIconHandle(bombDroppedWorldIconObject as unknown);
    if (runtimeIcon) {
      bombDroppedWorldIconHandle = runtimeIcon;
    }
  }

  if (!runtimeIcon) return;

  if (bombDroppedReturnDeadlineAtSec <= 0) {
    bombDroppedWorldIconLastShownSeconds = -1;
    try {
      mod.SetWorldIconText(runtimeIcon, getBombWorldIconTextMessage());
      mod.EnableWorldIconText(runtimeIcon, true);
    } catch (_err) {}
    return;
  }

  let remainingSeconds = mod.Ceiling(bombDroppedReturnDeadlineAtSec - getCurrentSchedulerNowSeconds());
  if (remainingSeconds < 0) remainingSeconds = 0;

  try {
    if (bombDroppedWorldIconLastShownSeconds !== remainingSeconds) {
      mod.SetWorldIconText(runtimeIcon, formatBombWorldIconTimerLabel(remainingSeconds));
      bombDroppedWorldIconLastShownSeconds = remainingSeconds;
    }
    mod.EnableWorldIconText(runtimeIcon, true);
  } catch (_err) {}
}

function tryGetObjectPositionSafe(obj: any): mod.Vector | undefined {
  return getObjectPositionSafeValidated(obj as unknown, "legacy").position;
}

function tryGetPlayerPositionSafe(player: mod.Player): mod.Vector | undefined {
  try {
    return getPlayerPosition(player);
  } catch (_err) {
    return undefined;
  }
}

function resolveRuntimeWorldIconHandle(spawned: unknown): mod.WorldIcon | undefined {
  if (!spawned) return undefined;

  try {
    const icon = spawned as mod.WorldIcon;
    mod.EnableWorldIconText(icon, false);
    return icon;
  } catch (_errAsWorldIcon) {}

  const resolvedObject = resolveObjectFromUnknown(spawned);
  if (resolvedObject.objId >= 0) {
    try {
      return mod.GetWorldIcon(resolvedObject.objId);
    } catch (_errByObjId) {}
  }

  return undefined;
}

function resolveRuntimeVehicleSpawnerHandle(spawned: unknown): mod.VehicleSpawner | undefined {
  if (!spawned) return undefined;

  const resolvedObject = resolveObjectFromUnknown(spawned);
  if (resolvedObject.objId >= 0) {
    try {
      return mod.GetVehicleSpawner(resolvedObject.objId);
    } catch (_errByObjId) {}
  }

  return undefined;
}

function resolveRuntimeSfxHandle(spawned: unknown): mod.SFX | undefined {
  if (!spawned) return undefined;

  if (mod.IsType(spawned, mod.Types.SFX)) {
    return spawned as mod.SFX;
  }

  const resolvedObject = resolveObjectFromUnknown(spawned);
  if (resolvedObject.objId >= 0) {
    try {
      return mod.GetSFX(resolvedObject.objId);
    } catch (_errByObjId) {}
  }

  return undefined;
}

function warnBombBaseBeepLoopMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombBaseBeepLoopMissingWarned) return;
  bombBaseBeepLoopMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BEEP] Base loop unavailable ({})", reason)
  );
}

function warnBombDroppedBeepLoopMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombDroppedBeepLoopMissingWarned) return;
  bombDroppedBeepLoopMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BEEP] Dropped loop unavailable ({})", reason)
  );
}

function warnBombCarrierBeepLoopMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombCarrierBeepLoopMissingWarned) return;
  bombCarrierBeepLoopMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BEEP] Carrier loop unavailable ({})", reason)
  );
}

function warnBombCarrierIconMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombCarrierIconMissingWarned) return;
  bombCarrierIconMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB CARRIER ICON] Runtime icon unavailable ({})", reason)
  );
}

function warnBombCarrierIconOwnerFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombCarrierIconOwnerWarned) return;
  bombCarrierIconOwnerWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB CARRIER ICON] Owner setup failed ({})", reason)
  );
}

function stopBombLoopHandle(handle: mod.SFX | undefined): void {
  if (!handle) return;
  try {
    mod.StopSound(handle);
  } catch (_err) {}
}

function spawnRuntimeSfxSourceAtPosition(
  asset: mod.RuntimeSpawn_Common,
  pos: mod.Vector
): RuntimeSfxSourceSpawnValidation {
  let spawned: unknown = undefined;

  try {
    spawned = mod.SpawnObject(asset, pos, BOMB_DROP_ROTATION) as unknown;
  } catch (_errSpawn) {
    return {
      spawned: undefined,
      object: undefined,
      handle: undefined,
      objId: -1,
      reason: "spawn_exception",
    };
  }

  if (spawned === undefined || spawned === null) {
    return {
      spawned,
      object: undefined,
      handle: undefined,
      objId: -1,
      reason: "spawn_return_undefined",
    };
  }

  const resolvedObject = resolveObjectFromUnknown(spawned);
  const resolvedHandle = resolveRuntimeSfxHandle(spawned);

  return {
    spawned,
    object: resolvedObject.object,
    handle: resolvedHandle ?? (spawned as mod.SFX),
    objId: resolvedObject.objId,
    reason: resolvedHandle ? resolvedObject.reason : resolvedObject.reason + "/sfx_direct_fallback",
  };
}

function tryPlayRuntimeSfxSource3D(
  spawnedSource: RuntimeSfxSourceSpawnValidation,
  volume: number,
  pos: mod.Vector,
  attenuationRange: number
): mod.SFX | undefined {
  const primaryHandle = spawnedSource.handle;
  const directHandle = spawnedSource.spawned ? (spawnedSource.spawned as mod.SFX) : undefined;
  const handles: mod.SFX[] = [];

  if (primaryHandle) handles.push(primaryHandle);
  if (directHandle && directHandle !== primaryHandle) handles.push(directHandle);

  for (let i = 0; i < handles.length; i++) {
    const handle = handles[i];
    try {
      mod.PlaySound(handle, volume, pos, attenuationRange);
      return handle;
    } catch (_errPlay3d) {
      try {
        mod.PlaySound(handle, volume);
        return handle;
      } catch (_errPlayFallback) {}
    }
  }

  return undefined;
}

async function cleanupRuntimeSfxSourceAfterDelay(
  spawnedSource: RuntimeSfxSourceSpawnValidation,
  activeHandle: mod.SFX | undefined,
  delaySeconds: number,
  context: string
): Promise<void> {
  await mod.Wait(delaySeconds);

  if (spawnedSource.object) {
    unspawnObjectSafe(spawnedSource.object, context, false);
    return;
  }

  if (spawnedSource.spawned) {
    unspawnObjectSafe(spawnedSource.spawned, context, false);
    return;
  }

  if (activeHandle) {
    unspawnObjectSafe(activeHandle as unknown, context, false);
  }
}

function playRuntimeOneShotSfxAtPosition(
  asset: mod.RuntimeSpawn_Common,
  pos: mod.Vector,
  volume: number,
  attenuationRange: number,
  cleanupSeconds: number,
  context: string
): boolean {
  const spawnedSource = spawnRuntimeSfxSourceAtPosition(asset, pos);
  const activeHandle = tryPlayRuntimeSfxSource3D(
    spawnedSource,
    volume,
    pos,
    attenuationRange
  );
  if (!activeHandle) {
    if (spawnedSource.object) {
      unspawnObjectSafe(spawnedSource.object, context + "_spawn_failed", false);
    } else if (spawnedSource.spawned) {
      unspawnObjectSafe(spawnedSource.spawned, context + "_spawn_failed", false);
    }
    return false;
  }

  void cleanupRuntimeSfxSourceAfterDelay(
    spawnedSource,
    activeHandle,
    cleanupSeconds,
    context
  );
  return true;
}

function getBombLoopAssetForMode(mode: BombBeepMode): mod.RuntimeSpawn_Common | undefined {
  if (mode === "carrier") return BOMB_CARRIER_LOOP_ASSET;
  if (mode === "base" || mode === "dropped") return BOMB_NEUTRAL_LOOP_ASSET;
  return undefined;
}

function getBombLoopVolumeForMode(mode: BombBeepMode): number {
  return mode === "carrier" ? BOMB_CARRIER_LOOP_VOLUME : BOMB_NEUTRAL_LOOP_VOLUME;
}

function clearBombBeepPulseNow(): void {
  stopBombLoopHandle(bombBeepPulseHandle);

  if (bombBeepPulseObject) {
    unspawnObjectSafe(bombBeepPulseObject, "bomb active loop object", false);
  } else if (bombBeepPulseSpawned) {
    unspawnObjectSafe(bombBeepPulseSpawned, "bomb active loop spawned source", false);
  } else if (bombBeepPulseHandle) {
    unspawnObjectSafe(bombBeepPulseHandle as unknown, "bomb active loop handle", false);
  }

  bombBeepPulseSpawned = undefined;
  bombBeepPulseObject = undefined;
  bombBeepPulseHandle = undefined;
  bombBeepLastPlayPos = undefined;
}

function clearBombBeepModeState(): void {
  bombBeepMode = "none";
  bombBeepNextPulseAtSec = 0;
  bombBeepFixedAnchorPos = undefined;
  bombBeepLastPlayPos = undefined;
}

function setBombBeepModeState(mode: BombBeepMode, fixedAnchorPos?: mod.Vector, nowSec?: number): void {
  const previousMode = bombBeepMode;
  const previousAnchor = bombBeepFixedAnchorPos;
  const now = nowSec ?? getCurrentSchedulerNowSeconds();

  bombBeepMode = mode;
  bombBeepFixedAnchorPos = mode === "carrier" ? undefined : fixedAnchorPos;

  const anchorChanged =
    (previousAnchor === undefined) !== (bombBeepFixedAnchorPos === undefined) ||
    (previousAnchor !== undefined &&
      bombBeepFixedAnchorPos !== undefined &&
      mod.DistanceBetween(previousAnchor, bombBeepFixedAnchorPos) > 0.01);

  if (previousMode !== mode || anchorChanged) {
    clearBombBeepPulseNow();
    bombBeepNextPulseAtSec = now;
  }
}

function getBombBeepWarnForMode(mode: BombBeepMode): ((reason: string) => void) | undefined {
  if (mode === "base") return warnBombBaseBeepLoopMissingOnce;
  if (mode === "dropped") return warnBombDroppedBeepLoopMissingOnce;
  if (mode === "carrier") return warnBombCarrierBeepLoopMissingOnce;
  return undefined;
}

function playBombBeepPulseAtPosition(mode: BombBeepMode, pos: mod.Vector): void {
  if (mode === "none") return;

  const warn = getBombBeepWarnForMode(mode);
  const asset = getBombLoopAssetForMode(mode);
  if (!asset) {
    if (warn) warn("missing loop asset");
    return;
  }

  clearBombBeepPulseNow();

  const spawnedSource = spawnRuntimeSfxSourceAtPosition(asset, pos);
  const activeHandle = tryPlayRuntimeSfxSource3D(
    spawnedSource,
    getBombLoopVolumeForMode(mode),
    pos,
    BOMB_SOUND_ATTENUATION_RANGE
  );
  if (!activeHandle) {
    if (spawnedSource.spawned) {
      unspawnObjectSafe(spawnedSource.spawned, "bomb loop spawn failure cleanup", false);
    }
    if (warn) {
      warn(
        "spawn/resolve failed (" + spawnedSource.reason + ", objId=" + String(spawnedSource.objId) + ")"
      );
    }
    return;
  }

  bombBeepPulseSpawned = spawnedSource.spawned;
  bombBeepPulseObject = spawnedSource.object;
  bombBeepPulseHandle = activeHandle;

  bombBeepLastPlayPos = pos;
  if (mode === "carrier") {
    bombBeepNextPulseAtSec = getCurrentSchedulerNowSeconds() + BOMB_CARRIER_LOOP_REANCHOR_COOLDOWN_SECONDS;
  }
}

function clearBombBaseBeepLoop(): void {
  if (bombBeepMode !== "base") return;
  clearBombBeepPulseNow();
  clearBombBeepModeState();
}

function clearBombDroppedBeepLoop(): void {
  if (bombBeepMode !== "dropped") return;
  clearBombBeepPulseNow();
  clearBombBeepModeState();
}

function clearBombCarrierBeepLoop(): void {
  if (bombBeepMode !== "carrier") return;
  clearBombBeepPulseNow();
  clearBombBeepModeState();
}

function startBombBaseBeepLoopAtPosition(pos: mod.Vector): void {
  setBombBeepModeState("base", pos);
  playBombBeepPulseAtPosition("base", pos);
}

function startBombDroppedBeepLoopAtPosition(pos: mod.Vector): void {
  setBombBeepModeState("dropped", pos);
  playBombBeepPulseAtPosition("dropped", pos);
}

function startBombCarrierBeepLoopAtPosition(pos: mod.Vector): void {
  setBombBeepModeState("carrier");
  playBombBeepPulseAtPosition("carrier", pos);
}

function clearBombDropOneShotRuntimeSource(): void {
  bombDropOneShotCleanupToken += 1;
  stopBombLoopHandle(bombDropOneShotHandle);

  if (bombDropOneShotObject) {
    unspawnObjectSafe(bombDropOneShotObject, "bomb drop one-shot object", false);
  } else if (bombDropOneShotSpawned) {
    unspawnObjectSafe(bombDropOneShotSpawned, "bomb drop one-shot spawned source", false);
  } else if (bombDropOneShotHandle) {
    unspawnObjectSafe(bombDropOneShotHandle as unknown, "bomb drop one-shot handle", false);
  }

  bombDropOneShotSpawned = undefined;
  bombDropOneShotObject = undefined;
  bombDropOneShotHandle = undefined;
}

async function cleanupBombDropOneShotAfterDelay(token: number): Promise<void> {
  await mod.Wait(BOMB_DROP_ONE_SHOT_CLEANUP_SECONDS);
  if (bombDropOneShotCleanupToken !== token) return;
  clearBombDropOneShotRuntimeSource();
}

function getBombCarrierIconTargetPosition(player: mod.Player): mod.Vector | undefined {
  const carrierPos = tryGetPlayerPositionSafe(player);
  if (!carrierPos) return undefined;
  return mod.Add(carrierPos, mod.CreateVector(0, BOMB_CARRIER_ICON_HEIGHT_OFFSET_METERS, 0));
}

function getBombCarrierIconTargetPositionForPlayerId(playerId: number, player: mod.Player): mod.Vector | undefined {
  const carrierPos = tryGetPlayerPositionSafe(player);
  if (!carrierPos) return undefined;

  lastKnownLivePositionByPlayerId[playerId] = carrierPos;
  cipherPlayerPositionSnapshotByPlayerId[playerId] = snapshotVector(carrierPos);
  return mod.Add(carrierPos, mod.CreateVector(0, BOMB_CARRIER_ICON_HEIGHT_OFFSET_METERS, 0));
}

function setBombCarrierIconPositionSafe(icon: mod.WorldIcon, pos: mod.Vector, _context: string): boolean {
  try {
    mod.SetWorldIconPosition(icon, pos);
    return true;
  } catch (_errSetPos) {
    return false;
  }
}

function setBombCarrierIconAbsolutePositionSafe(
  icon: mod.WorldIcon | undefined,
  object: mod.Object | undefined,
  pos: mod.Vector,
  context: string
): boolean {
  let moved = true;
  if (icon) {
    moved = setBombCarrierIconPositionSafe(icon, pos, context + "_handle") && moved;
  }
  if (object) {
    moved = moveObjectToAbsolutePositionSafe(object, pos, context + "_object") && moved;
  }
  return moved;
}

function setBombCarrierIconHotLanePosition(
  icon: mod.WorldIcon | undefined,
  object: mod.Object | undefined,
  targetPos: mod.Vector,
  previousTargetPos: mod.Vector | undefined,
  context: string
): boolean {
  if (!icon) return false;

  const movedHandle = setBombCarrierIconPositionSafe(icon, targetPos, context + "_handle");
  if (!movedHandle) return false;

  let shouldSnapBackingObject = previousTargetPos === undefined;
  if (!shouldSnapBackingObject && previousTargetPos) {
    const distance = mod.DistanceBetween(previousTargetPos, targetPos);
    shouldSnapBackingObject = !Number.isFinite(distance) || distance > BOMB_CARRIER_ICON_HARD_SNAP_DISTANCE_METERS;
  }

  if (shouldSnapBackingObject && object) {
    moveObjectToAbsolutePositionSafe(object, targetPos, context + "_object_snap");
  }

  return true;
}

function clearBombCarrierRuntimeWorldIcons(): void {
  if (bombCarrierFriendlyIconHandle) {
    try {
      mod.EnableWorldIconText(bombCarrierFriendlyIconHandle, false);
      mod.EnableWorldIconImage(bombCarrierFriendlyIconHandle, false);
    } catch (_err) {}
  }
  if (bombCarrierEnemyIconHandle) {
    try {
      mod.EnableWorldIconText(bombCarrierEnemyIconHandle, false);
      mod.EnableWorldIconImage(bombCarrierEnemyIconHandle, false);
    } catch (_err) {}
  }

  if (bombCarrierFriendlyIconObject) {
    unspawnObjectSafe(bombCarrierFriendlyIconObject, "carrier friendly icon object", false);
  } else if (bombCarrierFriendlyIconHandle) {
    unspawnObjectSafe(bombCarrierFriendlyIconHandle as unknown, "carrier friendly icon handle", false);
  }

  if (bombCarrierEnemyIconObject) {
    unspawnObjectSafe(bombCarrierEnemyIconObject, "carrier enemy icon object", false);
  } else if (bombCarrierEnemyIconHandle) {
    unspawnObjectSafe(bombCarrierEnemyIconHandle as unknown, "carrier enemy icon handle", false);
  }

  bombCarrierFriendlyIconObject = undefined;
  bombCarrierFriendlyIconHandle = undefined;
  bombCarrierEnemyIconObject = undefined;
  bombCarrierEnemyIconHandle = undefined;
  bombCarrierEnemyBlinkStartAtSec = 0;
  bombCarrierLastSourcePos = undefined;
  bombCarrierFriendlyLastPos = undefined;
  bombCarrierEnemyLastPos = undefined;
  resetCarrierIconVisualFollowState();
}

function configureBombCarrierIconForTeam(icon: mod.WorldIcon, ownerTeam: mod.Team, color: mod.Vector): boolean {
  try {
    mod.SetWorldIconImage(icon, BOMB_CARRIER_ICON_IMAGE);
    mod.SetWorldIconColor(icon, color);
    mod.SetWorldIconText(icon, getBombWorldIconTextMessage());
    mod.EnableWorldIconText(icon, true);
  } catch (_errConfig) {
    return false;
  }

  try {
    mod.SetWorldIconOwner(icon, ownerTeam);
  } catch (_errOwner) {
    warnBombCarrierIconOwnerFailureOnce("SetWorldIconOwner failed");
    return false;
  }

  try {
    mod.EnableWorldIconImage(icon, true);
  } catch (_errEnable) {
    return false;
  }

  return true;
}

function spawnBombCarrierRuntimeWorldIcons(
  carrierPlayer: mod.Player,
  nowSec?: number,
  carrierTeamOverride?: mod.Team
): void {
  clearBombCarrierRuntimeWorldIcons();

  if (!mod.IsPlayerValid(carrierPlayer)) return;
  const knownCarrierId = bombCarrierPlayerId;
  const carrierPos =
    knownCarrierId !== undefined
      ? getBombCarrierIconTargetPositionForPlayerId(knownCarrierId, carrierPlayer)
      : getBombCarrierIconTargetPosition(carrierPlayer);
  if (!carrierPos) return;

  const carrierTeam =
    carrierTeamOverride ??
    (knownCarrierId !== undefined ? getCipherKeyTeamSnapshot(knownCarrierId) : undefined);
  if (!carrierTeam) return;
  if (!mod.Equals(carrierTeam, team1) && !mod.Equals(carrierTeam, team2)) return;
  const enemyTeam = mod.Equals(carrierTeam, team1) ? team2 : team1;

  let friendlySpawned: unknown = undefined;
  try {
    friendlySpawned = mod.SpawnObject(BOMB_CARRIER_ICON_ASSET, carrierPos, BOMB_DROP_ROTATION) as unknown;
  } catch (_errSpawnFriendly) {
    warnBombCarrierIconMissingOnce("friendly SpawnObject failed");
    return;
  }

  const friendlyResolved = resolveObjectFromUnknown(friendlySpawned);
  const friendlyIcon = resolveRuntimeWorldIconHandle(friendlySpawned);
  if (!friendlyIcon) {
    warnBombCarrierIconMissingOnce("friendly resolve handle failed");
    if (friendlyResolved.object) {
      unspawnObjectSafe(friendlyResolved.object, "carrier friendly icon unresolved", false);
    }
    return;
  }

  if (!configureBombCarrierIconForTeam(friendlyIcon, carrierTeam, BOMB_CARRIER_ICON_FRIENDLY_COLOR)) {
    warnBombCarrierIconMissingOnce("friendly configure failed");
    unspawnObjectSafe(friendlyIcon as unknown, "carrier friendly icon configure failed", false);
    return;
  }

  bombCarrierFriendlyIconObject = friendlyResolved.object;
  bombCarrierFriendlyIconHandle = friendlyIcon;
  if (!setBombCarrierIconAbsolutePositionSafe(
    friendlyIcon,
    bombCarrierFriendlyIconObject,
    carrierPos,
    "carrier_icon_friendly_spawn"
  )) {
    warnBombCarrierIconMissingOnce("friendly SetWorldIconPosition failed");
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  let enemySpawned: unknown = undefined;
  try {
    enemySpawned = mod.SpawnObject(BOMB_CARRIER_ICON_ASSET, carrierPos, BOMB_DROP_ROTATION) as unknown;
  } catch (_errSpawnEnemy) {
    warnBombCarrierIconMissingOnce("enemy SpawnObject failed");
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  const enemyResolved = resolveObjectFromUnknown(enemySpawned);
  const enemyIcon = resolveRuntimeWorldIconHandle(enemySpawned);
  if (!enemyIcon) {
    warnBombCarrierIconMissingOnce("enemy resolve handle failed");
    if (enemyResolved.object) {
      unspawnObjectSafe(enemyResolved.object, "carrier enemy icon unresolved", false);
    }
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  if (!configureBombCarrierIconForTeam(enemyIcon, enemyTeam, BOMB_CARRIER_ICON_ENEMY_COLOR)) {
    warnBombCarrierIconMissingOnce("enemy configure failed");
    unspawnObjectSafe(enemyIcon as unknown, "carrier enemy icon configure failed", false);
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  bombCarrierEnemyIconObject = enemyResolved.object;
  bombCarrierEnemyIconHandle = enemyIcon;
  if (!setBombCarrierIconAbsolutePositionSafe(
    enemyIcon,
    bombCarrierEnemyIconObject,
    carrierPos,
    "carrier_icon_enemy_spawn"
  )) {
    warnBombCarrierIconMissingOnce("enemy SetWorldIconPosition failed");
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  bombCarrierLastSourcePos = carrierPos;
  bombCarrierFriendlyLastPos = carrierPos;
  bombCarrierEnemyLastPos = carrierPos;
  bombCarrierEnemyBlinkStartAtSec = nowSec ?? getCurrentSchedulerNowSeconds();
}

function syncCipherCarrierVisualsNow(nowSec?: number, _reason: string = "tick"): void {
  updateBombCarrierRuntimeWorldIconsTick(nowSec);
}

function updateBombCarrierRuntimeWorldIconsTick(nowSec?: number): void {
  const now = nowSec ?? getCurrentSchedulerNowSeconds();
  if (gameStatus !== 3 || bombCarrierPlayerId === undefined) {
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  const carrier = serverPlayers.get(bombCarrierPlayerId);
  if (!carrier || !carrier.isDeployed || !mod.IsPlayerValid(carrier.player) || !isPlayerAlive(carrier.player)) {
    clearBombCarrierRuntimeWorldIcons();
    return;
  }

  if (!bombCarrierFriendlyIconHandle || !bombCarrierEnemyIconHandle) {
    spawnBombCarrierRuntimeWorldIcons(
      carrier.player,
      now,
      getCipherKeyTeamSnapshot(bombCarrierPlayerId) ?? carrier.team
    );
    return;
  }

  const carrierPos = getBombCarrierIconTargetPositionForPlayerId(bombCarrierPlayerId, carrier.player);
  if (!carrierPos) return;

  const movedFriendly = setBombCarrierIconHotLanePosition(
    bombCarrierFriendlyIconHandle,
    bombCarrierFriendlyIconObject,
    carrierPos,
    bombCarrierFriendlyLastPos,
    "carrier_icon_friendly_tick"
  );
  const movedEnemy = setBombCarrierIconHotLanePosition(
    bombCarrierEnemyIconHandle,
    bombCarrierEnemyIconObject,
    carrierPos,
    bombCarrierEnemyLastPos,
    "carrier_icon_enemy_tick"
  );

  if (!movedFriendly || !movedEnemy) {
    clearBombCarrierRuntimeWorldIcons();
    spawnBombCarrierRuntimeWorldIcons(
      carrier.player,
      now,
      getCipherKeyTeamSnapshot(bombCarrierPlayerId) ?? carrier.team
    );
    return;
  }

  bombCarrierLastSourcePos = carrierPos;
  bombCarrierFriendlyLastPos = carrierPos;
  bombCarrierEnemyLastPos = carrierPos;

  try {
    mod.EnableWorldIconImage(bombCarrierFriendlyIconHandle, true);
    mod.EnableWorldIconText(bombCarrierFriendlyIconHandle, true);
  } catch (_errFriendlyEnable) {}

  const elapsedSec = mod.Max(0, now - bombCarrierEnemyBlinkStartAtSec);
  const cycleSec = elapsedSec % BOMB_CARRIER_ICON_BLINK_CYCLE_SECONDS;
  const enemyVisible = cycleSec < BOMB_CARRIER_ICON_BLINK_ON_SECONDS;
  try {
    mod.EnableWorldIconImage(bombCarrierEnemyIconHandle, enemyVisible);
    mod.EnableWorldIconText(bombCarrierEnemyIconHandle, enemyVisible);
  } catch (_errEnemyEnable) {}
}

function updateBombCarrierBeepLoopTick(nowSec?: number): void {
  const now = nowSec ?? getCurrentSchedulerNowSeconds();
  if (gameStatus !== 3) {
    clearBombBeepPulseNow();
    clearBombBeepModeState();
    return;
  }

  let desiredMode: BombBeepMode = "none";
  let desiredPulsePos: mod.Vector | undefined = undefined;
  let desiredFixedAnchor: mod.Vector | undefined = undefined;

  if (bombCarrierPlayerId !== undefined) {
    const carrier = serverPlayers.get(bombCarrierPlayerId);
    if (carrier && carrier.isDeployed && mod.IsPlayerValid(carrier.player) && isPlayerAlive(carrier.player)) {
      const carrierPos = tryGetPlayerPositionSafe(carrier.player);
      if (carrierPos) {
        desiredMode = "carrier";
        desiredPulsePos = carrierPos;
      }
    }
  }

  if (desiredMode === "none" && hasDroppedBombRuntimeObjects()) {
    const droppedPos = resolveDroppedBombAudioAnchorPosition();
    if (droppedPos) {
      desiredMode = "dropped";
      desiredPulsePos = droppedPos;
      desiredFixedAnchor = droppedPos;
    }
  }

  if (desiredMode === "none" && hasBaseBombAuthorityOrPending() && !hasDroppedBombRuntimeObjects()) {
    const basePos = resolveBaseBombAudioAnchorPosition();
    if (basePos) {
      bombBaseCachedPosition = basePos;
      desiredMode = "base";
      desiredPulsePos = basePos;
      desiredFixedAnchor = basePos;
    }
  }

  if (desiredMode === "none" || !desiredPulsePos) {
    clearBombBeepPulseNow();
    clearBombBeepModeState();
    return;
  }

  const anchorChanged =
    (desiredMode !== "carrier" &&
      ((bombBeepFixedAnchorPos === undefined) !== (desiredFixedAnchor === undefined) ||
        (bombBeepFixedAnchorPos !== undefined &&
          desiredFixedAnchor !== undefined &&
          mod.DistanceBetween(bombBeepFixedAnchorPos, desiredFixedAnchor) > 0.01))) ||
    false;

  if (bombBeepMode !== desiredMode || anchorChanged || !bombBeepPulseHandle || !bombBeepLastPlayPos) {
    setBombBeepModeState(desiredMode, desiredFixedAnchor, now);
    playBombBeepPulseAtPosition(desiredMode, desiredPulsePos);
    return;
  }

  if (desiredMode !== "carrier") return;

  if (bombBeepPulseObject) {
    const moved = moveObjectToAbsolutePositionSafe(
      bombBeepPulseObject,
      desiredPulsePos,
      "bomb_carrier_loop_follow"
    );
    if (!moved) {
      playBombBeepPulseAtPosition(desiredMode, desiredPulsePos);
      return;
    }
  } else {
    playBombBeepPulseAtPosition(desiredMode, desiredPulsePos);
    return;
  }

  if (now < bombBeepNextPulseAtSec) return;
  if (mod.DistanceBetween(bombBeepLastPlayPos, desiredPulsePos) < BOMB_CARRIER_LOOP_REANCHOR_DISTANCE_METERS) {
    return;
  }

  playBombBeepPulseAtPosition(desiredMode, desiredPulsePos);
}

function warnBombDroppedPickupObjectSpawnFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombDroppedPickupObjectSpawnWarned) return;
  bombDroppedPickupObjectSpawnWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB DROP] Dropped loot spawner spawn failed ({})", reason)
  );
}

function warnBombBasePickupObjectSpawnFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombBasePickupObjectSpawnWarned) return;
  bombBasePickupObjectSpawnWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BASE] Base loot spawn failed ({})", reason)
  );
}

function warnBombPickupObjectUnspawnFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombPickupObjectUnspawnWarned) return;
  bombPickupObjectUnspawnWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB FLOW] Runtime object unspawn failed ({})", reason)
  );
}

function warnBombDropRuntimeWorldIconMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombDroppedWorldIconMissingWarned) return;
  bombDroppedWorldIconMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB DROP] Runtime WorldIcon unavailable ({})", reason)
  );
}

function warnBombBasePositionResolveFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombBasePositionResolveWarned) return;
  bombBasePositionResolveWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BASE] Base position resolve failed ({})", reason)
  );
}

function warnBombBaseReturnRespawnFailureOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombBaseReturnRespawnFailedWarned) return;
  bombBaseReturnRespawnFailedWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BASE] Return-to-base respawn failed ({})", reason)
  );
}

function clearBombBaseRuntimeLootSpawner(): void {
  if (bombBaseRuntimeLootSpawnerObject) {
    unspawnObjectSafe(bombBaseRuntimeLootSpawnerObject, "base runtime loot spawner");
  }
  bombBaseRuntimeLootSpawnerObject = undefined;
  bombBaseRuntimeLootSpawnerHandle = undefined;
  bombBaseRuntimeLootSpawnerObjectId = undefined;
}

function clearBombDroppedRuntimeLootSpawner(): void {
  if (bombDroppedRuntimeLootSpawnerObject) {
    unspawnObjectSafe(bombDroppedRuntimeLootSpawnerObject, "dropped runtime loot spawner");
  }
  bombDroppedRuntimeLootSpawnerObject = undefined;
  bombDroppedRuntimeLootSpawnerHandle = undefined;
}

function spawnRuntimeLootSpawnerAt(position: mod.Vector, context: string): RuntimeLootSpawnerSpawnValidation {
  const spawnedRuntime = spawnRuntimeCommonObjectSafe(
    BOMB_RUNTIME_LOOT_SPAWNER_ASSET,
    position,
    BOMB_DROP_ROTATION,
    context,
    BOMB_RUNTIME_LOOT_SPAWNER_SCALE
  );
  if (!spawnedRuntime.object) {
    return {
      object: undefined,
      spawner: undefined,
      objId: spawnedRuntime.objId,
      reason: spawnedRuntime.reason,
      position: undefined,
    };
  }

  let runtimeSpawner: mod.LootSpawner | undefined = undefined;
  if (spawnedRuntime.objId >= 0) {
    try {
      runtimeSpawner = mod.GetLootSpawner(spawnedRuntime.objId);
    } catch (_err) {}
  }

  if (!runtimeSpawner) {
    unspawnObjectSafe(spawnedRuntime.object, context + " resolve loot spawner");
    setBombSpawnValidationDebugState(context, "runtime_get_lootspawner_failed", spawnedRuntime.objId);
    return {
      object: undefined,
      spawner: undefined,
      objId: spawnedRuntime.objId,
      reason: "runtime_get_lootspawner_failed",
      position: undefined,
    };
  }

  const runtimePos =
    getObjectPositionSafeValidated(spawnedRuntime.object, context + "_position_after_spawn").position ?? position;

  return {
    object: spawnedRuntime.object,
    spawner: runtimeSpawner,
    objId: spawnedRuntime.objId,
    reason: "ok",
    position: runtimePos,
  };
}

function spawnLootAtRuntimeSpawner(position: mod.Vector, context: string): RuntimeLootSpawnerSpawnValidation {
  const runtimeSpawner = spawnRuntimeLootSpawnerAt(position, context);
  if (!runtimeSpawner.object || !runtimeSpawner.spawner) return runtimeSpawner;

  try {
    mod.SpawnLoot(runtimeSpawner.spawner, BOMB_LOOT_GADGET);
    setBombSpawnValidationDebugState(context, "runtime_spawnloot_ok", runtimeSpawner.objId);
    return runtimeSpawner;
  } catch (_err) {
    unspawnObjectSafe(runtimeSpawner.object, context + " runtime SpawnLoot failed");
    setBombSpawnValidationDebugState(context, "runtime_spawnloot_failed", runtimeSpawner.objId);
    return {
      object: undefined,
      spawner: undefined,
      objId: runtimeSpawner.objId,
      reason: "runtime_spawnloot_failed",
      position: undefined,
    };
  }
}

function tryResolveBombBaseRuntimeLootPosition(context: string): mod.Vector | undefined {
  const runtimeTarget = bombBaseRuntimeLootSpawnerObject ?? bombBaseRuntimeLootSpawnerObjectId;
  return getObjectPositionSafeValidated(runtimeTarget, context).position;
}

function tryResolveBombBasePosition(): mod.Vector | undefined {
  const runtimePos = tryResolveBombBaseRuntimeLootPosition("base_loot_spawner_runtime_position");
  if (runtimePos) {
    bombBaseCachedPosition = runtimePos;
    return runtimePos;
  }

  if (bombBaseCachedPosition) return bombBaseCachedPosition;

  warnBombBasePositionResolveFailureOnce("no runtime/cached base position");
  return undefined;
}

function spawnDroppedBombAtPosition(pos: mod.Vector): boolean {
  clearDroppedBombRuntimeObjects();

  const runtimeDroppedSpawn = spawnLootAtRuntimeSpawner(pos, BOMB_SPAWN_CONTEXT_DROPPED_PICKUP);
  if (!runtimeDroppedSpawn.object || !runtimeDroppedSpawn.spawner) {
    warnBombDroppedPickupObjectSpawnFailureOnce(
      "spawn validation failed (" +
        runtimeDroppedSpawn.reason +
        ", objId=" +
        String(runtimeDroppedSpawn.objId) +
        ")"
    );
    return false;
  }

  bombDroppedRuntimeLootSpawnerObject = runtimeDroppedSpawn.object;
  bombDroppedRuntimeLootSpawnerHandle = runtimeDroppedSpawn.spawner;
  const dropAnchorPos = pos;
  bombDroppedPickupAnchorPosition = dropAnchorPos;
  clearBombBaseBeepLoop();
  clearBombCarrierBeepLoop();
  startBombDroppedBeepLoopAtPosition(dropAnchorPos);

  let runtimeIconSpawned: unknown = undefined;
  try {
    runtimeIconSpawned = mod.SpawnObject(BOMB_DROP_WORLDICON_ASSET, dropAnchorPos, BOMB_DROP_ROTATION) as unknown;
  } catch (_errWorldIconSpawn) {
    setBombSpawnValidationDebugState(BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON, "spawn_exception", -1);
    warnBombDropRuntimeWorldIconMissingOnce("SpawnObject failed");
    return true;
  }

  const runtimeIconObject = resolveObjectFromUnknown(runtimeIconSpawned);
  setBombSpawnValidationDebugState(
    BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON,
    runtimeIconObject.reason,
    runtimeIconObject.objId
  );
  bombDroppedWorldIconObject = runtimeIconObject.object;
  bombDroppedWorldIconHandle = undefined;

  const runtimeIcon = resolveRuntimeWorldIconHandle(runtimeIconSpawned);
  if (!runtimeIcon) {
    warnBombDropRuntimeWorldIconMissingOnce("resolve handle failed");
    return true;
  }

  bombDroppedWorldIconHandle = runtimeIcon;

  const configured = configureBombWorldIconSafe(runtimeIcon, true);
  if (!configured) {
    warnBombDropRuntimeWorldIconMissingOnce("configure icon failed");
    return true;
  }

  // Reassert final visible state for deterministic drop visuals.
  try {
    mod.EnableWorldIconImage(runtimeIcon, true);
  } catch (_errWorldIconEnable) {
    warnBombDropRuntimeWorldIconMissingOnce("enable image failed");
  }

  return true;
}

function getActiveBombSourcePosition(): mod.Vector | undefined {
  const droppedPos = getObjectPositionSafeValidated(
    bombDroppedRuntimeLootSpawnerObject,
    "active_source_dropped_loot_spawner"
  ).position;
  if (droppedPos) return droppedPos;

  const baseRuntimePos = tryResolveBombBaseRuntimeLootPosition("active_source_base_loot_spawner");
  if (baseRuntimePos) return baseRuntimePos;

  return bombBaseCachedPosition;
}

function resetBombCarrierVerticalTrackingState(): void {
  bombCarrierTrackedY = undefined;
  bombCarrierVerticalState = "stable";
  bombCarrierStableYSinceSec = 0;
  bombCarrierSawRisingY = false;
  bombCarrierSawFallingY = false;
  bombCarrierPendingManualDrop = false;
  bombCarrierManualDropArmed = false;
}

function getPlayerResolvedDropPosition(playerId: number): mod.Vector | undefined {
  const sp = serverPlayers.get(playerId);
  if (sp && mod.IsPlayerValid(sp.player)) {
    const livePos = tryGetPlayerPositionSafe(sp.player);
    if (livePos) return livePos;
  }

  return lastKnownLivePositionByPlayerId[playerId];
}

function updateBombCarrierVerticalTrackingState(
  player: mod.Player,
  nowSec: number
): mod.Vector | undefined {
  const pos = tryGetPlayerPositionSafe(player);
  if (!pos) return undefined;

  if (bombCarrierTrackedY === undefined) {
    bombCarrierTrackedY = mod.YComponentOf(pos);
    bombCarrierVerticalState = "stable";
    bombCarrierStableYSinceSec = nowSec;
    return pos;
  }

  const deltaY = mod.YComponentOf(pos) - bombCarrierTrackedY;
  if (deltaY > BOMB_CARRIER_DROP_Y_EPSILON_METERS) {
    bombCarrierVerticalState = "rising";
    bombCarrierSawRisingY = true;
    bombCarrierStableYSinceSec = 0;
  } else if (deltaY < -BOMB_CARRIER_DROP_Y_EPSILON_METERS) {
    bombCarrierVerticalState = "falling";
    bombCarrierSawFallingY = true;
    bombCarrierStableYSinceSec = 0;
  } else {
    bombCarrierVerticalState = "stable";
    if (bombCarrierStableYSinceSec <= 0) {
      bombCarrierStableYSinceSec = nowSec;
    }
    if (
      !bombCarrierPendingManualDrop &&
      nowSec - bombCarrierStableYSinceSec >= BOMB_CARRIER_DROP_STABLE_SECONDS
    ) {
      bombCarrierSawRisingY = false;
      bombCarrierSawFallingY = false;
    }
  }

  bombCarrierTrackedY = mod.YComponentOf(pos);
  return pos;
}

function getBombDropFallbackPosition(playerId: number): mod.Vector | undefined {
  const resolvedPos = getPlayerResolvedDropPosition(playerId);
  if (resolvedPos) return resolvedPos;

  return getActiveBombSourcePosition();
}

function isEligibleBombRadiusPickupCandidate(sp: Player): boolean {
  if (!sp) return false;
  if (!sp.isDeployed) return false;
  if (!mod.IsPlayerValid(sp.player)) return false;
  if (!isPlayerAlive(sp.player)) return false;
  if (isBotBackfillPlayer(sp.player)) return false;

  const team = getCipherKeyTeamSnapshot(sp.id) ?? sp.team;
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;
  return true;
}

function isEligibleDroppedBombReclaimCandidate(sp: Player): boolean {
  if (!isEligibleBombRadiusPickupCandidate(sp)) return false;
  if (bombDroppedLastCarrierPlayerId === sp.id && getCurrentSchedulerNowSeconds() < bombDroppedLastCarrierBlockedUntilSec) {
    return false;
  }

  return true;
}

function findBombPickupCandidateWithinRadiusDeterministic(
  anchorPos: mod.Vector,
  radiusMeters: number,
  eligibilityOverride?: (sp: Player) => boolean
): Player | undefined {
  let winner: Player | undefined = undefined;
  let winnerDistance = radiusMeters + 0.0001;
  let scanned = 0;

  serverPlayers.forEach((sp) => {
    scanned += 1;
    const isEligible = eligibilityOverride ?? isEligibleBombRadiusPickupCandidate;
    if (!isEligible(sp)) return;

    const pos = tryGetPlayerPositionSafe(sp.player);
    if (!pos) return;

    const dist = mod.DistanceBetween(pos, anchorPos);
    if (dist > radiusMeters) return;

    if (
      !winner ||
      dist < winnerDistance - 0.0001 ||
      (Math.abs(dist - winnerDistance) <= 0.0001 && sp.id < winner.id)
    ) {
      winner = sp;
      winnerDistance = dist;
    }
  });
  trackBombPickupScanCandidates(scanned);

  return winner;
}

function findDroppedBombReclaimCandidateWithinRadius(anchorPos: mod.Vector): Player | undefined {
  return findBombPickupCandidateWithinRadiusDeterministic(
    anchorPos,
    BOMB_DROPPED_RECLAIM_RADIUS_METERS,
    isEligibleDroppedBombReclaimCandidate
  );
}

function getDeployedPlayerPositionsForBombBaseSelection(): mod.Vector[] {
  const positions: mod.Vector[] = [];

  serverPlayers.forEach((sp) => {
    if (!sp || !sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;
    if (!isPlayerAlive(sp.player)) return;
    if (isBotBackfillPlayer(sp.player)) return;

    const playerTeam = getCipherKeyTeamSnapshot(sp.id) ?? sp.team;
    if (!mod.Equals(playerTeam, team1) && !mod.Equals(playerTeam, team2)) return;

    const pos = tryGetPlayerPositionSafe(sp.player);
    if (!pos) return;
    positions.push(pos);
  });

  return positions;
}

function getObjectiveCapturePointPosition(cpId: number): mod.Vector | undefined {
  const cp = serverCapturePoints[cpId];
  if (!cp) return undefined;

  try {
    return mod.GetObjectPosition(cp.capturePoint);
  } catch (_err) {
    return undefined;
  }
}

function getBombVectorMidpoint(a: mod.Vector, b: mod.Vector): mod.Vector {
  return mod.Divide(mod.Add(a, b), 2);
}

function getBombVectorHorizontalDistanceSquared(a: mod.Vector, b: mod.Vector): number {
  const dx = mod.XComponentOf(a) - mod.XComponentOf(b);
  const dz = mod.ZComponentOf(a) - mod.ZComponentOf(b);
  return (dx * dx) + (dz * dz);
}

function getBombVectorHorizontalDistanceMeters(a: mod.Vector, b: mod.Vector): number {
  return mod.SquareRoot(getBombVectorHorizontalDistanceSquared(a, b));
}

function snapshotVector(position: mod.Vector): CipherVectorSnapshot {
  return {
    x: mod.XComponentOf(position),
    y: mod.YComponentOf(position),
    z: mod.ZComponentOf(position),
  };
}

function resetCipherSpawnRoutingState(): void {
  cipherPresenceZoneActivePlayersByZone = {};
  cipherPresenceZonesByPlayerId = {};
  cipherAnchorPositionByObjectId = {};
  cipherAnchorPositionSnapshotByObjectId = {};
  cipherCapturePointPositionByObjectId = {};
  cipherCapturePointPositionSnapshotByObjectId = {};
  cipherPlayerPositionSnapshotByPlayerId = {};
  cipherAnchorCooldownUntilSecByObjectId = {};
  cipherAnchorRoundRobinIndexByKey = {};
  cipherVariantTieFlipBySide = {};
  cipherQueuedAnchorByPlayerId = {};
  cipherPendingSpawnJobs = [];
  cipherUrgentSpawnJobs = [];
}

function isCipherPresenceTriggerId(triggerId: number): boolean {
  return CIPHER_PRESENCE_TRIGGER_ZONE_BY_ID[triggerId] !== undefined;
}

function markCipherPresenceZoneActive(playerId: number, triggerId: number): void {
  const zone = CIPHER_PRESENCE_TRIGGER_ZONE_BY_ID[triggerId];
  if (!zone) return;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;

  let zones = cipherPresenceZonesByPlayerId[playerId];
  if (!zones) zones = {};
  zones[zone] = true;
  cipherPresenceZonesByPlayerId[playerId] = zones;

  let players = cipherPresenceZoneActivePlayersByZone[zone];
  if (!players) players = {};
  players[playerId] = mod.GetTeam(sp.player);
  cipherPresenceZoneActivePlayersByZone[zone] = players;
}

function clearCipherPresenceZoneActive(playerId: number, triggerId: number): void {
  const zone = CIPHER_PRESENCE_TRIGGER_ZONE_BY_ID[triggerId];
  if (!zone) return;

  const zones = cipherPresenceZonesByPlayerId[playerId];
  if (zones) {
    delete zones[zone];
  }

  const players = cipherPresenceZoneActivePlayersByZone[zone];
  if (players) {
    delete players[playerId];
  }
}

function clearCipherPresenceForPlayer(playerId: number): void {
  const zones = cipherPresenceZonesByPlayerId[playerId];
  if (zones) {
    for (const zone in zones) {
      const players = cipherPresenceZoneActivePlayersByZone[zone];
      if (players) delete players[playerId];
    }
  }
  delete cipherPresenceZonesByPlayerId[playerId];
  delete cipherPlayerPositionSnapshotByPlayerId[playerId];
}

function getCachedCipherAnchorPosition(anchorId: number): mod.Vector | undefined {
  const cached = cipherAnchorPositionByObjectId[anchorId];
  if (cached) return cached;

  try {
    const spatialAnchor = mod.GetSpatialObject(anchorId);
    const position = mod.GetObjectPosition(spatialAnchor);
    cipherAnchorPositionByObjectId[anchorId] = position;
    cipherAnchorPositionSnapshotByObjectId[anchorId] = snapshotVector(position);
    return position;
  } catch (_err) {
    cipherAnchorPositionByObjectId[anchorId] = undefined;
    return undefined;
  }
}

function getCachedCipherCapturePointPosition(cpId: number): mod.Vector | undefined {
  const cached = cipherCapturePointPositionByObjectId[cpId];
  if (cached) return cached;

  const position = getObjectiveCapturePointPosition(cpId);
  if (!position) return undefined;

  cipherCapturePointPositionByObjectId[cpId] = position;
  cipherCapturePointPositionSnapshotByObjectId[cpId] = snapshotVector(position);
  return position;
}

function getCachedCipherCapturePointPositionSnapshot(cpId: number): CipherVectorSnapshot | undefined {
  const cached = cipherCapturePointPositionSnapshotByObjectId[cpId];
  if (cached) return cached;

  const position = getCachedCipherCapturePointPosition(cpId);
  if (!position) return undefined;
  return cipherCapturePointPositionSnapshotByObjectId[cpId];
}

function refreshCipherPlayerPositionSnapshots(): void {
  serverPlayers.forEach((sp) => {
    if (!sp || !sp.isDeployed || !mod.IsPlayerValid(sp.player) || !isPlayerAliveSafe(sp.player)) {
      delete cipherPlayerPositionSnapshotByPlayerId[sp.id];
      return;
    }

    const position = tryGetPlayerPositionSafe(sp.player);
    if (!position) return;
    cipherPlayerPositionSnapshotByPlayerId[sp.id] = snapshotVector(position);
  });
}

function countCipherEnemyPresence(zone: CipherPresenceZone, enemyTeam: mod.Team): number {
  const players = cipherPresenceZoneActivePlayersByZone[zone];
  if (!players) return 0;

  let count = 0;
  for (const playerIdKey in players) {
    const playerId = Number(playerIdKey);
    const sp = serverPlayers.get(playerId);
    if (!sp || !mod.IsPlayerValid(sp.player) || !sp.isDeployed) continue;
    const team = players[playerId];
    if (mod.Equals(team, enemyTeam)) count += 1;
  }
  return count;
}

function chooseCipherSpawnVariant(side: CipherMapSide, team: mod.Team): CipherHorizontalVariant {
  const enemyTeam = getOpposingTeam(team);
  const westZone: CipherPresenceZone = side === "north" ? "northWest" : "southWest";
  const eastZone: CipherPresenceZone = side === "north" ? "northEast" : "southEast";
  const westPressure = countCipherEnemyPresence(westZone, enemyTeam);
  const eastPressure = countCipherEnemyPresence(eastZone, enemyTeam);

  if (westPressure > eastPressure) return "east";
  if (eastPressure > westPressure) return "west";

  const tieKey = side;
  const next = (cipherVariantTieFlipBySide[tieKey] ?? 0) + 1;
  cipherVariantTieFlipBySide[tieKey] = next;
  return mod.Modulo(next, 2) === 0 ? "west" : "east";
}

function getCipherAnchorIdsForSideVariant(
  side: CipherMapSide,
  variant: CipherHorizontalVariant
): number[] {
  if (side === "north") {
    return variant === "east" ? CIPHER_NORTH_EAST_ANCHORS : CIPHER_NORTH_WEST_ANCHORS;
  }
  return variant === "east" ? CIPHER_SOUTH_EAST_ANCHORS : CIPHER_SOUTH_WEST_ANCHORS;
}

function isCipherAnchorSafeFromEnemies(anchorPos: mod.Vector, team: mod.Team): boolean {
  const enemyTeam = getOpposingTeam(team);
  for (const playerIdKey in cipherPlayerPositionSnapshotByPlayerId) {
    const playerId = Number(playerIdKey);
    const sp = serverPlayers.get(playerId);
    if (!sp || !mod.IsPlayerValid(sp.player)) continue;
    if (!mod.Equals(mod.GetTeam(sp.player), enemyTeam)) continue;

    const snapshot = cipherPlayerPositionSnapshotByPlayerId[playerId];
    if (!snapshot) continue;
    const enemyPos = mod.CreateVector(snapshot.x, snapshot.y, snapshot.z);
    if (getBombVectorHorizontalDistanceMeters(anchorPos, enemyPos) <= CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS) {
      return false;
    }
  }
  return true;
}

function chooseCipherAnchorIdForPlayer(
  playerId: number,
  team: mod.Team,
  side: CipherMapSide,
  variant: CipherHorizontalVariant
): number | undefined {
  const anchorIds = getCipherAnchorIdsForSideVariant(side, variant);
  if (anchorIds.length <= 0) return undefined;

  const nowSec = getCurrentSchedulerNowSeconds();
  const key = side + ":" + variant + ":" + String(modlib.getTeamId(team));
  const startIndex = cipherAnchorRoundRobinIndexByKey[key] ?? 0;
  let fallbackAnchorId: number | undefined = undefined;

  for (let offset = 0; offset < anchorIds.length; offset++) {
    const idx = mod.Modulo(startIndex + offset, anchorIds.length);
    const anchorId = anchorIds[idx];
    const anchorPos = getCachedCipherAnchorPosition(anchorId);
    if (!anchorPos) continue;
    if (fallbackAnchorId === undefined) fallbackAnchorId = anchorId;

    const cooldownUntil = cipherAnchorCooldownUntilSecByObjectId[anchorId] ?? 0;
    if (cooldownUntil > nowSec) continue;
    if (!isCipherAnchorSafeFromEnemies(anchorPos, team)) continue;

    cipherAnchorRoundRobinIndexByKey[key] = mod.Modulo(idx + 1, anchorIds.length);
    cipherAnchorCooldownUntilSecByObjectId[anchorId] = nowSec + CIPHER_ANCHOR_COOLDOWN_SECONDS;
    return anchorId;
  }

  if (fallbackAnchorId !== undefined) {
    cipherAnchorRoundRobinIndexByKey[key] = mod.Modulo(startIndex + 1, anchorIds.length);
    cipherAnchorCooldownUntilSecByObjectId[fallbackAnchorId] = nowSec + CIPHER_ANCHOR_COOLDOWN_SECONDS;
  }
  void playerId;
  return fallbackAnchorId;
}

function getCipherAttackObjectiveCenterForSide(side: CipherMapSide): mod.Vector | undefined {
  const targetCpIds = side === "north" ? SOUTH_OBJECTIVE_CP_IDS : NORTH_OBJECTIVE_CP_IDS;
  let total: mod.Vector | undefined = undefined;
  let count = 0;

  for (let i = 0; i < targetCpIds.length; i++) {
    const position = getCachedCipherCapturePointPosition(targetCpIds[i]);
    if (!position) continue;
    total = total ? mod.Add(total, position) : position;
    count += 1;
  }

  if (!total || count <= 0) return undefined;
  return mod.Divide(total, count);
}

function isCipherSpawnRoutingPhaseActive(): boolean {
  return gameStatus === 2 || gameStatus === 3;
}

function getCipherQueuedSpawnAnchorForPlayer(playerId: number): CipherQueuedSpawnAnchor | undefined {
  return cipherQueuedAnchorByPlayerId[playerId];
}

function prepareCipherQueuedAnchorForPlayer(playerId: number, forceRefresh: boolean = false): boolean {
  if (!isCipherSpawnRoutingPhaseActive()) return false;
  if (!forceRefresh && cipherQueuedAnchorByPlayerId[playerId] !== undefined) return true;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return false;

  const team = mod.GetTeam(sp.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;

  const side = getCipherTeamSideForCurrentHalf(team);
  if (!side) return false;

  refreshCipherPlayerPositionSnapshots();
  const variant = chooseCipherSpawnVariant(side, team);
  const anchorId = chooseCipherAnchorIdForPlayer(playerId, team, side, variant);
  if (anchorId === undefined) return false;

  cipherQueuedAnchorByPlayerId[playerId] = {
    anchorObjectId: anchorId,
    side,
    variant,
  };
  return true;
}

function hasCipherSpawnJobQueued(
  queue: CipherSpawnJob[],
  playerId: number,
  kind: CipherSpawnJobKind
): boolean {
  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    if (job.playerId === playerId && job.kind === kind) return true;
  }
  return false;
}

function enqueueCipherSpawnJob(playerId: number, kind: CipherSpawnJobKind, urgent: boolean): void {
  if (!isCipherSpawnRoutingPhaseActive()) return;
  if (hasCipherSpawnJobQueued(cipherUrgentSpawnJobs, playerId, kind)) return;
  if (hasCipherSpawnJobQueued(cipherPendingSpawnJobs, playerId, kind)) return;

  const job: CipherSpawnJob = {
    kind,
    playerId,
    createdAtSec: getCurrentSchedulerNowSeconds(),
    attempt: 0,
  };
  if (urgent) {
    cipherUrgentSpawnJobs.push(job);
  } else {
    cipherPendingSpawnJobs.push(job);
  }
}

function requestCipherSpawnAnchorForPlayer(playerId: number, urgent: boolean = false): void {
  enqueueCipherSpawnJob(playerId, "queue-anchor", urgent);
}

function requestCipherSpawnTeleportForPlayer(playerId: number, urgent: boolean = false): void {
  enqueueCipherSpawnJob(playerId, "teleport-deployed", urgent);
}

function processCipherSpawnJobs(source: string): void {
  if (!isCipherSpawnRoutingPhaseActive()) return;
  void source;

  let processed = 0;
  const nowSec = getCurrentSchedulerNowSeconds();
  while (processed < CIPHER_SPAWN_JOBS_PER_TICK) {
    const job = cipherUrgentSpawnJobs.length > 0 ? cipherUrgentSpawnJobs.shift() : cipherPendingSpawnJobs.shift();
    if (!job) break;
    processed += 1;

    let completed = false;
    if (job.kind === "queue-anchor") {
      completed = prepareCipherQueuedAnchorForPlayer(job.playerId);
    } else {
      const sp = serverPlayers.get(job.playerId);
      if (sp && sp.isDeployed && mod.IsPlayerValid(sp.player) && isPlayerAliveSafe(sp.player)) {
        completed = teleportCipherPlayerToRoutedAnchor(sp.player, job.playerId);
        if (completed && isCipherLiveTransitionActive()) {
          markCipherSecondHalfDeployReadyForPlayer(job.playerId, sp.player);
        }
      }
    }

    if (!completed && nowSec - job.createdAtSec <= CIPHER_SPAWN_RETRY_WINDOW_SECONDS) {
      const retryJob: CipherSpawnJob = {
        kind: job.kind,
        playerId: job.playerId,
        createdAtSec: job.createdAtSec,
        attempt: job.attempt + 1,
      };
      cipherPendingSpawnJobs.push(retryJob);
    }
  }
}

function getCipherTeleportYawRadians(anchorPos: mod.Vector, targetCenter: mod.Vector | undefined): number {
  if (!targetCenter) return 0;
  const dx = mod.XComponentOf(targetCenter) - mod.XComponentOf(anchorPos);
  const dz = mod.ZComponentOf(targetCenter) - mod.ZComponentOf(anchorPos);
  if (Math.abs(dx) <= 0.001 && Math.abs(dz) <= 0.001) return 0;
  return Math.atan2(dx, dz);
}

function teleportCipherPlayerToRoutedAnchor(player: mod.Player, playerId: number): boolean {
  if (!isCipherSpawnRoutingPhaseActive()) return false;
  if (!mod.IsPlayerValid(player)) return false;
  if (!isPlayerAliveSafe(player)) return false;
  if (isCipherLiveTransitionActive() && cipherTransitionTeleportedByPlayerId[playerId] === true) return true;

  const team = mod.GetTeam(player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;

  if (getCipherQueuedSpawnAnchorForPlayer(playerId) === undefined) {
    prepareCipherQueuedAnchorForPlayer(playerId);
  }

  const queuedAnchor = getCipherQueuedSpawnAnchorForPlayer(playerId);
  if (!queuedAnchor) return false;

  const anchorPos = getCachedCipherAnchorPosition(queuedAnchor.anchorObjectId);
  if (!anchorPos) return false;

  const targetCenter = getCipherAttackObjectiveCenterForSide(queuedAnchor.side);
  const yawRadians = getCipherTeleportYawRadians(anchorPos, targetCenter);

  try {
    (mod as any).Teleport(player, anchorPos, yawRadians);
    cipherPlayerPositionSnapshotByPlayerId[playerId] = snapshotVector(anchorPos);
    delete cipherQueuedAnchorByPlayerId[playerId];
    if (isCipherLiveTransitionActive()) {
      cipherTransitionTeleportedByPlayerId[playerId] = true;
    }
    return true;
  } catch (err) {
    LogRuntimeError("CipherSpawnTeleport/" + String(playerId) + "/" + String(queuedAnchor.anchorObjectId), err);
  }
  return false;
}

function getBombDynamicLaneMidpoints(): BombDynamicLaneMidpoint[] | undefined {
  const posA = getObjectiveCapturePointPosition(CP_A_ID);
  const posB = getObjectiveCapturePointPosition(CP_B_ID);
  const posE = getObjectiveCapturePointPosition(CP_T2_B_ID);
  const posF = getObjectiveCapturePointPosition(CP_T2_C_ID);

  if (!posA || !posB || !posE || !posF) return undefined;

  return [
    { lane: "AE", midpoint: getBombVectorMidpoint(posA, posE) },
    { lane: "BF", midpoint: getBombVectorMidpoint(posB, posF) },
  ];
}

function getBombDynamicGeometry(): BombDynamicSpawnGeometry | undefined {
  const laneMidpoints = getBombDynamicLaneMidpoints();
  if (!laneMidpoints || laneMidpoints.length <= 0) return undefined;

  let geometryCenter = mod.CreateVector(0, 0, 0);
  for (let i = 0; i < laneMidpoints.length; i++) {
    geometryCenter = mod.Add(geometryCenter, laneMidpoints[i].midpoint);
  }
  geometryCenter = mod.Divide(geometryCenter, laneMidpoints.length);

  const deployedPositions = getDeployedPlayerPositionsForBombBaseSelection();
  if (deployedPositions.length <= 0) {
    return {
      geometryCenter,
      safestLaneMidpoint: undefined,
      finalSeed: geometryCenter,
    };
  }

  let winner: BombDynamicLaneMidpoint | undefined = undefined;
  let winnerMinDistance = -1;
  let winnerAverageDistance = -1;
  let winnerLaneOrder = Number.MAX_SAFE_INTEGER;

  const getLaneOrder = (lane: BombDynamicLane): number => {
    if (lane === "AE") return 0;
    return 1;
  };

  for (let i = 0; i < laneMidpoints.length; i++) {
    const laneMidpoint = laneMidpoints[i];
    let minDistance = Number.MAX_VALUE;
    let totalDistance = 0;

    for (let j = 0; j < deployedPositions.length; j++) {
      const distance = mod.DistanceBetween(laneMidpoint.midpoint, deployedPositions[j]);
      if (distance < minDistance) minDistance = distance;
      totalDistance += distance;
    }

    const averageDistance = totalDistance / deployedPositions.length;
    const laneOrder = getLaneOrder(laneMidpoint.lane);
    const betterMinDistance = minDistance > winnerMinDistance + 0.0001;
    const tiedMinDistance = Math.abs(minDistance - winnerMinDistance) <= 0.0001;
    const betterAverageDistance = averageDistance > winnerAverageDistance + 0.0001;
    const tiedAverageDistance = Math.abs(averageDistance - winnerAverageDistance) <= 0.0001;

    if (
      !winner ||
      betterMinDistance ||
      (tiedMinDistance && (betterAverageDistance || (tiedAverageDistance && laneOrder < winnerLaneOrder)))
    ) {
      winner = laneMidpoint;
      winnerMinDistance = minDistance;
      winnerAverageDistance = averageDistance;
      winnerLaneOrder = laneOrder;
    }
  }

  const finalSeed = winner ? getBombVectorMidpoint(geometryCenter, winner.midpoint) : geometryCenter;
  return {
    geometryCenter,
    safestLaneMidpoint: winner,
    finalSeed,
  };
}

function getBombDynamicLandingDebugContext(context: string): string {
  return context + "_dynamic_landing";
}

function getBombDynamicRetryDebugContext(context: string): string {
  return context + "_dynamic_retry";
}

function setBombDynamicLandingDebugState(context: string, resultPath: string): void {
  setBombSpawnValidationDebugState(getBombDynamicLandingDebugContext(context), resultPath, -1);
}

function setBombDynamicRetryDebugState(context: string): void {
  setBombSpawnValidationDebugState(getBombDynamicRetryDebugContext(context), "retry_scheduled", -1);
}

function getBombDynamicSeedForStrategy(
  geometry: BombDynamicSpawnGeometry,
  strategy: BombDynamicSpawnStrategy
): mod.Vector {
  if (strategy === "live_start_center") {
    return geometry.geometryCenter;
  }
  return geometry.finalSeed;
}

function tryResolveBombBaseAnchorPosition(slotIndex: number, context: string): mod.Vector | undefined {
  const cfg = getBombBaseSlotConfig(slotIndex);
  if (!cfg) return undefined;

  return tryGetBombAnchorCapturePointPositionById(
    cfg.anchorCapturePointId,
    getBombDynamicLandingDebugContext(context) + "_anchor_cp_" + String(cfg.anchorCapturePointId)
  );
}

function getBombBaseAnchorCandidatesBySeed(seed: mod.Vector, context: string): BombBaseAnchorCandidate[] {
  const candidates: BombBaseAnchorCandidate[] = [];

  for (let i = 0; i < BOMB_BASE_SLOT_CONFIGS.length; i++) {
    const cfg = getBombBaseSlotConfig(i);
    if (!cfg) continue;

    const anchorPos = tryResolveBombBaseAnchorPosition(i, context + "_slot_" + String(i));
    if (!anchorPos) return [];

    candidates.push({
      slotIndex: i,
      anchorCapturePointId: cfg.anchorCapturePointId,
      anchorPos,
      distanceSquared: getBombVectorHorizontalDistanceSquared(seed, anchorPos),
    });
  }

  candidates.sort((a, b) => {
    const distanceDelta = a.distanceSquared - b.distanceSquared;
    if (Math.abs(distanceDelta) > 0.0001) return distanceDelta;
    if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex;
    return a.anchorCapturePointId - b.anchorCapturePointId;
  });

  return candidates;
}

function getBombBaseAnchorCandidatesByPlayerPositions(context: string): BombBaseAnchorCandidate[] {
  const playerPositions = getDeployedPlayerPositionsForBombBaseSelection();
  if (playerPositions.length <= 0) return [];

  const candidates: BombBaseAnchorCandidate[] = [];

  for (let i = 0; i < BOMB_BASE_SLOT_CONFIGS.length; i++) {
    const cfg = getBombBaseSlotConfig(i);
    if (!cfg) continue;

    const anchorPos = tryResolveBombBaseAnchorPosition(i, context + "_slot_" + String(i));
    if (!anchorPos) return [];

    let totalPlayerDistanceMeters = 0;
    let nearestPlayerDistanceMeters = Number.POSITIVE_INFINITY;

    for (let j = 0; j < playerPositions.length; j++) {
      const distanceMeters = getBombVectorHorizontalDistanceMeters(anchorPos, playerPositions[j]);
      totalPlayerDistanceMeters += distanceMeters;
      if (distanceMeters < nearestPlayerDistanceMeters) {
        nearestPlayerDistanceMeters = distanceMeters;
      }
    }

    candidates.push({
      slotIndex: i,
      anchorCapturePointId: cfg.anchorCapturePointId,
      anchorPos,
      distanceSquared: 0,
      totalPlayerDistanceMeters,
      nearestPlayerDistanceMeters: Number.isFinite(nearestPlayerDistanceMeters)
        ? nearestPlayerDistanceMeters
        : 0,
    });
  }

  candidates.sort((a, b) => {
    const totalDistanceDelta =
      (b.totalPlayerDistanceMeters ?? 0) - (a.totalPlayerDistanceMeters ?? 0);
    if (Math.abs(totalDistanceDelta) > 0.0001) return totalDistanceDelta;

    const nearestDistanceDelta =
      (b.nearestPlayerDistanceMeters ?? 0) - (a.nearestPlayerDistanceMeters ?? 0);
    if (Math.abs(nearestDistanceDelta) > 0.0001) return nearestDistanceDelta;

    if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex;
    return a.anchorCapturePointId - b.anchorCapturePointId;
  });

  return candidates;
}

function resolveDynamicBombBaseAnchorCandidates(
  context: string,
  strategy: BombDynamicSpawnStrategy
): BombBaseAnchorCandidate[] {
  if (!ensureBombAnchorSectorAvailable(context)) return [];

  if (strategy === "player_biased") {
    const playerBiasedCandidates = getBombBaseAnchorCandidatesByPlayerPositions(context);
    if (playerBiasedCandidates.length > 0) {
      setBombSpawnValidationDebugState(
        getBombDynamicLandingDebugContext(context),
        "anchor_candidates_player_biased",
        playerBiasedCandidates[0].anchorCapturePointId
      );
      return playerBiasedCandidates;
    }
  }

  const geometry = getBombDynamicGeometry();
  if (!geometry) {
    setBombDynamicLandingDebugState(context, "geometry_unavailable");
    return [];
  }

  const seed = getBombDynamicSeedForStrategy(geometry, strategy);
  const candidates = getBombBaseAnchorCandidatesBySeed(seed, context);
  if (candidates.length <= 0) {
    setBombDynamicLandingDebugState(context, "anchor_candidates_unavailable");
    return [];
  }

  setBombSpawnValidationDebugState(
    getBombDynamicLandingDebugContext(context),
    strategy === "live_start_center"
      ? "anchor_candidates_live_start_center"
      : "anchor_candidates_player_biased_fallback",
    candidates[0].anchorCapturePointId
  );
  return candidates;
}

function scheduleDynamicBaseBombRespawnRetry(
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased"
): void {
  if (gameStatus !== 3) {
    cipherSecondHalfTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    return;
  }
  setBombDynamicRetryDebugState(context);
  scheduleDeferredBombRespawnAfterDelay(
    BOMB_DYNAMIC_RETRY_DELAY_SECONDS,
    context + "_dynamic_retry",
    announcementMode,
    showHighlightMessage,
    spawnStrategy
  );
}

async function respawnBombAtDynamicLocationNow(
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased"
): Promise<boolean> {
  if (gameStatus !== 3) return false;

  clearBombCarrierState();
  invalidateBombReturnToBaseTimer();
  clearDroppedBombRuntimeObjects();
  bombDroppedSourceKind = "none";
  clearBombBaseBeepLoop();
  clearBombCarrierBeepLoop();
  clearBombDroppedBeepLoop();
  clearBombBaseRuntimeWorldIcon();
  clearBombBaseRuntimeLootSpawner();
  bombActiveBaseSlotIndex = BOMB_DEFAULT_BASE_SLOT_INDEX;
  bombBaseLandingAnchorPosition = undefined;
  bombBaseCachedPosition = undefined;
  bombStaticLootSpawnerInitialPosition = undefined;
  setBombPickupTriggerEnabled(false);
  setAllBaseWorldIconsEnabled(false);
  tryUnspawnAllLootForBombFlow(context + "_dynamic_respawn");

  const anchorCandidates = resolveDynamicBombBaseAnchorCandidates(context, spawnStrategy);
  if (anchorCandidates.length <= 0) {
    warnBombBaseReturnRespawnFailureOnce(context + ": dynamic anchor resolve failed");
    return false;
  }

  let lastFailureReason = "no_anchor_candidates";

  for (let i = 0; i < anchorCandidates.length; i++) {
    const candidate = anchorCandidates[i];
    const runtimeBaseSpawn = spawnLootAtRuntimeSpawner(
      candidate.anchorPos,
      context + "_anchor_" + String(candidate.anchorCapturePointId)
    );
    if (!runtimeBaseSpawn.object || !runtimeBaseSpawn.spawner) {
      lastFailureReason =
        "spawn_validation_failed(anchor=" +
        String(candidate.anchorCapturePointId) +
        ", reason=" +
        runtimeBaseSpawn.reason +
        ", objId=" +
        String(runtimeBaseSpawn.objId) +
        ")";
      continue;
    }

    bombActiveBaseSlotIndex = candidate.slotIndex;
    bombBaseRuntimeLootSpawnerObject = runtimeBaseSpawn.object;
    bombBaseRuntimeLootSpawnerHandle = runtimeBaseSpawn.spawner;
    bombBaseRuntimeLootSpawnerObjectId = runtimeBaseSpawn.objId >= 0 ? runtimeBaseSpawn.objId : undefined;
    bombBaseLandingAnchorPosition = candidate.anchorPos;
    bombBaseCachedPosition = candidate.anchorPos;
    bombStaticLootSpawnerInitialPosition = candidate.anchorPos;

    const movedPickupTrigger = moveBombPickupTriggerToPosition(candidate.anchorPos, true);
    if (!movedPickupTrigger) {
      clearBombBaseRuntimeLootSpawner();
      bombActiveBaseSlotIndex = BOMB_DEFAULT_BASE_SLOT_INDEX;
      bombBaseLandingAnchorPosition = undefined;
      bombBaseCachedPosition = undefined;
      bombStaticLootSpawnerInitialPosition = undefined;
      setBombPickupTriggerEnabled(false);
      lastFailureReason = "pickup_trigger_move_failed(anchor=" + String(candidate.anchorCapturePointId) + ")";
      continue;
    }

    setBombSpawnValidationDebugState(
      getBombDynamicLandingDebugContext(context),
      "anchor_selected",
      candidate.anchorCapturePointId
    );
    setBombBaseAvailabilityState(true);
    announceBombSpawnResolved(announcementMode, showHighlightMessage);
    EvaluateBaseBombPickupFromActiveBaseSlotRadius();
    return true;
  }

  warnBombBasePickupObjectSpawnFailureOnce(lastFailureReason);
  return false;
}

function createGadgetRestoreEquipment(gadget: mod.Gadgets): BombRestoreEquipment {
  return { kind: "gadget", gadget };
}

function captureBombSlotAmmoState(player: mod.Player, slot: mod.InventorySlots): BombRestoreAmmoState | undefined {
  const ammo = getInventoryAmmoSafe(player, slot);
  const magazineAmmo = getInventoryMagazineAmmoSafe(player, slot);
  if (ammo < 0 || magazineAmmo < 0) return undefined;
  return {
    sourceSlot: slot,
    ammo,
    magazineAmmo,
  };
}

function cacheBombCarrierRestoreAmmoForPlayer(
  playerId: number,
  player: mod.Player,
  replacedSlot: mod.InventorySlots
): BombRestoreAmmoState | undefined {
  if (replacedSlot !== BOMB_CARRIER_INVENTORY_SLOT) {
    delete bombCarrierRestoreAmmoByPlayerId[playerId];
    return undefined;
  }

  const snapshot = captureBombSlotAmmoState(player, BOMB_CARRIER_INVENTORY_SLOT);
  bombCarrierRestoreAmmoByPlayerId[playerId] = snapshot;
  return snapshot;
}

function resolveBombCarrierRestoreAmmoForRemoval(
  playerId: number,
  _player: mod.Player,
  replacedSlot: mod.InventorySlots | undefined
): BombRestoreAmmoState | undefined {
  if (replacedSlot !== BOMB_CARRIER_INVENTORY_SLOT) return undefined;
  const cached = bombCarrierRestoreAmmoByPlayerId[playerId];
  if (!cached) return undefined;
  if (cached.ammo < 0 || cached.magazineAmmo < 0) return undefined;
  return cached;
}

function gadgetEnumName(gadget: mod.Gadgets): string {
  const name = (mod.Gadgets as any)[gadget];
  return typeof name === "string" ? name : "";
}

function restoreEquipmentDebugName(equipment: BombRestoreEquipment | undefined): string {
  if (!equipment) return "-1";
  const name = gadgetEnumName(equipment.gadget);
  return name ? "gadget:" + name : "gadget:" + String(equipment.gadget);
}

function isSoldierClassSafe(player: mod.Player, soldierClass: mod.SoldierClass): boolean {
  try {
    return mod.IsSoldierClass(player, soldierClass) === true;
  } catch (_err) {
    return false;
  }
}

function resolveClassBasedGadgetOneRestoreEquipment(player: mod.Player): BombRestoreEquipment | undefined {
  if (isSoldierClassSafe(player, mod.SoldierClass.Assault)) {
    return createGadgetRestoreEquipment(mod.Gadgets.Launcher_Breaching_Projectile);
  }
  if (isSoldierClassSafe(player, mod.SoldierClass.Engineer)) {
    return createGadgetRestoreEquipment(mod.Gadgets.Launcher_Unguided_Rocket);
  }
  if (isSoldierClassSafe(player, mod.SoldierClass.Recon)) {
    return createGadgetRestoreEquipment(mod.Gadgets.Deployable_Recon_Drone);
  }
  if (isSoldierClassSafe(player, mod.SoldierClass.Support)) {
    return createGadgetRestoreEquipment(mod.Gadgets.Deployable_Grenade_Intercept_System);
  }

  return undefined;
}

function resolveClassBasedGadgetTwoOverride(player: mod.Player): mod.Gadgets | undefined {
  if (isSoldierClassSafe(player, mod.SoldierClass.Engineer)) return mod.Gadgets.Deployable_EOD_Bot;
  if (isSoldierClassSafe(player, mod.SoldierClass.Support)) return mod.Gadgets.Launcher_Smoke_Grenade;
  return undefined;
}

function hasBombCarrierDeployRestoreCacheForPlayer(playerId: number): boolean {
  return Object.prototype.hasOwnProperty.call(bombCarrierDeployRestoreEquipmentByPlayerId, playerId);
}

function invalidateBombCarrierRestoreInsertForPlayer(playerId: number): void {
  delete bombCarrierRestoreInsertTokenByPlayerId[playerId];
}

function beginBombDeployLoadoutApplyForPlayer(playerId: number): number {
  bombDeployLoadoutApplyTokenCounter += 1;
  bombDeployLoadoutApplyTokenByPlayerId[playerId] = bombDeployLoadoutApplyTokenCounter;
  return bombDeployLoadoutApplyTokenCounter;
}

function invalidateBombDeployLoadoutApplyForPlayer(playerId: number): void {
  delete bombDeployLoadoutApplyTokenByPlayerId[playerId];
}

function isBombDeployLoadoutApplyCurrent(playerId: number, token: number): boolean {
  return bombDeployLoadoutApplyTokenByPlayerId[playerId] === token;
}

function clearBombCarrierDeployRestoreCacheForPlayer(playerId: number): void {
  delete bombCarrierDeployRestoreEquipmentByPlayerId[playerId];
  invalidateBombDeployLoadoutApplyForPlayer(playerId);
  invalidateBombCarrierRestoreInsertForPlayer(playerId);
}

function isBombDeployLoadoutApplyPlayerEligible(
  playerId: number,
  player: mod.Player,
  token: number
): boolean {
  if (!isBombDeployLoadoutApplyCurrent(playerId, token)) return false;
  if (gameStatus !== 2 && gameStatus !== 3) return false;
  if (bombCarrierPlayerId === playerId) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp || !sp.isDeployed) return false;

  try {
    if (!mod.IsPlayerValid(player)) return false;
  } catch (_err) {
    return false;
  }

  const currentObjId = getObjIdSafe(sp.player);
  const deployObjId = getObjIdSafe(player);
  return currentObjId >= 0 && currentObjId === deployObjId;
}

async function cacheBombCarrierDeployRestoreEquipmentForPlayer(
  playerId: number,
  player: mod.Player
): Promise<void> {
  const token = beginBombDeployLoadoutApplyForPlayer(playerId);

  await mod.Wait(BOMB_DEPLOY_LOADOUT_APPLY_DELAY_SECONDS);
  if (!isBombDeployLoadoutApplyPlayerEligible(playerId, player, token)) return;

  const restoredEquipment = resolveClassBasedGadgetOneRestoreEquipment(player);
  bombCarrierDeployRestoreEquipmentByPlayerId[playerId] = restoredEquipment;
  const gadgetTwoOverride = resolveClassBasedGadgetTwoOverride(player);

  if (restoredEquipment === undefined && gadgetTwoOverride === undefined) return;

  if (gadgetTwoOverride !== undefined) {
    removeEquipmentSlotSafe(player, mod.InventorySlots.GadgetTwo);
    await mod.Wait(BOMB_DEPLOY_LOADOUT_SLOT_SETTLE_SECONDS);
    if (!isBombDeployLoadoutApplyPlayerEligible(playerId, player, token)) return;
    addEquipmentToSlotSafe(player, gadgetTwoOverride, mod.InventorySlots.GadgetTwo);
  }

  if (restoredEquipment !== undefined) {
    removeEquipmentSlotSafe(player, BOMB_CARRIER_INVENTORY_SLOT);
    await mod.Wait(BOMB_DEPLOY_LOADOUT_SLOT_SETTLE_SECONDS);
    if (!isBombDeployLoadoutApplyPlayerEligible(playerId, player, token)) return;
    addRestoreEquipmentToSlotSafe(player, restoredEquipment, BOMB_CARRIER_INVENTORY_SLOT);
  }
}

function getCachedGadgetOneRestoreForBombTransfer(playerId: number): BombRestoreEquipment | undefined {
  if (!hasBombCarrierDeployRestoreCacheForPlayer(playerId)) return undefined;
  return bombCarrierDeployRestoreEquipmentByPlayerId[playerId];
}

function beginBombCarrierRestoreInsertForPlayer(playerId: number): number {
  bombCarrierRestoreInsertTokenCounter += 1;
  bombCarrierRestoreInsertTokenByPlayerId[playerId] = bombCarrierRestoreInsertTokenCounter;
  return bombCarrierRestoreInsertTokenCounter;
}

function isBombCarrierRestoreInsertCurrent(playerId: number, token: number): boolean {
  return bombCarrierRestoreInsertTokenByPlayerId[playerId] === token;
}

function isBombCarrierRestoreInsertPlayerEligible(playerId: number, player: mod.Player): boolean {
  if (gameStatus !== 3) return false;
  if (bombCarrierPlayerId === playerId) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp || !sp.isDeployed) return false;

  try {
    if (!mod.IsPlayerValid(player)) return false;
  } catch (_err) {
    return false;
  }

  const currentObjId = getObjIdSafe(sp.player);
  const restoreObjId = getObjIdSafe(player);
  return currentObjId >= 0 && currentObjId === restoreObjId;
}

async function restoreBombCarrierReplacementEquipmentForPlayerAfterDelay(
  playerId: number,
  player: mod.Player,
  replacedSlot: mod.InventorySlots | undefined,
  previousEquipment: BombRestoreEquipment | undefined,
  restoreAmmoState: BombRestoreAmmoState | undefined,
  reason: string,
  token: number
): Promise<void> {
  await mod.Wait(BOMB_GADGET_ONE_RESTORE_INSERT_SETTLE_SECONDS);

  if (!isBombCarrierRestoreInsertCurrent(playerId, token)) return;
  if (!isBombCarrierRestoreInsertPlayerEligible(playerId, player)) {
    invalidateBombCarrierRestoreInsertForPlayer(playerId);
    return;
  }
  if (replacedSlot === undefined || previousEquipment === undefined) {
    invalidateBombCarrierRestoreInsertForPlayer(playerId);
    return;
  }

  addRestoreEquipmentToSlotSafe(player, previousEquipment, replacedSlot);

  if (replacedSlot === BOMB_CARRIER_INVENTORY_SLOT && restoreAmmoState !== undefined) {
    setInventoryAmmoSafe(player, BOMB_CARRIER_INVENTORY_SLOT, restoreAmmoState.ammo);
    setInventoryMagazineAmmoSafe(player, BOMB_CARRIER_INVENTORY_SLOT, restoreAmmoState.magazineAmmo);
  }

  logBombPickupDebug(
    mod.Message(
      "[BOMB DEBUG] restored equipment p/reason/equipment {}",
      String(playerId) + "/" + reason + "/" + restoreEquipmentDebugName(previousEquipment)
    )
  );

  invalidateBombCarrierRestoreInsertForPlayer(playerId);
}

function scheduleBombCarrierReplacementEquipmentRestoreForPlayer(
  playerId: number,
  player: mod.Player,
  replacedSlot: mod.InventorySlots | undefined,
  previousEquipment: BombRestoreEquipment | undefined,
  restoreAmmoState: BombRestoreAmmoState | undefined,
  reason: string
): boolean {
  if (replacedSlot === undefined) {
    logBombPickupDebug(
      mod.Message("[BOMB DEBUG] no equipment restore p/reason {}", String(playerId) + "/" + reason)
    );
    return false;
  }

  if (previousEquipment !== undefined) {
    const token = beginBombCarrierRestoreInsertForPlayer(playerId);
    void restoreBombCarrierReplacementEquipmentForPlayerAfterDelay(
      playerId,
      player,
      replacedSlot,
      previousEquipment,
      restoreAmmoState,
      reason,
      token
    );
    return true;
  }

  logBombPickupDebug(
    mod.Message("[BOMB DEBUG] no equipment restore p/reason {}", String(playerId) + "/" + reason)
  );
  return false;
}

function restoreBombCarrierInventoryForPlayer(
  playerId: number,
  player: mod.Player,
  replacedSlot: mod.InventorySlots | undefined,
  previousEquipment: BombRestoreEquipment | undefined,
  reason: string
): void {
  const restoreAmmoState = resolveBombCarrierRestoreAmmoForRemoval(playerId, player, replacedSlot);

  removeBombEquipmentSafe(player, replacedSlot);

  scheduleBombCarrierReplacementEquipmentRestoreForPlayer(
    playerId,
    player,
    replacedSlot,
    previousEquipment,
    restoreAmmoState,
    reason
  );
}

function invalidateBombReturnToBaseTimer(): void {
  bombReturnToBaseToken += 1;
  bombDroppedReturnDeadlineAtSec = 0;
  bombDroppedWorldIconLastShownSeconds = -1;
}

function invalidateDeferredBombSpawnTimer(): void {
  bombDeferredBaseSpawnToken += 1;
}

function getBombSpawnAnnouncementMessageState(
  mode: BombSpawnAnnouncementMode
): { key: any; fallbackText: string } {
  if (mode === "bomb_located") {
    return {
      key: (mod.stringkeys as any).BombHasBeenLocated,
      fallbackText: "BOMB LOCATION FOUND",
    };
  }

  return {
    key: (mod.stringkeys as any).NewBombLocationFound,
    fallbackText: "NEW BOMB LOCATION FOUND",
  };
}

function getBombDroppedNoticeMessageState(): { key: any; fallbackText: string } {
  return {
    key: (mod.stringkeys as any).BombHasBeenDropped,
    fallbackText: "BOMB HAS BEEN DROPPED",
  };
}

function announceBombLocationForAllTeams(message: any): void {
  modlib.ShowHighlightedGameModeMessage(message, team1);
  modlib.ShowHighlightedGameModeMessage(message, team2);
}

function playBombLocationVoForAllTeams(): void {
  ensureAudioSpawned();
  playVOToTeam(team1, mod.VoiceOverEvents2D.ObjectiveLocated, mod.VoiceOverFlags.Alpha);
  playVOToTeam(team2, mod.VoiceOverEvents2D.ObjectiveLocated, mod.VoiceOverFlags.Alpha);
}

function announceBombSpawnResolved(
  mode: "new_location_found" | "bomb_located",
  showHighlightMessage: boolean = true
): void {
  const copy = getBombSpawnAnnouncementMessageState(mode);
  const message = getStringMessageWithFallback(copy.key, copy.fallbackText);
  if (showHighlightMessage) {
    announceBombLocationForAllTeams(message);
  }
  showBombNoticeForAllPlayers(copy.key, copy.fallbackText);
  playBombLocationVoForAllTeams();
  if (mode === "bomb_located") {
    playBombSpawnStingerToAll(BOMB_SPAWN_STINGER_VOLUME);
  }
}

function scheduleDeferredBombRespawnAfterDelay(
  delaySeconds: number,
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean = true,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased"
): void {
  const myToken = bombDeferredBaseSpawnToken + 1;
  bombDeferredBaseSpawnToken = myToken;
  void runDeferredBombRespawnAfterDelay(
    myToken,
    delaySeconds,
    context,
    announcementMode,
    showHighlightMessage,
    spawnStrategy
  );
}

async function runDeferredBombRespawnAfterDelay(
  token: number,
  delaySeconds: number,
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy
): Promise<void> {
  if (delaySeconds > 0) {
    await mod.Wait(delaySeconds);
  }

  if (bombDeferredBaseSpawnToken !== token) return;
  if (gameStatus !== 3) {
    cipherSuddenDeathTransitionActive = false;
    return;
  }

  // Fail-closed: if bomb authority is already active or a dynamic spawn is settling, do not force another spawn.
  if (bombCarrierPlayerId !== undefined) return;
  if (hasDroppedBombRuntimeObjects()) return;
  if (hasBaseBombAuthorityOrPending()) return;

  const spawned = await respawnBombAtDynamicLocationNow(context, announcementMode, showHighlightMessage, spawnStrategy);
  if (!spawned) {
    scheduleDynamicBaseBombRespawnRetry(context, announcementMode, showHighlightMessage, spawnStrategy);
  }
}

function clearBombCarrierState(): void {
  clearBombCarrierBeepLoop();
  clearBombCarrierRuntimeWorldIcons();
  clearBombBeepModeState();
  bombCarrierPlayerId = undefined;
  bombCarrierUiStateVersion++;
  bombCarrierReplacedSlotByPlayerId = {};
  bombCarrierPreviousEquipmentByPlayerId = {};
  bombCarrierRestoreAmmoByPlayerId = {};
  resetBombCarrierVerticalTrackingState();
  UpdateBombCarrierUiForAllPlayers(undefined, true);

  if (gameStatus === 3 && initialization[3] === true) {
    syncLiveHybridObjectiveSurfaceState("clearBombCarrierState");
  }
}

function clearObjectiveSuccessfulArmContext(cpId: number): void {
  objectiveLastSuccessfulArmPositionByCpId[cpId] = undefined;
  objectiveLastSuccessfulArmerPlayerIdByCpId[cpId] = undefined;
}

function resetObjectiveSuccessfulArmContextState(): void {
  objectiveLastSuccessfulArmPositionByCpId = {};
  objectiveLastSuccessfulArmerPlayerIdByCpId = {};

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    objectiveLastSuccessfulArmPositionByCpId[cpId] = undefined;
    objectiveLastSuccessfulArmerPlayerIdByCpId[cpId] = undefined;
  }
}

function clearObjectiveDestroyExplosionPosition(cpId: number): void {
  objectiveDestroyExplosionPositionByCpId[cpId] = undefined;
}

function resetObjectiveDestroyExplosionPositionState(): void {
  objectiveDestroyExplosionPositionByCpId = {};

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    objectiveDestroyExplosionPositionByCpId[cpId] = undefined;
  }
}

function recordObjectiveSuccessfulArmContext(cpId: number, playerId: number): void {
  const sp = serverPlayers.get(playerId);
  let armPos: mod.Vector | undefined = undefined;

  if (sp && mod.IsPlayerValid(sp.player)) {
    armPos = tryGetPlayerPositionSafe(sp.player);
  }
  if (!armPos) {
    armPos = getBombDropFallbackPosition(playerId);
  }

  if (!armPos) return;

  objectiveLastSuccessfulArmPositionByCpId[cpId] = armPos;
  objectiveLastSuccessfulArmerPlayerIdByCpId[cpId] = playerId;
}

function tryResolveObjectiveDestroyExplosionPosition(cpId: number): mod.Vector | undefined {
  const storedPos = objectiveDestroyExplosionPositionByCpId[cpId];
  if (storedPos) return storedPos;

  const mcomPos = tryGetObjectiveMcomPosition(cpId);
  if (mcomPos) return mcomPos;

  const awardAnchorPos = tryGetObjectiveAwardAnchorPosition(cpId);
  if (awardAnchorPos) return awardAnchorPos;

  return getObjectiveCapturePointPosition(cpId);
}

function captureObjectiveDestroyExplosionPositionForCp(cpId: number): void {
  objectiveDestroyExplosionPositionByCpId[cpId] = tryResolveObjectiveDestroyExplosionPosition(cpId);
}

function applyExplosionDamageAtPosition(pos: mod.Vector, radiusMeters: number, damage: number): void {
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return;
  if (!Number.isFinite(damage) || damage <= 0) return;

  serverPlayers.forEach((sp) => {
    if (!sp || !sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;
    if (!isPlayerAlive(sp.player)) return;

    const playerPos = tryGetPlayerPositionSafe(sp.player);
    if (!playerPos) return;
    if (mod.DistanceBetween(pos, playerPos) > radiusMeters) return;

    mod.DealDamage(sp.player, damage);
  });
}

function playDroppedBombReturnExplosionAtPosition(pos: mod.Vector): void {
  const iconSpawn = spawnRuntimeCommonObjectSafe(
    mod.RuntimeSpawn_Common.WorldIcon,
    mod.Add(pos, mod.CreateVector(0, 1.5, 0)),
    BOMB_DROP_ROTATION,
    "dropped_cipher_key_signal_lost_icon"
  );
  if (iconSpawn.object) {
    const icon = resolveRuntimeWorldIconHandle(iconSpawn.object as unknown);
    if (icon) {
      try {
        mod.SetWorldIconText(
          icon,
          getStringMessageWithFallback((mod.stringkeys as any).CipherKeySignalLost, "KEY SIGNAL LOST")
        );
        mod.SetWorldIconColor(icon, COLOR_NEUTRAL);
        mod.EnableWorldIconImage(icon, false);
        mod.EnableWorldIconText(icon, true);
      } catch (_errIcon) {}
    }
    void cleanupRuntimeFxAfterDelay(iconSpawn.object as unknown as mod.VFX | mod.Object, 1.5);
  }

  playRuntimeOneShotSfxAtPosition(
    BOMB_SPAWN_STINGER_ASSET,
    pos,
    BOMB_SPAWN_STINGER_VOLUME,
    BOMB_SOUND_ATTENUATION_RANGE,
    BOMB_DROP_ONE_SHOT_CLEANUP_SECONDS,
    "dropped_cipher_key_signal_lost"
  );
}

function scheduleBombReturnToBaseAfterDelay(): void {
  const myToken = bombReturnToBaseToken + 1;
  bombReturnToBaseToken = myToken;
  bombDroppedReturnDeadlineAtSec = getCurrentSchedulerNowSeconds() + BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS;
  bombDroppedWorldIconLastShownSeconds = -1;
  void returnBombToBaseAfterDelay(myToken);
}

async function returnBombToBaseAfterDelay(token: number): Promise<void> {
  await mod.Wait(BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS);

  if (bombReturnToBaseToken !== token) return;
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined) return;
  if (!hasDroppedBombRuntimeObjects()) return;

  const explosionPos = tryResolveDroppedBombAnchorPosition();
  tryUnspawnAllLootForBombFlow("player_drop_return_timeout");
  clearDroppedBombRuntimeObjects();
  bombDroppedSourceKind = "none";
  invalidateDeferredBombSpawnTimer();

  if (explosionPos) {
    playDroppedBombReturnExplosionAtPosition(explosionPos);
  }

  scheduleDeferredBombRespawnAfterDelay(
    BOMB_PLAYER_DROPPED_EXPLOSION_RESPAWN_DELAY_SECONDS,
    "player_drop_dynamic_relocation_signal_lost",
    "new_location_found",
    true
  );
}

function assignBombCarrierFromDelta(
  playerId: number,
  delta: BombPickupDelta,
  _fromDroppedBomb: boolean,
  resolver:
    | "strict"
    | "fallback"
    | "scan_fallback"
    | "area_watch"
    | "dropped_radius"
    | "base_radius_active_slot"
    | "objective_disarm"
): void {
  invalidateBombCarrierRestoreInsertForPlayer(playerId);
  bombCarrierPlayerId = playerId;
  bombCarrierPreviousEquipmentByPlayerId[playerId] = delta.replacedEquipment;
  bombCarrierReplacedSlotByPlayerId[playerId] = delta.replacedSlot;
  clearBombBaseBeepLoop();
  clearBombDroppedBeepLoop();
  clearBombCarrierBeepLoop();
  clearBombCarrierRuntimeWorldIcons();
  resetBombCarrierVerticalTrackingState();
  bombCarrierUiStateVersion++;

  const carrierNowSec = getCurrentSchedulerNowSeconds();
  const carrierState = serverPlayers.get(playerId);
  if (carrierState && mod.IsPlayerValid(carrierState.player)) {
    const carrierTeam = getCipherKeyTeamSnapshot(playerId) ?? carrierState.team;
    spawnBombCarrierRuntimeWorldIcons(carrierState.player, carrierNowSec, carrierTeam);
    syncCipherCarrierVisualsNow(carrierNowSec, "assign_pickup");
    applyBombCarrierHudStateForPlayer(
      carrierState,
      true,
      getBombCarrierPulseAlpha(carrierNowSec),
      mod.Floor(getBombCarrierPulseAlpha(carrierNowSec) * 100),
      true
    );
    if (mod.Equals(carrierTeam, team1) || mod.Equals(carrierTeam, team2)) {
      showCipherKeyPickupNoticeForTeam(carrierTeam);
    }
    const carrierPos = tryGetPlayerPositionSafe(carrierState.player);
    if (carrierPos) {
      bombCarrierTrackedY = mod.YComponentOf(carrierPos);
      bombCarrierStableYSinceSec = carrierNowSec;
      startBombCarrierBeepLoopAtPosition(carrierPos);
    }
  }
  UpdateBombCarrierUiForAllPlayers(carrierNowSec, true);

  logBombPickupDebug(
    mod.Message(
      "[BOMB DEBUG] carrier assign p/resolver/slot/equipment {}",
      String(playerId) +
        "/" +
        resolver +
        "/" +
        String(delta.replacedSlot) +
        "/" +
        restoreEquipmentDebugName(delta.replacedEquipment)
    )
  );

  setBombBaseAvailabilityState(false);

  invalidateBombReturnToBaseTimer();
  bombDroppedSourceKind = "none";

  if (gameStatus === 3 && initialization[3] === true) {
    syncLiveHybridObjectiveSurfaceState("assignBombCarrierFromDelta");
  }
}

function transferBombToPlayerAsCarrier(
  sp: Player,
  fromDroppedBomb: boolean,
  resolver:
    | "area_watch"
    | "dropped_radius"
    | "base_radius_active_slot"
    | "objective_disarm"
): boolean {
  if (!sp) return false;
  if (!sp.isDeployed) return false;
  if (!mod.IsPlayerValid(sp.player)) return false;
  if (!isPlayerAlive(sp.player)) return false;

  const playerTeam = getCipherKeyTeamSnapshot(sp.id) ?? sp.team;
  if (!mod.Equals(playerTeam, team1) && !mod.Equals(playerTeam, team2)) return false;

  const restoredEquipment = getCachedGadgetOneRestoreForBombTransfer(sp.id);
  cacheBombCarrierRestoreAmmoForPlayer(sp.id, sp.player, BOMB_CARRIER_INVENTORY_SLOT);
  addEquipmentToSlotSafe(sp.player, BOMB_LOOT_GADGET, BOMB_CARRIER_INVENTORY_SLOT);

  assignBombCarrierFromDelta(
    sp.id,
    {
      replacedSlot: BOMB_CARRIER_INVENTORY_SLOT,
      replacedEquipment: restoredEquipment,
    },
    fromDroppedBomb,
    resolver
  );

  tryDeliverCipherKeyFromActiveObjectiveAreaForCarrier(sp.id);
  return true;
}

function transferBombToPlayerAsCarrierAfterDisarm(playerId: number): boolean {
  const sp = serverPlayers.get(playerId);
  if (!sp) return false;
  if (!sp.isDeployed) return false;
  if (!mod.IsPlayerValid(sp.player)) return false;
  if (!isPlayerAlive(sp.player)) return false;

  const playerTeam = getCipherKeyTeamSnapshot(playerId) ?? sp.team;
  if (!mod.Equals(playerTeam, team1) && !mod.Equals(playerTeam, team2)) return false;

  clearDroppedBombRuntimeObjects();
  clearBombBaseRuntimeLootSpawner();
  clearBombCarrierState();
  setBombPickupTriggerEnabled(false);
  setBombBaseAvailabilityState(false);
  invalidateBombReturnToBaseTimer();
  return transferBombToPlayerAsCarrier(sp, false, "objective_disarm");
}

function forceBombDropFromCarrier(playerId: number, reason: string, dropPositionOverride?: mod.Vector): void {
  if (bombCarrierPlayerId === undefined) return;
  if (bombCarrierPlayerId !== playerId) return;

  const sp = serverPlayers.get(playerId);
  const replacedSlot = bombCarrierReplacedSlotByPlayerId[playerId];
  const previousEquipment = bombCarrierPreviousEquipmentByPlayerId[playerId];
  const isManualSlotSwitch = reason === "manual_slot_switch";
  const shouldShowDropNotice =
    reason === "death" ||
    isManualSlotSwitch ||
    reason === "restricted_area" ||
    reason === "hq_area" ||
    reason === "combat_boundary_exit";
  let carrierTeamForNotice: mod.Team = teamNeutral;
  if (sp) {
    const carrierTeam = getCipherKeyTeamSnapshot(playerId) ?? sp.team;
    if (mod.Equals(carrierTeam, team1) || mod.Equals(carrierTeam, team2)) {
      carrierTeamForNotice = carrierTeam;
    }
  }

  logBombPickupDebug(
    mod.Message(
      "[BOMB DEBUG] force drop p/reason/slot/equipment {}",
      String(playerId) +
        "/" +
        reason +
        "/" +
        String(replacedSlot ?? -1) +
        "/" +
        restoreEquipmentDebugName(previousEquipment)
    )
  );

  const dropPos = dropPositionOverride ?? getBombDropFallbackPosition(playerId);
  if (sp) {
    applyBombCarrierHudStateForPlayer(
      sp,
      false,
      1,
      100,
      true
    );
  }
  clearBombCarrierState();
  if (shouldShowDropNotice) {
    showCipherKeyDroppedNoticeForTeam(carrierTeamForNotice);
  }

  if (sp && mod.IsPlayerValid(sp.player)) {
    restoreBombCarrierInventoryForPlayer(playerId, sp.player, replacedSlot, previousEquipment, reason);
  }

  if (dropPos && shouldShowDropNotice) {
    playBombDropOneShotAtPosition(dropPos);
  }
  cancelObjectiveCaptureAttemptsForPlayer(playerId);
  setBombBaseAvailabilityState(false);
  clearBombBaseRuntimeLootSpawner();
  invalidateBombReturnToBaseTimer();

  if (!dropPos || !spawnDroppedBombAtPosition(dropPos)) {
    clearDroppedBombRuntimeObjects();
    bombDroppedSourceKind = "none";
    invalidateDeferredBombSpawnTimer();
    scheduleDeferredBombRespawnAfterDelay(0, "carrier_drop_fallback_dynamic", "new_location_found", true);
    return;
  }

  bombDroppedSourceKind = "carrier_drop";
  bombDroppedPickupAnchorPosition = dropPos;
  bombDroppedLastCarrierPlayerId = playerId;
  bombDroppedLastCarrierBlockedUntilSec =
    getCurrentSchedulerNowSeconds() + BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS;
  setBombPickupTriggerEnabled(false);

  EvaluateDroppedBombReclaimFromAnchor();
  if (!hasDroppedBombRuntimeObjects() || bombCarrierPlayerId !== undefined) {
    return;
  }

  scheduleBombReturnToBaseAfterDelay();
}

function resetBombCarrierRuntimeState(hideBaseIcon: boolean, preserveDeployRestoreCache = false): void {
  invalidateBombReturnToBaseTimer();
  invalidateDeferredBombSpawnTimer();
  if (bombCarrierPlayerId !== undefined) {
    const carrierId = bombCarrierPlayerId;
    const carrier = serverPlayers.get(carrierId);
    if (carrier && mod.IsPlayerValid(carrier.player)) {
      restoreBombCarrierInventoryForPlayer(
        carrierId,
        carrier.player,
        bombCarrierReplacedSlotByPlayerId[carrierId],
        bombCarrierPreviousEquipmentByPlayerId[carrierId],
        "cipher_authority_reset"
      );
    }
  }
  clearBombCarrierState();
  clearBombNoticeState();
  bombSpawnValidationDebugByContext = {};
  bombAnchorSectorMissingWarned = false;
  bombAnchorCapturePointMissingWarnedById = {};
  bombBaseWorldIconMissingWarnedById = {};
  bombStaticLootSpawnerMissingWarnedById = {};
  bombBaseSlotPositionMissingWarnedById = {};
  bombBaseFirstPickupAnchorUnavailableWarnedById = {};
  bombBaseBeepLoopMissingWarned = false;
  bombDroppedBeepLoopMissingWarned = false;
  bombCarrierBeepLoopMissingWarned = false;
  bombCarrierIconMissingWarned = false;
  bombCarrierIconOwnerWarned = false;
  if (!preserveDeployRestoreCache) {
    bombCarrierDeployRestoreEquipmentByPlayerId = {};
    bombDeployLoadoutApplyTokenByPlayerId = {};
    bombDeployLoadoutApplyTokenCounter += 1;
  }
  bombCarrierRestoreInsertTokenByPlayerId = {};
  bombCarrierRestoreInsertTokenCounter += 1;
  bombActiveBaseSlotIndex = BOMB_DEFAULT_BASE_SLOT_INDEX;
  clearBombQuadBikeRuntimeSpawner();
  bombQuadBikeLiveSpawnAttempted = false;
  bombQuadBikeAnchorMissingWarned = false;
  clearBombBaseRuntimeLootSpawner();
  clearBombBaseRuntimeWorldIcon();
  clearBombBaseBeepLoop();
  clearBombDroppedBeepLoop();
  clearBombCarrierBeepLoop();
  clearBombCarrierRuntimeWorldIcons();
  bombCarrierLastSourcePos = undefined;
  bombCarrierFriendlyLastPos = undefined;
  bombCarrierEnemyLastPos = undefined;
  clearBombDropOneShotRuntimeSource();
  clearBombBeepModeState();
  clearBombBeepPulseNow();
  schedulerNextLiveIconFollowAtSec = 0;
  bombBaseCachedPosition = undefined;
  bombBaseLandingAnchorPosition = undefined;
  bombStaticLootSpawnerInitialPosition = undefined;
  bombDroppedSourceKind = "none";
  clearDroppedBombRuntimeObjects();
  lastKnownLivePositionByPlayerId = {};
  setBombPickupTriggerEnabled(false);
  cacheBombPickupWorldAnchorPositions();
  setAllBaseWorldIconsEnabled(false);

  if (hideBaseIcon) {
    setBombBaseAvailabilityState(false);
  }
}

function trySpawnLiveQuadBikeFromConfiguredCapturePoint(): void {
  if (bombQuadBikeLiveSpawnAttempted) return;
  if (BOMB_QUAD_BIKE_SPAWN_CAPTURE_POINT_ID <= 0) return;

  const spawnTransform = tryResolveQuadBikeSpawnCapturePointTransform();
  if (!spawnTransform || !spawnTransform.position) return;

  bombQuadBikeLiveSpawnAttempted = true;

  const spawnResult = spawnRuntimeCommonObjectSafe(
    BOMB_QUAD_BIKE_RUNTIME_SPAWNER_ASSET,
    spawnTransform.position,
    spawnTransform.rotation ?? BOMB_QUAD_BIKE_ROTATION_FALLBACK,
    "quad_bike_vehicle_spawner"
  );
  if (!spawnResult.object) return;

  bombQuadBikeRuntimeSpawnerObject = spawnResult.object;

  const vehicleSpawner = resolveRuntimeVehicleSpawnerHandle(spawnResult.object);
  if (!vehicleSpawner) {
    clearBombQuadBikeRuntimeSpawner();
    return;
  }

  bombQuadBikeRuntimeSpawnerHandle = vehicleSpawner;

  try {
    mod.SetVehicleSpawnerVehicleType(vehicleSpawner, BOMB_QUAD_BIKE_VEHICLE_TYPE);
    mod.SetVehicleSpawnerAutoSpawn(vehicleSpawner, false);
    mod.ForceVehicleSpawnerSpawn(vehicleSpawner);
  } catch (_err) {
    clearBombQuadBikeRuntimeSpawner();
  }
}

function EvaluateBombPickupAndCarrierState(): void {
  if (gameStatus !== 3) return;

  serverPlayers.forEach((sp) => {
    if (!sp || !sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;
    if (!isPlayerAlive(sp.player)) return;
    if (isBotBackfillPlayer(sp.player)) return;

    const team = getCipherKeyTeamSnapshot(sp.id) ?? sp.team;
    if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

    const pos = tryGetPlayerPositionSafe(sp.player);
    if (!pos) return;
    lastKnownLivePositionByPlayerId[sp.id] = pos;
  });

  if (bombCarrierPlayerId !== undefined) {
    const carrierId = bombCarrierPlayerId;
    const carrier = serverPlayers.get(carrierId);

    if (
      !carrier ||
      !carrier.isDeployed ||
      !mod.IsPlayerValid(carrier.player) ||
      !isPlayerAlive(carrier.player)
    ) {
      forceBombDropFromCarrier(carrierId, "carrier_lost");
      return;
    }

    const carrierTeam = getCipherKeyTeamSnapshot(carrierId) ?? carrier.team;
    if (!mod.Equals(carrierTeam, team1) && !mod.Equals(carrierTeam, team2)) {
      forceBombDropFromCarrier(carrierId, "carrier_team_invalid");
      return;
    }

    const carrierSlot = bombCarrierReplacedSlotByPlayerId[carrierId] ?? BOMB_CARRIER_INVENTORY_SLOT;
    if (
      isInventorySlotActiveSafe(carrier.player, carrierSlot) &&
      !hasEquipmentSafe(carrier.player, BOMB_LOOT_GADGET)
    ) {
      forceBombDropFromCarrier(carrierId, "carrier_gadget_missing");
      return;
    }

    return;
  }
  // No carrier: pickup authority is radius-based (base from active base slot, dropped from dropped anchor).
}

function EvaluateBaseBombPickupFromActiveBaseSlotRadius(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined) return;
  if (hasDroppedBombRuntimeObjects()) return;
  if (!bombPickupTriggerEnabled) return;

  const baseAnchor = tryGetActiveBasePickupAnchor();
  if (!baseAnchor) {
    setBombPickupTriggerEnabled(false);
    setBombBaseAvailabilityState(false);
    return;
  }

  const winner = findBombPickupCandidateWithinRadiusDeterministic(
    baseAnchor,
    BOMB_BASE_FIRST_PICKUP_RADIUS_METERS
  );
  if (!winner) return;

  tryUnspawnAllLootForBombFlow("base_radius_active_slot_pickup");
  clearBombBaseRuntimeLootSpawner();
  invalidateBombReturnToBaseTimer();
  transferBombToPlayerAsCarrier(winner, false, "base_radius_active_slot");

  setBombPickupTriggerEnabled(false);
  setBombBaseAvailabilityState(false);
}

function EvaluateDroppedBombReclaimFromAnchor(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined) return;
  if (!hasDroppedBombRuntimeObjects()) return;
  const anchorPos = tryResolveDroppedBombAnchorPosition();
  if (!anchorPos) return;

  const winner = findDroppedBombReclaimCandidateWithinRadius(anchorPos);
  if (!winner) return;

  tryUnspawnAllLootForBombFlow("dropped_radius_pickup");
  clearDroppedBombRuntimeObjects();
  invalidateBombReturnToBaseTimer();
  transferBombToPlayerAsCarrier(winner, true, "dropped_radius");

  setBombPickupTriggerEnabled(false);
  setBombBaseAvailabilityState(false);
}

function EvaluateResponsiveBombPickupRadiusScans(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined) return;

  if (hasDroppedBombRuntimeObjects()) {
    EvaluateDroppedBombReclaimFromAnchor();
    return;
  }

  if (bombPickupTriggerEnabled) {
    EvaluateBaseBombPickupFromActiveBaseSlotRadius();
  }
}

function EvaluateBombCarrierManualSlotSwitchAndLock(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId === undefined) return;

  const carrierId = bombCarrierPlayerId;
  const carrier = serverPlayers.get(carrierId);
  if (!carrier) return;
  if (!carrier.isDeployed) return;
  if (!mod.IsPlayerValid(carrier.player)) return;
  if (!isPlayerAlive(carrier.player)) return;

  const replacedSlot = bombCarrierReplacedSlotByPlayerId[carrierId];
  if (replacedSlot === undefined) return;

  const nowSec = getCurrentSchedulerNowSeconds();
  const carrierPos = updateBombCarrierVerticalTrackingState(carrier.player, nowSec);
  const slotIsActive = isInventorySlotActiveSafe(carrier.player, replacedSlot);

  if (!bombCarrierManualDropArmed) {
    if (!slotIsActive) {
      bombCarrierManualDropArmed = true;
      bombCarrierPendingManualDrop = false;
    }
    return;
  }

  if (!slotIsActive) {
    bombCarrierPendingManualDrop = false;
    return;
  }

  if (!hasEquipmentSafe(carrier.player, BOMB_LOOT_GADGET)) {
    forceBombDropFromCarrier(carrierId, "carrier_gadget_missing", carrierPos);
    return;
  }

  forceBombDropFromCarrier(carrierId, "manual_slot_switch", carrierPos);
}

async function runLiveStartBombSpawnAfterDelay(
  token: number,
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy
): Promise<void> {
  if (BOMB_LIVE_START_INITIAL_SPAWN_DELAY_SECONDS > 0) {
    await mod.Wait(BOMB_LIVE_START_INITIAL_SPAWN_DELAY_SECONDS);
  }
  emitLiveTransitionCheckpoint("bomb_live_start_delay_elapsed");

  if (bombDeferredBaseSpawnToken !== token) return;
  if (gameStatus !== 3) return;

  emitLiveTransitionCheckpoint("bomb_live_start_respawn_before");
  const spawned = await respawnBombAtDynamicLocationNow(
    context,
    announcementMode,
    showHighlightMessage,
    spawnStrategy
  );
  emitLiveTransitionCheckpoint(spawned ? "bomb_live_start_respawn_ok" : "bomb_live_start_respawn_failed");
  if (!spawned) {
    scheduleDynamicBaseBombRespawnRetry(
      context,
      announcementMode,
      showHighlightMessage,
      spawnStrategy
    );
  }
}

function spawnBombPickupObjectAtLiveStart(): boolean {
  emitLiveTransitionCheckpoint("bomb_live_start_schedule_enter");
  const myToken = bombDeferredBaseSpawnToken + 1;
  bombDeferredBaseSpawnToken = myToken;
  void runLiveStartBombSpawnAfterDelay(
    myToken,
    "live_start_delayed",
    "bomb_located",
    false,
    "live_start_center"
  );
  emitLiveTransitionCheckpoint("bomb_live_start_schedule_exit");
  return true;
}

function getObjectiveMcomSfxConfig(cpId: number): ObjectiveMcomSfxConfig | undefined {
  return OBJECTIVE_MCOM_SFX_BY_CP_ID[cpId];
}

function getObjectiveMcomSfxKey(cpId: number, role: ObjectiveMcomSfxRole): string {
  return String(cpId) + ":" + role;
}

function getObjectiveMcomSfxAsset(cpId: number, role: ObjectiveMcomSfxRole): mod.RuntimeSpawn_Common | undefined {
  const cfg = getObjectiveMcomSfxConfig(cpId);
  if (!cfg) return undefined;
  return cfg[role];
}

function tryGetObjectiveMcomPosition(cpId: number): mod.Vector | undefined {
  const mcomId = OBJECTIVE_MCOM_ID_BY_CP_ID[cpId];
  if (!mcomId) return undefined;
  try {
    const objectiveMcom = mod.GetMCOM(mcomId);
    return mod.GetObjectPosition(objectiveMcom);
  } catch (_err) {
    return undefined;
  }
}

function tryGetObjectiveMcomSfxAnchorPosition(cpId: number): mod.Vector | undefined {
  const cfg = getObjectiveMcomSfxConfig(cpId);
  const anchorId = cfg?.anchorObjectId;
  if (!anchorId) return undefined;

  try {
    const spatialAnchor = mod.GetSpatialObject(anchorId);
    return mod.GetObjectPosition(spatialAnchor);
  } catch (_err) {}

  try {
    const vfxAnchor = mod.GetVFX(anchorId);
    return mod.GetObjectPosition(vfxAnchor);
  } catch (_err) {}

  return undefined;
}

function tryGetObjectiveMcomSfxPositionForCp(cpId: number): mod.Vector | undefined {
  // Primary: explicit CP -> MCOM mapping (most reliable for this objective flow).
  const mcomPos = tryGetObjectiveMcomPosition(cpId);
  if (mcomPos) return mcomPos;

  // Fallback: configured CP anchor object.
  const anchorPos = tryGetObjectiveMcomSfxAnchorPosition(cpId);
  if (anchorPos) return anchorPos;

  // Final fallback: capture point world position.
  const cp = serverCapturePoints[cpId];
  if (!cp) return undefined;
  try {
    return mod.GetObjectPosition(cp.capturePoint);
  } catch (_err) {}
  return undefined;
}

function warnObjectiveMcomSfxMissingOnce(cpId: number, role: ObjectiveMcomSfxRole, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  const key = getObjectiveMcomSfxKey(cpId, role);
  if (objectiveMcomSfxMissingWarnedByKey[key] === true) return;
  objectiveMcomSfxMissingWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[OBJECTIVE MCOM SFX] cp {} role {} unavailable ({})", cpId, role, reason)
  );
}

function ensureObjectiveMcomSfxHandleForCpRole(cpId: number, role: ObjectiveMcomSfxRole, spawnPos: mod.Vector): any | undefined {
  const key = getObjectiveMcomSfxKey(cpId, role);
  if (objectiveMcomSfxUnavailableByKey[key] === true) return undefined;

  const existing = objectiveMcomSfxHandleByKey[key];
  if (existing) return existing;

  const asset = getObjectiveMcomSfxAsset(cpId, role);
  if (!asset) {
    objectiveMcomSfxUnavailableByKey[key] = true;
    warnObjectiveMcomSfxMissingOnce(cpId, role, "missing asset config");
    return undefined;
  }

  try {
    const spawned = mod.SpawnObject(
      asset,
      spawnPos,
      OBJECTIVE_MCOM_SFX_SPAWN_ROTATION
    );

    if (mod.IsType(spawned, mod.Types.SFX) || mod.IsType(spawned, mod.Types.Object)) {
      objectiveMcomSfxHandleByKey[key] = spawned;
      return spawned;
    }

    objectiveMcomSfxUnavailableByKey[key] = true;
    warnObjectiveMcomSfxMissingOnce(cpId, role, "spawn returned unsupported type");
    return undefined;
  } catch (_err) {
    objectiveMcomSfxUnavailableByKey[key] = true;
    warnObjectiveMcomSfxMissingOnce(cpId, role, "SpawnObject failed");
    return undefined;
  }
}

function ensureObjectiveMcomSfxSpawned(): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const spawnPos = tryGetObjectiveMcomSfxPositionForCp(cpId);
    if (!spawnPos) {
      for (let j = 0; j < OBJECTIVE_MCOM_SFX_ROLES.length; j++) {
        const role = OBJECTIVE_MCOM_SFX_ROLES[j];
        warnObjectiveMcomSfxMissingOnce(cpId, role, "missing MCOM/anchor/capturepoint position");
      }
      continue;
    }

    for (let j = 0; j < OBJECTIVE_MCOM_SFX_ROLES.length; j++) {
      const role = OBJECTIVE_MCOM_SFX_ROLES[j];
      ensureObjectiveMcomSfxHandleForCpRole(cpId, role, spawnPos);
    }
  }
}

function playObjectiveMcomSfxForCpRole(
  cpId: number,
  role: ObjectiveMcomSfxRole,
  receiver?: mod.Player
): boolean {
  const key = getObjectiveMcomSfxKey(cpId, role);
  if (objectiveMcomSfxUnavailableByKey[key] === true) return false;

  const pos = tryGetObjectiveMcomSfxPositionForCp(cpId);
  if (!pos) {
    warnObjectiveMcomSfxMissingOnce(cpId, role, "missing MCOM/anchor/capturepoint position");
    objectiveMcomSfxEnabledByKey[key] = false;
    return false;
  }

  const handle = ensureObjectiveMcomSfxHandleForCpRole(cpId, role, pos);
  if (!handle) return false;

  let played = false;
  const attenuationRange =
    role === "alarmSimple" || role === "alarmLeadout"
      ? OBJECTIVE_MCOM_SFX_ATTENUATION_RANGE
      : OBJECTIVE_ATTEMPT_PLAYER_SFX_ATTENUATION_RANGE;

  try {
    mod.PlaySound(handle, OBJECTIVE_MCOM_SFX_VOLUME, pos, attenuationRange);
    played = true;
  } catch (_err3dWorld) {
    try {
      mod.PlaySound(handle, OBJECTIVE_MCOM_SFX_VOLUME);
      played = true;
    } catch (_errFallbackWorld) {}
  }

  if (receiver && mod.IsPlayerValid(receiver)) {
    try {
      mod.PlaySound(
        handle,
        OBJECTIVE_MCOM_SFX_VOLUME,
        pos,
        attenuationRange,
        receiver
      );
      played = true;
    } catch (_err3dReceiver) {
      try {
        mod.PlaySound(handle, OBJECTIVE_MCOM_SFX_VOLUME, receiver);
        played = true;
      } catch (_errFallbackReceiver) {}
    }
  }

  if (played) return true;

  try {
    mod.PlaySound(handle, OBJECTIVE_MCOM_SFX_VOLUME);
    return true;
  } catch (_errFallback) {
    objectiveMcomSfxEnabledByKey[key] = false;
    warnObjectiveMcomSfxMissingOnce(cpId, role, "PlaySound failed (3D + fallback)");
    return false;
  }
}

function stopObjectiveMcomSfxForCpRole(cpId: number, role: ObjectiveMcomSfxRole): void {
  const key = getObjectiveMcomSfxKey(cpId, role);
  if (objectiveMcomSfxUnavailableByKey[key] === true) return;

  const handle = objectiveMcomSfxHandleByKey[key];
  if (!handle) {
    objectiveMcomSfxEnabledByKey[key] = false;
    return;
  }

  try {
    mod.StopSound(handle);
  } catch (_err) {
    objectiveMcomSfxUnavailableByKey[key] = true;
    warnObjectiveMcomSfxMissingOnce(cpId, role, "StopSound failed");
  }

  objectiveMcomSfxEnabledByKey[key] = false;
}

function setObjectiveMcomSfxEnabledForCp(
  cpId: number,
  role: ObjectiveMcomSfxRole,
  enabled: boolean,
  receiver?: mod.Player
): void {
  const key = getObjectiveMcomSfxKey(cpId, role);
  const current = objectiveMcomSfxEnabledByKey[key] === true;
  if (current === enabled) return;

  if (enabled) {
    if (playObjectiveMcomSfxForCpRole(cpId, role, receiver)) {
      objectiveMcomSfxEnabledByKey[key] = true;
    }
    return;
  }

  stopObjectiveMcomSfxForCpRole(cpId, role);
}

async function pulseObjectiveMcomSfxForCp(
  cpId: number,
  role: "arm" | "defused",
  receiver?: mod.Player
): Promise<void> {
  playObjectiveMcomSfxForCpRole(cpId, role, receiver);
}

function stopObjectiveMcomAttemptLoopSfxForCp(cpId: number): void {
  setObjectiveMcomSfxEnabledForCp(cpId, "arming", false);
  setObjectiveMcomSfxEnabledForCp(cpId, "defusing", false);
}

function stopAllObjectiveMcomSfxForCp(cpId: number): void {
  for (let i = 0; i < OBJECTIVE_MCOM_SFX_ROLES.length; i++) {
    stopObjectiveMcomSfxForCpRole(cpId, OBJECTIVE_MCOM_SFX_ROLES[i]);
  }
}

function StopAllObjectiveMcomSfx(): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    stopAllObjectiveMcomSfxForCp(OBJECTIVE_DEFINITIONS[i].cpId);
  }
  stopObjectiveAttemptLocalArmingSfxForAllPlayers();
  stopObjectiveAttemptLocalDefusingSfxForAllPlayers();
}

function resetObjectiveMcomSfxRuntimeState(): void {
  for (const key in objectiveMcomSfxHandleByKey) {
    const handle = objectiveMcomSfxHandleByKey[key];
    if (!handle) continue;
    try {
      mod.StopSound(handle);
    } catch (_err) {}
  }

  objectiveMcomSfxHandleByKey = {};
  objectiveMcomSfxUnavailableByKey = {};
  objectiveMcomSfxMissingWarnedByKey = {};
  objectiveMcomSfxEnabledByKey = {};
}

function getObjectiveAttemptCompleteAsset(kind: "arm" | "defused"): mod.RuntimeSpawn_Common {
  return kind === "defused" ? OBJECTIVE_ATTEMPT_DEFUSE_COMPLETE_ASSET : OBJECTIVE_ATTEMPT_ARM_COMPLETE_ASSET;
}

function playObjectiveAttemptCompletionSfxForPlayer(
  playerId: number | undefined,
  kind: "arm" | "defused",
  fallbackPos?: mod.Vector
): void {
  let pos = fallbackPos;
  if (playerId !== undefined) {
    const sp = serverPlayers.get(playerId);
    if (sp && mod.IsPlayerValid(sp.player)) {
      pos = tryGetPlayerPositionSafe(sp.player) ?? pos;
    }
  }

  if (!pos) return;

  playRuntimeOneShotSfxAtPosition(
    getObjectiveAttemptCompleteAsset(kind),
    pos,
    OBJECTIVE_ATTEMPT_PLAYER_SFX_VOLUME,
    OBJECTIVE_ATTEMPT_PLAYER_SFX_ATTENUATION_RANGE,
    OBJECTIVE_ATTEMPT_PLAYER_SFX_CLEANUP_SECONDS,
    "objective_attempt_complete_" + kind + "_" + String(playerId ?? -1)
  );
}

function playObjectiveAttemptLocalSfx(receiver: mod.Player, kind: "arming" | "arm" | "defused" | "defusing"): void {
  if (!mod.IsPlayerValid(receiver)) return;

  let handle: any = null;
  if (kind === "arming") handle = SFX_ObjectiveArmingLocal;
  else if (kind === "arm") handle = SFX_ObjectiveArmLocal;
  else if (kind === "defused") handle = SFX_ObjectiveDefusedLocal;
  else handle = SFX_ObjectiveDefusingLocal;

  if (!handle) return;

  try {
    mod.PlaySound(handle, OBJECTIVE_MCOM_SFX_VOLUME, receiver);
  } catch (_errLocalTargeted) {
    try {
      mod.PlaySound(handle, OBJECTIVE_MCOM_SFX_VOLUME);
    } catch (_errLocalFallback) {}
  }
}

function stopObjectiveAttemptLocalArmingSfxForPlayer(receiver: mod.Player): void {
  if (!SFX_ObjectiveArmingLocal) return;
  if (!mod.IsPlayerValid(receiver)) return;
  try {
    mod.StopSound(SFX_ObjectiveArmingLocal, receiver);
  } catch (_errStop) {}
}

function stopObjectiveAttemptLocalDefusingSfxForPlayer(receiver: mod.Player): void {
  if (!SFX_ObjectiveDefusingLocal) return;
  if (!mod.IsPlayerValid(receiver)) return;
  try {
    mod.StopSound(SFX_ObjectiveDefusingLocal, receiver);
  } catch (_errStop) {}
}

function stopObjectiveAttemptLocalArmingSfxForAllPlayers(): void {
  if (!SFX_ObjectiveArmingLocal) return;
  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    try {
      mod.StopSound(SFX_ObjectiveArmingLocal, sp.player);
    } catch (_errStopAll) {}
  });
}

function stopObjectiveAttemptLocalDefusingSfxForAllPlayers(): void {
  if (!SFX_ObjectiveDefusingLocal) return;
  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    try {
      mod.StopSound(SFX_ObjectiveDefusingLocal, sp.player);
    } catch (_errStopAll) {}
  });
}

function disableObjectiveSafely(objective: any): void {
  try {
    mod.EnableGameModeObjective(objective, false);
  } catch (_err) {}
}

function disableSectorObjectiveByIdSafe(sectorId: number): void {
  try {
    disableObjectiveSafely(mod.GetSector(sectorId));
  } catch (_err) {}
}

function disableCapturePointObjectiveByIdSafe(cpId: number): void {
  try {
    disableObjectiveSafely(mod.GetCapturePoint(cpId));
  } catch (_err) {}
}

function getTeamCountOnPoint(cp: CapturePoint, team: mod.Team): number {
  const on = cp.getOnPoint();
  if (mod.Equals(team, team1)) return on[0];
  if (mod.Equals(team, team2)) return on[1];
  return 0;
}

function getOppositeTeam(team: mod.Team): mod.Team {
  if (mod.Equals(team, team1)) return team2;
  if (mod.Equals(team, team2)) return team1;
  return teamNeutral;
}

function getObjectiveAuthoritativeOwner(cpId: number): mod.Team {
  const cp = serverCapturePoints[cpId];
  if (!cp) return teamNeutral;
  const owner = cp.getOwner();
  if (mod.Equals(owner, team1) || mod.Equals(owner, team2) || mod.Equals(owner, teamNeutral)) {
    return owner;
  }
  return teamNeutral;
}

function warnObjectiveEngineCallOnce(key: string, message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (objectiveEngineWarnedByKey[key] === true) return;
  objectiveEngineWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(message);
}

function safeEnableCapturePointObjectiveByCpId(
  cpId: number,
  enabled: boolean,
  context: string,
  force: boolean = false
): void {
  const cp = serverCapturePoints[cpId];
  if (!cp) return;
  if (!force && objectiveCapturePointObjectiveEnabledByCpId[cpId] === enabled) return;
  try {
    mod.EnableGameModeObjective(cp.capturePoint, enabled);
    objectiveCapturePointObjectiveEnabledByCpId[cpId] = enabled;
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "enable_obj/" + context + "/" + String(cpId),
      mod.Message(
        "[OBJECTIVE ENGINE] EnableGameModeObjective failed cp/context/enabled {}",
        String(cpId) + "/" + context + "/" + (enabled ? "1" : "0")
      )
    );
    LogRuntimeError("EnableGameModeObjective/" + context + "/" + String(cpId), err);
  }
}

function setObjectiveCapturePointObjectivesEnabled(enabled: boolean, context: string): void {
  for (let i = 0; i < OBJECTIVE_REGISTRATION_ORDER.length; i++) {
    safeEnableCapturePointObjectiveByCpId(OBJECTIVE_REGISTRATION_ORDER[i], enabled, context);
  }
}

function disableAllObjectiveCapturePointObjectives(context: string): void {
  setObjectiveCapturePointObjectivesEnabled(false, context);
}

function setNeutralObjectiveCapturePointEnabledForActiveCp(
  activeCpId: number,
  enabled: boolean,
  context: string
): void {
  const neutralCpId = OBJECTIVE_NEUTRAL_CP_ID_BY_ACTIVE_CP_ID[activeCpId];
  if (!neutralCpId) return;

  setObjectiveAuthoritativeOwner(neutralCpId, teamNeutral, context + "_neutral_owner");
  safeEnableCapturePointObjectiveByCpId(neutralCpId, enabled, context + "_neutral_cp", true);
}

function disableAllNeutralObjectiveCapturePointObjectives(context: string): void {
  for (let i = 0; i < OBJECTIVE_NEUTRAL_CP_IDS.length; i++) {
    const neutralCpId = OBJECTIVE_NEUTRAL_CP_IDS[i];
    setObjectiveAuthoritativeOwner(neutralCpId, teamNeutral, context + "_neutral_owner");
    safeEnableCapturePointObjectiveByCpId(neutralCpId, false, context + "_neutral_cp", true);
  }
}

function disableAllObjectiveInteractPoints(_context: string): void {
  for (let i = 0; i < OBJECTIVE_INTERACT_POINT_IDS.length; i++) {
    SafeEnableInteractPointById(OBJECTIVE_INTERACT_POINT_IDS[i], false);
  }

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    objectiveCaptureInteractEnabledByCpId[OBJECTIVE_DEFINITIONS[i].cpId] = false;
  }
}

function safeSetCapturePointTimingByCpId(
  cpId: number,
  captureTime: number,
  neutralizeTime: number,
  context: string
): void {
  const cp = serverCapturePoints[cpId];
  if (!cp) return;
  try {
    mod.SetCapturePointCapturingTime(cp.capturePoint, captureTime);
    mod.SetCapturePointNeutralizationTime(cp.capturePoint, neutralizeTime);
    mod.SetMaxCaptureMultiplier(cp.capturePoint, 1);
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "set_timing/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] SetCapturePointTiming failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("SetCapturePointTiming/" + context + "/" + String(cpId), err);
  }
}

function safeEnableObjectiveMcomByCpId(
  cpId: number,
  enabled: boolean,
  context: string,
  force: boolean = false
): void {
  const mcomId = OBJECTIVE_MCOM_ID_BY_CP_ID[cpId];
  if (!mcomId) return;
  if (!force && objectiveMcomObjectiveEnabledByCpId[cpId] === enabled) return;
  try {
    mod.EnableGameModeObjective(mod.GetMCOM(mcomId), enabled);
    objectiveMcomObjectiveEnabledByCpId[cpId] = enabled;
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "enable_mcom/" + context + "/" + String(cpId),
      mod.Message(
        "[OBJECTIVE ENGINE] EnableGameModeObjective failed cp/context/enabled {}",
        String(cpId) + "/" + context + "/" + (enabled ? "1" : "0")
      )
    );
    LogRuntimeError("EnableGameModeObjectiveMCOM/" + context + "/" + String(cpId), err);
  }
}

function safeSetObjectiveMcomOwnerByCpId(cpId: number, owner: mod.Team, context: string): void {
  const mcomId = OBJECTIVE_MCOM_ID_BY_CP_ID[cpId];
  if (!mcomId) return;
  try {
    mod.SetMCOMOwner(mod.GetMCOM(mcomId), owner);
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "set_mcom_owner/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] SetMCOMOwner failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("SetMCOMOwner/" + context + "/" + String(cpId), err);
  }
}

function safeSetObjectiveMcomFuseTimeByCpId(cpId: number, seconds: number, context: string): void {
  const mcomId = OBJECTIVE_MCOM_ID_BY_CP_ID[cpId];
  if (!mcomId) return;
  try {
    mod.SetMCOMFuseTime(mod.GetMCOM(mcomId), seconds);
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "set_mcom_fuse/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] SetMCOMFuseTime failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("SetMCOMFuseTime/" + context + "/" + String(cpId), err);
  }
}

function setObjectiveNativeMcomObjectivesEnabled(enabled: boolean, context: string): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    safeEnableObjectiveMcomByCpId(OBJECTIVE_DEFINITIONS[i].cpId, enabled, context);
  }
}

function syncDisabledBombAnchorObjectives(): void {
  disableSectorObjectiveByIdSafe(BOMB_ANCHOR_SECTOR_ID);
  for (let i = 0; i < BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS.length; i++) {
    disableCapturePointObjectiveByIdSafe(BOMB_SECTOR_DISABLED_CAPTURE_POINT_IDS[i]);
  }
}

function seedObjectiveNativeMcomState(context: string): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    safeSetObjectiveMcomFuseTimeByCpId(def.cpId, OBJECTIVE_SCORE_HOLD_SECONDS, context);
    safeSetObjectiveMcomOwnerByCpId(def.cpId, getObjectiveDefendingTeamForCurrentHalf(def.cpId), context);
  }
}

function safeSetObjectiveCapturePointOwnerByCpId(cpId: number, owner: mod.Team, context: string): void {
  const cp = serverCapturePoints[cpId];
  if (!cp) return;
  try {
    mod.SetCapturePointOwner(cp.capturePoint, owner);
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "set_cp_owner/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] SetCapturePointOwner failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("SetCapturePointOwner/" + context + "/" + String(cpId), err);
  }
  cp.setOwner(owner);
}

function setObjectiveAuthoritativeOwner(cpId: number, owner: mod.Team, context: string = "setObjectiveAuthoritativeOwner"): void {
  // Objective ownership is seeded during init/reset and stays static during live play.
  safeSetObjectiveCapturePointOwnerByCpId(cpId, owner, context);
}

function applyObjectiveLockedCaptureTiming(cpId: number): void {
  safeSetCapturePointTimingByCpId(
    cpId,
    OBJECTIVE_CAPTURE_LOCKED_CAPTURE_TIME,
    OBJECTIVE_CAPTURE_LOCKED_NEUTRALIZE_TIME,
    "applyObjectiveLockedCaptureTiming"
  );
}

function clearObjectivePendingAward(cpId: number): void {
  objectivePendingAwardStartTickByCpId[cpId] = undefined;
  objectivePendingAwardStartAtSecByCpId[cpId] = undefined;
  objectivePendingAwardDeadlineAtSecByCpId[cpId] = undefined;
  objectivePendingAwardTeamByCpId[cpId] = teamNeutral;
  objectivePendingAwardTokenByCpId[cpId] = undefined;
  clearObjectiveDestroyExplosionPosition(cpId);
  setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", false);
  setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", false);
  syncObjectiveArmedPendingVisualStateForCp(cpId);
}

function isObjectiveDisabledAfterAward(cpId: number): boolean {
  return objectiveDisabledAfterAwardByCpId[cpId] === true;
}

function isObjectiveCaptureAttemptActive(cpId: number): boolean {
  return objectiveCaptureAttemptEnabledByCpId[cpId] === true;
}

function setObjectiveCaptureInteractEnabled(cpId: number, enabled: boolean): void {
  const ipId = OBJECTIVE_INTERACT_POINT_ID_BY_CP_ID[cpId];
  if (!ipId) return;

  const previous = objectiveCaptureInteractEnabledByCpId[cpId] === true;
  if (previous === enabled) return;

  objectiveCaptureInteractEnabledByCpId[cpId] = enabled;
  SafeEnableInteractPointById(ipId, enabled);
}

function isPlayerInsideObjectiveAreaForCp(playerId: number, cpId: number): boolean {
  const triggerId = OBJECTIVE_AREA_TRIGGER_ID_BY_CP_ID[cpId];
  if (!(triggerId > 0)) return false;

  const active = objectiveAreaActiveTriggersByPlayerId[playerId];
  if (!active) return false;

  return active[triggerId] === true;
}

function getValidObjectiveInteractionPlayer(playerId: number): Player | undefined {
  const sp = serverPlayers.get(playerId);
  if (!sp) return undefined;
  if (!sp.isDeployed) return undefined;
  if (!mod.IsPlayerValid(sp.player)) return undefined;
  if (!isPlayerAlive(sp.player)) return undefined;
  return sp;
}

function isPlayerEligibleToArmObjectiveCp(cpId: number, playerId: number): boolean {
  if (gameStatus !== 3) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (isObjectivePendingAwardActive(cpId)) return false;
  if (bombCarrierPlayerId !== playerId) return false;
  if (!isPlayerInsideObjectiveAreaForCp(playerId, cpId)) return false;

  const sp = getValidObjectiveInteractionPlayer(playerId);
  if (!sp) return false;

  const playerTeam = mod.GetTeam(sp.player);
  return mod.Equals(playerTeam, getObjectiveArmingTeam(cpId));
}

function canPlayerArmObjectiveCp(cpId: number, playerId: number): boolean {
  if (isObjectiveCaptureAttemptActive(cpId)) return false;
  return isPlayerEligibleToArmObjectiveCp(cpId, playerId);
}

function isPlayerEligibleToDisarmObjectiveCp(cpId: number, playerId: number): boolean {
  if (gameStatus !== 3) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (!isObjectivePendingAwardActive(cpId)) return false;
  if (!isPlayerInsideObjectiveAreaForCp(playerId, cpId)) return false;

  const sp = getValidObjectiveInteractionPlayer(playerId);
  if (!sp) return false;

  return mod.Equals(mod.GetTeam(sp.player), getObjectiveDefendingTeamForCurrentHalf(cpId));
}

function canPlayerDisarmObjectiveCp(cpId: number, playerId: number): boolean {
  if (isObjectiveCaptureAttemptActive(cpId)) return false;
  return isPlayerEligibleToDisarmObjectiveCp(cpId, playerId);
}

function isPlayerAuthorizedForObjectiveCp(cpId: number, playerId: number): boolean {
  return canPlayerArmObjectiveCp(cpId, playerId) || canPlayerDisarmObjectiveCp(cpId, playerId);
}

function hasAnyAuthorizedObjectiveInteractorForCp(cpId: number): boolean {
  let found = false;

  serverPlayers.forEach((sp) => {
    if (found || !sp) return;
    if (isPlayerAuthorizedForObjectiveCp(cpId, sp.id)) {
      found = true;
    }
  });

  return found;
}

function updateObjectiveCaptureInteractionForCp(cpId: number): void {
  if (!isObjectiveCpId(cpId)) return;

  if (isObjectiveDisabledAfterAward(cpId) || isObjectiveCaptureAttemptActive(cpId)) {
    setObjectiveCaptureInteractEnabled(cpId, false);
    return;
  }

  setObjectiveCaptureInteractEnabled(cpId, hasAnyAuthorizedObjectiveInteractorForCp(cpId));
}

function UpdateObjectiveCaptureInteractionState(): void {
  disableAllObjectiveInteractPoints("UpdateObjectiveCaptureInteractionState");
}

function beginObjectiveCaptureAttempt(cpId: number, playerId: number, kind: ObjectiveAttemptKind): void {
  const sp = serverPlayers.get(playerId);
  if (!sp) return;

  objectiveCaptureAttemptEnabledByCpId[cpId] = true;
  objectiveCaptureAttemptTeamByCpId[cpId] = mod.GetTeam(sp.player);
  objectiveCaptureAttemptKindByCpId[cpId] = kind;
  objectiveCaptureAttemptTokenByCpId[cpId] = (objectiveCaptureAttemptTokenByCpId[cpId] ?? 0) + 1;
  objectiveCaptureAttemptStartTickByCpId[cpId] = serverTickCount;
  objectiveCaptureAttemptStartAtSecByCpId[cpId] = getCurrentSchedulerNowSeconds();
  objectiveCaptureAttemptPlayerIdByCpId[cpId] = playerId;

  stopObjectiveMcomAttemptLoopSfxForCp(cpId);

  if (mod.IsPlayerValid(sp.player)) {
    stopObjectiveAttemptLocalArmingSfxForPlayer(sp.player);
    stopObjectiveAttemptLocalDefusingSfxForPlayer(sp.player);
  }

  if (kind === "disarm" && mod.IsPlayerValid(sp.player)) {
    setObjectiveMcomSfxEnabledForCp(cpId, "defusing", true, sp.player);
    playObjectiveAttemptLocalSfx(sp.player, "defusing");
  } else if (mod.IsPlayerValid(sp.player)) {
    setObjectiveMcomSfxEnabledForCp(cpId, "arming", true, sp.player);
    playObjectiveAttemptLocalSfx(sp.player, "arming");
  }

  setObjectiveCaptureInteractEnabled(cpId, false);
  UpdateObjectiveHoldProgressUiForPlayer(sp);
}

function endObjectiveCaptureAttempt(cpId: number): void {
  stopObjectiveMcomAttemptLoopSfxForCp(cpId);

  const attemptPlayerId = objectiveCaptureAttemptPlayerIdByCpId[cpId];
  const attemptPlayer = attemptPlayerId !== undefined ? serverPlayers.get(attemptPlayerId) : undefined;

  objectiveCaptureAttemptEnabledByCpId[cpId] = false;
  objectiveCaptureAttemptTeamByCpId[cpId] = teamNeutral;
  objectiveCaptureAttemptKindByCpId[cpId] = "arm";
  objectiveCaptureAttemptStartTickByCpId[cpId] = undefined;
  objectiveCaptureAttemptStartAtSecByCpId[cpId] = undefined;
  objectiveCaptureAttemptPlayerIdByCpId[cpId] = undefined;
  setObjectiveCaptureInteractEnabled(cpId, false);

  if (attemptPlayer && mod.IsPlayerValid(attemptPlayer.player)) {
    stopObjectiveAttemptLocalArmingSfxForPlayer(attemptPlayer.player);
    stopObjectiveAttemptLocalDefusingSfxForPlayer(attemptPlayer.player);
    UpdateObjectiveHoldProgressUiForPlayer(attemptPlayer);
  }
}

function cancelObjectiveCaptureAttemptsForPlayer(playerId: number): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (objectiveCaptureAttemptEnabledByCpId[cpId] !== true) continue;
    if (objectiveCaptureAttemptPlayerIdByCpId[cpId] !== playerId) continue;
    endObjectiveCaptureAttempt(cpId);
    updateObjectiveCaptureInteractionForCp(cpId);
  }
}

function completeObjectiveCaptureAttempt(cpId: number): void {
  const attemptKind = objectiveCaptureAttemptKindByCpId[cpId] ?? "arm";
  const attemptPlayerId = objectiveCaptureAttemptPlayerIdByCpId[cpId];

  if (attemptPlayerId === undefined) {
    endObjectiveCaptureAttempt(cpId);
    updateObjectiveCaptureInteractionForCp(cpId);
    return;
  }

  if (attemptKind === "disarm") {
    handleObjectiveDefuseSuccess(cpId, attemptPlayerId);
  } else {
    handleObjectiveArmSuccess(cpId, attemptPlayerId);
  }

  endObjectiveCaptureAttempt(cpId);
  if (initialization[3] === true) {
    syncLiveHybridObjectiveSurfaceState("completeObjectiveCaptureAttempt", true);
  } else {
    updateObjectiveCaptureInteractionForCp(cpId);
  }
}

function EvaluateObjectiveCaptureHoldAttempts(): void {
  if (gameStatus !== 3) return;

  const nowSec = getCurrentSchedulerNowSeconds();
  const useEngineSeconds = USE_ENGINE_TIME_SCHEDULER && currentFrameHasEngineNowSec;

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (objectiveCaptureAttemptEnabledByCpId[cpId] !== true) continue;

    const attemptKind = objectiveCaptureAttemptKindByCpId[cpId] ?? "arm";
    const attemptTeam = objectiveCaptureAttemptTeamByCpId[cpId] ?? teamNeutral;
    const attemptPlayerId = objectiveCaptureAttemptPlayerIdByCpId[cpId];
    const attemptStartTick = objectiveCaptureAttemptStartTickByCpId[cpId];
    const attemptStartAtSec = objectiveCaptureAttemptStartAtSecByCpId[cpId];

    if (
      attemptPlayerId === undefined ||
      mod.Equals(attemptTeam, teamNeutral) ||
      (attemptStartTick === undefined && attemptStartAtSec === undefined)
    ) {
      endObjectiveCaptureAttempt(cpId);
      updateObjectiveCaptureInteractionForCp(cpId);
      continue;
    }

    const sp = getValidObjectiveInteractionPlayer(attemptPlayerId);
    if (!sp) {
      endObjectiveCaptureAttempt(cpId);
      updateObjectiveCaptureInteractionForCp(cpId);
      continue;
    }

    if (!mod.Equals(mod.GetTeam(sp.player), attemptTeam)) {
      endObjectiveCaptureAttempt(cpId);
      updateObjectiveCaptureInteractionForCp(cpId);
      continue;
    }

    const stillEligible =
      attemptKind === "disarm"
        ? isPlayerEligibleToDisarmObjectiveCp(cpId, attemptPlayerId)
        : isPlayerEligibleToArmObjectiveCp(cpId, attemptPlayerId);
    if (!stillEligible) {
      endObjectiveCaptureAttempt(cpId);
      updateObjectiveCaptureInteractionForCp(cpId);
      continue;
    }

    if (useEngineSeconds && attemptStartAtSec !== undefined) {
      if (nowSec - attemptStartAtSec < OBJECTIVE_INTERACT_HOLD_SECONDS) continue;
    } else {
      if (attemptStartTick === undefined) continue;
      if (serverTickCount - attemptStartTick < OBJECTIVE_INTERACT_HOLD_TICKS) continue;
    }

    completeObjectiveCaptureAttempt(cpId);
  }
}

function HandleObjectiveCaptureInteract(eventPlayer: mod.Player, cpId: number): void {
  if (gameStatus !== 3) return;

  const playerId = modlib.getPlayerId(eventPlayer);
  if (isObjectiveCaptureAttemptActive(cpId)) return;

  let kind: ObjectiveAttemptKind | undefined = undefined;
  if (canPlayerDisarmObjectiveCp(cpId, playerId)) kind = "disarm";
  else if (canPlayerArmObjectiveCp(cpId, playerId)) kind = "arm";

  if (!kind) return;

  cancelObjectiveCaptureAttemptsForPlayer(playerId);
  beginObjectiveCaptureAttempt(cpId, playerId, kind);
  updateObjectiveCaptureInteractionForCp(cpId);
}

function getValidBombCarrierForObjectiveSurfacePromotion(): Player | undefined {
  if (bombCarrierPlayerId === undefined) return undefined;

  const carrier = serverPlayers.get(bombCarrierPlayerId);
  if (!carrier) return undefined;
  if (!carrier.isDeployed) return undefined;
  if (!mod.IsPlayerValid(carrier.player)) return undefined;
  if (!isPlayerAlive(carrier.player)) return undefined;

  const carrierTeam = getCipherKeyTeamSnapshot(carrier.id) ?? carrier.team;
  if (!mod.Equals(carrierTeam, team1) && !mod.Equals(carrierTeam, team2)) return undefined;

  return carrier;
}

function getLiveHybridPromotedObjectiveCpId(): number | undefined {
  const carrier = getValidBombCarrierForObjectiveSurfacePromotion();
  if (!carrier) return undefined;

  const activeTriggers = objectiveAreaActiveTriggersByPlayerId[carrier.id];
  if (!activeTriggers) return undefined;

  const carrierTeam = getCipherKeyTeamSnapshot(carrier.id) ?? carrier.team;
  const candidateCpIds: number[] = [];

  for (const triggerIdKey in activeTriggers) {
    if (activeTriggers[triggerIdKey] !== true) continue;

    const triggerId = Number(triggerIdKey);
    const cpId = OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID[triggerId];
    if (cpId === undefined) continue;

    const def = getObjectiveDef(cpId);
    if (!def) continue;
    if (mod.Equals(carrierTeam, getObjectiveDefendingTeamForCurrentHalf(cpId))) continue;
    if (candidateCpIds.indexOf(cpId) >= 0) continue;
    candidateCpIds.push(cpId);
  }

  if (candidateCpIds.length <= 0) return undefined;
  if (candidateCpIds.length === 1) return candidateCpIds[0];

  const lastEnteredTriggerId = objectiveAreaLastEnteredTriggerByPlayerId[carrier.id];
  if (lastEnteredTriggerId !== undefined) {
    const lastEnteredCpId = OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID[lastEnteredTriggerId];
    if (lastEnteredCpId !== undefined && candidateCpIds.indexOf(lastEnteredCpId) >= 0) {
      warnObjectiveEngineCallOnce(
        "objective_area_overlap/" + String(carrier.id),
        mod.Message(
          "[OBJECTIVE AREA] multiple active triggers player/cps/selected {}",
          String(carrier.id) +
            "/" +
            candidateCpIds.join(",") +
            "/" +
            String(lastEnteredTriggerId) +
            "->" +
            String(lastEnteredCpId)
        )
      );
      return lastEnteredCpId;
    }
  }

  warnObjectiveEngineCallOnce(
    "objective_area_overlap/" + String(carrier.id),
    mod.Message(
      "[OBJECTIVE AREA] multiple active triggers player/cps/selected {}",
      String(carrier.id) + "/" + candidateCpIds.join(",") + "/" + "fallback->" + String(candidateCpIds[0])
    )
  );
  return candidateCpIds[0];
}

function applyLiveHybridObjectiveSurfaceStateForCp(
  cpId: number,
  promotedCpId: number | undefined,
  context: string,
  force: boolean = false
): void {
  void promotedCpId;
  const disabled = isObjectiveDisabledAfterAward(cpId);
  const armed = isObjectivePendingAwardActive(cpId);
  const capturePointEnabled = !disabled && !armed;
  const mcomEnabled = false;

  safeEnableCapturePointObjectiveByCpId(
    cpId,
    capturePointEnabled,
    "syncLiveHybridObjectiveSurfaceState/" + context,
    force
  );
  safeEnableObjectiveMcomByCpId(cpId, mcomEnabled, "syncLiveHybridObjectiveSurfaceState/" + context, force);
}

function reapplyLiveHybridObjectiveSurfaceStateForCp(cpId: number, context: string): void {
  if (gameStatus !== 3) return;
  applyLiveHybridObjectiveSurfaceStateForCp(cpId, getLiveHybridPromotedObjectiveCpId(), context, true);
  updateObjectiveCaptureInteractionForCp(cpId);
}

function syncLiveHybridObjectiveSurfaceState(context: string, force: boolean = false): void {
  if (gameStatus !== 3) return;

  const promotedCpId = getLiveHybridPromotedObjectiveCpId();

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    applyLiveHybridObjectiveSurfaceStateForCp(OBJECTIVE_DEFINITIONS[i].cpId, promotedCpId, context, force);
  }

  UpdateObjectiveCaptureInteractionState();
}

function getObjectiveAwardIndexByCpId(cpId: number): number {
  return OBJECTIVE_AWARD_CP_IDS.indexOf(cpId);
}

function getObjectiveAwardAnchorIdByCpId(cpId: number): number | undefined {
  const idx = getObjectiveAwardIndexByCpId(cpId);
  if (idx < 0 || idx >= OBJECTIVE_AWARD_VFX_IDS.length) return undefined;
  return OBJECTIVE_AWARD_VFX_IDS[idx];
}

function getObjectiveAwardVfxByCpId(cpId: number): mod.VFX | undefined {
  const idx = getObjectiveAwardIndexByCpId(cpId);
  if (idx < 0 || idx >= objectiveAwardVfx.length) return undefined;
  return objectiveAwardVfx[idx];
}

function getObjectivePersistentFireVfxByCpId(cpId: number): mod.VFX[] {
  const idx = getObjectiveAwardIndexByCpId(cpId);
  if (idx < 0) return [];

  const result: mod.VFX[] = [];

  if (idx < objectiveAwardPersistentFirePrimaryVfx.length) {
    result.push(objectiveAwardPersistentFirePrimaryVfx[idx]);
  } else {
    warnObjectiveAwardPersistentFireMissingOnce(cpId, OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_NAME);
  }

  if (idx < objectiveAwardPersistentFireSecondaryVfx.length) {
    result.push(objectiveAwardPersistentFireSecondaryVfx[idx]);
  } else {
    warnObjectiveAwardPersistentFireMissingOnce(cpId, OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_NAME);
  }

  return result;
}

function getObjectiveArmedWorldIconIdByCpId(cpId: number): number | undefined {
  return OBJECTIVE_ARMED_WORLDICON_ID_BY_CP_ID[cpId];
}

function warnObjectiveArmedWorldIconMissingOnce(cpId: number, iconId: number | undefined): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (objectiveArmedWorldIconMissingWarnedByCpId[cpId] === true) return;
  objectiveArmedWorldIconMissingWarnedByCpId[cpId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[OBJECTIVE ICON] Missing/invalid world icon cp {} id {}",
      cpId,
      iconId ?? -1
    )
  );
}

function setObjectiveArmedWorldIconEnabled(cpId: number, enabled: boolean): void {
  const iconId = getObjectiveArmedWorldIconIdByCpId(cpId);
  if (!iconId) {
    if (!enabled) {
      delete objectiveArmedWorldIconLastShownSecondsByCpId[cpId];
    }
    return;
  }

  try {
    const icon = mod.GetWorldIcon(iconId);
    mod.SetWorldIconImage(icon, mod.WorldIconImages.BombArmed);
    mod.SetWorldIconColor(icon, COLOR_ENEMY);
    if (!enabled) {
      delete objectiveArmedWorldIconLastShownSecondsByCpId[cpId];
    }
    mod.EnableWorldIconText(icon, false);
    mod.EnableWorldIconImage(icon, enabled);
  } catch (_err) {
    warnObjectiveArmedWorldIconMissingOnce(cpId, iconId);
  }
}

function getObjectivePendingAwardRemainingSeconds(cpId: number): number | undefined {
  const pendingTeam = objectivePendingAwardTeamByCpId[cpId] ?? teamNeutral;
  const pendingStartTick = objectivePendingAwardStartTickByCpId[cpId];
  const pendingStartAtSec = objectivePendingAwardStartAtSecByCpId[cpId];
  const pendingDeadlineAtSec = objectivePendingAwardDeadlineAtSecByCpId[cpId];
  const pendingToken = objectivePendingAwardTokenByCpId[cpId];
  if (
    (pendingStartTick === undefined && pendingStartAtSec === undefined) ||
    pendingToken === undefined ||
    mod.Equals(pendingTeam, teamNeutral)
  ) {
    return undefined;
  }

  const nowSec = getCurrentSchedulerNowSeconds();
  const useEngineSeconds = USE_ENGINE_TIME_SCHEDULER && currentFrameHasEngineNowSec;
  let remainingSeconds = 0;

  if (pendingDeadlineAtSec !== undefined) {
    remainingSeconds = mod.Ceiling(pendingDeadlineAtSec - nowSec);
  } else if (useEngineSeconds && pendingStartAtSec !== undefined) {
    remainingSeconds = mod.Ceiling(OBJECTIVE_SCORE_HOLD_SECONDS - (nowSec - pendingStartAtSec));
  } else if (pendingStartTick !== undefined) {
    remainingSeconds = mod.Ceiling((OBJECTIVE_SCORE_HOLD_TICKS - (serverTickCount - pendingStartTick)) / TICK_RATE);
  } else {
    return undefined;
  }

  if (remainingSeconds < 0) remainingSeconds = 0;
  return remainingSeconds;
}

function updateObjectiveArmedWorldIconCountdownForCp(cpId: number): void {
  const remainingSeconds = getObjectivePendingAwardRemainingSeconds(cpId);
  const iconId = getObjectiveArmedWorldIconIdByCpId(cpId);
  if (!iconId) {
    delete objectiveArmedWorldIconLastShownSecondsByCpId[cpId];
    return;
  }

  if (remainingSeconds === undefined) {
    setObjectiveArmedWorldIconEnabled(cpId, false);
    return;
  }

  setObjectiveArmedWorldIconEnabled(cpId, true);

  try {
    const icon = mod.GetWorldIcon(iconId);
    if (objectiveArmedWorldIconLastShownSecondsByCpId[cpId] !== remainingSeconds) {
      mod.SetWorldIconText(icon, formatUiTimerLabel(remainingSeconds));
      objectiveArmedWorldIconLastShownSecondsByCpId[cpId] = remainingSeconds;
    }
    mod.EnableWorldIconText(icon, true);
  } catch (_err) {
    warnObjectiveArmedWorldIconMissingOnce(cpId, iconId);
  }
}

function updateObjectiveArmedWorldIconCountdowns(): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    updateObjectiveArmedWorldIconCountdownForCp(OBJECTIVE_DEFINITIONS[i].cpId);
  }
}

function getCipherObjectiveKeyCount(cpId: number): number {
  const count = cipherObjectiveKeyCountByCpId[cpId] ?? 0;
  if (!Number.isFinite(count) || count < 0) return 0;
  if (count > CIPHER_KEYS_TO_DESTROY_OBJECTIVE) return CIPHER_KEYS_TO_DESTROY_OBJECTIVE;
  return count;
}

function setCipherObjectiveKeyCount(cpId: number, value: number): void {
  let next = value;
  if (!Number.isFinite(next) || next < 0) next = 0;
  if (next > CIPHER_KEYS_TO_DESTROY_OBJECTIVE) next = CIPHER_KEYS_TO_DESTROY_OBJECTIVE;
  cipherObjectiveKeyCountByCpId[cpId] = next;
}

function getCipherCounterMessage(count: number): any {
  return mod.Message((mod.stringkeys as any).CipherKeyCounter, count);
}

function getCipherCounterRuntimeIconKey(cpId: number, ownerTeam: mod.Team): string {
  return String(cpId) + ":" + String(modlib.getTeamId(ownerTeam));
}

function getCipherCounterAnchorPositionForCp(cpId: number): mod.Vector | undefined {
  const snapshot = getCachedCipherCapturePointPositionSnapshot(cpId);
  if (!snapshot) return undefined;
  return mod.CreateVector(snapshot.x, snapshot.y + CIPHER_COUNTER_Y_OFFSET_METERS, snapshot.z);
}

function warnCipherCounterRuntimeIconMissingOnce(key: string, cpId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (cipherCounterRuntimeWorldIconMissingWarnedByKey[key] === true) return;
  cipherCounterRuntimeWorldIconMissingWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[OBJECTIVE ICON] Missing/invalid world icon cp {} id {}", cpId, reason)
  );
}

function clearCipherCounterRuntimeWorldIconByKey(key: string): void {
  const handle = cipherCounterRuntimeWorldIconHandleByKey[key];
  if (handle) {
    try {
      mod.EnableWorldIconText(handle, false);
      mod.EnableWorldIconImage(handle, false);
    } catch (_errDisable) {}
  }

  const object = cipherCounterRuntimeWorldIconObjectByKey[key];
  if (object) {
    unspawnObjectSafe(object, "cipher counter runtime world icon", false);
  } else if (handle) {
    unspawnObjectSafe(handle as unknown, "cipher counter runtime world icon handle", false);
  }

  delete cipherCounterRuntimeWorldIconObjectByKey[key];
  delete cipherCounterRuntimeWorldIconHandleByKey[key];
  delete cipherCounterRuntimeWorldIconLastStateByKey[key];
}

function clearCipherCounterRuntimeWorldIconsForCp(cpId: number): void {
  const prefix = String(cpId) + ":";
  const keys: string[] = [];
  for (const key in cipherCounterRuntimeWorldIconHandleByKey) {
    if (key.indexOf(prefix) === 0) keys.push(key);
  }
  for (const key in cipherCounterRuntimeWorldIconObjectByKey) {
    if (key.indexOf(prefix) === 0 && keys.indexOf(key) < 0) keys.push(key);
  }
  for (let i = 0; i < keys.length; i++) {
    clearCipherCounterRuntimeWorldIconByKey(keys[i]);
  }
}

function clearAllCipherCounterRuntimeWorldIcons(): void {
  const keys: string[] = [];
  for (const key in cipherCounterRuntimeWorldIconHandleByKey) keys.push(key);
  for (const key in cipherCounterRuntimeWorldIconObjectByKey) {
    if (keys.indexOf(key) < 0) keys.push(key);
  }
  for (let i = 0; i < keys.length; i++) {
    clearCipherCounterRuntimeWorldIconByKey(keys[i]);
  }
  cipherCounterRuntimeWorldIconMissingWarnedByKey = {};
}

function configureCipherCounterRuntimeWorldIcon(
  cpId: number,
  ownerTeam: mod.Team,
  textColor: mod.Vector,
  count: number,
  force: boolean
): void {
  if (mod.Equals(ownerTeam, teamNeutral)) return;

  const key = getCipherCounterRuntimeIconKey(cpId, ownerTeam);
  const pos = getCipherCounterAnchorPositionForCp(cpId);
  if (!pos) {
    warnCipherCounterRuntimeIconMissingOnce(key, cpId, "missing_position");
    return;
  }

  let handle = cipherCounterRuntimeWorldIconHandleByKey[key];
  if (!handle) {
    const spawned = spawnRuntimeCommonObjectSafe(
      mod.RuntimeSpawn_Common.WorldIcon,
      pos,
      BOMB_DROP_ROTATION,
      "cipher_counter_worldicon_" + key
    );
    if (!spawned.object) {
      warnCipherCounterRuntimeIconMissingOnce(key, cpId, spawned.reason);
      return;
    }

    const resolvedHandle = resolveRuntimeWorldIconHandle(spawned.object as unknown);
    if (!resolvedHandle) {
      unspawnObjectSafe(spawned.object, "cipher counter unresolved world icon", false);
      warnCipherCounterRuntimeIconMissingOnce(key, cpId, "resolve_failed");
      return;
    }

    cipherCounterRuntimeWorldIconObjectByKey[key] = spawned.object;
    cipherCounterRuntimeWorldIconHandleByKey[key] = resolvedHandle;
    handle = resolvedHandle;
  } else {
    const object = cipherCounterRuntimeWorldIconObjectByKey[key];
    if (object) {
      moveObjectToAbsolutePositionSafe(object, pos, "cipher_counter_worldicon_move");
    } else {
      try {
        mod.SetWorldIconPosition(handle, pos);
      } catch (_errMove) {}
    }
  }

  const stateKey = String(count) + ":" + String(modlib.getTeamId(ownerTeam));
  if (force || cipherCounterRuntimeWorldIconLastStateByKey[key] !== stateKey) {
    try {
      mod.SetWorldIconText(handle, getCipherCounterMessage(count));
      mod.SetWorldIconColor(handle, textColor);
      mod.SetWorldIconOwner(handle, ownerTeam);
      cipherCounterRuntimeWorldIconLastStateByKey[key] = stateKey;
    } catch (_errConfigure) {
      warnCipherCounterRuntimeIconMissingOnce(key, cpId, "configure_failed");
      return;
    }
  }

  try {
    mod.EnableWorldIconImage(handle, false);
    mod.EnableWorldIconText(handle, gameStatus === 3);
  } catch (_errEnable) {
    warnCipherCounterRuntimeIconMissingOnce(key, cpId, "enable_failed");
  }
}

function updateCipherCounterWorldIconForCp(cpId: number, force: boolean = false): void {
  const iconId = getObjectiveArmedWorldIconIdByCpId(cpId);
  if (!iconId) {
    delete cipherCounterWorldIconLastShownByCpId[cpId];
    return;
  }

  const count = getCipherObjectiveKeyCount(cpId);
  const enabled = gameStatus === 3;
  const defendingTeam = getObjectiveDefendingTeamForCurrentHalf(cpId);
  const attackingTeam = getOpposingTeam(defendingTeam);

  try {
    const icon = mod.GetWorldIcon(iconId);
    mod.EnableWorldIconImage(icon, false);
    mod.EnableWorldIconText(icon, false);
  } catch (_err) {
    warnObjectiveArmedWorldIconMissingOnce(cpId, iconId);
  }

  if (!enabled) {
    delete cipherCounterWorldIconLastShownByCpId[cpId];
    clearCipherCounterRuntimeWorldIconsForCp(cpId);
    return;
  }

  configureCipherCounterRuntimeWorldIcon(cpId, attackingTeam, COLOR_FRIENDLY, count, force);
  configureCipherCounterRuntimeWorldIcon(cpId, defendingTeam, COLOR_ENEMY, count, force);
  cipherCounterWorldIconLastShownByCpId[cpId] = count;
}

function updateCipherCounterWorldIcons(force: boolean = false): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    updateCipherCounterWorldIconForCp(OBJECTIVE_DEFINITIONS[i].cpId, force);
  }
}

function hideAllCipherCounterWorldIcons(): void {
  clearAllCipherCounterRuntimeWorldIcons();
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const iconId = getObjectiveArmedWorldIconIdByCpId(cpId);
    delete cipherCounterWorldIconLastShownByCpId[cpId];
    if (!iconId) continue;
    try {
      const icon = mod.GetWorldIcon(iconId);
      mod.EnableWorldIconImage(icon, false);
      mod.EnableWorldIconText(icon, false);
    } catch (_err) {
      warnObjectiveArmedWorldIconMissingOnce(cpId, iconId);
    }
  }
}

function resetCipherObjectiveCounters(): void {
  cipherObjectiveKeyCountByCpId = {};
  cipherCounterWorldIconLastShownByCpId = {};
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    setCipherObjectiveKeyCount(OBJECTIVE_DEFINITIONS[i].cpId, 0);
  }
  updateCipherCounterWorldIcons(true);
}

function isObjectivePendingAwardActive(cpId: number): boolean {
  const pendingTeam = objectivePendingAwardTeamByCpId[cpId] ?? teamNeutral;
  const pendingStartTick = objectivePendingAwardStartTickByCpId[cpId];
  const pendingStartAtSec = objectivePendingAwardStartAtSecByCpId[cpId];
  const pendingToken = objectivePendingAwardTokenByCpId[cpId];
  return (
    (pendingStartTick !== undefined || pendingStartAtSec !== undefined) &&
    pendingToken !== undefined &&
    !mod.Equals(pendingTeam, teamNeutral)
  );
}

function syncObjectiveArmedPendingVisualStateForCp(cpId: number): void {
  syncLiveBaseHqsForLivePhase();
  const armedPending = isObjectivePendingAwardActive(cpId);
  updateCipherCounterWorldIconForCp(cpId, true);

  if (armedPending) {
    safeEnableCapturePointObjectiveByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_armed");
    safeEnableObjectiveMcomByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_armed");
    return;
  }

  if (isObjectiveDisabledAfterAward(cpId)) {
    safeEnableCapturePointObjectiveByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_disabled");
    safeEnableObjectiveMcomByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_disabled");
    return;
  }

  if (gameStatus === 3) {
    safeEnableCapturePointObjectiveByCpId(cpId, true, "syncObjectiveArmedPendingVisualStateForCp_live");
    safeEnableObjectiveMcomByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_live");
  }
}

function hideAllObjectiveArmedWorldIcons(): void {
  hideAllCipherCounterWorldIcons();
}

function warnObjectiveAwardAnchorMissingOnce(cpId: number, anchorId: number | undefined): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (objectiveAwardBurstMissingAnchorWarnedByCpId[cpId] === true) return;
  objectiveAwardBurstMissingAnchorWarnedByCpId[cpId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[OBJECTIVE AWARD VFX] Missing/invalid anchor cp {} id {}",
      cpId,
      anchorId ?? -1
    )
  );
}

function warnObjectiveAwardPersistentFireMissingOnce(cpId: number, fxName: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  const key = String(cpId) + ":" + fxName;
  if (objectiveAwardPersistentFireMissingWarnedByKey[key] === true) return;
  objectiveAwardPersistentFireMissingWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[OBJECTIVE AWARD VFX] Missing persistent fire VFX cp {} fx {}", cpId, fxName)
  );
}

function tryGetObjectiveAwardAnchorPosition(cpId: number): mod.Vector | undefined {
  const anchorId = getObjectiveAwardAnchorIdByCpId(cpId);
  if (!anchorId) {
    const mcomPos = tryGetObjectiveMcomPosition(cpId);
    if (mcomPos) return mcomPos;
    warnObjectiveAwardAnchorMissingOnce(cpId, anchorId);
    const cp = serverCapturePoints[cpId];
    if (!cp) return undefined;
    try {
      return mod.GetObjectPosition(cp.capturePoint);
    } catch (_err) {}
    return undefined;
  }

  try {
    const vfxAnchor = mod.GetVFX(anchorId);
    return mod.GetObjectPosition(vfxAnchor);
  } catch (_err) {}

  try {
    const spatialAnchor = mod.GetSpatialObject(anchorId);
    return mod.GetObjectPosition(spatialAnchor);
  } catch (_err) {}

  const mcomPos = tryGetObjectiveMcomPosition(cpId);
  if (mcomPos) return mcomPos;

  warnObjectiveAwardAnchorMissingOnce(cpId, anchorId);
  const cp = serverCapturePoints[cpId];
  if (!cp) return undefined;
  try {
    return mod.GetObjectPosition(cp.capturePoint);
  } catch (_err) {}
  return undefined;
}

function spawnObjectiveAwardRuntimeFxAtPosition(
  asset: mod.RuntimeSpawn_Common,
  pos: mod.Vector
): mod.VFX | mod.Object | undefined {
  const spawned = mod.SpawnObject(asset, pos, OBJECTIVE_AWARD_BURST_ROTATION);

  if (mod.IsType(spawned, mod.Types.VFX)) {
    const vfx = spawned as mod.VFX;
    mod.EnableVFX(vfx, true);
    return vfx;
  }

  if (mod.IsType(spawned, mod.Types.Object)) {
    const spawnedObj = spawned as mod.Object;
    try {
      const spawnedObjId = mod.GetObjId(spawnedObj);
      const vfxFromObj = mod.GetVFX(spawnedObjId);
      mod.EnableVFX(vfxFromObj, true);
      return vfxFromObj;
    } catch (_err) {}

    return spawnedObj;
  }

  return undefined;
}

async function cleanupRuntimeFxAfterDelay(
  spawned: mod.VFX | mod.Object,
  delaySeconds: number
): Promise<void> {
  await mod.Wait(delaySeconds);

  if (mod.IsType(spawned, mod.Types.VFX)) {
    try {
      mod.EnableVFX(spawned as mod.VFX, false);
    } catch (_err) {}
    return;
  }

  if (mod.IsType(spawned, mod.Types.Object)) {
    try {
      mod.UnspawnObject(spawned as mod.Object);
    } catch (_err) {}
  }
}

function stopObjectiveAwardBurstForCp(cpId: number): void {
  objectiveAwardBurstTokenByCpId[cpId] = (objectiveAwardBurstTokenByCpId[cpId] ?? 0) + 1;

  const active = objectiveAwardBurstActiveByCpId[cpId];
  objectiveAwardBurstActiveByCpId[cpId] = undefined;
  if (!active) return;

  if (mod.IsType(active, mod.Types.VFX)) {
    mod.EnableVFX(active as mod.VFX, false);
    return;
  }

  if (mod.IsType(active, mod.Types.Object)) {
    mod.UnspawnObject(active as mod.Object);
  }
}

function stopObjectiveAwardPersistentFireForCp(cpId: number): void {
  const vfxList = getObjectivePersistentFireVfxByCpId(cpId);
  for (let i = 0; i < vfxList.length; i++) {
    mod.EnableVFX(vfxList[i], false);
  }
}

function enableObjectiveAwardPersistentFireForCp(cpId: number): void {
  if (!OBJECTIVE_AWARD_PERSISTENT_FIRE_ENABLED) return;
  const vfxList = getObjectivePersistentFireVfxByCpId(cpId);
  for (let i = 0; i < vfxList.length; i++) {
    mod.EnableVFX(vfxList[i], true);
  }
}

function playObjectiveAwardExplosionOneShotAtPosition(pos: mod.Vector): void {
  if (!OBJECTIVE_AWARD_EXPLOSION_ONESHOT_ENABLED) return;
  spawnObjectiveAwardRuntimeFxAtPosition(OBJECTIVE_AWARD_EXPLOSION_ONESHOT_ASSET, pos);
}

function stopAllObjectiveAwardBursts(): void {
  for (let i = 0; i < OBJECTIVE_AWARD_CP_IDS.length; i++) {
    const cpId = OBJECTIVE_AWARD_CP_IDS[i];
    stopObjectiveAwardBurstForCp(cpId);
    stopObjectiveAwardPersistentFireForCp(cpId);
  }
}

async function cleanupObjectiveAwardBurstAfterDelay(cpId: number, token: number): Promise<void> {
  await mod.Wait(OBJECTIVE_AWARD_BURST_LIFETIME_SECONDS);
  if ((objectiveAwardBurstTokenByCpId[cpId] ?? 0) !== token) return;
  stopObjectiveAwardBurstForCp(cpId);
}

function playObjectiveAwardBurstForCp(cpId: number, ownerTeam: mod.Team): void {
  if (mod.Equals(ownerTeam, teamNeutral)) return;

  const pos = tryResolveObjectiveDestroyExplosionPosition(cpId);
  if (!pos) return;

  playObjectiveAwardExplosionOneShotAtPosition(pos);
  applyExplosionDamageAtPosition(
    pos,
    BOMB_PLAYER_DROPPED_EXPLOSION_DAMAGE_RADIUS_METERS,
    BOMB_PLAYER_DROPPED_EXPLOSION_DAMAGE
  );
  enableObjectiveAwardPersistentFireForCp(cpId);

  if (!OBJECTIVE_AWARD_BURST_ENABLED) return;

  const asset = mod.Equals(ownerTeam, team1)
    ? OBJECTIVE_AWARD_BURST_TEAM1_ASSET
    : OBJECTIVE_AWARD_BURST_TEAM2_ASSET;

  stopObjectiveAwardBurstForCp(cpId);
  const token = (objectiveAwardBurstTokenByCpId[cpId] ?? 0) + 1;
  objectiveAwardBurstTokenByCpId[cpId] = token;

  const spawned = spawnObjectiveAwardRuntimeFxAtPosition(asset, pos);
  if (!spawned) return;

  if (mod.IsType(spawned, mod.Types.VFX)) {
    const vfx = spawned as mod.VFX;
    objectiveAwardBurstActiveByCpId[cpId] = vfx;
    void cleanupObjectiveAwardBurstAfterDelay(cpId, token);
    return;
  }

  if (mod.IsType(spawned, mod.Types.Object)) {
    objectiveAwardBurstActiveByCpId[cpId] = spawned as mod.Object;
    void cleanupObjectiveAwardBurstAfterDelay(cpId, token);
  }
}

function setObjectiveAwardVfxEnabled(cpId: number, enabled: boolean): void {
  const vfx = getObjectiveAwardVfxByCpId(cpId);
  if (!vfx) return;
  mod.EnableVFX(vfx, enabled);
}

function disableObjectiveAfterAwardSuccess(cpId: number, ownerTeam: mod.Team): void {
  const cp = serverCapturePoints[cpId];
  if (!cp || mod.Equals(ownerTeam, teamNeutral)) return;

  captureObjectiveDestroyExplosionPositionForCp(cpId);
  objectiveDisabledAfterAwardByCpId[cpId] = true;
  objectiveDisabledOwnerTeamByCpId[cpId] = ownerTeam;
  safeEnableCapturePointObjectiveByCpId(cpId, false, "disableObjectiveAfterAwardSuccess", true);
  safeEnableObjectiveMcomByCpId(cpId, false, "disableObjectiveAfterAwardSuccess");
  setObjectiveCaptureInteractEnabled(cpId, false);
  setObjectiveAwardVfxEnabled(cpId, true);
  playObjectiveAwardBurstForCp(cpId, ownerTeam);
  clearObjectivePendingAward(cpId);
  setObjectiveAuthoritativeOwner(cpId, teamNeutral, "disableObjectiveAfterAwardSuccess");
  setNeutralObjectiveCapturePointEnabledForActiveCp(cpId, true, "disableObjectiveAfterAwardSuccess");
  clearObjectiveSuccessfulArmContext(cpId);

  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

function resetObjectiveDisableAndAwardFxState(): void {
  stopAllObjectiveAwardBursts();
  objectiveDisabledAfterAwardByCpId = {};
  objectiveDisabledOwnerTeamByCpId = {};
  resetObjectiveDestroyExplosionPositionState();
  objectiveAwardPersistentFireMissingWarnedByKey = {};
  objectiveArmedWorldIconMissingWarnedByCpId = {};
  hideAllObjectiveArmedWorldIcons();

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    objectiveDisabledAfterAwardByCpId[cpId] = false;
    objectiveDisabledOwnerTeamByCpId[cpId] = teamNeutral;
    setObjectiveAwardVfxEnabled(cpId, false);
  }
}

function resetObjectiveRuntimeState(): void {
  resetObjectiveMcomSfxRuntimeState();
  objectiveArmedWorldIconLastShownSecondsByCpId = {};
  objectiveCapturePointObjectiveEnabledByCpId = {};
  objectiveMcomObjectiveEnabledByCpId = {};
  objectiveCaptureInteractEnabledByCpId = {};
  objectiveCaptureAttemptEnabledByCpId = {};
  objectiveCaptureAttemptTeamByCpId = {};
  objectiveCaptureAttemptKindByCpId = {};
  objectiveCaptureAttemptTokenByCpId = {};
  objectiveCaptureAttemptStartTickByCpId = {};
  objectiveCaptureAttemptStartAtSecByCpId = {};
  objectiveCaptureAttemptPlayerIdByCpId = {};
  objectivePendingAwardStartTickByCpId = {};
  objectivePendingAwardStartAtSecByCpId = {};
  objectivePendingAwardDeadlineAtSecByCpId = {};
  objectivePendingAwardTeamByCpId = {};
  objectivePendingAwardTokenByCpId = {};
  objectiveDestroyExplosionPositionByCpId = {};
  resetObjectiveSuccessfulArmContextState();
  HideAllObjectiveHoldProgressUi();
  HideAllDeployObjectiveTimerUi();

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const cp = serverCapturePoints[cpId];

    objectiveCaptureInteractEnabledByCpId[cpId] = false;
    objectiveCaptureAttemptEnabledByCpId[cpId] = false;
    objectiveCaptureAttemptTeamByCpId[cpId] = teamNeutral;
    objectiveCaptureAttemptKindByCpId[cpId] = "arm";
    objectiveCaptureAttemptTokenByCpId[cpId] = 0;
    objectiveCaptureAttemptStartTickByCpId[cpId] = undefined;
    objectiveCaptureAttemptStartAtSecByCpId[cpId] = undefined;
    objectiveCaptureAttemptPlayerIdByCpId[cpId] = undefined;
    objectivePendingAwardStartTickByCpId[cpId] = undefined;
    objectivePendingAwardStartAtSecByCpId[cpId] = undefined;
    objectivePendingAwardDeadlineAtSecByCpId[cpId] = undefined;
    objectivePendingAwardTeamByCpId[cpId] = teamNeutral;
    objectivePendingAwardTokenByCpId[cpId] = undefined;
    objectiveDestroyExplosionPositionByCpId[cpId] = undefined;
    if (!cp) continue;
    (cp as any)._capturingTeam = teamNeutral;
    (cp as any)._captureProgress = 0;
    (cp as any)._previousCaptureProgress = 0;
    applyObjectiveLockedCaptureTiming(cpId);
  }

  if (audioInitialized) ensureObjectiveMcomSfxSpawned();
}

function EvaluatePostCaptureAwardTimers(): void {
  if (gameStatus !== 3) return;
  updateObjectiveArmedWorldIconCountdowns();
}

function getObjectiveArmingTeam(cpId: number): mod.Team {
  return getOpposingTeam(getObjectiveDefendingTeamForCurrentHalf(cpId));
}

function getCipherCarrierAttackingTeam(playerId: number): mod.Team {
  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return teamNeutral;
  const team = mod.GetTeam(sp.player);
  return mod.Equals(team, team1) || mod.Equals(team, team2) ? team : teamNeutral;
}

function beginObjectiveDestroyPresentationAfterSecondKey(cpId: number, attackingTeam: mod.Team): void {
  if (mod.Equals(attackingTeam, teamNeutral)) return;
  if (isObjectivePendingAwardActive(cpId)) return;

  captureObjectiveDestroyExplosionPositionForCp(cpId);
  objectivePendingAwardStartTickByCpId[cpId] = serverTickCount;
  const pendingStartAtSec = getCurrentSchedulerNowSeconds();
  objectivePendingAwardStartAtSecByCpId[cpId] = pendingStartAtSec;
  objectivePendingAwardDeadlineAtSecByCpId[cpId] = pendingStartAtSec + OBJECTIVE_SCORE_HOLD_SECONDS;
  objectivePendingAwardTeamByCpId[cpId] = attackingTeam;
  objectivePendingAwardTokenByCpId[cpId] = (objectivePendingAwardTokenByCpId[cpId] ?? 0) + 1;
  const pendingToken = objectivePendingAwardTokenByCpId[cpId] ?? 0;

  const cp = serverCapturePoints[cpId];
  if (cp) {
    (cp as any)._capturingTeam = teamNeutral;
    (cp as any)._captureProgress = 0;
    (cp as any)._previousCaptureProgress = 0;
    cp.clearOnPoint();
  }

  safeEnableCapturePointObjectiveByCpId(cpId, false, "beginObjectiveDestroyPresentationAfterSecondKey", true);
  safeEnableObjectiveMcomByCpId(cpId, false, "beginObjectiveDestroyPresentationAfterSecondKey", true);
  setObjectiveCaptureInteractEnabled(cpId, false);
  syncObjectiveArmedPendingVisualStateForCp(cpId);
  UpdateObjectiveArmAlarmSfxState();
  updateCipherCounterWorldIconForCp(cpId, true);
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
  void completeObjectiveDestroyPresentationAfterDelay(cpId, attackingTeam, pendingToken);
}

async function completeObjectiveDestroyPresentationAfterDelay(
  cpId: number,
  attackingTeam: mod.Team,
  token: number
): Promise<void> {
  const deadlineAtSec =
    objectivePendingAwardDeadlineAtSecByCpId[cpId] ??
    (getCurrentSchedulerNowSeconds() + OBJECTIVE_SCORE_HOLD_SECONDS);
  const waitSeconds = mod.Max(0, deadlineAtSec - getCurrentSchedulerNowSeconds());
  await mod.Wait(waitSeconds);
  if (gameStatus !== 3) return;
  if (objectivePendingAwardTokenByCpId[cpId] !== token) return;
  if (!mod.Equals(objectivePendingAwardTeamByCpId[cpId] ?? teamNeutral, attackingTeam)) return;
  if (isObjectiveDisabledAfterAward(cpId)) return;

  handleObjectiveDestroySuccess(cpId, attackingTeam);
  resolvePendingCipherScoreTransitionIfReady();
  logObjectiveDelayedAward(
    mod.Message("[OBJECTIVE AWARD] timed success cp/token {}", String(cpId) + "/" + String(token))
  );
}

function clearCipherCarrierAfterDelivery(playerId: number | undefined): void {
  if (playerId !== undefined) {
    const carrier = serverPlayers.get(playerId);
    if (carrier && mod.IsPlayerValid(carrier.player)) {
      const replacedSlot = bombCarrierReplacedSlotByPlayerId[playerId];
      const previousEquipment = bombCarrierPreviousEquipmentByPlayerId[playerId];
      restoreBombCarrierInventoryForPlayer(
        playerId,
        carrier.player,
        replacedSlot,
        previousEquipment,
        "cipher_key_delivered"
      );
    }
  }

  clearBombCarrierState();
  invalidateBombReturnToBaseTimer();
  setBombPickupTriggerEnabled(false);
  setBombBaseAvailabilityState(false);
  clearBombBaseRuntimeLootSpawner();
  clearDroppedBombRuntimeObjects();
}

function addCipherScore(attackingTeam: mod.Team): void {
  if (mod.Equals(attackingTeam, team1)) {
    serverScores[0] += 1;
    cipherHalfScores[0] += 1;
  } else if (mod.Equals(attackingTeam, team2)) {
    serverScores[1] += 1;
    cipherHalfScores[1] += 1;
  }
}

function getCipherTeamScoreIndex(team: mod.Team): number {
  if (mod.Equals(team, team1)) return 0;
  if (mod.Equals(team, team2)) return 1;
  return -1;
}

function willCipherScoreTriggerPhaseTransition(scoringTeam: mod.Team): boolean {
  if (mod.Equals(scoringTeam, teamNeutral)) return false;
  if (cipherMatchStage === "suddenDeath") return true;
  if (getCipherTeamTotalScore(scoringTeam) >= WIN_SCORE) return true;

  const scoreIndex = getCipherTeamScoreIndex(scoringTeam);
  if (scoreIndex < 0) return false;
  return cipherHalfScores[scoreIndex] >= HALF_SCORE_CAP;
}

function finalizePendingObjectiveAwardsForImmediateTransition(context: string): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (!isObjectivePendingAwardActive(cpId)) continue;
    const pendingTeam = objectivePendingAwardTeamByCpId[cpId] ?? teamNeutral;
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", false);
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", false);
    handleObjectiveDestroySuccess(cpId, pendingTeam);
    logObjectiveDelayedAward(
      mod.Message("[OBJECTIVE AWARD] immediate transition finalize cp/context {}", String(cpId) + "/" + context)
    );
  }
}

function handleCipherKeyDelivery(cpId: number, carrierPlayerId: number | undefined, attackingTeam: mod.Team): void {
  if (gameStatus !== 3) return;
  if (isObjectiveDisabledAfterAward(cpId)) return;
  if (mod.Equals(attackingTeam, teamNeutral)) return;

  const cp = serverCapturePoints[cpId];
  if (!cp) return;

  const currentCount = getCipherObjectiveKeyCount(cpId);
  if (currentCount >= CIPHER_KEYS_TO_DESTROY_OBJECTIVE) return;

  const symbol = getObjectiveLaneSymbol(cpId, cp.symbol);
  const deliveryPlayer = carrierPlayerId !== undefined ? serverPlayers.get(carrierPlayerId) : undefined;
  const nextCount = currentCount + 1;

  setCipherObjectiveKeyCount(cpId, nextCount);
  if (carrierPlayerId !== undefined) {
    recordObjectiveSuccessfulArmContext(cpId, carrierPlayerId);
  }
  addCipherScore(attackingTeam);
  const scoreTriggersPhaseTransition = willCipherScoreTriggerPhaseTransition(attackingTeam);

  if (deliveryPlayer) {
    deliveryPlayer.addScore(150);
    deliveryPlayer.addArmed();
  }

  if (modlib.Equals(attackingTeam, team1)) {
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveArmed, symbol), team1);
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveArmedEnemy, symbol), team2);
  } else if (modlib.Equals(attackingTeam, team2)) {
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveArmed, symbol), team2);
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveArmedEnemy, symbol), team1);
  }

  if (carrierPlayerId !== undefined) {
    const deliveryPos = getPlayerResolvedDropPosition(carrierPlayerId);
    playObjectiveAttemptCompletionSfxForPlayer(carrierPlayerId, "arm", deliveryPos);
  }

  playObjectiveOutcomeVoForTeams("arm", attackingTeam, symbol);
  clearCipherCarrierAfterDelivery(carrierPlayerId);
  updateCipherCounterWorldIconForCp(cpId, true);

  if (nextCount >= CIPHER_KEYS_TO_DESTROY_OBJECTIVE) {
    if (scoreTriggersPhaseTransition) {
      handleObjectiveDestroySuccess(cpId, attackingTeam);
    } else {
      beginObjectiveDestroyPresentationAfterSecondKey(cpId, attackingTeam);
    }
  }

  if (!scoreTriggersPhaseTransition) {
    scheduleDeferredBombRespawnAfterDelay(
      CIPHER_KEY_DELIVERY_RESPAWN_DELAY_SECONDS,
      "cipher_key_delivered_cp_" + String(cpId),
      "new_location_found"
    );
  }

  UpdateScoreboard();
  SetUIScores();
  ClampTicketsAndMaybeEndMatch();
  evaluateCipherMatchProgressAfterScore(attackingTeam);
  syncLiveHybridObjectiveSurfaceState("handleCipherKeyDelivery", true);
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

function tryDeliverCipherKeyForCarrierAtObjective(playerId: number, cpId: number): boolean {
  if (gameStatus !== 3) return false;
  if (bombCarrierPlayerId !== playerId) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (getCipherObjectiveKeyCount(cpId) >= CIPHER_KEYS_TO_DESTROY_OBJECTIVE) return false;
  if (!isPlayerInsideObjectiveAreaForCp(playerId, cpId)) return false;

  const attackingTeam = getCipherCarrierAttackingTeam(playerId);
  if (mod.Equals(attackingTeam, teamNeutral)) return false;
  if (mod.Equals(attackingTeam, getObjectiveDefendingTeamForCurrentHalf(cpId))) return false;

  handleCipherKeyDelivery(cpId, playerId, attackingTeam);
  return true;
}

function tryDeliverCipherKeyFromAreaTrigger(playerId: number, triggerId: number): boolean {
  const cpId = OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID[triggerId];
  if (cpId === undefined) return false;
  return tryDeliverCipherKeyForCarrierAtObjective(playerId, cpId);
}

function tryDeliverCipherKeyFromActiveObjectiveAreaForCarrier(playerId: number): boolean {
  const activeTriggers = objectiveAreaActiveTriggersByPlayerId[playerId];
  if (!activeTriggers) return false;

  const lastTriggerId = objectiveAreaLastEnteredTriggerByPlayerId[playerId];
  if (lastTriggerId !== undefined && tryDeliverCipherKeyFromAreaTrigger(playerId, lastTriggerId)) {
    return true;
  }

  for (const triggerIdKey in activeTriggers) {
    if (activeTriggers[triggerIdKey] !== true) continue;
    if (tryDeliverCipherKeyFromAreaTrigger(playerId, Number(triggerIdKey))) return true;
  }

  return false;
}

function handleObjectiveArmSuccess(cpId: number, armerId: number | undefined): void {
  const deliveredByTeam = armerId !== undefined ? getCipherCarrierAttackingTeam(armerId) : getObjectiveArmingTeam(cpId);
  handleCipherKeyDelivery(cpId, armerId, deliveredByTeam);
}

function handleObjectiveDefuseSuccess(cpId: number, defuserId: number | undefined): void {
  if (gameStatus !== 3) return;
  if (isObjectiveDisabledAfterAward(cpId)) return;

  const cp = serverCapturePoints[cpId];
  const def = getObjectiveDef(cpId);
  if (!cp || !def) return;
  const defendingTeam = getObjectiveDefendingTeamForCurrentHalf(cpId);

  const hadPending = isObjectivePendingAwardActive(cpId);
  const symbol = getObjectiveLaneSymbol(cpId, cp.symbol);
  const defuser = defuserId !== undefined ? serverPlayers.get(defuserId) : undefined;
  const attemptOutcomePos =
    defuserId !== undefined ? getPlayerResolvedDropPosition(defuserId) : tryGetObjectiveMcomPosition(cpId);

  clearObjectivePendingAward(cpId);
  clearCaptureCredit(cpId);

  (cp as any)._capturingTeam = teamNeutral;
  (cp as any)._captureProgress = 0;
  (cp as any)._previousCaptureProgress = 0;

  stopObjectiveMcomAttemptLoopSfxForCp(cpId);
  if (defuser && mod.IsPlayerValid(defuser.player)) {
    stopObjectiveAttemptLocalArmingSfxForPlayer(defuser.player);
    stopObjectiveAttemptLocalDefusingSfxForPlayer(defuser.player);
  }

  playObjectiveOutcomeVoForTeams("defuse", defendingTeam, symbol);
  playObjectiveAttemptCompletionSfxForPlayer(defuserId, "defused", attemptOutcomePos);
  if (defuser && mod.IsPlayerValid(defuser.player)) {
    playObjectiveAttemptLocalSfx(defuser.player, "defused");
  }

  if (defuser) {
    defuser.addScore(150);
  }

  if (hadPending) {
    invalidateDeferredBombSpawnTimer();
    const transferred = defuserId !== undefined ? transferBombToPlayerAsCarrierAfterDisarm(defuserId) : false;
    if (!transferred) {
      scheduleDeferredBombRespawnAfterDelay(0, "objective_defused_cp_" + String(cpId), "new_location_found", true);
    }
  }

  clearObjectiveSuccessfulArmContext(cpId);

  if (isRoutingCpId(cpId)) markHqRoutingDirty();

  syncObjectiveArmedPendingVisualStateForCp(cpId);
  syncLiveHybridObjectiveSurfaceState("handleObjectiveDefuseSuccess", true);
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

function handleObjectiveDestroySuccess(cpId: number, ownerTeam: mod.Team): void {
  if (gameStatus !== 3) return;
  if (isObjectiveDisabledAfterAward(cpId)) return;

  const cp = serverCapturePoints[cpId];
  if (!cp) return;

  if (mod.Equals(ownerTeam, teamNeutral)) return;

  const symbol = getObjectiveLaneSymbol(cpId, cp.symbol);
  const destroyedCreditPlayerId = objectiveLastSuccessfulArmerPlayerIdByCpId[cpId];
  const destroyedCreditPlayer =
    destroyedCreditPlayerId !== undefined ? serverPlayers.get(destroyedCreditPlayerId) : undefined;

  if (destroyedCreditPlayer) {
    destroyedCreditPlayer.addDestroyed();
    destroyedCreditPlayer.addScore(150);
  }

  UpdateScoreboard();
  disableObjectiveAfterAwardSuccess(cpId, ownerTeam);

  if (modlib.Equals(ownerTeam, team1)) {
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveDestroyed, symbol), team1);
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveDestroyedEnemy, symbol), team2);
  } else if (modlib.Equals(ownerTeam, team2)) {
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveDestroyed, symbol), team2);
    modlib.ShowHighlightedGameModeMessage(mod.Message(mod.stringkeys.ObjectiveDestroyedEnemy, symbol), team1);
  }

  playObjectiveOutcomeVoForTeams("destroyed", ownerTeam, symbol);
  updateCipherCounterWorldIconForCp(cpId, true);
  SetUIScores();
  ClampTicketsAndMaybeEndMatch();
  playObjectiveAwardSuccessSfxToAll();

  if (isRoutingCpId(cpId)) markHqRoutingDirty();
  syncLiveHybridObjectiveSurfaceState("handleObjectiveDestroySuccess", true);
}

function UpdateObjectiveArmAlarmSfxState(): void {
  if (gameStatus !== 3) {
    StopAllObjectiveMcomSfx();
    return;
  }

  const nowSec = getCurrentSchedulerNowSeconds();
  const useEngineSeconds = USE_ENGINE_TIME_SCHEDULER && currentFrameHasEngineNowSec;
  const leadoutTicks = OBJECTIVE_AWARD_ALARM_LEADOUT_SECONDS * TICK_RATE;

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const pendingTeam = objectivePendingAwardTeamByCpId[cpId] ?? teamNeutral;
    const pendingStartTick = objectivePendingAwardStartTickByCpId[cpId];
    const pendingStartAtSec = objectivePendingAwardStartAtSecByCpId[cpId];
    const pendingDeadlineAtSec = objectivePendingAwardDeadlineAtSecByCpId[cpId];
    const pendingToken = objectivePendingAwardTokenByCpId[cpId];

    let enableSimple = false;
    let enableLeadout = false;

    if (
      (pendingStartTick !== undefined || pendingStartAtSec !== undefined) &&
      pendingToken !== undefined &&
      !mod.Equals(pendingTeam, teamNeutral)
    ) {
      if (pendingDeadlineAtSec !== undefined) {
        const remainingSec = pendingDeadlineAtSec - nowSec;
        if (remainingSec > 0) {
          if (remainingSec > OBJECTIVE_AWARD_ALARM_LEADOUT_SECONDS) enableSimple = true;
          else enableLeadout = true;
        }
      } else if (useEngineSeconds && pendingStartAtSec !== undefined) {
        const elapsedSec = nowSec - pendingStartAtSec;
        const remainingSec = OBJECTIVE_SCORE_HOLD_SECONDS - elapsedSec;
        if (remainingSec > 0) {
          if (remainingSec > OBJECTIVE_AWARD_ALARM_LEADOUT_SECONDS) enableSimple = true;
          else enableLeadout = true;
        }
      } else if (pendingStartTick !== undefined) {
        const elapsed = serverTickCount - pendingStartTick;
        const remaining = OBJECTIVE_SCORE_HOLD_TICKS - elapsed;
        if (remaining > 0) {
          if (remaining > leadoutTicks) enableSimple = true;
          else enableLeadout = true;
        }
      }
    }

    setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", enableSimple);
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", enableLeadout);
  }
}

function isObjectiveCpId(cpId: number): boolean {
  return getObjectiveDef(cpId) !== undefined;
}

function isRoutingCpId(cpId: number): boolean {
  const def = getObjectiveDef(cpId);
  return def ? def.countsForRouting : false;
}

function getObjectiveLaneForCpId(cpId: number): ObjectiveLetter | null {
  const def = getObjectiveDef(cpId);
  return def ? def.lane : null;
}

function getObjectiveDisplayLaneForCpId(cpId: number): ObjectiveLetter | null {
  const def = getObjectiveDef(cpId);
  return def ? def.displayLane : null;
}

function isFriendlyHudSlot(lane: TopHudLane): boolean {
  return lane === "A" || lane === "B";
}

function getHudCpIdForViewerLane(viewerTeam: mod.Team, lane: TopHudLane): number {
  if (mod.Equals(viewerTeam, team1)) {
    if (lane === "A") return CP_A_ID;
    if (lane === "B") return CP_B_ID;
    if (lane === "E") return CP_T2_B_ID;
    return CP_T2_C_ID;
  }

  if (mod.Equals(viewerTeam, team2)) {
    if (lane === "A") return CP_T2_B_ID;
    if (lane === "B") return CP_T2_C_ID;
    if (lane === "E") return CP_A_ID;
    return CP_B_ID;
  }

  if (lane === "A") return CP_A_ID;
  if (lane === "B") return CP_B_ID;
  if (lane === "E") return CP_T2_B_ID;
  return CP_T2_C_ID;
}

function getHudDisplayLetterForViewerLane(viewerTeam: mod.Team, lane: TopHudLane): ObjectiveLetter {
  const cpId = getHudCpIdForViewerLane(viewerTeam, lane);
  const laneFromDef = getObjectiveDisplayLaneForCpId(cpId);
  if (laneFromDef) return laneFromDef;
  return lane;
}

function getHudColorForViewerLane(_viewerTeam: mod.Team, lane: TopHudLane): mod.Vector {
  void _viewerTeam;
  return isFriendlyHudSlot(lane) ? COLOR_FRIENDLY : COLOR_ENEMY;
}

function getObjectiveLaneBaseColor(lane: ObjectiveLetter): mod.Vector {
  return lane === "A" || lane === "B" ? COLOR_FRIENDLY : COLOR_ENEMY;
}

function isObjectiveLetter(value: string): value is ObjectiveLetter {
  return value === "A" || value === "B" || value === "C" || value === "D" || value === "E" || value === "F";
}

function getObjectiveLaneSymbol(cpId: number, fallbackSymbol: string): ObjectiveLetter {
  const lane = getObjectiveDisplayLaneForCpId(cpId);
  if (lane) return lane;
  if (isObjectiveLetter(fallbackSymbol)) return fallbackSymbol;
  return "A";
}

function getFlagStringKey(lane: ObjectiveLetter): any {
  if (lane === "A") return mod.stringkeys.FLAGA;
  if (lane === "B") return mod.stringkeys.FLAGB;
  if (lane === "C") return mod.stringkeys.FLAGC;
  if (lane === "D") return mod.stringkeys.FLAGD;
  if (lane === "E") return mod.stringkeys.FLAGE;
  return mod.stringkeys.FLAGF;
}

const TOP_HUD_FLAG_FILL_BASE_ALPHA = 0.5;
const TOP_HUD_FLAG_TEXT_BASE_ALPHA = 1.0;
const TOP_HUD_FLAG_OUTLINE_BASE_ALPHA = 1.0;
const TOP_HUD_ARMED_PULSE_MIN_MULTIPLIER = 0.55;
const TOP_HUD_ARMED_PULSE_MAX_MULTIPLIER = 1.0;
const TOP_HUD_ARMED_PULSE_PERIOD_SECONDS = 1.1;
const TOP_HUD_ARMED_COLOR_FLIP_INTERVAL_SECONDS = 1.0;

function getTopHudArmedPulseMultiplier(): number {
  const tSeconds = serverTickCount / TICK_RATE;
  const phase = tSeconds * ((2 * mod.Pi()) / TOP_HUD_ARMED_PULSE_PERIOD_SECONDS);
  const wave = (mod.SineFromRadians(phase) + 1) / 2;
  return TOP_HUD_ARMED_PULSE_MIN_MULTIPLIER +
    (TOP_HUD_ARMED_PULSE_MAX_MULTIPLIER - TOP_HUD_ARMED_PULSE_MIN_MULTIPLIER) * wave;
}

function getTopHudObjectiveAlphaMultiplier(cpId: number): number {
  if (getCipherObjectiveKeyCount(cpId) >= CIPHER_KEYS_TO_DESTROY_OBJECTIVE) return 1.0;
  if (isObjectiveDisabledAfterAward(cpId)) return 1.0;
  if (isObjectivePendingAwardActive(cpId)) return getTopHudArmedPulseMultiplier();
  return 1.0;
}

function getObjectivePendingAwardStartSeconds(cpId: number): number | undefined {
  const startAtSec = objectivePendingAwardStartAtSecByCpId[cpId];
  if (startAtSec !== undefined && Number.isFinite(startAtSec)) return startAtSec;

  const startTick = objectivePendingAwardStartTickByCpId[cpId];
  if (startTick !== undefined && Number.isFinite(startTick)) {
    return startTick / TICK_RATE;
  }

  return undefined;
}

function getTopHudArmedFlipFlopIsNeutral(cpId: number, nowSec?: number): boolean {
  const startSec = getObjectivePendingAwardStartSeconds(cpId);
  if (startSec === undefined) return true;

  const sampleNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  let elapsed = sampleNowSec - startSec;
  if (!Number.isFinite(elapsed) || elapsed < 0) elapsed = 0;

  const phaseIndex = mod.Floor(elapsed / TOP_HUD_ARMED_COLOR_FLIP_INTERVAL_SECONDS);
  return mod.Modulo(phaseIndex, 2) === 0;
}

function getTopHudObjectiveDisplayColor(cpId: number, laneColor: mod.Vector, nowSec?: number): mod.Vector {
  if (getCipherObjectiveKeyCount(cpId) >= CIPHER_KEYS_TO_DESTROY_OBJECTIVE) return COLOR_NEUTRAL;
  if (isObjectiveDisabledAfterAward(cpId)) return COLOR_NEUTRAL;
  if (isObjectivePendingAwardActive(cpId)) {
    return getTopHudArmedFlipFlopIsNeutral(cpId, nowSec) ? COLOR_NEUTRAL : laneColor;
  }
  return laneColor;
}

let objectiveConfigWarningShown = false;

function ValidateObjectiveConfiguration(): void {
  if (objectiveConfigWarningShown) return;

  const missingDefs: number[] = [];
  const missingWrappers: number[] = [];
  const idMismatches: string[] = [];
  const missingMcomIds: number[] = [];
  const mcomIdAliases: string[] = [];
  const duplicateConfiguredMcomIds: number[] = [];
  const authoredSectorMismatches: string[] = [];
  const hqProtectionTriggerMismatches: string[] = [];
  const hqProtectionTriggerCollisions: string[] = [];
  const seenConfiguredMcomIds: { [mcomId: number]: boolean } = {};

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const mcomId = OBJECTIVE_DEFINITIONS[i].mcomId;
    if (seenConfiguredMcomIds[mcomId] === true) {
      if (duplicateConfiguredMcomIds.indexOf(mcomId) < 0) {
        duplicateConfiguredMcomIds.push(mcomId);
      }
      continue;
    }
    seenConfiguredMcomIds[mcomId] = true;
  }

  for (let i = 0; i < ALL_OBJECTIVE_CP_IDS.length; i++) {
    const cpId = ALL_OBJECTIVE_CP_IDS[i];
    const def = objectiveDefByCpId[cpId];
    if (!def) {
      missingDefs.push(cpId);
      continue;
    }

    if (!def.mcomId || objectiveDefByMcomId[def.mcomId] !== def) {
      missingMcomIds.push(cpId);
    } else {
      try {
        const resolvedMcomId = getObjectiveResolvedMcomIdByCpId(cpId) ?? mod.GetObjId(mod.GetMCOM(def.mcomId));
        if (resolvedMcomId !== def.mcomId) {
          mcomIdAliases.push(def.cpId + ":" + def.mcomId + "->" + resolvedMcomId);
        }
      } catch (_err) {
        mcomIdAliases.push(def.cpId + ":" + def.mcomId + "->unresolved");
      }
    }

    const cp = serverCapturePoints[cpId];
    if (!cp) {
      missingWrappers.push(cpId);
      continue;
    }

    let resolvedId = -1;
    try {
      resolvedId = mod.GetObjId(cp.capturePoint);
    } catch (_err) {
      idMismatches.push(cpId + "->unresolved");
      continue;
    }
    if (resolvedId !== cpId) {
      idMismatches.push(cpId + "->" + resolvedId);
    }
  }

  const authoredSectorIds = [
    AUTHORED_OBJECTIVE_NATIVE_SECTOR_ID,
    AUTHORED_LEGACY_CAPTURE_POINT_SECTOR_ID,
  ];
  for (let i = 0; i < authoredSectorIds.length; i++) {
    const sectorId = authoredSectorIds[i];
    try {
      const resolvedSectorId = mod.GetObjId(mod.GetSector(sectorId));
      if (resolvedSectorId !== sectorId) {
        authoredSectorMismatches.push(sectorId + "->" + resolvedSectorId);
      }
    } catch (_err) {
      authoredSectorMismatches.push(sectorId + "->unresolved");
    }
  }

  const hqProtectionChecks = [
    { label: "t1", id: TEAM1_HQ_PROTECTION_TRIGGER_ID },
    { label: "t2", id: TEAM2_HQ_PROTECTION_TRIGGER_ID },
  ];
  for (let i = 0; i < hqProtectionChecks.length; i++) {
    const check = hqProtectionChecks[i];
    if (EXPECTED_OBJECTIVE_MCOM_IDS.indexOf(check.id) >= 0) {
      const cpId = OBJECTIVE_CP_ID_BY_MCOM_ID[check.id];
      hqProtectionTriggerCollisions.push(
        check.label + ":" + check.id + "->mcom_cp_" + String(cpId ?? -1)
      );
    }

    try {
      const resolvedTriggerId = mod.GetObjId(mod.GetAreaTrigger(check.id));
      if (resolvedTriggerId !== check.id) {
        hqProtectionTriggerMismatches.push(check.label + ":" + check.id + "->" + resolvedTriggerId);
      }
    } catch (_err) {
      hqProtectionTriggerMismatches.push(check.label + ":" + check.id + "->unresolved");
    }
  }

  if (
    missingDefs.length === 0 &&
    missingWrappers.length === 0 &&
    idMismatches.length === 0 &&
    missingMcomIds.length === 0 &&
    duplicateConfiguredMcomIds.length === 0 &&
    authoredSectorMismatches.length === 0 &&
    hqProtectionTriggerMismatches.length === 0 &&
    hqProtectionTriggerCollisions.length === 0
  ) {
    if (mcomIdAliases.length > 0) {
      emitObjectiveNativeEventFlow(
        mod.Message("[OBJECTIVE MCOM ALIAS] cp/lane/configured/resolved/context {}", mcomIdAliases.join(","))
      );
    }
    return;
  }

  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  objectiveConfigWarningShown = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[OBJECTIVE CONFIG] CP defs/wrappers/mismatches {} | MCOM ids/mismatches/dupes {}",
      (missingDefs.length > 0 ? missingDefs.join(",") : "none") +
        "/" +
        (missingWrappers.length > 0 ? missingWrappers.join(",") : "none") +
        "/" +
        (idMismatches.length > 0 ? idMismatches.join(",") : "none"),
      (missingMcomIds.length > 0 ? missingMcomIds.join(",") : "none") +
        "/" +
        (mcomIdAliases.length > 0 ? mcomIdAliases.join(",") : "none") +
        "/" +
        (duplicateConfiguredMcomIds.length > 0 ? duplicateConfiguredMcomIds.join(",") : "none")
    )
  );
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[OBJECTIVE AUTHORING] sectors {} | HQ triggers/mismatches/collisions {}",
      authoredSectorMismatches.length > 0 ? authoredSectorMismatches.join(",") : "none",
      (hqProtectionTriggerMismatches.length > 0 ? hqProtectionTriggerMismatches.join(",") : "none") +
        "/" +
        (hqProtectionTriggerCollisions.length > 0 ? hqProtectionTriggerCollisions.join(",") : "none")
    )
  );
}

function registerObjectivesDeterministically(): void {
  // Non-live phases keep the capture-point/interact layer inert. Live re-enables CP objectives separately.
  disableAllObjectiveCapturePointObjectives("registerObjectivesDeterministically");
  disableAllNeutralObjectiveCapturePointObjectives("registerObjectivesDeterministically");
  disableAllObjectiveInteractPoints("registerObjectivesDeterministically");
}

function applyObjectiveRoundStartOwnership(resetRoundState: boolean = true): void {
  if (resetRoundState) {
    captureCreditByCpId = {};
  }

  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  seedObjectiveNativeMcomState("applyObjectiveRoundStartOwnership");
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  disableAllObjectiveCapturePointObjectives("applyObjectiveRoundStartOwnership");
  disableAllNeutralObjectiveCapturePointObjectives("applyObjectiveRoundStartOwnership");
  disableAllObjectiveInteractPoints("applyObjectiveRoundStartOwnership");

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    const cp = serverCapturePoints[def.cpId];
    if (!cp) continue;

    applyObjectiveLockedCaptureTiming(def.cpId);
    setObjectiveAuthoritativeOwner(def.cpId, getObjectiveDefendingTeamForCurrentHalf(def.cpId));
    clearObjectivePendingAward(def.cpId);

    (cp as any)._capturingTeam = teamNeutral;
    (cp as any)._captureProgress = 0;
    (cp as any)._previousCaptureProgress = 0;
    cp.clearOnPoint();
  }
}

function applyObjectiveLiveHybridRoundStartState(resetRoundState: boolean = true): void {
  if (resetRoundState) {
    captureCreditByCpId = {};
  }

  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  seedObjectiveNativeMcomState("applyObjectiveLiveHybridRoundStartState");
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  setObjectiveCapturePointObjectivesEnabled(true, "applyObjectiveLiveHybridRoundStartState");
  disableAllNeutralObjectiveCapturePointObjectives("applyObjectiveLiveHybridRoundStartState");
  setObjectiveNativeMcomObjectivesEnabled(false, "applyObjectiveLiveHybridRoundStartState");
  disableAllObjectiveInteractPoints("applyObjectiveLiveHybridRoundStartState");

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    const cp = serverCapturePoints[def.cpId];
    if (!cp) continue;

    applyObjectiveLockedCaptureTiming(def.cpId);
    setObjectiveAuthoritativeOwner(
      def.cpId,
      getObjectiveDefendingTeamForCurrentHalf(def.cpId),
      "applyObjectiveLiveHybridRoundStartState"
    );
    clearObjectivePendingAward(def.cpId);

    (cp as any)._capturingTeam = teamNeutral;
    (cp as any)._captureProgress = 0;
    (cp as any)._previousCaptureProgress = 0;
    cp.clearOnPoint();
  }

  syncLiveHybridObjectiveSurfaceState("applyObjectiveLiveHybridRoundStartState");
}

async function reassertObjectiveOwnershipShortlyAfterLiveStart(): Promise<void> {
  await mod.Wait(0.2);
  if (gameStatus !== 3) return;
  applyObjectiveLiveHybridRoundStartState(false);
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

function UpdateThreatenedFlagsFromEngineTruth(): void {
  if (!ENABLE_DYNAMIC_HQ_ROUTING) {
    threatenedFlagForTeam1 = null;
    threatenedFlagForTeam2 = null;
    return;
  }

  threatenedFlagForTeam1 = null;
  threatenedFlagForTeam2 = null;

  let bestT1Prog = -1;
  let bestT2Prog = -1;

  ROUTING_OBJECTIVE_CP_IDS.forEach((cpId) => {
    const cp = serverCapturePoints[cpId];
    if (!cp) return;

    const owner = cp.getOwner();
    const prog = cp.getCaptureProgress();

    // only care when progress is actually moving away from the owner (i.e., in the band)
    if (!(prog > PROGRESS_EMPTY && prog < PROGRESS_FULL)) return;

    const on = cp.getOnPoint();
    const majority =
      on[0] > on[1] ? team1 :
      on[1] > on[0] ? team2 :
      teamNeutral;

    // Team1-owned flag being taken by Team2 majority
    if (mod.Equals(owner, team1) && mod.Equals(majority, team2)) {
      if (prog > bestT1Prog) {
        bestT1Prog = prog;
        threatenedFlagForTeam1 = cp.id;
      }
    }

    // Team2-owned flag being taken by Team1 majority
    if (mod.Equals(owner, team2) && mod.Equals(majority, team1)) {
      if (prog > bestT2Prog) {
        bestT2Prog = prog;
        threatenedFlagForTeam2 = cp.id;
      }
    }
  });
}
function markHqRoutingDirty(): void {
  if (!ENABLE_DYNAMIC_HQ_ROUTING) return;
  hqRoutingDirty = true;
}
function refreshCapturePointsEngineStateForUI(): void {
  // Lightweight sampling for UI smoothness: progress + contested state.
  Object.values(serverCapturePoints).forEach((cp) => {
    cp.setCaptureProgress();
    UpdateCapturePointContestedState(cp);
  });
}

function recomputeThreatenedFlagsAndHqRouting(): void {
  if (!ENABLE_DYNAMIC_HQ_ROUTING) {
    UpdateFlagHQSpawns();
    hqRoutingDirty = false;
    return;
  }

  // Debounce: avoid doing this multiple times in the same tick if several events fire together.
  if (lastHqRoutingUpdateTick === phaseTickCount) return;
  lastHqRoutingUpdateTick = phaseTickCount;

  // Keep our cached CP state fresh before computing threatened flags / HQ.
  refreshCapturePointsEngineStateForUI();


  UpdateThreatenedFlagsFromEngineTruth();
  UpdateFlagHQSpawns();

  hqRoutingDirty = false;
}

function getSpawnersForTeamAndRoute(team: mod.Team, routeKey: DynamicRouteKey): number[] {
  return mod.Equals(team, team1) ? TEAM1_SPAWNERS_BY_ROUTE[routeKey] : TEAM2_SPAWNERS_BY_ROUTE[routeKey];
}

function getInitialSpawnPointObjIdForTeam(team: mod.Team): number {
  const hqId = getCipherLiveHqIdForTeam(team);
  const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(hqId);
  if (!canUseTransitionSpawnPointForTeam(team, spawnerObjId)) return 0;
  return spawnerObjId;
}

function getNoFlagHqIdForTeam(team: mod.Team): number {
  return mod.Equals(team, team1) ? TEAM1_NO_FLAG_HQ : TEAM2_NO_FLAG_HQ;
}

function getLiveSafeSpawnHqIdsForTeam(team: mod.Team): number[] {
  const ids = mod.Equals(team, team1) ? LIVE_SAFE_SPAWN_TEAM1_HQ_IDS : LIVE_SAFE_SPAWN_TEAM2_HQ_IDS;
  return ids;
}

function getLiveSafeSpawnPlayerSpawnerIdsForTeam(team: mod.Team): number[] {
  const ids = mod.Equals(team, team1)
    ? LIVE_SAFE_SPAWN_TEAM1_PLAYERSPAWNER_IDS
    : LIVE_SAFE_SPAWN_TEAM2_PLAYERSPAWNER_IDS;
  return ids;
}

function getLiveSafeSpawnPlayerSpawnerIdForHq(hqId: number): number {
  return HQ_TO_PLAYERSPAWNER_ID[hqId] ?? 0;
}

function getDefaultLiveSafeSpawnHqObjIdForTeam(team: mod.Team): number {
  return getCipherLiveHqIdForTeam(team);
}

function isValidLiveSafeSpawnHqIdForTeam(team: mod.Team, hqId: number): boolean {
  const ids = getLiveSafeSpawnHqIdsForTeam(team);
  for (let i = 0; i < ids.length; i++) {
    if (hqId === ids[i]) return true;
  }
  return false;
}

function isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team: mod.Team, spawnerId: number): boolean {
  const ids = getLiveSafeSpawnPlayerSpawnerIdsForTeam(team);
  for (let i = 0; i < ids.length; i++) {
    if (spawnerId === ids[i]) return true;
  }
  return false;
}

function canUseTransitionSpawnPointForTeam(team: mod.Team, spawnerObjId: number): boolean {
  if (!spawnerObjId) return false;
  if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return false;
  return tryGetSpawnPointPositionSafe(spawnerObjId) !== undefined;
}

function resolveInitialTransitionPlayerSpawnerObjIdForTeam(team: mod.Team): number {
  const initialHqId = mod.Equals(team, team1) ? TEAM1_INITIAL_HQ : TEAM2_INITIAL_HQ;
  const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(initialHqId);
  if (!canUseTransitionSpawnPointForTeam(team, spawnerObjId)) return 0;
  return spawnerObjId;
}

function trySpawnPlayerFromSpawnPointSafe(
  player: mod.Player,
  spawnerObjId: number,
  context: string
): boolean {
  if (!spawnerObjId) return false;
  try {
    mod.SpawnPlayerFromSpawnPoint(player, spawnerObjId);
    return true;
  } catch (err) {
    LogRuntimeError("SpawnPlayerFromSpawnPoint/" + context, err);
    return false;
  }
}

function sanitizeForcedSafeSpawnHqForTeam(team: mod.Team, hqId: number): number {
  if (isValidLiveSafeSpawnHqIdForTeam(team, hqId)) return hqId;
  return getDefaultLiveSafeSpawnHqObjIdForTeam(team);
}

function tryGetSpawnPointPositionSafe(spawnPointId: number): mod.Vector | undefined {
  try {
    return mod.GetObjectPosition(mod.GetSpawnPoint(spawnPointId));
  } catch (_err) {
    return undefined;
  }
}

function tryGetSpawnPointRotationSafe(spawnPointId: number): mod.Vector | undefined {
  try {
    return mod.GetObjectRotation(mod.GetSpawnPoint(spawnPointId) as unknown as mod.Object);
  } catch (_err) {
    return undefined;
  }
}

function warnTransitionSpawnOnce(key: string, message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (transitionSpawnWarnedByKey[key] === true) return;
  transitionSpawnWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(message);
}

function warnTransitionSpawnDebugOnce(key: string, message: any): void {
  if (!DEBUG_TRANSITION_SPAWN_DIAGNOSTICS) return;
  warnTransitionSpawnOnce(key, message);
}

function resetTransitionSpawnQueueState(clearWarnings: boolean = false): void {
  transitionSpawnRequestedByPlayerId = {};
  transitionSpawnLastAttemptTickByPlayerId = {};
  transitionSpawnInFlightByPlayerId = {};
  if (clearWarnings) transitionSpawnWarnedByKey = {};
}

function clearTransitionSpawnStateForPlayer(playerId: number): void {
  delete transitionSpawnRequestedByPlayerId[playerId];
  delete transitionSpawnInFlightByPlayerId[playerId];
  delete transitionSpawnLastAttemptTickByPlayerId[playerId];
}

function getTransitionSpawnQueueSnapshot(): string {
  let requestedCount = 0;
  let deployedCount = 0;
  let undeployedCount = 0;

  serverPlayers.forEach((sp) => {
    if (!sp) return;
    if (transitionSpawnRequestedByPlayerId[sp.id] === true) requestedCount += 1;
    if (sp.isDeployed) deployedCount += 1;
    else undeployedCount += 1;
  });

  return (
    "status=" +
    String(gameStatus) +
    "/inits=" +
    getInitializationFlagSummary() +
    "/requested=" +
    String(requestedCount) +
    "/deployed=" +
    String(deployedCount) +
    "/undeployed=" +
    String(undeployedCount)
  );
}

function requestTransitionSpawn(playerId: number, source: string): void {
  const sp = serverPlayers.get(playerId);
  if (!sp) return;
  if (!mod.IsPlayerValid(sp.player)) return;

  const team = mod.GetTeam(sp.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

  if (transitionSpawnRequestedByPlayerId[playerId] === true) return;
  transitionSpawnRequestedByPlayerId[playerId] = true;
  warnTransitionSpawnDebugOnce(
    "queued/" + source + "/" + String(playerId),
    mod.Message(
      "[TRANSITION SPAWN] queued player/source/snapshot {}",
      String(playerId) + "/" + source + "/" + getTransitionSpawnQueueSnapshot()
    )
  );
}

function requestTransitionSpawnForUndeployedTransitionPlayers(source: string): void {
  serverPlayers.forEach((sp) => {
    if (!sp) return;
    if (sp.isDeployed) return;
    requestTransitionSpawn(sp.id, source);
  });
}

function requestTransitionSpawnForAllTransitionPlayers(source: string): void {
  serverPlayers.forEach((sp) => {
    if (!sp) return;
    requestTransitionSpawn(sp.id, source);
  });
}

function processTransitionSpawnQueue(source: string): void {
  if (
    gameStatus !== 1 &&
    gameStatus !== 2 &&
    !(gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive))
  ) {
    return;
  }

  let requestedCount = 0;
  let spawnAttemptsThisTick = 0;

  serverPlayers.forEach((sp) => {
    if (!sp) return;
    if (spawnAttemptsThisTick >= CIPHER_SPAWN_JOBS_PER_TICK) return;
    const playerId = sp.id;
    if (transitionSpawnRequestedByPlayerId[playerId] !== true) return;
    requestedCount += 1;

    if (!mod.IsPlayerValid(sp.player)) return;

    if (sp.isDeployed) {
      handleCipherTransitionDeployedPlayer(playerId, sp.player, source + "_deployed");
      clearTransitionSpawnStateForPlayer(playerId);
      return;
    }

    const lastAttemptTick = transitionSpawnLastAttemptTickByPlayerId[playerId] ?? -999999;
    if (transitionSpawnInFlightByPlayerId[playerId] === true) {
      const inFlightTicks = serverTickCount - lastAttemptTick;
      if (inFlightTicks < TRANSITION_SPAWN_INFLIGHT_TIMEOUT_TICKS) {
        warnTransitionSpawnDebugOnce(
          "dedupe_inflight/" + source + "/" + String(playerId),
          mod.Message(
            "[TRANSITION SPAWN] dedupe in-flight player/source/snapshot {}",
            String(playerId) + "/" + source + "/" + getTransitionSpawnQueueSnapshot()
          )
        );
        return;
      }

      transitionSpawnInFlightByPlayerId[playerId] = false;
      warnTransitionSpawnDebugOnce(
        "inflight_timeout/" + source + "/" + String(playerId),
        mod.Message(
          "[TRANSITION SPAWN] in-flight timeout player/source/ticks/snapshot {}",
          String(playerId) +
            "/" +
            source +
            "/" +
            String(inFlightTicks) +
            "/" +
            getTransitionSpawnQueueSnapshot()
        )
      );
    }

    if (serverTickCount - lastAttemptTick < TRANSITION_SPAWN_MIN_RETRY_TICKS) {
      warnTransitionSpawnDebugOnce(
        "dedupe_tick/" + source + "/" + String(playerId),
        mod.Message(
          "[TRANSITION SPAWN] dedupe retry-window player/source/snapshot {}",
          String(playerId) + "/" + source + "/" + getTransitionSpawnQueueSnapshot()
        )
      );
      return;
    }

    const team = mod.GetTeam(sp.player);
    const spawnerObjId = getInitialSpawnPointObjIdForTeam(team);
    const teamId = modlib.getTeamId(team);
    warnTransitionSpawnDebugOnce(
      "attempt/" + source + "/" + String(playerId) + "/" + String(teamId) + "/" + String(spawnerObjId),
      mod.Message(
        "[TRANSITION SPAWN] attempt player/team/spawner/source/snapshot {}",
        String(playerId) +
          "/" +
          String(teamId) +
          "/" +
          String(spawnerObjId) +
          "/" +
          source +
          "/" +
          getTransitionSpawnQueueSnapshot()
      )
    );
    const spawnerPos = spawnerObjId ? tryGetSpawnPointPositionSafe(spawnerObjId) : undefined;
    if (!spawnerObjId || !spawnerPos) {
      warnTransitionSpawnOnce(
        "missing_spawner/" + source + "/" + String(playerId),
        mod.Message(
          "[TRANSITION SPAWN] missing spawner player/source/spawner/snapshot {}",
          String(playerId) + "/" + source + "/" + String(spawnerObjId) + "/" + getTransitionSpawnQueueSnapshot()
        )
      );
      return;
    }

    transitionSpawnInFlightByPlayerId[playerId] = true;
    transitionSpawnLastAttemptTickByPlayerId[playerId] = serverTickCount;
    spawnAttemptsThisTick += 1;
    requestCipherSpawnAnchorForPlayer(playerId, true);
    mod.SetRedeployTime(sp.player, 0);
    applyPhaseInputRestrictionsForPlayer(sp.player);
    const spawned = trySpawnPlayerFromSpawnPointSafe(
      sp.player,
      spawnerObjId,
      "transition_spawn_queue/" + source
    );
    if (!spawned) {
      transitionSpawnInFlightByPlayerId[playerId] = false;
      warnTransitionSpawnOnce(
        "spawn_fail/" + source + "/" + String(playerId),
        mod.Message(
          "[TRANSITION SPAWN] spawn failed player/source/snapshot {}",
          String(playerId) + "/" + source + "/" + getTransitionSpawnQueueSnapshot()
        )
      );
    }
  });

  let undeployedCount = 0;
  let undeployedRequestedCount = 0;
  serverPlayers.forEach((sp) => {
    if (!sp) return;
    if (sp.isDeployed) return;
    undeployedCount += 1;
    if (transitionSpawnRequestedByPlayerId[sp.id] === true) {
      undeployedRequestedCount += 1;
    }
  });

  if (requestedCount <= 0 && undeployedCount > 0 && undeployedRequestedCount <= 0) {
    warnTransitionSpawnOnce(
      "queue_drained_undeployed/" + source,
      mod.Message(
        "[TRANSITION SPAWN] queue drained with undeployed players source/snapshot {}",
        source + "/" + getTransitionSpawnQueueSnapshot()
      )
    );
  }
}

function validatePreLivePlayerTeamsFromEngine(): boolean {
  let valid = true;

  serverPlayers.forEach((sp) => {
    if (!sp) return;
    if (!mod.IsPlayerValid(sp.player)) return;

    const team = mod.GetTeam(sp.player);
    sp.setTeam();

    if (mod.Equals(team, team1) || mod.Equals(team, team2)) return;
    valid = false;

    if (preliveTeamSanityWarnedByPlayerId[sp.id] === true) return;
    preliveTeamSanityWarnedByPlayerId[sp.id] = true;

    warnTransitionSpawnOnce(
      "prelive_team_invalid/" + String(sp.id),
      mod.Message(
        "[TRANSITION TEAM SANITY] invalid player/team/status/inits {}",
        String(sp.id) +
          "/" +
          String(modlib.getTeamId(team)) +
          "/" +
          String(gameStatus) +
          "/" +
          getInitializationFlagSummary()
      )
    );
  });

  return valid;
}

function validatePreLiveTransitionSpawnPrerequisites(): boolean {
  const t1SpawnerObjId = getInitialSpawnPointObjIdForTeam(team1);
  const t2SpawnerObjId = getInitialSpawnPointObjIdForTeam(team2);
  const t1Ok = !!t1SpawnerObjId && tryGetSpawnPointPositionSafe(t1SpawnerObjId) !== undefined;
  const t2Ok = !!t2SpawnerObjId && tryGetSpawnPointPositionSafe(t2SpawnerObjId) !== undefined;
  if (t1Ok && t2Ok) return true;

  warnTransitionSpawnOnce(
    "prelive_prereq_missing",
    mod.Message(
      "[TRANSITION SPAWN] prelive prerequisite missing t1/t2/snapshot {}",
      String(t1SpawnerObjId) + "/" + String(t2SpawnerObjId) + "/" + getTransitionSpawnQueueSnapshot()
    )
  );
  return false;
}

function tryGetLiveSafeSpawnHqPositionSafe(hqId: number): mod.Vector | undefined {
  const spawnPointId = getLiveSafeSpawnPlayerSpawnerIdForHq(hqId);
  if (!spawnPointId) return undefined;
  return tryGetSpawnPointPositionSafe(spawnPointId);
}

function getStoredOrDefaultLiveSafeSpawnHqObjId(playerId: number, team: mod.Team): number {
  const stored = lastLiveHqSpawnPointObjIdByPlayerId[playerId];
  if (stored && isValidLiveSafeSpawnHqIdForTeam(team, stored)) return stored;
  return getDefaultLiveSafeSpawnHqObjIdForTeam(team);
}

function getAlternateLiveSafeSpawnHqObjId(team: mod.Team, currentHqId: number): number {
  const ids = getLiveSafeSpawnHqIdsForTeam(team);
  if (ids.length <= 1) return ids[0] ?? getDefaultLiveSafeSpawnHqObjIdForTeam(team);
  if (currentHqId === ids[0]) return ids[1];
  if (currentHqId === ids[1]) return ids[0];
  return ids[0];
}

function resolveForcedSafeSpawnHqObjId(playerId: number, team: mod.Team, nextUsed: number): number {
  const baseHqId = getStoredOrDefaultLiveSafeSpawnHqObjId(playerId, team);

  let chosenHqId = baseHqId;
  if (nextUsed > 1) {
    const previousForcedHqId = lastForcedSafeSpawnHqObjIdByPlayerId[playerId];
    const seedHqId =
      previousForcedHqId && isValidLiveSafeSpawnHqIdForTeam(team, previousForcedHqId)
        ? previousForcedHqId
        : baseHqId;
    chosenHqId = getAlternateLiveSafeSpawnHqObjId(team, seedHqId);
  }

  chosenHqId = sanitizeForcedSafeSpawnHqForTeam(team, chosenHqId);
  lastForcedSafeSpawnHqObjIdByPlayerId[playerId] = chosenHqId;
  return chosenHqId;
}

function recordLastLiveHqSpawnSourceFromDeploy(eventPlayer: mod.Player, playerId: number): void {
  if (!mod.IsPlayerValid(eventPlayer)) return;
  if (!isPlayerAliveSafe(eventPlayer)) return;

  const team = mod.GetTeam(eventPlayer);
  const playerPos = getPlayerPosition(eventPlayer);
  const hqIds = getLiveSafeSpawnHqIdsForTeam(team);

  let nearestHqId = 0;
  let nearestDistance = 999999;

  for (let i = 0; i < hqIds.length; i++) {
    const hqId = hqIds[i];
    const hqPos = tryGetLiveSafeSpawnHqPositionSafe(hqId);
    if (!hqPos) continue;

    const d = mod.DistanceBetween(playerPos, hqPos);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearestHqId = hqId;
    }
  }

  if (nearestHqId && nearestDistance <= LAST_HQ_RECORD_THRESHOLD_METERS) {
    lastLiveHqSpawnPointObjIdByPlayerId[playerId] = nearestHqId;
  }
}

function commitPendingDynamicHqForPlayer(playerId: number): void {
  const pending = pendingDynamicHqForPlayer[playerId];
  if (pending && isValidDynamicSpawnId(pending)) {
    lastDynamicHqForPlayer[playerId] = pending;
  }
  pendingDynamicHqForPlayer[playerId] = undefined;
}

/*
  Resolve a spawn ObjId from a specific route key.
  - Falls back to NO if the requested route has no spawners.
  - Returns 0 if nothing exists at all (defensive).
*/
function resolveSpawnerObjIdForRouteKey(playerId: number, team: mod.Team, routeKey: DynamicRouteKey): number {
  const list = getSpawnersForTeamAndRoute(team, routeKey);
  const finalList = list && list.length > 0 ? list : getSpawnersForTeamAndRoute(team, "NO");

  if (!finalList || finalList.length <= 0) return 0;

  const idx = safeSpawnSpawnerIndex[playerId] ?? 0;
  const chosen = finalList[idx % finalList.length];

  safeSpawnSpawnerIndex[playerId] = (idx + 1) % finalList.length;

  return chosen;
}

function HqDesyncCheckAndRecycle(eventPlayer: mod.Player, playerId: number): void {
  // If we're already in a safe-spawn recycle flow, don't add another recycle on top.
  if (safeSpawnUnsafePending[playerId] === true) return;
  if (safeSpawnForcedUndeploy[playerId] === true) return;

  const retries = hqDesyncForcedRedeploys[playerId] ?? 0;
  if (retries >= HQ_DESYNC_MAX_FORCED_REDEPLOYS) return;

  const team = mod.GetTeam(eventPlayer);

  const anchorHqId = sanitizeForcedSafeSpawnHqForTeam(
    team,
    getStoredOrDefaultLiveSafeSpawnHqObjId(playerId, team)
  );
  const hqSpawnerPos = tryGetLiveSafeSpawnHqPositionSafe(anchorHqId);
  if (!hqSpawnerPos) return;

  // Actual player position right after deploy.
  const playerPos = getPlayerPosition(eventPlayer);

  const distToHqSpawner = mod.DistanceBetween(playerPos, hqSpawnerPos);

  // If they spawned essentially on the HQ spawner object, treat as desync spawn -> recycle.
  if (distToHqSpawner > HQ_DESYNC_SPAWNER_EPSILON_METERS) return;

  const nextUsed = retries + 1;
  hqDesyncForcedRedeploys[playerId] = nextUsed;

  const chosenHqId = sanitizeForcedSafeSpawnHqForTeam(
    team,
    resolveForcedSafeSpawnHqObjId(playerId, team, nextUsed)
  );
  const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(chosenHqId);
  if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return;

  safeSpawnForcedUndeploy[playerId] = true;
  safeSpawnUnsafePending[playerId] = true;
  safeSpawnUnsafeHqObjIdByPlayerId[playerId] = chosenHqId;
  safeSpawnUnsafeSpawnerObjId[playerId] = spawnerObjId;

  mod.UndeployPlayer(eventPlayer);
}

function resolveSafeSpawnSpawnerObjId(playerId: number, team: mod.Team): number {
  const routeHqId =
    lastDynamicHqForPlayer[playerId] ??
    (mod.Equals(team, team1) ? currentDynamicHqTeam1 : currentDynamicHqTeam2) ??
    getNoFlagHqIdForTeam(team);

  const liveBaseSpawnerId = getLiveSafeSpawnPlayerSpawnerIdForHq(routeHqId);
  if (liveBaseSpawnerId > 0) {
    return liveBaseSpawnerId;
  }

  const routeKey = routeKeyFromHqId(routeHqId);
  return resolveSpawnerObjIdForRouteKey(playerId, team, routeKey);
}

function getPlayerPosition(player: mod.Player): mod.Vector {
  return mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
}

function isPlayerAlive(player: mod.Player): boolean {
  return mod.GetSoldierState(player, mod.SoldierStateBool.IsAlive);
}

function isPlayerAliveSafe(player: mod.Player): boolean {
  try {
    return isPlayerAlive(player);
  } catch (_err) {
    return false;
  }
}

function tryGetSquadNameSafe(squad: mod.Squad): string {
  try {
    const name = mod.GetSquadName(squad);
    return name ? name : "";
  } catch (_err) {
    return "";
  }
}

function arePlayersInSameSquad(
  player: mod.Player,
  otherPlayer: mod.Player,
  playerSquad?: mod.Squad,
  playerSquadName?: string
): boolean {
  let mySquad = playerSquad;
  if (!mySquad) {
    try {
      mySquad = mod.GetSquad(player);
    } catch (_err) {
      return false;
    }
  }
  if (!mySquad) return false;

  let otherSquad: mod.Squad;
  try {
    otherSquad = mod.GetSquad(otherPlayer);
  } catch (_err) {
    return false;
  }

  if (mod.Equals(mySquad, otherSquad)) return true;

  let mySquadName = playerSquadName ?? "";
  if (!mySquadName) mySquadName = tryGetSquadNameSafe(mySquad);
  if (!mySquadName) return false;

  const otherSquadName = tryGetSquadNameSafe(otherSquad);
  if (!otherSquadName) return false;

  return mySquadName === otherSquadName;
}

function isSquadSpawnBypassActive(playerId: number): boolean {
  return squadSpawnBypass[playerId] === true;
}

async function clearSquadSpawnBypassLater(playerId: number): Promise<void> {
  await mod.Wait(SQUAD_SPAWN_BYPASS_LIFETIME_SECONDS);
  squadSpawnBypass[playerId] = false;
}

async function startSquadSpawnBypassProbe(player: mod.Player, playerId: number): Promise<void> {
  let playerSquad: mod.Squad | undefined;
  try {
    playerSquad = mod.GetSquad(player);
  } catch (_err) {
    return;
  }
  if (!playerSquad) return;
  const playerSquadName = tryGetSquadNameSafe(playerSquad);

  const allPlayers = mod.AllPlayers();

  let elapsed = 0;

  while (elapsed <= SQUAD_SPAWN_PROBE_WINDOW_SECONDS) {
    const sp = serverPlayers.get(playerId);
    if (!sp || !sp.isDeployed) return;
    if (!isPlayerAlive(player)) return;

    const playerPosition = getPlayerPosition(player);

    for (let i = 0; i < mod.CountOf(allPlayers); i++) {
      const otherPlayer = mod.ValueInArray(allPlayers, i) as mod.Player;

      if (mod.Equals(player, otherPlayer)) continue;
      if (!mod.IsPlayerValid(otherPlayer)) continue;
      if (!isPlayerAlive(otherPlayer)) continue;
      if (!arePlayersInSameSquad(player, otherPlayer, playerSquad, playerSquadName)) continue;

      const otherId = modlib.getPlayerId(otherPlayer);
      const otherSp = serverPlayers.get(otherId);
      if (!otherSp || !otherSp.isDeployed) continue;

      const otherPosition = getPlayerPosition(otherPlayer);
      const distance = mod.DistanceBetween(playerPosition, otherPosition);

      if (distance <= SQUAD_SPAWN_DISTANCE) {
        squadSpawnBypass[playerId] = true;
        void clearSquadSpawnBypassLater(playerId);
        return;
      }
    }

    await mod.Wait(SQUAD_SPAWN_PROBE_INTERVAL_SECONDS);
    elapsed += SQUAD_SPAWN_PROBE_INTERVAL_SECONDS;
  }
}

function checkIfSpawnedOnSquadmate(player: mod.Player): boolean {
  let playerSquad: mod.Squad | undefined;
  try {
    playerSquad = mod.GetSquad(player);
  } catch (_err) {
    return false;
  }
  if (!playerSquad) return false;
  const playerSquadName = tryGetSquadNameSafe(playerSquad);

  const allPlayers = mod.AllPlayers();
  const playerPosition = getPlayerPosition(player);

  for (let i = 0; i < mod.CountOf(allPlayers); i++) {
    const otherPlayer = mod.ValueInArray(allPlayers, i) as mod.Player;

    if (mod.Equals(player, otherPlayer)) continue;
    if (!mod.IsPlayerValid(otherPlayer)) continue;
    if (!isPlayerAlive(otherPlayer)) continue;
    if (!arePlayersInSameSquad(player, otherPlayer, playerSquad, playerSquadName)) continue;

    const otherPosition = getPlayerPosition(otherPlayer);
    const distance = mod.DistanceBetween(playerPosition, otherPosition);

    if (distance <= SQUAD_SPAWN_DISTANCE) {
      return true;
    }
  }

  return false;
}

function hasEnemyNearPosition(team: mod.Team, pos: mod.Vector, radiusMeters: number, ignorePlayerId: number): boolean {
  let found = false;

  serverPlayers.forEach((p) => {
    if (found) return;

    if (p.id === ignorePlayerId) return;
    if (!p.isDeployed) return;

    const otherTeam = mod.GetTeam(p.player);
    if (mod.Equals(otherTeam, team)) return;

    if (!isPlayerAlive(p.player)) return;

    const enemyPos = getPlayerPosition(p.player);
    const d = mod.DistanceBetween(pos, enemyPos);

    if (d <= radiusMeters) found = true;
  });

  return found;
}
const FRIENDLY_SPAWN_BYPASS_RADIUS_METERS = 8;

function isSpawnNearFriendlyPlayer(eventPlayer: mod.Player, playerId: number, radiusMeters: number): boolean {
  if (!mod.IsPlayerValid(eventPlayer)) return false;
  if (!isPlayerAlive(eventPlayer)) return false;

  const myTeam = mod.GetTeam(eventPlayer);
  const myPos = getPlayerPosition(eventPlayer);

  let nearFriendly = false;

  serverPlayers.forEach((sp) => {
    if (nearFriendly) return;

    // ignore self
    if (sp.id === playerId) return;

    if (!sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;
    if (!isPlayerAlive(sp.player)) return;

    const t = mod.GetTeam(sp.player);
    if (!mod.Equals(t, myTeam)) return;

    const otherPos = getPlayerPosition(sp.player);
    const d = mod.DistanceBetween(myPos, otherPos);

    if (d <= radiusMeters) {
      nearFriendly = true;
    }
  });

  return nearFriendly;
}

function isValidDynamicSpawnId(id: number): boolean {
  return id >= TEAM1_FLAG_A_HQ && id <= TEAM2_NO_FLAG_HQ;
}
function getSafeSpawnEnemyRadiusMeters(attemptUsed: number): number {
  void attemptUsed;
  return SAFE_SPAWN_ENEMY_RADIUS_METERS;
}





/*
  Safe spawn check:
    - Runs shortly after deploy (live only).
    - If enemy is within 8m, force an undeploy and re-spawn from a safer HQ spawnpoint.
    - Makes up to SAFE_SPAWN_MAX_FORCED_REDEPLOYS attempts.
    - First forced attempt uses the player's recorded last live HQ source (fallback: initial HQ).
    - Additional forced attempts alternate between the team's live HQ pair.
    - Bypasses recycling if it looks like a squad spawn.
*/
async function SafeSpawnCheckOrRedeploy(eventPlayer: mod.Player, playerId: number): Promise<void> {
  if (safeSpawnPendingCheck[playerId] === true) return;
  if (safeSpawnUnsafePending[playerId] === true) return;

  safeSpawnPendingCheck[playerId] = true;

  try {
    await mod.Wait(SAFE_SPAWN_CHECK_DELAY_SECONDS);

    // 1) Hard bypass if spawn is near ANY friendly within 8m
    if (isSpawnNearFriendlyPlayer(eventPlayer, playerId, FRIENDLY_SPAWN_BYPASS_RADIUS_METERS)) {
      safeSpawnForcedRedeploys[playerId] = 0;
      commitPendingDynamicHqForPlayer(playerId);
      return;
    }


    // 2) Keep your existing bypass if you still want it
    if (isSquadSpawnBypassActive(playerId)) {
      safeSpawnForcedRedeploys[playerId] = 0;
      return;
    }

    if (gameStatus !== 3) return;

    const p = serverPlayers.get(playerId);
    if (!p) return;

    if (!p.isDeployed) return;
    if (!isPlayerAlive(eventPlayer)) return;

    const used = safeSpawnForcedRedeploys[playerId] ?? 0;
    const radius = getSafeSpawnEnemyRadiusMeters(used);


    // If we already hit the cap previously, do not loop forever.
    if (used >= SAFE_SPAWN_MAX_FORCED_REDEPLOYS) return;

    // If this looks like a squad spawn, do not force recycle.
    if (checkIfSpawnedOnSquadmate(eventPlayer)) {
      safeSpawnForcedRedeploys[playerId] = 0;
      return;
    }

    const team = mod.GetTeam(eventPlayer);
    const pos = getPlayerPosition(eventPlayer);

    
    const unsafe = hasEnemyNearPosition(team, pos, radius, playerId);



    if (!unsafe) {
      // Successful safe spawn: reset attempt counter.
      safeSpawnForcedRedeploys[playerId] = 0;
      commitPendingDynamicHqForPlayer(playerId);
      return;
    }


    // Unsafe: consume one attempt.
    const nextUsed = used + 1;
    safeSpawnForcedRedeploys[playerId] = nextUsed;
    safeSpawnForcedUndeploy[playerId] = true;

    const chosenHqId = sanitizeForcedSafeSpawnHqForTeam(
      team,
      resolveForcedSafeSpawnHqObjId(playerId, team, nextUsed)
    );
    const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(chosenHqId);

    // Defensive: if mapping is empty/misconfigured, do nothing (avoids random fallback behavior).
    if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return;

    safeSpawnUnsafePending[playerId] = true;
    safeSpawnUnsafeHqObjIdByPlayerId[playerId] = chosenHqId;
    safeSpawnUnsafeSpawnerObjId[playerId] = spawnerObjId;

    p.isDeployed = false;

    mod.SetRedeployTime(eventPlayer, 9999);

    mod.DisplayNotificationMessage(mod.Message(mod.stringkeys.SafeSpawnRetryToast), eventPlayer);
    mod.UndeployPlayer(eventPlayer);
  } finally {
    safeSpawnPendingCheck[playerId] = false;
  }
}

/* =================================================================================================
   5) AUDIO (SFX / VO)
================================================================================================= */

let audioInitialized = false;
let SFX_CaptureBuildup: any = null;

let SFX_TickFriendly: any = null;
let SFX_TickEnemy: any = null;
let SFX_CapturedFriendly: any = null;
let SFX_ReadyUp: any = null;
let SFX_CountdownHeartbeat: any = null;
let SFX_ThumpFriendly: any = null;
let SFX_ThumpEnemy: any = null;
let SFX_MatchStartStinger: any = null;
let SFX_MCOMDestroyed: any = null;
let SFX_ObjectiveArmingLocal: any = null;
let SFX_ObjectiveArmLocal: any = null;
let SFX_ObjectiveDefusedLocal: any = null;
let SFX_ObjectiveDefusingLocal: any = null;
let SFX_BombSpawnStinger2D: any = null;
// Capture tick LOOPS (start once, stop once)
let SFX_TickFriendlyLoop: any = null;
let SFX_TickEnemyLoop: any = null;
// End-of-round suspense loops
let SFX_Endgame_WinningLoop: any = null;
let SFX_Endgame_LosingLoop: any = null;
// Restricted Area countdown loop
let SFX_OutOfBoundsCountdownLoop: any = null;


// Track per-player state so loops never stack
let endgameLoopStateByPlayerId: { [playerId: number]: "none" | "win" | "lose" } = {};


// Track what loop (if any) each player is currently hearing
let captureTickLoopStateByPlayerId: { [playerId: number]: "none" | "friendly" | "enemy" } = {};

let voModuleByTeamId: { [teamId: number]: any | undefined } = {};
let voFallbackModule: any = null;
let voDispatchWarningShownByKey: { [key: string]: boolean } = {};
// Postmatch result SFX
let SFX_PostMatchVictory: any = null;
let SFX_PostMatchDefeat: any = null;
const OBJECTIVE_AWARD_SUCCESS_VOLUME = 1.0;

let postmatchResultSfxPlayed = false;
// Endgame suspense loop tuning
const ENDGAME_TICKET_THRESHOLD = WIN_SCORE - 1;
const ENDGAME_TIME_THRESHOLD_SECONDS = 30;
const ENDGAME_LOOP_INTERVAL_SECONDS = 0.8;

// Per-player endgame loop tokens (token invalidation like capture tick loop)
let endgameLoopTokenByPlayerId: { [playerId: number]: number } = {};
let endgameLoopModeByPlayerId: { [playerId: number]: "none" | "win" | "lose" } = {};

/* Cooldowns */
const SFX_CONTEST_COOLDOWN = 2.0;
const SFX_CAPTURE_COOLDOWN = 2.0;
const SFX_TEAMMATE_JOIN_COOLDOWN = 1.0;

const SFX_CONTEST_CD_TICKS = mod.Ceiling(SFX_CONTEST_COOLDOWN * TICK_RATE);
const SFX_CAPTURE_CD_TICKS = mod.Ceiling(SFX_CAPTURE_COOLDOWN * TICK_RATE);
const SFX_JOIN_CD_TICKS = mod.Ceiling(SFX_TEAMMATE_JOIN_COOLDOWN * TICK_RATE);

const CAPTURE_TICK_INTERVAL_SECONDS = 0.45;
const CAPTURE_TICK_INTERVAL_TICKS = mod.Max(1, mod.Floor(CAPTURE_TICK_INTERVAL_SECONDS * TICK_RATE));

const CAPTURE_BUILDUP_THRESHOLD = 0.88;   // Start buildup when progress crosses this on the way up to 1.0
const CAPTURE_BUILDUP_BEATS = 3;
const CAPTURE_BUILDUP_BEAT_INTERVAL_SECONDS = 0.12;

let lastCaptureBuildupTickByCp: { [cpId: number]: number } = {};
const CAPTURE_BUILDUP_COOLDOWN_TICKS = mod.Ceiling(2.0 * TICK_RATE);


let lastContestSfxTickByCp: { [cpId: number]: number } = {};
let lastCaptureSfxTickByCp: { [cpId: number]: number } = {};
let lastJoinSfxTickByCp: { [cpId: number]: number } = {};

let lastCaptureTickAt: { [key: string]: number } = {};
let capturePointContested: { [cpId: number]: boolean } = {};
let lastCaptureProgressByCpId: { [cpId: number]: number } = {};
let captureTickLoopTokenByPlayerId: { [playerId: number]: number } = {};
let captureCreditByCpId: { [cpId: number]: { [playerId: number]: boolean } } = {};


let lastEnterPointSfxTickByPlayerId: { [playerId: number]: number } = {};
const ENTER_POINT_SFX_COOLDOWN_TICKS = mod.Floor(0.75 * TICK_RATE);

function ensureAudioSpawned(): void {
  if (audioInitialized) return;
  audioInitialized = true;

  SFX_CaptureBuildup = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Notification_ObjectiveSecured_FadeIn_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

    // Looping capture tick sounds (SimpleLoop2D)
  SFX_TickFriendlyLoop = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Standoff_ZoneCaptureTick_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_TickEnemyLoop = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_CaptureObjectives_CapturingTick_IsEnemy_SimpleLoop2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );


  SFX_ReadyUp = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_SP_Collectibles_Dogtag_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_CountdownHeartbeat = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Shared_Countdown_Tick_Urgent_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_TickFriendly = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Standoff_ZoneCaptureTick_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_TickEnemy = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_CaptureObjectives_CapturingTickEnemy_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_CapturedFriendly = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_CaptureObjectives_OnCapturedByFriendly_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_ThumpFriendly = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_CaptureObjectives_CapturingThumpFriendly_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_ThumpEnemy = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_CaptureObjectives_CapturingThumpEnemy_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_MatchStartStinger = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_Intro_FinalImpact_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_MCOMDestroyed = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_Wreckage_MCOMDestroyed_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  // Local objective hold feedback (played directly to the interacting player).
  SFX_ObjectiveArmingLocal = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Arm_SimpleLoop3D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_ObjectiveArmLocal = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Armed_OneShot3D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_ObjectiveDefusedLocal = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Defused_OneShot3D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_ObjectiveDefusingLocal = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_GameModes_Rush_Defusing_SimpleLoop3D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  SFX_BombSpawnStinger2D = mod.SpawnObject(
    BOMB_SPAWN_STINGER_ASSET,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

    // End-of-round suspense loops
  // Winning team: satisfying / anticipatory tension
  SFX_Endgame_WinningLoop = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_GameModes_BR_Circle_DamageStop_Loop2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  // Losing team: hopeless / pressure tone
  SFX_Endgame_LosingLoop = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_GameModes_BR_Circle_DeathWarning_SimpleLoop2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );


    // Postmatch result sounds
  // "Qualified" reads as a positive/celebration stinger in Portal
  SFX_PostMatchVictory = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_EOM_Qualified_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  // Defeat stinger
  SFX_PostMatchDefeat = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gauntlet_EOM_Defeat_OneShot2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );


    // Restricted Area / Out-of-bounds warning loop (SimpleLoop2D)
  SFX_OutOfBoundsCountdownLoop = mod.SpawnObject(
    mod.RuntimeSpawn_Common.SFX_UI_Gamemode_Shared_OutOfBounds_SFXLoop_SimpleLoop2D,
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(0, 0, 0)
  );

  ensureObjectiveMcomSfxSpawned();

}

function forEachPlayerOnTeam(team: mod.Team, fn: (p: Player) => void): void {
  serverPlayers.forEach((p) => {
    if (mod.Equals(mod.GetTeam(p.player), team)) fn(p);
  });
}

function stopCaptureTickLoop(playerId: number): void {
  // Keep the token invalidation (in case other code expects it)
  const t = captureTickLoopTokenByPlayerId[playerId] ?? 0;
  captureTickLoopTokenByPlayerId[playerId] = t + 1;

  const p = serverPlayers.get(playerId);
  if (p && mod.IsPlayerValid(p.player)) {
    stopCaptureTickLoopsForPlayer(p.player, playerId);
  }
}
function stopEndgameLoop(playerId: number): void {
  const t = endgameLoopTokenByPlayerId[playerId] ?? 0;
  endgameLoopTokenByPlayerId[playerId] = t + 1;
  endgameLoopModeByPlayerId[playerId] = "none";
}
function startRestrictedAreaLoopSfxForPlayer(player: mod.Player): void {
  if (!SFX_OutOfBoundsCountdownLoop) return;
  mod.PlaySound(SFX_OutOfBoundsCountdownLoop, 1.0, player);
}

function stopRestrictedAreaLoopSfxForPlayer(player: mod.Player): void {
  if (!SFX_OutOfBoundsCountdownLoop) return;
  mod.StopSound(SFX_OutOfBoundsCountdownLoop, player);
}

async function startEndgameLoop(playerId: number, mode: "win" | "lose"): Promise<void> {
  stopEndgameLoop(playerId);
  endgameLoopModeByPlayerId[playerId] = mode;

  const myToken = endgameLoopTokenByPlayerId[playerId];

  while (true) {
    if (endgameLoopTokenByPlayerId[playerId] !== myToken) return;
    if (gameStatus !== 3) return;

    const sp = serverPlayers.get(playerId);
    if (!sp) return;
    if (!sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;
    if (!isPlayerAlive(sp.player)) return;

    // Use only sounds you already spawn and already know work.
    if (mode === "win") {
      if (SFX_Endgame_WinningLoop) mod.PlaySound(SFX_CaptureBuildup, 0, sp.player);
    } else {
      if (SFX_CountdownHeartbeat) mod.PlaySound(SFX_CountdownHeartbeat, 0, sp.player);
    }

    await mod.Wait(ENDGAME_LOOP_INTERVAL_SECONDS);
  }
}

function StopAllEndgameLoops(): void {
  serverPlayers.forEach((p) => stopEndgameLoop(p.id));
}

async function startCaptureTickLoop(playerId: number): Promise<void> {
  // Kill any previous loop and start a new one.
  stopCaptureTickLoop(playerId);
  const myToken = captureTickLoopTokenByPlayerId[playerId];

  while (true) {
    // Stop if token changed.
    if (captureTickLoopTokenByPlayerId[playerId] !== myToken) return;

    if (gameStatus !== 3) return;

    const p = serverPlayers.get(playerId);
    if (!p) return;

    if (!p.isDeployed) return;
    if (!mod.IsPlayerValid(p.player)) return;
    if (!isPlayerAlive(p.player)) return;

    const point = p.getCapturePoint();
    if (!point) return;

    const cp = serverCapturePoints[mod.GetObjId(point)];
    if (!cp) return;

    const onPointCounts = cp.getOnPoint();
    const hasT1 = onPointCounts[0] > 0;
    const hasT2 = onPointCounts[1] > 0;

        const contested = hasT1 && hasT2;

    const progress = cp.getCaptureProgress();
    const inProgressBand = progress > PROGRESS_EMPTY && progress < PROGRESS_FULL;

    const majorityTeam = getMajorityTeamOnPoint(cp);
    const ownerTeam = cp.getOwner();

    // "Working" means: your team has majority and you are not already the owner at full progress.
    // This makes ticking start immediately even when progress is 0 at the beginning of a neutral capture.
    const working =
      !contested &&
      !mod.Equals(majorityTeam, teamNeutral) &&
      !mod.Equals(ownerTeam, majorityTeam);

    // Only tick if contested, progress is moving, or we're actively working the objective.
    if (contested || inProgressBand || working) {
      if (contested) {
        playTickEnemy(p.player);
      } else {
        const playerTeam = mod.GetTeam(p.player);

        if (mod.Equals(majorityTeam, teamNeutral)) {
          playTickEnemy(p.player);
        } else if (mod.Equals(playerTeam, majorityTeam)) {
          playTickFriendly(p.player);
        } else {
          playTickEnemy(p.player);
        }
      }
    }


    await mod.Wait(CAPTURE_TICK_INTERVAL_SECONDS);
  }
}
function playCaptureBuildupBeat(receiver: mod.Player): void {
  if (SFX_CaptureBuildup) {
    // Slightly lower volume so it feels like a buildup, not a capture stinger.
    mod.PlaySound(SFX_CaptureBuildup, 0.2, receiver);
  }
}

function stopEndgameLoopForPlayer(player: mod.Player, playerId: number): void {
  if (SFX_Endgame_WinningLoop) mod.StopSound(SFX_Endgame_WinningLoop, player);
  if (SFX_Endgame_LosingLoop) mod.StopSound(SFX_Endgame_LosingLoop, player);
  endgameLoopStateByPlayerId[playerId] = "none";
}

function setEndgameLoopForPlayer(
  player: mod.Player,
  playerId: number,
  desired: "none" | "win" | "lose"
): void {
  const current = endgameLoopStateByPlayerId[playerId] ?? "none";
  if (current === desired) return;

  // Stop previous loop
  if (SFX_Endgame_WinningLoop) mod.StopSound(SFX_Endgame_WinningLoop, player);
  if (SFX_Endgame_LosingLoop) mod.StopSound(SFX_Endgame_LosingLoop, player);

  if (desired === "win") {
    if (SFX_Endgame_WinningLoop) mod.PlaySound(SFX_Endgame_WinningLoop, 0.25, player);
  } else if (desired === "lose") {
    if (SFX_Endgame_LosingLoop) mod.PlaySound(SFX_Endgame_LosingLoop, 0.25, player);
  }

  endgameLoopStateByPlayerId[playerId] = desired;
}
function UpdateEndgameSuspenseAudio(): void {
  if (gameStatus !== 3) {
    StopAllEndgameLoops();
    return;
  }

  const timeLeft = getLiveClockRemainingSeconds(getCurrentSchedulerNowSeconds());
  if (timeLeft === undefined) {
    StopAllEndgameLoops();
    return;
  }

  // Compare with CEILING tickets so it matches what players see.
  const t1Tickets = mod.Ceiling(serverScores[0]);
  const t2Tickets = mod.Ceiling(serverScores[1]);

  const endByTicketsSoon = t1Tickets >= ENDGAME_TICKET_THRESHOLD || t2Tickets >= ENDGAME_TICKET_THRESHOLD;
  const endByTimeSoon = timeLeft <= ENDGAME_TIME_THRESHOLD_SECONDS;

  if (!endByTicketsSoon && !endByTimeSoon) {
    StopAllEndgameLoops();
    return;
  }

  // Current leader decides win/lose mood.
  let leader: mod.Team = teamNeutral;
  if (t1Tickets > t2Tickets) leader = team1;
  else if (t2Tickets > t1Tickets) leader = team2;

  // If tied, do not play either mood.
  if (mod.Equals(leader, teamNeutral)) {
    StopAllEndgameLoops();
    return;
  }

  serverPlayers.forEach((sp) => {
    if (!sp) return;
    if (!sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;

    const playerTeam = mod.GetTeam(sp.player);

    let desired: "none" | "win" | "lose" = "none";
    if (mod.Equals(playerTeam, leader)) desired = "win";
    else if (mod.Equals(playerTeam, team1) || mod.Equals(playerTeam, team2)) desired = "lose";

    const current = endgameLoopModeByPlayerId[sp.id] ?? "none";
    if (current === desired) return;

    if (desired === "none") {
      stopEndgameLoop(sp.id);
      return;
    }

    void startEndgameLoop(sp.id, desired);
  });
}


async function playCaptureBuildupToCapturingTeamOnPoint(cp: CapturePoint, capturingTeam: mod.Team): Promise<void> {
  // Rate limit per capture point so it does not spam.
  const last = lastCaptureBuildupTickByCp[cp.id] ?? -999999;
  if (serverTickCount - last < CAPTURE_BUILDUP_COOLDOWN_TICKS) return;
  lastCaptureBuildupTickByCp[cp.id] = serverTickCount;

  // Play a short 3-beat buildup only to the capturing team currently on the point.
  for (let beat = 0; beat < CAPTURE_BUILDUP_BEATS; beat++) {
    const ids = cp.getPlayerIdsOnPoint();

    for (let i = 0; i < ids.length; i++) {
      const pid = ids[i];
      const p = serverPlayers.get(pid);
      if (!p) continue;

      if (!p.isDeployed) continue;
      if (!mod.IsPlayerValid(p.player)) continue;
      if (!isPlayerAlive(p.player)) continue;

      if (!mod.Equals(mod.GetTeam(p.player), capturingTeam)) continue;

      playCaptureBuildupBeat(p.player);
    }

    await mod.Wait(CAPTURE_BUILDUP_BEAT_INTERVAL_SECONDS);
  }
}

function playTickFriendly(receiver: mod.Player): void {
  // The CaptureObjectives ticking runtime spawners can be silent or unavailable in some Portal builds.
  // Use the countdown heartbeat sound as the reliable capture tick.
  if (SFX_TickFriendly) {
    mod.PlaySound(SFX_TickFriendly, 0.1, receiver);
    return;
  }

  // Fallbacks if heartbeat is not available for some reason.
  if (SFX_ThumpFriendly) {
    mod.PlaySound(SFX_ThumpFriendly, 0.2, receiver);
    return;
  }

  if (SFX_TickFriendly) mod.PlaySound(SFX_TickFriendly, 0.1, receiver);
}

function playTickEnemy(receiver: mod.Player): void {
  // Use the same reliable tick during contest/pressure.
  if (SFX_TickEnemy) {
    mod.PlaySound(SFX_TickEnemy, 0.2, receiver);
    return;
  }

  // Fallbacks.
  if (SFX_ThumpEnemy) {
    mod.PlaySound(SFX_ThumpEnemy, 0.2, receiver);
    return;
  }

  if (SFX_TickEnemy) mod.PlaySound(SFX_TickEnemy, 0.2, receiver);
}

function stopCaptureTickLoopsForPlayer(player: mod.Player, playerId: number): void {
  // Stop both so we never overlap
  if (SFX_TickFriendlyLoop) mod.StopSound(SFX_TickFriendlyLoop, player);
  if (SFX_TickEnemyLoop) mod.StopSound(SFX_TickEnemyLoop, player);

  captureTickLoopStateByPlayerId[playerId] = "none";
}

function setCaptureTickLoopForPlayer(player: mod.Player, playerId: number, desired: "none" | "friendly" | "enemy"): void {
  const current = captureTickLoopStateByPlayerId[playerId] ?? "none";
  if (current === desired) return;

  // Always stop previous loop first
  if (SFX_TickFriendlyLoop) mod.StopSound(SFX_TickFriendlyLoop, player);
  if (SFX_TickEnemyLoop) mod.StopSound(SFX_TickEnemyLoop, player);

  if (desired === "friendly") {
    if (SFX_TickFriendlyLoop) mod.PlaySound(SFX_TickFriendlyLoop, 0.20, player);
  } else if (desired === "enemy") {
    if (SFX_TickEnemyLoop) mod.PlaySound(SFX_TickEnemyLoop, 0.20, player);
  }

  captureTickLoopStateByPlayerId[playerId] = desired;
}

function StopAllCaptureTickLoops(): void {
  serverPlayers.forEach((p) => {
    if (!p) return;
    if (!mod.IsPlayerValid(p.player)) return;
    stopCaptureTickLoopsForPlayer(p.player, p.id);
  });
}


/*
  Global loop manager:
  - For each deployed/alive player, decide what they should hear:
      none: not on a point or no contest/progress activity
      friendly: player is on point AND their team is the majority capturing/neutralizing (not contested)
      enemy: contested OR player is not majority OR majority is neutral
  - Start/stop loops only on state changes (no spam).
*/
function UpdateCaptureTickLoopsGlobal(): void {
  if (gameStatus !== 3) {
    StopAllCaptureTickLoops();
    return;
  }

  serverPlayers.forEach((sp) => {
    if (!sp) return;

    const player = sp.player;
    const playerId = sp.id;

    if (!sp.isDeployed || !mod.IsPlayerValid(player) || !isPlayerAlive(player)) {
      if (mod.IsPlayerValid(player)) stopCaptureTickLoopsForPlayer(player, playerId);
      return;
    }

    const point = sp.getCapturePoint();
    if (!point) {
      stopCaptureTickLoopsForPlayer(player, playerId);
      return;
    }

    const cpWrap = serverCapturePoints[mod.GetObjId(point)];
    if (!cpWrap) {
      stopCaptureTickLoopsForPlayer(player, playerId);
      return;
    }

    const on = cpWrap.getOnPoint();
    const hasT1 = on[0] > 0;
    const hasT2 = on[1] > 0;

    const contested = hasT1 && hasT2;

    const progress = cpWrap.getCaptureProgress();
    const inProgressBand = progress > PROGRESS_EMPTY && progress < PROGRESS_FULL;

    // If nothing is actually happening, do not play a tick loop
    if (!contested && !inProgressBand) {
      stopCaptureTickLoopsForPlayer(player, playerId);
      return;
    }

    // Decide friendly vs enemy loop
    if (contested) {
      setCaptureTickLoopForPlayer(player, playerId, "enemy");
      return;
    }

    const majority = getMajorityTeamOnPoint(cpWrap);
    const myTeam = mod.GetTeam(player);

    if (mod.Equals(majority, teamNeutral)) {
      setCaptureTickLoopForPlayer(player, playerId, "enemy");
      return;
    }

    if (mod.Equals(myTeam, majority)) setCaptureTickLoopForPlayer(player, playerId, "friendly");
    else setCaptureTickLoopForPlayer(player, playerId, "enemy");
  });
}


function playCapturedSfx(receiver: mod.Player): void {
  if (SFX_CapturedFriendly) mod.PlaySound(SFX_CapturedFriendly, 1.0, receiver);
}

function playThumpFriendly(receiver: mod.Player): void {
  if (SFX_ThumpFriendly) mod.PlaySound(SFX_ThumpFriendly, 0.8, receiver);
}

function playThumpEnemy(receiver: mod.Player): void {
  if (SFX_ThumpEnemy) mod.PlaySound(SFX_ThumpEnemy, 0.8, receiver);
}

function playCountdownHeartbeatToAll(volume: number): void {
  if (!SFX_CountdownHeartbeat) return;
  serverPlayers.forEach((p) => mod.PlaySound(SFX_CountdownHeartbeat, volume, p.player));
}

function playMatchStartStingerToAll(volume: number): void {
  if (!SFX_MatchStartStinger) return;
  serverPlayers.forEach((p) => {
    try {
      mod.PlaySound(SFX_MatchStartStinger, volume, p.player);
    } catch (_err) {}
  });
}

function playBombSpawnStingerToAll(volume: number): void {
  ensureAudioSpawned();
  if (!SFX_BombSpawnStinger2D) return;
  serverPlayers.forEach((p) => mod.PlaySound(SFX_BombSpawnStinger2D, volume, p.player));
}

function playBombDropOneShotAtPosition(pos: mod.Vector): void {
  clearBombDropOneShotRuntimeSource();

  const cleanupToken = bombDropOneShotCleanupToken;
  const spawnedSource = spawnRuntimeSfxSourceAtPosition(BOMB_DROP_ONE_SHOT_ASSET, pos);
  const activeHandle = tryPlayRuntimeSfxSource3D(
    spawnedSource,
    BOMB_DROP_ONE_SHOT_VOLUME,
    pos,
    BOMB_SOUND_ATTENUATION_RANGE
  );
  if (!activeHandle) {
    if (spawnedSource.spawned) {
      unspawnObjectSafe(spawnedSource.spawned, "bomb drop one-shot spawn failure cleanup", false);
    }
    return;
  }

  bombDropOneShotSpawned = spawnedSource.spawned;
  bombDropOneShotObject = spawnedSource.object;
  bombDropOneShotHandle = activeHandle;

  void cleanupBombDropOneShotAfterDelay(cleanupToken);
}

function playObjectiveAwardSuccessSfxToAll(): void {
  if (!SFX_MCOMDestroyed) return;

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    mod.PlaySound(SFX_MCOMDestroyed, OBJECTIVE_AWARD_SUCCESS_VOLUME, p.player);
  });
}

function warnVoDispatchIssueOnce(key: string, message: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (voDispatchWarningShownByKey[key] === true) return;
  voDispatchWarningShownByKey[key] = true;
  emitStringKeyDebugWorldLog(mod.Message("[VO DISPATCH] {}", message));
}

function clearVoModuleState(): void {
  voModuleByTeamId = {};
  voFallbackModule = null;
  voDispatchWarningShownByKey = {};
}

function spawnVoModuleSafe(context: string): any | undefined {
  try {
    return mod.SpawnObject(
      mod.RuntimeSpawn_Common.SFX_VOModule_OneShot2D,
      mod.CreateVector(0, 0, 0),
      mod.CreateVector(0, 0, 0),
      mod.CreateVector(0, 0, 0)
    );
  } catch (err) {
    LogRuntimeError("SpawnVO/" + context, err);
    return undefined;
  }
}

function getVoTeamKey(team: mod.Team | undefined): number | undefined {
  if (team === undefined) return undefined;
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return undefined;
  return modlib.getTeamId(team);
}

function clearVoModuleHandle(team: mod.Team | undefined): void {
  const teamKey = getVoTeamKey(team);
  if (teamKey === undefined) {
    voFallbackModule = null;
    return;
  }

  delete voModuleByTeamId[teamKey];
}

function ensureFallbackVoModule(context: string): any | undefined {
  ensureAudioSpawned();
  if (voFallbackModule) return voFallbackModule;
  voFallbackModule = spawnVoModuleSafe("fallback/" + context);
  return voFallbackModule;
}

function ensureVoModuleForTeam(team: mod.Team | undefined, context: string): any | undefined {
  ensureAudioSpawned();

  const teamKey = getVoTeamKey(team);
  if (teamKey === undefined) return ensureFallbackVoModule(context + "/unknown_team");

  const existing = voModuleByTeamId[teamKey];
  if (existing) return existing;

  const spawned = spawnVoModuleSafe(context + "/team_" + String(teamKey));
  voModuleByTeamId[teamKey] = spawned;
  return spawned;
}

function spawnTeamVoModulesForMatchStart(): void {
  if (!ensureVoModuleForTeam(team1, "match_start")) {
    warnVoDispatchIssueOnce("match_start_team1_missing", "failed to spawn team 1 VO module at match start");
  }

  if (!ensureVoModuleForTeam(team2, "match_start")) {
    warnVoDispatchIssueOnce("match_start_team2_missing", "failed to spawn team 2 VO module at match start");
  }
}

function tryPlayVoWithRetry(
  evt: mod.VoiceOverEvents2D,
  flag: mod.VoiceOverFlags,
  receiver: any,
  context: string,
  team?: mod.Team
): boolean {
  const initial = ensureVoModuleForTeam(team, context + "/initial");
  if (!initial) return false;

  try {
    mod.PlayVO(initial, evt, flag, receiver);
    return true;
  } catch (_errInitial) {
    clearVoModuleHandle(team);
  }

  const retryModule = ensureVoModuleForTeam(team, context + "/retry");
  if (!retryModule) {
    warnVoDispatchIssueOnce(
      "module_missing_after_respawn:" + context,
      "module missing after respawn (" + context + ")"
    );
    return false;
  }

  try {
    mod.PlayVO(retryModule, evt, flag, receiver);
    return true;
  } catch (errRetry) {
    clearVoModuleHandle(team);
    LogRuntimeError("PlayVO/" + context, errRetry);
    warnVoDispatchIssueOnce("retry_failed:" + context, "retry failed (" + context + ")");
    return false;
  }
}

function playVOToPlayer(receiver: mod.Player, evt: mod.VoiceOverEvents2D, flag: mod.VoiceOverFlags): void {
  if (!mod.IsPlayerValid(receiver)) return;
  const receiverTeam = mod.GetTeam(receiver);
  const receiverObjId = getObjIdSafe(receiver as unknown);
  tryPlayVoWithRetry(
    evt,
    flag,
    receiver,
    "player_" + String(receiverObjId) + "_evt_" + String(evt),
    receiverTeam
  );
}

function playVOToTeam(team: mod.Team, evt: mod.VoiceOverEvents2D, flag: mod.VoiceOverFlags): void {
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

  const teamCtx = "team_" + String(modlib.getTeamId(team)) + "_evt_" + String(evt);
  const playedToTeam = tryPlayVoWithRetry(evt, flag, team, teamCtx + "_group", team);
  if (playedToTeam) return;

  forEachPlayerOnTeam(team, (p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    tryPlayVoWithRetry(evt, flag, p.player, teamCtx + "_fallback_p_" + String(p.id), team);
  });
}

function refreshVoModuleForTeam(team: mod.Team, context: string): any | undefined {
  clearVoModuleHandle(team);
  return ensureVoModuleForTeam(team, context + "/fresh");
}

function playFreshAnnouncementVoToTeamMembers(
  team: mod.Team,
  evt: mod.VoiceOverEvents2D,
  flag: mod.VoiceOverFlags,
  context: string
): void {
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;
  ensureAudioSpawned();

  let moduleHandle = refreshVoModuleForTeam(team, context);
  if (!moduleHandle) {
    warnVoDispatchIssueOnce("fresh_module_missing:" + context, "fresh team VO module missing (" + context + ")");
  }

  forEachPlayerOnTeam(team, (p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;

    if (moduleHandle) {
      try {
        mod.PlayVO(moduleHandle, evt, flag, p.player);
        return;
      } catch (_err) {
        clearVoModuleHandle(team);
        moduleHandle = undefined;
      }
    }

    tryPlayVoWithRetry(
      evt,
      flag,
      p.player,
      context + "_fallback_p_" + String(p.id),
      team
    );
    moduleHandle = ensureVoModuleForTeam(team, context + "/recovered");
  });
}

function playFreshAnnouncementVoToAllTeams(
  evt: mod.VoiceOverEvents2D,
  flag: mod.VoiceOverFlags,
  context: string
): void {
  playFreshAnnouncementVoToTeamMembers(team1, evt, flag, context + "_team1");
  playFreshAnnouncementVoToTeamMembers(team2, evt, flag, context + "_team2");
}

function getOpposingTeam(team: mod.Team): mod.Team {
  if (mod.Equals(team, team1)) return team2;
  if (mod.Equals(team, team2)) return team1;
  return teamNeutral;
}

function playObjectiveOutcomeVoForTeams(
  kind: "arm" | "defuse" | "destroyed",
  actingTeam: mod.Team,
  symbol: ObjectiveLetter
): void {
  if (!mod.Equals(actingTeam, team1) && !mod.Equals(actingTeam, team2)) return;

  const enemyTeam = getOpposingTeam(actingTeam);
  if (!mod.Equals(enemyTeam, team1) && !mod.Equals(enemyTeam, team2)) return;

  const flag = getVoiceOverFlagForSymbol(symbol);

  if (kind === "arm") {
    playVOToTeam(actingTeam, mod.VoiceOverEvents2D.MComArmFriendly, flag);
    playVOToTeam(enemyTeam, mod.VoiceOverEvents2D.MComArmEnemy, flag);
    return;
  }

  if (kind === "defuse") {
    playVOToTeam(actingTeam, mod.VoiceOverEvents2D.MComDefuseFriendly, flag);
    playVOToTeam(enemyTeam, mod.VoiceOverEvents2D.MComDefuseEnemy, flag);
    return;
  }

  playVOToTeam(actingTeam, mod.VoiceOverEvents2D.MComDestroyedFriendly, flag);
  playVOToTeam(enemyTeam, mod.VoiceOverEvents2D.MComDestroyedEnemy, flag);
}

function playSfxToTeam(team: mod.Team, kind: "tickFriendly" | "tickEnemy" | "captured"): void {
  forEachPlayerOnTeam(team, (p) => {
    if (kind === "tickFriendly") playTickFriendly(p.player);
    else if (kind === "tickEnemy") playTickEnemy(p.player);
    else playCapturedSfx(p.player);
  });
}

function playPostMatchResultSfxOnce(): void {
  if (postmatchResultSfxPlayed) return;
  postmatchResultSfxPlayed = true;

  const winner = getWinningTeam();
  if (mod.Equals(winner, teamNeutral)) return;

  serverPlayers.forEach((p) => {
    const t = mod.GetTeam(p.player);

    // Winner hears victory, losers hear defeat
    if (mod.Equals(t, winner)) {
      if (SFX_PostMatchVictory) mod.PlaySound(SFX_PostMatchVictory, 1.0, p.player);
    } else if (mod.Equals(t, team1) || mod.Equals(t, team2)) {
      if (SFX_PostMatchDefeat) mod.PlaySound(SFX_PostMatchDefeat, 1.0, p.player);
    }
  });
}


function canPlayCpSfx(cdTicks: number, lastMap: { [cpId: number]: number }, cpId: number): boolean {
  const last = lastMap[cpId] ?? -9999999;
  return serverTickCount - last >= cdTicks;
}

function markCpSfx(lastMap: { [cpId: number]: number }, cpId: number): void {
  lastMap[cpId] = serverTickCount;
}

/* =================================================================================================
   6) UI (PARSE UI + PER-PLAYER HUD)
================================================================================================= */
const TICKETS_BAR_MAX = WIN_SCORE;

let UIContainers: mod.UIWidget[] = [];

/* Track HUD build state so we can build once and then only toggle/update */
let liveHudBuiltByPlayerId: { [playerId: number]: boolean } = {}; // reused name to avoid touching lots of code paths
let readyTextBuiltByPlayerId: { [playerId: number]: boolean } = {};
let readyTextWidgetByPlayerId: { [playerId: number]: mod.UIWidget } = {};


/* Prematch roster UI */
const MAX_ROSTER_LINES = 32;
let prematchRosterBuilt: boolean = false;
let prematchRosterTeam1: (mod.UIWidget | null)[] = [];
let prematchRosterTeam2: (mod.UIWidget | null)[] = [];
const PREMATCH_PANEL_POS_X = -780;
const PREMATCH_PANEL_WIDTH = 292;
const PREMATCH_PANEL_MIN_HEIGHT = 572;
const PREMATCH_PANEL_MAX_HEIGHT = 760;
const PREMATCH_PANEL_BASE_POS_Y = -176;
const PREMATCH_PANEL_TOP_LOCK_REL_Y = PREMATCH_PANEL_BASE_POS_Y - PREMATCH_PANEL_MIN_HEIGHT / 2;
const PREMATCH_PANEL_HEIGHT = PREMATCH_PANEL_MIN_HEIGHT;
const PREMATCH_PANEL_POS_Y = PREMATCH_PANEL_BASE_POS_Y;
const PREMATCH_PANEL_ANCHOR = mod.UIAnchor.Center;
const PREMATCH_COLUMN_CENTER_OFFSET = 72;
const PREMATCH_ROSTER_TO_BUTTON_GAP = 42;
const PREMATCH_PANEL_BOTTOM_PADDING = 14;
const PREMATCH_LABEL_WIDTH = 130;
const PREMATCH_LABEL_HEIGHT = 42;
const PREMATCH_BUTTON_WIDTH = 130;
const PREMATCH_BUTTON_HEIGHT = 42;
const PREMATCH_TEAM_HEADER_Y = 170;
const PREMATCH_READY_TEXT_Y = 126;
const PREMATCH_READY_TEXT_WIDTH = 220;
const PREMATCH_READY_TEXT_HEIGHT = 40;
const PREMATCH_READY_TEXT_SIZE = 32;
const PREMATCH_ROSTER_START_Y = 214;
const PREMATCH_ROSTER_ROW_HEIGHT = 16;
const PREMATCH_ROSTER_TEXT_WIDTH = 130;
const PREMATCH_ROSTER_TEXT_HEIGHT = 16;
const PREMATCH_ROSTER_TEXT_SIZE = 14;
const PREMATCH_ROSTER_LINE_WIDTH = 118;
const PREMATCH_ROSTER_LINE_HEIGHT = 1;
const POSTMATCH_MAX_LINES = 24;
let prematchPanelLayoutKey = "";

interface PrematchPanelLayout {
  rows: number;
  visibleRows: number;
  panelHeight: number;
  panelCenterY: number;
  buttonY: number;
  labelY: number;
  layoutKey: string;
}

function getPrematchTeamCountsFromServerPlayers(): { team1Count: number; team2Count: number } {
  let team1Count = 0;
  let team2Count = 0;

  serverPlayers.forEach((p) => {
    const t = mod.GetTeam(p.player);
    if (mod.Equals(t, team1)) team1Count++;
    else if (mod.Equals(t, team2)) team2Count++;
  });

  return { team1Count, team2Count };
}

function getPrematchVisibleRowsForPanelHeight(panelHeight: number): number {
  const buttonY = panelHeight - PREMATCH_BUTTON_HEIGHT - PREMATCH_PANEL_BOTTOM_PADDING;
  const rosterBottomLimitY = buttonY - PREMATCH_ROSTER_TO_BUTTON_GAP;
  const rawVisibleRows =
    Math.floor(
      (rosterBottomLimitY - PREMATCH_ROSTER_START_Y - PREMATCH_ROSTER_TEXT_HEIGHT) / PREMATCH_ROSTER_ROW_HEIGHT
    ) + 1;

  return mod.Max(0, Math.min(MAX_ROSTER_LINES, rawVisibleRows));
}

function computePrematchPanelLayout(team1Count: number, team2Count: number): PrematchPanelLayout {
  const rows = Math.min(MAX_ROSTER_LINES, mod.Max(team1Count, team2Count));
  const rosterBottomY =
    PREMATCH_ROSTER_START_Y +
    mod.Max(0, rows - 1) * PREMATCH_ROSTER_ROW_HEIGHT +
    PREMATCH_ROSTER_TEXT_HEIGHT;

  const requiredHeight =
    rosterBottomY + PREMATCH_ROSTER_TO_BUTTON_GAP + PREMATCH_BUTTON_HEIGHT + PREMATCH_PANEL_BOTTOM_PADDING;
  const panelHeight = mod.Max(PREMATCH_PANEL_MIN_HEIGHT, Math.min(PREMATCH_PANEL_MAX_HEIGHT, requiredHeight));
  const panelCenterY = PREMATCH_PANEL_TOP_LOCK_REL_Y + panelHeight / 2;
  const buttonY = panelHeight - PREMATCH_BUTTON_HEIGHT - PREMATCH_PANEL_BOTTOM_PADDING;
  const labelY = buttonY;
  const visibleRows = getPrematchVisibleRowsForPanelHeight(panelHeight);
  const layoutKey = "rows:" + rows + "|h:" + panelHeight + "|vr:" + visibleRows;

  return {
    rows,
    visibleRows,
    panelHeight,
    panelCenterY,
    buttonY,
    labelY,
    layoutKey,
  };
}

function computePrematchPanelLayoutFromServerPlayers(): PrematchPanelLayout {
  const counts = getPrematchTeamCountsFromServerPlayers();
  return computePrematchPanelLayout(counts.team1Count, counts.team2Count);
}

function applyPrematchPanelLayout(layout: PrematchPanelLayout, force: boolean = false): void {
  const panel = SafeFindWidget("PreMatchContainer");
  const team1Header = SafeFindWidget("Text_Team_1");
  const team2Header = SafeFindWidget("Text_Team_2");

  const canSkip =
    !force &&
    prematchPanelLayoutKey === layout.layoutKey &&
    panel !== null &&
    team1Header !== null &&
    team2Header !== null;

  if (canSkip) return;

  if (panel) {
    SafeSetWidgetPositionHandle(panel, mod.CreateVector(PREMATCH_PANEL_POS_X, layout.panelCenterY, 0));
    SafeSetWidgetSizeHandle(panel, mod.CreateVector(PREMATCH_PANEL_WIDTH, layout.panelHeight, 0));
  }

  if (team1Header) {
    SafeSetWidgetPositionHandle(
      team1Header,
      mod.CreateVector(-PREMATCH_COLUMN_CENTER_OFFSET, PREMATCH_TEAM_HEADER_Y, 0)
    );
  }

  if (team2Header) {
    SafeSetWidgetPositionHandle(
      team2Header,
      mod.CreateVector(PREMATCH_COLUMN_CENTER_OFFSET, PREMATCH_TEAM_HEADER_Y, 0)
    );
  }

  if (panel && team1Header && team2Header) prematchPanelLayoutKey = layout.layoutKey;
}

let postMatchWidgetsToDelete: string[] = [];

/* VoiceOver flag mapping */
const voflags: { [key: string]: mod.VoiceOverFlags } = {
  A: mod.VoiceOverFlags.Alpha,
  B: mod.VoiceOverFlags.Bravo,
  C: mod.VoiceOverFlags.Charlie,
  D: mod.VoiceOverFlags.Delta,
  E: mod.VoiceOverFlags.Echo,
  F: mod.VoiceOverFlags.Foxtrot,
};

function getVoiceOverFlagForSymbol(symbol: ObjectiveLetter): mod.VoiceOverFlags {
  return voflags[symbol] ?? mod.VoiceOverFlags.Alpha;
}

/* -----------------------------------------------------------------------------------------------
   Top-level UI layout
------------------------------------------------------------------------------------------------ */

const UIWidget = modlib.ParseUI({
  name: "UIContainer",
  type: "Container",
  position: [0, 0],
  size: [7000, 5000],
  anchor: mod.UIAnchor.TopCenter,
  visible: true,
  padding: 0,
  bgColor: [0, 0, 0],
  bgAlpha: 1,
  bgFill: mod.UIBgFill.None,
  children: [
    {
      name: "LiveContainer",
      type: "Container",
      position: [0, 0],
      size: [1920, 1080],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0,
      bgFill: mod.UIBgFill.None,
      children: [
        // Left HUD live timer (keeps widget name "RemainingTime" so SetUITime keeps working)
        {
          name: "matchtime",
          type: "Container",
          position: [LIVE_TIMER_DEFAULT_POS_X, LIVE_TIMER_DEFAULT_POS_Y],
          size: [LIVE_TIMER_DEFAULT_WIDTH, LIVE_TIMER_DEFAULT_HEIGHT],
          anchor: mod.UIAnchor.TopLeft,
          visible: true,
          padding: 0,
          bgColor: [0.1216, 0.1216, 0.1216],
          bgAlpha: 0.8,
          bgFill: mod.UIBgFill.None,
          children: [
            {
              name: "RemainingTime",
              type: "Text",
              position: [LIVE_TIMER_DEFAULT_TEXT_POS_X, LIVE_TIMER_DEFAULT_TEXT_POS_Y],
              size: [LIVE_TIMER_DEFAULT_TEXT_WIDTH, LIVE_TIMER_DEFAULT_TEXT_HEIGHT],
              anchor: mod.UIAnchor.Center,
              visible: true,
              padding: 0,
              bgColor: [0, 0, 0],
              bgAlpha: 0,
              bgFill: mod.UIBgFill.None,
              textLabel: mod.stringkeys.TimeDefault,
              textColor: [1, 1, 1],
              textAlpha: 1,
              textSize: LIVE_TIMER_DEFAULT_TEXT_SIZE,
              textAnchor: mod.UIAnchor.Center,
            },
          ],
        },
        {
          name: "LiveTimerIntroContainer",
          type: "Container",
          position: [LIVE_TIMER_INTRO_POS_X, LIVE_TIMER_INTRO_POS_Y],
          size: [LIVE_TIMER_INTRO_WIDTH, LIVE_TIMER_INTRO_HEIGHT],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.5,
          bgFill: mod.UIBgFill.Blur,
          children: [
            {
              name: "LiveTimerIntroLabel",
              type: "Text",
              position: [LIVE_TIMER_INTRO_LABEL_POS_X, LIVE_TIMER_INTRO_LABEL_POS_Y],
              size: [LIVE_TIMER_INTRO_LABEL_WIDTH, LIVE_TIMER_INTRO_LABEL_HEIGHT],
              anchor: mod.UIAnchor.Center,
              visible: true,
              padding: 0,
              bgColor: [0, 0, 0],
              bgAlpha: 0,
              bgFill: mod.UIBgFill.None,
              textLabel: mod.stringkeys.Text_TimeRemaining,
              textColor: LIVE_TIMER_INTRO_LABEL_TEXT_COLOR,
              textAlpha: 1,
              textSize: LIVE_TIMER_INTRO_LABEL_TEXT_SIZE,
              textAnchor: mod.UIAnchor.Center,
            },
            {
              name: "LiveTimerIntroValue",
              type: "Text",
              position: [LIVE_TIMER_INTRO_VALUE_POS_X, LIVE_TIMER_INTRO_VALUE_POS_Y],
              size: [LIVE_TIMER_INTRO_VALUE_WIDTH, LIVE_TIMER_INTRO_VALUE_HEIGHT],
              anchor: mod.UIAnchor.Center,
              visible: true,
              padding: 0,
              bgColor: [0, 0, 0],
              bgAlpha: 0,
              bgFill: mod.UIBgFill.None,
              textLabel: mod.stringkeys.TimeDefault,
              textColor: LIVE_TIMER_INTRO_VALUE_TEXT_COLOR,
              textAlpha: 1,
              textSize: LIVE_TIMER_INTRO_VALUE_TEXT_SIZE,
              textAnchor: mod.UIAnchor.Center,
            },
          ],
        },

      ],
    },
    {
      name: "PostMatchContainer",
      type: "Container",
      position: [0, 0],
      size: [7000, 5000],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
    },
    {
  name: "PreMatchContainer",
  type: "Container",
  position: [PREMATCH_PANEL_POS_X, PREMATCH_PANEL_POS_Y],
  size: [PREMATCH_PANEL_WIDTH, PREMATCH_PANEL_HEIGHT],
  anchor: PREMATCH_PANEL_ANCHOR,
  visible: true,
  padding: 0,
  bgColor: [0, 0, 0],
  bgAlpha: 0.5,
  bgFill: mod.UIBgFill.Blur,
  children: [
    {
      name: "Text_Cipher_Esports",
      type: "Text",
      position: [-72, 22],
      size: [130, 42],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Cipher_Esports,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 22,
      textAnchor: mod.UIAnchor.Center
    },
    {
      name: "Text_Mode_Domination",
      type: "Text",
      position: [72, 22],
      size: [130, 42],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Mode_Domination,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 22,
      textAnchor: mod.UIAnchor.Center
    },
    {
      name: "Text_Current_Map",
      type: "Text",
      position: [0, 70],
      size: [260, 48],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Current_Map,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 20,
      textAnchor: mod.UIAnchor.Center
    },
    {
      name: "Container_NRDAA",
      type: "Container",
      position: [0, 18],
      size: [1, 58],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [1, 1, 1],
      bgAlpha: 0.8,
      bgFill: mod.UIBgFill.Solid
    },

    {
      name: "Text_Team_1",
      type: "Text",
      position: [-72, PREMATCH_TEAM_HEADER_Y],
      size: [130, 34],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Team_1,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 22,
      textAnchor: mod.UIAnchor.Center
    },
    {
      name: "Text_Team_2",
      type: "Text",
      position: [72, PREMATCH_TEAM_HEADER_Y],
      size: [130, 34],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Team_2,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 22,
      textAnchor: mod.UIAnchor.Center
    }
  ]
},
    {
      name: "CountDownContainer",
      type: "Container",
      position: [0, 150],
      size: [300, 150],
      anchor: mod.UIAnchor.TopCenter,
      visible: false,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Blur,
      children: [
        {
          name: "MatchStartsText",
          type: "Text",
          position: [0, 0],
          size: [300, 50],
          anchor: mod.UIAnchor.TopCenter,
          visible: false,
          padding: 0,
          bgColor: [0.2, 0.2, 0.2],
          bgAlpha: 1,
          bgFill: mod.UIBgFill.None,
          textLabel: mod.stringkeys.Redeploying,
          textColor: [1, 1, 1],
          textAlpha: 1,
          textSize: 50,
          textAnchor: mod.UIAnchor.Center,
        },
        {
          name: "CountDownText",
          type: "Text",
          position: [0, 50],
          size: [300, 100],
          anchor: mod.UIAnchor.TopCenter,
          visible: false,
          padding: 0,
          bgColor: [0.2, 0.2, 0.2],
          bgAlpha: 1,
          bgFill: mod.UIBgFill.None,
          textLabel: mod.stringkeys.CountDownText,
          textColor: [1, 1, 1],
          textAlpha: 1,
          textSize: 100,
          textAnchor: mod.UIAnchor.Center,
        },
      ],
    },
  ],
});
SetCountdownOverlayVisible(false);
SetCountdownOverlayDepthAboveGameUI();

function HandlePrematchReadyUp(player: mod.Player): void {
  if (gameStatus !== 0) return;
  if (!mod.IsPlayerValid(player)) return;
  if (isBotBackfillPlayer(player)) return;

  const p = serverPlayers.get(modlib.getPlayerId(player));
  if (!p) return;

  // Prematch authority stays on interact points; UI only reflects the authoritative state.
  p.changeReady();
  refreshPrematchReadyStateUi();

  if (SFX_ReadyUp) mod.PlaySound(SFX_ReadyUp, 0.8, player);
}

function HandlePrematchSwitchTeams(player: mod.Player): void {
  if (gameStatus !== 0) return;
  if (!mod.IsPlayerValid(player)) return;
  if (isBotBackfillPlayer(player)) return;
  const playerId = modlib.getPlayerId(player);
  if (isPrematchSwitchDebounced(playerId)) return;
  const p = serverPlayers.get(playerId);
  const currentTeam = mod.GetTeam(player);
  // If they were ready, unready them when switching before the redeploy path begins.
  if (p && p.isReady()) p.changeReady();
  const goingToTeam2 = modlib.getTeamId(currentTeam) === 1;
  const newTeam = goingToTeam2 ? team2 : team1;
  switchTeamPrematchAndRedeploy(player, newTeam);
  markPrematchTeamSwitchTick(playerId);
  p?.setTeam();
  setReadyPhaseProtectionForPlayer(player, true);
  if (p) UpdateTopFlagColorsForPlayer(p);
  refreshPrematchReadyStateUi();
}
// Force key UI widgets to render AboveGameUI (above deploy screen / game UI layer)
function SetDepthAboveGameUI(name: string): void {
  const w = mod.FindUIWidgetWithName(name);
  if (!w) return;
  mod.SetUIWidgetDepth(w, mod.UIDepth.AboveGameUI);
}

function SetCountdownOverlayDepthAboveGameUI(): void {
  SetDepthAboveGameUI("CountDownContainer");
}

function SetCountdownOverlayVisible(visible: boolean): void {
  SafeSetWidgetVisibleByName("CountDownContainer", visible);
  SafeSetWidgetVisibleByName("MatchStartsText", visible);
  SafeSetWidgetVisibleByName("CountDownText", visible);
}

function getTopHudFlagContainerWidgetName(lane: TopHudLane): string {
  return "Container_" + lane;
}

function setLiveScorePanelVisible(visible: boolean): void {
  const rootHudWidgets = [
    "BG_Score_Container",
    "Container_A",
    "Container_B",
    "Container_C",
    "Container_D",
    "Container_E",
    "Container_F",
    "friendlyscore",
    "enemyscore",
  ];

  for (let i = 0; i < rootHudWidgets.length; i++) {
    const widget = mod.FindUIWidgetWithName(rootHudWidgets[i]);
    if (!widget) continue;
    SafeSetWidgetVisibleHandle(widget, visible);
  }

  serverPlayers.forEach((p) => {
    const playerId = p.id;
    const perPlayerWidgets = [
      "TeamFriendlyScore" + playerId,
      "TeamOpponentScore" + playerId,
      "FriendlyScorePulse" + playerId,
      "EnemyScorePulse" + playerId,
      "Text_BombCarrier" + playerId,
      BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
      BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
    ];

    for (let i = 0; i < perPlayerWidgets.length; i++) {
      const widget = mod.FindUIWidgetWithName(perPlayerWidgets[i]);
      if (!widget) continue;
      // Bomb carrier and bomb notice visibility are controlled from authoritative runtime state.
      // Only force-hide them outside live contexts.
      if (visible && (
        perPlayerWidgets[i] === "Text_BombCarrier" + playerId ||
        perPlayerWidgets[i] === BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId ||
        perPlayerWidgets[i] === BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId
      )) continue;
      SafeSetWidgetVisibleHandle(widget, visible);
    }
  });

  if (visible) {
    UpdateBombCarrierUiForAllPlayers();
    refreshBombNoticeUiForAllPlayers();
  }
}



// Auto-generated-style score panel kept as a dedicated widget block.
const bgScoreContainerWidget = modlib.ParseUI({
  name: "BG_Score_Container",
  type: "Container",
  position: [38.03, 660.56],
  size: [288.02, 88],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.5,
  bgFill: mod.UIBgFill.Solid,
});
// Keep an explicit reference so the dedicated ParseUI block is retained for side effects.
void bgScoreContainerWidget;

const containerAWidget = modlib.ParseUI({
  name: "Container_A",
  type: "Container",
  position: [38.03, 660.56],
  size: [44, 44],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.4,
  bgFill: mod.UIBgFill.None,
});
void containerAWidget;

const containerBWidget = modlib.ParseUI({
  name: "Container_B",
  type: "Container",
  position: [84.33, 660.56],
  size: [44, 44],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.4,
  bgFill: mod.UIBgFill.None,
});
void containerBWidget;

const containerCWidget = modlib.ParseUI({
  name: "Container_C",
  type: "Container",
  position: [130.64, 660.56],
  size: [44, 44],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.4,
  bgFill: mod.UIBgFill.None,
});
void containerCWidget;

const containerDWidget = modlib.ParseUI({
  name: "Container_D",
  type: "Container",
  position: [181.3, 660.56],
  size: [44, 44],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.4,
  bgFill: mod.UIBgFill.None,
});
void containerDWidget;

const containerEWidget = modlib.ParseUI({
  name: "Container_E",
  type: "Container",
  position: [228, 660.56],
  size: [44, 44],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.4,
  bgFill: mod.UIBgFill.None,
});
void containerEWidget;

const containerFWidget = modlib.ParseUI({
  name: "Container_F",
  type: "Container",
  position: [274, 660.56],
  size: [44, 44],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.0314, 0.0431, 0.0431],
  bgAlpha: 0.4,
  bgFill: mod.UIBgFill.None,
});
void containerFWidget;

const friendlyScoreWidget = modlib.ParseUI({
  name: "friendlyscore",
  type: "Container",
  position: [56.33, 698.56],
  size: [100, 50],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.2314, 0.4196, 0.6745],
  bgAlpha: 0,
  bgFill: mod.UIBgFill.None,
});
void friendlyScoreWidget;

const enemyScoreWidget = modlib.ParseUI({
  name: "enemyscore",
  type: "Container",
  position: [203.91, 698.56],
  size: [100, 50],
  anchor: mod.UIAnchor.TopLeft,
  visible: false,
  padding: 0,
  bgColor: [0.698, 0.1882, 0.1882],
  bgAlpha: 0,
  bgFill: mod.UIBgFill.None,
});
void enemyScoreWidget;

/* -----------------------------------------------------------------------------------------------
   Match start banner (DOMINATION splash)
------------------------------------------------------------------------------------------------ */

const MATCH_START_BANNER_SHOW_SECONDS = 2.0;
let matchStartBannerRunning = false;
let hasShownMatchStartBanner = false;

function resetMatchStartBannerState(resetShown: boolean = false): void {
  if (resetShown) hasShownMatchStartBanner = false;
  matchStartBannerRunning = false;
  SafeSetWidgetVisibleByName("Container_0NX1G", false);
}

const container0nx1gWidget = modlib.ParseUI({
  name: "Container_0NX1G",
  type: "Container",
  position: [0, 0],
  size: [1920, 1080],
  anchor: mod.UIAnchor.TopCenter,
  visible: false,
  padding: 0,
  bgColor: [0, 0, 0],
  bgAlpha: 0,
  bgFill: mod.UIBgFill.None,
  children: [
    {
      name: "Text_Cipher_Presents",
      type: "Text",
      position: [0, -325],
      size: [650, 110],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Cipher_Presents,
      textColor: [0.35, 0.65, 1.0],
      textAlpha: 1,
      textSize: 34,
      textAnchor: mod.UIAnchor.TopCenter,
    },
    {
      name: "Intro_DOMINATION_Text",
      type: "Text",
      position: [0, 200],
      size: [650, 110],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [1.0, 0.55, 0.18],
      bgAlpha: 0.95,
      bgFill: mod.UIBgFill.Solid,
      textLabel: mod.stringkeys.Text_Domination,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 60,
      textAnchor: mod.UIAnchor.Center,
    },
    {
      name: "Intro_DOMINATION_Line_Left",
      type: "Container",
      position: [-385, 200],
      size: [80, 110],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [1.0, 0.45, 0.16],
      bgAlpha: 0.9,
      bgFill: mod.UIBgFill.GradientRight,
    },
    {
      name: "Intro_DOMINATION_Line_Right",
      type: "Container",
      position: [385, 200],
      size: [80, 110],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [1.0, 0.45, 0.16],
      bgAlpha: 0.9,
      bgFill: mod.UIBgFill.GradientLeft,
    },
  ],
});

function Lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

async function showMatchStartBannerOnce(): Promise<void> {
  if (hasShownMatchStartBanner || matchStartBannerRunning) return;
  matchStartBannerRunning = true;
  let root: mod.UIWidget | undefined = undefined;

  try {
    await mod.Wait(0.8); // Wait for the match start stinger to finish playing

    root = mod.FindUIWidgetWithName("Container_0NX1G");
    const textW = mod.FindUIWidgetWithName("Intro_DOMINATION_Text");
    const leftW = mod.FindUIWidgetWithName("Intro_DOMINATION_Line_Left");
    const rightW = mod.FindUIWidgetWithName("Intro_DOMINATION_Line_Right");

    if (!root || !textW || !leftW || !rightW) {
      return;
    }

    hasShownMatchStartBanner = true;
    mod.SetUIWidgetVisible(root, true);

    mod.SetUIWidgetBgAlpha(textW, 1);
    mod.SetUITextAlpha(textW, 1);

    mod.SetUIWidgetBgAlpha(leftW, 1);
    mod.SetUIWidgetBgAlpha(rightW, 1);

    await mod.Wait(MATCH_START_BANNER_SHOW_SECONDS);

    let currentLerpValue = 0;
    let lerpIncrement = 0;

    while (currentLerpValue < 1.0) {
      lerpIncrement += 0.1;
      currentLerpValue = Lerp(currentLerpValue, 1, lerpIncrement);

      const a = 1 - currentLerpValue;

      mod.SetUIWidgetBgAlpha(textW, a);
      mod.SetUITextAlpha(textW, a);
      mod.SetUIWidgetBgAlpha(leftW, a);
      mod.SetUIWidgetBgAlpha(rightW, a);

      await mod.Wait(0.1);
    }

    mod.SetUIWidgetVisible(root, false);
  } catch (err) {
    LogRuntimeError("showMatchStartBannerOnce", err);
    if (root) {
      try {
        mod.SetUIWidgetVisible(root, false);
      } catch (_hideErr) {}
    }
  } finally {
    matchStartBannerRunning = false;
  }
}

/* -----------------------------------------------------------------------------------------------
   Prematch roster UI
------------------------------------------------------------------------------------------------ */
// -------------------- Prematch UI (per-player) --------------------

const UI_PREMATCH_CONTAINER_ID = "UI_PREMATCH_CONTAINER_";
const UI_PREMATCH_BUTTON_READY_ID = "UI_PREMATCH_BUTTON_READY_";
const UI_PREMATCH_BUTTON_SWITCH_ID = "UI_PREMATCH_BUTTON_SWITCH_";
const UI_PREMATCH_LABEL_READY_ID = "UI_PREMATCH_LABEL_READY_";
const UI_PREMATCH_LABEL_SWITCH_ID = "UI_PREMATCH_LABEL_SWITCH_";

const PREMATCH_BUTTON_TEXT_COLOR = mod.CreateVector(0.0314, 0.0431, 0.0431);
const PREMATCH_BUTTON_BASE_COLOR = mod.CreateVector(0.0745, 0.1843, 0.2471);
const PREMATCH_BUTTON_HOVER_COLOR = mod.CreateVector(1, 1, 1);
const PREMATCH_BUTTON_PRESSED_COLOR = mod.CreateVector(0.4392, 0.9216, 1);

function safeFind(name: string): mod.UIWidget | undefined {
  try {
    const root = mod.GetUIRoot();
    try {
      const wRoot = mod.FindUIWidgetWithName(name, root);
      if (wRoot && mod.IsType(wRoot, mod.Types.UIWidget)) return wRoot as mod.UIWidget;
    } catch {
    }

    const w = mod.FindUIWidgetWithName(name);
    if (w && mod.IsType(w, mod.Types.UIWidget)) return w as mod.UIWidget;
  } catch {
  }
  return undefined;
}

function applyPrematchLayoutToPlayerWidgets(playerId: number, layout: PrematchPanelLayout): void {
  const container = safeFind(UI_PREMATCH_CONTAINER_ID + playerId);
  if (container) {
    SafeSetWidgetPositionHandle(container, mod.CreateVector(PREMATCH_PANEL_POS_X, layout.panelCenterY, 0));
    SafeSetWidgetSizeHandle(container, mod.CreateVector(PREMATCH_PANEL_WIDTH, layout.panelHeight, 0));
  }

  const readyButton = safeFind(UI_PREMATCH_BUTTON_READY_ID + playerId);
  if (readyButton) {
    SafeSetWidgetPositionHandle(
      readyButton,
      mod.CreateVector(-PREMATCH_COLUMN_CENTER_OFFSET, layout.buttonY, 0)
    );
    SafeSetWidgetSizeHandle(readyButton, mod.CreateVector(PREMATCH_BUTTON_WIDTH, PREMATCH_BUTTON_HEIGHT, 0));
  }

  const switchButton = safeFind(UI_PREMATCH_BUTTON_SWITCH_ID + playerId);
  if (switchButton) {
    SafeSetWidgetPositionHandle(switchButton, mod.CreateVector(PREMATCH_COLUMN_CENTER_OFFSET, layout.buttonY, 0));
    SafeSetWidgetSizeHandle(switchButton, mod.CreateVector(PREMATCH_BUTTON_WIDTH, PREMATCH_BUTTON_HEIGHT, 0));
  }

  const readyLabel = safeFind(UI_PREMATCH_LABEL_READY_ID + playerId);
  if (readyLabel) {
    SafeSetWidgetPositionHandle(readyLabel, mod.CreateVector(-PREMATCH_COLUMN_CENTER_OFFSET, layout.labelY, 0));
    SafeSetWidgetSizeHandle(readyLabel, mod.CreateVector(PREMATCH_LABEL_WIDTH, PREMATCH_LABEL_HEIGHT, 0));
  }

  const switchLabel = safeFind(UI_PREMATCH_LABEL_SWITCH_ID + playerId);
  if (switchLabel) {
    SafeSetWidgetPositionHandle(switchLabel, mod.CreateVector(PREMATCH_COLUMN_CENTER_OFFSET, layout.labelY, 0));
    SafeSetWidgetSizeHandle(switchLabel, mod.CreateVector(PREMATCH_LABEL_WIDTH, PREMATCH_LABEL_HEIGHT, 0));
  }
}


function ensurePrematchLabelOverlay(
  player: mod.Player,
  container: mod.UIWidget,
  labelName: string,
  posX: number,
  labelY: number,
  labelKey: any
): void {
  const existing = safeFind(labelName);
  if (!existing) {
    mod.AddUIText(
      labelName,
      mod.CreateVector(posX, labelY, 0),
      mod.CreateVector(PREMATCH_LABEL_WIDTH, PREMATCH_LABEL_HEIGHT, 0),
      mod.UIAnchor.TopCenter,
      container,
      true,
      0,
      mod.CreateVector(0, 0, 0),
      0,
      mod.UIBgFill.None,
      mod.Message(labelKey),
      22,
      PREMATCH_BUTTON_TEXT_COLOR,
      1,
      mod.UIAnchor.Center,
      player
    );
  }

  const label = safeFind(labelName);
  if (label) {
    SafeSetWidgetPositionHandle(label, mod.CreateVector(posX, labelY, 0));
    SafeSetWidgetSizeHandle(label, mod.CreateVector(PREMATCH_LABEL_WIDTH, PREMATCH_LABEL_HEIGHT, 0));
    mod.SetUITextLabel(label, mod.Message(labelKey));
    mod.SetUITextColor(label, PREMATCH_BUTTON_TEXT_COLOR);
    mod.SetUIWidgetDepth(label, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetVisible(label, true);
  }
}

function HideLegacyPrematchButtons(): void {
  const legacyNames = [
    "Button_Ready",
    "Button_Switch_Team",
    "Text_Ready",
    "Text_Switch_Teams",
    "Button_Ready_Label",
    "Button_Switch_Team_Label",
  ];

  for (let i = 0; i < legacyNames.length; i++) {
    const w = safeFind(legacyNames[i]);
    if (!w) continue;
    try {
      mod.SetUIWidgetVisible(w, false);
      // Defensive: ensure legacy buttons never capture input
      if (legacyNames[i] === "Button_Ready" || legacyNames[i] === "Button_Switch_Team") {
        mod.EnableUIButtonEvent(w, mod.UIButtonEvent.ButtonDown, false);
        mod.EnableUIButtonEvent(w, mod.UIButtonEvent.ButtonUp, false);
      }
    } catch {
      // ignore
    }
  }
}


function EnsurePrematchButtonsForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;

  HideLegacyPrematchButtons();

  const pid = mod.GetObjId(player);
  const layout = computePrematchPanelLayoutFromServerPlayers();
  applyPrematchPanelLayout(layout);

  const containerName = UI_PREMATCH_CONTAINER_ID + pid;
  const readyBtnName = UI_PREMATCH_BUTTON_READY_ID + pid;
  const switchBtnName = UI_PREMATCH_BUTTON_SWITCH_ID + pid;
  const readyLabelName = UI_PREMATCH_LABEL_READY_ID + pid;
  const switchLabelName = UI_PREMATCH_LABEL_SWITCH_ID + pid;

  const applyButtonBaseAndAlphas = (btn: mod.UIWidget): void => {
    mod.SetUIButtonEnabled(btn, true);

    mod.SetUIButtonColorBase(btn, PREMATCH_BUTTON_BASE_COLOR);
    mod.SetUIButtonColorDisabled(btn, PREMATCH_BUTTON_BASE_COLOR);
    mod.SetUIButtonColorPressed(btn, PREMATCH_BUTTON_PRESSED_COLOR);
    mod.SetUIButtonColorHover(btn, PREMATCH_BUTTON_HOVER_COLOR);
    mod.SetUIButtonColorFocused(btn, PREMATCH_BUTTON_BASE_COLOR);

    mod.SetUIButtonAlphaBase(btn, 1);
    mod.SetUIButtonAlphaDisabled(btn, 1);
    mod.SetUIButtonAlphaPressed(btn, 1);
    mod.SetUIButtonAlphaHover(btn, 1);
    mod.SetUIButtonAlphaFocused(btn, 1);

    mod.SetUIWidgetDepth(btn, mod.UIDepth.AboveGameUI);
  };

  const existingContainer = safeFind(containerName);
  if (existingContainer) {
    mod.EnableUIInputMode(true, player);

    const readyBtn = safeFind(readyBtnName);
    const switchBtn = safeFind(switchBtnName);

    const rebuild = false;

    if (rebuild) {
      const readyLabel = safeFind(readyLabelName);
      const switchLabel = safeFind(switchLabelName);

      if (readyLabel) mod.DeleteUIWidget(readyLabel);
      if (switchLabel) mod.DeleteUIWidget(switchLabel);
      if (readyBtn) mod.DeleteUIWidget(readyBtn);
      if (switchBtn) mod.DeleteUIWidget(switchBtn);

      mod.DeleteUIWidget(existingContainer);
    } else {
      mod.SetUIWidgetVisible(existingContainer, true);
      mod.SetUIWidgetDepth(existingContainer, mod.UIDepth.AboveGameUI);
      applyPrematchLayoutToPlayerWidgets(pid, layout);

      if (readyBtn) applyButtonBaseAndAlphas(readyBtn);
      if (switchBtn) applyButtonBaseAndAlphas(switchBtn);

      ensurePrematchLabelOverlay(
        player,
        existingContainer,
        readyLabelName,
        -PREMATCH_COLUMN_CENTER_OFFSET,
        layout.labelY,
        mod.stringkeys.Text_Ready
      );
      ensurePrematchLabelOverlay(
        player,
        existingContainer,
        switchLabelName,
        PREMATCH_COLUMN_CENTER_OFFSET,
        layout.labelY,
        mod.stringkeys.Text_Switch_Teams
      );

      applyPrematchLayoutToPlayerWidgets(pid, layout);
      return;
    }
  }

  mod.EnableUIInputMode(true, player);

  mod.AddUIContainer(
    containerName,
    mod.CreateVector(PREMATCH_PANEL_POS_X, layout.panelCenterY, 0),
    mod.CreateVector(PREMATCH_PANEL_WIDTH, layout.panelHeight, 0),
    PREMATCH_PANEL_ANCHOR,
    mod.GetUIRoot(),
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    player
  );

  const container = safeFind(containerName);
  if (!container) return;
  mod.SetUIWidgetDepth(container, mod.UIDepth.AboveGameUI);

  mod.AddUIButton(
    readyBtnName,
    mod.CreateVector(-PREMATCH_COLUMN_CENTER_OFFSET, layout.buttonY, 0),
    mod.CreateVector(PREMATCH_BUTTON_WIDTH, PREMATCH_BUTTON_HEIGHT, 0),
    mod.UIAnchor.TopCenter,
    container,
    true,
    0,
    mod.CreateVector(1, 1, 1),
    1,
    mod.UIBgFill.Solid,
    true,
    PREMATCH_BUTTON_BASE_COLOR,
    1,
    PREMATCH_BUTTON_BASE_COLOR,
    1,
    PREMATCH_BUTTON_PRESSED_COLOR,
    1,
    PREMATCH_BUTTON_HOVER_COLOR,
    1,
    PREMATCH_BUTTON_BASE_COLOR,
    1,
    player
  );

  mod.AddUIButton(
    switchBtnName,
    mod.CreateVector(PREMATCH_COLUMN_CENTER_OFFSET, layout.buttonY, 0),
    mod.CreateVector(PREMATCH_BUTTON_WIDTH, PREMATCH_BUTTON_HEIGHT, 0),
    mod.UIAnchor.TopCenter,
    container,
    true,
    0,
    mod.CreateVector(1, 1, 1),
    1,
    mod.UIBgFill.Solid,
    true,
    PREMATCH_BUTTON_BASE_COLOR,
    1,
    PREMATCH_BUTTON_BASE_COLOR,
    1,
    PREMATCH_BUTTON_PRESSED_COLOR,
    1,
    PREMATCH_BUTTON_HOVER_COLOR,
    1,
    PREMATCH_BUTTON_BASE_COLOR,
    1,
    player
  );

  const readyBtn2 = safeFind(readyBtnName);
  const switchBtn2 = safeFind(switchBtnName);
  if (!readyBtn2 || !switchBtn2) return;

  applyButtonBaseAndAlphas(readyBtn2);
  applyButtonBaseAndAlphas(switchBtn2);

  ensurePrematchLabelOverlay(
    player,
    container,
    readyLabelName,
    -PREMATCH_COLUMN_CENTER_OFFSET,
    layout.labelY,
    mod.stringkeys.Text_Ready
  );
  ensurePrematchLabelOverlay(
    player,
    container,
    switchLabelName,
    PREMATCH_COLUMN_CENTER_OFFSET,
    layout.labelY,
    mod.stringkeys.Text_Switch_Teams
  );

  applyPrematchLayoutToPlayerWidgets(pid, layout);
}




function SetPrematchButtonsVisibleForPlayer(player: mod.Player, visible: boolean): void {
  if (!mod.IsPlayerValid(player)) return;

  const pid = mod.GetObjId(player);
  const container = safeFind(UI_PREMATCH_CONTAINER_ID + pid);
  const rdybutton = safeFind(UI_PREMATCH_BUTTON_READY_ID + pid);
  const switchbutton = safeFind(UI_PREMATCH_BUTTON_SWITCH_ID + pid);
  const txtready = safeFind(UI_PREMATCH_LABEL_READY_ID + pid);
  const txtswitch = safeFind(UI_PREMATCH_LABEL_SWITCH_ID + pid);
  if (container) mod.SetUIWidgetVisible(container, visible);
  if (rdybutton) mod.SetUIWidgetVisible(rdybutton, visible);
  if (switchbutton) mod.SetUIWidgetVisible(switchbutton, visible);
  if (txtready) mod.SetUIWidgetVisible(txtready, visible);
  if (txtswitch) mod.SetUIWidgetVisible(txtswitch, visible);
  // If you hide the UI, you generally want to turn off UI input mode too.
  if (!visible) mod.EnableUIInputMode(false, player);
}

function SetPrematchButtonsVisibleForAllPlayers(visible: boolean): void {
  const allPlayers = mod.AllPlayers();
  for (let i = 0; i < mod.CountOf(allPlayers); i++) {
    const p = mod.ValueInArray(allPlayers, i) as mod.Player;
    if (p && mod.IsPlayerValid(p)) SetPrematchButtonsVisibleForPlayer(p, visible);
  }
}
// Prematch roster UI lists centered player names with a light separator line under each row.

let prematchRosterTeam1Lines: (mod.UIWidget | null)[] = [];
let prematchRosterTeam2Lines: (mod.UIWidget | null)[] = [];

const ROSTER_LINE_COLOR = mod.CreateVector(0.9, 0.9, 0.9);

function warnPrematchUiGuardOnce(key: string, message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (prematchUiGuardWarnedByKey[key] === true) return;
  prematchUiGuardWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(message);
}

function resetPrematchRosterBuildState(): void {
  prematchRosterBuilt = false;
  prematchRosterTeam1 = [];
  prematchRosterTeam2 = [];
  prematchRosterTeam1Lines = [];
  prematchRosterTeam2Lines = [];
  prematchPanelLayoutKey = "";
}

function BuildPrematchRosterUI(): void {
    if (prematchRosterBuilt) return;

    const parent = SafeFindWidget("PreMatchContainer");
    if (!parent) {
      warnPrematchUiGuardOnce(
        "prematch_roster_parent_missing",
        mod.Message("[PREMATCH ROSTER] missing parent widget {}", "PreMatchContainer")
      );
      return;
    }

    let buildOk = false;
    try {
      const initialLayout = computePrematchPanelLayoutFromServerPlayers();
      applyPrematchPanelLayout(initialLayout, true);

      const startY = PREMATCH_ROSTER_START_Y;
      const rowH = PREMATCH_ROSTER_ROW_HEIGHT;

      const textW = PREMATCH_ROSTER_TEXT_WIDTH;
      const textH = PREMATCH_ROSTER_TEXT_HEIGHT;

      const lineW = PREMATCH_ROSTER_LINE_WIDTH;
      const lineH = PREMATCH_ROSTER_LINE_HEIGHT;

      prematchRosterTeam1 = [];
      prematchRosterTeam2 = [];
      prematchRosterTeam1Lines = [];
      prematchRosterTeam2Lines = [];

      for (let i = 0; i < MAX_ROSTER_LINES; i++) {
          const y = startY + i * rowH;

          mod.AddUIText(
              "PreMatchRosterT1_" + i,
              mod.CreateVector(-PREMATCH_COLUMN_CENTER_OFFSET, y, 0),
              mod.CreateVector(textW, textH, 0),
              mod.UIAnchor.TopCenter,
              parent,
              false,
              0,
              mod.CreateVector(0, 0, 0),
              0,
              mod.UIBgFill.None,
              mod.Message(""),
              PREMATCH_ROSTER_TEXT_SIZE,
              mod.CreateVector(1, 1, 1),
              1,
              mod.UIAnchor.Center
          );

          mod.AddUIContainer(
              "PreMatchRosterT1Line_" + i,
              mod.CreateVector(-PREMATCH_COLUMN_CENTER_OFFSET, y + textH - 1, 0),
              mod.CreateVector(lineW, lineH, 0),
              mod.UIAnchor.TopCenter,
              parent,
              false,
              0,
              ROSTER_LINE_COLOR,
              0.8,
              mod.UIBgFill.Solid
          );

          mod.AddUIText(
              "PreMatchRosterT2_" + i,
              mod.CreateVector(PREMATCH_COLUMN_CENTER_OFFSET, y, 0),
              mod.CreateVector(textW, textH, 0),
              mod.UIAnchor.TopCenter,
              parent,
              false,
              0,
              mod.CreateVector(0, 0, 0),
              0,
              mod.UIBgFill.None,
              mod.Message(""),
              PREMATCH_ROSTER_TEXT_SIZE,
              mod.CreateVector(1, 1, 1),
              1,
              mod.UIAnchor.Center
          );

          mod.AddUIContainer(
              "PreMatchRosterT2Line_" + i,
              mod.CreateVector(PREMATCH_COLUMN_CENTER_OFFSET, y + textH - 1, 0),
              mod.CreateVector(lineW, lineH, 0),
              mod.UIAnchor.TopCenter,
              parent,
              false,
              0,
              ROSTER_LINE_COLOR,
              0.8,
              mod.UIBgFill.Solid
          );

          prematchRosterTeam1.push(SafeFindWidget("PreMatchRosterT1_" + i));
          prematchRosterTeam2.push(SafeFindWidget("PreMatchRosterT2_" + i));

          prematchRosterTeam1Lines.push(SafeFindWidget("PreMatchRosterT1Line_" + i));
          prematchRosterTeam2Lines.push(SafeFindWidget("PreMatchRosterT2Line_" + i));
      }

      buildOk = true;
    } catch (err) {
      LogRuntimeError("BuildPrematchRosterUI", err);
      warnPrematchUiGuardOnce(
        "prematch_roster_build_failed",
        mod.Message("[PREMATCH ROSTER] build failed (see runtime error log)")
      );
    } finally {
      prematchRosterBuilt = buildOk;
      if (!buildOk) {
        resetPrematchRosterBuildState();
      }
    }
}

function UpdatePrematchRosterUI(): void {
    if (!prematchRosterBuilt) {
      BuildPrematchRosterUI();
      if (!prematchRosterBuilt) return;
    }

    try {
      const team1Players: Player[] = [];
      const team2Players: Player[] = [];

      serverPlayers.forEach((p) => {
          const t = mod.GetTeam(p.player);
          if (mod.Equals(t, team1)) team1Players.push(p);
          else if (mod.Equals(t, team2)) team2Players.push(p);
      });

      team1Players.sort((a, b) => a.id - b.id);
      team2Players.sort((a, b) => a.id - b.id);

      const layout = computePrematchPanelLayout(team1Players.length, team2Players.length);
      applyPrematchPanelLayout(layout);
      for (let i = 0; i < MAX_ROSTER_LINES; i++) {
          const w = prematchRosterTeam1[i];
          const line = prematchRosterTeam1Lines[i];
          if (!w || !line) continue;

          if (i < team1Players.length && i < layout.visibleRows) {
              const p = team1Players[i];
              const ready = isBotBackfillPlayer(p.player) ? true : p.isReady();

              SafeSetWidgetVisibleHandle(w, true);
              SafeSetWidgetVisibleHandle(line, true);

              SafeSetTextColorHandle(w, ready ? mod.CreateVector(0, 1, 0) : mod.CreateVector(1, 0, 0));
              SafeSetTextLabelHandle(
                  w,
                  ready
                      ? mod.Message(mod.stringkeys.RosterReadyLine, p.player)
                      : mod.Message(mod.stringkeys.RosterNotReadyLine, p.player)
              );
          } else {
              SafeSetWidgetVisibleHandle(w, false);
              SafeSetWidgetVisibleHandle(line, false);
              SafeSetTextLabelHandle(w, mod.Message(""));
          }
      }

      for (let i = 0; i < MAX_ROSTER_LINES; i++) {
          const w = prematchRosterTeam2[i];
          const line = prematchRosterTeam2Lines[i];
          if (!w || !line) continue;

          if (i < team2Players.length && i < layout.visibleRows) {
              const p = team2Players[i];
              const ready = isBotBackfillPlayer(p.player) ? true : p.isReady();

              SafeSetWidgetVisibleHandle(w, true);
              SafeSetWidgetVisibleHandle(line, true);

              SafeSetTextColorHandle(w, ready ? mod.CreateVector(0, 1, 0) : mod.CreateVector(1, 0, 0));
              SafeSetTextLabelHandle(
                  w,
                  ready
                      ? mod.Message(mod.stringkeys.RosterReadyLine, p.player)
                      : mod.Message(mod.stringkeys.RosterNotReadyLine, p.player)
              );
          } else {
              SafeSetWidgetVisibleHandle(w, false);
              SafeSetWidgetVisibleHandle(line, false);
              SafeSetTextLabelHandle(w, mod.Message(""));
          }
      }
    } catch (err) {
      LogRuntimeError("UpdatePrematchRosterUI", err);
      warnPrematchUiGuardOnce(
        "prematch_roster_update_failed",
        mod.Message("[PREMATCH ROSTER] update failed; forcing rebuild")
      );
      resetPrematchRosterBuildState();
    }
}

function refreshPrematchReadyStateUi(): void {
  if (gameStatus !== -1 && gameStatus !== 0) return;
  const readyPlayers: [number, number] = [0, 0];
  const totalPlayers: [number, number] = [0, 0];
  serverPlayers.forEach((p) => {
    p.setTeam();
    const team = mod.GetTeam(p.player);
    if (isBotBackfillPlayer(p.player)) return;
    if (mod.Equals(team, team1)) {
      totalPlayers[0] += 1;
      if (p.isReady()) readyPlayers[0] += 1;
    } else if (mod.Equals(team, team2)) {
      totalPlayers[1] += 1;
      if (p.isReady()) readyPlayers[1] += 1;
    }
  });
  prematchReadyPlayersByTeam = readyPlayers;
  prematchTotalPlayersByTeam = totalPlayers;
  prematchAllPlayersReady =
    readyPlayers[0] === totalPlayers[0] &&
    readyPlayers[1] === totalPlayers[1] &&
    (readyPlayers[0] > 0 || readyPlayers[1] > 0);
  SafeSetTextLabelByName("PreMatchTeam1", mod.Message("{}/{}", readyPlayers[0], totalPlayers[0]));
  SafeSetTextLabelByName("PreMatchTeam2", mod.Message("{}/{}", readyPlayers[1], totalPlayers[1]));
  UpdatePrematchRosterUI();
}
/* -----------------------------------------------------------------------------------------------
   Per-player ReadyText (prematch)
------------------------------------------------------------------------------------------------ */

function replacePrematchReadyText(playerId: number, receiver: mod.Player): void {
  const readyTextName = "ReadyText" + playerId;
  safeDeleteWidgetByName(readyTextName);

  const parent = SafeFindWidget("PreMatchContainer");
  if (!parent) {
    readyTextBuiltByPlayerId[playerId] = false;
    delete readyTextWidgetByPlayerId[playerId];
    warnPrematchUiGuardOnce(
      "prematch_readytext_parent_missing",
      mod.Message("[PREMATCH READY TEXT] missing parent widget {}", "PreMatchContainer")
    );
    return;
  }

  try {
    mod.AddUIText(
      readyTextName,
      mod.CreateVector(0, PREMATCH_READY_TEXT_Y, 0),
      mod.CreateVector(PREMATCH_READY_TEXT_WIDTH, PREMATCH_READY_TEXT_HEIGHT, 0),
      mod.UIAnchor.TopCenter,
      parent,
      true,
      0,
      mod.CreateVector(0, 0, 0),
      0.4,
      mod.UIBgFill.None,
      mod.Message(mod.stringkeys.NotReady),
      PREMATCH_READY_TEXT_SIZE,
      mod.CreateVector(1, 0, 0),
      1,
      mod.UIAnchor.Center,
      receiver
    );
  } catch (err) {
    LogRuntimeError("replacePrematchReadyText/" + String(playerId), err);
    readyTextBuiltByPlayerId[playerId] = false;
    delete readyTextWidgetByPlayerId[playerId];
    return;
  }

  const readyWidget = SafeFindWidget(readyTextName);
  if (!readyWidget) {
    readyTextBuiltByPlayerId[playerId] = false;
    delete readyTextWidgetByPlayerId[playerId];
    warnPrematchUiGuardOnce(
      "prematch_readytext_handle_missing",
      mod.Message("[PREMATCH READY TEXT] widget missing after add {}", readyTextName)
    );
    return;
  }

  readyTextBuiltByPlayerId[playerId] = true;
  readyTextWidgetByPlayerId[playerId] = readyWidget;
}

function resolvePrematchReadyTextWidgetForPlayer(playerId: number): mod.UIWidget | undefined {
  const name = "ReadyText" + playerId;
  const widget = SafeFindWidget(name);
  if (!widget) {
    readyTextBuiltByPlayerId[playerId] = false;
    delete readyTextWidgetByPlayerId[playerId];
    return undefined;
  }

  readyTextBuiltByPlayerId[playerId] = true;
  readyTextWidgetByPlayerId[playerId] = widget;
  return widget;
}

/* -----------------------------------------------------------------------------------------------
   Live HUD (per player) build / rebuild
------------------------------------------------------------------------------------------------ */

function deletePlayerLiveHudWidgets(playerId: number): void {
  markCipherKeyHudDirtyForPlayer(playerId);
  safeDeleteWidgetByName("TeamFriendlyScore" + playerId);
  safeDeleteWidgetByName("TeamOpponentScore" + playerId);
  safeDeleteWidgetByName("TeamFriendlyScorePad0" + playerId);
  safeDeleteWidgetByName("TeamOpponentScorePad0" + playerId);
  safeDeleteWidgetByName("TeamFriendlyScorePad1" + playerId);
  safeDeleteWidgetByName("TeamFriendlyScorePad2" + playerId);
  safeDeleteWidgetByName("TeamOpponentScorePad1" + playerId);
  safeDeleteWidgetByName("TeamOpponentScorePad2" + playerId);
  safeDeleteWidgetByName("FriendlyTicketsFill" + playerId);
  safeDeleteWidgetByName("EnemyTicketsFill" + playerId);

  const syms = TOP_HUD_LANES;
  for (let i = 0; i < syms.length; i++) {
    const s = syms[i];

    safeDeleteWidgetByName("FLAG" + s + "_FILL" + playerId);
    safeDeleteWidgetByName("FLAG" + s + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_OUTLINE" + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_INNER" + playerId);

    // Thin outline frame pieces
    safeDeleteWidgetByName("FLAG" + s + "_OL_T" + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_OL_B" + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_OL_L" + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_OL_R" + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_HOLD_BG" + playerId);
    safeDeleteWidgetByName("FLAG" + s + "_HOLD_FILL" + playerId);
  }

  safeDeleteWidgetByName("ActiveFlag" + playerId);
  safeDeleteWidgetByName("FriendlyCap" + playerId);
  safeDeleteWidgetByName("EnemyCap" + playerId);
  safeDeleteWidgetByName("CapProgress" + playerId);
  safeDeleteWidgetByName("ActiveFlagContainer" + playerId);
  safeDeleteWidgetByName("FriendlyScorePulse" + playerId);
  safeDeleteWidgetByName("EnemyScorePulse" + playerId);
  safeDeleteWidgetByName("Text_BombCarrier" + playerId);
  safeDeleteWidgetByName("Text_BombNotice" + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName("Text_BombDroppedDeath" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldFillArming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldFillDisarming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldTextArming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldTextDisarming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldContainer" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldRoot" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldBg" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldFill" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerLaneFill" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerLaneText" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerLaneOutlineTop" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerLaneOutlineBottom" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerLaneOutlineLeft" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerLaneOutlineRight" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerTitle" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerValue" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerPanel" + playerId);
  safeDeleteAllWidgetsByName("DeployObjectiveTimerRoot" + playerId);
  deleteCipherTransitionHudForPlayer(playerId);

}

const LIVE_HUD_FRIENDLY_SCORE_POS = mod.CreateVector(56.33, 698.56, 0);
const LIVE_HUD_ENEMY_SCORE_POS = mod.CreateVector(203.91, 698.56, 0);
const LIVE_HUD_SCORE_SIZE = mod.CreateVector(100, 50, 0);
const BOMB_CARRIER_WIDGET_NAME_PREFIX = "Text_BombCarrier";
const BOMB_CARRIER_WIDGET_POS = mod.CreateVector(0, 876.98, 0);
const BOMB_CARRIER_WIDGET_SIZE = mod.CreateVector(243, 50, 0);
const BOMB_CARRIER_WIDGET_BG_COLOR = mod.CreateVector(0.0314, 0.0431, 0.0431);
const BOMB_CARRIER_WIDGET_TEXT_COLOR = mod.CreateVector(1, 1, 1);
const BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX = "Container_BombNotice";
const BOMB_NOTICE_WIDGET_NAME_PREFIX = "Text_BombNotice";
const BOMB_NOTICE_WIDGET_POS = mod.CreateVector(0, -432, 0);
const BOMB_NOTICE_CONTAINER_SIZE = mod.CreateVector(676, 64, 0);
const BOMB_NOTICE_WIDGET_SIZE = mod.CreateVector(554, 54, 0);
const BOMB_NOTICE_WIDGET_BG_COLOR = mod.CreateVector(0.0314, 0.0431, 0.0431);
const BOMB_NOTICE_WIDGET_TEXT_COLOR = mod.CreateVector(1, 1, 1);
const BOMB_NOTICE_WIDGET_TEXT_SIZE = 36;
const BOMB_NOTICE_DURATION_SECONDS = 4.0;
const OBJECTIVE_HOLD_CONTAINER_WIDTH = 228;
const OBJECTIVE_HOLD_CONTAINER_HEIGHT = 66;
const OBJECTIVE_HOLD_FILL_MIN_WIDTH = 1;
const OBJECTIVE_HOLD_FILL_MAX_WIDTH = 227;
const OBJECTIVE_HOLD_FILL_HEIGHT = 65;
const OBJECTIVE_HOLD_PROGRESS_BAR_OFFSET_Y = 0;
const OBJECTIVE_HOLD_PROGRESS_BG_ALPHA = 0.4;
const OBJECTIVE_HOLD_PROGRESS_FILL_ALPHA = 0.8;
const OBJECTIVE_HOLD_BG_COLOR = mod.CreateVector(0.0314, 0.0431, 0.0431);
const OBJECTIVE_HOLD_FILL_COLOR = mod.CreateVector(0.3294, 0.3686, 0.3882);
const DEPLOY_OBJECTIVE_TIMER_ROOT_WIDTH = 1920;
const DEPLOY_OBJECTIVE_TIMER_ROOT_HEIGHT = 1080;
const DEPLOY_OBJECTIVE_TIMER_ROOT_POS_X = 0;
const DEPLOY_OBJECTIVE_TIMER_ROOT_POS_Y = 0;
const DEPLOY_OBJECTIVE_TIMER_PANEL_WIDTH = 720;
const DEPLOY_OBJECTIVE_TIMER_PANEL_HEIGHT = 112;
const DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X = 0;
const DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y = -374;
const DEPLOY_OBJECTIVE_TIMER_PANEL_ALPHA = 0.78;
const DEPLOY_OBJECTIVE_TIMER_LANE_SIZE = 72;
const DEPLOY_OBJECTIVE_TIMER_LANE_POS_X = -250;
const DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y = 0;
const DEPLOY_OBJECTIVE_TIMER_LANE_OUTLINE_THICKNESS = 2;
const DEPLOY_OBJECTIVE_TIMER_TITLE_POS_X = 0;
const DEPLOY_OBJECTIVE_TIMER_TITLE_POS_Y = -18;
const DEPLOY_OBJECTIVE_TIMER_TITLE_WIDTH = 520;
const DEPLOY_OBJECTIVE_TIMER_TITLE_HEIGHT = 30;
const DEPLOY_OBJECTIVE_TIMER_VALUE_POS_X = 0;
const DEPLOY_OBJECTIVE_TIMER_VALUE_POS_Y = 22;
const DEPLOY_OBJECTIVE_TIMER_VALUE_WIDTH = 320;
const DEPLOY_OBJECTIVE_TIMER_VALUE_HEIGHT = 48;
const DEPLOY_OBJECTIVE_TIMER_TITLE_TEXT_SIZE = 22;
const DEPLOY_OBJECTIVE_TIMER_VALUE_TEXT_SIZE = 42;
const DEPLOY_OBJECTIVE_TIMER_LANE_TEXT_SIZE = 42;

function bindPlayerTopScoreWidgetRefs(p: Player): void {
  p.friendlyScoreWidget = mod.FindUIWidgetWithName("TeamFriendlyScore" + p.id);
  p.opponentScoreWidget = mod.FindUIWidgetWithName("TeamOpponentScore" + p.id);
  p.friendlyScorePadWidget = null as any;
  p.opponentScorePadWidget = null as any;
  p.bombCarrierTextWidget = mod.FindUIWidgetWithName(BOMB_CARRIER_WIDGET_NAME_PREFIX + p.id);
  p.bombNoticeContainerWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id);
  p.bombNoticeTextWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id);
  p.bombCarrierUiLastVisible = false;
  p.bombCarrierUiLastVersion = -1;
  p.bombCarrierUiLastAlphaBucket = -1;
  p.bombNoticeUiLastStateKey = "";
  markCipherKeyHudReadyForPlayer(p.id, hasCipherKeyHudWidgetRefs(p));
}

function bindPlayerCipherKeyHudWidgetRefs(p: Player, force: boolean = false): void {
  if (force || !p.bombCarrierTextWidget) {
    p.bombCarrierTextWidget = mod.FindUIWidgetWithName(BOMB_CARRIER_WIDGET_NAME_PREFIX + p.id);
  }
  if (force || !p.bombNoticeContainerWidget) {
    p.bombNoticeContainerWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id);
  }
  if (force || !p.bombNoticeTextWidget) {
    p.bombNoticeTextWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id);
  }

  markCipherKeyHudReadyForPlayer(p.id, hasCipherKeyHudWidgetRefs(p));
}

function bindObjectiveHoldWidgetRefs(p: Player): void {
  const playerId = p.id;
  p.objectiveHoldRootWidget = mod.FindUIWidgetWithName(getObjectiveHoldRootWidgetName(playerId));
  p.objectiveHoldContainerWidget = mod.FindUIWidgetWithName(getObjectiveHoldContainerWidgetName(playerId));
  p.objectiveHoldFillArmingWidget = mod.FindUIWidgetWithName(getObjectiveHoldArmingFillWidgetName(playerId));
  p.objectiveHoldFillDisarmingWidget = mod.FindUIWidgetWithName(getObjectiveHoldDisarmingFillWidgetName(playerId));
  p.objectiveHoldTextArmingWidget = mod.FindUIWidgetWithName(getObjectiveHoldArmingTextWidgetName(playerId));
  p.objectiveHoldTextDisarmingWidget = mod.FindUIWidgetWithName(getObjectiveHoldDisarmingTextWidgetName(playerId));
}

function bindDeployObjectiveTimerWidgetRefs(p: Player): void {
  const playerId = p.id;
  p.deployObjectiveTimerRootWidget = findRootParentWidgetByName(getDeployObjectiveTimerRootWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerPanelWidget = findRootParentWidgetByName(getDeployObjectiveTimerPanelWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneFillWidget = findRootParentWidgetByName(getDeployObjectiveTimerLaneFillWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneTextWidget = findRootParentWidgetByName(getDeployObjectiveTimerLaneTextWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineTopWidget = findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineBottomWidget = findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineLeftWidget = findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineRightWidget = findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerTitleWidget = findRootParentWidgetByName(getDeployObjectiveTimerTitleWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerValueWidget = findRootParentWidgetByName(getDeployObjectiveTimerValueWidgetName(playerId)) ?? null as any;
}

function setTopScoreWidgetDepthForPlayer(playerId: number): void {
  const names = [
    "TeamFriendlyScore" + playerId,
    "TeamOpponentScore" + playerId,
    "FriendlyScorePulse" + playerId,
    "EnemyScorePulse" + playerId,
    BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
  ];

  for (let i = 0; i < names.length; i++) {
    const widget = mod.FindUIWidgetWithName(names[i]);
    if (!widget) continue;
    mod.SetUIWidgetDepth(widget, mod.UIDepth.AboveGameUI);
  }
}

function isWidgetParentRoot(widget: mod.UIWidget | undefined): boolean {
  if (!widget) return false;

  try {
    const parent = mod.GetUIWidgetParent(widget);
    if (!parent) return false;
    const root = mod.GetUIRoot();
    if (!root) return false;

    try {
      return mod.GetObjId(parent as any) === mod.GetObjId(root as any);
    } catch (_errId) {
      return parent === root;
    }
  } catch (_err) {
    return false;
  }
}

function hasValidRootTopScoreWidgets(playerId: number): boolean {
  const friendlyScore = mod.FindUIWidgetWithName("TeamFriendlyScore" + playerId);
  const enemyScore = mod.FindUIWidgetWithName("TeamOpponentScore" + playerId);
  const friendlyPulse = mod.FindUIWidgetWithName("FriendlyScorePulse" + playerId);
  const enemyPulse = mod.FindUIWidgetWithName("EnemyScorePulse" + playerId);
  const bombCarrier = mod.FindUIWidgetWithName(BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId);
  const bombNoticeContainer = mod.FindUIWidgetWithName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  const bombNotice = mod.FindUIWidgetWithName(BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId);

  if (
    !friendlyScore ||
    !enemyScore ||
    !friendlyPulse ||
    !enemyPulse ||
    !bombCarrier ||
    !bombNoticeContainer ||
    !bombNotice
  ) {
    return false;
  }

  return (
    isWidgetParentRoot(friendlyScore) &&
    isWidgetParentRoot(enemyScore) &&
    isWidgetParentRoot(friendlyPulse) &&
    isWidgetParentRoot(enemyPulse) &&
    isWidgetParentRoot(bombCarrier) &&
    isWidgetParentRoot(bombNoticeContainer) &&
    isWidgetParentRoot(bombNotice)
  );
}

function rebuildPlayerTopScoreWidgets(p: Player): boolean {
  const playerId = p.id;

  safeDeleteWidgetByName("TeamFriendlyScore" + playerId);
  safeDeleteWidgetByName("TeamOpponentScore" + playerId);
  safeDeleteWidgetByName("TeamFriendlyScorePad0" + playerId);
  safeDeleteWidgetByName("TeamOpponentScorePad0" + playerId);
  safeDeleteWidgetByName("TeamFriendlyScorePad1" + playerId);
  safeDeleteWidgetByName("TeamFriendlyScorePad2" + playerId);
  safeDeleteWidgetByName("TeamOpponentScorePad1" + playerId);
  safeDeleteWidgetByName("TeamOpponentScorePad2" + playerId);
  safeDeleteWidgetByName("FriendlyScorePulse" + playerId);
  safeDeleteWidgetByName("EnemyScorePulse" + playerId);
  safeDeleteWidgetByName(BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName("Text_BombDroppedDeath" + playerId);

  const uiRoot = mod.GetUIRoot();
  if (!uiRoot) return false;

  const team = mod.GetTeam(p.player);
  const friendly = getFriendlyScore(team);
  const enemy = getOpponentScore(team);

  mod.AddUIText(
    "TeamFriendlyScore" + playerId,
    LIVE_HUD_FRIENDLY_SCORE_POS,
    LIVE_HUD_SCORE_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.Text_Freindly_Score, friendly),
    24,
    COLOR_FRIENDLY,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    "TeamOpponentScore" + playerId,
    LIVE_HUD_ENEMY_SCORE_POS,
    LIVE_HUD_SCORE_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.Text_Enemy_Score, enemy),
    24,
    COLOR_ENEMY,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIContainer(
    "FriendlyScorePulse" + playerId,
    LIVE_HUD_FRIENDLY_SCORE_POS,
    LIVE_HUD_SCORE_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
    true,
    0,
    mod.CreateVector(0.2314, 0.4196, 0.6745),
    0,
    mod.UIBgFill.GradientLeft,
    p.player
  );

  mod.AddUIContainer(
    "EnemyScorePulse" + playerId,
    LIVE_HUD_ENEMY_SCORE_POS,
    LIVE_HUD_SCORE_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
    true,
    0,
    mod.CreateVector(0.698, 0.1882, 0.1882),
    0,
    mod.UIBgFill.GradientRight,
    p.player
  );

  mod.AddUIText(
    BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId,
    BOMB_CARRIER_WIDGET_POS,
    BOMB_CARRIER_WIDGET_SIZE,
    mod.UIAnchor.TopCenter,
    uiRoot,
    false,
    0,
    BOMB_CARRIER_WIDGET_BG_COLOR,
    1,
    mod.UIBgFill.None,
    getStringMessageWithFallback((mod.stringkeys as any).Text_BombCarrier, "CARRYING BOMB"),
    27,
    BOMB_CARRIER_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIContainer(
    BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_WIDGET_POS,
    BOMB_NOTICE_CONTAINER_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    BOMB_NOTICE_WIDGET_BG_COLOR,
    0.5,
    mod.UIBgFill.Blur,
    p.player
  );

  mod.AddUIText(
    BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_WIDGET_POS,
    BOMB_NOTICE_WIDGET_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    BOMB_NOTICE_WIDGET_TEXT_SIZE,
    BOMB_NOTICE_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  bindPlayerTopScoreWidgetRefs(p);
  setTopScoreWidgetDepthForPlayer(playerId);
  refreshBombNoticeUiForPlayer(p);

  return hasValidRootTopScoreWidgets(playerId);
}

function safeDeleteWidgetByName(widgetName: string): void {
  const widget = mod.FindUIWidgetWithName(widgetName);
  if (!widget) return;

  try {
    mod.DeleteUIWidget(widget);
  } catch (_err) {}
}

function safeDeleteAllWidgetsByName(widgetName: string): void {
  for (let i = 0; i < 16; i++) {
    let widget: mod.UIWidget | undefined = undefined;
    try {
      const found = mod.FindUIWidgetWithName(widgetName);
      if (found && mod.IsType(found, mod.Types.UIWidget)) {
        widget = found as mod.UIWidget;
      }
    } catch (_errFind) {}

    if (!widget) return;

    try {
      mod.DeleteUIWidget(widget);
    } catch (_errDelete) {
      return;
    }
  }
}

function findRootParentWidgetByName(widgetName: string): mod.UIWidget | undefined {
  try {
    const root = mod.GetUIRoot();
    if (root) {
      try {
        const rooted = mod.FindUIWidgetWithName(widgetName, root);
        if (rooted && mod.IsType(rooted, mod.Types.UIWidget) && isWidgetParentRoot(rooted as mod.UIWidget)) {
          return rooted as mod.UIWidget;
        }
      } catch (_errRooted) {}
    }

    const widget = mod.FindUIWidgetWithName(widgetName);
    if (widget && mod.IsType(widget, mod.Types.UIWidget) && isWidgetParentRoot(widget as mod.UIWidget)) {
      return widget as mod.UIWidget;
    }
  } catch (_err) {}

  return undefined;
}

function cleanupLegacySharedTopHudWidgets(): void {
  const legacyNames = [
    "FlagContainerA",
    "FlagContainerB",
    "FlagContainerC",
    "FlagContainerD",
    "FlagContainerE",
    "FlagContainerF",
    "friendlyprogressbar",
    "friendlyprogressbarfill",
    "friendlyprogress_pulse",
    "enemyprogressbar",
    "enemyprogressbarfill",
    "enemyprogress_pulse",
    "friendlyscore_pulse",
    "enemyscore_pulse",
  ];

  for (let i = 0; i < legacyNames.length; i++) {
    safeDeleteWidgetByName(legacyNames[i]);
  }
}

function hasLiveHudFlagParentsReady(): boolean {
  for (let i = 0; i < TOP_HUD_LANES.length; i++) {
    const lane = TOP_HUD_LANES[i];
    if (!mod.FindUIWidgetWithName(getTopHudFlagContainerWidgetName(lane))) return false;
  }
  return true;
}

function getStringMessageWithFallback(key: any, fallbackText: string): any {
  if (key !== undefined && key !== null) {
    try {
      return mod.Message(key);
    } catch (_err) {}
  }
  return mod.Message(fallbackText);
}

function getCounterMessageWithFallback(value: number): any {
  const counterKey = (mod.stringkeys as any).CounterText;
  if (counterKey !== undefined && counterKey !== null) {
    try {
      return mod.Message(counterKey, value);
    } catch (_err) {}
  }

  return mod.Message("{}", value);
}

function rebuildPlayerLiveHud(p: Player): void {
  const scorePanel = mod.FindUIWidgetWithName("BG_Score_Container");

  if (!scorePanel || !hasLiveHudFlagParentsReady()) {
    deletePlayerLiveHudWidgets(p.id);
    liveHudBuiltByPlayerId[p.id] = false;
    return;
  }

  // If already built, DO NOT recreate widgets.
  // Just re-bind widget references (important for reconnect/deploy cases) and return.
  if (liveHudBuiltByPlayerId[p.id] === true) {
    p.flagWidget = {};
    for (let i = 0; i < TOP_HUD_LANES.length; i++) {
      const lane = TOP_HUD_LANES[i];
      p.flagWidget[lane] = mod.FindUIWidgetWithName("FLAG" + lane + p.id);
    }

    bindPlayerTopScoreWidgetRefs(p);

    if (!hasValidRootTopScoreWidgets(p.id)) {
      if (!rebuildPlayerTopScoreWidgets(p)) {
        deletePlayerLiveHudWidgets(p.id);
        liveHudBuiltByPlayerId[p.id] = false;
        return;
      }
    } else {
      setTopScoreWidgetDepthForPlayer(p.id);
    }

    // Active popup HUD intentionally removed in this layout.
    p.activeFlagContainerWidget = null as any;
    p.activeFlagFriendlyWidget = null as any;
    p.activeFlagEnemyWidget = null as any;
    p.friendlyCapWidget = null as any;
    p.enemyCapWidget = null as any;
    p.activeFlagWidget = null as any;
    p.progressBarWidget = null as any;
    rebuildObjectiveHoldProgressUiWidgetsForPlayer(p);
    rebuildDeployObjectiveTimerUiWidgetsForPlayer(p);

    return;
  }

  if (!rebuildPlayerTopScoreWidgets(p)) {
    deletePlayerLiveHudWidgets(p.id);
    liveHudBuiltByPlayerId[p.id] = false;
    return;
  }

  for (let i = 0; i < TOP_HUD_LANES.length; i++) {
    const lane = TOP_HUD_LANES[i];
    const containerName = getTopHudFlagContainerWidgetName(lane);
    const displayLetter = getHudDisplayLetterForViewerLane(mod.GetTeam(p.player), lane);

    mod.AddUIText(
      "FLAG" + lane + p.id,
      mod.CreateVector(0, 0, 0),
      mod.CreateVector(44, 44, 0),
      mod.UIAnchor.Center,
      mod.FindUIWidgetWithName(containerName),
      true,
      0,
      mod.CreateVector(0, 0, 0),
      0.4,
      mod.UIBgFill.Blur,
      mod.Message(getFlagStringKey(displayLetter)),
      24,
      getHudColorForViewerLane(mod.GetTeam(p.player), lane),
      1,
      mod.UIAnchor.Center,
      p.player
    );
  }

  // Thin outline frames ON TOP of the existing squares (does not change your original containers).
  const outlineThickness = 1;
  const flagBoxSize = 44;

  function addFlagOutline(symbol: TopHudLane, parentName: string, color: mod.Vector): void {
    const parentWidget = mod.FindUIWidgetWithName(parentName);
    if (!parentWidget) return;

    const half = flagBoxSize / 2;
    const tHalf = outlineThickness / 2;

    mod.AddUIContainer(
      "FLAG" + symbol + "_OL_T" + p.id,
      mod.CreateVector(0, -half + tHalf, 0),
      mod.CreateVector(flagBoxSize, outlineThickness, 0),
      mod.UIAnchor.Center,
      parentWidget,
      true,
      0,
      color,
      TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
      mod.UIBgFill.Solid,
      p.player
    );

    mod.AddUIContainer(
      "FLAG" + symbol + "_OL_B" + p.id,
      mod.CreateVector(0, half - tHalf, 0),
      mod.CreateVector(flagBoxSize, outlineThickness, 0),
      mod.UIAnchor.Center,
      parentWidget,
      true,
      0,
      color,
      TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
      mod.UIBgFill.Solid,
      p.player
    );

    mod.AddUIContainer(
      "FLAG" + symbol + "_OL_L" + p.id,
      mod.CreateVector(-half + tHalf, 0, 0),
      mod.CreateVector(outlineThickness, flagBoxSize, 0),
      mod.UIAnchor.Center,
      parentWidget,
      true,
      0,
      color,
      TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
      mod.UIBgFill.Solid,
      p.player
    );

    mod.AddUIContainer(
      "FLAG" + symbol + "_OL_R" + p.id,
      mod.CreateVector(half - tHalf, 0, 0),
      mod.CreateVector(outlineThickness, flagBoxSize, 0),
      mod.UIAnchor.Center,
      parentWidget,
      true,
      0,
      color,
      TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
      mod.UIBgFill.Solid,
      p.player
    );
  }

  function addFlagFill(symbol: TopHudLane, parentName: string, color: mod.Vector): void {
    const parentWidget = mod.FindUIWidgetWithName(parentName);
    if (!parentWidget) return;

    mod.AddUIContainer(
      "FLAG" + symbol + "_FILL" + p.id,
      mod.CreateVector(0, 0, 0),
      mod.CreateVector(flagBoxSize, flagBoxSize, 0),
      mod.UIAnchor.Center,
      parentWidget,
      true,
      0,
      color,
      TOP_HUD_FLAG_FILL_BASE_ALPHA,
      mod.UIBgFill.Blur,
      p.player
    );
  }

  for (let i = 0; i < TOP_HUD_LANES.length; i++) {
    const lane = TOP_HUD_LANES[i];
    const containerName = getTopHudFlagContainerWidgetName(lane);
    const laneColor = getHudColorForViewerLane(mod.GetTeam(p.player), lane);

    addFlagFill(lane, containerName, laneColor);
    addFlagOutline(lane, containerName, laneColor);
  }

  p.flagWidget = {};
  for (let i = 0; i < TOP_HUD_LANES.length; i++) {
    const lane = TOP_HUD_LANES[i];
    p.flagWidget[lane] = mod.FindUIWidgetWithName("FLAG" + lane + p.id);
  }

  bindPlayerTopScoreWidgetRefs(p);
  setTopScoreWidgetDepthForPlayer(p.id);

  // Active popup HUD intentionally removed in this layout.
  p.activeFlagContainerWidget = null as any;
  p.activeFlagFriendlyWidget = null as any;
  p.activeFlagEnemyWidget = null as any;
  p.friendlyCapWidget = null as any;
  p.enemyCapWidget = null as any;
  p.activeFlagWidget = null as any;
  p.progressBarWidget = null as any;
  rebuildObjectiveHoldProgressUiWidgetsForPlayer(p);
  rebuildDeployObjectiveTimerUiWidgetsForPlayer(p);

  liveHudBuiltByPlayerId[p.id] = true;
}

function getObjectiveHoldRootWidgetName(playerId: number): string {
  return "ObjectiveHoldRoot" + playerId;
}

function getObjectiveHoldContainerWidgetName(playerId: number): string {
  return "ObjectiveHoldContainer" + playerId;
}

function getObjectiveHoldArmingFillWidgetName(playerId: number): string {
  return "ObjectiveHoldFillArming" + playerId;
}

function getObjectiveHoldDisarmingFillWidgetName(playerId: number): string {
  return "ObjectiveHoldFillDisarming" + playerId;
}

function getObjectiveHoldArmingTextWidgetName(playerId: number): string {
  return "ObjectiveHoldTextArming" + playerId;
}

function getObjectiveHoldDisarmingTextWidgetName(playerId: number): string {
  return "ObjectiveHoldTextDisarming" + playerId;
}

function rebuildObjectiveHoldProgressUiWidgetsForPlayer(p: Player): void {
  const playerId = p.id;
  safeDeleteWidgetByName(getObjectiveHoldArmingFillWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldDisarmingFillWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldArmingTextWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldDisarmingTextWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldContainerWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldRootWidgetName(playerId));
  safeDeleteWidgetByName("ObjectiveHoldBg" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldFill" + playerId);

  mod.AddUIContainer(
    getObjectiveHoldRootWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(1920, 1080, 0),
    mod.UIAnchor.Center,
    mod.GetUIRoot(),
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    p.player
  );

  const holdRoot = mod.FindUIWidgetWithName(getObjectiveHoldRootWidgetName(playerId));
  if (!holdRoot) return;

  mod.AddUIContainer(
    getObjectiveHoldContainerWidgetName(playerId),
    mod.CreateVector(0, OBJECTIVE_HOLD_PROGRESS_BAR_OFFSET_Y, 0),
    mod.CreateVector(OBJECTIVE_HOLD_CONTAINER_WIDTH, OBJECTIVE_HOLD_CONTAINER_HEIGHT, 0),
    mod.UIAnchor.Center,
    holdRoot,
    false,
    0,
    OBJECTIVE_HOLD_BG_COLOR,
    OBJECTIVE_HOLD_PROGRESS_BG_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  const holdContainer = mod.FindUIWidgetWithName(getObjectiveHoldContainerWidgetName(playerId));
  if (!holdContainer) return;

  mod.SetUIWidgetDepth(holdRoot, mod.UIDepth.AboveGameUI);
  mod.SetUIWidgetDepth(holdContainer, mod.UIDepth.AboveGameUI);

  mod.AddUIContainer(
    getObjectiveHoldArmingFillWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(OBJECTIVE_HOLD_FILL_MIN_WIDTH, OBJECTIVE_HOLD_FILL_HEIGHT, 0),
    mod.UIAnchor.Center,
    holdContainer,
    false,
    0,
    OBJECTIVE_HOLD_FILL_COLOR,
    OBJECTIVE_HOLD_PROGRESS_FILL_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  mod.AddUIContainer(
    getObjectiveHoldDisarmingFillWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(OBJECTIVE_HOLD_FILL_MIN_WIDTH, OBJECTIVE_HOLD_FILL_HEIGHT, 0),
    mod.UIAnchor.Center,
    holdContainer,
    false,
    0,
    OBJECTIVE_HOLD_FILL_COLOR,
    OBJECTIVE_HOLD_PROGRESS_FILL_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  mod.AddUIText(
    getObjectiveHoldArmingTextWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(184, 50, 0),
    mod.UIAnchor.Center,
    holdContainer,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    getStringMessageWithFallback((mod.stringkeys as any).Text_ARMING, "ARMING"),
    24,
    mod.CreateVector(1, 1, 1),
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getObjectiveHoldDisarmingTextWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    mod.CreateVector(184, 50, 0),
    mod.UIAnchor.Center,
    holdContainer,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    getStringMessageWithFallback((mod.stringkeys as any).Text_DISARMING, "DISARMING"),
    24,
    mod.CreateVector(1, 1, 1),
    1,
    mod.UIAnchor.Center,
    p.player
  );

  bindObjectiveHoldWidgetRefs(p);
  hideObjectiveHoldProgressForPlayer(playerId);
}

function getCachedObjectiveHoldWidgetsForPlayer(p: Player): {
  root?: mod.UIWidget;
  container?: mod.UIWidget;
  fillArming?: mod.UIWidget;
  fillDisarming?: mod.UIWidget;
  textArming?: mod.UIWidget;
  textDisarming?: mod.UIWidget;
} {
  let root = p.objectiveHoldRootWidget;
  let container = p.objectiveHoldContainerWidget;
  let fillArming = p.objectiveHoldFillArmingWidget;
  let fillDisarming = p.objectiveHoldFillDisarmingWidget;
  let textArming = p.objectiveHoldTextArmingWidget;
  let textDisarming = p.objectiveHoldTextDisarmingWidget;

  if (!root || !container || !fillArming || !fillDisarming || !textArming || !textDisarming) {
    bindObjectiveHoldWidgetRefs(p);
    root = p.objectiveHoldRootWidget;
    container = p.objectiveHoldContainerWidget;
    fillArming = p.objectiveHoldFillArmingWidget;
    fillDisarming = p.objectiveHoldFillDisarmingWidget;
    textArming = p.objectiveHoldTextArmingWidget;
    textDisarming = p.objectiveHoldTextDisarmingWidget;
  }

  return { root, container, fillArming, fillDisarming, textArming, textDisarming };
}

function hideObjectiveHoldProgressForPlayer(playerId: number): void {
  const p = serverPlayers.get(playerId);
  const widgets = p ? getCachedObjectiveHoldWidgetsForPlayer(p) : {};
  const container = widgets.container ?? mod.FindUIWidgetWithName(getObjectiveHoldContainerWidgetName(playerId));
  const fillArming = widgets.fillArming ?? mod.FindUIWidgetWithName(getObjectiveHoldArmingFillWidgetName(playerId));
  const fillDisarming =
    widgets.fillDisarming ?? mod.FindUIWidgetWithName(getObjectiveHoldDisarmingFillWidgetName(playerId));
  const textArming = widgets.textArming ?? mod.FindUIWidgetWithName(getObjectiveHoldArmingTextWidgetName(playerId));
  const textDisarming =
    widgets.textDisarming ?? mod.FindUIWidgetWithName(getObjectiveHoldDisarmingTextWidgetName(playerId));
  const legacyBg = mod.FindUIWidgetWithName("ObjectiveHoldBg" + playerId);
  const legacyFill = mod.FindUIWidgetWithName("ObjectiveHoldFill" + playerId);

  SafeSetWidgetPositionHandle(fillArming, mod.CreateVector(0, 0, 0));
  SafeSetWidgetSizeHandle(fillArming, mod.CreateVector(OBJECTIVE_HOLD_FILL_MIN_WIDTH, OBJECTIVE_HOLD_FILL_HEIGHT, 0));
  SafeSetWidgetVisibleHandle(fillArming, false);
  SafeSetWidgetPositionHandle(fillDisarming, mod.CreateVector(0, 0, 0));
  SafeSetWidgetSizeHandle(
    fillDisarming,
    mod.CreateVector(OBJECTIVE_HOLD_FILL_MIN_WIDTH, OBJECTIVE_HOLD_FILL_HEIGHT, 0)
  );
  SafeSetWidgetVisibleHandle(fillDisarming, false);
  SafeSetWidgetVisibleHandle(textArming, false);
  SafeSetWidgetVisibleHandle(textDisarming, false);
  SafeSetWidgetPositionHandle(container, mod.CreateVector(0, OBJECTIVE_HOLD_PROGRESS_BAR_OFFSET_Y, 0));
  SafeSetWidgetVisibleHandle(container, false);
  SafeDeleteWidgetHandle(legacyBg);
  SafeDeleteWidgetHandle(legacyFill);
}

function getDeployObjectiveTimerRootWidgetName(playerId: number): string {
  return "DeployObjectiveTimerRoot" + playerId;
}

function getDeployObjectiveTimerPanelWidgetName(playerId: number): string {
  return "DeployObjectiveTimerPanel" + playerId;
}

function getDeployObjectiveTimerLaneFillWidgetName(playerId: number): string {
  return "DeployObjectiveTimerLaneFill" + playerId;
}

function getDeployObjectiveTimerLaneTextWidgetName(playerId: number): string {
  return "DeployObjectiveTimerLaneText" + playerId;
}

function getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId: number): string {
  return "DeployObjectiveTimerLaneOutlineTop" + playerId;
}

function getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId: number): string {
  return "DeployObjectiveTimerLaneOutlineBottom" + playerId;
}

function getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId: number): string {
  return "DeployObjectiveTimerLaneOutlineLeft" + playerId;
}

function getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId: number): string {
  return "DeployObjectiveTimerLaneOutlineRight" + playerId;
}

function getDeployObjectiveTimerTitleWidgetName(playerId: number): string {
  return "DeployObjectiveTimerTitle" + playerId;
}

function getDeployObjectiveTimerValueWidgetName(playerId: number): string {
  return "DeployObjectiveTimerValue" + playerId;
}

function resetDeployObjectiveTimerCacheForPlayer(p: Player): void {
  p.deployObjectiveTimerLastShownCpId = undefined;
  p.deployObjectiveTimerLastShownRemainingSeconds = -1;
}

function rebuildDeployObjectiveTimerUiWidgetsForPlayer(p: Player): void {
  const playerId = p.id;
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneFillWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneTextWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerTitleWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerValueWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerPanelWidgetName(playerId));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerRootWidgetName(playerId));

  const uiRoot = mod.GetUIRoot();
  if (!uiRoot) return;

  const laneHalf = DEPLOY_OBJECTIVE_TIMER_LANE_SIZE / 2;
  const outlineHalf = DEPLOY_OBJECTIVE_TIMER_LANE_OUTLINE_THICKNESS / 2;
  const panelCenterPos = mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X, DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y, 0);

  mod.AddUIContainer(
    getDeployObjectiveTimerRootWidgetName(playerId),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_ROOT_POS_X, DEPLOY_OBJECTIVE_TIMER_ROOT_POS_Y, 0),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_ROOT_WIDTH, DEPLOY_OBJECTIVE_TIMER_ROOT_HEIGHT, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    p.player
  );

  mod.AddUIContainer(
    getDeployObjectiveTimerPanelWidgetName(playerId),
    panelCenterPos,
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_PANEL_WIDTH, DEPLOY_OBJECTIVE_TIMER_PANEL_HEIGHT, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    BOMB_NOTICE_WIDGET_BG_COLOR,
    DEPLOY_OBJECTIVE_TIMER_PANEL_ALPHA,
    mod.UIBgFill.Blur,
    p.player
  );

  mod.AddUIContainer(
    getDeployObjectiveTimerLaneFillWidgetName(playerId),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_LANE_POS_X, DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y, 0),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    COLOR_NEUTRAL,
    TOP_HUD_FLAG_FILL_BASE_ALPHA,
    mod.UIBgFill.Blur,
    p.player
  );

  mod.AddUIContainer(
    getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_LANE_POS_X,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y - laneHalf + outlineHalf,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, DEPLOY_OBJECTIVE_TIMER_LANE_OUTLINE_THICKNESS, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    COLOR_NEUTRAL,
    TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  mod.AddUIContainer(
    getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_LANE_POS_X,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y + laneHalf - outlineHalf,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, DEPLOY_OBJECTIVE_TIMER_LANE_OUTLINE_THICKNESS, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    COLOR_NEUTRAL,
    TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  mod.AddUIContainer(
    getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_LANE_POS_X - laneHalf + outlineHalf,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_LANE_OUTLINE_THICKNESS, DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    COLOR_NEUTRAL,
    TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  mod.AddUIContainer(
    getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_LANE_POS_X + laneHalf - outlineHalf,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_LANE_OUTLINE_THICKNESS, DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    COLOR_NEUTRAL,
    TOP_HUD_FLAG_OUTLINE_BASE_ALPHA,
    mod.UIBgFill.Solid,
    p.player
  );

  mod.AddUIText(
    getDeployObjectiveTimerLaneTextWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_LANE_POS_X,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_LANE_POS_Y,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, DEPLOY_OBJECTIVE_TIMER_LANE_SIZE, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.FLAGA),
    DEPLOY_OBJECTIVE_TIMER_LANE_TEXT_SIZE,
    COLOR_NEUTRAL,
    TOP_HUD_FLAG_TEXT_BASE_ALPHA,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getDeployObjectiveTimerTitleWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_TITLE_POS_X,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_TITLE_POS_Y,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_TITLE_WIDTH, DEPLOY_OBJECTIVE_TIMER_TITLE_HEIGHT, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    getStringMessageWithFallback((mod.stringkeys as any).Text_ObjectiveDestroyTimer, "TIME LEFT UNTIL DESTROYED"),
    DEPLOY_OBJECTIVE_TIMER_TITLE_TEXT_SIZE,
    BOMB_NOTICE_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getDeployObjectiveTimerValueWidgetName(playerId),
    mod.CreateVector(
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_X + DEPLOY_OBJECTIVE_TIMER_VALUE_POS_X,
      DEPLOY_OBJECTIVE_TIMER_PANEL_POS_Y + DEPLOY_OBJECTIVE_TIMER_VALUE_POS_Y,
      0
    ),
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_VALUE_WIDTH, DEPLOY_OBJECTIVE_TIMER_VALUE_HEIGHT, 0),
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    formatUiTimerLabel(OBJECTIVE_SCORE_HOLD_SECONDS),
    DEPLOY_OBJECTIVE_TIMER_VALUE_TEXT_SIZE,
    BOMB_NOTICE_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  bindDeployObjectiveTimerWidgetRefs(p);

  SafeSetWidgetDepthHandle(p.deployObjectiveTimerRootWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerPanelWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerLaneFillWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerLaneOutlineTopWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerLaneOutlineBottomWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerLaneOutlineLeftWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerLaneOutlineRightWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerLaneTextWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerTitleWidget, mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(p.deployObjectiveTimerValueWidget, mod.UIDepth.AboveGameUI);

  resetDeployObjectiveTimerCacheForPlayer(p);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerRootWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerPanelWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerLaneFillWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerLaneTextWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerLaneOutlineTopWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerLaneOutlineBottomWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerLaneOutlineLeftWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerLaneOutlineRightWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerTitleWidget, false);
  SafeSetWidgetVisibleHandle(p.deployObjectiveTimerValueWidget, false);
}

function getCachedDeployObjectiveTimerWidgetsForPlayer(p: Player): {
  root?: mod.UIWidget;
  panel?: mod.UIWidget;
  laneFill?: mod.UIWidget;
  laneText?: mod.UIWidget;
  outlineTop?: mod.UIWidget;
  outlineBottom?: mod.UIWidget;
  outlineLeft?: mod.UIWidget;
  outlineRight?: mod.UIWidget;
  title?: mod.UIWidget;
  value?: mod.UIWidget;
} {
  let root = p.deployObjectiveTimerRootWidget;
  let panel = p.deployObjectiveTimerPanelWidget;
  let laneFill = p.deployObjectiveTimerLaneFillWidget;
  let laneText = p.deployObjectiveTimerLaneTextWidget;
  let outlineTop = p.deployObjectiveTimerLaneOutlineTopWidget;
  let outlineBottom = p.deployObjectiveTimerLaneOutlineBottomWidget;
  let outlineLeft = p.deployObjectiveTimerLaneOutlineLeftWidget;
  let outlineRight = p.deployObjectiveTimerLaneOutlineRightWidget;
  let title = p.deployObjectiveTimerTitleWidget;
  let value = p.deployObjectiveTimerValueWidget;

  if (!root || !panel || !laneFill || !laneText || !outlineTop || !outlineBottom || !outlineLeft || !outlineRight || !title || !value) {
    bindDeployObjectiveTimerWidgetRefs(p);
    root = p.deployObjectiveTimerRootWidget;
    panel = p.deployObjectiveTimerPanelWidget;
    laneFill = p.deployObjectiveTimerLaneFillWidget;
    laneText = p.deployObjectiveTimerLaneTextWidget;
    outlineTop = p.deployObjectiveTimerLaneOutlineTopWidget;
    outlineBottom = p.deployObjectiveTimerLaneOutlineBottomWidget;
    outlineLeft = p.deployObjectiveTimerLaneOutlineLeftWidget;
    outlineRight = p.deployObjectiveTimerLaneOutlineRightWidget;
    title = p.deployObjectiveTimerTitleWidget;
    value = p.deployObjectiveTimerValueWidget;
  }

  if (!root || !panel || !laneFill || !laneText || !outlineTop || !outlineBottom || !outlineLeft || !outlineRight || !title || !value) {
    rebuildDeployObjectiveTimerUiWidgetsForPlayer(p);
    root = p.deployObjectiveTimerRootWidget;
    panel = p.deployObjectiveTimerPanelWidget;
    laneFill = p.deployObjectiveTimerLaneFillWidget;
    laneText = p.deployObjectiveTimerLaneTextWidget;
    outlineTop = p.deployObjectiveTimerLaneOutlineTopWidget;
    outlineBottom = p.deployObjectiveTimerLaneOutlineBottomWidget;
    outlineLeft = p.deployObjectiveTimerLaneOutlineLeftWidget;
    outlineRight = p.deployObjectiveTimerLaneOutlineRightWidget;
    title = p.deployObjectiveTimerTitleWidget;
    value = p.deployObjectiveTimerValueWidget;
  }

  return { root, panel, laneFill, laneText, outlineTop, outlineBottom, outlineLeft, outlineRight, title, value };
}

function getHighestPriorityArmedObjectiveCpId(): number | undefined {
  let bestCpId: number | undefined = undefined;
  let bestRemainingSeconds = Number.POSITIVE_INFINITY;

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const remainingSeconds = getObjectivePendingAwardRemainingSeconds(cpId);
    if (remainingSeconds === undefined) continue;

    if (
      bestCpId === undefined ||
      remainingSeconds < bestRemainingSeconds ||
      (remainingSeconds === bestRemainingSeconds && cpId < bestCpId)
    ) {
      bestCpId = cpId;
      bestRemainingSeconds = remainingSeconds;
    }
  }

  return bestCpId;
}

function hideDeployObjectiveTimerUiForPlayer(playerId: number): void {
  const p = serverPlayers.get(playerId);
  const root =
    p?.deployObjectiveTimerRootWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerRootWidgetName(playerId));
  const panel =
    p?.deployObjectiveTimerPanelWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerPanelWidgetName(playerId));
  const laneFill =
    p?.deployObjectiveTimerLaneFillWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerLaneFillWidgetName(playerId));
  const laneText =
    p?.deployObjectiveTimerLaneTextWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerLaneTextWidgetName(playerId));
  const outlineTop =
    p?.deployObjectiveTimerLaneOutlineTopWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId));
  const outlineBottom =
    p?.deployObjectiveTimerLaneOutlineBottomWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId));
  const outlineLeft =
    p?.deployObjectiveTimerLaneOutlineLeftWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId));
  const outlineRight =
    p?.deployObjectiveTimerLaneOutlineRightWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId));
  const title =
    p?.deployObjectiveTimerTitleWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerTitleWidgetName(playerId));
  const value =
    p?.deployObjectiveTimerValueWidget ?? findRootParentWidgetByName(getDeployObjectiveTimerValueWidgetName(playerId));

  SafeSetWidgetVisibleHandle(root, false);
  SafeSetWidgetVisibleHandle(panel, false);
  SafeSetWidgetVisibleHandle(laneFill, false);
  SafeSetWidgetVisibleHandle(laneText, false);
  SafeSetWidgetVisibleHandle(outlineTop, false);
  SafeSetWidgetVisibleHandle(outlineBottom, false);
  SafeSetWidgetVisibleHandle(outlineLeft, false);
  SafeSetWidgetVisibleHandle(outlineRight, false);
  SafeSetWidgetVisibleHandle(title, false);
  SafeSetWidgetVisibleHandle(value, false);

  if (p) {
    resetDeployObjectiveTimerCacheForPlayer(p);
  }
}

function HideAllDeployObjectiveTimerUi(): void {
  serverPlayers.forEach((p) => {
    hideDeployObjectiveTimerUiForPlayer(p.id);
  });
}

function UpdateDeployObjectiveTimerUiForPlayer(p: Player, nowSec?: number): void {
  if (gameStatus !== 3 || p.isDeployed) {
    hideDeployObjectiveTimerUiForPlayer(p.id);
    return;
  }

  const armedCpId = getHighestPriorityArmedObjectiveCpId();
  if (armedCpId === undefined) {
    hideDeployObjectiveTimerUiForPlayer(p.id);
    return;
  }

  const remainingSeconds = getObjectivePendingAwardRemainingSeconds(armedCpId);
  if (remainingSeconds === undefined) {
    hideDeployObjectiveTimerUiForPlayer(p.id);
    return;
  }

  const widgets = getCachedDeployObjectiveTimerWidgetsForPlayer(p);
  const root = widgets.root;
  const laneFill = widgets.laneFill;
  const laneText = widgets.laneText;
  const outlineTop = widgets.outlineTop;
  const outlineBottom = widgets.outlineBottom;
  const outlineLeft = widgets.outlineLeft;
  const outlineRight = widgets.outlineRight;
  const panel = widgets.panel;
  const title = widgets.title;
  const value = widgets.value;
  if (!root || !panel || !laneFill || !laneText || !outlineTop || !outlineBottom || !outlineLeft || !outlineRight || !title || !value) {
    return;
  }

  const lane = getObjectiveLaneSymbol(armedCpId, "A");
  const sampleNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const displayColor = getTopHudObjectiveDisplayColor(armedCpId, getObjectiveLaneBaseColor(lane), sampleNowSec);

  SafeSetWidgetVisibleHandle(root, true);
  SafeSetWidgetVisibleHandle(panel, true);
  SafeSetWidgetVisibleHandle(laneFill, true);
  SafeSetWidgetVisibleHandle(laneText, true);
  SafeSetWidgetVisibleHandle(outlineTop, true);
  SafeSetWidgetVisibleHandle(outlineBottom, true);
  SafeSetWidgetVisibleHandle(outlineLeft, true);
  SafeSetWidgetVisibleHandle(outlineRight, true);
  SafeSetWidgetVisibleHandle(title, true);
  SafeSetWidgetVisibleHandle(value, true);
  SafeSetWidgetBgColorHandle(laneFill, displayColor);
  SafeSetWidgetBgColorHandle(outlineTop, displayColor);
  SafeSetWidgetBgColorHandle(outlineBottom, displayColor);
  SafeSetWidgetBgColorHandle(outlineLeft, displayColor);
  SafeSetWidgetBgColorHandle(outlineRight, displayColor);
  SafeSetTextColorHandle(laneText, displayColor);
  SafeSetWidgetBgAlphaHandle(laneFill, TOP_HUD_FLAG_FILL_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineTop, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineBottom, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineLeft, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineRight, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  SafeSetTextAlphaHandle(laneText, TOP_HUD_FLAG_TEXT_BASE_ALPHA);

  if (p.deployObjectiveTimerLastShownCpId !== armedCpId) {
    SafeSetTextLabelHandle(laneText, mod.Message(getFlagStringKey(lane)));
    p.deployObjectiveTimerLastShownCpId = armedCpId;
    p.deployObjectiveTimerLastShownRemainingSeconds = -1;
  }

  if (p.deployObjectiveTimerLastShownRemainingSeconds !== remainingSeconds) {
    SafeSetTextLabelHandle(value, formatUiTimerLabel(remainingSeconds));
    p.deployObjectiveTimerLastShownRemainingSeconds = remainingSeconds;
  }
}

function UpdateDeployObjectiveTimerUiForAllPlayers(nowSec?: number): void {
  if (gameStatus !== 3) {
    HideAllDeployObjectiveTimerUi();
    return;
  }

  const sampleNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  serverPlayers.forEach((p) => UpdateDeployObjectiveTimerUiForPlayer(p, sampleNowSec));
}

function findActiveObjectiveHoldCpIdForPlayer(playerId: number): number | undefined {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (objectiveCaptureAttemptEnabledByCpId[cpId] !== true) continue;
    if (objectiveCaptureAttemptPlayerIdByCpId[cpId] !== playerId) continue;
    return cpId;
  }

  return undefined;
}

function UpdateObjectiveHoldProgressUiForPlayer(p: Player, nowSec?: number): void {
  const widgets = getCachedObjectiveHoldWidgetsForPlayer(p);
  const root = widgets.root;
  const container = widgets.container;
  const fillArming = widgets.fillArming;
  const fillDisarming = widgets.fillDisarming;
  const textArming = widgets.textArming;
  const textDisarming = widgets.textDisarming;
  if (!root || !container || !fillArming || !fillDisarming || !textArming || !textDisarming) return;

  const activeCpId = findActiveObjectiveHoldCpIdForPlayer(p.id);
  if (activeCpId === undefined) {
    hideObjectiveHoldProgressForPlayer(p.id);
    return;
  }

  const attemptActive = objectiveCaptureAttemptEnabledByCpId[activeCpId] === true;
  const startTick = objectiveCaptureAttemptStartTickByCpId[activeCpId];
  const startAtSec = objectiveCaptureAttemptStartAtSecByCpId[activeCpId];
  const attemptTeam = objectiveCaptureAttemptTeamByCpId[activeCpId] ?? teamNeutral;
  const attemptKind = objectiveCaptureAttemptKindByCpId[activeCpId] ?? "arm";

  if (
    !attemptActive ||
    (startTick === undefined && startAtSec === undefined) ||
    mod.Equals(attemptTeam, teamNeutral)
  ) {
    hideObjectiveHoldProgressForPlayer(p.id);
    return;
  }

  let progress = 0;
  if (startAtSec !== undefined && (nowSec !== undefined || (USE_ENGINE_TIME_SCHEDULER && currentFrameHasEngineNowSec))) {
    const sampleNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
    progress = (sampleNowSec - startAtSec) / OBJECTIVE_INTERACT_HOLD_SECONDS;
  } else if (startTick !== undefined) {
    progress = (serverTickCount - startTick) / OBJECTIVE_INTERACT_HOLD_TICKS;
  } else {
    hideObjectiveHoldProgressForPlayer(p.id);
    return;
  }

  if (progress < 0) progress = 0;
  if (progress > 1) progress = 1;

  const activeFill = attemptKind === "disarm" ? fillDisarming : fillArming;
  const inactiveFill = attemptKind === "disarm" ? fillArming : fillDisarming;
  const activeText = attemptKind === "disarm" ? textDisarming : textArming;
  const inactiveText = attemptKind === "disarm" ? textArming : textDisarming;

  let width = OBJECTIVE_HOLD_FILL_MIN_WIDTH + progress * (OBJECTIVE_HOLD_FILL_MAX_WIDTH - OBJECTIVE_HOLD_FILL_MIN_WIDTH);
  if (width < OBJECTIVE_HOLD_FILL_MIN_WIDTH) width = OBJECTIVE_HOLD_FILL_MIN_WIDTH;
  if (width > OBJECTIVE_HOLD_FILL_MAX_WIDTH) width = OBJECTIVE_HOLD_FILL_MAX_WIDTH;

  mod.SetUIWidgetPosition(container, mod.CreateVector(0, OBJECTIVE_HOLD_PROGRESS_BAR_OFFSET_Y, 0));
  mod.SetUIWidgetBgColor(container, OBJECTIVE_HOLD_BG_COLOR);
  mod.SetUIWidgetBgAlpha(container, OBJECTIVE_HOLD_PROGRESS_BG_ALPHA);
  mod.SetUIWidgetBgColor(activeFill, OBJECTIVE_HOLD_FILL_COLOR);
  mod.SetUIWidgetBgAlpha(activeFill, OBJECTIVE_HOLD_PROGRESS_FILL_ALPHA);
  mod.SetUIWidgetPosition(activeFill, mod.CreateVector(0, 0, 0));
  mod.SetUIWidgetSize(activeFill, mod.CreateVector(width, OBJECTIVE_HOLD_FILL_HEIGHT, 0));
  mod.SetUIWidgetVisible(activeFill, true);
  mod.SetUIWidgetPosition(inactiveFill, mod.CreateVector(0, 0, 0));
  mod.SetUIWidgetSize(inactiveFill, mod.CreateVector(OBJECTIVE_HOLD_FILL_MIN_WIDTH, OBJECTIVE_HOLD_FILL_HEIGHT, 0));
  mod.SetUIWidgetVisible(inactiveFill, false);
  mod.SetUIWidgetVisible(activeText, true);
  mod.SetUIWidgetVisible(inactiveText, false);
  mod.SetUIWidgetVisible(container, true);
  mod.SetUIWidgetDepth(root, mod.UIDepth.AboveGameUI);
  mod.SetUIWidgetDepth(container, mod.UIDepth.AboveGameUI);
  mod.SetUIWidgetDepth(fillArming, mod.UIDepth.AboveGameUI);
  mod.SetUIWidgetDepth(fillDisarming, mod.UIDepth.AboveGameUI);
  mod.SetUIWidgetDepth(textArming, mod.UIDepth.AboveGameUI);
  mod.SetUIWidgetDepth(textDisarming, mod.UIDepth.AboveGameUI);
}

function UpdateObjectiveHoldProgressUiForAllPlayers(nowSec?: number): void {
  if (gameStatus !== 3) {
    HideAllObjectiveHoldProgressUi();
    return;
  }

  const sampleNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  serverPlayers.forEach((p) => UpdateObjectiveHoldProgressUiForPlayer(p, sampleNowSec));
}

function HideAllObjectiveHoldProgressUi(): void {
  serverPlayers.forEach((p) => {
    hideObjectiveHoldProgressForPlayer(p.id);
  });
}


/* -----------------------------------------------------------------------------------------------
   Live HUD helpers
------------------------------------------------------------------------------------------------ */
const PULSE_MAX_ALPHA = 0.4;
const PULSE_DURATION_SECONDS = 0.55;
const PULSE_STEP_SECONDS = 0.05;

let lastFriendlyBleedPulseTick = -999999;
let lastEnemyBleedPulseTick = -999999;

let friendlyPulseRunning = false;
let enemyPulseRunning = false;

const BLEED_PULSE_COOLDOWN_TICKS = mod.Floor(1 * TICK_RATE);


function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function getBombCarrierPulseAlpha(nowSec: number): number {
  const oscillation = 0.5 + 0.5 * Math.sin(2 * Math.PI * CARRIER_PULSE_FREQ_HZ * nowSec);
  const alpha = CARRIER_PULSE_ALPHA_MIN + (CARRIER_PULSE_ALPHA_MAX - CARRIER_PULSE_ALPHA_MIN) * oscillation;
  return clamp01(alpha);
}

function getCipherCarrierHudMessage(): any {
  return getStringMessageWithFallback((mod.stringkeys as any).Text_BombCarrier, "CARRYING CIPHER KEY");
}

function hasCipherKeyHudWidgetRefs(p: Player): boolean {
  return !!(p.bombCarrierTextWidget && p.bombNoticeContainerWidget && p.bombNoticeTextWidget);
}

function ensureCipherKeyHudReadyForPlayer(p: Player, allowRebuild: boolean = true): boolean {
  if (!p) return false;
  if (hasCipherKeyHudWidgetRefs(p)) return true;

  bindPlayerTopScoreWidgetRefs(p);
  if (hasCipherKeyHudWidgetRefs(p)) return true;

  if (allowRebuild && gameStatus === 3) {
    if (rebuildPlayerTopScoreWidgets(p)) {
      bindPlayerTopScoreWidgetRefs(p);
    }
  }

  return hasCipherKeyHudWidgetRefs(p);
}

function repairCipherKeyHudCacheForPlayer(p: Player, allowRebuild: boolean = true): boolean {
  const ready = ensureCipherKeyHudReadyForPlayer(p, allowRebuild);
  markCipherKeyHudReadyForPlayer(p.id, ready);
  return ready;
}

function repairCipherKeyHudCachesForAllPlayers(allowRebuild: boolean = true): void {
  const players = getCipherKeyUiPlayerSnapshot(true);
  for (let i = 0; i < players.length; i++) {
    repairCipherKeyHudCacheForPlayer(players[i], allowRebuild);
  }
}

function repairDirtyCipherKeyHudCaches(maxRepairs: number = 2): void {
  if (maxRepairs <= 0) return;

  let repaired = 0;
  const players = getCipherKeyUiPlayerSnapshot(true);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (cipherKeyHudDirtyByPlayerId[p.id] !== true && cipherKeyHudReadyByPlayerId[p.id] === true) continue;
    repairCipherKeyHudCacheForPlayer(p, true);
    repaired += 1;
    if (repaired >= maxRepairs) return;
  }
}

function applyBombCarrierHudStateForPlayer(
  p: Player,
  visible: boolean,
  alpha: number,
  alphaBucket: number,
  force: boolean
): void {
  let widget = p.bombCarrierTextWidget;
  if (!widget && force) {
    bindPlayerCipherKeyHudWidgetRefs(p, true);
    widget = p.bombCarrierTextWidget;
  }
  if (!widget) {
    markCipherKeyHudDirtyForPlayer(p.id);
    return;
  }

  if (force || p.bombCarrierUiLastVisible !== visible || p.bombCarrierUiLastVersion !== bombCarrierUiStateVersion) {
    try {
      mod.SetUIWidgetVisible(widget, visible);
      p.bombCarrierUiLastVisible = visible;
      p.bombCarrierUiLastVersion = bombCarrierUiStateVersion;
      p.bombCarrierUiLastAlphaBucket = -1;
      if (visible) {
        SafeSetTextLabelHandle(widget, getCipherCarrierHudMessage());
        SafeSetTextSizeHandle(widget, 27);
      }
    } catch (_errVisible) {
      p.bombCarrierTextWidget = null as any;
      markCipherKeyHudDirtyForPlayer(p.id);
      if (force) {
        bindPlayerCipherKeyHudWidgetRefs(p, true);
        const retryWidget = p.bombCarrierTextWidget;
        if (retryWidget) {
          try {
            mod.SetUIWidgetVisible(retryWidget, visible);
            p.bombCarrierUiLastVisible = visible;
            p.bombCarrierUiLastVersion = bombCarrierUiStateVersion;
            p.bombCarrierUiLastAlphaBucket = -1;
            if (visible) {
              SafeSetTextLabelHandle(retryWidget, getCipherCarrierHudMessage());
              SafeSetTextSizeHandle(retryWidget, 27);
            }
            widget = retryWidget;
          } catch (_errRetryVisible) {
            p.bombCarrierTextWidget = null as any;
            markCipherKeyHudDirtyForPlayer(p.id);
            return;
          }
        }
      }
      if (!widget) return;
    }
  }

  try {
    if (visible && (force || p.bombCarrierUiLastAlphaBucket !== alphaBucket)) {
      mod.SetUITextAlpha(widget, alpha);
      p.bombCarrierUiLastAlphaBucket = alphaBucket;
    } else if (!visible && (force || p.bombCarrierUiLastAlphaBucket !== 100)) {
      mod.SetUITextAlpha(widget, 1);
      p.bombCarrierUiLastAlphaBucket = 100;
    }
  } catch (_errAlpha) {
    p.bombCarrierTextWidget = null as any;
    markCipherKeyHudDirtyForPlayer(p.id);
  }
}

function UpdateBombCarrierUiForAllPlayers(nowSec?: number, force: boolean = false): void {
  const alpha = getBombCarrierPulseAlpha(nowSec ?? getCurrentSchedulerNowSeconds());
  const alphaBucket = mod.Floor(alpha * 100);

  const players = getCipherKeyUiPlayerSnapshot();
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p.bombCarrierTextWidget && !force) {
      markCipherKeyHudDirtyForPlayer(p.id);
      continue;
    }
    const visible =
      gameStatus === 3 &&
      bombCarrierPlayerId === p.id &&
      p.isDeployed;

    applyBombCarrierHudStateForPlayer(p, visible, alpha, alphaBucket, force);
  }
}

function getActiveGlobalBombNoticeMessage(): any {
  return getStringMessageWithFallback(bombNoticeMessageKey, bombNoticeFallbackText);
}

function getActiveBombNoticeMessageForPlayer(p: Player, nowSec: number): any {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  if (playerVisibleUntilSec > nowSec) {
    return getStringMessageWithFallback(
      bombNoticeMessageKeyByPlayerId[p.id],
      bombNoticeFallbackTextByPlayerId[p.id] ?? bombNoticeFallbackText
    );
  }

  return getActiveGlobalBombNoticeMessage();
}

function isBombNoticeVisibleForPlayer(p: Player, nowSec: number): boolean {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  return playerVisibleUntilSec > nowSec || bombNoticeVisibleUntilSec > nowSec;
}

function getBombNoticeUiStateKeyForPlayer(p: Player, nowSec: number): string {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  if (playerVisibleUntilSec > nowSec) {
    return "p:" + String(bombNoticeTokenByPlayerId[p.id] ?? 0);
  }
  if (bombNoticeVisibleUntilSec > nowSec) {
    return "g:" + String(bombNoticeToken);
  }
  return "hidden";
}

function refreshBombNoticeUiForPlayer(p: Player, nowSec?: number, force: boolean = false): void {
  let container = p.bombNoticeContainerWidget;
  let widget = p.bombNoticeTextWidget;
  if ((!container || !widget) && force) {
    bindPlayerCipherKeyHudWidgetRefs(p, true);
    container = p.bombNoticeContainerWidget;
    widget = p.bombNoticeTextWidget;
  }
  if (!container || !widget) {
    markCipherKeyHudDirtyForPlayer(p.id);
    return;
  }

  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const visible = gameStatus === 3 && isBombNoticeVisibleForPlayer(p, resolvedNowSec);
  const stateKey = visible ? getBombNoticeUiStateKeyForPlayer(p, resolvedNowSec) : "hidden";
  if (!force && p.bombNoticeUiLastStateKey === stateKey) return;
  p.bombNoticeUiLastStateKey = stateKey;

  try {
    SafeSetTextLabelHandle(widget, getActiveBombNoticeMessageForPlayer(p, resolvedNowSec));
    SafeSetTextSizeHandle(widget, BOMB_NOTICE_WIDGET_TEXT_SIZE);
    mod.SetUIWidgetVisible(container, visible);
    mod.SetUIWidgetVisible(widget, visible);
    mod.SetUITextAlpha(widget, visible ? 1 : 0);
  } catch (_errNotice) {
    p.bombNoticeContainerWidget = null as any;
    p.bombNoticeTextWidget = null as any;
    markCipherKeyHudDirtyForPlayer(p.id);
    if (force) {
      bindPlayerCipherKeyHudWidgetRefs(p, true);
      container = p.bombNoticeContainerWidget;
      widget = p.bombNoticeTextWidget;
      if (!container || !widget) return;
      try {
        SafeSetTextLabelHandle(widget, getActiveBombNoticeMessageForPlayer(p, resolvedNowSec));
        SafeSetTextSizeHandle(widget, BOMB_NOTICE_WIDGET_TEXT_SIZE);
        mod.SetUIWidgetVisible(container, visible);
        mod.SetUIWidgetVisible(widget, visible);
        mod.SetUITextAlpha(widget, visible ? 1 : 0);
      } catch (_errNoticeRetry) {
        p.bombNoticeContainerWidget = null as any;
        p.bombNoticeTextWidget = null as any;
        markCipherKeyHudDirtyForPlayer(p.id);
      }
    }
  }
}

function refreshBombNoticeUiForAllPlayers(nowSec?: number, force: boolean = false): void {
  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const players = getCipherKeyUiPlayerSnapshot();
  for (let i = 0; i < players.length; i++) {
    refreshBombNoticeUiForPlayer(players[i], resolvedNowSec, force);
  }
}

function clearBombNoticeState(): void {
  bombNoticeToken++;
  bombNoticeVisibleUntilSec = 0;
  bombNoticeMessageKeyByPlayerId = {};
  bombNoticeFallbackTextByPlayerId = {};
  bombNoticeVisibleUntilSecByPlayerId = {};
  bombNoticeTokenByPlayerId = {};
  refreshBombNoticeUiForAllPlayers(undefined, true);
}

async function hideBombNoticeAfterDelay(token: number, durationSeconds: number): Promise<void> {
  await mod.Wait(durationSeconds);
  if (bombNoticeToken !== token) return;

  bombNoticeVisibleUntilSec = 0;
  refreshBombNoticeUiForAllPlayers(undefined, true);
}

async function hideBombNoticeForPlayerAfterDelay(
  playerId: number,
  token: number,
  durationSeconds: number
): Promise<void> {
  await mod.Wait(durationSeconds);
  if ((bombNoticeTokenByPlayerId[playerId] ?? 0) !== token) return;

  bombNoticeVisibleUntilSecByPlayerId[playerId] = 0;
  const sp = serverPlayers.get(playerId);
  if (sp) refreshBombNoticeUiForPlayer(sp, undefined, true);
}

function showBombNoticeForAllPlayers(
  messageKey: any,
  fallbackText: string,
  durationSeconds: number = BOMB_NOTICE_DURATION_SECONDS
): void {
  if (gameStatus !== 3) return;

  bombNoticeMessageKeyByPlayerId = {};
  bombNoticeFallbackTextByPlayerId = {};
  bombNoticeVisibleUntilSecByPlayerId = {};
  bombNoticeTokenByPlayerId = {};
  bombNoticeMessageKey = messageKey;
  bombNoticeFallbackText = fallbackText;
  bombNoticeToken++;
  const token = bombNoticeToken;
  const nowSec = getCurrentSchedulerNowSeconds();
  bombNoticeVisibleUntilSec = nowSec + durationSeconds;
  refreshCipherKeyPlayerSnapshots("showBombNoticeForAllPlayers");
  refreshBombNoticeUiForAllPlayers(nowSec, true);
  void hideBombNoticeAfterDelay(token, durationSeconds);
}

function showBombNoticeForPlayer(
  playerId: number,
  messageKey: any,
  fallbackText: string,
  durationSeconds: number = BOMB_NOTICE_DURATION_SECONDS
): void {
  if (gameStatus !== 3) return;

  const sp = getCipherKeyPlayerSnapshot(playerId) ?? serverPlayers.get(playerId);
  if (!sp) return;

  const token = (bombNoticeTokenByPlayerId[playerId] ?? 0) + 1;
  bombNoticeTokenByPlayerId[playerId] = token;
  bombNoticeMessageKeyByPlayerId[playerId] = messageKey;
  bombNoticeFallbackTextByPlayerId[playerId] = fallbackText;
  const nowSec = getCurrentSchedulerNowSeconds();
  bombNoticeVisibleUntilSecByPlayerId[playerId] = nowSec + durationSeconds;
  refreshBombNoticeUiForPlayer(sp, nowSec, true);
  void hideBombNoticeForPlayerAfterDelay(playerId, token, durationSeconds);
}

function showTeamScopedBombNoticeForKeyTeam(
  keyTeam: mod.Team,
  friendlyKey: any,
  friendlyFallback: string,
  enemyKey: any,
  enemyFallback: string,
  durationSeconds: number = BOMB_NOTICE_DURATION_SECONDS
): void {
  if (mod.Equals(keyTeam, teamNeutral)) return;

  const keyTeamId = mod.Equals(keyTeam, team1) ? 1 : mod.Equals(keyTeam, team2) ? 2 : 0;
  if (keyTeamId <= 0) return;

  refreshCipherKeyPlayerSnapshots("showTeamScopedBombNoticeForKeyTeam");
  const players = getCipherKeyUiPlayerSnapshot(false);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const viewerTeamId = cipherKeyTeamIdByPlayerIdSnapshot[p.id];
    if (viewerTeamId === keyTeamId) {
      showBombNoticeForPlayer(p.id, friendlyKey, friendlyFallback, durationSeconds);
    } else if (viewerTeamId === 1 || viewerTeamId === 2) {
      showBombNoticeForPlayer(p.id, enemyKey, enemyFallback, durationSeconds);
    }
  }
}

function showCipherKeyPickupNoticeForTeam(keyTeam: mod.Team): void {
  showTeamScopedBombNoticeForKeyTeam(
    keyTeam,
    (mod.stringkeys as any).CipherKeyWeHave,
    "WE HAVE THE KEY",
    (mod.stringkeys as any).CipherKeyEnemyHas,
    "ENEMY TEAM HAS KEY"
  );
}

function showCipherKeyDroppedNoticeForTeam(keyTeam: mod.Team): void {
  showTeamScopedBombNoticeForKeyTeam(
    keyTeam,
    (mod.stringkeys as any).CipherKeyWeDropped,
    "WE DROPPED THE KEY",
    (mod.stringkeys as any).CipherKeyEnemyDropped,
    "ENEMY DROPPED KEY"
  );
}

async function pulseWidgetAlpha(widget: mod.UIWidget, maxAlpha: number): Promise<void> {
  if (!widget) return;

  const steps = mod.Max(1, mod.Ceiling(PULSE_DURATION_SECONDS / PULSE_STEP_SECONDS));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // triangle wave 0 -> 1 -> 0
    const up = t <= 0.5 ? (t / 0.5) : ((1 - t) / 0.5);
    const a = maxAlpha * clamp01(up);

    mod.SetUIWidgetBgAlpha(widget, a);

    await mod.Wait(PULSE_STEP_SECONDS);
  }

  mod.SetUIWidgetBgAlpha(widget, 0);
}

function ClampTicketsAndMaybeEndMatch(): void {
  // Normalize score values first so all win checks/UI are deterministic.
  const t1 = serverScores[0];
  const t2 = serverScores[1];

  const t1Valid = typeof t1 === "number" && Number.isFinite(t1);
  const t2Valid = typeof t2 === "number" && Number.isFinite(t2);

  serverScores[0] = t1Valid ? t1 : 0;
  serverScores[1] = t2Valid ? t2 : 0;

  if (serverScores[0] < 0) serverScores[0] = 0;
  if (serverScores[1] < 0) serverScores[1] = 0;
  if (serverScores[0] > WIN_SCORE) serverScores[0] = WIN_SCORE;
  if (serverScores[1] > WIN_SCORE) serverScores[1] = WIN_SCORE;

  // End immediately once either team reaches the win score.
  if (serverScores[0] >= WIN_SCORE || serverScores[1] >= WIN_SCORE) {
    finalizePendingObjectiveAwardsForImmediateTransition("ClampTicketsAndMaybeEndMatch");
    enterPostmatchFromLive();
  }
}
const TICKET_PULSE_TEXT_MAX_ALPHA = 1.0;
const TICKET_PULSE_TEXT_MIN_ALPHA = 0.55;

let pulseRunningByPlayerKey: { [key: string]: boolean } = {};
let lastBleedPulseTickByLosingTeamId: { [teamId: number]: number } = {};

async function pulseBgAlpha(widget: mod.UIWidget, maxAlpha: number, endAlpha: number): Promise<void> {
  if (!widget) return;

  const steps = mod.Max(1, mod.Ceiling(PULSE_DURATION_SECONDS / PULSE_STEP_SECONDS));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    const up = t <= 0.5 ? (t / 0.5) : ((1 - t) / 0.5);
    const a = maxAlpha * clamp01(up);

    mod.SetUIWidgetBgAlpha(widget, a);
    await mod.Wait(PULSE_STEP_SECONDS);
  }

  mod.SetUIWidgetBgAlpha(widget, endAlpha);
}


async function pulseTextAlpha(widget: mod.UIWidget): Promise<void> {
  if (!widget) return;

  const steps = mod.Max(1, mod.Ceiling(PULSE_DURATION_SECONDS / PULSE_STEP_SECONDS));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    const up = t <= 0.5 ? (t / 0.5) : ((1 - t) / 0.5);
    const a = TICKET_PULSE_TEXT_MIN_ALPHA + (TICKET_PULSE_TEXT_MAX_ALPHA - TICKET_PULSE_TEXT_MIN_ALPHA) * clamp01(up);

    mod.SetUITextAlpha(widget, a);
    await mod.Wait(PULSE_STEP_SECONDS);
  }

  mod.SetUITextAlpha(widget, 1);
}

async function pulseTicketsForPlayerSide(p: Player, side: "friendly" | "enemy"): Promise<void> {
  const key = p.id + "_" + side;
  if (pulseRunningByPlayerKey[key] === true) return;
  pulseRunningByPlayerKey[key] = true;

  try {
    if (side === "friendly") {
      const score = mod.FindUIWidgetWithName("TeamFriendlyScore" + p.id);
      const scorePulse = mod.FindUIWidgetWithName("FriendlyScorePulse" + p.id);

      await Promise.all([
        pulseTextAlpha(score),
        pulseBgAlpha(scorePulse, 0.4, 0),  // overlay returns to invisible
      ]);
      return;
    }

    const score = mod.FindUIWidgetWithName("TeamOpponentScore" + p.id);
    const scorePulse = mod.FindUIWidgetWithName("EnemyScorePulse" + p.id);

    await Promise.all([
      pulseTextAlpha(score),
      pulseBgAlpha(scorePulse, 0.4, 0),
    ]);
  } finally {
    pulseRunningByPlayerKey[key] = false;
  }
}
function ClearAllTicketBleedPulses(): void {
  serverPlayers.forEach((p) => {
    const f = mod.FindUIWidgetWithName("FriendlyScorePulse" + p.id);
    const e = mod.FindUIWidgetWithName("EnemyScorePulse" + p.id);
    if (f) mod.SetUIWidgetBgAlpha(f, 0);
    if (e) mod.SetUIWidgetBgAlpha(e, 0);
  });
}


function triggerBleedPulseForLosingTeam(losingTeam: mod.Team): void {
  const losingTeamId = modlib.getTeamId(losingTeam);

  const last = lastBleedPulseTickByLosingTeamId[losingTeamId] ?? -999999;
  if (serverTickCount - last < BLEED_PULSE_COOLDOWN_TICKS) return;
  lastBleedPulseTickByLosingTeamId[losingTeamId] = serverTickCount;

  // If losingTeam is your team => pulse friendly side. Otherwise pulse enemy side.
  serverPlayers.forEach((p) => {
    const t = mod.GetTeam(p.player);

    if (mod.Equals(t, losingTeam)) {
      void pulseTicketsForPlayerSide(p, "friendly");
    } else if (mod.Equals(t, team1) || mod.Equals(t, team2)) {
      void pulseTicketsForPlayerSide(p, "enemy");
    }
  });
}


function ChangeTickets(): void {
  // First-to-2 mode: score changes only on enemy-owned flag captures.
  // Keep pulse cleanup and centralized win evaluation in this periodic path.
  ClearAllTicketBleedPulses();
  ClampTicketsAndMaybeEndMatch();
}

function ForceAllPlayersNeutralFlagUI(): void {
  serverPlayers.forEach((p) => {
    // Neutralize the small A-F letters for this player
    for (let i = 0; i < TOP_HUD_LANES.length; i++) {
      setFlagLetterAndOutlineColorForPlayer(p.id, TOP_HUD_LANES[i], COLOR_NEUTRAL);
    }


    // Hide the on-point widget if it is showing
    p.setCapturePoint(null);
    if (p.activeFlagContainerWidget) mod.SetUIWidgetVisible(p.activeFlagContainerWidget, false);

    // Clear numbers so they do not stick visually
    if (p.activeFlagWidget) mod.SetUITextLabel(p.activeFlagWidget, mod.Message(""));
    if (p.activeFlagFriendlyWidget) mod.SetUITextLabel(p.activeFlagFriendlyWidget, mod.Message(""));
    if (p.activeFlagEnemyWidget) mod.SetUITextLabel(p.activeFlagEnemyWidget, mod.Message(""));

    // Optional: also clear the per-player cap numbers if they exist
    if (p.friendlyCapWidget) mod.SetUITextLabel(p.friendlyCapWidget, mod.Message(""));
    if (p.enemyCapWidget) mod.SetUITextLabel(p.enemyCapWidget, mod.Message(""));
  });
}

// Ticket bar fills are per-player; keep shared fills hidden.
function HideSharedTicketBarFills(): void {
  // Progress bars were removed from the top score panel.
}
function UpdateTopFlagColorsForPlayer(p: Player): void {
  const team = mod.GetTeam(p.player);
  const sampleNowSec = getCurrentSchedulerNowSeconds();
  for (let i = 0; i < TOP_HUD_LANES.length; i++) {
    const lane = TOP_HUD_LANES[i];
    const cpId = getHudCpIdForViewerLane(team, lane);
    const displayLetter = getHudDisplayLetterForViewerLane(team, lane);
    const alphaMultiplier = getTopHudObjectiveAlphaMultiplier(cpId);
    const laneColor = getHudColorForViewerLane(team, lane);
    const displayColor = getTopHudObjectiveDisplayColor(cpId, laneColor, sampleNowSec);

    const letter = mod.FindUIWidgetWithName("FLAG" + lane + p.id);
    const fill = mod.FindUIWidgetWithName("FLAG" + lane + "_FILL" + p.id);
    const outT = mod.FindUIWidgetWithName("FLAG" + lane + "_OL_T" + p.id);
    const outB = mod.FindUIWidgetWithName("FLAG" + lane + "_OL_B" + p.id);
    const outL = mod.FindUIWidgetWithName("FLAG" + lane + "_OL_L" + p.id);
    const outR = mod.FindUIWidgetWithName("FLAG" + lane + "_OL_R" + p.id);

    if (letter) {
      mod.SetUITextLabel(letter, mod.Message(getFlagStringKey(displayLetter)));
      mod.SetUITextColor(letter, displayColor);
      mod.SetUITextAlpha(letter, TOP_HUD_FLAG_TEXT_BASE_ALPHA * alphaMultiplier);
    }
    if (fill) {
      mod.SetUIWidgetBgColor(fill, displayColor);
      mod.SetUIWidgetBgAlpha(fill, TOP_HUD_FLAG_FILL_BASE_ALPHA * alphaMultiplier);
    }
    if (outT) {
      mod.SetUIWidgetBgColor(outT, displayColor);
      mod.SetUIWidgetBgAlpha(outT, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA * alphaMultiplier);
    }
    if (outB) {
      mod.SetUIWidgetBgColor(outB, displayColor);
      mod.SetUIWidgetBgAlpha(outB, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA * alphaMultiplier);
    }
    if (outL) {
      mod.SetUIWidgetBgColor(outL, displayColor);
      mod.SetUIWidgetBgAlpha(outL, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA * alphaMultiplier);
    }
    if (outR) {
      mod.SetUIWidgetBgColor(outR, displayColor);
      mod.SetUIWidgetBgAlpha(outR, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA * alphaMultiplier);
    }
  }
}

function UpdateTopFlagColorsForAllPlayers(): void {
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

// Ticket bar fills shrink with the viewer's friendly/opponent tickets.
function UpdateTopTicketBarsForPlayer(p: Player): void {
  // Ticket progress bars were intentionally removed from this HUD layout.
  void p;
}


// -------------------------------------------------------------------------------------------------
// UI SAFE HELPERS
// Prevent runtime errors if a widget name does not exist yet (join-in-progress / rebuild races).
// These functions do nothing if the widget is missing.
// -------------------------------------------------------------------------------------------------
function setFlagOutlineColorForPlayer(playerId: number, symbol: TopHudLane, color: mod.Vector): void {
  const t = mod.FindUIWidgetWithName("FLAG" + symbol + "_OL_T" + playerId);
  const b = mod.FindUIWidgetWithName("FLAG" + symbol + "_OL_B" + playerId);
  const l = mod.FindUIWidgetWithName("FLAG" + symbol + "_OL_L" + playerId);
  const r = mod.FindUIWidgetWithName("FLAG" + symbol + "_OL_R" + playerId);

  if (t) {
    mod.SetUIWidgetBgColor(t, color);
    mod.SetUIWidgetBgAlpha(t, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  }
  if (b) {
    mod.SetUIWidgetBgColor(b, color);
    mod.SetUIWidgetBgAlpha(b, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  }
  if (l) {
    mod.SetUIWidgetBgColor(l, color);
    mod.SetUIWidgetBgAlpha(l, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  }
  if (r) {
    mod.SetUIWidgetBgColor(r, color);
    mod.SetUIWidgetBgAlpha(r, TOP_HUD_FLAG_OUTLINE_BASE_ALPHA);
  }
}

function setFlagLetterAndOutlineColorForPlayer(playerId: number, symbol: TopHudLane, color: mod.Vector): void {
  const letter = mod.FindUIWidgetWithName("FLAG" + symbol + playerId);
  if (letter) {
    mod.SetUITextColor(letter, color);
    mod.SetUITextAlpha(letter, TOP_HUD_FLAG_TEXT_BASE_ALPHA);
  }

  setFlagOutlineColorForPlayer(playerId, symbol, color);
  setFlagFillColorForPlayer(playerId, symbol, color);
}


function setFlagFillColorForPlayer(playerId: number, symbol: TopHudLane, color: mod.Vector): void {
  const fill = mod.FindUIWidgetWithName("FLAG" + symbol + "_FILL" + playerId);
  if (!fill) return;

  mod.SetUIWidgetBgColor(fill, color);
  mod.SetUIWidgetBgAlpha(fill, TOP_HUD_FLAG_FILL_BASE_ALPHA);
  mod.SetUIWidgetBgFill(fill, mod.UIBgFill.Blur);
}


function SafeFindWidget(name: string): mod.UIWidget | null {
  const w = mod.FindUIWidgetWithName(name);
  return w ? w : null;
}

function SafeSetWidgetVisibleHandle(widget: mod.UIWidget | undefined | null, visible: boolean): void {
  if (!widget) return;
  try {
    mod.SetUIWidgetVisible(widget, visible);
  } catch (_err) {}
}

function SafeSetWidgetPositionHandle(widget: mod.UIWidget | undefined | null, pos: mod.Vector): void {
  if (!widget) return;
  try {
    mod.SetUIWidgetPosition(widget, pos);
  } catch (_err) {}
}

function SafeSetWidgetSizeHandle(widget: mod.UIWidget | undefined | null, size: mod.Vector): void {
  if (!widget) return;
  try {
    mod.SetUIWidgetSize(widget, size);
  } catch (_err) {}
}

function SafeDeleteWidgetHandle(widget: mod.UIWidget | undefined | null): void {
  if (!widget) return;
  try {
    mod.DeleteUIWidget(widget);
  } catch (_err) {}
}

function SafeSetTextLabelHandle(widget: mod.UIWidget | undefined | null, label: any): void {
  if (!widget) return;
  try {
    mod.SetUITextLabel(widget, label);
  } catch (_err) {}
}

function SafeSetTextColorHandle(widget: mod.UIWidget | undefined | null, color: mod.Vector): void {
  if (!widget) return;
  try {
    mod.SetUITextColor(widget, color);
  } catch (_err) {}
}

function SafeSetTextAlphaHandle(widget: mod.UIWidget | undefined | null, value: number): void {
  if (!widget) return;
  try {
    mod.SetUITextAlpha(widget, value);
  } catch (_err) {}
}

function SafeSetTextSizeHandle(widget: mod.UIWidget | undefined | null, value: number): void {
  if (!widget) return;
  try {
    mod.SetUITextSize(widget, value);
  } catch (_err) {}
}

function SafeSetWidgetDepthHandle(widget: mod.UIWidget | undefined | null, depth: mod.UIDepth): void {
  if (!widget) return;
  try {
    mod.SetUIWidgetDepth(widget, depth);
  } catch (_err) {}
}

function SafeSetWidgetBgColorHandle(widget: mod.UIWidget | undefined | null, color: mod.Vector): void {
  if (!widget) return;
  try {
    mod.SetUIWidgetBgColor(widget, color);
  } catch (_err) {}
}

function SafeSetWidgetBgAlphaHandle(widget: mod.UIWidget | undefined | null, value: number): void {
  if (!widget) return;
  try {
    mod.SetUIWidgetBgAlpha(widget, value);
  } catch (_err) {}
}

function SafeSetTextAlphaByName(name: string, a: number): void {
  const w = SafeFindWidget(name);
  if (!w) return;
  try {
    mod.SetUITextAlpha(w, a);
  } catch (_err) {}
}

function SafeSetTextLabelByName(name: string, label: any): void {
  const w = SafeFindWidget(name);
  if (!w) return;
  try {
    mod.SetUITextLabel(w, label);
  } catch (_err) {}
}

function formatUiTimerLabel(totalSeconds: number): any {
  let safeSeconds = totalSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds < 0) safeSeconds = 0;
  safeSeconds = mod.Floor(safeSeconds);
  const minutes = mod.Floor(safeSeconds / 60);
  const totalSecondsRemainder = mod.Floor(safeSeconds % 60);
  const seconds1 = totalSecondsRemainder % 10;
  const seconds10 = mod.Floor(totalSecondsRemainder / 10);
  if (minutes < 10) {
    return mod.Message(mod.stringkeys.RemainingTimeSingleDigitMinute, minutes, seconds10, seconds1);
  }
  return mod.Message(mod.stringkeys.RemainingTimeDoubleDigitMinute, minutes, seconds10, seconds1);
}

function getAllObjectivePendingAwardActive(): boolean {
  for (let i = 0; i < ALL_OBJECTIVE_CP_IDS.length; i++) {
    if (isObjectivePendingAwardActive(ALL_OBJECTIVE_CP_IDS[i])) return true;
  }
  return false;
}

function resetLiveTimerWidgetPresentation(): void {
  SafeSetWidgetVisibleByName("matchtime", false);
  SafeSetWidgetVisibleByName("LiveTimerIntroContainer", false);
}

function resetLiveClockState(): void {
  liveClockStarted = false;
  liveClockCountdownStartAtSec = 0;
  liveClockDeadlineAtSec = 0;
  liveClockCurrentPhaseDurationSeconds = 0;
  liveClockOvertimeActive = false;
  liveClockOvertimeConsumed = false;
  liveClockTimeoutHoldActive = false;
  liveTimerIntroActive = false;
  liveTimerIntroEndsAtSec = 0;
  liveTimerIntroDisplaySeconds = ROUND_TIME;
  resetLiveTimerWidgetPresentation();
}

function startLiveTimerIntro(targetSeconds: number, nowSec?: number): void {
  const resolvedNow = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();
  liveTimerIntroActive = true;
  liveTimerIntroEndsAtSec = resolvedNow + LIVE_TIMER_INTRO_SECONDS;
  liveTimerIntroDisplaySeconds = targetSeconds;
  SafeSetWidgetVisibleByName("LiveTimerIntroContainer", true);
  SafeSetWidgetVisibleByName("matchtime", false);
}

function getLiveClockRemainingSeconds(nowSec: number): number | undefined {
  if (!liveClockStarted || liveClockCurrentPhaseDurationSeconds <= 0) return undefined;
  if (liveClockTimeoutHoldActive) return 0;
  if (!Number.isFinite(liveClockDeadlineAtSec) || liveClockDeadlineAtSec <= 0) return undefined;
  const remaining = liveClockDeadlineAtSec - nowSec;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return remaining;
}

function updateLiveTimerIntroState(nowSec: number): void {
  if (liveTimerIntroActive && nowSec >= liveTimerIntroEndsAtSec) {
    liveTimerIntroActive = false;
    liveTimerIntroEndsAtSec = 0;
  }

  const showIntro = gameStatus === 3 && liveTimerIntroActive;
  const showLeftHudTimer = gameStatus === 3 && liveClockStarted && !liveTimerIntroActive;
  SafeSetWidgetVisibleByName("LiveTimerIntroContainer", showIntro);
  SafeSetWidgetVisibleByName("matchtime", showLeftHudTimer);
}

function beginScriptOwnedLiveClockPhase(durationSeconds: number, nowSec?: number, showIntro: boolean = false): void {
  const resolvedNow = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();
  liveClockStarted = true;
  liveClockTimeoutHoldActive = false;
  liveClockCurrentPhaseDurationSeconds = durationSeconds;
  liveClockCountdownStartAtSec = resolvedNow;
  liveClockDeadlineAtSec = resolvedNow + durationSeconds;
  liveTimerIntroDisplaySeconds = durationSeconds;
  if (showIntro) {
    startLiveTimerIntro(durationSeconds, resolvedNow);
  } else {
    liveTimerIntroActive = false;
    liveTimerIntroEndsAtSec = 0;
  }
  SetUITime(resolvedNow);
}

function beginRegulationClock(nowSec?: number): void {
  if (liveClockStarted) return;
  liveClockOvertimeActive = false;
  beginScriptOwnedLiveClockPhase(ROUND_TIME, nowSec, false);
  playFreshAnnouncementVoToAllTeams(
    mod.VoiceOverEvents2D.RoundStartGeneric,
    mod.VoiceOverFlags.Alpha,
    "round_start_generic"
  );
}

function beginOvertimeClock(nowSec?: number): void {
  const resolvedNow = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();
  liveClockOvertimeActive = true;
  liveClockOvertimeConsumed = true;
  beginScriptOwnedLiveClockPhase(OVERTIME_TIME, resolvedNow, true);
  playFreshAnnouncementVoToAllTeams(
    mod.VoiceOverEvents2D.TimeOvertime,
    mod.VoiceOverFlags.Alpha,
    "time_overtime"
  );
}

function resetCipherSuddenDeathState(): void {
  cipherSuddenDeathEliminatedByPlayerId = {};
  cipherSuddenDeathUndeployIgnoreUntilSec = 0;
}

function resetCipherObjectivesForCurrentStage(context: string): void {
  cipherPendingScoreTransitionTeam = teamNeutral;
  resetBombCarrierRuntimeState(true, true);
  resetCipherSpawnRoutingState();
  resetCipherObjectiveCounters();
  applyObjectiveLiveHybridRoundStartState(true);
  syncLiveHybridObjectiveSurfaceState(context, true);
  updateCipherCounterWorldIcons(true);
}

function showCipherPhaseNoticeForAllPlayers(messageKey: any, fallbackText: string, durationSeconds: number = 3): void {
  const message = getStringMessageWithFallback(messageKey, fallbackText);
  modlib.ShowHighlightedGameModeMessage(message, team1);
  modlib.ShowHighlightedGameModeMessage(message, team2);
  if (gameStatus === 3) {
    showBombNoticeForAllPlayers(messageKey, fallbackText, durationSeconds);
  }
}

function setCipherPhaseCountdownOverlay(messageKey: any, fallbackText: string, secondsRemaining: number): void {
  SafeSetTextLabelByName("MatchStartsText", getStringMessageWithFallback(messageKey, fallbackText));
  SafeSetTextLabelByName("CountDownText", mod.Message(secondsRemaining));
  SetCountdownOverlayVisible(true);
  SetCountdownOverlayDepthAboveGameUI();
}

const CIPHER_TRANSITION_ROOT_WIDGET_NAME_PREFIX = "CipherTransitionRoot";
const CIPHER_TRANSITION_PANEL_WIDGET_NAME_PREFIX = "CipherTransitionPanel";
const CIPHER_TRANSITION_TITLE_WIDGET_NAME_PREFIX = "CipherTransitionTitle";
const CIPHER_TRANSITION_SUBTITLE_WIDGET_NAME_PREFIX = "CipherTransitionSubtitle";
const CIPHER_TRANSITION_PROGRESS_WIDGET_NAME_PREFIX = "CipherTransitionProgress";
const CIPHER_TRANSITION_TIMER_WIDGET_NAME_PREFIX = "CipherTransitionTimer";
const CIPHER_TRANSITION_ROOT_SIZE = mod.CreateVector(1920, 1080, 0);
const CIPHER_TRANSITION_PANEL_POS = mod.CreateVector(0, -78, 0);
const CIPHER_TRANSITION_PANEL_SIZE = mod.CreateVector(650, 178, 0);
const CIPHER_TRANSITION_TITLE_POS = mod.CreateVector(0, -54, 0);
const CIPHER_TRANSITION_SUBTITLE_POS = mod.CreateVector(0, -14, 0);
const CIPHER_TRANSITION_PROGRESS_POS = mod.CreateVector(0, 28, 0);
const CIPHER_TRANSITION_TIMER_POS = mod.CreateVector(0, 66, 0);
const CIPHER_TRANSITION_TITLE_SIZE = mod.CreateVector(600, 42, 0);
const CIPHER_TRANSITION_ROW_SIZE = mod.CreateVector(600, 30, 0);
const CIPHER_TRANSITION_TITLE_TEXT_SIZE = 38;
const CIPHER_TRANSITION_ROW_TEXT_SIZE = 24;
const CIPHER_TRANSITION_TIMER_TEXT_SIZE = 30;
const CIPHER_TRANSITION_PANEL_COLOR = mod.CreateVector(0.0314, 0.0431, 0.0431);
const CIPHER_TRANSITION_ACCENT_COLOR = mod.CreateVector(0.4392, 0.9216, 1);

function getCipherTransitionRootWidgetName(playerId: number): string {
  return CIPHER_TRANSITION_ROOT_WIDGET_NAME_PREFIX + playerId;
}

function getCipherTransitionPanelWidgetName(playerId: number): string {
  return CIPHER_TRANSITION_PANEL_WIDGET_NAME_PREFIX + playerId;
}

function getCipherTransitionTitleWidgetName(playerId: number): string {
  return CIPHER_TRANSITION_TITLE_WIDGET_NAME_PREFIX + playerId;
}

function getCipherTransitionSubtitleWidgetName(playerId: number): string {
  return CIPHER_TRANSITION_SUBTITLE_WIDGET_NAME_PREFIX + playerId;
}

function getCipherTransitionProgressWidgetName(playerId: number): string {
  return CIPHER_TRANSITION_PROGRESS_WIDGET_NAME_PREFIX + playerId;
}

function getCipherTransitionTimerWidgetName(playerId: number): string {
  return CIPHER_TRANSITION_TIMER_WIDGET_NAME_PREFIX + playerId;
}

function resetCipherTransitionHudRefsForPlayer(p: Player): void {
  p.cipherTransitionRootWidget = null as any;
  p.cipherTransitionPanelWidget = null as any;
  p.cipherTransitionTitleWidget = null as any;
  p.cipherTransitionSubtitleWidget = null as any;
  p.cipherTransitionProgressWidget = null as any;
  p.cipherTransitionTimerWidget = null as any;
}

function deleteCipherTransitionHudForPlayer(playerId: number): void {
  safeDeleteAllWidgetsByName(getCipherTransitionTimerWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherTransitionProgressWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherTransitionSubtitleWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherTransitionTitleWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherTransitionPanelWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherTransitionRootWidgetName(playerId));
}

function bindCipherTransitionHudRefsForPlayer(p: Player): void {
  const playerId = p.id;
  p.cipherTransitionRootWidget = mod.FindUIWidgetWithName(getCipherTransitionRootWidgetName(playerId));
  p.cipherTransitionPanelWidget = mod.FindUIWidgetWithName(getCipherTransitionPanelWidgetName(playerId));
  p.cipherTransitionTitleWidget = mod.FindUIWidgetWithName(getCipherTransitionTitleWidgetName(playerId));
  p.cipherTransitionSubtitleWidget = mod.FindUIWidgetWithName(getCipherTransitionSubtitleWidgetName(playerId));
  p.cipherTransitionProgressWidget = mod.FindUIWidgetWithName(getCipherTransitionProgressWidgetName(playerId));
  p.cipherTransitionTimerWidget = mod.FindUIWidgetWithName(getCipherTransitionTimerWidgetName(playerId));
}

function setCipherTransitionHudDepthForPlayer(p: Player): void {
  const widgets = [
    p.cipherTransitionRootWidget,
    p.cipherTransitionPanelWidget,
    p.cipherTransitionTitleWidget,
    p.cipherTransitionSubtitleWidget,
    p.cipherTransitionProgressWidget,
    p.cipherTransitionTimerWidget,
  ];
  for (let i = 0; i < widgets.length; i++) {
    if (widgets[i]) mod.SetUIWidgetDepth(widgets[i], mod.UIDepth.AboveGameUI);
  }
}

function rebuildCipherTransitionHudForPlayer(p: Player): void {
  const playerId = p.id;
  deleteCipherTransitionHudForPlayer(playerId);
  resetCipherTransitionHudRefsForPlayer(p);

  const uiRoot = mod.GetUIRoot();
  if (!uiRoot) return;

  mod.AddUIContainer(
    getCipherTransitionRootWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    CIPHER_TRANSITION_ROOT_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    p.player
  );

  const root = mod.FindUIWidgetWithName(getCipherTransitionRootWidgetName(playerId));
  if (!root) return;

  mod.AddUIContainer(
    getCipherTransitionPanelWidgetName(playerId),
    CIPHER_TRANSITION_PANEL_POS,
    CIPHER_TRANSITION_PANEL_SIZE,
    mod.UIAnchor.Center,
    root,
    true,
    0,
    CIPHER_TRANSITION_PANEL_COLOR,
    0.78,
    mod.UIBgFill.Blur,
    p.player
  );

  const panel = mod.FindUIWidgetWithName(getCipherTransitionPanelWidgetName(playerId));
  if (!panel) return;

  mod.AddUIText(
    getCipherTransitionTitleWidgetName(playerId),
    CIPHER_TRANSITION_TITLE_POS,
    CIPHER_TRANSITION_TITLE_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_TRANSITION_TITLE_TEXT_SIZE,
    CIPHER_TRANSITION_ACCENT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getCipherTransitionSubtitleWidgetName(playerId),
    CIPHER_TRANSITION_SUBTITLE_POS,
    CIPHER_TRANSITION_ROW_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_TRANSITION_ROW_TEXT_SIZE,
    BOMB_NOTICE_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getCipherTransitionProgressWidgetName(playerId),
    CIPHER_TRANSITION_PROGRESS_POS,
    CIPHER_TRANSITION_ROW_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_TRANSITION_ROW_TEXT_SIZE,
    BOMB_NOTICE_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getCipherTransitionTimerWidgetName(playerId),
    CIPHER_TRANSITION_TIMER_POS,
    CIPHER_TRANSITION_ROW_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_TRANSITION_TIMER_TEXT_SIZE,
    CIPHER_TRANSITION_ACCENT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  bindCipherTransitionHudRefsForPlayer(p);
  setCipherTransitionHudDepthForPlayer(p);
}

function ensureCipherTransitionHudForPlayer(p: Player): boolean {
  if (
    p.cipherTransitionRootWidget &&
    p.cipherTransitionPanelWidget &&
    p.cipherTransitionTitleWidget &&
    p.cipherTransitionSubtitleWidget &&
    p.cipherTransitionProgressWidget &&
    p.cipherTransitionTimerWidget
  ) {
    return true;
  }

  bindCipherTransitionHudRefsForPlayer(p);
  if (
    p.cipherTransitionRootWidget &&
    p.cipherTransitionPanelWidget &&
    p.cipherTransitionTitleWidget &&
    p.cipherTransitionSubtitleWidget &&
    p.cipherTransitionProgressWidget &&
    p.cipherTransitionTimerWidget
  ) {
    setCipherTransitionHudDepthForPlayer(p);
    return true;
  }

  rebuildCipherTransitionHudForPlayer(p);
  return !!(
    p.cipherTransitionRootWidget &&
    p.cipherTransitionPanelWidget &&
    p.cipherTransitionTitleWidget &&
    p.cipherTransitionSubtitleWidget &&
    p.cipherTransitionProgressWidget &&
    p.cipherTransitionTimerWidget
  );
}

function setCipherTransitionHudVisibleForPlayer(p: Player, visible: boolean): void {
  if (!ensureCipherTransitionHudForPlayer(p)) return;
  SafeSetWidgetVisibleHandle(p.cipherTransitionRootWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherTransitionPanelWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherTransitionTitleWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherTransitionSubtitleWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherTransitionProgressWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherTransitionTimerWidget, visible);
}

function getCipherDeployCounts(): { ready: number; required: number } {
  let required = 0;
  let ready = 0;

  for (const playerIdKey in cipherSecondHalfDeployRequiredByPlayerId) {
    const playerId = Number(playerIdKey);
    const sp = serverPlayers.get(playerId);
    if (!sp || !isRequiredSecondHalfDeployPlayer(sp)) {
      delete cipherSecondHalfDeployRequiredByPlayerId[playerId];
      delete cipherSecondHalfDeployReadyByPlayerId[playerId];
      continue;
    }

    required += 1;
    if (cipherSecondHalfDeployReadyByPlayerId[playerId] === true && sp.isDeployed) {
      ready += 1;
    }
  }

  return { ready, required };
}

function isCipherLiveTransitionActive(): boolean {
  return (
    gameStatus === 3 &&
    (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) &&
    cipherSecondHalfTransitionStage !== "none"
  );
}

function setCipherTransitionCountdownSeconds(secondsRemaining: number): void {
  cipherTransitionCountdownSeconds = mod.Max(0, mod.Ceiling(secondsRemaining));
  countDown = cipherTransitionCountdownSeconds;
  SetUITime(getCurrentSchedulerNowSeconds());
}

function refreshCipherTransitionHudForCurrentState(): void {
  if (!isCipherLiveTransitionActive()) return;
  const countdownStage = cipherSecondHalfTransitionStage === "countdown";
  showCipherTransitionHudForAllPlayers(
    countdownStage ? cipherTransitionStartsTitleKey : cipherTransitionDeployTitleKey,
    countdownStage ? cipherTransitionStartsTitleFallback : cipherTransitionDeployTitleFallback,
    cipherTransitionSubtitleFallback,
    countdownStage ? "STARTS IN" : "FORCE DEPLOY IN",
    cipherTransitionCountdownSeconds
  );
}

function showCipherTransitionHudForAllPlayers(
  titleKey: any,
  titleFallback: string,
  subtitleFallback: string,
  timerPrefix: string,
  secondsRemaining: number
): void {
  const title = getStringMessageWithFallback(titleKey, titleFallback);
  const counts = getCipherDeployCounts();
  const progressLabel = mod.Message("DEPLOYED {}/{}", counts.ready, counts.required);
  const timerLabel = mod.Message("{} {}", timerPrefix, secondsRemaining);
  const subtitleLabel = mod.Message(subtitleFallback);

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!ensureCipherTransitionHudForPlayer(p)) return;
    SafeSetTextLabelHandle(p.cipherTransitionTitleWidget, title);
    SafeSetTextLabelHandle(p.cipherTransitionSubtitleWidget, subtitleLabel);
    SafeSetTextLabelHandle(p.cipherTransitionProgressWidget, progressLabel);
    SafeSetTextLabelHandle(p.cipherTransitionTimerWidget, timerLabel);
    setCipherTransitionHudVisibleForPlayer(p, true);
  });
}

function hideCipherTransitionHudForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!p.cipherTransitionRootWidget) {
      bindCipherTransitionHudRefsForPlayer(p);
    }
    if (!p.cipherTransitionRootWidget) return;
    setCipherTransitionHudVisibleForPlayer(p, false);
  });
}

async function runCipherPhaseCountdown(
  messageKey: any,
  fallbackText: string,
  durationSeconds: number,
  source: string
): Promise<void> {
  for (let remaining = durationSeconds; remaining > 0; remaining--) {
    countDown = remaining;
    setCipherPhaseCountdownOverlay(messageKey, fallbackText, remaining);
    processTransitionSpawnQueue(source);
    processCipherSpawnJobs(source);
    playCountdownHeartbeatToAll(remaining <= 3 ? 0.85 : 0.6);
    await mod.Wait(1);
  }

  countDown = 0;
  setCipherPhaseCountdownOverlay(messageKey, fallbackText, 0);
  processTransitionSpawnQueue(source);
  processCipherSpawnJobs(source);
}

const CIPHER_SECOND_HALF_FREEZE_INPUTS: mod.RestrictedInputs[] = [
  mod.RestrictedInputs.CameraPitch,
  mod.RestrictedInputs.CameraYaw,
  mod.RestrictedInputs.Crouch,
  mod.RestrictedInputs.CycleFire,
  mod.RestrictedInputs.CyclePrimary,
  mod.RestrictedInputs.FireWeapon,
  mod.RestrictedInputs.Interact,
  mod.RestrictedInputs.Jump,
  mod.RestrictedInputs.MoveForwardBack,
  mod.RestrictedInputs.MoveLeftRight,
  mod.RestrictedInputs.Prone,
  mod.RestrictedInputs.Reload,
  mod.RestrictedInputs.SelectCharacterGadget,
  mod.RestrictedInputs.SelectMelee,
  mod.RestrictedInputs.SelectOpenGadget,
  mod.RestrictedInputs.SelectPrimary,
  mod.RestrictedInputs.SelectSecondary,
  mod.RestrictedInputs.SelectThrowable,
  mod.RestrictedInputs.Sprint,
  mod.RestrictedInputs.Zoom,
];

function isRequiredSecondHalfDeployPlayer(p: Player): boolean {
  if (!p || !mod.IsPlayerValid(p.player)) return false;
  const team = mod.GetTeam(p.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;
  if (isBotBackfillPlayer(p.player)) return false;
  return true;
}

function resetCipherSecondHalfDeployTracking(): void {
  cipherSecondHalfDeployRequiredByPlayerId = {};
  cipherSecondHalfDeployReadyByPlayerId = {};
  cipherTransitionTeleportedByPlayerId = {};
  cipherTransitionCountdownSeconds = 0;
  cipherTransitionDeployTitleKey = undefined;
  cipherTransitionDeployTitleFallback = "";
  cipherTransitionStartsTitleKey = undefined;
  cipherTransitionStartsTitleFallback = "";
  cipherTransitionSubtitleFallback = "";
}

function setCipherSecondHalfDeployFreezeForPlayer(
  player: mod.Player,
  frozen: boolean,
  _source: string
): void {
  if (!mod.IsPlayerValid(player)) return;
  const playerId = modlib.getPlayerId(player);

  if (!frozen) {
    delete cipherSecondHalfFrozenByPlayerId[playerId];
    mod.SetPlayerMovementSpeedMultiplier(player, 1);
    mod.EnableAllInputRestrictions(player, false);
    return;
  }

  cipherSecondHalfFrozenByPlayerId[playerId] = true;
  mod.SetPlayerMovementSpeedMultiplier(player, 0);
  for (let i = 0; i < CIPHER_SECOND_HALF_FREEZE_INPUTS.length; i++) {
    mod.EnableInputRestriction(player, CIPHER_SECOND_HALF_FREEZE_INPUTS[i], true);
  }
}

function clearCipherSecondHalfDeployFreezeForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    setCipherSecondHalfDeployFreezeForPlayer(p.player, false, "clear_second_half_freeze");
  });
  cipherSecondHalfFrozenByPlayerId = {};
}

function applyCipherSecondHalfDeployFreezeForReadyPlayers(source: string): void {
  if (cipherSecondHalfTransitionStage !== "deploy" && cipherSecondHalfTransitionStage !== "countdown") return;
  serverPlayers.forEach((p) => {
    if (!p || !p.isDeployed || !mod.IsPlayerValid(p.player)) return;
    if (cipherSecondHalfDeployReadyByPlayerId[p.id] !== true && cipherSecondHalfTransitionStage !== "countdown") return;
    setCipherSecondHalfDeployFreezeForPlayer(p.player, true, source);
  });
}

function markCipherSecondHalfDeployRequiredPlayers(): void {
  resetCipherSecondHalfDeployTracking();
  serverPlayers.forEach((p) => {
    if (!isRequiredSecondHalfDeployPlayer(p)) return;
    cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;
  });
}

function markCipherSecondHalfDeployRequiredForPlayer(p: Player): void {
  if (cipherSecondHalfTransitionStage !== "deploy" && cipherSecondHalfTransitionStage !== "countdown") return;
  if (!isRequiredSecondHalfDeployPlayer(p)) return;
  cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;
}

function markCipherSecondHalfDeployReadyForPlayer(playerId: number, player: mod.Player): void {
  if (cipherSecondHalfTransitionStage !== "deploy" && cipherSecondHalfTransitionStage !== "countdown") return;
  const sp = serverPlayers.get(playerId);
  if (!sp) return;
  markCipherSecondHalfDeployRequiredForPlayer(sp);
  cipherSecondHalfDeployReadyByPlayerId[playerId] = true;
  setCipherSecondHalfDeployFreezeForPlayer(player, true, "second_half_deploy_ready");
  refreshCipherTransitionHudForCurrentState();
}

function clearCipherSecondHalfDeployReadyForPlayer(playerId: number): void {
  delete cipherSecondHalfDeployReadyByPlayerId[playerId];
}

function hasAllRequiredCipherSecondHalfDeployersReady(): boolean {
  const counts = getCipherDeployCounts();
  return counts.required <= 0 || counts.ready >= counts.required;
}

function requestForceDeployForMissingCipherSecondHalfPlayers(source: string): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (cipherSecondHalfDeployReadyByPlayerId[p.id] === true) return;
    if (p.isDeployed) {
      handleCipherTransitionDeployedPlayer(p.id, p.player, source + "_already_deployed");
      return;
    }
    mod.SetRedeployTime(p.player, 0);
    requestTransitionSpawn(p.id, source);
  });
}

function handleCipherTransitionDeployedPlayer(playerId: number, player: mod.Player, source: string): boolean {
  if (!isCipherLiveTransitionActive()) return false;
  if (!mod.IsPlayerValid(player) || !isPlayerAliveSafe(player)) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp) return false;
  sp.team = mod.GetTeam(player);
  sp.isDeployed = true;
  mod.SetRedeployTime(player, 0);
  applyPrematch889HealthForPlayer(playerId);
  applyPhaseInputRestrictionsForPlayer(player);

  if (cipherTransitionTeleportedByPlayerId[playerId] !== true) {
    if (getCipherQueuedSpawnAnchorForPlayer(playerId) === undefined) {
      prepareCipherQueuedAnchorForPlayer(playerId);
    }
    const teleported = teleportCipherPlayerToRoutedAnchor(player, playerId);
    if (teleported && bombCarrierPlayerId === playerId) {
      syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "transition_deploy_teleport");
    }
    if (!teleported) {
      requestCipherSpawnAnchorForPlayer(playerId, true);
      requestCipherSpawnTeleportForPlayer(playerId, true);
      void source;
      return false;
    }
  }

  clearTransitionSpawnStateForPlayer(playerId);
  markCipherSecondHalfDeployReadyForPlayer(playerId, player);
  refreshCipherKeyPlayerSnapshots("handleCipherTransitionDeployedPlayer");
  return true;
}

async function settleForcedCipherSecondHalfDeploys(source: string): Promise<void> {
  const settleEndAtSec = getCurrentSchedulerNowSeconds() + CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS;
  while (gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive)) {
    requestForceDeployForMissingCipherSecondHalfPlayers(source);
    processTransitionSpawnQueue(source);
    processCipherSpawnJobs(source);
    applyCipherSecondHalfDeployFreezeForReadyPlayers(source);
    if (hasAllRequiredCipherSecondHalfDeployersReady()) return;
    if (getCurrentSchedulerNowSeconds() >= settleEndAtSec) return;
    await mod.Wait(0.2);
  }
}

async function runCipherTransitionDeployWindow(
  source: string,
  deployTitleKey: any,
  deployTitleFallback: string,
  startsTitleKey: any,
  startsTitleFallback: string,
  subtitleFallback: string
): Promise<void> {
  markCipherSecondHalfDeployRequiredPlayers();
  cipherTransitionDeployTitleKey = deployTitleKey;
  cipherTransitionDeployTitleFallback = deployTitleFallback;
  cipherTransitionStartsTitleKey = startsTitleKey;
  cipherTransitionStartsTitleFallback = startsTitleFallback;
  cipherTransitionSubtitleFallback = subtitleFallback;
  SetCountdownOverlayVisible(false);

  for (
    let remaining = CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS;
    remaining > CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS;
    remaining--
  ) {
    if (
      gameStatus !== 3 ||
      !(cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) ||
      cipherSecondHalfTransitionStage !== "deploy"
    ) return;
    setCipherTransitionCountdownSeconds(remaining);
    showCipherTransitionHudForAllPlayers(
      deployTitleKey,
      deployTitleFallback,
      subtitleFallback,
      "FORCE DEPLOY IN",
      remaining
    );
    processTransitionSpawnQueue(source);
    processCipherSpawnJobs(source);
    applyCipherSecondHalfDeployFreezeForReadyPlayers(source);

    if (hasAllRequiredCipherSecondHalfDeployersReady()) break;

    await mod.Wait(1);
  }

  if (
    gameStatus !== 3 ||
    !(cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) ||
    cipherSecondHalfTransitionStage !== "deploy"
  ) return;

  cipherSecondHalfTransitionStage = "countdown";
  setCipherTransitionCountdownSeconds(CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS);
  requestForceDeployForMissingCipherSecondHalfPlayers(source + "_force_deploy");

  for (let remaining = CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS; remaining > 0; remaining--) {
    if (
      gameStatus !== 3 ||
      !(cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) ||
      cipherSecondHalfTransitionStage !== "countdown"
    ) return;

    setCipherTransitionCountdownSeconds(remaining);
    requestForceDeployForMissingCipherSecondHalfPlayers(source + "_final_countdown");
    processTransitionSpawnQueue(source + "_final_countdown");
    processCipherSpawnJobs(source + "_final_countdown");
    applyCipherSecondHalfDeployFreezeForReadyPlayers(source + "_final_countdown");
    showCipherTransitionHudForAllPlayers(
      startsTitleKey,
      startsTitleFallback,
      subtitleFallback,
      "STARTS IN",
      remaining
    );
    playCountdownHeartbeatToAll(remaining <= 3 ? 0.85 : 0.6);
    await mod.Wait(1);
  }

  setCipherTransitionCountdownSeconds(0);
  requestForceDeployForMissingCipherSecondHalfPlayers(source + "_zero");
  processTransitionSpawnQueue(source + "_zero");
  processCipherSpawnJobs(source + "_zero");
  applyCipherSecondHalfDeployFreezeForReadyPlayers(source + "_zero");
}

function prepareCipherHalfForLive(
  half: CipherHalfIndex,
  context: string,
  redeploySeconds: number = REDEPLOY_TIME
): void {
  cipherCurrentHalf = half;
  cipherMatchStage = half === 1 ? "half1" : "half2";
  cipherHalfScores = [0, 0];
  resetCipherSuddenDeathState();
  resetCipherObjectivesForCurrentStage(context);
  ConfigureLiveSpawns();
  serverPlayers.forEach((p) => {
    mod.SetRedeployTime(p.player, redeploySeconds);
    p.setCapturePoint(null);
    UpdateTopFlagColorsForPlayer(p);
  });
}

function startCipherHalfClockAndKey(half: CipherHalfIndex, nowSec?: number): void {
  beginScriptOwnedLiveClockPhase(ROUND_TIME, nowSec, half === 2);
  spawnBombPickupObjectAtLiveStart();
}

function beginCipherHalf(half: CipherHalfIndex, nowSec?: number): void {
  prepareCipherHalfForLive(half, "beginCipherHalf" + String(half));
  startCipherHalfClockAndKey(half, nowSec);
}

async function runCipherSecondHalfTransition(reason: CipherHalfTransitionReason): Promise<void> {
  const reasonKey =
    reason === "timeExpired"
      ? (mod.stringkeys as any).CipherHalftimeTimeExpired
      : (mod.stringkeys as any).CipherHalftimeScoreCap;
  const reasonFallback = reason === "timeExpired" ? "HALFTIME - TIME EXPIRED" : "HALFTIME - OBJECTIVE CAP REACHED";

  cipherSecondHalfTransitionActive = true;
  cipherSecondHalfTransitionStage = "deploy";
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;
  resetTransitionSpawnQueueState(false);
  HideAllObjectiveHoldProgressUi();
  HideAllDeployObjectiveTimerUi();
  clearBombNoticeState();
  showCipherPhaseNoticeForAllPlayers(reasonKey, reasonFallback, 4);

  prepareCipherHalfForLive(2, "runCipherSecondHalfTransition", 0);
  cipherPhaseTransitionUndeployIgnoreUntilSec =
    getCurrentSchedulerNowSeconds() +
    CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS +
    CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS +
    CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS +
    2;
  mod.SetSpawnMode(mod.SpawnModes.Deploy);
  serverPlayers.forEach((p) => {
    mod.SetRedeployTime(p.player, 0);
    p.setCapturePoint(null);
    clearCipherSecondHalfDeployReadyForPlayer(p.id);
  });
  mod.UndeployAllPlayers();

  await runCipherTransitionDeployWindow(
    "second_half_deploy_window_" + reason,
    (mod.stringkeys as any).CipherSwitchingSides,
    "SWITCHING SIDES",
    (mod.stringkeys as any).CipherSecondHalfStarts,
    "SECOND HALF STARTS IN",
    "DEPLOY TO START NEXT HALF"
  );

  if (gameStatus !== 3) {
    clearCipherSecondHalfDeployFreezeForAllPlayers();
    hideCipherTransitionHudForAllPlayers();
    cipherSecondHalfTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
    resetCipherSecondHalfDeployTracking();
    return;
  }
  SetCountdownOverlayVisible(false);
  hideCipherTransitionHudForAllPlayers();
  clearCipherSecondHalfDeployFreezeForAllPlayers();
  cipherSecondHalfTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  resetCipherSecondHalfDeployTracking();
  serverPlayers.forEach((p) => {
    mod.SetRedeployTime(p.player, REDEPLOY_TIME);
    setReadyPhaseProtectionForPlayer(p.player, false);
  });
  showCipherPhaseNoticeForAllPlayers((mod.stringkeys as any).CipherSecondHalfLive, "SECOND HALF", 3);
  startCipherHalfClockAndKey(2, getCurrentSchedulerNowSeconds());
}

function beginCipherSecondHalf(
  _nowSec?: number,
  reason: CipherHalfTransitionReason = "scoreCap"
): void {
  if (cipherSecondHalfTransitionActive) return;
  void runCipherSecondHalfTransition(reason);
}

function prepareCipherSuddenDeathForLive(context: string): void {
  cipherCurrentHalf = 2;
  cipherMatchStage = "suddenDeath";
  cipherHalfScores = [0, 0];
  resetCipherSuddenDeathState();
  resetCipherObjectivesForCurrentStage(context);
  ConfigureLiveSpawns();
  serverPlayers.forEach((p) => {
    cipherSuddenDeathEliminatedByPlayerId[p.id] = false;
    mod.SetRedeployTime(p.player, 0);
  });
}

async function runCipherSuddenDeathTransition(): Promise<void> {
  cipherSuddenDeathTransitionActive = true;
  cipherSecondHalfTransitionStage = "deploy";
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;
  resetTransitionSpawnQueueState(false);
  HideAllObjectiveHoldProgressUi();
  HideAllDeployObjectiveTimerUi();
  clearBombNoticeState();
  showCipherPhaseNoticeForAllPlayers((mod.stringkeys as any).CipherSuddenDeathOneLife, "SUDDEN DEATH - ONE LIFE", 5);
  prepareCipherSuddenDeathForLive("runCipherSuddenDeathTransition");
  cipherSuddenDeathUndeployIgnoreUntilSec =
    getCurrentSchedulerNowSeconds() +
    CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS +
    CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS +
    CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS +
    2;
  cipherPhaseTransitionUndeployIgnoreUntilSec = cipherSuddenDeathUndeployIgnoreUntilSec;
  mod.SetSpawnMode(mod.SpawnModes.Deploy);
  serverPlayers.forEach((p) => {
    mod.SetRedeployTime(p.player, 0);
    p.setCapturePoint(null);
    clearCipherSecondHalfDeployReadyForPlayer(p.id);
  });
  mod.UndeployAllPlayers();

  await runCipherTransitionDeployWindow(
    "sudden_death_transition",
    (mod.stringkeys as any).CipherSuddenDeathOneLife,
    "SUDDEN DEATH",
    (mod.stringkeys as any).CipherSuddenDeathStarts,
    "SUDDEN DEATH STARTS IN",
    "NO RESPAWNS"
  );

  if (gameStatus !== 3) {
    clearCipherSecondHalfDeployFreezeForAllPlayers();
    hideCipherTransitionHudForAllPlayers();
    cipherSuddenDeathTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    cipherSuddenDeathUndeployIgnoreUntilSec = 0;
    cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
    resetCipherSecondHalfDeployTracking();
    return;
  }
  SetCountdownOverlayVisible(false);
  hideCipherTransitionHudForAllPlayers();
  clearCipherSecondHalfDeployFreezeForAllPlayers();
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cipherSuddenDeathUndeployIgnoreUntilSec = 0;
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  resetCipherSecondHalfDeployTracking();
  serverPlayers.forEach((p) => {
    mod.SetRedeployTime(p.player, 0);
    setReadyPhaseProtectionForPlayer(p.player, false);
  });
  beginOvertimeClock(getCurrentSchedulerNowSeconds());
  spawnBombPickupObjectAtLiveStart();
}

function beginCipherSuddenDeath(_nowSec?: number): void {
  if (cipherSuddenDeathTransitionActive) return;
  void runCipherSuddenDeathTransition();
}

function getCipherTeamTotalScore(team: mod.Team): number {
  const idx = getCipherTeamScoreIndex(team);
  if (idx < 0) return 0;
  return serverScores[idx] ?? 0;
}

function resolveSecondHalfTimeoutWinner(): mod.Team {
  const t1 = getCipherTeamTotalScore(team1);
  const t2 = getCipherTeamTotalScore(team2);
  if (t1 > t2) return team1;
  if (t2 > t1) return team2;
  return teamNeutral;
}

function enterPostmatchFromLive(forcedWinner?: mod.Team): void {
  if (gameStatus === 4) return;
  cipherPendingScoreTransitionTeam = teamNeutral;
  postmatchWinnerTeam = forcedWinner !== undefined ? forcedWinner : resolveWinningTeamFromScores();
  gameStatus = 4;
  liveTimerIntroActive = false;
  liveTimerIntroEndsAtSec = 0;
  liveClockTimeoutHoldActive = false;
  HideAllObjectiveHoldProgressUi();
  HideAllDeployObjectiveTimerUi();
  resetLiveTimerWidgetPresentation();
  const live = mod.FindUIWidgetWithName("LiveContainer");
  if (live) mod.SetUIWidgetVisible(live, false);
  setLiveScorePanelVisible(false);
}

function evaluateCipherMatchProgressAfterScore(scoringTeam: mod.Team): void {
  if (gameStatus !== 3) return;
  if (mod.Equals(scoringTeam, teamNeutral)) return;

  if (cipherMatchStage === "suddenDeath") {
    finalizePendingObjectiveAwardsForImmediateTransition("sudden_death_score");
    enterPostmatchFromLive(scoringTeam);
    return;
  }

  if (getCipherTeamTotalScore(scoringTeam) >= WIN_SCORE) {
    finalizePendingObjectiveAwardsForImmediateTransition("match_score_cap");
    enterPostmatchFromLive(scoringTeam);
    return;
  }

  const scoreIndex = getCipherTeamScoreIndex(scoringTeam);
  if (scoreIndex < 0) return;

  if (cipherHalfScores[scoreIndex] >= HALF_SCORE_CAP) {
    finalizePendingObjectiveAwardsForImmediateTransition("half_score_cap");
    if (cipherMatchStage === "half1") {
      beginCipherSecondHalf(getCurrentSchedulerNowSeconds(), "scoreCap");
      return;
    }

    const winner = resolveWinningTeamFromScores();
    if (mod.Equals(winner, teamNeutral)) {
      beginCipherSuddenDeath(getCurrentSchedulerNowSeconds());
      return;
    }
    enterPostmatchFromLive(winner);
  }
}

function resolvePendingCipherScoreTransitionIfReady(): void {
  if (gameStatus !== 3) return;
  if (mod.Equals(cipherPendingScoreTransitionTeam, teamNeutral)) return;
  if (getAllObjectivePendingAwardActive()) return;

  const scoringTeam = cipherPendingScoreTransitionTeam;
  cipherPendingScoreTransitionTeam = teamNeutral;
  evaluateCipherMatchProgressAfterScore(scoringTeam);
}

function isCipherSuddenDeathActive(): boolean {
  return gameStatus === 3 && cipherMatchStage === "suddenDeath";
}

function countCipherSuddenDeathLivesRemaining(team: mod.Team): number {
  let count = 0;
  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    if (!mod.Equals(mod.GetTeam(sp.player), team)) return;
    if (cipherSuddenDeathEliminatedByPlayerId[sp.id] === true) return;
    count += 1;
  });
  return count;
}

function resolveCipherSuddenDeathEliminationWinner(): mod.Team {
  const team1Alive = countCipherSuddenDeathLivesRemaining(team1);
  const team2Alive = countCipherSuddenDeathLivesRemaining(team2);
  if (team1Alive <= 0 && team2Alive > 0) return team2;
  if (team2Alive <= 0 && team1Alive > 0) return team1;
  return teamNeutral;
}

function consumeCipherSuddenDeathLife(playerId: number): void {
  if (!isCipherSuddenDeathActive()) return;
  if (cipherSuddenDeathEliminatedByPlayerId[playerId] === true) return;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;
  const team = mod.GetTeam(sp.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

  cipherSuddenDeathEliminatedByPlayerId[playerId] = true;
  mod.SetRedeployTime(sp.player, 9999);

  const winner = resolveCipherSuddenDeathEliminationWinner();
  if (!mod.Equals(winner, teamNeutral)) {
    enterPostmatchFromLive(winner);
  }
}

function resolveLiveTimeoutIfNeeded(nowSec: number): void {
  if (gameStatus !== 3) return;
  if (!liveClockStarted) return;
  if (!Number.isFinite(liveClockDeadlineAtSec) || liveClockDeadlineAtSec <= 0) return;

  const timeoutReached = nowSec >= liveClockDeadlineAtSec;
  if (!timeoutReached && !liveClockTimeoutHoldActive) return;

  if (getAllObjectivePendingAwardActive()) {
    liveClockTimeoutHoldActive = true;
    return;
  }

  liveClockTimeoutHoldActive = false;

  if (cipherMatchStage === "half1") {
    beginCipherSecondHalf(nowSec, "timeExpired");
    return;
  }

  if (cipherMatchStage === "half2") {
    const winner = resolveSecondHalfTimeoutWinner();
    if (!mod.Equals(winner, teamNeutral)) {
      enterPostmatchFromLive(winner);
      return;
    }

    beginCipherSuddenDeath(nowSec);
    return;
  }

  if (cipherMatchStage === "suddenDeath") {
    const winner = resolveSecondHalfTimeoutWinner();
    enterPostmatchFromLive(winner);
    return;
  }

  const team1Score = serverScores[0];
  const team2Score = serverScores[1];

  if (team1Score > team2Score) {
    enterPostmatchFromLive();
    return;
  }
  if (team2Score > team1Score) {
    enterPostmatchFromLive();
    return;
  }

  if (!liveClockOvertimeActive && !liveClockOvertimeConsumed && team1Score === 0 && team2Score === 0) {
    beginOvertimeClock(nowSec);
    return;
  }

  enterPostmatchFromLive();
}

function SafeSetWidgetVisibleByName(name: string, visible: boolean): void {
  const w = SafeFindWidget(name);
  if (!w) return;
  try {
    mod.SetUIWidgetVisible(w, visible);
  } catch (_err) {}
}

function SafeEnableWorldIconById(iconId: number, enabledImage: boolean, enabledText: boolean): void {
  try {
    const icon = mod.GetWorldIcon(iconId);
    mod.EnableWorldIconImage(icon, enabledImage);
    mod.EnableWorldIconText(icon, enabledText);
  } catch (_err) {}
}

function SafeEnableInteractPointById(interactId: number, enabled: boolean): void {
  try {
    mod.EnableInteractPoint(mod.GetInteractPoint(interactId), enabled);
  } catch (_err) {}
}

function SafeSetWorldIconTextById(iconId: number, textLabel: any): void {
  try {
    mod.SetWorldIconText(mod.GetWorldIcon(iconId), textLabel);
  } catch (_err) {}
}


function SetUITime(nowSec?: number): void {
  const timeWidget = mod.FindUIWidgetWithName("RemainingTime");
  const introValueWidget = mod.FindUIWidgetWithName("LiveTimerIntroValue");
  if (!timeWidget && !introValueWidget) return;

  const resolvedNow = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();

  if (isCipherLiveTransitionActive()) {
    const displaySeconds = mod.Max(0, mod.Ceiling(cipherTransitionCountdownSeconds));
    const displayLabel = formatUiTimerLabel(displaySeconds);
    SafeSetWidgetVisibleByName("LiveTimerIntroContainer", false);
    SafeSetWidgetVisibleByName("matchtime", true);
    if (timeWidget) mod.SetUITextLabel(timeWidget, displayLabel);
    if (introValueWidget) mod.SetUITextLabel(introValueWidget, displayLabel);
    return;
  }

  updateLiveTimerIntroState(resolvedNow);

  if (!liveClockStarted) {
    if (timeWidget) mod.SetUITextLabel(timeWidget, mod.Message(mod.stringkeys.TimeDefault));
    if (introValueWidget) mod.SetUITextLabel(introValueWidget, mod.Message(mod.stringkeys.TimeDefault));
    return;
  }

  const remainingTime = getLiveClockRemainingSeconds(resolvedNow);
  const displaySeconds = remainingTime !== undefined ? mod.Max(0, mod.Ceiling(remainingTime)) : 0;
  const displayLabel = formatUiTimerLabel(displaySeconds);

  if (timeWidget) {
    mod.SetUITextLabel(timeWidget, displayLabel);
  }
  if (introValueWidget) {
    mod.SetUITextLabel(introValueWidget, formatUiTimerLabel(liveTimerIntroDisplaySeconds));
  }
}



function getFriendlyScore(team: mod.Team): number {
  return mod.Equals(team, team1) ? mod.Ceiling(serverScores[0]) : mod.Ceiling(serverScores[1]);
}

function getOpponentScore(team: mod.Team): number {
  return mod.Equals(team, team1) ? mod.Ceiling(serverScores[1]) : mod.Ceiling(serverScores[0]);
}

function formatTwoDigitScore(score: number): string {
  let safe = score;
  if (!Number.isFinite(safe)) safe = 0;
  safe = mod.Floor(safe);
  if (safe < 0) safe = 0;
  if (safe < 10) return "0" + String(safe);
  return String(safe);
}

function SetUIScores(): void {
  serverPlayers.forEach((p) => p.updateTickets());
}

/* =================================================================================================
   7) PLAYER / CAPTURE POINT WRAPPERS
================================================================================================= */
// Reused, per-sync caches to avoid allocations
let _syncStamp = 0; // increments each sync call (stamp technique)
const _seenThisSync: { [playerId: number]: number } = {}; // playerId -> stamp

const _tmpPlayerToCpId: { [playerId: number]: number } = {}; // temporary mapping
const _tmpPlayerToCpIdKeys: number[] = []; // keys set this sync (so we can clear cheaply)

function _tmpPlayerToCpIdSet(playerId: number, cpId: number): void {
  // Only record the key once so we can clear fast later
  if (_tmpPlayerToCpId[playerId] === undefined) {
    _tmpPlayerToCpIdKeys.push(playerId);
  }
  _tmpPlayerToCpId[playerId] = cpId;
}

function _tmpPlayerToCpIdClear(): void {
  for (let i = 0; i < _tmpPlayerToCpIdKeys.length; i++) {
    const id = _tmpPlayerToCpIdKeys[i];
    delete _tmpPlayerToCpId[id];
  }
  _tmpPlayerToCpIdKeys.length = 0;
}


const serverPlayers = new Map<number, Player>();
const disconnectedPlayers: Player[] = [];

let cipherKeyActivePlayerIdsSnapshot: number[] = [];
let cipherKeyPlayerByIdSnapshot: { [playerId: number]: Player | undefined } = {};
let cipherKeyTeamByPlayerIdSnapshot: { [playerId: number]: mod.Team | undefined } = {};
let cipherKeyTeamIdByPlayerIdSnapshot: { [playerId: number]: number | undefined } = {};
let cipherKeyHudReadyByPlayerId: { [playerId: number]: boolean | undefined } = {};
let cipherKeyHudDirtyByPlayerId: { [playerId: number]: boolean | undefined } = {};

function refreshCipherKeyPlayerSnapshots(_context: string = "unknown"): void {
  cipherKeyActivePlayerIdsSnapshot = [];
  cipherKeyPlayerByIdSnapshot = {};
  cipherKeyTeamByPlayerIdSnapshot = {};
  cipherKeyTeamIdByPlayerIdSnapshot = {};

  serverPlayers.forEach((p) => {
    if (!p) return;
    if (!mod.IsPlayerValid(p.player)) return;
    cipherKeyActivePlayerIdsSnapshot.push(p.id);
    cipherKeyPlayerByIdSnapshot[p.id] = p;
    cipherKeyTeamByPlayerIdSnapshot[p.id] = p.team;
    cipherKeyTeamIdByPlayerIdSnapshot[p.id] = modlib.getTeamId(p.team);
  });
}

function getCipherKeyPlayerSnapshot(playerId: number): Player | undefined {
  return cipherKeyPlayerByIdSnapshot[playerId] ?? serverPlayers.get(playerId);
}

function getCipherKeyTeamSnapshot(playerId: number): mod.Team | undefined {
  const cached = cipherKeyTeamByPlayerIdSnapshot[playerId];
  if (cached) return cached;
  const p = getCipherKeyPlayerSnapshot(playerId);
  return p?.team;
}

function markCipherKeyHudDirtyForPlayer(playerId: number): void {
  cipherKeyHudReadyByPlayerId[playerId] = false;
  cipherKeyHudDirtyByPlayerId[playerId] = true;
}

function markCipherKeyHudReadyForPlayer(playerId: number, ready: boolean): void {
  cipherKeyHudReadyByPlayerId[playerId] = ready;
  if (ready) {
    delete cipherKeyHudDirtyByPlayerId[playerId];
  } else {
    cipherKeyHudDirtyByPlayerId[playerId] = true;
  }
}

function clearCipherKeyHudCacheForPlayer(playerId: number): void {
  delete cipherKeyHudReadyByPlayerId[playerId];
  delete cipherKeyHudDirtyByPlayerId[playerId];
}

function getCipherKeyUiPlayerSnapshot(lazyRefresh: boolean = true): Player[] {
  if (lazyRefresh && cipherKeyActivePlayerIdsSnapshot.length <= 0 && serverPlayers.size > 0) {
    refreshCipherKeyPlayerSnapshots("lazy_ui_snapshot");
  }

  const players: Player[] = [];
  for (let i = 0; i < cipherKeyActivePlayerIdsSnapshot.length; i++) {
    const playerId = cipherKeyActivePlayerIdsSnapshot[i];
    const p = cipherKeyPlayerByIdSnapshot[playerId] ?? serverPlayers.get(playerId);
    if (!p) continue;
    players.push(p);
  }
  return players;
}

let playerInDamageZone: { [playerId: number]: boolean } = {};
let prematchHealthInside889ByPlayerId: { [playerId: number]: boolean } = {};
let prematchHealthAppliedMaxByPlayerId: { [playerId: number]: number } = {};

// -------------------------------
// Restricted Area (UI + countdown)
// -------------------------------
let playerInRestrictedArea: { [playerId: number]: boolean } = {};
let restrictedAreaCountdownToken: { [playerId: number]: number } = {};
let restrictedAreaActiveTriggersByPlayerId: { [playerId: number]: { [triggerId: number]: boolean } } = {};
let playerOutsideCombatBoundaryByPlayerId: { [playerId: number]: boolean } = {};
let playerInMandownByPlayerId: { [playerId: number]: boolean } = {};
let restrictedAreaFeedbackSuppressedByPlayerId: { [playerId: number]: boolean } = {};
let restrictedAreaPendingLethalConfirmTokenByPlayerId: { [playerId: number]: number } = {};
let restrictedAreaPendingLethalConfirmTimerByPlayerId: { [playerId: number]: number | undefined } = {};
let objectiveAreaActiveTriggersByPlayerId: { [playerId: number]: { [triggerId: number]: boolean } } = {};
let objectiveAreaLastEnteredTriggerByPlayerId: { [playerId: number]: number | undefined } = {};

let restrictedAreaRootWidgetByPlayerId: { [playerId: number]: mod.UIWidget } = {};
let restrictedAreaCounterWidgetByPlayerId: { [playerId: number]: mod.UIWidget } = {};

function isRestrictedAreaTriggerId(triggerId: number): boolean {
  return RESTRICTED_AREA_TRIGGER_IDS.indexOf(triggerId) >= 0;
}

function isObjectiveAreaTriggerId(triggerId: number): boolean {
  return OBJECTIVE_AREA_TRIGGER_IDS.indexOf(triggerId) >= 0;
}

function isRestrictedTriggerForPlayer(triggerId: number, playerTeam: mod.Team): boolean {
  if (triggerId === RESTRICTED_AREA_TRIGGER) {
    return mod.Equals(playerTeam, team1) || mod.Equals(playerTeam, team2);
  }

  if (triggerId === TEAM1_HQ_PROTECTION_TRIGGER_ID) {
    return mod.Equals(playerTeam, team2);
  }

  if (triggerId === TEAM2_HQ_PROTECTION_TRIGGER_ID) {
    return mod.Equals(playerTeam, team1);
  }

  return false;
}

function markRestrictedTriggerActive(playerId: number, triggerId: number): void {
  if (!isRestrictedAreaTriggerId(triggerId)) return;

  let active = restrictedAreaActiveTriggersByPlayerId[playerId];
  if (!active) {
    active = {};
    restrictedAreaActiveTriggersByPlayerId[playerId] = active;
  }
  active[triggerId] = true;
}

function clearRestrictedTriggerActive(playerId: number, triggerId: number): void {
  const active = restrictedAreaActiveTriggersByPlayerId[playerId];
  if (!active) return;

  delete active[triggerId];

  for (const k in active) {
    if (active[k] === true) return;
  }

  delete restrictedAreaActiveTriggersByPlayerId[playerId];
}

function hasAnyRestrictedTriggerActive(playerId: number): boolean {
  const active = restrictedAreaActiveTriggersByPlayerId[playerId];
  if (!active) return false;

  for (const k in active) {
    if (active[k] === true) return true;
  }

  return false;
}

function clearAllRestrictedTriggerStateForPlayer(playerId: number): void {
  delete restrictedAreaActiveTriggersByPlayerId[playerId];
  delete playerOutsideCombatBoundaryByPlayerId[playerId];
}

function markObjectiveAreaTriggerActive(playerId: number, triggerId: number): void {
  if (!isObjectiveAreaTriggerId(triggerId)) return;

  let active = objectiveAreaActiveTriggersByPlayerId[playerId];
  if (!active) {
    active = {};
    objectiveAreaActiveTriggersByPlayerId[playerId] = active;
  }

  active[triggerId] = true;
  objectiveAreaLastEnteredTriggerByPlayerId[playerId] = triggerId;
}

function clearObjectiveAreaTriggerActive(playerId: number, triggerId: number): void {
  const active = objectiveAreaActiveTriggersByPlayerId[playerId];
  if (!active) return;

  delete active[triggerId];

  let lastActiveTriggerId: number | undefined = undefined;
  for (const k in active) {
    if (active[k] !== true) continue;
    lastActiveTriggerId = Number(k);
    break;
  }

  if (lastActiveTriggerId === undefined) {
    delete objectiveAreaActiveTriggersByPlayerId[playerId];
    delete objectiveAreaLastEnteredTriggerByPlayerId[playerId];
    return;
  }

  if (objectiveAreaLastEnteredTriggerByPlayerId[playerId] === triggerId) {
    objectiveAreaLastEnteredTriggerByPlayerId[playerId] = lastActiveTriggerId;
  }
}

function clearAllObjectiveAreaTriggerStateForPlayer(playerId: number): void {
  delete objectiveAreaActiveTriggersByPlayerId[playerId];
  delete objectiveAreaLastEnteredTriggerByPlayerId[playerId];
}

function hasAnyRestrictedSourceActive(playerId: number): boolean {
  return playerOutsideCombatBoundaryByPlayerId[playerId] === true || hasAnyRestrictedTriggerActive(playerId);
}

function hasRestrictedAreaFeedbackOrSourcesActive(playerId: number): boolean {
  return playerInRestrictedArea[playerId] === true || hasAnyRestrictedSourceActive(playerId);
}

function cancelPendingRestrictedLethalConfirmForPlayer(playerId: number): void {
  restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] =
    (restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] ?? 0) + 1;
  Timers.clearTimeout(restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId]);
  delete restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId];
}

function clearRestrictedAreaFeedbackSuppressionForPlayer(playerId: number): void {
  delete restrictedAreaFeedbackSuppressedByPlayerId[playerId];
}

function canPlayerReceiveRestrictedAreaFeedback(playerId: number): boolean {
  const p = serverPlayers.get(playerId);
  if (!p) return false;
  if (!p.isDeployed) return false;
  if (playerInMandownByPlayerId[playerId] === true) return false;
  if (restrictedAreaFeedbackSuppressedByPlayerId[playerId] === true) return false;
  if (!mod.IsPlayerValid(p.player)) return false;
  return isPlayerAliveSafe(p.player);
}

function syncRestrictedAreaStateFromSources(playerId: number): boolean {
  const restricted = hasAnyRestrictedSourceActive(playerId) && canPlayerReceiveRestrictedAreaFeedback(playerId);
  playerInRestrictedArea[playerId] = restricted;
  return restricted;
}

function deactivateRestrictedAreaFeedbackForPlayer(
  playerId: number,
  suppressRestartUntilReset: boolean = false
): void {
  cancelPendingRestrictedLethalConfirmForPlayer(playerId);
  restrictedAreaCountdownToken[playerId] = (restrictedAreaCountdownToken[playerId] ?? 0) + 1;
  playerInRestrictedArea[playerId] = false;
  if (suppressRestartUntilReset) {
    restrictedAreaFeedbackSuppressedByPlayerId[playerId] = true;
  }
  hideRestrictedAreaUi(playerId);

  const p = serverPlayers.get(playerId);
  if (p) stopRestrictedAreaLoopSfxForPlayer(p.player);
}

function cancelRestrictedAreaFeedbackForPlayer(playerId: number): void {
  deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
}

function resetRestrictedAreaStateForPlayer(playerId: number): void {
  deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
  clearAllRestrictedTriggerStateForPlayer(playerId);
  delete playerInMandownByPlayerId[playerId];
  clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);
}

function isRestrictedAreaLethalStateForPlayer(playerId: number, player: mod.Player): boolean {
  if (playerInMandownByPlayerId[playerId] === true) return true;
  if (!mod.IsPlayerValid(player)) return true;
  if (!isPlayerAliveSafe(player)) return true;

  let currentHealth = Number.POSITIVE_INFINITY;
  let normalizedHealth = Number.POSITIVE_INFINITY;

  try {
    currentHealth = mod.GetSoldierState(player, mod.SoldierStateNumber.CurrentHealth);
  } catch (_err) {}

  try {
    normalizedHealth = mod.GetSoldierState(player, mod.SoldierStateNumber.NormalizedHealth);
  } catch (_err) {}

  return currentHealth <= 0.1 || normalizedHealth <= 0.001;
}

function scheduleRestrictedAreaLethalConfirmForPlayer(playerId: number, player: mod.Player): void {
  if (!hasRestrictedAreaFeedbackOrSourcesActive(playerId)) return;
  if (restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId] !== undefined) return;

  const token = (restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] ?? 0) + 1;
  restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] = token;
  restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId] = Timers.setTimeout(() => {
    if (restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] !== token) return;
    delete restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId];

    if (!hasRestrictedAreaFeedbackOrSourcesActive(playerId)) return;
    if (!isRestrictedAreaLethalStateForPlayer(playerId, player)) return;

    deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
  }, RESTRICTED_AREA_LETHAL_CONFIRM_DELAY_MS);
}

function startRestrictedCountdownIfNeeded(p: Player): void {
  const playerId = p.id;
  const wasRestricted = playerInRestrictedArea[playerId] === true;
  const restricted = syncRestrictedAreaStateFromSources(playerId);
  if (restricted && !wasRestricted) {
    startRestrictedAreaCountdown(p);
  }
}

function clearRestrictedCountdownIfNoSourcesRemain(playerId: number): void {
  const restricted = syncRestrictedAreaStateFromSources(playerId);
  if (restricted) return;

  deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
}

function buildRestrictedAreaUiForPlayer(p: Player): void {
  const playerId = p.id;

  // If it already exists (reconnect / re-init), delete and rebuild.
  const existingRoot = restrictedAreaRootWidgetByPlayerId[playerId];
  if (existingRoot) {
    mod.DeleteUIWidget(existingRoot);
    delete restrictedAreaRootWidgetByPlayerId[playerId];
    delete restrictedAreaCounterWidgetByPlayerId[playerId];
  }

  const rootName = `Restricted_Area_UI_${playerId}`;
  const counterName = `Restricted_Area_CounterText_${playerId}`;

  const root = modlib.ParseUI({
    name: rootName,
    type: "Container",
    position: [0, 0],
    size: [1920, 1080],
    anchor: mod.UIAnchor.Center,
    visible: false, // hidden by default
    padding: 0,
    bgColor: [0.2, 0.2, 0.2],
    bgAlpha: 1,
    bgFill: mod.UIBgFill.None,
    playerId: p.player, // IMPORTANT: restrict this UI to this player only
    children: [
      {
        name: `Restricted_Area_Faded_${playerId}`,
        type: "Container",
        position: [0, 0],
        size: [2000, 1500],
        anchor: mod.UIAnchor.Center,
        visible: true,
        padding: 0,
        bgColor: [0.0314, 0.0431, 0.0431],
        bgAlpha: 0.8,
        bgFill: mod.UIBgFill.Blur,
        children: [
          {
            name: `Restricted_Area_RedRect_${playerId}`,
            type: "Container",
            position: [0, 0],
            size: [1337.4, 201.8],
            anchor: mod.UIAnchor.Center,
            visible: true,
            padding: 0,
            bgColor: [0.8902, 0.0078, 0.0078],
            bgAlpha: 0.5,
            bgFill: mod.UIBgFill.Blur,
            children: [
              {
                name: `Restricted_Area_Text_${playerId}`,
                type: "Text",
                position: [0, -59.8],
                size: [746.3, 194.9],
                anchor: mod.UIAnchor.Center,
                visible: true,
                padding: 0,
                bgColor: [0.2, 0.2, 0.2],
                bgAlpha: 1,
                bgFill: mod.UIBgFill.None,
                textLabel: mod.stringkeys.Restricted_Area,
                textColor: [1, 1, 1],
                textAlpha: 1,
                textSize: 69,
                textAnchor: mod.UIAnchor.Center,
              },
              {
                name: `Restricted_Area_LeaveNow_${playerId}`,
                type: "Text",
                position: [0, 0],
                size: [571.5, 50],
                anchor: mod.UIAnchor.Center,
                visible: true,
                padding: 0,
                bgColor: [0.2, 0.2, 0.2],
                bgAlpha: 1,
                bgFill: mod.UIBgFill.None,
                textLabel: mod.stringkeys.Leave_Now,
                textColor: [1, 1, 1],
                textAlpha: 1,
                textSize: 38,
                textAnchor: mod.UIAnchor.Center,
              },
              {
                name: counterName,
                type: "Text",
                position: [0, 50],
                size: [150, 150],
                anchor: mod.UIAnchor.Center,
                visible: true,
                padding: 0,
                bgColor: [0.2, 0.2, 0.2],
                bgAlpha: 1,
                bgFill: mod.UIBgFill.None,
                textLabel: mod.Message(3),
                textColor: [1, 1, 1],
                textAlpha: 1,
                textSize: 63,
                textAnchor: mod.UIAnchor.Center,
              },
            ],
          },
          {
            name: `Restricted_Area_Outline_${playerId}`,
            type: "Container",
            position: [0, 0],
            size: [1337.4, 201.8],
            anchor: mod.UIAnchor.Center,
            visible: true,
            padding: 0,
            bgColor: [1, 1, 1],
            bgAlpha: 0.5,
            bgFill: mod.UIBgFill.OutlineThick,
          },
        ],
      },
    ],
  }) as mod.UIWidget;

  const counterWidget = mod.FindUIWidgetWithName(counterName) as mod.UIWidget;

  restrictedAreaRootWidgetByPlayerId[playerId] = root;
  restrictedAreaCounterWidgetByPlayerId[playerId] = counterWidget;

  // Ensure clean defaults
  clearAllRestrictedTriggerStateForPlayer(playerId);
  delete playerInMandownByPlayerId[playerId];
  clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);
  playerInRestrictedArea[playerId] = false;
  restrictedAreaCountdownToken[playerId] = 0;
  mod.SetUIWidgetVisible(root, false);
}

function showRestrictedAreaUi(playerId: number): void {
  const root = restrictedAreaRootWidgetByPlayerId[playerId];
  if (!root) return;
  mod.SetUIWidgetVisible(root, true);
}

function hideRestrictedAreaUi(playerId: number): void {
  const root = restrictedAreaRootWidgetByPlayerId[playerId];
  if (!root) return;
  mod.SetUIWidgetVisible(root, false);
}

async function startRestrictedAreaCountdown(p: Player): Promise<void> {
  const playerId = p.id;

  // New token cancels any existing countdown loop for this player
  const myToken = (restrictedAreaCountdownToken[playerId] ?? 0) + 1;
  restrictedAreaCountdownToken[playerId] = myToken;

  // Re-check eligibility here so a queued countdown cannot flash after death/mandown.
  if (restrictedAreaCountdownToken[playerId] !== myToken) {
    return;
  }
  if (syncRestrictedAreaStateFromSources(playerId) !== true) {
    deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
    return;
  }

  await mod.Wait(RESTRICTED_AREA_UI_ACTIVATION_DELAY_SECONDS);

  if (restrictedAreaCountdownToken[playerId] !== myToken) {
    return;
  }
  if (syncRestrictedAreaStateFromSources(playerId) !== true) {
    deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
    return;
  }

  const initialCounterWidget = restrictedAreaCounterWidgetByPlayerId[playerId];
  if (initialCounterWidget) mod.SetUITextLabel(initialCounterWidget, mod.Message(3));

  showRestrictedAreaUi(playerId);
  startRestrictedAreaLoopSfxForPlayer(p.player);

  let secondsLeft = 3;

  while (secondsLeft > 0) {
    // Cancel if player left area or a newer countdown started
    if (playerInRestrictedArea[playerId] !== true) break;
    if (restrictedAreaCountdownToken[playerId] !== myToken) break;

    const counterWidget = restrictedAreaCounterWidgetByPlayerId[playerId];
    if (counterWidget) mod.SetUITextLabel(counterWidget, mod.Message(secondsLeft));

    await mod.Wait(1);
    secondsLeft--;
  }

  if (restrictedAreaCountdownToken[playerId] !== myToken) return;

  // If still in area after countdown, kill
  if (
    playerInRestrictedArea[playerId] === true &&
    p.isDeployed &&
    isPlayerAlive(p.player)
  ) {
    deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
    // Big damage = guaranteed kill
    mod.DealDamage(p.player, 9999);
    return;
  }

  // Hide UI if they left (or after kill attempt)
  if (playerInRestrictedArea[playerId] !== true) {
    deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
  } else {
    // Still in restricted area after countdown (even after kill attempt), keep UI up,
    // but stop the ticking loop so it doesn't run forever.
    stopRestrictedAreaLoopSfxForPlayer(p.player);
  }

}

function cleanupRestrictedAreaUiForPlayer(playerId: number): void {
  resetRestrictedAreaStateForPlayer(playerId);

  const root = restrictedAreaRootWidgetByPlayerId[playerId];
  if (root) mod.DeleteUIWidget(root);

  delete restrictedAreaRootWidgetByPlayerId[playerId];
  delete restrictedAreaCounterWidgetByPlayerId[playerId];
}

/* ----------------------------------------
   Player state (UI + scoreboard + capture)
---------------------------------------- */

class Player {
  public player: mod.Player;
  public id: number;
  public team: mod.Team;

  public isDeployed: boolean;

  public friendlyCapWidget: mod.UIWidget;
  public enemyCapWidget: mod.UIWidget;
  public progressBarWidget: mod.UIWidget;

  public friendlyScoreWidget: mod.UIWidget;
  public opponentScoreWidget: mod.UIWidget;
  public friendlyScorePadWidget: mod.UIWidget;
  public opponentScorePadWidget: mod.UIWidget;
  public bombCarrierTextWidget: mod.UIWidget;
  public bombNoticeContainerWidget: mod.UIWidget;
  public bombNoticeTextWidget: mod.UIWidget;
  public bombCarrierUiLastVisible: boolean;
  public bombCarrierUiLastVersion: number;
  public bombCarrierUiLastAlphaBucket: number;
  public bombNoticeUiLastStateKey: string;
  public objectiveHoldRootWidget: mod.UIWidget;
  public objectiveHoldContainerWidget: mod.UIWidget;
  public objectiveHoldFillArmingWidget: mod.UIWidget;
  public objectiveHoldFillDisarmingWidget: mod.UIWidget;
  public objectiveHoldTextArmingWidget: mod.UIWidget;
  public objectiveHoldTextDisarmingWidget: mod.UIWidget;
  public deployObjectiveTimerRootWidget: mod.UIWidget;
  public deployObjectiveTimerPanelWidget: mod.UIWidget;
  public deployObjectiveTimerLaneFillWidget: mod.UIWidget;
  public deployObjectiveTimerLaneTextWidget: mod.UIWidget;
  public deployObjectiveTimerLaneOutlineTopWidget: mod.UIWidget;
  public deployObjectiveTimerLaneOutlineBottomWidget: mod.UIWidget;
  public deployObjectiveTimerLaneOutlineLeftWidget: mod.UIWidget;
  public deployObjectiveTimerLaneOutlineRightWidget: mod.UIWidget;
  public deployObjectiveTimerTitleWidget: mod.UIWidget;
  public deployObjectiveTimerValueWidget: mod.UIWidget;
  public deployObjectiveTimerLastShownCpId: number | undefined;
  public deployObjectiveTimerLastShownRemainingSeconds: number;
  public cipherTransitionRootWidget: mod.UIWidget;
  public cipherTransitionPanelWidget: mod.UIWidget;
  public cipherTransitionTitleWidget: mod.UIWidget;
  public cipherTransitionSubtitleWidget: mod.UIWidget;
  public cipherTransitionProgressWidget: mod.UIWidget;
  public cipherTransitionTimerWidget: mod.UIWidget;

  public flagWidget: { [key: string]: mod.UIWidget };

  public activeFlagContainerWidget: mod.UIWidget;
  public activeFlagFriendlyWidget: mod.UIWidget;
  public activeFlagEnemyWidget: mod.UIWidget;
  public activeFlagWidget: mod.UIWidget;

  private _scoreboard: number[]; // [score, kills, deaths, armed, destroyed]
  private _onCapturePoint: mod.CapturePoint | null;
  private _firstDeploy: boolean;
  private _ready: boolean;

    constructor(player: mod.Player) {
    this.player = player;
    this.id = modlib.getPlayerId(this.player);
    this.team = mod.GetTeam(this.player);

    this._scoreboard = [0, 0, 0, 0, 0];
    this._onCapturePoint = null;
    this._firstDeploy = true;
    this._ready = false;

    this.isDeployed = false;

    // Live HUD widget refs start empty. They will be built when live starts or when joining during live.
    this.friendlyCapWidget = null as any;
    this.enemyCapWidget = null as any;
    this.progressBarWidget = null as any;

    this.friendlyScoreWidget = null as any;
    this.opponentScoreWidget = null as any;
    this.friendlyScorePadWidget = null as any;
    this.opponentScorePadWidget = null as any;
    this.bombCarrierTextWidget = null as any;
    this.bombNoticeContainerWidget = null as any;
    this.bombNoticeTextWidget = null as any;
    this.bombCarrierUiLastVisible = false;
    this.bombCarrierUiLastVersion = -1;
    this.bombCarrierUiLastAlphaBucket = -1;
    this.bombNoticeUiLastStateKey = "";
    this.objectiveHoldRootWidget = null as any;
    this.objectiveHoldContainerWidget = null as any;
    this.objectiveHoldFillArmingWidget = null as any;
    this.objectiveHoldFillDisarmingWidget = null as any;
    this.objectiveHoldTextArmingWidget = null as any;
    this.objectiveHoldTextDisarmingWidget = null as any;
    this.deployObjectiveTimerRootWidget = null as any;
    this.deployObjectiveTimerPanelWidget = null as any;
    this.deployObjectiveTimerLaneFillWidget = null as any;
    this.deployObjectiveTimerLaneTextWidget = null as any;
    this.deployObjectiveTimerLaneOutlineTopWidget = null as any;
    this.deployObjectiveTimerLaneOutlineBottomWidget = null as any;
    this.deployObjectiveTimerLaneOutlineLeftWidget = null as any;
    this.deployObjectiveTimerLaneOutlineRightWidget = null as any;
    this.deployObjectiveTimerTitleWidget = null as any;
    this.deployObjectiveTimerValueWidget = null as any;
    this.deployObjectiveTimerLastShownCpId = undefined;
    this.deployObjectiveTimerLastShownRemainingSeconds = -1;
    this.cipherTransitionRootWidget = null as any;
    this.cipherTransitionPanelWidget = null as any;
    this.cipherTransitionTitleWidget = null as any;
    this.cipherTransitionSubtitleWidget = null as any;
    this.cipherTransitionProgressWidget = null as any;
    this.cipherTransitionTimerWidget = null as any;

    this.flagWidget = {} as any;

    this.activeFlagContainerWidget = null as any;
    this.activeFlagFriendlyWidget = null as any;
    this.activeFlagEnemyWidget = null as any;
    this.activeFlagWidget = null as any;

    // Do not build any Live HUD widgets here.
    // Building them here is what causes some players to keep the placeholder tickets and then get a second set in live.

    mod.SetRedeployTime(this.player, 0);

    // Mark as not built so rebuildPlayerLiveHud will build cleanly when needed.
    liveHudBuiltByPlayerId[this.id] = false;
  }


  setCapturePoint(capturePoint: mod.CapturePoint | null): void {
    this._onCapturePoint = capturePoint;
  }

  getCapturePoint(): mod.CapturePoint | null {
    return this._onCapturePoint;
  }

  isFirstDeploy(): boolean {
    if (this._firstDeploy) {
      this._firstDeploy = false;
      return true;
    }
    return false;
  }

  updateScoreboard(): void {
    mod.SetScoreboardPlayerValues(
      this.player,
      this._scoreboard[0],
      this._scoreboard[1],
      this._scoreboard[2],
      this._scoreboard[3],
      this._scoreboard[4]
    );
  }

  addScore(score: number): void {
    this._scoreboard[0] += score;
  }

  addKill(): void {
    this._scoreboard[1] += 1;
  }

  addDeath(): void {
    this._scoreboard[2] += 1;
  }

  addKillAssist(): void {
    // Legacy method kept for compatibility. Assist stat is repurposed.
  }

  addArmed(): void {
    this._scoreboard[3] += 1;
  }

  addDestroyed(): void {
    this._scoreboard[4] += 1;
  }

  isReady(): boolean {
    return this._ready;
  }

  changeReady(): void {
    this._ready = !this._ready;

    const w = resolvePrematchReadyTextWidgetForPlayer(this.id);
    if (!w) return;

    if (this._ready) {
      SafeSetTextColorHandle(w, mod.CreateVector(0, 1, 0));
      SafeSetTextLabelHandle(w, mod.Message(mod.stringkeys.Ready));
    } else {
      SafeSetTextColorHandle(w, mod.CreateVector(1, 0, 0));
      SafeSetTextLabelHandle(w, mod.Message(mod.stringkeys.NotReady));
    }
  }
  resetReadyForNewRound(): void {
    this._ready = false;

    const w = resolvePrematchReadyTextWidgetForPlayer(this.id);
    if (!w) return;

    SafeSetTextColorHandle(w, mod.CreateVector(1, 0, 0));
    SafeSetTextLabelHandle(w, mod.Message(mod.stringkeys.NotReady));
  }

  setTeam(): void {
    this.team = mod.GetTeam(this.player);
    refreshCipherKeyPlayerSnapshots("Player.setTeam");
  }

  addUI(): void {
    if (gameStatus !== 3) return;

    // Build once (if needed), then only apply authoritative state -> UI.
    rebuildPlayerLiveHud(this);

    // Pull from authoritative server state
    this.updateTickets();
    this.updateUIPlayersOnPoint();
    this.updateUIProgress();
    UpdateObjectiveHoldProgressUiForPlayer(this);
    UpdateDeployObjectiveTimerUiForPlayer(this);
  }
  getScoreboardSnapshot(): number[] {
    // [score, kills, deaths, armed, destroyed]
    return [
      this._scoreboard[0],
      this._scoreboard[1],
      this._scoreboard[2],
      this._scoreboard[3],
      this._scoreboard[4],
    ];
  }

  resetForNewRound(): void {
    this._scoreboard = [0, 0, 0, 0, 0];
    this._onCapturePoint = null;
    this._firstDeploy = true;
    this._ready = false;
    this.isDeployed = false;
    this.deployObjectiveTimerLastShownCpId = undefined;
    this.deployObjectiveTimerLastShownRemainingSeconds = -1;

    // Reset prematch ready text if it exists.
    const w = resolvePrematchReadyTextWidgetForPlayer(this.id);
    if (w) {
      SafeSetTextColorHandle(w, mod.CreateVector(1, 0, 0));
      SafeSetTextLabelHandle(w, mod.Message(mod.stringkeys.NotReady));
    }
  }



  updateTickets(): void {
    if (!this.friendlyScoreWidget || !this.opponentScoreWidget) return;

    const currentTeam = mod.GetTeam(this.player);

    const friendly = getFriendlyScore(currentTeam);
    const enemy = getOpponentScore(currentTeam);

    mod.SetUITextLabel(this.friendlyScoreWidget, mod.Message(mod.stringkeys.Text_Freindly_Score, friendly));
    mod.SetUITextLabel(this.opponentScoreWidget, mod.Message(mod.stringkeys.Text_Enemy_Score, enemy));

    UpdateTopTicketBarsForPlayer(this);

    // NEW: keep top flag colors correct when the player's team changes mid-match
    UpdateTopFlagColorsForPlayer(this);
  }



  updateUIPlayersOnPoint(): void {
    if (!this.friendlyCapWidget || !this.enemyCapWidget) return;

    const point = this.getCapturePoint();
    if (!point) return;

    const cp = serverCapturePoints[mod.GetObjId(point)];
    const team = mod.GetTeam(this.player);

    if (modlib.Equals(team, team1)) {
      mod.SetUITextLabel(this.friendlyCapWidget, mod.Message(cp.getOnPoint()[0]));
      mod.SetUITextLabel(this.enemyCapWidget, mod.Message(cp.getOnPoint()[1]));
    } else {
      mod.SetUITextLabel(this.friendlyCapWidget, mod.Message(cp.getOnPoint()[1]));
      mod.SetUITextLabel(this.enemyCapWidget, mod.Message(cp.getOnPoint()[0]));
    }
  }

  updateUIProgress(): void {
    if (!this.progressBarWidget) return;

    const point = this.getCapturePoint();
    if (!point) return;

    const cp = serverCapturePoints[mod.GetObjId(point)];
    const team = mod.GetTeam(this.player);
    const capturingTeam = cp.getCapturingTeam();

    let prog = cp.getCaptureProgress();

    if (mod.Equals(cp.getOwner(), team) && prog >= PROGRESS_FULL) {
      prog = 1;
    }

    const size = mod.CreateVector(mod.Ceiling(60 * prog), 60, 0);

    if (this.progressBarWidget) {
      mod.SetUIWidgetSize(this.progressBarWidget, size);

      if (!mod.Equals(capturingTeam, teamNeutral) && prog > PROGRESS_EMPTY && prog < PROGRESS_FULL) {
        if (mod.Equals(capturingTeam, team)) mod.SetUIWidgetBgColor(this.progressBarWidget, COLOR_FRIENDLY);
        else mod.SetUIWidgetBgColor(this.progressBarWidget, COLOR_ENEMY);
      } else if (modlib.Equals(cp.getOwner(), team)) {
        mod.SetUIWidgetBgColor(this.progressBarWidget, COLOR_FRIENDLY);
      } else if (modlib.Equals(cp.getOwner(), teamNeutral)) {
        if (modlib.Equals(cp.getCapturingTeam(), team)) mod.SetUIWidgetBgColor(this.progressBarWidget, COLOR_FRIENDLY);
        else mod.SetUIWidgetBgColor(this.progressBarWidget, COLOR_ENEMY);
      } else {
        mod.SetUIWidgetBgColor(this.progressBarWidget, COLOR_ENEMY);
      }
    }
  }
}

let performanceStatsLoggingInitialized = false;

function initializePerformanceStatsLoggingOnce(): void {
  if (performanceStatsLoggingInitialized) return;
  performanceStatsLoggingInitialized = true;
  PerformanceStats.setLogging((text) => console.log(text), PerformanceStats.LogLevel.Warning);
}

/* ----------------------------------------
   Capture point wrapper
---------------------------------------- */

class CapturePoint {
  public capturePoint: mod.CapturePoint;
  public symbol: ObjectiveLetter;
  public id: number;

  private _owner: mod.Team;
  private _onPoint: number[];
  private _captureProgress: number;
  private _previousCaptureProgress: number;
  private _capturingTeam: mod.Team;

  constructor(id: number, symbol: ObjectiveLetter) {
    this.id = id;
    this.symbol = symbol;

    this.capturePoint = mod.GetCapturePoint(id);

    this._owner = teamNeutral;
    this._onPoint = [];
    this._captureProgress = 0;
    this._previousCaptureProgress = 0;
    this._capturingTeam = teamNeutral;

    mod.SetCapturePointCapturingTime(this.capturePoint, CAPTURE_TIME);
    mod.SetCapturePointNeutralizationTime(this.capturePoint, NEUTRALIZE_TIME);

    mod.EnableGameModeObjective(this.capturePoint, false);
  }

  getPlayerIdsOnPoint(): number[] {
    return this._onPoint;
  }
  clearOnPoint(): void {
    this._onPoint.length = 0; // reuses same array backing store
  }

  addOnPoint(playerId: number): void {
    this._onPoint.push(playerId);
  }

  removeOnPoint(playerId: number): void {
    const index = this._onPoint.indexOf(playerId);
    if (index >= 0) this._onPoint.splice(index, 1);
  }

  getOnPoint(): number[] {
    let onPoint = [0, 0];
    for (let i = 0; i < this._onPoint.length; i++) {
      const p = serverPlayers.get(this._onPoint[i]);
      if (!p) continue;

      const team = mod.GetTeam(p.player);
      if (mod.Equals(team, team1)) onPoint[0] += 1;
      else onPoint[1] += 1;
    }
    return onPoint;
  }

  setOwner(owner: mod.Team): void {
    this._owner = owner;
  }

  getOwner(): mod.Team {
    return this._owner;
  }

  setCaptureProgress(): void {
    this._previousCaptureProgress = this._captureProgress;
    this._captureProgress = mod.GetCaptureProgress(this.capturePoint);
    if (this._captureProgress < 0) this._captureProgress = 0;
    if (this._captureProgress > 1) this._captureProgress = 1;

    const onPoint = this.getOnPoint();
    const majorityTeam =
      onPoint[0] > onPoint[1] ? team1 :
      onPoint[1] > onPoint[0] ? team2 :
      teamNeutral;
    const progressMoved = mod.AbsoluteValue(this._captureProgress - this._previousCaptureProgress) > 0.0001;
    if (progressMoved && !mod.Equals(majorityTeam, teamNeutral)) {
      this._capturingTeam = majorityTeam;
    } else if (!(this._captureProgress > PROGRESS_EMPTY && this._captureProgress < PROGRESS_FULL)) {
      this._capturingTeam = teamNeutral;
    }

    if (gameStatus === 3) {
      const prev = this._previousCaptureProgress;
      const cur = this._captureProgress;
      const progressMovedLocal = mod.AbsoluteValue(cur - prev) > 0.0001;

      if (progressMovedLocal) {
        const creditTeam = majorityTeam;

        if (!mod.Equals(creditTeam, teamNeutral)) {
          const ids = this.getPlayerIdsOnPoint();
          for (let i = 0; i < ids.length; i++) {
            const pid = ids[i];
            const sp = serverPlayers.get(pid);
            if (!sp) continue;
            if (!mod.Equals(mod.GetTeam(sp.player), creditTeam)) continue;
            markCaptureCredit(this.id, pid);
          }
        }
      }

      const progressRising = cur > prev;
      const crossedThreshold = prev < CAPTURE_BUILDUP_THRESHOLD && cur >= CAPTURE_BUILDUP_THRESHOLD;
      if (progressRising && crossedThreshold && !mod.Equals(this._capturingTeam, teamNeutral)) {
        void playCaptureBuildupToCapturingTeamOnPoint(this, this._capturingTeam);
      }
    }

    if (mod.AbsoluteValue(this._captureProgress - this._previousCaptureProgress) > 0.0001) {
      this.setUIProgressForPlayersOnPoint();
    }
  }

  getCaptureProgress(): number {
    return this._captureProgress;
  }

  getCapturingTeam(): mod.Team {
    return this._capturingTeam;
  }

  getColor(team: mod.Team): mod.Vector {
    if (mod.Equals(team, this._owner)) return COLOR_FRIENDLY;
    if (mod.Equals(this._owner, teamNeutral)) return COLOR_NEUTRAL;
    return COLOR_ENEMY;
  }

  updateUIforPlayersOnPoint(): void {
    this._onPoint.forEach((id) => {
      const p = serverPlayers.get(id);
      if (p) p.updateUIPlayersOnPoint();
    });
  }

  setUIProgressForPlayersOnPoint(): void {
    this._onPoint.forEach((id) => {
      const p = serverPlayers.get(id);
      if (p) p.updateUIProgress();
    });
  }
}

/* Capture points registry */
let serverCapturePoints: { [key: number]: CapturePoint } = {
  [CP_A_ID]: new CapturePoint(CP_A_ID, "A"),
  [CP_B_ID]: new CapturePoint(CP_B_ID, "B"),
  [CP_C_ID]: new CapturePoint(CP_C_ID, "A"),
  [CP_NORTH_B_NEUTRAL_ID]: new CapturePoint(CP_NORTH_B_NEUTRAL_ID, "B"),
  [CP_T2_B_ID]: new CapturePoint(CP_T2_B_ID, "A"),
  [CP_T2_C_ID]: new CapturePoint(CP_T2_C_ID, "B"),
  [CP_T2_A_NEUTRAL_ID]: new CapturePoint(CP_T2_A_NEUTRAL_ID, "A"),
  [CP_T2_B_NEUTRAL_ID]: new CapturePoint(CP_T2_B_NEUTRAL_ID, "B"),
};

/* Threatened-flag overrides for late spawns */
let threatenedFlagForTeam1: number | null = null;
let threatenedFlagForTeam2: number | null = null;
// HQ routing updates can be expensive; we drive them off capture-point events and a small safety cadence.
let hqRoutingDirty: boolean = true;
let lastHqRoutingUpdateTick: number = -999999;
const HQ_ROUTING_SAFETY_INTERVAL_TICKS = TICK_RATE * 2; // refresh occasionally in case events are missed
const HQ_ROUTING_SAFETY_INTERVAL_SECONDS = HQ_ROUTING_SAFETY_INTERVAL_TICKS / TICK_RATE;


// Track whether each team has captured at least one flag this round.
// Used to keep initial HQ spawns until a team captures a flag for the first time.
let team1HasCapturedAnyFlag: boolean = false;
let team2HasCapturedAnyFlag: boolean = false;

/* =================================================================================================
   8) INPUT / DAMAGE RESTRICTIONS (PHASE-BASED)
================================================================================================= */

function applyPhaseInputRestrictionsForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;

  const playerId = modlib.getPlayerId(player);
  const isPrematch = gameStatus === 0;
  const isRedeployCountdown = gameStatus === 1;
  const isPreLive = gameStatus === 2;
  const isLive = gameStatus >= 3;

  if (isLive) {
    mod.EnableAllInputRestrictions(player, false);
    return;
  }

  

  if (isPrematch) {
    mod.EnableAllInputRestrictions(player, false);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.Interact, false);
    return;
  }

  if (isRedeployCountdown) {
    mod.EnableAllInputRestrictions(player, false);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.FireWeapon, true);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.Interact, true);
    return;
  }

  if (isPreLive) {
    mod.EnableAllInputRestrictions(player, true);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.CameraPitch, false);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.CameraYaw, false);
    return;
  }
}

/* Utility wrapper (keeps old call sites readable) */
function setReadyPhaseProtectionForPlayer(player: mod.Player, enabled: boolean): void {
  if (!enabled) {
    mod.EnableAllInputRestrictions(player, false);
    
    return;
  }
  applyPhaseInputRestrictionsForPlayer(player);
}

function setPlayerMaxHealthAndRefill(player: mod.Player, maxHealth: number): void {
  if (!mod.IsPlayerValid(player)) return;

  try {
    mod.SetPlayerMaxHealth(player, maxHealth);
  } catch (_errSetMax) {}

  try {
    mod.Heal(player, PREMATCH_HEALTH_FULL_HEAL_AMOUNT);
  } catch (_errHeal) {}
}

function clearPrematch889StateForPlayer(playerId: number): void {
  delete prematchHealthInside889ByPlayerId[playerId];
  delete prematchHealthAppliedMaxByPlayerId[playerId];
}

function isPrematchOutside889(playerId: number): boolean {
  if (gameStatus !== 0) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp) return false;
  if (!mod.IsPlayerValid(sp.player)) return false;

  return prematchHealthInside889ByPlayerId[playerId] !== true;
}

function forcePrematchOutside889FullHeal(player: mod.Player, playerId: number): void {
  if (!mod.IsPlayerValid(player)) return;
  if (!isPrematchOutside889(playerId)) return;

  try {
    mod.Heal(player, PREMATCH_HEALTH_FULL_HEAL_AMOUNT);
  } catch (_err) {}
}

// Prematch 889 health mapping:
// - inside 889: normal max health
// - outside 889: outside max health policy
function applyPrematch889HealthForPlayer(playerId: number): void {
  const sp = serverPlayers.get(playerId);
  if (!sp) return;
  if (!mod.IsPlayerValid(sp.player)) return;

  const desiredMax =
    gameStatus === 0
      ? prematchHealthInside889ByPlayerId[playerId] === true
        ? PREMATCH_HEALTH_NORMAL_MAX
        : PREMATCH_HEALTH_OUTSIDE_MAX
      : PREMATCH_HEALTH_NORMAL_MAX;

  if (prematchHealthAppliedMaxByPlayerId[playerId] !== desiredMax) {
    setPlayerMaxHealthAndRefill(sp.player, desiredMax);
    prematchHealthAppliedMaxByPlayerId[playerId] = desiredMax;
    return;
  }

  // Outside 889 in prematch must always be topped off, even when max-health value is unchanged.
  if (isPrematchOutside889(playerId)) {
    forcePrematchOutside889FullHeal(sp.player, playerId);
  }
}

function applyPrematch889HealthForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    applyPrematch889HealthForPlayer(p.id);
  });
}

function normalizeAllPlayersToStandardHealthAndClearPrematch889State(): void {
  serverPlayers.forEach((p) => {
    if (!mod.IsPlayerValid(p.player)) {
      clearPrematch889StateForPlayer(p.id);
      return;
    }

    setPlayerMaxHealthAndRefill(p.player, PREMATCH_HEALTH_NORMAL_MAX);
    clearPrematch889StateForPlayer(p.id);
  });
}

function warnPrematchSwitchDebounceOnce(playerId: number, ticksRemaining: number): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (prematchSwitchDebounceWarnedByPlayerId[playerId] === true) return;
  prematchSwitchDebounceWarnedByPlayerId[playerId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[PREMATCH SWITCH] debounced player/remainTicks/status/inits {}",
      String(playerId) +
        "/" +
        String(ticksRemaining) +
        "/" +
        String(gameStatus) +
        "/" +
        getInitializationFlagSummary()
    )
  );
}

function warnPrematchStabilizationGateBlockedOnce(
  readyPlayers: number[],
  totalPlayers: number[],
  elapsedTicksSinceSwitch: number
): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  const key = String(lastPrematchTeamSwitchTick);
  if (prematchStabilizationGateWarnedBySwitchTick[key] === true) return;
  prematchStabilizationGateWarnedBySwitchTick[key] = true;

  emitStringKeyDebugWorldLog(
    mod.Message(
      "[PREMATCH GATE] blocked status/inits/rdy/tot/switchElapsed {}",
      String(gameStatus) +
        "/" +
        getInitializationFlagSummary() +
        "/" +
        String(readyPlayers[0]) +
        "-" +
        String(readyPlayers[1]) +
        "/" +
        String(totalPlayers[0]) +
        "-" +
        String(totalPlayers[1]) +
        "/" +
        String(elapsedTicksSinceSwitch)
    )
  );
}

function markPrematchTeamSwitchTick(playerId: number): void {
  lastPrematchTeamSwitchTick = serverTickCount;
  lastPrematchTeamSwitchAtSec = getCurrentSchedulerNowSeconds();
  lastPrematchTeamSwitchTickByPlayerId[playerId] = serverTickCount;
}

function isPrematchSwitchDebounced(playerId: number): boolean {
  const lastTick = prematchSwitchLastHandledTickByPlayerId[playerId] ?? -999999;
  const elapsedTicks = serverTickCount - lastTick;
  if (elapsedTicks < PREMATCH_SWITCH_DEBOUNCE_TICKS) {
    warnPrematchSwitchDebounceOnce(playerId, PREMATCH_SWITCH_DEBOUNCE_TICKS - elapsedTicks);
    return true;
  }

  prematchSwitchLastHandledTickByPlayerId[playerId] = serverTickCount;
  return false;
}

/* Prematch team switch helper */
function switchTeamPrematchAndRedeploy(player: mod.Player, newTeam: mod.Team): void {
  mod.UndeployPlayer(player);
  mod.SetTeam(player, newTeam);
  mod.SetRedeployTime(player, 0);
}

function forceAutoDeployToInitialHqDuringCountdown(): void {
  return;
}


/* Prematch loadout stripping (MELEE ONLY) */
const READYUP_REMOVE_SLOTS: mod.InventorySlots[] = [
  mod.InventorySlots.PrimaryWeapon,
  mod.InventorySlots.SecondaryWeapon,
  mod.InventorySlots.Throwable,
  mod.InventorySlots.ClassGadget,
  mod.InventorySlots.GadgetOne,
  mod.InventorySlots.GadgetTwo,
  mod.InventorySlots.MiscGadget,
  // IMPORTANT: do NOT remove mod.InventorySlots.MeleeWeapon
];

function stripLoadoutToMeleeOnly(player: mod.Player): void {
  for (let i = 0; i < READYUP_REMOVE_SLOTS.length; i++) {
    mod.RemoveEquipment(player, READYUP_REMOVE_SLOTS[i]);
  }
}

/* Bot backfill detection (Portal setting: bot backfill counts as AI soldiers). 
   We must exclude AI soldiers from Ready Up requirements. */
function isBotBackfillPlayer(player: mod.Player): boolean {
  return mod.GetSoldierState(player, mod.SoldierStateBool.IsAISoldier);
}


/* =================================================================================================
   9) HQ ENABLE/DISABLE + ROUTING LOGIC
================================================================================================= */

function warnPrematchHqMapValidationOnce(key: string, message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (prematchHqMapValidationWarnedByKey[key] === true) return;
  prematchHqMapValidationWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(message);
}

function tryResolveHqObjIdFromMapData(hqId: number): number {
  try {
    const hq = mod.GetHQ(hqId);
    return getObjIdSafe(hq);
  } catch (_err) {
    return -1;
  }
}

function validatePrematchReadyupHqsFromMapData(): void {
  const configuredTeam1HqId: number = Number(TEAM1_READYUP_HQ);
  const configuredTeam2HqId: number = Number(TEAM2_READYUP_HQ);

  const team1ObjId = tryResolveHqObjIdFromMapData(configuredTeam1HqId);
  const team2ObjId = tryResolveHqObjIdFromMapData(configuredTeam2HqId);

  let valid = true;
  let reason = "ok";

  if (configuredTeam1HqId === configuredTeam2HqId) {
    valid = false;
    reason = "same_configured_id";
  } else if (team1ObjId < 0 && team2ObjId < 0) {
    valid = false;
    reason = "missing_both";
  } else if (team1ObjId < 0) {
    valid = false;
    reason = "missing_team1";
  } else if (team2ObjId < 0) {
    valid = false;
    reason = "missing_team2";
  } else if (team1ObjId === team2ObjId) {
    valid = false;
    reason = "same_objid";
  }

  if (valid) {
    resolvedPrematchHqTeam1Id = configuredTeam1HqId;
    resolvedPrematchHqTeam2Id = configuredTeam2HqId;
    prematchHqFallbackActive = false;
  } else {
    resolvedPrematchHqTeam1Id = TEAM1_INITIAL_HQ;
    resolvedPrematchHqTeam2Id = TEAM2_INITIAL_HQ;
    prematchHqFallbackActive = true;
  }

  const diag = "cfg=" +
    String(configuredTeam1HqId) +
    "/" +
    String(configuredTeam2HqId) +
    " obj=" +
    String(team1ObjId) +
    "/" +
    String(team2ObjId) +
    " valid=" +
    (valid ? "1" : "0") +
    " reason=" +
    reason +
    " targets=" +
    String(resolvedPrematchHqTeam1Id) +
    "/" +
    String(resolvedPrematchHqTeam2Id);

  const key = "prematch_hq_map/" + diag;
  warnPrematchHqMapValidationOnce(
    key,
    mod.Message("[PREMATCH HQ MAP] {}", diag)
  );
}

function enforceReadyupHqsDisabledOutsidePrematch(_source: string): void {
  if (gameStatus === 0) return;
  SafeEnableHQById(TEAM1_READYUP_HQ, false);
  SafeEnableHQById(TEAM2_READYUP_HQ, false);
}

function warnSafeEnableHqOnce(hqId: number, enabled: boolean, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (hqEnableWarnedById[hqId] === true) return;
  hqEnableWarnedById[hqId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[HQ SAFE ENABLE] HQ {} toggle {} failed ({})", hqId, enabled ? "on" : "off", reason)
  );
}

function SafeEnableHQById(hqId: number, enabled: boolean): void {
  try {
    mod.EnableHQ(mod.GetHQ(hqId), enabled);
  } catch (err) {
    warnSafeEnableHqOnce(hqId, enabled, String(err));
    LogRuntimeError("SafeEnableHQById/" + String(hqId), err);
  }
}

function syncLiveBaseHqsForLivePhase(): void {
  const shouldEnable = gameStatus === 3;
  const changed = liveBaseHqsUnlocked !== shouldEnable;
  liveBaseHqsUnlocked = shouldEnable;

  if (gameStatus === 3) {
    EnableLiveBaseHQs();
  }

  if (changed) {
    markHqRoutingDirty();
  }

  enforceReadyupHqsDisabledOutsidePrematch("syncLiveBaseHqsForLivePhase");
}

function DisableAllDynamicHQsAndLiveHQs(): void {
  const idsToDisable: number[] = [
    TEAM1_READYUP_HQ, TEAM2_READYUP_HQ,

    TEAM1_INITIAL_HQ, TEAM2_INITIAL_HQ,
    TEAM1_LIVE_HQ, TEAM2_LIVE_HQ,

    TEAM1_FLAG_A_HQ, TEAM1_FLAG_B_HQ, TEAM1_FLAG_C_HQ,
    TEAM2_FLAG_A_HQ, TEAM2_FLAG_B_HQ, TEAM2_FLAG_C_HQ,

    TEAM1_AB_HQ, TEAM1_AC_HQ, TEAM1_BC_HQ,
    TEAM2_AB_HQ, TEAM2_AC_HQ, TEAM2_BC_HQ,

    TEAM1_ABC_HQ, TEAM2_ABC_HQ,

    TEAM1_NO_FLAG_HQ, TEAM2_NO_FLAG_HQ,
  ];

  idsToDisable.forEach((id) => SafeEnableHQById(id, false));
}

function EnableAllBaseHQs(): void {
  SafeEnableHQById(TEAM1_INITIAL_HQ, true);
  SafeEnableHQById(TEAM2_INITIAL_HQ, true);
  SafeEnableHQById(TEAM1_LIVE_HQ, false);
  SafeEnableHQById(TEAM2_LIVE_HQ, false);
}

function getCipherLiveHqIdForTeam(team: mod.Team): number {
  if (cipherCurrentHalf === 1) {
    return mod.Equals(team, team1) ? TEAM1_INITIAL_HQ : TEAM2_INITIAL_HQ;
  }
  return mod.Equals(team, team1) ? TEAM1_LIVE_HQ : TEAM2_LIVE_HQ;
}

function EnableLiveBaseHQs(): void {
  SafeEnableHQById(TEAM1_INITIAL_HQ, false);
  SafeEnableHQById(TEAM2_INITIAL_HQ, false);
  SafeEnableHQById(TEAM1_LIVE_HQ, false);
  SafeEnableHQById(TEAM2_LIVE_HQ, false);
  SafeEnableHQById(getCipherLiveHqIdForTeam(team1), true);
  SafeEnableHQById(getCipherLiveHqIdForTeam(team2), true);
}

function ConfigureLiveSpawns(): void {
  DisableAllDynamicHQsAndLiveHQs();
  syncLiveBaseHqsForLivePhase();
  if (ENABLE_DYNAMIC_HQ_ROUTING) {
    return;
  }

  currentDynamicHqTeam1 = getCipherLiveHqIdForTeam(team1);
  currentDynamicHqTeam2 = getCipherLiveHqIdForTeam(team2);
}

function ConfigurePreMatchSpawns(): void {
  validatePrematchReadyupHqsFromMapData();
  DisableAllDynamicHQsAndLiveHQs();

  if (prematchHqFallbackActive) {
    SafeEnableHQById(TEAM1_READYUP_HQ, false);
    SafeEnableHQById(TEAM2_READYUP_HQ, false);
    SafeEnableHQById(TEAM1_INITIAL_HQ, true);
    SafeEnableHQById(TEAM2_INITIAL_HQ, true);
    return;
  }

  SafeEnableHQById(TEAM1_INITIAL_HQ, false);
  SafeEnableHQById(TEAM2_INITIAL_HQ, false);

  SafeEnableHQById(resolvedPrematchHqTeam1Id, true);
  SafeEnableHQById(resolvedPrematchHqTeam2Id, true);
}


/*
  Updates which HQ is enabled for each team in live phase.
  Priority:
    - If a team still owns a "threatened" point (being neutralized), route them to that flag HQ.
    - Else route by ownership count: 0 -> NO, 1 -> that flag HQ, 2 -> combo HQ, 3 -> ABC HQ
*/
function UpdateFlagHQSpawns(): void {
  if (gameStatus !== 3) return;
  if (!ENABLE_DYNAMIC_HQ_ROUTING) {
    DisableAllDynamicHQsAndLiveHQs();
    EnableLiveBaseHQs();
    threatenedFlagForTeam1 = null;
    threatenedFlagForTeam2 = null;
    currentDynamicHqTeam1 = getCipherLiveHqIdForTeam(team1);
    currentDynamicHqTeam2 = getCipherLiveHqIdForTeam(team2);
    hqRoutingDirty = false;
    return;
  }

  // Keep base HQ quartet enabled throughout live while dynamic routes are toggled.
  EnableLiveBaseHQs();

  const ownerA = serverCapturePoints[CP_A_ID].getOwner();
  const ownerB = serverCapturePoints[CP_B_ID].getOwner();
  const ownerC = serverCapturePoints[CP_C_ID].getOwner();

  const t1OwnA = mod.Equals(ownerA, team1);
  const t1OwnB = mod.Equals(ownerB, team1);
  const t1OwnC = mod.Equals(ownerC, team1);
  const t1Count = (t1OwnA ? 1 : 0) + (t1OwnB ? 1 : 0) + (t1OwnC ? 1 : 0);

  const t2OwnA = mod.Equals(ownerA, team2);
  const t2OwnB = mod.Equals(ownerB, team2);
  const t2OwnC = mod.Equals(ownerC, team2);
  const t2Count = (t2OwnA ? 1 : 0) + (t2OwnB ? 1 : 0) + (t2OwnC ? 1 : 0);

  if (t1Count > 0) team1HasCapturedAnyFlag = true;
  if (t2Count > 0) team2HasCapturedAnyFlag = true;

  const t1SingleHQs = [TEAM1_FLAG_A_HQ, TEAM1_FLAG_B_HQ, TEAM1_FLAG_C_HQ];
  const t1ComboHQs = [TEAM1_AB_HQ, TEAM1_AC_HQ, TEAM1_BC_HQ, TEAM1_ABC_HQ];
  const t1AllSpecialHQs = t1SingleHQs.concat(t1ComboHQs).concat([TEAM1_NO_FLAG_HQ]);

  const t2SingleHQs = [TEAM2_FLAG_A_HQ, TEAM2_FLAG_B_HQ, TEAM2_FLAG_C_HQ];
  const t2ComboHQs = [TEAM2_AB_HQ, TEAM2_AC_HQ, TEAM2_BC_HQ, TEAM2_ABC_HQ];
  const t2AllSpecialHQs = t2SingleHQs.concat(t2ComboHQs).concat([TEAM2_NO_FLAG_HQ]);

  t1AllSpecialHQs.forEach((id) => SafeEnableHQById(id, false));
  t2AllSpecialHQs.forEach((id) => SafeEnableHQById(id, false));

  const getTeam1FlagHQForCp = (cp: CapturePoint | undefined): number | null => {
    if (!cp) return null;
    if (cp.symbol === "A") return TEAM1_FLAG_A_HQ;
    if (cp.symbol === "B") return TEAM1_FLAG_B_HQ;
    if (cp.symbol === "C") return TEAM1_FLAG_C_HQ;
    return null;
  };

  const getTeam2FlagHQForCp = (cp: CapturePoint | undefined): number | null => {
    if (!cp) return null;
    if (cp.symbol === "A") return TEAM2_FLAG_A_HQ;
    if (cp.symbol === "B") return TEAM2_FLAG_B_HQ;
    if (cp.symbol === "C") return TEAM2_FLAG_C_HQ;
    return null;
  };

  let t1OverrideHQ: number | null = null;
  if (threatenedFlagForTeam1 !== null) {
    const threatenedCp = serverCapturePoints[threatenedFlagForTeam1];
    if (threatenedCp) {
      const owner = threatenedCp.getOwner();
      const capturingTeam = threatenedCp.getCapturingTeam();
      const progress = threatenedCp.getCaptureProgress();

      if (mod.Equals(owner, team1) && mod.Equals(capturingTeam, team2) && progress > PROGRESS_EMPTY && progress < PROGRESS_FULL) {
        t1OverrideHQ = getTeam1FlagHQForCp(threatenedCp);
      } else {
        threatenedFlagForTeam1 = null;
      }
    } else {
      threatenedFlagForTeam1 = null;
    }
  }

  let t2OverrideHQ: number | null = null;
  if (threatenedFlagForTeam2 !== null) {
    const threatenedCp = serverCapturePoints[threatenedFlagForTeam2];
    if (threatenedCp) {
      const owner = threatenedCp.getOwner();
      const capturingTeam = threatenedCp.getCapturingTeam();
      const progress = threatenedCp.getCaptureProgress();

      if (mod.Equals(owner, team2) && mod.Equals(capturingTeam, team1) && progress > PROGRESS_EMPTY && progress < PROGRESS_FULL) {
        t2OverrideHQ = getTeam2FlagHQForCp(threatenedCp);
      } else {
        threatenedFlagForTeam2 = null;
      }
    } else {
      threatenedFlagForTeam2 = null;
    }
  }

  let chosenT1: number = TEAM1_NO_FLAG_HQ;
  if (t1OverrideHQ !== null) chosenT1 = t1OverrideHQ;
  else if (t1Count === 0) {
    // Before Team 1 captures any flag this round, keep them spawning at the initial HQ.
    chosenT1 = team1HasCapturedAnyFlag ? TEAM1_NO_FLAG_HQ : TEAM1_INITIAL_HQ;
  }
  else if (t1Count === 1) {
    if (t1OwnA) chosenT1 = TEAM1_FLAG_A_HQ;
    if (t1OwnB) chosenT1 = TEAM1_FLAG_B_HQ;
    if (t1OwnC) chosenT1 = TEAM1_FLAG_C_HQ;
  } else if (t1Count === 2) {
    if (t1OwnA && t1OwnB && !t1OwnC) chosenT1 = TEAM1_AB_HQ;
    else if (t1OwnA && t1OwnC && !t1OwnB) chosenT1 = TEAM1_AC_HQ;
    else if (t1OwnB && t1OwnC && !t1OwnA) chosenT1 = TEAM1_BC_HQ;
  } else if (t1Count === 3) {
    chosenT1 = TEAM1_ABC_HQ;
  }

  let chosenT2: number = TEAM2_NO_FLAG_HQ;
  if (t2OverrideHQ !== null) chosenT2 = t2OverrideHQ;
  else if (t2Count === 0) {
    // Before Team 2 captures any flag this round, keep them spawning at the initial HQ.
    chosenT2 = team2HasCapturedAnyFlag ? TEAM2_NO_FLAG_HQ : TEAM2_INITIAL_HQ;
  }
  else if (t2Count === 1) {
    if (t2OwnA) chosenT2 = TEAM2_FLAG_A_HQ;
    if (t2OwnB) chosenT2 = TEAM2_FLAG_B_HQ;
    if (t2OwnC) chosenT2 = TEAM2_FLAG_C_HQ;
  } else if (t2Count === 2) {
    if (t2OwnA && t2OwnB && !t2OwnC) chosenT2 = TEAM2_AB_HQ;
    else if (t2OwnA && t2OwnC && !t2OwnB) chosenT2 = TEAM2_AC_HQ;
    else if (t2OwnB && t2OwnC && !t2OwnA) chosenT2 = TEAM2_BC_HQ;
  } else if (t2Count === 3) {
    chosenT2 = TEAM2_ABC_HQ;
  }

  SafeEnableHQById(chosenT1, true);
  SafeEnableHQById(chosenT2, true);

  currentDynamicHqTeam1 = chosenT1;
  currentDynamicHqTeam2 = chosenT2;
}

/* =================================================================================================
   10) TICKETS / BLEED / SCOREBOARD
================================================================================================= */





function UpdateScoreboard(): void {
  serverPlayers.forEach((p) => p.updateScoreboard());
}

/* =================================================================================================
   11) CAPTURE AUDIO LOOPS / CONTESTED DETECTION
================================================================================================= */

function UpdateCaptureTickAudio(): void {
  if (gameStatus !== 3) return;

  const now = serverTickCount;

  Object.values(serverCapturePoints).forEach((cp) => {
    const cpId = cp.id;

    const playerIds = cp.getPlayerIdsOnPoint();
    if (!playerIds || playerIds.length === 0) return;

    const onPointCounts = cp.getOnPoint();
    const hasT1 = onPointCounts[0] > 0;
    const hasT2 = onPointCounts[1] > 0;
    if (!hasT1 && !hasT2) return;

    const progress = cp.getCaptureProgress();
    const contested = hasT1 && hasT2;

    const inProgressBand = progress > PROGRESS_EMPTY && progress < PROGRESS_FULL;

    // Tick while:
    // - contested (both teams present), OR
    // - progress is actively between empty/full (someone is capturing or neutralizing)
    if (!contested && !inProgressBand) return;

    const majorityTeam = getMajorityTeamOnPoint(cp);

    for (let i = 0; i < playerIds.length; i++) {
      const playerId = playerIds[i];
      const p = serverPlayers.get(playerId);
      if (!p) continue;
      if (!p.isDeployed) continue;
      if (!mod.IsPlayerValid(p.player)) continue;
      if (!isPlayerAlive(p.player)) continue;

      const key = playerId + "_" + cpId;
      const last = lastCaptureTickAt[key] ?? -999999;

      if (now - last < CAPTURE_TICK_INTERVAL_TICKS) continue;
      lastCaptureTickAt[key] = now;

      if (contested) {
        // Everyone hears enemy tick when contested.
        playTickEnemy(p.player);
        continue;
      }

      // Not contested: majority team hears friendly tick, minority hears enemy tick.
      // If equal (no majority), treat like contested for feedback.
      if (mod.Equals(majorityTeam, teamNeutral)) {
        playTickEnemy(p.player);
        continue;
      }

      const playerTeam = mod.GetTeam(p.player);
      if (mod.Equals(playerTeam, majorityTeam)) playTickFriendly(p.player);
      else playTickEnemy(p.player);
    }
  });
}


function PlayCaptureContestedAudio(cp: CapturePoint): void {
  const owner = getObjectiveAuthoritativeOwner(cp.id);
  const playerIds = cp.getPlayerIdsOnPoint();
  const symbol = getObjectiveLaneSymbol(cp.id, cp.symbol);

  for (let i = 0; i < playerIds.length; i++) {
    const playerId = playerIds[i];
    const p = serverPlayers.get(playerId);
    if (!p) continue;

    const playerTeam = mod.GetTeam(p.player);

    if (!mod.Equals(owner, teamNeutral) && mod.Equals(playerTeam, owner)) {
      playVOToPlayer(p.player, mod.VoiceOverEvents2D.ObjectiveContested, getVoiceOverFlagForSymbol(symbol));
    }
  }
}

function UpdateCapturePointContestedState(cp: CapturePoint): void {
  const onPoint = cp.getOnPoint();
  const contestedNow = onPoint[0] > 0 && onPoint[1] > 0;

  const cpId = cp.id;
  const wasContested = capturePointContested[cpId] === true;

  if (contestedNow && !wasContested) {
    PlayCaptureContestedAudio(cp);
  }

  capturePointContested[cpId] = contestedNow;
}

function getMajorityTeamOnPoint(cp: CapturePoint): mod.Team {
  const onPoint = cp.getOnPoint();
  if (onPoint[0] > onPoint[1]) return team1;
  if (onPoint[1] > onPoint[0]) return team2;
  return teamNeutral;
}

/* =================================================================================================
   12) PHASE INITIALIZATION
================================================================================================= */
function ResetRoutingAndSafeSpawnStateForNewRound(): void {
  lastDynamicHqForPlayer = {};
  pendingDynamicHqForPlayer = {};
  safeSpawnSpawnerIndex = {};
  liveBaseHqsUnlocked = false;

  safeSpawnUnsafePending = {};
  safeSpawnUnsafeSpawnerObjId = {};
  safeSpawnUnsafeHqObjIdByPlayerId = {};
  safeSpawnForcedRedeploys = {};
  safeSpawnPendingCheck = {};
  safeSpawnForcedUndeploy = {};
  lastLiveHqSpawnPointObjIdByPlayerId = {};
  lastForcedSafeSpawnHqObjIdByPlayerId = {};

  hqDesyncForcedRedeploys = {};
  squadSpawnBypass = {};

  currentDynamicHqTeam1 = getCipherLiveHqIdForTeam(team1);
  currentDynamicHqTeam2 = getCipherLiveHqIdForTeam(team2);
  resetCipherSpawnRoutingState();

  threatenedFlagForTeam1 = null;
  threatenedFlagForTeam2 = null;
  lastHqRoutingUpdateTick = -999999;
  hqRoutingDirty = ENABLE_DYNAMIC_HQ_ROUTING;
}

function ResetRoundGameplayState(): void {
  // Reset tickets immediately so any UI that reads serverScores starts clean.
  serverScores = [INITIAL_TICKETS, INITIAL_TICKETS];
  cipherCurrentHalf = 1;
  cipherMatchStage = "half1";
  cipherHalfScores = [0, 0];
  cipherObjectiveKeyCountByCpId = {};
  cipherCounterWorldIconLastShownByCpId = {};
  resetCipherSuddenDeathState();
  clearCipherSecondHalfDeployFreezeForAllPlayers();
  resetCipherSecondHalfDeployTracking();
  cipherSecondHalfTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  postmatchWinnerTeam = teamNeutral;
  resetBombCarrierRuntimeState(true);
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};

  // Clear per-round caches related to capture tick audio and capture credit (if you added it)
  lastCaptureTickAt = {};
  capturePointContested = {};
  lastContestSfxTickByCp = {};
  lastCaptureSfxTickByCp = {};
  lastJoinSfxTickByCp = {};
  lastEnterPointSfxTickByPlayerId = {};

  // Clear threatened routing
  threatenedFlagForTeam1 = null;
  threatenedFlagForTeam2 = null;
  ResetRoutingAndSafeSpawnStateForNewRound();

  // Restore all objectives to defending-owner defaults for the next round.
  registerObjectivesDeterministically();
  applyObjectiveRoundStartOwnership(true);

  // Clear all players capturepoint refs and hide the capture widget container
  serverPlayers.forEach((p) => {
    p.setCapturePoint(null);
    if (p.activeFlagContainerWidget) mod.SetUIWidgetVisible(p.activeFlagContainerWidget, false);
  });

  // Reset the match timer baseline (your custom timer uses phaseTickCount + ROUND_TIME)
  phaseTickCount = 0;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  resetLiveClockState();
  stopDamageZonePulseTimer();
  playerInDamageZone = {};
  prematchReadyPlayersByTeam = [0, 0];
  prematchTotalPlayersByTeam = [0, 0];
  prematchAllPlayersReady = false;
}
function ResetAllPlayersReadyState(): void {
  serverPlayers.forEach((p) => p.resetReadyForNewRound());
}

function resetLifecycleStateForFreshMatchStart(): void {
  initialization[0] = false;
  initialization[1] = false;
  initialization[2] = false;
  initialization[3] = false;
  initialization[4] = false;
  liveBaseHqsUnlocked = false;
  phaseTickCount = 0;
  currentFrameNowSec = 0;
  currentFrameHasEngineNowSec = false;
  countDown = COUNT_DOWN_TIME;
  liveGameModeLimitAtSec = 0;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  resetLiveClockState();
  stopDamageZonePulseTimer();
  playerInDamageZone = {};
  prematchReadyPlayersByTeam = [0, 0];
  prematchTotalPlayersByTeam = [0, 0];
  prematchAllPlayersReady = false;
  postmatchEndStep = 0;
  postmatchEndStepTick = 0;
  postmatchEndStepAtSec = 0;
  postmatchWinnerTeam = teamNeutral;
  cipherCurrentHalf = 1;
  cipherMatchStage = "half1";
  cipherHalfScores = [0, 0];
  cipherObjectiveKeyCountByCpId = {};
  cipherCounterWorldIconLastShownByCpId = {};
  resetCipherSuddenDeathState();
  clearCipherSecondHalfDeployFreezeForAllPlayers();
  resetCipherSecondHalfDeployTracking();
  cipherSecondHalfTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  transitionFallbackActive = false;
  transitionFallbackNextAllowedTick = 0;
  transitionWarnedByKey = {};
  liveTransitionCheckpointSeenByKey = {};
  hqEnableWarnedById = {};
  prematchUiGuardWarnedByKey = {};
  prematchHqMapValidationWarnedByKey = {};
  resolvedPrematchHqTeam1Id = TEAM1_READYUP_HQ;
  resolvedPrematchHqTeam2Id = TEAM2_READYUP_HQ;
  prematchHqFallbackActive = false;
  prematchSwitchLastHandledTickByPlayerId = {};
  prematchSwitchDebounceWarnedByPlayerId = {};
  lastPrematchTeamSwitchTick = -999999;
  lastPrematchTeamSwitchAtSec = -999999;
  lastPrematchTeamSwitchTickByPlayerId = {};
  prematchStabilizationGateWarnedBySwitchTick = {};
  preliveTeamSanityWarnedByPlayerId = {};
  prematchHealthInside889ByPlayerId = {};
  prematchHealthAppliedMaxByPlayerId = {};
  objectiveEngineWarnedByKey = {};
  resetTransitionSpawnQueueState(true);
  perfTelemetryLastSampleAtSec = 0;
  perfTelemetryLastFrameAtSec = -1;
  perfTelemetrySmoothedHz = 0;
  perfTelemetryFrameCount = 0;
  perfTelemetryFastLaneRuns = 0;
  perfTelemetrySlowLaneRuns = 0;
  perfTelemetryIconLaneRuns = 0;
  perfTelemetryEndgameLaneRuns = 0;
  perfTelemetryDamageLaneRuns = 0;
  perfTelemetryBombPickupScanMaxCandidates = 0;
  clearVoModuleState();
  resetMatchStartBannerState(true);
}


function ReturnToPreMatchState(): void {
  // --- Core prematch recovery variables ---
  serverScores = [INITIAL_TICKETS, INITIAL_TICKETS];
  cipherCurrentHalf = 1;
  cipherMatchStage = "half1";
  cipherHalfScores = [0, 0];
  cipherObjectiveKeyCountByCpId = {};
  cipherCounterWorldIconLastShownByCpId = {};
  resetCipherSuddenDeathState();
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  phaseTickCount = 0;
  countDown = COUNT_DOWN_TIME;
  liveGameModeLimitAtSec = 0;
  postmatchEndStep = 0;
  postmatchEndStepTick = 0;
  postmatchEndStepAtSec = 0;
  postmatchWinnerTeam = teamNeutral;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  resetLiveClockState();
  postmatchResultSfxPlayed = false;
  stopAllObjectiveAwardBursts();
  StopAllObjectiveMcomSfx();
  hideAllObjectiveArmedWorldIcons();
  HideAllDeployObjectiveTimerUi();
  ResetRoutingAndSafeSpawnStateForNewRound();
  resetBombCarrierRuntimeState(true);
  resetTransitionSpawnQueueState(false);
  liveTransitionCheckpointSeenByKey = {};
  prematchSwitchLastHandledTickByPlayerId = {};
  prematchSwitchDebounceWarnedByPlayerId = {};
  lastPrematchTeamSwitchTick = -999999;
  lastPrematchTeamSwitchAtSec = -999999;
  lastPrematchTeamSwitchTickByPlayerId = {};
  prematchStabilizationGateWarnedBySwitchTick = {};
  preliveTeamSanityWarnedByPlayerId = {};
  prematchHealthInside889ByPlayerId = {};
  prematchHealthAppliedMaxByPlayerId = {};
  resetMatchStartBannerState(true);
  stopDamageZonePulseTimer();
  playerInDamageZone = {};

  // IMPORTANT: make sure prematch init re-runs (so prematch enables icons/interacts/etc)
  initialization[0] = false;
  initialization[1] = false;
  initialization[2] = false;
  initialization[3] = false;
  initialization[4] = false;

  // --- UI visibility ---
  SafeSetWidgetVisibleByName("PreMatchContainer", true);
  SetCountdownOverlayVisible(false);
  hideCipherTransitionHudForAllPlayers();
  SafeSetWidgetVisibleByName("LiveContainer", false);
  SafeSetWidgetVisibleByName("PostMatchContainer", false);

  gameStatus = 0;

  // --- Reset READY state so we do NOT auto-start the next prematch-to-live transition ---
  serverPlayers.forEach((p) => {
    p.resetReadyForNewRound();

    // Also force the per-player prematch ready text to update immediately
    // (recreate it so it cannot carry old label/color)
    replacePrematchReadyText(p.id, p.player);

    // Reset internal deploy bookkeeping so prematch behaves clean
    p.isDeployed = false;

    // Clear any capture UI state
    p.setCapturePoint(null);
    if (p.activeFlagContainerWidget) {
      try {
        mod.SetUIWidgetVisible(p.activeFlagContainerWidget, false);
      } catch (_err) {}
    }

    // Clear redeploy time so players can be placed into prematch world state.
    mod.SetRedeployTime(p.player, 0);

    // Apply prematch restrictions (combat enabled, interact allowed)
    applyPhaseInputRestrictionsForPlayer(p.player);

  });

  // --- Re-enable prematch world icons + interact points ---
  for (let i = 0; i < 4; i++) {
    SafeEnableWorldIconById(WORLDICON_T1_SWITCH + i, true, true);
  }

  SafeEnableInteractPointById(IP_T1_SWITCH, true);
  SafeEnableInteractPointById(IP_T1_READY, true);
  SafeEnableInteractPointById(IP_T2_SWITCH, true);
  SafeEnableInteractPointById(IP_T2_READY, true);

  // --- Spawns back to prematch HQs ---
  ConfigurePreMatchSpawns();

  // --- Make sure prematch roster UI reflects the new prematch state immediately ---
  refreshPrematchReadyStateUi();
  applyPrematch889HealthForAllPlayers();

  // --- Put everyone back into the world in prematch ---
  mod.DeployAllPlayers();
  setObjectiveNativeMcomObjectivesEnabled(false, "restorePrematch");
  disableAllObjectiveCapturePointObjectives("restorePrematch");
  disableAllObjectiveInteractPoints("restorePrematch");
  syncDisabledBombAnchorObjectives();
}

function InitializePreMatch(): void {
  phaseTickCount = 0;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  stopDamageZonePulseTimer();
  setLiveScorePanelVisible(false);
  setObjectiveNativeMcomObjectivesEnabled(false, "InitializePreMatch");
  disableAllObjectiveCapturePointObjectives("InitializePreMatch");
  disableAllObjectiveInteractPoints("InitializePreMatch");
  syncDisabledBombAnchorObjectives();
  StopAllObjectiveMcomSfx();
  hideAllObjectiveArmedWorldIcons();
  HideAllDeployObjectiveTimerUi();
  resetBombCarrierRuntimeState(true);
  resetTransitionSpawnQueueState(false);
  resetLiveClockState();
  validateRequiredQuadBikeAnchorConfigurationOnce();

  // If we are looping back into prematch, ensure the world state is clean.
  ResetRoundGameplayState();
  StopAllEndgameLoops();
  resetMatchStartBannerState(true);

  UIContainers = [
    mod.FindUIWidgetWithName("PreMatchContainer"),
    mod.FindUIWidgetWithName("CountDownContainer"),
    mod.FindUIWidgetWithName("LiveContainer"),
    mod.FindUIWidgetWithName("PostMatchContainer"),
  ];

  serverPlayers.forEach((p) => p.setTeam());

  SafeSetWorldIconTextById(WORLDICON_T1_SWITCH, mod.Message(mod.stringkeys.SwitchTeam));
  SafeSetWorldIconTextById(WORLDICON_T1_READY, mod.Message(mod.stringkeys.Ready));
  SafeSetWorldIconTextById(WORLDICON_T2_SWITCH, mod.Message(mod.stringkeys.SwitchTeam));
  SafeSetWorldIconTextById(WORLDICON_T2_READY, mod.Message(mod.stringkeys.Ready));

  // Re-enable icons (they were disabled in countdown)
  for (let i = 0; i < 4; i++) {
    SafeEnableWorldIconById(WORLDICON_T1_SWITCH + i, true, true);
  }

  // Re-enable prematch interact points (ready + switch)
  SafeEnableInteractPointById(IP_T1_SWITCH, true);
  SafeEnableInteractPointById(IP_T1_READY, true);
  SafeEnableInteractPointById(IP_T2_SWITCH, true);
  SafeEnableInteractPointById(IP_T2_READY, true);

  mod.SetScoreboardType(mod.ScoreboardType.CustomTwoTeams);
  liveGameModeLimitAtSec = 0;
  mod.SetGameModeTimeLimit(60000);

  // Prematch UI visibility
  SafeSetWidgetVisibleByName("PreMatchContainer", true);
  SetCountdownOverlayVisible(false);
  hideCipherTransitionHudForAllPlayers();
  SafeSetWidgetVisibleByName("LiveContainer", false);

  ConfigurePreMatchSpawns();


  refreshPrematchReadyStateUi();

  serverPlayers.forEach((p) => setReadyPhaseProtectionForPlayer(p.player, true));
  applyPrematch889HealthForAllPlayers();

  initialization[0] = true;
  resetTransitionFallbackGuardIfPrematchReady();
}

function InitializeCountDown(): void {
  let initOk = false;
  try {
    liveTransitionCheckpointSeenByKey = {};
    emitLiveTransitionCheckpoint("countdown_init_enter");
    stopDamageZonePulseTimer();
    phaseTickCount = 0;
    countDown = COUNT_DOWN_TIME;
    clearPhaseCountdownDeadline();
    resetEngineSchedulerCadenceState();
    setLiveScorePanelVisible(false);
    setObjectiveNativeMcomObjectivesEnabled(false, "InitializeCountDown");
    syncDisabledBombAnchorObjectives();
    StopAllObjectiveMcomSfx();
    hideAllObjectiveArmedWorldIcons();
    HideAllDeployObjectiveTimerUi();
    resetBombCarrierRuntimeState(true);
    registerObjectivesDeterministically();
    applyObjectiveLiveHybridRoundStartState(true);
    resetMatchStartBannerState(true);
    resetLiveClockState();

    team1HasCapturedAnyFlag = false;
    team2HasCapturedAnyFlag = false;

    // Restore the legacy countdown UI behavior for the ready-up delay.
    // Players stay deployed while this 5-second Redeploying countdown is visible,
    // then they are undeployed only after it completes.
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
    SafeSetWidgetVisibleByName("PreMatchContainer", false);

    for (let i = 0; i < 4; i++) {
      SafeEnableWorldIconById(WORLDICON_T1_SWITCH + i, false, false);
    }

    SafeEnableInteractPointById(IP_T1_READY, false);
    SafeEnableInteractPointById(IP_T2_READY, false);
    disableAllObjectiveInteractPoints("InitializeCountDown");

    SafeSetTextLabelByName("MatchStartsText", mod.Message(mod.stringkeys.Redeploying));
    SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
    SetCountdownOverlayVisible(true);
    hideCipherTransitionHudForAllPlayers();
    SetCountdownOverlayDepthAboveGameUI();

    DisableAllDynamicHQsAndLiveHQs();
    EnableAllBaseHQs();
    enforceReadyupHqsDisabledOutsidePrematch("InitializeCountDown");
    resetTransitionSpawnQueueState(false);

    serverPlayers.forEach((p) => setReadyPhaseProtectionForPlayer(p.player, true));
    initOk = true;
  } catch (err) {
    LogRuntimeError("InitializeCountDown", err);
  } finally {
    initialization[1] = initOk;
    if (!initOk) {
      warnTransitionRecoveryOnce(
        "initfail/InitializeCountDown",
        mod.Message(
          "[TRANSITION INIT FAIL] phase/status/inits {}",
          "countdown/" + String(gameStatus) + "/" + getInitializationFlagSummary()
        )
      );
    }
  }
}

function InitializePreLive(): void {
  let initOk = false;
  try {
    liveTransitionCheckpointSeenByKey = {};
    emitLiveTransitionCheckpoint("prelive_init_enter");
    stopDamageZonePulseTimer();
    phaseTickCount = 0;
    countDown = PRELIVE_TIME;
    clearPhaseCountdownDeadline();
    resetEngineSchedulerCadenceState();
    setLiveScorePanelVisible(false);
    setObjectiveNativeMcomObjectivesEnabled(false, "InitializePreLive");
    syncDisabledBombAnchorObjectives();
    StopAllObjectiveMcomSfx();
    hideAllObjectiveArmedWorldIcons();
    HideAllDeployObjectiveTimerUi();
    resetBombCarrierRuntimeState(true);
    resetMatchStartBannerState(true);
    resetTransitionSpawnQueueState(false);
    resetLiveClockState();
    cipherCurrentHalf = 1;
    cipherMatchStage = "half1";
    cipherHalfScores = [0, 0];
    cipherPendingScoreTransitionTeam = teamNeutral;
    cipherSecondHalfTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    resetCipherSecondHalfDeployTracking();
    clearCipherSecondHalfDeployFreezeForAllPlayers();
    cipherSuddenDeathTransitionActive = false;
    resetCipherSuddenDeathState();
    resetCipherSpawnRoutingState();
    preliveTeamSanityWarnedByPlayerId = {};

    if (!validatePreLivePlayerTeamsFromEngine()) {
      initOk = false;
      return;
    }

    if (!validatePreLiveTransitionSpawnPrerequisites()) {
      initOk = false;
      return;
    }

    SafeSetTextLabelByName("MatchStartsText", mod.Message(mod.stringkeys.MatchStarts));
    SafeSetTextLabelByName("CountDownText", mod.Message(countDown));

    // Hide prematch UI.
    SafeSetWidgetVisibleByName("PreMatchContainer", false);
    SetCountdownOverlayVisible(true);
    hideCipherTransitionHudForAllPlayers();
    SetCountdownOverlayDepthAboveGameUI();

    // Disable prematch world icons + interact points.
    for (let i = 0; i < 4; i++) {
      SafeEnableWorldIconById(WORLDICON_T1_SWITCH + i, false, false);
    }
    SafeEnableInteractPointById(IP_T1_SWITCH, false);
    SafeEnableInteractPointById(IP_T1_READY, false);
    SafeEnableInteractPointById(IP_T2_SWITCH, false);
    SafeEnableInteractPointById(IP_T2_READY, false);
    disableAllObjectiveInteractPoints("InitializePreLive");

    // Pre-live deploys through the active half HQs, then the spawn queue routes players to anchors.
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
    DisableAllDynamicHQsAndLiveHQs();
    EnableLiveBaseHQs();
    enforceReadyupHqsDisabledOutsidePrematch("InitializePreLive");

    registerObjectivesDeterministically();

    // Re-apply defending owners and expose the active CP objective layer during pre-live.
    // Native MCOM objectives stay disabled so the deploy map keeps A/B labels.
    applyObjectiveLiveHybridRoundStartState(true);

    cipherPhaseTransitionUndeployIgnoreUntilSec = getCurrentSchedulerNowSeconds() + PRELIVE_TIME + 2;
    mod.UndeployAllPlayers();
    requestTransitionSpawnForAllTransitionPlayers("prelive_start");

    serverPlayers.forEach((p) => setReadyPhaseProtectionForPlayer(p.player, true));
    initOk = true;
  } catch (err) {
    LogRuntimeError("InitializePreLive", err);
  } finally {
    initialization[2] = initOk;
    if (!initOk) {
      warnTransitionRecoveryOnce(
        "initfail/InitializePreLive",
        mod.Message(
          "[TRANSITION INIT FAIL] phase/status/inits {}",
          "prelive/" + String(gameStatus) + "/" + getInitializationFlagSummary()
        )
      );
    }
  }
}

function InitializeLive(): void {
  let initOk = false;
  try {
    emitLiveTransitionCheckpoint("live_init_enter");
    stopDamageZonePulseTimer();
    resetLiveClockState();
    emitLiveTransitionCheckpoint("live_init_clock_reset");
    liveGameModeLimitAtSec = mod.GetMatchTimeElapsed() + LIVE_ENGINE_TIME_LIMIT_SAFETY_SECONDS;
    mod.SetGameModeTimeLimit(liveGameModeLimitAtSec);
    emitLiveTransitionCheckpoint("live_init_time_limit");
    cleanupLegacySharedTopHudWidgets();
    setLiveScorePanelVisible(true);
    emitLiveTransitionCheckpoint("live_init_score_panel");
    syncDisabledBombAnchorObjectives();
    StopAllObjectiveMcomSfx();
    hideAllObjectiveArmedWorldIcons();
    HideAllDeployObjectiveTimerUi();
    emitLiveTransitionCheckpoint("live_init_objective_fx_clear");
    resetBombCarrierRuntimeState(true, true);
    serverScores = [INITIAL_TICKETS, INITIAL_TICKETS];
    cipherCurrentHalf = 1;
    cipherMatchStage = "half1";
    cipherHalfScores = [0, 0];
    resetCipherSuddenDeathState();
    cipherSecondHalfTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    resetCipherSecondHalfDeployTracking();
    clearCipherSecondHalfDeployFreezeForAllPlayers();
    cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
    resetCipherSpawnRoutingState();
    resetCipherObjectiveCounters();
    registerObjectivesDeterministically();
    disableAllObjectiveInteractPoints("InitializeLive");
    resetTransitionSpawnQueueState(false);
    emitLiveTransitionCheckpoint("live_init_runtime_reset");
    // Re-enable the tabletop deploy screen for live play.
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
    emitLiveTransitionCheckpoint("live_init_spawn_mode");
    ConfigureLiveSpawns();
    enforceReadyupHqsDisabledOutsidePrematch("InitializeLive");
    emitLiveTransitionCheckpoint("live_init_spawns");
    applyObjectiveLiveHybridRoundStartState(false);
    updateCipherCounterWorldIcons(true);
    void reassertObjectiveOwnershipShortlyAfterLiveStart();
    emitLiveTransitionCheckpoint("live_init_objectives");
    trySpawnLiveQuadBikeFromConfiguredCapturePoint();
    emitLiveTransitionCheckpoint("live_init_quadbike");
    phaseTickCount = 0;
    clearPhaseCountdownDeadline();
    resetEngineSchedulerCadenceState();
    emitLiveTransitionCheckpoint("live_init_phase_clock");
    // Root containers
    SetDepthAboveGameUI("UIContainer");
    SetDepthAboveGameUI("LiveContainer");

    // Match time HUD + center intro
    SetDepthAboveGameUI("matchtime");
    SetDepthAboveGameUI("LiveTimerIntroContainer");


    // Scores + pulses
    SetDepthAboveGameUI("friendlyscore");
    SetDepthAboveGameUI("enemyscore");

    // Objective/score panel + flag containers
    SetDepthAboveGameUI("BG_Score_Container");
    SetDepthAboveGameUI("Container_A");
    SetDepthAboveGameUI("Container_B");
    SetDepthAboveGameUI("Container_C");
    SetDepthAboveGameUI("Container_D");
    SetDepthAboveGameUI("Container_E");
    SetDepthAboveGameUI("Container_F");
    emitLiveTransitionCheckpoint("live_init_depths");

    UpdateFlagHQSpawns();
    emitLiveTransitionCheckpoint("live_init_hqs");

    // Hide prematch UI once players are deploying/playing.
    SafeSetWidgetVisibleByName("PreMatchContainer", false);
    SetCountdownOverlayVisible(false);
    hideCipherTransitionHudForAllPlayers();
    SafeSetWidgetVisibleByName("LiveContainer", true);
    HideSharedTicketBarFills();
    emitLiveTransitionCheckpoint("live_init_countdown_hidden");


    serverPlayers.forEach((p) => p.addUI());
    beginRegulationClock(getCurrentSchedulerNowSeconds());
    emitLiveTransitionCheckpoint("live_init_player_ui_clock");

    serverPlayers.forEach((p) => setReadyPhaseProtectionForPlayer(p.player, false));

    serverPlayers.forEach((p) => {
      p.setTeam();
      mod.SetRedeployTime(p.player, REDEPLOY_TIME);
      mod.EnableAllInputRestrictions(p.player, false);
      mod.EnableInputRestriction(p.player, mod.RestrictedInputs.FireWeapon, false);
      if (p.isDeployed) p.isFirstDeploy();
    });
    refreshCipherKeyPlayerSnapshots("InitializeLive");
    repairCipherKeyHudCachesForAllPlayers(true);
    UpdateBombCarrierUiForAllPlayers(undefined, true);
    refreshBombNoticeUiForAllPlayers(undefined, true);
    emitLiveTransitionCheckpoint("live_init_players_unlocked");

    mod.SetScoreboardColumnNames(
      mod.Message(mod.stringkeys.ScoreboardScore),
      mod.Message(mod.stringkeys.ScoreboardKills),
      mod.Message(mod.stringkeys.ScoreboardDeaths),
      mod.Message(mod.stringkeys.ScoreboardAssists),
      mod.Message(mod.stringkeys.ScoreboardCaptures)
    );
    emitLiveTransitionCheckpoint("live_init_scoreboard");

    SetUITime();
    SetUIScores();
    startDamageZonePulseTimer();
    emitLiveTransitionCheckpoint("live_init_complete");
    initOk = true;
  } catch (err) {
    LogRuntimeError("InitializeLive", err);
  } finally {
    initialization[3] = initOk;
    if (!initOk) {
      warnTransitionRecoveryOnce(
        "initfail/InitializeLive",
        mod.Message(
          "[TRANSITION INIT FAIL] phase/status/inits {}",
          "live/" + String(gameStatus) + "/" + getInitializationFlagSummary()
        )
      );
    } else {
      emitLiveTransitionCheckpoint("live_init_success_bomb_schedule_before");
      try {
        spawnBombPickupObjectAtLiveStart();
        emitLiveTransitionCheckpoint("live_init_success_bomb_schedule_after");
      } catch (bombErr) {
        LogRuntimeError("InitializeLive/bombSchedule", bombErr);
        emitLiveTransitionCheckpoint("live_init_success_bomb_schedule_failed");
      }
    }
  }
}

function resolveWinningTeamFromScores(): mod.Team {
  const t1 = serverScores[0];
  const t2 = serverScores[1];

  if (t1 > t2) return team1;
  if (t2 > t1) return team2;
  return teamNeutral;
}

function getWinningTeam(): mod.Team {
  if (gameStatus === 4) return postmatchWinnerTeam;
  return resolveWinningTeamFromScores();
}

function deletePostMatchReportUI(): void {
  for (let i = 0; i < postMatchWidgetsToDelete.length; i++) {
    safeDeleteWidgetByName(postMatchWidgetsToDelete[i]);
  }
  postMatchWidgetsToDelete = [];
}

function addPostMatchText(
  name: string,
  posX: number,
  posY: number,
  w: number,
  h: number,
  size: number,
  color: mod.Vector,
  alpha: number,
  receiver: mod.Team | mod.Player
): void {
  const parent = mod.FindUIWidgetWithName("PostMatchContainer");
  mod.AddUIText(
    name,
    mod.CreateVector(posX, posY, 0),
    mod.CreateVector(w, h, 0),
    mod.UIAnchor.TopCenter,
    parent,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(""),
    size,
    color,
    alpha,
    mod.UIAnchor.Center,
    receiver as any
  );

  postMatchWidgetsToDelete.push(name);
}

function setPostMatchText(name: string, label: any): void {
  const w = mod.FindUIWidgetWithName(name);
  if (w) mod.SetUITextLabel(w, label);
}

function BuildPostMatchReportUI(): void {
  deletePostMatchReportUI();

  const parent = mod.FindUIWidgetWithName("PostMatchContainer");
  if (!parent) return;

  mod.SetUIWidgetBgFill(parent, mod.UIBgFill.Solid);
  mod.SetUIWidgetBgAlpha(parent, 0.75);
  mod.SetUIWidgetBgColor(parent, mod.CreateVector(0, 0, 0));
  mod.SetUIWidgetDepth(parent, mod.UIDepth.AboveGameUI);

  const winner = getWinningTeam();

  // Build connected player lists (serverPlayers only contains connected players)
  const t1List: Player[] = [];
  const t2List: Player[] = [];

  serverPlayers.forEach((p) => {
    const t = mod.GetTeam(p.player);
    if (mod.Equals(t, team1)) t1List.push(p);
    else if (mod.Equals(t, team2)) t2List.push(p);
  });

  t1List.sort((a, b) => b.getScoreboardSnapshot()[0] - a.getScoreboardSnapshot()[0]);
  t2List.sort((a, b) => b.getScoreboardSnapshot()[0] - a.getScoreboardSnapshot()[0]);

  // Layout
  const headerY = 220;
  const rowStartY = 260;
  const rowH = 22;

  // Portal-safe centered layout
const TABLE_WIDTH = 620; // safe on 16:9
const TABLE_GAP = 60;    // space between teams

// Left and right table centers
const leftX  = -(TABLE_GAP / 2 + TABLE_WIDTH / 2);
const rightX = +(TABLE_GAP / 2 + TABLE_WIDTH / 2);

  // Utility: clamp line count without mod.Min
  function clampLines(n: number): number {
    let out = n;
    if (out > POSTMATCH_MAX_LINES) out = POSTMATCH_MAX_LINES;
    if (out < 0) out = 0;
    return out;
  }

  // Build a full view for a specific receiver team:
  // left side = friendly team data, right side = enemy team data.
  function buildForReceiver(
    receiver: mod.Team,
    friendlyList: Player[],
    enemyList: Player[],
    friendlyTicketsA: number,
    friendlyTicketsB: number,
    resultKey: any
  ): void {
    // Result text (color depends on result)
    const resultColor =
      resultKey === mod.stringkeys.PostMatchVictory ? COLOR_FRIENDLY :
      resultKey === mod.stringkeys.PostMatchDefeat ? COLOR_ENEMY :
      COLOR_NEUTRAL;

    addPostMatchText("PM_Result_" + modlib.getTeamId(receiver), 0, 80, 800, 80, 64, resultColor, 1, receiver);
    setPostMatchText("PM_Result_" + modlib.getTeamId(receiver), mod.Message(resultKey));

    // Final tickets line (friendly-enemy from viewer perspective)
    addPostMatchText("PM_Tickets_" + modlib.getTeamId(receiver), 0, 150, 900, 40, 28, COLOR_NEUTRAL, 1, receiver);
    setPostMatchText(
      "PM_Tickets_" + modlib.getTeamId(receiver),
      mod.Message(mod.stringkeys.PostMatchFinalTickets, mod.Ceiling(friendlyTicketsA), mod.Ceiling(friendlyTicketsB))
    );

    // Headers (left = friendly, right = enemy)
    function addHeaders(side: "L" | "R", x: number, color: mod.Vector): void {
      const suffix = side + "_" + modlib.getTeamId(receiver);

      addPostMatchText("H_Name_" + suffix, x - 220, headerY, 280, 24, 18, color, 1, receiver);
      addPostMatchText("H_Score_" + suffix, x + 120, headerY, 90, 24, 18, color, 1, receiver);
      addPostMatchText("H_K_" + suffix, x + 200, headerY, 40, 24, 18, color, 1, receiver);
      addPostMatchText("H_D_" + suffix, x + 245, headerY, 40, 24, 18, color, 1, receiver);
      addPostMatchText("H_A_" + suffix, x + 290, headerY, 40, 24, 18, color, 1, receiver);
      addPostMatchText("H_C_" + suffix, x + 345, headerY, 60, 24, 18, color, 1, receiver);

      setPostMatchText("H_Name_" + suffix, mod.Message(mod.stringkeys.PostMatchHeaderName));
      setPostMatchText("H_Score_" + suffix, mod.Message(mod.stringkeys.PostMatchHeaderScore));
      setPostMatchText("H_K_" + suffix, mod.Message(mod.stringkeys.PostMatchHeaderKills));
      setPostMatchText("H_D_" + suffix, mod.Message(mod.stringkeys.PostMatchHeaderDeaths));
      setPostMatchText("H_A_" + suffix, mod.Message(mod.stringkeys.PostMatchHeaderAssists));
      setPostMatchText("H_C_" + suffix, mod.Message(mod.stringkeys.PostMatchHeaderCaptures));
    }

    addHeaders("L", leftX, COLOR_FRIENDLY);
    addHeaders("R", rightX, COLOR_ENEMY);

    // Friendly rows (left)
    const friendlyLines = clampLines(friendlyList.length);
    for (let i = 0; i < friendlyLines; i++) {
      const y = rowStartY + i * rowH;
      const p = friendlyList[i];
      const s = p.getScoreboardSnapshot();
      const suf = "L_" + modlib.getTeamId(receiver) + "_" + i;

      addPostMatchText("N_" + suf, leftX - 220, y, 280, 22, 16, COLOR_FRIENDLY, 1, receiver);
      addPostMatchText("S_" + suf, leftX + 120, y, 90, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("K_" + suf, leftX + 200, y, 40, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("D_" + suf, leftX + 245, y, 40, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("A_" + suf, leftX + 290, y, 40, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("C_" + suf, leftX + 345, y, 60, 22, 16, COLOR_NEUTRAL, 1, receiver);

      setPostMatchText("N_" + suf, mod.Message(mod.stringkeys.PostMatchPlayerName, p.player));
      setPostMatchText("S_" + suf, mod.Message(s[0]));
      setPostMatchText("K_" + suf, mod.Message(s[1]));
      setPostMatchText("D_" + suf, mod.Message(s[2]));
      setPostMatchText("A_" + suf, mod.Message(s[3]));
      setPostMatchText("C_" + suf, mod.Message(s[4]));
    }

    // Enemy rows (right) in COLOR_ENEMY for the name column
    const enemyLines = clampLines(enemyList.length);
    for (let i = 0; i < enemyLines; i++) {
      const y = rowStartY + i * rowH;
      const p = enemyList[i];
      const s = p.getScoreboardSnapshot();
      const suf = "R_" + modlib.getTeamId(receiver) + "_" + i;

      addPostMatchText("N_" + suf, rightX - 220, y, 280, 22, 16, COLOR_ENEMY, 1, receiver);
      addPostMatchText("S_" + suf, rightX + 120, y, 90, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("K_" + suf, rightX + 200, y, 40, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("D_" + suf, rightX + 245, y, 40, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("A_" + suf, rightX + 290, y, 40, 22, 16, COLOR_NEUTRAL, 1, receiver);
      addPostMatchText("C_" + suf, rightX + 345, y, 60, 22, 16, COLOR_NEUTRAL, 1, receiver);

      setPostMatchText("N_" + suf, mod.Message(mod.stringkeys.PostMatchPlayerName, p.player));
      setPostMatchText("S_" + suf, mod.Message(s[0]));
      setPostMatchText("K_" + suf, mod.Message(s[1]));
      setPostMatchText("D_" + suf, mod.Message(s[2]));
      setPostMatchText("A_" + suf, mod.Message(s[3]));
      setPostMatchText("C_" + suf, mod.Message(s[4]));
    }
  }

  // Determine result per receiver team
  const t1ResultKey =
    mod.Equals(winner, team1) ? mod.stringkeys.PostMatchVictory :
    mod.Equals(winner, team2) ? mod.stringkeys.PostMatchDefeat :
    mod.stringkeys.PostMatchDraw;

  const t2ResultKey =
    mod.Equals(winner, team2) ? mod.stringkeys.PostMatchVictory :
    mod.Equals(winner, team1) ? mod.stringkeys.PostMatchDefeat :
    mod.stringkeys.PostMatchDraw;

  // Team 1 viewers: left = team1 (friendly), right = team2 (enemy)
  buildForReceiver(team1, t1List, t2List, serverScores[0], serverScores[1], t1ResultKey);

  // Team 2 viewers: left = team2 (friendly), right = team1 (enemy)
  buildForReceiver(team2, t2List, t1List, serverScores[1], serverScores[0], t2ResultKey);
}

function InitializePostmatch(): void {
  let initOk = false;
  try {
    stopDamageZonePulseTimer();
    phaseTickCount = 0;
    countDown = POSTMATCH_TIME;
    postmatchEndStep = 0;
    postmatchEndStepTick = 0;
    postmatchEndStepAtSec = 0;
    setPhaseCountdownDeadlineFromNow(POSTMATCH_TIME);
    resetEngineSchedulerCadenceState();
    setLiveScorePanelVisible(false);
    setObjectiveNativeMcomObjectivesEnabled(false, "InitializePostmatch");
    disableAllObjectiveCapturePointObjectives("InitializePostmatch");
    disableAllObjectiveInteractPoints("InitializePostmatch");
    syncDisabledBombAnchorObjectives();
    StopAllObjectiveMcomSfx();
    hideAllObjectiveArmedWorldIcons();
    resetBombCarrierRuntimeState(true);
    enforceReadyupHqsDisabledOutsidePrematch("InitializePostmatch");

    SafeSetWidgetVisibleByName("LiveContainer", false);
    SetCountdownOverlayVisible(false);
    hideCipherTransitionHudForAllPlayers();
    SafeSetWidgetVisibleByName("PreMatchContainer", false);
    StopAllCaptureTickLoops();
    StopAllEndgameLoops();



    const post = mod.FindUIWidgetWithName("PostMatchContainer");
    if (post) {
      SafeSetWidgetVisibleHandle(post, true);
      mod.SetUIWidgetDepth(post, mod.UIDepth.AboveGameUI);
      SafeSetWidgetSizeHandle(post, mod.CreateVector(6000, 5000, 0));
    }

    // Unlock players but keep them from interacting/shooting.
    serverPlayers.forEach((p) => {
      mod.EnableAllInputRestrictions(p.player, true);
      mod.EnableInputRestriction(p.player, mod.RestrictedInputs.CameraPitch, false);
      mod.EnableInputRestriction(p.player, mod.RestrictedInputs.CameraYaw, false);
    });

    // Clamp scores for display.
    if (serverScores[0] < 0) serverScores[0] = 0;
    if (serverScores[1] < 0) serverScores[1] = 0;

    BuildPostMatchReportUI();
    playPostMatchResultSfxOnce();
    initOk = true;
  } catch (err) {
    LogRuntimeError("InitializePostmatch", err);
  } finally {
    initialization[4] = initOk;
    if (!initOk) {
      warnTransitionRecoveryOnce(
        "initfail/InitializePostmatch",
        mod.Message(
          "[TRANSITION INIT FAIL] phase/status/inits {}",
          "postmatch/" + String(gameStatus) + "/" + getInitializationFlagSummary()
        )
      );
    }
  }
}


/* =================================================================================================
   13) GAME MODE LIFECYCLE + MAIN LOOP
================================================================================================= */
// -------------------------------------------------------------------------------------------------
// RUNTIME SAFETY GUARD
// If any unexpected runtime error occurs, keep the mode running and rate-limit logs.
// This prevents "timer frozen / capture logic stopped" failure mode.
// -------------------------------------------------------------------------------------------------

let lastRuntimeErrorTick = -999999;

function LogRuntimeError(tag: string, err: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  // Rate limit to once per second (prevents spam + performance issues).
  if (serverTickCount - lastRuntimeErrorTick < TICK_RATE) return;
  lastRuntimeErrorTick = serverTickCount;

  emitStringKeyDebugWorldLog(
    mod.Message("[RUNTIME ERROR] {}: {}", tag, String(err))
  );
}

function getInitializationFlagSummary(): string {
  return (
    (initialization[0] ? "1" : "0") +
    (initialization[1] ? "1" : "0") +
    (initialization[2] ? "1" : "0") +
    (initialization[3] ? "1" : "0") +
    (initialization[4] ? "1" : "0")
  );
}

function tryGetEngineMatchTimeElapsedSeconds(): number | undefined {
  try {
    const elapsed = Number(mod.GetMatchTimeElapsed());
    if (Number.isFinite(elapsed)) return elapsed;
  } catch (_err) {}
  return undefined;
}

function tryGetEngineMatchTimeRemainingSeconds(): number | undefined {
  try {
    const remaining = Number(mod.GetMatchTimeRemaining());
    if (Number.isFinite(remaining)) return remaining;
  } catch (_err) {}
  return undefined;
}

function tryGetConfiguredLiveGameModeLimitSeconds(): number | undefined {
  if (!Number.isFinite(liveGameModeLimitAtSec) || liveGameModeLimitAtSec <= 0) return undefined;
  return liveGameModeLimitAtSec;
}

function clampNumber(value: number, minValue: number, maxValue: number): number {
  let out = value;
  if (out < minValue) out = minValue;
  if (out > maxValue) out = maxValue;
  return out;
}

function resetVisualSubtickClockState(): void {
  visualSubtickLastOutputSec = 0;
  visualSubtickLastPreferredSec = -1;
  visualSubtickLastPreferredFloorSec = -1;
  visualSubtickPreferredFloorTick = 0;
  visualSubtickEstimatedHz = TICK_RATE;
  visualSubtickCoarseStepCount = 0;
  visualSubtickFineStepCount = 0;
  visualSubtickFallbackFrameCount = 0;
  visualSubtickLastMode = "fallback";
  visualSubtickLastDebugLogAtSec = 0;
}

function resetCarrierIconVisualFollowState(): void {
  carrierIconVisualErrorSumMeters = 0;
  carrierIconVisualErrorMaxMeters = 0;
  carrierIconVisualErrorSamples = 0;
}

function maybeLogVisualSubtickDebugTelemetry(nowSec: number): void {
  if (!DEBUG_CARRIER_SUBTICK) return;
  if (visualSubtickLastDebugLogAtSec > 0 && nowSec - visualSubtickLastDebugLogAtSec < VISUAL_SUBTICK_DEBUG_LOG_INTERVAL_SECONDS) {
    return;
  }
  visualSubtickLastDebugLogAtSec = nowSec;

  const carrierErrAvg =
    carrierIconVisualErrorSamples > 0 ? carrierIconVisualErrorSumMeters / carrierIconVisualErrorSamples : 0;

  if (DEBUG_CARRIER_SUBTICK) {
    mod.DisplayHighlightedWorldLogMessage(
      mod.Message(
        "[SUBTICK CARRIER] mode/hz/fallback errAvg/max/samples {}",
        visualSubtickLastMode +
          "/" +
          String(mod.Floor(visualSubtickEstimatedHz * 10) / 10) +
          "/" +
          String(visualSubtickFallbackFrameCount) +
          "/" +
          String(mod.Floor(carrierErrAvg * 100) / 100) +
          "/" +
          String(mod.Floor(carrierIconVisualErrorMaxMeters * 100) / 100) +
          "/" +
          String(carrierIconVisualErrorSamples)
      )
    );
  }

  visualSubtickFallbackFrameCount = 0;
  carrierIconVisualErrorSumMeters = 0;
  carrierIconVisualErrorMaxMeters = 0;
  carrierIconVisualErrorSamples = 0;
}

function getVisualSubtickNowSec(): number {
  const elapsed = tryGetEngineMatchTimeElapsedSeconds();
  const remaining = tryGetEngineMatchTimeRemainingSeconds();
  const gameModeLimit = tryGetConfiguredLiveGameModeLimitSeconds();
  let elapsedFromRemaining: number | undefined = undefined;
  if (remaining !== undefined && gameModeLimit !== undefined) {
    const derived = gameModeLimit - remaining;
    if (Number.isFinite(derived)) elapsedFromRemaining = derived;
  }

  let preferredNow: number | undefined = undefined;
  let preferredMode = "fallback";
  if (elapsed !== undefined && elapsedFromRemaining !== undefined) {
    if (Math.abs(elapsed - elapsedFromRemaining) <= VISUAL_SUBTICK_ENGINE_CLOSE_TOLERANCE_SECONDS) {
      preferredNow =
        elapsed * VISUAL_SUBTICK_BLEND_ELAPSED_WEIGHT +
        elapsedFromRemaining * VISUAL_SUBTICK_BLEND_REMAINING_WEIGHT;
      preferredMode = "blend";
    } else {
      preferredNow = elapsed;
      preferredMode = "elapsed";
    }
  } else if (elapsed !== undefined) {
    preferredNow = elapsed;
    preferredMode = "elapsed";
  } else if (elapsedFromRemaining !== undefined) {
    preferredNow = elapsedFromRemaining;
    preferredMode = "remaining";
  }

  if (preferredNow === undefined) {
    preferredNow = getCurrentSchedulerNowSeconds();
    preferredMode = "fallback";
    visualSubtickFallbackFrameCount += 1;
  }

  if (!Number.isFinite(preferredNow) || preferredNow < 0) preferredNow = 0;

  if (visualSubtickLastPreferredSec >= 0) {
    const step = preferredNow - visualSubtickLastPreferredSec;
    if (step > 0.0001) {
      if (step >= VISUAL_SUBTICK_COARSE_STEP_THRESHOLD_SECONDS) {
        visualSubtickCoarseStepCount += 1;
        if (visualSubtickCoarseStepCount > 20) visualSubtickCoarseStepCount = 20;
        if (visualSubtickFineStepCount > 0) visualSubtickFineStepCount -= 1;
      } else if (step <= VISUAL_SUBTICK_FINE_STEP_THRESHOLD_SECONDS) {
        visualSubtickFineStepCount += 1;
        if (visualSubtickFineStepCount > 20) visualSubtickFineStepCount = 20;
        if (visualSubtickCoarseStepCount > 0) visualSubtickCoarseStepCount -= 1;
      }
    }
  }
  visualSubtickLastPreferredSec = preferredNow;

  let outputNow = preferredNow;
  const quantized = visualSubtickCoarseStepCount >= 4 && visualSubtickFineStepCount <= 1;
  if (quantized) {
    const floorSec = mod.Floor(preferredNow);
    if (visualSubtickLastPreferredFloorSec < 0) {
      visualSubtickLastPreferredFloorSec = floorSec;
      visualSubtickPreferredFloorTick = serverTickCount;
    } else if (floorSec !== visualSubtickLastPreferredFloorSec) {
      const floorStep = floorSec - visualSubtickLastPreferredFloorSec;
      const tickStep = serverTickCount - visualSubtickPreferredFloorTick;
      if (floorStep > 0 && tickStep > 0) {
        const hzEstimate = tickStep / floorStep;
        if (Number.isFinite(hzEstimate) && hzEstimate > 0) {
          visualSubtickEstimatedHz = clampNumber(
            hzEstimate,
            VISUAL_SUBTICK_ESTIMATED_HZ_MIN,
            VISUAL_SUBTICK_ESTIMATED_HZ_MAX
          );
        }
      }
      visualSubtickLastPreferredFloorSec = floorSec;
      visualSubtickPreferredFloorTick = serverTickCount;
    }

    const hz = clampNumber(visualSubtickEstimatedHz, VISUAL_SUBTICK_ESTIMATED_HZ_MIN, VISUAL_SUBTICK_ESTIMATED_HZ_MAX);
    let fraction = 0;
    if (hz > 0) {
      fraction = (serverTickCount - visualSubtickPreferredFloorTick) / hz;
    }
    if (!Number.isFinite(fraction)) fraction = 0;
    if (fraction < 0) fraction = 0;
    if (fraction > 0.999) fraction = 0.999;
    outputNow = floorSec + fraction;
    preferredMode += "_quantized";
  } else {
    visualSubtickLastPreferredFloorSec = -1;
    visualSubtickPreferredFloorTick = serverTickCount;
  }

  if (outputNow < visualSubtickLastOutputSec) outputNow = visualSubtickLastOutputSec;
  visualSubtickLastOutputSec = outputNow;
  visualSubtickLastMode = preferredMode;
  maybeLogVisualSubtickDebugTelemetry(outputNow);
  return outputNow;
}

function getCurrentSchedulerNowSeconds(): number {
  if (currentFrameHasEngineNowSec) return currentFrameNowSec;
  const engineNow = tryGetEngineMatchTimeElapsedSeconds();
  if (engineNow !== undefined) return engineNow;
  return serverTickCount / TICK_RATE;
}

function shouldUseEngineScheduler(nowSec: number | undefined): nowSec is number {
  return USE_ENGINE_TIME_SCHEDULER && nowSec !== undefined;
}

function consumeNoCatchUpDue(nowSec: number, nextDueAtSec: number, intervalSec: number): { due: boolean; nextDueAtSec: number } {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    return { due: true, nextDueAtSec: nowSec };
  }
  if (!Number.isFinite(nextDueAtSec) || nextDueAtSec <= 0) {
    return { due: true, nextDueAtSec: nowSec + intervalSec };
  }
  if (nowSec < nextDueAtSec) {
    return { due: false, nextDueAtSec };
  }
  return { due: true, nextDueAtSec: nowSec + intervalSec };
}

function resetEngineSchedulerCadenceState(): void {
  schedulerNextLiveFastUpdateAtSec = 0;
  schedulerNextLiveSlowUpdateAtSec = 0;
  schedulerNextLiveEndgameAudioAtSec = 0;
  schedulerNextLiveIconFollowAtSec = 0;
  schedulerNextLiveHqSafetyAtSec = 0;
  resetVisualSubtickClockState();
  resetCarrierIconVisualFollowState();
}

function setPhaseCountdownDeadlineFromNow(durationSeconds: number): void {
  const nowSec = getCurrentSchedulerNowSeconds();
  phaseCountdownDeadlineAtSec = nowSec + durationSeconds;
  phaseCountdownLastShownSeconds = mod.Ceiling(durationSeconds);
}

function clearPhaseCountdownDeadline(): void {
  phaseCountdownDeadlineAtSec = 0;
  phaseCountdownLastShownSeconds = -1;
}

function emitPerfTelemetryLog(message: any): void {
  if (!DEBUG_PERF_TELEMETRY) return;
  try {
    mod.DisplayHighlightedWorldLogMessage(message);
  } catch (_err) {}
}

function updatePerfTelemetryFrame(nowSec: number): void {
  if (!DEBUG_PERF_TELEMETRY) return;

  perfTelemetryFrameCount += 1;
  if (perfTelemetryLastFrameAtSec > 0) {
    const dt = nowSec - perfTelemetryLastFrameAtSec;
    if (dt > 0.0001) {
      const instHz = 1 / dt;
      if (perfTelemetrySmoothedHz <= 0) {
        perfTelemetrySmoothedHz = instHz;
      } else {
        perfTelemetrySmoothedHz = perfTelemetrySmoothedHz * 0.9 + instHz * 0.1;
      }
    }
  }
  perfTelemetryLastFrameAtSec = nowSec;

  if (perfTelemetryLastSampleAtSec <= 0) {
    perfTelemetryLastSampleAtSec = nowSec;
    return;
  }

  if (nowSec - perfTelemetryLastSampleAtSec < 5) return;

  emitPerfTelemetryLog(
    mod.Message(
      "[PERF] hz/frame {} lanes icon/fast/slow/end/dmg {} maxBombScan {}",
      String(mod.Floor(perfTelemetrySmoothedHz * 10) / 10) + "/" + String(perfTelemetryFrameCount),
      String(perfTelemetryIconLaneRuns) +
        "/" +
        String(perfTelemetryFastLaneRuns) +
        "/" +
        String(perfTelemetrySlowLaneRuns) +
        "/" +
        String(perfTelemetryEndgameLaneRuns) +
        "/" +
        String(perfTelemetryDamageLaneRuns),
      perfTelemetryBombPickupScanMaxCandidates
    )
  );

  perfTelemetryLastSampleAtSec = nowSec;
  perfTelemetryFrameCount = 0;
  perfTelemetryFastLaneRuns = 0;
  perfTelemetrySlowLaneRuns = 0;
  perfTelemetryIconLaneRuns = 0;
  perfTelemetryEndgameLaneRuns = 0;
  perfTelemetryDamageLaneRuns = 0;
  perfTelemetryBombPickupScanMaxCandidates = 0;
}

function trackBombPickupScanCandidates(sampleCount: number): void {
  if (!DEBUG_PERF_TELEMETRY) return;
  if (sampleCount > perfTelemetryBombPickupScanMaxCandidates) {
    perfTelemetryBombPickupScanMaxCandidates = sampleCount;
  }
}

function warnTransitionRecoveryOnce(key: string, message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (transitionWarnedByKey[key] === true) return;
  transitionWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(message);
}

function resetTransitionFallbackGuardIfPrematchReady(): void {
  if (gameStatus !== 0) return;
  if (!initialization[0]) return;
  transitionFallbackActive = false;
  transitionFallbackNextAllowedTick = 0;
}

function forceReturnToPrematchFromTransitionFailure(source: string, err?: any): void {
  if (err !== undefined) {
    LogRuntimeError("Transition/" + source, err);
  }

  const warnKey = "fallback/" + source;
  warnTransitionRecoveryOnce(
    warnKey,
    mod.Message(
      "[TRANSITION RECOVERY] source/status/inits {}",
      source + "/" + String(gameStatus) + "/" + getInitializationFlagSummary()
    )
  );

  if (transitionFallbackActive) return;
  if (serverTickCount < transitionFallbackNextAllowedTick) {
    warnTransitionRecoveryOnce(
      "fallback_cooldown/" + source,
      mod.Message(
        "[TRANSITION RECOVERY] cooldown active source/nextTick {}",
        source + "/" + String(transitionFallbackNextAllowedTick)
      )
    );
    return;
  }

  transitionFallbackActive = true;

  let recoveredToPrematch = false;
  try {
    ReturnToPreMatchState();
  } catch (fallbackErr) {
    LogRuntimeError("TransitionFallback/" + source, fallbackErr);
  } finally {
    recoveredToPrematch = gameStatus === 0;
    if (!recoveredToPrematch) {
      transitionFallbackNextAllowedTick = serverTickCount + TRANSITION_FALLBACK_RETRY_COOLDOWN_TICKS;
      warnTransitionRecoveryOnce(
        "fallback_retry/" + source,
        mod.Message(
          "[TRANSITION RECOVERY RETRY] source/nextTick/status/inits {}",
          source +
            "/" +
            String(transitionFallbackNextAllowedTick) +
            "/" +
            String(gameStatus) +
            "/" +
            getInitializationFlagSummary()
        )
      );
    } else {
      transitionFallbackNextAllowedTick = 0;
    }
    transitionFallbackActive = false;
  }
}


const MAIN_LOOP_INTERVAL_MS = 1;
let mainLoopIntervalHandle: number | undefined = undefined;
let damageZonePulseIntervalHandle: number | undefined = undefined;

function pulseDamageZonePlayers(): void {
  if (gameStatus !== 3) return;

  serverPlayers.forEach((p) => {
    if (playerInDamageZone[p.id] === true && p.isDeployed && isPlayerAlive(p.player)) {
      mod.DealDamage(p.player, DAMAGE_PER_PULSE);
    }
  });
}

function stopDamageZonePulseTimer(): void {
  Timers.clearInterval(damageZonePulseIntervalHandle);
  damageZonePulseIntervalHandle = undefined;
}

function startDamageZonePulseTimer(): void {
  stopDamageZonePulseTimer();
  damageZonePulseIntervalHandle = Timers.setInterval(() => {
    pulseDamageZonePlayers();
  }, DAMAGE_ZONE_PULSE_INTERVAL_MS);
}

function stopMainLoopTimer(): void {
  Timers.clearInterval(mainLoopIntervalHandle);
  mainLoopIntervalHandle = undefined;
}

function startMainLoopTimer(): void {
  stopMainLoopTimer();
  mainLoopIntervalHandle = Timers.setInterval(() => {
    OngoingGlobal_Inner();
  }, MAIN_LOOP_INTERVAL_MS, true);
}

function Mode_OnGameModeStarted(): void {
  initializePerformanceStatsLoggingOnce();
  startMainLoopTimer();
  resetLifecycleStateForFreshMatchStart();
  SetDepthAboveGameUI("PreMatchContainer");
  SetCountdownOverlayVisible(false);

  refreshObjectiveResolvedMcomAliases("Mode_OnGameModeStarted");
  ValidateObjectiveConfiguration();
  validateRequiredQuadBikeAnchorConfigurationOnce();
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  ensureAudioSpawned();
  spawnTeamVoModulesForMatchStart();
  postmatchResultSfxPlayed = false;
  setObjectiveNativeMcomObjectivesEnabled(false, "OnGameModeStarted");
  disableAllObjectiveCapturePointObjectives("OnGameModeStarted");
  disableAllObjectiveInteractPoints("OnGameModeStarted");
  syncDisabledBombAnchorObjectives();
  StopAllObjectiveMcomSfx();
  hideAllObjectiveArmedWorldIcons();
  resetBombCarrierRuntimeState(true);

  gameStatus = 0;
  serverTickCount = 0;
  gameModeStarted = true;

  ConfigurePreMatchSpawns();

  for (let i = 0; i < fireVfx.length; i++) {
    mod.EnableVFX(fireVfx[i], true);
  }
  SafeSetWidgetVisibleByName("PreMatchContainer", true);
  refreshPrematchReadyStateUi();
}
function Mode_OnGameModeEnding(): void {
  stopMainLoopTimer();
  stopDamageZonePulseTimer();
  stopAllObjectiveAwardBursts();
  StopAllObjectiveMcomSfx();
  hideAllObjectiveArmedWorldIcons();
  resetBombCarrierRuntimeState(true);
  clearVoModuleState();
}

function Mode_OngoingGlobal(): void {
  try {
    runCipherHotLaneFromOngoingGlobal();
  } catch (err) {
    LogRuntimeError("Mode_OngoingGlobal", err);
  }
}

function getHotLaneNowSeconds(): number {
  const engineNowSec = tryGetEngineMatchTimeElapsedSeconds();
  const useEngineSchedulerFrame = shouldUseEngineScheduler(engineNowSec);
  currentFrameHasEngineNowSec = useEngineSchedulerFrame;
  currentFrameNowSec = useEngineSchedulerFrame ? (engineNowSec as number) : serverTickCount / TICK_RATE;
  return currentFrameNowSec;
}

function warnCipherHotLaneFallbackOnce(nowSec: number): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (cipherHotLaneFallbackWarned) return;
  cipherHotLaneFallbackWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[CIPHER HOTLANE] OngoingGlobal fallback active at {}", mod.Ceiling(nowSec))
  );
}

function runCipherCarrierHotLaneFrame(sampleNowSec: number, source: string): void {
  if (!gameModeStarted) return;
  if (gameStatus !== 3 || initialization[3] !== true) return;
  if (bombCarrierPlayerId === undefined) return;

  EvaluateBombCarrierManualSlotSwitchAndLock();
  if (bombCarrierPlayerId !== undefined) {
    syncCipherCarrierVisualsNow(sampleNowSec, source);
  }
  UpdateBombCarrierUiForAllPlayers(sampleNowSec);
}

function runCipherHotLaneFromOngoingGlobal(): void {
  if (!gameModeStarted) return;
  if (gameStatus !== 3 || initialization[3] !== true) return;
  if (bombCarrierPlayerId === undefined) return;

  const hotLaneNowSec = getHotLaneNowSeconds();
  const visualNowSec = ENABLE_CARRIER_SUBTICK ? getVisualSubtickNowSec() : hotLaneNowSec;
  lastCipherHotLaneRunAtSec = hotLaneNowSec;
  runCipherCarrierHotLaneFrame(visualNowSec, "ongoing_global_hot_lane");
}

function runCipherHotLaneFallbackIfNeeded(nowSec: number): void {
  if (!gameModeStarted) return;
  if (gameStatus !== 3 || initialization[3] !== true) return;
  if (bombCarrierPlayerId === undefined) return;
  if (lastCipherHotLaneRunAtSec > 0 && nowSec - lastCipherHotLaneRunAtSec <= CIPHER_HOT_LANE_FALLBACK_AFTER_SECONDS) {
    return;
  }

  warnCipherHotLaneFallbackOnce(nowSec);
  lastCipherHotLaneRunAtSec = nowSec;
  runCipherCarrierHotLaneFrame(nowSec, "heavy_loop_hot_lane_fallback");
}

function OngoingGlobal_Inner(): void {
  if (!gameModeStarted) return;

  serverTickCount += 1;
  phaseTickCount += 1;

  const engineNowSec = tryGetEngineMatchTimeElapsedSeconds();
  const useEngineSchedulerFrame = shouldUseEngineScheduler(engineNowSec);
  currentFrameHasEngineNowSec = useEngineSchedulerFrame;
  currentFrameNowSec = useEngineSchedulerFrame ? (engineNowSec as number) : serverTickCount / TICK_RATE;
  const nowSec = currentFrameNowSec;
  updatePerfTelemetryFrame(nowSec);

  if (gameStatus === 0) {
    if (!initialization[0]) InitializePreMatch();
    resetTransitionFallbackGuardIfPrematchReady();

    const readyPlayers = prematchReadyPlayersByTeam;
    const totalPlayers = prematchTotalPlayersByTeam;
    const allReady = prematchAllPlayersReady;
    const switchElapsedTicks = useEngineSchedulerFrame
      ? mod.Floor((nowSec - lastPrematchTeamSwitchAtSec) * TICK_RATE)
      : serverTickCount - lastPrematchTeamSwitchTick;
    const teamSwitchStabilized = useEngineSchedulerFrame
      ? nowSec - lastPrematchTeamSwitchAtSec >= PRELIVE_TEAM_SWITCH_STABILIZE_SECONDS
      : switchElapsedTicks >= PRELIVE_TEAM_SWITCH_STABILIZE_TICKS;

    if (allReady) {
      if (!teamSwitchStabilized) {
        warnPrematchStabilizationGateBlockedOnce(readyPlayers, totalPlayers, switchElapsedTicks);
      } else {
        normalizeAllPlayersToStandardHealthAndClearPrematch889State();
        initialization[2] = false;
        gameStatus = 2;
      }
    }
  } else if (gameStatus === 1) {
    if (!initialization[1]) {
      InitializeCountDown();
      if (!initialization[1]) return;
    }

    if (mod.Modulo(phaseTickCount, TICK_RATE) === 0) {
      countDown -= 1;
      if (countDown < 0) countDown = 0;
      playCountdownHeartbeatToAll(0.6);
      SafeSetTextLabelByName("CountDownText", mod.Message(countDown));

      if (countDown === 0) {
        // Existing ready-up 5-second delay ends here; undeploy once, then hand off to pre-live.
        mod.UndeployAllPlayers();
        gameStatus = 2;
      }
    }
  } else if (gameStatus === 2) {
    if (!initialization[2]) {
      InitializePreLive();
      if (!initialization[2]) {
        forceReturnToPrematchFromTransitionFailure("InitializePreLive");
      }
      return;
    }

    processTransitionSpawnQueue("prelive_countdown");
    processCipherSpawnJobs("prelive_countdown");

    if (mod.Modulo(phaseTickCount, TICK_RATE) === 0) {
      countDown -= 1;
      if (countDown < 0) countDown = 0;
      const vol = countDown <= 3 ? 0.85 : 0.6;
      playCountdownHeartbeatToAll(vol);

      SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
      if (countDown === 0) {
        emitLiveTransitionCheckpoint("prelive_zero_enter");
        playMatchStartStingerToAll(1.0);
        emitLiveTransitionCheckpoint("prelive_zero_stinger_after");
        if (!hasShownMatchStartBanner) {
          emitLiveTransitionCheckpoint("prelive_zero_banner_start");
          void showMatchStartBannerOnce();
          emitLiveTransitionCheckpoint("prelive_zero_banner_after");
        }
        emitLiveTransitionCheckpoint("prelive_zero_set_live_before");
        gameStatus = 3;
        emitLiveTransitionCheckpoint("prelive_zero_set_live_after");
      }
    }
  } else if (gameStatus === 3) {
    if (!initialization[3]) {
      InitializeLive();
      if (!initialization[3]) {
        forceReturnToPrematchFromTransitionFailure("InitializeLive");
      }
      return;
    }

    runCipherHotLaneFallbackIfNeeded(nowSec);

    if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) {
      processTransitionSpawnQueue("cipher_live_phase_transition");
      processCipherSpawnJobs("cipher_live_phase_transition");
      applyCipherSecondHalfDeployFreezeForReadyPlayers("cipher_live_phase_transition");
      updateCipherCounterWorldIcons();
      return;
    }

    const visualNowSec = ENABLE_CARRIER_SUBTICK ? getVisualSubtickNowSec() : nowSec;

    // Damage smoothing queue processing runs every tick (30 Hz) for consistent feel.
    if (ENABLE_DAMAGE_SMOOTHING) {
      dmgSpreadProcessQueueTick();
      dmgSpreadUpdateHealthCacheTick();
    }

    updateDroppedBombWorldIconCountdown();
   EvaluateResponsiveBombPickupRadiusScans();
    SetUITime(nowSec);
    UpdateObjectiveCaptureInteractionState();
    EvaluateObjectiveCaptureHoldAttempts();
    EvaluatePostCaptureAwardTimers();
    if (gameStatus !== 3) {
      HideAllObjectiveHoldProgressUi();
      return;
    }
    UpdateObjectiveArmAlarmSfxState();
    updateCipherCounterWorldIcons();
    UpdateObjectiveHoldProgressUiForAllPlayers(visualNowSec);
    UpdateDeployObjectiveTimerUiForAllPlayers();
    repairDirtyCipherKeyHudCaches(2);

    let iconLaneDue = true;
    if (useEngineSchedulerFrame) {
      const iconDue = consumeNoCatchUpDue(nowSec, schedulerNextLiveIconFollowAtSec, ICON_FOLLOW_INTERVAL_SECONDS);
      iconLaneDue = iconDue.due;
      schedulerNextLiveIconFollowAtSec = iconDue.nextDueAtSec;
    }
    if (iconLaneDue) {
      const iconLaneNowSec = ENABLE_CARRIER_SUBTICK ? visualNowSec : nowSec;
      updateBombCarrierBeepLoopTick(iconLaneNowSec);
      if (DEBUG_PERF_TELEMETRY) perfTelemetryIconLaneRuns += 1;
    }

    // Throttle expensive live updates to prevent server lag / Hz drops.
    let fastLaneDue = false;
    if (useEngineSchedulerFrame) {
      const fastDue = consumeNoCatchUpDue(nowSec, schedulerNextLiveFastUpdateAtSec, FAST_INTERVAL_SECONDS);
      fastLaneDue = fastDue.due;
      schedulerNextLiveFastUpdateAtSec = fastDue.nextDueAtSec;
    } else {
      fastLaneDue = mod.Modulo(phaseTickCount, LIVE_FAST_UPDATE_INTERVAL_TICKS) === 0;
    }
    if (fastLaneDue) {
      SyncPlayersOnPointsFromEngine();
      refreshCapturePointsEngineStateForUI();
      UpdateTopFlagColorsForAllPlayers();
      EvaluateBombPickupAndCarrierState();
      ensureDroppedBombRuntimeWorldIconVisibleIfNeeded();
      ensureBaseBombRuntimeWorldIconVisibleIfNeeded();

      if (ENABLE_DYNAMIC_HQ_ROUTING) {
        // HQ routing only when dirty (event-driven) or periodic safety refresh.
        let safetyDue = false;
        if (useEngineSchedulerFrame) {
          const hqSafety = consumeNoCatchUpDue(nowSec, schedulerNextLiveHqSafetyAtSec, HQ_ROUTING_SAFETY_INTERVAL_SECONDS);
          safetyDue = hqSafety.due;
          schedulerNextLiveHqSafetyAtSec = hqSafety.nextDueAtSec;
        } else {
          safetyDue = mod.Modulo(phaseTickCount, HQ_ROUTING_SAFETY_INTERVAL_TICKS) === 0;
        }
        if (hqRoutingDirty || safetyDue) {
          recomputeThreatenedFlagsAndHqRouting();
        }
      } else {
        // Keep fixed initial HQs in live if anything toggles HQ state unexpectedly.
        let enforceFixedHqDue = false;
        if (useEngineSchedulerFrame) {
          const hqSafety = consumeNoCatchUpDue(nowSec, schedulerNextLiveHqSafetyAtSec, HQ_ROUTING_SAFETY_INTERVAL_SECONDS);
          enforceFixedHqDue = hqSafety.due;
          schedulerNextLiveHqSafetyAtSec = hqSafety.nextDueAtSec;
        } else {
          enforceFixedHqDue = mod.Modulo(phaseTickCount, HQ_ROUTING_SAFETY_INTERVAL_TICKS) === 0;
        }
        if (enforceFixedHqDue) {
          UpdateFlagHQSpawns();
        }
      }
      if (DEBUG_PERF_TELEMETRY) perfTelemetryFastLaneRuns += 1;
    }

    let endgameLaneDue = false;
    if (useEngineSchedulerFrame) {
      const endgameDue = consumeNoCatchUpDue(nowSec, schedulerNextLiveEndgameAudioAtSec, ENDGAME_AUDIO_INTERVAL_SECONDS);
      endgameLaneDue = endgameDue.due;
      schedulerNextLiveEndgameAudioAtSec = endgameDue.nextDueAtSec;
    } else {
      endgameLaneDue = mod.Modulo(phaseTickCount, LIVE_ENDGAME_AUDIO_INTERVAL_TICKS) === 0;
    }
    if (endgameLaneDue) {
      UpdateEndgameSuspenseAudio();
      if (DEBUG_PERF_TELEMETRY) perfTelemetryEndgameLaneRuns += 1;
    }

    let slowLaneDue = false;
    if (useEngineSchedulerFrame) {
      const slowDue = consumeNoCatchUpDue(nowSec, schedulerNextLiveSlowUpdateAtSec, SLOW_INTERVAL_SECONDS);
      slowLaneDue = slowDue.due;
      schedulerNextLiveSlowUpdateAtSec = slowDue.nextDueAtSec;
    } else {
      slowLaneDue = mod.Modulo(phaseTickCount, LIVE_SLOW_UPDATE_INTERVAL_TICKS) === 0;
    }
    if (slowLaneDue) {
      // UI/tickets/scoreboard do not need per-tick updates
      ChangeTickets();
      SetUIScores();
      UpdateScoreboard();
      UpdateCaptureTickLoopsGlobal();
      if (DEBUG_PERF_TELEMETRY) perfTelemetrySlowLaneRuns += 1;
    }

    ClampTicketsAndMaybeEndMatch();
    if (gameStatus !== 3) return;
    resolveLiveTimeoutIfNeeded(nowSec);

  } else {
    if (!initialization[4]) {
      InitializePostmatch();
      if (!initialization[4]) return;
    }
    // --- Sequenced end flow (tick-based, deterministic order) ---
    if (postmatchEndStep !== 0) {
      if (useEngineSchedulerFrame) {
        // Step 1: Undeploy everyone on a new frame before ending the mode.
        if (postmatchEndStep === 1) {
          if (nowSec - postmatchEndStepAtSec >= POSTMATCH_END_STEP_ADVANCE_SECONDS) {
            mod.UndeployAllPlayers();
            postmatchEndStep = 2;
            postmatchEndStepTick = serverTickCount;
            postmatchEndStepAtSec = nowSec;
          }
          return;
        }

        // Step 2: End the gamemode after the undeploy frame has settled.
        if (postmatchEndStep === 2) {
          if (nowSec - postmatchEndStepAtSec >= POSTMATCH_END_STEP_ADVANCE_SECONDS) {
            mod.EndGameMode(postmatchWinnerTeam);
            postmatchEndStep = 3;
            postmatchEndStepTick = serverTickCount;
            postmatchEndStepAtSec = nowSec;
          }
          return;
        }

        if (postmatchEndStep === 3) {
          return;
        }
      } else {
        // Step 1: Undeploy everyone on a new tick before ending the mode.
        if (postmatchEndStep === 1) {
          if (serverTickCount - postmatchEndStepTick >= POSTMATCH_END_STEP_ADVANCE_TICKS) {
            mod.UndeployAllPlayers();
            postmatchEndStep = 2;
            postmatchEndStepTick = serverTickCount;
            postmatchEndStepAtSec = nowSec;
          }
          return;
        }

        // Step 2: End the gamemode after the undeploy tick has settled.
        if (postmatchEndStep === 2) {
          if (serverTickCount - postmatchEndStepTick >= POSTMATCH_END_STEP_ADVANCE_TICKS) {
            mod.EndGameMode(postmatchWinnerTeam);
            postmatchEndStep = 3;
            postmatchEndStepTick = serverTickCount;
            postmatchEndStepAtSec = nowSec;
          }
          return;
        }

        if (postmatchEndStep === 3) {
          return;
        }
      }
    }

    let postmatchSecondDue = false;
    if (useEngineSchedulerFrame) {
      if (phaseCountdownDeadlineAtSec <= 0) setPhaseCountdownDeadlineFromNow(countDown);
      const displaySeconds = mod.Max(0, mod.Ceiling(phaseCountdownDeadlineAtSec - nowSec));
      if (displaySeconds !== phaseCountdownLastShownSeconds) {
        phaseCountdownLastShownSeconds = displaySeconds;
        countDown = displaySeconds;
        postmatchSecondDue = true;
      }
    } else if (mod.Modulo(phaseTickCount, TICK_RATE) === 0) {
      countDown -= 1;
      if (countDown < 0) countDown = 0;
      postmatchSecondDue = true;
    }

    if (postmatchSecondDue && countDown === 0) {
      // Hide postmatch overlay
      const post = mod.FindUIWidgetWithName("PostMatchContainer");
      if (post) mod.SetUIWidgetVisible(post, false);

      // Start the sequenced end flow (next ticks)
      postmatchEndStep = 1;
      postmatchEndStepTick = serverTickCount;
      postmatchEndStepAtSec = nowSec;
      return;
    }
  }


  if (serverTickCount === 10000000) serverTickCount = 137;
}

/* =================================================================================================
   14) PLAYER EVENTS (JOIN / LEAVE / DEPLOY / UNDEPLOY / INTERACT)
================================================================================================= */

function findServerPlayerByObjId(playerObjId: number): Player | undefined {
  let found: Player | undefined = undefined;
  serverPlayers.forEach((sp) => {
    if (sp && mod.GetObjId(sp.player) === playerObjId) found = sp;
  });
  return found;
}

function Mode_OnPlayerJoinGame(eventPlayer: mod.Player): void {
  try {
    let player: Player | undefined;

    const joiningId = modlib.getPlayerId(eventPlayer);

    // IMPORTANT:
    // This event can be triggered multiple times for the same player (deploy/respawn/ongoing player rule).
    // If we already know the player, do NOT announce "joined" again.
    const existing = serverPlayers.get(joiningId);
    if (existing) {
      existing.player = eventPlayer;
      existing.setTeam();
      player = existing;
    } else {
      // Reconnect detection should be based on playerId, not objId (objId can change).
      for (let i = 0; i < disconnectedPlayers.length; i++) {
        const p = disconnectedPlayers[i];
        if (p.id === joiningId) {
          p.player = eventPlayer;
          p.setTeam();
          serverPlayers.set(p.id, p);
          mod.DisplayHighlightedWorldLogMessage(
            mod.Message(mod.stringkeys.PlayerReconnected, eventPlayer, p.id)
          );
          disconnectedPlayers.splice(i, 1);
          player = p;
          break;
        }
      }

      // Truly new player
      if (!player) {
        const newPlayer = new Player(eventPlayer);
        serverPlayers.set(newPlayer.id, newPlayer);
        mod.DisplayHighlightedWorldLogMessage(
          mod.Message(mod.stringkeys.PlayerJoined, newPlayer.player, newPlayer.id)
        );
        player = newPlayer;
      }
    }

    if (player) {
      buildRestrictedAreaUiForPlayer(player);
    }
    if (prematchHealthInside889ByPlayerId[joiningId] === undefined) {
      prematchHealthInside889ByPlayerId[joiningId] = false;
    }
    delete prematchHealthAppliedMaxByPlayerId[joiningId];
    if (gameStatus === 0) {
      applyPrematch889HealthForPlayer(joiningId);
    }

    applyPhaseInputRestrictionsForPlayer(eventPlayer);

    if (gameStatus === 1) {
      stripLoadoutToMeleeOnly(eventPlayer);
    }

    if (gameStatus === 0 || gameStatus === -1) {
      if (player) replacePrematchReadyText(player.id, eventPlayer);
      refreshPrematchReadyStateUi();
    } else if (gameStatus === 3) {
      SafeSetWidgetVisibleByName("PreMatchContainer", false);
      SafeSetWidgetVisibleByName("LiveContainer", true);

      // Keep shared fills hidden for join-in-progress players as well.
      HideSharedTicketBarFills();

      if (player) {
        player.addUI();
        repairCipherKeyHudCacheForPlayer(player, true);
      }

      if (player && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive)) {
        if (cipherSecondHalfTransitionStage === "deploy") {
          markCipherSecondHalfDeployRequiredForPlayer(player);
        } else {
          requestTransitionSpawn(player.id, "join_live_phase_transition");
        }
      }
    } else if (gameStatus === 2 && player) {
      requestTransitionSpawn(player.id, "join_prelive");
    }
    refreshCipherKeyPlayerSnapshots("OnPlayerJoinGame");
  } catch (err) {
    LogRuntimeError("OnPlayerJoinGame", err);
  }
}

function Mode_OnPlayerLeaveGame(eventNumber: number): void {
  try {
    let leaving: Player | undefined = undefined;

    leaving = findServerPlayerByObjId(eventNumber);
    if (!leaving) leaving = serverPlayers.get(eventNumber);

    if (!leaving) return;
    cleanupRestrictedAreaUiForPlayer(leaving.id);
    // Ensure HUD can be rebuilt cleanly if the engine destroys UI widgets on disconnect.
    liveHudBuiltByPlayerId[leaving.id] = false;



    mod.DisplayHighlightedWorldLogMessage(mod.Message(mod.stringkeys.PlayerDisconnected, leaving.id));
    if (gameStatus === 3 && bombCarrierPlayerId === leaving.id) {
      const leavePos = tryGetPlayerPositionSafe(leaving.player);
      if (leavePos) lastKnownLivePositionByPlayerId[leaving.id] = leavePos;
      forceBombDropFromCarrier(leaving.id, "disconnect");
    }

    cancelObjectiveCaptureAttemptsForPlayer(leaving.id);

    disconnectedPlayers.push(leaving);
    serverPlayers.delete(leaving.id);

    if (gameStatus === 3 && initialization[3] === true) {
      syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerLeaveGame");
    }

    clearBombCarrierDeployRestoreCacheForPlayer(leaving.id);
    delete lastKnownLivePositionByPlayerId[leaving.id];
    delete safeSpawnUnsafeHqObjIdByPlayerId[leaving.id];
    delete lastLiveHqSpawnPointObjIdByPlayerId[leaving.id];
    delete lastForcedSafeSpawnHqObjIdByPlayerId[leaving.id];
    delete transitionSpawnRequestedByPlayerId[leaving.id];
    delete transitionSpawnLastAttemptTickByPlayerId[leaving.id];
    delete transitionSpawnInFlightByPlayerId[leaving.id];
    delete cipherSecondHalfDeployRequiredByPlayerId[leaving.id];
    delete cipherSecondHalfDeployReadyByPlayerId[leaving.id];
    delete cipherTransitionTeleportedByPlayerId[leaving.id];
    delete cipherSecondHalfFrozenByPlayerId[leaving.id];
    delete bombNoticeMessageKeyByPlayerId[leaving.id];
    delete bombNoticeFallbackTextByPlayerId[leaving.id];
    delete bombNoticeVisibleUntilSecByPlayerId[leaving.id];
    delete bombNoticeTokenByPlayerId[leaving.id];
    clearCipherKeyHudCacheForPlayer(leaving.id);
    delete prematchSwitchLastHandledTickByPlayerId[leaving.id];
    delete prematchSwitchDebounceWarnedByPlayerId[leaving.id];
    delete lastPrematchTeamSwitchTickByPlayerId[leaving.id];
    delete preliveTeamSanityWarnedByPlayerId[leaving.id];
    delete playerInDamageZone[leaving.id];
    clearPrematch889StateForPlayer(leaving.id);
    clearAllObjectiveAreaTriggerStateForPlayer(leaving.id);
    clearCipherPresenceForPlayer(leaving.id);

    if (gameStatus === 3) {
      leaving.addDeath();

      const cp = leaving.getCapturePoint();
      if (cp) {
        const capturePoint = serverCapturePoints[mod.GetObjId(cp)];
        if (capturePoint) capturePoint.removeOnPoint(leaving.id);
        leaving.setCapturePoint(null);
      }
    }

    if (gameStatus === 0 || gameStatus === -1) refreshPrematchReadyStateUi();
  } catch (err) {
    LogRuntimeError("OnPlayerLeaveGame", err);
  } finally {
    refreshCipherKeyPlayerSnapshots("OnPlayerLeaveGame");
  }
}

async function Mode_OnPlayerDeployed(eventPlayer: mod.Player): Promise<void> {
  try {
    const playerId = modlib.getPlayerId(eventPlayer);
    const team = mod.GetTeam(eventPlayer);
    cancelPendingRestrictedLethalConfirmForPlayer(playerId);
    clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);
    hideDeployObjectiveTimerUiForPlayer(playerId);
    clearTransitionSpawnStateForPlayer(playerId);
    clearAllObjectiveAreaTriggerStateForPlayer(playerId);
    clearCipherPresenceForPlayer(playerId);
    cancelObjectiveCaptureAttemptsForPlayer(playerId);

    applyPhaseInputRestrictionsForPlayer(eventPlayer);
    // Reset damage spacing state on deploy
    dmgSpreadClearForPlayer(eventPlayer);
  
    if (gameStatus === 0) {
      const pPrematch = serverPlayers.get(playerId);
      if (pPrematch) {
        pPrematch.team = team;
        pPrematch.isDeployed = true;
      }
      applyPrematch889HealthForPlayer(playerId);
      refreshPrematchReadyStateUi();
      return;
    }

    if (gameStatus === 1) {
      const pCountdown = serverPlayers.get(playerId);
      if (pCountdown) {
        pCountdown.team = team;
        pCountdown.isDeployed = true;
      }
      applyPrematch889HealthForPlayer(playerId);
      stripLoadoutToMeleeOnly(eventPlayer);
      return;
    }

    if (gameStatus === 2) {
      const pPre = serverPlayers.get(playerId);
      if (pPre) {
        pPre.team = team;
        pPre.isDeployed = true;
      }
      applyPrematch889HealthForPlayer(playerId);
      void cacheBombCarrierDeployRestoreEquipmentForPlayer(playerId, eventPlayer);
      requestCipherSpawnAnchorForPlayer(playerId, true);
      requestCipherSpawnTeleportForPlayer(playerId, true);
      processCipherSpawnJobs("OnPlayerDeployed_Prelive");
      teleportCipherPlayerToRoutedAnchor(eventPlayer, playerId);
      if (bombCarrierPlayerId === playerId) {
        syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "OnPlayerDeployed_Prelive");
      }
      return;
    }

    if (gameStatus !== 3) return;

    const p = serverPlayers.get(playerId);
    if (!p) return;

    p.team = team;
    p.isDeployed = true;
    repairCipherKeyHudCacheForPlayer(p, true);
    if (isCipherSuddenDeathActive() && cipherSuddenDeathEliminatedByPlayerId[playerId] === true) {
      mod.SetRedeployTime(eventPlayer, 9999);
      mod.UndeployPlayer(eventPlayer);
      return;
    }

    if (isCipherLiveTransitionActive()) {
      void cacheBombCarrierDeployRestoreEquipmentForPlayer(playerId, eventPlayer);
      handleCipherTransitionDeployedPlayer(playerId, eventPlayer, "OnPlayerDeployed_Transition");
      return;
    }

    void cacheBombCarrierDeployRestoreEquipmentForPlayer(playerId, eventPlayer);
    applyPrematch889HealthForPlayer(playerId);
    recordLastLiveHqSpawnSourceFromDeploy(eventPlayer, playerId);
    applyPhaseInputRestrictionsForPlayer(eventPlayer);
  // If we spawned near ANY friendly player (<= 8m), do not allow safe-spawn recycling.
    if (isSpawnNearFriendlyPlayer(eventPlayer, playerId, FRIENDLY_SPAWN_BYPASS_RADIUS_METERS)) {
      safeSpawnForcedRedeploys[playerId] = 0;
      safeSpawnForcedUndeploy[playerId] = false;
      safeSpawnUnsafePending[playerId] = false;
      // Optional: you can also stop the squad probe logic if you want.
    }


  // --- SQUAD SPAWN HARD BYPASS (within 8m) ---
  // If the player spawned close to a living squadmate, we do NOT want safe-spawn recycling at all.
  // This avoids the timing/race where the async probe hasn't set bypass yet.
    const squadSpawnNow = checkIfSpawnedOnSquadmate(eventPlayer);
    if (squadSpawnNow) {
      squadSpawnBypass[playerId] = true;
      void clearSquadSpawnBypassLater(playerId);

      // Reset forced redeploy counter so a squad spawn doesn't inherit prior "unsafe" history.
      safeSpawnForcedRedeploys[playerId] = 0;
      safeSpawnForcedUndeploy[playerId] = false;
      safeSpawnUnsafePending[playerId] = false;
    } else {
      squadSpawnBypass[playerId] = false;

      // Keep your probe if you still want it for edge cases.
      void startSquadSpawnBypassProbe(eventPlayer, playerId);
    }

    mod.SetRedeployTime(eventPlayer, REDEPLOY_TIME);
    requestCipherSpawnAnchorForPlayer(playerId, true);
    processCipherSpawnJobs("OnPlayerDeployed_LiveAnchor");

    const wasForced = safeSpawnForcedUndeploy[playerId] === true;

  // IMPORTANT: Do NOT overwrite the player's HQ routing while we are in a forced safe-spawn recycle.
  // We only "commit" the route after the safe-spawn check succeeds.
    if (!wasForced && safeSpawnUnsafePending[playerId] !== true) {
      const dyn = modlib.Equals(team, team1) ? currentDynamicHqTeam1 : currentDynamicHqTeam2;
      if (dyn && isValidDynamicSpawnId(dyn)) {
        pendingDynamicHqForPlayer[playerId] = dyn;
      }
    }


    // Keep first-deploy state transitions, but no score mutation on deploy/death in this mode.
    p.isFirstDeploy();

    await SafeSpawnCheckOrRedeploy(eventPlayer, playerId);

    if (safeSpawnUnsafePending[playerId] !== true) {
      requestCipherSpawnTeleportForPlayer(playerId, true);
      processCipherSpawnJobs("OnPlayerDeployed_LiveTeleport");
      teleportCipherPlayerToRoutedAnchor(eventPlayer, playerId);
      if (bombCarrierPlayerId === playerId) {
        syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "OnPlayerDeployed_LiveTeleport");
      }
      markCipherSecondHalfDeployReadyForPlayer(playerId, eventPlayer);
    }
    
    HqDesyncCheckAndRecycle(eventPlayer, playerId);


    if (safeSpawnUnsafePending[playerId] !== true) {
      safeSpawnForcedUndeploy[playerId] = false;
    }
  } catch (err) {
    LogRuntimeError("OnPlayerDeployed", err);
  } finally {
    refreshCipherKeyPlayerSnapshots("OnPlayerDeployed");
  }
}

async function Mode_OnPlayerUndeploy(eventPlayer: mod.Player): Promise<void> {
  try {
    const id = modlib.getPlayerId(eventPlayer);
    const p = serverPlayers.get(id);
    if (!p) return;
    const wasDeployed = p.isDeployed === true;

    // Reset damage spacing state on undeploy
    dmgSpreadClearForPlayer(eventPlayer);
    prematchHealthInside889ByPlayerId[id] = false;
    delete prematchHealthAppliedMaxByPlayerId[id];


    p.isDeployed = false;
    clearCipherSecondHalfDeployReadyForPlayer(id);
    invalidateBombDeployLoadoutApplyForPlayer(id);
    invalidateBombCarrierRestoreInsertForPlayer(id);
    playerInDamageZone[id] = false;
    resetRestrictedAreaStateForPlayer(id);
    clearAllObjectiveAreaTriggerStateForPlayer(id);
    clearCipherPresenceForPlayer(id);
    cancelObjectiveCaptureAttemptsForPlayer(id);
    UpdateDeployObjectiveTimerUiForPlayer(p);

    if (gameStatus === 3 && initialization[3] === true) {
      syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerUndeploy");
    }

    if (gameStatus === 3 && bombCarrierPlayerId === id) {
      const undeployPos = tryGetPlayerPositionSafe(eventPlayer);
      if (undeployPos) lastKnownLivePositionByPlayerId[id] = undeployPos;
      forceBombDropFromCarrier(id, "undeploy");
    }

    if (
      isCipherSuddenDeathActive() &&
      wasDeployed &&
      safeSpawnForcedUndeploy[id] !== true &&
      getCurrentSchedulerNowSeconds() >= cipherSuddenDeathUndeployIgnoreUntilSec
    ) {
      consumeCipherSuddenDeathLife(id);
      return;
    }


  // Countdown/pre-live auto-spawn:
  // If a player redeploys manually (or gets undeployed by the mode) during the countdown,
  // queue a safe transition spawn from the main loop so we avoid callback-time re-entrant spawns.
    if (gameStatus === 3 && cipherSecondHalfTransitionStage === "deploy") {
      mod.SetRedeployTime(eventPlayer, 0);
      clearTransitionSpawnStateForPlayer(id);
      setCipherSecondHalfDeployFreezeForPlayer(eventPlayer, false, "second_half_deploy_undeploy");
      return;
    }

    if (
      gameStatus === 1 ||
      gameStatus === 2 ||
      (gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive))
    ) {
      applyPhaseInputRestrictionsForPlayer(eventPlayer);
      mod.SetRedeployTime(eventPlayer, 0);
      clearTransitionSpawnStateForPlayer(id);
      requestTransitionSpawn(id, "OnPlayerUndeploy_Transition");
      return;
    }

    if (gameStatus === 3) {
      ForceRemovePlayerFromAllCapturePoints(id);
      stopCaptureTickLoop(id);
    }

    if (safeSpawnUnsafePending[id] === true) {
      safeSpawnUnsafePending[id] = false;

      const pendingHqObjId = safeSpawnUnsafeHqObjIdByPlayerId[id];
      const pendingSpawnerObjId = safeSpawnUnsafeSpawnerObjId[id];
      safeSpawnUnsafeHqObjIdByPlayerId[id] = 0;
      safeSpawnUnsafeSpawnerObjId[id] = 0;

      // Keep the original 0.1s undeploy buffer, but add an extra 0.5s between redeploy attempts
      await mod.Wait(0.1);
      await mod.Wait(0.5);

      const team = mod.GetTeam(eventPlayer);
      // Pending spawner is intentionally not trusted as authority;
      // final spawnpoint is always recomputed from sanitized team HQ id.
      let resolvedHqObjId = sanitizeForcedSafeSpawnHqForTeam(team, pendingHqObjId);
      if (!pendingHqObjId && !pendingSpawnerObjId) {
        resolvedHqObjId = getDefaultLiveSafeSpawnHqObjIdForTeam(team);
      }

      let spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(resolvedHqObjId);
      if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) {
        resolvedHqObjId = getDefaultLiveSafeSpawnHqObjIdForTeam(team);
        spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(resolvedHqObjId);
      }

      if (isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) {
        lastLiveHqSpawnPointObjIdByPlayerId[id] = resolvedHqObjId;
        lastForcedSafeSpawnHqObjIdByPlayerId[id] = resolvedHqObjId;
        mod.SetRedeployTime(eventPlayer, 0);
        trySpawnPlayerFromSpawnPointSafe(eventPlayer, spawnerObjId, "OnPlayerUndeploy_SafeSpawnRecycle");
      }

      mod.SetRedeployTime(eventPlayer, REDEPLOY_TIME);
      return;
    }

    if (safeSpawnForcedUndeploy[id] === true) return;
    if (gameStatus === 2) return;
    if (gameStatus === 3 && getCurrentSchedulerNowSeconds() < cipherPhaseTransitionUndeployIgnoreUntilSec) return;

    if (gameStatus === 3) p.addDeath();
  } catch (err) {
    LogRuntimeError("OnPlayerUndeploy", err);
  } finally {
    refreshCipherKeyPlayerSnapshots("OnPlayerUndeploy");
  }
}

function Mode_OnPlayerInteract(eventPlayer: mod.Player, eventInteractPoint: mod.InteractPoint): void {
  try {
    const ipId = mod.GetObjId(eventInteractPoint);

    if (gameStatus === 0) {
      if (ipId === IP_T1_SWITCH || ipId === IP_T2_SWITCH) {
        HandlePrematchSwitchTeams(eventPlayer);
      }

      if (ipId === IP_T1_READY || ipId === IP_T2_READY) {
        HandlePrematchReadyUp(eventPlayer);
      }

      return;
    }

    if (gameStatus === 3) {
      const objectiveCpId = OBJECTIVE_CP_ID_BY_INTERACT_POINT_ID[ipId];
      if (objectiveCpId !== undefined) {
        HandleObjectiveCaptureInteract(eventPlayer, objectiveCpId);
        return;
      }

      if (ipId === IP_SPECTATOR) {
        mod.SetCameraTypeForPlayer(eventPlayer, mod.Cameras.Free);
      }

      if (ipId === IP_T1_SWITCH || ipId === IP_T2_SWITCH) {
        const switchingId = modlib.getPlayerId(eventPlayer);
        if (bombCarrierPlayerId === switchingId) {
          const switchPos = tryGetPlayerPositionSafe(eventPlayer);
          if (switchPos) lastKnownLivePositionByPlayerId[switchingId] = switchPos;
          forceBombDropFromCarrier(switchingId, "team_switch");
        }

        mod.UndeployPlayer(eventPlayer);

        const p = serverPlayers.get(modlib.getPlayerId(eventPlayer));
        const currentTeam = mod.GetTeam(eventPlayer);

        if (modlib.getTeamId(currentTeam) === 1) {
          mod.SetTeam(eventPlayer, team2);
          p?.setTeam();
        } else {
          mod.SetTeam(eventPlayer, team1);
          p?.setTeam();
        }
      }
    }
  } catch (err) {
    LogRuntimeError("OnPlayerInteract", err);
  }
}

/* =================================================================================================
   15) CAPTURE EVENTS (ENTER/EXIT / CAPTURED / LOST / CAPTURING)
================================================================================================= */
function SyncPlayersOnPointsFromEngine(): void {
  if (gameStatus !== 3) return;

  // --- Reused caches (declare these once at module scope if you haven't yet) ---
  // let _syncStamp = 0;
  // const _seenThisSync: { [playerId: number]: number } = {};
  // const _tmpPlayerToCpId: { [playerId: number]: number } = {};
  // const _tmpPlayerToCpIdKeys: number[] = [];
  // function _tmpPlayerToCpIdSet(playerId: number, cpId: number): void { ... }
  // function _tmpPlayerToCpIdClear(): void { ... }

  _syncStamp += 1;

  // Overwrite each CP's _onPoint list with engine truth (no per-call arrays).
  // Also build a temp player->cpId mapping without allocating a new object.
  for (const k in serverCapturePoints) {
    const cp = serverCapturePoints[k];
    if (!cp) continue;

    cp.clearOnPoint();

    const arr = mod.GetPlayersOnPoint(cp.capturePoint);

    for (let i = 0; i < mod.CountOf(arr); i++) {
      const pl = mod.ValueInArray(arr, i) as mod.Player;
      if (!mod.IsPlayerValid(pl)) continue;
      if (!isPlayerAlive(pl)) continue;

      const pid = modlib.getPlayerId(pl);
      const sp = serverPlayers.get(pid);
      if (!sp) continue;
      if (!sp.isDeployed) continue;

      // De-dupe without allocating freshIds or doing indexOf scans
      if (_seenThisSync[pid] === _syncStamp) continue;
      _seenThisSync[pid] = _syncStamp;

      // Add to this CP's on-point list (reuses same array backing store)
      (cp as any)._onPoint.push(pid);

      // Record mapping (reused cache, cleared cheaply later)
      _tmpPlayerToCpIdSet(pid, cp.id);
    }
  }

  // Ensure each player's capture UI state matches engine truth.
  serverPlayers.forEach((sp) => {
    if (!sp) return;

    const newCpId = _tmpPlayerToCpId[sp.id]; // undefined if not on any point
    const oldPoint = sp.getCapturePoint();

    if (newCpId === undefined) {
      if (oldPoint) {
        sp.setCapturePoint(null);
        stopCaptureTickLoop(sp.id);
      }
      return;
    }

    const cpWrap = serverCapturePoints[newCpId];
    if (!cpWrap) return;

    const newPoint = cpWrap.capturePoint;

    // No mod.GetCapturePointId in your SDK; compare capture point handle directly
    if (!oldPoint || oldPoint !== newPoint) {
      sp.setCapturePoint(newPoint);
      void startCaptureTickLoop(sp.id);
    }

    sp.updateUIPlayersOnPoint();
    sp.updateUIProgress();
  });

  // Clear only keys we set this sync (no new object alloc)
  _tmpPlayerToCpIdClear();
}






function ForceRemovePlayerFromAllCapturePoints(playerId: number): void {
  stopCaptureTickLoop(playerId);

  // Remove from all tracked capture points.
  Object.values(serverCapturePoints).forEach((cp) => cp.removeOnPoint(playerId));

  // Clear their local capture UI state if they are still known on server.
  const p = serverPlayers.get(playerId);
  if (p) {
    p.setCapturePoint(null);

    // These widgets exist only in live; guard in case they are not built yet.
    if (p.friendlyCapWidget) mod.SetUITextLabel(p.friendlyCapWidget, mod.Message(0));
    if (p.enemyCapWidget) mod.SetUITextLabel(p.enemyCapWidget, mod.Message(0));
    if (p.activeFlagWidget) mod.SetUITextLabel(p.activeFlagWidget, mod.Message(0));
  }

  // Refresh UI for everyone still on points.
  Object.values(serverCapturePoints).forEach((cp) => cp.updateUIforPlayersOnPoint());
}
function markCaptureCredit(cpId: number, playerId: number): void {
  if (!captureCreditByCpId[cpId]) captureCreditByCpId[cpId] = {};
  captureCreditByCpId[cpId][playerId] = true;
}

function clearCaptureCredit(cpId: number): void {
  captureCreditByCpId[cpId] = {};
}

function Mode_OnPlayerEnterCapturePoint(eventPlayer: mod.Player, eventCapturePoint: mod.CapturePoint): void {
  const id = modlib.getPlayerId(eventPlayer);
  const cpId = mod.GetObjId(eventCapturePoint);

  if (gameStatus !== 3) return;

  const team = mod.GetTeam(eventPlayer);
  const cp = serverCapturePoints[cpId];
  const player = serverPlayers.get(id);

  if (!cp || !isObjectiveCpId(cpId)) return;
  if (isRoutingCpId(cpId)) markHqRoutingDirty();

  const before = cp.getOnPoint();
  cp.addOnPoint(id);

  const lastEnter = lastEnterPointSfxTickByPlayerId[id] ?? -999999;
  if (phaseTickCount - lastEnter >= ENTER_POINT_SFX_COOLDOWN_TICKS) {
    lastEnterPointSfxTickByPlayerId[id] = phaseTickCount;

    if (mod.Equals(cp.getOwner(), team) || mod.Equals(cp.getOwner(), teamNeutral)) playThumpFriendly(eventPlayer);
    else playThumpEnemy(eventPlayer);
  }

  const onpoint = cp.getOnPoint();
  const myIdx: 0 | 1 = mod.Equals(team, team1) ? 0 : 1;
  const otherIdx: 0 | 1 = myIdx === 0 ? 1 : 0;

  const myBefore = before[myIdx];
  const myAfter = onpoint[myIdx];
  const enemyAfter = onpoint[otherIdx];

  const ownerTeam = cp.getOwner();

  const teammateJoined = myBefore >= 1 && myAfter >= 2 && enemyAfter === 0 && !mod.Equals(ownerTeam, team);

  if (teammateJoined) {
    if (canPlayCpSfx(SFX_JOIN_CD_TICKS, lastJoinSfxTickByCp, cpId)) {
      markCpSfx(lastJoinSfxTickByCp, cpId);

      serverPlayers.forEach((sp) => {
        if (!mod.Equals(mod.GetTeam(sp.player), team)) return;

        const onCp = sp.getCapturePoint();
        if (!onCp) return;
        if (mod.GetObjId(onCp) !== cpId) return;
        if (sp.id === id) return;

        playTickFriendly(sp.player);
      });
    }
  }

  if (player) {
    player.setCapturePoint(eventCapturePoint);
    void startCaptureTickLoop(id);
  }
  
  cp.updateUIforPlayersOnPoint();
}

function Mode_OnPlayerExitCapturePoint(eventPlayer: mod.Player, eventCapturePoint: mod.CapturePoint): void {
  const id = modlib.getPlayerId(eventPlayer);
  const cpId = mod.GetObjId(eventCapturePoint);

  if (gameStatus !== 3) return;

  const cp = serverCapturePoints[cpId];
  if (!cp || !isObjectiveCpId(cpId)) return;
  if (isRoutingCpId(cpId)) markHqRoutingDirty();

  cp.removeOnPoint(id);

  const p = serverPlayers.get(id);
  if (p) {
    p.setCapturePoint(null);
    stopCaptureTickLoop(id);

  }

  cp.updateUIforPlayersOnPoint();
}

/* =================================================================================================
   16) COMBAT EVENTS
================================================================================================= */
/* =================================================================================================
   DAMAGE SPACING (NO DAMAGE FACTORS)
   - Keeps total damage the same
   - Spaces incoming damage over a short window based on distance
   - Uses Heal() to undo the instant hit, then DealDamage() to re-apply over time
================================================================================================= */

const DMG_SPREAD_CLOSE_MAX_DIST = 10;
const DMG_SPREAD_MID_MAX_DIST = 25;

// Tune these (seconds). Close range = more delay, long range = less delay.
const DMG_SPREAD_CLOSE_SEC = 2.0; // 0-10m
const DMG_SPREAD_MID_SEC = 1.80;   // 10-25m
const DMG_SPREAD_FAR_SEC = 1.60;   // 25m+

// Per-player health cache (LIVE only)
let dmgLastHealth: { [playerId: number]: number } = {};

// Per-player queued damage
let dmgQueued: { [playerId: number]: number } = {};
let dmgQueuedTicksLeft: { [playerId: number]: number } = {};
let dmgQueuedGiverObjId: { [playerId: number]: number } = {};
// Track only victims currently needing smoothing work
let dmgActive: { [playerId: number]: boolean } = {};
let dmgActiveIds: number[] = [];

// Guard to prevent our own re-applied DealDamage() from being re-smoothed
let dmgIsReapplying: { [playerId: number]: boolean } = {};
// Health-based delay scaling:
//  - 1.0 health => 100% of base delay
//  - 0.0 health => MIN factor of base delay
const DMG_SPREAD_HEALTH_DELAY_MIN_FACTOR = 0.45; // <= 1.0 (lower = faster when low HP)
const DMG_SPREAD_HEALTH_DELAY_MAX_FACTOR = 1.0;  // keep at 1.0

function dmgGetNormalizedHealth(player: mod.Player): number {
  // SDK supports NormalizedHealth (0..1)
  return mod.GetSoldierState(player, mod.SoldierStateNumber.NormalizedHealth);
}

function dmgSpreadApplyHealthDelayScale(baseTicks: number, normalizedHealth: number): number {
  // Clamp 0..1 without relying on Math.min/max
  let h = normalizedHealth;
  if (typeof h !== "number" || !Number.isFinite(h)) h = 1;
  if (h < 0) h = 0;
  if (h > 1) h = 1;

  // Scale factor = min + (max-min)*h
  const factor =
    DMG_SPREAD_HEALTH_DELAY_MIN_FACTOR +
    (DMG_SPREAD_HEALTH_DELAY_MAX_FACTOR - DMG_SPREAD_HEALTH_DELAY_MIN_FACTOR) * h;

  const scaled = mod.Ceiling(baseTicks * factor);
  return scaled < 1 ? 1 : scaled;
}

function dmgMarkActive(id: number): void {
  if (dmgActive[id] === true) return;
  dmgActive[id] = true;
  dmgActiveIds.push(id);
}

function dmgUnmarkActive(id: number): void {
  if (dmgActive[id] !== true) return;
  dmgActive[id] = false;
  const idx = dmgActiveIds.indexOf(id);
  if (idx >= 0) dmgActiveIds.splice(idx, 1);
}

function dmgSpreadSecondsToTicks(sec: number): number {
  const raw = mod.Ceiling(sec * TICK_RATE);
  return raw < 1 ? 1 : raw;
}

function dmgSpreadDistanceMeters(victim: mod.Player, attacker: mod.Player): number {
  if (!mod.IsPlayerValid(attacker)) return 99999;
  if (!isPlayerAlive(victim)) return 99999;
  if (!isPlayerAlive(attacker)) return 99999;

  const vPos = getPlayerPosition(victim);
  const aPos = getPlayerPosition(attacker);
  return mod.DistanceBetween(vPos, aPos);
}

function dmgSpreadPickTicks(distanceMeters: number): number {
  if (distanceMeters <= DMG_SPREAD_CLOSE_MAX_DIST) return dmgSpreadSecondsToTicks(DMG_SPREAD_CLOSE_SEC);
  if (distanceMeters <= DMG_SPREAD_MID_MAX_DIST) return dmgSpreadSecondsToTicks(DMG_SPREAD_MID_SEC);
  return dmgSpreadSecondsToTicks(DMG_SPREAD_FAR_SEC);
}

function dmgGetCurrentHealth(player: mod.Player): number {
  return mod.GetSoldierState(player, mod.SoldierStateNumber.CurrentHealth);
}

// Update cached health for all deployed alive players during LIVE
function dmgSpreadUpdateHealthCacheTick(): void {
  if (gameStatus !== 3) return;

  serverPlayers.forEach((sp) => {
    if (!sp || !sp.isDeployed) return;
    if (!mod.IsPlayerValid(sp.player)) return;
    if (!isPlayerAlive(sp.player)) return;

    dmgLastHealth[sp.id] = dmgGetCurrentHealth(sp.player);
  });
}

// Apply queued damage smoothly during LIVE (ONLY for active damaged victims)
function dmgSpreadProcessQueueTick(): void {
  if (gameStatus !== 3) return;
  if (dmgActiveIds.length <= 0) return;

  // Iterate backwards so we can safely remove entries
  for (let i = dmgActiveIds.length - 1; i >= 0; i--) {
    const id = dmgActiveIds[i];

    const sp = serverPlayers.get(id);
    if (!sp || !sp.isDeployed || !mod.IsPlayerValid(sp.player) || !isPlayerAlive(sp.player)) {
      // Player gone / invalid: stop processing them
      dmgQueued[id] = 0;
      dmgQueuedTicksLeft[id] = 0;
      dmgQueuedGiverObjId[id] = 0;
      dmgUnmarkActive(id);
      continue;
    }

    const remaining = dmgQueued[id] ?? 0;
    let ticksLeft = dmgQueuedTicksLeft[id] ?? 0;

    // Nothing left to do => deactivate
    if (remaining <= 0 || ticksLeft <= 0) {
      dmgQueued[id] = 0;
      dmgQueuedTicksLeft[id] = 0;
      dmgQueuedGiverObjId[id] = 0;
      dmgUnmarkActive(id);
      continue;
    }

    // Spread evenly. Use Ceiling so it always finishes.
    let step = mod.Ceiling(remaining / ticksLeft);
    if (step < 1) step = 1;
    if (step > remaining) step = remaining;

    // Optional giver for kill credit (best-effort)
    const giverObjId = dmgQueuedGiverObjId[id] ?? 0;
    let giver: mod.Player | null = null;

    if (giverObjId !== 0) {
      const found = findServerPlayerByObjId(giverObjId);
      if (found && mod.IsPlayerValid(found.player)) giver = found.player;
    }

    // IMPORTANT: prevent re-smoothing our own scripted DealDamage
    dmgIsReapplying[id] = true;
    try {
      if (giver) mod.DealDamage(sp.player, step, giver);
      else mod.DealDamage(sp.player, step);
    } finally {
      dmgIsReapplying[id] = false;
    }

    dmgQueued[id] = remaining - step;
    ticksLeft -= 1;
    dmgQueuedTicksLeft[id] = ticksLeft;

    if (dmgQueued[id] <= 0 || dmgQueuedTicksLeft[id] <= 0) {
      dmgQueued[id] = 0;
      dmgQueuedTicksLeft[id] = 0;
      dmgQueuedGiverObjId[id] = 0;
      dmgUnmarkActive(id);
    }
  }
}


// Clear queue state for a player (call on deploy/undeploy)
function dmgSpreadClearForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;
  const id = modlib.getPlayerId(player);

  dmgQueued[id] = 0;
  dmgQueuedTicksLeft[id] = 0;
  dmgQueuedGiverObjId[id] = 0;

  dmgIsReapplying[id] = false;
  dmgUnmarkActive(id);

  if (mod.IsPlayerValid(player) && isPlayerAlive(player)) {
    dmgLastHealth[id] = dmgGetCurrentHealth(player);
  } else {
    dmgLastHealth[id] = 0;
  }
}


function Mode_OnPlayerDamaged(
  eventPlayer: mod.Player,      // victim
  eventOtherPlayer: mod.Player, // attacker
  eventDamageType: mod.DamageType,
  eventWeaponUnlock: mod.WeaponUnlock
): void {
  if (!mod.IsPlayerValid(eventPlayer)) return;

  const victimId = modlib.getPlayerId(eventPlayer);

  // Prematch 889 rule:
  // - outside 889: full non-lethal protection (always force full heal)
  // - inside 889: no protection, player can be killed/downed normally
  if (isPrematchOutside889(victimId)) {
    forcePrematchOutside889FullHeal(eventPlayer, victimId);
    return;
  }

  const sp = serverPlayers.get(victimId);
  if (!sp) return;

  if (gameStatus === 3 && sp.isDeployed) {
    if (hasRestrictedAreaFeedbackOrSourcesActive(victimId)) {
      if (isRestrictedAreaLethalStateForPlayer(victimId, eventPlayer)) {
        deactivateRestrictedAreaFeedbackForPlayer(victimId, true);
      } else {
        scheduleRestrictedAreaLethalConfirmForPlayer(victimId, eventPlayer);
      }
    }
  }

  if (!isPlayerAlive(eventPlayer)) return;

  // LIVE only
  if (gameStatus !== 3) return;
  if (!sp.isDeployed) return;

  const cur = dmgGetCurrentHealth(eventPlayer);

  // Toggle: if smoothing is disabled, just keep health cache updated and do nothing.
  if (!ENABLE_DAMAGE_SMOOTHING) {
    dmgLastHealth[victimId] = cur;
    return;
  }

  const healthNormAfterHit = dmgGetNormalizedHealth(eventPlayer);


  // If this damage came from our own queued re-application, just update cache and stop.
  if (dmgIsReapplying[victimId] === true) {
    dmgLastHealth[victimId] = cur;
    return;
  }

  // If not player-vs-player (world/zone/etc), do NOT smooth; just keep cache updated.
  if (!mod.IsPlayerValid(eventOtherPlayer) || mod.Equals(eventPlayer, eventOtherPlayer)) {
    dmgLastHealth[victimId] = cur;
    return;
  }

  // Only smooth enemy damage
  const vTeam = mod.GetTeam(eventPlayer);
  const aTeam = mod.GetTeam(eventOtherPlayer);
  if (mod.Equals(vTeam, aTeam)) {
    dmgLastHealth[victimId] = cur;
    return;
  }

  const prev = dmgLastHealth[victimId];

  // If cache is missing, initialize and do nothing this hit (avoids bad deltas)
  if (typeof prev !== "number" || !Number.isFinite(prev) || prev <= 0) {
    dmgLastHealth[victimId] = cur;
    return;
  }

  const delta = prev - cur;
  if (delta <= 0) {
    dmgLastHealth[victimId] = cur;
    return;
  }

  // Undo the instant damage
  mod.Heal(eventPlayer, delta);

  // Restore cache to the healed value
  dmgLastHealth[victimId] = prev;

  // Queue the same damage to be applied over time
  const dist = dmgSpreadDistanceMeters(eventPlayer, eventOtherPlayer);
  const baseTicks = dmgSpreadPickTicks(dist);
  const spreadTicks = dmgSpreadApplyHealthDelayScale(baseTicks, healthNormAfterHit);


  dmgQueued[victimId] = (dmgQueued[victimId] ?? 0) + delta;
  dmgQueuedTicksLeft[victimId] = spreadTicks;

  // Best-effort store giver ObjId for credit
  dmgQueuedGiverObjId[victimId] = mod.GetObjId(eventOtherPlayer);

  // Mark victim active so queue processing runs ONLY for them
  dmgMarkActive(victimId);
}

function Mode_OnMandown(eventPlayer: mod.Player, _eventOtherPlayer: mod.Player): void {
  if (!mod.IsPlayerValid(eventPlayer)) return;

  const playerId = modlib.getPlayerId(eventPlayer);
  if (gameStatus === 3) {
    playerInMandownByPlayerId[playerId] = true;
    cancelObjectiveCaptureAttemptsForPlayer(playerId);
    UpdateObjectiveCaptureInteractionState();
    deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
  }
  if (!isPrematchOutside889(playerId)) return;

  // Prematch outside 889 must never stay in mandown.
  forcePrematchOutside889FullHeal(eventPlayer, playerId);
}

function Mode_OnRevived(eventPlayer: mod.Player, _eventOtherPlayer: mod.Player): void {
  const playerId = modlib.getPlayerId(eventPlayer);
  cancelPendingRestrictedLethalConfirmForPlayer(playerId);
  delete playerInMandownByPlayerId[playerId];
  clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);

  if (gameStatus !== 3) return;

  const p = serverPlayers.get(playerId);
  if (!p) return;

  startRestrictedCountdownIfNeeded(p);
  UpdateObjectiveCaptureInteractionState();
}




function Mode_OnPlayerDied(
  eventPlayer: mod.Player,
  _eventOtherPlayer: mod.Player,
  _eventDeathType: mod.DeathType,
  _eventWeaponUnlock: mod.WeaponUnlock
): void {
  const playerId = modlib.getPlayerId(eventPlayer);
  invalidateBombCarrierRestoreInsertForPlayer(playerId);
  if (gameStatus !== 3) return;

  playerInMandownByPlayerId[playerId] = true;
  deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
  let deathPos: mod.Vector | undefined = undefined;
  try {
    deathPos = mod.GetSoldierState(eventPlayer, mod.SoldierStateVector.GetPosition);
  } catch (_err) {}

  if (deathPos) {
    lastKnownLivePositionByPlayerId[playerId] = deathPos;
  }

  clearAllObjectiveAreaTriggerStateForPlayer(playerId);
  clearCipherPresenceForPlayer(playerId);
  cancelObjectiveCaptureAttemptsForPlayer(playerId);
  if (initialization[3] === true) {
    syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerDied");
  }

  if (bombCarrierPlayerId === playerId) {
    forceBombDropFromCarrier(playerId, "death", deathPos);
  }
  consumeCipherSuddenDeathLife(playerId);
}

function Mode_OnPlayerEarnedKill(
  eventPlayer: mod.Player,
  eventOtherPlayer: mod.Player,
  eventDeathType: mod.DeathType,
  eventWeaponUnlock: mod.WeaponUnlock
): void {
  if (gameStatus !== 3) return;

  const p = serverPlayers.get(modlib.getPlayerId(eventPlayer));
  if (!p) return;

  if (mod.NotEqualTo(eventPlayer, eventOtherPlayer)) {
    p.addKill();
    p.addScore(100);
  }
}

function Mode_OnPlayerEarnedKillAssist(eventPlayer: mod.Player, eventOtherPlayer: mod.Player): void {
  if (gameStatus !== 3) return;

  const p = serverPlayers.get(modlib.getPlayerId(eventPlayer));
  if (!p) return;

  // Assist score remains, but the old assists stat slot is now Armed.
  p.addScore(50);
}

/* =================================================================================================
   17) DAMAGE ZONE EVENTS
================================================================================================= */

function Mode_OnPlayerEnterAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void {
  const triggerId = mod.GetObjId(eventAreaTrigger);
  const playerId = modlib.getPlayerId(eventPlayer);

  if (triggerId === PREMATCH_HEALTH_AREA_TRIGGER_ID) {
    if (gameStatus === 0) {
      prematchHealthInside889ByPlayerId[playerId] = true;
      applyPrematch889HealthForPlayer(playerId);
    }
    return;
  }

  if (gameStatus !== 3) return;

  if (isCipherPresenceTriggerId(triggerId)) {
    markCipherPresenceZoneActive(playerId, triggerId);
    return;
  }

  if (isObjectiveAreaTriggerId(triggerId)) {
    markObjectiveAreaTriggerActive(playerId, triggerId);
    tryDeliverCipherKeyFromAreaTrigger(playerId, triggerId);
    syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerEnterAreaTrigger");
    return;
  }

  if (triggerId === BOMB_PICKUP_TRIGGER_ID) {
    if (!BOMB_USE_PICKUP_AREA_TRIGGER_AUTHORITY) return;
    if (!bombPickupTriggerEnabled) return;
    if (bombCarrierPlayerId !== undefined) return;

    const pBomb = serverPlayers.get(playerId);
    if (!pBomb) return;
    if (!pBomb.isDeployed) return;
    if (!mod.IsPlayerValid(eventPlayer)) return;
    if (!isPlayerAlive(eventPlayer)) return;
    if (isBotBackfillPlayer(eventPlayer)) return;

    const team = getCipherKeyTeamSnapshot(playerId) ?? pBomb.team;
    if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

    const fromDroppedBomb = hasDroppedBombRuntimeObjects();

    tryUnspawnAllLootForBombFlow("area_trigger_pickup");

    if (fromDroppedBomb) {
      clearDroppedBombRuntimeObjects();
    }
    clearBombBaseRuntimeLootSpawner();
    transferBombToPlayerAsCarrier(pBomb, fromDroppedBomb, "area_watch");

    setBombPickupTriggerEnabled(false);
    setBombBaseAvailabilityState(false);
    return;
  }

  const p = serverPlayers.get(playerId);
  if (!p) return;

  if (triggerId === COMBAT_BOUNDARY_TRIGGER_ID) {
    delete playerOutsideCombatBoundaryByPlayerId[playerId];
    clearRestrictedCountdownIfNoSourcesRemain(playerId);
    return;
  }

  const isBombCarrierHqDropZoneTrigger =
    triggerId === TEAM1_HQ_PROTECTION_TRIGGER_ID ||
    triggerId === TEAM2_HQ_PROTECTION_TRIGGER_ID;
  if (bombCarrierPlayerId === playerId && isBombCarrierHqDropZoneTrigger) {
    const carrierPos = tryGetPlayerPositionSafe(eventPlayer);
    forceBombDropFromCarrier(playerId, "hq_area", carrierPos);
  }

  // Existing damage zone
  if (triggerId === DAMAGE_TRIGGER_ID) {
    playerInDamageZone[playerId] = true;
    return;
  }

  // Restricted areas: shared 7003 + team-specific HQ protection areas.
  if (isRestrictedAreaTriggerId(triggerId)) {
    const playerTeam = mod.GetTeam(eventPlayer);
    if (!isRestrictedTriggerForPlayer(triggerId, playerTeam)) return;

    markRestrictedTriggerActive(playerId, triggerId);
    startRestrictedCountdownIfNeeded(p);

    return;
  }
}


function Mode_OnPlayerExitAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void {
  const triggerId = mod.GetObjId(eventAreaTrigger);
  const playerId = modlib.getPlayerId(eventPlayer);

  if (triggerId === PREMATCH_HEALTH_AREA_TRIGGER_ID) {
    if (gameStatus === 0) {
      prematchHealthInside889ByPlayerId[playerId] = false;
      applyPrematch889HealthForPlayer(playerId);
    }
    return;
  }

  if (isObjectiveAreaTriggerId(triggerId)) {
    clearObjectiveAreaTriggerActive(playerId, triggerId);
    cancelObjectiveCaptureAttemptsForPlayer(playerId);
    if (gameStatus === 3 && initialization[3] === true) {
      syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerExitAreaTrigger");
    }
    return;
  }

  if (isCipherPresenceTriggerId(triggerId)) {
    clearCipherPresenceZoneActive(playerId, triggerId);
    return;
  }

  // Existing damage zone
  if (triggerId === DAMAGE_TRIGGER_ID) {
    playerInDamageZone[playerId] = false;
    return;
  }

  if (triggerId === COMBAT_BOUNDARY_TRIGGER_ID) {
    const p = serverPlayers.get(playerId);
    if (!p) return;

    playerOutsideCombatBoundaryByPlayerId[playerId] = true;
    if (bombCarrierPlayerId === playerId) {
      const carrierPos = tryGetPlayerPositionSafe(eventPlayer);
      forceBombDropFromCarrier(playerId, "combat_boundary_exit", carrierPos);
    }
    startRestrictedCountdownIfNeeded(p);
    return;
  }

  // Restricted areas: remove one source; cancel only when none remain.
  if (isRestrictedAreaTriggerId(triggerId)) {
    clearRestrictedTriggerActive(playerId, triggerId);
    clearRestrictedCountdownIfNoSourcesRemain(playerId);
    return;
  }

}

function Mode_OnMCOMArmed(eventMCOM: mod.MCOM): void {
  if (gameStatus !== 3) return;

  const cpId = resolveObjectiveCpIdFromMcomEvent(eventMCOM);
  if (cpId === undefined) {
    logObjectiveNativeEventFlow("armed_unmapped", eventMCOM, cpId);
    return;
  }

  safeEnableObjectiveMcomByCpId(cpId, false, "Mode_OnMCOMArmed", true);
  reapplyLiveHybridObjectiveSurfaceStateForCp(cpId, "Mode_OnMCOMArmed");
  logObjectiveNativeEventFlow("armed_ignored", eventMCOM, cpId);
}

function Mode_OnMCOMDefused(eventMCOM: mod.MCOM): void {
  if (gameStatus !== 3) return;

  const cpId = resolveObjectiveCpIdFromMcomEvent(eventMCOM);
  if (cpId === undefined) {
    logObjectiveNativeEventFlow("defused_unmapped", eventMCOM, cpId);
    return;
  }

  safeEnableObjectiveMcomByCpId(cpId, false, "Mode_OnMCOMDefused", true);
  reapplyLiveHybridObjectiveSurfaceStateForCp(cpId, "Mode_OnMCOMDefused");
  logObjectiveNativeEventFlow("defused_ignored", eventMCOM, cpId);
}

function Mode_OnMCOMDestroyed(eventMCOM: mod.MCOM): void {
  if (gameStatus !== 3) return;

  const cpId = resolveObjectiveCpIdFromMcomEvent(eventMCOM);
  if (cpId === undefined) {
    logObjectiveNativeEventFlow("destroyed_unmapped", eventMCOM, cpId);
    return;
  }

  safeEnableObjectiveMcomByCpId(cpId, false, "Mode_OnMCOMDestroyed", true);
  reapplyLiveHybridObjectiveSurfaceStateForCp(cpId, "Mode_OnMCOMDestroyed");
  logObjectiveNativeEventFlow("destroyed_ignored", eventMCOM, cpId);
}

function Mode_OngoingMCOM(eventMCOM: mod.MCOM): void {
  if (gameStatus !== 3) return;

  const cpId = resolveObjectiveCpIdFromMcomEvent(eventMCOM);
  if (cpId === undefined) return;

  safeEnableObjectiveMcomByCpId(cpId, false, "Mode_OngoingMCOM", true);
  reapplyLiveHybridObjectiveSurfaceStateForCp(cpId, "Mode_OngoingMCOM");
}

export function isSquadObliterationLivePhase(): boolean {
  return gameStatus === 3;
}

export const lifecycleRuntimeHandlers = {
  onGameModeStarted: Mode_OnGameModeStarted,
  onGameModeEnding: Mode_OnGameModeEnding,
};

export const playerSessionRuntimeHandlers = {
  onPlayerJoinGame: Mode_OnPlayerJoinGame,
  onPlayerLeaveGame: Mode_OnPlayerLeaveGame,
  onPlayerDeployed: Mode_OnPlayerDeployed,
  onPlayerUndeploy: Mode_OnPlayerUndeploy,
};

export const prematchRuntimeHandlers = {
  onPlayerInteract: Mode_OnPlayerInteract,
};

export const objectiveRuntimeHandlers = {
  onPlayerEnterCapturePoint: Mode_OnPlayerEnterCapturePoint,
  onPlayerExitCapturePoint: Mode_OnPlayerExitCapturePoint,
  onOngoingMcom: Mode_OngoingMCOM,
  onMcomArmed: Mode_OnMCOMArmed,
  onMcomDefused: Mode_OnMCOMDefused,
  onMcomDestroyed: Mode_OnMCOMDestroyed,
};

export const combatRuntimeHandlers = {
  onPlayerDamaged: Mode_OnPlayerDamaged,
  onMandown: Mode_OnMandown,
  onRevived: Mode_OnRevived,
  onPlayerDied: Mode_OnPlayerDied,
  onPlayerEarnedKill: Mode_OnPlayerEarnedKill,
  onPlayerEarnedKillAssist: Mode_OnPlayerEarnedKillAssist,
};

export const restrictedAreaRuntimeHandlers = {
  onPlayerEnterAreaTrigger: Mode_OnPlayerEnterAreaTrigger,
  onPlayerExitAreaTrigger: Mode_OnPlayerExitAreaTrigger,
};

export const schedulerRuntimeHandlers = {
  onOngoingGlobal: Mode_OngoingGlobal,
};
