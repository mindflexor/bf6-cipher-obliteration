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
import { SPAWN_ROUTING_CONFIG } from '../config/spawn-routing.ts';
import { WORLD_IDS } from '../config/world-ids.ts';
import { modlib } from '../utils/mod-compat.ts';
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
const CIPHER_RUNTIME_BOTS_DEFAULT_ENABLED = true;
const CIPHER_RUNTIME_BOT_DESIRED_TEAM_SIZE = 8;
const CIPHER_RUNTIME_BOT_MAX_PER_TEAM = 8;
const CIPHER_RUNTIME_BOT_MAX_TOTAL = 16;
const CIPHER_RUNTIME_BOT_RECONCILE_INTERVAL_SECONDS = 1.0;
const CIPHER_RUNTIME_BOT_SPAWN_RETRY_SECONDS = 2.0;
const CIPHER_RUNTIME_BOT_RESPAWN_DELAY_SECONDS = 1.0;
const CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS = 5.0;
const CIPHER_RUNTIME_BOT_UNSPAWN_DELAY_SECONDS = CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS;
const CIPHER_RUNTIME_BOT_SPAWN_BIND_TIMEOUT_SECONDS = 5.0;
const CIPHER_RUNTIME_BOT_CREATE_BUDGET_PER_RECONCILE = 2;
const CIPHER_RUNTIME_BOT_RETIRE_BUDGET_PER_RECONCILE = 2;
const CIPHER_RUNTIME_BOT_SPAWN_BUDGET_PER_RECONCILE = 2;
const CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID = 8085;
const CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID = 8086;
const CIPHER_RUNTIME_BOT_REVIVE_SCAN_RADIUS_METERS = 8.0;
const CIPHER_RUNTIME_BOT_REVIVE_FORCE_RADIUS_METERS = 2.5;
const CIPHER_RUNTIME_BOT_REVIVE_ASSIGNMENT_SECONDS = 3.0;
const CIPHER_RUNTIME_BOT_ENEMY_SCAN_RADIUS_METERS = 55.0;
const CIPHER_RUNTIME_BOT_TARGET_REFRESH_SECONDS = 0.75;
const CIPHER_RUNTIME_BOT_STAGED_SPAWN_INTERVAL_TICKS = TICK_RATE;
const CIPHER_RUNTIME_BOT_LOCK_REAPPLY_INTERVAL_TICKS = TICK_RATE;
const CIPHER_TRANSITION_LIVE_START_SETTLE_SECONDS = 2.0;

// Bot objective controller timing.
// These are used by shouldIssueBotMoveCommand(...) and evaluateBotObjectiveController(...).
const BOT_OBJECTIVE_THINK_INTERVAL_SECONDS = 1.0;
const BOT_OBJECTIVE_COMMAND_REFRESH_SECONDS = 1.0;
const BOT_OBJECTIVE_TARGET_REISSUE_DISTANCE_METERS = 4.0;

// Bot movement retry pacing.
// These prevent AI move fail/success events from causing instant command spam.
const BOT_OBJECTIVE_MOVE_FAIL_RETRY_SECONDS = 2.0;
const BOT_OBJECTIVE_MOVE_SUCCESS_RECHECK_SECONDS = 0.35;

// Bots should not instantly recycle on death, otherwise they appear to disappear instead of being revivable.
// If the engine gives them a real mandown state, this delay gives friendly bots time to revive them.
// If the engine fully kills the AI, they still come back later for testing.
const CIPHER_RUNTIME_BOT_DEATH_RESPAWN_DELAY_SECONDS = CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS;

// Live bot respawn delay after an authored AI bot undeploys.
const BOT_LIVE_SPAWN_INITIAL_DELAY_SECONDS = 0.25;

// Defer key drops caused by death/mandown/undeploy out of the combat event stack.
let deferredBombCarrierDropToken = 0;
let deferredBombCarrierDropTimer: number | undefined = undefined;

// Debug portal-log pulls.
// These are intentionally one-shot timers so they do not spam the server.
let runtimeBotDebugPortalLogToken = 0;
let runtimeBotDebugPortalLogEarlyTimer: number | undefined = undefined;
let runtimeBotDebugPortalLogLateTimer: number | undefined = undefined;
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
const NODE_OVERLOAD_COOLDOWN_SECONDS = RULES.nodeOverloadCooldownSeconds;
const CIPHER_COUNTER_Y_OFFSET_METERS = 5.5;
const CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS = 30;
const CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS = 5;
const CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS = 2.0;
const CIPHER_HALFTIME_INTERMISSION_SECONDS = 5;

const ROUND_TIME = RULES.halfTimeSeconds;                // seconds
const OVERTIME_TIME = RULES.suddenDeathSeconds;              // seconds
const TOTAL_TICKS = ROUND_TIME * TICK_RATE;
const LIVE_ENGINE_TIME_LIMIT_SAFETY_SECONDS = 7200;
const LIVE_TIMER_INTRO_SECONDS = 3.0;
const LIVE_SCORE_PANEL_LEFT = 0;
const LIVE_SCORE_PANEL_TOP = 660.56;
const LIVE_SCORE_PANEL_WIDTH = 288.02;
const LIVE_SCORE_PANEL_HEIGHT = 88;
const LIVE_SCORE_FLAG_SIZE = 44;
const LIVE_SCORE_FLAG_GAP = 6;
const LIVE_SCORE_FLAG_ROW_WIDTH = (LIVE_SCORE_FLAG_SIZE * 4) + (LIVE_SCORE_FLAG_GAP * 3);
const LIVE_SCORE_FLAG_ROW_LEFT = LIVE_SCORE_PANEL_LEFT + ((LIVE_SCORE_PANEL_WIDTH - LIVE_SCORE_FLAG_ROW_WIDTH) / 2);
const LIVE_SCORE_FLAG_ROW_TOP = LIVE_SCORE_PANEL_TOP + 3;
const LIVE_SCORE_ROW_CENTER_Y = LIVE_SCORE_PANEL_TOP + 63;
const LIVE_HUD_SCORE_WIDTH = 64;
const LIVE_HUD_SCORE_HEIGHT = 38;
const LIVE_TIMER_DEFAULT_WIDTH = 130;
const LIVE_TIMER_DEFAULT_HEIGHT = 34;
const LIVE_TIMER_DEFAULT_POS_X = LIVE_SCORE_PANEL_LEFT + ((LIVE_SCORE_PANEL_WIDTH - LIVE_TIMER_DEFAULT_WIDTH) / 2);
const LIVE_TIMER_DEFAULT_POS_Y = LIVE_SCORE_ROW_CENTER_Y - (LIVE_TIMER_DEFAULT_HEIGHT / 2);
const LIVE_HUD_FRIENDLY_SCORE_X = LIVE_SCORE_PANEL_LEFT + 20;
const LIVE_HUD_ENEMY_SCORE_X = LIVE_SCORE_PANEL_LEFT + LIVE_SCORE_PANEL_WIDTH - LIVE_HUD_SCORE_WIDTH - 20;
const LIVE_HUD_SCORE_Y = LIVE_SCORE_ROW_CENTER_Y - (LIVE_HUD_SCORE_HEIGHT / 2);
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
const POSTMATCH_TIME = RULES.postmatchTimeSeconds;              // seconds

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
type CipherPresenceZone = "northWest" | "northEast" | "southWest" | "southEast";
type CipherSpawnVariant = "north" | "south";
type CipherSpawnRegion = {
  quadrant: CipherPresenceZone;
  variant: CipherSpawnVariant;
};
type CipherPresenceLane = "west" | "east";
type CipherLanePressure = {
  west: number;
  east: number;
};
type CipherNodeState = "active" | "rebooting";
type CipherHalfTransitionReason = "scoreCap" | "timeExpired";
type CipherSecondHalfTransitionStage = "none" | "intermission" | "deploy" | "countdown" | "finalizing";
type CipherLiveTransitionSupervisorKind = "none" | "secondHalf" | "suddenDeath";
type CipherTransitionWorkCost = "normal" | "heavy";
type CipherTransitionWorkItem = {
  token: number;
  name: string;
  cost: CipherTransitionWorkCost;
  run: () => void;
};
const CIPHER_DEFERRED_LIVE_START_KEY_DELAY_SECONDS = 0.05;
const CIPHER_TRANSITION_NORMAL_WORK_PER_TICK = 2;
const CIPHER_TRANSITION_HEAVY_WORK_PER_TICK = 1;
const CIPHER_TRANSITION_UNDEPLOY_WORK_PER_TICK = 8;
const CIPHER_TRANSITION_FINALIZER_WATCHDOG_SECONDS = 8;
const CIPHER_TRANSITION_OBJECTIVE_EVENT_SUPPRESS_SECONDS = 0.35;

let cipherCurrentHalf: CipherHalfIndex = 1;
let cipherMatchStage: CipherMatchStage = "half1";
let cipherHalfScores: number[] = [0, 0];
let cipherNodeStateByCpId: { [cpId: number]: CipherNodeState | undefined } = {};
let cipherNodeRebootUntilSecByCpId: { [cpId: number]: number | undefined } = {};
let cipherNodeRebootTokenByCpId: { [cpId: number]: number | undefined } = {};
let cipherNodeOverloadedByTeamByCpId: { [cpId: number]: mod.Team | undefined } = {};
let cipherCounterWorldIconLastShownByCpId: { [cpId: number]: string | undefined } = {};
let cipherCounterRuntimeWorldIconObjectByKey: { [key: string]: mod.Object | undefined } = {};
let cipherCounterRuntimeWorldIconHandleByKey: { [key: string]: mod.WorldIcon | undefined } = {};
let cipherCounterRuntimeWorldIconLastStateByKey: { [key: string]: string | undefined } = {};
let cipherCounterRuntimeWorldIconMissingWarnedByKey: { [key: string]: boolean } = {};
let cipherCounterWorldIconLastStateByCpId: { [cpId: number]: string | undefined } = {};
let cipherSuddenDeathEliminatedByPlayerId: { [playerId: number]: boolean } = {};
let cipherSuddenDeathPostmatchPending = false;
let cipherSuddenDeathUndeployIgnoreUntilSec = 0;
let cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
let cipherPendingScoreTransitionTeam: mod.Team = teamNeutral;
let cipherSecondHalfTransitionActive = false;
let cipherSecondHalfTransitionStage: CipherSecondHalfTransitionStage = "none";
let cipherLiveTransitionSupervisorKind: CipherLiveTransitionSupervisorKind = "none";
let cipherLiveTransitionSupervisorToken = 0;
let cipherLiveTransitionSupervisorDeadlineAtSec = 0;
let cipherLiveTransitionSupervisorDeadlineTick = 0;
let cipherLiveTransitionSupervisorLastShownSeconds = -1;
let cipherLiveTransitionSupervisorReason: CipherHalfTransitionReason = "scoreCap";
let cipherDeferredLiveStartKeyToken = 0;
let cipherSecondHalfDeployRequiredByPlayerId: { [playerId: number]: boolean } = {};
let cipherSecondHalfDeployReadyByPlayerId: { [playerId: number]: boolean } = {};
let cipherSecondHalfFrozenByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionTeleportedByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionCountdownSeconds = 0;
let cipherTransitionDeployTitleKey: any = undefined;
let cipherTransitionDeployTitleFallback = "";
let cipherTransitionStartsTitleKey: any = undefined;
let cipherTransitionStartsTitleFallback = "";
let cipherTransitionSubtitleKey: any = undefined;
let cipherTransitionSubtitleFallback = "";
let cipherSecondHalfForceDeployIssuedForTransitionToken = 0;
let cipherTransitionWorkToken = 0;
let cipherTransitionWorkQueue: CipherTransitionWorkItem[] = [];
let cipherTransitionFinalizerActive = false;
let cipherTransitionFinalizerKind: CipherLiveTransitionSupervisorKind = "none";
let cipherTransitionFinalizerToken = 0;
let cipherTransitionFinalizerStartedAtSec = 0;
let cipherTransitionUndeployCursor = 0;
let cipherTransitionLastCheckpoint = "";
let cipherTransitionLastError = "";
let cipherTransitionEngineMutationActive = false;
let cipherSuppressObjectiveEventsUntilSec = 0;
let cipherSuddenDeathTransitionActive = false;
let cipherSecondHalfTransitionToken = 0;
let cipherSuddenDeathTransitionToken = 0;

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
const PREMATCH_READY_DEBOUNCE_TICKS = PREMATCH_SWITCH_DEBOUNCE_TICKS;
const PRELIVE_TEAM_SWITCH_STABILIZE_TICKS = 10;
let prematchSwitchLastHandledTickByPlayerId: { [playerId: number]: number } = {};
let prematchSwitchDebounceWarnedByPlayerId: { [playerId: number]: boolean } = {};
let prematchReadyLastHandledTickByPlayerId: { [playerId: number]: number } = {};
let prematchReadyDebounceWarnedByPlayerId: { [playerId: number]: boolean } = {};
let lastPrematchTeamSwitchTick = -999999;
let lastPrematchTeamSwitchTickByPlayerId: { [playerId: number]: number } = {};
let prematchStabilizationGateWarnedBySwitchTick: { [switchTick: string]: boolean } = {};
let prematchPreliveGateWarnedByKey: { [key: string]: boolean } = {};
let preliveTeamSanityWarnedByPlayerId: { [playerId: number]: boolean } = {};
let prematchHqMapValidationWarnedByKey: { [key: string]: boolean } = {};
let prematchReadyPlayersByTeam: [number, number] = [0, 0];
let prematchTotalPlayersByTeam: [number, number] = [0, 0];
let prematchAllPlayersReady = false;

type CipherAdminAction =
  | "t1_dec"
  | "t1_inc"
  | "t2_dec"
  | "t2_inc"
  | "time_dec"
  | "time_inc"
  | "expire_timer"
  | "reset_timer"
  | "force_half1"
  | "force_half2"
  | "start_sudden_death"
  | "restart_prematch"
  | "end_match"
  | "toggle_bots"
  | "clear_bots"
  | "force_bot_reconcile"
  | "close"
  | "close_x";

type CipherAdminPrimaryClickPhase = "down" | "up";
type CipherAdminPrimaryClickState = {
  widgetName: string;
  atSeconds: number;
  phase: CipherAdminPrimaryClickPhase;
};

const CIPHER_ADMIN_INTERACT_AUTO_SPAWN_ENABLED = false; // false = admin interact point will NOT spawn on deploy/fallback
const CIPHER_ADMIN_INTERACT_LIFETIME_SECONDS = 5;
const CIPHER_ADMIN_INTERACT_FALLBACK_INTERVAL_SECONDS = 3;
const CIPHER_ADMIN_INTERACT_HEIGHT_OFFSET_METERS = 1.25;
const CIPHER_ADMIN_BUTTON_DEBOUNCE_TICKS = 6;
const CIPHER_ADMIN_PRIMARY_CLICK_DEBOUNCE_SECONDS = 0.12;
const CIPHER_ADMIN_PRIMARY_CLICK_RELEASE_GRACE_SECONDS = 2.0;
const CIPHER_ADMIN_PANEL_ROOT_PREFIX = "CipherAdminRoot";
const CIPHER_ADMIN_PANEL_PANEL_PREFIX = "CipherAdminPanel";
const CIPHER_ADMIN_PANEL_TITLE_PREFIX = "CipherAdminTitle";
const CIPHER_ADMIN_PANEL_STATUS_PREFIX = "CipherAdminStatus";
const CIPHER_ADMIN_PANEL_ACTION_COUNT_PREFIX = "CipherAdminActionCount";
const CIPHER_ADMIN_BUTTON_PREFIX = "CipherAdminButton_";
const CIPHER_ADMIN_BUTTON_LABEL_PREFIX = "CipherAdminButtonLabel_";
const CIPHER_ADMIN_DEFERRED_DELETE_DELAY_SECONDS = 0.05;
const CIPHER_ADMIN_PANEL_SIZE = mod.CreateVector(600, 540, 0);
const CIPHER_ADMIN_PANEL_POS = mod.CreateVector(0, 0, 0);
const CIPHER_ADMIN_PANEL_BG_COLOR = mod.CreateVector(0.0314, 0.0431, 0.0431);
const CIPHER_ADMIN_BUTTON_BASE_COLOR = mod.CreateVector(0.0745, 0.1843, 0.2471);
const CIPHER_ADMIN_BUTTON_DISABLED_COLOR = mod.CreateVector(0.05, 0.05, 0.05);
const CIPHER_ADMIN_BUTTON_PRESSED_COLOR = mod.CreateVector(0.4392, 0.9216, 1);
const CIPHER_ADMIN_BUTTON_HOVER_COLOR = mod.CreateVector(0.16, 0.30, 0.36);
const CIPHER_ADMIN_BUTTON_TEXT_COLOR = mod.CreateVector(1, 1, 1);
const CIPHER_ADMIN_PANEL_ACCENT_COLOR = mod.CreateVector(0.4392, 0.9216, 1);
const CIPHER_ADMIN_BUTTON_SIZE = mod.CreateVector(162, 34, 0);
const CIPHER_ADMIN_GRID_BUTTON_SIZE = mod.CreateVector(260, 32, 0);
const CIPHER_ADMIN_WIDE_BUTTON_SIZE = mod.CreateVector(250, 34, 0);
const CIPHER_ADMIN_CLOSE_X_BUTTON_SIZE = mod.CreateVector(34, 30, 0);
const CIPHER_ADMIN_BUTTON_BORDER_PADDING = 2;
const CIPHER_ADMIN_BUTTON_TEXT_SIZE = 14;
const CIPHER_ADMIN_STATUS_TEXT_SIZE = 16;
const CIPHER_ADMIN_TITLE_TEXT_SIZE = 24;

let cipherAdminPlayerId: number | undefined = undefined;
let cipherAdminInteractObject: mod.Object | undefined = undefined;
let cipherAdminInteractPoint: mod.InteractPoint | undefined = undefined;
let cipherAdminInteractObjId = -1;
let cipherAdminInteractToken = 0;
let cipherAdminInteractSpawnTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherAdminPanelVisibleByPlayerId: { [playerId: number]: boolean | undefined } = {};
let cipherAdminButtonLastHandledTickByKey: { [key: string]: number | undefined } = {};
let cipherAdminPanelCloseTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherAdminPanelDeletingByPlayerId: { [playerId: number]: boolean | undefined } = {};
let cipherAdminPanelDeleteTimerByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherAdminPrimaryClickByPlayerId: { [playerId: number]: CipherAdminPrimaryClickState | undefined } = {};
let cipherAdminActionCount = 0;
let cipherAdminNextInteractFallbackAtSec = 0;

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
const CP_D_ID = 204;
const CP_A_SECOND_HALF_ID = 301;
const CP_B_SECOND_HALF_ID = 302;
const CP_C_SECOND_HALF_ID = 303;
const CP_D_SECOND_HALF_ID = 304;
const AUTHORED_FIRST_HALF_SECTOR_ID = 200;
const AUTHORED_SECOND_HALF_SECTOR_ID = 300;
const LEGACY_OBJECTIVE_SURFACE_SECTOR_IDS: number[] = [];
const LEGACY_OBJECTIVE_SURFACE_CP_IDS: number[] = [];
const FIRST_HALF_OBJECTIVE_CP_IDS: number[] = [CP_A_ID, CP_B_ID, CP_C_ID, CP_D_ID];
const SECOND_HALF_OBJECTIVE_CP_IDS: number[] = [
  CP_A_SECOND_HALF_ID,
  CP_B_SECOND_HALF_ID,
  CP_C_SECOND_HALF_ID,
  CP_D_SECOND_HALF_ID,
];
const NORTH_OBJECTIVE_CP_IDS: number[] = [CP_A_ID, CP_B_ID, CP_A_SECOND_HALF_ID, CP_B_SECOND_HALF_ID];
const SOUTH_OBJECTIVE_CP_IDS: number[] = [CP_C_ID, CP_D_ID, CP_C_SECOND_HALF_ID, CP_D_SECOND_HALF_ID];
const TEAM1_DEFENDER_CP_IDS: number[] = [CP_A_ID, CP_B_ID, CP_C_SECOND_HALF_ID, CP_D_SECOND_HALF_ID];
const TEAM2_DEFENDER_CP_IDS: number[] = [CP_C_ID, CP_D_ID, CP_A_SECOND_HALF_ID, CP_B_SECOND_HALF_ID];
const ALL_OBJECTIVE_CP_IDS: number[] = FIRST_HALF_OBJECTIVE_CP_IDS.concat(SECOND_HALF_OBJECTIVE_CP_IDS);
const OBJECTIVE_REGISTRATION_ORDER: number[] = ALL_OBJECTIVE_CP_IDS;
const OBJECTIVE_LOGICAL_CP_ID_BY_SURFACE_CP_ID: { [cpId: number]: number | undefined } = {};
const OBJECTIVE_SURFACE_ONLY_CP_IDS: number[] = LEGACY_OBJECTIVE_SURFACE_CP_IDS.slice();
const ALL_SCRIPTED_OBJECTIVE_CP_IDS: number[] = ALL_OBJECTIVE_CP_IDS.concat(LEGACY_OBJECTIVE_SURFACE_CP_IDS);
const OBJECTIVE_SURFACE_SECTOR_IDS: number[] = [
  AUTHORED_FIRST_HALF_SECTOR_ID,
  AUTHORED_SECOND_HALF_SECTOR_ID,
].concat(LEGACY_OBJECTIVE_SURFACE_SECTOR_IDS);

for (let i = 0; i < ALL_OBJECTIVE_CP_IDS.length; i++) {
  const cpId = ALL_OBJECTIVE_CP_IDS[i];
  OBJECTIVE_LOGICAL_CP_ID_BY_SURFACE_CP_ID[cpId] = cpId;
}
const OBJECTIVE_POSITION_ANCHOR_ID_BY_CP_ID: { [cpId: number]: number } =
  WORLD_IDS.objectivePositionAnchors;

type ObjectiveLetter = "A" | "B" | "C" | "D";
type RuntimeObjectiveHalf = 1 | 2;
type TopHudLane = "A" | "B" | "C" | "D";
type ObjectiveAttemptKind = "arm" | "disarm";
type ObjectiveDefinition = {
  cpId: number;
  mcomId?: number;
  lane: ObjectiveLetter;
  displayLane: ObjectiveLetter;
  half: RuntimeObjectiveHalf;
  side: CipherMapSide;
  sectorId: number;
  anchorId: number;
  defendingTeam: mod.Team;
  countsForRouting: boolean;
};

const OBJECTIVE_DEFINITIONS: ObjectiveDefinition[] = SQUAD_OBJECTIVE_CONFIGS.map((config) => ({
  cpId: config.cpId,
  mcomId: config.mcomId,
  lane: config.lane,
  displayLane: config.displayLane ?? config.lane,
  half: config.half,
  side: config.side,
  sectorId: config.sectorId,
  anchorId: config.anchorId,
  defendingTeam: config.defendingTeamId === 1 ? team1 : team2,
  countsForRouting: config.countsForRouting,
}));

let objectiveDefByCpId: { [cpId: number]: ObjectiveDefinition } = {};
let objectiveDefByMcomId: { [mcomId: number]: ObjectiveDefinition } = {};
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const def = OBJECTIVE_DEFINITIONS[i];
  objectiveDefByCpId[def.cpId] = def;
  if (def.mcomId !== undefined) objectiveDefByMcomId[def.mcomId] = def;
}

function getCipherObjectiveSide(cpId: number): CipherMapSide | undefined {
  const def = objectiveDefByCpId[cpId];
  return def ? def.side : undefined;
}

function getObjectiveDefendingTeamForCurrentHalf(cpId: number): mod.Team {
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
const TOP_HUD_LANES: TopHudLane[] = ["A", "B", "C", "D"];

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
const OBJECTIVE_LANE_BY_INTERACT_POINT_ID: { [interactId: number]: ObjectiveLetter | undefined } = {};
const OBJECTIVE_AREA_TRIGGER_ID_BY_CP_ID: { [cpId: number]: number } =
  WORLD_IDS.areaTriggers.objectiveByCapturePoint;
const OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID: { [triggerId: number]: number } = {};
const OBJECTIVE_LANE_BY_AREA_TRIGGER_ID: { [triggerId: number]: ObjectiveLetter | undefined } = {};
const OBJECTIVE_AREA_TRIGGER_IDS: number[] = [];
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const def = OBJECTIVE_DEFINITIONS[i];
  const cpId = def.cpId;
  const triggerId = OBJECTIVE_AREA_TRIGGER_ID_BY_CP_ID[cpId];
  if (!(triggerId > 0)) continue;
  OBJECTIVE_LANE_BY_AREA_TRIGGER_ID[triggerId] = def.lane;
  if (def.half === 1) OBJECTIVE_CP_ID_BY_AREA_TRIGGER_ID[triggerId] = cpId;
  if (OBJECTIVE_AREA_TRIGGER_IDS.indexOf(triggerId) >= 0) continue;
  OBJECTIVE_AREA_TRIGGER_IDS.push(triggerId);
}
const OBJECTIVE_INTERACT_POINT_IDS: number[] = [];
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const def = OBJECTIVE_DEFINITIONS[i];
  const cpId = def.cpId;
  const interactId = OBJECTIVE_INTERACT_POINT_ID_BY_CP_ID[cpId];
  if (!(interactId > 0)) continue;
  OBJECTIVE_LANE_BY_INTERACT_POINT_ID[interactId] = def.lane;
  if (def.half === 1) OBJECTIVE_CP_ID_BY_INTERACT_POINT_ID[interactId] = cpId;
  if (OBJECTIVE_INTERACT_POINT_IDS.indexOf(interactId) >= 0) continue;
  OBJECTIVE_INTERACT_POINT_IDS.push(interactId);
}

function getObjectiveDefinitionForLaneAndHalf(
  lane: ObjectiveLetter,
  half: RuntimeObjectiveHalf = cipherCurrentHalf
): ObjectiveDefinition | undefined {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    if (def.lane === lane && def.half === half) return def;
  }
  return undefined;
}

function getActiveObjectiveCpIdForLane(lane: ObjectiveLetter): number {
  const def = getObjectiveDefinitionForLaneAndHalf(lane, cipherCurrentHalf);
  return def ? def.cpId : 0;
}

function getActiveObjectiveCpIdsForSide(side: CipherMapSide): number[] {
  const cpIds: number[] = [];
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    if (def.half !== cipherCurrentHalf) continue;
    if (def.side !== side) continue;
    cpIds.push(def.cpId);
  }
  return cpIds;
}

function isObjectiveActiveForCurrentHalf(cpId: number): boolean {
  const def = objectiveDefByCpId[cpId];
  return def !== undefined && def.half === cipherCurrentHalf;
}

function resolveCurrentHalfObjectiveCpIdFromAreaTrigger(triggerId: number): number | undefined {
  const lane = OBJECTIVE_LANE_BY_AREA_TRIGGER_ID[triggerId];
  if (!lane) return undefined;
  const cpId = getActiveObjectiveCpIdForLane(lane);
  return cpId > 0 ? cpId : undefined;
}

function resolveCurrentHalfObjectiveCpIdFromInteractPoint(interactId: number): number | undefined {
  const lane = OBJECTIVE_LANE_BY_INTERACT_POINT_ID[interactId];
  if (!lane) return undefined;
  const cpId = getActiveObjectiveCpIdForLane(lane);
  return cpId > 0 ? cpId : undefined;
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
const BOMB_ANCHOR_OBJECT_IDS = BOMB_CONFIG.anchorObjectIds;
const BOMB_QUAD_BIKE_SPAWN_OBJECT_ID = BOMB_CONFIG.quadBikeSpawnObjectId;

type BombBaseSlotConfig = {
  anchorObjectId: number;
};

const BOMB_BASE_SLOT_CONFIGS: BombBaseSlotConfig[] = BOMB_ANCHOR_OBJECT_IDS.map((anchorObjectId) => ({
  anchorObjectId,
}));
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
const NEXT_KEY_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK = "NEXT KEY\n0{}:{}{}";
const NEXT_KEY_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK = "NEXT KEY\n{}:{}{}";
const NEXT_KEY_HUD_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK = "NEXT KEY UNLOCKS IN 0{}:{}{}";
const NEXT_KEY_HUD_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK = "NEXT KEY UNLOCKS IN {}:{}{}";
const FIRST_KEY_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK = "KEY UNLOCKS\n0{}:{}{}";
const FIRST_KEY_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK = "KEY UNLOCKS\n{}:{}{}";
const FIRST_KEY_HUD_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK = "KEY UNLOCKS IN 0{}:{}{}";
const FIRST_KEY_HUD_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK = "KEY UNLOCKS IN {}:{}{}";
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
const BOMB_CARRIER_ICON_RESEED_COOLDOWN_TICKS = mod.Max(1, mod.Floor(0.5 * TICK_RATE));
const BOMB_CARRIER_ICON_RESEED_COOLDOWN_SECONDS = BOMB_CARRIER_ICON_RESEED_COOLDOWN_TICKS / TICK_RATE;
const BOMB_CARRIER_ICON_HARD_SNAP_DISTANCE_METERS = 4;
const BOMB_CARRIER_DROP_Y_EPSILON_METERS = 0.15;
const BOMB_CARRIER_DROP_STABLE_SECONDS = 1.0;
const ICON_FOLLOW_PREDICT_LEAD_SECONDS = 0.03;
const ICON_FOLLOW_STIFFNESS = 28;
const ICON_FOLLOW_MAX_DT_SECONDS = 0.20;
const ICON_FOLLOW_MAX_SPEED_MPS = 25;
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
  if (def.mcomId === undefined) continue;
  OBJECTIVE_MCOM_ID_BY_CP_ID[def.cpId] = def.mcomId;
  OBJECTIVE_CP_ID_BY_MCOM_ID[def.mcomId] = def.cpId;
  objectiveResolvedMcomIdByCpId[def.cpId] = def.mcomId;
}
const HARD_DISABLED_OBJECTIVE_MCOM_IDS: number[] = [7101, 7102, 7103, 7104];
const EXPECTED_OBJECTIVE_MCOM_IDS: number[] = HARD_DISABLED_OBJECTIVE_MCOM_IDS.slice();
const HARD_DISABLED_OBJECTIVE_MCOM_DROP_Y = -300;
const hardObjectiveMcomMovedBelowMapById: { [mcomId: number]: boolean } = {};
const hardObjectiveMcomInitialPositionById: { [mcomId: number]: mod.Vector | undefined } = {};
const hardObjectiveMcomMoveWarnedByKey: { [key: string]: boolean } = {};

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
  CP_C_ID,
  CP_D_ID,
  CP_A_SECOND_HALF_ID,
  CP_B_SECOND_HALF_ID,
  CP_C_SECOND_HALF_ID,
  CP_D_SECOND_HALF_ID,
];
const OBJECTIVE_AWARD_VFX_ID_BY_CP_ID: { [cpId: number]: number } = {
  [CP_A_ID]: 8101,
  [CP_B_ID]: 8102,
  [CP_C_ID]: 8103,
  [CP_D_ID]: 8201,
  [CP_A_SECOND_HALF_ID]: 8101,
  [CP_B_SECOND_HALF_ID]: 8102,
  [CP_C_SECOND_HALF_ID]: 8103,
  [CP_D_SECOND_HALF_ID]: 8201,
};
const OBJECTIVE_AWARD_VFX_IDS: number[] = [8101, 8102, 8103, 8201];
const objectiveAwardVfx: mod.VFX[] = OBJECTIVE_AWARD_VFX_IDS.map((id) => mod.GetVFX(id));
const OBJECTIVE_ARMED_WORLDICON_ID_BY_CP_ID: { [cpId: number]: number } = {
  [CP_A_ID]: 221,
  [CP_B_ID]: 222,
  [CP_C_ID]: 223,
  [CP_D_ID]: 321,
  [CP_A_SECOND_HALF_ID]: 221,
  [CP_B_SECOND_HALF_ID]: 222,
  [CP_C_SECOND_HALF_ID]: 223,
  [CP_D_SECOND_HALF_ID]: 321,
};
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_NAME = "FX_Car_Fire_M_GS";
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_ID_BY_CP_ID: { [cpId: number]: number } = {
  [CP_A_ID]: 211,
  [CP_B_ID]: 212,
  [CP_C_ID]: 213,
  [CP_D_ID]: 311,
  [CP_A_SECOND_HALF_ID]: 211,
  [CP_B_SECOND_HALF_ID]: 212,
  [CP_C_SECOND_HALF_ID]: 213,
  [CP_D_SECOND_HALF_ID]: 311,
};
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_IDS: number[] = [211, 212, 213, 311];
const objectiveAwardPersistentFirePrimaryVfx: mod.VFX[] = OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_IDS.map((id) =>
  mod.GetVFX(id)
);
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_NAME = "FX_CarFire_FrameCrawl";
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_VFX_ID_BY_CP_ID: { [cpId: number]: number } = {
  [CP_A_ID]: 611,
  [CP_B_ID]: 612,
  [CP_C_ID]: 613,
  [CP_D_ID]: 711,
  [CP_A_SECOND_HALF_ID]: 611,
  [CP_B_SECOND_HALF_ID]: 612,
  [CP_C_SECOND_HALF_ID]: 613,
  [CP_D_SECOND_HALF_ID]: 711,
};
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_VFX_IDS: number[] = [611, 612, 613, 711];
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
const OBJECTIVE_DISABLE_EMP_HIT_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).FX_Gadget_ReconDrone_EMP_Hit;
const OBJECTIVE_DISABLE_SPARK_START_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).FX_Gadget_Sabotage_01_StartSparks;
const OBJECTIVE_DISABLE_SPARK_LOOP_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).FX_Gadget_Sabotage_02_SparkLoop;
const OBJECTIVE_DISABLE_3D_SFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).SFX_Gadgets_EIDOS_Disabled_OneShot3D;
const OBJECTIVE_DISABLE_UI_SFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).SFX_UI_Gauntlet_DataUpload_DataDepositPointDisable_OneShot2D;
const OBJECTIVE_DISABLE_SPARK_LOOP_LIFETIME_SECONDS = 8.0;

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
    anchorObjectId: 215,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_B_ID]: {
    anchorObjectId: 216,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_C_ID]: {
    anchorObjectId: 217,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_D_ID]: {
    anchorObjectId: 218,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_A_SECOND_HALF_ID]: {
    anchorObjectId: 215,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_B_SECOND_HALF_ID]: {
    anchorObjectId: 216,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_C_SECOND_HALF_ID]: {
    anchorObjectId: 217,
    alarmSimple: OBJECTIVE_MCOM_SFX_ALARM_SIMPLE_ASSET,
    alarmLeadout: OBJECTIVE_MCOM_SFX_ALARM_LEADOUT_ASSET,
    arming: OBJECTIVE_MCOM_SFX_ARMING_ASSET,
    arm: OBJECTIVE_MCOM_SFX_ARM_ASSET,
    defused: OBJECTIVE_MCOM_SFX_DEFUSED_ASSET,
    defusing: OBJECTIVE_MCOM_SFX_DEFUSING_ASSET,
  },
  [CP_D_SECOND_HALF_ID]: {
    anchorObjectId: 218,
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
let safeSpawnGenerationByPlayerId: { [playerId: number]: number } = {};
let safeSpawnCheckQueuedGenerationByPlayerId: { [playerId: number]: number | undefined } = {};
let safeSpawnForcedQueuedGenerationByPlayerId: { [playerId: number]: number | undefined } = {};
let lastLiveHqSpawnPointObjIdByPlayerId: { [playerId: number]: number } = {};
let lastForcedSafeSpawnHqObjIdByPlayerId: { [playerId: number]: number } = {};

/* HQ DESYNC FIX: detect "spawned at HQ spawner object origin" and recycle spawn */
let hqDesyncForcedRedeploys: { [playerId: number]: number } = {};

const HQ_DESYNC_SPAWNER_EPSILON_METERS = 0.5; // treat "0 meters" as <= this threshold (float-safe)
const HQ_DESYNC_MAX_FORCED_REDEPLOYS = 2;     // safety: prevent infinite loops


/* Safe spawn tuning */
const SAFE_SPAWN_CHECK_DELAY_SECONDS = SPAWN_ROUTING_CONFIG.safeSpawnCheckDelaySeconds;
const CIPHER_SPAWN_ENEMY_DANGER_RADIUS_METERS = 18;
const SAFE_SPAWN_ENEMY_RADIUS_METERS = CIPHER_SPAWN_ENEMY_DANGER_RADIUS_METERS;
const CIPHER_RESPAWN_ROUTE_EVALUATION_SECONDS = SPAWN_ROUTING_CONFIG.routeEvaluationDurationSeconds;
const CIPHER_RESPAWN_ROUTE_TICK_SECONDS = SPAWN_ROUTING_CONFIG.routeEvaluationTickSeconds;
const CIPHER_RESPAWN_OBJECTIVE_PRESSURE_RADIUS_METERS = SPAWN_ROUTING_CONFIG.objectivePressureRadiusMeters;
const CIPHER_RESPAWN_CANDIDATE_SAFETY_RADIUS_METERS = SPAWN_ROUTING_CONFIG.queuedCandidateSafetyRadiusMeters;
const CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS = SPAWN_ROUTING_CONFIG.rerouteSafetyRadiusMeters;
const CIPHER_RESPAWN_ROUTE_TICK_MS = mod.Max(1, CIPHER_RESPAWN_ROUTE_TICK_SECONDS * 1000);

// This is the number of unsafe attempts allowed before we stop forcing recycle attempts.
const SAFE_SPAWN_MAX_FORCED_REDEPLOYS = 5;
const SAFE_SPAWN_CHECK_DELAY_TICKS = mod.Max(1, mod.Ceiling(SAFE_SPAWN_CHECK_DELAY_SECONDS * TICK_RATE));
const SAFE_SPAWN_CHECK_QUEUE_BUDGET_PER_TICK = 2;
const SAFE_SPAWN_FORCED_QUEUE_BUDGET_PER_TICK = 1;
const SAFE_SPAWN_FORCED_SPAWN_DELAY_TICKS = mod.Max(1, mod.Ceiling(0.2 * TICK_RATE));
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
const CIPHER_NORTH_EAST_NORTH_ANCHORS: number[] = [1411, 1412, 1413, 1414, 1415];
const CIPHER_NORTH_EAST_SOUTH_ANCHORS: number[] = [1421, 1422, 1423, 1424, 1425];
const CIPHER_NORTH_WEST_NORTH_ANCHORS: number[] = [2311, 2312, 2313, 2314, 2315];
const CIPHER_NORTH_WEST_SOUTH_ANCHORS: number[] = [2321, 2322, 2323, 2324, 2325];
const CIPHER_SOUTH_EAST_NORTH_ANCHORS: number[] = [3411, 3412, 3413, 3414, 3415];
const CIPHER_SOUTH_EAST_SOUTH_ANCHORS: number[] = [3421, 3422, 3423, 3424, 3425];
const CIPHER_SOUTH_WEST_NORTH_ANCHORS: number[] = [4311, 4312, 4313, 4314, 4315];
const CIPHER_SOUTH_WEST_SOUTH_ANCHORS: number[] = [4321, 4322, 4323, 4324, 4325];
const CIPHER_ANCHOR_COOLDOWN_SECONDS = 12;
const CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS = CIPHER_SPAWN_ENEMY_DANGER_RADIUS_METERS;

type CipherVectorSnapshot = { x: number; y: number; z: number };
type CipherQueuedSpawnAnchor = {
  anchorObjectId: number;
  side: CipherMapSide;
  region: CipherSpawnRegion;
};
type CipherSpawnJobKind = "queue-anchor" | "teleport-deployed";
type CipherSpawnJob = {
  kind: CipherSpawnJobKind;
  playerId: number;
  createdAtSec: number;
  attempt: number;
};
type CipherRespawnRouteJob = {
  token: number;
  playerId: number;
  teamId: number;
  startedAtSec: number;
  currentSecond: number;
  currentCandidate?: CipherQueuedSpawnAnchor;
  finalizedCandidate?: CipherQueuedSpawnAnchor;
  timerHandle?: number;
  dangerDetected: boolean;
};
type SafeSpawnCheckQueueItem = {
  playerId: number;
  generation: number;
  dueTick: number;
};
type ForcedSafeSpawnStage = "undeploy" | "spawn";
type ForcedSafeSpawnQueueItem = {
  playerId: number;
  generation: number;
  hqObjId: number;
  spawnerObjId: number;
  stage: ForcedSafeSpawnStage;
  dueTick: number;
  waitTicks: number;
};

let cipherPresenceZoneActivePlayersByZone: { [zone: string]: { [playerId: number]: mod.Team } } = {};
let cipherPresenceZonesByPlayerId: { [playerId: number]: { [zone: string]: boolean } } = {};
let cipherAnchorPositionByObjectId: { [objectId: number]: mod.Vector | undefined } = {};
let cipherObjectiveAnchorPositionByCpId: { [cpId: number]: mod.Vector | undefined } = {};
let cipherObjectiveAnchorPositionSnapshotByCpId: { [cpId: number]: CipherVectorSnapshot | undefined } = {};
let cipherPlayerPositionSnapshotByPlayerId: { [playerId: number]: CipherVectorSnapshot | undefined } = {};
let cipherAnchorCooldownUntilSecByObjectId: { [objectId: number]: number } = {};
let cipherAnchorRoundRobinIndexByKey: { [key: string]: number } = {};
let cipherSpawnRegionTieFlipByKey: { [key: string]: number } = {};
let cipherLastSpawnRegionByTeamId: { [teamId: string]: CipherSpawnRegion | undefined } = {};
let cipherLastSpawnRegionAtSecByTeamId: { [teamId: string]: number | undefined } = {};
let cipherQueuedAnchorByPlayerId: { [playerId: number]: CipherQueuedSpawnAnchor | undefined } = {};
let cipherPendingSpawnJobs: CipherSpawnJob[] = [];
let cipherUrgentSpawnJobs: CipherSpawnJob[] = [];
let cipherRespawnRouteJobByPlayerId: { [playerId: number]: CipherRespawnRouteJob | undefined } = {};
const cipherRespawnRouteTokenByPlayerId: { [playerId: number]: number } = {};
const CIPHER_SPAWN_JOBS_PER_TICK = 1;
const CIPHER_SPAWN_RETRY_WINDOW_SECONDS = 0.75;
let safeSpawnCheckQueue: SafeSpawnCheckQueueItem[] = [];
let safeSpawnForcedQueue: ForcedSafeSpawnQueueItem[] = [];



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
    if (def.mcomId === undefined) continue;
    objectiveDefByMcomId[def.mcomId] = def;
    OBJECTIVE_CP_ID_BY_MCOM_ID[def.mcomId] = def.cpId;
    objectiveResolvedMcomIdByCpId[def.cpId] = def.mcomId;
  }

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    const configuredMcomId = def.mcomId;
    if (configuredMcomId === undefined) continue;
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
let objectiveSurfaceSectorObjectiveEnabledBySectorId: { [sectorId: number]: boolean | undefined } = {};
let objectiveSurfaceSyncInProgress = false;
let objectiveSurfaceSyncQueued = false;
let objectiveMcomObjectiveEnabledByCpId: { [cpId: number]: boolean | undefined } = {};
let objectiveMcomSfxHandleByKey: { [key: string]: any } = {};
let objectiveMcomSfxUnavailableByKey: { [key: string]: boolean } = {};
let objectiveMcomSfxMissingWarnedByKey: { [key: string]: boolean } = {};
let objectiveMcomSfxEnabledByKey: { [key: string]: boolean } = {};
let bombAnchorSectorMissingWarned = false;
let bombAnchorObjectMissingWarnedById: { [objectId: number]: boolean } = {};
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
  replacedSlot?: mod.InventorySlots;
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

type ObjectAnchorTransformResult = {
  object: mod.Object | undefined;
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

type BombDynamicLane = "AC" | "BD";
type BombDroppedSourceKind = "none" | "carrier_drop";
type NextKeyUnlockLabelMode = "first_key" | "next_key";
type BombCarrierVerticalState = "stable" | "rising" | "falling";
type BombBeepMode = "none" | "base" | "dropped" | "carrier";
type BombSpawnAnnouncementMode = "new_location_found" | "bomb_located";
type BotObjectiveRole =
  | "seekKey"
  | "deliverKey"
  | "escortCarrier"
  | "interceptCarrier"
  | "revive"
  | "pressureObjective"
  | "regroup";
type BotEnemyTarget = {
  player: mod.Player;
  playerId: number;
  pos: mod.Vector;
  distance: number;
};
type RuntimeBotSlot = {
  slotId: number;
  desiredTeam: mod.Team;
  classToSpawn: mod.SoldierClass;
  spawner: mod.Spawner | undefined;
  spawnerObjId: number;
  player: mod.Player | undefined;
  playerId: number | undefined;
  nextSpawnAtSec: number;
  forceRespawnAfterSec: number;
  spawnToken: number;
  pendingSinceSec: number;
  spawning: boolean;
  retired: boolean;
};
type BombDynamicLaneMidpoint = {
  lane: BombDynamicLane;
  midpoint: mod.Vector;
};
type BombBaseAnchorCandidate = {
  slotIndex: number;
  anchorObjectId: number;
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
let cipherKeyTimeCarrierPlayerId: number | undefined = undefined;
let cipherKeyTimeLastWholeSecond: number | undefined = undefined;
let bombCarrierReplacedSlotByPlayerId: { [playerId: number]: mod.InventorySlots | undefined } = {};
let bombCarrierPreviousEquipmentByPlayerId: { [playerId: number]: BombRestoreEquipment | undefined } = {};
let bombCarrierRestoreAmmoByPlayerId: { [playerId: number]: BombRestoreAmmoState | undefined } = {};
let bombCarrierDeployRestoreEquipmentByPlayerId: { [playerId: number]: BombRestoreEquipment | undefined } = {};
let bombDeployLoadoutApplyTokenByPlayerId: { [playerId: number]: number } = {};
let bombDeployLoadoutApplyTokenCounter = 0;
let bombCarrierRestoreInsertTokenByPlayerId: { [playerId: number]: number } = {};
let bombCarrierRestoreInsertTokenCounter = 0;
let bombPickupTransferInProgress = false;
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
let bombCarrierIconFollowReseedBlockedUntilSec = 0;
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
let cipherDeferredLiveStartKeyTimerHandle: number | undefined = undefined;
let nextKeyUnlockCountdownToken = 0;
let nextKeyUnlockDeadlineAtSec = 0;
let nextKeyUnlockAnchorPosition: mod.Vector | undefined = undefined;
let nextKeyUnlockWorldIconObject: mod.Object | undefined = undefined;
let nextKeyUnlockWorldIconHandle: mod.WorldIcon | undefined = undefined;
let nextKeyUnlockWorldIconLastShownSeconds = -1;
let nextKeyUnlockLabelMode: NextKeyUnlockLabelMode = "next_key";
let nextKeyUnlockHudLastStateByPlayerId: { [playerId: number]: string | undefined } = {};
let nextKeyUnlockWorldIconMissingWarned = false;
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
let botObjectiveNextThinkAtSec = 0;
let botObjectiveAssignedRoleByPlayerId: { [playerId: number]: BotObjectiveRole | undefined } = {};
let botObjectiveLastCommandAtSecByPlayerId: { [playerId: number]: number | undefined } = {};
let botObjectiveLastTargetByPlayerId: { [playerId: number]: mod.Vector | undefined } = {};
let botObjectiveTargetPlayerIdByPlayerId: { [playerId: number]: number | undefined } = {};
let botObjectiveTargetRefreshAtSecByPlayerId: { [playerId: number]: number | undefined } = {};
let botReviveTargetPlayerIdByReviverId: { [playerId: number]: number | undefined } = {};
let botReviveAssignmentStartedAtSecByReviverId: { [playerId: number]: number | undefined } = {};
let botLiveSpawnRequestedByPlayerId: { [playerId: number]: boolean | undefined } = {};
let botLiveSpawnNextAttemptAtSecByPlayerId: { [playerId: number]: number | undefined } = {};
let botBackfillKnownByPlayerId: { [playerId: number]: boolean | undefined } = {};
let runtimeBotSlotsBySlotId: { [slotId: number]: RuntimeBotSlot | undefined } = {};
let runtimeBotSlotByPlayerId: { [playerId: number]: number | undefined } = {};
let runtimeBotPendingSlotIdsBySpawnerObjId: { [spawnerObjId: number]: number[] | undefined } = {};
let runtimeBotAuthoredSpawnerByObjId: { [spawnerObjId: number]: mod.Spawner | undefined } = {};
let runtimeBotReleasedPlayerId: { [playerId: number]: boolean | undefined } = {};
let runtimeBotRespawnAfterSecByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherRuntimeBotsEnabled = CIPHER_RUNTIME_BOTS_DEFAULT_ENABLED;
let runtimeBotNextSlotId = 1;
let runtimeBotNextReconcileAtSec = 0;
let runtimeBotSpawnTokenCounter = 0;
let runtimeBotSpawnerValidationComplete = false;
let runtimeBotSpawnerValidationFailed = false;
let runtimeBotSpawnerValidationWarned = false;
let runtimeBotPhaseLockedByPlayerId: { [playerId: number]: boolean | undefined } = {};
let runtimeBotStagedSpawnNextTick = 0;
let runtimeBotStagedSpawnTeamToggle = 0;
let runtimeBotLockReapplyNextTick = 0;
let cipherTransitionReconcileQueued = false;
let cipherTransitionReconcileReason = "";
let cipherLiveStartSettlingUntilSec = 0;
let cipherLiveStartSettlingStage: CipherMatchStage | "none" = "none";
let cipherLiveStartSettleToken = 0;
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

let carrierIconVisualLastSampleSec = 0;
let carrierIconVisualLastCarrierPos: mod.Vector | undefined = undefined;
let carrierIconVisualVelocity = mod.CreateVector(0, 0, 0);
let carrierIconFriendlyVisualPos: mod.Vector | undefined = undefined;
let carrierIconEnemyVisualPos: mod.Vector | undefined = undefined;

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

function warnBombAnchorObjectMissingOnce(anchorObjectId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombAnchorObjectMissingWarnedById[anchorObjectId] === true) return;
  bombAnchorObjectMissingWarnedById[anchorObjectId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[BOMB BASE] Anchor object {} unavailable ({})", anchorObjectId, reason)
  );
}

function warnBombQuadBikeAnchorMissingOnce(anchorObjectId: number, reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (bombQuadBikeAnchorMissingWarned) return;
  bombQuadBikeAnchorMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[QUAD BIKE] Required spawn object {} unavailable ({})",
      anchorObjectId,
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

function resolveSpatialObjectTransformById(
  objectId: number,
  warnMissingOnce?: (objectId: number, reason: string) => void
): ObjectAnchorTransformResult {
  let spatialObject: mod.Object | undefined = undefined;

  try {
    spatialObject = mod.GetSpatialObject(objectId) as unknown as mod.Object;
  } catch (_err) {
    if (warnMissingOnce) warnMissingOnce(objectId, "GetSpatialObject failed");
    return {
      object: undefined,
      objId: -1,
      position: undefined,
      rotation: undefined,
      reason: "spatial_object_missing",
    };
  }

  const objId = getObjIdSafe(spatialObject);

  let position: mod.Vector | undefined = undefined;
  try {
    position = mod.GetObjectPosition(spatialObject);
  } catch (_err) {
    if (warnMissingOnce) warnMissingOnce(objectId, "GetObjectPosition failed");
    return {
      object: spatialObject,
      objId,
      position: undefined,
      rotation: undefined,
      reason: "position_unavailable",
    };
  }

  try {
    return {
      object: spatialObject,
      objId,
      position,
      rotation: mod.GetObjectRotation(spatialObject),
      reason: "ok",
    };
  } catch (_err) {
    return {
      object: spatialObject,
      objId,
      position,
      rotation: undefined,
      reason: "rotation_unavailable",
    };
  }
}

function tryResolveQuadBikeSpawnObjectTransform(): ObjectAnchorTransformResult | undefined {
  if (BOMB_QUAD_BIKE_SPAWN_OBJECT_ID <= 0) return undefined;

  const transform = resolveSpatialObjectTransformById(
    BOMB_QUAD_BIKE_SPAWN_OBJECT_ID,
    warnBombQuadBikeAnchorMissingOnce
  );
  if (!transform.position) return undefined;

  const origin = mod.CreateVector(0, 0, 0);
  const distanceFromOrigin = mod.DistanceBetween(transform.position, origin);
  if (!Number.isFinite(distanceFromOrigin) || distanceFromOrigin <= 0.01) {
    warnBombQuadBikeAnchorMissingOnce(BOMB_QUAD_BIKE_SPAWN_OBJECT_ID, "position_invalid");
    return undefined;
  }

  return transform;
}

function validateRequiredQuadBikeAnchorConfigurationOnce(): void {
  if (BOMB_QUAD_BIKE_SPAWN_OBJECT_ID <= 0) return;
  void tryResolveQuadBikeSpawnObjectTransform();
}

function tryGetBombAnchorObjectTransformById(
  anchorObjectId: number,
  context: string
): ObjectAnchorTransformResult {
  const result = resolveSpatialObjectTransformById(anchorObjectId, warnBombAnchorObjectMissingOnce);
  if (!result.position) {
    setBombSpawnValidationDebugState(
      context,
      result.reason === "spatial_object_missing" ? "anchor_object_missing" : "anchor_object_position_unavailable",
      anchorObjectId
    );
  }
  return result;
}

function tryGetBombAnchorObjectPositionById(
  anchorObjectId: number,
  context: string
): mod.Vector | undefined {
  return tryGetBombAnchorObjectTransformById(anchorObjectId, context).position;
}

function getBombBaseSlotSpatialPosition(slotIndex: number): mod.Vector | undefined {
  const cfg = getBombBaseSlotConfig(slotIndex);
  if (!cfg) return undefined;
  return tryGetBombAnchorObjectPositionById(cfg.anchorObjectId, "bomb_base_slot_spatial_position");
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
      invalidSlotIds.push(String(cfg.anchorObjectId));
      continue;
    }

    const fromOrigin = mod.DistanceBetween(pos, zero);
    if (!Number.isFinite(fromOrigin) || fromOrigin <= 0.01) {
      invalidSlotIds.push(String(cfg.anchorObjectId));
    }
  }

  if (invalidSlotIds.length <= 0) return;
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[BOMB BASE] Anchor object config invalid/zero-vector for {}",
      invalidSlotIds.join(",")
    )
  );
}

function tryGetStaticBombLootSpawnerPosition(): mod.Vector | undefined {
  const cfg = getActiveBombBaseSlotConfig();
  return tryGetBombAnchorObjectPositionById(cfg.anchorObjectId, "bomb_anchor_position");
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
        bombPickupTriggerInitialPosition = mod.GetObjectPosition(trigger as unknown as mod.Object);
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

function formatNextKeyWorldIconTimerLabel(
  totalSeconds: number,
  labelMode: NextKeyUnlockLabelMode = nextKeyUnlockLabelMode
): any {
  let safeSeconds = totalSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds < 0) safeSeconds = 0;
  safeSeconds = mod.Floor(safeSeconds);
  const minutes = mod.Floor(safeSeconds / 60);
  const totalSecondsRemainder = mod.Floor(safeSeconds % 60);
  const seconds1 = totalSecondsRemainder % 10;
  const seconds10 = mod.Floor(totalSecondsRemainder / 10);
  const singleDigitKey =
    labelMode === "first_key"
      ? FIRST_KEY_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK
      : NEXT_KEY_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK;
  const doubleDigitKey =
    labelMode === "first_key"
      ? FIRST_KEY_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK
      : NEXT_KEY_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK;
  if (minutes < 10) {
    return mod.Message(singleDigitKey, minutes, seconds10, seconds1);
  }
  return mod.Message(doubleDigitKey, minutes, seconds10, seconds1);
}

function formatNextKeyHudTimerLabel(
  totalSeconds: number,
  labelMode: NextKeyUnlockLabelMode = nextKeyUnlockLabelMode
): any {
  let safeSeconds = totalSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds < 0) safeSeconds = 0;
  safeSeconds = mod.Floor(safeSeconds);
  const minutes = mod.Floor(safeSeconds / 60);
  const totalSecondsRemainder = mod.Floor(safeSeconds % 60);
  const seconds1 = totalSecondsRemainder % 10;
  const seconds10 = mod.Floor(totalSecondsRemainder / 10);
  const singleDigitKey =
    labelMode === "first_key"
      ? FIRST_KEY_HUD_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK
      : NEXT_KEY_HUD_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK;
  const doubleDigitKey =
    labelMode === "first_key"
      ? FIRST_KEY_HUD_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK
      : NEXT_KEY_HUD_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK;
  if (minutes < 10) {
    return mod.Message(singleDigitKey, minutes, seconds10, seconds1);
  }
  return mod.Message(doubleDigitKey, minutes, seconds10, seconds1);
}

function warnNextKeyUnlockWorldIconMissingOnce(reason: string): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (nextKeyUnlockWorldIconMissingWarned) return;
  nextKeyUnlockWorldIconMissingWarned = true;
  emitStringKeyDebugWorldLog(
    mod.Message("[NEXT KEY] Runtime WorldIcon unavailable ({})", reason)
  );
}

function isNextKeyUnlockCountdownActive(): boolean {
  return (
    nextKeyUnlockCountdownToken > 0 &&
    nextKeyUnlockDeadlineAtSec > 0 &&
    nextKeyUnlockAnchorPosition !== undefined
  );
}

function getNextKeyUnlockRemainingSeconds(nowSec?: number): number {
  if (!isNextKeyUnlockCountdownActive()) return 0;
  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  return mod.Max(0, mod.Ceiling(nextKeyUnlockDeadlineAtSec - resolvedNowSec));
}

function clearNextKeyUnlockRuntimeWorldIcon(_context: string): void {
  if (nextKeyUnlockWorldIconHandle) {
    try {
      mod.EnableWorldIconText(nextKeyUnlockWorldIconHandle, false);
      mod.EnableWorldIconImage(nextKeyUnlockWorldIconHandle, false);
    } catch (_errDisable) {}
  }
  if (nextKeyUnlockWorldIconObject) {
    unspawnObjectSafe(nextKeyUnlockWorldIconObject, "next key unlock world icon");
  } else if (nextKeyUnlockWorldIconHandle) {
    unspawnObjectSafe(nextKeyUnlockWorldIconHandle as unknown, "next key unlock world icon handle", false);
  }
  nextKeyUnlockWorldIconObject = undefined;
  nextKeyUnlockWorldIconHandle = undefined;
  nextKeyUnlockWorldIconLastShownSeconds = -1;
}

function configureNextKeyUnlockWorldIcon(icon: mod.WorldIcon, pos: mod.Vector, remainingSeconds: number): boolean {
  try {
    mod.SetWorldIconPosition(icon, pos);
    mod.SetWorldIconText(icon, formatNextKeyWorldIconTimerLabel(remainingSeconds));
    mod.SetWorldIconColor(icon, COLOR_NEUTRAL);
    mod.EnableWorldIconImage(icon, false);
    mod.EnableWorldIconText(icon, true);
    return true;
  } catch (_err) {
    return false;
  }
}

function spawnOrUpdateNextKeyUnlockWorldIcon(remainingSeconds: number, force: boolean = false): void {
  if (!isNextKeyUnlockCountdownActive() || !nextKeyUnlockAnchorPosition) {
    clearNextKeyUnlockRuntimeWorldIcon("inactive");
    return;
  }

  const iconPos = mod.Add(nextKeyUnlockAnchorPosition, NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET);
  let runtimeIcon = nextKeyUnlockWorldIconHandle;
  if (!runtimeIcon && nextKeyUnlockWorldIconObject) {
    runtimeIcon = resolveRuntimeWorldIconHandle(nextKeyUnlockWorldIconObject as unknown);
    if (runtimeIcon) nextKeyUnlockWorldIconHandle = runtimeIcon;
  }

  if (!runtimeIcon) {
    const iconSpawn = spawnRuntimeCommonObjectSafe(
      mod.RuntimeSpawn_Common.WorldIcon,
      iconPos,
      BOMB_DROP_ROTATION,
      "next_key_unlock_world_icon"
    );
    if (!iconSpawn.object) {
      warnNextKeyUnlockWorldIconMissingOnce("SpawnObject failed");
      return;
    }
    nextKeyUnlockWorldIconObject = iconSpawn.object;
    runtimeIcon = resolveRuntimeWorldIconHandle(iconSpawn.object as unknown);
    if (!runtimeIcon) {
      warnNextKeyUnlockWorldIconMissingOnce("resolve handle failed");
      clearNextKeyUnlockRuntimeWorldIcon("resolve_failed");
      return;
    }
    nextKeyUnlockWorldIconHandle = runtimeIcon;
    force = true;
  } else if (nextKeyUnlockWorldIconObject) {
    moveObjectToAbsolutePositionSafe(nextKeyUnlockWorldIconObject, iconPos, "next_key_unlock_world_icon_move");
  }

  if (force || nextKeyUnlockWorldIconLastShownSeconds !== remainingSeconds) {
    if (!configureNextKeyUnlockWorldIcon(runtimeIcon, iconPos, remainingSeconds)) {
      warnNextKeyUnlockWorldIconMissingOnce("configure failed");
      clearNextKeyUnlockRuntimeWorldIcon("configure_failed");
      return;
    }
    nextKeyUnlockWorldIconLastShownSeconds = remainingSeconds;
  }
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
    const anchorPos = tryGetBombAnchorObjectPositionById(
      cfg.anchorObjectId,
      "bomb_base_audio_anchor_object_" + String(cfg.anchorObjectId)
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
  _object: mod.Object | undefined,
  targetPos: mod.Vector,
  _previousTargetPos: mod.Vector | undefined,
  context: string
): boolean {
  if (!icon) return false;
  return setBombCarrierIconPositionSafe(icon, targetPos, context + "_handle");
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
  bombCarrierIconFollowReseedBlockedUntilSec = 0;
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
  bombCarrierIconFollowReseedBlockedUntilSec = 0;
  bombCarrierEnemyBlinkStartAtSec = nowSec ?? getCurrentSchedulerNowSeconds();

  carrierIconVisualLastSampleSec = nowSec ?? getCarrierSubtickNowSec();
  carrierIconVisualLastCarrierPos = carrierPos;
  carrierIconVisualVelocity = mod.CreateVector(0, 0, 0);
  carrierIconFriendlyVisualPos = carrierPos;
  carrierIconEnemyVisualPos = carrierPos;
}

function syncCipherCarrierVisualsNow(nowSec?: number, _reason: string = "tick"): void {
  if (ENABLE_CARRIER_SUBTICK) {
    updateBombCarrierRuntimeWorldIconsVisualFollowFrame(nowSec);
  }

  updateBombCarrierRuntimeWorldIconsTick(nowSec);
}

function getCarrierSubtickNowSec(): number {
  if (!ENABLE_CARRIER_SUBTICK) return getCurrentSchedulerNowSeconds();
  return getVisualSubtickNowSec();
}

function clampVectorMagnitude(vector: mod.Vector, maxMagnitude: number): mod.Vector {
  if (!Number.isFinite(maxMagnitude) || maxMagnitude <= 0) return mod.CreateVector(0, 0, 0);

  const zero = mod.CreateVector(0, 0, 0);
  const magnitude = mod.DistanceBetween(vector, zero);

  if (!Number.isFinite(magnitude) || magnitude <= 0.0001) return mod.CreateVector(0, 0, 0);
  if (magnitude <= maxMagnitude) return vector;

  return mod.Multiply(mod.Normalize(vector), maxMagnitude);
}

function updateBombCarrierRuntimeWorldIconsVisualFollowFrame(nowSec?: number): void {
  if (!ENABLE_CARRIER_SUBTICK) return;

  const now = nowSec ?? getCarrierSubtickNowSec();

  if (gameStatus !== 3 || bombCarrierPlayerId === undefined) {
    resetCarrierIconVisualFollowState();
    return;
  }

  if (!bombCarrierFriendlyIconHandle || !bombCarrierEnemyIconHandle) return;

  const carrier = serverPlayers.get(bombCarrierPlayerId);
  if (!carrier || !carrier.isDeployed || !mod.IsPlayerValid(carrier.player) || !isPlayerAlive(carrier.player)) {
    resetCarrierIconVisualFollowState();
    return;
  }

  const carrierPos = getBombCarrierIconTargetPositionForPlayerId(bombCarrierPlayerId, carrier.player);
  if (!carrierPos) return;

  if (
    !carrierIconVisualLastCarrierPos ||
    carrierIconVisualLastSampleSec <= 0 ||
    !carrierIconFriendlyVisualPos ||
    !carrierIconEnemyVisualPos
  ) {
    carrierIconVisualLastSampleSec = now;
    carrierIconVisualLastCarrierPos = carrierPos;
    carrierIconVisualVelocity = mod.CreateVector(0, 0, 0);
    carrierIconFriendlyVisualPos = carrierPos;
    carrierIconEnemyVisualPos = carrierPos;

    setBombCarrierIconPositionSafe(
      bombCarrierFriendlyIconHandle,
      carrierPos,
      "carrier_icon_friendly_init"
    );

    setBombCarrierIconPositionSafe(
      bombCarrierEnemyIconHandle,
      carrierPos,
      "carrier_icon_enemy_init"
    );

    return;
  }

  let dt = now - carrierIconVisualLastSampleSec;
  if (!Number.isFinite(dt) || dt < 0.001) dt = 0.001;
  if (dt > ICON_FOLLOW_MAX_DT_SECONDS) dt = ICON_FOLLOW_MAX_DT_SECONDS;

  const measuredVelocity = clampVectorMagnitude(
    mod.Divide(mod.Subtract(carrierPos, carrierIconVisualLastCarrierPos), dt),
    ICON_FOLLOW_MAX_SPEED_MPS
  );

  const followAlpha = clampNumber(1 - Math.exp(-ICON_FOLLOW_STIFFNESS * dt), 0, 1);

  carrierIconVisualVelocity = mod.Add(
    carrierIconVisualVelocity,
    mod.Multiply(mod.Subtract(measuredVelocity, carrierIconVisualVelocity), followAlpha)
  );

  const predictedPos = mod.Add(
    carrierPos,
    mod.Multiply(carrierIconVisualVelocity, ICON_FOLLOW_PREDICT_LEAD_SECONDS)
  );

  carrierIconFriendlyVisualPos = mod.Add(
    carrierIconFriendlyVisualPos,
    mod.Multiply(mod.Subtract(predictedPos, carrierIconFriendlyVisualPos), followAlpha)
  );

  carrierIconEnemyVisualPos = mod.Add(
    carrierIconEnemyVisualPos,
    mod.Multiply(mod.Subtract(predictedPos, carrierIconEnemyVisualPos), followAlpha)
  );

  const movedFriendly = setBombCarrierIconPositionSafe(
    bombCarrierFriendlyIconHandle,
    carrierIconFriendlyVisualPos,
    "carrier_icon_friendly_subtick"
  );

  const movedEnemy = setBombCarrierIconPositionSafe(
    bombCarrierEnemyIconHandle,
    carrierIconEnemyVisualPos,
    "carrier_icon_enemy_subtick"
  );

  if (!movedFriendly || !movedEnemy) {
    if (now >= bombCarrierIconFollowReseedBlockedUntilSec) {
      clearBombCarrierRuntimeWorldIcons();
      bombCarrierIconFollowReseedBlockedUntilSec = now + BOMB_CARRIER_ICON_RESEED_COOLDOWN_SECONDS;
    }

    return;
  }

  carrierIconVisualLastSampleSec = now;
  carrierIconVisualLastCarrierPos = carrierPos;

  bombCarrierLastSourcePos = carrierPos;
  bombCarrierFriendlyLastPos = carrierIconFriendlyVisualPos;
  bombCarrierEnemyLastPos = carrierIconEnemyVisualPos;

  const followError = mod.DistanceBetween(carrierIconFriendlyVisualPos, carrierPos);
  if (Number.isFinite(followError)) {
    carrierIconVisualErrorSumMeters += followError;
    carrierIconVisualErrorSamples += 1;
    if (followError > carrierIconVisualErrorMaxMeters) carrierIconVisualErrorMaxMeters = followError;
  }
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
    if (now < bombCarrierIconFollowReseedBlockedUntilSec) return;

    spawnBombCarrierRuntimeWorldIcons(
      carrier.player,
      now,
      getCipherKeyTeamSnapshot(bombCarrierPlayerId) ?? carrier.team
    );

    bombCarrierIconFollowReseedBlockedUntilSec = now + BOMB_CARRIER_ICON_RESEED_COOLDOWN_SECONDS;
    return;
  }

  const carrierPos = getBombCarrierIconTargetPositionForPlayerId(bombCarrierPlayerId, carrier.player);
  if (!carrierPos) return;

  const nextFriendlyPos = carrierIconFriendlyVisualPos ?? bombCarrierFriendlyLastPos ?? carrierPos;
  const nextEnemyPos = carrierIconEnemyVisualPos ?? bombCarrierEnemyLastPos ?? carrierPos;

  const movedFriendly = setBombCarrierIconPositionSafe(
    bombCarrierFriendlyIconHandle,
    nextFriendlyPos,
    "carrier_icon_friendly_tick"
  );

  const movedEnemy = setBombCarrierIconPositionSafe(
    bombCarrierEnemyIconHandle,
    nextEnemyPos,
    "carrier_icon_enemy_tick"
  );

  if (!movedFriendly || !movedEnemy) {
    if (now < bombCarrierIconFollowReseedBlockedUntilSec) return;

    clearBombCarrierRuntimeWorldIcons();

    spawnBombCarrierRuntimeWorldIcons(
      carrier.player,
      now,
      getCipherKeyTeamSnapshot(bombCarrierPlayerId) ?? carrier.team
    );

    bombCarrierIconFollowReseedBlockedUntilSec = now + BOMB_CARRIER_ICON_RESEED_COOLDOWN_SECONDS;
    return;
  }

  bombCarrierLastSourcePos = carrierPos;
  bombCarrierFriendlyLastPos = nextFriendlyPos;
  bombCarrierEnemyLastPos = nextEnemyPos;

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
    if (isCipherRuntimeBotPlayerId(sp.id)) return;
    if (isBotBackfillPlayer(sp.player)) return;

    const playerTeam = getCipherKeyTeamSnapshot(sp.id) ?? sp.team;
    if (!mod.Equals(playerTeam, team1) && !mod.Equals(playerTeam, team2)) return;

    const pos = tryGetPlayerPositionSafe(sp.player);
    if (!pos) return;
    positions.push(pos);
  });

  return positions;
}

function getObjectivePositionAnchorObjectId(cpId: number): number | undefined {
  const anchorObjectId = OBJECTIVE_POSITION_ANCHOR_ID_BY_CP_ID[cpId];
  return anchorObjectId > 0 ? anchorObjectId : undefined;
}

function getObjectiveAnchorPosition(cpId: number): mod.Vector | undefined {
  const anchorObjectId = getObjectivePositionAnchorObjectId(cpId);
  if (!anchorObjectId) {
    return getObjectiveFallbackPosition(cpId);
  }

  try {
    const anchorObject = mod.GetSpatialObject(anchorObjectId) as unknown as mod.Object;
    return mod.GetObjectPosition(anchorObject);
  } catch (_err) {
    return getObjectiveFallbackPosition(cpId);
  }
}

function getObjectiveFallbackPosition(cpId: number): mod.Vector | undefined {
  const mcomPos = tryGetObjectiveMcomPosition(cpId);
  if (mcomPos) return mcomPos;

  const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "getObjectiveFallbackPosition");
  if (!capturePoint) return undefined;

  try {
    return mod.GetObjectPosition(capturePoint as unknown as mod.Object);
  } catch (_err) {
    return undefined;
  }
}

function clearBotObjectiveStateForPlayer(playerId: number): void {
  delete botObjectiveAssignedRoleByPlayerId[playerId];
  delete botObjectiveLastCommandAtSecByPlayerId[playerId];
  delete botObjectiveLastTargetByPlayerId[playerId];
  delete botObjectiveTargetPlayerIdByPlayerId[playerId];
  delete botObjectiveTargetRefreshAtSecByPlayerId[playerId];
  delete botReviveTargetPlayerIdByReviverId[playerId];
  delete botReviveAssignmentStartedAtSecByReviverId[playerId];
  delete botLiveSpawnRequestedByPlayerId[playerId];
  delete botLiveSpawnNextAttemptAtSecByPlayerId[playerId];
}

function clearBotObjectiveAssignments(): void {
  botObjectiveAssignedRoleByPlayerId = {};
  botObjectiveLastCommandAtSecByPlayerId = {};
  botObjectiveLastTargetByPlayerId = {};
  botObjectiveTargetPlayerIdByPlayerId = {};
  botObjectiveTargetRefreshAtSecByPlayerId = {};
  botReviveTargetPlayerIdByReviverId = {};
  botReviveAssignmentStartedAtSecByReviverId = {};
  botObjectiveNextThinkAtSec = 0;
}

function clearBotObjectiveState(): void {
  clearBotObjectiveAssignments();
  botLiveSpawnRequestedByPlayerId = {};
  botLiveSpawnNextAttemptAtSecByPlayerId = {};
}

function getPlayerIdSafe(player: mod.Player): number | undefined {
  try {
    return modlib.getPlayerId(player);
  } catch (_err) {
    return undefined;
  }
}

function markBotBackfillPlayerId(playerId: number): void {
  botBackfillKnownByPlayerId[playerId] = true;
}

function isKnownBotBackfillPlayerId(playerId: number): boolean {
  return botBackfillKnownByPlayerId[playerId] === true;
}

function isBotBackfillPlayerSafe(player: mod.Player): boolean {
  const playerId = getPlayerIdSafe(player);
  try {
    const isBot = isBotBackfillPlayer(player);
    if (isBot && playerId !== undefined) markBotBackfillPlayerId(playerId);
    if (isBot) return true;
  } catch (_err) {
    return playerId !== undefined && isKnownBotBackfillPlayerId(playerId);
  }
  return playerId !== undefined && isKnownBotBackfillPlayerId(playerId);
}

function getRuntimeBotSlotById(slotId: number | undefined): RuntimeBotSlot | undefined {
  if (slotId === undefined) return undefined;
  const slot = runtimeBotSlotsBySlotId[slotId];
  if (!slot || slot.retired) return undefined;
  return slot;
}

function getRuntimeBotSlotForPlayerId(playerId: number): RuntimeBotSlot | undefined {
  return getRuntimeBotSlotById(runtimeBotSlotByPlayerId[playerId]);
}

function isCipherRuntimeBotPlayerId(playerId: number): boolean {
  return getRuntimeBotSlotForPlayerId(playerId) !== undefined || runtimeBotReleasedPlayerId[playerId] === true;
}

function isCipherRuntimeBotPlayer(player: mod.Player): boolean {
  const playerId = getPlayerIdSafe(player);
  return playerId !== undefined && isCipherRuntimeBotPlayerId(playerId);
}

function shouldSkipHumanInputRestrictionsForPlayer(player: mod.Player): boolean {
  const playerId = getPlayerIdSafe(player);
  if (playerId !== undefined && isCipherRuntimeBotPlayerId(playerId)) return true;
  return isBotBackfillPlayerSafe(player);
}

function clearRuntimeBotPlayerBinding(slot: RuntimeBotSlot, releaseOldPlayerId: boolean): void {
  const oldPlayerId = slot.playerId;
  if (oldPlayerId !== undefined) {
    delete runtimeBotSlotByPlayerId[oldPlayerId];
    delete runtimeBotRespawnAfterSecByPlayerId[oldPlayerId];
    delete runtimeBotPhaseLockedByPlayerId[oldPlayerId];
    if (releaseOldPlayerId) runtimeBotReleasedPlayerId[oldPlayerId] = true;
    clearBotObjectiveStateForPlayer(oldPlayerId);
  }
  slot.player = undefined;
  slot.playerId = undefined;
  slot.spawning = false;
  slot.forceRespawnAfterSec = 0;
  slot.pendingSinceSec = 0;
}

function configureRuntimeBotCombat(player: mod.Player): void {
  try {
    mod.AIEnableTargeting(player, true);
  } catch (_errTargeting) {}
  try {
    mod.AIEnableShooting(player, true);
  } catch (_errShooting) {}
  try {
    mod.AIGadgetSettings(player, true, true, true);
  } catch (_errGadgets) {}
}

function configureRuntimeBotLocked(player: mod.Player): void {
  try {
    mod.AIEnableTargeting(player, false);
  } catch (_errTargeting) {}
  try {
    mod.AIEnableShooting(player, false);
  } catch (_errShooting) {}
  try {
    mod.AIGadgetSettings(player, false, false, false);
  } catch (_errGadgets) {}
  try {
    mod.AISetTarget(player);
  } catch (_errClearTarget) {}
}

function shouldRuntimeBotsBePhaseLocked(): boolean {
  if (gameStatus === 2) return true;
  if (isCipherLiveTransitionActive()) return true;
  return cipherLiveStartSettlingStage !== "none" && getCurrentSchedulerNowSeconds() < cipherLiveStartSettlingUntilSec;
}

function isRuntimeBotPhaseLocked(playerId: number): boolean {
  return runtimeBotPhaseLockedByPlayerId[playerId] === true || shouldRuntimeBotsBePhaseLocked();
}

function applyRuntimeBotPhaseLockForPlayer(player: mod.Player, playerId: number, _source: string): void {
  if (!mod.IsPlayerValid(player)) return;

  runtimeBotPhaseLockedByPlayerId[playerId] = true;
  clearBotObjectiveStateForPlayer(playerId);

  // Runtime bots are not human clients. Do not use Portal input restrictions on AI.
  configureRuntimeBotLocked(player);

  const sp = serverPlayers.get(playerId);
  if (!sp || !sp.isDeployed) return;

  try {
    mod.SetPlayerMovementSpeedMultiplier(player, 0);
  } catch (_errSpeed) {}
}

function releaseRuntimeBotPhaseLockForPlayer(player: mod.Player, playerId: number, _source: string): void {
  if (!mod.IsPlayerValid(player)) return;

  delete runtimeBotPhaseLockedByPlayerId[playerId];

  const sp = serverPlayers.get(playerId);
  if (sp && sp.isDeployed) {
    try {
      mod.SetPlayerMovementSpeedMultiplier(player, 1);
    } catch (_errSpeed) {}
  }

  configureRuntimeBotCombat(player);
}

function applyRuntimeBotPhaseLocksForAll(source: string): void {
  if (serverTickCount < runtimeBotLockReapplyNextTick) return;
  runtimeBotLockReapplyNextTick = serverTickCount + CIPHER_RUNTIME_BOT_LOCK_REAPPLY_INTERVAL_TICKS;
  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    if (!getRuntimeBotSlotForPlayerId(sp.id)) return;
    if (!sp.isDeployed) return;
    applyRuntimeBotPhaseLockForPlayer(sp.player, sp.id, source);
  });
}

function releaseRuntimeBotPhaseLocksForAll(source: string): void {
  runtimeBotPhaseLockedByPlayerId = {};
  runtimeBotLockReapplyNextTick = 0;
  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    if (!getRuntimeBotSlotForPlayerId(sp.id)) return;
    releaseRuntimeBotPhaseLockForPlayer(sp.player, sp.id, source);
  });
}

function finishRuntimeBotLiveStartSettle(token: number, expectedStage: CipherMatchStage, source: string): void {
  if (token !== cipherLiveStartSettleToken) return;
  if (gameStatus !== 3 || cipherMatchStage !== expectedStage) return;
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;

  cipherLiveStartSettlingStage = "none";
  cipherLiveStartSettlingUntilSec = 0;
  releaseRuntimeBotPhaseLocksForAll(source + "_release");
  requestCipherTransitionReconcile(source + "_settled");
  botObjectiveNextThinkAtSec = 0;
  runtimeBotNextReconcileAtSec = 0;
}

function isCipherLiveStartSettling(): boolean {
  return cipherLiveStartSettlingStage !== "none" && getCurrentSchedulerNowSeconds() < cipherLiveStartSettlingUntilSec;
}

function startRuntimeBotLiveStartSettle(expectedStage: CipherMatchStage, source: string): void {
  cipherLiveStartSettleToken += 1;
  const token = cipherLiveStartSettleToken;
  cipherLiveStartSettlingStage = expectedStage;
  cipherLiveStartSettlingUntilSec = getCurrentSchedulerNowSeconds() + CIPHER_TRANSITION_LIVE_START_SETTLE_SECONDS;
  runtimeBotLockReapplyNextTick = 0;
  applyRuntimeBotPhaseLocksForAll(source + "_settle");
  Timers.setTimeout(
    () => finishRuntimeBotLiveStartSettle(token, expectedStage, source),
    CIPHER_TRANSITION_LIVE_START_SETTLE_SECONDS * 1000
  );
}

function routeRuntimeBotToCipherSpawnAnchor(player: mod.Player, playerId: number, context: string): void {
  try {
    requestCipherSpawnAnchorForPlayer(playerId, true);
    processCipherSpawnJobs(context + "_anchor");
    requestCipherSpawnTeleportForPlayer(playerId, true);
    processCipherSpawnJobs(context + "_teleport");
    teleportCipherPlayerToRoutedAnchor(player, playerId);
    if (gameStatus === 3 && !isCipherLiveTransitionActive() && !isRuntimeBotPhaseLocked(playerId)) {
      SafeSpawnCheckOrRedeploy(playerId);
    }
    if (bombCarrierPlayerId === playerId) {
      syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), context + "_carrier_visuals");
    }
  } catch (err) {
    LogRuntimeError("runtime_bot_route/" + context + "/" + String(playerId), err);
  }
}

function getRuntimeBotClassForSlot(slotId: number): mod.SoldierClass {
  const classSlot = (slotId - 1) % 4;
  if (classSlot === 0) return mod.SoldierClass.Assault;
  if (classSlot === 1) return mod.SoldierClass.Engineer;
  if (classSlot === 2) return mod.SoldierClass.Recon;
  return mod.SoldierClass.Support;
}

function forEachRuntimeBotSlot(callback: (slot: RuntimeBotSlot) => void): void {
  for (const slotIdKey in runtimeBotSlotsBySlotId) {
    const slot = runtimeBotSlotsBySlotId[Number(slotIdKey)];
    if (!slot || slot.retired) continue;
    callback(slot);
  }
}

function countActiveRuntimeBotSlots(): number {
  let count = 0;
  forEachRuntimeBotSlot(() => {
    count += 1;
  });
  return count;
}

type RuntimeBotTeamCounts = {
  team1Humans: number;
  team2Humans: number;
  team1Bots: number;
  team2Bots: number;
  totalBots: number;
};

function countRuntimeBotTeamState(): RuntimeBotTeamCounts {
  let team1Humans = 0;
  let team2Humans = 0;
  let team1Bots = 0;
  let team2Bots = 0;

  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    if (isCipherRuntimeBotPlayerId(sp.id)) return;
    if (isBotBackfillPlayerSafe(sp.player)) return;

    const team = getCipherKeyTeamSnapshot(sp.id) ?? mod.GetTeam(sp.player);
    if (mod.Equals(team, team1)) team1Humans += 1;
    else if (mod.Equals(team, team2)) team2Humans += 1;
  });

  forEachRuntimeBotSlot((slot) => {
    if (mod.Equals(slot.desiredTeam, team1)) team1Bots += 1;
    else if (mod.Equals(slot.desiredTeam, team2)) team2Bots += 1;
  });

  return {
    team1Humans,
    team2Humans,
    team1Bots,
    team2Bots,
    totalBots: team1Bots + team2Bots,
  };
}

function getDesiredRuntimeBotCountForHumanCount(humanCount: number): number {
  return Math.max(0, Math.min(CIPHER_RUNTIME_BOT_MAX_PER_TEAM, CIPHER_RUNTIME_BOT_DESIRED_TEAM_SIZE - humanCount));
}

function createRuntimeBotSlot(desiredTeam: mod.Team, nowSec: number): RuntimeBotSlot {
  const slotId = runtimeBotNextSlotId;
  runtimeBotNextSlotId += 1;

  const slot: RuntimeBotSlot = {
    slotId,
    desiredTeam,
    classToSpawn: getRuntimeBotClassForSlot(slotId),
    spawner: undefined,
    spawnerObjId: 0,
    player: undefined,
    playerId: undefined,
    nextSpawnAtSec: nowSec,
    forceRespawnAfterSec: 0,
    spawnToken: 0,
    pendingSinceSec: 0,
    spawning: false,
    retired: false,
  };

  runtimeBotSlotsBySlotId[slotId] = slot;
  return slot;
}

function getAuthoredRuntimeBotSpawnerIdForTeam(team: mod.Team): number {
  if (mod.Equals(team, team1)) return CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID;
  if (mod.Equals(team, team2)) return CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID;
  return 0;
}

function removePendingRuntimeBotSlot(slotId: number, spawnerObjId: number): void {
  if (!(spawnerObjId > 0)) return;
  const pending = runtimeBotPendingSlotIdsBySpawnerObjId[spawnerObjId];
  if (!pending) return;
  const next: number[] = [];
  for (let i = 0; i < pending.length; i++) {
    if (pending[i] !== slotId) next.push(pending[i]);
  }
  runtimeBotPendingSlotIdsBySpawnerObjId[spawnerObjId] = next.length > 0 ? next : undefined;
}

function queuePendingRuntimeBotSlot(slot: RuntimeBotSlot): void {
  if (!(slot.spawnerObjId > 0)) return;
  removePendingRuntimeBotSlot(slot.slotId, slot.spawnerObjId);
  const pending = runtimeBotPendingSlotIdsBySpawnerObjId[slot.spawnerObjId] ?? [];
  pending.push(slot.slotId);
  runtimeBotPendingSlotIdsBySpawnerObjId[slot.spawnerObjId] = pending;
}

function takePendingRuntimeBotSlotForSpawner(spawnerObjId: number): RuntimeBotSlot | undefined {
  const pending = runtimeBotPendingSlotIdsBySpawnerObjId[spawnerObjId];
  if (!pending || pending.length <= 0) return undefined;

  while (pending.length > 0) {
    const slotId = pending.shift();
    const slot = getRuntimeBotSlotById(slotId);
    if (slot && slot.spawning && slot.spawnerObjId === spawnerObjId) {
      runtimeBotPendingSlotIdsBySpawnerObjId[spawnerObjId] = pending.length > 0 ? pending : undefined;
      return slot;
    }
  }

  runtimeBotPendingSlotIdsBySpawnerObjId[spawnerObjId] = undefined;
  return undefined;
}

function resolveAuthoredRuntimeBotSpawnerByObjId(
  spawnerObjId: number,
  context: string,
  logFailure: boolean = true
): mod.Spawner | undefined {
  if (!(spawnerObjId > 0)) return undefined;
  const cached = runtimeBotAuthoredSpawnerByObjId[spawnerObjId];
  if (cached) return cached;

  try {
    const spawner = mod.GetSpawner(spawnerObjId);
    runtimeBotAuthoredSpawnerByObjId[spawnerObjId] = spawner;
    try {
      mod.AISetUnspawnOnDead(spawner, false);
    } catch (_errUnspawnOnDead) {}
    try {
      mod.SetUnspawnDelayInSeconds(spawner, CIPHER_RUNTIME_BOT_UNSPAWN_DELAY_SECONDS);
    } catch (_errUnspawnDelay) {}
    return spawner;
  } catch (err) {
    if (logFailure) {
      LogRuntimeError("runtime_bot_get_authored_spawner/" + context + "/" + String(spawnerObjId), err);
    }
    return undefined;
  }
}

function clearRuntimeBotSpawnerForSlot(slot: RuntimeBotSlot, _unspawnAi: boolean, context: string): void {
  if (!slot.spawner && slot.spawnerObjId <= 0) return;

  removePendingRuntimeBotSlot(slot.slotId, slot.spawnerObjId);
  slot.spawner = undefined;
  slot.spawnerObjId = 0;
  void context;
}

function ensureRuntimeBotSpawnerForSlot(slot: RuntimeBotSlot): boolean {
  if (slot.retired) return false;
  const spawnerObjId = getAuthoredRuntimeBotSpawnerIdForTeam(slot.desiredTeam);
  if (!(spawnerObjId > 0)) return false;
  if (slot.spawner && slot.spawnerObjId === spawnerObjId) return true;

  removePendingRuntimeBotSlot(slot.slotId, slot.spawnerObjId);
  const spawner = resolveAuthoredRuntimeBotSpawnerByObjId(spawnerObjId, "slot_" + String(slot.slotId));
  if (!spawner) return false;

  slot.spawner = spawner;
  slot.spawnerObjId = spawnerObjId;
  return true;
}

function spawnRuntimeBotFromSlot(slot: RuntimeBotSlot, nowSec: number, context: string): void {
  if (slot.retired) return;

  if (
    slot.spawning &&
    slot.pendingSinceSec > 0 &&
    nowSec - slot.pendingSinceSec < CIPHER_RUNTIME_BOT_SPAWN_BIND_TIMEOUT_SECONDS
  ) {
    return;
  }

  if (!ensureRuntimeBotSpawnerForSlot(slot)) {
    slot.nextSpawnAtSec = nowSec + CIPHER_RUNTIME_BOT_SPAWN_RETRY_SECONDS;
    return;
  }

  if (!slot.spawner) return;
  if (nowSec < slot.nextSpawnAtSec) return;

  try {
    runtimeBotSpawnTokenCounter += 1;
    slot.spawnToken = runtimeBotSpawnTokenCounter;
    slot.spawning = true;
    slot.pendingSinceSec = nowSec;

    queuePendingRuntimeBotSlot(slot);

    // Use the stable Conquest-style overload:
    // spawner + bot name + team.
    // Do not pass SoldierClass here.
    mod.SpawnAIFromAISpawner(
      slot.spawner,
      mod.Message(mod.stringkeys.BotName),
      slot.desiredTeam
    );

    slot.nextSpawnAtSec = nowSec + CIPHER_RUNTIME_BOT_SPAWN_RETRY_SECONDS;
    slot.forceRespawnAfterSec = 0;
  } catch (err) {
    removePendingRuntimeBotSlot(slot.slotId, slot.spawnerObjId);
    LogRuntimeError("runtime_bot_spawn/" + context, err);
    slot.spawning = false;
    slot.pendingSinceSec = 0;
    slot.nextSpawnAtSec = nowSec + CIPHER_RUNTIME_BOT_SPAWN_RETRY_SECONDS;
  }
}

function retireRuntimeBotSlot(slot: RuntimeBotSlot, context: string): void {
  slot.retired = true;
  removePendingRuntimeBotSlot(slot.slotId, slot.spawnerObjId);
  clearRuntimeBotPlayerBinding(slot, true);
  clearRuntimeBotSpawnerForSlot(slot, true, context);
  delete runtimeBotSlotsBySlotId[slot.slotId];
}

function clearRuntimeBotState(unspawnSpawners: boolean): void {
  if (unspawnSpawners) {
    const authoredSpawnerIds = [CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID, CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID];
    for (let i = 0; i < authoredSpawnerIds.length; i++) {
      const spawner = runtimeBotAuthoredSpawnerByObjId[authoredSpawnerIds[i]];
      if (!spawner) continue;
      try {
        mod.UnspawnAllAIsFromAISpawner(spawner);
      } catch (_errUnspawnAi) {}
    }
  }

  const slotsToClear: RuntimeBotSlot[] = [];
  forEachRuntimeBotSlot((slot) => {
    slotsToClear.push(slot);
  });
  for (let i = 0; i < slotsToClear.length; i++) {
    retireRuntimeBotSlot(slotsToClear[i], "clear_runtime_bot_state");
  }

  runtimeBotSlotsBySlotId = {};
  runtimeBotSlotByPlayerId = {};
  runtimeBotPendingSlotIdsBySpawnerObjId = {};
  runtimeBotAuthoredSpawnerByObjId = {};
  runtimeBotRespawnAfterSecByPlayerId = {};
  runtimeBotPhaseLockedByPlayerId = {};
  runtimeBotNextSlotId = 1;
  runtimeBotNextReconcileAtSec = 0;
  runtimeBotSpawnTokenCounter = 0;
  runtimeBotStagedSpawnNextTick = 0;
  runtimeBotStagedSpawnTeamToggle = 0;
  runtimeBotLockReapplyNextTick = 0;
  clearBotObjectiveAssignments();
  void unspawnSpawners;
}

function chooseRuntimeBotSlotToRetire(team?: mod.Team): RuntimeBotSlot | undefined {
  let best: RuntimeBotSlot | undefined = undefined;
  forEachRuntimeBotSlot((slot) => {
    if (team && !mod.Equals(slot.desiredTeam, team)) return;
    if (!best || slot.slotId > best.slotId) best = slot;
  });
  return best;
}

function reconcileRuntimeBotSlotCount(nowSec: number): void {
  let counts = countRuntimeBotTeamState();
  const desiredTeam1Bots = getDesiredRuntimeBotCountForHumanCount(counts.team1Humans);
  const desiredTeam2Bots = getDesiredRuntimeBotCountForHumanCount(counts.team2Humans);

  let retireBudget = CIPHER_RUNTIME_BOT_RETIRE_BUDGET_PER_RECONCILE;
  while (counts.team1Bots > desiredTeam1Bots && retireBudget > 0) {
    const slot = chooseRuntimeBotSlotToRetire(team1);
    if (!slot) return;
    retireRuntimeBotSlot(slot, "team1_over_target");
    retireBudget -= 1;
    counts = countRuntimeBotTeamState();
  }
  while (counts.team2Bots > desiredTeam2Bots && retireBudget > 0) {
    const slot = chooseRuntimeBotSlotToRetire(team2);
    if (!slot) return;
    retireRuntimeBotSlot(slot, "team2_over_target");
    retireBudget -= 1;
    counts = countRuntimeBotTeamState();
  }
  while (counts.totalBots > CIPHER_RUNTIME_BOT_MAX_TOTAL && retireBudget > 0) {
    const slot = chooseRuntimeBotSlotToRetire();
    if (!slot) return;
    retireRuntimeBotSlot(slot, "total_over_target");
    retireBudget -= 1;
    counts = countRuntimeBotTeamState();
  }

  let createBudget = CIPHER_RUNTIME_BOT_CREATE_BUDGET_PER_RECONCILE;
  while (
    counts.team1Bots < desiredTeam1Bots &&
    counts.team1Bots < CIPHER_RUNTIME_BOT_MAX_PER_TEAM &&
    counts.totalBots < CIPHER_RUNTIME_BOT_MAX_TOTAL &&
    createBudget > 0
  ) {
    createRuntimeBotSlot(team1, nowSec);
    createBudget -= 1;
    counts = countRuntimeBotTeamState();
  }
  while (
    counts.team2Bots < desiredTeam2Bots &&
    counts.team2Bots < CIPHER_RUNTIME_BOT_MAX_PER_TEAM &&
    counts.totalBots < CIPHER_RUNTIME_BOT_MAX_TOTAL &&
    createBudget > 0
  ) {
    createRuntimeBotSlot(team2, nowSec);
    createBudget -= 1;
    counts = countRuntimeBotTeamState();
  }
}

function resetRuntimeBotStagedSpawnSchedule(): void {
  runtimeBotStagedSpawnNextTick = 0;
  runtimeBotStagedSpawnTeamToggle = 0;
  runtimeBotLockReapplyNextTick = 0;
}

function chooseReadyRuntimeBotSlotForStagedSpawn(nowSec: number): RuntimeBotSlot | undefined {
  let best: RuntimeBotSlot | undefined = undefined;
  forEachRuntimeBotSlot((slot) => {
    if (best) return;
    if (slot.retired || slot.spawning) return;
    if (slot.playerId !== undefined) return;
    if (nowSec < slot.nextSpawnAtSec) return;
    best = slot;
  });
  return best;
}

function chooseRuntimeBotTeamForStagedSlot(counts: RuntimeBotTeamCounts): mod.Team | undefined {
  const desiredTeam1Bots = getDesiredRuntimeBotCountForHumanCount(counts.team1Humans);
  const desiredTeam2Bots = getDesiredRuntimeBotCountForHumanCount(counts.team2Humans);
  const team1Needed = counts.team1Bots < desiredTeam1Bots && counts.team1Bots < CIPHER_RUNTIME_BOT_MAX_PER_TEAM;
  const team2Needed = counts.team2Bots < desiredTeam2Bots && counts.team2Bots < CIPHER_RUNTIME_BOT_MAX_PER_TEAM;

  if (!team1Needed && !team2Needed) return undefined;
  if (team1Needed && !team2Needed) return team1;
  if (team2Needed && !team1Needed) return team2;

  runtimeBotStagedSpawnTeamToggle = 1 - runtimeBotStagedSpawnTeamToggle;
  return runtimeBotStagedSpawnTeamToggle === 0 ? team1 : team2;
}

function spawnOneRuntimeBotStaged(nowSec: number, source: string): void {
  if (!cipherRuntimeBotsEnabled) return;
  if (!validateRuntimeBotSpawnersOnce()) {
    if (countActiveRuntimeBotSlots() > 0) clearRuntimeBotState(true);
    cipherRuntimeBotsEnabled = false;
    refreshCipherAdminPanels();
    return;
  }

  let slot = chooseReadyRuntimeBotSlotForStagedSpawn(nowSec);
  if (!slot) {
    const counts = countRuntimeBotTeamState();
    if (counts.totalBots >= CIPHER_RUNTIME_BOT_MAX_TOTAL) return;
    const team = chooseRuntimeBotTeamForStagedSlot(counts);
    if (!team) return;
    slot = createRuntimeBotSlot(team, nowSec);
  }

  spawnRuntimeBotFromSlot(slot, nowSec, source + "_staged");
}

function tickRuntimeBotStagedSpawning(nowSec: number, source: string): void {
  if (!cipherRuntimeBotsEnabled) {
    if (countActiveRuntimeBotSlots() > 0) clearRuntimeBotState(true);
    return;
  }
  if (!shouldRuntimeBotsBePhaseLocked()) return;

  applyRuntimeBotPhaseLocksForAll(source + "_lock");

  if (runtimeBotStagedSpawnNextTick > 0 && serverTickCount < runtimeBotStagedSpawnNextTick) return;
  runtimeBotStagedSpawnNextTick = serverTickCount + CIPHER_RUNTIME_BOT_STAGED_SPAWN_INTERVAL_TICKS;
  spawnOneRuntimeBotStaged(nowSec, source);
}

function shouldRuntimeBotSlotSpawn(slot: RuntimeBotSlot, nowSec: number): boolean {
  if (slot.retired) return false;
  if (slot.spawning && slot.pendingSinceSec > 0 && nowSec - slot.pendingSinceSec < CIPHER_RUNTIME_BOT_SPAWN_BIND_TIMEOUT_SECONDS) {
    return false;
  }
  if (slot.spawning && slot.pendingSinceSec > 0) {
    removePendingRuntimeBotSlot(slot.slotId, slot.spawnerObjId);
    slot.spawning = false;
    slot.pendingSinceSec = 0;
    slot.nextSpawnAtSec = nowSec + CIPHER_RUNTIME_BOT_SPAWN_RETRY_SECONDS;
    return false;
  }
  if (slot.playerId === undefined) return true;

  const sp = serverPlayers.get(slot.playerId);
  if (slot.forceRespawnAfterSec > 0) {
    if (nowSec < slot.forceRespawnAfterSec) return false;

    if (
      !sp ||
      !mod.IsPlayerValid(sp.player) ||
      !sp.isDeployed ||
      playerInMandownByPlayerId[sp.id] === true ||
      !isPlayerAliveSafe(sp.player)
    ) {
      if (sp) delete playerInMandownByPlayerId[sp.id];
      clearRuntimeBotPlayerBinding(slot, true);
      return true;
    }

    clearRuntimeBotRespawnStateForPlayer(sp.id);
    return false;
  }

  if (!sp || !mod.IsPlayerValid(sp.player)) return true;
  if (!sp.isDeployed) return true;

  return false;
}

function reconcileRuntimeBotSpawns(nowSec: number): void {
  let spawnBudget = CIPHER_RUNTIME_BOT_SPAWN_BUDGET_PER_RECONCILE;
  forEachRuntimeBotSlot((slot) => {
    if (spawnBudget <= 0) return;
    if (!shouldRuntimeBotSlotSpawn(slot, nowSec)) return;
    if (slot.spawning && nowSec < slot.nextSpawnAtSec) return;
    spawnRuntimeBotFromSlot(slot, nowSec, "reconcile");
    spawnBudget -= 1;
  });
}

function validateRuntimeBotSpawnersOnce(): boolean {
  if (runtimeBotSpawnerValidationComplete) return !runtimeBotSpawnerValidationFailed;

  runtimeBotSpawnerValidationComplete = true;
  const team1Spawner = resolveAuthoredRuntimeBotSpawnerByObjId(
    CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID,
    "validate_team1",
    false
  );
  const team2Spawner = resolveAuthoredRuntimeBotSpawnerByObjId(
    CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID,
    "validate_team2",
    false
  );

  runtimeBotSpawnerValidationFailed = !team1Spawner || !team2Spawner;
  if (runtimeBotSpawnerValidationFailed && !runtimeBotSpawnerValidationWarned) {
    runtimeBotSpawnerValidationWarned = true;
    LogRuntimeError(
      "runtime_bot_spawner_validation",
      "runtime bot AI spawner missing: " +
        String(CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID) +
        "/" +
        String(CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID)
    );
  }

  return !runtimeBotSpawnerValidationFailed;
}

function reconcileRuntimeBots(nowSec: number): void {
  if (!cipherRuntimeBotsEnabled) {
    if (countActiveRuntimeBotSlots() > 0) clearRuntimeBotState(true);
    return;
  }
  if (shouldRuntimeBotsBePhaseLocked()) {
    applyRuntimeBotPhaseLocksForAll("runtime_bot_reconcile_phase_lock");
    return;
  }
  if (
    gameStatus !== 3 ||
    initialization[3] !== true ||
    cipherSecondHalfTransitionActive ||
    cipherSuddenDeathTransitionActive ||
    isCipherSuddenDeathActive()
  ) {
    return;
  }
  if (!validateRuntimeBotSpawnersOnce()) {
    if (countActiveRuntimeBotSlots() > 0) clearRuntimeBotState(true);
    cipherRuntimeBotsEnabled = false;
    refreshCipherAdminPanels();
    return;
  }
  if (nowSec < runtimeBotNextReconcileAtSec) return;
  runtimeBotNextReconcileAtSec = nowSec + CIPHER_RUNTIME_BOT_RECONCILE_INTERVAL_SECONDS;

  reconcileRuntimeBotSlotCount(nowSec);
  reconcileRuntimeBotSpawns(nowSec);
}

function bindRuntimeBotPlayerToSlot(slot: RuntimeBotSlot, player: mod.Player): void {
  try {
    const playerId = modlib.getPlayerId(player);

    clearRuntimeBotPlayerBinding(slot, false);

    slot.player = player;
    slot.playerId = playerId;
    slot.spawning = false;
    slot.pendingSinceSec = 0;
    slot.forceRespawnAfterSec = 0;

    runtimeBotSlotByPlayerId[playerId] = slot.slotId;
    delete runtimeBotReleasedPlayerId[playerId];

    let sp = serverPlayers.get(playerId);
    if (!sp) {
      sp = new Player(player);
      serverPlayers.set(playerId, sp);
    } else {
      sp.player = player;
    }

    // SpawnAIFromAISpawner already receives the desired team.
    // Do not call mod.SetTeam inside OnSpawnerSpawned.
    sp.team = slot.desiredTeam;
    sp.isDeployed = true;

    if (shouldRuntimeBotsBePhaseLocked()) {
      applyRuntimeBotPhaseLockForPlayer(player, playerId, "runtime_bot_bind");
    } else {
      releaseRuntimeBotPhaseLockForPlayer(player, playerId, "runtime_bot_bind");
    }

    try {
      mod.SetRedeployTime(player, REDEPLOY_TIME);
    } catch (_errRedeploy) {}

    // Runtime bots are not HUD clients.
    clearCipherKeyHudCacheForPlayer(playerId);
    clearBotObjectiveStateForPlayer(playerId);

    // Do not route/teleport/safe-spawn from OnSpawnerSpawned.
    // The bot objective controller will command movement after spawn.
    botObjectiveNextThinkAtSec = 0;
    requestCipherTransitionReconcile("runtime_bot_bound");
    runtimeBotNextReconcileAtSec = getCurrentSchedulerNowSeconds() + CIPHER_RUNTIME_BOT_RECONCILE_INTERVAL_SECONDS;
  } catch (err) {
    slot.spawning = false;
    slot.pendingSinceSec = 0;
    slot.nextSpawnAtSec = getCurrentSchedulerNowSeconds() + CIPHER_RUNTIME_BOT_SPAWN_RETRY_SECONDS;
    LogRuntimeError("runtime_bot_bind/" + String(slot.slotId), err);
  }
}

function markRuntimeBotSlotForRespawn(playerId: number, delaySeconds: number): void {
  const slot = getRuntimeBotSlotForPlayerId(playerId);
  if (!slot) return;
  const respawnAfterSec = getCurrentSchedulerNowSeconds() + mod.Max(0, delaySeconds);
  slot.forceRespawnAfterSec = respawnAfterSec;
  slot.nextSpawnAtSec = respawnAfterSec;
  slot.spawning = false;
  runtimeBotRespawnAfterSecByPlayerId[playerId] = respawnAfterSec;
}

function clearRuntimeBotRespawnStateForPlayer(playerId: number): void {
  const slot = getRuntimeBotSlotForPlayerId(playerId);
  if (slot) {
    slot.forceRespawnAfterSec = 0;
    slot.nextSpawnAtSec = 0;
    slot.spawning = false;
  }
  delete runtimeBotRespawnAfterSecByPlayerId[playerId];
}

function handleRuntimeBotRevivedForPlayer(playerId: number, player: mod.Player, _source: string): void {
  const slot = getRuntimeBotSlotForPlayerId(playerId);
  if (!slot) return;

  slot.player = player;
  slot.playerId = playerId;
  slot.spawning = false;
  slot.pendingSinceSec = 0;
  clearRuntimeBotRespawnStateForPlayer(playerId);
  runtimeBotSlotByPlayerId[playerId] = slot.slotId;
  delete runtimeBotReleasedPlayerId[playerId];

  const sp = serverPlayers.get(playerId);
  if (sp) {
    sp.player = player;
    sp.isDeployed = true;
    sp.team = slot.desiredTeam;
  }

  delete playerInMandownByPlayerId[playerId];
  if (shouldRuntimeBotsBePhaseLocked()) {
    applyRuntimeBotPhaseLockForPlayer(player, playerId, "runtime_bot_revived");
  } else {
    releaseRuntimeBotPhaseLockForPlayer(player, playerId, "runtime_bot_revived");
  }
  botObjectiveNextThinkAtSec = 0;
  runtimeBotNextReconcileAtSec = getCurrentSchedulerNowSeconds() + CIPHER_RUNTIME_BOT_RECONCILE_INTERVAL_SECONDS;
}

function detachRuntimeBotPlayerForRespawn(playerId: number, delaySeconds: number): void {
  const slot = getRuntimeBotSlotForPlayerId(playerId);
  if (!slot) return;
  clearRuntimeBotPlayerBinding(slot, true);
  slot.nextSpawnAtSec = getCurrentSchedulerNowSeconds() + delaySeconds;
}

function isLiveBotPlayer(sp: Player | undefined): boolean {
  if (!sp) return false;
  if (!mod.IsPlayerValid(sp.player)) return false;
  if (!cipherRuntimeBotsEnabled) return false;
  if (!getRuntimeBotSlotForPlayerId(sp.id)) return false;
  const team = getCipherKeyTeamSnapshot(sp.id) ?? mod.GetTeam(sp.player);
  return mod.Equals(team, team1) || mod.Equals(team, team2);
}

function isLiveBotDeployedAndAlive(sp: Player | undefined): sp is Player {
  if (!sp) return false;
  if (!isLiveBotPlayer(sp)) return false;
  if (!sp.isDeployed) return false;
  return isPlayerAliveSafe(sp.player);
}

function hasLiveBots(): boolean {
  let found = false;
  serverPlayers.forEach((sp) => {
    if (found) return;
    if (isLiveBotPlayer(sp)) found = true;
  });
  return found;
}

function requestLiveBotSpawnForPlayerId(
  playerId: number,
  source: string,
  delaySeconds: number = BOT_LIVE_SPAWN_INITIAL_DELAY_SECONDS
): void {
  if (gameStatus !== 3) return;
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  if (isCipherSuddenDeathActive()) return;

  const slot = getRuntimeBotSlotForPlayerId(playerId);
  if (!slot) return;
  void source;
  markRuntimeBotSlotForRespawn(playerId, delaySeconds);
  runtimeBotNextReconcileAtSec = 0;
}

function requestLiveBotSpawnsForAllBots(_source: string): void {
  runtimeBotNextReconcileAtSec = 0;
  reconcileRuntimeBots(getCurrentSchedulerNowSeconds());
}

function handleRuntimeBotDeployedForCurrentPhase(
  eventPlayer: mod.Player,
  playerId: number,
  slot: RuntimeBotSlot,
  source: string
): void {
  let sp = serverPlayers.get(playerId);
  if (!sp) {
    sp = new Player(eventPlayer);
    serverPlayers.set(playerId, sp);
  }

  sp.player = eventPlayer;
  sp.team = slot.desiredTeam;
  sp.isDeployed = true;

  clearCipherKeyHudCacheForPlayer(playerId);
  clearQueuedSafeSpawnStateForPlayer(playerId);
  invalidateCipherRespawnRouteJobForPlayer(playerId);
  clearTransitionSpawnStateForPlayer(playerId);

  safeSpawnForcedRedeploys[playerId] = 0;
  safeSpawnForcedUndeploy[playerId] = false;
  safeSpawnUnsafePending[playerId] = false;
  safeSpawnPendingCheck[playerId] = false;
  hqDesyncForcedRedeploys[playerId] = 0;

  try {
    mod.SetRedeployTime(eventPlayer, isCipherSuddenDeathActive() ? 9999 : REDEPLOY_TIME);
  } catch (_errRedeploy) {}

  if (gameStatus === 2 || isCipherLiveTransitionActive() || shouldRuntimeBotsBePhaseLocked()) {
    applyRuntimeBotPhaseLockForPlayer(eventPlayer, playerId, source);
    botObjectiveNextThinkAtSec = 0;
    requestCipherTransitionReconcile(source + "_bot_locked_no_route");
    return;
  }

  releaseRuntimeBotPhaseLockForPlayer(eventPlayer, playerId, source);

  sp.isFirstDeploy();
  botObjectiveNextThinkAtSec = 0;
  requestCipherTransitionReconcile(source);
}

function processLiveBotSpawnRequests(nowSec: number): void {
  reconcileRuntimeBots(nowSec);
}

function shouldIssueBotMoveCommand(playerId: number, role: BotObjectiveRole, target: mod.Vector, nowSec: number): boolean {
  const lastRole = botObjectiveAssignedRoleByPlayerId[playerId];
  const lastCommandAt = botObjectiveLastCommandAtSecByPlayerId[playerId] ?? -999999;
  const lastTarget = botObjectiveLastTargetByPlayerId[playerId];

  if (lastRole !== role) return true;
  if (!lastTarget) return true;
  if (mod.DistanceBetween(lastTarget, target) > BOT_OBJECTIVE_TARGET_REISSUE_DISTANCE_METERS) return true;
  return nowSec - lastCommandAt >= BOT_OBJECTIVE_COMMAND_REFRESH_SECONDS;
}

function getRuntimeBotMoveSpeedForRole(role: BotObjectiveRole): mod.MoveSpeed {
  if (role === "seekKey" || role === "deliverKey" || role === "interceptCarrier") return mod.MoveSpeed.Sprint;
  if (role === "escortCarrier" || role === "revive") return mod.MoveSpeed.InvestigateRun;
  return mod.MoveSpeed.Run;
}

function getRuntimeBotDefendRadiusForRole(role: BotObjectiveRole): number {
  if (role === "escortCarrier") return 10;
  if (role === "interceptCarrier") return 18;
  if (role === "revive") return 8;
  return 14;
}

function trySetRuntimeBotTarget(bot: Player, targetPlayer: mod.Player): void {
  if (!isLiveBotDeployedAndAlive(bot)) return;
  if (isRuntimeBotPhaseLocked(bot.id)) return;
  if (!mod.IsPlayerValid(targetPlayer)) return;
  try {
    mod.AISetTarget(bot.player, targetPlayer);
  } catch (_errTarget) {}
}

function chooseNearestRuntimeBotEnemyTarget(sp: Player, maxRadiusMeters: number): BotEnemyTarget | undefined {
  if (!isLiveBotDeployedAndAlive(sp)) return undefined;
  if (isRuntimeBotPhaseLocked(sp.id)) return undefined;

  const botTeam = getCipherKeyTeamSnapshot(sp.id) ?? mod.GetTeam(sp.player);
  if (!mod.Equals(botTeam, team1) && !mod.Equals(botTeam, team2)) return undefined;

  const botPos = tryGetPlayerPositionSafe(sp.player);
  if (!botPos) return undefined;

  let best: BotEnemyTarget | undefined = undefined;

  serverPlayers.forEach((candidate) => {
    if (!candidate || candidate.id === sp.id) return;
    if (!candidate.isDeployed || !mod.IsPlayerValid(candidate.player)) return;
    if (playerInMandownByPlayerId[candidate.id] === true) return;
    if (!isPlayerAliveSafe(candidate.player)) return;

    const candidateTeam = getCipherKeyTeamSnapshot(candidate.id) ?? mod.GetTeam(candidate.player);
    if (!mod.Equals(candidateTeam, team1) && !mod.Equals(candidateTeam, team2)) return;
    if (mod.Equals(candidateTeam, botTeam)) return;

    const candidatePos = tryGetPlayerPositionSafe(candidate.player);
    if (!candidatePos) return;

    const dist = mod.DistanceBetween(botPos, candidatePos);
    if (dist > maxRadiusMeters) return;

    if (
      best === undefined ||
      dist < best.distance - 0.0001 ||
      (Math.abs(dist - best.distance) <= 0.0001 && candidate.id < best.playerId)
    ) {
      best = {
        player: candidate.player,
        playerId: candidate.id,
        pos: candidatePos,
        distance: dist,
      };
    }
  });

  return best;
}

function refreshRuntimeBotEnemyTarget(sp: Player, nowSec: number): BotEnemyTarget | undefined {
  if (isRuntimeBotPhaseLocked(sp.id)) return undefined;
  const target = chooseNearestRuntimeBotEnemyTarget(sp, CIPHER_RUNTIME_BOT_ENEMY_SCAN_RADIUS_METERS);
  const lastTargetPlayerId = botObjectiveTargetPlayerIdByPlayerId[sp.id];
  const lastRefreshAtSec = botObjectiveTargetRefreshAtSecByPlayerId[sp.id] ?? -999999;

  if (!target) {
    if (lastTargetPlayerId !== undefined) {
      try {
        mod.AISetTarget(sp.player);
      } catch (_errClearTarget) {}
      delete botObjectiveTargetPlayerIdByPlayerId[sp.id];
      delete botObjectiveTargetRefreshAtSecByPlayerId[sp.id];
    }
    return undefined;
  }

  if (
    lastTargetPlayerId !== target.playerId ||
    nowSec - lastRefreshAtSec >= CIPHER_RUNTIME_BOT_TARGET_REFRESH_SECONDS
  ) {
    trySetRuntimeBotTarget(sp, target.player);
    try {
      mod.AISetFocusPoint(sp.player, target.pos, true);
    } catch (_errFocus) {}
    botObjectiveTargetPlayerIdByPlayerId[sp.id] = target.playerId;
    botObjectiveTargetRefreshAtSecByPlayerId[sp.id] = nowSec;
  }

  return target;
}

function refreshRuntimeBotEnemyTargets(nowSec: number): { [playerId: number]: BotEnemyTarget | undefined } {
  const targets: { [playerId: number]: BotEnemyTarget | undefined } = {};
  serverPlayers.forEach((sp) => {
    if (!isLiveBotDeployedAndAlive(sp)) return;
    if (isRuntimeBotPhaseLocked(sp.id)) return;
    targets[sp.id] = refreshRuntimeBotEnemyTarget(sp, nowSec);
  });
  return targets;
}

function issueBotMoveCommand(sp: Player, role: BotObjectiveRole, target: mod.Vector, nowSec: number): void {
  if (!isLiveBotDeployedAndAlive(sp)) return;
  if (isRuntimeBotPhaseLocked(sp.id)) return;
  if (!shouldIssueBotMoveCommand(sp.id, role, target, nowSec)) return;

  try {
    mod.AISetMoveSpeed(sp.player, getRuntimeBotMoveSpeedForRole(role));
  } catch (_errMoveSpeed) {}

  let issued = false;

  // For key running and delivery, always try a real move order first.
  // DefendPosition can cause bots to hold their current area instead of pathing cleanly.
  try {
    mod.AIMoveToBehavior(sp.player, target);
    issued = true;
  } catch (_errMove) {
    try {
      mod.AIDefendPositionBehavior(sp.player, target, 0, getRuntimeBotDefendRadiusForRole(role));
      issued = true;
    } catch (_errDefend) {}
  }

  if (!issued) return;

  botObjectiveAssignedRoleByPlayerId[sp.id] = role;
  botObjectiveLastCommandAtSecByPlayerId[sp.id] = nowSec;
  botObjectiveLastTargetByPlayerId[sp.id] = target;
}

function getBotOffsetTarget(baseTarget: mod.Vector, playerId: number, radiusMeters: number): mod.Vector {
  const slot = playerId % 8;
  let x = 0;
  let z = 0;

  if (slot === 0) x = radiusMeters;
  else if (slot === 1) x = -radiusMeters;
  else if (slot === 2) z = radiusMeters;
  else if (slot === 3) z = -radiusMeters;
  else if (slot === 4) {
    x = radiusMeters;
    z = radiusMeters;
  } else if (slot === 5) {
    x = -radiusMeters;
    z = radiusMeters;
  } else if (slot === 6) {
    x = radiusMeters;
    z = -radiusMeters;
  } else {
    x = -radiusMeters;
    z = -radiusMeters;
  }

  return mod.Add(baseTarget, mod.CreateVector(x, 0, z));
}

function getDefaultBotCipherKeyAnchorPosition(): mod.Vector | undefined {
  const activeSlot = getBombBaseSlotIndexOrDefault(bombActiveBaseSlotIndex);
  const activePos = getBombBaseSlotSpatialPosition(activeSlot);
  if (activePos) return activePos;

  for (let i = 0; i < BOMB_BASE_SLOT_CONFIGS.length; i++) {
    const pos = getBombBaseSlotSpatialPosition(i);
    if (pos) return pos;
  }

  return undefined;
}

function getBotCipherKeyTargetPosition(): mod.Vector | undefined {
  if (bombCarrierPlayerId !== undefined) return undefined;

  // For dropped keys, use the stable drop anchor first.
  // Runtime icon/object positions can be offset or temporarily invalid.
  if (hasDroppedBombRuntimeObjects()) {
    return (
      tryResolveDroppedBombAnchorPosition() ??
      bombDroppedPickupAnchorPosition ??
      getObjectPositionSafeValidated(bombDroppedWorldIconObject, "bot_dropped_key_world_icon").position
    );
  }

  // Important:
  // When the key unlocks, do NOT switch bot movement to the runtime loot object first.
  // That object can be inside/near props or return a path target the AI cannot navigate cleanly.
  // Keep bot movement pointed at the authored/current base anchor, and let radius scans handle pickup.
  if (bombPickupTriggerEnabled) {
    return (
      tryGetActiveBasePickupAnchor() ??
      nextKeyUnlockAnchorPosition ??
      getDefaultBotCipherKeyAnchorPosition() ??
      tryResolveBombBaseRuntimeLootPosition("bot_base_key_runtime_fallback")
    );
  }

  // Before the key unlocks, move bots toward the reserved unlock anchor.
  return (
    nextKeyUnlockAnchorPosition ??
    tryGetActiveBasePickupAnchor() ??
    getDefaultBotCipherKeyAnchorPosition()
  );
}

function canBotRunToCipherKey(sp: Player, _keyIsDropped: boolean): boolean {
  if (!isLiveBotDeployedAndAlive(sp)) return false;
  if (bombCarrierPlayerId === sp.id) return false;

  // IMPORTANT:
  // Do not gate movement by pickup/reclaim eligibility.
  // Eligibility only means "can pick up right now."
  // A bot that is far away still needs to receive the move command toward the key.
  return true;
}

function isValidBotCarrierDeliveryObjective(cpId: number, carrierTeam: mod.Team): boolean {
  if (!isObjectiveCpId(cpId)) return false;
  if (!isObjectiveActiveForCurrentHalf(cpId)) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (!isCipherNodeActive(cpId)) return false;
  if (mod.Equals(carrierTeam, teamNeutral)) return false;
  return !mod.Equals(carrierTeam, getObjectiveDefendingTeamForCurrentHalf(cpId));
}

function chooseNearestBotDeliveryPositionFromOrigin(origin: mod.Vector, carrierTeam: mod.Team): mod.Vector | undefined {
  let bestPos: mod.Vector | undefined = undefined;
  let bestDistance = 999999;

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (!isValidBotCarrierDeliveryObjective(cpId, carrierTeam)) continue;

    const cpPos = getObjectiveAnchorPosition(cpId);
    if (!cpPos) continue;
    const dist = mod.DistanceBetween(origin, cpPos);
    if (!bestPos || dist < bestDistance - 0.0001) {
      bestPos = cpPos;
      bestDistance = dist;
    }
  }

  return bestPos;
}

function chooseNearestBotCarrierDeliveryPosition(carrier: Player, carrierTeam: mod.Team): mod.Vector | undefined {
  const carrierPos = tryGetPlayerPositionSafe(carrier.player);
  if (!carrierPos) return undefined;
  return chooseNearestBotDeliveryPositionFromOrigin(carrierPos, carrierTeam);
}

function chooseNearestBotTeammatePosition(sp: Player, botTeam: mod.Team): mod.Vector | undefined {
  const botPos = tryGetPlayerPositionSafe(sp.player);
  if (!botPos) return undefined;

  let bestPos: mod.Vector | undefined = undefined;
  let bestDistance = 999999;
  let bestPlayerId = 999999;

  serverPlayers.forEach((candidate) => {
    if (!candidate || candidate.id === sp.id) return;
    if (!candidate.isDeployed || !mod.IsPlayerValid(candidate.player) || !isPlayerAliveSafe(candidate.player)) return;
    const candidateTeam = getCipherKeyTeamSnapshot(candidate.id) ?? mod.GetTeam(candidate.player);
    if (!mod.Equals(candidateTeam, botTeam)) return;

    const candidatePos = tryGetPlayerPositionSafe(candidate.player);
    if (!candidatePos) return;
    const dist = mod.DistanceBetween(botPos, candidatePos);
    if (!bestPos || dist < bestDistance - 0.0001 || (Math.abs(dist - bestDistance) <= 0.0001 && candidate.id < bestPlayerId)) {
      bestPos = candidatePos;
      bestDistance = dist;
      bestPlayerId = candidate.id;
    }
  });

  return bestPos;
}

function tryIssueBotReviveAssignment(sp: Player, nowSec: number): boolean {
  if (!isLiveBotDeployedAndAlive(sp)) return false;
  if (isRuntimeBotPhaseLocked(sp.id)) return false;
  if (bombCarrierPlayerId === sp.id) {
    delete botReviveTargetPlayerIdByReviverId[sp.id];
    delete botReviveAssignmentStartedAtSecByReviverId[sp.id];
    return false;
  }

  const botTeam = getCipherKeyTeamSnapshot(sp.id) ?? mod.GetTeam(sp.player);
  const botPos = tryGetPlayerPositionSafe(sp.player);
  if (!botPos) return false;

  const best = {
    player: undefined as mod.Player | undefined,
    playerId: 999999,
    pos: undefined as mod.Vector | undefined,
    distance: CIPHER_RUNTIME_BOT_REVIVE_SCAN_RADIUS_METERS + 0.0001,
  };

  serverPlayers.forEach((candidate) => {
    if (!candidate || candidate.id === sp.id) return;
    if (playerInMandownByPlayerId[candidate.id] !== true) return;
    if (!mod.IsPlayerValid(candidate.player)) return;

    const candidateTeam = getCipherKeyTeamSnapshot(candidate.id) ?? mod.GetTeam(candidate.player);
    if (!mod.Equals(candidateTeam, botTeam)) return;

    const candidatePos = tryGetPlayerPositionSafe(candidate.player);
    if (!candidatePos) return;

    const dist = mod.DistanceBetween(botPos, candidatePos);
    if (dist > CIPHER_RUNTIME_BOT_REVIVE_SCAN_RADIUS_METERS) return;
    if (
      best.player === undefined ||
      dist < best.distance - 0.0001 ||
      (Math.abs(dist - best.distance) <= 0.0001 && candidate.id < best.playerId)
    ) {
      best.player = candidate.player;
      best.pos = candidatePos;
      best.distance = dist;
      best.playerId = candidate.id;
    }
  });

  if (!best.player || !best.pos) {
    delete botReviveTargetPlayerIdByReviverId[sp.id];
    delete botReviveAssignmentStartedAtSecByReviverId[sp.id];
    return false;
  }

  if (botReviveTargetPlayerIdByReviverId[sp.id] !== best.playerId) {
    botReviveTargetPlayerIdByReviverId[sp.id] = best.playerId;
    botReviveAssignmentStartedAtSecByReviverId[sp.id] = nowSec;
  }

  const assignmentStartedAtSec = botReviveAssignmentStartedAtSecByReviverId[sp.id] ?? nowSec;
  const assignmentReady = nowSec - assignmentStartedAtSec >= CIPHER_RUNTIME_BOT_REVIVE_ASSIGNMENT_SECONDS;

  if (best.distance <= CIPHER_RUNTIME_BOT_REVIVE_FORCE_RADIUS_METERS && assignmentReady) {
    try {
      mod.ForceRevive(best.player);
      handleRuntimeBotRevivedForPlayer(best.playerId, best.player, "bot_force_revive");
      delete playerInMandownByPlayerId[best.playerId];
      delete botReviveTargetPlayerIdByReviverId[sp.id];
      delete botReviveAssignmentStartedAtSecByReviverId[sp.id];
      botObjectiveNextThinkAtSec = 0;
      return true;
    } catch (_errRevive) {}
  }

  issueBotMoveCommand(sp, "revive", getBotOffsetTarget(best.pos, sp.id, 1.25), nowSec);
  return true;
}

function chooseBotFallbackAssignment(sp: Player): { role: BotObjectiveRole; target: mod.Vector } | undefined {
  const botTeam = getCipherKeyTeamSnapshot(sp.id) ?? mod.GetTeam(sp.player);
  const botPos = tryGetPlayerPositionSafe(sp.player);
  if (!botPos) return undefined;

  const teammatePos = chooseNearestBotTeammatePosition(sp, botTeam);
  if (teammatePos) {
    return {
      role: "regroup",
      target: getBotOffsetTarget(teammatePos, sp.id, 2.25),
    };
  }

  const pressurePos = chooseNearestBotDeliveryPositionFromOrigin(botPos, botTeam);
  if (pressurePos) {
    return {
      role: "pressureObjective",
      target: getBotOffsetTarget(pressurePos, sp.id, 2.75),
    };
  }

  return {
    role: "regroup",
    target: botPos,
  };
}

type BotCarrierRoutingResult = {
  carrierId: number | undefined;
  carrierTeam: mod.Team | undefined;
  carrierPos: mod.Vector | undefined;
  routed: boolean;
};

function evaluateBotCarrierRouting(nowSec: number): BotCarrierRoutingResult {
  if (bombCarrierPlayerId === undefined) {
    return { carrierId: undefined, carrierTeam: undefined, carrierPos: undefined, routed: false };
  }

  const carrier = serverPlayers.get(bombCarrierPlayerId);
  if (!carrier || !carrier.isDeployed || !mod.IsPlayerValid(carrier.player) || !isPlayerAliveSafe(carrier.player)) {
    return { carrierId: bombCarrierPlayerId, carrierTeam: undefined, carrierPos: undefined, routed: false };
  }

  const carrierTeam = getCipherKeyTeamSnapshot(carrier.id) ?? mod.GetTeam(carrier.player);
  const carrierPos = tryGetPlayerPositionSafe(carrier.player);
  if (!isLiveBotPlayer(carrier)) {
    return { carrierId: carrier.id, carrierTeam, carrierPos, routed: false };
  }

  tryDeliverCipherKeyFromActiveObjectiveAreaForCarrier(carrier.id);
  if (bombCarrierPlayerId !== carrier.id) {
    return { carrierId: carrier.id, carrierTeam, carrierPos, routed: true };
  }

  const target = chooseNearestBotCarrierDeliveryPosition(carrier, carrierTeam);
  if (!target) {
    const fallback = chooseBotFallbackAssignment(carrier);
    if (fallback) {
      issueBotMoveCommand(carrier, fallback.role, fallback.target, nowSec);
      return { carrierId: carrier.id, carrierTeam, carrierPos, routed: true };
    }
    return { carrierId: carrier.id, carrierTeam, carrierPos, routed: false };
  }

  issueBotMoveCommand(carrier, "deliverKey", target, nowSec);
  return { carrierId: carrier.id, carrierTeam, carrierPos, routed: true };
}

function evaluateBotKeyRunnerRouting(
  nowSec: number,
  excludedPlayerId: number | undefined
): { [playerId: number]: boolean } {
  const routedByPlayerId: { [playerId: number]: boolean } = {};
  const keyTarget = getBotCipherKeyTargetPosition();
  if (!keyTarget) return routedByPlayerId;

  const keyIsDropped = hasDroppedBombRuntimeObjects();
  serverPlayers.forEach((sp) => {
    if (!isLiveBotDeployedAndAlive(sp)) return;
    if (excludedPlayerId !== undefined && sp.id === excludedPlayerId) return;

    // Revive has priority over chasing the key, so bots can pick teammates up.
    if (tryIssueBotReviveAssignment(sp, nowSec)) {
      routedByPlayerId[sp.id] = true;
      return;
    }

    if (!canBotRunToCipherKey(sp, keyIsDropped)) return;

    issueBotMoveCommand(sp, "seekKey", keyTarget, nowSec);
    routedByPlayerId[sp.id] = true;
  });

  return routedByPlayerId;
}

function evaluateBotCarrierSupportRouting(
  nowSec: number,
  carrierRouting: BotCarrierRoutingResult,
  routedByPlayerId: { [playerId: number]: boolean }
): void {
  if (carrierRouting.carrierId === undefined) return;
  if (carrierRouting.carrierTeam === undefined || !carrierRouting.carrierPos) return;

  serverPlayers.forEach((sp) => {
    if (!isLiveBotDeployedAndAlive(sp)) return;
    if (sp.id === carrierRouting.carrierId) return;

    const botTeam = getCipherKeyTeamSnapshot(sp.id) ?? mod.GetTeam(sp.player);
    const friendlyCarrier = mod.Equals(botTeam, carrierRouting.carrierTeam);
    const role: BotObjectiveRole = friendlyCarrier ? "escortCarrier" : "interceptCarrier";
    const offsetMeters = friendlyCarrier ? 2.75 : 3.5;
    if (!friendlyCarrier) {
      const carrier = serverPlayers.get(carrierRouting.carrierId as number);
      if (carrier && mod.IsPlayerValid(carrier.player)) {
        trySetRuntimeBotTarget(sp, carrier.player);
      }
    }
    issueBotMoveCommand(sp, role, getBotOffsetTarget(carrierRouting.carrierPos as mod.Vector, sp.id, offsetMeters), nowSec);
    routedByPlayerId[sp.id] = true;
  });
}

function evaluateBotObjectiveController(nowSec: number): void {
  if (gameStatus !== 3) {
    clearBotObjectiveAssignments();
    return;
  }

  reconcileRuntimeBots(nowSec);

  if (!hasLiveBots()) {
    clearBotObjectiveAssignments();
    return;
  }

  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  if (nowSec < botObjectiveNextThinkAtSec) return;
  botObjectiveNextThinkAtSec = nowSec + BOT_OBJECTIVE_THINK_INTERVAL_SECONDS;

  refreshRuntimeBotEnemyTargets(nowSec);

  // Keep pickup logic alive even when bots are already standing near the spawned key.
  // This prevents bots from reaching the key area and then waiting forever.
  if (bombCarrierPlayerId === undefined) {
    try {
      EvaluateResponsiveBombPickupRadiusScans();
    } catch (err) {
      LogRuntimeError("bot_objective_pickup_scan", err);
    }
  }

  const carrierRouting = evaluateBotCarrierRouting(nowSec);
  const routedByPlayerId = evaluateBotKeyRunnerRouting(nowSec, carrierRouting.carrierId);

  if (carrierRouting.carrierId !== undefined && carrierRouting.routed) {
    routedByPlayerId[carrierRouting.carrierId] = true;
  }

  evaluateBotCarrierSupportRouting(nowSec, carrierRouting, routedByPlayerId);

  serverPlayers.forEach((sp) => {
    if (!isLiveBotDeployedAndAlive(sp)) return;
    if (routedByPlayerId[sp.id] === true) return;
    if (tryIssueBotReviveAssignment(sp, nowSec)) return;

    const fallback = chooseBotFallbackAssignment(sp);
    if (!fallback) return;

    issueBotMoveCommand(sp, fallback.role, fallback.target, nowSec);
  });
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
  cancelAllCipherRespawnRouteJobs();
  cipherPresenceZoneActivePlayersByZone = {};
  cipherPresenceZonesByPlayerId = {};
  cipherAnchorPositionByObjectId = {};
  cipherObjectiveAnchorPositionByCpId = {};
  cipherObjectiveAnchorPositionSnapshotByCpId = {};
  cipherPlayerPositionSnapshotByPlayerId = {};
  cipherAnchorCooldownUntilSecByObjectId = {};
  cipherAnchorRoundRobinIndexByKey = {};
  cipherSpawnRegionTieFlipByKey = {};
  cipherLastSpawnRegionByTeamId = {};
  cipherLastSpawnRegionAtSecByTeamId = {};
  cipherQueuedAnchorByPlayerId = {};
  cipherPendingSpawnJobs = [];
  cipherUrgentSpawnJobs = [];
  cipherRespawnRouteJobByPlayerId = {};
}

function clearCipherSpawnJobQueues(): void {
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
    const spatialAnchor = mod.GetSpatialObject(anchorId) as unknown as mod.Object;
    const position = mod.GetObjectPosition(spatialAnchor);
    cipherAnchorPositionByObjectId[anchorId] = position;
    return position;
  } catch (_err) {
    cipherAnchorPositionByObjectId[anchorId] = undefined;
    return undefined;
  }
}

function getCachedObjectiveAnchorPosition(cpId: number): mod.Vector | undefined {
  const cached = cipherObjectiveAnchorPositionByCpId[cpId];
  if (cached) return cached;

  const position = getObjectiveAnchorPosition(cpId);
  if (!position) return undefined;

  cipherObjectiveAnchorPositionByCpId[cpId] = position;
  cipherObjectiveAnchorPositionSnapshotByCpId[cpId] = snapshotVector(position);
  return position;
}

function getCachedObjectiveAnchorPositionSnapshot(cpId: number): CipherVectorSnapshot | undefined {
  const cached = cipherObjectiveAnchorPositionSnapshotByCpId[cpId];
  if (cached) return cached;

  const position = getCachedObjectiveAnchorPosition(cpId);
  if (!position) return undefined;
  return cipherObjectiveAnchorPositionSnapshotByCpId[cpId];
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

function getCipherTeamRoutingKey(team: mod.Team): string {
  return String(modlib.getTeamId(team));
}

function getCipherSpawnRegionKey(region: CipherSpawnRegion): string {
  return region.quadrant + ":" + region.variant;
}

function copyCipherSpawnRegion(region: CipherSpawnRegion): CipherSpawnRegion {
  return {
    quadrant: region.quadrant,
    variant: region.variant,
  };
}

function getCipherPresenceZoneSide(zone: CipherPresenceZone): CipherMapSide {
  return zone === "northWest" || zone === "northEast" ? "north" : "south";
}

function getCipherRequiredSpawnVariantForSide(side: CipherMapSide): CipherSpawnVariant {
  return side;
}

function isCipherSpawnRegionStrictForSide(region: CipherSpawnRegion, side: CipherMapSide): boolean {
  return (
    getCipherPresenceZoneSide(region.quadrant) === side &&
    region.variant === getCipherRequiredSpawnVariantForSide(side)
  );
}

function getCipherStrictSpawnRegionForQuadrant(quadrant: CipherPresenceZone): CipherSpawnRegion {
  const side = getCipherPresenceZoneSide(quadrant);
  return {
    quadrant,
    variant: getCipherRequiredSpawnVariantForSide(side),
  };
}

function getCipherStrictSpawnRegionsForSide(side: CipherMapSide): CipherSpawnRegion[] {
  if (side === "north") {
    return [
      { quadrant: "northWest", variant: "north" },
      { quadrant: "northEast", variant: "north" },
    ];
  }

  return [
    { quadrant: "southWest", variant: "south" },
    { quadrant: "southEast", variant: "south" },
  ];
}

function getCipherAnchorIdsForRegion(region: CipherSpawnRegion): number[] {
  if (region.quadrant === "northEast") {
    return region.variant === "north" ? CIPHER_NORTH_EAST_NORTH_ANCHORS : CIPHER_NORTH_EAST_SOUTH_ANCHORS;
  }
  if (region.quadrant === "northWest") {
    return region.variant === "north" ? CIPHER_NORTH_WEST_NORTH_ANCHORS : CIPHER_NORTH_WEST_SOUTH_ANCHORS;
  }
  if (region.quadrant === "southEast") {
    return region.variant === "north" ? CIPHER_SOUTH_EAST_NORTH_ANCHORS : CIPHER_SOUTH_EAST_SOUTH_ANCHORS;
  }
  return region.variant === "north" ? CIPHER_SOUTH_WEST_NORTH_ANCHORS : CIPHER_SOUTH_WEST_SOUTH_ANCHORS;
}

function getCipherPresenceZoneLane(zone: CipherPresenceZone): CipherPresenceLane {
  return zone === "northWest" || zone === "southWest" ? "west" : "east";
}

function getCipherStrictQuadrantForSideAndLane(side: CipherMapSide, lane: CipherPresenceLane): CipherPresenceZone {
  if (side === "north") return lane === "west" ? "northWest" : "northEast";
  return lane === "west" ? "southWest" : "southEast";
}

function isCipherPresenceEntryCountableEnemy(
  playerId: number,
  zone: CipherPresenceZone,
  storedTeam: mod.Team | undefined,
  enemyTeam: mod.Team
): boolean {
  const sp = serverPlayers.get(playerId);
  let currentTeam: mod.Team | undefined = undefined;
  let stale = false;

  if (!sp || !mod.IsPlayerValid(sp.player) || !sp.isDeployed || !isPlayerAliveSafe(sp.player)) {
    stale = true;
  } else {
    currentTeam = mod.GetTeam(sp.player);
    if (storedTeam !== undefined && !mod.Equals(currentTeam, storedTeam)) {
      stale = true;
    }
  }

  if (stale) {
    const players = cipherPresenceZoneActivePlayersByZone[zone];
    if (players) delete players[playerId];
    const zones = cipherPresenceZonesByPlayerId[playerId];
    if (zones) delete zones[zone];
    delete cipherPlayerPositionSnapshotByPlayerId[playerId];
    return false;
  }

  return currentTeam !== undefined && mod.Equals(currentTeam, enemyTeam);
}

function countCipherEnemyPresenceInZone(zone: CipherPresenceZone, enemyTeam: mod.Team): number {
  const players = cipherPresenceZoneActivePlayersByZone[zone];
  if (!players) return 0;

  let count = 0;
  for (const playerIdKey in players) {
    const playerId = Number(playerIdKey);
    if (isCipherPresenceEntryCountableEnemy(playerId, zone, players[playerId], enemyTeam)) {
      count += 1;
    }
  }
  return count;
}

function countCipherEnemyPresenceInRegion(region: CipherSpawnRegion, enemyTeam: mod.Team): number {
  return countCipherEnemyPresenceInZone(region.quadrant, enemyTeam);
}

function getCipherEnemyLanePressure(team: mod.Team): CipherLanePressure {
  const enemyTeam = getOpposingTeam(team);
  if (!mod.Equals(enemyTeam, team1) && !mod.Equals(enemyTeam, team2)) {
    return { west: 0, east: 0 };
  }

  const pressure: CipherLanePressure = { west: 0, east: 0 };
  const zones: CipherPresenceZone[] = ["northWest", "northEast", "southWest", "southEast"];

  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const lane = getCipherPresenceZoneLane(zone);
    pressure[lane] += countCipherEnemyPresenceInZone(zone, enemyTeam);
  }

  return pressure;
}

function getCipherLanePressureSpawnRegion(team: mod.Team, side: CipherMapSide): CipherSpawnRegion | undefined {
  const pressure = getCipherEnemyLanePressure(team);
  if (pressure.west <= 0 && pressure.east <= 0) return undefined;
  if (pressure.west === pressure.east) return undefined;

  const targetLane: CipherPresenceLane = pressure.west > pressure.east ? "east" : "west";
  return getCipherStrictSpawnRegionForQuadrant(getCipherStrictQuadrantForSideAndLane(side, targetLane));
}

function getDefaultCipherSpawnRegion(team: mod.Team, side: CipherMapSide): CipherSpawnRegion {
  const teamKey = getCipherTeamRoutingKey(team);
  const lastSpawnRegion = cipherLastSpawnRegionByTeamId[teamKey];
  if (lastSpawnRegion && isCipherSpawnRegionStrictForSide(lastSpawnRegion, side)) {
    return copyCipherSpawnRegion(lastSpawnRegion);
  }

  const tieKey = teamKey + ":" + side;
  const next = (cipherSpawnRegionTieFlipByKey[tieKey] ?? 0) + 1;
  cipherSpawnRegionTieFlipByKey[tieKey] = next;

  if (side === "north") {
    return {
      quadrant: mod.Modulo(next, 2) === 0 ? "northWest" : "northEast",
      variant: "north",
    };
  }

  return {
    quadrant: mod.Modulo(next, 2) === 0 ? "southWest" : "southEast",
    variant: "south",
  };
}

function addCipherSpawnRegionCandidate(
  candidates: CipherSpawnRegion[],
  addedByKey: { [key: string]: boolean },
  region: CipherSpawnRegion
): void {
  const key = getCipherSpawnRegionKey(region);
  if (addedByKey[key] === true) return;
  addedByKey[key] = true;
  candidates.push(copyCipherSpawnRegion(region));
}

function appendCipherRegionsByLowestPressure(
  candidates: CipherSpawnRegion[],
  addedByKey: { [key: string]: boolean },
  team: mod.Team,
  side: CipherMapSide
): void {
  const enemyTeam = getOpposingTeam(team);
  const remaining: CipherSpawnRegion[] = [];
  const strictRegions = getCipherStrictSpawnRegionsForSide(side);

  for (let i = 0; i < strictRegions.length; i++) {
    const region = strictRegions[i];
    if (addedByKey[getCipherSpawnRegionKey(region)] === true) continue;
    remaining.push(copyCipherSpawnRegion(region));
  }

  remaining.sort((a, b) => {
    const pressureA = countCipherEnemyPresenceInRegion(a, enemyTeam);
    const pressureB = countCipherEnemyPresenceInRegion(b, enemyTeam);
    if (pressureA !== pressureB) return pressureA - pressureB;
    const keyA = getCipherSpawnRegionKey(a);
    const keyB = getCipherSpawnRegionKey(b);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return 0;
  });

  for (let i = 0; i < remaining.length; i++) {
    addCipherSpawnRegionCandidate(candidates, addedByKey, remaining[i]);
  }
}

function buildCipherSpawnRegionCandidates(team: mod.Team, side: CipherMapSide): CipherSpawnRegion[] {
  const candidates: CipherSpawnRegion[] = [];
  const addedByKey: { [key: string]: boolean } = {};
  const pressuredRegion = getCipherLanePressureSpawnRegion(team, side);

  if (pressuredRegion) {
    addCipherSpawnRegionCandidate(candidates, addedByKey, pressuredRegion);
    appendCipherRegionsByLowestPressure(candidates, addedByKey, team, side);
    return candidates;
  }

  const defaultRegion = getDefaultCipherSpawnRegion(team, side);
  addCipherSpawnRegionCandidate(candidates, addedByKey, defaultRegion);
  appendCipherRegionsByLowestPressure(candidates, addedByKey, team, side);
  return candidates;
}

function countCipherEnemiesNearPosition(
  team: mod.Team,
  pos: mod.Vector,
  radiusMeters: number,
  ignorePlayerId: number = -1
): number {
  return countCipherEnemiesNearPositionWithinRadius(team, pos, radiusMeters, ignorePlayerId);
}

function countCipherEnemiesNearPositionWithinRadius(
  team: mod.Team,
  pos: mod.Vector,
  radiusMeters: number,
  ignorePlayerId: number = -1
): number {
  const enemyTeam = getOpposingTeam(team);
  let count = 0;

  for (const playerIdKey in cipherPlayerPositionSnapshotByPlayerId) {
    const playerId = Number(playerIdKey);
    if (playerId === ignorePlayerId) continue;
    const sp = serverPlayers.get(playerId);
    if (!sp || !mod.IsPlayerValid(sp.player)) continue;
    if (!sp.isDeployed) continue;
    if (!mod.Equals(mod.GetTeam(sp.player), enemyTeam)) continue;
    if (!isPlayerAliveSafe(sp.player)) continue;

    const liveEnemyPos = tryGetPlayerPositionSafe(sp.player);
    const snapshot = liveEnemyPos ? snapshotVector(liveEnemyPos) : cipherPlayerPositionSnapshotByPlayerId[playerId];
    if (!snapshot) {
      delete cipherPlayerPositionSnapshotByPlayerId[playerId];
      continue;
    }
    cipherPlayerPositionSnapshotByPlayerId[playerId] = snapshot;
    const enemyPos = mod.CreateVector(snapshot.x, snapshot.y, snapshot.z);
    if (getBombVectorHorizontalDistanceMeters(pos, enemyPos) <= radiusMeters) {
      count += 1;
    }
  }

  return count;
}

function isCipherAnchorSafeFromEnemiesWithinRadius(anchorPos: mod.Vector, team: mod.Team, radiusMeters: number): boolean {
  return countCipherEnemiesNearPositionWithinRadius(team, anchorPos, radiusMeters) <= 0;
}

function isCipherAnchorSafeFromEnemies(anchorPos: mod.Vector, team: mod.Team): boolean {
  return isCipherAnchorSafeFromEnemiesWithinRadius(anchorPos, team, CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS);
}

function chooseCipherAnchorIdForRegion(
  playerId: number,
  team: mod.Team,
  region: CipherSpawnRegion,
  safetyRadiusMeters: number = CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS,
  allowUnsafeFallback: boolean = false
): number | undefined {
  const anchorIds = getCipherAnchorIdsForRegion(region);
  if (anchorIds.length <= 0) return undefined;

  const nowSec = getCurrentSchedulerNowSeconds();
  const key = getCipherSpawnRegionKey(region) + ":" + String(modlib.getTeamId(team));
  const startIndex = cipherAnchorRoundRobinIndexByKey[key] ?? 0;
  let safeCooldownFallbackAnchorId: number | undefined = undefined;
  let safeCooldownFallbackIndex = startIndex;
  let leastDangerousAnchorId: number | undefined = undefined;
  let leastDangerousEnemyCount = 999999;
  let leastDangerousIndex = startIndex;

  for (let offset = 0; offset < anchorIds.length; offset++) {
    const idx = mod.Modulo(startIndex + offset, anchorIds.length);
    const anchorId = anchorIds[idx];
    const anchorPos = getCachedCipherAnchorPosition(anchorId);
    if (!anchorPos) continue;
    const enemyCount = countCipherEnemiesNearPositionWithinRadius(team, anchorPos, safetyRadiusMeters, playerId);
    if (
      enemyCount < leastDangerousEnemyCount ||
      (enemyCount === leastDangerousEnemyCount && anchorId < (leastDangerousAnchorId ?? 999999))
    ) {
      leastDangerousAnchorId = anchorId;
      leastDangerousEnemyCount = enemyCount;
      leastDangerousIndex = idx;
    }
    if (enemyCount > 0) continue;

    const cooldownUntil = cipherAnchorCooldownUntilSecByObjectId[anchorId] ?? 0;
    if (cooldownUntil > nowSec) {
      if (safeCooldownFallbackAnchorId === undefined) {
        safeCooldownFallbackAnchorId = anchorId;
        safeCooldownFallbackIndex = idx;
      }
      continue;
    }

    cipherAnchorRoundRobinIndexByKey[key] = mod.Modulo(idx + 1, anchorIds.length);
    cipherAnchorCooldownUntilSecByObjectId[anchorId] = nowSec + CIPHER_ANCHOR_COOLDOWN_SECONDS;
    return anchorId;
  }

  if (safeCooldownFallbackAnchorId !== undefined) {
    cipherAnchorRoundRobinIndexByKey[key] = mod.Modulo(safeCooldownFallbackIndex + 1, anchorIds.length);
    cipherAnchorCooldownUntilSecByObjectId[safeCooldownFallbackAnchorId] = nowSec + CIPHER_ANCHOR_COOLDOWN_SECONDS;
    return safeCooldownFallbackAnchorId;
  }

  if (allowUnsafeFallback && leastDangerousAnchorId !== undefined) {
    cipherAnchorRoundRobinIndexByKey[key] = mod.Modulo(leastDangerousIndex + 1, anchorIds.length);
    cipherAnchorCooldownUntilSecByObjectId[leastDangerousAnchorId] = nowSec + CIPHER_ANCHOR_COOLDOWN_SECONDS;
    return leastDangerousAnchorId;
  }
  void playerId;
  return undefined;
}

function chooseCipherSpawnAnchorForPlayer(
  playerId: number,
  team: mod.Team,
  defaultSide: CipherMapSide,
  preferredRegions?: CipherSpawnRegion[],
  safetyRadiusMeters: number = CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS,
  allowUnsafeFallback: boolean = false
): CipherQueuedSpawnAnchor | undefined {
  const candidates = preferredRegions ?? buildCipherSpawnRegionCandidates(team, defaultSide);

  for (let i = 0; i < candidates.length; i++) {
    const region = candidates[i];
    const anchorId = chooseCipherAnchorIdForRegion(playerId, team, region, safetyRadiusMeters, allowUnsafeFallback);
    if (anchorId === undefined) continue;
    return {
      anchorObjectId: anchorId,
      side: getCipherPresenceZoneSide(region.quadrant),
      region: copyCipherSpawnRegion(region),
    };
  }

  return undefined;
}

function cancelCipherRespawnRouteJobForPlayer(playerId: number): void {
  const job = cipherRespawnRouteJobByPlayerId[playerId];
  if (job?.timerHandle !== undefined) {
    Timers.clearInterval(job.timerHandle);
  }
  delete cipherRespawnRouteJobByPlayerId[playerId];
}

function cancelAllCipherRespawnRouteJobs(): void {
  for (const playerIdKey in cipherRespawnRouteJobByPlayerId) {
    cancelCipherRespawnRouteJobForPlayer(Number(playerIdKey));
  }
  cipherRespawnRouteJobByPlayerId = {};
}

function nextCipherRespawnRouteToken(playerId: number): number {
  const token = (cipherRespawnRouteTokenByPlayerId[playerId] ?? 0) + 1;
  cipherRespawnRouteTokenByPlayerId[playerId] = token;
  return token;
}

function invalidateCipherRespawnRouteJobForPlayer(playerId: number): void {
  nextCipherRespawnRouteToken(playerId);
  cancelCipherRespawnRouteJobForPlayer(playerId);
}

function isCipherRespawnRouteJobCurrent(job: CipherRespawnRouteJob): boolean {
  if (cipherRespawnRouteTokenByPlayerId[job.playerId] !== job.token) return false;
  if (gameStatus !== 3) return false;
  if (isCipherLiveTransitionActive()) return false;
  if (isCipherSuddenDeathActive()) return false;

  const sp = serverPlayers.get(job.playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return false;
  if (sp.isDeployed) return false;

  const team = mod.GetTeam(sp.player);
  const teamId = modlib.getTeamId(team);
  if (teamId !== job.teamId) return false;
  return mod.Equals(team, team1) || mod.Equals(team, team2);
}

function getCipherActiveObjectiveDefsForDefendingTeam(team: mod.Team): ObjectiveDefinition[] {
  const defs: ObjectiveDefinition[] = [];
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    if (def.half !== cipherCurrentHalf) continue;
    if (!def.countsForRouting) continue;
    if (!mod.Equals(def.defendingTeam, team)) continue;
    defs.push(def);
  }
  return defs;
}

function getCipherPresenceLaneForObjective(def: ObjectiveDefinition): CipherPresenceLane {
  return def.lane === "A" || def.lane === "C" ? "west" : "east";
}

function getCipherObjectivePressureSpawnRegion(team: mod.Team, side: CipherMapSide): CipherSpawnRegion | undefined {
  const defs = getCipherActiveObjectiveDefsForDefendingTeam(team);
  if (defs.length <= 0) return undefined;

  refreshCipherPlayerPositionSnapshots();
  const pressure: CipherLanePressure = { west: 0, east: 0 };
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    const pos = getCachedObjectiveAnchorPosition(def.cpId);
    if (!pos) continue;
    const lane = getCipherPresenceLaneForObjective(def);
    pressure[lane] += countCipherEnemiesNearPosition(
      team,
      pos,
      CIPHER_RESPAWN_OBJECTIVE_PRESSURE_RADIUS_METERS
    );
  }

  if (pressure.west === pressure.east) return undefined;
  const targetLane: CipherPresenceLane = pressure.west > pressure.east ? "east" : "west";
  return getCipherStrictSpawnRegionForQuadrant(getCipherStrictQuadrantForSideAndLane(side, targetLane));
}

function buildCipherRespawnRouteRegionCandidates(team: mod.Team, side: CipherMapSide): CipherSpawnRegion[] {
  const candidates: CipherSpawnRegion[] = [];
  const addedByKey: { [key: string]: boolean } = {};
  const objectivePressureRegion = getCipherObjectivePressureSpawnRegion(team, side);
  if (objectivePressureRegion) addCipherSpawnRegionCandidate(candidates, addedByKey, objectivePressureRegion);

  const presencePressureRegion = getCipherLanePressureSpawnRegion(team, side);
  if (presencePressureRegion) addCipherSpawnRegionCandidate(candidates, addedByKey, presencePressureRegion);

  addCipherSpawnRegionCandidate(candidates, addedByKey, getDefaultCipherSpawnRegion(team, side));
  appendCipherRegionsByLowestPressure(candidates, addedByKey, team, side);
  return candidates;
}

function selectCipherRespawnRouteCandidate(
  playerId: number,
  team: mod.Team,
  safetyRadiusMeters: number,
  allowUnsafeFallback: boolean
): CipherQueuedSpawnAnchor | undefined {
  const side = getCipherTeamSideForCurrentHalf(team);
  if (!side) return undefined;
  const candidates = buildCipherRespawnRouteRegionCandidates(team, side);
  return chooseCipherSpawnAnchorForPlayer(playerId, team, side, candidates, safetyRadiusMeters, allowUnsafeFallback);
}

function isCipherRespawnCandidateSafe(
  candidate: CipherQueuedSpawnAnchor | undefined,
  team: mod.Team,
  radiusMeters: number
): boolean {
  if (!candidate) return false;
  const pos = getCachedCipherAnchorPosition(candidate.anchorObjectId);
  if (!pos) return false;
  refreshCipherPlayerPositionSnapshots();
  return isCipherAnchorSafeFromEnemiesWithinRadius(pos, team, radiusMeters);
}

function finalizeCipherRespawnRouteJobForPlayer(playerId: number, source: string): void {
  const job = cipherRespawnRouteJobByPlayerId[playerId];
  if (!job) return;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    return;
  }

  const team = mod.GetTeam(sp.player);
  let candidate = job.finalizedCandidate ?? job.currentCandidate;
  if (!candidate || !isCipherQueuedSpawnAnchorValidForTeam(candidate, team)) {
    candidate = selectCipherRespawnRouteCandidate(
      playerId,
      team,
      CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS,
      true
    );
  }

  if (candidate) {
    cipherQueuedAnchorByPlayerId[playerId] = candidate;
  }

  void source;
  cancelCipherRespawnRouteJobForPlayer(playerId);
}

function tickCipherRespawnRouteJob(playerId: number, token: number): void {
  const job = cipherRespawnRouteJobByPlayerId[playerId];
  if (!job || job.token !== token) return;
  if (!isCipherRespawnRouteJobCurrent(job)) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    return;
  }

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    return;
  }

  const team = mod.GetTeam(sp.player);
  job.currentSecond += 1;

  if (job.currentSecond === 1) {
    job.currentCandidate = selectCipherRespawnRouteCandidate(
      playerId,
      team,
      CIPHER_RESPAWN_OBJECTIVE_PRESSURE_RADIUS_METERS,
      true
    );
  } else if (job.currentSecond === 2) {
    job.dangerDetected = !isCipherRespawnCandidateSafe(
      job.currentCandidate,
      team,
      CIPHER_RESPAWN_CANDIDATE_SAFETY_RADIUS_METERS
    );
  } else if (job.currentSecond === 3) {
    if (job.dangerDetected) {
      job.currentCandidate = selectCipherRespawnRouteCandidate(
        playerId,
        team,
        CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS,
        true
      );
      job.dangerDetected = !isCipherRespawnCandidateSafe(
        job.currentCandidate,
        team,
        CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS
      );
    }
  } else if (job.currentSecond === 4) {
    if (!isCipherRespawnCandidateSafe(job.currentCandidate, team, CIPHER_RESPAWN_CANDIDATE_SAFETY_RADIUS_METERS)) {
      job.currentCandidate = selectCipherRespawnRouteCandidate(
        playerId,
        team,
        CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS,
        true
      );
    }
  }

  if (job.currentSecond >= CIPHER_RESPAWN_ROUTE_EVALUATION_SECONDS) {
    job.finalizedCandidate = job.currentCandidate ?? selectCipherRespawnRouteCandidate(
      playerId,
      team,
      CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS,
      true
    );
    finalizeCipherRespawnRouteJobForPlayer(playerId, "route_timer_complete");
  }
}

function shouldStartCipherRespawnRouteJobForPlayer(playerId: number, wasDeployed: boolean): boolean {
  if (!wasDeployed) return false;
  if (gameStatus !== 3) return false;
  if (isCipherLiveTransitionActive()) return false;
  if (isCipherSuddenDeathActive()) return false;
  if (safeSpawnForcedUndeploy[playerId] === true || safeSpawnUnsafePending[playerId] === true) return false;
  if (isCipherRuntimeBotPlayerId(playerId)) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return false;
  const team = mod.GetTeam(sp.player);
  return mod.Equals(team, team1) || mod.Equals(team, team2);
}

function startCipherRespawnRouteJobForPlayer(playerId: number, wasDeployed: boolean, source: string): void {
  if (!shouldStartCipherRespawnRouteJobForPlayer(playerId, wasDeployed)) return;

  cancelCipherRespawnRouteJobForPlayer(playerId);
  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;

  const team = mod.GetTeam(sp.player);
  const token = nextCipherRespawnRouteToken(playerId);
  const job: CipherRespawnRouteJob = {
    token,
    playerId,
    teamId: modlib.getTeamId(team),
    startedAtSec: getCurrentSchedulerNowSeconds(),
    currentSecond: 0,
    dangerDetected: false,
  };

  job.timerHandle = Timers.setInterval(() => tickCipherRespawnRouteJob(playerId, token), CIPHER_RESPAWN_ROUTE_TICK_MS);
  cipherRespawnRouteJobByPlayerId[playerId] = job;
  void source;
}

function getCipherAttackObjectiveCenterForSide(side: CipherMapSide): mod.Vector | undefined {
  const targetCpIds = getActiveObjectiveCpIdsForSide(side === "north" ? "south" : "north");
  let total: mod.Vector | undefined = undefined;
  let count = 0;

  for (let i = 0; i < targetCpIds.length; i++) {
    const position = getCachedObjectiveAnchorPosition(targetCpIds[i]);
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

function isCipherQueuedSpawnAnchorValidForTeam(queuedAnchor: CipherQueuedSpawnAnchor, team: mod.Team): boolean {
  const expectedSide = getCipherTeamSideForCurrentHalf(team);
  if (!expectedSide) return false;
  if (queuedAnchor.side !== expectedSide) return false;
  if (!isCipherSpawnRegionStrictForSide(queuedAnchor.region, expectedSide)) return false;
  return getCipherAnchorIdsForRegion(queuedAnchor.region).indexOf(queuedAnchor.anchorObjectId) >= 0;
}

function prepareCipherQueuedAnchorForPlayer(playerId: number, forceRefresh: boolean = false): boolean {
  if (!isCipherSpawnRoutingPhaseActive()) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return false;

  const team = mod.GetTeam(sp.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;

  const defaultSide = getCipherTeamSideForCurrentHalf(team);
  if (!defaultSide) return false;

  const queuedAnchor = cipherQueuedAnchorByPlayerId[playerId];
  if (!forceRefresh && queuedAnchor !== undefined) {
    if (isCipherQueuedSpawnAnchorValidForTeam(queuedAnchor, team)) return true;
    delete cipherQueuedAnchorByPlayerId[playerId];
  }

  refreshCipherPlayerPositionSnapshots();
  const selectedAnchor = chooseCipherSpawnAnchorForPlayer(playerId, team, defaultSide);
  if (!selectedAnchor) return false;

  cipherQueuedAnchorByPlayerId[playerId] = selectedAnchor;
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

function getClosestCipherEnemyObjectivePositionForTeleport(
  team: mod.Team,
  spawnPos: mod.Vector,
  queuedAnchor: CipherQueuedSpawnAnchor
): mod.Vector | undefined {
  const enemyTeam = getOpposingTeam(team);
  let defs = getCipherActiveObjectiveDefsForDefendingTeam(enemyTeam);

  if (defs.length <= 0) {
    const fallbackSide = queuedAnchor.side === "north" ? "south" : "north";
    const cpIds = getActiveObjectiveCpIdsForSide(fallbackSide);
    defs = [];
    for (let i = 0; i < cpIds.length; i++) {
      const def = objectiveDefByCpId[cpIds[i]];
      if (def) defs.push(def);
    }
  }

  let bestPos: mod.Vector | undefined = undefined;
  let bestDistance = 999999999;
  for (let i = 0; i < defs.length; i++) {
    const pos = getCachedObjectiveAnchorPosition(defs[i].cpId);
    if (!pos) continue;
    const distance = getBombVectorHorizontalDistanceSquared(spawnPos, pos);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPos = pos;
    }
  }

  return bestPos;
}

function computeCipherTeleportYawTowardObjective(
  spawnPos: mod.Vector,
  team: mod.Team,
  queuedAnchor: CipherQueuedSpawnAnchor
): number {
  const target = getClosestCipherEnemyObjectivePositionForTeleport(team, spawnPos, queuedAnchor);
  if (target) return getCipherTeleportYawRadians(spawnPos, target);
  return getCipherTeleportYawRadians(spawnPos, getCipherAttackObjectiveCenterForSide(queuedAnchor.side));
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
  if (!isCipherQueuedSpawnAnchorValidForTeam(queuedAnchor, team)) {
    delete cipherQueuedAnchorByPlayerId[playerId];
    if (!prepareCipherQueuedAnchorForPlayer(playerId, true)) return false;
  }

  const refreshedQueuedAnchor = getCipherQueuedSpawnAnchorForPlayer(playerId);
  if (!refreshedQueuedAnchor) return false;

  let finalQueuedAnchor = refreshedQueuedAnchor;
  let anchorPos = getCachedCipherAnchorPosition(finalQueuedAnchor.anchorObjectId);
  if (!anchorPos) return false;
  refreshCipherPlayerPositionSnapshots();
  if (!isCipherAnchorSafeFromEnemies(anchorPos, team)) {
    delete cipherQueuedAnchorByPlayerId[playerId];
    if (!prepareCipherQueuedAnchorForPlayer(playerId, true)) return false;

    const safeQueuedAnchor = getCipherQueuedSpawnAnchorForPlayer(playerId);
    if (!safeQueuedAnchor) return false;
    finalQueuedAnchor = safeQueuedAnchor;
    anchorPos = getCachedCipherAnchorPosition(finalQueuedAnchor.anchorObjectId);
    if (!anchorPos) return false;
    refreshCipherPlayerPositionSnapshots();
    if (!isCipherAnchorSafeFromEnemies(anchorPos, team)) {
      delete cipherQueuedAnchorByPlayerId[playerId];
      return false;
    }
  }

  const yawRadians = computeCipherTeleportYawTowardObjective(anchorPos, team, finalQueuedAnchor);

  try {
    (mod as any).Teleport(player, anchorPos, yawRadians);
    cipherPlayerPositionSnapshotByPlayerId[playerId] = snapshotVector(anchorPos);
    const teamKey = getCipherTeamRoutingKey(team);
    cipherLastSpawnRegionByTeamId[teamKey] = copyCipherSpawnRegion(finalQueuedAnchor.region);
    cipherLastSpawnRegionAtSecByTeamId[teamKey] = getCurrentSchedulerNowSeconds();
    delete cipherQueuedAnchorByPlayerId[playerId];
    if (isCipherLiveTransitionActive()) {
      cipherTransitionTeleportedByPlayerId[playerId] = true;
    }
    return true;
  } catch (err) {
    LogRuntimeError("CipherSpawnTeleport/" + String(playerId) + "/" + String(finalQueuedAnchor.anchorObjectId), err);
  }
  return false;
}

function getBombDynamicLaneMidpoints(): BombDynamicLaneMidpoint[] | undefined {
  const cpA = getActiveObjectiveCpIdForLane("A");
  const cpB = getActiveObjectiveCpIdForLane("B");
  const cpC = getActiveObjectiveCpIdForLane("C");
  const cpD = getActiveObjectiveCpIdForLane("D");
  const posA = getObjectiveAnchorPosition(cpA);
  const posB = getObjectiveAnchorPosition(cpB);
  const posC = getObjectiveAnchorPosition(cpC);
  const posD = getObjectiveAnchorPosition(cpD);

  if (!posA || !posB || !posC || !posD) return undefined;

  return [
    { lane: "AC", midpoint: getBombVectorMidpoint(posA, posC) },
    { lane: "BD", midpoint: getBombVectorMidpoint(posB, posD) },
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
    if (lane === "AC") return 0;
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

  return tryGetBombAnchorObjectPositionById(
    cfg.anchorObjectId,
    getBombDynamicLandingDebugContext(context) + "_anchor_object_" + String(cfg.anchorObjectId)
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
      anchorObjectId: cfg.anchorObjectId,
      anchorPos,
      distanceSquared: getBombVectorHorizontalDistanceSquared(seed, anchorPos),
    });
  }

  candidates.sort((a, b) => {
    const distanceDelta = a.distanceSquared - b.distanceSquared;
    if (Math.abs(distanceDelta) > 0.0001) return distanceDelta;
    if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex;
    return a.anchorObjectId - b.anchorObjectId;
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
      anchorObjectId: cfg.anchorObjectId,
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
    return a.anchorObjectId - b.anchorObjectId;
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
        playerBiasedCandidates[0].anchorObjectId
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
    candidates[0].anchorObjectId
  );
  return candidates;
}

function scheduleDynamicBaseBombRespawnRetry(
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased",
  labelMode: NextKeyUnlockLabelMode = "next_key"
): void {
  if (gameStatus !== 3) return;
  setBombDynamicRetryDebugState(context);
  scheduleDeferredBombRespawnAfterDelay(
    BOMB_DYNAMIC_RETRY_DELAY_SECONDS,
    context + "_dynamic_retry",
    announcementMode,
    showHighlightMessage,
    spawnStrategy,
    false,
    labelMode
  );
}

async function respawnBombAtDynamicLocationNow(
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased",
  reservedCandidate?: BombBaseAnchorCandidate
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

  const fallbackAnchorCandidates = reservedCandidate
    ? []
    : resolveDynamicBombBaseAnchorCandidates(context, spawnStrategy);
  const anchorCandidates = reservedCandidate
    ? [reservedCandidate].concat(resolveDynamicBombBaseAnchorCandidates(context + "_reserved_fallback", spawnStrategy))
    : fallbackAnchorCandidates;
  if (anchorCandidates.length <= 0) {
    warnBombBaseReturnRespawnFailureOnce(context + ": dynamic anchor resolve failed");
    return false;
  }

  let lastFailureReason = "no_anchor_candidates";

  for (let i = 0; i < anchorCandidates.length; i++) {
    const candidate = anchorCandidates[i];
    const runtimeBaseSpawn = spawnLootAtRuntimeSpawner(
      candidate.anchorPos,
      context + "_anchor_" + String(candidate.anchorObjectId)
    );
    if (!runtimeBaseSpawn.object || !runtimeBaseSpawn.spawner) {
      lastFailureReason =
        "spawn_validation_failed(anchor=" +
        String(candidate.anchorObjectId) +
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
      lastFailureReason = "pickup_trigger_move_failed(anchor=" + String(candidate.anchorObjectId) + ")";
      continue;
    }

    setBombSpawnValidationDebugState(
      getBombDynamicLandingDebugContext(context),
      "anchor_selected",
      candidate.anchorObjectId
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
    clearBombCarrierDeployRestoreCacheForPlayer(playerId);
    return;
  }
  if (replacedSlot === undefined || previousEquipment === undefined) {
    clearBombCarrierDeployRestoreCacheForPlayer(playerId);
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

  clearBombCarrierDeployRestoreCacheForPlayer(playerId);
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

  const scheduled = scheduleBombCarrierReplacementEquipmentRestoreForPlayer(
    playerId,
    player,
    replacedSlot,
    previousEquipment,
    restoreAmmoState,
    reason
  );
  if (!scheduled) {
    clearBombCarrierDeployRestoreCacheForPlayer(playerId);
  }
}

function invalidateBombReturnToBaseTimer(): void {
  bombReturnToBaseToken += 1;
  bombDroppedReturnDeadlineAtSec = 0;
  bombDroppedWorldIconLastShownSeconds = -1;
}

function invalidateDeferredBombSpawnTimer(): void {
  bombDeferredBaseSpawnToken += 1;
  cipherDeferredLiveStartKeyToken += 1;
  Timers.clearTimeout(cipherDeferredLiveStartKeyTimerHandle);
  cipherDeferredLiveStartKeyTimerHandle = undefined;
  clearNextKeyUnlockCountdown("invalidateDeferredBombSpawnTimer", true);
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

function reserveNextKeyUnlockAnchor(
  context: string,
  delaySeconds: number,
  spawnStrategy: BombDynamicSpawnStrategy,
  labelMode: NextKeyUnlockLabelMode
): BombBaseAnchorCandidate | undefined {
  if (delaySeconds <= 0) {
    clearNextKeyUnlockCountdown(context + "_no_delay", true);
    return undefined;
  }

  const candidates = resolveDynamicBombBaseAnchorCandidates(context + "_next_key_reserve", spawnStrategy);
  if (candidates.length <= 0) {
    clearNextKeyUnlockCountdown(context + "_reserve_failed", true);
    return undefined;
  }

  const candidate = candidates[0];
  nextKeyUnlockCountdownToken++;
  nextKeyUnlockDeadlineAtSec = getCurrentSchedulerNowSeconds() + delaySeconds;
  nextKeyUnlockAnchorPosition = candidate.anchorPos;
  nextKeyUnlockLabelMode = labelMode;
  nextKeyUnlockWorldIconLastShownSeconds = -1;
  updateNextKeyUnlockCountdownVisuals(undefined, true);
  return candidate;
}

function scheduleDeferredBombRespawnAfterDelay(
  delaySeconds: number,
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean = true,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased",
  showNextKeyUnlockCountdown: boolean = false,
  labelMode: NextKeyUnlockLabelMode = "next_key"
): void {
  const myToken = bombDeferredBaseSpawnToken + 1;
  bombDeferredBaseSpawnToken = myToken;
  const reservedCandidate = showNextKeyUnlockCountdown
    ? reserveNextKeyUnlockAnchor(context, delaySeconds, spawnStrategy, labelMode)
    : undefined;
  const reservedCountdownToken = showNextKeyUnlockCountdown ? nextKeyUnlockCountdownToken : 0;
  if (!showNextKeyUnlockCountdown) {
    clearNextKeyUnlockCountdown(context + "_no_countdown", true);
  }
  void runDeferredBombRespawnAfterDelay(
    myToken,
    delaySeconds,
    context,
    announcementMode,
    showHighlightMessage,
    spawnStrategy,
    reservedCandidate,
    reservedCountdownToken,
    labelMode
  );
}

async function runDeferredBombRespawnAfterDelay(
  token: number,
  delaySeconds: number,
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy,
  reservedCandidate?: BombBaseAnchorCandidate,
  reservedCountdownToken: number = 0,
  labelMode: NextKeyUnlockLabelMode = "next_key"
): Promise<void> {
  if (delaySeconds > 0) {
    await mod.Wait(delaySeconds);
  }

  if (bombDeferredBaseSpawnToken !== token) {
    if (reservedCountdownToken > 0 && nextKeyUnlockCountdownToken === reservedCountdownToken) {
      clearNextKeyUnlockCountdown(context + "_stale_token", true);
    }
    return;
  }
  if (gameStatus !== 3) {
    clearNextKeyUnlockCountdown(context + "_phase_exit", true);
    return;
  }

  // Fail-closed: if bomb authority is already active or a dynamic spawn is settling, do not force another spawn.
  if (bombCarrierPlayerId !== undefined || hasDroppedBombRuntimeObjects() || hasBaseBombAuthorityOrPending()) {
    clearNextKeyUnlockCountdown(context + "_authority_already_active", true);
    return;
  }

  clearNextKeyUnlockCountdown(context + "_spawn_attempt", true);
  const spawned = await respawnBombAtDynamicLocationNow(
    context,
    announcementMode,
    showHighlightMessage,
    spawnStrategy,
    reservedCandidate
  );
  if (!spawned) {
    scheduleDynamicBaseBombRespawnRetry(context, announcementMode, showHighlightMessage, spawnStrategy, labelMode);
  }
}

function resetCipherKeyTimeTrackingState(): void {
  cipherKeyTimeCarrierPlayerId = undefined;
  cipherKeyTimeLastWholeSecond = undefined;
}

function startCipherKeyTimeTrackingForCarrier(playerId: number, nowSec?: number): void {
  const resolvedNowSec = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();
  cipherKeyTimeCarrierPlayerId = playerId;
  cipherKeyTimeLastWholeSecond = mod.Floor(resolvedNowSec);
}

function updateCipherKeyTimeCarryStats(nowSec: number): void {
  if (
    gameStatus !== 3 ||
    initialization[3] !== true ||
    isCipherLiveTransitionActive() ||
    bombCarrierPlayerId === undefined
  ) {
    resetCipherKeyTimeTrackingState();
    return;
  }

  const carrierId = bombCarrierPlayerId;
  const carrier = serverPlayers.get(carrierId);
  if (
    !carrier ||
    !carrier.isDeployed ||
    !mod.IsPlayerValid(carrier.player) ||
    !isPlayerAliveSafe(carrier.player)
  ) {
    resetCipherKeyTimeTrackingState();
    return;
  }

  const wholeSecond = mod.Floor(nowSec);
  if (cipherKeyTimeCarrierPlayerId !== carrierId || cipherKeyTimeLastWholeSecond === undefined) {
    cipherKeyTimeCarrierPlayerId = carrierId;
    cipherKeyTimeLastWholeSecond = wholeSecond;
    return;
  }

  const elapsedSeconds = wholeSecond - cipherKeyTimeLastWholeSecond;
  if (elapsedSeconds <= 0) return;

  carrier.addKeyTimeSeconds(elapsedSeconds);
  cipherKeyTimeLastWholeSecond = wholeSecond;
  carrier.updateScoreboard();
}

function clearBombCarrierState(): void {
  resetCipherKeyTimeTrackingState();
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

  return getObjectiveAnchorPosition(cpId);
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
  startCipherKeyTimeTrackingForCarrier(playerId);
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
  refreshCipherKeyUiAndIconsImmediately("assignBombCarrierFromDelta");

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
  clearBotObjectiveAssignments();
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
  if (bombCarrierPlayerId !== undefined) return false;
  if (bombPickupTransferInProgress) return false;
  if (!sp.isDeployed) return false;
  if (!mod.IsPlayerValid(sp.player)) return false;
  if (!isPlayerAlive(sp.player)) return false;

  const playerTeam = getCipherKeyTeamSnapshot(sp.id) ?? sp.team;
  if (!mod.Equals(playerTeam, team1) && !mod.Equals(playerTeam, team2)) return false;

  bombPickupTransferInProgress = true;
  try {
    if (bombCarrierPlayerId !== undefined) return false;

    invalidateDeferredBombSpawnTimer();
    invalidateBombReturnToBaseTimer();
    if (fromDroppedBomb) {
      clearDroppedBombRuntimeObjects();
    } else {
      clearBombBaseRuntimeLootSpawner();
      clearBombBaseRuntimeWorldIcon();
    }
    setBombPickupTriggerEnabled(false);
    setBombBaseAvailabilityState(false);

    removeBombEquipmentSafe(sp.player);

    assignBombCarrierFromDelta(
      sp.id,
      {
        replacedSlot: undefined,
        replacedEquipment: undefined,
      },
      fromDroppedBomb,
      resolver
    );

    tryDeliverCipherKeyFromActiveObjectiveAreaForCarrier(sp.id);
    return true;
  } finally {
    bombPickupTransferInProgress = false;
  }
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

function clearDeferredBombCarrierDropTimer(): void {
  if (deferredBombCarrierDropTimer !== undefined) {
    Timers.clearTimeout(deferredBombCarrierDropTimer);
  }

  deferredBombCarrierDropTimer = undefined;
}

function scheduleBombCarrierDropAfterCombatEvent(
  playerId: number,
  reason: "death" | "mandown" | "undeploy",
  dropPositionOverride?: mod.Vector
): void {
  if (bombCarrierPlayerId === undefined) return;
  if (bombCarrierPlayerId !== playerId) return;

  deferredBombCarrierDropToken += 1;
  const token = deferredBombCarrierDropToken;
  clearDeferredBombCarrierDropTimer();

  const cachedDropPosition =
    dropPositionOverride ??
    getPlayerResolvedDropPosition(playerId) ??
    getActiveBombSourcePosition();

  // Do not drop the key directly inside OnMandown/OnPlayerDied/OnPlayerUndeploy.
  // Those event stacks are high-risk because they are already mutating soldier/combat state.
  deferredBombCarrierDropTimer = Timers.setTimeout(() => {
    if (token !== deferredBombCarrierDropToken) return;
    deferredBombCarrierDropTimer = undefined;

    if (gameStatus !== 3) return;
    if (bombCarrierPlayerId !== playerId) return;

    try {
      forceBombDropFromCarrier(playerId, reason, cachedDropPosition);
      botObjectiveNextThinkAtSec = 0;
    } catch (err) {
      LogRuntimeError("DeferredBombCarrierDrop/" + reason, err);

      // Fail safe: never leave the match locked with a dead carrier still holding the key.
      try {
        clearBombCarrierState();
        clearDroppedBombRuntimeObjects();
        setBombPickupTriggerEnabled(false);
        setBombBaseAvailabilityState(false);
        scheduleDeferredBombRespawnAfterDelay(0, "deferred_carrier_drop_failed", "new_location_found", true);
      } catch (fallbackErr) {
        LogRuntimeError("DeferredBombCarrierDropFallback/" + reason, fallbackErr);
      }
    }
  }, 150);
}

function forceBombDropFromCarrier(playerId: number, reason: string, dropPositionOverride?: mod.Vector): void {
  if (bombCarrierPlayerId === undefined) return;
  if (bombCarrierPlayerId !== playerId) return;

  const sp = serverPlayers.get(playerId);
  const replacedSlot = bombCarrierReplacedSlotByPlayerId[playerId];
  const previousEquipment = bombCarrierPreviousEquipmentByPlayerId[playerId];
  const shouldShowDropNotice =
    reason === "death" ||
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
  clearBotObjectiveAssignments();
  if (shouldShowDropNotice) {
    showCipherKeyDroppedNoticeForTeam(carrierTeamForNotice);
  }

  const canSafelyRestoreCarrierInventory =
    reason !== "death" &&
    reason !== "mandown" &&
    reason !== "undeploy" &&
    sp !== undefined &&
    mod.IsPlayerValid(sp.player) &&
    isPlayerAliveSafe(sp.player) &&
    playerInMandownByPlayerId[playerId] !== true;

  if (canSafelyRestoreCarrierInventory && sp) {
    try {
      restoreBombCarrierInventoryForPlayer(playerId, sp.player, replacedSlot, previousEquipment, reason);
    } catch (err) {
      LogRuntimeError("restoreBombCarrierInventoryForPlayer/" + reason, err);
    }
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
    refreshCipherKeyUiAndIconsImmediately("forceBombDropFromCarrier_fallback");
    scheduleDeferredBombRespawnAfterDelay(0, "carrier_drop_fallback_dynamic", "new_location_found", true);
    return;
  }

  bombDroppedSourceKind = "carrier_drop";
  bombDroppedPickupAnchorPosition = dropPos;
  bombDroppedLastCarrierPlayerId = playerId;
  bombDroppedLastCarrierBlockedUntilSec =
    getCurrentSchedulerNowSeconds() + BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS;
  setBombPickupTriggerEnabled(false);

  refreshCipherKeyUiAndIconsImmediately("forceBombDropFromCarrier");

  EvaluateDroppedBombReclaimFromAnchor();
  if (!hasDroppedBombRuntimeObjects() || bombCarrierPlayerId !== undefined) {
    return;
  }

  scheduleBombReturnToBaseAfterDelay();
}

function resetBombCarrierRuntimeState(hideBaseIcon: boolean, preserveDeployRestoreCache = false): void {
  clearBotObjectiveState();
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
  bombAnchorObjectMissingWarnedById = {};
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
  if (BOMB_QUAD_BIKE_SPAWN_OBJECT_ID <= 0) return;

  const spawnTransform = tryResolveQuadBikeSpawnObjectTransform();
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
  return;
}

function spawnBombPickupObjectAtLiveStart(): boolean {
  emitLiveTransitionCheckpoint("bomb_live_start_schedule_enter");
  scheduleDeferredBombRespawnAfterDelay(
    BOMB_LIVE_START_INITIAL_SPAWN_DELAY_SECONDS,
    "live_start_delayed",
    "bomb_located",
    false,
    "live_start_center",
    true,
    "first_key"
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
    const objectiveMcom = mod.GetMCOM(mcomId) as unknown as mod.Object;
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
    const spatialAnchor = mod.GetSpatialObject(anchorId) as unknown as mod.Object;
    return mod.GetObjectPosition(spatialAnchor);
  } catch (_err) {}

  try {
    const vfxAnchor = mod.GetVFX(anchorId) as unknown as mod.Object;
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

  // Final fallback: configured objective world-position anchor.
  return getObjectiveAnchorPosition(cpId);
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
    objectiveSurfaceSectorObjectiveEnabledBySectorId[sectorId] = false;
  } catch (_err) {}
}

function disableCapturePointObjectiveByIdSafe(cpId: number): void {
  try {
    const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "disableCapturePointObjectiveByIdSafe");
    if (!capturePoint) return;
    disableObjectiveSafely(capturePoint);
    objectiveCapturePointObjectiveEnabledByCpId[cpId] = false;
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

function getDebugTeamId(team: mod.Team): number {
  try {
    return modlib.getTeamId(team);
  } catch (_err) {
    return -1;
  }
}

function warnObjectiveEngineCallOnce(key: string, message: any): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (objectiveEngineWarnedByKey[key] === true) return;
  objectiveEngineWarnedByKey[key] = true;
  emitStringKeyDebugWorldLog(message);
}

function resolveObjectiveCapturePointHandleByCpId(
  cpId: number,
  context: string
): mod.CapturePoint | undefined {
  const cp = serverCapturePoints[cpId];
  if (cp) return cp.resolveHandle(context);

  try {
    const capturePoint = mod.GetCapturePoint(cpId);
    return capturePoint;
  } catch (err) {
    LogRuntimeError("GetCapturePoint/" + context + "/" + String(cpId), err);
    return undefined;
  }
}

function safeEnableSectorObjectiveById(
  sectorId: number,
  enabled: boolean,
  context: string,
  force: boolean = false
): void {
  if (!sectorId) return;
  if (!force && objectiveSurfaceSectorObjectiveEnabledBySectorId[sectorId] === enabled) return;
  try {
    mod.EnableGameModeObjective(mod.GetSector(sectorId), enabled);
    objectiveSurfaceSectorObjectiveEnabledBySectorId[sectorId] = enabled;
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "enable_sector/" + context + "/" + String(sectorId),
      mod.Message(
        "[OBJECTIVE ENGINE] EnableGameModeObjective failed sector/context/enabled {}",
        String(sectorId) + "/" + context + "/" + (enabled ? "1" : "0")
      )
    );
    LogRuntimeError("EnableGameModeObjectiveSector/" + context + "/" + String(sectorId), err);
  }
}

function safeEnableCapturePointObjectiveByCpId(
  cpId: number,
  enabled: boolean,
  context: string,
  force: boolean = false
): void {
  if (!force && objectiveCapturePointObjectiveEnabledByCpId[cpId] === enabled) return;
  const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "EnableGameModeObjective/" + context);
  if (!capturePoint) return;
  try {
    mod.EnableGameModeObjective(capturePoint, enabled);
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

function disableAllObjectiveCapturePointObjectives(context: string): void {
  disableAllScriptedObjectiveCapturePointSurfaces(context, true);
}

function isObjectiveCapturePointSurfaceActive(cpId: number): boolean {
  if (!isObjectiveCpId(cpId)) return false;
  if (!isObjectiveActiveForCurrentHalf(cpId)) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (isObjectivePendingAwardActive(cpId)) return false;
  return isCipherNodeActive(cpId);
}

function disableAllObjectiveSurfaceSectors(context: string, force: boolean = false): void {
  for (let i = 0; i < OBJECTIVE_SURFACE_SECTOR_IDS.length; i++) {
    safeEnableSectorObjectiveById(OBJECTIVE_SURFACE_SECTOR_IDS[i], false, context, force);
  }
}

function disableAllScriptedObjectiveCapturePointSurfaces(context: string, force: boolean = false): void {
  for (let i = 0; i < ALL_SCRIPTED_OBJECTIVE_CP_IDS.length; i++) {
    const cpId = ALL_SCRIPTED_OBJECTIVE_CP_IDS[i];
    const owner = getExpectedScriptObjectiveCapturePointOwner(cpId);
    applyObjectiveLockedCaptureTiming(cpId);
    setObjectiveAuthoritativeOwner(cpId, owner, context + "_owner");
    safeEnableCapturePointObjectiveByCpId(cpId, false, context + "_cp", force);
    ensureObjectiveEngineOwnerMatchesScript(cpId, context + "_cp");
  }
}

function applyScriptedObjectiveCapturePointSurface(
  cpId: number,
  owner: mod.Team,
  enabled: boolean,
  context: string,
  force: boolean = false
): void {
  applyObjectiveLockedCaptureTiming(cpId);
  setObjectiveAuthoritativeOwner(cpId, owner, context + "_owner");
  safeEnableCapturePointObjectiveByCpId(cpId, enabled, context + "_cp", force);
  ensureObjectiveEngineOwnerMatchesScript(cpId, context + "_cp");
}

type ObjectiveResolvedSurfaceLayer = {
  cpId: number;
  sectorId: number;
  owner: mod.Team;
};

function getActiveOwnedObjectiveSurfaceLayer(cpId: number): ObjectiveResolvedSurfaceLayer | undefined {
  const def = objectiveDefByCpId[cpId];
  if (!def) return undefined;

  return {
    cpId: def.cpId,
    sectorId: def.sectorId,
    owner: def.defendingTeam,
  };
}

function getDesiredObjectiveSurfaceLayer(cpId: number): ObjectiveResolvedSurfaceLayer | undefined {
  if (!isObjectiveCpId(cpId)) return undefined;
  if (isObjectiveCapturePointSurfaceActive(cpId)) {
    return getActiveOwnedObjectiveSurfaceLayer(cpId);
  }
  return undefined;
}

function getLogicalObjectiveCpIdForSurfaceCpId(cpId: number): number | undefined {
  return OBJECTIVE_LOGICAL_CP_ID_BY_SURFACE_CP_ID[cpId];
}

function setNeutralObjectiveCapturePointEnabledForActiveCp(
  activeCpId: number,
  enabled: boolean,
  context: string
): void {
  void activeCpId;
  void enabled;
  if (gameStatus === 0 || gameStatus === 2 || gameStatus === 3) {
    syncLiveHybridObjectiveSurfaceState(context + "_neutral_surface", true);
  }
}

function disableAllNeutralObjectiveCapturePointObjectives(context: string): void {
  void context;
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
  const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "SetCapturePointTiming/" + context);
  if (!capturePoint) return;
  try {
    mod.SetCapturePointCapturingTime(capturePoint, captureTime);
    mod.SetCapturePointNeutralizationTime(capturePoint, neutralizeTime);
    mod.SetMaxCaptureMultiplier(capturePoint, 1);
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
  if (enabled && isHardDisabledObjectiveMcomId(mcomId)) enabled = false;
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

function isHardDisabledObjectiveMcomId(mcomId: number): boolean {
  return HARD_DISABLED_OBJECTIVE_MCOM_IDS.indexOf(mcomId) >= 0;
}

function disableHardObjectiveMcoms(context: string): void {
  for (let i = 0; i < HARD_DISABLED_OBJECTIVE_MCOM_IDS.length; i++) {
    const mcomId = HARD_DISABLED_OBJECTIVE_MCOM_IDS[i];
    try {
      mod.EnableGameModeObjective(mod.GetMCOM(mcomId), false);
    } catch (err) {
      warnObjectiveEngineCallOnce(
        "hard_disable_mcom/" + context + "/" + String(mcomId),
        mod.Message("[OBJECTIVE ENGINE] hard-disable MCOM failed id/context {}", String(mcomId) + "/" + context)
      );
      LogRuntimeError("HardDisableObjectiveMCOM/" + context + "/" + String(mcomId), err);
    }
  }

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    if (def.mcomId !== undefined && isHardDisabledObjectiveMcomId(def.mcomId)) {
      objectiveMcomObjectiveEnabledByCpId[def.cpId] = false;
    }
  }
}

function warnHardObjectiveMcomMoveOnce(mcomId: number, context: string, reason: string, err?: unknown): void {
  const key = String(mcomId) + "/" + reason;
  if (hardObjectiveMcomMoveWarnedByKey[key] === true) return;
  hardObjectiveMcomMoveWarnedByKey[key] = true;
  if (err !== undefined) {
    LogRuntimeError("MoveHardObjectiveMCOM/" + context + "/" + String(mcomId) + "/" + reason, err);
    return;
  }
  warnObjectiveEngineCallOnce(
    "move_hard_mcom/" + context + "/" + String(mcomId) + "/" + reason,
    mod.Message("[OBJECTIVE ENGINE] move-down MCOM skipped id/context/reason {}", String(mcomId) + "/" + context + "/" + reason)
  );
}

function moveHardObjectiveMcomsBelowMapOnce(context: string): void {
  const delta = mod.CreateVector(0, HARD_DISABLED_OBJECTIVE_MCOM_DROP_Y, 0);

  for (let i = 0; i < HARD_DISABLED_OBJECTIVE_MCOM_IDS.length; i++) {
    const mcomId = HARD_DISABLED_OBJECTIVE_MCOM_IDS[i];
    if (hardObjectiveMcomMovedBelowMapById[mcomId] === true) continue;

    let mcomObject: mod.Object | undefined = undefined;
    try {
      mcomObject = mod.GetMCOM(mcomId) as unknown as mod.Object;
    } catch (err) {
      warnHardObjectiveMcomMoveOnce(mcomId, context, "missing", err);
      continue;
    }

    try {
      hardObjectiveMcomInitialPositionById[mcomId] = mod.GetObjectPosition(mcomObject);
      mod.MoveObject(mcomObject, delta);
      hardObjectiveMcomMovedBelowMapById[mcomId] = true;
    } catch (err) {
      warnHardObjectiveMcomMoveOnce(mcomId, context, "move_failed", err);
    }
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
  disableHardObjectiveMcoms(context + "_hard_disable");
}

function syncDisabledBombAnchorObjectives(): void {
  disableSectorObjectiveByIdSafe(BOMB_ANCHOR_SECTOR_ID);
}

function seedObjectiveNativeMcomState(context: string): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    safeSetObjectiveMcomFuseTimeByCpId(def.cpId, OBJECTIVE_SCORE_HOLD_SECONDS, context);
    safeSetObjectiveMcomOwnerByCpId(def.cpId, getObjectiveDefendingTeamForCurrentHalf(def.cpId), context);
  }
  disableHardObjectiveMcoms(context + "_hard_disable");
}

function safeSetObjectiveCapturePointOwnerByCpId(cpId: number, owner: mod.Team, context: string): void {
  const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "SetCapturePointOwner/" + context);
  if (!capturePoint) return;
  try {
    mod.SetCapturePointOwner(capturePoint, owner);
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "set_cp_owner/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] SetCapturePointOwner failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("SetCapturePointOwner/" + context + "/" + String(cpId), err);
  }
  const cp = serverCapturePoints[cpId];
  if (!cp) return;
  cp.setOwner(owner);
}

function setObjectiveAuthoritativeOwner(cpId: number, owner: mod.Team, context: string = "setObjectiveAuthoritativeOwner"): void {
  // Objective ownership is seeded during init/reset and stays static during live play.
  safeSetObjectiveCapturePointOwnerByCpId(cpId, owner, context);
}

function isScriptedObjectiveCapturePointId(cpId: number): boolean {
  return ALL_SCRIPTED_OBJECTIVE_CP_IDS.indexOf(cpId) >= 0;
}

function getExpectedScriptObjectiveCapturePointOwner(cpId: number): mod.Team {
  const def = objectiveDefByCpId[cpId];
  if (def) return def.defendingTeam;
  return teamNeutral;
}

function ensureObjectiveEngineOwnerMatchesScript(
  cpId: number,
  context: string = "ensureObjectiveEngineOwnerMatchesScript"
): boolean {
  const cp = serverCapturePoints[cpId];
  if (!isScriptedObjectiveCapturePointId(cpId)) return false;

  const scriptOwner =
    cp ? getObjectiveAuthoritativeOwner(cpId) : getExpectedScriptObjectiveCapturePointOwner(cpId);
  const capturePoint = resolveObjectiveCapturePointHandleByCpId(
    cpId,
    "GetCurrentOwnerTeam/" + context
  );
  if (!capturePoint) return false;
  let engineOwner: mod.Team;
  try {
    engineOwner = mod.GetCurrentOwnerTeam(capturePoint);
  } catch (err) {
    warnObjectiveEngineCallOnce(
      "get_cp_owner/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] GetCurrentOwnerTeam failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("GetCurrentOwnerTeam/" + context + "/" + String(cpId), err);
    return false;
  }

  if (mod.Equals(engineOwner, scriptOwner)) return false;

  warnObjectiveEngineCallOnce(
    "cp_owner_drift/" +
      context +
      "/" +
      String(cpId) +
      "/" +
      String(getDebugTeamId(engineOwner)) +
      "->" +
      String(getDebugTeamId(scriptOwner)),
    mod.Message(
      "[OBJECTIVE ENGINE] owner drift cp/expected/engine/half/context {}",
      String(cpId) +
        "/" +
        String(getDebugTeamId(scriptOwner)) +
        "/" +
        String(getDebugTeamId(engineOwner)) +
        "/" +
        String(cipherCurrentHalf) +
        "/" +
        context
    )
  );
  safeSetObjectiveCapturePointOwnerByCpId(cpId, scriptOwner, "ensureObjectiveEngineOwnerMatchesScript/" + context);
  return true;
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

function resetCipherNodeStates(context: string): void {
  const nextTokenByCpId: { [cpId: number]: number | undefined } = {};
  cipherNodeStateByCpId = {};
  cipherNodeRebootUntilSecByCpId = {};
  cipherNodeOverloadedByTeamByCpId = {};
  disableAllNeutralObjectiveCapturePointObjectives("resetCipherNodeStates/" + context);

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    cipherNodeStateByCpId[cpId] = "active";
    nextTokenByCpId[cpId] = (cipherNodeRebootTokenByCpId[cpId] ?? 0) + 1;
    cipherNodeOverloadedByTeamByCpId[cpId] = teamNeutral;
  }

  cipherNodeRebootTokenByCpId = nextTokenByCpId;
  cipherCounterWorldIconLastShownByCpId = {};
  cipherCounterWorldIconLastStateByCpId = {};

  if (gameStatus === 3) {
    updateCipherCounterWorldIcons(true);
    UpdateTopFlagColorsForAllPlayers();
  }
}

function clearAllCipherNodeRebootState(
  reason: string,
  hideCounterIcons: boolean = true,
  refreshLiveIcons: boolean = false
): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    cipherNodeStateByCpId[cpId] = "active";
    cipherNodeRebootUntilSecByCpId[cpId] = undefined;
    cipherNodeRebootTokenByCpId[cpId] = (cipherNodeRebootTokenByCpId[cpId] ?? 0) + 1;
    cipherNodeOverloadedByTeamByCpId[cpId] = teamNeutral;
    objectivePendingAwardStartTickByCpId[cpId] = undefined;
    objectivePendingAwardStartAtSecByCpId[cpId] = undefined;
    objectivePendingAwardDeadlineAtSecByCpId[cpId] = undefined;
    objectivePendingAwardTeamByCpId[cpId] = teamNeutral;
    objectivePendingAwardTokenByCpId[cpId] = undefined;
    clearObjectiveDestroyExplosionPosition(cpId);
    clearObjectiveSuccessfulArmContext(cpId);
    setObjectiveAwardVfxEnabled(cpId, false);
    stopObjectiveMcomAttemptLoopSfxForCp(cpId);
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", false);
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", false);
  }

  cipherCounterWorldIconLastShownByCpId = {};
  cipherCounterWorldIconLastStateByCpId = {};
  HideAllDeployObjectiveTimerUi();

  if (hideCounterIcons) {
    hideAllCipherCounterWorldIcons();
  }

  if (refreshLiveIcons && gameStatus === 3 && !isCipherLiveTransitionActive()) {
    updateCipherCounterWorldIcons(true);
    UpdateTopFlagColorsForAllPlayers();
  }

  cipherTransitionLastCheckpoint = "node_cleanup/" + reason;
}

function isCipherNodeActive(cpId: number): boolean {
  const state = cipherNodeStateByCpId[cpId];
  return state === undefined || state === "active";
}

function isCipherNodeRebooting(cpId: number): boolean {
  return cipherNodeStateByCpId[cpId] === "rebooting";
}

function getCipherNodeRebootRemainingSeconds(cpId: number): number {
  if (!isCipherNodeRebooting(cpId)) return 0;
  const rebootUntilSec = cipherNodeRebootUntilSecByCpId[cpId];
  if (rebootUntilSec === undefined || !Number.isFinite(rebootUntilSec)) return 0;
  return mod.Max(0, mod.Ceiling(rebootUntilSec - getCurrentSchedulerNowSeconds()));
}

function showCipherNodeRebootingDeniedMessage(playerId: number, cpId: number): void {
  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;

  const cp = serverCapturePoints[cpId];
  const symbol = getObjectiveLaneSymbol(cpId, cp ? cp.symbol : "A");
  modlib.ShowHighlightedGameModeMessage(
    mod.Message((mod.stringkeys as any).CipherNodeCannotScoreRebooting, symbol),
    sp.player
  );
}

function startCipherNodeReboot(cpId: number, attackingTeam: mod.Team, context: string): void {
  if (!isObjectiveCpId(cpId)) return;
  if (mod.Equals(attackingTeam, teamNeutral)) return;

  captureObjectiveDestroyExplosionPositionForCp(cpId);
  cipherNodeStateByCpId[cpId] = "rebooting";
  cipherNodeRebootUntilSecByCpId[cpId] = getCurrentSchedulerNowSeconds() + NODE_OVERLOAD_COOLDOWN_SECONDS;
  cipherNodeOverloadedByTeamByCpId[cpId] = attackingTeam;
  const token = (cipherNodeRebootTokenByCpId[cpId] ?? 0) + 1;
  cipherNodeRebootTokenByCpId[cpId] = token;

  const cp = serverCapturePoints[cpId];
  if (cp) {
    (cp as any)._capturingTeam = teamNeutral;
    (cp as any)._captureProgress = 0;
    (cp as any)._previousCaptureProgress = 0;
    cp.clearOnPoint();
  }

  if (isObjectiveCaptureAttemptActive(cpId)) endObjectiveCaptureAttempt(cpId);
  safeEnableCapturePointObjectiveByCpId(cpId, false, "startCipherNodeReboot/" + context, true);
  safeEnableObjectiveMcomByCpId(cpId, false, "startCipherNodeReboot/" + context, true);
  setObjectiveCaptureInteractEnabled(cpId, false);
  setObjectiveAwardVfxEnabled(cpId, false);
  stopObjectiveMcomAttemptLoopSfxForCp(cpId);
  setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", false);
  setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", false);
  setObjectiveAuthoritativeOwner(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    "startCipherNodeReboot/" + context
  );
  playObjectiveDisableEmpPresentationForCp(cpId, attackingTeam);
  playObjectiveAwardSuccessSfxToAll();

  const symbol = getObjectiveLaneSymbol(cpId, cp ? cp.symbol : "A");
  if (modlib.Equals(attackingTeam, team1)) {
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabled, symbol),
      team1
    );
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabledEnemy, symbol),
      team2
    );
  } else if (modlib.Equals(attackingTeam, team2)) {
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabled, symbol),
      team2
    );
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabledEnemy, symbol),
      team1
    );
  }

  clearObjectivePendingAward(cpId);
  clearObjectiveSuccessfulArmContext(cpId);
  clearBotObjectiveAssignments();
  updateCipherCounterWorldIconForCp(cpId, true);
  if (isRoutingCpId(cpId)) markHqRoutingDirty();
  syncLiveHybridObjectiveSurfaceState("startCipherNodeReboot/" + context, true);
  scheduleDelayedObjectiveSurfaceReassert("startCipherNodeReboot/" + context);
  UpdateTopFlagColorsForAllPlayers();

  void reactivateCipherNode(cpId, token, context);
}

async function reactivateCipherNode(cpId: number, token: number, context: string): Promise<void> {
  await mod.Wait(NODE_OVERLOAD_COOLDOWN_SECONDS);
  if (gameStatus !== 3) return;
  if (cipherNodeRebootTokenByCpId[cpId] !== token) return;
  if (!isCipherNodeRebooting(cpId)) return;
  if (!isObjectiveActiveForCurrentHalf(cpId)) {
    cipherNodeStateByCpId[cpId] = "active";
    cipherNodeRebootUntilSecByCpId[cpId] = undefined;
    cipherNodeOverloadedByTeamByCpId[cpId] = teamNeutral;
    updateCipherCounterWorldIconForCp(cpId, true);
    return;
  }

  cipherNodeStateByCpId[cpId] = "active";
  cipherNodeRebootUntilSecByCpId[cpId] = undefined;
  cipherNodeOverloadedByTeamByCpId[cpId] = teamNeutral;
  setObjectiveAuthoritativeOwner(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    "reactivateCipherNode/" + context
  );
  setNeutralObjectiveCapturePointEnabledForActiveCp(cpId, false, "reactivateCipherNode/" + context);
  clearObjectivePendingAward(cpId);
  setObjectiveAwardVfxEnabled(cpId, false);
  syncObjectiveArmedPendingVisualStateForCp(cpId);
  syncLiveHybridObjectiveSurfaceState("reactivateCipherNode/" + context, true);
  scheduleDelayedObjectiveSurfaceReassert("reactivateCipherNode/" + context);
  updateCipherCounterWorldIconForCp(cpId, true);

  const cp = serverCapturePoints[cpId];
  const symbol = getObjectiveLaneSymbol(cpId, cp ? cp.symbol : "A");
  modlib.ShowHighlightedGameModeMessage(mod.Message((mod.stringkeys as any).CipherNodeRebooted, symbol), team1);
  modlib.ShowHighlightedGameModeMessage(mod.Message((mod.stringkeys as any).CipherNodeRebooted, symbol), team2);

  if (isRoutingCpId(cpId)) markHqRoutingDirty();
  UpdateTopFlagColorsForAllPlayers();
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
  if (!isObjectiveActiveForCurrentHalf(cpId)) return false;

  const sp = serverPlayers.get(playerId);
  if (sp) {
    const activeCapturePoint = sp.getCapturePoint();
    if (activeCapturePoint) {
      try {
        if (mod.GetObjId(activeCapturePoint) === cpId) return true;
      } catch (_err) {}
    }
  }

  const cp = serverCapturePoints[cpId];
  if (cp && cp.getPlayerIdsOnPoint().indexOf(playerId) >= 0) return true;

  const triggerId = OBJECTIVE_AREA_TRIGGER_ID_BY_CP_ID[cpId];
  if (!(triggerId > 0)) return false;

  const active = objectiveAreaActiveTriggersByPlayerId[playerId];
  if (!active) return false;

  if (active[triggerId] !== true) return false;
  const resolvedCpId = resolveCurrentHalfObjectiveCpIdFromAreaTrigger(triggerId);
  return resolvedCpId === cpId;
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
  if (!isObjectiveActiveForCurrentHalf(cpId)) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (!isCipherNodeActive(cpId)) return false;
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
  if (!isObjectiveActiveForCurrentHalf(cpId)) return false;
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
  ensureObjectiveEngineOwnerMatchesScript(cpId, "updateObjectiveCaptureInteractionForCp");

  if (isObjectiveDisabledAfterAward(cpId) || !isCipherNodeActive(cpId) || isObjectiveCaptureAttemptActive(cpId)) {
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

type ObjectiveDesiredSurfaceLayer = {
  layer: ObjectiveResolvedSurfaceLayer;
};

function buildDesiredLiveHybridObjectiveSurfaceLayers(
  context: string,
  force: boolean = false
): ObjectiveDesiredSurfaceLayer[] {
  const desiredLayers: ObjectiveDesiredSurfaceLayer[] = [];

  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (!isObjectiveCpId(cpId)) continue;

    safeEnableObjectiveMcomByCpId(cpId, false, "syncLiveHybridObjectiveSurfaceState/" + context, force);

    const desiredLayer = getDesiredObjectiveSurfaceLayer(cpId);
    if (!desiredLayer) continue;

    desiredLayers.push({
      layer: desiredLayer,
    });
  }

  return desiredLayers;
}

function applyDesiredLiveHybridObjectiveSurfaceLayer(
  desired: ObjectiveDesiredSurfaceLayer,
  context: string,
  force: boolean = false
): void {
  const desiredLayer = desired.layer;

  // Match the KOTH objective-layer pattern: sector first, then the CP and owner that belong to it.
  safeEnableSectorObjectiveById(
    desiredLayer.sectorId,
    true,
    "syncLiveHybridObjectiveSurfaceState/" + context + "_sector_" + String(desiredLayer.sectorId),
    force
  );
  applyScriptedObjectiveCapturePointSurface(
    desiredLayer.cpId,
    desiredLayer.owner,
    true,
    "syncLiveHybridObjectiveSurfaceState/" + context + "_surface_" + String(desiredLayer.cpId),
    force
  );
}

function reapplyLiveHybridObjectiveSurfaceStateForCp(cpId: number, context: string): void {
  if (gameStatus !== 0 && gameStatus !== 2 && gameStatus !== 3) return;
  void cpId;
  syncLiveHybridObjectiveSurfaceState("reapplyLiveHybridObjectiveSurfaceStateForCp/" + context, true);
  updateObjectiveCaptureInteractionForCp(cpId);
}

function syncLiveHybridObjectiveSurfaceState(context: string, force: boolean = false): void {
  if (gameStatus !== 0 && gameStatus !== 2 && gameStatus !== 3) return;
  if (objectiveSurfaceSyncInProgress) {
    objectiveSurfaceSyncQueued = true;
    return;
  }

  objectiveSurfaceSyncInProgress = true;

  try {
    let pass = 0;
    do {
      objectiveSurfaceSyncQueued = false;
      syncLiveHybridObjectiveSurfaceStatePass(pass === 0 ? context : context + "_queued_" + String(pass), force || pass > 0);
      pass++;
    } while ((gameStatus === 0 || gameStatus === 2 || gameStatus === 3) && objectiveSurfaceSyncQueued && pass < 2);

    objectiveSurfaceSyncQueued = false;
  } finally {
    objectiveSurfaceSyncInProgress = false;
  }
}

function syncLiveHybridObjectiveSurfaceStatePass(context: string, force: boolean = false): void {
  if (gameStatus !== 0 && gameStatus !== 2 && gameStatus !== 3) return;

  const desiredLayers = buildDesiredLiveHybridObjectiveSurfaceLayers(context, force);
  const desiredCpEnabledById: { [cpId: number]: boolean | undefined } = {};
  const desiredSectorEnabledById: { [sectorId: number]: boolean | undefined } = {};

  disableAllObjectiveSurfaceSectors("syncLiveHybridObjectiveSurfaceState/" + context + "_clear_sectors", true);
  disableAllScriptedObjectiveCapturePointSurfaces(
    "syncLiveHybridObjectiveSurfaceState/" + context + "_clear_cps",
    true
  );

  for (let i = 0; i < desiredLayers.length; i++) {
    const desiredLayer = desiredLayers[i].layer;
    desiredCpEnabledById[desiredLayer.cpId] = true;
    desiredSectorEnabledById[desiredLayer.sectorId] = true;
  }

  for (let i = 0; i < desiredLayers.length; i++) {
    applyDesiredLiveHybridObjectiveSurfaceLayer(desiredLayers[i], context, force);
  }

  for (let i = 0; i < ALL_SCRIPTED_OBJECTIVE_CP_IDS.length; i++) {
    const cpId = ALL_SCRIPTED_OBJECTIVE_CP_IDS[i];
    if (desiredCpEnabledById[cpId] === true) continue;
    applyScriptedObjectiveCapturePointSurface(
      cpId,
      getExpectedScriptObjectiveCapturePointOwner(cpId),
      false,
      "syncLiveHybridObjectiveSurfaceState/" + context + "_final_disabled",
      true
    );
  }

  for (let i = 0; i < OBJECTIVE_SURFACE_SECTOR_IDS.length; i++) {
    const sectorId = OBJECTIVE_SURFACE_SECTOR_IDS[i];
    if (desiredSectorEnabledById[sectorId] === true) continue;
    safeEnableSectorObjectiveById(
      sectorId,
      false,
      "syncLiveHybridObjectiveSurfaceState/" + context + "_final_sector_disabled",
      true
    );
  }

  disableHardObjectiveMcoms("syncLiveHybridObjectiveSurfaceState/" + context);
  UpdateObjectiveCaptureInteractionState();
}

async function reassertObjectiveSurfaceAfterDelay(context: string, delaySeconds: number): Promise<void> {
  await mod.Wait(delaySeconds);
  if (gameStatus !== 0 && gameStatus !== 2 && gameStatus !== 3) return;
  syncLiveHybridObjectiveSurfaceState("delayed_reassert/" + context + "/" + String(delaySeconds), true);
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
  if (ENABLE_DYNAMIC_HQ_ROUTING) markHqRoutingDirty();
}

function scheduleDelayedObjectiveSurfaceReassert(context: string): void {
  void reassertObjectiveSurfaceAfterDelay(context, 0.2);
  void reassertObjectiveSurfaceAfterDelay(context, 0.8);
}

function getObjectiveAwardIndexByCpId(cpId: number): number {
  return OBJECTIVE_AWARD_CP_IDS.indexOf(cpId);
}

function getObjectiveAwardAnchorIdByCpId(cpId: number): number | undefined {
  const vfxId = OBJECTIVE_AWARD_VFX_ID_BY_CP_ID[cpId];
  return vfxId > 0 ? vfxId : undefined;
}

function getObjectiveAwardVfxByCpId(cpId: number): mod.VFX | undefined {
  const vfxId = OBJECTIVE_AWARD_VFX_ID_BY_CP_ID[cpId];
  if (!(vfxId > 0)) return undefined;
  return mod.GetVFX(vfxId);
}

function getObjectivePersistentFireVfxByCpId(cpId: number): mod.VFX[] {
  const result: mod.VFX[] = [];
  const primaryVfxId = OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_ID_BY_CP_ID[cpId];
  const secondaryVfxId = OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_VFX_ID_BY_CP_ID[cpId];

  if (primaryVfxId > 0) {
    result.push(mod.GetVFX(primaryVfxId));
  } else {
    warnObjectiveAwardPersistentFireMissingOnce(cpId, OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_NAME);
  }

  if (secondaryVfxId > 0) {
    result.push(mod.GetVFX(secondaryVfxId));
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

function getCipherNodeRebootingWorldIconMessage(totalSeconds: number): any {
  let safeSeconds = totalSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds < 0) safeSeconds = 0;
  safeSeconds = mod.Floor(safeSeconds);
  const minutes = mod.Floor(safeSeconds / 60);
  const totalSecondsRemainder = mod.Floor(safeSeconds % 60);
  const seconds1 = totalSecondsRemainder % 10;
  const seconds10 = mod.Floor(totalSecondsRemainder / 10);
  if (minutes < 10) {
    return mod.Message(
      (mod.stringkeys as any).CipherNodeRebootingSecondsSingleDigitMinute,
      minutes,
      seconds10,
      seconds1
    );
  }
  return mod.Message(
    (mod.stringkeys as any).CipherNodeRebootingSecondsDoubleDigitMinute,
    minutes,
    seconds10,
    seconds1
  );
}

function getCipherNodeStatusWorldIconMessage(cpId: number): any {
  if (isCipherNodeRebooting(cpId)) {
    return getCipherNodeRebootingWorldIconMessage(getCipherNodeRebootRemainingSeconds(cpId));
  }
  return mod.Message((mod.stringkeys as any).CipherNodeActive);
}

function getCipherCounterRuntimeIconKey(cpId: number, ownerTeam: mod.Team): string {
  return String(cpId) + ":" + String(modlib.getTeamId(ownerTeam));
}

function getCipherCounterAnchorPositionForCp(cpId: number): mod.Vector | undefined {
  const snapshot = getCachedObjectiveAnchorPositionSnapshot(cpId);
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
  delete cipherCounterWorldIconLastStateByCpId[cpId];
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
  cipherCounterWorldIconLastStateByCpId = {};
}

function hasCipherCounterRuntimeWorldIconForTeam(cpId: number, ownerTeam: mod.Team): boolean {
  if (mod.Equals(ownerTeam, teamNeutral)) return false;
  const key = getCipherCounterRuntimeIconKey(cpId, ownerTeam);
  return !!cipherCounterRuntimeWorldIconHandleByKey[key];
}

function getCipherCounterWorldIconStateKey(
  cpId: number,
  team1Color: mod.Vector,
  team2Color: mod.Vector
): string {
  return (
    String(cpId) +
    ":" +
    String(cipherCurrentHalf) +
    ":" +
    String(cipherNodeStateByCpId[cpId] ?? "active") +
    ":" +
    String(getCipherNodeRebootRemainingSeconds(cpId)) +
    ":" +
    String(getVectorStateKey(team1Color)) +
    ":" +
    String(getVectorStateKey(team2Color)) +
    ":" +
    String(gameStatus)
  );
}

function getVectorStateKey(value: mod.Vector): string {
  return (
    String(mod.XComponentOf(value)) +
    "," +
    String(mod.YComponentOf(value)) +
    "," +
    String(mod.ZComponentOf(value))
  );
}

function getCipherCounterIconColorForViewer(cpId: number, viewerTeam: mod.Team): mod.Vector {
  if (isCipherNodeRebooting(cpId)) return COLOR_NEUTRAL;
  const defendingTeam = getObjectiveDefendingTeamForCurrentHalf(cpId);
  return mod.Equals(viewerTeam, defendingTeam) ? COLOR_FRIENDLY : COLOR_ENEMY;
}

function configureCipherCounterRuntimeWorldIcon(
  cpId: number,
  ownerTeam: mod.Team,
  textColor: mod.Vector,
  force: boolean
): void {
  if (mod.Equals(ownerTeam, teamNeutral)) return;

  const key = getCipherCounterRuntimeIconKey(cpId, ownerTeam);
  const stateKey =
    String(cipherNodeStateByCpId[cpId] ?? "active") +
    ":" +
    String(getCipherNodeRebootRemainingSeconds(cpId)) +
    ":" +
    String(modlib.getTeamId(ownerTeam));
  let handle = cipherCounterRuntimeWorldIconHandleByKey[key];
  if (!force && handle && cipherCounterRuntimeWorldIconLastStateByKey[key] === stateKey) {
    return;
  }

  const pos = getCipherCounterAnchorPositionForCp(cpId);
  if (!pos) {
    warnCipherCounterRuntimeIconMissingOnce(key, cpId, "missing_position");
    return;
  }

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

  if (force || cipherCounterRuntimeWorldIconLastStateByKey[key] !== stateKey) {
    try {
      mod.SetWorldIconText(handle, getCipherNodeStatusWorldIconMessage(cpId));
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
    delete cipherCounterWorldIconLastStateByCpId[cpId];
    return;
  }

  const enabled = gameStatus === 3;
  const activeForHalf = isObjectiveActiveForCurrentHalf(cpId);
  const team1IconColor = getCipherCounterIconColorForViewer(cpId, team1);
  const team2IconColor = getCipherCounterIconColorForViewer(cpId, team2);
  const stateKey = getCipherCounterWorldIconStateKey(cpId, team1IconColor, team2IconColor);

  if (
    !force &&
    enabled &&
    activeForHalf &&
    cipherCounterWorldIconLastStateByCpId[cpId] === stateKey &&
    hasCipherCounterRuntimeWorldIconForTeam(cpId, team1) &&
    hasCipherCounterRuntimeWorldIconForTeam(cpId, team2)
  ) {
    return;
  }

  try {
    const icon = mod.GetWorldIcon(iconId);
    mod.EnableWorldIconImage(icon, false);
    mod.EnableWorldIconText(icon, false);
  } catch (_err) {
    warnObjectiveArmedWorldIconMissingOnce(cpId, iconId);
  }

  if (!enabled || !activeForHalf) {
    delete cipherCounterWorldIconLastShownByCpId[cpId];
    delete cipherCounterWorldIconLastStateByCpId[cpId];
    clearCipherCounterRuntimeWorldIconsForCp(cpId);
    return;
  }

  configureCipherCounterRuntimeWorldIcon(cpId, team1, team1IconColor, force);
  configureCipherCounterRuntimeWorldIcon(cpId, team2, team2IconColor, force);
  cipherCounterWorldIconLastShownByCpId[cpId] = stateKey;
  cipherCounterWorldIconLastStateByCpId[cpId] = stateKey;
}

function updateCipherCounterWorldIcons(force: boolean = false): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    if (def.half !== cipherCurrentHalf) {
      clearCipherCounterRuntimeWorldIconsForCp(def.cpId);
      delete cipherCounterWorldIconLastShownByCpId[def.cpId];
      delete cipherCounterWorldIconLastStateByCpId[def.cpId];
      continue;
    }
    updateCipherCounterWorldIconForCp(def.cpId, force);
  }
}

function hideAllCipherCounterWorldIcons(): void {
  clearAllCipherCounterRuntimeWorldIcons();
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const iconId = getObjectiveArmedWorldIconIdByCpId(cpId);
    delete cipherCounterWorldIconLastShownByCpId[cpId];
    delete cipherCounterWorldIconLastStateByCpId[cpId];
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
  resetCipherNodeStates("resetCipherObjectiveCounters");
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

  if (isCipherNodeRebooting(cpId)) {
    safeEnableCapturePointObjectiveByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_rebooting");
    safeEnableObjectiveMcomByCpId(cpId, false, "syncObjectiveArmedPendingVisualStateForCp_rebooting");
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
    return getObjectiveAnchorPosition(cpId);
  }

  try {
    const vfxAnchor = mod.GetVFX(anchorId) as unknown as mod.Object;
    return mod.GetObjectPosition(vfxAnchor);
  } catch (_err) {}

  try {
    const spatialAnchor = mod.GetSpatialObject(anchorId) as unknown as mod.Object;
    return mod.GetObjectPosition(spatialAnchor);
  } catch (_err) {}

  const mcomPos = tryGetObjectiveMcomPosition(cpId);
  if (mcomPos) return mcomPos;

  warnObjectiveAwardAnchorMissingOnce(cpId, anchorId);
  return getObjectiveAnchorPosition(cpId);
}

function spawnObjectiveAwardRuntimeFxAtPosition(
  asset: mod.RuntimeSpawn_Common,
  pos: mod.Vector
): mod.VFX | mod.Object | undefined {
  let spawned: any = undefined;
  try {
    spawned = mod.SpawnObject(asset, pos, OBJECTIVE_AWARD_BURST_ROTATION);
  } catch (_err) {
    return undefined;
  }

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

async function cleanupObjectiveAwardBurstAfterDelay(
  cpId: number,
  token: number,
  delaySeconds: number = OBJECTIVE_AWARD_BURST_LIFETIME_SECONDS
): Promise<void> {
  await mod.Wait(delaySeconds);
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

function spawnObjectiveDisableFxOneShot(asset: mod.RuntimeSpawn_Common, pos: mod.Vector, lifetimeSeconds: number): void {
  const spawned = spawnObjectiveAwardRuntimeFxAtPosition(asset, pos);
  if (!spawned) return;
  void cleanupRuntimeFxAfterDelay(spawned, lifetimeSeconds);
}

function playObjectiveDisableEmpPresentationForCp(cpId: number, ownerTeam: mod.Team): void {
  if (mod.Equals(ownerTeam, teamNeutral)) return;

  const pos = tryResolveObjectiveDestroyExplosionPosition(cpId);
  if (!pos) return;

  stopObjectiveAwardBurstForCp(cpId);
  stopObjectiveAwardPersistentFireForCp(cpId);
  setObjectiveAwardVfxEnabled(cpId, false);

  spawnObjectiveDisableFxOneShot(OBJECTIVE_DISABLE_EMP_HIT_ASSET, pos, 2.5);
  spawnObjectiveDisableFxOneShot(OBJECTIVE_DISABLE_SPARK_START_ASSET, pos, 2.5);

  const token = (objectiveAwardBurstTokenByCpId[cpId] ?? 0) + 1;
  objectiveAwardBurstTokenByCpId[cpId] = token;
  const sparkLoop = spawnObjectiveAwardRuntimeFxAtPosition(OBJECTIVE_DISABLE_SPARK_LOOP_ASSET, pos);
  if (sparkLoop) {
    objectiveAwardBurstActiveByCpId[cpId] = sparkLoop;
    void cleanupObjectiveAwardBurstAfterDelay(cpId, token, OBJECTIVE_DISABLE_SPARK_LOOP_LIFETIME_SECONDS);
  }

  playRuntimeOneShotSfxAtPosition(
    OBJECTIVE_DISABLE_3D_SFX_ASSET,
    pos,
    OBJECTIVE_MCOM_SFX_VOLUME,
    OBJECTIVE_MCOM_SFX_ATTENUATION_RANGE,
    3.0,
    "objective_disable_emp_sfx"
  );
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
  setObjectiveAwardVfxEnabled(cpId, false);
  stopObjectiveMcomAttemptLoopSfxForCp(cpId);
  setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", false);
  setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", false);
  playObjectiveDisableEmpPresentationForCp(cpId, ownerTeam);
  clearObjectivePendingAward(cpId);
  setObjectiveAuthoritativeOwner(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    "disableObjectiveAfterAwardSuccess"
  );
  clearObjectiveSuccessfulArmContext(cpId);
  clearBotObjectiveAssignments();

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
  objectiveSurfaceSectorObjectiveEnabledBySectorId = {};
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
  // Cipher-key delivery disables MCOMs immediately on the second key.
  // Keep the old pending-award lane dormant so no 00:45 armed countdown or alarm is reintroduced.
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

  clearObjectivePendingAward(cpId);
  syncLiveHybridObjectiveSurfaceState("completeObjectiveDestroyPresentationAfterDelay", true);
  updateCipherCounterWorldIconForCp(cpId, true);
  logObjectiveDelayedAward(
    mod.Message("[OBJECTIVE AWARD] timed pending cleared cp/token {}", String(cpId) + "/" + String(token))
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
  clearBotObjectiveAssignments();
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

type CipherDeliveryOutcome = "continue" | "halftime" | "suddenDeath" | "postmatch";

function resolveCipherDeliveryOutcome(scoringTeam: mod.Team): CipherDeliveryOutcome {
  if (mod.Equals(scoringTeam, teamNeutral)) return "continue";
  if (cipherMatchStage === "suddenDeath") return "postmatch";
  if (getCipherTeamTotalScore(scoringTeam) >= WIN_SCORE) return "postmatch";
  if (cipherMatchStage !== "half1") return "continue";

  const scoreIndex = getCipherTeamScoreIndex(scoringTeam);
  if (scoreIndex < 0) return "continue";
  return cipherHalfScores[scoreIndex] >= HALF_SCORE_CAP ? "halftime" : "continue";
}

function beginCipherDeliveryPhaseTransition(outcome: CipherDeliveryOutcome, scoringTeam: mod.Team): void {
  if (outcome === "continue") return;

  invalidateDeferredBombSpawnTimer();
  HideAllObjectiveHoldProgressUi();
  HideAllDeployObjectiveTimerUi();
  clearBombNoticeState();
  clearAllCipherNodeRebootState("delivery_" + outcome, true);
  finalizePendingObjectiveAwardsForImmediateTransition("cipher_delivery_" + outcome);

  if (outcome === "halftime") {
    beginCipherSecondHalf(getCurrentSchedulerNowSeconds(), "scoreCap");
    return;
  }

  if (outcome === "suddenDeath") {
    beginCipherSuddenDeath(getCurrentSchedulerNowSeconds());
    return;
  }

  if (cipherMatchStage === "suddenDeath") {
    scheduleCipherSuddenDeathPostmatch(scoringTeam, "delivery_phase_transition");
    return;
  }

  enterPostmatchFromLive(scoringTeam);
}

function finalizePendingObjectiveAwardsForImmediateTransition(context: string): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (!isObjectivePendingAwardActive(cpId)) continue;
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmSimple", false);
    setObjectiveMcomSfxEnabledForCp(cpId, "alarmLeadout", false);
    clearObjectivePendingAward(cpId);
    logObjectiveDelayedAward(
      mod.Message("[OBJECTIVE AWARD] immediate transition clear cp/context {}", String(cpId) + "/" + context)
    );
  }
}

function handleCipherKeyDelivery(cpId: number, carrierPlayerId: number | undefined, attackingTeam: mod.Team): void {
  if (gameStatus !== 3) return;
  if (isObjectiveDisabledAfterAward(cpId)) return;
  if (!isCipherNodeActive(cpId)) {
    if (carrierPlayerId !== undefined) showCipherNodeRebootingDeniedMessage(carrierPlayerId, cpId);
    return;
  }
  if (mod.Equals(attackingTeam, teamNeutral)) return;

  const cp = serverCapturePoints[cpId];
  if (!cp) return;

  const symbol = getObjectiveLaneSymbol(cpId, cp.symbol);
  const deliveryPlayer = carrierPlayerId !== undefined ? serverPlayers.get(carrierPlayerId) : undefined;

  if (carrierPlayerId !== undefined) {
    recordObjectiveSuccessfulArmContext(cpId, carrierPlayerId);
  }
  addCipherScore(attackingTeam);
  const deliveryOutcome = resolveCipherDeliveryOutcome(attackingTeam);

  if (deliveryPlayer) {
    deliveryPlayer.addScore(150);
    deliveryPlayer.addDestroyed();
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
  UpdateScoreboard();
  SetUIScores();

  if (deliveryOutcome === "continue") {
    startCipherNodeReboot(cpId, attackingTeam, "handleCipherKeyDelivery");
    updateCipherCounterWorldIconForCp(cpId, true);
    scheduleDeferredBombRespawnAfterDelay(
      CIPHER_KEY_DELIVERY_RESPAWN_DELAY_SECONDS,
      "cipher_key_delivered_cp_" + String(cpId),
      "new_location_found",
      true,
      "player_biased",
      true
    );
    syncLiveHybridObjectiveSurfaceState("handleCipherKeyDelivery", true);
    scheduleDelayedObjectiveSurfaceReassert("handleCipherKeyDelivery");
  } else {
    beginCipherDeliveryPhaseTransition(deliveryOutcome, attackingTeam);
  }

  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

function tryDeliverCipherKeyForCarrierAtObjective(playerId: number, cpId: number): boolean {
  if (gameStatus !== 3) return false;
  if (bombCarrierPlayerId !== playerId) return false;
  if (!isObjectiveActiveForCurrentHalf(cpId)) return false;
  if (isObjectiveDisabledAfterAward(cpId)) return false;
  if (isCipherNodeRebooting(cpId)) {
    showCipherNodeRebootingDeniedMessage(playerId, cpId);
    return false;
  }
  if (!isCipherNodeActive(cpId)) return false;
  if (!isPlayerInsideObjectiveAreaForCp(playerId, cpId)) return false;

  const attackingTeam = getCipherCarrierAttackingTeam(playerId);
  if (mod.Equals(attackingTeam, teamNeutral)) return false;
  if (mod.Equals(attackingTeam, getObjectiveDefendingTeamForCurrentHalf(cpId))) return false;

  handleCipherKeyDelivery(cpId, playerId, attackingTeam);
  return true;
}

function tryDeliverCipherKeyFromAreaTrigger(playerId: number, triggerId: number): boolean {
  const cpId = resolveCurrentHalfObjectiveCpIdFromAreaTrigger(triggerId);
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
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabled, symbol),
      team1
    );
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabledEnemy, symbol),
      team2
    );
  } else if (modlib.Equals(ownerTeam, team2)) {
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabled, symbol),
      team2
    );
    modlib.ShowHighlightedGameModeMessage(
      mod.Message((mod.stringkeys as any).CipherObjectiveDisabledEnemy, symbol),
      team1
    );
  }

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
  const cpId = getActiveObjectiveCpIdForLane(lane);
  return mod.Equals(getObjectiveDefendingTeamForCurrentHalf(cpId), team1);
}

function getHudSlotDisplayLane(lane: TopHudLane): ObjectiveLetter {
  return lane;
}

function getObjectiveCpIdForCurrentDefenderAndDisplayLane(
  defendingTeam: mod.Team,
  displayLane: ObjectiveLetter
): number | undefined {
  if (!mod.Equals(defendingTeam, team1) && !mod.Equals(defendingTeam, team2)) return undefined;

  for (let i = 0; i < ALL_OBJECTIVE_CP_IDS.length; i++) {
    const cpId = ALL_OBJECTIVE_CP_IDS[i];
    if (!mod.Equals(getObjectiveDefendingTeamForCurrentHalf(cpId), defendingTeam)) continue;
    if (getObjectiveDisplayLaneForCpId(cpId) !== displayLane) continue;
    return cpId;
  }

  return undefined;
}

function getHudCpIdForViewerLane(viewerTeam: mod.Team, lane: TopHudLane): number {
  void viewerTeam;
  const cpId = getActiveObjectiveCpIdForLane(lane);
  return cpId > 0 ? cpId : CP_A_ID;
}

function getHudDisplayLetterForViewerLane(viewerTeam: mod.Team, lane: TopHudLane): ObjectiveLetter {
  void viewerTeam;
  return lane;
}

function getHudColorForViewerLane(viewerTeam: mod.Team, lane: TopHudLane): mod.Vector {
  const cpId = getHudCpIdForViewerLane(viewerTeam, lane);
  const owner = getObjectiveDefendingTeamForCurrentHalf(cpId);
  if (mod.Equals(owner, teamNeutral)) return COLOR_NEUTRAL;
  if (mod.Equals(owner, viewerTeam)) return COLOR_FRIENDLY;
  return COLOR_ENEMY;
}

function getObjectiveLaneBaseColor(lane: ObjectiveLetter): mod.Vector {
  const cpId = getActiveObjectiveCpIdForLane(lane);
  const owner = getObjectiveDefendingTeamForCurrentHalf(cpId);
  if (mod.Equals(owner, team1)) return COLOR_FRIENDLY;
  if (mod.Equals(owner, team2)) return COLOR_ENEMY;
  return COLOR_NEUTRAL;
}

function isObjectiveLetter(value: string): value is ObjectiveLetter {
  return value === "A" || value === "B" || value === "C" || value === "D";
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
  return mod.stringkeys.FLAGD;
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
  if (isObjectiveDisabledAfterAward(cpId)) return 1.0;
  if (isCipherNodeRebooting(cpId)) return getTopHudArmedPulseMultiplier();
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
  if (isObjectiveDisabledAfterAward(cpId)) return COLOR_NEUTRAL;
  if (isCipherNodeRebooting(cpId)) return COLOR_NEUTRAL;
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
    if (mcomId === undefined) continue;
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

    if (def.mcomId !== undefined && objectiveDefByMcomId[def.mcomId] !== def) {
      missingMcomIds.push(cpId);
    } else if (def.mcomId !== undefined) {
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
    const capturePoint = cp.resolveHandle("validateObjectiveAuthoring/active");
    if (!capturePoint) {
      idMismatches.push(cpId + "->unresolved");
      continue;
    }

    try {
      resolvedId = mod.GetObjId(capturePoint);
    } catch (_err) {
      idMismatches.push(cpId + "->unresolved");
      continue;
    }
    if (resolvedId !== cpId) {
      idMismatches.push(cpId + "->" + resolvedId);
    }
  }

  const surfaceValidationCpIds = OBJECTIVE_SURFACE_ONLY_CP_IDS;
  for (let i = 0; i < surfaceValidationCpIds.length; i++) {
    const cpId = surfaceValidationCpIds[i];
    const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "validateObjectiveAuthoring/surface");
    if (!capturePoint) continue;

    let resolvedId = -1;
    try {
      resolvedId = mod.GetObjId(capturePoint);
    } catch (_err) {
      idMismatches.push(cpId + "->unresolved");
      continue;
    }
    if (resolvedId !== cpId) {
      idMismatches.push(cpId + "->" + resolvedId);
    }
  }

  const authoredSectorIds = OBJECTIVE_SURFACE_SECTOR_IDS;
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
  disableAllObjectiveSurfaceSectors("registerObjectivesDeterministically", true);
  disableAllObjectiveInteractPoints("registerObjectivesDeterministically");
}

function applyObjectiveRoundStartOwnership(resetRoundState: boolean = true): void {
  if (resetRoundState) {
    captureCreditByCpId = {};
  }

  resetCipherNodeStates("applyObjectiveRoundStartOwnership");
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  seedObjectiveNativeMcomState("applyObjectiveRoundStartOwnership");
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  disableAllObjectiveCapturePointObjectives("applyObjectiveRoundStartOwnership");
  disableAllNeutralObjectiveCapturePointObjectives("applyObjectiveRoundStartOwnership");
  disableAllObjectiveSurfaceSectors("applyObjectiveRoundStartOwnership", true);
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

  resetCipherNodeStates("applyObjectiveLiveHybridRoundStartState");
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  seedObjectiveNativeMcomState("applyObjectiveLiveHybridRoundStartState");
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  disableAllObjectiveCapturePointObjectives("applyObjectiveLiveHybridRoundStartState");
  disableAllNeutralObjectiveCapturePointObjectives("applyObjectiveLiveHybridRoundStartState");
  disableAllObjectiveSurfaceSectors("applyObjectiveLiveHybridRoundStartState", true);
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
  syncLiveHybridObjectiveSurfaceState("reassertObjectiveOwnershipShortlyAfterLiveStart", true);
  scheduleDelayedObjectiveSurfaceReassert("reassertObjectiveOwnershipShortlyAfterLiveStart");
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
  // Lightweight sampling for UI smoothness: script-owned owner + progress + contested state.
  Object.values(serverCapturePoints).forEach((cp) => {
    if (isScriptedObjectiveCapturePointId(cp.id)) {
      ensureObjectiveEngineOwnerMatchesScript(cp.id, "refreshCapturePointsEngineStateForUI");
    }
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

function getConfiguredInitialTransitionPlayerSpawnerObjIdForTeam(team: mod.Team): number {
  const initialHqId = mod.Equals(team, team1) ? TEAM1_INITIAL_HQ : TEAM2_INITIAL_HQ;
  return getLiveSafeSpawnPlayerSpawnerIdForHq(initialHqId);
}

function getInitialSpawnPointObjIdForTeam(team: mod.Team): number {
  const hqId = getCipherLiveHqIdForTeam(team);
  const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(hqId);
  if (!spawnerObjId) return 0;
  if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return 0;
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
  const spawnerObjId = getConfiguredInitialTransitionPlayerSpawnerObjIdForTeam(team);
  if (!spawnerObjId) return 0;
  if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return 0;
  return spawnerObjId;
}

function trySpawnPlayerFromSpawnPointSafe(
  player: mod.Player,
  spawnerObjId: number,
  context: string
): boolean {
  if (!spawnerObjId) return false;
  if (tryGetSpawnPointPositionSafe(spawnerObjId) === undefined) return false;
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
    return mod.GetObjectPosition(mod.GetSpawnPoint(spawnPointId) as unknown as mod.Object);
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
  if (isCipherRuntimeBotPlayerId(playerId) || isBotBackfillPlayerSafe(sp.player)) {
    clearTransitionSpawnStateForPlayer(playerId);
    return;
  }

  const team = mod.GetTeam(sp.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

  if (gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive)) {
    if (
      cipherSecondHalfTransitionStage !== "deploy" &&
      cipherSecondHalfTransitionStage !== "countdown"
    ) {
      return;
    }
    try {
      if (cipherLiveTransitionSupervisorKind === "secondHalf") {
        applyCipherSecondHalfHqSpawns(source + "_hq_deploy");
      }
      requestCipherSpawnAnchorForPlayer(playerId, true);
      mod.SetRedeployTime(sp.player, 0);
      applyPhaseInputRestrictionsForPlayer(sp.player);
      mod.DeployPlayer(sp.player);
    } catch (err) {
      LogRuntimeError("TransitionDeployPlayer/" + source + "/" + String(playerId), err);
    }
    return;
  }

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
    if (isCipherRuntimeBotPlayerId(playerId) || isBotBackfillPlayerSafe(sp.player)) {
      clearTransitionSpawnStateForPlayer(playerId);
      return;
    }

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
    if (!spawnerObjId) {
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
  const t1SpawnerObjId = getConfiguredInitialTransitionPlayerSpawnerObjIdForTeam(team1);
  const t2SpawnerObjId = getConfiguredInitialTransitionPlayerSpawnerObjIdForTeam(team2);
  const t1Ok = !!t1SpawnerObjId && isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team1, t1SpawnerObjId);
  const t2Ok = !!t2SpawnerObjId && isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team2, t2SpawnerObjId);
  if (t1Ok && t2Ok) return true;

  warnTransitionSpawnOnce(
    "prelive_prereq_missing",
    mod.Message(
      "[TRANSITION SPAWN] prelive configured spawner missing t1/t2/snapshot {}",
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

  queueForcedSafeSpawnRetry(playerId, chosenHqId, spawnerObjId);
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

function isNativeFriendlyOrSquadSpawn(eventPlayer: mod.Player, playerId: number): boolean {
  // Treat any live deploy within 8m of a living teammate as a native team/squad spawn.
  // This intentionally uses TEAM proximity, not only squad proximity, because Portal squad detection can race
  // right after deploy. This matches the behavior you want: do not custom-teleport if the player spawned
  // beside a friendly.
  if (isSpawnNearFriendlyPlayer(eventPlayer, playerId, FRIENDLY_SPAWN_BYPASS_RADIUS_METERS)) {
    return true;
  }

  // Keep the stricter squad check too, in case team snapshot timing is weird but squad resolves correctly.
  if (checkIfSpawnedOnSquadmate(eventPlayer)) {
    return true;
  }

  return false;
}

function finishSafeSpawnAsNativeFriendlyOrSquadSpawn(eventPlayer: mod.Player, playerId: number): void {
  // This is the critical difference from finishSafeSpawnAsSafe():
  // DO NOT call finalizeSafeSpawnDeploySuccess(), because that function requests/executes
  // teleportCipherPlayerToRoutedAnchor().
  safeSpawnForcedRedeploys[playerId] = 0;
  safeSpawnForcedUndeploy[playerId] = false;
  safeSpawnUnsafePending[playerId] = false;
  safeSpawnPendingCheck[playerId] = false;

  commitPendingDynamicHqForPlayer(playerId);

  squadSpawnBypass[playerId] = true;
  void clearSquadSpawnBypassLater(playerId);

  // If this deploy happened during the second-half/sudden-death transition,
  // still mark the player ready so transition logic can continue.
  markCipherSecondHalfDeployReadyForPlayer(playerId, eventPlayer);

  if (bombCarrierPlayerId === playerId) {
    syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "NativeFriendlyOrSquadSpawn_NoTeleport");
  }
  queueCipherAdminInteractSpawnForPlayer(playerId, "native_friendly_or_squad_spawn");
}

function isValidDynamicSpawnId(id: number): boolean {
  return id >= TEAM1_FLAG_A_HQ && id <= TEAM2_NO_FLAG_HQ;
}
function getSafeSpawnEnemyRadiusMeters(attemptUsed: number): number {
  void attemptUsed;
  return SAFE_SPAWN_ENEMY_RADIUS_METERS;
}

function getSafeSpawnGeneration(playerId: number): number {
  return safeSpawnGenerationByPlayerId[playerId] ?? 0;
}

function bumpSafeSpawnGeneration(playerId: number): number {
  const nextGeneration = getSafeSpawnGeneration(playerId) + 1;
  safeSpawnGenerationByPlayerId[playerId] = nextGeneration;
  return nextGeneration;
}

function clearQueuedSafeSpawnStateForPlayer(playerId: number): void {
  delete safeSpawnCheckQueuedGenerationByPlayerId[playerId];
  delete safeSpawnForcedQueuedGenerationByPlayerId[playerId];
  delete cipherQueuedAnchorByPlayerId[playerId];
  safeSpawnPendingCheck[playerId] = false;
}

function isSafeSpawnCheckQueueItemCurrent(item: SafeSpawnCheckQueueItem): boolean {
  if (safeSpawnCheckQueuedGenerationByPlayerId[item.playerId] !== item.generation) return false;
  if (getSafeSpawnGeneration(item.playerId) !== item.generation) return false;
  return serverPlayers.get(item.playerId) !== undefined;
}

function isForcedSafeSpawnQueueItemCurrent(item: ForcedSafeSpawnQueueItem): boolean {
  if (safeSpawnForcedQueuedGenerationByPlayerId[item.playerId] !== item.generation) return false;
  if (getSafeSpawnGeneration(item.playerId) !== item.generation) return false;
  return serverPlayers.get(item.playerId) !== undefined;
}

function isSafeSpawnUnsafePendingForPlayer(playerId: number): boolean {
  return safeSpawnUnsafePending[playerId] === true;
}

function queueForcedSafeSpawnRetry(playerId: number, hqObjId: number, spawnerObjId: number): void {
  const p = serverPlayers.get(playerId);
  if (!p || !spawnerObjId) return;

  delete cipherQueuedAnchorByPlayerId[playerId];
  const generation = getSafeSpawnGeneration(playerId);
  if (safeSpawnForcedQueuedGenerationByPlayerId[playerId] === generation) return;

  safeSpawnForcedUndeploy[playerId] = true;
  safeSpawnUnsafePending[playerId] = true;
  safeSpawnUnsafeHqObjIdByPlayerId[playerId] = hqObjId;
  safeSpawnUnsafeSpawnerObjId[playerId] = spawnerObjId;
  safeSpawnForcedQueuedGenerationByPlayerId[playerId] = generation;
  safeSpawnForcedQueue.push({
    playerId,
    generation,
    hqObjId,
    spawnerObjId,
    stage: "undeploy",
    dueTick: phaseTickCount + 1,
    waitTicks: 0,
  });
}

function queueForcedSafeSpawnRetryForCurrentRoute(
  eventPlayer: mod.Player,
  playerId: number,
  source: string
): boolean {
  void source;
  if (!mod.IsPlayerValid(eventPlayer)) return false;

  const team = mod.GetTeam(eventPlayer);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;

  const used = safeSpawnForcedRedeploys[playerId] ?? 0;
  const nextUsed =
    used >= SAFE_SPAWN_MAX_FORCED_REDEPLOYS ? SAFE_SPAWN_MAX_FORCED_REDEPLOYS : used + 1;
  safeSpawnForcedRedeploys[playerId] = nextUsed;

  const chosenHqId = sanitizeForcedSafeSpawnHqForTeam(
    team,
    resolveForcedSafeSpawnHqObjId(playerId, team, nextUsed)
  );
  const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(chosenHqId);

  if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return false;

  queueForcedSafeSpawnRetry(playerId, chosenHqId, spawnerObjId);
  return true;
}

function finalizeSafeSpawnDeploySuccess(eventPlayer: mod.Player, playerId: number): void {
  if (safeSpawnUnsafePending[playerId] === true) return;

  requestCipherSpawnTeleportForPlayer(playerId, true);
  processCipherSpawnJobs("SafeSpawnSuccess_LiveTeleport");
  const teleported = teleportCipherPlayerToRoutedAnchor(eventPlayer, playerId);
  if (!teleported && gameStatus === 3) {
    if (queueForcedSafeSpawnRetryForCurrentRoute(eventPlayer, playerId, "SafeSpawnSuccess_NoSafeAnchor")) return;
  }
  if (
    teleported &&
    hasEnemyNearPosition(
      mod.GetTeam(eventPlayer),
      getPlayerPosition(eventPlayer),
      getSafeSpawnEnemyRadiusMeters(safeSpawnForcedRedeploys[playerId] ?? 0),
      playerId
    )
  ) {
    if (queueForcedSafeSpawnRetryForCurrentRoute(eventPlayer, playerId, "SafeSpawnSuccess_PostTeleportUnsafe")) return;
  }
  if (bombCarrierPlayerId === playerId) {
    syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "SafeSpawnSuccess_LiveTeleport");
  }
  markCipherSecondHalfDeployReadyForPlayer(playerId, eventPlayer);
  queueCipherAdminInteractSpawnForPlayer(playerId, "safe_spawn_success");
  HqDesyncCheckAndRecycle(eventPlayer, playerId);
  if (!isSafeSpawnUnsafePendingForPlayer(playerId)) {
    safeSpawnForcedUndeploy[playerId] = false;
  }
}

function finishSafeSpawnAsSafe(eventPlayer: mod.Player, playerId: number): void {
  safeSpawnForcedRedeploys[playerId] = 0;
  commitPendingDynamicHqForPlayer(playerId);
  finalizeSafeSpawnDeploySuccess(eventPlayer, playerId);
}

function runSafeSpawnCheckOrRedeploy(playerId: number, generation: number): void {
  if (safeSpawnPendingCheck[playerId] === true) return;
  if (safeSpawnUnsafePending[playerId] === true) return;
  if (generation !== getSafeSpawnGeneration(playerId)) return;

  const p = serverPlayers.get(playerId);
  if (!p) return;

  const eventPlayer = p.player;
  if (!mod.IsPlayerValid(eventPlayer)) return;

  safeSpawnPendingCheck[playerId] = true;

  try {
    if (gameStatus !== 3) return;
    if (!p.isDeployed) return;
    if (!isPlayerAlive(eventPlayer)) return;

    // FIRST: native friendly/squad spawn bypass.
    // This must happen before the enemy unsafe check. If a player chose a squad/friendly spawn,
    // we do not recycle or anchor-teleport them even if enemies are nearby.
    if (isNativeFriendlyOrSquadSpawn(eventPlayer, playerId) || isSquadSpawnBypassActive(playerId)) {
      finishSafeSpawnAsNativeFriendlyOrSquadSpawn(eventPlayer, playerId);
      return;
    }

    const team = mod.GetTeam(eventPlayer);
    const pos = getPlayerPosition(eventPlayer);
    const used = safeSpawnForcedRedeploys[playerId] ?? 0;
    const radius = getSafeSpawnEnemyRadiusMeters(used);
    const unsafe = hasEnemyNearPosition(team, pos, radius, playerId);

    if (unsafe) {
      queueForcedSafeSpawnRetryForCurrentRoute(eventPlayer, playerId, "SafeSpawnCheck_Unsafe");
      return;
    }

    finishSafeSpawnAsSafe(eventPlayer, playerId);
  } finally {
    safeSpawnPendingCheck[playerId] = false;
  }
}

function SafeSpawnCheckOrRedeploy(playerId: number): void {
  if (safeSpawnUnsafePending[playerId] === true) return;

  const generation = getSafeSpawnGeneration(playerId);
  if (safeSpawnCheckQueuedGenerationByPlayerId[playerId] === generation) return;

  safeSpawnCheckQueuedGenerationByPlayerId[playerId] = generation;
  safeSpawnCheckQueue.push({
    playerId,
    generation,
    dueTick: phaseTickCount + SAFE_SPAWN_CHECK_DELAY_TICKS,
  });
}

function processSafeSpawnCheckQueue(): void {
  if (gameStatus !== 3 || safeSpawnCheckQueue.length <= 0) return;

  let processed = 0;
  const remaining: SafeSpawnCheckQueueItem[] = [];

  for (let i = 0; i < safeSpawnCheckQueue.length; i++) {
    const item = safeSpawnCheckQueue[i];

    if (!isSafeSpawnCheckQueueItemCurrent(item)) continue;

    if (processed >= SAFE_SPAWN_CHECK_QUEUE_BUDGET_PER_TICK || item.dueTick > phaseTickCount) {
      remaining.push(item);
      continue;
    }

    delete safeSpawnCheckQueuedGenerationByPlayerId[item.playerId];
    processed += 1;
    runSafeSpawnCheckOrRedeploy(item.playerId, item.generation);
  }

  safeSpawnCheckQueue = remaining;
}

function processForcedSafeSpawnQueue(): void {
  if (gameStatus !== 3 || safeSpawnForcedQueue.length <= 0) return;

  let processed = 0;
  const remaining: ForcedSafeSpawnQueueItem[] = [];

  for (let i = 0; i < safeSpawnForcedQueue.length; i++) {
    const item = safeSpawnForcedQueue[i];

    if (!isForcedSafeSpawnQueueItemCurrent(item)) continue;

    if (processed >= SAFE_SPAWN_FORCED_QUEUE_BUDGET_PER_TICK || item.dueTick > phaseTickCount) {
      remaining.push(item);
      continue;
    }

    const p = serverPlayers.get(item.playerId);
    if (!p || !mod.IsPlayerValid(p.player)) {
      delete safeSpawnForcedQueuedGenerationByPlayerId[item.playerId];
      safeSpawnUnsafePending[item.playerId] = false;
      safeSpawnUnsafeSpawnerObjId[item.playerId] = 0;
      safeSpawnUnsafeHqObjIdByPlayerId[item.playerId] = 0;
      continue;
    }

    processed += 1;

    if (item.stage === "undeploy") {
      safeSpawnForcedUndeploy[item.playerId] = true;
      safeSpawnUnsafePending[item.playerId] = true;
      safeSpawnUnsafeHqObjIdByPlayerId[item.playerId] = item.hqObjId;
      safeSpawnUnsafeSpawnerObjId[item.playerId] = item.spawnerObjId;
      p.isDeployed = false;

      mod.SetRedeployTime(p.player, 9999);
      mod.DisplayNotificationMessage(mod.Message(mod.stringkeys.SafeSpawnRetryToast), p.player);
      mod.UndeployPlayer(p.player);

      remaining.push({
        playerId: item.playerId,
        generation: item.generation,
        hqObjId: item.hqObjId,
        spawnerObjId: item.spawnerObjId,
        stage: "spawn",
        dueTick: phaseTickCount + SAFE_SPAWN_FORCED_SPAWN_DELAY_TICKS,
        waitTicks: 0,
      });
      continue;
    }

    if (p.isDeployed && item.waitTicks < TICK_RATE) {
      remaining.push({
        playerId: item.playerId,
        generation: item.generation,
        hqObjId: item.hqObjId,
        spawnerObjId: item.spawnerObjId,
        stage: "spawn",
        dueTick: phaseTickCount + 1,
        waitTicks: item.waitTicks + 1,
      });
      continue;
    }

    safeSpawnUnsafePending[item.playerId] = false;
    safeSpawnUnsafeSpawnerObjId[item.playerId] = 0;
    safeSpawnUnsafeHqObjIdByPlayerId[item.playerId] = 0;
    delete safeSpawnForcedQueuedGenerationByPlayerId[item.playerId];

    lastLiveHqSpawnPointObjIdByPlayerId[item.playerId] = item.hqObjId;
    lastForcedSafeSpawnHqObjIdByPlayerId[item.playerId] = item.hqObjId;
    mod.SetRedeployTime(p.player, 0);
    trySpawnPlayerFromSpawnPointSafe(p.player, item.spawnerObjId, "SafeSpawnForcedQueue");
    mod.SetRedeployTime(p.player, isCipherSuddenDeathActive() ? 9999 : REDEPLOY_TIME);
  }

  safeSpawnForcedQueue = remaining;
}

function processLiveSafeSpawnQueues(): void {
  processForcedSafeSpawnQueue();
  processSafeSpawnCheckQueue();
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
let SFX_ObjectiveDisabledUi: any = null;
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

  SFX_ObjectiveDisabledUi = mod.SpawnObject(
    OBJECTIVE_DISABLE_UI_SFX_ASSET,
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
  if (!SFX_ObjectiveDisabledUi) return;

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    mod.PlaySound(SFX_ObjectiveDisabledUi, OBJECTIVE_AWARD_SUCCESS_VOLUME, p.player);
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
const PREMATCH_PANEL_POS_X = -560;
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
const PREMATCH_PANEL_WIDGET_NAME = "PreMatchPanel";

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
  const panel = SafeFindWidget(PREMATCH_PANEL_WIDGET_NAME);
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

const POSTMATCH_SHOWCASE_PARENT_ID = 4747;
const POSTMATCH_CAMERA_ID = 4646;
const POSTMATCH_SHOWCASE_HEAD_TEXT_Y_OFFSET_METERS = 2.4;
const POSTMATCH_SHOWCASE_FEET_TEXT_Y_OFFSET_METERS = -0.25;
const POSTMATCH_RESULT_TEXT_Y = -360;
const POSTMATCH_SCORE_TEXT_Y = -275;
const POSTMATCH_HINT_TEXT_Y = -215;
const POSTMATCH_RESULT_TEXT_WIDTH = 900;
const POSTMATCH_RESULT_TEXT_HEIGHT = 120;
const POSTMATCH_SCORE_TEXT_WIDTH = 160;
const POSTMATCH_SCORE_TEXT_HEIGHT = 56;
const POSTMATCH_HINT_TEXT_WIDTH = 900;
const POSTMATCH_HINT_TEXT_HEIGHT = 44;
const POSTMATCH_HINT_TEXT_SIZE = 28;

type PostmatchShowcaseStatKind = "eliminations" | "destroyed" | "keyTime" | "moralSupport";
type PostmatchShowcaseIconKind = "head" | "feet";

type PostmatchShowcaseSlot = {
  anchorId: number;
  statKind: PostmatchShowcaseStatKind;
  player: Player;
  statValue: number;
  headIconObject?: mod.Object;
  headIconHandle?: mod.WorldIcon;
  feetIconObject?: mod.Object;
  feetIconHandle?: mod.WorldIcon;
};

type PostmatchQuaternion = {
  w: number;
  x: number;
  y: number;
  z: number;
};

type PostmatchShowcaseRuntimeObjectConfig = {
  key: string;
  anchorId?: number;
  asset: mod.RuntimeSpawn_Common;
  localOffset: mod.Vector;
  localRotation: mod.Vector;
  scale?: mod.Vector;
};

type PostmatchShowcaseRuntimeObjectCache = {
  key: string;
  position?: mod.Vector;
  rotation?: mod.Vector;
  runtimeObject?: mod.Object;
  runtimeSpawned: boolean;
};

// Local transforms are relative to authored parent ObjId 4747. Runtime assets use spatial type names.
const POSTMATCH_SHOWCASE_RUNTIME_OBJECT_CONFIGS: PostmatchShowcaseRuntimeObjectConfig[] = [
  {
    key: "postmatch_wall_180",
    asset: mod.RuntimeSpawn_Common.CinderblockStack_01_C_180,
    localOffset: mod.CreateVector(-1.88476568, 0.06756592, 0.10205078),
    localRotation: mod.CreateVector(0, -1.56557786, 0),
  },
  {
    key: "postmatch_wall_181",
    asset: mod.RuntimeSpawn_Common.CinderblockStack_01_C_180,
    localOffset: mod.CreateVector(0.04083252, 0.06756592, 0.09197998),
    localRotation: mod.CreateVector(0, -1.56557786, 0),
  },
  {
    key: "postmatch_wall_182",
    asset: mod.RuntimeSpawn_Common.CinderblockStack_01_C_180,
    localOffset: mod.CreateVector(1.95547498, 0.06756592, 0.08197022),
    localRotation: mod.CreateVector(0, -1.56557786, 0),
  },
  {
    key: "postmatch_wall_183",
    asset: mod.RuntimeSpawn_Common.CinderblockStack_01_C_180,
    localOffset: mod.CreateVector(-1.88476568, 1.856842, 0.10205078),
    localRotation: mod.CreateVector(1.18524949, -1.56834724, -1.19420312),
  },
  {
    key: "postmatch_wall_184",
    asset: mod.RuntimeSpawn_Common.CinderblockStack_01_C_180,
    localOffset: mod.CreateVector(0.04083252, 1.856842, 0.09197998),
    localRotation: mod.CreateVector(1.18524949, -1.56834724, -1.19420312),
  },
  {
    key: "postmatch_wall_185",
    asset: mod.RuntimeSpawn_Common.CinderblockStack_01_C_180,
    localOffset: mod.CreateVector(1.95547498, 1.856842, 0.08197022),
    localRotation: mod.CreateVector(1.18524949, -1.56834724, -1.19420312),
  },
  {
    key: "top_eliminations_pedestal",
    asset: mod.RuntimeSpawn_Common.BarrierStoneBlock_01_A,
    localOffset: mod.CreateVector(-1.93911748, -0.59436035, 1.52606206),
    localRotation: mod.CreateVector(3.14159265, -1.56201727, 3.14159265),
  },
  {
    key: "most_mcoms_destroyed_pedestal",
    asset: mod.RuntimeSpawn_Common.BarrierStoneBlock_01_A,
    localOffset: mod.CreateVector(-0.59240722, -0.59436035, 1.53784186),
    localRotation: mod.CreateVector(3.14159265, -1.56201727, 3.14159265),
  },
  {
    key: "key_time_pedestal",
    asset: mod.RuntimeSpawn_Common.BarrierStoneBlock_01_A,
    localOffset: mod.CreateVector(0.75463873, -0.59436035, 1.54968267),
    localRotation: mod.CreateVector(3.14159265, -1.56201727, 3.14159265),
  },
  {
    key: "moral_support_pedestal",
    asset: mod.RuntimeSpawn_Common.BarrierStoneBlock_01_A,
    localOffset: mod.CreateVector(2.11074839, -0.59436035, 1.56161507),
    localRotation: mod.CreateVector(3.14159265, -1.56201727, 3.14159265),
  },
  {
    key: "top_eliminations_anchor",
    anchorId: 4545,
    asset: mod.RuntimeSpawn_Common.FiringRange_MatDecal_01,
    localOffset: mod.CreateVector(-1.97021488, 0.6274719, 1.58447277),
    localRotation: mod.CreateVector(0, -1.43722636, 0),
  },
  {
    key: "most_mcoms_destroyed_anchor",
    anchorId: 4546,
    asset: mod.RuntimeSpawn_Common.FiringRange_MatDecal_01,
    localOffset: mod.CreateVector(-0.58270266, 0.6274719, 1.59271247),
    localRotation: mod.CreateVector(0, -1.43722636, 0),
  },
  {
    key: "key_time_anchor",
    anchorId: 4547,
    asset: mod.RuntimeSpawn_Common.FiringRange_MatDecal_01,
    localOffset: mod.CreateVector(0.80899053, 0.6274719, 1.62503057),
    localRotation: mod.CreateVector(0, -1.43722636, 0),
  },
  {
    key: "moral_support_anchor",
    anchorId: 4548,
    asset: mod.RuntimeSpawn_Common.FiringRange_MatDecal_01,
    localOffset: mod.CreateVector(2.15637209, 0.6274719, 1.56951907),
    localRotation: mod.CreateVector(0, -1.43722636, 0),
  },
];

let postmatchShowcaseRuntimeObjectCacheByKey: { [key: string]: PostmatchShowcaseRuntimeObjectCache } = {};
let postmatchShowcaseAnchorPositionById: { [anchorId: number]: mod.Vector | undefined } = {};

const POSTMATCH_SHOWCASE_SLOT_CONFIGS: { anchorId: number; statKind: PostmatchShowcaseStatKind }[] = [
  { anchorId: 4545, statKind: "eliminations" },
  { anchorId: 4546, statKind: "destroyed" },
  { anchorId: 4547, statKind: "keyTime" },
  { anchorId: 4548, statKind: "moralSupport" },
];
const POSTMATCH_SHOWCASE_STAT_PRIORITY: PostmatchShowcaseStatKind[] = [
  "eliminations",
  "destroyed",
  "keyTime",
  "moralSupport",
];

let postmatchShowcaseSlots: PostmatchShowcaseSlot[] = [];
let postmatchShowcaseCameraAppliedByPlayerId: { [playerId: number]: boolean } = {};

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

const SAFE_UI_ROOT_WIDTH = 7000;
const SAFE_UI_ROOT_HEIGHT = 7000;
const SAFE_UI_ROOT_SIZE = mod.CreateVector(SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT, 0);
const SAFE_UI_CONTENT_WIDTH = 1440;
const SAFE_UI_CONTENT_HEIGHT = 1080;
const SCREEN_UI_REFERENCE_WIDTH = 1920;
const SCREEN_UI_REFERENCE_HEIGHT = 1080;

function safeRootPosFromTopLeft(x: number, y: number, width: number, height: number): [number, number] {
  return [
    x + width / 2 - SCREEN_UI_REFERENCE_WIDTH / 2,
    y + height / 2 - SCREEN_UI_REFERENCE_HEIGHT / 2,
  ];
}

function safeRootPosFromTopCenter(x: number, y: number, _width: number, height: number): [number, number] {
  return [
    x,
    y + height / 2 - SCREEN_UI_REFERENCE_HEIGHT / 2,
  ];
}

function safeContentPosFromTopLeft(x: number, y: number, width: number, height: number): [number, number] {
  return [
    x + width / 2 - SAFE_UI_CONTENT_WIDTH / 2,
    y + height / 2 - SAFE_UI_CONTENT_HEIGHT / 2,
  ];
}

function safeRootVectorFromTopLeft(x: number, y: number, width: number, height: number): mod.Vector {
  const pos = safeRootPosFromTopLeft(x, y, width, height);
  return mod.CreateVector(pos[0], pos[1], 0);
}

function safeRootVectorFromTopCenter(x: number, y: number, width: number, height: number): mod.Vector {
  const pos = safeRootPosFromTopCenter(x, y, width, height);
  return mod.CreateVector(pos[0], pos[1], 0);
}

function safeContentVectorFromTopLeft(x: number, y: number, width: number, height: number): mod.Vector {
  const pos = safeContentPosFromTopLeft(x, y, width, height);
  return mod.CreateVector(pos[0], pos[1], 0);
}

/* -----------------------------------------------------------------------------------------------
   Top-level UI layout
------------------------------------------------------------------------------------------------ */

const UIWidget = modlib.ParseUI({
  name: "UIContainer",
  type: "Container",
  position: [0, 0],
  size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
  anchor: mod.UIAnchor.Center,
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
      size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
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
          position: safeContentPosFromTopLeft(
            LIVE_TIMER_DEFAULT_POS_X,
            LIVE_TIMER_DEFAULT_POS_Y,
            LIVE_TIMER_DEFAULT_WIDTH,
            LIVE_TIMER_DEFAULT_HEIGHT
          ),
          size: [LIVE_TIMER_DEFAULT_WIDTH, LIVE_TIMER_DEFAULT_HEIGHT],
          anchor: mod.UIAnchor.Center,
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
        {
          name: "BG_Score_Container",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_SCORE_PANEL_LEFT,
            LIVE_SCORE_PANEL_TOP,
            LIVE_SCORE_PANEL_WIDTH,
            LIVE_SCORE_PANEL_HEIGHT
          ),
          size: [LIVE_SCORE_PANEL_WIDTH, LIVE_SCORE_PANEL_HEIGHT],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.5,
          bgFill: mod.UIBgFill.Solid,
        },
        {
          name: "Container_A",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_SCORE_FLAG_ROW_LEFT,
            LIVE_SCORE_FLAG_ROW_TOP,
            LIVE_SCORE_FLAG_SIZE,
            LIVE_SCORE_FLAG_SIZE
          ),
          size: [LIVE_SCORE_FLAG_SIZE, LIVE_SCORE_FLAG_SIZE],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.4,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "Container_B",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_SCORE_FLAG_ROW_LEFT + (LIVE_SCORE_FLAG_SIZE + LIVE_SCORE_FLAG_GAP),
            LIVE_SCORE_FLAG_ROW_TOP,
            LIVE_SCORE_FLAG_SIZE,
            LIVE_SCORE_FLAG_SIZE
          ),
          size: [LIVE_SCORE_FLAG_SIZE, LIVE_SCORE_FLAG_SIZE],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.4,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "Container_C",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_SCORE_FLAG_ROW_LEFT + ((LIVE_SCORE_FLAG_SIZE + LIVE_SCORE_FLAG_GAP) * 2),
            LIVE_SCORE_FLAG_ROW_TOP,
            LIVE_SCORE_FLAG_SIZE,
            LIVE_SCORE_FLAG_SIZE
          ),
          size: [LIVE_SCORE_FLAG_SIZE, LIVE_SCORE_FLAG_SIZE],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.4,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "Container_D",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_SCORE_FLAG_ROW_LEFT + ((LIVE_SCORE_FLAG_SIZE + LIVE_SCORE_FLAG_GAP) * 3),
            LIVE_SCORE_FLAG_ROW_TOP,
            LIVE_SCORE_FLAG_SIZE,
            LIVE_SCORE_FLAG_SIZE
          ),
          size: [LIVE_SCORE_FLAG_SIZE, LIVE_SCORE_FLAG_SIZE],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.4,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "Container_E",
          type: "Container",
          position: safeContentPosFromTopLeft(0, 0, 1, 1),
          size: [1, 1],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.4,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "Container_F",
          type: "Container",
          position: safeContentPosFromTopLeft(0, 0, 1, 1),
          size: [1, 1],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.0314, 0.0431, 0.0431],
          bgAlpha: 0.4,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "friendlyscore",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_HUD_FRIENDLY_SCORE_X,
            LIVE_HUD_SCORE_Y,
            LIVE_HUD_SCORE_WIDTH,
            LIVE_HUD_SCORE_HEIGHT
          ),
          size: [LIVE_HUD_SCORE_WIDTH, LIVE_HUD_SCORE_HEIGHT],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.2314, 0.4196, 0.6745],
          bgAlpha: 0,
          bgFill: mod.UIBgFill.None,
        },
        {
          name: "enemyscore",
          type: "Container",
          position: safeContentPosFromTopLeft(
            LIVE_HUD_ENEMY_SCORE_X,
            LIVE_HUD_SCORE_Y,
            LIVE_HUD_SCORE_WIDTH,
            LIVE_HUD_SCORE_HEIGHT
          ),
          size: [LIVE_HUD_SCORE_WIDTH, LIVE_HUD_SCORE_HEIGHT],
          anchor: mod.UIAnchor.Center,
          visible: false,
          padding: 0,
          bgColor: [0.698, 0.1882, 0.1882],
          bgAlpha: 0,
          bgFill: mod.UIBgFill.None,
        },

      ],
    },
    {
      name: "PostMatchContainer",
      type: "Container",
      position: [0, 0],
      size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
    },
    {
  name: "PreMatchContainer",
  type: "Container",
  position: [0, 0],
  size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
  anchor: mod.UIAnchor.Center,
  visible: true,
  padding: 0,
  bgColor: [0, 0, 0],
  bgAlpha: 0,
  bgFill: mod.UIBgFill.None,
  children: [
    {
  name: PREMATCH_PANEL_WIDGET_NAME,
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
}
  ]
},
    {
      name: "CountDownContainer",
      type: "Container",
      position: [0, 0],
      size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0,
      bgFill: mod.UIBgFill.None,
      children: [
        {
          name: "CountDownPanel",
          type: "Container",
          position: safeRootPosFromTopCenter(0, 150, 300, 150),
          size: [300, 150],
          anchor: mod.UIAnchor.Center,
          visible: true,
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
    },
  ],
});
SetCountdownOverlayVisible(false);
SetCountdownOverlayDepthAboveGameUI();

function ensureServerPlayerTrackedForPrematchReady(player: mod.Player): Player | undefined {
  if (!mod.IsPlayerValid(player)) return undefined;

  const playerId = modlib.getPlayerId(player);
  let p = serverPlayers.get(playerId);
  if (!p) {
    p = new Player(player);
    serverPlayers.set(playerId, p);
  } else {
    p.player = player;
  }

  const team = mod.GetTeam(player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) {
    mod.SetTeam(player, team1);
  }
  p.setTeam();
  return p;
}

function HandlePrematchReadyUp(player: mod.Player, interactPointId: number = -1): void {
  if (gameStatus !== 0) return;
  if (!mod.IsPlayerValid(player)) return;
  if (isBotBackfillPlayer(player)) return;
  const playerId = modlib.getPlayerId(player);
  if (isPrematchReadyDebounced(playerId, interactPointId)) return;

  const p = ensureServerPlayerTrackedForPrematchReady(player);
  if (!p) return;

  // Prematch authority stays on interact points; UI only reflects the authoritative state.
  p.changeReady();
  refreshPrematchReadyStateUi();
  tryStartPreliveFromPrematch("ready_interact", player, interactPointId);

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
  SetDepthAboveGameUI("CountDownPanel");
}

function SetCountdownOverlayVisible(visible: boolean): void {
  SafeSetWidgetVisibleByName("CountDownContainer", visible);
  SafeSetWidgetVisibleByName("CountDownPanel", visible);
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
      getPlayerLiveHudRootWidgetName(playerId),
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
  size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
  anchor: mod.UIAnchor.Center,
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
      position: safeRootPosFromTopCenter(0, 200, 650, 110),
      size: [650, 110],
      anchor: mod.UIAnchor.Center,
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
      position: safeRootPosFromTopCenter(-385, 200, 80, 110),
      size: [80, 110],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [1.0, 0.45, 0.16],
      bgAlpha: 0.9,
      bgFill: mod.UIBgFill.GradientRight,
    },
    {
      name: "Intro_DOMINATION_Line_Right",
      type: "Container",
      position: safeRootPosFromTopCenter(385, 200, 80, 110),
      size: [80, 110],
      anchor: mod.UIAnchor.Center,
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
    mod.SetUIWidgetDepth(root, mod.UIDepth.AboveGameUI);
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
const STALE_PREMATCH_BUTTON_WIDGET_PREFIXES = [
  "UI_PREMATCH_CONTAINER_",
  "UI_PREMATCH_BUTTON_READY_",
  "UI_PREMATCH_BUTTON_SWITCH_",
  "UI_PREMATCH_LABEL_READY_",
  "UI_PREMATCH_LABEL_SWITCH_",
];

const STALE_PREMATCH_BUTTON_WIDGET_NAMES = [
  "Button_Ready",
  "Button_Switch_Team",
  "Text_Ready",
  "Text_Switch_Teams",
  "Button_Ready_Label",
  "Button_Switch_Team_Label",
];

function deletePrematchButtonWidgetsForPlayer(player: mod.Player): void {
  if (!player || !mod.IsPlayerValid(player)) return;

  let objId = -1;
  let stablePlayerId = -1;
  try {
    objId = mod.GetObjId(player);
  } catch (_errObjId) {}
  try {
    stablePlayerId = modlib.getPlayerId(player);
  } catch (_errPlayerId) {}

  for (let i = 0; i < STALE_PREMATCH_BUTTON_WIDGET_PREFIXES.length; i++) {
    const prefix = STALE_PREMATCH_BUTTON_WIDGET_PREFIXES[i];
    if (objId >= 0) safeDeleteAllWidgetsByName(prefix + objId);
    if (stablePlayerId >= 0 && stablePlayerId !== objId) safeDeleteAllWidgetsByName(prefix + stablePlayerId);
  }

  try {
    mod.EnableUIInputMode(false, player);
  } catch (_errInputMode) {}
}

function DeletePrematchButtonWidgetsForAllPlayers(): void {
  for (let i = 0; i < STALE_PREMATCH_BUTTON_WIDGET_NAMES.length; i++) {
    safeDeleteAllWidgetsByName(STALE_PREMATCH_BUTTON_WIDGET_NAMES[i]);
  }

  const allPlayers = mod.AllPlayers();
  for (let i = 0; i < mod.CountOf(allPlayers); i++) {
    const player = mod.ValueInArray(allPlayers, i) as mod.Player;
    deletePrematchButtonWidgetsForPlayer(player);
  }

  serverPlayers.forEach((playerInfo) => {
    if (!playerInfo) return;
    deletePrematchButtonWidgetsForPlayer(playerInfo.player);
  });
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

function setStaticPrematchPanelWidgetsVisible(visible: boolean): void {
  const staticNames = [
    "Text_Cipher_Esports",
    "Text_Mode_Domination",
    "Text_Current_Map",
    "Container_NRDAA",
    "Text_Team_1",
    "Text_Team_2",
    "PreMatchTeam1",
    "PreMatchTeam2",
  ];

  for (let i = 0; i < staticNames.length; i++) {
    SafeSetWidgetVisibleByName(staticNames[i], visible);
  }
}

function HidePrematchUiForTransition(): void {
  SafeSetWidgetVisibleByName("PreMatchContainer", false);
  SafeSetWidgetVisibleByName(PREMATCH_PANEL_WIDGET_NAME, false);
  setStaticPrematchPanelWidgetsVisible(false);

  for (let i = 0; i < MAX_ROSTER_LINES; i++) {
    SafeSetWidgetVisibleHandle(prematchRosterTeam1[i], false);
    SafeSetWidgetVisibleHandle(prematchRosterTeam2[i], false);
    SafeSetWidgetVisibleHandle(prematchRosterTeam1Lines[i], false);
    SafeSetWidgetVisibleHandle(prematchRosterTeam2Lines[i], false);
    SafeSetWidgetVisibleByName("PreMatchRosterT1_" + i, false);
    SafeSetWidgetVisibleByName("PreMatchRosterT2_" + i, false);
    SafeSetWidgetVisibleByName("PreMatchRosterT1Line_" + i, false);
    SafeSetWidgetVisibleByName("PreMatchRosterT2Line_" + i, false);
  }

  for (const playerIdText in readyTextWidgetByPlayerId) {
    const playerId = Number(playerIdText);
    if (!Number.isFinite(playerId)) continue;
    SafeSetWidgetVisibleHandle(readyTextWidgetByPlayerId[playerId], false);
    SafeSetWidgetVisibleByName("ReadyText" + playerId, false);
  }

  serverPlayers.forEach((p) => {
    SafeSetWidgetVisibleByName("ReadyText" + p.id, false);
  });

  DeletePrematchButtonWidgetsForAllPlayers();
}

function ShowPrematchUi(): void {
  if (gameStatus !== 0) return;

  DeletePrematchButtonWidgetsForAllPlayers();

  SafeSetWidgetVisibleByName("PreMatchContainer", true);
  SafeSetWidgetVisibleByName(PREMATCH_PANEL_WIDGET_NAME, true);
  setStaticPrematchPanelWidgetsVisible(true);

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    const readyText = resolvePrematchReadyTextWidgetForPlayer(p.id);
    if (readyText) {
      SafeSetWidgetVisibleHandle(readyText, true);
    } else {
      replacePrematchReadyText(p.id, p.player);
    }
    try {
      mod.EnableUIInputMode(false, p.player);
    } catch (_errInputMode) {}
  });

  BuildPrematchRosterUI();
  UpdatePrematchRosterUI();
  DeletePrematchButtonWidgetsForAllPlayers();
}

function BuildPrematchRosterUI(): void {
    if (gameStatus !== 0) return;
    if (prematchRosterBuilt) return;

    const parent = SafeFindWidget(PREMATCH_PANEL_WIDGET_NAME);
    if (!parent) {
      warnPrematchUiGuardOnce(
        "prematch_roster_parent_missing",
        mod.Message("[PREMATCH ROSTER] missing parent widget {}", PREMATCH_PANEL_WIDGET_NAME)
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
    if (gameStatus !== 0) return;
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

  const parent = SafeFindWidget(PREMATCH_PANEL_WIDGET_NAME);
  if (!parent) {
    readyTextBuiltByPlayerId[playerId] = false;
    delete readyTextWidgetByPlayerId[playerId];
    warnPrematchUiGuardOnce(
      "prematch_readytext_parent_missing",
      mod.Message("[PREMATCH READY TEXT] missing parent widget {}", PREMATCH_PANEL_WIDGET_NAME)
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
  safeDeleteWidgetByName(getPlayerLiveHudRootWidgetName(playerId));
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

const PLAYER_LIVE_HUD_ROOT_WIDGET_NAME_PREFIX = "PlayerLiveHudRoot";
const LIVE_HUD_FRIENDLY_SCORE_POS = safeContentVectorFromTopLeft(
  LIVE_HUD_FRIENDLY_SCORE_X,
  LIVE_HUD_SCORE_Y,
  LIVE_HUD_SCORE_WIDTH,
  LIVE_HUD_SCORE_HEIGHT
);
const LIVE_HUD_ENEMY_SCORE_POS = safeContentVectorFromTopLeft(
  LIVE_HUD_ENEMY_SCORE_X,
  LIVE_HUD_SCORE_Y,
  LIVE_HUD_SCORE_WIDTH,
  LIVE_HUD_SCORE_HEIGHT
);
const LIVE_HUD_SCORE_SIZE = mod.CreateVector(LIVE_HUD_SCORE_WIDTH, LIVE_HUD_SCORE_HEIGHT, 0);
const BOMB_CARRIER_WIDGET_NAME_PREFIX = "Text_BombCarrier";
const BOMB_CARRIER_WIDGET_POS = safeRootVectorFromTopCenter(0, 876.98, 243, 50);
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
const NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX = "Container_NextKeyUnlock";
const NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX = "Text_NextKeyUnlock";
const NEXT_KEY_UNLOCK_WIDGET_POS = mod.CreateVector(0, -466, 0);
const NEXT_KEY_UNLOCK_CONTAINER_SIZE = mod.CreateVector(676, 46, 0);
const NEXT_KEY_UNLOCK_WIDGET_SIZE = mod.CreateVector(554, 38, 0);
const NEXT_KEY_UNLOCK_WIDGET_BG_COLOR = BOMB_NOTICE_WIDGET_BG_COLOR;
const NEXT_KEY_UNLOCK_WIDGET_TEXT_COLOR = mod.CreateVector(1, 1, 1);
const NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE = 24;
const NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET = mod.CreateVector(0, 1.15, 0);
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
const DEPLOY_OBJECTIVE_TIMER_ROOT_WIDTH = SAFE_UI_ROOT_WIDTH;
const DEPLOY_OBJECTIVE_TIMER_ROOT_HEIGHT = SAFE_UI_ROOT_HEIGHT;
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

function getPlayerLiveHudRootWidgetName(playerId: number): string {
  return PLAYER_LIVE_HUD_ROOT_WIDGET_NAME_PREFIX + playerId;
}

function bindPlayerTopScoreWidgetRefs(p: Player): void {
  p.friendlyScoreWidget = mod.FindUIWidgetWithName("TeamFriendlyScore" + p.id);
  p.opponentScoreWidget = mod.FindUIWidgetWithName("TeamOpponentScore" + p.id);
  p.friendlyScorePadWidget = null as any;
  p.opponentScorePadWidget = null as any;
  p.bombCarrierTextWidget = mod.FindUIWidgetWithName(BOMB_CARRIER_WIDGET_NAME_PREFIX + p.id);
  p.bombNoticeContainerWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id);
  p.bombNoticeTextWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id);
  p.nextKeyUnlockContainerWidget = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + p.id);
  p.nextKeyUnlockTextWidget = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + p.id);
  p.bombCarrierUiLastVisible = false;
  p.bombCarrierUiLastVersion = -1;
  p.bombCarrierUiLastAlphaBucket = -1;
  p.bombNoticeUiLastStateKey = "";
  p.nextKeyUnlockHudLastStateKey = "";
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
  if (force || !p.nextKeyUnlockTextWidget) {
    p.nextKeyUnlockTextWidget = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + p.id);
  }
  if (force || !p.nextKeyUnlockContainerWidget) {
    p.nextKeyUnlockContainerWidget = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + p.id);
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
  p.deployObjectiveTimerRootWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerRootWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerPanelWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerPanelWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneFillWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneFillWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneTextWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneTextWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineTopWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineBottomWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineLeftWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerLaneOutlineRightWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerTitleWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerTitleWidgetName(playerId)) ?? null as any;
  p.deployObjectiveTimerValueWidget = mod.FindUIWidgetWithName(getDeployObjectiveTimerValueWidgetName(playerId)) ?? null as any;
}

function setTopScoreWidgetDepthForPlayer(playerId: number): void {
  const names = [
    getPlayerLiveHudRootWidgetName(playerId),
    "TeamFriendlyScore" + playerId,
    "TeamOpponentScore" + playerId,
    "FriendlyScorePulse" + playerId,
    "EnemyScorePulse" + playerId,
    BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId,
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
  const liveHudRoot = mod.FindUIWidgetWithName(getPlayerLiveHudRootWidgetName(playerId));
  const friendlyScore = mod.FindUIWidgetWithName("TeamFriendlyScore" + playerId);
  const enemyScore = mod.FindUIWidgetWithName("TeamOpponentScore" + playerId);
  const friendlyPulse = mod.FindUIWidgetWithName("FriendlyScorePulse" + playerId);
  const enemyPulse = mod.FindUIWidgetWithName("EnemyScorePulse" + playerId);
  const bombCarrier = mod.FindUIWidgetWithName(BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId);
  const bombNoticeContainer = mod.FindUIWidgetWithName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  const bombNotice = mod.FindUIWidgetWithName(BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId);
  const nextKeyUnlockContainer = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  const nextKeyUnlock = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId);

  if (
    !liveHudRoot ||
    !friendlyScore ||
    !enemyScore ||
    !friendlyPulse ||
    !enemyPulse ||
    !bombCarrier ||
    !bombNoticeContainer ||
    !bombNotice ||
    !nextKeyUnlockContainer ||
    !nextKeyUnlock
  ) {
    return false;
  }

  return true;
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
  safeDeleteWidgetByName(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName("Text_BombDroppedDeath" + playerId);
  safeDeleteWidgetByName(getPlayerLiveHudRootWidgetName(playerId));

  const uiRoot = mod.GetUIRoot();
  if (!uiRoot) return false;

  mod.AddUIContainer(
    getPlayerLiveHudRootWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    SAFE_UI_ROOT_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    p.player
  );

  const liveHudRoot = mod.FindUIWidgetWithName(getPlayerLiveHudRootWidgetName(playerId));
  if (!liveHudRoot) return false;

  const team = mod.GetTeam(p.player);
  const friendly = getFriendlyScore(team);
  const enemy = getOpponentScore(team);

  mod.AddUIText(
    "TeamFriendlyScore" + playerId,
    LIVE_HUD_FRIENDLY_SCORE_POS,
    LIVE_HUD_SCORE_SIZE,
    mod.UIAnchor.Center,
    liveHudRoot,
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
    mod.UIAnchor.Center,
    liveHudRoot,
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
    mod.UIAnchor.Center,
    liveHudRoot,
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
    mod.UIAnchor.Center,
    liveHudRoot,
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
    mod.UIAnchor.Center,
    liveHudRoot,
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
    liveHudRoot,
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
    liveHudRoot,
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

  mod.AddUIContainer(
    NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_WIDGET_POS,
    NEXT_KEY_UNLOCK_CONTAINER_SIZE,
    mod.UIAnchor.Center,
    liveHudRoot,
    false,
    0,
    NEXT_KEY_UNLOCK_WIDGET_BG_COLOR,
    0.5,
    mod.UIBgFill.Blur,
    p.player
  );

  mod.AddUIText(
    NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_WIDGET_POS,
    NEXT_KEY_UNLOCK_WIDGET_SIZE,
    mod.UIAnchor.Center,
    liveHudRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE,
    NEXT_KEY_UNLOCK_WIDGET_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  bindPlayerTopScoreWidgetRefs(p);
  setTopScoreWidgetDepthForPlayer(playerId);
  refreshBombNoticeUiForPlayer(p);
  refreshNextKeyUnlockHudForPlayer(p, undefined, true);

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

function getCipherAdminRootWidgetName(playerId: number): string {
  return CIPHER_ADMIN_PANEL_ROOT_PREFIX + playerId;
}

function getCipherAdminPanelWidgetName(playerId: number): string {
  return CIPHER_ADMIN_PANEL_PANEL_PREFIX + playerId;
}

function getCipherAdminTitleWidgetName(playerId: number): string {
  return CIPHER_ADMIN_PANEL_TITLE_PREFIX + playerId;
}

function getCipherAdminStatusWidgetName(playerId: number): string {
  return CIPHER_ADMIN_PANEL_STATUS_PREFIX + playerId;
}

function getCipherAdminActionCountWidgetName(playerId: number): string {
  return CIPHER_ADMIN_PANEL_ACTION_COUNT_PREFIX + playerId;
}

function getCipherAdminButtonWidgetName(playerId: number, action: CipherAdminAction): string {
  return CIPHER_ADMIN_BUTTON_PREFIX + action + "_" + playerId;
}

function getCipherAdminButtonLabelWidgetName(playerId: number, action: CipherAdminAction): string {
  return CIPHER_ADMIN_BUTTON_LABEL_PREFIX + action + "_" + playerId;
}

function getCipherAdminButtonBorderWidgetName(playerId: number, action: CipherAdminAction): string {
  return getCipherAdminButtonWidgetName(playerId, action) + "_BORDER";
}

function getCipherAdminActions(): CipherAdminAction[] {
  return [
    "t1_dec",
    "t1_inc",
    "t2_dec",
    "t2_inc",
    "time_dec",
    "time_inc",
    "expire_timer",
    "reset_timer",
    "force_half1",
    "force_half2",
    "start_sudden_death",
    "restart_prematch",
    "end_match",
    "toggle_bots",
    "clear_bots",
    "force_bot_reconcile",
    "close",
    "close_x",
  ];
}

function getCipherAdminToggleBotsLabelKey(): any {
  return cipherRuntimeBotsEnabled
    ? (mod.stringkeys as any).CipherAdminButtonToggleBotsOff
    : (mod.stringkeys as any).CipherAdminButtonToggleBotsOn;
}

function isCipherHumanServerPlayer(p: Player | undefined): boolean {
  if (!p || !mod.IsPlayerValid(p.player)) return false;
  if (isCipherRuntimeBotPlayerId(p.id)) return false;
  if (isBotBackfillPlayerSafe(p.player)) return false;
  return true;
}

function ensureCipherAdminAssigned(): void {
  if (cipherAdminPlayerId !== undefined) {
    const existing = serverPlayers.get(cipherAdminPlayerId);
    if (isCipherHumanServerPlayer(existing)) return;
  }

  cipherAdminPlayerId = undefined;
  serverPlayers.forEach((p) => {
    if (cipherAdminPlayerId !== undefined) return;
    if (!isCipherHumanServerPlayer(p)) return;
    cipherAdminPlayerId = p.id;
  });
}

function assignCipherAdminFromJoiningPlayerIfNeeded(player: mod.Player): void {
  const playerId = getPlayerIdSafe(player);
  if (playerId === undefined) return;
  if (isCipherRuntimeBotPlayerId(playerId)) return;
  if (isBotBackfillPlayerSafe(player)) return;
  if (cipherAdminPlayerId === undefined) cipherAdminPlayerId = playerId;
  ensureCipherAdminAssigned();
}

function isCipherAdminPlayer(player: mod.Player): boolean {
  ensureCipherAdminAssigned();
  const playerId = getPlayerIdSafe(player);
  return playerId !== undefined && cipherAdminPlayerId === playerId;
}

function getCipherAdminStatusStringKey(hasClock: boolean): any {
  if (gameStatus === -1) {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusNotStarted
      : (mod.stringkeys as any).CipherAdminStatusNotStartedNoClock;
  }
  if (gameStatus === 0) {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusPrematch
      : (mod.stringkeys as any).CipherAdminStatusPrematchNoClock;
  }
  if (gameStatus === 1) {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusCountdown
      : (mod.stringkeys as any).CipherAdminStatusCountdownNoClock;
  }
  if (gameStatus === 2) {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusPrelive
      : (mod.stringkeys as any).CipherAdminStatusPreliveNoClock;
  }
  if (gameStatus === 4) {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusPostmatch
      : (mod.stringkeys as any).CipherAdminStatusPostmatchNoClock;
  }
  if (cipherMatchStage === "suddenDeath") {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusSuddenDeath
      : (mod.stringkeys as any).CipherAdminStatusSuddenDeathNoClock;
  }
  if (cipherCurrentHalf === 1) {
    return hasClock
      ? (mod.stringkeys as any).CipherAdminStatusHalf1
      : (mod.stringkeys as any).CipherAdminStatusHalf1NoClock;
  }
  return hasClock
    ? (mod.stringkeys as any).CipherAdminStatusHalf2
    : (mod.stringkeys as any).CipherAdminStatusHalf2NoClock;
}

function getCipherAdminCurrentClockRemainingSeconds(nowSec: number): number | undefined {
  if (isCipherLiveTransitionActive()) {
    return mod.Max(0, cipherTransitionCountdownSeconds);
  }

  if (gameStatus === 3) {
    return getLiveClockRemainingSeconds(nowSec);
  }

  if (gameStatus === 4 && phaseCountdownDeadlineAtSec > 0) {
    return mod.Max(0, phaseCountdownDeadlineAtSec - nowSec);
  }

  if (gameStatus === 1 || gameStatus === 2 || gameStatus === 4 || gameStatus === 0 || gameStatus === -1) {
    if (Number.isFinite(countDown) && countDown >= 0) return countDown;
  }

  return undefined;
}

function getCipherAdminStatusLabel(): any {
  const nowSec = getCurrentSchedulerNowSeconds();
  const remaining = getCipherAdminCurrentClockRemainingSeconds(nowSec);
  const key = getCipherAdminStatusStringKey(remaining !== undefined);
  if (remaining === undefined) {
    return mod.Message(key, serverScores[0], serverScores[1]);
  }
  return mod.Message(key, serverScores[0], serverScores[1], mod.Max(0, mod.Ceiling(remaining)));
}

function refreshCipherAdminPanelForPlayerId(playerId: number): void {
  if (cipherAdminPanelVisibleByPlayerId[playerId] !== true) return;
  SafeSetTextLabelByName(getCipherAdminStatusWidgetName(playerId), getCipherAdminStatusLabel());
  SafeSetTextLabelByName(
    getCipherAdminActionCountWidgetName(playerId),
    mod.Message((mod.stringkeys as any).CipherAdminActionCount, cipherAdminActionCount)
  );
  SafeSetTextLabelByName(
    getCipherAdminButtonLabelWidgetName(playerId, "toggle_bots"),
    mod.Message(getCipherAdminToggleBotsLabelKey())
  );
}

function refreshCipherAdminPanels(): void {
  for (const playerIdKey in cipherAdminPanelVisibleByPlayerId) {
    refreshCipherAdminPanelForPlayerId(Number(playerIdKey));
  }
}

function enableCipherAdminButtonEvents(widget: mod.UIWidget | undefined | null, enabled: boolean): void {
  if (!widget) return;
  try {
    mod.EnableUIButtonEvent(widget, mod.UIButtonEvent.ButtonDown, enabled);
    mod.EnableUIButtonEvent(widget, mod.UIButtonEvent.ButtonUp, enabled);
    mod.EnableUIButtonEvent(widget, mod.UIButtonEvent.FocusIn, false);
    mod.EnableUIButtonEvent(widget, mod.UIButtonEvent.FocusOut, false);
    mod.EnableUIButtonEvent(widget, mod.UIButtonEvent.HoverIn, false);
    mod.EnableUIButtonEvent(widget, mod.UIButtonEvent.HoverOut, false);
  } catch (_err) {}
}

function disableCipherAdminButtonEventsForPlayerId(playerId: number): void {
  const actions = getCipherAdminActions();
  for (let i = 0; i < actions.length; i++) {
    try {
      enableCipherAdminButtonEvents(mod.FindUIWidgetWithName(getCipherAdminButtonWidgetName(playerId, actions[i])), false);
    } catch (_err) {}
  }
}

function deleteCipherAdminPanelForPlayerId(playerId: number): void {
  const actions = getCipherAdminActions();
  for (let i = 0; i < actions.length; i++) {
    safeDeleteAllWidgetsByName(getCipherAdminButtonLabelWidgetName(playerId, actions[i]));
    safeDeleteAllWidgetsByName(getCipherAdminButtonWidgetName(playerId, actions[i]));
    safeDeleteAllWidgetsByName(getCipherAdminButtonBorderWidgetName(playerId, actions[i]));
  }
  safeDeleteAllWidgetsByName(getCipherAdminActionCountWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherAdminStatusWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherAdminTitleWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherAdminPanelWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherAdminRootWidgetName(playerId));
}

function clearCipherAdminPanelDeleteTimerForPlayerId(playerId: number): void {
  const handle = cipherAdminPanelDeleteTimerByPlayerId[playerId];
  if (handle !== undefined) {
    Timers.clearTimeout(handle);
  }
  delete cipherAdminPanelDeleteTimerByPlayerId[playerId];
}

function clearAllCipherAdminPanelDeleteTimers(): void {
  for (const playerIdKey in cipherAdminPanelDeleteTimerByPlayerId) {
    clearCipherAdminPanelDeleteTimerForPlayerId(Number(playerIdKey));
  }
  cipherAdminPanelDeleteTimerByPlayerId = {};
}

function deleteCipherAdminPanelForPlayerIdDeferred(playerId: number, expectedToken: number): void {
  clearCipherAdminPanelDeleteTimerForPlayerId(playerId);
  cipherAdminPanelDeleteTimerByPlayerId[playerId] = Timers.setTimeout(() => {
    if (cipherAdminPanelCloseTokenByPlayerId[playerId] !== expectedToken) return;
    deleteCipherAdminPanelForPlayerId(playerId);
    delete cipherAdminPanelDeletingByPlayerId[playerId];
    delete cipherAdminPanelDeleteTimerByPlayerId[playerId];
  }, CIPHER_ADMIN_DEFERRED_DELETE_DELAY_SECONDS * 1000);
}

function closeCipherAdminPanelForPlayerId(playerId: number, deleteImmediately: boolean = false): void {
  const token = (cipherAdminPanelCloseTokenByPlayerId[playerId] ?? 0) + 1;
  cipherAdminPanelCloseTokenByPlayerId[playerId] = token;
  delete cipherAdminPanelVisibleByPlayerId[playerId];
  resetCipherAdminPrimaryClickTrackerForPlayerId(playerId);
  disableCipherAdminButtonEventsForPlayerId(playerId);

  let root: mod.UIWidget | undefined = undefined;
  try {
    root = mod.FindUIWidgetWithName(getCipherAdminRootWidgetName(playerId));
  } catch (_errFindRoot) {}
  if (root) {
    try {
      mod.SetUIWidgetVisible(root, false);
    } catch (_err) {}
  }

  const sp = serverPlayers.get(playerId);
  if (sp && mod.IsPlayerValid(sp.player)) {
    try {
      mod.EnableUIInputMode(false, sp.player);
    } catch (_err) {}
  }

  if (deleteImmediately) {
    clearCipherAdminPanelDeleteTimerForPlayerId(playerId);
    deleteCipherAdminPanelForPlayerId(playerId);
    delete cipherAdminPanelDeletingByPlayerId[playerId];
    return;
  }

  cipherAdminPanelDeletingByPlayerId[playerId] = true;
  deleteCipherAdminPanelForPlayerIdDeferred(playerId, token);
}

function forceDeleteCipherAdminPanelForPlayerId(playerId: number): void {
  cipherAdminPanelCloseTokenByPlayerId[playerId] = (cipherAdminPanelCloseTokenByPlayerId[playerId] ?? 0) + 1;
  clearCipherAdminPanelDeleteTimerForPlayerId(playerId);
  resetCipherAdminPrimaryClickTrackerForPlayerId(playerId);
  deleteCipherAdminPanelForPlayerId(playerId);
  delete cipherAdminPanelVisibleByPlayerId[playerId];
  delete cipherAdminPanelDeletingByPlayerId[playerId];
  const sp = serverPlayers.get(playerId);
  if (sp && mod.IsPlayerValid(sp.player)) {
    try {
      mod.EnableUIInputMode(false, sp.player);
    } catch (_err) {}
  }
}

function closeCipherAdminPanelsForAllPlayers(): void {
  for (const playerIdKey in cipherAdminPanelVisibleByPlayerId) {
    closeCipherAdminPanelForPlayerId(Number(playerIdKey));
  }
}

function forceDeleteCipherAdminPanelsForAllPlayers(): void {
  const playerIdsByKey: { [playerId: number]: boolean } = {};
  for (const playerIdKey in cipherAdminPanelVisibleByPlayerId) {
    playerIdsByKey[Number(playerIdKey)] = true;
  }
  for (const playerIdKey in cipherAdminPanelDeleteTimerByPlayerId) {
    playerIdsByKey[Number(playerIdKey)] = true;
  }
  for (const playerIdKey in playerIdsByKey) {
    forceDeleteCipherAdminPanelForPlayerId(Number(playerIdKey));
  }
  clearAllCipherAdminPanelDeleteTimers();
}

function clearCipherAdminInteractPoint(context: string): void {
  cipherAdminInteractToken += 1;
  if (cipherAdminInteractObject) {
    unspawnObjectSafe(cipherAdminInteractObject, context, false);
  } else if (cipherAdminInteractPoint) {
    try {
      mod.EnableInteractPoint(cipherAdminInteractPoint, false);
    } catch (_errDisableInteract) {}
    unspawnObjectSafe(cipherAdminInteractPoint as unknown, context, false);
  }
  cipherAdminInteractObject = undefined;
  cipherAdminInteractPoint = undefined;
  cipherAdminInteractObjId = -1;
}

function clearCipherAdminRuntimeState(context: string): void {
  forceDeleteCipherAdminPanelsForAllPlayers();
  clearCipherAdminInteractPoint(context);
  cipherAdminButtonLastHandledTickByKey = {};
  cipherAdminPrimaryClickByPlayerId = {};
}

function enableCipherAdminInteractPointById(interactId: number, enabled: boolean): void {
  if (!(interactId > 0)) return;
  try {
    mod.EnableInteractPoint(mod.GetInteractPoint(interactId), enabled);
  } catch (_err) {}
}

type CipherAdminInteractSpawnResult = {
  object?: mod.Object;
  interactPoint?: mod.InteractPoint;
  objId: number;
  reason: string;
};

function resolveCipherAdminInteractFromUnknown(target: unknown): CipherAdminInteractSpawnResult {
  if (target === undefined || target === null) {
    return { objId: -1, reason: "spawn_return_undefined" };
  }

  try {
    const interactPoint = target as mod.InteractPoint;
    mod.EnableInteractPoint(interactPoint, false);
    return {
      interactPoint,
      objId: getObjIdSafe(interactPoint as unknown),
      reason: "interact_point",
    };
  } catch (_errAsInteract) {}

  const objId = getObjIdSafe(target);
  if (objId > 0) {
    try {
      const interactPoint = mod.GetInteractPoint(objId);
      mod.EnableInteractPoint(interactPoint, false);
      return {
        interactPoint,
        objId,
        reason: "objid_interact_point",
      };
    } catch (_errByInteractId) {}
  }

  const resolvedObject = resolveObjectFromUnknown(target);
  if (resolvedObject.object) {
    return {
      object: resolvedObject.object,
      objId: resolvedObject.objId,
      reason: resolvedObject.reason,
    };
  }

  return {
    objId: resolvedObject.objId,
    reason: resolvedObject.reason,
  };
}

function spawnCipherAdminRuntimeInteractPoint(
  pos: mod.Vector,
  context: string
): CipherAdminInteractSpawnResult {
  let spawned: unknown = undefined;
  try {
    spawned = mod.SpawnObject(mod.RuntimeSpawn_Common.InteractPoint, pos, BOMB_DROP_ROTATION) as unknown;
  } catch (_errSpawn) {
    return { objId: -1, reason: "spawn_exception" };
  }
  return resolveCipherAdminInteractFromUnknown(spawned);
}

function getCipherAdminInteractSpawnPosition(player: mod.Player): mod.Vector | undefined {
  const pos = tryGetPlayerPositionSafe(player);
  if (!pos) return undefined;
  return mod.CreateVector(
    mod.XComponentOf(pos),
    mod.YComponentOf(pos) + CIPHER_ADMIN_INTERACT_HEIGHT_OFFSET_METERS,
    mod.ZComponentOf(pos)
  );
}

async function expireCipherAdminInteractPointAfterDelay(expectedToken: number): Promise<void> {
  await mod.Wait(CIPHER_ADMIN_INTERACT_LIFETIME_SECONDS);
  if (cipherAdminInteractToken !== expectedToken) return;
  clearCipherAdminInteractPoint("admin_interact_expired");
}

function spawnCipherAdminInteractPointForPlayer(player: mod.Player): void {
  if (!CIPHER_ADMIN_INTERACT_AUTO_SPAWN_ENABLED) {
    clearCipherAdminInteractPoint("admin_interact_auto_spawn_disabled");
    return;
  }

  if (!isCipherAdminPlayer(player)) return;
  if (!mod.IsPlayerValid(player)) return;

  const playerId = getPlayerIdSafe(player);
  if (playerId === undefined || isCipherRuntimeBotPlayerId(playerId)) return;

  const pos = getCipherAdminInteractSpawnPosition(player);
  if (!pos) return;

  clearCipherAdminInteractPoint("admin_interact_replaced");
  const spawned = spawnCipherAdminRuntimeInteractPoint(pos, "admin_interact");
  if (!(spawned.objId > 0) || (!spawned.object && !spawned.interactPoint)) return;

  cipherAdminInteractObject = spawned.object;
  cipherAdminInteractPoint = spawned.interactPoint;
  cipherAdminInteractObjId = spawned.objId;
  if (cipherAdminInteractPoint) {
    try {
      mod.EnableInteractPoint(cipherAdminInteractPoint, true);
    } catch (_errEnableDirect) {
      enableCipherAdminInteractPointById(cipherAdminInteractObjId, true);
    }
  } else {
    enableCipherAdminInteractPointById(cipherAdminInteractObjId, true);
  }
  cipherAdminInteractToken += 1;
  void expireCipherAdminInteractPointAfterDelay(cipherAdminInteractToken);
}

async function spawnCipherAdminInteractPointForPlayerAfterDelay(
  playerId: number,
  expectedToken: number,
  delaySeconds: number,
  context: string
): Promise<void> {
  if (delaySeconds > 0) await mod.Wait(delaySeconds);
  if (cipherAdminInteractSpawnTokenByPlayerId[playerId] !== expectedToken) return;
  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;
  if (!sp.isDeployed) return;
  if (!isPlayerAliveSafe(sp.player)) return;
  if (!isCipherAdminPlayer(sp.player)) return;
  spawnCipherAdminInteractPointForPlayer(sp.player);
  void context;
}

function queueCipherAdminInteractSpawnForPlayer(playerId: number, context: string): void {
  if (!CIPHER_ADMIN_INTERACT_AUTO_SPAWN_ENABLED) {
    cipherAdminInteractSpawnTokenByPlayerId[playerId] = (cipherAdminInteractSpawnTokenByPlayerId[playerId] ?? 0) + 1;
    clearCipherAdminInteractPoint(context + "_admin_interact_auto_spawn_disabled");
    return;
  }

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;
  if (!isCipherAdminPlayer(sp.player)) return;
  if (isCipherRuntimeBotPlayerId(playerId)) return;

  const token = (cipherAdminInteractSpawnTokenByPlayerId[playerId] ?? 0) + 1;
  cipherAdminInteractSpawnTokenByPlayerId[playerId] = token;
  void spawnCipherAdminInteractPointForPlayerAfterDelay(playerId, token, 0.15, context + "_015");
  void spawnCipherAdminInteractPointForPlayerAfterDelay(playerId, token, 0.5, context + "_050");
  void spawnCipherAdminInteractPointForPlayerAfterDelay(playerId, token, 1.0, context + "_100");
}

function isCipherAdminInteractPointId(interactId: number): boolean {
  return cipherAdminInteractObjId > 0 && interactId === cipherAdminInteractObjId;
}

function tickCipherAdminInteractFallback(nowSec: number): void {
  if (!CIPHER_ADMIN_INTERACT_AUTO_SPAWN_ENABLED) {
    if (cipherAdminInteractObjId > 0 || cipherAdminInteractPoint || cipherAdminInteractObject) {
      clearCipherAdminInteractPoint("admin_interact_fallback_disabled");
    }
    return;
  }

  if (nowSec < cipherAdminNextInteractFallbackAtSec) return;
  cipherAdminNextInteractFallbackAtSec = nowSec + CIPHER_ADMIN_INTERACT_FALLBACK_INTERVAL_SECONDS;
  if (cipherAdminInteractObjId > 0) return;

  ensureCipherAdminAssigned();
  if (cipherAdminPlayerId === undefined) return;

  const sp = serverPlayers.get(cipherAdminPlayerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;
  if (!sp.isDeployed) return;
  if (!isPlayerAliveSafe(sp.player)) return;
  if (!isCipherAdminPlayer(sp.player)) return;
  if (isCipherRuntimeBotPlayerId(sp.id) || isBotBackfillPlayerSafe(sp.player)) return;

  queueCipherAdminInteractSpawnForPlayer(sp.id, "admin_interact_fallback");
}

function addCipherAdminButton(
  player: mod.Player,
  playerId: number,
  parent: mod.UIWidget,
  action: CipherAdminAction,
  pos: mod.Vector,
  labelKey: any,
  wide: boolean = false,
  sizeOverride?: mod.Vector,
  textSize: number = CIPHER_ADMIN_BUTTON_TEXT_SIZE
): void {
  const buttonName = getCipherAdminButtonWidgetName(playerId, action);
  const labelName = getCipherAdminButtonLabelWidgetName(playerId, action);
  const borderName = getCipherAdminButtonBorderWidgetName(playerId, action);
  const size = sizeOverride ?? (wide ? CIPHER_ADMIN_WIDE_BUTTON_SIZE : CIPHER_ADMIN_BUTTON_SIZE);
  const borderSize = mod.Add(
    size,
    mod.CreateVector(CIPHER_ADMIN_BUTTON_BORDER_PADDING * 2, CIPHER_ADMIN_BUTTON_BORDER_PADDING * 2, 0)
  );

  mod.AddUIContainer(
    borderName,
    pos,
    borderSize,
    mod.UIAnchor.Center,
    parent,
    true,
    0,
    CIPHER_ADMIN_PANEL_ACCENT_COLOR,
    0.85,
    mod.UIBgFill.OutlineThin,
    mod.UIDepth.AboveGameUI,
    player
  );

  const border = mod.FindUIWidgetWithName(borderName);
  const buttonParent = border ?? parent;
  const childPosition = border ? mod.CreateVector(0, 0, 0) : pos;

  mod.AddUIButton(
    buttonName,
    childPosition,
    size,
    mod.UIAnchor.Center,
    buttonParent,
    true,
    0,
    CIPHER_ADMIN_BUTTON_BASE_COLOR,
    0.92,
    mod.UIBgFill.Solid,
    true,
    CIPHER_ADMIN_BUTTON_BASE_COLOR,
    0.92,
    CIPHER_ADMIN_BUTTON_DISABLED_COLOR,
    0.5,
    CIPHER_ADMIN_BUTTON_PRESSED_COLOR,
    0.45,
    CIPHER_ADMIN_BUTTON_HOVER_COLOR,
    0.95,
    CIPHER_ADMIN_BUTTON_HOVER_COLOR,
    0.95,
    mod.UIDepth.AboveGameUI,
    player
  );

  const button = mod.FindUIWidgetWithName(buttonName);
  if (button && border) {
    try {
      mod.SetUIWidgetParent(button, border);
      mod.SetUIWidgetPosition(button, mod.CreateVector(0, 0, 0));
    } catch (_errParentButton) {}
  }

  mod.AddUIText(
    labelName,
    childPosition,
    size,
    mod.UIAnchor.Center,
    buttonParent,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(labelKey),
    textSize,
    CIPHER_ADMIN_BUTTON_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    player
  );

  const label = mod.FindUIWidgetWithName(labelName);
  if (label && border) {
    try {
      mod.SetUIWidgetParent(label, border);
      mod.SetUIWidgetPosition(label, mod.CreateVector(0, 0, 0));
      mod.SetUIWidgetSize(label, size);
      mod.SetUITextAnchor(label, mod.UIAnchor.Center);
    } catch (_errParentLabel) {}
  }

  enableCipherAdminButtonEvents(mod.FindUIWidgetWithName(buttonName), true);
  SafeSetWidgetDepthHandle(mod.FindUIWidgetWithName(borderName), mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(mod.FindUIWidgetWithName(buttonName), mod.UIDepth.AboveGameUI);
  SafeSetWidgetDepthHandle(mod.FindUIWidgetWithName(labelName), mod.UIDepth.AboveGameUI);
}

function openCipherAdminPanelForPlayer(player: mod.Player): void {
  if (!isCipherAdminPlayer(player)) return;
  const playerId = getPlayerIdSafe(player);
  if (playerId === undefined) return;

  forceDeleteCipherAdminPanelForPlayerId(playerId);
  cipherAdminPanelCloseTokenByPlayerId[playerId] = (cipherAdminPanelCloseTokenByPlayerId[playerId] ?? 0) + 1;

  const uiRoot = mod.GetUIRoot();
  if (!uiRoot) return;

  mod.AddUIContainer(
    getCipherAdminRootWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    SAFE_UI_ROOT_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.UIDepth.AboveGameUI,
    player
  );

  const root = mod.FindUIWidgetWithName(getCipherAdminRootWidgetName(playerId));
  if (!root) return;

  mod.AddUIContainer(
    getCipherAdminPanelWidgetName(playerId),
    CIPHER_ADMIN_PANEL_POS,
    CIPHER_ADMIN_PANEL_SIZE,
    mod.UIAnchor.Center,
    root,
    true,
    0,
    CIPHER_ADMIN_PANEL_BG_COLOR,
    0.82,
    mod.UIBgFill.Solid,
    mod.UIDepth.AboveGameUI,
    player
  );

  const panel = mod.FindUIWidgetWithName(getCipherAdminPanelWidgetName(playerId));
  if (!panel) return;

  mod.AddUIText(
    getCipherAdminTitleWidgetName(playerId),
    mod.CreateVector(0, -242, 0),
    mod.CreateVector(500, 36, 0),
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message((mod.stringkeys as any).CipherAdminTitle),
    CIPHER_ADMIN_TITLE_TEXT_SIZE,
    CIPHER_ADMIN_PANEL_ACCENT_COLOR,
    1,
    mod.UIAnchor.Center,
    player
  );

  mod.AddUIText(
    getCipherAdminStatusWidgetName(playerId),
    mod.CreateVector(0, -208, 0),
    mod.CreateVector(500, 30, 0),
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    getCipherAdminStatusLabel(),
    CIPHER_ADMIN_STATUS_TEXT_SIZE,
    CIPHER_ADMIN_BUTTON_TEXT_COLOR,
    1,
    mod.UIAnchor.Center,
    player
  );

  mod.AddUIText(
    getCipherAdminActionCountWidgetName(playerId),
    mod.CreateVector(0, -184, 0),
    mod.CreateVector(500, 24, 0),
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message((mod.stringkeys as any).CipherAdminActionCount, cipherAdminActionCount),
    14,
    CIPHER_ADMIN_BUTTON_TEXT_COLOR,
    0.85,
    mod.UIAnchor.Center,
    player
  );

  addCipherAdminButton(
    player,
    playerId,
    panel,
    "close_x",
    mod.CreateVector(276, -244, 0),
    (mod.stringkeys as any).CipherAdminButtonCloseX,
    false,
    CIPHER_ADMIN_CLOSE_X_BUTTON_SIZE,
    20
  );
  addCipherAdminButton(player, playerId, panel, "t1_dec", mod.CreateVector(-145, -146, 0), (mod.stringkeys as any).CipherAdminButtonT1Dec, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "t1_inc", mod.CreateVector(145, -146, 0), (mod.stringkeys as any).CipherAdminButtonT1Inc, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "t2_dec", mod.CreateVector(-145, -108, 0), (mod.stringkeys as any).CipherAdminButtonT2Dec, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "t2_inc", mod.CreateVector(145, -108, 0), (mod.stringkeys as any).CipherAdminButtonT2Inc, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "time_dec", mod.CreateVector(-145, -70, 0), (mod.stringkeys as any).CipherAdminButtonTimeDec, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "time_inc", mod.CreateVector(145, -70, 0), (mod.stringkeys as any).CipherAdminButtonTimeInc, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "expire_timer", mod.CreateVector(-145, -32, 0), (mod.stringkeys as any).CipherAdminButtonExpireTimer, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "reset_timer", mod.CreateVector(145, -32, 0), (mod.stringkeys as any).CipherAdminButtonResetTimer, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "force_half1", mod.CreateVector(-145, 6, 0), (mod.stringkeys as any).CipherAdminButtonForceHalf1, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "force_half2", mod.CreateVector(145, 6, 0), (mod.stringkeys as any).CipherAdminButtonForceHalf2, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "start_sudden_death", mod.CreateVector(-145, 44, 0), (mod.stringkeys as any).CipherAdminButtonStartSuddenDeath, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "restart_prematch", mod.CreateVector(145, 44, 0), (mod.stringkeys as any).CipherAdminButtonRestartPrematch, false, CIPHER_ADMIN_GRID_BUTTON_SIZE, 13);
  addCipherAdminButton(player, playerId, panel, "end_match", mod.CreateVector(-145, 82, 0), (mod.stringkeys as any).CipherAdminButtonEndMatch, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "toggle_bots", mod.CreateVector(145, 82, 0), getCipherAdminToggleBotsLabelKey(), false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "clear_bots", mod.CreateVector(-145, 120, 0), (mod.stringkeys as any).CipherAdminButtonClearBots, false, CIPHER_ADMIN_GRID_BUTTON_SIZE);
  addCipherAdminButton(player, playerId, panel, "force_bot_reconcile", mod.CreateVector(145, 120, 0), (mod.stringkeys as any).CipherAdminButtonForceBotReconcile, false, CIPHER_ADMIN_GRID_BUTTON_SIZE, 13);
  addCipherAdminButton(player, playerId, panel, "close", mod.CreateVector(0, 220, 0), (mod.stringkeys as any).CipherAdminButtonClose, true, mod.CreateVector(540, 34, 0));

  cipherAdminPanelVisibleByPlayerId[playerId] = true;
  try {
    mod.EnableUIInputMode(true, player);
  } catch (_err) {}
  refreshCipherAdminPanelForPlayerId(playerId);
}

function parseCipherAdminActionFromWidgetName(widgetName: string, playerId: number): CipherAdminAction | undefined {
  const suffix = "_" + String(playerId);
  const prefix = CIPHER_ADMIN_BUTTON_PREFIX;
  if (widgetName.indexOf(prefix) !== 0) return undefined;
  if (widgetName.lastIndexOf(suffix) !== widgetName.length - suffix.length) return undefined;

  const rawAction = widgetName.substring(prefix.length, widgetName.length - suffix.length);
  const actions = getCipherAdminActions();
  for (let i = 0; i < actions.length; i++) {
    if (rawAction === actions[i]) return actions[i];
  }
  return undefined;
}

function getUiWidgetNameSafe(widget: mod.UIWidget): string {
  try {
    return mod.GetUIWidgetName(widget);
  } catch (_err) {
    return "";
  }
}

function resetCipherAdminPrimaryClickTrackerForPlayerId(playerId: number): void {
  delete cipherAdminPrimaryClickByPlayerId[playerId];
}

function isCipherAdminPrimaryClickEvent(eventUIButtonEvent: mod.UIButtonEvent): boolean {
  return (
    mod.Equals(eventUIButtonEvent, mod.UIButtonEvent.ButtonDown) ||
    mod.Equals(eventUIButtonEvent, mod.UIButtonEvent.ButtonUp)
  );
}

function getCipherAdminPrimaryClickPhase(eventUIButtonEvent: mod.UIButtonEvent): CipherAdminPrimaryClickPhase {
  return mod.Equals(eventUIButtonEvent, mod.UIButtonEvent.ButtonDown) ? "down" : "up";
}

function getCipherAdminClickTimeSeconds(): number {
  try {
    return mod.GetMatchTimeElapsed();
  } catch (_err) {
    return getCurrentSchedulerNowSeconds();
  }
}

function tryConsumeCipherAdminPrimaryClickEvent(
  playerId: number,
  widgetName: string,
  eventUIButtonEvent: mod.UIButtonEvent
): boolean {
  if (!isCipherAdminPrimaryClickEvent(eventUIButtonEvent)) return false;

  const nowSec = getCipherAdminClickTimeSeconds();
  const phase = getCipherAdminPrimaryClickPhase(eventUIButtonEvent);
  const prior = cipherAdminPrimaryClickByPlayerId[playerId];

  if (prior && prior.widgetName === widgetName) {
    if (
      prior.phase === "down" &&
      phase === "up" &&
      nowSec - prior.atSeconds <= CIPHER_ADMIN_PRIMARY_CLICK_RELEASE_GRACE_SECONDS
    ) {
      resetCipherAdminPrimaryClickTrackerForPlayerId(playerId);
      return false;
    }

    if (
      prior.phase === phase &&
      nowSec - prior.atSeconds <= CIPHER_ADMIN_PRIMARY_CLICK_DEBOUNCE_SECONDS
    ) {
      return false;
    }
  }

  cipherAdminPrimaryClickByPlayerId[playerId] = { widgetName, atSeconds: nowSec, phase };
  return true;
}

function isCipherAdminButtonDebounced(playerId: number, action: CipherAdminAction): boolean {
  const key = String(playerId) + ":" + action;
  const last = cipherAdminButtonLastHandledTickByKey[key];
  if (last !== undefined && serverTickCount - last < CIPHER_ADMIN_BUTTON_DEBOUNCE_TICKS) return true;
  cipherAdminButtonLastHandledTickByKey[key] = serverTickCount;
  return false;
}

function getCipherAdminScoreTeam(action: CipherAdminAction): mod.Team {
  if (action === "t1_dec" || action === "t1_inc") return team1;
  if (action === "t2_dec" || action === "t2_inc") return team2;
  return teamNeutral;
}

function syncCipherAdminActionEffects(context: string): void {
  const nowSec = getCurrentSchedulerNowSeconds();
  UpdateScoreboard();
  SetUIScores();
  SetUITime(nowSec);
  UpdateTopFlagColorsForAllPlayers();
  updateCipherCounterWorldIcons(true);
  if (gameStatus === 3 && initialization[3] === true && !isCipherLiveTransitionActive()) {
    syncLiveHybridObjectiveSurfaceState(context, true);
    scheduleDelayedObjectiveSurfaceReassert(context);
  }
  refreshCipherAdminPanels();
}

function getCipherAdminActionLogKey(action: CipherAdminAction): any {
  if (action === "t1_dec") return (mod.stringkeys as any).CipherAdminActionLogT1Dec;
  if (action === "t1_inc") return (mod.stringkeys as any).CipherAdminActionLogT1Inc;
  if (action === "t2_dec") return (mod.stringkeys as any).CipherAdminActionLogT2Dec;
  if (action === "t2_inc") return (mod.stringkeys as any).CipherAdminActionLogT2Inc;
  if (action === "time_dec") return (mod.stringkeys as any).CipherAdminActionLogTimeDec;
  if (action === "time_inc") return (mod.stringkeys as any).CipherAdminActionLogTimeInc;
  if (action === "expire_timer") return (mod.stringkeys as any).CipherAdminActionLogExpireTimer;
  if (action === "reset_timer") return (mod.stringkeys as any).CipherAdminActionLogResetTimer;
  if (action === "force_half1") return (mod.stringkeys as any).CipherAdminActionLogForceHalf1;
  if (action === "force_half2") return (mod.stringkeys as any).CipherAdminActionLogForceHalf2;
  if (action === "start_sudden_death") return (mod.stringkeys as any).CipherAdminActionLogStartSuddenDeath;
  if (action === "restart_prematch") return (mod.stringkeys as any).CipherAdminActionLogRestartPrematch;
  if (action === "end_match") return (mod.stringkeys as any).CipherAdminActionLogEndMatch;
  if (action === "toggle_bots") return (mod.stringkeys as any).CipherAdminActionLogToggleBots;
  if (action === "clear_bots") return (mod.stringkeys as any).CipherAdminActionLogClearBots;
  if (action === "force_bot_reconcile") return (mod.stringkeys as any).CipherAdminActionLogForceBotReconcile;
  return undefined;
}

function recordCipherAdminAction(player: mod.Player, action: CipherAdminAction): void {
  cipherAdminActionCount += 1;
  const key = getCipherAdminActionLogKey(action);
  if (key === undefined || key === null) return;
  try {
    mod.DisplayHighlightedWorldLogMessage(mod.Message(key, player));
  } catch (_err) {}
}

function applyCipherAdminScoreAdjustment(action: CipherAdminAction): boolean {
  const team = getCipherAdminScoreTeam(action);
  const scoreIndex = getCipherTeamScoreIndex(team);
  if (scoreIndex < 0) return false;

  const delta = action === "t1_inc" || action === "t2_inc" ? 1 : -1;
  const previousScore = serverScores[scoreIndex] ?? 0;
  const previousHalfScore = cipherHalfScores[scoreIndex] ?? 0;
  serverScores[scoreIndex] = Math.max(0, Math.min(WIN_SCORE, (serverScores[scoreIndex] ?? 0) + delta));
  if (cipherMatchStage !== "suddenDeath") {
    cipherHalfScores[scoreIndex] = Math.max(0, Math.min(HALF_SCORE_CAP, (cipherHalfScores[scoreIndex] ?? 0) + delta));
  }
  if (serverScores[scoreIndex] === previousScore && cipherHalfScores[scoreIndex] === previousHalfScore) return false;

  if (gameStatus !== 3 || isCipherLiveTransitionActive()) return true;
  const outcome = resolveCipherDeliveryOutcome(team);
  beginCipherDeliveryPhaseTransition(outcome, team);
  return true;
}

function applyCipherAdminTimeAdjustment(deltaSeconds: number): boolean {
  const nowSec = getCurrentSchedulerNowSeconds();

  if (isCipherLiveTransitionActive()) {
    setCipherTransitionCountdownSeconds(mod.Max(0, cipherTransitionCountdownSeconds + deltaSeconds));
    refreshCipherTransitionHudForCurrentState();
    return true;
  }

  if (gameStatus === 3 && liveClockStarted) {
    liveClockDeadlineAtSec = Math.max(nowSec, liveClockDeadlineAtSec + deltaSeconds);
    SetUITime(nowSec);
    return true;
  }

  if (gameStatus === 0 || gameStatus === 1 || gameStatus === 2 || gameStatus === 4 || gameStatus === -1) {
    const currentRemaining = getCipherAdminCurrentClockRemainingSeconds(nowSec) ?? countDown;
    countDown = mod.Max(0, mod.Ceiling(currentRemaining + deltaSeconds));
    if (gameStatus === 4 || phaseCountdownDeadlineAtSec > 0) {
      phaseCountdownDeadlineAtSec = nowSec + countDown;
      phaseCountdownLastShownSeconds = countDown;
    }
    SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
    return true;
  }

  return true;
}

function expireCipherAdminLiveTimer(): boolean {
  const nowSec = getCurrentSchedulerNowSeconds();

  if (isCipherLiveTransitionActive()) {
    setCipherTransitionCountdownSeconds(0);
    refreshCipherTransitionHudForCurrentState();
    return true;
  }

  if (gameStatus === 3 && liveClockStarted) {
    liveClockDeadlineAtSec = nowSec;
    SetUITime(nowSec);
    resolveLiveTimeoutIfNeeded(nowSec);
    return true;
  }

  if (gameStatus === 0 || gameStatus === 1 || gameStatus === 2 || gameStatus === 4 || gameStatus === -1) {
    countDown = 0;
    if (phaseCountdownDeadlineAtSec > 0 || gameStatus === 4) {
      phaseCountdownDeadlineAtSec = nowSec;
      phaseCountdownLastShownSeconds = 0;
    }
    SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
    return true;
  }

  return true;
}

function resetCipherAdminLiveTimer(): boolean {
  const nowSec = getCurrentSchedulerNowSeconds();

  if (isCipherLiveTransitionActive()) {
    const duration =
      cipherSecondHalfTransitionStage === "deploy"
        ? CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS
        : CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS;
    setCipherTransitionCountdownSeconds(duration);
    refreshCipherTransitionHudForCurrentState();
    return true;
  }

  if (gameStatus === 3) {
    const duration = cipherMatchStage === "suddenDeath" ? OVERTIME_TIME : ROUND_TIME;
    beginScriptOwnedLiveClockPhase(duration, nowSec, false);
    return true;
  }

  let duration = COUNT_DOWN_TIME;
  if (gameStatus === 2) duration = PRELIVE_TIME;
  else if (gameStatus === 4) duration = POSTMATCH_TIME;
  countDown = duration;
  if (gameStatus === 4 || phaseCountdownDeadlineAtSec > 0) {
    phaseCountdownDeadlineAtSec = nowSec + duration;
    phaseCountdownLastShownSeconds = duration;
  }
  SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
  return true;
}

function ensureCipherAdminLiveInitialized(): boolean {
  if (gameStatus !== 3 || initialization[3] !== true) {
    gameStatus = 3;
    initialization[3] = false;
    InitializeLive();
  }
  return gameStatus === 3 && initialization[3] === true;
}

function forceCipherAdminLiveHalf(half: CipherHalfIndex): boolean {
  if (!ensureCipherAdminLiveInitialized()) return false;

  if (half === 2 && cipherCurrentHalf === 1 && !isCipherLiveTransitionActive()) {
    beginCipherSecondHalf(getCurrentSchedulerNowSeconds(), "scoreCap");
    return true;
  }

  invalidateDeferredBombSpawnTimer();
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearCipherLivePhaseTransitionRuntimeState("admin_force_half", true, true);
  hideCipherTransitionHudForAllPlayers();
  SetCountdownOverlayVisible(false);
  SafeSetWidgetVisibleByName("LiveContainer", true);

  prepareCipherHalfForLive(half, "admin_force_half", REDEPLOY_TIME);
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;
  startCipherHalfClockAndKey(half, getCurrentSchedulerNowSeconds());
  UpdateScoreboard();
  SetUIScores();
  SetUITime();
  updateCipherCounterWorldIcons(true);
  return true;
}

function startCipherAdminSuddenDeath(): boolean {
  if (!ensureCipherAdminLiveInitialized()) return false;
  invalidateDeferredBombSpawnTimer();
  beginCipherSuddenDeath(getCurrentSchedulerNowSeconds());
  return true;
}

function resetRuntimeBotSpawnerValidationState(): void {
  runtimeBotSpawnerValidationComplete = false;
  runtimeBotSpawnerValidationFailed = false;
}

function safeSendPortalLogToAdmin(source: string): void {
  try {
    const sendPortalLogToAdmin = (mod as any).SendPortalLogToAdmin as undefined | (() => void);

    if (!sendPortalLogToAdmin) {
      try {
        mod.DisplayHighlightedWorldLogMessage(
          mod.Message("[ADMIN LOG] SendPortalLogToAdmin unavailable ({})", source)
        );
      } catch (_errLogUnavailable) {}
      return;
    }

    sendPortalLogToAdmin();

    try {
      mod.DisplayHighlightedWorldLogMessage(
        mod.Message("[ADMIN LOG] Portal log sent ({})", source)
      );
    } catch (_errLogSent) {}
  } catch (err) {
    LogRuntimeError("SendPortalLogToAdmin/" + source, err);
  }
}

function clearRuntimeBotDebugPortalLogTimers(): void {
  if (runtimeBotDebugPortalLogEarlyTimer !== undefined) {
    Timers.clearTimeout(runtimeBotDebugPortalLogEarlyTimer);
  }

  if (runtimeBotDebugPortalLogLateTimer !== undefined) {
    Timers.clearTimeout(runtimeBotDebugPortalLogLateTimer);
  }

  runtimeBotDebugPortalLogEarlyTimer = undefined;
  runtimeBotDebugPortalLogLateTimer = undefined;
}

function scheduleRuntimeBotDebugPortalLogs(source: string): void {
  clearRuntimeBotDebugPortalLogTimers();

  runtimeBotDebugPortalLogToken += 1;
  const token = runtimeBotDebugPortalLogToken;

  // Pull one log after bots have had time to spawn and receive movement.
  runtimeBotDebugPortalLogEarlyTimer = Timers.setTimeout(() => {
    if (token !== runtimeBotDebugPortalLogToken) return;
    if (!cipherRuntimeBotsEnabled) return;
    safeSendPortalLogToAdmin(source + "_25s");
  }, 25000);

  // Pull one just before your reported ~1 minute crash window.
  runtimeBotDebugPortalLogLateTimer = Timers.setTimeout(() => {
    if (token !== runtimeBotDebugPortalLogToken) return;
    if (!cipherRuntimeBotsEnabled) return;
    safeSendPortalLogToAdmin(source + "_55s");
  }, 55000);
}

function setCipherRuntimeBotsEnabled(enabled: boolean, context: string): boolean {
  if (!enabled) {
    cipherRuntimeBotsEnabled = false;
    clearRuntimeBotDebugPortalLogTimers();
    clearRuntimeBotState(true);
    resetRuntimeBotSpawnerValidationState();
    refreshCipherAdminPanels();
    safeSendPortalLogToAdmin("bots_disabled_" + context);
    return true;
  }

  cipherRuntimeBotsEnabled = true;
  runtimeBotNextReconcileAtSec = 0;
  botObjectiveNextThinkAtSec = 0;
  resetRuntimeBotStagedSpawnSchedule();
  resetRuntimeBotSpawnerValidationState();

  safeSendPortalLogToAdmin("bots_enabled_" + context);
  scheduleRuntimeBotDebugPortalLogs("runtime_bots");

  if (!validateRuntimeBotSpawnersOnce()) {
    cipherRuntimeBotsEnabled = false;
    clearRuntimeBotDebugPortalLogTimers();
    clearRuntimeBotState(true);
    refreshCipherAdminPanels();
    safeSendPortalLogToAdmin("bots_enable_failed_" + context);
    return false;
  }

  reconcileRuntimeBots(getCurrentSchedulerNowSeconds());
  botObjectiveNextThinkAtSec = 0;
  refreshCipherAdminPanels();
  void context;
  return true;
}

function toggleCipherRuntimeBotsFromAdmin(context: string): boolean {
  return setCipherRuntimeBotsEnabled(!cipherRuntimeBotsEnabled, context);
}

function clearCipherRuntimeBotsFromAdmin(): boolean {
  clearRuntimeBotState(true);
  runtimeBotNextReconcileAtSec = 0;
  resetRuntimeBotStagedSpawnSchedule();
  refreshCipherAdminPanels();
  return true;
}

function forceCipherRuntimeBotReconcileFromAdmin(): boolean {
  runtimeBotNextReconcileAtSec = 0;
  botObjectiveNextThinkAtSec = 0;
  resetRuntimeBotStagedSpawnSchedule();

  if (cipherRuntimeBotsEnabled) {
    reconcileRuntimeBots(getCurrentSchedulerNowSeconds());
  }

  safeSendPortalLogToAdmin("force_bot_reconcile");
  refreshCipherAdminPanels();
  return true;
}

function executeCipherAdminAction(player: mod.Player, playerId: number, action: CipherAdminAction): void {
  try {
    if (action === "close" || action === "close_x") {
      closeCipherAdminPanelForPlayerId(playerId);
      return;
    }

    let handled = false;
    if (action === "t1_dec" || action === "t1_inc" || action === "t2_dec" || action === "t2_inc") {
      handled = applyCipherAdminScoreAdjustment(action);
    } else if (action === "time_dec") {
      handled = applyCipherAdminTimeAdjustment(-60);
    } else if (action === "time_inc") {
      handled = applyCipherAdminTimeAdjustment(60);
    } else if (action === "expire_timer") {
      handled = expireCipherAdminLiveTimer();
    } else if (action === "reset_timer") {
      handled = resetCipherAdminLiveTimer();
    } else if (action === "force_half1") {
      handled = forceCipherAdminLiveHalf(1);
    } else if (action === "force_half2") {
      handled = forceCipherAdminLiveHalf(2);
    } else if (action === "start_sudden_death") {
      handled = startCipherAdminSuddenDeath();
    } else if (action === "restart_prematch") {
      handled = true;
      closeCipherAdminPanelsForAllPlayers();
      clearCipherAdminInteractPoint("admin_restart_prematch");
      ReturnToPreMatchState();
      ensureCipherAdminAssigned();
    } else if (action === "end_match") {
      handled = true;
      closeCipherAdminPanelForPlayerId(playerId);
      enterPostmatchFromLive(resolveWinningTeamFromScores());
    } else if (action === "toggle_bots") {
      handled = toggleCipherRuntimeBotsFromAdmin("admin_toggle_bots");
    } else if (action === "clear_bots") {
      handled = clearCipherRuntimeBotsFromAdmin();
    } else if (action === "force_bot_reconcile") {
      handled = forceCipherRuntimeBotReconcileFromAdmin();
    }

    if (!handled) {
      refreshCipherAdminPanels();
      return;
    }

    recordCipherAdminAction(player, action);
    syncCipherAdminActionEffects("admin_" + action);
  } catch (err) {
    LogRuntimeError("AdminAction/" + action, err);
    refreshCipherAdminPanels();
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

function getStringMessageWithFallback1(key: any, fallbackText: string, arg0: any): any {
  if (key !== undefined && key !== null) {
    try {
      return mod.Message(key, arg0);
    } catch (_err) {}
  }
  return mod.Message(fallbackText, arg0);
}

function getStringMessageWithFallback2(key: any, fallbackText: string, arg0: any, arg1: any): any {
  if (key !== undefined && key !== null) {
    try {
      return mod.Message(key, arg0, arg1);
    } catch (_err) {}
  }
  return mod.Message(fallbackText, arg0, arg1);
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
    SAFE_UI_ROOT_SIZE,
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

  const timerRoot = mod.FindUIWidgetWithName(getDeployObjectiveTimerRootWidgetName(playerId));
  if (!timerRoot) return;

  mod.AddUIContainer(
    getDeployObjectiveTimerPanelWidgetName(playerId),
    panelCenterPos,
    mod.CreateVector(DEPLOY_OBJECTIVE_TIMER_PANEL_WIDTH, DEPLOY_OBJECTIVE_TIMER_PANEL_HEIGHT, 0),
    mod.UIAnchor.Center,
    timerRoot,
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
    timerRoot,
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
    timerRoot,
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
    timerRoot,
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
    timerRoot,
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
    timerRoot,
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
    timerRoot,
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
    timerRoot,
    false,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    getStringMessageWithFallback((mod.stringkeys as any).Text_ObjectiveDestroyTimer, "NODE REBOOTING"),
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
    timerRoot,
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
    p?.deployObjectiveTimerRootWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerRootWidgetName(playerId));
  const panel =
    p?.deployObjectiveTimerPanelWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerPanelWidgetName(playerId));
  const laneFill =
    p?.deployObjectiveTimerLaneFillWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneFillWidgetName(playerId));
  const laneText =
    p?.deployObjectiveTimerLaneTextWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneTextWidgetName(playerId));
  const outlineTop =
    p?.deployObjectiveTimerLaneOutlineTopWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId));
  const outlineBottom =
    p?.deployObjectiveTimerLaneOutlineBottomWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId));
  const outlineLeft =
    p?.deployObjectiveTimerLaneOutlineLeftWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId));
  const outlineRight =
    p?.deployObjectiveTimerLaneOutlineRightWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId));
  const title =
    p?.deployObjectiveTimerTitleWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerTitleWidgetName(playerId));
  const value =
    p?.deployObjectiveTimerValueWidget ?? mod.FindUIWidgetWithName(getDeployObjectiveTimerValueWidgetName(playerId));

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
  return !!(
    p.bombCarrierTextWidget &&
    p.bombNoticeContainerWidget &&
    p.bombNoticeTextWidget &&
    p.nextKeyUnlockContainerWidget &&
    p.nextKeyUnlockTextWidget
  );
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
  // Runtime bots / AI soldiers do not receive human HUD widgets.
  if (isCipherRuntimeBotPlayerId(p.id) || isBotBackfillPlayerSafe(p.player)) {
    clearCipherKeyHudCacheForPlayer(p.id);
    return true;
  }

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

  serverPlayers.forEach((p) => {
    if (!p) return;
    if (isCipherRuntimeBotPlayerId(p.id) || isBotBackfillPlayerSafe(p.player)) return;

    if (force || !p.bombCarrierTextWidget) {
      p.bombCarrierTextWidget = mod.FindUIWidgetWithName(BOMB_CARRIER_WIDGET_NAME_PREFIX + p.id) as any;
    }

    const visible =
      gameStatus === 3 &&
      bombCarrierPlayerId === p.id &&
      p.isDeployed &&
      mod.IsPlayerValid(p.player);

    applyBombCarrierHudStateForPlayer(p, visible, alpha, alphaBucket, force);
  });
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

  serverPlayers.forEach((p) => {
    if (!p) return;
    if (isCipherRuntimeBotPlayerId(p.id) || isBotBackfillPlayerSafe(p.player)) return;

    if (force || !p.bombNoticeContainerWidget || !p.bombNoticeTextWidget) {
      p.bombNoticeContainerWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
      p.bombNoticeTextWidget = mod.FindUIWidgetWithName(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id) as any;
    }

    refreshBombNoticeUiForPlayer(p, resolvedNowSec, force);
  });
}

function getNextKeyUnlockHudStateKey(visible: boolean, remainingSeconds: number): string {
  if (!visible) return "hidden";
  return "unlock:" + String(nextKeyUnlockCountdownToken) + ":" + String(remainingSeconds);
}

function refreshNextKeyUnlockHudForPlayer(p: Player, nowSec?: number, force: boolean = false): void {
  let widget = p.nextKeyUnlockTextWidget;
  let container = p.nextKeyUnlockContainerWidget;
  if ((!widget || force) && gameStatus === 3) {
    p.nextKeyUnlockTextWidget = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + p.id) as any;
    widget = p.nextKeyUnlockTextWidget;
  }
  if ((!container || force) && gameStatus === 3) {
    p.nextKeyUnlockContainerWidget = mod.FindUIWidgetWithName(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
    container = p.nextKeyUnlockContainerWidget;
  }
  if (!widget || !container) {
    if (gameStatus === 3) markCipherKeyHudDirtyForPlayer(p.id);
    return;
  }

  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const remainingSeconds = getNextKeyUnlockRemainingSeconds(resolvedNowSec);
  const visible = gameStatus === 3 && isNextKeyUnlockCountdownActive();
  const stateKey = getNextKeyUnlockHudStateKey(visible, remainingSeconds);
  if (!force && p.nextKeyUnlockHudLastStateKey === stateKey) return;
  p.nextKeyUnlockHudLastStateKey = stateKey;
  nextKeyUnlockHudLastStateByPlayerId[p.id] = stateKey;

  try {
    SafeSetTextLabelHandle(widget, formatNextKeyHudTimerLabel(remainingSeconds));
    SafeSetTextSizeHandle(widget, NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE);
    mod.SetUIWidgetVisible(container, visible);
    mod.SetUIWidgetVisible(widget, visible);
    mod.SetUITextAlpha(widget, visible ? 1 : 0);
    mod.SetUIWidgetDepth(container, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetDepth(widget, mod.UIDepth.AboveGameUI);
  } catch (_errNextKeyHud) {
    p.nextKeyUnlockContainerWidget = null as any;
    p.nextKeyUnlockTextWidget = null as any;
    p.nextKeyUnlockHudLastStateKey = "";
    delete nextKeyUnlockHudLastStateByPlayerId[p.id];
    markCipherKeyHudDirtyForPlayer(p.id);
  }
}

function refreshNextKeyUnlockHudForAllPlayers(nowSec?: number, force: boolean = false): void {
  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();

  serverPlayers.forEach((p) => {
    if (!p) return;
    if (isCipherRuntimeBotPlayerId(p.id) || isBotBackfillPlayerSafe(p.player)) return;
    refreshNextKeyUnlockHudForPlayer(p, resolvedNowSec, force);
  });
}

function updateNextKeyUnlockCountdownVisuals(nowSec?: number, force: boolean = false): void {
  if (!isNextKeyUnlockCountdownActive()) {
    if (force) refreshNextKeyUnlockHudForAllPlayers(nowSec, true);
    return;
  }

  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const remainingSeconds = getNextKeyUnlockRemainingSeconds(resolvedNowSec);
  spawnOrUpdateNextKeyUnlockWorldIcon(remainingSeconds, force);
  refreshNextKeyUnlockHudForAllPlayers(resolvedNowSec, force);
}

function clearNextKeyUnlockCountdown(context: string, forceHudRefresh: boolean = true): void {
  nextKeyUnlockCountdownToken++;
  nextKeyUnlockDeadlineAtSec = 0;
  nextKeyUnlockAnchorPosition = undefined;
  nextKeyUnlockLabelMode = "next_key";
  clearNextKeyUnlockRuntimeWorldIcon(context);
  nextKeyUnlockHudLastStateByPlayerId = {};
  if (forceHudRefresh) refreshNextKeyUnlockHudForAllPlayers(undefined, true);
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

function refreshCipherKeyUiAndIconsImmediately(reason: string): void {
  if (gameStatus !== 3) return;

  const nowSec = getCurrentSchedulerNowSeconds();

  refreshCipherKeyPlayerSnapshots(reason);
  repairCipherKeyHudCachesForAllPlayers(true);
  refreshBombNoticeUiForAllPlayers(nowSec, true);
  updateNextKeyUnlockCountdownVisuals(nowSec, true);
  UpdateBombCarrierUiForAllPlayers(nowSec, true);

  if (bombCarrierPlayerId !== undefined) {
    syncCipherCarrierVisualsNow(nowSec, reason);
    updateBombCarrierBeepLoopTick(nowSec);
  }

  ensureDroppedBombRuntimeWorldIconVisibleIfNeeded();
  ensureBaseBombRuntimeWorldIconVisibleIfNeeded();
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
  if (gameStatus !== 3 || isCipherLiveTransitionActive()) return;

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
  try {
    const w = mod.FindUIWidgetWithName(name);
    return w ? w : null;
  } catch (_err) {
    return null;
  }
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
  cipherSuddenDeathPostmatchPending = false;
  cipherSuddenDeathUndeployIgnoreUntilSec = 0;
  deleteCipherSuddenDeathAliveHudForAllPlayers();
}

function resetCipherObjectivesForCurrentStage(context: string): void {
  cipherPendingScoreTransitionTeam = teamNeutral;
  resetBombCarrierRuntimeState(true, true);
  resetCipherSpawnRoutingState();
  resetCipherObjectiveCounters();
  applyObjectiveLiveHybridRoundStartState(true);
  syncLiveHybridObjectiveSurfaceState(context, true);
  scheduleDelayedObjectiveSurfaceReassert(context);
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
const CIPHER_TRANSITION_ROOT_SIZE = SAFE_UI_ROOT_SIZE;
const CIPHER_TRANSITION_PANEL_POS = mod.CreateVector(0, -78, 0);
const CIPHER_TRANSITION_PANEL_SIZE = mod.CreateVector(650, 178, 0);
const CIPHER_TRANSITION_TITLE_POS = mod.CreateVector(0, -54, 0);
const CIPHER_TRANSITION_SUBTITLE_POS = mod.CreateVector(0, -14, 0);
const CIPHER_TRANSITION_PROGRESS_POS = mod.CreateVector(0, 28, 0);
const CIPHER_TRANSITION_TIMER_POS = mod.CreateVector(0, 66, 0);
const CIPHER_TRANSITION_DEPLOY_PROGRESS_POS = mod.CreateVector(0, -12, 0);
const CIPHER_TRANSITION_DEPLOY_TIMER_POS = mod.CreateVector(0, 20, 0);
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

function suppressCipherObjectiveEventsForTransition(context: string): void {
  const nowSec = getCurrentSchedulerNowSeconds();
  cipherSuppressObjectiveEventsUntilSec = mod.Max(
    cipherSuppressObjectiveEventsUntilSec,
    nowSec + CIPHER_TRANSITION_OBJECTIVE_EVENT_SUPPRESS_SECONDS
  );
  cipherTransitionLastCheckpoint = "suppress_events/" + context;
}

function isCipherTransitionObjectiveEventSuppressed(): boolean {
  if (gameStatus !== 3) return false;
  if (cipherTransitionEngineMutationActive) return true;
  if (isCipherLiveTransitionActive()) return true;
  return getCurrentSchedulerNowSeconds() < cipherSuppressObjectiveEventsUntilSec;
}

function setCipherTransitionCountdownSeconds(secondsRemaining: number): void {
  cipherTransitionCountdownSeconds = mod.Max(0, mod.Ceiling(secondsRemaining));
  countDown = cipherTransitionCountdownSeconds;
  SetUITime(getCurrentSchedulerNowSeconds());
}

function refreshCipherTransitionHudForCurrentState(): void {
  if (!isCipherLiveTransitionActive()) return;
  const countdownStage = cipherSecondHalfTransitionStage === "countdown";
  const intermissionStage = cipherSecondHalfTransitionStage === "intermission";
  showCipherTransitionHudForAllPlayers(
    countdownStage ? cipherTransitionStartsTitleKey : cipherTransitionDeployTitleKey,
    countdownStage ? cipherTransitionStartsTitleFallback : cipherTransitionDeployTitleFallback,
    cipherTransitionSubtitleKey,
    cipherTransitionSubtitleFallback,
    countdownStage || intermissionStage
      ? (mod.stringkeys as any).CipherStartsIn
      : (mod.stringkeys as any).CipherForceDeployIn,
    countdownStage || intermissionStage ? "STARTS IN {}" : "FORCE DEPLOY IN {}",
    cipherTransitionCountdownSeconds,
    !intermissionStage,
    !(countdownStage || intermissionStage)
  );
}

function showCipherTransitionHudForAllPlayers(
  titleKey: any,
  titleFallback: string,
  subtitleKey: any,
  subtitleFallback: string,
  timerKey: any,
  timerFallback: string,
  secondsRemaining: number,
  showDeployProgress: boolean = true,
  useDeployCenteredLayout: boolean = false
): void {
  const title = getStringMessageWithFallback(titleKey, titleFallback);
  const counts = getCipherDeployCounts();
  const progressLabel = getStringMessageWithFallback2(
    (mod.stringkeys as any).CipherDeployProgress,
    "DEPLOYED {}/{}",
    counts.ready,
    counts.required
  );
  const timerLabel = getStringMessageWithFallback1(timerKey, timerFallback, secondsRemaining);
  const subtitleLabel = getStringMessageWithFallback(subtitleKey, subtitleFallback);

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!ensureCipherTransitionHudForPlayer(p)) return;
    SafeSetTextLabelHandle(p.cipherTransitionTitleWidget, title);
    SafeSetTextLabelHandle(p.cipherTransitionSubtitleWidget, subtitleLabel);
    SafeSetTextLabelHandle(p.cipherTransitionProgressWidget, progressLabel);
    SafeSetTextLabelHandle(p.cipherTransitionTimerWidget, timerLabel);
    SafeSetWidgetPositionHandle(
      p.cipherTransitionProgressWidget,
      useDeployCenteredLayout ? CIPHER_TRANSITION_DEPLOY_PROGRESS_POS : CIPHER_TRANSITION_PROGRESS_POS
    );
    SafeSetWidgetPositionHandle(
      p.cipherTransitionTimerWidget,
      useDeployCenteredLayout ? CIPHER_TRANSITION_DEPLOY_TIMER_POS : CIPHER_TRANSITION_TIMER_POS
    );
    setCipherTransitionHudVisibleForPlayer(p, true);
    SafeSetWidgetVisibleHandle(p.cipherTransitionTitleWidget, !useDeployCenteredLayout);
    SafeSetWidgetVisibleHandle(p.cipherTransitionSubtitleWidget, !useDeployCenteredLayout);
    SafeSetWidgetVisibleHandle(p.cipherTransitionProgressWidget, showDeployProgress);
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

function hideCipherTransitionHudForAllPlayersNoBuild(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    bindCipherTransitionHudRefsForPlayer(p);
    SafeSetWidgetVisibleHandle(p.cipherTransitionRootWidget, false);
    SafeSetWidgetVisibleHandle(p.cipherTransitionPanelWidget, false);
    SafeSetWidgetVisibleHandle(p.cipherTransitionTitleWidget, false);
    SafeSetWidgetVisibleHandle(p.cipherTransitionSubtitleWidget, false);
    SafeSetWidgetVisibleHandle(p.cipherTransitionProgressWidget, false);
    SafeSetWidgetVisibleHandle(p.cipherTransitionTimerWidget, false);
  });
}

const CIPHER_SD_ALIVE_ROOT_WIDGET_NAME_PREFIX = "CipherSuddenDeathAliveRoot";
const CIPHER_SD_ALIVE_PANEL_WIDGET_NAME_PREFIX = "CipherSuddenDeathAlivePanel";
const CIPHER_SD_ALIVE_TITLE_WIDGET_NAME_PREFIX = "CipherSuddenDeathAliveTitle";
const CIPHER_SD_ALIVE_FRIENDLY_WIDGET_NAME_PREFIX = "CipherSuddenDeathFriendlyAlive";
const CIPHER_SD_ALIVE_ENEMY_WIDGET_NAME_PREFIX = "CipherSuddenDeathEnemyAlive";
const CIPHER_SD_ALIVE_FRIENDLY_SLOT_WIDGET_NAME_PREFIX = "CipherSuddenDeathFriendlyAliveSlot";
const CIPHER_SD_ALIVE_ENEMY_SLOT_WIDGET_NAME_PREFIX = "CipherSuddenDeathEnemyAliveSlot";

const CIPHER_SD_ALIVE_ROOT_SIZE = SAFE_UI_ROOT_SIZE;
const CIPHER_SD_ALIVE_ROOT_ANCHOR = mod.UIAnchor.TopLeft;
const CIPHER_SD_ALIVE_PANEL_ANCHOR = mod.UIAnchor.TopLeft;
const CIPHER_SD_ALIVE_PANEL_POS_X = 34;
const CIPHER_SD_ALIVE_PANEL_POS_Y = 326;
const CIPHER_SD_ALIVE_PANEL_POS = mod.CreateVector(
  CIPHER_SD_ALIVE_PANEL_POS_X,
  CIPHER_SD_ALIVE_PANEL_POS_Y,
  0
);

const CIPHER_SD_ALIVE_PANEL_SIZE = mod.CreateVector(288.02, 88, 0);

// Internal positions are centered relative to the panel.
const CIPHER_SD_ALIVE_TITLE_POS = mod.CreateVector(0, -30, 0);
const CIPHER_SD_ALIVE_FRIENDLY_POS = mod.CreateVector(-96, -6, 0);
const CIPHER_SD_ALIVE_ENEMY_POS = mod.CreateVector(-96, 24, 0);

const CIPHER_SD_ALIVE_SLOT_START_X = -48;
const CIPHER_SD_ALIVE_SLOT_SPACING_X = 22;

const CIPHER_SD_ALIVE_TITLE_SIZE = mod.CreateVector(260, 20, 0);
const CIPHER_SD_ALIVE_LABEL_SIZE = mod.CreateVector(54, 22, 0);
const CIPHER_SD_ALIVE_SLOT_SIZE = mod.CreateVector(20, 24, 0);

const CIPHER_SD_ALIVE_TITLE_TEXT_SIZE = 16;
const CIPHER_SD_ALIVE_LABEL_TEXT_SIZE = 13;
const CIPHER_SD_ALIVE_SLOT_TEXT_SIZE = 18;
const CIPHER_SD_ALIVE_DOT_TEXT_SIZE = 22;
const CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM = 8;

function getCipherSuddenDeathAliveRootWidgetName(playerId: number): string {
  return CIPHER_SD_ALIVE_ROOT_WIDGET_NAME_PREFIX + playerId;
}

function getCipherSuddenDeathAlivePanelWidgetName(playerId: number): string {
  return CIPHER_SD_ALIVE_PANEL_WIDGET_NAME_PREFIX + playerId;
}

function getCipherSuddenDeathAliveTitleWidgetName(playerId: number): string {
  return CIPHER_SD_ALIVE_TITLE_WIDGET_NAME_PREFIX + playerId;
}

function getCipherSuddenDeathFriendlyAliveWidgetName(playerId: number): string {
  return CIPHER_SD_ALIVE_FRIENDLY_WIDGET_NAME_PREFIX + playerId;
}

function getCipherSuddenDeathEnemyAliveWidgetName(playerId: number): string {
  return CIPHER_SD_ALIVE_ENEMY_WIDGET_NAME_PREFIX + playerId;
}

function getCipherSuddenDeathFriendlyAliveSlotWidgetName(playerId: number, slotIndex: number): string {
  return CIPHER_SD_ALIVE_FRIENDLY_SLOT_WIDGET_NAME_PREFIX + playerId + "_" + slotIndex;
}

function getCipherSuddenDeathEnemyAliveSlotWidgetName(playerId: number, slotIndex: number): string {
  return CIPHER_SD_ALIVE_ENEMY_SLOT_WIDGET_NAME_PREFIX + playerId + "_" + slotIndex;
}

function resetCipherSuddenDeathAliveHudRefsForPlayer(p: Player): void {
  p.cipherSuddenDeathAliveRootWidget = null as any;
  p.cipherSuddenDeathAlivePanelWidget = null as any;
  p.cipherSuddenDeathAliveTitleWidget = null as any;
  p.cipherSuddenDeathFriendlyAliveWidget = null as any;
  p.cipherSuddenDeathEnemyAliveWidget = null as any;
  p.cipherSuddenDeathFriendlyAliveSlotWidgets = [];
  p.cipherSuddenDeathEnemyAliveSlotWidgets = [];
}

function deleteCipherSuddenDeathAliveHudForPlayer(playerId: number): void {
  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    safeDeleteAllWidgetsByName(getCipherSuddenDeathEnemyAliveSlotWidgetName(playerId, i));
    safeDeleteAllWidgetsByName(getCipherSuddenDeathFriendlyAliveSlotWidgetName(playerId, i));
  }
  safeDeleteAllWidgetsByName(getCipherSuddenDeathEnemyAliveWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherSuddenDeathFriendlyAliveWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherSuddenDeathAliveTitleWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherSuddenDeathAlivePanelWidgetName(playerId));
  safeDeleteAllWidgetsByName(getCipherSuddenDeathAliveRootWidgetName(playerId));
}

function deleteCipherSuddenDeathAliveHudForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p) return;
    deleteCipherSuddenDeathAliveHudForPlayer(p.id);
    resetCipherSuddenDeathAliveHudRefsForPlayer(p);
  });
}

function bindCipherSuddenDeathAliveHudRefsForPlayer(p: Player): void {
  const playerId = p.id;
  p.cipherSuddenDeathAliveRootWidget = mod.FindUIWidgetWithName(getCipherSuddenDeathAliveRootWidgetName(playerId));
  p.cipherSuddenDeathAlivePanelWidget = mod.FindUIWidgetWithName(getCipherSuddenDeathAlivePanelWidgetName(playerId));
  p.cipherSuddenDeathAliveTitleWidget = mod.FindUIWidgetWithName(getCipherSuddenDeathAliveTitleWidgetName(playerId));
  p.cipherSuddenDeathFriendlyAliveWidget = mod.FindUIWidgetWithName(getCipherSuddenDeathFriendlyAliveWidgetName(playerId));
  p.cipherSuddenDeathEnemyAliveWidget = mod.FindUIWidgetWithName(getCipherSuddenDeathEnemyAliveWidgetName(playerId));
  p.cipherSuddenDeathFriendlyAliveSlotWidgets = [];
  p.cipherSuddenDeathEnemyAliveSlotWidgets = [];
  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    p.cipherSuddenDeathFriendlyAliveSlotWidgets.push(
      mod.FindUIWidgetWithName(getCipherSuddenDeathFriendlyAliveSlotWidgetName(playerId, i))
    );
    p.cipherSuddenDeathEnemyAliveSlotWidgets.push(
      mod.FindUIWidgetWithName(getCipherSuddenDeathEnemyAliveSlotWidgetName(playerId, i))
    );
  }
}

function setCipherSuddenDeathAliveHudDepthForPlayer(p: Player): void {
  const widgets = [
    p.cipherSuddenDeathAliveRootWidget,
    p.cipherSuddenDeathAlivePanelWidget,
    p.cipherSuddenDeathAliveTitleWidget,
    p.cipherSuddenDeathFriendlyAliveWidget,
    p.cipherSuddenDeathEnemyAliveWidget,
  ];
  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    widgets.push(p.cipherSuddenDeathFriendlyAliveSlotWidgets[i]);
    widgets.push(p.cipherSuddenDeathEnemyAliveSlotWidgets[i]);
  }
  for (let i = 0; i < widgets.length; i++) {
    if (widgets[i]) mod.SetUIWidgetDepth(widgets[i], mod.UIDepth.AboveGameUI);
  }
}

function rebuildCipherSuddenDeathAliveHudForPlayer(p: Player): void {
  const playerId = p.id;
  deleteCipherSuddenDeathAliveHudForPlayer(playerId);
  resetCipherSuddenDeathAliveHudRefsForPlayer(p);

  const uiRoot = mod.GetUIRoot();
  if (!uiRoot) return;

  mod.AddUIContainer(
    getCipherSuddenDeathAliveRootWidgetName(playerId),
    mod.CreateVector(0, 0, 0),
    CIPHER_SD_ALIVE_ROOT_SIZE,
    CIPHER_SD_ALIVE_ROOT_ANCHOR,
    uiRoot,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    p.player
  );

  const root = mod.FindUIWidgetWithName(getCipherSuddenDeathAliveRootWidgetName(playerId));
  if (!root) return;

  mod.AddUIContainer(
    getCipherSuddenDeathAlivePanelWidgetName(playerId),
    CIPHER_SD_ALIVE_PANEL_POS,
    CIPHER_SD_ALIVE_PANEL_SIZE,
    CIPHER_SD_ALIVE_PANEL_ANCHOR,
    root,
    true,
    0,
    mod.CreateVector(0.0314, 0.0431, 0.0431),
    0.5,
    mod.UIBgFill.Solid,
    p.player
  );

  const panel = mod.FindUIWidgetWithName(getCipherSuddenDeathAlivePanelWidgetName(playerId));
  if (!panel) return;

  mod.AddUIText(
    getCipherSuddenDeathAliveTitleWidgetName(playerId),
    CIPHER_SD_ALIVE_TITLE_POS,
    CIPHER_SD_ALIVE_TITLE_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_SD_ALIVE_TITLE_TEXT_SIZE,
    CIPHER_TRANSITION_ACCENT_COLOR,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getCipherSuddenDeathFriendlyAliveWidgetName(playerId),
    CIPHER_SD_ALIVE_FRIENDLY_POS,
    CIPHER_SD_ALIVE_LABEL_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_SD_ALIVE_LABEL_TEXT_SIZE,
    COLOR_FRIENDLY,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  mod.AddUIText(
    getCipherSuddenDeathEnemyAliveWidgetName(playerId),
    CIPHER_SD_ALIVE_ENEMY_POS,
    CIPHER_SD_ALIVE_LABEL_SIZE,
    mod.UIAnchor.Center,
    panel,
    true,
    0,
    mod.CreateVector(0, 0, 0),
    0,
    mod.UIBgFill.None,
    mod.Message(mod.stringkeys.EmptyText),
    CIPHER_SD_ALIVE_LABEL_TEXT_SIZE,
    COLOR_ENEMY,
    1,
    mod.UIAnchor.Center,
    p.player
  );

  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    const slotX = CIPHER_SD_ALIVE_SLOT_START_X + (i * CIPHER_SD_ALIVE_SLOT_SPACING_X);
    mod.AddUIText(
      getCipherSuddenDeathFriendlyAliveSlotWidgetName(playerId, i),
      mod.CreateVector(slotX, -6, 0),
      CIPHER_SD_ALIVE_SLOT_SIZE,
      mod.UIAnchor.Center,
      panel,
      false,
      0,
      mod.CreateVector(0, 0, 0),
      0,
      mod.UIBgFill.None,
      mod.Message(mod.stringkeys.EmptyText),
      CIPHER_SD_ALIVE_SLOT_TEXT_SIZE,
      COLOR_FRIENDLY,
      1,
      mod.UIAnchor.Center,
      p.player
    );

    mod.AddUIText(
      getCipherSuddenDeathEnemyAliveSlotWidgetName(playerId, i),
      mod.CreateVector(slotX, 24, 0),
      CIPHER_SD_ALIVE_SLOT_SIZE,
      mod.UIAnchor.Center,
      panel,
      false,
      0,
      mod.CreateVector(0, 0, 0),
      0,
      mod.UIBgFill.None,
      mod.Message(mod.stringkeys.EmptyText),
      CIPHER_SD_ALIVE_SLOT_TEXT_SIZE,
      COLOR_ENEMY,
      1,
      mod.UIAnchor.Center,
      p.player
    );
  }

  bindCipherSuddenDeathAliveHudRefsForPlayer(p);
  setCipherSuddenDeathAliveHudDepthForPlayer(p);
}

function ensureCipherSuddenDeathAliveHudForPlayer(p: Player): boolean {
  if (
    p.cipherSuddenDeathAliveRootWidget &&
    p.cipherSuddenDeathAlivePanelWidget &&
    p.cipherSuddenDeathAliveTitleWidget &&
    p.cipherSuddenDeathFriendlyAliveWidget &&
    p.cipherSuddenDeathEnemyAliveWidget &&
    hasCipherSuddenDeathAliveSlotRefsForPlayer(p)
  ) {
    setCipherSuddenDeathAliveHudDepthForPlayer(p);
    return true;
  }

  rebuildCipherSuddenDeathAliveHudForPlayer(p);
  return !!(
    p.cipherSuddenDeathAliveRootWidget &&
    p.cipherSuddenDeathAlivePanelWidget &&
    p.cipherSuddenDeathAliveTitleWidget &&
    p.cipherSuddenDeathFriendlyAliveWidget &&
    p.cipherSuddenDeathEnemyAliveWidget &&
    hasCipherSuddenDeathAliveSlotRefsForPlayer(p)
  );
}

function hasCipherSuddenDeathAliveSlotRefsForPlayer(p: Player): boolean {
  if (!p.cipherSuddenDeathFriendlyAliveSlotWidgets || !p.cipherSuddenDeathEnemyAliveSlotWidgets) return false;
  if (p.cipherSuddenDeathFriendlyAliveSlotWidgets.length < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM) return false;
  if (p.cipherSuddenDeathEnemyAliveSlotWidgets.length < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM) return false;

  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    if (!p.cipherSuddenDeathFriendlyAliveSlotWidgets[i]) return false;
    if (!p.cipherSuddenDeathEnemyAliveSlotWidgets[i]) return false;
  }
  return true;
}

function setCipherSuddenDeathAliveHudVisibleForPlayer(p: Player, visible: boolean): void {
  if (!ensureCipherSuddenDeathAliveHudForPlayer(p)) return;
  SafeSetWidgetVisibleHandle(p.cipherSuddenDeathAliveRootWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherSuddenDeathAlivePanelWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherSuddenDeathAliveTitleWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherSuddenDeathFriendlyAliveWidget, visible);
  SafeSetWidgetVisibleHandle(p.cipherSuddenDeathEnemyAliveWidget, visible);
  if (!visible) {
    for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
      SafeSetWidgetVisibleHandle(p.cipherSuddenDeathFriendlyAliveSlotWidgets[i], false);
      SafeSetWidgetVisibleHandle(p.cipherSuddenDeathEnemyAliveSlotWidgets[i], false);
    }
  }
}

function countCipherSuddenDeathTeamSlots(team: mod.Team): number {
  let count = 0;
  serverPlayers.forEach((sp) => {
    if (!sp || !mod.IsPlayerValid(sp.player)) return;
    if (!mod.Equals(mod.GetTeam(sp.player), team)) return;
    count += 1;
  });
  return count;
}

function updateCipherSuddenDeathAliveSlotWidgets(
  widgets: mod.UIWidget[],
  aliveCount: number,
  slotCount: number,
  aliveColor: mod.Vector,
  aliveDotLabel: any,
  deadMarkerLabel: any
): void {
  const visibleSlotCount = Math.min(CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM, Math.max(aliveCount, slotCount));

  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    const widget = widgets[i];
    const visible = i < visibleSlotCount;
    SafeSetWidgetVisibleHandle(widget, visible);
    if (!visible) continue;

    const alive = i < aliveCount;
    SafeSetTextLabelHandle(widget, alive ? aliveDotLabel : deadMarkerLabel);
    SafeSetTextColorHandle(widget, alive ? aliveColor : COLOR_NEUTRAL);
    SafeSetTextSizeHandle(widget, alive ? CIPHER_SD_ALIVE_DOT_TEXT_SIZE : CIPHER_SD_ALIVE_SLOT_TEXT_SIZE);
  }
}

function updateCipherSuddenDeathAliveHudForPlayer(p: Player): void {
  if (!p || !mod.IsPlayerValid(p.player)) return;
  if (!isCipherSuddenDeathActive() || cipherSuddenDeathTransitionActive || cipherSecondHalfTransitionStage !== "none") {
    if (p.cipherSuddenDeathAliveRootWidget) setCipherSuddenDeathAliveHudVisibleForPlayer(p, false);
    return;
  }

  const team = mod.GetTeam(p.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) {
    setCipherSuddenDeathAliveHudVisibleForPlayer(p, false);
    return;
  }

  const enemyTeam = mod.Equals(team, team1) ? team2 : team1;
  const friendlyAlive = countCipherSuddenDeathLivesRemaining(team);
  const enemyAlive = countCipherSuddenDeathLivesRemaining(enemyTeam);
  const friendlySlots = countCipherSuddenDeathTeamSlots(team);
  const enemySlots = countCipherSuddenDeathTeamSlots(enemyTeam);

  if (!ensureCipherSuddenDeathAliveHudForPlayer(p)) return;
  const aliveDotLabel = getStringMessageWithFallback((mod.stringkeys as any).CipherSuddenDeathAliveDot, "●");
  const deadMarkerLabel = getStringMessageWithFallback((mod.stringkeys as any).CipherSuddenDeathDeadMarker, "X");

  SafeSetTextLabelHandle(
    p.cipherSuddenDeathAliveTitleWidget,
    getStringMessageWithFallback((mod.stringkeys as any).CipherSuddenDeathAliveTitle, "SUDDEN DEATH")
  );
  SafeSetTextLabelHandle(
    p.cipherSuddenDeathFriendlyAliveWidget,
    getStringMessageWithFallback((mod.stringkeys as any).CipherSuddenDeathFriendlyLabel, "ALLY")
  );
  SafeSetTextLabelHandle(
    p.cipherSuddenDeathEnemyAliveWidget,
    getStringMessageWithFallback((mod.stringkeys as any).CipherSuddenDeathEnemyLabel, "ENEMY")
  );
  SafeSetTextColorHandle(p.cipherSuddenDeathFriendlyAliveWidget, COLOR_FRIENDLY);
  SafeSetTextColorHandle(p.cipherSuddenDeathEnemyAliveWidget, COLOR_ENEMY);
  updateCipherSuddenDeathAliveSlotWidgets(
    p.cipherSuddenDeathFriendlyAliveSlotWidgets,
    friendlyAlive,
    friendlySlots,
    COLOR_FRIENDLY,
    aliveDotLabel,
    deadMarkerLabel
  );
  updateCipherSuddenDeathAliveSlotWidgets(
    p.cipherSuddenDeathEnemyAliveSlotWidgets,
    enemyAlive,
    enemySlots,
    COLOR_ENEMY,
    aliveDotLabel,
    deadMarkerLabel
  );
  setCipherSuddenDeathAliveHudVisibleForPlayer(p, true);
}

function updateCipherSuddenDeathAliveHudForAllPlayers(): void {
  serverPlayers.forEach((p) => updateCipherSuddenDeathAliveHudForPlayer(p));
}

function hideCipherSuddenDeathAliveHudForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!p.cipherSuddenDeathAliveRootWidget) {
      bindCipherSuddenDeathAliveHudRefsForPlayer(p);
    }
    if (!p.cipherSuddenDeathAliveRootWidget) return;
    setCipherSuddenDeathAliveHudVisibleForPlayer(p, false);
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

const CIPHER_TRANSITION_LIVE_INPUT_CLEAR_INPUTS: mod.RestrictedInputs[] = [
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

const CIPHER_INTERMISSION_FREEZE_INPUTS: mod.RestrictedInputs[] = [
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

const CIPHER_DEPLOY_READY_FREEZE_INPUTS: mod.RestrictedInputs[] = [
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
  if (isCipherRuntimeBotPlayerId(p.id)) return false;
  const team = mod.GetTeam(p.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;
  if (isBotBackfillPlayerSafe(p.player)) return false;
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
  cipherTransitionSubtitleKey = undefined;
  cipherTransitionSubtitleFallback = "";
}

function clearCipherLiveInputRestrictionsForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

  try {
    mod.SetPlayerMovementSpeedMultiplier(player, 1);
  } catch (_errSpeed) {}
  try {
    mod.EnableAllInputRestrictions(player, false);
  } catch (_errAllInputs) {}
  for (let i = 0; i < CIPHER_TRANSITION_LIVE_INPUT_CLEAR_INPUTS.length; i++) {
    try {
      mod.EnableInputRestriction(player, CIPHER_TRANSITION_LIVE_INPUT_CLEAR_INPUTS[i], false);
    } catch (_errInput) {}
  }
}

function setCipherSecondHalfDeployFreezeForPlayer(
  player: mod.Player,
  frozen: boolean,
  _source: string
): void {
  if (!mod.IsPlayerValid(player)) return;
  const playerId = modlib.getPlayerId(player);
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) {
    if (!frozen) delete cipherSecondHalfFrozenByPlayerId[playerId];
    return;
  }

  if (!frozen) {
    delete cipherSecondHalfFrozenByPlayerId[playerId];
    clearCipherLiveInputRestrictionsForPlayer(player);
    return;
  }

  // Re-apply every transition tick. The engine can clear restrictions after deploy/spawn,
  // so do not early-return just because our script already marked this player frozen.
  cipherSecondHalfFrozenByPlayerId[playerId] = true;

  clearCipherLiveInputRestrictionsForPlayer(player);
  try {
    mod.SetPlayerMovementSpeedMultiplier(player, 0);
  } catch (_errSpeed) {}

  const inputs =
    cipherSecondHalfTransitionStage === "intermission"
      ? CIPHER_INTERMISSION_FREEZE_INPUTS
      : CIPHER_DEPLOY_READY_FREEZE_INPUTS;

  for (let i = 0; i < inputs.length; i++) {
    try {
      mod.EnableInputRestriction(player, inputs[i], true);
    } catch (_errInput) {}
  }
}

function clearCipherSecondHalfDeployFreezeForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    try {
      setCipherSecondHalfDeployFreezeForPlayer(p.player, false, "clear_second_half_freeze");
    } catch (err) {
      LogRuntimeError("TransitionClearFreeze/" + String(p.id), err);
    }
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

function applyCipherIntermissionFreezeForDeployedPlayers(source: string): void {
  if (cipherSecondHalfTransitionStage !== "intermission") return;
  serverPlayers.forEach((p) => {
    if (!p || !p.isDeployed || !mod.IsPlayerValid(p.player)) return;
    setCipherSecondHalfDeployFreezeForPlayer(p.player, true, source);
  });
}

function applyCipherTransitionInputLocksForPlayers(source: string): void {
  if (cipherSecondHalfTransitionStage === "intermission") {
    applyCipherIntermissionFreezeForDeployedPlayers(source);
    applyRuntimeBotPhaseLocksForAll(source + "_bots");
    return;
  }
  applyCipherSecondHalfDeployFreezeForReadyPlayers(source);
  applyRuntimeBotPhaseLocksForAll(source + "_bots");
}

function hardUnlockCipherLiveInputsForAllPlayers(_source: string): void {
  cipherSecondHalfFrozenByPlayerId = {};
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    try {
      clearCipherLiveInputRestrictionsForPlayer(p.player);
    } catch (err) {
      LogRuntimeError("TransitionHardUnlock/" + String(p.id), err);
    }
  });
}

function beginCipherSecondHalfTransitionOwnership(): number {
  cipherSecondHalfTransitionToken += 1;
  cipherSuddenDeathTransitionToken += 1;
  return cipherSecondHalfTransitionToken;
}

function beginCipherSuddenDeathTransitionOwnership(): number {
  cipherSuddenDeathTransitionToken += 1;
  cipherSecondHalfTransitionToken += 1;
  return cipherSuddenDeathTransitionToken;
}

function invalidateCipherLiveTransitionOwnership(): void {
  cipherSecondHalfTransitionToken += 1;
  cipherSuddenDeathTransitionToken += 1;
  cancelCipherTransitionWorkQueue("invalidate_transition_ownership");
  clearCipherTransitionSupervisorState();
}

function clearCipherLivePhaseTransitionRuntimeState(
  source: string,
  resetDeployTracking: boolean,
  resetBombRuntime: boolean,
  preserveDeployRestoreCache: boolean = false
): void {
  try {
    resetTransitionSpawnQueueState(false);
  } catch (err) {
    LogRuntimeError("TransitionRuntimeClear/spawnQueue/" + source, err);
  }
  try {
    clearCipherSpawnJobQueues();
  } catch (err) {
    LogRuntimeError("TransitionRuntimeClear/spawnJobs/" + source, err);
  }
  try {
    cancelAllCipherRespawnRouteJobs();
  } catch (err) {
    LogRuntimeError("TransitionRuntimeClear/respawnRoute/" + source, err);
  }
  try {
    clearCipherSecondHalfDeployFreezeForAllPlayers();
  } catch (err) {
    LogRuntimeError("TransitionRuntimeClear/freeze/" + source, err);
  }
  try {
    hardUnlockCipherLiveInputsForAllPlayers(source);
  } catch (err) {
    LogRuntimeError("TransitionRuntimeClear/inputUnlock/" + source, err);
  }
  cipherLiveStartSettleToken += 1;
  cipherLiveStartSettlingStage = "none";
  cipherLiveStartSettlingUntilSec = 0;
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  cipherSuddenDeathUndeployIgnoreUntilSec = 0;
  if (resetDeployTracking) {
    try {
      resetCipherSecondHalfDeployTracking();
    } catch (err) {
      LogRuntimeError("TransitionRuntimeClear/deployTracking/" + source, err);
    }
  }
  if (resetBombRuntime) {
    try {
      resetBombCarrierRuntimeState(true, preserveDeployRestoreCache);
    } catch (err) {
      LogRuntimeError("TransitionRuntimeClear/bombRuntime/" + source, err);
    }
  }
}

async function reassertCipherLiveInputUnlocksForStage(
  expectedStage: CipherMatchStage,
  source: string
): Promise<void> {
  const waits = [0, 0.25, 0.75, 1.0];
  for (let i = 0; i < waits.length; i++) {
    if (waits[i] > 0) await mod.Wait(waits[i]);
    if (gameStatus !== 3) return;
    if (cipherMatchStage !== expectedStage) return;
    if (cipherSecondHalfTransitionStage !== "none") return;
    hardUnlockCipherLiveInputsForAllPlayers(source);
  }
}

function startCipherPostTransitionLiveInputUnlock(expectedStage: CipherMatchStage, source: string): void {
  hardUnlockCipherLiveInputsForAllPlayers(source);
  void reassertCipherLiveInputUnlocksForStage(expectedStage, source);
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

function clearCipherSecondHalfDeployReadyForPlayer(playerId: number, force: boolean = false): void {
  if (!force && cipherSecondHalfTransitionStage === "countdown") return;
  delete cipherSecondHalfDeployReadyByPlayerId[playerId];
}

function hasAllRequiredCipherSecondHalfDeployersReady(): boolean {
  const counts = getCipherDeployCounts();
  return counts.required <= 0 || counts.ready >= counts.required;
}

function getCipherSecondHalfForceDeployToken(): number {
  if (cipherLiveTransitionSupervisorToken > 0) return cipherLiveTransitionSupervisorToken;
  return cipherSecondHalfTransitionToken;
}

function forceDeployMissingCipherSecondHalfPlayersOnce(source: string): void {
  if (!isCipherLiveTransitionActive()) return;
  const transitionToken = getCipherSecondHalfForceDeployToken();
  if (transitionToken <= 0) return;
  if (cipherSecondHalfForceDeployIssuedForTransitionToken === transitionToken) return;
  cipherSecondHalfForceDeployIssuedForTransitionToken = transitionToken;

  applyCipherSecondHalfHqSpawns(source + "_hq_reassert");

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;

    if (!isRequiredSecondHalfDeployPlayer(p)) {
      delete cipherSecondHalfDeployRequiredByPlayerId[p.id];
      delete cipherSecondHalfDeployReadyByPlayerId[p.id];
      return;
    }

    if (cipherSecondHalfDeployRequiredByPlayerId[p.id] !== true) {
      cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;
    }

    if (cipherSecondHalfDeployReadyByPlayerId[p.id] === true && p.isDeployed) return;

    if (p.isDeployed) {
      handleCipherTransitionDeployedPlayer(p.id, p.player, source + "_already_deployed");
      return;
    }

    try {
      requestCipherSpawnAnchorForPlayer(p.id, true);
      mod.SetRedeployTime(p.player, 0);
      applyPhaseInputRestrictionsForPlayer(p.player);
      mod.DeployPlayer(p.player);
    } catch (err) {
      LogRuntimeError("ForceDeploySecondHalf/" + source + "/" + String(p.id), err);
    }
  });
}

function requestForceDeployForMissingCipherSecondHalfPlayers(source: string): void {
  forceDeployMissingCipherSecondHalfPlayersOnce(source);
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

function runCipherTransitionStepWorkSafe(source: string, forceDeployMissingPlayers: boolean): void {
  if (forceDeployMissingPlayers) {
    try {
      requestForceDeployForMissingCipherSecondHalfPlayers(source + "_force_deploy");
    } catch (err) {
      LogRuntimeError("TransitionStep/requestForceDeploy/" + source, err);
    }
  }

  try {
    processTransitionSpawnQueue(source);
  } catch (err) {
    LogRuntimeError("TransitionStep/processTransitionSpawnQueue/" + source, err);
  }

  try {
    processCipherSpawnJobs(source);
  } catch (err) {
    LogRuntimeError("TransitionStep/processCipherSpawnJobs/" + source, err);
  }

  try {
    applyCipherSecondHalfDeployFreezeForReadyPlayers(source);
    applyRuntimeBotPhaseLocksForAll(source + "_bots");
  } catch (err) {
    LogRuntimeError("TransitionStep/applyDeployFreeze/" + source, err);
  }
}

function showCipherTransitionHudSafe(
  source: string,
  titleKey: any,
  titleFallback: string,
  subtitleKey: any,
  subtitleFallback: string,
  timerKey: any,
  timerFallback: string,
  secondsRemaining: number,
  showDeployProgress: boolean,
  useDeployCenteredLayout: boolean = false
): void {
  try {
    showCipherTransitionHudForAllPlayers(
      titleKey,
      titleFallback,
      subtitleKey,
      subtitleFallback,
      timerKey,
      timerFallback,
      secondsRemaining,
      showDeployProgress,
      useDeployCenteredLayout
    );
  } catch (err) {
    LogRuntimeError("TransitionStep/showTransitionHud/" + source, err);
  }
}

function playCountdownHeartbeatSafe(source: string, volume: number): void {
  try {
    playCountdownHeartbeatToAll(volume);
  } catch (err) {
    LogRuntimeError("TransitionStep/playCountdownHeartbeat/" + source, err);
  }
}

async function settleForcedCipherSecondHalfDeploys(source: string): Promise<void> {
  const settleEndAtSec = getCurrentSchedulerNowSeconds() + CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS;
  forceDeployMissingCipherSecondHalfPlayersOnce(source + "_enter");

  while (gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive)) {
    runCipherTransitionStepWorkSafe(source, false);

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
  subtitleKey: any,
  subtitleFallback: string,
  isCurrentTransition: () => boolean
): Promise<void> {
  if (!isCurrentTransition()) return;
  markCipherSecondHalfDeployRequiredPlayers();

  cipherTransitionDeployTitleKey = deployTitleKey;
  cipherTransitionDeployTitleFallback = deployTitleFallback;
  cipherTransitionStartsTitleKey = startsTitleKey;
  cipherTransitionStartsTitleFallback = startsTitleFallback;
  cipherTransitionSubtitleKey = subtitleKey;
  cipherTransitionSubtitleFallback = subtitleFallback;

  SetCountdownOverlayVisible(false);

  for (
    let remaining = CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS;
    remaining > CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS;
    remaining--
  ) {
    if (
      !isCurrentTransition() ||
      gameStatus !== 3 ||
      !(cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) ||
      cipherSecondHalfTransitionStage !== "deploy"
    ) {
      return;
    }

    setCipherTransitionCountdownSeconds(remaining);

    showCipherTransitionHudSafe(
      source + "_deploy_hud_" + String(remaining),
      deployTitleKey,
      deployTitleFallback,
      subtitleKey,
      subtitleFallback,
      (mod.stringkeys as any).CipherForceDeployIn,
      "FORCE DEPLOY IN {}",
      remaining,
      true,
      true
    );

    runCipherTransitionStepWorkSafe(source + "_deploy_" + String(remaining), false);

    if (hasAllRequiredCipherSecondHalfDeployersReady()) {
      break;
    }

    await mod.Wait(1);
  }

  if (
    !isCurrentTransition() ||
    gameStatus !== 3 ||
    !(cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) ||
    cipherSecondHalfTransitionStage !== "deploy"
  ) {
    return;
  }

  // Enter final countdown.
  cipherSecondHalfTransitionStage = "countdown";
  setCipherTransitionCountdownSeconds(CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS);

  // Do one safe settle pass before showing 5.
  // This prevents the common freeze where the function sets countdown to 5 and then dies
  // inside a force-deploy/spawn/HUD/freeze call.
  forceDeployMissingCipherSecondHalfPlayersOnce(source + "_countdown_enter");
  runCipherTransitionStepWorkSafe(source + "_countdown_enter", false);

  for (let remaining = CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS; remaining > 0; remaining--) {
    if (
      !isCurrentTransition() ||
      gameStatus !== 3 ||
      !(cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) ||
      cipherSecondHalfTransitionStage !== "countdown"
    ) {
      return;
    }

    setCipherTransitionCountdownSeconds(remaining);

    runCipherTransitionStepWorkSafe(source + "_countdown_" + String(remaining), false);

    showCipherTransitionHudSafe(
      source + "_countdown_hud_" + String(remaining),
      startsTitleKey,
      startsTitleFallback,
      subtitleKey,
      subtitleFallback,
      (mod.stringkeys as any).CipherStartsIn,
      "STARTS IN {}",
      remaining,
      true
    );

    playCountdownHeartbeatSafe(
      source + "_countdown_heartbeat_" + String(remaining),
      remaining <= 3 ? 0.85 : 0.6
    );

    await mod.Wait(1);
  }

  setCipherTransitionCountdownSeconds(0);

  runCipherTransitionStepWorkSafe(source + "_countdown_zero", false);
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

function scheduleCipherLiveStartKeyRetry(context: string): void {
  try {
    scheduleDynamicBaseBombRespawnRetry(
      context + "_retry",
      "bomb_located",
      false,
      "live_start_center",
      "first_key"
    );
  } catch (err) {
    LogRuntimeError("LiveStartKey/retry/" + context, err);
  }
}

function runDeferredCipherLiveStartKeySpawn(
  token: number,
  expectedHalf: CipherHalfIndex,
  expectedStage: CipherMatchStage,
  context: string
): void {
  if (cipherDeferredLiveStartKeyToken !== token) return;
  cipherDeferredLiveStartKeyTimerHandle = undefined;
  if (gameStatus !== 3 || initialization[3] !== true) return;
  if (isCipherLiveTransitionActive()) return;
  if (cipherCurrentHalf !== expectedHalf || cipherMatchStage !== expectedStage) return;
  if (bombCarrierPlayerId !== undefined || hasDroppedBombRuntimeObjects() || hasBaseBombAuthorityOrPending()) return;

  try {
    if (!spawnBombPickupObjectAtLiveStart()) {
      scheduleCipherLiveStartKeyRetry(context + "_not_spawned");
    }
  } catch (err) {
    LogRuntimeError("LiveStartKey/spawn/" + context, err);
    scheduleCipherLiveStartKeyRetry(context + "_exception");
  }
}

function scheduleCipherLiveStartKeySpawn(
  expectedHalf: CipherHalfIndex,
  expectedStage: CipherMatchStage,
  context: string
): void {
  const token = cipherDeferredLiveStartKeyToken + 1;
  cipherDeferredLiveStartKeyToken = token;
  Timers.clearTimeout(cipherDeferredLiveStartKeyTimerHandle);
  cipherDeferredLiveStartKeyTimerHandle = Timers.setTimeout(
    () => runDeferredCipherLiveStartKeySpawn(token, expectedHalf, expectedStage, context),
    CIPHER_DEFERRED_LIVE_START_KEY_DELAY_SECONDS * 1000
  );
}

function startCipherHalfClockAndKey(half: CipherHalfIndex, nowSec?: number): void {
  try {
    beginScriptOwnedLiveClockPhase(ROUND_TIME, nowSec, half === 2);
  } catch (err) {
    LogRuntimeError("LiveStartClock/half" + String(half), err);
  }
  scheduleCipherLiveStartKeySpawn(half, half === 1 ? "half1" : "half2", "half" + String(half) + "_live_start");
}

function beginCipherHalf(half: CipherHalfIndex, nowSec?: number): void {
  prepareCipherHalfForLive(half, "beginCipherHalf" + String(half));
  startCipherHalfClockAndKey(half, nowSec);
}

function getFirstHalfResultTitleKey(): any {
  if (cipherHalfScores[0] > cipherHalfScores[1]) return (mod.stringkeys as any).CipherFirstHalfTeam1Won;
  if (cipherHalfScores[1] > cipherHalfScores[0]) return (mod.stringkeys as any).CipherFirstHalfTeam2Won;
  return (mod.stringkeys as any).CipherFirstHalfTied;
}

function getFirstHalfResultTitleFallback(): string {
  if (cipherHalfScores[0] > cipherHalfScores[1]) return "TEAM 1 WON FIRST HALF";
  if (cipherHalfScores[1] > cipherHalfScores[0]) return "TEAM 2 WON FIRST HALF";
  return "FIRST HALF TIED";
}

function clearCipherTransitionSupervisorState(): void {
  cipherLiveTransitionSupervisorKind = "none";
  cipherLiveTransitionSupervisorToken = 0;
  cipherLiveTransitionSupervisorDeadlineAtSec = 0;
  cipherLiveTransitionSupervisorDeadlineTick = 0;
  cipherLiveTransitionSupervisorLastShownSeconds = -1;
}

function isCipherTransitionSupervisorCurrent(): boolean {
  if (cipherLiveTransitionSupervisorKind === "secondHalf") {
    return cipherSecondHalfTransitionActive && cipherSecondHalfTransitionToken === cipherLiveTransitionSupervisorToken;
  }
  if (cipherLiveTransitionSupervisorKind === "suddenDeath") {
    return cipherSuddenDeathTransitionActive && cipherSuddenDeathTransitionToken === cipherLiveTransitionSupervisorToken;
  }
  return false;
}

function startCipherTransitionSupervisorStage(
  stage: CipherSecondHalfTransitionStage,
  durationSeconds: number,
  nowSec: number
): void {
  cipherSecondHalfTransitionStage = stage;
  const safeDurationSeconds = mod.Max(0, durationSeconds);
  cipherLiveTransitionSupervisorDeadlineAtSec = nowSec + safeDurationSeconds;
  cipherLiveTransitionSupervisorDeadlineTick = serverTickCount + mod.Ceiling(safeDurationSeconds * TICK_RATE);
  cipherLiveTransitionSupervisorLastShownSeconds = -1;
  setCipherTransitionCountdownSeconds(safeDurationSeconds);
}

function getCipherTransitionStageDurationSeconds(stage: CipherSecondHalfTransitionStage): number {
  if (stage === "intermission") return CIPHER_HALFTIME_INTERMISSION_SECONDS;
  if (stage === "deploy") return CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS;
  if (stage === "countdown") return CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS;
  if (stage === "finalizing") return CIPHER_TRANSITION_FINALIZER_WATCHDOG_SECONDS;
  return 0;
}

function repairCipherTransitionSupervisorDeadlineIfMissing(nowSec: number): void {
  const durationSeconds = getCipherTransitionStageDurationSeconds(cipherSecondHalfTransitionStage);
  if (durationSeconds <= 0) return;

  const maxFutureTicks = mod.Ceiling((durationSeconds + 2) * TICK_RATE);
  if (
    cipherLiveTransitionSupervisorDeadlineTick > 0 &&
    cipherLiveTransitionSupervisorDeadlineTick <= serverTickCount + maxFutureTicks
  ) {
    return;
  }

  startCipherTransitionSupervisorStage(cipherSecondHalfTransitionStage, durationSeconds, nowSec);
}

function getCipherTransitionSupervisorRemainingSeconds(nowSec: number): number {
  repairCipherTransitionSupervisorDeadlineIfMissing(nowSec);
  if (
    cipherSecondHalfTransitionStage === "intermission" ||
    cipherSecondHalfTransitionStage === "deploy" ||
    cipherSecondHalfTransitionStage === "countdown"
  ) {
    const remainingTicks = mod.Max(0, cipherLiveTransitionSupervisorDeadlineTick - serverTickCount);
    return mod.Max(0, mod.Ceiling(remainingTicks / TICK_RATE));
  }
  return mod.Max(0, mod.Ceiling(cipherLiveTransitionSupervisorDeadlineAtSec - nowSec));
}

function showCipherTransitionSupervisorHud(remainingSeconds: number): void {
  if (cipherLiveTransitionSupervisorKind === "none") return;
  const countdownStage = cipherSecondHalfTransitionStage === "countdown";
  const deployStage = cipherSecondHalfTransitionStage === "deploy";
  const intermissionStage = cipherSecondHalfTransitionStage === "intermission";
  const source =
    cipherLiveTransitionSupervisorKind +
    "_supervisor_" +
    cipherSecondHalfTransitionStage +
    "_" +
    String(remainingSeconds);

  showCipherTransitionHudSafe(
    source,
    countdownStage ? cipherTransitionStartsTitleKey : cipherTransitionDeployTitleKey,
    countdownStage ? cipherTransitionStartsTitleFallback : cipherTransitionDeployTitleFallback,
    cipherTransitionSubtitleKey,
    cipherTransitionSubtitleFallback,
    deployStage ? (mod.stringkeys as any).CipherForceDeployIn : (mod.stringkeys as any).CipherStartsIn,
    deployStage ? "FORCE DEPLOY IN {}" : "STARTS IN {}",
    remainingSeconds,
    !intermissionStage,
    deployStage
  );
}

function refreshCipherTransitionSupervisorSecond(remainingSeconds: number): void {
  if (cipherLiveTransitionSupervisorLastShownSeconds === remainingSeconds) return;
  cipherLiveTransitionSupervisorLastShownSeconds = remainingSeconds;
  setCipherTransitionCountdownSeconds(remainingSeconds);
  showCipherTransitionSupervisorHud(remainingSeconds);
  if (cipherSecondHalfTransitionStage === "countdown" && remainingSeconds > 0) {
    playCountdownHeartbeatSafe(
      cipherLiveTransitionSupervisorKind + "_supervisor_countdown_" + String(remainingSeconds),
      remainingSeconds <= 3 ? 0.85 : 0.6
    );
  }
}

function requestCipherTransitionReconcile(reason: string): void {
  if (!isCipherLiveTransitionActive() && cipherLiveStartSettlingStage === "none") return;
  cipherTransitionReconcileQueued = true;
  if (cipherTransitionReconcileReason.length <= 0) {
    cipherTransitionReconcileReason = reason;
  } else if (cipherTransitionReconcileReason.indexOf(reason) < 0) {
    cipherTransitionReconcileReason = cipherTransitionReconcileReason + ";" + reason;
  }
}

function runQueuedCipherTransitionReconcile(nowSec: number): void {
  if (
    cipherLiveStartSettlingStage !== "none" &&
    cipherLiveStartSettlingUntilSec > 0 &&
    nowSec >= cipherLiveStartSettlingUntilSec
  ) {
    finishRuntimeBotLiveStartSettle(cipherLiveStartSettleToken, cipherLiveStartSettlingStage, "transition_reconcile");
  }

  if (!cipherTransitionReconcileQueued) return;
  const reason = cipherTransitionReconcileReason;
  cipherTransitionReconcileQueued = false;
  cipherTransitionReconcileReason = "";

  if (!isCipherLiveTransitionActive()) return;

  repairCipherTransitionSupervisorDeadlineIfMissing(nowSec);

  if (cipherSecondHalfTransitionStage === "intermission") {
    verifyCipherTransitionPlayersUndeployed("transition_reconcile_intermission/" + reason);
    applyCipherTransitionInputLocksForPlayers("transition_reconcile_intermission/" + reason);
    return;
  }

  if (cipherSecondHalfTransitionStage === "deploy" || cipherSecondHalfTransitionStage === "countdown") {
    runCipherTransitionStepWorkSafe("transition_reconcile_" + cipherSecondHalfTransitionStage + "/" + reason, false);
    tickRuntimeBotStagedSpawning(nowSec, "transition_reconcile_" + cipherSecondHalfTransitionStage);
  }
}

function abortCipherTransitionSupervisor(context: string, resetBombRuntime: boolean = true): void {
  const hadTransition = cipherLiveTransitionSupervisorKind !== "none";
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cancelCipherTransitionWorkQueue(context + "_abort");
  clearCipherTransitionSupervisorState();
  if (hadTransition) {
    clearCipherLivePhaseTransitionRuntimeState(context, true, resetBombRuntime);
  }
  hideCipherTransitionHudForAllPlayers();
  SetCountdownOverlayVisible(false);
}

function verifyCipherTransitionPlayersUndeployed(source: string): void {
  const players: Player[] = [];
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!isRequiredSecondHalfDeployPlayer(p)) return;
    players.push(p);
  });

  if (players.length <= 0) return;

  let scanned = 0;
  let processed = 0;
  while (scanned < players.length && processed < CIPHER_TRANSITION_UNDEPLOY_WORK_PER_TICK) {
    const idx = mod.Modulo(cipherTransitionUndeployCursor, players.length);
    cipherTransitionUndeployCursor = mod.Modulo(cipherTransitionUndeployCursor + 1, players.length);
    scanned += 1;

    const p = players[idx];
    if (!p || !mod.IsPlayerValid(p.player)) continue;
    if (!p.isDeployed) continue;

    processed += 1;
    try {
      setCipherSecondHalfDeployFreezeForPlayer(p.player, true, source);
      mod.SetRedeployTime(p.player, 9999);
      mod.UndeployPlayer(p.player);
    } catch (err) {
      LogRuntimeError("TransitionUndeployVerify/" + source + "/" + String(p.id), err);
    }
  }
}

function enterCipherSecondHalfDeploySupervisorStage(nowSec: number): void {
  cipherSecondHalfForceDeployIssuedForTransitionToken = 0;
  startCipherTransitionSupervisorStage("deploy", CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS, nowSec);

  try {
    clearCipherSecondHalfDeployFreezeForAllPlayers();
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/clearFreeze", err);
  }

  try {
    if (cipherLiveTransitionSupervisorKind === "suddenDeath") {
      prepareCipherSuddenDeathForLive("sudden_death_supervisor_deploy");
    } else {
      prepareCipherHalfForLive(2, "second_half_supervisor_deploy", 0);
    }
  } catch (err) {
    if (cipherLiveTransitionSupervisorKind === "suddenDeath") {
      cipherCurrentHalf = 2;
      cipherMatchStage = "suddenDeath";
    } else {
      cipherCurrentHalf = 2;
      cipherMatchStage = "half2";
    }
    LogRuntimeError("TransitionDeployStage/prepareLive", err);
  }

  try {
    applyCipherSecondHalfHqSpawns(cipherLiveTransitionSupervisorKind + "_supervisor_deploy");
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/hqSpawns", err);
  }
  try {
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/spawnMode", err);
  }
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    try {
      mod.SetRedeployTime(p.player, 0);
      p.setCapturePoint(null);
      clearCipherSecondHalfDeployReadyForPlayer(p.id, true);
    } catch (err) {
      LogRuntimeError("TransitionDeployStage/playerPrep/" + String(p.id), err);
    }
  });
  try {
    mod.UndeployAllPlayers();
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/undeployAll", err);
  }
  try {
    applyCipherSecondHalfHqSpawns(cipherLiveTransitionSupervisorKind + "_supervisor_deploy_after_undeploy");
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/hqAfterUndeploy", err);
  }
  markCipherSecondHalfDeployRequiredPlayers();
  resetRuntimeBotStagedSpawnSchedule();
  try {
    tickRuntimeBotStagedSpawning(nowSec, cipherLiveTransitionSupervisorKind + "_supervisor_deploy_enter");
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/botStagedSpawn", err);
  }
  runCipherTransitionStepWorkSafe(cipherLiveTransitionSupervisorKind + "_supervisor_deploy_enter", false);
}

function enterCipherTransitionCountdownSupervisorStage(
  nowSec: number,
  forceMissingSecondHalfPlayers: boolean = false
): void {
  startCipherTransitionSupervisorStage("countdown", CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS, nowSec);
  if (cipherLiveTransitionSupervisorKind === "secondHalf" || cipherLiveTransitionSupervisorKind === "suddenDeath") {
    try {
      applyCipherSecondHalfHqSpawns(cipherLiveTransitionSupervisorKind + "_supervisor_countdown_enter");
    } catch (err) {
      LogRuntimeError("TransitionCountdownStage/hqSpawns", err);
    }
    if (forceMissingSecondHalfPlayers) {
      try {
        forceDeployMissingCipherSecondHalfPlayersOnce(cipherLiveTransitionSupervisorKind + "_supervisor_countdown_enter");
      } catch (err) {
        LogRuntimeError("TransitionCountdownStage/forceDeploy", err);
      }
    }
  }
  runCipherTransitionStepWorkSafe(cipherLiveTransitionSupervisorKind + "_supervisor_countdown_enter", false);
}

function restoreCipherTransitionPlayersForLive(redeploySeconds: number, context: string): void {
  serverPlayers.forEach((p) => {
    try {
      if (!p || !mod.IsPlayerValid(p.player)) return;
      mod.SetRedeployTime(p.player, redeploySeconds);
      setReadyPhaseProtectionForPlayer(p.player, false);
      p.setCapturePoint(null);
    } catch (err) {
      LogRuntimeError("TransitionComplete/playerRestore/" + context + "/" + String(p?.id ?? -1), err);
    }
  });
}

function beginCipherTransitionWorkQueue(checkpoint: string): number {
  cipherTransitionWorkToken += 1;
  cipherTransitionWorkQueue = [];
  cipherTransitionLastCheckpoint = checkpoint;
  cipherTransitionLastError = "";
  return cipherTransitionWorkToken;
}

function cancelCipherTransitionWorkQueue(checkpoint: string): void {
  cipherTransitionWorkToken += 1;
  cipherTransitionWorkQueue = [];
  cipherTransitionFinalizerActive = false;
  cipherTransitionFinalizerKind = "none";
  cipherTransitionFinalizerToken = 0;
  cipherTransitionFinalizerStartedAtSec = 0;
  cipherTransitionEngineMutationActive = false;
  cipherSuppressObjectiveEventsUntilSec = 0;
  cipherTransitionLastCheckpoint = checkpoint;
}

function logCipherTransitionCheckpoint(name: string): void {
  const key = String(cipherTransitionWorkToken) + "/" + name;
  if (liveTransitionCheckpointSeenByKey[key] === true) return;
  liveTransitionCheckpointSeenByKey[key] = true;
  try {
    mod.DisplayHighlightedWorldLogMessage(mod.Message("[CIPHER TRANSITION] {}", name));
  } catch (_err) {}
}

function enqueueCipherTransitionWork(
  token: number,
  name: string,
  cost: CipherTransitionWorkCost,
  run: () => void
): void {
  cipherTransitionWorkQueue.push({ token, name, cost, run });
}

function runCipherTransitionWorkItem(item: CipherTransitionWorkItem): void {
  cipherTransitionLastCheckpoint = item.name;
  logCipherTransitionCheckpoint(item.name);
  const previousMutationActive = cipherTransitionEngineMutationActive;
  if (item.cost === "heavy") {
    cipherTransitionEngineMutationActive = true;
    suppressCipherObjectiveEventsForTransition(item.name);
  }
  try {
    item.run();
  } catch (err) {
    cipherTransitionLastError = item.name + ": " + String(err);
    LogRuntimeError("TransitionWork/" + item.name, err);
  } finally {
    cipherTransitionEngineMutationActive = previousMutationActive;
  }
}

function drainCipherTransitionWorkQueue(): void {
  let normalUsed = 0;
  let heavyUsed = 0;

  while (cipherTransitionWorkQueue.length > 0) {
    const item = cipherTransitionWorkQueue[0];
    if (!item || item.token !== cipherTransitionWorkToken) {
      cipherTransitionWorkQueue.shift();
      continue;
    }

    if (item.cost === "heavy") {
      if (heavyUsed >= CIPHER_TRANSITION_HEAVY_WORK_PER_TICK || normalUsed > 0) return;
      cipherTransitionWorkQueue.shift();
      heavyUsed += 1;
      runCipherTransitionWorkItem(item);
      return;
    }

    if (normalUsed >= CIPHER_TRANSITION_NORMAL_WORK_PER_TICK) return;
    cipherTransitionWorkQueue.shift();
    normalUsed += 1;
    runCipherTransitionWorkItem(item);
  }
}

function getCipherObjectiveDefinitionsForHalf(half: CipherHalfIndex): ObjectiveDefinition[] {
  const defs: ObjectiveDefinition[] = [];
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const def = OBJECTIVE_DEFINITIONS[i];
    if (def.half === half) defs.push(def);
  }
  return defs;
}

function prepareCipherTransitionScriptStateForLiveStage(
  stage: CipherMatchStage,
  context: string
): void {
  cipherCurrentHalf = stage === "half1" ? 1 : 2;
  cipherMatchStage = stage;
  cipherHalfScores = [0, 0];
  cipherPendingScoreTransitionTeam = teamNeutral;
  resetCipherSuddenDeathState();
  clearAllCipherNodeRebootState(context, false);
  resetCipherSpawnRoutingState();
  captureCreditByCpId = {};
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  clearBotObjectiveAssignments();
}

function resetCipherTransitionObjectiveRuntimeOnly(context: string): void {
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  disableAllObjectiveInteractPoints(context + "_interacts");
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const cp = serverCapturePoints[cpId];
    if (cp) {
      (cp as any)._capturingTeam = teamNeutral;
      (cp as any)._captureProgress = 0;
      (cp as any)._previousCaptureProgress = 0;
      cp.clearOnPoint();
    }
  }
}

function disableCipherObjectiveHalfSurface(half: CipherHalfIndex, context: string): void {
  const defs = getCipherObjectiveDefinitionsForHalf(half);
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    applyScriptedObjectiveCapturePointSurface(
      def.cpId,
      def.defendingTeam,
      false,
      context + "_cp_" + String(def.cpId),
      true
    );
  }
}

function enableCipherObjectiveHalfSector(half: CipherHalfIndex, context: string): void {
  const defs = getCipherObjectiveDefinitionsForHalf(half);
  const enabledSectorById: { [sectorId: number]: boolean | undefined } = {};
  for (let i = 0; i < defs.length; i++) {
    const sectorId = defs[i].sectorId;
    if (enabledSectorById[sectorId] === true) continue;
    enabledSectorById[sectorId] = true;
    safeEnableSectorObjectiveById(sectorId, true, context + "_sector_" + String(sectorId), true);
  }
}

function disableCipherObjectiveHalfSector(half: CipherHalfIndex, context: string): void {
  const defs = getCipherObjectiveDefinitionsForHalf(half);
  const disabledSectorById: { [sectorId: number]: boolean | undefined } = {};
  for (let i = 0; i < defs.length; i++) {
    const sectorId = defs[i].sectorId;
    if (disabledSectorById[sectorId] === true) continue;
    disabledSectorById[sectorId] = true;
    safeEnableSectorObjectiveById(sectorId, false, context + "_sector_" + String(sectorId), true);
  }
}

function enableCipherObjectiveHalfCapturePoints(half: CipherHalfIndex, context: string): void {
  const defs = getCipherObjectiveDefinitionsForHalf(half);
  for (let i = 0; i < defs.length; i++) {
    const def = defs[i];
    applyScriptedObjectiveCapturePointSurface(
      def.cpId,
      def.defendingTeam,
      true,
      context + "_cp_" + String(def.cpId),
      true
    );
  }
  UpdateObjectiveCaptureInteractionState();
}

function applyCipherMinimalHalfObjectiveSurface(half: CipherHalfIndex, context: string): void {
  const inactiveHalf: CipherHalfIndex = half === 1 ? 2 : 1;
  disableCipherObjectiveHalfSector(inactiveHalf, context + "_inactive_sector");
  disableCipherObjectiveHalfSurface(inactiveHalf, context + "_inactive_cps");
  enableCipherObjectiveHalfSector(half, context + "_active_sector");
  enableCipherObjectiveHalfCapturePoints(half, context + "_active_cps");
  disableHardObjectiveMcoms(context + "_hard_mcoms");
}

function applyCipherSecondHalfHqDisableOnly(_context: string): void {
  SafeEnableHQById(TEAM1_INITIAL_HQ, false);
  SafeEnableHQById(TEAM2_INITIAL_HQ, false);
}

function applyCipherSecondHalfHqEnableOnly(context: string): void {
  SafeEnableHQById(TEAM1_LIVE_HQ, true);
  SafeEnableHQById(TEAM2_LIVE_HQ, true);
  currentDynamicHqTeam1 = TEAM1_LIVE_HQ;
  currentDynamicHqTeam2 = TEAM2_LIVE_HQ;
  enforceReadyupHqsDisabledOutsidePrematch(context);
}

function finalizeCipherTransitionLiveStart(
  kind: CipherLiveTransitionSupervisorKind,
  context: string
): void {
  if (kind !== "secondHalf" && kind !== "suddenDeath") return;
  const expectedStage: CipherMatchStage = kind === "secondHalf" ? "half2" : "suddenDeath";

  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cipherPhaseTransitionUndeployIgnoreUntilSec = 0;
  cipherSuddenDeathUndeployIgnoreUntilSec = 0;
  clearCipherTransitionSupervisorState();

  cipherTransitionFinalizerActive = false;
  cipherTransitionFinalizerKind = "none";
  cipherTransitionFinalizerToken = 0;
  cipherTransitionFinalizerStartedAtSec = 0;
  cipherTransitionWorkQueue = [];
  cipherTransitionEngineMutationActive = false;
  cipherSuppressObjectiveEventsUntilSec =
    getCurrentSchedulerNowSeconds() + CIPHER_TRANSITION_OBJECTIVE_EVENT_SUPPRESS_SECONDS;
  cipherTransitionLastCheckpoint = context + "/complete";

  startCipherPostTransitionLiveInputUnlock(expectedStage, context + "_input_unlock");
  startRuntimeBotLiveStartSettle(expectedStage, context + "_bot_settle");
  scheduleCipherLiveStartKeySpawn(2, expectedStage, context + "_live_start");
}

function forceFinishCipherTransitionFinalizer(nowSec: number, reason: string): void {
  const kind =
    cipherTransitionFinalizerKind !== "none"
      ? cipherTransitionFinalizerKind
      : cipherLiveTransitionSupervisorKind;
  if (kind !== "secondHalf" && kind !== "suddenDeath") return;

  const context =
    (kind === "secondHalf" ? "second_half" : "sudden_death") +
    "_supervisor_watchdog_" +
    reason;
  LogRuntimeError(
    "TransitionFinalizerWatchdog/" + reason,
    cipherTransitionLastCheckpoint + "/" + cipherTransitionLastError
  );

  try {
    SetCountdownOverlayVisible(false);
  } catch (err) {
    LogRuntimeError("TransitionWatchdog/countdownOverlay/" + context, err);
  }
  try {
    hideCipherTransitionHudForAllPlayersNoBuild();
  } catch (err) {
    LogRuntimeError("TransitionWatchdog/hideHud/" + context, err);
  }
  try {
    clearCipherLivePhaseTransitionRuntimeState(context, true, false);
  } catch (err) {
    LogRuntimeError("TransitionWatchdog/clearRuntime/" + context, err);
  }
  try {
    clearAllCipherNodeRebootState(context + "_node_cleanup", true);
  } catch (err) {
    LogRuntimeError("TransitionWatchdog/nodeCleanup/" + context, err);
  }

  if (kind === "secondHalf") {
    try {
      prepareCipherTransitionScriptStateForLiveStage("half2", context + "_state");
    } catch (err) {
      cipherCurrentHalf = 2;
      cipherMatchStage = "half2";
      LogRuntimeError("TransitionWatchdog/prepareHalf/" + context, err);
    }
    try {
      applyCipherSecondHalfHqDisableOnly(context + "_hq_disable");
      applyCipherSecondHalfHqEnableOnly(context + "_hq_enable");
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/hqSpawns/" + context, err);
    }
    try {
      resetCipherTransitionObjectiveRuntimeOnly(context + "_objective_runtime");
      applyCipherMinimalHalfObjectiveSurface(2, context + "_surface");
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/objectiveSurface/" + context, err);
    }
    try {
      restoreCipherTransitionPlayersForLive(REDEPLOY_TIME, context);
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/restorePlayers/" + context, err);
    }
    try {
      showCipherPhaseNoticeForAllPlayers((mod.stringkeys as any).CipherSecondHalfLive, "SECOND HALF", 3);
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/notice/" + context, err);
    }
    try {
      liveClockTimeoutHoldActive = false;
      liveClockStarted = false;
      beginScriptOwnedLiveClockPhase(ROUND_TIME, nowSec, true);
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/clock/" + context, err);
    }
  } else {
    try {
      prepareCipherTransitionScriptStateForLiveStage("suddenDeath", context + "_state");
      serverPlayers.forEach((p) => {
        cipherSuddenDeathEliminatedByPlayerId[p.id] = false;
      });
    } catch (err) {
      cipherCurrentHalf = 2;
      cipherMatchStage = "suddenDeath";
      LogRuntimeError("TransitionWatchdog/prepareSuddenDeath/" + context, err);
    }
    try {
      resetCipherTransitionObjectiveRuntimeOnly(context + "_objective_runtime");
      applyCipherMinimalHalfObjectiveSurface(2, context + "_surface");
      applyCipherSecondHalfHqDisableOnly(context + "_hq_disable");
      applyCipherSecondHalfHqEnableOnly(context + "_hq_enable");
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/suddenDeathSurface/" + context, err);
    }
    try {
      restoreCipherTransitionPlayersForLive(9999, context);
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/restorePlayers/" + context, err);
    }
    try {
      liveClockTimeoutHoldActive = false;
      liveClockStarted = false;
      beginOvertimeClock(nowSec);
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/clock/" + context, err);
    }
    try {
      updateCipherSuddenDeathAliveHudForAllPlayers();
    } catch (err) {
      LogRuntimeError("TransitionWatchdog/aliveHud/" + context, err);
    }
  }

  try {
    updateCipherCounterWorldIcons(true);
    UpdateTopFlagColorsForAllPlayers();
  } catch (err) {
    LogRuntimeError("TransitionWatchdog/objectiveIcons/" + context, err);
  }
  try {
    UpdateScoreboard();
    SetUIScores();
    SetUITime(nowSec);
  } catch (err) {
    LogRuntimeError("TransitionWatchdog/uiSync/" + context, err);
  }

  finalizeCipherTransitionLiveStart(kind, context);
}

function finishCipherTransitionFinalizer(
  token: number,
  kind: CipherLiveTransitionSupervisorKind,
  context: string
): void {
  if (token !== cipherTransitionFinalizerToken) return;
  finalizeCipherTransitionLiveStart(kind, context);
}

function beginCipherTransitionFinalizer(
  kind: CipherLiveTransitionSupervisorKind,
  nowSec: number
): void {
  if (kind !== "secondHalf" && kind !== "suddenDeath") return;
  if (!isCipherTransitionSupervisorCurrent()) return;
  if (cipherTransitionFinalizerActive && cipherSecondHalfTransitionStage === "finalizing") return;

  const context = kind === "secondHalf" ? "second_half_supervisor_finalize" : "sudden_death_supervisor_finalize";
  const token = beginCipherTransitionWorkQueue(context);
  cipherTransitionFinalizerActive = true;
  cipherTransitionFinalizerKind = kind;
  cipherTransitionFinalizerToken = token;
  cipherTransitionFinalizerStartedAtSec = nowSec;
  cipherSecondHalfTransitionStage = "finalizing";
  cipherLiveTransitionSupervisorDeadlineAtSec = nowSec + CIPHER_TRANSITION_FINALIZER_WATCHDOG_SECONDS;
  cipherLiveTransitionSupervisorLastShownSeconds = -1;
  setCipherTransitionCountdownSeconds(0);

  enqueueCipherTransitionWork(token, context + "/countdownOverlay", "normal", () => SetCountdownOverlayVisible(false));
  enqueueCipherTransitionWork(token, context + "/hideHudNoBuild", "normal", () => hideCipherTransitionHudForAllPlayersNoBuild());
  enqueueCipherTransitionWork(token, context + "/suppressEvents", "normal", () =>
    suppressCipherObjectiveEventsForTransition(context + "_start")
  );
  enqueueCipherTransitionWork(token, context + "/stopKeyTimers", "heavy", () => {
    invalidateDeferredBombSpawnTimer();
    invalidateBombReturnToBaseTimer();
    clearNextKeyUnlockCountdown(context + "_stop_key_timers", true);
  });
  enqueueCipherTransitionWork(token, context + "/nodeCleanup", "heavy", () =>
    clearAllCipherNodeRebootState(context + "_node_cleanup", true)
  );
  enqueueCipherTransitionWork(token, context + "/clearRuntime", "heavy", () =>
    clearCipherLivePhaseTransitionRuntimeState(context, true, false)
  );

  if (kind === "secondHalf") {
    enqueueCipherTransitionWork(token, context + "/stateHalf2", "heavy", () =>
      prepareCipherTransitionScriptStateForLiveStage("half2", context + "_state")
    );
    enqueueCipherTransitionWork(token, context + "/objectiveRuntime", "heavy", () =>
      resetCipherTransitionObjectiveRuntimeOnly(context + "_objective_runtime")
    );
    enqueueCipherTransitionWork(token, context + "/hqDisable12", "heavy", () =>
      applyCipherSecondHalfHqDisableOnly(context + "_hq_disable")
    );
    enqueueCipherTransitionWork(token, context + "/hqEnable34", "heavy", () =>
      applyCipherSecondHalfHqEnableOnly(context + "_hq_enable")
    );
    enqueueCipherTransitionWork(token, context + "/disableHalf1Sector", "heavy", () =>
      disableCipherObjectiveHalfSector(1, context + "_disable_half1_sector")
    );
    enqueueCipherTransitionWork(token, context + "/disableHalf1Cps", "heavy", () =>
      disableCipherObjectiveHalfSurface(1, context + "_disable_half1_cps")
    );
    enqueueCipherTransitionWork(token, context + "/enableHalf2Sector", "heavy", () =>
      enableCipherObjectiveHalfSector(2, context + "_enable_half2_sector")
    );
    enqueueCipherTransitionWork(token, context + "/enableHalf2Cps", "heavy", () =>
      enableCipherObjectiveHalfCapturePoints(2, context + "_enable_half2_cps")
    );
    enqueueCipherTransitionWork(token, context + "/hardDisableMcoms", "heavy", () =>
      disableHardObjectiveMcoms(context + "_hard_mcoms")
    );
    enqueueCipherTransitionWork(token, context + "/restorePlayers", "heavy", () =>
      restoreCipherTransitionPlayersForLive(REDEPLOY_TIME, context)
    );
    enqueueCipherTransitionWork(token, context + "/noticeClock", "normal", () => {
      showCipherPhaseNoticeForAllPlayers((mod.stringkeys as any).CipherSecondHalfLive, "SECOND HALF", 3);
      liveClockTimeoutHoldActive = false;
      liveClockStarted = false;
      beginScriptOwnedLiveClockPhase(ROUND_TIME, nowSec, true);
    });
    enqueueCipherTransitionWork(token, context + "/objectiveIcons", "heavy", () => {
      updateCipherCounterWorldIcons(true);
      UpdateTopFlagColorsForAllPlayers();
    });
    enqueueCipherTransitionWork(token, context + "/uiSync", "normal", () => {
      UpdateScoreboard();
      SetUIScores();
      SetUITime(nowSec);
    });
    enqueueCipherTransitionWork(token, context + "/finish", "normal", () =>
      finishCipherTransitionFinalizer(token, "secondHalf", context)
    );
  } else {
    enqueueCipherTransitionWork(token, context + "/stateSuddenDeath", "heavy", () => {
      prepareCipherTransitionScriptStateForLiveStage("suddenDeath", context + "_state");
      serverPlayers.forEach((p) => {
        cipherSuddenDeathEliminatedByPlayerId[p.id] = false;
      });
    });
    enqueueCipherTransitionWork(token, context + "/objectiveRuntime", "heavy", () =>
      resetCipherTransitionObjectiveRuntimeOnly(context + "_objective_runtime")
    );
    enqueueCipherTransitionWork(token, context + "/hqDisable12", "heavy", () =>
      applyCipherSecondHalfHqDisableOnly(context + "_hq_disable")
    );
    enqueueCipherTransitionWork(token, context + "/hqEnable34", "heavy", () =>
      applyCipherSecondHalfHqEnableOnly(context + "_hq_enable")
    );
    enqueueCipherTransitionWork(token, context + "/surfaceHalf2", "heavy", () =>
      applyCipherMinimalHalfObjectiveSurface(2, context + "_surface")
    );
    enqueueCipherTransitionWork(token, context + "/restorePlayers", "heavy", () =>
      restoreCipherTransitionPlayersForLive(9999, context)
    );
    enqueueCipherTransitionWork(token, context + "/clockAliveHud", "normal", () => {
      liveClockTimeoutHoldActive = false;
      liveClockStarted = false;
      beginOvertimeClock(nowSec);
      updateCipherSuddenDeathAliveHudForAllPlayers();
    });
    enqueueCipherTransitionWork(token, context + "/objectiveIcons", "heavy", () => {
      updateCipherCounterWorldIcons(true);
      UpdateTopFlagColorsForAllPlayers();
    });
    enqueueCipherTransitionWork(token, context + "/uiSync", "normal", () => {
      UpdateScoreboard();
      SetUIScores();
      SetUITime(nowSec);
    });
    enqueueCipherTransitionWork(token, context + "/finish", "normal", () =>
      finishCipherTransitionFinalizer(token, "suddenDeath", context)
    );
  }
}

function tickCipherTransitionFinalizer(nowSec: number): void {
  if (!cipherTransitionFinalizerActive) return;
  drainCipherTransitionWorkQueue();
  if (!cipherTransitionFinalizerActive) return;

  if (cipherTransitionWorkQueue.length <= 0) {
    forceFinishCipherTransitionFinalizer(nowSec, "queue_empty");
    return;
  }

  if (
    cipherTransitionFinalizerStartedAtSec > 0 &&
    nowSec - cipherTransitionFinalizerStartedAtSec >= CIPHER_TRANSITION_FINALIZER_WATCHDOG_SECONDS
  ) {
    forceFinishCipherTransitionFinalizer(nowSec, "timeout");
  }
}

function completeCipherTransitionSupervisorGuarded(
  kind: CipherLiveTransitionSupervisorKind,
  nowSec: number
): void {
  beginCipherTransitionFinalizer(kind, nowSec);
}

function completeCipherSecondHalfSupervisor(nowSec: number): void {
  completeCipherTransitionSupervisorGuarded("secondHalf", nowSec);
}

function completeCipherSuddenDeathSupervisor(nowSec: number): void {
  completeCipherTransitionSupervisorGuarded("suddenDeath", nowSec);
}

function completeCipherTransitionSupervisor(nowSec: number): void {
  if (cipherLiveTransitionSupervisorKind === "secondHalf") {
    completeCipherSecondHalfSupervisor(nowSec);
  } else if (cipherLiveTransitionSupervisorKind === "suddenDeath") {
    completeCipherSuddenDeathSupervisor(nowSec);
  }
}

function recoverCipherTransitionSupervisorTickFailure(
  nowSec: number,
  failedStage: CipherSecondHalfTransitionStage,
  err: any
): void {
  LogRuntimeError(
    "TransitionSupervisor/tick/" + cipherLiveTransitionSupervisorKind + "/" + failedStage,
    err
  );

  try {
    if (failedStage === "intermission") {
      enterCipherSecondHalfDeploySupervisorStage(nowSec);
      return;
    }

    if (failedStage === "deploy") {
      enterCipherTransitionCountdownSupervisorStage(nowSec, true);
      return;
    }

    if (failedStage === "countdown" || failedStage === "finalizing") {
      forceFinishCipherTransitionFinalizer(nowSec, "tick_failure");
    }
  } catch (recoverErr) {
    LogRuntimeError(
      "TransitionSupervisor/recover/" + cipherLiveTransitionSupervisorKind + "/" + failedStage,
      recoverErr
    );
    forceFinishCipherTransitionFinalizer(nowSec, "recover_failure");
  }
}

function tickCipherLiveTransitionSupervisorUnsafe(nowSec: number): boolean {
  if (cipherLiveTransitionSupervisorKind === "none") return false;

  if (gameStatus !== 3 || !isCipherTransitionSupervisorCurrent()) {
    abortCipherTransitionSupervisor("transition_supervisor_state_mismatch");
    return true;
  }

  if (cipherSecondHalfTransitionStage === "finalizing") {
    tickCipherTransitionFinalizer(nowSec);
    return true;
  }

  const remaining = getCipherTransitionSupervisorRemainingSeconds(nowSec);
  refreshCipherTransitionSupervisorSecond(remaining);

  if (cipherSecondHalfTransitionStage === "intermission") {
    try {
      applyCipherIntermissionFreezeForDeployedPlayers("second_half_supervisor_intermission");
      verifyCipherTransitionPlayersUndeployed(cipherLiveTransitionSupervisorKind + "_supervisor_intermission_verify");
    } catch (err) {
      LogRuntimeError("TransitionSupervisor/applyIntermissionFreeze", err);
    }
    if (remaining <= 0) enterCipherSecondHalfDeploySupervisorStage(nowSec);
    return true;
  }

  if (cipherSecondHalfTransitionStage === "deploy") {
    runCipherTransitionStepWorkSafe(cipherLiveTransitionSupervisorKind + "_supervisor_deploy", false);
    tickRuntimeBotStagedSpawning(nowSec, cipherLiveTransitionSupervisorKind + "_supervisor_deploy");
    const forceWindowReached = remaining <= CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS;
    if (hasAllRequiredCipherSecondHalfDeployersReady() || forceWindowReached) {
      enterCipherTransitionCountdownSupervisorStage(nowSec, forceWindowReached);
    }
    return true;
  }

  if (cipherSecondHalfTransitionStage === "countdown") {
    runCipherTransitionStepWorkSafe(cipherLiveTransitionSupervisorKind + "_supervisor_countdown", false);
    tickRuntimeBotStagedSpawning(nowSec, cipherLiveTransitionSupervisorKind + "_supervisor_countdown");
    if (remaining <= 0) completeCipherTransitionSupervisor(nowSec);
    return true;
  }

  abortCipherTransitionSupervisor("transition_supervisor_invalid_stage");
  return true;
}

function tickCipherLiveTransitionSupervisor(nowSec: number): boolean {
  const failedStage = cipherSecondHalfTransitionStage;
  try {
    return tickCipherLiveTransitionSupervisorUnsafe(nowSec);
  } catch (err) {
    recoverCipherTransitionSupervisorTickFailure(nowSec, failedStage, err);
    return true;
  }
}

function beginCipherSecondHalfSupervisor(
  nowSec: number,
  reason: CipherHalfTransitionReason = "scoreCap"
): void {
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  const transitionToken = beginCipherSecondHalfTransitionOwnership();
  const reasonKey =
    reason === "timeExpired"
      ? (mod.stringkeys as any).CipherHalftimeTimeExpired
      : (mod.stringkeys as any).CipherHalftimeScoreCap;
  const reasonFallback = reason === "timeExpired" ? "HALFTIME - TIME EXPIRED" : "HALFTIME - OBJECTIVE CAP REACHED";

  cipherLiveTransitionSupervisorKind = "secondHalf";
  cipherLiveTransitionSupervisorToken = transitionToken;
  cipherLiveTransitionSupervisorReason = reason;
  cipherSecondHalfTransitionActive = true;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "intermission";
  clearCipherLivePhaseTransitionRuntimeState("second_half_supervisor_enter", true, true);
  try {
    clearRuntimeBotState(true);
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/clearRuntimeBots", err);
  }
  cipherSecondHalfTransitionStage = "intermission";
  cipherTransitionUndeployCursor = 0;
  try {
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/spawnMode", err);
  }
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    try {
      mod.SetRedeployTime(p.player, 9999);
    } catch (err) {
      LogRuntimeError("SecondHalfSupervisor/redeployLock/" + String(p.id), err);
    }
  });
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;
  try {
    clearAllCipherNodeRebootState("second_half_supervisor_enter", true);
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/nodeCleanup", err);
  }
  try {
    HideAllObjectiveHoldProgressUi();
    HideAllDeployObjectiveTimerUi();
    clearBombNoticeState();
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/hideLiveUi", err);
  }
  cipherPhaseTransitionUndeployIgnoreUntilSec =
    nowSec +
    CIPHER_HALFTIME_INTERMISSION_SECONDS +
    CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS +
    CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS +
    CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS +
    2;

  cipherTransitionDeployTitleKey = getFirstHalfResultTitleKey();
  cipherTransitionDeployTitleFallback = getFirstHalfResultTitleFallback();
  cipherTransitionSubtitleKey = (mod.stringkeys as any).CipherSwitchingSides;
  cipherTransitionSubtitleFallback = "SWITCHING SIDES";
  cipherTransitionStartsTitleKey = (mod.stringkeys as any).CipherSecondHalfStarts;
  cipherTransitionStartsTitleFallback = "SECOND HALF STARTS IN";
  try {
    SetCountdownOverlayVisible(false);
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/countdownOverlay", err);
  }

  try {
    showCipherPhaseNoticeForAllPlayers(reasonKey, reasonFallback, 3);
  } catch (err) {
    LogRuntimeError("TransitionSupervisor/showHalftimeNotice", err);
  }

  startCipherTransitionSupervisorStage("intermission", CIPHER_HALFTIME_INTERMISSION_SECONDS, nowSec);
  verifyCipherTransitionPlayersUndeployed("second_half_supervisor_enter");
  tickCipherLiveTransitionSupervisor(nowSec);
}

function beginCipherSuddenDeathSupervisor(nowSec: number): void {
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  const transitionToken = beginCipherSuddenDeathTransitionOwnership();

  cipherLiveTransitionSupervisorKind = "suddenDeath";
  cipherLiveTransitionSupervisorToken = transitionToken;
  cipherSuddenDeathTransitionActive = true;
  cipherSecondHalfTransitionActive = false;
  cipherSecondHalfTransitionStage = "intermission";
  clearCipherLivePhaseTransitionRuntimeState("sudden_death_supervisor_enter", true, true);
  try {
    clearRuntimeBotState(true);
  } catch (err) {
    LogRuntimeError("SuddenDeathSupervisor/clearRuntimeBots", err);
  }
  cipherSecondHalfTransitionStage = "intermission";
  cipherTransitionUndeployCursor = 0;
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;
  try {
    clearAllCipherNodeRebootState("sudden_death_supervisor_enter", true);
  } catch (err) {
    LogRuntimeError("SuddenDeathSupervisor/nodeCleanup", err);
  }
  try {
    HideAllObjectiveHoldProgressUi();
    HideAllDeployObjectiveTimerUi();
    clearBombNoticeState();
  } catch (err) {
    LogRuntimeError("SuddenDeathSupervisor/hideLiveUi", err);
  }
  try {
    showCipherPhaseNoticeForAllPlayers((mod.stringkeys as any).CipherSuddenDeathOneLife, "SUDDEN DEATH - ONE LIFE", 5);
  } catch (err) {
    LogRuntimeError("TransitionSupervisor/showSuddenDeathNotice", err);
  }
  cipherTransitionDeployTitleKey = (mod.stringkeys as any).CipherSuddenDeathOneLife;
  cipherTransitionDeployTitleFallback = "SUDDEN DEATH";
  cipherTransitionStartsTitleKey = (mod.stringkeys as any).CipherSuddenDeathStarts;
  cipherTransitionStartsTitleFallback = "SUDDEN DEATH STARTS IN";
  cipherTransitionSubtitleKey = (mod.stringkeys as any).CipherNoRespawns;
  cipherTransitionSubtitleFallback = "NO RESPAWNS";
  cipherSuddenDeathUndeployIgnoreUntilSec =
    nowSec +
    CIPHER_HALFTIME_INTERMISSION_SECONDS +
    CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS +
    CIPHER_SECOND_HALF_FINAL_COUNTDOWN_SECONDS +
    CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS +
    2;
  cipherPhaseTransitionUndeployIgnoreUntilSec = cipherSuddenDeathUndeployIgnoreUntilSec;
  try {
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
  } catch (err) {
    LogRuntimeError("SuddenDeathSupervisor/spawnMode", err);
  }
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    try {
      mod.SetRedeployTime(p.player, 9999);
      p.setCapturePoint(null);
      clearCipherSecondHalfDeployReadyForPlayer(p.id, true);
    } catch (err) {
      LogRuntimeError("SuddenDeathSupervisor/redeployLock/" + String(p.id), err);
    }
  });
  startCipherTransitionSupervisorStage("intermission", CIPHER_HALFTIME_INTERMISSION_SECONDS, nowSec);
  verifyCipherTransitionPlayersUndeployed("sudden_death_supervisor_enter");
  tickCipherLiveTransitionSupervisor(nowSec);
}

async function runCipherHalftimeIntermission(
  reasonKey: any,
  reasonFallback: string,
  isCurrentTransition: () => boolean
): Promise<void> {
  if (!isCurrentTransition()) return;
  cipherSecondHalfTransitionStage = "intermission";
  cipherTransitionDeployTitleKey = getFirstHalfResultTitleKey();
  cipherTransitionDeployTitleFallback = getFirstHalfResultTitleFallback();
  cipherTransitionSubtitleKey = (mod.stringkeys as any).CipherSwitchingSides;
  cipherTransitionSubtitleFallback = "SWITCHING SIDES";
  cipherTransitionStartsTitleKey = (mod.stringkeys as any).CipherSecondHalfStarts;
  cipherTransitionStartsTitleFallback = "SECOND HALF STARTS IN";
  SetCountdownOverlayVisible(false);

  try {
    showCipherPhaseNoticeForAllPlayers(reasonKey, reasonFallback, 3);
  } catch (err) {
    LogRuntimeError("HalftimeIntermission/showPhaseNotice", err);
  }

  for (let remaining = CIPHER_HALFTIME_INTERMISSION_SECONDS; remaining > 0; remaining--) {
    if (
      !isCurrentTransition() ||
      gameStatus !== 3 ||
      !cipherSecondHalfTransitionActive ||
      cipherSecondHalfTransitionStage !== "intermission"
    ) {
      return;
    }

    setCipherTransitionCountdownSeconds(remaining);

    showCipherTransitionHudSafe(
      "second_half_intermission_hud_" + String(remaining),
      cipherTransitionDeployTitleKey,
      cipherTransitionDeployTitleFallback,
      cipherTransitionSubtitleKey,
      cipherTransitionSubtitleFallback,
      (mod.stringkeys as any).CipherStartsIn,
      "STARTS IN {}",
      remaining,
      false
    );

    try {
      applyCipherIntermissionFreezeForDeployedPlayers("second_half_intermission_" + String(remaining));
    } catch (err) {
      LogRuntimeError("HalftimeIntermission/applyFreeze", err);
    }

    await mod.Wait(1);
  }
}

async function runCipherSecondHalfTransition(reason: CipherHalfTransitionReason): Promise<void> {
  beginCipherSecondHalfSupervisor(getCurrentSchedulerNowSeconds(), reason);
}

function beginCipherSecondHalf(
  nowSec?: number,
  reason: CipherHalfTransitionReason = "scoreCap"
): void {
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  beginCipherSecondHalfSupervisor(nowSec ?? getCurrentSchedulerNowSeconds(), reason);
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
  beginCipherSuddenDeathSupervisor(getCurrentSchedulerNowSeconds());
}

function beginCipherSuddenDeath(nowSec?: number): void {
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  beginCipherSuddenDeathSupervisor(nowSec ?? getCurrentSchedulerNowSeconds());
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
  closeCipherAdminPanelsForAllPlayers();
  clearCipherAdminInteractPoint("enter_postmatch");
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearAllCipherNodeRebootState("enter_postmatch", true);
  clearCipherLivePhaseTransitionRuntimeState("enter_postmatch", true, true);
  clearRuntimeBotState(true);
  cipherPendingScoreTransitionTeam = teamNeutral;
  postmatchWinnerTeam = forcedWinner !== undefined ? forcedWinner : resolveWinningTeamFromScores();
  gameStatus = 4;
  mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);
  liveTimerIntroActive = false;
  liveTimerIntroEndsAtSec = 0;
  liveClockTimeoutHoldActive = false;
  HideAllObjectiveHoldProgressUi();
  HideAllDeployObjectiveTimerUi();
  deleteCipherSuddenDeathAliveHudForAllPlayers();
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
    scheduleCipherSuddenDeathPostmatch(scoringTeam, "sudden_death_score");
    return;
  }

  if (getCipherTeamTotalScore(scoringTeam) >= WIN_SCORE) {
    finalizePendingObjectiveAwardsForImmediateTransition("match_score_cap");
    enterPostmatchFromLive(scoringTeam);
    return;
  }

  const scoreIndex = getCipherTeamScoreIndex(scoringTeam);
  if (scoreIndex < 0) return;
  if (cipherMatchStage !== "half1") return;

  if (cipherHalfScores[scoreIndex] >= HALF_SCORE_CAP) {
    finalizePendingObjectiveAwardsForImmediateTransition("half_score_cap");
    beginCipherSecondHalf(getCurrentSchedulerNowSeconds(), "scoreCap");
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
    if (isCipherRuntimeBotPlayerId(sp.id)) return;
    if (isBotBackfillPlayerSafe(sp.player)) return;
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

function scheduleCipherSuddenDeathPostmatch(winner: mod.Team, source: string): void {
  if (mod.Equals(winner, teamNeutral)) return;
  if (cipherSuddenDeathPostmatchPending === true) return;

  cipherSuddenDeathPostmatchPending = true;
  cipherPendingScoreTransitionTeam = teamNeutral;
  liveClockTimeoutHoldActive = false;

  try {
    updateCipherSuddenDeathAliveHudForAllPlayers();
  } catch (err) {
    LogRuntimeError("SuddenDeathPostmatchHud/" + source, err);
  }

  // Do not enter postmatch directly inside mandown/death/score event stacks.
  // Portal can crash if we clear objectives/UI/key state while the engine is still processing combat events.
  Timers.setTimeout(() => {
    if (gameStatus !== 3 || cipherMatchStage !== "suddenDeath") {
      cipherSuddenDeathPostmatchPending = false;
      return;
    }

    try {
      enterPostmatchFromLive(winner);
    } catch (err) {
      cipherSuddenDeathPostmatchPending = false;
      LogRuntimeError("SuddenDeathPostmatch/" + source, err);
    }
  }, 250);
}

function consumeCipherSuddenDeathLife(playerId: number, source: string): void {
  if (!isCipherSuddenDeathActive()) return;
  if (cipherSuddenDeathPostmatchPending === true) return;
  if (cipherSuddenDeathEliminatedByPlayerId[playerId] === true) return;

  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;

  const team = mod.GetTeam(sp.player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

  cipherSuddenDeathEliminatedByPlayerId[playerId] = true;
  playerInMandownByPlayerId[playerId] = true;

  try {
    mod.SetRedeployTime(sp.player, 9999);
  } catch (err) {
    LogRuntimeError("SuddenDeathSetRedeployTime/" + source, err);
  }

  try {
    updateCipherSuddenDeathAliveHudForAllPlayers();
  } catch (err) {
    LogRuntimeError("SuddenDeathAliveHud/" + source, err);
  }

  const winner = resolveCipherSuddenDeathEliminationWinner();
  scheduleCipherSuddenDeathPostmatch(winner, source);
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
    if (!mod.Equals(winner, teamNeutral)) {
      scheduleCipherSuddenDeathPostmatch(winner, "sudden_death_timeout");
      return;
    }

    enterPostmatchFromLive(teamNeutral);
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
  delete nextKeyUnlockHudLastStateByPlayerId[playerId];
}

function getCipherKeyUiPlayerSnapshot(lazyRefresh: boolean = true): Player[] {
  if (lazyRefresh && cipherKeyActivePlayerIdsSnapshot.length <= 0 && serverPlayers.size > 0) {
    refreshCipherKeyPlayerSnapshots("lazy_ui_snapshot");
  }

  const players: Player[] = [];
  for (let i = 0; i < cipherKeyActivePlayerIdsSnapshot.length; i++) {
    const playerId = cipherKeyActivePlayerIdsSnapshot[i];

    if (isCipherRuntimeBotPlayerId(playerId)) continue;

    const p = cipherKeyPlayerByIdSnapshot[playerId] ?? serverPlayers.get(playerId);
    if (!p) continue;
    if (isBotBackfillPlayerSafe(p.player)) continue;

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
    size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
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
        size: [SAFE_UI_ROOT_WIDTH, SAFE_UI_ROOT_HEIGHT],
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
  public nextKeyUnlockContainerWidget: mod.UIWidget;
  public nextKeyUnlockTextWidget: mod.UIWidget;
  public bombCarrierUiLastVisible: boolean;
  public bombCarrierUiLastVersion: number;
  public bombCarrierUiLastAlphaBucket: number;
  public bombNoticeUiLastStateKey: string;
  public nextKeyUnlockHudLastStateKey: string;
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
  public cipherSuddenDeathAliveRootWidget: mod.UIWidget;
  public cipherSuddenDeathAlivePanelWidget: mod.UIWidget;
  public cipherSuddenDeathAliveTitleWidget: mod.UIWidget;
  public cipherSuddenDeathFriendlyAliveWidget: mod.UIWidget;
  public cipherSuddenDeathEnemyAliveWidget: mod.UIWidget;
  public cipherSuddenDeathFriendlyAliveSlotWidgets: mod.UIWidget[];
  public cipherSuddenDeathEnemyAliveSlotWidgets: mod.UIWidget[];

  public flagWidget: { [key: string]: mod.UIWidget };

  public activeFlagContainerWidget: mod.UIWidget;
  public activeFlagFriendlyWidget: mod.UIWidget;
  public activeFlagEnemyWidget: mod.UIWidget;
  public activeFlagWidget: mod.UIWidget;

  private _scoreboard: number[]; // [score, kills, deaths, keyTimeSeconds, nodeOverloads]
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
    this.nextKeyUnlockContainerWidget = null as any;
    this.nextKeyUnlockTextWidget = null as any;
    this.bombCarrierUiLastVisible = false;
    this.bombCarrierUiLastVersion = -1;
    this.bombCarrierUiLastAlphaBucket = -1;
    this.bombNoticeUiLastStateKey = "";
    this.nextKeyUnlockHudLastStateKey = "";
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
    this.cipherSuddenDeathAliveRootWidget = null as any;
    this.cipherSuddenDeathAlivePanelWidget = null as any;
    this.cipherSuddenDeathAliveTitleWidget = null as any;
    this.cipherSuddenDeathFriendlyAliveWidget = null as any;
    this.cipherSuddenDeathEnemyAliveWidget = null as any;
    this.cipherSuddenDeathFriendlyAliveSlotWidgets = [];
    this.cipherSuddenDeathEnemyAliveSlotWidgets = [];

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
    // Legacy method kept for compatibility. Slot 3 is Key Time now.
  }

  addKeyTimeSeconds(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this._scoreboard[3] += mod.Floor(seconds);
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
    updateCipherSuddenDeathAliveHudForPlayer(this);
  }
  getScoreboardSnapshot(): number[] {
    // [score, kills, deaths, keyTimeSeconds, nodeOverloads]
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

function initializePerformanceStatsLoggingOnce(): void {
  // Disabled to keep Portal bundle.ts under the hard file-size limit.
  // Cipher Obliteration does not require bf6-portal-utils/performance-stats at runtime.
}

/* ----------------------------------------
   Capture point wrapper
---------------------------------------- */

class CapturePoint {
  public capturePoint: mod.CapturePoint | undefined;
  public symbol: ObjectiveLetter;
  public id: number;

  private _owner: mod.Team;
  private _onPoint: number[];
  private _captureProgress: number;
  private _previousCaptureProgress: number;
  private _capturingTeam: mod.Team;
  private _resolveMissingWarned: boolean;
  private _configureFailedWarned: boolean;

  constructor(id: number, symbol: ObjectiveLetter) {
    this.id = id;
    this.symbol = symbol;

    this.capturePoint = undefined;

    this._owner = teamNeutral;
    this._onPoint = [];
    this._captureProgress = 0;
    this._previousCaptureProgress = 0;
    this._capturingTeam = teamNeutral;
    this._resolveMissingWarned = false;
    this._configureFailedWarned = false;

    const capturePoint = this.resolveHandle("constructor");
    if (!capturePoint) return;

    try {
      mod.SetCapturePointCapturingTime(capturePoint, CAPTURE_TIME);
      mod.SetCapturePointNeutralizationTime(capturePoint, NEUTRALIZE_TIME);
      mod.EnableGameModeObjective(capturePoint, false);
    } catch (err) {
      this.warnConfigureFailureOnce("constructor", err);
    }
  }

  resolveHandle(context: string = "resolveHandle"): mod.CapturePoint | undefined {
    try {
      this.capturePoint = mod.GetCapturePoint(this.id);
      return this.capturePoint;
    } catch (err) {
      if (!this._resolveMissingWarned) {
        this._resolveMissingWarned = true;
        LogRuntimeError("CapturePoint/GetCapturePoint/" + context + "/" + String(this.id), err);
      }
      return undefined;
    }
  }

  private warnConfigureFailureOnce(context: string, err: unknown): void {
    if (this._configureFailedWarned) return;
    this._configureFailedWarned = true;
    LogRuntimeError("CapturePoint/configure/" + context + "/" + String(this.id), err);
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
    const capturePoint = this.resolveHandle("setCaptureProgress");
    if (!capturePoint) return;

    this._previousCaptureProgress = this._captureProgress;
    try {
      this._captureProgress = mod.GetCaptureProgress(capturePoint);
    } catch (err) {
      this.warnConfigureFailureOnce("GetCaptureProgress", err);
      return;
    }
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
  [CP_C_ID]: new CapturePoint(CP_C_ID, "C"),
  [CP_D_ID]: new CapturePoint(CP_D_ID, "D"),
  [CP_A_SECOND_HALF_ID]: new CapturePoint(CP_A_SECOND_HALF_ID, "A"),
  [CP_B_SECOND_HALF_ID]: new CapturePoint(CP_B_SECOND_HALF_ID, "B"),
  [CP_C_SECOND_HALF_ID]: new CapturePoint(CP_C_SECOND_HALF_ID, "C"),
  [CP_D_SECOND_HALF_ID]: new CapturePoint(CP_D_SECOND_HALF_ID, "D"),
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

  // Runtime bots and AI backfill are not human clients.
  // Bot countdown locking is handled by applyRuntimeBotPhaseLockForPlayer().
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

  const isPrematch = gameStatus === 0;
  const isRedeployCountdown = gameStatus === 1;
  const isPreLive = gameStatus === 2;
  const isLive = gameStatus >= 3;

  if (isLive) {
    if (isCipherLiveTransitionActive()) return;
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
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

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

function warnPrematchReadyDebounceOnce(playerId: number, interactPointId: number, ticksRemaining: number): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  if (prematchReadyDebounceWarnedByPlayerId[playerId] === true) return;
  prematchReadyDebounceWarnedByPlayerId[playerId] = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[PREMATCH READY] debounced player/ip/remainTicks/status/inits {}",
      String(playerId) +
        "/" +
        String(interactPointId) +
        "/" +
        String(ticksRemaining) +
        "/" +
        String(gameStatus) +
        "/" +
        getInitializationFlagSummary()
    )
  );
}

function getPrematchEventTeamId(player?: mod.Player): number {
  if (!player) return -1;
  try {
    if (!mod.IsPlayerValid(player)) return -1;
    return modlib.getTeamId(mod.GetTeam(player));
  } catch (_err) {
    return -1;
  }
}

function getPrematchTeamSwitchElapsedTicks(): number {
  return serverTickCount - lastPrematchTeamSwitchTick;
}

function isPrematchTeamSwitchStabilized(): boolean {
  return getPrematchTeamSwitchElapsedTicks() >= PRELIVE_TEAM_SWITCH_STABILIZE_TICKS;
}

function warnPrematchPreliveGateOnce(
  source: string,
  reason: string,
  eventPlayer?: mod.Player,
  interactPointId: number = -1,
  switchElapsedTicks: number = getPrematchTeamSwitchElapsedTicks()
): void {
  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  const teamId = getPrematchEventTeamId(eventPlayer);
  const t1SpawnerObjId = getConfiguredInitialTransitionPlayerSpawnerObjIdForTeam(team1);
  const t2SpawnerObjId = getConfiguredInitialTransitionPlayerSpawnerObjIdForTeam(team2);
  const key =
    source +
    "/" +
    reason +
    "/" +
    String(interactPointId) +
    "/" +
    String(teamId) +
    "/" +
    String(prematchReadyPlayersByTeam[0]) +
    "-" +
    String(prematchReadyPlayersByTeam[1]) +
    "/" +
    String(prematchTotalPlayersByTeam[0]) +
    "-" +
    String(prematchTotalPlayersByTeam[1]) +
    "/" +
    String(t1SpawnerObjId) +
    "-" +
    String(t2SpawnerObjId);
  if (prematchPreliveGateWarnedByKey[key] === true) return;
  prematchPreliveGateWarnedByKey[key] = true;

  emitStringKeyDebugWorldLog(
    mod.Message(
      "[PREMATCH PRELIVE] gate source/reason/team/ip/rdy/tot/switchElapsed/spawns/status/inits {}",
      source +
        "/" +
        reason +
        "/" +
        String(teamId) +
        "/" +
        String(interactPointId) +
        "/" +
        String(prematchReadyPlayersByTeam[0]) +
        "-" +
        String(prematchReadyPlayersByTeam[1]) +
        "/" +
        String(prematchTotalPlayersByTeam[0]) +
        "-" +
        String(prematchTotalPlayersByTeam[1]) +
        "/" +
        String(switchElapsedTicks) +
        "/" +
        String(t1SpawnerObjId) +
        "-" +
        String(t2SpawnerObjId) +
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

function isPrematchReadyDebounced(playerId: number, interactPointId: number): boolean {
  const lastTick = prematchReadyLastHandledTickByPlayerId[playerId] ?? -999999;
  const elapsedTicks = serverTickCount - lastTick;
  if (elapsedTicks < PREMATCH_READY_DEBOUNCE_TICKS) {
    warnPrematchReadyDebounceOnce(playerId, interactPointId, PREMATCH_READY_DEBOUNCE_TICKS - elapsedTicks);
    return true;
  }

  prematchReadyLastHandledTickByPlayerId[playerId] = serverTickCount;
  return false;
}

function tryStartPreliveFromPrematch(
  source: string,
  eventPlayer?: mod.Player,
  interactPointId: number = -1
): boolean {
  if (gameStatus !== 0) return false;

  const readyPlayers = prematchReadyPlayersByTeam;
  const totalPlayers = prematchTotalPlayersByTeam;
  if (!prematchAllPlayersReady) {
    warnPrematchPreliveGateOnce(source, "not_all_ready", eventPlayer, interactPointId);
    return false;
  }

  const switchElapsedTicks = getPrematchTeamSwitchElapsedTicks();
  if (!isPrematchTeamSwitchStabilized()) {
    warnPrematchStabilizationGateBlockedOnce(readyPlayers, totalPlayers, switchElapsedTicks);
    warnPrematchPreliveGateOnce(source, "team_switch_stabilizing", eventPlayer, interactPointId, switchElapsedTicks);
    return false;
  }

  normalizeAllPlayersToStandardHealthAndClearPrematch889State();
  initialization[2] = false;
  gameStatus = 2;
  return true;
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

function applyCipherSecondHalfHqSpawns(context: string = "second_half_hq_spawns"): void {
  SafeEnableHQById(TEAM1_INITIAL_HQ, false);
  SafeEnableHQById(TEAM2_INITIAL_HQ, false);
  SafeEnableHQById(TEAM1_LIVE_HQ, true);
  SafeEnableHQById(TEAM2_LIVE_HQ, true);
  currentDynamicHqTeam1 = TEAM1_LIVE_HQ;
  currentDynamicHqTeam2 = TEAM2_LIVE_HQ;
  enforceReadyupHqsDisabledOutsidePrematch(context);
}

function EnableLiveBaseHQs(): void {
  if (cipherCurrentHalf === 2) {
    applyCipherSecondHalfHqSpawns("EnableLiveBaseHQs");
    return;
  }
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
  safeSpawnGenerationByPlayerId = {};
  safeSpawnCheckQueuedGenerationByPlayerId = {};
  safeSpawnForcedQueuedGenerationByPlayerId = {};
  safeSpawnCheckQueue = [];
  safeSpawnForcedQueue = [];
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
  resetCipherNodeStates("ResetRoundGameplayState");
  resetCipherSuddenDeathState();
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearCipherLivePhaseTransitionRuntimeState("ResetRoundGameplayState", true, true);
  postmatchWinnerTeam = teamNeutral;
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
  prematchReadyLastHandledTickByPlayerId = {};
  prematchReadyDebounceWarnedByPlayerId = {};
  prematchPreliveGateWarnedByKey = {};
}
function ResetAllPlayersReadyState(): void {
  serverPlayers.forEach((p) => p.resetReadyForNewRound());
}

function resetLifecycleStateForFreshMatchStart(): void {
  clearRuntimeBotState(true);
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
  resetCipherNodeStates("resetLifecycleStateForFreshMatchStart");
  resetCipherSuddenDeathState();
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearCipherLivePhaseTransitionRuntimeState("resetLifecycleStateForFreshMatchStart", true, true);
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
  prematchReadyLastHandledTickByPlayerId = {};
  prematchReadyDebounceWarnedByPlayerId = {};
  lastPrematchTeamSwitchTick = -999999;
  lastPrematchTeamSwitchTickByPlayerId = {};
  prematchStabilizationGateWarnedBySwitchTick = {};
  prematchPreliveGateWarnedByKey = {};
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
  clearPostmatchShowcaseState();
}


function ReturnToPreMatchState(): void {
  clearCipherAdminRuntimeState("ReturnToPreMatchState");
  clearRuntimeBotState(true);
  // --- Core prematch recovery variables ---
  serverScores = [INITIAL_TICKETS, INITIAL_TICKETS];
  cipherCurrentHalf = 1;
  cipherMatchStage = "half1";
  cipherHalfScores = [0, 0];
  resetCipherNodeStates("ReturnToPreMatchState");
  resetCipherSuddenDeathState();
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearCipherLivePhaseTransitionRuntimeState("ReturnToPreMatchState", true, true);
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
  liveTransitionCheckpointSeenByKey = {};
  prematchSwitchLastHandledTickByPlayerId = {};
  prematchSwitchDebounceWarnedByPlayerId = {};
  prematchReadyLastHandledTickByPlayerId = {};
  prematchReadyDebounceWarnedByPlayerId = {};
  lastPrematchTeamSwitchTick = -999999;
  lastPrematchTeamSwitchTickByPlayerId = {};
  prematchStabilizationGateWarnedBySwitchTick = {};
  prematchPreliveGateWarnedByKey = {};
  preliveTeamSanityWarnedByPlayerId = {};
  prematchHealthInside889ByPlayerId = {};
  prematchHealthAppliedMaxByPlayerId = {};
  resetMatchStartBannerState(true);
  clearPostmatchShowcaseState();
  stopDamageZonePulseTimer();
  playerInDamageZone = {};

  // IMPORTANT: make sure prematch init re-runs (so prematch enables icons/interacts/etc)
  initialization[0] = false;
  initialization[1] = false;
  initialization[2] = false;
  initialization[3] = false;
  initialization[4] = false;

  gameStatus = 0;

  // --- UI visibility ---
  SetCountdownOverlayVisible(false);
  hideCipherTransitionHudForAllPlayers();
  SafeSetWidgetVisibleByName("LiveContainer", false);
  SafeSetWidgetVisibleByName("PostMatchContainer", false);

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
  ShowPrematchUi();
  applyPrematch889HealthForAllPlayers();

  // --- Put everyone back into the world in prematch ---
  mod.DeployAllPlayers();
  setObjectiveNativeMcomObjectivesEnabled(false, "restorePrematch");
  disableAllObjectiveCapturePointObjectives("restorePrematch");
  disableAllObjectiveSurfaceSectors("restorePrematch", true);
  disableAllObjectiveInteractPoints("restorePrematch");
  syncLiveHybridObjectiveSurfaceState("restorePrematch", true);
  syncDisabledBombAnchorObjectives();
}

function InitializePreMatch(): void {
  phaseTickCount = 0;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  stopDamageZonePulseTimer();
  clearPostmatchShowcaseState();
  setLiveScorePanelVisible(false);
  setObjectiveNativeMcomObjectivesEnabled(false, "InitializePreMatch");
  disableAllObjectiveCapturePointObjectives("InitializePreMatch");
  disableAllObjectiveSurfaceSectors("InitializePreMatch", true);
  disableAllObjectiveInteractPoints("InitializePreMatch");
  syncDisabledBombAnchorObjectives();
  StopAllObjectiveMcomSfx();
  hideAllObjectiveArmedWorldIcons();
  HideAllDeployObjectiveTimerUi();
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearCipherLivePhaseTransitionRuntimeState("InitializePreMatch", true, true);
  resetLiveClockState();
  validateRequiredQuadBikeAnchorConfigurationOnce();

  // If we are looping back into prematch, ensure the world state is clean.
  ResetRoundGameplayState();
  syncLiveHybridObjectiveSurfaceState("InitializePreMatch", true);
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
  ShowPrematchUi();
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
    clearPostmatchShowcaseState();
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
    HidePrematchUiForTransition();

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
    clearCipherSpawnJobQueues();

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
    clearPostmatchShowcaseState();
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
    resetMatchStartBannerState(true);
    resetLiveClockState();
    cipherCurrentHalf = 1;
    cipherMatchStage = "half1";
    cipherHalfScores = [0, 0];
    cipherPendingScoreTransitionTeam = teamNeutral;
    invalidateCipherLiveTransitionOwnership();
    cipherSecondHalfTransitionActive = false;
    cipherSuddenDeathTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    clearCipherLivePhaseTransitionRuntimeState("InitializePreLive", true, true);
    resetCipherSuddenDeathState();
    resetCipherSpawnRoutingState();
    preliveTeamSanityWarnedByPlayerId = {};
    resetRuntimeBotStagedSpawnSchedule();

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
    HidePrematchUiForTransition();
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
    clearPostmatchShowcaseState();
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
    invalidateCipherLiveTransitionOwnership();
    clearCipherLivePhaseTransitionRuntimeState("InitializeLive", true, true);
    serverScores = [INITIAL_TICKETS, INITIAL_TICKETS];
    cipherCurrentHalf = 1;
    cipherMatchStage = "half1";
    cipherHalfScores = [0, 0];
    resetCipherSuddenDeathState();
    cipherSecondHalfTransitionActive = false;
    cipherSuddenDeathTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    resetCipherSpawnRoutingState();
    resetCipherObjectiveCounters();
    registerObjectivesDeterministically();
    disableAllObjectiveInteractPoints("InitializeLive");
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
    emitLiveTransitionCheckpoint("live_init_depths");

    UpdateFlagHQSpawns();
    emitLiveTransitionCheckpoint("live_init_hqs");

    // Hide prematch UI once players are deploying/playing.
    HidePrematchUiForTransition();
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
      clearCipherLiveInputRestrictionsForPlayer(p.player);
      if (p.isDeployed) p.isFirstDeploy();
    });
    refreshCipherKeyPlayerSnapshots("InitializeLive");
    repairCipherKeyHudCachesForAllPlayers(true);
    UpdateBombCarrierUiForAllPlayers(undefined, true);
    refreshBombNoticeUiForAllPlayers(undefined, true);
    startRuntimeBotLiveStartSettle("half1", "InitializeLive");
    requestLiveBotSpawnsForAllBots("InitializeLive");
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
        scheduleCipherLiveStartKeySpawn(1, "half1", "InitializeLive");
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

function normalizePostmatchQuaternion(q: PostmatchQuaternion): PostmatchQuaternion {
  const norm = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z);
  if (norm <= 0) return { w: 1, x: 0, y: 0, z: 0 };
  return {
    w: q.w / norm,
    x: q.x / norm,
    y: q.y / norm,
    z: q.z / norm,
  };
}

function postmatchQuaternionProduct(q1: PostmatchQuaternion, q2: PostmatchQuaternion): PostmatchQuaternion {
  return normalizePostmatchQuaternion({
    w: q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z,
    x: q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y,
    y: q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x,
    z: q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w,
  });
}

function postmatchQuaternionFromEuler(euler: mod.Vector): PostmatchQuaternion {
  const eulerX = mod.XComponentOf(euler);
  const eulerY = mod.YComponentOf(euler);
  const eulerZ = mod.ZComponentOf(euler);

  const cx = Math.cos(eulerX / 2);
  const cy = Math.cos(eulerY / 2);
  const cz = Math.cos(eulerZ / 2);
  const sx = Math.sin(eulerX / 2);
  const sy = Math.sin(eulerY / 2);
  const sz = Math.sin(eulerZ / 2);

  return normalizePostmatchQuaternion({
    w: cx * cy * cz + sx * sy * sz,
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
  });
}

function postmatchQuaternionToEuler(q: PostmatchQuaternion): mod.Vector {
  const n = normalizePostmatchQuaternion(q);
  const x = Math.atan2(
    2 * (n.y * n.z + n.w * n.x),
    n.w * n.w - n.x * n.x - n.y * n.y + n.z * n.z
  );
  const y = Math.asin(Math.max(-1, Math.min(1, 2 * (n.w * n.y - n.x * n.z))));
  const z = Math.atan2(
    2 * (n.x * n.y + n.w * n.z),
    n.w * n.w + n.x * n.x - n.y * n.y - n.z * n.z
  );

  return mod.CreateVector(x, y, z);
}

function rotatePostmatchVectorByQuaternion(vector: mod.Vector, q: PostmatchQuaternion): mod.Vector {
  const vecX = mod.XComponentOf(vector);
  const vecY = mod.YComponentOf(vector);
  const vecZ = mod.ZComponentOf(vector);

  const x =
    (q.w * q.w + q.x * q.x - q.y * q.y - q.z * q.z) * vecX +
    2 * (q.x * q.y - q.w * q.z) * vecY +
    2 * (q.x * q.z + q.w * q.y) * vecZ;

  const y =
    2 * (q.x * q.y + q.w * q.z) * vecX +
    (q.w * q.w - q.x * q.x + q.y * q.y - q.z * q.z) * vecY +
    2 * (q.y * q.z - q.w * q.x) * vecZ;

  const z =
    2 * (q.x * q.z - q.w * q.y) * vecX +
    2 * (q.y * q.z + q.w * q.x) * vecY +
    (q.w * q.w - q.x * q.x - q.y * q.y + q.z * q.z) * vecZ;

  return mod.CreateVector(x, y, z);
}

function getOrCreatePostmatchShowcaseObjectCache(
  config: PostmatchShowcaseRuntimeObjectConfig
): PostmatchShowcaseRuntimeObjectCache {
  const existing = postmatchShowcaseRuntimeObjectCacheByKey[config.key];
  if (existing) return existing;

  const created: PostmatchShowcaseRuntimeObjectCache = {
    key: config.key,
    runtimeSpawned: false,
  };

  postmatchShowcaseRuntimeObjectCacheByKey[config.key] = created;
  return created;
}

function getPostmatchShowcaseParentTransform(): { position: mod.Vector; rotation: PostmatchQuaternion } | undefined {
  try {
    const parent = mod.GetSpatialObject(POSTMATCH_SHOWCASE_PARENT_ID) as unknown as mod.Object;
    return {
      position: mod.GetObjectPosition(parent),
      rotation: postmatchQuaternionFromEuler(mod.GetObjectRotation(parent)),
    };
  } catch (_err) {
    return undefined;
  }
}

function resolvePostmatchShowcaseRuntimeTransform(
  config: PostmatchShowcaseRuntimeObjectConfig
): { position: mod.Vector; rotation: mod.Vector } | undefined {
  const parent = getPostmatchShowcaseParentTransform();
  if (!parent) return undefined;

  const worldOffset = rotatePostmatchVectorByQuaternion(config.localOffset, parent.rotation);
  const localRotation = postmatchQuaternionFromEuler(config.localRotation);
  const worldRotation = postmatchQuaternionProduct(parent.rotation, localRotation);

  return {
    position: mod.Add(parent.position, worldOffset),
    rotation: postmatchQuaternionToEuler(worldRotation),
  };
}

function getPostmatchShowcaseAnchorConfig(anchorId: number): PostmatchShowcaseRuntimeObjectConfig | undefined {
  for (let i = 0; i < POSTMATCH_SHOWCASE_RUNTIME_OBJECT_CONFIGS.length; i++) {
    const config = POSTMATCH_SHOWCASE_RUNTIME_OBJECT_CONFIGS[i];
    if (config.anchorId === anchorId) return config;
  }
  return undefined;
}

function getPostmatchShowcaseAnchorPosition(anchorId: number): mod.Vector | undefined {
  const cached = postmatchShowcaseAnchorPositionById[anchorId];
  if (cached) return cached;

  const config = getPostmatchShowcaseAnchorConfig(anchorId);
  if (!config) return undefined;

  const transform = resolvePostmatchShowcaseRuntimeTransform(config);
  if (!transform) return undefined;

  postmatchShowcaseAnchorPositionById[anchorId] = transform.position;
  return transform.position;
}

function getPostmatchSpatialObjectPosition(objId: number): mod.Vector | undefined {
  if (objId === POSTMATCH_CAMERA_ID || objId === POSTMATCH_SHOWCASE_PARENT_ID) {
    try {
      return mod.GetObjectPosition(mod.GetSpatialObject(objId) as unknown as mod.Object);
    } catch (_err) {
      return undefined;
    }
  }

  return getPostmatchShowcaseAnchorPosition(objId);
}

function spawnPostmatchShowcaseRuntimeSpatialObjects(): void {
  for (let i = 0; i < POSTMATCH_SHOWCASE_RUNTIME_OBJECT_CONFIGS.length; i++) {
    const config = POSTMATCH_SHOWCASE_RUNTIME_OBJECT_CONFIGS[i];
    const cache = getOrCreatePostmatchShowcaseObjectCache(config);
    const transform = resolvePostmatchShowcaseRuntimeTransform(config);
    if (!transform) continue;

    cache.position = transform.position;
    cache.rotation = transform.rotation;
    if (config.anchorId !== undefined) {
      postmatchShowcaseAnchorPositionById[config.anchorId] = transform.position;
    }

    if (cache.runtimeSpawned && cache.runtimeObject) continue;

    const spawned = spawnRuntimeCommonObjectSafe(
      config.asset,
      transform.position,
      transform.rotation,
      "postmatch_showcase_runtime_" + config.key,
      config.scale
    );

    if (!spawned.object) continue;

    cache.runtimeObject = spawned.object;
    cache.runtimeSpawned = true;
  }
}

function unspawnPostmatchShowcaseRuntimeSpatialObjects(): void {
  for (const key in postmatchShowcaseRuntimeObjectCacheByKey) {
    const cache = postmatchShowcaseRuntimeObjectCacheByKey[key];
    if (!cache || !cache.runtimeObject) continue;

    unspawnObjectSafe(cache.runtimeObject, "postmatch_showcase_runtime_" + key, false);
    cache.runtimeObject = undefined;
    cache.runtimeSpawned = false;
  }
  postmatchShowcaseAnchorPositionById = {};
}

function hidePostmatchShowcaseSpatialObjectsForPrematch(): void {
  unspawnPostmatchShowcaseRuntimeSpatialObjects();
}

function showPostmatchShowcaseSpatialObjectsForPostmatch(): void {
  spawnPostmatchShowcaseRuntimeSpatialObjects();
}

function getPostmatchShowcaseStatValue(p: Player, statKind: PostmatchShowcaseStatKind): number {
  const snapshot = p.getScoreboardSnapshot();
  if (statKind === "eliminations") return snapshot[1];
  if (statKind === "destroyed") return snapshot[4];
  if (statKind === "keyTime") return snapshot[3];
  return snapshot[0];
}

function getPostmatchShowcaseStatLabelKey(statKind: PostmatchShowcaseStatKind): any {
  if (statKind === "eliminations") return (mod.stringkeys as any).PostMatchTopEliminations;
  if (statKind === "destroyed") return (mod.stringkeys as any).PostMatchMostObjectivesDestroyed;
  if (statKind === "keyTime") return (mod.stringkeys as any).PostMatchKeyTime;
  return (mod.stringkeys as any).PostMatchMoralSupport;
}

function isBetterPostmatchShowcaseCandidate(
  candidate: Player,
  currentBest: Player | undefined,
  statKind: PostmatchShowcaseStatKind
): boolean {
  if (!currentBest) return true;

  const candidateScore = candidate.getScoreboardSnapshot()[0];
  const bestScore = currentBest.getScoreboardSnapshot()[0];

  if (statKind === "moralSupport") {
    if (candidateScore !== bestScore) return candidateScore < bestScore;
    return candidate.id < currentBest.id;
  }

  const candidateStat = getPostmatchShowcaseStatValue(candidate, statKind);
  const bestStat = getPostmatchShowcaseStatValue(currentBest, statKind);
  if (candidateStat !== bestStat) return candidateStat > bestStat;
  if (candidateScore !== bestScore) return candidateScore > bestScore;
  return candidate.id < currentBest.id;
}

function isPostmatchShowcaseStatSelectable(p: Player, statKind: PostmatchShowcaseStatKind): boolean {
  if (statKind === "moralSupport") return true;
  return getPostmatchShowcaseStatValue(p, statKind) > 0;
}

function hasPostmatchShowcaseSelectablePlayer(
  candidates: Player[],
  usedPlayerIds: { [playerId: number]: boolean },
  statKind: PostmatchShowcaseStatKind
): boolean {
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (usedPlayerIds[candidate.id] === true) continue;
    if (isPostmatchShowcaseStatSelectable(candidate, statKind)) return true;
  }
  return false;
}

function selectPostmatchShowcasePlayer(
  candidates: Player[],
  usedPlayerIds: { [playerId: number]: boolean },
  statKind: PostmatchShowcaseStatKind
): Player | undefined {
  let best: Player | undefined = undefined;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (usedPlayerIds[candidate.id] === true) continue;
    if (!isPostmatchShowcaseStatSelectable(candidate, statKind)) continue;
    if (isBetterPostmatchShowcaseCandidate(candidate, best, statKind)) best = candidate;
  }
  if (best) usedPlayerIds[best.id] = true;
  return best;
}

function selectNextPostmatchShowcaseStatKind(
  candidates: Player[],
  usedPlayerIds: { [playerId: number]: boolean },
  startIndex: number
): { statKind: PostmatchShowcaseStatKind; nextIndex: number } | undefined {
  for (let i = startIndex; i < POSTMATCH_SHOWCASE_STAT_PRIORITY.length; i++) {
    const statKind = POSTMATCH_SHOWCASE_STAT_PRIORITY[i];
    if (!hasPostmatchShowcaseSelectablePlayer(candidates, usedPlayerIds, statKind)) continue;
    return {
      statKind,
      nextIndex: i + 1,
    };
  }
  return undefined;
}

function buildPostmatchShowcaseSlots(): PostmatchShowcaseSlot[] {
  const winner = getWinningTeam();
  if (mod.Equals(winner, teamNeutral)) return [];

  const candidates: Player[] = [];
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!mod.Equals(mod.GetTeam(p.player), winner)) return;
    candidates.push(p);
  });

  const usedPlayerIds: { [playerId: number]: boolean } = {};
  const slots: PostmatchShowcaseSlot[] = [];
  let statPriorityIndex = 0;
  for (let i = 0; i < POSTMATCH_SHOWCASE_SLOT_CONFIGS.length; i++) {
    const config = POSTMATCH_SHOWCASE_SLOT_CONFIGS[i];
    const selectedStat = selectNextPostmatchShowcaseStatKind(candidates, usedPlayerIds, statPriorityIndex);
    if (!selectedStat) break;

    statPriorityIndex = selectedStat.nextIndex;
    const player = selectPostmatchShowcasePlayer(candidates, usedPlayerIds, selectedStat.statKind);
    if (!player) continue;
    slots.push({
      anchorId: config.anchorId,
      statKind: selectedStat.statKind,
      player,
      statValue: getPostmatchShowcaseStatValue(player, selectedStat.statKind),
    });
  }
  return slots;
}

const POSTMATCH_LOSING_TEAM_RESTRICTED_INPUTS: mod.RestrictedInputs[] = [
  mod.RestrictedInputs.FireWeapon,
  mod.RestrictedInputs.MoveForwardBack,
  mod.RestrictedInputs.MoveLeftRight,
];

function isPostmatchWinnerTeam(team: mod.Team): boolean {
  const winner = getWinningTeam();
  if (!mod.Equals(winner, team1) && !mod.Equals(winner, team2)) return false;
  return mod.Equals(team, winner);
}

function findPostmatchShowcaseSlotForPlayerId(playerId: number): PostmatchShowcaseSlot | undefined {
  for (let i = 0; i < postmatchShowcaseSlots.length; i++) {
    const slot = postmatchShowcaseSlots[i];
    if (slot && slot.player && slot.player.id === playerId) return slot;
  }
  return undefined;
}

function setPostmatchRestrictedInputsForPlayer(
  player: mod.Player,
  inputs: mod.RestrictedInputs[],
  restricted: boolean
): void {
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

  for (let i = 0; i < inputs.length; i++) {
    mod.EnableInputRestriction(player, inputs[i], restricted);
  }
}

function applyPostmatchShowcaseMovementLockForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

  clearCipherLiveInputRestrictionsForPlayer(player);
  mod.EnableInputRestriction(player, mod.RestrictedInputs.MoveForwardBack, true);
  mod.EnableInputRestriction(player, mod.RestrictedInputs.MoveLeftRight, true);
}

function applyPostmatchLosingInputLockForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

  clearCipherLiveInputRestrictionsForPlayer(player);
  setPostmatchRestrictedInputsForPlayer(player, POSTMATCH_LOSING_TEAM_RESTRICTED_INPUTS, true);
}

function applyPostmatchInputStateForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;
  if (gameStatus !== 4) return;

  const team = mod.GetTeam(player);
  if (isPostmatchWinnerTeam(team)) {
    applyPostmatchShowcaseMovementLockForPlayer(player);
  } else {
    applyPostmatchLosingInputLockForPlayer(player);
  }
}

function clearPostmatchShowcaseMovementLockForPlayer(player: mod.Player): void {
  if (!mod.IsPlayerValid(player)) return;
  if (shouldSkipHumanInputRestrictionsForPlayer(player)) return;

  try {
    mod.EnableInputRestriction(player, mod.RestrictedInputs.MoveForwardBack, false);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.MoveLeftRight, false);
    mod.EnableInputRestriction(player, mod.RestrictedInputs.FireWeapon, false);
  } catch (_err) {}
}

function setPostmatchShowcaseCameraForPlayer(player: mod.Player, enabled: boolean): void {
  if (!mod.IsPlayerValid(player)) return;
  const playerId = modlib.getPlayerId(player);
  try {
    if (enabled) {
      if (gameStatus !== 4) return;
      mod.SetCameraTypeForPlayer(player, mod.Cameras.Fixed, POSTMATCH_CAMERA_ID);
      postmatchShowcaseCameraAppliedByPlayerId[playerId] = true;
    } else {
      if (postmatchShowcaseCameraAppliedByPlayerId[playerId] !== true) return;
      mod.SetCameraTypeForPlayer(player, mod.Cameras.FirstPerson);
      delete postmatchShowcaseCameraAppliedByPlayerId[playerId];
    }
  } catch (_err) {}
}

function applyPostmatchShowcaseCameraAndInputForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    applyPostmatchInputStateForPlayer(p.player);
    setPostmatchShowcaseCameraForPlayer(p.player, true);
  });
}

function clearPostmatchShowcaseCameraAndInputForAllPlayers(): void {
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    clearPostmatchShowcaseMovementLockForPlayer(p.player);
    setPostmatchShowcaseCameraForPlayer(p.player, false);
  });
}

function tryMakePostmatchShowcasePlayerAlive(p: Player): boolean {
  if (!p || !mod.IsPlayerValid(p.player)) return false;
  if (isPlayerAliveSafe(p.player)) return true;

  try {
    mod.ForceRevive(p.player);
  } catch (_errRevive) {}
  if (isPlayerAliveSafe(p.player)) return true;

  const spawnerObjId = getInitialSpawnPointObjIdForTeam(mod.GetTeam(p.player));
  if (spawnerObjId > 0) {
    try {
      mod.SetRedeployTime(p.player, 0);
      trySpawnPlayerFromSpawnPointSafe(p.player, spawnerObjId, "postmatch_showcase");
    } catch (_errSpawn) {}
  }

  return isPlayerAliveSafe(p.player);
}

function createOffsetPosition(base: mod.Vector, yOffset: number): mod.Vector {
  return mod.Add(base, mod.CreateVector(0, yOffset, 0));
}

function configurePostmatchShowcaseWorldIcon(
  handle: mod.WorldIcon,
  pos: mod.Vector,
  label: any,
  color: mod.Vector
): void {
  mod.SetWorldIconPosition(handle, pos);
  mod.SetWorldIconText(handle, label);
  mod.SetWorldIconColor(handle, color);
  mod.EnableWorldIconImage(handle, false);
  mod.EnableWorldIconText(handle, true);
}

function spawnPostmatchShowcaseWorldIcon(
  pos: mod.Vector,
  label: any,
  color: mod.Vector,
  context: string
): { object?: mod.Object; handle?: mod.WorldIcon } {
  const spawned = spawnRuntimeCommonObjectSafe(mod.RuntimeSpawn_Common.WorldIcon, pos, BOMB_DROP_ROTATION, context);
  if (!spawned.object) return {};

  const handle = resolveRuntimeWorldIconHandle(spawned.object as unknown);
  if (!handle) {
    unspawnObjectSafe(spawned.object, context + "_unresolved", false);
    return {};
  }

  try {
    configurePostmatchShowcaseWorldIcon(handle, pos, label, color);
  } catch (_errConfigure) {
    unspawnObjectSafe(spawned.object, context + "_configure_failed", false);
    return {};
  }

  return { object: spawned.object, handle };
}

function getPostmatchShowcaseIconObject(
  slot: PostmatchShowcaseSlot,
  iconKind: PostmatchShowcaseIconKind
): mod.Object | undefined {
  return iconKind === "head" ? slot.headIconObject : slot.feetIconObject;
}

function getPostmatchShowcaseIconHandle(
  slot: PostmatchShowcaseSlot,
  iconKind: PostmatchShowcaseIconKind
): mod.WorldIcon | undefined {
  return iconKind === "head" ? slot.headIconHandle : slot.feetIconHandle;
}

function setPostmatchShowcaseIconRefs(
  slot: PostmatchShowcaseSlot,
  iconKind: PostmatchShowcaseIconKind,
  object: mod.Object | undefined,
  handle: mod.WorldIcon | undefined
): void {
  if (iconKind === "head") {
    slot.headIconObject = object;
    slot.headIconHandle = handle;
    return;
  }

  slot.feetIconObject = object;
  slot.feetIconHandle = handle;
}

function clearPostmatchShowcaseWorldIconForSlot(
  slot: PostmatchShowcaseSlot,
  iconKind: PostmatchShowcaseIconKind,
  context: string
): void {
  const object = getPostmatchShowcaseIconObject(slot, iconKind);
  const handle = getPostmatchShowcaseIconHandle(slot, iconKind);

  if (object) unspawnObjectSafe(object, context + " object", false);
  else if (handle) unspawnObjectSafe(handle as unknown, context + " handle", false);

  setPostmatchShowcaseIconRefs(slot, iconKind, undefined, undefined);
}

function resolvePostmatchShowcaseWorldIconForSlot(
  slot: PostmatchShowcaseSlot,
  iconKind: PostmatchShowcaseIconKind
): mod.WorldIcon | undefined {
  const existingHandle = getPostmatchShowcaseIconHandle(slot, iconKind);
  if (existingHandle) return existingHandle;

  const object = getPostmatchShowcaseIconObject(slot, iconKind);
  if (!object) return undefined;

  const resolvedHandle = resolveRuntimeWorldIconHandle(object as unknown);
  if (!resolvedHandle) return undefined;

  setPostmatchShowcaseIconRefs(slot, iconKind, object, resolvedHandle);
  return resolvedHandle;
}

function ensurePostmatchShowcaseWorldIconForSlot(
  slot: PostmatchShowcaseSlot,
  iconKind: PostmatchShowcaseIconKind,
  pos: mod.Vector,
  label: any,
  color: mod.Vector,
  context: string
): void {
  let object = getPostmatchShowcaseIconObject(slot, iconKind);
  let handle = resolvePostmatchShowcaseWorldIconForSlot(slot, iconKind);

  if (object && !handle) {
    clearPostmatchShowcaseWorldIconForSlot(slot, iconKind, context + "_stale");
    object = undefined;
  }

  if (handle) {
    try {
      configurePostmatchShowcaseWorldIcon(handle, pos, label, color);
      if (object) moveObjectToAbsolutePositionSafe(object, pos, context + "_move");
      return;
    } catch (_errConfigure) {
      clearPostmatchShowcaseWorldIconForSlot(slot, iconKind, context + "_configure_failed");
      object = undefined;
      handle = undefined;
    }
  }

  const spawned = spawnPostmatchShowcaseWorldIcon(pos, label, color, context);
  setPostmatchShowcaseIconRefs(slot, iconKind, spawned.object, spawned.handle);
}

function clearPostmatchShowcaseRuntimeWorldIcons(): void {
  for (let i = 0; i < postmatchShowcaseSlots.length; i++) {
    const slot = postmatchShowcaseSlots[i];
    clearPostmatchShowcaseWorldIconForSlot(slot, "head", "postmatch head icon");
    clearPostmatchShowcaseWorldIconForSlot(slot, "feet", "postmatch feet icon");
  }
}

function getPostmatchShowcaseBasePosition(slot: PostmatchShowcaseSlot): mod.Vector | undefined {
  if (mod.IsPlayerValid(slot.player.player) && isPlayerAliveSafe(slot.player.player)) {
    const playerPos = tryGetPlayerPositionSafe(slot.player.player);
    if (playerPos) return playerPos;
  }
  return getPostmatchSpatialObjectPosition(slot.anchorId);
}

function updatePostmatchShowcaseWorldIconPositions(): void {
  if (gameStatus !== 4) return;
  for (let i = 0; i < postmatchShowcaseSlots.length; i++) {
    const slot = postmatchShowcaseSlots[i];
    const basePos = getPostmatchShowcaseBasePosition(slot);
    if (!basePos) continue;
    ensurePostmatchShowcaseWorldIconForSlot(
      slot,
      "head",
      createOffsetPosition(basePos, POSTMATCH_SHOWCASE_HEAD_TEXT_Y_OFFSET_METERS),
      mod.Message(mod.stringkeys.PostMatchPlayerName, slot.player.player),
      COLOR_NEUTRAL,
      "postmatch_head_worldicon_" + String(slot.anchorId)
    );
    ensurePostmatchShowcaseWorldIconForSlot(
      slot,
      "feet",
      createOffsetPosition(basePos, POSTMATCH_SHOWCASE_FEET_TEXT_Y_OFFSET_METERS),
      mod.Message(getPostmatchShowcaseStatLabelKey(slot.statKind), mod.Ceiling(slot.statValue)),
      COLOR_FRIENDLY,
      "postmatch_feet_worldicon_" + String(slot.anchorId)
    );
  }
}

function teleportPostmatchShowcaseSlotPlayer(slot: PostmatchShowcaseSlot, context: string): boolean {
  const player = slot.player.player;
  if (!mod.IsPlayerValid(player)) return false;
  if (!isPlayerAliveSafe(player)) return false;

  const anchorPos = getPostmatchSpatialObjectPosition(slot.anchorId);
  if (!anchorPos) return false;

  const cameraPos = getPostmatchSpatialObjectPosition(POSTMATCH_CAMERA_ID);
  const yawRadians = getCipherTeleportYawRadians(anchorPos, cameraPos);
  try {
    mod.Teleport(player, anchorPos, yawRadians);
    return true;
  } catch (err) {
    LogRuntimeError(
      "PostmatchShowcaseTeleport/" + context + "/" + String(slot.player.id) + "/" + String(slot.anchorId),
      err
    );
    return false;
  }
}

function applyPostmatchShowcaseSlot(slot: PostmatchShowcaseSlot): void {
  const player = slot.player.player;
  if (!mod.IsPlayerValid(player)) return;

  applyPostmatchInputStateForPlayer(player);
  setPostmatchShowcaseCameraForPlayer(player, true);

  if (!tryMakePostmatchShowcasePlayerAlive(slot.player)) return;
  teleportPostmatchShowcaseSlotPlayer(slot, "apply");
}

function applyPostmatchShowcaseSlots(): void {
  for (let i = 0; i < postmatchShowcaseSlots.length; i++) {
    applyPostmatchShowcaseSlot(postmatchShowcaseSlots[i]);
  }
  updatePostmatchShowcaseWorldIconPositions();
}

async function reassertPostmatchShowcaseAfterDelay(): Promise<void> {
  const waits = [0.1, 0.35, 0.75, 1.25];
  let previousWait = 0;
  for (let i = 0; i < waits.length; i++) {
    const waitSeconds = waits[i] - previousWait;
    previousWait = waits[i];
    await mod.Wait(waitSeconds);
    if (gameStatus !== 4 || initialization[4] !== true) return;
    applyPostmatchShowcaseCameraAndInputForAllPlayers();
    applyPostmatchShowcaseSlots();
  }
}

function showPostmatchStatsMapHint(): void {
  const message = mod.Message((mod.stringkeys as any).PostMatchStatsMapHint);
  modlib.ShowHighlightedGameModeMessage(message, team1);
  modlib.ShowHighlightedGameModeMessage(message, team2);
}

function beginPostmatchShowcase(): void {
  clearPostmatchShowcaseRuntimeWorldIcons();
  postmatchShowcaseSlots = buildPostmatchShowcaseSlots();

  showPostmatchShowcaseSpatialObjectsForPostmatch();

  applyPostmatchShowcaseCameraAndInputForAllPlayers();
  applyPostmatchShowcaseSlots();
  void reassertPostmatchShowcaseAfterDelay();
}

function clearPostmatchShowcaseState(): void {
  clearPostmatchShowcaseRuntimeWorldIcons();
  postmatchShowcaseSlots = [];

  hidePostmatchShowcaseSpatialObjectsForPrematch();

  clearPostmatchShowcaseCameraAndInputForAllPlayers();
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
  receiver: mod.Team | mod.Player,
  anchor: mod.UIAnchor = mod.UIAnchor.TopCenter
): void {
  const parent = mod.FindUIWidgetWithName("PostMatchContainer");
  mod.AddUIText(
    name,
    mod.CreateVector(posX, posY, 0),
    mod.CreateVector(w, h, 0),
    anchor,
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

  mod.SetUIWidgetBgFill(parent, mod.UIBgFill.None);
  mod.SetUIWidgetBgAlpha(parent, 0);
  mod.SetUIWidgetBgColor(parent, mod.CreateVector(0, 0, 0));
  mod.SetUIWidgetDepth(parent, mod.UIDepth.AboveGameUI);
  SafeSetWidgetSizeHandle(parent, SAFE_UI_ROOT_SIZE);

  const winner = getWinningTeam();

  function buildForReceiver(
    receiver: mod.Team,
    friendlyScore: number,
    enemyScore: number,
    resultKey: any
  ): void {
    const resultColor =
      resultKey === mod.stringkeys.PostMatchVictory ? COLOR_FRIENDLY :
      resultKey === mod.stringkeys.PostMatchDefeat ? COLOR_ENEMY :
      COLOR_NEUTRAL;

    const teamSuffix = String(modlib.getTeamId(receiver));
    addPostMatchText(
      "PM_Result_" + teamSuffix,
      0,
      POSTMATCH_RESULT_TEXT_Y,
      POSTMATCH_RESULT_TEXT_WIDTH,
      POSTMATCH_RESULT_TEXT_HEIGHT,
      60,
      resultColor,
      1,
      receiver,
      mod.UIAnchor.Center
    );
    setPostMatchText("PM_Result_" + teamSuffix, mod.Message(resultKey));

    addPostMatchText(
      "PM_FriendlyScore_" + teamSuffix,
      -110,
      POSTMATCH_SCORE_TEXT_Y,
      POSTMATCH_SCORE_TEXT_WIDTH,
      POSTMATCH_SCORE_TEXT_HEIGHT,
      40,
      COLOR_FRIENDLY,
      1,
      receiver,
      mod.UIAnchor.Center
    );
    setPostMatchText(
      "PM_FriendlyScore_" + teamSuffix,
      mod.Message((mod.stringkeys as any).PostMatchScoreValue, mod.Ceiling(friendlyScore))
    );

    addPostMatchText(
      "PM_ScoreSeparator_" + teamSuffix,
      0,
      POSTMATCH_SCORE_TEXT_Y,
      80,
      POSTMATCH_SCORE_TEXT_HEIGHT,
      38,
      COLOR_NEUTRAL,
      1,
      receiver,
      mod.UIAnchor.Center
    );
    setPostMatchText("PM_ScoreSeparator_" + teamSuffix, mod.Message(mod.stringkeys.Dash));

    addPostMatchText(
      "PM_EnemyScore_" + teamSuffix,
      110,
      POSTMATCH_SCORE_TEXT_Y,
      POSTMATCH_SCORE_TEXT_WIDTH,
      POSTMATCH_SCORE_TEXT_HEIGHT,
      40,
      COLOR_ENEMY,
      1,
      receiver,
      mod.UIAnchor.Center
    );
        setPostMatchText(
      "PM_EnemyScore_" + teamSuffix,
      mod.Message((mod.stringkeys as any).PostMatchScoreValue, mod.Ceiling(enemyScore))
    );

    addPostMatchText(
      "PM_MapHint_" + teamSuffix,
      0,
      POSTMATCH_HINT_TEXT_Y,
      POSTMATCH_HINT_TEXT_WIDTH,
      POSTMATCH_HINT_TEXT_HEIGHT,
      POSTMATCH_HINT_TEXT_SIZE,
      COLOR_NEUTRAL,
      1,
      receiver,
      mod.UIAnchor.Center
    );
    setPostMatchText(
      "PM_MapHint_" + teamSuffix,
      mod.Message((mod.stringkeys as any).PostMatchStatsMapHint)
    );
  }

  const t1ResultKey =
    mod.Equals(winner, team1) ? mod.stringkeys.PostMatchVictory :
    mod.Equals(winner, team2) ? mod.stringkeys.PostMatchDefeat :
    mod.stringkeys.PostMatchDraw;

  const t2ResultKey =
    mod.Equals(winner, team2) ? mod.stringkeys.PostMatchVictory :
    mod.Equals(winner, team1) ? mod.stringkeys.PostMatchDefeat :
    mod.stringkeys.PostMatchDraw;

  buildForReceiver(team1, serverScores[0], serverScores[1], t1ResultKey);
  buildForReceiver(team2, serverScores[1], serverScores[0], t2ResultKey);
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
    mod.SetSpawnMode(mod.SpawnModes.AutoSpawn);
    setPhaseCountdownDeadlineFromNow(POSTMATCH_TIME);
    resetEngineSchedulerCadenceState();
    setLiveScorePanelVisible(false);
    setObjectiveNativeMcomObjectivesEnabled(false, "InitializePostmatch");
    disableAllObjectiveCapturePointObjectives("InitializePostmatch");
    disableAllObjectiveSurfaceSectors("InitializePostmatch", true);
    disableAllObjectiveInteractPoints("InitializePostmatch");
    syncDisabledBombAnchorObjectives();
    StopAllObjectiveMcomSfx();
    hideAllObjectiveArmedWorldIcons();
    resetCipherNodeStates("InitializePostmatch");
    resetBombCarrierRuntimeState(true);
    enforceReadyupHqsDisabledOutsidePrematch("InitializePostmatch");

    SafeSetWidgetVisibleByName("LiveContainer", false);
    SetCountdownOverlayVisible(false);
    hideCipherTransitionHudForAllPlayers();
    hideCipherSuddenDeathAliveHudForAllPlayers();
    HidePrematchUiForTransition();
    StopAllCaptureTickLoops();
    StopAllEndgameLoops();
    applyPostmatchShowcaseCameraAndInputForAllPlayers();

    const post = mod.FindUIWidgetWithName("PostMatchContainer");
    if (post) {
      SafeSetWidgetVisibleHandle(post, true);
      mod.SetUIWidgetDepth(post, mod.UIDepth.AboveGameUI);
      SafeSetWidgetSizeHandle(post, SAFE_UI_ROOT_SIZE);
    }

    // Clamp scores for display.
    if (serverScores[0] < 0) serverScores[0] = 0;
    if (serverScores[1] < 0) serverScores[1] = 0;

    BuildPostMatchReportUI();
    showPostmatchStatsMapHint();
    beginPostmatchShowcase();
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
  cipherTransitionLastError = tag + ": " + String(err);
  // Rate limit to once per second (prevents spam + performance issues).
  if (serverTickCount - lastRuntimeErrorTick < TICK_RATE) return;
  lastRuntimeErrorTick = serverTickCount;

  try {
    mod.DisplayHighlightedWorldLogMessage(
      mod.Message("[RUNTIME ERROR] {}: {}", tag, String(err))
    );
  } catch (_err) {}
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
  carrierIconVisualLastSampleSec = 0;
  carrierIconVisualLastCarrierPos = undefined;
  carrierIconVisualVelocity = mod.CreateVector(0, 0, 0);
  carrierIconFriendlyVisualPos = undefined;
  carrierIconEnemyVisualPos = undefined;

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


const MAIN_LOOP_INTERVAL_MS = 33;
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
    try {
      OngoingGlobal_Inner();
    } catch (err) {
      try {
        LogRuntimeError("MainLoop", err);
      } catch (_errLog) {}
    }
  }, MAIN_LOOP_INTERVAL_MS);
}

function Mode_OnGameModeStarted(): void {
  initializePerformanceStatsLoggingOnce();
  startMainLoopTimer();
  resetLifecycleStateForFreshMatchStart();
  SetDepthAboveGameUI("PreMatchContainer");
  SetDepthAboveGameUI(PREMATCH_PANEL_WIDGET_NAME);
  SetCountdownOverlayVisible(false);

  refreshObjectiveResolvedMcomAliases("Mode_OnGameModeStarted");
  ValidateObjectiveConfiguration();
  moveHardObjectiveMcomsBelowMapOnce("Mode_OnGameModeStarted");
  validateRequiredQuadBikeAnchorConfigurationOnce();
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  ensureAudioSpawned();
  spawnTeamVoModulesForMatchStart();
  postmatchResultSfxPlayed = false;
  setObjectiveNativeMcomObjectivesEnabled(false, "OnGameModeStarted");
  disableAllObjectiveCapturePointObjectives("OnGameModeStarted");
  disableAllObjectiveSurfaceSectors("OnGameModeStarted", true);
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
  ShowPrematchUi();
  refreshPrematchReadyStateUi();
}
function Mode_OnGameModeEnding(): void {
  stopMainLoopTimer();
  stopDamageZonePulseTimer();
  clearCipherAdminRuntimeState("Mode_OnGameModeEnding");
  cancelAllCipherRespawnRouteJobs();
  clearRuntimeBotState(true);
  stopAllObjectiveAwardBursts();
  StopAllObjectiveMcomSfx();
  hideAllObjectiveArmedWorldIcons();
  disableAllObjectiveSurfaceSectors("Mode_OnGameModeEnding", true);
  resetCipherNodeStates("Mode_OnGameModeEnding");
  resetBombCarrierRuntimeState(true);
  clearVoModuleState();
}

function Mode_OngoingGlobal(): void {
  // Intentionally lightweight. Main loop logic runs through Timers.
  return;
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
  tickCipherAdminInteractFallback(nowSec);

  if (gameStatus === 0) {
    if (!initialization[0]) InitializePreMatch();
    resetTransitionFallbackGuardIfPrematchReady();
    tryStartPreliveFromPrematch("prematch_main_loop");
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
    tickRuntimeBotStagedSpawning(nowSec, "prelive_countdown");

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

    runQueuedCipherTransitionReconcile(nowSec);

    if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) {
      tickCipherLiveTransitionSupervisor(nowSec);
      return;
    }

    processLiveSafeSpawnQueues();

    const visualNowSec = ENABLE_CARRIER_SUBTICK ? getVisualSubtickNowSec() : nowSec;

    // Damage smoothing queue processing runs every tick (30 Hz) for consistent feel.
    if (ENABLE_DAMAGE_SMOOTHING) {
      dmgSpreadProcessQueueTick();
      dmgSpreadUpdateHealthCacheTick();
    }

    updateDroppedBombWorldIconCountdown();
    EvaluateResponsiveBombPickupRadiusScans();
    updateCipherKeyTimeCarryStats(nowSec);
    evaluateBotObjectiveController(nowSec);
    SetUITime(nowSec);
    UpdateObjectiveCaptureInteractionState();
    EvaluateObjectiveCaptureHoldAttempts();
    EvaluatePostCaptureAwardTimers();
    if (gameStatus !== 3) {
      HideAllObjectiveHoldProgressUi();
      return;
    }
    UpdateObjectiveArmAlarmSfxState();
    UpdateObjectiveHoldProgressUiForAllPlayers(visualNowSec);
    UpdateDeployObjectiveTimerUiForAllPlayers();
    repairDirtyCipherKeyHudCaches(2);

    if (ENABLE_CARRIER_SUBTICK) {
      UpdateBombCarrierUiForAllPlayers(visualNowSec);
      refreshBombNoticeUiForAllPlayers(visualNowSec);
      updateBombCarrierRuntimeWorldIconsVisualFollowFrame(visualNowSec);
    }

    let iconLaneDue = true;
    if (useEngineSchedulerFrame) {
      const iconDue = consumeNoCatchUpDue(nowSec, schedulerNextLiveIconFollowAtSec, ICON_FOLLOW_INTERVAL_SECONDS);
      iconLaneDue = iconDue.due;
      schedulerNextLiveIconFollowAtSec = iconDue.nextDueAtSec;
    }
    if (iconLaneDue) {
      const iconLaneNowSec = ENABLE_CARRIER_SUBTICK ? visualNowSec : nowSec;

      if (!ENABLE_CARRIER_SUBTICK) {
        UpdateBombCarrierUiForAllPlayers(iconLaneNowSec);
        refreshBombNoticeUiForAllPlayers(iconLaneNowSec);
        updateNextKeyUnlockCountdownVisuals(iconLaneNowSec);
      }

      if (ENABLE_CARRIER_SUBTICK === true) {
        refreshBombNoticeUiForAllPlayers(iconLaneNowSec);
        updateNextKeyUnlockCountdownVisuals(iconLaneNowSec);
      }

      updateBombCarrierRuntimeWorldIconsTick(iconLaneNowSec);
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
      updateCipherCounterWorldIcons(false);
      updateCipherSuddenDeathAliveHudForAllPlayers();
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
    updatePostmatchShowcaseWorldIconPositions();
    if (postmatchEndStep !== 0) {
      return;
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
      mod.EndGameMode(postmatchWinnerTeam);
      postmatchEndStep = 3;
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
    const joiningId = modlib.getPlayerId(eventPlayer);
    const joiningIsAi = isBotBackfillPlayerSafe(eventPlayer);

    // Runtime AI bots must not be treated like human clients.
    // Do not build HUD/UI/admin/ready-up state for AI.
    // OnSpawnerSpawned will bind custom runtime bots to slots.
    if (joiningIsAi) {
      const existingBot = serverPlayers.get(joiningId);
      if (existingBot) {
        existingBot.player = eventPlayer;
        existingBot.team = mod.GetTeam(eventPlayer);
      }

      clearCipherKeyHudCacheForPlayer(joiningId);
      clearBotObjectiveStateForPlayer(joiningId);
      refreshCipherKeyPlayerSnapshots("OnPlayerJoinGame_AI");
      return;
    }

    let player: Player | undefined;

    // IMPORTANT:
    // This event can be triggered multiple times for the same player.
    // If we already know the player, do NOT announce "joined" again.
    const existing = serverPlayers.get(joiningId);
    if (existing) {
      existing.player = eventPlayer;
      existing.setTeam();
      player = existing;
    } else {
      // Reconnect detection should be based on playerId, not objId.
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

      // Truly new human player
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
    assignCipherAdminFromJoiningPlayerIfNeeded(eventPlayer);

    if (gameStatus === 1) {
      stripLoadoutToMeleeOnly(eventPlayer);
    }

    if (gameStatus === 0 || gameStatus === -1) {
      if (player) replacePrematchReadyText(player.id, eventPlayer);
      refreshPrematchReadyStateUi();
    } else if (gameStatus === 3) {
      HidePrematchUiForTransition();
      SafeSetWidgetVisibleByName("LiveContainer", true);
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

      runtimeBotNextReconcileAtSec = 0;
    } else if (gameStatus === 2 && player) {
      requestTransitionSpawn(player.id, "join_prelive");
    } else if (gameStatus === 4) {
      SafeSetWidgetVisibleByName("PostMatchContainer", true);
      applyPostmatchInputStateForPlayer(eventPlayer);
      setPostmatchShowcaseCameraForPlayer(eventPlayer, true);

      if (player) {
        const slot = findPostmatchShowcaseSlotForPlayerId(player.id);
        if (slot) applyPostmatchShowcaseSlot(slot);
      }
    }

    requestCipherTransitionReconcile("OnPlayerJoinGame");
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
    const leavingRuntimeSlot = getRuntimeBotSlotForPlayerId(leaving.id);
    const leavingIsRuntimeBot = leavingRuntimeSlot !== undefined || runtimeBotReleasedPlayerId[leaving.id] === true;
    cleanupRestrictedAreaUiForPlayer(leaving.id);
    deleteCipherSuddenDeathAliveHudForPlayer(leaving.id);
    resetCipherSuddenDeathAliveHudRefsForPlayer(leaving);
    // Ensure HUD can be rebuilt cleanly if the engine destroys UI widgets on disconnect.
    liveHudBuiltByPlayerId[leaving.id] = false;
    forceDeleteCipherAdminPanelForPlayerId(leaving.id);
    if (cipherAdminPlayerId === leaving.id) {
      cipherAdminPlayerId = undefined;
      clearCipherAdminInteractPoint("admin_left");
    }

    if (!leavingIsRuntimeBot) {
      mod.DisplayHighlightedWorldLogMessage(mod.Message(mod.stringkeys.PlayerDisconnected, leaving.id));
    }
    if (gameStatus === 3 && bombCarrierPlayerId === leaving.id) {
      const leavePos = tryGetPlayerPositionSafe(leaving.player);
      if (leavePos) lastKnownLivePositionByPlayerId[leaving.id] = leavePos;
      forceBombDropFromCarrier(leaving.id, "disconnect");
    }

    cancelObjectiveCaptureAttemptsForPlayer(leaving.id);

    if (!leavingIsRuntimeBot) disconnectedPlayers.push(leaving);
    serverPlayers.delete(leaving.id);
    ensureCipherAdminAssigned();

    if (gameStatus === 4 && postmatchEndStep === 0) {
      beginPostmatchShowcase();
    }

    if (isCipherSuddenDeathActive()) {
      updateCipherSuddenDeathAliveHudForAllPlayers();
      const winner = resolveCipherSuddenDeathEliminationWinner();
      if (!mod.Equals(winner, teamNeutral)) {
        scheduleCipherSuddenDeathPostmatch(winner, "player_leave");
      }
    }

    if (gameStatus === 3 && initialization[3] === true) {
      syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerLeaveGame");
    }

    clearBombCarrierDeployRestoreCacheForPlayer(leaving.id);
    delete lastKnownLivePositionByPlayerId[leaving.id];
    clearQueuedSafeSpawnStateForPlayer(leaving.id);
    delete safeSpawnGenerationByPlayerId[leaving.id];
    delete safeSpawnUnsafePending[leaving.id];
    delete safeSpawnUnsafeSpawnerObjId[leaving.id];
    delete safeSpawnUnsafeHqObjIdByPlayerId[leaving.id];
    delete safeSpawnForcedRedeploys[leaving.id];
    delete safeSpawnForcedUndeploy[leaving.id];
    delete lastLiveHqSpawnPointObjIdByPlayerId[leaving.id];
    delete lastForcedSafeSpawnHqObjIdByPlayerId[leaving.id];
    delete transitionSpawnRequestedByPlayerId[leaving.id];
    delete transitionSpawnLastAttemptTickByPlayerId[leaving.id];
    delete transitionSpawnInFlightByPlayerId[leaving.id];
    delete cipherAdminInteractSpawnTokenByPlayerId[leaving.id];
    delete cipherSecondHalfDeployRequiredByPlayerId[leaving.id];
    delete cipherSecondHalfDeployReadyByPlayerId[leaving.id];
    delete cipherTransitionTeleportedByPlayerId[leaving.id];
    delete cipherSecondHalfFrozenByPlayerId[leaving.id];
    delete postmatchShowcaseCameraAppliedByPlayerId[leaving.id];
    delete bombNoticeMessageKeyByPlayerId[leaving.id];
    delete bombNoticeFallbackTextByPlayerId[leaving.id];
    delete bombNoticeVisibleUntilSecByPlayerId[leaving.id];
    delete bombNoticeTokenByPlayerId[leaving.id];
    delete nextKeyUnlockHudLastStateByPlayerId[leaving.id];
    delete botBackfillKnownByPlayerId[leaving.id];
    delete runtimeBotReleasedPlayerId[leaving.id];
    if (leavingRuntimeSlot && !leavingRuntimeSlot.retired) {
      clearRuntimeBotPlayerBinding(leavingRuntimeSlot, false);
      leavingRuntimeSlot.nextSpawnAtSec = getCurrentSchedulerNowSeconds() + CIPHER_RUNTIME_BOT_RESPAWN_DELAY_SECONDS;
      runtimeBotNextReconcileAtSec = 0;
    }
    clearBotObjectiveStateForPlayer(leaving.id);
    clearCipherKeyHudCacheForPlayer(leaving.id);
    delete prematchSwitchLastHandledTickByPlayerId[leaving.id];
    delete prematchSwitchDebounceWarnedByPlayerId[leaving.id];
    delete prematchReadyLastHandledTickByPlayerId[leaving.id];
    delete prematchReadyDebounceWarnedByPlayerId[leaving.id];
    delete lastPrematchTeamSwitchTickByPlayerId[leaving.id];
    delete preliveTeamSanityWarnedByPlayerId[leaving.id];
    delete playerInDamageZone[leaving.id];
    clearPrematch889StateForPlayer(leaving.id);
    clearAllObjectiveAreaTriggerStateForPlayer(leaving.id);
    clearCipherPresenceForPlayer(leaving.id);
    invalidateCipherRespawnRouteJobForPlayer(leaving.id);

    if (gameStatus === 3 && !leavingIsRuntimeBot) {
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
    requestCipherTransitionReconcile("OnPlayerLeaveGame");
    refreshCipherKeyPlayerSnapshots("OnPlayerLeaveGame");
  }
}

async function Mode_OnPlayerDeployed(eventPlayer: mod.Player): Promise<void> {
  try {
    const playerId = modlib.getPlayerId(eventPlayer);
    const team = mod.GetTeam(eventPlayer);
    const deployedRuntimeBotSlot = getRuntimeBotSlotForPlayerId(playerId);
    const deployedIsBot = deployedRuntimeBotSlot !== undefined;
    const deployedSkipsHumanFlow = deployedIsBot || shouldSkipHumanInputRestrictionsForPlayer(eventPlayer);
    delete botLiveSpawnRequestedByPlayerId[playerId];
    delete botLiveSpawnNextAttemptAtSecByPlayerId[playerId];
    cancelPendingRestrictedLethalConfirmForPlayer(playerId);
    clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);
    hideDeployObjectiveTimerUiForPlayer(playerId);
    clearTransitionSpawnStateForPlayer(playerId);
    clearAllObjectiveAreaTriggerStateForPlayer(playerId);
    clearCipherPresenceForPlayer(playerId);
    cancelObjectiveCaptureAttemptsForPlayer(playerId);

    if (!deployedSkipsHumanFlow) {
      applyPhaseInputRestrictionsForPlayer(eventPlayer);
    }

    // Reset damage spacing state on deploy
    dmgSpreadClearForPlayer(eventPlayer);

    if (deployedIsBot && deployedRuntimeBotSlot) {
      handleRuntimeBotDeployedForCurrentPhase(
        eventPlayer,
        playerId,
        deployedRuntimeBotSlot,
        "OnPlayerDeployed_RuntimeBot"
      );
      return;
    }

    if (deployedSkipsHumanFlow) {
      const pAi = serverPlayers.get(playerId);
      if (pAi) {
        pAi.player = eventPlayer;
        pAi.team = team;
        pAi.isDeployed = true;
      }
      clearCipherKeyHudCacheForPlayer(playerId);
      clearBotObjectiveStateForPlayer(playerId);
      clearQueuedSafeSpawnStateForPlayer(playerId);
      invalidateCipherRespawnRouteJobForPlayer(playerId);
      clearTransitionSpawnStateForPlayer(playerId);
      return;
    }
  
    if (gameStatus === 0) {
      const pPrematch = serverPlayers.get(playerId);
      if (pPrematch) {
        pPrematch.team = team;
        pPrematch.isDeployed = true;
      }
      applyPrematch889HealthForPlayer(playerId);
      refreshPrematchReadyStateUi();
      queueCipherAdminInteractSpawnForPlayer(playerId, "OnPlayerDeployed_Prematch");
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
      queueCipherAdminInteractSpawnForPlayer(playerId, "OnPlayerDeployed_Countdown");
      return;
    }

    if (gameStatus === 2) {
      const pPre = serverPlayers.get(playerId);
      if (pPre) {
        pPre.team = team;
        pPre.isDeployed = true;
      }
      applyPrematch889HealthForPlayer(playerId);
      requestCipherSpawnAnchorForPlayer(playerId, true);
      requestCipherSpawnTeleportForPlayer(playerId, true);
      processCipherSpawnJobs("OnPlayerDeployed_Prelive");
      teleportCipherPlayerToRoutedAnchor(eventPlayer, playerId);
      if (bombCarrierPlayerId === playerId) {
        syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "OnPlayerDeployed_Prelive");
      }
      queueCipherAdminInteractSpawnForPlayer(playerId, "OnPlayerDeployed_Prelive");
      return;
    }

    if (gameStatus === 4) {
      const pPost = serverPlayers.get(playerId);
      if (pPost) {
        pPost.team = team;
        pPost.isDeployed = true;
      }
      applyPostmatchInputStateForPlayer(eventPlayer);
      setPostmatchShowcaseCameraForPlayer(eventPlayer, true);
      const slot = findPostmatchShowcaseSlotForPlayerId(playerId);
      if (slot) applyPostmatchShowcaseSlot(slot);
      queueCipherAdminInteractSpawnForPlayer(playerId, "OnPlayerDeployed_Postmatch");
      return;
    }

    if (gameStatus !== 3) return;

    const p = serverPlayers.get(playerId);
    if (!p) return;

    const liveRedeploySeconds = isCipherSuddenDeathActive() ? 9999 : REDEPLOY_TIME;

    p.team = team;
    p.isDeployed = true;

    if (isCipherSuddenDeathActive() && cipherSuddenDeathEliminatedByPlayerId[playerId] === true) {
      try {
        mod.SetRedeployTime(eventPlayer, 9999);
      } catch (_errRedeploy) {}

      try {
        mod.UndeployPlayer(eventPlayer);
      } catch (_errUndeploy) {}

      return;
    }

    if (isCipherLiveTransitionActive()) {
      if (handleCipherTransitionDeployedPlayer(playerId, eventPlayer, "OnPlayerDeployed_Transition")) {
        queueCipherAdminInteractSpawnForPlayer(playerId, "OnPlayerDeployed_Transition");
      }
      return;
    }

    queueCipherAdminInteractSpawnForPlayer(playerId, "OnPlayerDeployed_Live");
    repairCipherKeyHudCacheForPlayer(p, true);
    updateCipherSuddenDeathAliveHudForPlayer(p);

    applyPrematch889HealthForPlayer(playerId);
    recordLastLiveHqSpawnSourceFromDeploy(eventPlayer, playerId);
    applyPhaseInputRestrictionsForPlayer(eventPlayer);

    const enteringForcedSafeSpawnFlow = safeSpawnForcedUndeploy[playerId] === true;

    if (!enteringForcedSafeSpawnFlow) {
      bumpSafeSpawnGeneration(playerId);
      clearQueuedSafeSpawnStateForPlayer(playerId);
    }

    // Store the current dynamic HQ route, but do not teleport yet.
    // If this ends up being a native friendly/squad spawn, we will commit this route and exit.
    if (!enteringForcedSafeSpawnFlow && safeSpawnUnsafePending[playerId] !== true) {
      const dyn = modlib.Equals(team, team1) ? currentDynamicHqTeam1 : currentDynamicHqTeam2;
      if (dyn && isValidDynamicSpawnId(dyn)) {
        pendingDynamicHqForPlayer[playerId] = dyn;
      }
    }

    // CRITICAL FIX:
    // If the player spawned near a teammate/squadmate, this is a native squad/friendly spawn.
    // Do NOT request a Cipher anchor and do NOT call SafeSpawnCheckOrRedeploy(),
    // because those paths can teleport the player to an anchor.
    if (!enteringForcedSafeSpawnFlow && isNativeFriendlyOrSquadSpawn(eventPlayer, playerId)) {
      invalidateCipherRespawnRouteJobForPlayer(playerId);
      mod.SetRedeployTime(eventPlayer, liveRedeploySeconds);
      p.isFirstDeploy();
      finishSafeSpawnAsNativeFriendlyOrSquadSpawn(eventPlayer, playerId);
      return;
    }

    // Normal custom Cipher spawn route.
    mod.SetRedeployTime(eventPlayer, liveRedeploySeconds);
    finalizeCipherRespawnRouteJobForPlayer(playerId, "OnPlayerDeployed_Live");
    requestCipherSpawnAnchorForPlayer(playerId, true);
    processCipherSpawnJobs("OnPlayerDeployed_LiveAnchor");

    p.isFirstDeploy();

    SafeSpawnCheckOrRedeploy(playerId);
  } catch (err) {
    LogRuntimeError("OnPlayerDeployed", err);
  } finally {
    requestCipherTransitionReconcile("OnPlayerDeployed");
    refreshCipherKeyPlayerSnapshots("OnPlayerDeployed");
  }
}

async function Mode_OnPlayerUndeploy(eventPlayer: mod.Player): Promise<void> {
  try {
    const id = modlib.getPlayerId(eventPlayer);
    const p = serverPlayers.get(id);
    if (!p) return;
    const wasDeployed = p.isDeployed === true;
    const undeployedIsBot = getRuntimeBotSlotForPlayerId(id) !== undefined;
    const isForcedSafeSpawnFlowAtUndeploy =
      safeSpawnUnsafePending[id] === true || safeSpawnForcedUndeploy[id] === true;
    closeCipherAdminPanelForPlayerId(id);
    delete cipherAdminInteractSpawnTokenByPlayerId[id];
    if (cipherAdminPlayerId === id) clearCipherAdminInteractPoint("admin_undeploy");

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
    if (!isForcedSafeSpawnFlowAtUndeploy) {
      bumpSafeSpawnGeneration(id);
      clearQueuedSafeSpawnStateForPlayer(id);
    }
    cancelObjectiveCaptureAttemptsForPlayer(id);
    UpdateDeployObjectiveTimerUiForPlayer(p);
    updateCipherSuddenDeathAliveHudForAllPlayers();

    if (undeployedIsBot && (gameStatus === 2 || (gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive)))) {
      const slot = getRuntimeBotSlotForPlayerId(id);
      if (slot && !slot.retired) {
        clearRuntimeBotPlayerBinding(slot, true);
        slot.nextSpawnAtSec = getCurrentSchedulerNowSeconds() + CIPHER_RUNTIME_BOT_RESPAWN_DELAY_SECONDS;
        runtimeBotStagedSpawnNextTick = 0;
      }
      clearCipherKeyHudCacheForPlayer(id);
      clearQueuedSafeSpawnStateForPlayer(id);
      invalidateCipherRespawnRouteJobForPlayer(id);
      requestCipherTransitionReconcile("OnPlayerUndeploy_RuntimeBotTransition");
      return;
    }

    if (gameStatus === 3 && (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive)) {
      if (cipherSecondHalfTransitionStage === "deploy") {
        setCipherSecondHalfDeployFreezeForPlayer(eventPlayer, false, "transition_deploy_undeploy");
      } else {
        applyPhaseInputRestrictionsForPlayer(eventPlayer);
      }
      mod.SetRedeployTime(eventPlayer, 0);
      clearTransitionSpawnStateForPlayer(id);
      return;
    }

    if (gameStatus === 3 && initialization[3] === true) {
      syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerUndeploy");
    }

    if (gameStatus === 3 && bombCarrierPlayerId === id) {
      const undeployPos = tryGetPlayerPositionSafe(eventPlayer);
      if (undeployPos) lastKnownLivePositionByPlayerId[id] = undeployPos;
      scheduleBombCarrierDropAfterCombatEvent(id, "undeploy", undeployPos);
    }

    if (
      isCipherSuddenDeathActive() &&
      !isCipherLiveStartSettling() &&
      wasDeployed &&
      safeSpawnForcedUndeploy[id] !== true &&
      getCurrentSchedulerNowSeconds() >= cipherSuddenDeathUndeployIgnoreUntilSec
    ) {
      consumeCipherSuddenDeathLife(id, "undeploy");
      return;
    }


    if (
      gameStatus === 1 ||
      gameStatus === 2
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

    if (gameStatus === 3 && undeployedIsBot) {
      const nowSec = getCurrentSchedulerNowSeconds();
      const trackedReviveWindowUntilSec = runtimeBotRespawnAfterSecByPlayerId[id];
      const reviveWindowUntilSec = trackedReviveWindowUntilSec ?? 0;
      const fallbackRespawnDelaySeconds = isForcedSafeSpawnFlowAtUndeploy
        ? CIPHER_RUNTIME_BOT_RESPAWN_DELAY_SECONDS
        : trackedReviveWindowUntilSec !== undefined
          ? CIPHER_RUNTIME_BOT_RESPAWN_DELAY_SECONDS
          : CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS;
      const respawnDelaySeconds =
        reviveWindowUntilSec > nowSec
          ? reviveWindowUntilSec - nowSec
          : fallbackRespawnDelaySeconds;
      safeSpawnForcedRedeploys[id] = 0;
      safeSpawnForcedUndeploy[id] = false;
      safeSpawnUnsafePending[id] = false;
      safeSpawnPendingCheck[id] = false;
      hqDesyncForcedRedeploys[id] = 0;
      requestLiveBotSpawnForPlayerId(id, "OnPlayerUndeploy_Live", respawnDelaySeconds);
      p.addDeath();
      return;
    }

    if (safeSpawnUnsafePending[id] === true) {
      if (safeSpawnForcedQueuedGenerationByPlayerId[id] !== undefined) return;

      safeSpawnUnsafePending[id] = false;
      safeSpawnUnsafeHqObjIdByPlayerId[id] = 0;
      safeSpawnUnsafeSpawnerObjId[id] = 0;
      safeSpawnForcedUndeploy[id] = false;
      return;
    }

    if (safeSpawnForcedUndeploy[id] === true) return;
    if (gameStatus === 2) return;
    if (gameStatus === 3 && getCurrentSchedulerNowSeconds() < cipherPhaseTransitionUndeployIgnoreUntilSec) return;

    if (gameStatus === 3) {
      startCipherRespawnRouteJobForPlayer(id, wasDeployed, "OnPlayerUndeploy_Live");
      p.addDeath();
    }
  } catch (err) {
    LogRuntimeError("OnPlayerUndeploy", err);
  } finally {
    requestCipherTransitionReconcile("OnPlayerUndeploy");
    refreshCipherKeyPlayerSnapshots("OnPlayerUndeploy");
  }
}

function Mode_OnPlayerInteract(eventPlayer: mod.Player, eventInteractPoint: mod.InteractPoint): void {
  try {
    const ipId = getObjIdSafe(eventInteractPoint);

    if (isCipherAdminInteractPointId(ipId)) {
      if (isCipherAdminPlayer(eventPlayer)) {
        const playerId = getPlayerIdSafe(eventPlayer);
        if (playerId !== undefined && cipherAdminPanelVisibleByPlayerId[playerId] === true) {
          closeCipherAdminPanelForPlayerId(playerId);
        } else {
          openCipherAdminPanelForPlayer(eventPlayer);
        }
      }
      clearCipherAdminInteractPoint("admin_interact_used");
      return;
    }

    if (gameStatus === 0) {
      if (ipId === IP_T1_SWITCH || ipId === IP_T2_SWITCH) {
        warnPrematchPreliveGateOnce("prematch_interact", "switch_interact", eventPlayer, ipId);
        HandlePrematchSwitchTeams(eventPlayer);
      }

      if (ipId === IP_T1_READY || ipId === IP_T2_READY) {
        HandlePrematchReadyUp(eventPlayer, ipId);
      }

      return;
    }

    if (gameStatus === 3) {
      if (isCipherTransitionObjectiveEventSuppressed()) return;
      const objectiveCpId = resolveCurrentHalfObjectiveCpIdFromInteractPoint(ipId);
      if (objectiveCpId !== undefined) {
        HandleObjectiveCaptureInteract(eventPlayer, objectiveCpId);
        return;
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
        invalidateCipherRespawnRouteJobForPlayer(switchingId);
        updateCipherSuddenDeathAliveHudForAllPlayers();
        if (isCipherSuddenDeathActive()) {
          const winner = resolveCipherSuddenDeathEliminationWinner();
          if (!mod.Equals(winner, teamNeutral)) {
            enterPostmatchFromLive(winner);
          }
        }
      }
    }
  } catch (err) {
    LogRuntimeError("OnPlayerInteract", err);
  }
}

function Mode_OnPlayerUIButtonEvent(
  eventPlayer: mod.Player,
  eventUIWidget: mod.UIWidget,
  eventUIButtonEvent: mod.UIButtonEvent
): void {
  try {
    if (
      eventUIButtonEvent === mod.UIButtonEvent.FocusIn ||
      eventUIButtonEvent === mod.UIButtonEvent.FocusOut ||
      eventUIButtonEvent === mod.UIButtonEvent.HoverIn ||
      eventUIButtonEvent === mod.UIButtonEvent.HoverOut
    ) {
      return;
    }
    if (!isCipherAdminPlayer(eventPlayer)) return;
    const playerId = getPlayerIdSafe(eventPlayer);
    if (playerId === undefined) return;
    if (cipherAdminPanelVisibleByPlayerId[playerId] !== true) return;

    const widgetName = getUiWidgetNameSafe(eventUIWidget);
    const action = parseCipherAdminActionFromWidgetName(widgetName, playerId);
    if (!action) return;
    if (!tryConsumeCipherAdminPrimaryClickEvent(playerId, widgetName, eventUIButtonEvent)) return;
    if (isCipherAdminButtonDebounced(playerId, action)) return;

    executeCipherAdminAction(eventPlayer, playerId, action);
  } catch (err) {
    LogRuntimeError("OnPlayerUIButtonEvent", err);
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

    const capturePoint = cp.resolveHandle("syncCapturePointPlayersOnPointFromEngine");
    if (!capturePoint) continue;

    const arr = mod.GetPlayersOnPoint(capturePoint);

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

    const newPoint = cpWrap.resolveHandle("syncCapturePointPlayersOnPointFromEngine/player");
    if (!newPoint) return;

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
  if (isCipherTransitionObjectiveEventSuppressed()) return;

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

  if (isObjectiveActiveForCurrentHalf(cpId)) {
    tryDeliverCipherKeyForCarrierAtObjective(id, cpId);
  }
  
  cp.updateUIforPlayersOnPoint();
}

function Mode_OnPlayerExitCapturePoint(eventPlayer: mod.Player, eventCapturePoint: mod.CapturePoint): void {
  const id = modlib.getPlayerId(eventPlayer);
  const cpId = mod.GetObjId(eventCapturePoint);

  if (gameStatus !== 3) return;
  if (isCipherTransitionObjectiveEventSuppressed()) return;

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

function repairObjectiveCapturePointNativeEvent(eventName: string, eventCapturePoint: mod.CapturePoint): void {
  if (gameStatus !== 3) return;
  if (isCipherTransitionObjectiveEventSuppressed()) return;

  const cpId = mod.GetObjId(eventCapturePoint);
  if (!isScriptedObjectiveCapturePointId(cpId)) return;
  if (objectiveSurfaceSyncInProgress) {
    objectiveSurfaceSyncQueued = true;
    return;
  }

  const activeCpId = getLogicalObjectiveCpIdForSurfaceCpId(cpId) ?? cpId;
  const activeCp = serverCapturePoints[activeCpId];
  if (!activeCp || !isObjectiveCpId(activeCpId)) {
    ensureObjectiveEngineOwnerMatchesScript(cpId, eventName);
    return;
  }

  syncLiveHybridObjectiveSurfaceState(eventName, true);
  updateObjectiveCaptureInteractionForCp(activeCpId);
  updateCipherCounterWorldIconForCp(activeCpId, true);

  if (isRoutingCpId(activeCpId)) markHqRoutingDirty();
  serverPlayers.forEach((p) => UpdateTopFlagColorsForPlayer(p));
}

function Mode_OnCapturePointCaptured(eventCapturePoint: mod.CapturePoint): void {
  repairObjectiveCapturePointNativeEvent("Mode_OnCapturePointCaptured", eventCapturePoint);
}

function Mode_OnCapturePointLost(eventCapturePoint: mod.CapturePoint): void {
  repairObjectiveCapturePointNativeEvent("Mode_OnCapturePointLost", eventCapturePoint);
}

function Mode_OnCapturePointCapturing(eventCapturePoint: mod.CapturePoint): void {
  repairObjectiveCapturePointNativeEvent("Mode_OnCapturePointCapturing", eventCapturePoint);
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
    deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
    clearAllObjectiveAreaTriggerStateForPlayer(playerId);
    clearCipherPresenceForPlayer(playerId);

    if (isCipherSuddenDeathActive() && !isCipherLiveStartSettling()) {
      consumeCipherSuddenDeathLife(playerId, "mandown");
      return;
    }

    if (getRuntimeBotSlotForPlayerId(playerId)) {
      markRuntimeBotSlotForRespawn(playerId, CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS);
    }

    // If the key carrier goes mandown in normal live play, drop the key safely after this event stack.
    if (bombCarrierPlayerId === playerId) {
      const mandownPos = tryGetPlayerPositionSafe(eventPlayer);
      if (mandownPos) lastKnownLivePositionByPlayerId[playerId] = mandownPos;
      scheduleBombCarrierDropAfterCombatEvent(playerId, "mandown", mandownPos);
    }

    UpdateObjectiveCaptureInteractionState();
    botObjectiveNextThinkAtSec = 0;
    requestCipherTransitionReconcile("OnMandown");
  }

  if (!isPrematchOutside889(playerId)) return;

  // Prematch outside 889 must never stay in mandown.
  forcePrematchOutside889FullHeal(eventPlayer, playerId);
}

function Mode_OnRevived(eventPlayer: mod.Player, _eventOtherPlayer: mod.Player): void {
  const playerId = modlib.getPlayerId(eventPlayer);
  cancelPendingRestrictedLethalConfirmForPlayer(playerId);

  if (isCipherSuddenDeathActive() && cipherSuddenDeathEliminatedByPlayerId[playerId] === true) {
    return;
  }

  delete playerInMandownByPlayerId[playerId];
  clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);

  if (gameStatus !== 3) return;

  handleRuntimeBotRevivedForPlayer(playerId, eventPlayer, "Mode_OnRevived");

  const p = serverPlayers.get(playerId);
  if (!p) return;

  startRestrictedCountdownIfNeeded(p);
  UpdateObjectiveCaptureInteractionState();
  requestCipherTransitionReconcile("OnRevived");
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

  if (isCipherSuddenDeathActive() && !isCipherLiveStartSettling()) {
    consumeCipherSuddenDeathLife(playerId, "death");
    return;
  }

  // If the carrier fully dies, drop the key through a deferred path.
  // Do not call forceBombDropFromCarrier(...) directly from this combat event.
  if (bombCarrierPlayerId === playerId) {
    scheduleBombCarrierDropAfterCombatEvent(playerId, "death", deathPos);
  }

  if (isCipherTransitionObjectiveEventSuppressed()) {
    return;
  }

  const runtimeBotSlot = getRuntimeBotSlotForPlayerId(playerId);
  if (runtimeBotSlot) {
    // Do not instantly respawn bots. Give the revive logic a chance if the engine produced mandown.
    markRuntimeBotSlotForRespawn(playerId, CIPHER_RUNTIME_BOT_DEATH_RESPAWN_DELAY_SECONDS);
  }

  if (initialization[3] === true) {
    syncLiveHybridObjectiveSurfaceState("Mode_OnPlayerDied");
  }

  botObjectiveNextThinkAtSec = 0;
  requestCipherTransitionReconcile("OnPlayerDied");
}

function Mode_OnPlayerEarnedKill(
  eventPlayer: mod.Player,
  eventOtherPlayer: mod.Player,
  _eventDeathType: mod.DeathType,
  _eventWeaponUnlock: mod.WeaponUnlock
): void {
  if (gameStatus !== 3) return;

  const killerId = modlib.getPlayerId(eventPlayer);
  const victimId = modlib.getPlayerId(eventOtherPlayer);

  const killer = serverPlayers.get(killerId);
  if (killer) {
    killer.addKill();
    killer.addScore(100);
  }

  const victim = serverPlayers.get(victimId);
  if (victim) {
    victim.addDeath();
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
  if (isCipherTransitionObjectiveEventSuppressed()) return;

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
    if (bombCarrierPlayerId === playerId) {
      const carrierPos = tryGetPlayerPositionSafe(eventPlayer);
      forceBombDropFromCarrier(playerId, "restricted_area", carrierPos);
    }
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

  if (gameStatus === 3 && isCipherTransitionObjectiveEventSuppressed()) {
    if (isObjectiveAreaTriggerId(triggerId)) {
      clearObjectiveAreaTriggerActive(playerId, triggerId);
      cancelObjectiveCaptureAttemptsForPlayer(playerId);
    } else if (isCipherPresenceTriggerId(triggerId)) {
      clearCipherPresenceZoneActive(playerId, triggerId);
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
  disableHardObjectiveMcoms("Mode_OnMCOMArmed");
  if (gameStatus !== 3) return;
  if (isCipherTransitionObjectiveEventSuppressed()) return;

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
  disableHardObjectiveMcoms("Mode_OnMCOMDefused");
  if (gameStatus !== 3) return;
  if (isCipherTransitionObjectiveEventSuppressed()) return;

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
  disableHardObjectiveMcoms("Mode_OnMCOMDestroyed");
  if (gameStatus !== 3) return;
  if (isCipherTransitionObjectiveEventSuppressed()) return;

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
  disableHardObjectiveMcoms("Mode_OngoingMCOM");
  if (gameStatus !== 3) return;
  if (isCipherTransitionObjectiveEventSuppressed()) return;

  const cpId = resolveObjectiveCpIdFromMcomEvent(eventMCOM);
  if (cpId === undefined) return;

  safeEnableObjectiveMcomByCpId(cpId, false, "Mode_OngoingMCOM", true);
  reapplyLiveHybridObjectiveSurfaceStateForCp(cpId, "Mode_OngoingMCOM");
}

function Mode_OnAIMoveToFailed(eventPlayer: mod.Player): void {
  const playerId = getPlayerIdSafe(eventPlayer);
  if (playerId === undefined) return;
  if (!getRuntimeBotSlotForPlayerId(playerId)) return;
  if (isRuntimeBotPhaseLocked(playerId)) return;

  const nowSec = getCurrentSchedulerNowSeconds();

  // Do not immediately reissue on the same frame.
  // If a path is invalid, instant retry can create an AI fail/retry storm.
  delete botObjectiveAssignedRoleByPlayerId[playerId];
  delete botObjectiveLastTargetByPlayerId[playerId];
  botObjectiveLastCommandAtSecByPlayerId[playerId] = nowSec;
  botObjectiveNextThinkAtSec = nowSec + BOT_OBJECTIVE_MOVE_FAIL_RETRY_SECONDS;
}

function Mode_OnAIMoveToSucceeded(eventPlayer: mod.Player): void {
  const playerId = getPlayerIdSafe(eventPlayer);
  if (playerId === undefined) return;
  if (!getRuntimeBotSlotForPlayerId(playerId)) return;
  if (isRuntimeBotPhaseLocked(playerId)) return;

  const nowSec = getCurrentSchedulerNowSeconds();

  if (bombCarrierPlayerId === playerId) {
    tryDeliverCipherKeyFromActiveObjectiveAreaForCarrier(playerId);
  } else {
    EvaluateResponsiveBombPickupRadiusScans();
  }

  // Small delay avoids rapid success/reissue loops while still keeping bots responsive.
  botObjectiveNextThinkAtSec = nowSec + BOT_OBJECTIVE_MOVE_SUCCESS_RECHECK_SECONDS;
}

function Mode_OnSpawnerSpawned(eventPlayer: mod.Player, eventSpawner: mod.Spawner): void {
  try {
    const spawnerObjId = mod.GetObjId(eventSpawner as mod.Object);
    const slot = takePendingRuntimeBotSlotForSpawner(spawnerObjId);
    if (!slot) return;
    bindRuntimeBotPlayerToSlot(slot, eventPlayer);
    refreshCipherKeyPlayerSnapshots("OnSpawnerSpawned");
  } catch (err) {
    LogRuntimeError("OnSpawnerSpawned_RuntimeBot", err);
  }
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

export const adminRuntimeHandlers = {
  onPlayerUIButtonEvent: Mode_OnPlayerUIButtonEvent,
};

export const objectiveRuntimeHandlers = {
  onPlayerEnterCapturePoint: Mode_OnPlayerEnterCapturePoint,
  onPlayerExitCapturePoint: Mode_OnPlayerExitCapturePoint,
  onCapturePointCaptured: Mode_OnCapturePointCaptured,
  onCapturePointLost: Mode_OnCapturePointLost,
  onCapturePointCapturing: Mode_OnCapturePointCapturing,
  onOngoingMcom: Mode_OngoingMCOM,
  onMcomArmed: Mode_OnMCOMArmed,
  onMcomDefused: Mode_OnMCOMDefused,
  onMcomDestroyed: Mode_OnMCOMDestroyed,
};

export const botRuntimeHandlers = {
  onAiMoveToFailed: Mode_OnAIMoveToFailed,
  onAiMoveToSucceeded: Mode_OnAIMoveToSucceeded,
  onSpawnerSpawned: Mode_OnSpawnerSpawned,
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
