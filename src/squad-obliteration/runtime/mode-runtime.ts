/* =================================================================================================
   Mind Flexor - Cipher Obliteration Game Mode Script
   -------------------------------------------------------------------------------------------------
   

   Description:
     - Implements a four-lane, key-delivery Cipher mode:
         * Prematch ready-up flow (team switch + ready interactions)
         * Countdown -> Pre-live -> Live -> Postmatch state machine
         * Two-key node overloads, timed halves, sudden death, and postmatch
         * Cipher A-D HUD, key state, remaining time, and postmatch overlay
         * Fixed live HQ enforcement by half
         * Generation-guarded anchor routing with native squad-spawn bypass
         * Key/objective audio, countdown heartbeat, and match start stinger

   Usage / Notes:
     - This script assumes specific CapturePoint IDs, HQ IDs, InteractPoint IDs, WorldIcon IDs,
       and authored Cairo anchors already placed in the level.
     - Keep IDs in sync with your map placement.

   Licensing / Credits:
     - Licensed under MIT (see root LICENSE).
     - Primary mode implementation: Enoc Bernal (mindflexor).
     - Credits: BattlefieldDad, Mancour, uberdubersoldat, and dfk_7677 for gameplay inspiration.
     - Template and utilities foundation credit: Michael De Luca.

   Version:
     - v0.07
================================================================================================= */

import { BOMB_CONFIG } from '../config/bomb.ts';
import { CIPHER_OBJECTIVE_CONFIGS } from '../config/objectives.ts';
import { RULES } from '../config/rules.ts';
import { SPAWN_ROUTING_CONFIG } from '../config/spawn-routing.ts';
import { WORLD_IDS } from '../config/world-ids.ts';
import { modlib } from '../utils/mod-compat.ts';
import { Timers } from 'bf6-portal-utils/timers/index.ts';

/* =================================================================================================
   1) CORE CONFIGURATION
================================================================================================= */

const TICK_RATE = RULES.tickRate;        // OngoingGlobal is treated as configured ticks/sec

type CipherScheduledTask = {
  id: number;
  deadlineSeconds: number;
  context: string;
  run: () => void;
};

let cipherScheduledTaskSequence = 0;
let cipherScheduledTasks: CipherScheduledTask[] = [];
let cipherCancelledScheduledTaskIds: { [taskId: number]: boolean | undefined } = {};

function scheduleCipherGlobalTask(delaySeconds: number, context: string, run: () => void): number {
  cipherScheduledTaskSequence += 1;
  cipherScheduledTasks.push({
    id: cipherScheduledTaskSequence,
    deadlineSeconds: getCurrentSchedulerNowSeconds() + mod.Max(0, delaySeconds),
    context,
    run,
  });
  return cipherScheduledTaskSequence;
}

function cancelCipherGlobalTask(taskId: number | undefined): void {
  if (taskId === undefined) return;
  cipherCancelledScheduledTaskIds[taskId] = true;
}

function processCipherScheduledTasks(nowSeconds: number): boolean {
  if (cipherScheduledTasks.length === 0) return false;
  const remaining: CipherScheduledTask[] = [];
  let processed = 0;
  for (let i = 0; i < cipherScheduledTasks.length; i++) {
    const task = cipherScheduledTasks[i];
    if (cipherCancelledScheduledTaskIds[task.id] === true) {
      delete cipherCancelledScheduledTaskIds[task.id];
      continue;
    }
    // Never catch up multiple engine-calling timers in one server frame.
    if (task.deadlineSeconds > nowSeconds || processed >= 1) {
      remaining.push(task);
      continue;
    }
    processed += 1;
    try {
      task.run();
    } catch (err) {
      LogRuntimeError("ScheduledTask/" + task.context, err);
    }
  }
  cipherScheduledTasks = remaining;
  return processed > 0;
}

function resetCipherScheduledTasks(): void {
  cipherScheduledTasks = [];
  cipherCancelledScheduledTaskIds = {};
}

const USE_ENGINE_TIME_SCHEDULER = true;
const DEBUG_PERF_TELEMETRY = false;
const ENABLE_CARRIER_SUBTICK = true;
const DEBUG_CARRIER_SUBTICK = false;
const ICON_FOLLOW_INTERVAL_SECONDS = 0.05; // 20 Hz
const FAST_INTERVAL_SECONDS = 0.10; // 10 Hz
const SLOW_INTERVAL_SECONDS = 0.30; // 3.3 Hz
const ENDGAME_AUDIO_INTERVAL_SECONDS = 0.50; // 2 Hz
const CIPHER_RUNTIME_BOTS_DEFAULT_ENABLED = false;
const CIPHER_RUNTIME_BOT_RESPAWN_DELAY_SECONDS = 1.0;
const CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS = 5.0;
const CIPHER_RUNTIME_BOT_DEATH_RESPAWN_DELAY_SECONDS = CIPHER_RUNTIME_BOT_MANDOWN_REVIVE_WINDOW_SECONDS;
const BOT_LIVE_SPAWN_INITIAL_DELAY_SECONDS = 0.25;
const CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID = WORLD_IDS.bots.team1Spawner;
const CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID = WORLD_IDS.bots.team2Spawner;
const CIPHER_RUNTIME_BOT_STAGED_SPAWN_INTERVAL_TICKS = TICK_RATE;
const BOT_OBJECTIVE_MOVE_FAIL_RETRY_SECONDS = 2.0;
const BOT_OBJECTIVE_MOVE_SUCCESS_RECHECK_SECONDS = 0.35;

// Defer key drops caused by death/mandown/undeploy out of the combat event stack.
let deferredBombCarrierDropToken = 0;
let deferredBombCarrierDropTimer: number | undefined = undefined;

// Debug portal-log pulls.
// These are intentionally one-shot timers so they do not spam the server.
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
const CIPHER_NODE_VFX_Y_OFFSET_METERS = 1.25;
const CIPHER_NODE_VISUAL_Y_OFFSET_METERS = CIPHER_NODE_VFX_Y_OFFSET_METERS;
const CIPHER_LIVE_KEY_WATCHDOG_INITIAL_GRACE_SECONDS = 1.0;
const CIPHER_LIVE_KEY_WATCHDOG_RETRY_SECONDS = 0.75;
const CIPHER_LIVE_KEY_WATCHDOG_LOG_SECONDS = 5.0;
const CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS = 30;
const CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS = 0.75;
const CIPHER_SECOND_HALF_FORCE_DEPLOY_WATCHDOG_SECONDS = 2.0;
const CIPHER_HALFTIME_INTERMISSION_SECONDS = 5;

const ROUND_TIME = RULES.halfTimeSeconds;                // seconds
const OVERTIME_TIME = RULES.suddenDeathSeconds;              // seconds
const LIVE_ENGINE_TIME_LIMIT_SAFETY_SECONDS = 7200;
const LIVE_TIMER_INTRO_SECONDS = 3.0;
const LIVE_SCORE_PANEL_LEFT = 26;
const LIVE_SCORE_PANEL_TOP = 92;
const LIVE_SCORE_PANEL_WIDTH = 308;
const LIVE_SCORE_PANEL_HEIGHT = 122;
const LIVE_SCORE_NODE_SIZE = 44;
const LIVE_SCORE_NODE_GAP = 6;
const LIVE_SCORE_NODE_ROW_WIDTH = (LIVE_SCORE_NODE_SIZE * 4) + (LIVE_SCORE_NODE_GAP * 3);
const LIVE_SCORE_NODE_ROW_LEFT = LIVE_SCORE_PANEL_LEFT + ((LIVE_SCORE_PANEL_WIDTH - LIVE_SCORE_NODE_ROW_WIDTH) / 2);
const LIVE_SCORE_NODE_ROW_TOP = LIVE_SCORE_PANEL_TOP + 3;
const LIVE_SCORE_ROW_CENTER_Y = LIVE_SCORE_PANEL_TOP + 63;
const LIVE_HUD_SCORE_WIDTH = 64;
const LIVE_HUD_SCORE_HEIGHT = 38;
const LIVE_TIMER_DEFAULT_WIDTH = 150;
const LIVE_TIMER_DEFAULT_HEIGHT = 38;
const LIVE_TIMER_DEFAULT_POS_X = LIVE_SCORE_PANEL_LEFT + ((LIVE_SCORE_PANEL_WIDTH - LIVE_TIMER_DEFAULT_WIDTH) / 2);
const LIVE_TIMER_DEFAULT_POS_Y = LIVE_SCORE_ROW_CENTER_Y - (LIVE_TIMER_DEFAULT_HEIGHT / 2);
const LIVE_HUD_FRIENDLY_SCORE_X = LIVE_SCORE_PANEL_LEFT + 16;
const LIVE_HUD_ENEMY_SCORE_X = LIVE_SCORE_PANEL_LEFT + LIVE_SCORE_PANEL_WIDTH - LIVE_HUD_SCORE_WIDTH - 16;
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

const COUNT_DOWN_TIME = RULES.countdownTimeSeconds;              // ready-up delay before forced undeploy into pre-live
const PRELIVE_TIME = RULES.preliveTimeSeconds;                // seconds (pre-live freeze)
const POSTMATCH_TIME = RULES.postmatchTimeSeconds;              // seconds
const LIVE_HUD_BUILDS_PER_TICK = 1;
const LIVE_HUD_REPAIRS_PER_TICK = 2;
const PHASE_PLAYER_OPS_PER_TICK = 1;
const CIPHER_KEY_UI_REFRESHES_PER_TICK = 1;

const REDEPLOY_TIME = RULES.redeployTimeSeconds; // live redeploy time
// tickets after first live deploy

// per second
// per second
// Damage smoothing (applies in OnPlayerDamaged)
const ENABLE_DAMAGE_SMOOTHING = false;   // set to false to disable smoothing
// Master switch for string-table-backed debug/warn world logs listed in squadoblistrings.
const ENABLE_STRINGKEY_DEBUG_WORLD_LOGS = false;


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
let startupPipelineActive = false;
let startupPipelineStage = 0;
let startupPipelinePlayerCursor = 0;
let startupPipelinePlayerHandles: mod.Player[] = [];
let startupPipelineAnchorIds: number[] = [];
let startupPipelineAnchorCursor = 0;
let startupPipelinePreparedPlayerIds: number[] = [];
let startupPipelinePreparedPlayerCursor = 0;
let liveInitializationActive = false;
let liveInitializationStage = 0;
let liveInitializationPlayerIds: number[] = [];
let liveInitializationPlayerCursor = 0;
let liveInitializationObjectiveCursor = 0;
let preliveInitializationStage = 0;
let preliveInitializationPlayerIds: number[] = [];
let preliveInitializationPlayerCursor = 0;
let preliveInitializationObjectiveCursor = 0;
let phaseUiCleanupPlayerIds: number[] = [];
let phaseUiCleanupCursor = 0;
let phaseUiCleanupQueuedByPlayerId: { [playerId: number]: boolean | undefined } = {};
let liveCarrierTicketUiCursor = 0;
let liveBombNoticeUiCursor = 0;
let liveCarrierStatusUiCursor = 0;
let liveObjectiveHoldUiCursor = 0;
let liveDeployTimerUiCursor = 0;
let liveNextKeyUiCursor = 0;
let cipherCounterWorldIconCursor = 0;
let liveScoreboardCursor = 0;
let suddenDeathAliveHudCursor = 0;

let serverTickCount: number = 0;
let phaseTickCount: number = 0;
let countDown: number = COUNT_DOWN_TIME;
let currentFrameNowSec = 0;
let currentFrameHasEngineNowSec = false;
let phaseCountdownDeadlineAtSec = 0;
let phaseCountdownLastShownSeconds = -1;
let schedulerNextLiveFastUpdateAtSec = 0;
let schedulerNextLiveSlowUpdateAtSec = 0;
let schedulerNextLiveEndgameAudioAtSec = 0;
let schedulerNextLiveIconFollowAtSec = 0;
let liveGameModeLimitAtSec = 0;
let liveClockStarted = false;
let liveClockDeadlineAtSec = 0;
let liveClockCurrentPhaseDurationSeconds = 0;
let liveClockTimeoutHoldActive = false;
let liveTimerIntroActive = false;
let liveTimerIntroEndsAtSec = 0;
let liveTimerIntroDisplaySeconds: number = ROUND_TIME;
let liveHudBuildQueue: LiveHudBuildQueueItem[] = [];
let liveHudBuildQueuedByPlayerId: { [playerId: number]: boolean } = {};
let phasePlayerOperationQueue: PhasePlayerOperationQueueItem[] = [];
let phasePlayerOperationQueuedByKey: { [key: string]: boolean } = {};
let cipherKeyUiRefreshQueue: CipherKeyUiRefreshQueueItem[] = [];
let preliveTransitionSpawnPendingAfterUndeploy = false;
let preliveZeroTransitionHandled = false;

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
type CipherSecondHalfTransitionStage = "none" | "intermission" | "predeployReset" | "deploy" | "finalizing";
type CipherLiveTransitionSupervisorKind = "none" | "secondHalf" | "suddenDeath";
type CipherTransitionWorkCost = "normal" | "heavy";
type CipherTransitionWorkItem = {
  token: number;
  name: string;
  cost: CipherTransitionWorkCost;
  run: () => void;
};
type LiveHudQueuePriority = "normal" | "urgent";
type LiveHudBuildQueueItem = {
  playerId: number;
  reason: string;
  dueTick: number;
  priority: LiveHudQueuePriority;
  sessionToken: number | undefined;
  expectedGameStatus: number;
  expectedMatchStage: CipherMatchStage;
  stage: "top" | "topBuild" | "topBind" | "objectiveHold" | "deployTimer";
};
type PhasePlayerOperationKind = "deploy" | "undeploy";
type PhasePlayerOperationQueueItem = {
  playerId: number;
  kind: PhasePlayerOperationKind;
  reason: string;
  dueTick: number;
  sessionToken: number | undefined;
  expectedGameStatus: number;
  expectedMatchStage: CipherMatchStage;
  expectedTransitionToken: number;
};
type PostmatchPipelineStage =
  | "idle"
  | "setup"
  | "undeploy"
  | "undeploySettle"
  | "deploy"
  | "deploySettle"
  | "showcaseBuild"
  | "showcaseWorld"
  | "playerJobs"
  | "teleport"
  | "input"
  | "reportUi"
  | "cardUi"
  | "resultSfx"
  | "scoreFade"
  | "cardFade"
  | "cardSfx"
  | "complete";
type PostmatchEndingState = "alive" | "mandown" | "undeployed";
type PostmatchPlayerJobStage =
  | "revive"
  | "awaitAlive"
  | "deploy"
  | "awaitDeploy"
  | "teleport"
  | "input"
  | "done";
type PostmatchPlayerJob = {
  playerId: number;
  sessionToken: number;
  endingState: PostmatchEndingState;
  showcaseSlotIndex: number;
  stage: PostmatchPlayerJobStage;
  nextRetryTick: number;
};
type CipherKeyUiRefreshFlags = {
  force?: boolean;
  rebuildHud?: boolean;
  refreshBombNotice?: boolean;
  refreshNextKey?: boolean;
  updateCarrierHud?: boolean;
  updateScores?: boolean;
  updateIcons?: boolean;
  syncCarrierVisuals?: boolean;
  syncHybridSurface?: boolean;
  pickupNoticeTeamId?: number;
};
type CipherKeyUiRefreshQueueItem = {
  reason: string;
  dueTick: number;
  flags: CipherKeyUiRefreshFlags;
};
type DeferredBombCarrierDropReason = "death" | "mandown" | "undeploy" | "disconnect";
const CIPHER_DEFERRED_LIVE_START_KEY_DELAY_SECONDS = 0.05;
const CIPHER_TRANSITION_NORMAL_WORK_PER_TICK = 2;
const CIPHER_TRANSITION_HEAVY_WORK_PER_TICK = 1;
const CIPHER_TRANSITION_FINALIZER_WATCHDOG_SECONDS = 8;

// Small settle window between the 5-second switching-sides intermission and the 30-second deploy phase.
// This gives Portal a clean frame boundary after bot unspawn + player undeploy.
const CIPHER_TRANSITION_PREDEPLOY_SETTLE_MS = 250;
const CIPHER_TRANSITION_PREDEPLOY_STAGE_SECONDS = 10;
const CIPHER_TRANSITION_HUMAN_UNDEPLOY_WORK_PER_TICK = 1;
const CIPHER_TRANSITION_DEPLOY_RECONCILE_PLAYERS_PER_TICK = 4;
const CIPHER_TRANSITION_FORCE_DEPLOY_PLAYERS_PER_TICK = 1;
const CIPHER_TRANSITION_BOT_UNSPAWN_WORK_PER_TICK = 1;
const CIPHER_TRANSITION_OBJECTIVE_EVENT_SUPPRESS_SECONDS = 0.35;
const POSTMATCH_PLAYER_RETRY_LIMIT = 3;
const POSTMATCH_STAGE_SETTLE_TICKS = 3;
const POSTMATCH_SCORE_FADE_STEPS = 5;
const POSTMATCH_SCORE_FADE_STEP_TICKS = 5;
const POSTMATCH_CARD_FADE_STEPS = 5;
const POSTMATCH_CARD_FADE_STEP_TICKS = 3;

// Live state kept by the active Cipher runtime. These were previously near the top-level state block;
// keep them compact so the dead-code cleanup does not remove live transition/HUD bookkeeping.
let liveClockCountdownStartAtSec = 0;
let liveClockOvertimeActive = false;
let liveClockOvertimeConsumed = false;
let cipherPendingScoreTransitionTeam: mod.Team = teamNeutral;
let cipherLiveTransitionSupervisorStageStartedAtMs = 0;
let cipherLiveTransitionSupervisorReason: CipherHalfTransitionReason = "scoreCap";
let cipherTransitionUndeployCursor = 0;
let postmatchEndStepTick = 0;
let postmatchEndStepAtSec = 0;
let bombDroppedWorldIconLastShownSeconds = -1;
let runtimeBotLockReapplyNextTick = 0;
let bombCarrierIconMissingWarned = false;
let bombCarrierIconOwnerWarned = false;
let carrierIconVisualLastSampleSec = 0;
let carrierIconVisualLastCarrierPos: mod.Vector | undefined = undefined;
let carrierIconVisualVelocity = mod.CreateVector(0, 0, 0);
let carrierIconFriendlyVisualPos: mod.Vector | undefined = undefined;
let carrierIconEnemyVisualPos: mod.Vector | undefined = undefined;
let UIContainers: mod.UIWidget[] = [];
let postmatchPipelineToken = 0;
let postmatchPipelineStage: PostmatchPipelineStage = "idle";
let postmatchPipelineSetupStep = 0;
let postmatchPipelinePlayerIds: number[] = [];
let postmatchPipelineCursor = 0;
let postmatchPipelineRetryByPlayerId: { [playerId: number]: number | undefined } = {};
let postmatchPipelineStageReadyTick = 0;
let postmatchPipelineTeleportRetryByPlayerId: { [playerId: number]: number | undefined } = {};
let postmatchRevealStep = 0;
let postmatchRevealSlotIndex = 0;
let postmatchRevealNextTick = 0;
let postmatchRevealSfxPlayerIds: number[] = [];
let postmatchPlayerJobs: PostmatchPlayerJob[] = [];
let postmatchPlayerJobCursor = 0;
let postmatchCardUiBuildCursor = 0;

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
let cipherSecondHalfTransitionActive = false;
let cipherSecondHalfTransitionStage: CipherSecondHalfTransitionStage = "none";
let cipherLiveTransitionSupervisorKind: CipherLiveTransitionSupervisorKind = "none";
let cipherLiveTransitionSupervisorToken = 0;
let cipherLiveTransitionSupervisorDeadlineAtSec = 0;
let cipherLiveTransitionSupervisorDeadlineTick = 0;
let cipherLiveTransitionSupervisorDeadlineAtMs = 0;
let cipherLiveTransitionSupervisorLastShownSeconds = -1;
let cipherDeferredLiveStartKeyToken = 0;
let cipherLiveKeyWatchdogActive = false;
let cipherLiveKeyWatchdogStartedAtSec = 0;
let cipherLiveKeyWatchdogLastAttemptAtSec = -999999;
let cipherLiveKeyWatchdogLastLogAtSec = -999999;
let cipherLiveKeyWatchdogHalf: CipherHalfIndex = 1;
let cipherLiveKeyWatchdogStage: CipherMatchStage = "half1";
let cipherSecondHalfDeployRequiredByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionRosterLastDiagnostic = "";
let cipherSecondHalfDeployReadyByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionDeploySeenByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionDeployAckTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherTransitionDeployReconcileCursor = 0;
let cipherTransitionDeployLastHudStateKey = "";
let cipherTransitionForceDeployQueue: number[] = [];
let cipherTransitionForceDeployQueueToken = 0;
const cipherTransitionForceDeploySessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherTransitionForceDeployIssuedTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherTransitionForceFinishToken = 0;
let cipherTransitionForceFinishMinUntilSec = 0;
let cipherTransitionForceFinishDeadlineSec = 0;
let cipherSecondHalfFrozenByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionTeleportedByPlayerId: { [playerId: number]: boolean } = {};
let cipherTransitionCountdownSeconds = 0;
let cipherTransitionDeployTitleKey: any = undefined;
let cipherTransitionDeployTitleFallback = "";
let cipherTransitionSubtitleKey: any = undefined;
let cipherTransitionSubtitleFallback = "";
let cipherSecondHalfForceDeployIssuedForTransitionToken = 0;
let cipherTransitionWorkToken = 0;
let cipherTransitionWorkQueue: CipherTransitionWorkItem[] = [];
let cipherTransitionFinalizerActive = false;
let cipherTransitionFinalizerKind: CipherLiveTransitionSupervisorKind = "none";
let cipherTransitionFinalizerToken = 0;
let cipherTransitionFinalizerStartedAtSec = 0;
let cipherTransitionLastCheckpoint = "";
let cipherTransitionLastError = "";
let cipherTransitionEngineMutationActive = false;
let cipherSuppressObjectiveEventsUntilSec = 0;
let cipherTransitionPreDeployResetStarted = false;
let cipherTransitionPreDeployResetSource = "";
let cipherTransitionPreDeployBotSpawnerCursor = 0;
let cipherTransitionPreDeployBotInternalCleared = false;
let cipherTransitionPreDeployHumanQueue: number[] = [];
let cipherTransitionPreDeployHumanSessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherTransitionPreDeploySettleUntilSec = 0;
let cipherTransitionPreDeployEnterDeployScheduled = false;
let cipherTransitionPreDeployFirstWorkAtSec = 0;
let cipherTransitionIntermissionHandoffScheduled = false;
let cipherTransitionPreDeployNextWorkAtSec = 0;
let cipherTransitionPreDeployBotPlayerQueue: number[] = [];
let cipherSuddenDeathTransitionActive = false;
let cipherSuddenDeathPostmatchToken = 0;
let cipherSuddenDeathForcedUndeployTokenCounter = 0;
let cipherSuddenDeathForcedUndeployTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherPostmatchTransitionStarted = false;
let cipherSecondHalfTransitionToken = 0;
let cipherSuddenDeathTransitionToken = 0;
let cipherDeliveryTransitionTimer: number | undefined = undefined;
let cipherDeliveryTransitionToken = 0;
let cipherDeliveryTransitionPending = false;
let cipherTimeoutTransitionTimer: number | undefined = undefined;
let cipherTimeoutTransitionToken = 0;
let cipherTimeoutTransitionPending = false;

type CipherTimeoutTransitionOutcome =
  | "secondHalf"
  | "suddenDeath"
  | "postmatch";

let postmatchEndStep = 0;
let postmatchWinnerTeam: mod.Team = teamNeutral;
let postmatchEndTimer: number | undefined = undefined;
let postmatchEndToken = 0;
let postmatchEndTick = 0;
let transitionFallbackActive = false;
let transitionFallbackNextAllowedTick = 0;
let transitionWarnedByKey: { [key: string]: boolean } = {};
let liveTransitionCheckpointSeenByKey: { [key: string]: boolean } = {};
let hqEnableWarnedById: { [hqId: number]: boolean } = {};
let hqEnabledStateById: { [hqId: number]: boolean | undefined } = {};
let hqPhaseProfileKey = "none";
let hqPhaseProfileEpoch = 0;
let hqPhaseProfileDesiredIds: number[] = [];
let prematchUiGuardWarnedByKey: { [key: string]: boolean } = {};
const TRANSITION_FALLBACK_RETRY_COOLDOWN_TICKS = mod.Max(1, mod.Floor(2 * TICK_RATE));
let transitionSpawnRequestedByPlayerId: { [playerId: number]: boolean } = {};
let transitionSpawnLastAttemptTickByPlayerId: { [playerId: number]: number } = {};
let transitionSpawnInFlightByPlayerId: { [playerId: number]: boolean } = {};
let transitionSpawnSessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let transitionSpawnExpectedGameStatusByPlayerId: { [playerId: number]: number | undefined } = {};
let transitionSpawnExpectedMatchStageByPlayerId: { [playerId: number]: CipherMatchStage | undefined } = {};
let transitionSpawnExpectedTransitionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let transitionSpawnDueTickByPlayerId: { [playerId: number]: number | undefined } = {};
let transitionSpawnWarnedByKey: { [key: string]: boolean } = {};
let readyTransitionHumanPlayerIds: number[] = [];
let readyTransitionSessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let readyTransitionWaitingShown = false;
let objectiveEngineWarnedByKey: { [key: string]: boolean } = {};
const TRANSITION_SPAWN_MIN_RETRY_TICKS = mod.Max(1, mod.Floor(0.1 * TICK_RATE));
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
let prematchReadyPlayersByTeam: [number, number] = [0, 0];
let prematchTotalPlayersByTeam: [number, number] = [0, 0];
let prematchAllPlayersReady = false;

type CipherAdminAction = "close";
type CipherAdminPrimaryClickPhase = "down" | "up";
type CipherAdminPrimaryClickState = { widgetName: string; atSeconds: number; phase: CipherAdminPrimaryClickPhase };
let cipherAdminPlayerId: number | undefined = undefined;
let cipherAdminPanelVisibleByPlayerId: { [playerId: number]: boolean | undefined } = {};
const CIPHER_ADMIN_BUTTON_TEXT_SIZE = 14;
let cipherAdminInteractSpawnTokenByPlayerId: { [playerId: number]: number | undefined } = {};

const POSTMATCH_END_STEP_ADVANCE_TICKS = 1;
const POSTMATCH_END_RETRY_MS = 1000;

/* =================================================================================================
   3) WORLD IDS (HQ / CAPTURE POINTS / INTERACT / ICONS / DAMAGE ZONE)
================================================================================================= */

/* First-half live HQs */
const TEAM1_INITIAL_HQ = WORLD_IDS.hq.team1Initial;
const TEAM2_INITIAL_HQ = WORLD_IDS.hq.team2Initial;

/* Prematch ready-up HQs */
const TEAM1_READYUP_HQ = WORLD_IDS.hq.team1Readyup;
const TEAM2_READYUP_HQ = WORLD_IDS.hq.team2Readyup;

/* Fixed live HQs for half 2 and sudden death */
const TEAM1_LIVE_HQ = WORLD_IDS.hq.team1Live;
const TEAM2_LIVE_HQ = WORLD_IDS.hq.team2Live;

/* Only these authored HQ IDs exist in the Cipher spatial and may be toggled. */
const MANAGED_CIPHER_HQ_IDS: number[] = [
  TEAM1_READYUP_HQ,
  TEAM2_READYUP_HQ,
  TEAM1_INITIAL_HQ,
  TEAM2_INITIAL_HQ,
  TEAM1_LIVE_HQ,
  TEAM2_LIVE_HQ,
];

/* CapturePoint IDs */
const CP_A_ID = WORLD_IDS.capturePoints.a;
const CP_B_ID = WORLD_IDS.capturePoints.b;
const CP_C_ID = WORLD_IDS.capturePoints.c;
const CP_D_ID = WORLD_IDS.capturePoints.d;
const CP_A_SECOND_HALF_ID = WORLD_IDS.capturePoints.aSecondHalf;
const CP_B_SECOND_HALF_ID = WORLD_IDS.capturePoints.bSecondHalf;
const CP_C_SECOND_HALF_ID = WORLD_IDS.capturePoints.cSecondHalf;
const CP_D_SECOND_HALF_ID = WORLD_IDS.capturePoints.dSecondHalf;
const AUTHORED_FIRST_HALF_SECTOR_ID = WORLD_IDS.objectiveSectors.firstHalf;
const AUTHORED_SECOND_HALF_SECTOR_ID = WORLD_IDS.objectiveSectors.secondHalf;

// CapturePoints are enabled only as 3D objective markers. Their native capture
// progression is effectively locked because Cipher scoring is driven by the
// authored objective AreaTriggers, not CapturePoint enter/exit events.
const OBJECTIVE_CAPTURE_LOCKED_CAPTURE_TIME = 9999;
const OBJECTIVE_CAPTURE_LOCKED_NEUTRALIZE_TIME = 9999;

const FIRST_HALF_OBJECTIVE_CP_IDS: number[] = [CP_A_ID, CP_B_ID, CP_C_ID, CP_D_ID];
const SECOND_HALF_OBJECTIVE_CP_IDS: number[] = [
  CP_A_SECOND_HALF_ID,
  CP_B_SECOND_HALF_ID,
  CP_C_SECOND_HALF_ID,
  CP_D_SECOND_HALF_ID,
];
const ALL_OBJECTIVE_CP_IDS: number[] = FIRST_HALF_OBJECTIVE_CP_IDS.concat(SECOND_HALF_OBJECTIVE_CP_IDS);
const OBJECTIVE_LOGICAL_CP_ID_BY_SURFACE_CP_ID: { [cpId: number]: number | undefined } = {};
const ALL_SCRIPTED_OBJECTIVE_CP_IDS: number[] = ALL_OBJECTIVE_CP_IDS;
const OBJECTIVE_SURFACE_SECTOR_IDS: number[] = [
  AUTHORED_FIRST_HALF_SECTOR_ID,
  AUTHORED_SECOND_HALF_SECTOR_ID,
];

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
  lane: ObjectiveLetter;
  displayLane: ObjectiveLetter;
  half: RuntimeObjectiveHalf;
  side: CipherMapSide;
  sectorId: number;
  anchorId: number;
  defendingTeam: mod.Team;
  countsForRouting: boolean;
};

const OBJECTIVE_DEFINITIONS: ObjectiveDefinition[] = CIPHER_OBJECTIVE_CONFIGS.map((config) => ({
  cpId: config.cpId,
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
for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
  const def = OBJECTIVE_DEFINITIONS[i];
  objectiveDefByCpId[def.cpId] = def;
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
const TOP_HUD_LANES: TopHudLane[] = ["A", "B", "C", "D"];

/* Prematch InteractPoints (switch team + ready) */
const IP_T1_SWITCH = WORLD_IDS.interactPoints.team1Switch;
const IP_T1_READY = WORLD_IDS.interactPoints.team1Ready;
const IP_T2_SWITCH = WORLD_IDS.interactPoints.team2Switch;
const IP_T2_READY = WORLD_IDS.interactPoints.team2Ready;

/* Live spectator InteractPoint */
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
const WORLDICON_T1_SWITCH = WORLD_IDS.worldIcons.team1Switch;
const WORLDICON_T1_READY = WORLD_IDS.worldIcons.team1Ready;
const WORLDICON_T2_SWITCH = WORLD_IDS.worldIcons.team2Switch;
const WORLDICON_T2_READY = WORLD_IDS.worldIcons.team2Ready;

const RESTRICTED_AREA_TRIGGER = WORLD_IDS.areaTriggers.restricted;
const COMBAT_BOUNDARY_TRIGGER_ID = WORLD_IDS.areaTriggers.combatBoundary;
const PREMATCH_HEALTH_AREA_TRIGGER_ID = WORLD_IDS.areaTriggers.prematchHealth;
const PREMATCH_HEALTH_NORMAL_MAX = 100;
const PREMATCH_HEALTH_OUTSIDE_MAX = 100;
const PREMATCH_HEALTH_FULL_HEAL_AMOUNT = 9999;
const RESTRICTED_AREA_LETHAL_CONFIRM_DELAY_MS = 1;
const RESTRICTED_AREA_UI_ACTIVATION_DELAY_SECONDS = 0.66;
const RESTRICTED_AREA_TRIGGER_IDS: number[] = [
  RESTRICTED_AREA_TRIGGER,
];
const BOMB_LOOT_GADGET: mod.Gadgets = mod.Gadgets.Misc_PortalGadget;
const BOMB_ANCHOR_SECTOR_ID = BOMB_CONFIG.anchorSectorId;
const BOMB_ANCHOR_OBJECT_IDS = BOMB_CONFIG.anchorObjectIds;

type BombBaseSlotConfig = {
  anchorObjectId: number;
};

const BOMB_BASE_SLOT_CONFIGS: BombBaseSlotConfig[] = BOMB_ANCHOR_OBJECT_IDS.map((anchorObjectId) => ({
  anchorObjectId,
}));
const BOMB_DEFAULT_BASE_SLOT_INDEX = 0;
const BOMB_RUNTIME_LOOT_SPAWNER_ASSET: mod.RuntimeSpawn_Common = mod.RuntimeSpawn_Common.LootSpawner;
const BOMB_RUNTIME_LOOT_SPAWNER_SCALE = mod.CreateVector(1, 1, 1);
const BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS = BOMB_CONFIG.playerDroppedRelocationDelaySeconds;
const BOMB_PLAYER_DROPPED_EXPLOSION_RESPAWN_DELAY_SECONDS = BOMB_CONFIG.playerDroppedExplosionRespawnDelaySeconds;
const CIPHER_KEY_DELIVERY_RESPAWN_DELAY_SECONDS = BOMB_CONFIG.cipherKeyDeliveryRespawnDelaySeconds;
const BOMB_LIVE_START_INITIAL_SPAWN_DELAY_SECONDS = BOMB_CONFIG.liveStartInitialSpawnDelaySeconds;
const BOMB_DYNAMIC_RETRY_DELAY_SECONDS = BOMB_CONFIG.dynamicSpawnRetryDelaySeconds;
const BOMB_BASE_FIRST_PICKUP_RADIUS_METERS = 2;
const BOMB_DROPPED_RECLAIM_RADIUS_METERS = 2;
const BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS = 3;
const BOMB_DROP_WORLDICON_ASSET: mod.RuntimeSpawn_Common = mod.RuntimeSpawn_Common.WorldIcon;
const DROPPED_KEY_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK = "CIPHER KEY\n0{}:{}{}";
const DROPPED_KEY_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK = "CIPHER KEY\n{}:{}{}";
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
const BOMB_SPAWN_CONTEXT_DROPPED_PICKUP = "dropped_lootspawner";
const BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON = "dropped_worldicon";
const BOMB_CARRIER_INVENTORY_SLOT = mod.InventorySlots.GadgetOne;
const BOMB_DEPLOY_LOADOUT_SLOT_SETTLE_SECONDS = 0.1;
const BOMB_GADGET_ONE_RESTORE_INSERT_SETTLE_SECONDS = 0.5;
const DEBUG_BOMB_PICKUP = false;


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
const OBJECTIVE_AWARD_VFX_ID_BY_CP_ID = WORLD_IDS.objectiveVisuals.explosionVfxByCapturePoint;
const OBJECTIVE_ARMED_WORLDICON_ID_BY_CP_ID = WORLD_IDS.objectiveVisuals.worldIconByCapturePoint;
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_NAME = "FX_Car_Fire_M_GS";
const OBJECTIVE_AWARD_PERSISTENT_FIRE_PRIMARY_VFX_ID_BY_CP_ID =
  WORLD_IDS.objectiveVisuals.primaryVfxByCapturePoint;
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_NAME = "FX_CarFire_FrameCrawl";
const OBJECTIVE_AWARD_PERSISTENT_FIRE_SECONDARY_VFX_ID_BY_CP_ID =
  WORLD_IDS.objectiveVisuals.secondaryVfxByCapturePoint;
const OBJECTIVE_AWARD_BURST_LIFETIME_SECONDS = 4.0;
const OBJECTIVE_AWARD_BURST_ROTATION = mod.CreateVector(0, 0, 0);
const OBJECTIVE_DISABLE_EMP_HIT_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).FX_Gadget_ReconDrone_EMP_Hit;
const OBJECTIVE_DISABLE_3D_SFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).SFX_Gadgets_EIDOS_Disabled_OneShot3D;
const OBJECTIVE_DISABLE_UI_SFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).SFX_UI_Gauntlet_DataUpload_DataDepositPointDisable_OneShot2D;
const CIPHER_NODE_ACTIVE_FRIENDLY_VFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).FX_EODBot_Active_Friendly;
const CIPHER_NODE_ACTIVE_ENEMY_VFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).FX_EODBot_Active_Enemy;
const CIPHER_NODE_ACTIVE_SFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).SFX_GameModes_Gauntlet_Mission_Circuit_TerminalSpotLoop_SimpleLoop3D;
const CIPHER_NODE_REBOOT_SFX_ASSET: mod.RuntimeSpawn_Common =
  (mod.RuntimeSpawn_Common as any).SFX_GameModes_Gauntlet_Mission_Beacons_Beeping_SimpleLoop3D;
const CIPHER_NODE_LOOP_SFX_VOLUME = 0.45;
const CIPHER_NODE_LOOP_SFX_ATTENUATION_RANGE = 90;

// Rebooting node SFX only.
// Half volume and half distance from the old shared loop.
const CIPHER_NODE_REBOOT_LOOP_SFX_VOLUME = 0.225;
const CIPHER_NODE_REBOOT_LOOP_SFX_ATTENUATION_RANGE = 45;
const CIPHER_NODE_VISUAL_REASSERT_SECONDS = 4.0;

const CIPHER_NODE_POLYGON_CENTER_OFFSET_BY_CP_ID: { [cpId: number]: mod.Vector } = {
  [CP_A_ID]: mod.CreateVector(-0.0365, 3.4620, 0.0004),
  [CP_A_SECOND_HALF_ID]: mod.CreateVector(-0.0365, 3.4620, 0.0004),
  [CP_B_ID]: mod.CreateVector(-0.0415, 3.2407, 0.0320),
  [CP_B_SECOND_HALF_ID]: mod.CreateVector(-0.0415, 3.2407, 0.0320),
  [CP_C_ID]: mod.CreateVector(0.0330, 3.2889, -0.0321),
  [CP_C_SECOND_HALF_ID]: mod.CreateVector(0.0330, 3.2889, -0.0321),
  [CP_D_ID]: mod.CreateVector(0.0012, 3.3610, -0.0058),
  [CP_D_SECOND_HALF_ID]: mod.CreateVector(0.0012, 3.3610, -0.0058),
};

const CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID: { [cpId: number]: mod.Vector[] } = {
  [CP_A_ID]: [
    mod.CreateVector(-1.0398, 3.4620, -1.1122),
    mod.CreateVector(-1.4868, 3.4620, -0.0302),
    mod.CreateVector(-1.1752, 3.4620, 0.9222),
    mod.CreateVector(-0.1129, 3.4620, 1.4873),
    mod.CreateVector(0.9311, 3.4620, 1.1023),
    mod.CreateVector(1.45, 3.4620, 0.065),
    mod.CreateVector(1.1014, 3.4620, -0.945),
    mod.CreateVector(0.0399, 3.4620, -1.4866),
  ],
  [CP_B_ID]: [
    mod.CreateVector(1.0823, 3.2407, -0.9555),
    mod.CreateVector(0.0953, 3.2407, -1.4566),
    mod.CreateVector(-1.0488, 3.2407, -1.0701),
    mod.CreateVector(-1.4994, 3.2407, -0.0688),
    mod.CreateVector(-1.1839, 3.2407, 0.9789),
    mod.CreateVector(-0.0974, 3.2407, 1.4753),
    mod.CreateVector(0.8368, 3.2407, 1.215),
    mod.CreateVector(1.483, 3.2407, 0.1381),
  ],
  [CP_C_ID]: [
    mod.CreateVector(-0.8141, 3.2889, 0.9523),
    mod.CreateVector(-0.0242, 3.2889, 1.4507),
    mod.CreateVector(0.9971, 3.2889, 1.0897),
    mod.CreateVector(1.5256, 3.2889, -0.0067),
    mod.CreateVector(1.0708, 3.2889, -1.025),
    mod.CreateVector(-0.0362, 3.2889, -1.5179),
    mod.CreateVector(-1.0091, 3.2889, -1.1116),
    mod.CreateVector(-1.446, 3.2889, -0.0884),
  ],
  [CP_D_ID]: [
    mod.CreateVector(0.9712, 3.361, -1.1572),
    mod.CreateVector(-0.076, 3.361, -1.4937),
    mod.CreateVector(-1.1171, 3.361, -0.9252),
    mod.CreateVector(-1.4729, 3.361, 0.0175),
    mod.CreateVector(-1.0231, 3.361, 1.0436),
    mod.CreateVector(0.0651, 3.361, 1.4595),
    mod.CreateVector(1.1305, 3.361, 1.0657),
    mod.CreateVector(1.5322, 3.361, -0.0567),
  ],
};
CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_A_SECOND_HALF_ID] = CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_A_ID];
CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_B_SECOND_HALF_ID] = CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_B_ID];
CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_C_SECOND_HALF_ID] = CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_C_ID];
CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_D_SECOND_HALF_ID] = CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[CP_D_ID];

/* =================================================================================================
   4) FIXED LIVE HQ + CIPHER ANCHOR ROUTING
================================================================================================= */

/*
  Cairo HQ and anchor mapping.
  Fill arrays with the ObjIds you placed in Godot.
*/
// The selected route is owned by the upcoming session/life generation.
const CIPHER_SPAWN_ENEMY_DANGER_RADIUS_METERS = 18;
const CIPHER_RESPAWN_ROUTE_EVALUATION_SECONDS = SPAWN_ROUTING_CONFIG.routeEvaluationDurationSeconds;
const CIPHER_RESPAWN_ROUTE_TICK_SECONDS = SPAWN_ROUTING_CONFIG.routeEvaluationTickSeconds;
const CIPHER_RESPAWN_ROUTE_TICK_MS = mod.Max(1, CIPHER_RESPAWN_ROUTE_TICK_SECONDS * 1000);
const CIPHER_RESPAWN_POST_DEPLOY_DELAY_SECONDS = SPAWN_ROUTING_CONFIG.safeSpawnCheckDelaySeconds;
const CIPHER_RESPAWN_POST_DEPLOY_DELAY_TICKS = mod.Max(
  1,
  mod.Ceiling(CIPHER_RESPAWN_POST_DEPLOY_DELAY_SECONDS * TICK_RATE)
);
const CIPHER_RESPAWN_OBJECTIVE_PRESSURE_RADIUS_METERS = SPAWN_ROUTING_CONFIG.objectivePressureRadiusMeters;
const CIPHER_RESPAWN_CANDIDATE_SAFETY_RADIUS_METERS = SPAWN_ROUTING_CONFIG.queuedCandidateSafetyRadiusMeters;
const CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS = SPAWN_ROUTING_CONFIG.rerouteSafetyRadiusMeters;


const CIPHER_PRESENCE_TRIGGER_ZONE_BY_ID: { [triggerId: number]: CipherPresenceZone } = {
  [WORLD_IDS.presenceTriggers.northWest]: "northWest",
  [WORLD_IDS.presenceTriggers.northEast]: "northEast",
  [WORLD_IDS.presenceTriggers.southWest]: "southWest",
  [WORLD_IDS.presenceTriggers.southEast]: "southEast",
};
const CIPHER_NORTH_EAST_NORTH_ANCHORS = WORLD_IDS.respawnAnchors.northEastNorth;
const CIPHER_NORTH_EAST_SOUTH_ANCHORS = WORLD_IDS.respawnAnchors.northEastSouth;
const CIPHER_NORTH_WEST_NORTH_ANCHORS = WORLD_IDS.respawnAnchors.northWestNorth;
const CIPHER_NORTH_WEST_SOUTH_ANCHORS = WORLD_IDS.respawnAnchors.northWestSouth;
const CIPHER_SOUTH_EAST_NORTH_ANCHORS = WORLD_IDS.respawnAnchors.southEastNorth;
const CIPHER_SOUTH_EAST_SOUTH_ANCHORS = WORLD_IDS.respawnAnchors.southEastSouth;
const CIPHER_SOUTH_WEST_NORTH_ANCHORS = WORLD_IDS.respawnAnchors.southWestNorth;
const CIPHER_SOUTH_WEST_SOUTH_ANCHORS = WORLD_IDS.respawnAnchors.southWestSouth;
const CIPHER_FIRST_DEPLOY_NORTH_ANCHORS: number[] = WORLD_IDS.firstDeployAnchors.north;
const CIPHER_FIRST_DEPLOY_SOUTH_ANCHORS: number[] = WORLD_IDS.firstDeployAnchors.south;
const CIPHER_ANCHOR_COOLDOWN_SECONDS = 12;
const CIPHER_ANCHOR_ENEMY_SAFETY_RADIUS_METERS = CIPHER_SPAWN_ENEMY_DANGER_RADIUS_METERS;

type CipherQueuedSpawnAnchorKind = "dynamic" | "firstDeploy";
type CipherFirstDeployAnchorPhase = "half1" | "half2" | "suddenDeath";
type CipherVectorSnapshot = { x: number; y: number; z: number };
type CipherQueuedSpawnAnchor = {
  anchorObjectId: number;
  side: CipherMapSide;
  region: CipherSpawnRegion;
  kind: CipherQueuedSpawnAnchorKind;
  firstDeployPhase?: CipherFirstDeployAnchorPhase;
  firstDeploySessionToken?: number;
};
type CipherSpawnJobKind = "queue-anchor" | "teleport-deployed";
type CipherSpawnJob = {
  kind: CipherSpawnJobKind;
  playerId: number;
  createdAtSec: number;
  attempt: number;
  sessionToken: number | undefined;
  expectedGameStatus: number;
  expectedMatchStage: CipherMatchStage;
  expectedTransitionToken: number;
  lifeGeneration: number;
};
type CipherRespawnRouteStatus =
  | "evaluating"
  | "finalized"
  | "consumed"
  | "cancelled";
type CipherRespawnRouteJob = {
  token: number;
  playerId: number;
  teamId: number;
  startedAtSec: number;
  currentSecond: number;
  currentCandidate?: CipherQueuedSpawnAnchor;
  finalizedCandidate?: CipherQueuedSpawnAnchor;
  nextEvaluationAtSec: number;
  timerHandle?: number;
  dangerDetected: boolean;
  sessionToken: number | undefined;
  expectedMatchStage: CipherMatchStage;
  expectedHalf: CipherHalfIndex;
  lifeGeneration: number;
  status: CipherRespawnRouteStatus;
};
let cipherPresenceZoneActivePlayersByZone: { [zone: string]: { [playerId: number]: number } } = {};
let cipherPresenceZonesByPlayerId: { [playerId: number]: { [zone: string]: boolean } } = {};
let cipherAnchorPositionByObjectId: { [objectId: number]: CipherVectorSnapshot | undefined } = {};
let cipherObjectiveAnchorPositionByCpId: { [cpId: number]: CipherVectorSnapshot | undefined } = {};
let cipherObjectiveAnchorPositionSnapshotByCpId: { [cpId: number]: CipherVectorSnapshot | undefined } = {};
let cipherPlayerPositionSnapshotByPlayerId: { [playerId: number]: CipherVectorSnapshot | undefined } = {};
let cipherAnchorCooldownUntilSecByObjectId: { [objectId: number]: number } = {};
let cipherAnchorRoundRobinIndexByKey: { [key: string]: number } = {};
let cipherSpawnRegionTieFlipByKey: { [key: string]: number } = {};
let cipherLastSpawnRegionByTeamId: { [teamId: string]: CipherSpawnRegion | undefined } = {};
let cipherLastSpawnRegionAtSecByTeamId: { [teamId: string]: number | undefined } = {};
let cipherQueuedAnchorByPlayerId: { [playerId: number]: CipherQueuedSpawnAnchor | undefined } = {};
let cipherFirstDeployAnchorSessionToken = 0;
let cipherFirstDeployAnchorActive = false;
let cipherFirstDeployAnchorPhase: CipherFirstDeployAnchorPhase = "half1";
let cipherFirstDeployAnchorAssignedByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherFirstDeployAnchorRoundRobinBySide: { [side: string]: number } = {};
let cipherPendingSpawnJobs: CipherSpawnJob[] = [];
let cipherUrgentSpawnJobs: CipherSpawnJob[] = [];
let cipherRespawnRouteJobByPlayerId: { [playerId: number]: CipherRespawnRouteJob | undefined } = {};
const cipherRespawnRouteTokenByPlayerId: { [playerId: number]: number } = {};
const CIPHER_SPAWN_JOBS_PER_TICK = 4;
const CIPHER_TRANSITION_SPAWN_JOBS_PER_TICK = 1;
const CIPHER_SPAWN_RETRY_WINDOW_SECONDS = 0.75;
const CIPHER_TRANSITION_SPAWN_RETRY_WINDOW_SECONDS = 2.0;
/* Squad-spawn bypass probing */
const SQUAD_SPAWN_DISTANCE = 8;
const SQUAD_SPAWN_BYPASS_LIFETIME_SECONDS = SPAWN_ROUTING_CONFIG.squadSpawnBypassLifetimeSeconds;

let squadSpawnBypass: { [playerId: number]: boolean } = {};


function getObjectiveDef(cpId: number): ObjectiveDefinition | undefined {
  return objectiveDefByCpId[cpId];
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
type CipherNodeVisualMode = "none" | "active" | "rebooting";
let cipherNodeActiveVfxByCpId: { [cpId: number]: Array<mod.VFX | mod.Object> | undefined } = {};
let cipherNodeRebootVfxByCpId: { [cpId: number]: Array<mod.VFX | mod.Object> | undefined } = {};
let cipherNodeLoopSfxSourceByCpId: { [cpId: number]: RuntimeSfxSourceSpawnValidation | undefined } = {};
let cipherNodeLoopSfxHandleByCpId: { [cpId: number]: mod.SFX | undefined } = {};
let cipherNodeVisualModeByCpId: { [cpId: number]: CipherNodeVisualMode | undefined } = {};
let cipherNodeVisualLastReassertAtSecByCpId: { [cpId: number]: number | undefined } = {};
let objectiveArmedWorldIconMissingWarnedByCpId: { [cpId: number]: boolean } = {};
let objectiveArmedWorldIconLastShownSecondsByCpId: { [cpId: number]: number | undefined } = {};
let objectiveCapturePointObjectiveEnabledByCpId: { [cpId: number]: boolean | undefined } = {};
let objectiveSurfaceSectorObjectiveEnabledBySectorId: { [sectorId: number]: boolean | undefined } = {};
let objectiveSurfaceSyncInProgress = false;
let objectiveSurfaceSyncQueued = false;
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
  | "combatHold"
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
let bombStaticLootSpawnerInitialPosition: mod.Vector | undefined = undefined;
let bombBasePickupEnabled = false;
let bombBaseRuntimeLootSpawnerObject: mod.Object | undefined = undefined;
let bombBaseRuntimeLootSpawnerHandle: mod.LootSpawner | undefined = undefined;
let bombBaseRuntimeLootSpawnerObjectId: number | undefined = undefined;
let bombBaseRuntimeWorldIconObject: mod.Object | undefined = undefined;
let bombBaseRuntimeWorldIconHandle: mod.WorldIcon | undefined = undefined;
let bombActiveBaseSlotIndex = BOMB_DEFAULT_BASE_SLOT_INDEX;
let bombBaseCachedPosition: mod.Vector | undefined = undefined;
let bombBaseLandingAnchorPosition: mod.Vector | undefined = undefined;
let bombDroppedRuntimeLootSpawnerObject: mod.Object | undefined = undefined;
let bombDroppedRuntimeLootSpawnerHandle: mod.LootSpawner | undefined = undefined;
let bombDroppedWorldIconObject: mod.Object | undefined = undefined;
let bombDroppedWorldIconHandle: mod.WorldIcon | undefined = undefined;

// Native minimap-only bomb proxy. This does not change Cipher key logic.
// It exists only to use the native Bomb runtime object/minimap marker while our custom carrier/drop/deliver code remains authoritative.
// Native Bomb bridge: use the real Bomb object as the visible/carryable objective proxy.
// The existing Cipher scoring/drop/delivery state remains authoritative, but the native Bomb
// is spawned/given/dropped alongside it so the engine HUD/minimap behavior works properly.
const CIPHER_NATIVE_MINIMAP_BOMB_Y_OFFSET_METERS = 0;
const CIPHER_NATIVE_MINIMAP_BOMB_ROTATION = mod.CreateVector(0, 0, 0);
const CIPHER_NATIVE_BOMB_ENEMY_VISIBLE_SECONDS = 2.0;
const CIPHER_NATIVE_BOMB_ENEMY_HIDDEN_SECONDS = 2.0;
const CIPHER_NATIVE_BOMB_CARRIER_RESYNC_SECONDS = 0.75;
let cipherNativeMinimapBombObject: mod.Object | undefined = undefined;
let cipherNativeMinimapBombHandle: any | undefined = undefined;
type CipherNativeBombLifetime = "absent" | "active" | "destroying";
let cipherNativeMinimapBombGeneration = 0;
let cipherNativeMinimapBombLifetime: CipherNativeBombLifetime = "absent";
let cipherNativeMinimapBombLastPos: mod.Vector | undefined = undefined;
let cipherNativeMinimapBombWarnedUnavailable = false;
let cipherNativeMinimapBombCarrierPlayerId: number | undefined = undefined;
let cipherNativeMinimapBombCarrierTeamId = 0;
let cipherNativeMinimapBombLastGiveAtSec = -999999;
let cipherNativeMinimapBombLastGlobalVisible: boolean | undefined = undefined;
let cipherNativeBombCarrierBindToken = 0;
let cipherNativeBombVisibilityPulseStartedAtSec = 0;
let cipherNativeBombVisibilityPulseCarrierPlayerId: number | undefined = undefined;
let cipherNativeBombVisibilityPulseLastPhase = -1;
let cipherNativeBombVisibilityLastApplyAtSec = -999999;
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
type CipherEventBannerTone = "friendly" | "enemy" | "neutral";
type CipherEventBannerKind = "center" | "dropped";

let bombNoticeToken = 0;
let bombNoticeVisibleUntilSec = 0;
let bombNoticeMessageKey: any = undefined;
let bombNoticeFallbackText = "BOMB HAS BEEN DROPPED";
let bombNoticeMessageKeyByPlayerId: { [playerId: number]: any } = {};
let bombNoticeFallbackTextByPlayerId: { [playerId: number]: string | undefined } = {};
let bombNoticeDetailMessageByPlayerId: { [playerId: number]: any } = {};
let bombNoticeToneByPlayerId: { [playerId: number]: CipherEventBannerTone | undefined } = {};
let bombNoticeKindByPlayerId: { [playerId: number]: CipherEventBannerKind | undefined } = {};
let bombNoticeVisibleUntilSecByPlayerId: { [playerId: number]: number | undefined } = {};
let bombNoticeTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let bombCarrierUiStateVersion = 0;
let bombDroppedPickupAnchorPosition: mod.Vector | undefined = undefined;
let bombDroppedLastCarrierPlayerId: number | undefined = undefined;
let bombDroppedLastCarrierBlockedUntilSec = 0;
let bombDroppedReclaimBlockedUntilSec = 0;
let bombDroppedSourceKind: BombDroppedSourceKind = "none";
let bombReturnToBaseToken = 0;
let bombDroppedReturnDeadlineAtSec = 0;
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
let botLiveSpawnRequestedByPlayerId: { [playerId: number]: boolean | undefined } = {};
let botLiveSpawnNextAttemptAtSecByPlayerId: { [playerId: number]: number | undefined } = {};
let botBackfillKnownByPlayerId: { [playerId: number]: boolean | undefined } = {};
let runtimeBotStagedSpawnNextTick = 0;
let runtimeBotNextReconcileAtSec = 0;
let runtimeBotReleasedPlayerId: { [playerId: number]: boolean | undefined } = {};
let runtimeBotRespawnAfterSecByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherRuntimeBotsEnabled = CIPHER_RUNTIME_BOTS_DEFAULT_ENABLED;
let cipherTransitionReconcileQueued = false;
let cipherTransitionReconcileReason = "";
let cipherLiveStartSettlingUntilSec = 0;
let cipherLiveStartSettlingStage: CipherMatchStage | "none" = "none";
let cipherLiveStartSettleToken = 0;
let visualSubtickLastOutputSec = 0;
let visualSubtickLastPreferredSec = -1;
let visualSubtickLastPreferredFloorSec = -1;
let visualSubtickPreferredFloorTick = 0;
let visualSubtickEstimatedHz: number = TICK_RATE;
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
let bombBaseBeepLoopMissingWarned = false;
let bombDroppedBeepLoopMissingWarned = false;
let bombCarrierBeepLoopMissingWarned = false;
let objectiveLastSuccessfulArmPositionByCpId: { [cpId: number]: mod.Vector | undefined } = {};
let objectiveLastSuccessfulArmerPlayerIdByCpId: { [cpId: number]: number | undefined } = {};

function logBombPickupDebug(message: any): void {
  void message;
}

function shouldEmitStringKeyDebugWorldLogs(): boolean {
  return ENABLE_STRINGKEY_DEBUG_WORLD_LOGS;
}

function emitStringKeyDebugWorldLog(message: any): void {
  void message;
}

function emitLiveTransitionCheckpoint(_step: string): void {
  // Disabled in production builds; this previously emitted visible world-log debug messages.
}

function emitObjectiveNativeEventFlow(message: any): void {
  void message;
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
    mod.UnspawnObject(resolved.object!);
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
      position: mod.GetObjectPosition(resolved.object!),
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

function getBombBaseSlotConfig(slotIndex: number): BombBaseSlotConfig | undefined {
  if (slotIndex < 0 || slotIndex >= BOMB_BASE_SLOT_CONFIGS.length) return undefined;
  return BOMB_BASE_SLOT_CONFIGS[slotIndex];
}

function getBombBaseSlotIndexOrDefault(slotIndex: number): number {
  if (slotIndex >= 0 && slotIndex < BOMB_BASE_SLOT_CONFIGS.length) return slotIndex;
  return BOMB_DEFAULT_BASE_SLOT_INDEX;
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

function moveObjectToAbsolutePositionSafe(targetObject: mod.Object, targetPosition: mod.Vector, _context: string): boolean {
  try {
    const currentPosition = mod.GetObjectPosition(targetObject);
    const delta = mod.Subtract(targetPosition, currentPosition);
    mod.MoveObject(targetObject, delta);
    return true;
  } catch (_err) {
    return false;
  }
}

function cacheBombPickupWorldAnchorPositions(): void {
  if (!bombStaticLootSpawnerInitialPosition) {
    bombStaticLootSpawnerInitialPosition = bombBaseLandingAnchorPosition ?? bombBaseCachedPosition;
  }

  const fallbackPos =
    bombBaseLandingAnchorPosition ??
    bombBaseCachedPosition ??
    bombStaticLootSpawnerInitialPosition;
  if (fallbackPos) {
    if (!bombBaseCachedPosition) bombBaseCachedPosition = fallbackPos;
  }
}

function setBombBasePickupEnabled(enabled: boolean): void {
  bombBasePickupEnabled = enabled;
}

function setBombBasePickupPosition(targetPosition: mod.Vector, enableAfterMove: boolean): boolean {
  bombBaseCachedPosition = targetPosition;
  setBombBasePickupEnabled(enableAfterMove);
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
  void message;
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
  if (minutes < 10) return mod.Message(singleDigitKey, minutes, seconds10, seconds1);
  return mod.Message(doubleDigitKey, minutes, seconds10, seconds1);
}

function formatDroppedKeyWorldIconTimerLabel(totalSeconds: number): any {
  let safeSeconds = totalSeconds;
  if (!Number.isFinite(safeSeconds) || safeSeconds < 0) safeSeconds = 0;
  safeSeconds = mod.Floor(safeSeconds);
  const minutes = mod.Floor(safeSeconds / 60);
  const totalSecondsRemainder = mod.Floor(safeSeconds % 60);
  const seconds1 = totalSecondsRemainder % 10;
  const seconds10 = mod.Floor(totalSecondsRemainder / 10);
  if (minutes < 10) {
    return mod.Message(DROPPED_KEY_WORLDICON_TIMER_SINGLE_DIGIT_MINUTE_FALLBACK, minutes, seconds10, seconds1);
  }
  return mod.Message(DROPPED_KEY_WORLDICON_TIMER_DOUBLE_DIGIT_MINUTE_FALLBACK, minutes, seconds10, seconds1);
}

function clearNextKeyUnlockRuntimeWorldIcon(_context: string): void {
  if (nextKeyUnlockWorldIconHandle) {
    try { mod.EnableWorldIconText(nextKeyUnlockWorldIconHandle!, false); } catch (_errText) {}
    try { mod.EnableWorldIconImage(nextKeyUnlockWorldIconHandle!, false); } catch (_errImage) {}
  }

  if (nextKeyUnlockWorldIconObject) {
    unspawnObjectSafe(nextKeyUnlockWorldIconObject, "next key unlock world icon", false);
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
    mod.SetWorldIconOwner(icon, teamNeutral);
    mod.SetWorldIconColor(icon, COLOR_NEUTRAL);
    mod.SetWorldIconText(icon, formatNextKeyWorldIconTimerLabel(remainingSeconds, nextKeyUnlockLabelMode));
    mod.EnableWorldIconImage(icon, false);
    mod.EnableWorldIconText(icon, true);
    return true;
  } catch (err) {
    if (!nextKeyUnlockWorldIconMissingWarned) {
      nextKeyUnlockWorldIconMissingWarned = true;
      LogRuntimeError("NextKeyUnlockWorldIcon/configure", err);
    }
    return false;
  }
}

function spawnOrUpdateNextKeyUnlockWorldIcon(remainingSeconds: number, force: boolean = false): void {
  if (!nextKeyUnlockAnchorPosition) return;
  const iconPos = mod.Add(nextKeyUnlockAnchorPosition!, NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET);

  if (nextKeyUnlockWorldIconHandle && !force) {
    if (nextKeyUnlockWorldIconLastShownSeconds !== remainingSeconds) {
      configureNextKeyUnlockWorldIcon(nextKeyUnlockWorldIconHandle, iconPos, remainingSeconds);
      nextKeyUnlockWorldIconLastShownSeconds = remainingSeconds;
    }
    return;
  }

  if (nextKeyUnlockWorldIconHandle && force) {
    clearNextKeyUnlockRuntimeWorldIcon("force_rebuild");
  }

  try {
    const spawned = mod.SpawnObject(
      mod.RuntimeSpawn_Common.WorldIcon,
      iconPos,
      mod.CreateVector(0, 0, 0)
    ) as unknown;
    const resolved = resolveObjectFromUnknown(spawned);
    nextKeyUnlockWorldIconObject = resolved.object;
    try {
      nextKeyUnlockWorldIconHandle = mod.GetWorldIcon(resolved.objId);
    } catch (_errGetIcon) {
      nextKeyUnlockWorldIconHandle = spawned as mod.WorldIcon;
    }
    if (!nextKeyUnlockWorldIconHandle) return;
    if (configureNextKeyUnlockWorldIcon(nextKeyUnlockWorldIconHandle, iconPos, remainingSeconds)) {
      nextKeyUnlockWorldIconLastShownSeconds = remainingSeconds;
    }
  } catch (err) {
    if (!nextKeyUnlockWorldIconMissingWarned) {
      nextKeyUnlockWorldIconMissingWarned = true;
      LogRuntimeError("NextKeyUnlockWorldIcon/spawn", err);
    }
  }
}


function setAllBaseWorldIconsEnabled(enabled: boolean): void {
  if (bombBaseRuntimeWorldIconHandle) {
    try {
      mod.EnableWorldIconImage(bombBaseRuntimeWorldIconHandle!, enabled);
      mod.EnableWorldIconText(bombBaseRuntimeWorldIconHandle!, enabled);
    } catch (_err) {}
  }
}


function configureBombWorldIconSafe(icon: mod.WorldIcon, enableImage: boolean): boolean {
  const droppedPos = tryResolveDroppedBombAnchorPosition();
  const basePos = droppedPos ? undefined : resolveBaseBombAudioAnchorPosition();
  const sourcePos = droppedPos ?? basePos;
  if (!sourcePos) return false;

  const iconPos = mod.Add(sourcePos, droppedPos ? DROPPED_KEY_WORLD_ICON_OFFSET : NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET);
  try {
    mod.SetWorldIconPosition(icon, iconPos);
    mod.SetWorldIconOwner(icon, teamNeutral);
    // Text-only key world icon.
    // Do not set the bomb/key image.
    mod.SetWorldIconColor(icon, droppedPos ? COLOR_FRIENDLY : COLOR_NEUTRAL);
    if (droppedPos && bombDroppedReturnDeadlineAtSec > 0) {
      const remainingSeconds = mod.Max(0, mod.Ceiling(bombDroppedReturnDeadlineAtSec - getCurrentSchedulerNowSeconds()));
      mod.SetWorldIconText(icon, formatDroppedKeyWorldIconTimerLabel(remainingSeconds));
    } else {
      mod.SetWorldIconText(icon, getStringMessageWithFallback((mod.stringkeys as any).BOMB, "CIPHER KEY"));
    }
    mod.EnableWorldIconImage(icon, false);
    mod.EnableWorldIconText(icon, true);
    return true;
  } catch (err) {
    warnBombDropRuntimeWorldIconMissingOnce("configure failed");
    LogRuntimeError("BombWorldIcon/configure", err);
    return false;
  }
}

function clearBombBaseRuntimeWorldIcon(): void {
  if (bombBaseRuntimeWorldIconHandle) {
    try {
      mod.EnableWorldIconText(bombBaseRuntimeWorldIconHandle!, false);
      mod.EnableWorldIconImage(bombBaseRuntimeWorldIconHandle!, false);
    } catch (_err) {}
  }
  if (bombBaseRuntimeWorldIconObject) {
    unspawnObjectSafe(bombBaseRuntimeWorldIconObject, "base world icon object", false);
  }
  // Do not try to unspawn a WorldIcon handle as an Object. Some Portal runtime icon
  // handles cannot be resolved back to SpatialObject safely; disabling + clearing is enough.
  bombBaseRuntimeWorldIconObject = undefined;
  bombBaseRuntimeWorldIconHandle = undefined;
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


function ensureDroppedBombRuntimeWorldIconVisibleIfNeeded(): void {
  if (gameStatus !== 3) return;
  const anchorPos = tryResolveDroppedBombAnchorPosition();
  if (!anchorPos || bombCarrierPlayerId !== undefined) return;
  if (!hasDroppedBombRuntimeObjects()) return;

  const remainingSeconds =
    bombDroppedReturnDeadlineAtSec > 0
      ? mod.Max(0, mod.Ceiling(bombDroppedReturnDeadlineAtSec - getCurrentSchedulerNowSeconds()))
      : BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS;
  const iconPos = mod.Add(anchorPos, DROPPED_KEY_WORLD_ICON_OFFSET);

  if (!bombDroppedWorldIconHandle) {
    const spawned = spawnRuntimeCommonObjectSafe(
      BOMB_DROP_WORLDICON_ASSET,
      iconPos,
      BOMB_DROP_ROTATION,
      BOMB_SPAWN_CONTEXT_DROPPED_WORLDICON
    );
    bombDroppedWorldIconObject = spawned.object;
    if (spawned.object) {
      bombDroppedWorldIconHandle = resolveRuntimeWorldIconHandle(spawned.object as unknown);
    }
    if (!bombDroppedWorldIconHandle) {
      warnBombDropRuntimeWorldIconMissingOnce("ensure resolve failed");
      return;
    }
  } else if (bombDroppedWorldIconObject) {
    moveObjectToAbsolutePositionSafe(bombDroppedWorldIconObject, iconPos, "dropped_worldicon_move");
  }

  try {
    mod.SetWorldIconPosition(bombDroppedWorldIconHandle!, iconPos);
    mod.SetWorldIconOwner(bombDroppedWorldIconHandle!, teamNeutral);
    mod.SetWorldIconColor(bombDroppedWorldIconHandle!, COLOR_FRIENDLY);
    mod.SetWorldIconText(bombDroppedWorldIconHandle!, formatDroppedKeyWorldIconTimerLabel(remainingSeconds));
    mod.EnableWorldIconImage(bombDroppedWorldIconHandle!, false);
    mod.EnableWorldIconText(bombDroppedWorldIconHandle!, true);
    bombDroppedWorldIconLastShownSeconds = remainingSeconds;
  } catch (_err) {
    bombDroppedWorldIconHandle = undefined;
    bombDroppedWorldIconLastShownSeconds = -1;
    warnBombDropRuntimeWorldIconMissingOnce("ensure configure failed");
  }
}


function hasBaseBombAuthorityOrPending(): boolean {
  return (
    bombBasePickupEnabled ||
    bombBaseRuntimeLootSpawnerObject !== undefined ||
    bombBaseRuntimeLootSpawnerHandle !== undefined
  );
}

function spawnOrReassertBaseBombRuntimeWorldIcon(anchorPos: mod.Vector, enableImage: boolean): boolean {
  const iconPos = mod.Add(anchorPos, NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET);
  if (!bombBaseRuntimeWorldIconHandle) {
    const spawned = spawnRuntimeCommonObjectSafe(
      BOMB_DROP_WORLDICON_ASSET,
      iconPos,
      BOMB_DROP_ROTATION,
      "base_bomb_worldicon"
    );
    bombBaseRuntimeWorldIconObject = spawned.object;
    if (spawned.object) {
      bombBaseRuntimeWorldIconHandle = resolveRuntimeWorldIconHandle(spawned.object as unknown);
    }
    if (!bombBaseRuntimeWorldIconHandle) {
      warnBombBasePositionResolveFailureOnce("base world icon resolve failed");
      return false;
    }
  } else if (bombBaseRuntimeWorldIconObject) {
    moveObjectToAbsolutePositionSafe(bombBaseRuntimeWorldIconObject, iconPos, "base_worldicon_move");
  }

  return configureBombWorldIconSafe(bombBaseRuntimeWorldIconHandle, enableImage);
}

function ensureBaseBombRuntimeWorldIconVisibleIfNeeded(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined || hasDroppedBombRuntimeObjects()) return;
  if (!hasBaseBombAuthorityOrPending()) return;
  const basePos = resolveBaseBombAudioAnchorPosition();
  if (!basePos) return;
  spawnOrReassertBaseBombRuntimeWorldIcon(basePos, bombBasePickupEnabled);
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
  spawnOrReassertBaseBombRuntimeWorldIcon(basePos, bombBasePickupEnabled);
  spawnOrMoveCipherNativeMinimapBomb(basePos, "base_available");
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
  bombDroppedReclaimBlockedUntilSec = 0;
  bombDroppedSourceKind = "none";
}

function clearDroppedBombRuntimeObjects(): void {
  clearBombDroppedBeepLoop();
  clearBombDroppedRuntimeLootSpawner();
  bombDroppedReturnDeadlineAtSec = 0;
  bombDroppedWorldIconLastShownSeconds = -1;

  // Detach the generation's references before touching the engine. Cleanup can
  // re-enter through native callbacks, and a second pass must see no live icon.
  const worldIconHandle = bombDroppedWorldIconHandle;
  const worldIconObject = bombDroppedWorldIconObject;
  bombDroppedWorldIconObject = undefined;
  bombDroppedWorldIconHandle = undefined;

  if (worldIconHandle) {
    try {
      mod.EnableWorldIconText(worldIconHandle, false);
    } catch (_errText) {}
    try {
      mod.EnableWorldIconImage(worldIconHandle, false);
    } catch (_err) {}
  }

  if (worldIconObject) {
    unspawnObjectSafe(worldIconObject, "dropped world icon object", false);
  }
  // Same safety rule as base icon: never unspawn a raw WorldIcon handle as an Object.
  if (bombCarrierPlayerId === undefined) {
    clearCipherNativeMinimapBomb("clear_dropped_runtime");
  }
  clearDroppedBombAnchorReclaimState();
}

function getCipherNativeMinimapBombAsset(): any {
  try {
    return (mod.RuntimeSpawn_Common as any).Bomb;
  } catch (_err) {
    return undefined;
  }
}

function getCipherNativeMinimapBombPosition(sourcePos: mod.Vector | undefined): mod.Vector | undefined {
  if (!sourcePos) return undefined;
  try {
    return mod.CreateVector(
      mod.XComponentOf(sourcePos),
      mod.YComponentOf(sourcePos) + CIPHER_NATIVE_MINIMAP_BOMB_Y_OFFSET_METERS,
      mod.ZComponentOf(sourcePos)
    );
  } catch (_err) {
    return undefined;
  }
}

function trySetNativeBombTeam(team: mod.Team, context: string): void {
  if (cipherNativeMinimapBombLifetime !== "active") return;
  if (!cipherNativeMinimapBombHandle) return;
  try {
    (mod as any).SetBombTeam(cipherNativeMinimapBombHandle, team);
    cipherNativeMinimapBombCarrierTeamId = mod.GetObjId(team);
  } catch (err) {
    LogRuntimeError("NativeBomb/setTeam/" + context, err);
  }
}

function trySetNativeBombGlobalVisibility(visible: boolean, context: string, force: boolean = false): void {
  if (cipherNativeMinimapBombLifetime !== "active") return;
  if (!cipherNativeMinimapBombHandle) return;
  if (!force && cipherNativeMinimapBombLastGlobalVisible === visible) return;
  try {
    (mod as any).SetBombWorldIconGlobalVisibility(cipherNativeMinimapBombHandle, visible);
    cipherNativeMinimapBombLastGlobalVisible = visible;
  } catch (err) {
    LogRuntimeError("NativeBomb/globalVisibility/" + context, err);
  }
}

function configureCipherNativeBombAfterSpawn(ownerTeam: mod.Team, context: string): void {
  if (cipherNativeMinimapBombLifetime !== "active") return;
  if (!cipherNativeMinimapBombHandle) return;

  try {
    (mod as any).SetBombDropFuseTime(cipherNativeMinimapBombHandle, 9999);
  } catch (_errFuse) {}

  trySetNativeBombTeam(ownerTeam, context);
  trySetNativeBombGlobalVisibility(true, context + "_spawn_visible");

  try {
    (mod as any).ForceBombSpawn(cipherNativeMinimapBombHandle);
  } catch (_errSpawn) {
    // Runtime-spawned Bomb objects usually appear immediately; ForceBombSpawn is best-effort.
  }
}

function forceReleaseCipherNativeBombCarrier(context: string): void {
  if (cipherNativeMinimapBombLifetime !== "active") return;
  if (!cipherNativeMinimapBombHandle) return;

  try {
    (mod as any).ForceBombDrop(cipherNativeMinimapBombHandle);
  } catch (_errDrop) {
    // ForceBombDrop only succeeds when the native bomb is actually carried.
    // Ignore failures because the bomb may already be on the ground/unspawned.
  }

  cipherNativeMinimapBombCarrierPlayerId = undefined;
  cipherNativeMinimapBombLastGiveAtSec = -999999;
  resetCipherNativeBombCarrierVisibilityPulse(undefined, getCurrentSchedulerNowSeconds(), context + "_release");
}

function removeCipherNativeBombCarrierState(context: string): void {
  forceReleaseCipherNativeBombCarrier(context);

  // Preserve the proven legacy cleanup sequence. ForceBombDrop alone can leave
  // the native Bomb marker attached to the last carrier transform after death or
  // delivery, so explicitly unspawn the native Bomb before the runtime object is
  // cleared below.
  if (cipherNativeMinimapBombHandle) {
    try {
      (mod as any).ForceBombUnspawn(cipherNativeMinimapBombHandle);
    } catch (_errForceUnspawn) {}
  }

  cipherNativeMinimapBombCarrierPlayerId = undefined;
  cipherNativeMinimapBombLastGiveAtSec = -999999;
  cipherNativeMinimapBombLastGlobalVisible = undefined;
}

function clearCipherNativeMinimapBomb(context: string): void {
  if (cipherNativeMinimapBombLifetime === "destroying") return;
  if (!cipherNativeMinimapBombHandle && !cipherNativeMinimapBombObject) {
    cipherNativeMinimapBombLifetime = "absent";
    return;
  }

  const generation = cipherNativeMinimapBombGeneration;
  const handle = cipherNativeMinimapBombHandle;
  const object = cipherNativeMinimapBombObject;

  // The old working mode intentionally used both native cleanup layers. The
  // first ForceBombUnspawn detaches the carrier/minimap state, the repeated
  // ForceBombUnspawn flushes any delayed native Bomb state, and UnspawnObject
  // removes the runtime-spawned object itself. Treating these as alternatives
  // allowed a stale carrier marker to remain at a death or delivery position.
  removeCipherNativeBombCarrierState(context);

  if (handle) {
    try {
      (mod as any).ForceBombUnspawn(handle);
    } catch (_errForceUnspawn) {}
  }

  if (object) {
    try {
      mod.UnspawnObject(object);
    } catch (err) {
      LogRuntimeError("NativeBomb/clear/object/" + context, err);
    }
  } else if (handle) {
    try {
      mod.UnspawnObject(handle as mod.Object);
    } catch (_errUnspawnHandle) {}
  }

  // Detach script references only after both native cleanup paths have run.
  cipherNativeMinimapBombLifetime = "destroying";
  cipherNativeMinimapBombObject = undefined;
  cipherNativeMinimapBombHandle = undefined;
  cipherNativeMinimapBombLastPos = undefined;
  cipherNativeMinimapBombCarrierPlayerId = undefined;
  cipherNativeMinimapBombCarrierTeamId = 0;
  cipherNativeMinimapBombLastGiveAtSec = -999999;
  cipherNativeMinimapBombLastGlobalVisible = undefined;

  if (cipherNativeMinimapBombGeneration === generation) {
    cipherNativeMinimapBombLifetime = "absent";
  }
}

function spawnCipherNativeBombAtPosition(pos: mod.Vector, ownerTeam: mod.Team, context: string): void {
  const asset = getCipherNativeMinimapBombAsset();
  if (asset === undefined || asset === null) {
    if (!cipherNativeMinimapBombWarnedUnavailable) {
      cipherNativeMinimapBombWarnedUnavailable = true;
      LogRuntimeError("NativeBomb/asset", "RuntimeSpawn_Common.Bomb is not available in this API package");
    }
    return;
  }

  clearCipherNativeMinimapBomb(context + "_respawn_clear");

  try {
    const spawned = mod.SpawnObject(asset, pos, CIPHER_NATIVE_MINIMAP_BOMB_ROTATION) as unknown;
    const resolved = resolveObjectFromUnknown(spawned);
    cipherNativeMinimapBombGeneration += 1;
    cipherNativeMinimapBombHandle = spawned;
    cipherNativeMinimapBombObject = resolved.object;
    cipherNativeMinimapBombLifetime = "active";
    cipherNativeMinimapBombLastPos = pos;
    cipherNativeMinimapBombCarrierPlayerId = undefined;
    configureCipherNativeBombAfterSpawn(ownerTeam, context);
  } catch (err) {
    LogRuntimeError("NativeBomb/spawn/" + context, err);
    cipherNativeMinimapBombHandle = undefined;
    cipherNativeMinimapBombObject = undefined;
    cipherNativeMinimapBombLifetime = "absent";
    cipherNativeMinimapBombLastPos = undefined;
  }
}

function moveCipherNativeMinimapBombToPosition(pos: mod.Vector, context: string): void {
  if (cipherNativeMinimapBombLifetime !== "active") return;
  if (!cipherNativeMinimapBombHandle && !cipherNativeMinimapBombObject) return;

  const generation = cipherNativeMinimapBombGeneration;

  if (cipherNativeMinimapBombObject) {
    try {
      if (cipherNativeMinimapBombLastPos) {
        const delta = mod.Subtract(pos, cipherNativeMinimapBombLastPos!);
        mod.MoveObject(cipherNativeMinimapBombObject!, delta);
      } else {
        const current = mod.GetObjectPosition(cipherNativeMinimapBombObject!);
        mod.MoveObject(cipherNativeMinimapBombObject!, mod.Subtract(pos, current));
      }
      if (
        cipherNativeMinimapBombLifetime !== "active" ||
        cipherNativeMinimapBombGeneration !== generation
      ) return;
      cipherNativeMinimapBombLastPos = pos;
      cipherNativeMinimapBombCarrierPlayerId = undefined;
      return;
    } catch (err) {
      LogRuntimeError("NativeBomb/move/" + context, err);
    }
  }

  // If the native Bomb handle cannot be moved as a SpatialObject, respawn it at the new anchor/drop position.
  spawnCipherNativeBombAtPosition(pos, getNativeBombCurrentOwnerTeam(), context + "_respawn_move_fallback");
}

function getNativeBombCurrentOwnerTeam(): mod.Team {
  if (bombCarrierPlayerId !== undefined) {
    const carrier = serverPlayers.get(bombCarrierPlayerId);
    if (carrier) {
      const carrierTeam = getCipherKeyTeamSnapshot(carrier.id) ?? carrier.team;
      if (mod.Equals(carrierTeam, team1) || mod.Equals(carrierTeam, team2)) return carrierTeam;
    }
  }

  if (bombDroppedLastCarrierPlayerId !== undefined) {
    const lastCarrier = serverPlayers.get(bombDroppedLastCarrierPlayerId);
    if (lastCarrier) {
      const lastCarrierTeam = getCipherKeyTeamSnapshot(lastCarrier.id) ?? lastCarrier.team;
      if (mod.Equals(lastCarrierTeam, team1) || mod.Equals(lastCarrierTeam, team2)) return lastCarrierTeam;
    }
  }

  return teamNeutral;
}

function spawnOrMoveCipherNativeMinimapBomb(sourcePos: mod.Vector | undefined, context: string): void {
  const nativePos = getCipherNativeMinimapBombPosition(sourcePos);
  if (!nativePos) return;

  const ownerTeam = getNativeBombCurrentOwnerTeam();

  if (
    cipherNativeMinimapBombLifetime !== "active" ||
    (!cipherNativeMinimapBombHandle && !cipherNativeMinimapBombObject)
  ) {
    spawnCipherNativeBombAtPosition(nativePos, ownerTeam, context);
    return;
  }

  trySetNativeBombTeam(ownerTeam, context + "_team");
  trySetNativeBombGlobalVisibility(true, context + "_visible");
  moveCipherNativeMinimapBombToPosition(nativePos, context);
}

function resetCipherNativeBombCarrierVisibilityPulse(carrierId: number | undefined, nowSec: number, context: string): void {
  if (carrierId === undefined) {
    cipherNativeBombVisibilityPulseCarrierPlayerId = undefined;
    cipherNativeBombVisibilityPulseStartedAtSec = 0;
    cipherNativeBombVisibilityPulseLastPhase = -1;
    cipherNativeBombVisibilityLastApplyAtSec = -999999;
    return;
  }

  if (cipherNativeBombVisibilityPulseCarrierPlayerId === carrierId) return;
  cipherNativeBombVisibilityPulseCarrierPlayerId = carrierId;
  cipherNativeBombVisibilityPulseStartedAtSec = nowSec;
  cipherNativeBombVisibilityPulseLastPhase = -1;
  cipherNativeBombVisibilityLastApplyAtSec = -999999;
  trySetNativeBombGlobalVisibility(true, context + "_new_carrier_visible_first", true);
}

function updateCipherNativeBombCarrierVisibility(nowSec: number, context: string): void {
  if (cipherNativeMinimapBombLifetime !== "active") return;
  if (!cipherNativeMinimapBombHandle) return;
  if (bombCarrierPlayerId === undefined) {
    resetCipherNativeBombCarrierVisibilityPulse(undefined, nowSec, context + "_no_carrier_reset");
    trySetNativeBombGlobalVisibility(true, context + "_no_carrier");
    return;
  }

  resetCipherNativeBombCarrierVisibilityPulse(bombCarrierPlayerId, nowSec, context + "_carrier_reset");

  const cycle = CIPHER_NATIVE_BOMB_ENEMY_VISIBLE_SECONDS + CIPHER_NATIVE_BOMB_ENEMY_HIDDEN_SECONDS;
  const elapsed = Math.max(0, nowSec - cipherNativeBombVisibilityPulseStartedAtSec);
  const phaseTime = cycle > 0 ? elapsed % cycle : 0;
  const enemyVisible = phaseTime < CIPHER_NATIVE_BOMB_ENEMY_VISIBLE_SECONDS;
  const phaseIndex = enemyVisible ? 1 : 0;

  const phaseChanged = phaseIndex !== cipherNativeBombVisibilityPulseLastPhase || cipherNativeMinimapBombLastGlobalVisible !== enemyVisible;
  const reapplyDue = nowSec - cipherNativeBombVisibilityLastApplyAtSec >= 0.5;
  if (!phaseChanged && !reapplyDue) return;

  cipherNativeBombVisibilityPulseLastPhase = phaseIndex;
  cipherNativeBombVisibilityLastApplyAtSec = nowSec;

  // API contract from vendor index.d.ts:
  // SetBombWorldIconGlobalVisibility(true) = all teams see the bomb carrier icon.
  // SetBombWorldIconGlobalVisibility(false) = only the Bomb team sees it.
  // Because SetBombTeam() is set to the carrier team, false hides the carrier from enemies.
  // Reapply every 0.5s because native GiveBomb/engine state can refresh carrier icon visibility.
  trySetNativeBombGlobalVisibility(
    enemyVisible,
    context + (enemyVisible ? "_enemy_visible_2s" : "_enemy_hidden_2s"),
    true
  );
}

function giveCipherNativeBombToCarrier(carrier: Player, nowSec: number, context: string): void {
  if (cipherNativeMinimapBombLifetime === "destroying") return;
  if (!mod.IsPlayerValid(carrier.player)) return;

  const carrierTeam = getCipherKeyTeamSnapshot(carrier.id) ?? carrier.team;
  if (mod.Equals(carrierTeam, team1) || mod.Equals(carrierTeam, team2)) {
    trySetNativeBombTeam(carrierTeam, context + "_team");
  }

  if (cipherNativeMinimapBombLifetime !== "active" || !cipherNativeMinimapBombHandle) {
    const carrierPos = tryGetPlayerPositionSafe(carrier.player);
    const nativeCarrierPos = getCipherNativeMinimapBombPosition(carrierPos);
    if (nativeCarrierPos) {
      spawnCipherNativeBombAtPosition(nativeCarrierPos, carrierTeam, context + "_spawn_for_carrier");
    }
  }

  if (!cipherNativeMinimapBombHandle) return;

  // Give the native Bomb only once per carrier assignment. Re-giving it on a timer
  // causes the AI to replay pickup/interact animations while already carrying it.
  if (cipherNativeMinimapBombCarrierPlayerId !== carrier.id) {
    try {
      (mod as any).GiveBombToPlayer(carrier.player, cipherNativeMinimapBombHandle);
      cipherNativeMinimapBombCarrierPlayerId = carrier.id;
      cipherNativeMinimapBombLastGiveAtSec = nowSec;
      resetCipherNativeBombCarrierVisibilityPulse(carrier.id, nowSec, context + "_give");
    } catch (err) {
      LogRuntimeError("NativeBomb/giveToCarrier/" + context, err);
    }
  }

  updateCipherNativeBombCarrierVisibility(nowSec, context);
}

function scheduleCipherNativeBombCarrierBindRetries(playerId: number, context: string): void {
  cipherNativeBombCarrierBindToken += 1;
  const token = cipherNativeBombCarrierBindToken;
  const carrier = serverPlayers.get(playerId);
  if (!carrier) return;
  const expectedNativeObjId = carrier.nativeObjId;
  const expectedSessionToken = playerSessionTokenByPlayerId[playerId];
  const delaysSeconds = [0, 0.1, 0.25];

  for (let i = 0; i < delaysSeconds.length; i++) {
    const delaySeconds = delaysSeconds[i];
    scheduleCipherGlobalTask(delaySeconds, "native_bomb_bind/" + String(playerId) + "/" + String(i), () => {
      if (cipherNativeBombCarrierBindToken !== token) return;
      if (gameStatus !== 3 || bombCarrierPlayerId !== playerId) return;
      if (expectedSessionToken !== undefined && !isCurrentPlayerSession(playerId, expectedSessionToken)) return;
      const latest = serverPlayers.get(playerId);
      if (!latest || latest.nativeObjId !== expectedNativeObjId) return;
      if (!mod.IsPlayerValid(latest.player)) return;
      giveCipherNativeBombToCarrier(
        latest,
        getCurrentSchedulerNowSeconds(),
        context + "_retry_" + String(i)
      );
    });
  }
}

function updateCipherNativeMinimapBombForCarrier(nowSec?: number, context: string = "carrier_follow"): void {
  const t = nowSec ?? getCurrentSchedulerNowSeconds();
  if (gameStatus !== 3 || bombCarrierPlayerId === undefined) return;
  const carrier = serverPlayers.get(bombCarrierPlayerId);
  if (!carrier || !carrier.isDeployed || !mod.IsPlayerValid(carrier.player) || !isPlayerAliveSafe(carrier.player)) return;
  giveCipherNativeBombToCarrier(carrier, t, context);
}

function updateDroppedBombWorldIconCountdown(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined) return;
  if (!hasDroppedBombRuntimeObjects()) return;

  const anchorPos = tryResolveDroppedBombAnchorPosition();
  if (!anchorPos) return;

  if (bombDroppedReturnDeadlineAtSec <= 0) {
    bombDroppedReturnDeadlineAtSec = getCurrentSchedulerNowSeconds() + BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS;
  }

  const remainingSeconds = mod.Max(
    0,
    mod.Ceiling(bombDroppedReturnDeadlineAtSec - getCurrentSchedulerNowSeconds())
  );

  if (!bombDroppedWorldIconHandle) {
    ensureDroppedBombRuntimeWorldIconVisibleIfNeeded();
    return;
  }

  if (remainingSeconds === bombDroppedWorldIconLastShownSeconds) return;

  const iconPos = mod.Add(anchorPos, DROPPED_KEY_WORLD_ICON_OFFSET);
  try {
    mod.SetWorldIconPosition(bombDroppedWorldIconHandle!, iconPos);
    mod.SetWorldIconText(bombDroppedWorldIconHandle!, formatDroppedKeyWorldIconTimerLabel(remainingSeconds));
    mod.SetWorldIconColor(bombDroppedWorldIconHandle!, COLOR_FRIENDLY);
    mod.EnableWorldIconImage(bombDroppedWorldIconHandle!, false);
    mod.EnableWorldIconText(bombDroppedWorldIconHandle!, true);
    bombDroppedWorldIconLastShownSeconds = remainingSeconds;
  } catch (_err) {
    bombDroppedWorldIconHandle = undefined;
    bombDroppedWorldIconLastShownSeconds = -1;
  }
}


function tryGetPlayerPositionSafe(player: mod.Player): mod.Vector | undefined {
  try {
    if (!mod.IsPlayerValid(player)) return undefined;
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

function scheduleRuntimeSfxSourceCleanup(
  spawnedSource: RuntimeSfxSourceSpawnValidation,
  activeHandle: mod.SFX | undefined,
  delaySeconds: number,
  context: string
): void {
  scheduleCipherGlobalTask(delaySeconds, "sfx_cleanup/" + context, () => {
    if (spawnedSource.object) {
      unspawnObjectSafe(spawnedSource.object, context, false);
      return;
    }
    if (spawnedSource.spawned) {
      unspawnObjectSafe(spawnedSource.spawned, context, false);
      return;
    }
    if (activeHandle) unspawnObjectSafe(activeHandle as unknown, context, false);
  });
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

  scheduleRuntimeSfxSourceCleanup(
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
      mod.DistanceBetween(previousAnchor!, bombBeepFixedAnchorPos!) > 0.01);

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


function clearBombCarrierRuntimeWorldIcons(): void{ bombCarrierFriendlyIconObject = undefined; bombCarrierFriendlyIconHandle = undefined; bombCarrierEnemyIconObject = undefined; bombCarrierEnemyIconHandle = undefined; }


function spawnBombCarrierRuntimeWorldIcons(
  _carrierPlayer: mod.Player,
  _nowSec: number,
  _carrierTeamOverride?: mod.Team
): boolean{ return false; }


function syncCipherCarrierVisualsNow(nowSec?: number, _reason: string = "tick"): void {
  if (ENABLE_CARRIER_SUBTICK) {
    updateBombCarrierRuntimeWorldIconsVisualFollowFrame(nowSec);
  }

  updateBombCarrierRuntimeWorldIconsTick(nowSec);
  updateCipherNativeMinimapBombForCarrier(nowSec, _reason);
}


function updateBombCarrierRuntimeWorldIconsVisualFollowFrame(nowSec?: number): void{}

function updateBombCarrierRuntimeWorldIconsTick(nowSec?: number): void{}

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
          mod.DistanceBetween(bombBeepFixedAnchorPos!, desiredFixedAnchor) > 0.01))) ||
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
  if (mod.DistanceBetween(bombBeepLastPlayPos!, desiredPulsePos) < BOMB_CARRIER_LOOP_REANCHOR_DISTANCE_METERS) {
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
  // Clear references first so repeated/reentrant cleanup is idempotent.
  const object = bombDroppedRuntimeLootSpawnerObject;
  bombDroppedRuntimeLootSpawnerObject = undefined;
  bombDroppedRuntimeLootSpawnerHandle = undefined;
  if (object) {
    unspawnObjectSafe(object, "dropped runtime loot spawner");
  }
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

  // Portal gadget world loot is intentionally disabled.
  // The Cipher key pickup now uses the existing radius/native-object authority path,
  // while the runtime spawner object is kept as a stable anchor for validation/cleanup.
  setBombSpawnValidationDebugState(context, "runtime_spawner_ok_no_portal_gadget", runtimeSpawner.objId);
  return runtimeSpawner;
}

function tryResolveBombBaseRuntimeLootPosition(context: string): mod.Vector | undefined {
  const runtimeTarget = bombBaseRuntimeLootSpawnerObject ?? bombBaseRuntimeLootSpawnerObjectId;
  return getObjectPositionSafeValidated(runtimeTarget, context).position;
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
  spawnOrMoveCipherNativeMinimapBomb(dropAnchorPos, "dropped_spawn");
  clearBombBaseBeepLoop();
  clearBombCarrierBeepLoop();
  startBombDroppedBeepLoopAtPosition(dropAnchorPos);

  let runtimeIconSpawned: unknown = undefined;
  const runtimeIconPos = mod.Add(dropAnchorPos, DROPPED_KEY_WORLD_ICON_OFFSET);
  try {
    runtimeIconSpawned = mod.SpawnObject(BOMB_DROP_WORLDICON_ASSET, runtimeIconPos, BOMB_DROP_ROTATION) as unknown;
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

  const configured = configureBombWorldIconSafe(runtimeIcon, false);
  if (!configured) {
    warnBombDropRuntimeWorldIconMissingOnce("configure icon failed");
    return true;
  }

  // Reassert final visible state for deterministic drop visuals.
  try {
    mod.EnableWorldIconImage(runtimeIcon, false);
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
  const nowSec = getCurrentSchedulerNowSeconds();
  if (nowSec < bombDroppedReclaimBlockedUntilSec) return false;
  if (bombDroppedLastCarrierPlayerId === sp.id && nowSec < bombDroppedLastCarrierBlockedUntilSec) {
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
  const objectivePos = getObjectiveAnchorPosition(cpId);
  if (objectivePos) return objectivePos;

  const capturePoint = resolveObjectiveCapturePointHandleByCpId(cpId, "getObjectiveFallbackPosition");
  if (!capturePoint) return undefined;

  try {
    return mod.GetObjectPosition(capturePoint as unknown as mod.Object);
  } catch (_err) {
    return undefined;
  }
}

function clearBotObjectiveStateForPlayer(playerId: number): void {
  return;
}

function clearBotObjectiveAssignments(): void {
  return;
}

function clearBotObjectiveState(): void {
  return;
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
  return undefined as any;
}

function getRuntimeBotSlotForPlayerId(playerId: number): RuntimeBotSlot | undefined {
  return undefined as any;
}

function isCipherRuntimeBotPlayerId(playerId: number): boolean {
  return false;
}


function shouldSkipHumanInputRestrictionsForPlayer(player: mod.Player): boolean {
  const playerId = getPlayerIdSafe(player);
  if (playerId !== undefined && isCipherRuntimeBotPlayerId(playerId)) return true;
  return isBotBackfillPlayerSafe(player);
}

function clearRuntimeBotPlayerBinding(slot: RuntimeBotSlot, releaseOldPlayerId: boolean): void {
  return;
}

function configureRuntimeBotCombat(player: mod.Player): void {
  return;
}

function configureRuntimeBotLocked(player: mod.Player): void {
  return;
}

function shouldRuntimeBotsBePhaseLocked(): boolean {
  return false;
}

function isRuntimeBotPhaseLocked(playerId: number): boolean {
  return false;
}

function applyRuntimeBotPhaseLockForPlayer(player: mod.Player, playerId: number, _source: string): void {
  return;
}

function releaseRuntimeBotPhaseLockForPlayer(player: mod.Player, playerId: number, _source: string): void {
  return;
}

function applyRuntimeBotPhaseLocksForAll(source: string): void {
  return;
}

function releaseRuntimeBotPhaseLocksForAll(source: string): void {
  return;
}

function finishRuntimeBotLiveStartSettle(token: number, expectedStage: CipherMatchStage, source: string): void {
  return;
}

function isCipherLiveStartSettling(): boolean {
  return cipherLiveStartSettlingStage !== "none" && getCurrentSchedulerNowSeconds() < cipherLiveStartSettlingUntilSec;
}

function startRuntimeBotLiveStartSettle(expectedStage: CipherMatchStage, source: string): void {
  return;
}

function routeRuntimeBotToCipherSpawnAnchor(player: mod.Player, playerId: number, context: string): void {
  return;
}

function getRuntimeBotClassForSlot(slotId: number): mod.SoldierClass {
  return undefined as any;
}

function forEachRuntimeBotSlot(callback: (slot: RuntimeBotSlot) => void): void {
  return;
}

function countActiveRuntimeBotSlots(): number {
  return 0;
}

type RuntimeBotTeamCounts = {
  team1Humans: number;
  team2Humans: number;
  team1Bots: number;
  team2Bots: number;
  totalBots: number;
};

function countRuntimeBotTeamState(): RuntimeBotTeamCounts {
  return undefined as any;
}

function getDesiredRuntimeBotCountForHumanCount(humanCount: number): number {
  return 0;
}

function createRuntimeBotSlot(desiredTeam: mod.Team, nowSec: number): RuntimeBotSlot {
  return undefined as any;
}

function getAuthoredRuntimeBotSpawnerIdForTeam(team: mod.Team): number {
  return 0;
}

function removePendingRuntimeBotSlot(slotId: number, spawnerObjId: number): void {
  return;
}

function queuePendingRuntimeBotSlot(slot: RuntimeBotSlot): void {
  return;
}

function takePendingRuntimeBotSlotForSpawner(spawnerObjId: number): RuntimeBotSlot | undefined {
  return undefined as any;
}

function resolveAuthoredRuntimeBotSpawnerByObjId(
  spawnerObjId: number,
  context: string,
  logFailure: boolean = true
): mod.Spawner | undefined {
  return undefined as any;
}

function clearRuntimeBotSpawnerForSlot(slot: RuntimeBotSlot, _unspawnAi: boolean, context: string): void {
  return;
}

function ensureRuntimeBotSpawnerForSlot(slot: RuntimeBotSlot): boolean {
  return false;
}

function spawnRuntimeBotFromSlot(slot: RuntimeBotSlot, nowSec: number, context: string): void {
  return;
}

function retireRuntimeBotSlot(slot: RuntimeBotSlot, context: string): void {
  return;
}

function clearRuntimeBotState(unspawnSpawners: boolean): void {
  return;
}

function chooseRuntimeBotSlotToRetire(team?: mod.Team): RuntimeBotSlot | undefined {
  return undefined as any;
}

function reconcileRuntimeBotSlotCount(nowSec: number): void {
  return;
}

function resetRuntimeBotStagedSpawnSchedule(): void {
  return;
}

function chooseReadyRuntimeBotSlotForStagedSpawn(nowSec: number): RuntimeBotSlot | undefined {
  return undefined as any;
}

function chooseRuntimeBotTeamForStagedSlot(counts: RuntimeBotTeamCounts): mod.Team | undefined {
  return team1;
}

function spawnOneRuntimeBotStaged(nowSec: number, source: string): void {
  return;
}

function tickRuntimeBotStagedSpawning(nowSec: number, source: string): void {
  return;
}

function shouldRuntimeBotSlotSpawn(slot: RuntimeBotSlot, nowSec: number): boolean {
  return false;
}

function reconcileRuntimeBotSpawns(nowSec: number): void {
  return;
}

function validateRuntimeBotSpawnersOnce(): boolean {
  return false;
}

function reconcileRuntimeBots(nowSec: number): void {
  return;
}

function bindRuntimeBotPlayerToSlot(slot: RuntimeBotSlot, player: mod.Player): void {
  return;
}

function markRuntimeBotSlotForRespawn(playerId: number, delaySeconds: number): void {
  return;
}

function clearRuntimeBotRespawnStateForPlayer(playerId: number): void {
  return;
}

function handleRuntimeBotRevivedForPlayer(playerId: number, player: mod.Player, _source: string): void {
  return;
}


function isLiveBotPlayer(sp: Player | undefined): boolean {
  return false;
}

function isLiveBotDeployedAndAlive(sp: Player | undefined): sp is Player {
  return undefined as any;
}

function hasLiveBots(): boolean {
  return false;
}

function requestLiveBotSpawnForPlayerId(
  playerId: number,
  source: string,
  delaySeconds: number = BOT_LIVE_SPAWN_INITIAL_DELAY_SECONDS
): void {
  return;
}

function requestLiveBotSpawnsForAllBots(_source: string): void {
  return;
}

function handleRuntimeBotDeployedForCurrentPhase(
  eventPlayer: mod.Player,
  playerId: number,
  slot: RuntimeBotSlot,
  source: string
): void {
  return;
}


function shouldIssueBotMoveCommand(playerId: number, role: BotObjectiveRole, target: mod.Vector, nowSec: number): boolean {
  return false;
}

function getRuntimeBotMoveSpeedForRole(role: BotObjectiveRole): mod.MoveSpeed {
  return mod.MoveSpeed.Sprint;
}

function getRuntimeBotDefendRadiusForRole(role: BotObjectiveRole): number {
  return 0;
}

function isRuntimeBotSoftVisibleTarget(botPos: mod.Vector | undefined, targetPos: mod.Vector | undefined, distance: number): boolean {
  return false;
}

function trySetRuntimeBotTarget(bot: Player, targetPlayer: mod.Player): void {
  return;
}

function clearRuntimeBotCombatTarget(sp: Player, reason: string): void {
  return;
}


function hasRuntimeBotLineOfSightToTarget(
  sp: Player,
  target: BotEnemyTarget,
  _nowSec: number,
  _source: string
): boolean {
  return false;
}

function Mode_OnRayCastHit(_eventPlayer: mod.Player, _eventPoint: mod.Vector, _eventNormal: mod.Vector): void {}

function Mode_OnRayCastMissed(_eventPlayer: mod.Player): void {}


function chooseNearestRuntimeBotEnemyTarget(sp: Player, maxRadiusMeters: number, nowSec: number): BotEnemyTarget | undefined {
  return undefined as any;
}

function refreshRuntimeBotEnemyTarget(sp: Player, nowSec: number): BotEnemyTarget | undefined {
  return undefined as any;
}

function refreshRuntimeBotEnemyTargets(nowSec: number): { [playerId: number]: BotEnemyTarget | undefined } {
  return {};
}

function tryIssueBotCombatHold(
  sp: Player,
  target: BotEnemyTarget | undefined,
  nowSec: number,
  carrierCombat: boolean = false
): boolean {
  return false;
}

function issueBotMoveCommand(sp: Player, role: BotObjectiveRole, target: mod.Vector, nowSec: number): void {
  return;
}

function getBotOffsetTarget(baseTarget: mod.Vector, playerId: number, radiusMeters: number): mod.Vector {
  return undefined as any;
}

function getDefaultBotCipherKeyAnchorPosition(): mod.Vector | undefined {
  return undefined as any;
}

function getBotCipherKeyTargetPosition(): mod.Vector | undefined {
  return undefined as any;
}

function canBotRunToCipherKey(sp: Player, _keyIsDropped: boolean): boolean {
  return false;
}

function isValidBotCarrierDeliveryObjective(cpId: number, carrierTeam: mod.Team): boolean {
  return false;
}

function chooseNearestBotDeliveryPositionFromOrigin(origin: mod.Vector, carrierTeam: mod.Team): mod.Vector | undefined {
  return undefined as any;
}

function chooseNearestBotCarrierDeliveryPosition(carrier: Player, carrierTeam: mod.Team): mod.Vector | undefined {
  return undefined as any;
}

function chooseNearestBotTeammatePosition(sp: Player, botTeam: mod.Team): mod.Vector | undefined {
  return undefined as any;
}

function tryIssueBotReviveAssignment(sp: Player, nowSec: number): boolean {
  return false;
}

function chooseBotFallbackAssignment(sp: Player): { role: BotObjectiveRole; target: mod.Vector } | undefined {
  return undefined;
}

type BotCarrierRoutingResult = {
  carrierId: number | undefined;
  carrierTeam: mod.Team | undefined;
  carrierPos: mod.Vector | undefined;
  routed: boolean;
};

function evaluateBotCarrierRouting(nowSec: number): BotCarrierRoutingResult {
  return undefined as any;
}

function evaluateBotKeyRunnerRouting(
  nowSec: number,
  excludedPlayerId: number | undefined
): { [playerId: number]: boolean } {
  return {};
}

function evaluateBotCarrierSupportRouting(
  nowSec: number,
  carrierRouting: BotCarrierRoutingResult,
  routedByPlayerId: { [playerId: number]: boolean }
): void {
  return;
}

function evaluateBotObjectiveController(nowSec: number): void {
  return;
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
  // Anchor vectors are immutable for the loaded map. Keep the validated cache
  // across phase resets so respawn jobs never resolve SpatialObjects mid-match.
  cipherObjectiveAnchorPositionByCpId = {};
  cipherObjectiveAnchorPositionSnapshotByCpId = {};
  cipherPlayerPositionSnapshotByPlayerId = {};
  cipherAnchorCooldownUntilSecByObjectId = {};
  cipherAnchorRoundRobinIndexByKey = {};
  cipherSpawnRegionTieFlipByKey = {};
  cipherLastSpawnRegionByTeamId = {};
  cipherLastSpawnRegionAtSecByTeamId = {};
  cipherQueuedAnchorByPlayerId = {};
  endCipherFirstDeployAnchorSession("reset_spawn_routing");
  cipherPendingSpawnJobs = [];
  cipherUrgentSpawnJobs = [];
  cipherRespawnRouteJobByPlayerId = {};
}

function warmCipherSpawnAnchorPositionCache(): void {
  cipherAnchorPositionByObjectId = {};
  const groups: number[][] = [
    CIPHER_FIRST_DEPLOY_NORTH_ANCHORS,
    CIPHER_FIRST_DEPLOY_SOUTH_ANCHORS,
    CIPHER_NORTH_EAST_NORTH_ANCHORS,
    CIPHER_NORTH_EAST_SOUTH_ANCHORS,
    CIPHER_NORTH_WEST_NORTH_ANCHORS,
    CIPHER_NORTH_WEST_SOUTH_ANCHORS,
    CIPHER_SOUTH_EAST_NORTH_ANCHORS,
    CIPHER_SOUTH_EAST_SOUTH_ANCHORS,
    CIPHER_SOUTH_WEST_NORTH_ANCHORS,
    CIPHER_SOUTH_WEST_SOUTH_ANCHORS,
  ];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const ids = groups[groupIndex];
    for (let anchorIndex = 0; anchorIndex < ids.length; anchorIndex++) {
      getCachedCipherAnchorPosition(ids[anchorIndex]);
    }
  }
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
  players[playerId] = modlib.getTeamId(sp.team);
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
  if (cached) return mod.CreateVector(cached.x, cached.y, cached.z);

  try {
    const spatialAnchor = mod.GetSpatialObject(anchorId) as unknown as mod.Object;
    const position = mod.GetObjectPosition(spatialAnchor);
    const snapshot = snapshotVector(position);
    if (
      !Number.isFinite(snapshot.x) ||
      !Number.isFinite(snapshot.y) ||
      !Number.isFinite(snapshot.z)
    ) {
      delete cipherAnchorPositionByObjectId[anchorId];
      return undefined;
    }
    cipherAnchorPositionByObjectId[anchorId] = snapshot;
    return mod.CreateVector(snapshot.x, snapshot.y, snapshot.z);
  } catch (_err) {
    delete cipherAnchorPositionByObjectId[anchorId];
    return undefined;
  }
}

function getCachedObjectiveAnchorPosition(cpId: number): mod.Vector | undefined {
  const cached = cipherObjectiveAnchorPositionByCpId[cpId];
  if (cached) return mod.CreateVector(cached.x, cached.y, cached.z);

  const position = getObjectiveAnchorPosition(cpId);
  if (!position) return undefined;

  const snapshot = snapshotVector(position);
  cipherObjectiveAnchorPositionByCpId[cpId] = snapshot;
  cipherObjectiveAnchorPositionSnapshotByCpId[cpId] = snapshot;
  return mod.CreateVector(snapshot.x, snapshot.y, snapshot.z);
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

function getCipherFirstDeployAnchorIdsForSide(side: CipherMapSide): number[] {
  return side === "north" ? CIPHER_FIRST_DEPLOY_NORTH_ANCHORS : CIPHER_FIRST_DEPLOY_SOUTH_ANCHORS;
}

function isCipherFirstDeployAnchorIdForSide(anchorObjectId: number, side: CipherMapSide): boolean {
  return getCipherFirstDeployAnchorIdsForSide(side).indexOf(anchorObjectId) >= 0;
}

function getCipherFirstDeployFallbackRegionForSide(side: CipherMapSide): CipherSpawnRegion {
  return side === "north"
    ? { quadrant: "northWest", variant: "north" }
    : { quadrant: "southWest", variant: "south" };
}

function startCipherFirstDeployAnchorSession(phase: CipherFirstDeployAnchorPhase, source: string): void {
  cipherFirstDeployAnchorSessionToken += 1;
  cipherFirstDeployAnchorActive = true;
  cipherFirstDeployAnchorPhase = phase;
  cipherFirstDeployAnchorAssignedByPlayerId = {};
  cipherFirstDeployAnchorRoundRobinBySide = {};
  void source;
}

function endCipherFirstDeployAnchorSession(source: string): void {
  cipherFirstDeployAnchorSessionToken += 1;
  cipherFirstDeployAnchorActive = false;
  cipherFirstDeployAnchorAssignedByPlayerId = {};
  cipherFirstDeployAnchorRoundRobinBySide = {};
  void source;
}

function shouldUseCipherFirstDeployAnchorsForCurrentPhase(): boolean {
  if (!cipherFirstDeployAnchorActive) return false;
  if (gameStatus === 2 && cipherFirstDeployAnchorPhase === "half1") return true;
  if (
    gameStatus === 3 &&
    cipherSecondHalfTransitionStage === "deploy"
  ) {
    if (cipherFirstDeployAnchorPhase === "half2" && cipherLiveTransitionSupervisorKind === "secondHalf") return true;
    if (cipherFirstDeployAnchorPhase === "suddenDeath" && cipherLiveTransitionSupervisorKind === "suddenDeath") return true;
  }
  return false;
}

function chooseCipherFirstDeployAnchorForPlayer(
  playerId: number,
  team: mod.Team,
  side: CipherMapSide
): CipherQueuedSpawnAnchor | undefined {
  if (!shouldUseCipherFirstDeployAnchorsForCurrentPhase()) return undefined;

  const anchorIds = getCipherFirstDeployAnchorIdsForSide(side);
  if (anchorIds.length <= 0) return undefined;

  const assignedAnchorId = cipherFirstDeployAnchorAssignedByPlayerId[playerId];
  if (assignedAnchorId !== undefined && isCipherFirstDeployAnchorIdForSide(assignedAnchorId, side)) {
    return {
      anchorObjectId: assignedAnchorId,
      side,
      region: getCipherFirstDeployFallbackRegionForSide(side),
      kind: "firstDeploy",
      firstDeployPhase: cipherFirstDeployAnchorPhase,
      firstDeploySessionToken: cipherFirstDeployAnchorSessionToken,
    };
  }

  const sideKey = side + ":" + String(modlib.getTeamId(team)) + ":" + cipherFirstDeployAnchorPhase;
  const startIndex = cipherFirstDeployAnchorRoundRobinBySide[sideKey] ?? 0;
  let selectedAnchorId: number | undefined = undefined;
  let selectedIndex = startIndex;

  for (let offset = 0; offset < anchorIds.length; offset++) {
    const idx = mod.Modulo(startIndex + offset, anchorIds.length);
    const anchorId = anchorIds[idx];
    if (getCachedCipherAnchorPosition(anchorId) === undefined) continue;
    selectedAnchorId = anchorId;
    selectedIndex = idx;
    break;
  }

  if (selectedAnchorId === undefined) return undefined;

  cipherFirstDeployAnchorRoundRobinBySide[sideKey] = mod.Modulo(selectedIndex + 1, anchorIds.length);
  cipherFirstDeployAnchorAssignedByPlayerId[playerId] = selectedAnchorId;

  return {
    anchorObjectId: selectedAnchorId,
    side,
    region: getCipherFirstDeployFallbackRegionForSide(side),
    kind: "firstDeploy",
    firstDeployPhase: cipherFirstDeployAnchorPhase,
    firstDeploySessionToken: cipherFirstDeployAnchorSessionToken,
  };
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
  storedTeamId: number | undefined,
  enemyTeam: mod.Team
): boolean {
  const sp = serverPlayers.get(playerId);
  let currentTeam: mod.Team | undefined = undefined;
  let stale = false;

  if (!sp || !mod.IsPlayerValid(sp.player) || !sp.isDeployed || !isPlayerAliveSafe(sp.player)) {
    stale = true;
  } else {
    currentTeam = mod.GetTeam(sp.player);
    if (storedTeamId !== undefined && modlib.getTeamId(currentTeam) !== storedTeamId) {
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
      kind: "dynamic",
    };
  }

  return undefined;
}

function cancelCipherRespawnRouteJobForPlayer(playerId: number): void {
  const job = cipherRespawnRouteJobByPlayerId[playerId];
  if (job) {
    job.status = "cancelled";
    if (job.timerHandle !== undefined) Timers.clearInterval(job.timerHandle);
    delete cipherQueuedAnchorByPlayerId[playerId];
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
  if (job.status !== "evaluating") return false;
  if (cipherRespawnRouteTokenByPlayerId[job.playerId] !== job.token) return false;
  if (!isCurrentPlayerSession(job.playerId, job.sessionToken)) return false;
  if (job.lifeGeneration !== getPlayerLifeGeneration(job.playerId)) return false;
  if (gameStatus !== 3) return false;
  if (cipherMatchStage !== job.expectedMatchStage) return false;
  if (cipherCurrentHalf !== job.expectedHalf) return false;
  if (isCipherLiveTransitionActive()) return false;
  if (isCipherSuddenDeathActive()) return false;

  const sp = serverPlayers.get(job.playerId);
  if (!sp) return false;
  if (sp.isDeployed) return false;
  return job.teamId === 1 || job.teamId === 2;
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
  // Authored geometry is A=NE, B=NW, C=SW, D=SE. Routing sends
  // defenders to the opposite lane from the strongest objective pressure.
  return def.lane === "A" || def.lane === "D" ? "east" : "west";
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
  if (!job || job.status !== "evaluating") return;
  const team = mod.GetTeam(job.teamId);
  // Pressure can move substantially during the respawn delay. Always take one
  // final live sample instead of committing the candidate selected early in
  // the route window.
  let candidate = selectCipherRespawnRouteCandidate(
    playerId,
    team,
    CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS,
    true
  ) ?? job.finalizedCandidate ?? job.currentCandidate;
  if (!candidate || !isCipherQueuedSpawnAnchorValidForTeam(candidate, team)) {
    candidate = selectCipherRespawnRouteCandidate(
      playerId,
      team,
      CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS,
      true
    );
  }

  if (candidate) {
    job.finalizedCandidate = candidate;
    cipherQueuedAnchorByPlayerId[playerId] = candidate;
  }
  if (job.timerHandle !== undefined) {
    Timers.clearInterval(job.timerHandle);
    job.timerHandle = undefined;
  }
  job.status = "finalized";
  void source;
}

function tickCipherRespawnRouteJob(playerId: number, token: number): void {
  const job = cipherRespawnRouteJobByPlayerId[playerId];
  if (!job || job.token !== token) return;
  if (!isCipherRespawnRouteJobCurrent(job)) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    return;
  }

  const team = mod.GetTeam(job.teamId);
  job.currentSecond += 1;
  job.nextEvaluationAtSec = getCurrentSchedulerNowSeconds() + CIPHER_RESPAWN_ROUTE_TICK_SECONDS;

  // Continuously refresh the preferred quadrant while the player is waiting
  // to respawn. The safety checks below still decide whether a wider-radius
  // reroute is required, but lane pressure never remains frozen at second one.
  job.currentCandidate = selectCipherRespawnRouteCandidate(
    playerId,
    team,
    job.currentSecond >= 3
      ? CIPHER_RESPAWN_REROUTE_SAFETY_RADIUS_METERS
      : CIPHER_RESPAWN_OBJECTIVE_PRESSURE_RADIUS_METERS,
    true
  ) ?? job.currentCandidate;

  if (job.currentSecond === 2) {
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
  if (isCipherRuntimeBotPlayerId(playerId)) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp) return false;
  const team = sp.team;
  return mod.Equals(team, team1) || mod.Equals(team, team2);
}

function startCipherRespawnRouteJobForPlayer(playerId: number, wasDeployed: boolean, source: string): void {
  if (!shouldStartCipherRespawnRouteJobForPlayer(playerId, wasDeployed)) return;

  cancelCipherRespawnRouteJobForPlayer(playerId);
  const sp = serverPlayers.get(playerId);
  if (!sp) return;

  const team = sp.team;
  const token = nextCipherRespawnRouteToken(playerId);
  const nowSec = getCurrentSchedulerNowSeconds();
  const job: CipherRespawnRouteJob = {
    token,
    playerId,
    teamId: modlib.getTeamId(team),
    startedAtSec: nowSec,
    currentSecond: 0,
    nextEvaluationAtSec: nowSec + CIPHER_RESPAWN_ROUTE_TICK_SECONDS,
    dangerDetected: false,
    sessionToken: ensurePlayerSessionToken(playerId),
    expectedMatchStage: cipherMatchStage,
    expectedHalf: cipherCurrentHalf,
    lifeGeneration: getPlayerLifeGeneration(playerId),
    status: "evaluating",
  };

  cipherRespawnRouteJobByPlayerId[playerId] = job;
  job.timerHandle = Timers.setInterval(
    () => tickCipherRespawnRouteJob(playerId, token),
    CIPHER_RESPAWN_ROUTE_TICK_MS
  );
  void source;
}

function getCipherAttackObjectiveCenterForSide(side: CipherMapSide): mod.Vector | undefined {
  const targetCpIds = getActiveObjectiveCpIdsForSide(side === "north" ? "south" : "north");
  let total: mod.Vector | undefined = undefined;
  let count = 0;

  for (let i = 0; i < targetCpIds.length; i++) {
    const position = getCachedObjectiveAnchorPosition(targetCpIds[i]);
    if (!position) continue;
    total = total ? mod.Add(total!, position) : position;
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
  if (queuedAnchor.kind === "firstDeploy") {
    if (!shouldUseCipherFirstDeployAnchorsForCurrentPhase()) return false;
    if (queuedAnchor.firstDeployPhase !== cipherFirstDeployAnchorPhase) return false;
    if (queuedAnchor.firstDeploySessionToken !== cipherFirstDeployAnchorSessionToken) return false;
    return isCipherFirstDeployAnchorIdForSide(queuedAnchor.anchorObjectId, expectedSide);
  }
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

  const firstDeployAnchor = chooseCipherFirstDeployAnchorForPlayer(playerId, team, defaultSide);
  if (firstDeployAnchor) {
    cipherQueuedAnchorByPlayerId[playerId] = firstDeployAnchor;
    return true;
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
  const sessionToken = ensurePlayerSessionToken(playerId);
  if (hasCipherSpawnJobQueued(cipherUrgentSpawnJobs, playerId, kind)) return;
  if (hasCipherSpawnJobQueued(cipherPendingSpawnJobs, playerId, kind)) return;

  const job: CipherSpawnJob = {
    kind,
    playerId,
    createdAtSec: getCurrentSchedulerNowSeconds(),
    attempt: 0,
    sessionToken,
    expectedGameStatus: gameStatus,
    expectedMatchStage: cipherMatchStage,
    expectedTransitionToken: getQueuedPlayerWorkTransitionToken(),
    lifeGeneration: getPlayerLifeGeneration(playerId),
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

function clearCipherSpawnJobsForPlayer(playerId: number): void {
  cipherPendingSpawnJobs = cipherPendingSpawnJobs.filter((job) => job.playerId !== playerId);
  cipherUrgentSpawnJobs = cipherUrgentSpawnJobs.filter((job) => job.playerId !== playerId);
}

function processCipherSpawnJobs(source: string): void {
  if (!isCipherSpawnRoutingPhaseActive()) return;
  void source;

  let processed = 0;
  const jobBudget =
    gameStatus === 2 || isCipherLiveTransitionActive()
      ? CIPHER_TRANSITION_SPAWN_JOBS_PER_TICK
      : CIPHER_SPAWN_JOBS_PER_TICK;
  const retryWindowSeconds =
    gameStatus === 2 || isCipherLiveTransitionActive()
      ? CIPHER_TRANSITION_SPAWN_RETRY_WINDOW_SECONDS
      : CIPHER_SPAWN_RETRY_WINDOW_SECONDS;
  const nowSec = getCurrentSchedulerNowSeconds();
  while (processed < jobBudget) {
    const job = cipherUrgentSpawnJobs.length > 0 ? cipherUrgentSpawnJobs.shift() : cipherPendingSpawnJobs.shift();
    if (!job) break;
    processed += 1;

    if (!isQueuedPlayerWorkCurrent(
      job.playerId,
      job.sessionToken,
      job.expectedGameStatus,
      job.expectedMatchStage,
      job.expectedTransitionToken
    ) || job.lifeGeneration !== getPlayerLifeGeneration(job.playerId)) {
      continue;
    }

    let completed = false;
    if (job.kind === "queue-anchor") {
      completed = prepareCipherQueuedAnchorForPlayer(job.playerId);
    } else {
      const sp = serverPlayers.get(job.playerId);
      if (
        sp &&
        sp.isDeployed &&
        mod.IsPlayerValid(sp.player) &&
        isPlayerAliveSafe(sp.player) &&
        (gameStatus !== 3 || isCipherLiveTransitionActive())
      ) {
        const teleported = teleportCipherPlayerToRoutedAnchor(sp.player, job.playerId);
        // A post-deploy custom placement is attempted once. A failed placement
        // intentionally retains the native HQ/friendly spawn and is not retried.
        if (!teleported) delete cipherQueuedAnchorByPlayerId[job.playerId];
        completed = true;
      }
    }

    if (!completed && nowSec - job.createdAtSec <= retryWindowSeconds) {
      const retryJob: CipherSpawnJob = {
        kind: job.kind,
        playerId: job.playerId,
        createdAtSec: job.createdAtSec,
        attempt: job.attempt + 1,
        sessionToken: job.sessionToken,
        expectedGameStatus: job.expectedGameStatus,
        expectedMatchStage: job.expectedMatchStage,
        expectedTransitionToken: job.expectedTransitionToken,
        lifeGeneration: job.lifeGeneration,
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

function teleportCipherPlayerToRoutedAnchor(
  player: mod.Player,
  playerId: number,
  allowRouteRefresh: boolean = true
): boolean {
  if (!isCipherSpawnRoutingPhaseActive()) return false;
  if (!mod.IsPlayerValid(player)) return false;
  if (!isPlayerAliveSafe(player)) return false;
  if (isCipherLiveTransitionActive() && cipherTransitionTeleportedByPlayerId[playerId] === true) return true;

  const team = mod.GetTeam(player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;

  if (getCipherQueuedSpawnAnchorForPlayer(playerId) === undefined) {
    if (!allowRouteRefresh) return false;
    prepareCipherQueuedAnchorForPlayer(playerId);
  }

  const queuedAnchor = getCipherQueuedSpawnAnchorForPlayer(playerId);
  if (!queuedAnchor) return false;
  if (!isCipherQueuedSpawnAnchorValidForTeam(queuedAnchor, team)) {
    delete cipherQueuedAnchorByPlayerId[playerId];
    if (!allowRouteRefresh) return false;
    if (!prepareCipherQueuedAnchorForPlayer(playerId, true)) return false;
  }

  const refreshedQueuedAnchor = getCipherQueuedSpawnAnchorForPlayer(playerId);
  if (!refreshedQueuedAnchor) return false;

  let finalQueuedAnchor = refreshedQueuedAnchor;
  let anchorPos = getCachedCipherAnchorPosition(finalQueuedAnchor.anchorObjectId);
  if (!anchorPos) return false;
  refreshCipherPlayerPositionSnapshots();
  if (finalQueuedAnchor.kind !== "firstDeploy" && !isCipherAnchorSafeFromEnemies(anchorPos, team)) {
    delete cipherQueuedAnchorByPlayerId[playerId];
    if (!allowRouteRefresh) return false;
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
  // Consume all retryable placement state before crossing the engine boundary.
  // A synchronous deploy/undeploy callback can therefore never observe this
  // route as available for a second teleport attempt.
  delete cipherQueuedAnchorByPlayerId[playerId];
  clearCipherSpawnJobsForPlayer(playerId);

  try {
    (mod as any).Teleport(player, anchorPos, yawRadians);
    const routeJob = cipherRespawnRouteJobByPlayerId[playerId];
    if (routeJob && routeJob.status === "finalized") {
      routeJob.status = "consumed";
      delete cipherRespawnRouteJobByPlayerId[playerId];
    }
    cipherPlayerPositionSnapshotByPlayerId[playerId] = snapshotVector(anchorPos);
    if (finalQueuedAnchor.kind !== "firstDeploy") {
      const teamKey = getCipherTeamRoutingKey(team);
      cipherLastSpawnRegionByTeamId[teamKey] = copyCipherSpawnRegion(finalQueuedAnchor.region);
      cipherLastSpawnRegionAtSecByTeamId[teamKey] = getCurrentSchedulerNowSeconds();
    }
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

function respawnBombAtDynamicLocationNow(
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy = "player_biased",
  reservedCandidate?: BombBaseAnchorCandidate
): boolean {
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
  setBombBasePickupEnabled(false);
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

    const movedPickupTrigger = setBombBasePickupPosition(candidate.anchorPos, true);
    if (!movedPickupTrigger) {
      clearBombBaseRuntimeLootSpawner();
      bombActiveBaseSlotIndex = BOMB_DEFAULT_BASE_SLOT_INDEX;
      bombBaseLandingAnchorPosition = undefined;
      bombBaseCachedPosition = undefined;
      bombStaticLootSpawnerInitialPosition = undefined;
      setBombBasePickupEnabled(false);
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


function invalidateBombCarrierRestoreInsertForPlayer(playerId: number): void {
  delete bombCarrierRestoreInsertTokenByPlayerId[playerId];
}


function invalidateBombDeployLoadoutApplyForPlayer(playerId: number): void {
  delete bombDeployLoadoutApplyTokenByPlayerId[playerId];
}

function clearBombCarrierDeployRestoreCacheForPlayer(playerId: number): void {
  delete bombCarrierDeployRestoreEquipmentByPlayerId[playerId];
  invalidateBombDeployLoadoutApplyForPlayer(playerId);
  invalidateBombCarrierRestoreInsertForPlayer(playerId);
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

function restoreBombCarrierReplacementEquipmentForPlayer(
  playerId: number,
  player: mod.Player,
  replacedSlot: mod.InventorySlots | undefined,
  previousEquipment: BombRestoreEquipment | undefined,
  restoreAmmoState: BombRestoreAmmoState | undefined,
  reason: string,
  token: number
): void {
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
    scheduleCipherGlobalTask(BOMB_GADGET_ONE_RESTORE_INSERT_SETTLE_SECONDS, "key_equipment_restore/" + reason, () => {
      restoreBombCarrierReplacementEquipmentForPlayer(
        playerId,
        player,
        replacedSlot,
        previousEquipment,
        restoreAmmoState,
        reason,
        token
      );
    });
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
  cancelCipherGlobalTask(cipherDeferredLiveStartKeyTimerHandle);
  cipherDeferredLiveStartKeyTimerHandle = undefined;
  resetCipherLiveKeyWatchdog();
  clearNextKeyUnlockCountdown("invalidateDeferredBombSpawnTimer", true);
}

function getBombSpawnAnnouncementMessageState(
  mode: BombSpawnAnnouncementMode
): { key: any; fallbackText: string } {
  if (mode === "bomb_located") {
    return {
      key: (mod.stringkeys as any).BombHasBeenLocated,
      fallbackText: "CIPHER KEY UNLOCKED",
    };
  }

  return {
    key: (mod.stringkeys as any).NewBombLocationFound,
    fallbackText: "NEW CIPHER KEY LOCATION UNLOCKED",
  };
}


function announceBombLocationForAllTeams(_message: any): void {
  // Disabled for Cipher Obliteration.
  // The native highlighted game-mode/world popup can flash <unknown string>
  // during half transitions and key respawns.
  // We use the custom key-event banner instead.
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

  // Do not use the native highlighted game-mode/world popup.
  // It is not needed anymore because the custom key-event banner handles this.
  void showHighlightMessage;

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
  scheduleCipherGlobalTask(delaySeconds, "key_respawn/" + context, () => {
    runDeferredBombRespawn(
      myToken,
      context,
      announcementMode,
      showHighlightMessage,
      spawnStrategy,
      reservedCandidate,
      reservedCountdownToken,
      labelMode
    );
  });
}

function runDeferredBombRespawn(
  token: number,
  context: string,
  announcementMode: BombSpawnAnnouncementMode,
  showHighlightMessage: boolean,
  spawnStrategy: BombDynamicSpawnStrategy,
  reservedCandidate?: BombBaseAnchorCandidate,
  reservedCountdownToken: number = 0,
  labelMode: NextKeyUnlockLabelMode = "next_key"
): void {
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
  const spawned = respawnBombAtDynamicLocationNow(
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
  invalidateDeferredBombCarrierDropTimer();
  resetCipherKeyTimeTrackingState();
  clearBombCarrierBeepLoop();
  clearBombCarrierRuntimeWorldIcons();
  clearBombBeepModeState();
  forceReleaseCipherNativeBombCarrier("clear_bomb_carrier_state");
  cipherNativeBombCarrierBindToken += 1;
  bombCarrierPlayerId = undefined;
  if (!hasDroppedBombRuntimeObjects() && !bombBasePickupEnabled) {
    clearCipherNativeMinimapBomb("clear_carrier_state");
  }
  bombCarrierUiStateVersion++;
  bombCarrierReplacedSlotByPlayerId = {};
  bombCarrierPreviousEquipmentByPlayerId = {};
  bombCarrierRestoreAmmoByPlayerId = {};
  resetBombCarrierVerticalTrackingState();
  queueCipherKeyUiRefresh(
    "clearBombCarrierState",
    {
      force: true,
      refreshBombNotice: true,
      updateCarrierHud: true,
      updateIcons: true,
      syncHybridSurface: true,
    },
    1
  );
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

  const objectivePos = getObjectiveAnchorPosition(cpId);
  if (objectivePos) return objectivePos;

  const awardAnchorPos = tryGetObjectiveAwardAnchorPosition(cpId);
  if (awardAnchorPos) return awardAnchorPos;

  return getObjectiveAnchorPosition(cpId);
}

function captureObjectiveDestroyExplosionPositionForCp(cpId: number): void {
  objectiveDestroyExplosionPositionByCpId[cpId] =
    getCipherNodePolygonCenterPositionForCp(cpId) ?? tryResolveObjectiveDestroyExplosionPosition(cpId);
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
    scheduleRuntimeFxCleanup(iconSpawn.object as unknown as mod.VFX | mod.Object, 1.5);
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
  updateDroppedBombWorldIconCountdown();
  scheduleCipherGlobalTask(
    BOMB_PLAYER_DROPPED_RELOCATION_DELAY_SECONDS,
    "dropped_key_return",
    () => returnBombToBase(myToken)
  );
}

function returnBombToBase(token: number): void {
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
  invalidateDeferredBombCarrierDropTimer();
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

  let pickupNoticeTeamId = 0;
  const carrierState = serverPlayers.get(playerId);
  if (carrierState && mod.IsPlayerValid(carrierState.player)) {
    const carrierTeam = getCipherKeyTeamSnapshot(playerId) ?? carrierState.team;
    if (mod.Equals(carrierTeam, team1) || mod.Equals(carrierTeam, team2)) {
      pickupNoticeTeamId = mod.Equals(carrierTeam, team1) ? 1 : 2;
    }
    const carrierPos = tryGetPlayerPositionSafe(carrierState.player);
    if (carrierPos) {
      bombCarrierTrackedY = mod.YComponentOf(carrierPos);
      bombCarrierStableYSinceSec = getCurrentSchedulerNowSeconds();
    }
  }

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

  queueCipherKeyUiRefresh(
    "assignBombCarrierFromDelta",
    {
      force: true,
      // Do not rebuild live HUD during a key pickup. Rebuilding UI widgets while the
      // carrier/native-bomb state is changing can crash Portal, especially with multiple players.
      rebuildHud: false,
      refreshBombNotice: true,
      refreshNextKey: true,
      updateCarrierHud: true,
      updateScores: true,
      updateIcons: true,
      syncCarrierVisuals: true,
      syncHybridSurface: true,
      pickupNoticeTeamId,
    },
    2
  );
  scheduleCipherNativeBombCarrierBindRetries(playerId, "carrier_assign_" + resolver);
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
    setBombBasePickupEnabled(false);
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
  setBombBasePickupEnabled(false);
  setBombBaseAvailabilityState(false);
  invalidateBombReturnToBaseTimer();
  return transferBombToPlayerAsCarrier(sp, false, "objective_disarm");
}

function clearDeferredBombCarrierDropTimer(): void {
  if (deferredBombCarrierDropTimer !== undefined) {
    cancelCipherGlobalTask(deferredBombCarrierDropTimer);
  }

  deferredBombCarrierDropTimer = undefined;
}

function invalidateDeferredBombCarrierDropTimer(): void {
  deferredBombCarrierDropToken += 1;
  clearDeferredBombCarrierDropTimer();
}

function isValidCipherDropPosition(pos: mod.Vector | undefined): pos is mod.Vector {
  if (!pos) return false;

  try {
    const x = mod.XComponentOf(pos);
    const y = mod.YComponentOf(pos);
    const z = mod.ZComponentOf(pos);

    return (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof z === "number" &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(z)
    );
  } catch (_err) {
    return false;
  }
}

function getSafeCipherCarrierDropPosition(playerId: number, override?: mod.Vector): mod.Vector | undefined {
  if (isValidCipherDropPosition(override)) return override;

  const resolved = getPlayerResolvedDropPosition(playerId);
  if (isValidCipherDropPosition(resolved)) return resolved;

  const activeSource = getActiveBombSourcePosition();
  if (isValidCipherDropPosition(activeSource)) return activeSource;

  return undefined;
}

function completeDisconnectedBombCarrierDrop(
  playerId: number,
  cachedDropPosition: mod.Vector | undefined,
  cachedCarrierTeam: mod.Team
): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== playerId) return;

  const dropPos = isValidCipherDropPosition(cachedDropPosition) ? cachedDropPosition : undefined;

  forceReleaseCipherNativeBombCarrier("disconnect_drop");
  clearBombCarrierState();
  clearBotObjectiveAssignments();
  cancelObjectiveCaptureAttemptsForPlayer(playerId);
  setBombBaseAvailabilityState(false);
  clearBombBaseRuntimeLootSpawner();
  invalidateBombReturnToBaseTimer();

  if (!dropPos) {
    clearDroppedBombRuntimeObjects();
    bombDroppedSourceKind = "none";
    invalidateDeferredBombSpawnTimer();
    refreshCipherKeyUiAndIconsImmediately("disconnect_drop_no_position");
    scheduleDeferredBombRespawnAfterDelay(0, "disconnect_carrier_drop_no_position", "new_location_found", true);
    botObjectiveNextThinkAtSec = 0;
    return;
  }

  if (!spawnDroppedBombAtPosition(dropPos)) {
    clearCipherNativeMinimapBomb("disconnect_drop_spawn_failed");
    clearDroppedBombRuntimeObjects();
    bombDroppedSourceKind = "none";
    invalidateDeferredBombSpawnTimer();
    refreshCipherKeyUiAndIconsImmediately("disconnect_drop_fallback");
    scheduleDeferredBombRespawnAfterDelay(0, "disconnect_carrier_drop_fallback_dynamic", "new_location_found", true);
    botObjectiveNextThinkAtSec = 0;
    return;
  }

  bombDroppedSourceKind = "carrier_drop";
  bombDroppedPickupAnchorPosition = dropPos;
  bombDroppedLastCarrierPlayerId = playerId;
  const dropNowSec = getCurrentSchedulerNowSeconds();
  bombDroppedLastCarrierBlockedUntilSec =
    dropNowSec + BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS;
  bombDroppedReclaimBlockedUntilSec = dropNowSec + 1.25;

  setBombBasePickupEnabled(false);

  const nativeDropPos = getCipherNativeMinimapBombPosition(dropPos);
  if (nativeDropPos) {
    spawnCipherNativeBombAtPosition(nativeDropPos, cachedCarrierTeam, "disconnect_carrier_drop_native_bomb");
  }

  refreshCipherKeyUiAndIconsImmediately("disconnect_carrier_drop");
  scheduleBombReturnToBaseAfterDelay();
  botObjectiveNextThinkAtSec = 0;
}

function scheduleBombCarrierDropAfterCombatEvent(
  playerId: number,
  reason: DeferredBombCarrierDropReason,
  dropPositionOverride?: mod.Vector,
  cachedTeamOverride?: mod.Team
): void {
  if (bombCarrierPlayerId === undefined) return;
  if (bombCarrierPlayerId !== playerId) return;

  deferredBombCarrierDropToken += 1;
  const token = deferredBombCarrierDropToken;
  const carrierSessionToken = playerSessionTokenByPlayerId[playerId];
  clearDeferredBombCarrierDropTimer();

  const cachedDropPosition = getSafeCipherCarrierDropPosition(playerId, dropPositionOverride);
  const cachedCarrier = serverPlayers.get(playerId);
  let cachedCarrierTeam = cachedTeamOverride ?? getCipherKeyTeamSnapshot(playerId) ?? cachedCarrier?.team ?? teamNeutral;
  if (!mod.Equals(cachedCarrierTeam, team1) && !mod.Equals(cachedCarrierTeam, team2)) {
    cachedCarrierTeam = teamNeutral;
  }

  // Do not drop the key directly inside OnMandown/OnPlayerDied/OnPlayerUndeploy.
  // Those event stacks are high-risk because they are already mutating soldier/combat state.
  deferredBombCarrierDropTimer = scheduleCipherGlobalTask(0.15, "carrier_drop/" + reason, () => {
    if (token !== deferredBombCarrierDropToken) return;
    deferredBombCarrierDropTimer = undefined;

    if (gameStatus !== 3) return;
    if (bombCarrierPlayerId !== playerId) return;
    if (reason !== "disconnect" && !isCurrentPlayerSession(playerId, carrierSessionToken)) return;

    try {
      if (reason === "disconnect") {
        completeDisconnectedBombCarrierDrop(playerId, cachedDropPosition, cachedCarrierTeam);
        return;
      }

      const finalDropPosition = getSafeCipherCarrierDropPosition(playerId, cachedDropPosition);

      if (!finalDropPosition) {
        clearBombCarrierState();
        clearDroppedBombRuntimeObjects();
        setBombBasePickupEnabled(false);
        setBombBaseAvailabilityState(false);
        scheduleDeferredBombRespawnAfterDelay(
          0,
          "deferred_carrier_drop_no_position",
          "new_location_found",
          true
        );
        botObjectiveNextThinkAtSec = 0;
        return;
      }

      forceBombDropFromCarrier(playerId, reason, finalDropPosition);
      botObjectiveNextThinkAtSec = 0;
    } catch (err) {
      LogRuntimeError("DeferredBombCarrierDrop/" + reason, err);

      // Fail safe: never leave the match locked with a dead carrier still holding the key.
      try {
        clearBombCarrierState();
        clearDroppedBombRuntimeObjects();
        setBombBasePickupEnabled(false);
        setBombBaseAvailabilityState(false);
        scheduleDeferredBombRespawnAfterDelay(0, "deferred_carrier_drop_failed", "new_location_found", true);
      } catch (fallbackErr) {
        LogRuntimeError("DeferredBombCarrierDropFallback/" + reason, fallbackErr);
      }
    }
  });
}

function forceBombDropFromCarrier(playerId: number, reason: string, dropPositionOverride?: mod.Vector): void {
  if (bombCarrierPlayerId === undefined) return;
  if (bombCarrierPlayerId !== playerId) return;

  const sp = serverPlayers.get(playerId);
  const replacedSlot = bombCarrierReplacedSlotByPlayerId[playerId];
  const previousEquipment = bombCarrierPreviousEquipmentByPlayerId[playerId];

  const shouldShowDropNotice =
    reason === "death" ||
    reason === "mandown" ||
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

  const dropPos = getSafeCipherCarrierDropPosition(playerId, dropPositionOverride);

  // Drop must detach the native Bomb from the carrier before script carrier state is cleared.
  // The dropped native Bomb is respawned at dropPos below after the scripted drop succeeds.
  forceReleaseCipherNativeBombCarrier("force_drop_" + reason);
  clearBombCarrierState();
  clearBotObjectiveAssignments();

  if (shouldShowDropNotice) {
    showCipherKeyDroppedNoticeForTeam(carrierTeamForNotice, playerId);
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

  cancelObjectiveCaptureAttemptsForPlayer(playerId);
  setBombBaseAvailabilityState(false);
  clearBombBaseRuntimeLootSpawner();
  invalidateBombReturnToBaseTimer();

  if (!dropPos) {
    clearCipherNativeMinimapBomb("force_drop_no_position_" + reason);
    clearDroppedBombRuntimeObjects();
    bombDroppedSourceKind = "none";
    invalidateDeferredBombSpawnTimer();
    refreshCipherKeyUiAndIconsImmediately("forceBombDropFromCarrier_no_position");
    scheduleDeferredBombRespawnAfterDelay(0, "carrier_drop_no_position", "new_location_found", true);
    return;
  }

  if (shouldShowDropNotice) {
    playBombDropOneShotAtPosition(dropPos);
  }

  if (!spawnDroppedBombAtPosition(dropPos)) {
    clearCipherNativeMinimapBomb("force_drop_spawn_failed_" + reason);
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
  const dropNowSec = getCurrentSchedulerNowSeconds();
  bombDroppedLastCarrierBlockedUntilSec =
    dropNowSec + BOMB_DROPPED_RECLAIM_PREVIOUS_CARRIER_COOLDOWN_SECONDS;
  // Do not let another bot instantly reclaim in the same frame as a carrier death.
  // This gives the native Bomb marker time to visibly drop before radius pickup resumes.
  bombDroppedReclaimBlockedUntilSec = dropNowSec + 1.25;

  setBombBasePickupEnabled(false);

  const nativeDropPos = getCipherNativeMinimapBombPosition(dropPos);
  if (nativeDropPos) {
    spawnCipherNativeBombAtPosition(nativeDropPos, carrierTeamForNotice, "carrier_drop_native_bomb");
  }

  refreshCipherKeyUiAndIconsImmediately("forceBombDropFromCarrier");

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
  setBombBasePickupEnabled(false);
  cacheBombPickupWorldAnchorPositions();
  setAllBaseWorldIconsEnabled(false);

  if (hideBaseIcon) {
    setBombBaseAvailabilityState(false);
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
      !isPlayerAliveSafe(carrier.player)
    ) {
      scheduleBombCarrierDropAfterCombatEvent(carrierId, "death", getSafeCipherCarrierDropPosition(carrierId));
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
  if (!bombBasePickupEnabled) return;

  const baseAnchor = tryGetActiveBasePickupAnchor();
  if (!baseAnchor) {
    setBombBasePickupEnabled(false);
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

  setBombBasePickupEnabled(false);
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

  setBombBasePickupEnabled(false);
  setBombBaseAvailabilityState(false);
}

function EvaluateResponsiveBombPickupRadiusScans(): void {
  if (gameStatus !== 3) return;
  if (bombCarrierPlayerId !== undefined) return;

  if (hasDroppedBombRuntimeObjects()) {
    EvaluateDroppedBombReclaimFromAnchor();
    return;
  }

  if (bombBasePickupEnabled) {
    EvaluateBaseBombPickupFromActiveBaseSlotRadius();
  }
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
      "set_cp_timing/" + context + "/" + String(cpId),
      mod.Message("[OBJECTIVE ENGINE] SetCapturePointTiming failed cp/context {}", String(cpId) + "/" + context)
    );
    LogRuntimeError("SetCapturePointTiming/" + context + "/" + String(cpId), err);
  }
}

function applyObjectiveLockedCaptureTiming(cpId: number): void {
  safeSetCapturePointTimingByCpId(
    cpId,
    OBJECTIVE_CAPTURE_LOCKED_CAPTURE_TIME,
    OBJECTIVE_CAPTURE_LOCKED_NEUTRALIZE_TIME,
    "applyObjectiveLockedCaptureTiming"
  );
}

function disableAllObjectiveCapturePointObjectives(context: string): void {
  disableAllScriptedObjectiveCapturePointSurfaces(context, true);
}

function isObjectiveCapturePointSurfaceActive(cpId: number): boolean {
  // CapturePoints are a permanent display layer for the active half. Node
  // reboot/award state is represented by the custom VFX and WorldIcons only.
  return isObjectiveCpId(cpId) && isObjectiveActiveForCurrentHalf(cpId);
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
  safeEnableCapturePointObjectiveByCpId(cpId, enabled, context + "_display_only_cp", force);
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

function syncDisabledBombAnchorObjectives(): void {
  disableSectorObjectiveByIdSafe(BOMB_ANCHOR_SECTOR_ID);
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

function clearObjectivePendingAward(cpId: number): void {
  objectivePendingAwardStartTickByCpId[cpId] = undefined;
  objectivePendingAwardStartAtSecByCpId[cpId] = undefined;
  objectivePendingAwardDeadlineAtSecByCpId[cpId] = undefined;
  objectivePendingAwardTeamByCpId[cpId] = teamNeutral;
  objectivePendingAwardTokenByCpId[cpId] = undefined;
  clearObjectiveDestroyExplosionPosition(cpId);
  syncObjectiveArmedPendingVisualStateForCp(cpId);
}

function isObjectiveDisabledAfterAward(cpId: number): boolean {
  return objectiveDisabledAfterAwardByCpId[cpId] === true;
}

function resetCipherNodeStates(context: string, refreshLiveIcons: boolean = true): void {
  const nextTokenByCpId: { [cpId: number]: number | undefined } = {};
  cipherNodeStateByCpId = {};
  cipherNodeRebootUntilSecByCpId = {};
  cipherNodeOverloadedByTeamByCpId = {};
  clearAllCipherNodeVisuals();
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

  if (gameStatus === 3 && refreshLiveIcons) {
    updateCipherCounterWorldIcons(true);
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
    clearCipherNodeVisualsForCp(cpId);
  }

  cipherCounterWorldIconLastShownByCpId = {};
  cipherCounterWorldIconLastStateByCpId = {};
  HideAllDeployObjectiveTimerUi();

  if (hideCounterIcons) {
    hideAllCipherCounterWorldIcons();
  }

  if (refreshLiveIcons && gameStatus === 3 && !isCipherLiveTransitionActive()) {
    updateCipherCounterWorldIcons(true);
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
  void playerId;
  void cpId;
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

  if (isObjectiveCaptureAttemptActive(cpId)) endObjectiveCaptureAttempt(cpId);
  // Keep the active-half CapturePoint marker visible while the node reboots.
  applyScriptedObjectiveCapturePointSurface(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    isObjectiveActiveForCurrentHalf(cpId),
    "startCipherNodeReboot/" + context,
    true
  );
  setObjectiveCaptureInteractEnabled(cpId, false);
  setObjectiveAwardVfxEnabled(cpId, false);
  setObjectiveAuthoritativeOwner(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    "startCipherNodeReboot/" + context
  );
  playObjectiveDisableEmpPresentationForCp(cpId, attackingTeam);
  playObjectiveAwardSuccessSfxToAll();

  clearObjectivePendingAward(cpId);
  clearObjectiveSuccessfulArmContext(cpId);
  clearBotObjectiveAssignments();
  updateCipherCounterWorldIconForCp(cpId, true);
  syncLiveHybridObjectiveSurfaceState("startCipherNodeReboot/" + context, true);
}

function reactivateCipherNode(cpId: number, token: number, context: string): void {
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
  updateCipherCounterWorldIconForCp(cpId, true);

}

function evaluateCipherNodeRebootDeadlines(nowSec: number): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    const deadline = cipherNodeRebootUntilSecByCpId[cpId];
    if (deadline === undefined || !Number.isFinite(deadline) || nowSec < deadline) continue;
    reactivateCipherNode(cpId, cipherNodeRebootTokenByCpId[cpId] ?? 0, "scheduler_deadline");
  }
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


  if (mod.IsPlayerValid(sp.player)) {
  }

  if (kind === "disarm" && mod.IsPlayerValid(sp.player)) {
  } else if (mod.IsPlayerValid(sp.player)) {
  }

  setObjectiveCaptureInteractEnabled(cpId, false);
  UpdateObjectiveHoldProgressUiForPlayer(sp);
}

function endObjectiveCaptureAttempt(cpId: number): void {

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

  UpdateObjectiveCaptureInteractionState();
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

function getCipherNodeVisualAnchorPositionForCp(cpId: number): mod.Vector | undefined {
  const snapshot = getCachedObjectiveAnchorPositionSnapshot(cpId);
  if (snapshot) {
    return mod.CreateVector(snapshot.x, snapshot.y + CIPHER_NODE_VISUAL_Y_OFFSET_METERS, snapshot.z);
  }

  const anchor = getObjectiveAnchorPosition(cpId);
  if (!anchor) return undefined;
  return mod.Add(anchor, mod.CreateVector(0, CIPHER_NODE_VISUAL_Y_OFFSET_METERS, 0));
}

function getCipherNodeBaseAnchorPositionForCp(cpId: number): mod.Vector | undefined {
  const snapshot = getCachedObjectiveAnchorPositionSnapshot(cpId);
  if (snapshot) return mod.CreateVector(snapshot.x, snapshot.y, snapshot.z);
  return getObjectiveAnchorPosition(cpId);
}

function getCipherNodePolygonCenterPositionForCp(cpId: number): mod.Vector | undefined {
  const base = getCipherNodeBaseAnchorPositionForCp(cpId);
  if (!base) return undefined;
  const offset = CIPHER_NODE_POLYGON_CENTER_OFFSET_BY_CP_ID[cpId];
  if (offset) return mod.Add(base, offset);
  return getCipherNodeVisualAnchorPositionForCp(cpId);
}

function getCipherNodePolygonEndpointPositionsForCp(cpId: number): mod.Vector[] {
  const base = getCipherNodeBaseAnchorPositionForCp(cpId);
  if (!base) return [];

  const offsets = CIPHER_NODE_POLYGON_VERTEX_OFFSETS_BY_CP_ID[cpId];
  if (!offsets || offsets.length <= 0) {
    const center = getCipherNodePolygonCenterPositionForCp(cpId);
    return center ? [center] : [];
  }

  const positions: mod.Vector[] = [];
  for (let i = 0; i < offsets.length; i++) {
    positions.push(mod.Add(base, offsets[i]));
  }
  return positions;
}

function getCipherNodeActiveVfxAssetForCp(_cpId: number): mod.RuntimeSpawn_Common {
  return CIPHER_NODE_ACTIVE_FRIENDLY_VFX_ASSET;
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
        mod.SetWorldIconPosition(handle!, pos);
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
    updateCipherNodeVisualForCp(cpId, false);
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
    setObjectiveAwardVfxEnabled(cpId, false);
    clearCipherNodeVisualsForCp(cpId);
    return;
  }

  configureCipherCounterRuntimeWorldIcon(cpId, team1, team1IconColor, force);
  configureCipherCounterRuntimeWorldIcon(cpId, team2, team2IconColor, force);
  setObjectiveAwardVfxEnabled(cpId, false);
  updateCipherNodeVisualForCp(cpId, force);
  cipherCounterWorldIconLastShownByCpId[cpId] = stateKey;
  cipherCounterWorldIconLastStateByCpId[cpId] = stateKey;
}

function updateCipherCounterWorldIcons(force: boolean = false): void {
  if (OBJECTIVE_DEFINITIONS.length <= 0) return;
  const def = OBJECTIVE_DEFINITIONS[cipherCounterWorldIconCursor % OBJECTIVE_DEFINITIONS.length];
  cipherCounterWorldIconCursor = (cipherCounterWorldIconCursor + 1) % OBJECTIVE_DEFINITIONS.length;
  if (def.half !== cipherCurrentHalf) {
    clearCipherCounterRuntimeWorldIconsForCp(def.cpId);
    clearCipherNodeVisualsForCp(def.cpId);
    delete cipherCounterWorldIconLastShownByCpId[def.cpId];
    delete cipherCounterWorldIconLastStateByCpId[def.cpId];
    return;
  }
  updateCipherCounterWorldIconForCp(def.cpId, force);
}

function forceTextOnlyWorldIcon(icon: mod.WorldIcon | undefined, textVisible: boolean = true): void {
  if (!icon) return;

  try {
    mod.EnableWorldIconImage(icon, false);
  } catch (_errImage) {}

  try {
    mod.EnableWorldIconText(icon, textVisible);
  } catch (_errText) {}
}

function hideAllCipherCounterWorldIcons(): void {
  clearAllCipherCounterRuntimeWorldIcons();
  clearAllCipherNodeVisuals();
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
  updateCipherCounterWorldIconForCp(cpId, true);

  const def = objectiveDefByCpId[cpId];
  if (!def) return;

  // Cipher node state changes only affect custom VFX/WorldIcons. The native
  // CapturePoint remains a locked, owned 3D landmark for the active half.
  applyScriptedObjectiveCapturePointSurface(
    cpId,
    def.defendingTeam,
    isObjectiveActiveForCurrentHalf(cpId) && (gameStatus === 0 || gameStatus === 2 || gameStatus === 3),
    "syncObjectiveArmedPendingVisualStateForCp",
    true
  );
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
    const objectivePos = getObjectiveAnchorPosition(cpId);
    if (objectivePos) return objectivePos;
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

  const objectivePos = getObjectiveAnchorPosition(cpId);
  if (objectivePos) return objectivePos;

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

function scheduleRuntimeFxCleanup(
  spawned: mod.VFX | mod.Object,
  delaySeconds: number
): void {
  scheduleCipherGlobalTask(delaySeconds, "runtime_fx_cleanup", () => {
    if (mod.IsType(spawned, mod.Types.VFX)) {
      try { mod.EnableVFX(spawned as mod.VFX, false); } catch (_err) {}
      return;
    }
    if (mod.IsType(spawned, mod.Types.Object)) {
      try { mod.UnspawnObject(spawned as mod.Object); } catch (_err) {}
    }
  });
}

function cleanupCipherNodeVisualHandle(spawned: mod.VFX | mod.Object | undefined): void {
  if (!spawned) return;
  if (mod.IsType(spawned, mod.Types.VFX)) {
    try { mod.EnableVFX(spawned as mod.VFX, false); } catch (_err) {}
    return;
  }
  if (mod.IsType(spawned, mod.Types.Object)) {
    unspawnObjectSafe(spawned as mod.Object, "cipher node visual", false);
  }
}

function cleanupCipherNodeVisualList(list: Array<mod.VFX | mod.Object> | undefined): void {
  if (!list) return;
  for (let i = 0; i < list.length; i++) cleanupCipherNodeVisualHandle(list[i]);
}

function clearCipherNodeLoopSfxForCp(cpId: number): void {
  const handle = cipherNodeLoopSfxHandleByCpId[cpId];
  stopBombLoopHandle(handle);
  const source = cipherNodeLoopSfxSourceByCpId[cpId];
  if (source) {
    if (source.object) unspawnObjectSafe(source.object, "cipher node loop sfx", false);
    else if (source.spawned) unspawnObjectSafe(source.spawned, "cipher node loop sfx spawned", false);
    else if (handle) unspawnObjectSafe(handle as unknown, "cipher node loop sfx handle", false);
  } else if (handle) {
    unspawnObjectSafe(handle as unknown, "cipher node loop sfx handle", false);
  }
  cipherNodeLoopSfxSourceByCpId[cpId] = undefined;
  cipherNodeLoopSfxHandleByCpId[cpId] = undefined;
}

function clearCipherNodeVisualsForCp(cpId: number): void {
  cleanupCipherNodeVisualList(cipherNodeActiveVfxByCpId[cpId]);
  cleanupCipherNodeVisualList(cipherNodeRebootVfxByCpId[cpId]);
  clearCipherNodeLoopSfxForCp(cpId);
  cipherNodeActiveVfxByCpId[cpId] = undefined;
  cipherNodeRebootVfxByCpId[cpId] = undefined;
  cipherNodeVisualModeByCpId[cpId] = "none";
  cipherNodeVisualLastReassertAtSecByCpId[cpId] = undefined;
}

function clearAllCipherNodeVisuals(): void {
  for (let i = 0; i < OBJECTIVE_AWARD_CP_IDS.length; i++) {
    clearCipherNodeVisualsForCp(OBJECTIVE_AWARD_CP_IDS[i]);
  }
}

function hasCipherNodeVisualHandlesForMode(cpId: number, mode: CipherNodeVisualMode): boolean {
  if (mode === "active") {
    const list = cipherNodeActiveVfxByCpId[cpId];
    const expectedCount = getCipherNodePolygonEndpointPositionsForCp(cpId).length;
    return !!(list && list.length >= expectedCount && expectedCount > 0 && cipherNodeLoopSfxHandleByCpId[cpId]);
  }
  if (mode === "rebooting") {
    const list = cipherNodeRebootVfxByCpId[cpId];
    return !!(list && list.length > 0 && cipherNodeLoopSfxHandleByCpId[cpId]);
  }
  return true;
}

function spawnCipherNodeLoopSfxForCp(cpId: number, asset: mod.RuntimeSpawn_Common, pos: mod.Vector): void {
  const source = spawnRuntimeSfxSourceAtPosition(asset, pos);

  const isRebootLoop = asset === CIPHER_NODE_REBOOT_SFX_ASSET;
  const volume = isRebootLoop ? CIPHER_NODE_REBOOT_LOOP_SFX_VOLUME : CIPHER_NODE_LOOP_SFX_VOLUME;
  const range = isRebootLoop ? CIPHER_NODE_REBOOT_LOOP_SFX_ATTENUATION_RANGE : CIPHER_NODE_LOOP_SFX_ATTENUATION_RANGE;

  const handle = tryPlayRuntimeSfxSource3D(
    source,
    volume,
    pos,
    range
  );

  if (!handle) {
    if (source.object) unspawnObjectSafe(source.object, "cipher node loop sfx failed", false);
    else if (source.spawned) unspawnObjectSafe(source.spawned, "cipher node loop sfx failed", false);
    return;
  }

  cipherNodeLoopSfxSourceByCpId[cpId] = source;
  cipherNodeLoopSfxHandleByCpId[cpId] = handle;
}

function updateCipherNodeVisualForCp(cpId: number, force: boolean = false): void {
  const activeForHalf = gameStatus === 3 && isObjectiveActiveForCurrentHalf(cpId);
  if (!activeForHalf) {
    clearCipherNodeVisualsForCp(cpId);
    return;
  }

  const mode: CipherNodeVisualMode = isCipherNodeRebooting(cpId) ? "rebooting" : "active";
  const nowSec = getCurrentSchedulerNowSeconds();
  const lastReassert = cipherNodeVisualLastReassertAtSecByCpId[cpId] ?? -999999;
  const needsReassert =
    force ||
    cipherNodeVisualModeByCpId[cpId] !== mode ||
    !hasCipherNodeVisualHandlesForMode(cpId, mode) ||
    nowSec - lastReassert >= CIPHER_NODE_VISUAL_REASSERT_SECONDS;
  if (!needsReassert) return;

  const centerPos = getCipherNodePolygonCenterPositionForCp(cpId);
  if (!centerPos) {
    clearCipherNodeVisualsForCp(cpId);
    return;
  }

  clearCipherNodeVisualsForCp(cpId);
  if (mode === "active") {
    const asset = getCipherNodeActiveVfxAssetForCp(cpId);
    const endpointPositions = getCipherNodePolygonEndpointPositionsForCp(cpId);
    const list: Array<mod.VFX | mod.Object> = [];
    for (let i = 0; i < endpointPositions.length; i++) {
      const vfx = spawnObjectiveAwardRuntimeFxAtPosition(asset, endpointPositions[i]);
      if (vfx) list.push(vfx);
    }
    cipherNodeActiveVfxByCpId[cpId] = list;
    spawnCipherNodeLoopSfxForCp(cpId, CIPHER_NODE_ACTIVE_SFX_ASSET, centerPos);
  } else {
    const list: Array<mod.VFX | mod.Object> = [];
    const endpointPositions = getCipherNodePolygonEndpointPositionsForCp(cpId);
    for (let i = 0; i < endpointPositions.length; i++) {
      const vfx = spawnObjectiveAwardRuntimeFxAtPosition(
        CIPHER_NODE_ACTIVE_ENEMY_VFX_ASSET,
        endpointPositions[i]
      );
      if (vfx) list.push(vfx);
    }
    cipherNodeRebootVfxByCpId[cpId] = list;
    spawnCipherNodeLoopSfxForCp(cpId, CIPHER_NODE_REBOOT_SFX_ASSET, centerPos);
  }

  cipherNodeVisualModeByCpId[cpId] = mode;
  cipherNodeVisualLastReassertAtSecByCpId[cpId] = nowSec;
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


function spawnObjectiveDisableFxOneShot(asset: mod.RuntimeSpawn_Common, pos: mod.Vector, lifetimeSeconds: number): void {
  const spawned = spawnObjectiveAwardRuntimeFxAtPosition(asset, pos);
  if (!spawned) return;
  scheduleRuntimeFxCleanup(spawned, lifetimeSeconds);
}

function playObjectiveDisableEmpPresentationForCp(cpId: number, ownerTeam: mod.Team): void {
  if (mod.Equals(ownerTeam, teamNeutral)) return;

  const pos = tryResolveObjectiveDestroyExplosionPosition(cpId);
  if (!pos) return;

  stopObjectiveAwardBurstForCp(cpId);
  stopObjectiveAwardPersistentFireForCp(cpId);
  setObjectiveAwardVfxEnabled(cpId, false);
  clearCipherNodeVisualsForCp(cpId);

  spawnObjectiveDisableFxOneShot(OBJECTIVE_DISABLE_EMP_HIT_ASSET, pos, 2.5);

  playRuntimeOneShotSfxAtPosition(
    OBJECTIVE_DISABLE_3D_SFX_ASSET,
    pos,
    1.0,
    90,
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
  applyScriptedObjectiveCapturePointSurface(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    isObjectiveActiveForCurrentHalf(cpId),
    "disableObjectiveAfterAwardSuccess",
    true
  );
  setObjectiveCaptureInteractEnabled(cpId, false);
  setObjectiveAwardVfxEnabled(cpId, false);
  playObjectiveDisableEmpPresentationForCp(cpId, ownerTeam);
  clearObjectivePendingAward(cpId);
  setObjectiveAuthoritativeOwner(
    cpId,
    getObjectiveDefendingTeamForCurrentHalf(cpId),
    "disableObjectiveAfterAwardSuccess"
  );
  clearObjectiveSuccessfulArmContext(cpId);
  clearBotObjectiveAssignments();

}

function resetObjectiveDisableAndAwardFxState(): void {
  stopAllObjectiveAwardBursts();
  clearAllCipherNodeVisuals();
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
  objectiveArmedWorldIconLastShownSecondsByCpId = {};
  objectiveCapturePointObjectiveEnabledByCpId = {};
  objectiveSurfaceSectorObjectiveEnabledBySectorId = {};
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
  }

}

function EvaluatePostCaptureAwardTimers(): void {
  if (gameStatus !== 3) return;
  // Key delivery resolves immediately; no native objective countdown is involved.
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

function clearCipherCarrierAfterDelivery(playerId: number | undefined): void {
  // Delivery must immediately clear the native Bomb carrier state.
  // Otherwise the engine can keep showing the previous carrier as holding the Bomb after score/delivery.
  removeCipherNativeBombCarrierState("cipher_key_delivered");
  clearCipherNativeMinimapBomb("cipher_key_delivered");

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
  setBombBasePickupEnabled(false);
  setBombBaseAvailabilityState(false);
  clearBombBaseRuntimeLootSpawner();
  clearDroppedBombRuntimeObjects();
  clearBotObjectiveAssignments();
}

function getCipherTeamScoreIndex(team: mod.Team): number {
  if (mod.Equals(team, team1)) return 0;
  if (mod.Equals(team, team2)) return 1;
  return -1;
}

function getCipherLeadingTeamFromTotalScores(): mod.Team {
  const t1 = serverScores[0] ?? 0;
  const t2 = serverScores[1] ?? 0;
  if (t1 > t2) return team1;
  if (t2 > t1) return team2;
  return teamNeutral;
}

function addCipherScore(attackingTeam: mod.Team): boolean {
  const scoreIndex = getCipherTeamScoreIndex(attackingTeam);
  if (scoreIndex < 0) return false;

  const currentTotalScore = serverScores[scoreIndex] ?? 0;

  if (cipherMatchStage === "half1") {
    const currentHalfScore = cipherHalfScores[scoreIndex] ?? 0;
    if (currentHalfScore >= HALF_SCORE_CAP) return false;
    cipherHalfScores[scoreIndex] = currentHalfScore + 1;
  } else if (cipherMatchStage === "half2") {
    if (currentTotalScore >= WIN_SCORE) return false;
    cipherHalfScores[scoreIndex] = (cipherHalfScores[scoreIndex] ?? 0) + 1;
  }

  serverScores[scoreIndex] = currentTotalScore + 1;
  return true;
}

type CipherDeliveryOutcome = "continue" | "halftime" | "suddenDeath" | "postmatch";

function resolveCipherDeliveryOutcome(scoringTeam: mod.Team): CipherDeliveryOutcome {
  if (mod.Equals(scoringTeam, teamNeutral)) return "continue";
  if (cipherMatchStage === "suddenDeath") return "postmatch";

  const scoreIndex = getCipherTeamScoreIndex(scoringTeam);
  if (scoreIndex < 0) return "continue";

  if (cipherMatchStage === "half1") {
    const halfCapReached = cipherHalfScores[scoreIndex] >= HALF_SCORE_CAP;
    return halfCapReached ? "halftime" : "continue";
  }

  if (cipherMatchStage === "half2") {
    return getCipherTeamTotalScore(scoringTeam) >= WIN_SCORE ? "postmatch" : "continue";
  }

  return getCipherTeamTotalScore(scoringTeam) >= WIN_SCORE ? "postmatch" : "continue";
}
function clearDeferredCipherDeliveryTransitionTimer(): void {
  if (cipherDeliveryTransitionTimer !== undefined) {
    cancelCipherGlobalTask(cipherDeliveryTransitionTimer);
  }

  cipherDeliveryTransitionTimer = undefined;
}

function invalidateDeferredCipherDeliveryTransition(): void {
  cipherDeliveryTransitionToken += 1;
  cipherDeliveryTransitionPending = false;
  clearDeferredCipherDeliveryTransitionTimer();
}

function scheduleCipherDeliveryPhaseTransition(
  outcome: CipherDeliveryOutcome,
  scoringTeam: mod.Team,
  source: string
): void {
  if (outcome === "continue") return;
  if (mod.Equals(scoringTeam, teamNeutral)) return;
  if (cipherDeliveryTransitionPending === true) return;
  if (isCipherLiveTransitionActive()) return;

  cipherDeliveryTransitionPending = true;
  cipherDeliveryTransitionToken += 1;
  const token = cipherDeliveryTransitionToken;

  clearDeferredCipherDeliveryTransitionTimer();

  // Never start halftime/postmatch/sudden-death directly inside the key-delivery stack.
  // Portal can freeze/crash when objective/UI/spawn/bot state is heavily mutated from that event path.
  cipherDeliveryTransitionTimer = scheduleCipherGlobalTask(0.25, "delivery_transition/" + source, () => {
    if (token !== cipherDeliveryTransitionToken) return;

    cipherDeliveryTransitionTimer = undefined;
    cipherDeliveryTransitionPending = false;

    if (gameStatus !== 3) return;
    if (isCipherLiveTransitionActive()) return;

    try {
      beginCipherDeliveryPhaseTransition(outcome, scoringTeam);
    } catch (err) {
      LogRuntimeError("DeferredCipherDeliveryTransition/" + source + "/" + outcome, err);

      // Hard fallback for the exact first-half 4-key crash case.
      // If the transition failed after the score cap, force the second-half supervisor from a clean timer stack.
      try {
        if (outcome === "halftime" && gameStatus === 3 && cipherMatchStage === "half1") {
          beginCipherSecondHalf(getCurrentSchedulerNowSeconds(), "scoreCap");
        } else if (outcome === "postmatch") {
          const winner = getCipherLeadingTeamFromTotalScores();
          enterPostmatchFromLive(mod.Equals(winner, teamNeutral) ? scoringTeam : winner);
        } else if (outcome === "suddenDeath") {
          beginCipherSuddenDeath(getCurrentSchedulerNowSeconds());
        }
      } catch (fallbackErr) {
        LogRuntimeError("DeferredCipherDeliveryTransitionFallback/" + source + "/" + outcome, fallbackErr);
      }
    }
  });
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

  const winner = getCipherLeadingTeamFromTotalScores();
  enterPostmatchFromLive(mod.Equals(winner, teamNeutral) ? scoringTeam : winner);
}

function finalizePendingObjectiveAwardsForImmediateTransition(context: string): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (!isObjectivePendingAwardActive(cpId)) continue;
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

  showCipherKeyDeliveryNoticeForTeam(attackingTeam, carrierPlayerId, deliveryPlayer, symbol);

  if (carrierPlayerId !== undefined) {
    const deliveryPos = getPlayerResolvedDropPosition(carrierPlayerId);
  }

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
  } else {
    // Do not switch sides/postmatch directly from the delivery stack.
    scheduleCipherDeliveryPhaseTransition(
      deliveryOutcome,
      attackingTeam,
      "handleCipherKeyDelivery_cp_" + String(cpId)
    );
  }

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
    defuserId !== undefined ? getPlayerResolvedDropPosition(defuserId) : getObjectiveAnchorPosition(cpId);

  clearObjectivePendingAward(cpId);

  if (defuser && mod.IsPlayerValid(defuser.player)) {
  }

  if (defuser && mod.IsPlayerValid(defuser.player)) {
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


  syncObjectiveArmedPendingVisualStateForCp(cpId);
  syncLiveHybridObjectiveSurfaceState("handleObjectiveDefuseSuccess", true);
}

function isObjectiveCpId(cpId: number): boolean {
  return getObjectiveDef(cpId) !== undefined;
}


function getObjectiveDisplayLaneForCpId(cpId: number): ObjectiveLetter | null {
  const def = getObjectiveDef(cpId);
  return def ? def.displayLane : null;
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

function getLaneStringKey(lane: ObjectiveLetter): any {
  if (lane === "A") return mod.stringkeys.FLAGA;
  if (lane === "B") return mod.stringkeys.FLAGB;
  if (lane === "C") return mod.stringkeys.FLAGC;
  return mod.stringkeys.FLAGD;
}

const TOP_HUD_NODE_FILL_BASE_ALPHA = 0.5;
const TOP_HUD_NODE_TEXT_BASE_ALPHA = 1.0;
const TOP_HUD_NODE_OUTLINE_BASE_ALPHA = 1.0;
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
  const authoredSectorMismatches: string[] = [];

  for (let i = 0; i < ALL_OBJECTIVE_CP_IDS.length; i++) {
    const cpId = ALL_OBJECTIVE_CP_IDS[i];
    const def = objectiveDefByCpId[cpId];
    if (!def) {
      missingDefs.push(cpId);
      continue;
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

  if (
    missingDefs.length === 0 &&
    missingWrappers.length === 0 &&
    idMismatches.length === 0 &&
    authoredSectorMismatches.length === 0
  ) {
    return;
  }

  if (!shouldEmitStringKeyDebugWorldLogs()) return;
  objectiveConfigWarningShown = true;
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[OBJECTIVE CONFIG] CP defs/wrappers/mismatches {}",
      (missingDefs.length > 0 ? missingDefs.join(",") : "none") +
        "/" +
        (missingWrappers.length > 0 ? missingWrappers.join(",") : "none") +
        "/" +
        (idMismatches.length > 0 ? idMismatches.join(",") : "none")
    )
  );
  emitStringKeyDebugWorldLog(
    mod.Message(
      "[OBJECTIVE AUTHORING] sectors {} | Cairo restricted trigger {}",
      authoredSectorMismatches.length > 0 ? authoredSectorMismatches.join(",") : "none",
      RESTRICTED_AREA_TRIGGER
    )
  );
}

function registerObjectivesDeterministically(): void {
  // Start from a clean objective layer. The active half is enabled later as locked, display-only CapturePoints.
  disableAllObjectiveCapturePointObjectives("registerObjectivesDeterministically");
  disableAllNeutralObjectiveCapturePointObjectives("registerObjectivesDeterministically");
  disableAllObjectiveSurfaceSectors("registerObjectivesDeterministically", true);
  disableAllObjectiveInteractPoints("registerObjectivesDeterministically");
}

function applyObjectiveRoundStartOwnership(resetRoundState: boolean = true): void {
  void resetRoundState;

  resetCipherNodeStates("applyObjectiveRoundStartOwnership");
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
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
  }
}

function applyObjectiveLiveHybridRoundStartState(resetRoundState: boolean = true): void {
  void resetRoundState;

  resetCipherNodeStates("applyObjectiveLiveHybridRoundStartState");
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  disableAllObjectiveCapturePointObjectives("applyObjectiveLiveHybridRoundStartState");
  disableAllNeutralObjectiveCapturePointObjectives("applyObjectiveLiveHybridRoundStartState");
  disableAllObjectiveSurfaceSectors("applyObjectiveLiveHybridRoundStartState", true);
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
  }

  syncLiveHybridObjectiveSurfaceState("applyObjectiveLiveHybridRoundStartState");
}

function beginCursorObjectiveLiveHybridRoundStartState(): void {
  resetCipherNodeStates("beginCursorObjectiveLiveHybridRoundStartState", false);
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  resetObjectiveRuntimeState();
  resetObjectiveDisableAndAwardFxState();
  disableAllObjectiveCapturePointObjectives("beginCursorObjectiveLiveHybridRoundStartState");
  disableAllNeutralObjectiveCapturePointObjectives("beginCursorObjectiveLiveHybridRoundStartState");
  disableAllObjectiveSurfaceSectors("beginCursorObjectiveLiveHybridRoundStartState", true);
  disableAllObjectiveInteractPoints("beginCursorObjectiveLiveHybridRoundStartState");
}

function applyCursorObjectiveLiveHybridRoundStartForIndex(index: number): void {
  const def = OBJECTIVE_DEFINITIONS[index];
  if (!def) return;
  const cp = serverCapturePoints[def.cpId];
  if (!cp) return;
  applyObjectiveLockedCaptureTiming(def.cpId);
  setObjectiveAuthoritativeOwner(
    def.cpId,
    getObjectiveDefendingTeamForCurrentHalf(def.cpId),
    "applyCursorObjectiveLiveHybridRoundStartForIndex"
  );
  clearObjectivePendingAward(def.cpId);
}

function getConfiguredInitialTransitionHqObjIdForTeam(team: mod.Team): number {
  return getCipherLiveHqIdForTeam(team);
}

function isCurrentLiveHqIdForTeam(team: mod.Team, hqId: number): boolean {
  return hqId === getCipherLiveHqIdForTeam(team);
}

function tryDeployPlayerSafe(player: mod.Player, context: string): boolean {
  if (!mod.IsPlayerValid(player)) return false;
  try {
    mod.DeployPlayer(player);
    return true;
  } catch (err) {
    LogRuntimeError("DeployPlayer/" + context, err);
    return false;
  }
}

function warnTransitionSpawnOnce(key: string, message: any): void {
  void key;
  void message;
}

function warnTransitionSpawnDebugOnce(key: string, message: any): void {
  void key;
  void message;
}

function resetTransitionSpawnQueueState(clearWarnings: boolean = false): void {
  transitionSpawnRequestedByPlayerId = {};
  transitionSpawnLastAttemptTickByPlayerId = {};
  transitionSpawnInFlightByPlayerId = {};
  transitionSpawnSessionTokenByPlayerId = {};
  transitionSpawnExpectedGameStatusByPlayerId = {};
  transitionSpawnExpectedMatchStageByPlayerId = {};
  transitionSpawnExpectedTransitionTokenByPlayerId = {};
  transitionSpawnDueTickByPlayerId = {};
  if (clearWarnings) transitionSpawnWarnedByKey = {};
}

function clearTransitionSpawnStateForPlayer(playerId: number): void {
  delete transitionSpawnRequestedByPlayerId[playerId];
  delete transitionSpawnInFlightByPlayerId[playerId];
  delete transitionSpawnLastAttemptTickByPlayerId[playerId];
  delete transitionSpawnSessionTokenByPlayerId[playerId];
  delete transitionSpawnExpectedGameStatusByPlayerId[playerId];
  delete transitionSpawnExpectedMatchStageByPlayerId[playerId];
  delete transitionSpawnExpectedTransitionTokenByPlayerId[playerId];
  delete transitionSpawnDueTickByPlayerId[playerId];
}

function snapshotReadyTransitionHumans(): void {
  const teamOne: Player[] = [];
  const teamTwo: Player[] = [];
  const players = getValidHumanPlayersSnapshot();
  for (let i = 0; i < players.length; i++) {
    const team = mod.GetTeam(players[i].player);
    if (mod.Equals(team, team1)) teamOne.push(players[i]);
    else if (mod.Equals(team, team2)) teamTwo.push(players[i]);
  }
  teamOne.sort((a, b) => a.id - b.id);
  teamTwo.sort((a, b) => a.id - b.id);
  readyTransitionHumanPlayerIds = [];
  readyTransitionSessionTokenByPlayerId = {};
  const count = Math.max(teamOne.length, teamTwo.length);
  for (let i = 0; i < count; i++) {
    const pair = [teamOne[i], teamTwo[i]];
    for (let j = 0; j < pair.length; j++) {
      const player = pair[j];
      if (!player) continue;
      readyTransitionHumanPlayerIds.push(player.id);
      readyTransitionSessionTokenByPlayerId[player.id] = ensurePlayerSessionToken(player.id);
    }
  }
}

function configureReadyTransitionDeployDueTicks(): void {
  const count = readyTransitionHumanPlayerIds.length;
  for (let i = 0; i < count; i++) {
    const fraction = count <= 1 ? 0 : i / (count - 1);
    const offset = Math.round((1 + 8 * fraction) * TICK_RATE);
    transitionSpawnDueTickByPlayerId[readyTransitionHumanPlayerIds[i]] = serverTickCount + offset;
  }
}

function areReadyTransitionHumansTerminal(): boolean {
  for (let i = 0; i < readyTransitionHumanPlayerIds.length; i++) {
    const playerId = readyTransitionHumanPlayerIds[i];
    const expectedSession = readyTransitionSessionTokenByPlayerId[playerId];
    if (expectedSession === undefined || !isCurrentPlayerSession(playerId, expectedSession)) continue;
    const player = getValidHumanPlayerById(playerId);
    if (!player) continue;
    if (!player.isDeployed || transitionSpawnRequestedByPlayerId[playerId] === true) return false;
  }
  return !hasPendingPhasePlayerOperations("undeploy");
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
    if (cipherSecondHalfTransitionStage !== "deploy") {
      return;
    }
  }

  if (transitionSpawnRequestedByPlayerId[playerId] === true) return;
  transitionSpawnRequestedByPlayerId[playerId] = true;
  transitionSpawnSessionTokenByPlayerId[playerId] = ensurePlayerSessionToken(playerId);
  transitionSpawnExpectedGameStatusByPlayerId[playerId] = gameStatus;
  transitionSpawnExpectedMatchStageByPlayerId[playerId] = cipherMatchStage;
  transitionSpawnExpectedTransitionTokenByPlayerId[playerId] = getQueuedPlayerWorkTransitionToken();
  warnTransitionSpawnDebugOnce(
    "queued/" + source + "/" + String(playerId),
    mod.Message(
      "[TRANSITION SPAWN] queued player/source/snapshot {}",
      String(playerId) + "/" + source + "/" + getTransitionSpawnQueueSnapshot()
    )
  );
}


function requestTransitionSpawnForAllTransitionPlayers(source: string): void {
  const players = getValidHumanPlayersSnapshot();
  for (let i = 0; i < players.length; i++) {
    requestTransitionSpawn(players[i].id, source);
  }
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
  const players = getValidHumanPlayersSnapshot();

  for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
    const sp = players[playerIndex];
    if (spawnAttemptsThisTick >= CIPHER_TRANSITION_SPAWN_JOBS_PER_TICK) break;
    const playerId = sp.id;
    if (transitionSpawnRequestedByPlayerId[playerId] !== true) continue;
    requestedCount += 1;

    const expectedGameStatus = transitionSpawnExpectedGameStatusByPlayerId[playerId];
    const expectedMatchStage = transitionSpawnExpectedMatchStageByPlayerId[playerId];
    if (
      expectedGameStatus === undefined ||
      expectedMatchStage === undefined ||
      !isQueuedPlayerWorkCurrent(
        playerId,
        transitionSpawnSessionTokenByPlayerId[playerId],
        expectedGameStatus,
        expectedMatchStage,
        transitionSpawnExpectedTransitionTokenByPlayerId[playerId] ?? 0
      )
    ) {
      clearTransitionSpawnStateForPlayer(playerId);
      continue;
    }

    if (!mod.IsPlayerValid(sp.player)) continue;
    if (isCipherRuntimeBotPlayerId(playerId) || isBotBackfillPlayerSafe(sp.player)) {
      clearTransitionSpawnStateForPlayer(playerId);
      continue;
    }

    if (sp.isDeployed) {
      handleCipherTransitionDeployedPlayer(playerId, sp.player, source + "_deployed");
      clearTransitionSpawnStateForPlayer(playerId);
      continue;
    }

    const lastAttemptTick = transitionSpawnLastAttemptTickByPlayerId[playerId] ?? -999999;
    const dueTick = transitionSpawnDueTickByPlayerId[playerId] ?? serverTickCount;
    if (serverTickCount < dueTick) continue;
    if (transitionSpawnInFlightByPlayerId[playerId] === true) continue;

    if (serverTickCount - lastAttemptTick < TRANSITION_SPAWN_MIN_RETRY_TICKS) continue;

    const team = mod.GetTeam(sp.player);
    const hqObjId = getCipherLiveHqIdForTeam(team);
    if (!isCurrentLiveHqIdForTeam(team, hqObjId)) {
      warnTransitionSpawnOnce(
        "missing_hq/" + source + "/" + String(playerId),
        mod.Message(
          "[TRANSITION SPAWN] invalid HQ player/source/hq/snapshot {}",
          String(playerId) + "/" + source + "/" + String(hqObjId) + "/" + getTransitionSpawnQueueSnapshot()
        )
      );
      continue;
    }

    transitionSpawnInFlightByPlayerId[playerId] = true;
    transitionSpawnLastAttemptTickByPlayerId[playerId] = serverTickCount;
    spawnAttemptsThisTick += 1;
    requestCipherSpawnAnchorForPlayer(playerId, true);
    mod.SetRedeployTime(sp.player, 0);
    applyPhaseInputRestrictionsForPlayer(sp.player);
    const spawned = tryDeployPlayerSafe(sp.player, "transition_spawn_queue/" + source);
    if (!spawned) {
      transitionSpawnInFlightByPlayerId[playerId] = false;
      warnTransitionSpawnOnce(
        "spawn_fail/" + source + "/" + String(playerId),
        mod.Message(
          "[TRANSITION SPAWN] native deploy failed player/source/snapshot {}",
          String(playerId) + "/" + source + "/" + getTransitionSpawnQueueSnapshot()
        )
      );
    }
  }

  let undeployedCount = 0;
  let undeployedRequestedCount = 0;
  for (let i = 0; i < players.length; i++) {
    const sp = players[i];
    if (sp.isDeployed) continue;
    undeployedCount += 1;
    if (transitionSpawnRequestedByPlayerId[sp.id] === true) undeployedRequestedCount += 1;
  }

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
  const players = getValidHumanPlayersSnapshot();

  for (let i = 0; i < players.length; i++) {
    const sp = players[i];
    if (!mod.IsPlayerValid(sp.player)) continue;

    const team = mod.GetTeam(sp.player);
    sp.setTeam();

    if (mod.Equals(team, team1) || mod.Equals(team, team2)) continue;
    valid = false;

    if (preliveTeamSanityWarnedByPlayerId[sp.id] === true) continue;
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
  }

  return valid;
}

function validatePreLiveTransitionSpawnPrerequisites(): boolean {
  const t1HqObjId = getCipherLiveHqIdForTeam(team1);
  const t2HqObjId = getCipherLiveHqIdForTeam(team2);
  const t1Ok = isCurrentLiveHqIdForTeam(team1, t1HqObjId);
  const t2Ok = isCurrentLiveHqIdForTeam(team2, t2HqObjId);
  if (t1Ok && t2Ok) return true;

  warnTransitionSpawnOnce(
    "prelive_prereq_missing",
    mod.Message(
      "[TRANSITION SPAWN] configured HQ missing t1/t2/snapshot {}",
      String(t1HqObjId) + "/" + String(t2HqObjId) + "/" + getTransitionSpawnQueueSnapshot()
    )
  );
  return false;
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

function clearSquadSpawnBypassLater(playerId: number): void {
  const sessionGeneration = playerSessionTokenByPlayerId[playerId];
  const lifeGeneration = getPlayerLifeGeneration(playerId);
  scheduleCipherGlobalTask(SQUAD_SPAWN_BYPASS_LIFETIME_SECONDS, "squad_spawn_bypass/" + String(playerId), () => {
    if (!isCurrentPlayerSession(playerId, sessionGeneration)) return;
    if (getPlayerLifeGeneration(playerId) !== lifeGeneration) return;
    squadSpawnBypass[playerId] = false;
  });
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

function consumeCipherRouteForNativeFriendlySpawn(eventPlayer: mod.Player, playerId: number): void {
  delete cipherQueuedAnchorByPlayerId[playerId];
  clearCipherSpawnJobsForPlayer(playerId);
  squadSpawnBypass[playerId] = true;
  clearSquadSpawnBypassLater(playerId);

  if (bombCarrierPlayerId === playerId) {
    syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "NativeFriendlyOrSquadSpawn_NoTeleport");
  }
  queueCipherAdminInteractSpawnForPlayer(playerId, "native_friendly_or_squad_spawn");
}

/* =================================================================================================
   5) AUDIO (SFX / VO)
================================================================================================= */

let audioInitialized = false;
let SFX_ReadyUp: any = null;
let SFX_CountdownHeartbeat: any = null;
let SFX_MatchStartStinger: any = null;
let SFX_ObjectiveDisabledUi: any = null;
let SFX_BombSpawnStinger2D: any = null;
// End-of-round suspense loops
let SFX_Endgame_WinningLoop: any = null;
let SFX_Endgame_LosingLoop: any = null;
// Restricted Area countdown loop
let SFX_OutOfBoundsCountdownLoop: any = null;


// Track per-player state so loops never stack
let endgameLoopStateByPlayerId: { [playerId: number]: "none" | "win" | "lose" } = {};


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

// Per-player endgame loop tokens guard the cosmetic suspense task.
let endgameLoopTokenByPlayerId: { [playerId: number]: number } = {};
let endgameLoopModeByPlayerId: { [playerId: number]: "none" | "win" | "lose" } = {};

function ensureAudioSpawned(): void {
  if (audioInitialized) return;
  audioInitialized = true;

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


}

function forEachPlayerOnTeam(team: mod.Team, fn: (p: Player) => void): void {
  serverPlayers.forEach((p) => {
    if (mod.Equals(mod.GetTeam(p.player), team)) fn(p);
  });
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
      if (SFX_Endgame_WinningLoop) mod.PlaySound(SFX_Endgame_WinningLoop, 0, sp.player);
    } else {
      if (SFX_CountdownHeartbeat) mod.PlaySound(SFX_CountdownHeartbeat, 0, sp.player);
    }

    await mod.Wait(ENDGAME_LOOP_INTERVAL_SECONDS);
  }
}

function StopAllEndgameLoops(): void {
  serverPlayers.forEach((p) => stopEndgameLoop(p.id));
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

function playPostMatchResultSfxForPlayer(p: Player): void {
  if (!p || !mod.IsPlayerValid(p.player)) return;
  const winner = getWinningTeam();
  if (mod.Equals(winner, teamNeutral)) return;
  const t = mod.GetTeam(p.player);
  if (mod.Equals(t, winner)) {
    if (SFX_PostMatchVictory) mod.PlaySound(SFX_PostMatchVictory, 1.0, p.player);
  } else if (mod.Equals(t, team1) || mod.Equals(t, team2)) {
    if (SFX_PostMatchDefeat) mod.PlaySound(SFX_PostMatchDefeat, 1.0, p.player);
  }
}


/* =================================================================================================
   6) UI (PARSE UI + PER-PLAYER HUD)
================================================================================================= */
/* Track HUD build state so we can build once and then only toggle/update */
let liveHudBuiltByPlayerId: { [playerId: number]: boolean } = {}; // reused name to avoid touching lots of code paths
let liveHudBuiltSessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
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

const POSTMATCH_SHOWCASE_PARENT_ID = WORLD_IDS.postmatch.anchor;
const POSTMATCH_CAMERA_ID = WORLD_IDS.postmatch.camera;
const POSTMATCH_RESULT_TEXT_Y = -360;
const POSTMATCH_SCORE_TEXT_Y = -295;
const POSTMATCH_RESULT_TEXT_WIDTH = 900;
const POSTMATCH_RESULT_TEXT_HEIGHT = 120;
const POSTMATCH_SCORE_TEXT_WIDTH = 160;
const POSTMATCH_SCORE_TEXT_HEIGHT = 56;
const POSTMATCH_END_TIMER_TEXT_Y = -160;
const POSTMATCH_END_TIMER_TEXT_WIDTH = 900;
const POSTMATCH_END_TIMER_TEXT_HEIGHT = 44;
const POSTMATCH_END_TIMER_TEXT_SIZE = 26;

type PostmatchShowcaseStatKind = "eliminations" | "destroyed" | "keyTime" | "moralSupport";

type PostmatchShowcaseSlot = {
  anchorId: number;
  statKind: PostmatchShowcaseStatKind;
  player: Player;
  statValue: number;
};

const POSTMATCH_SHOWCASE_SCREEN_X = [-346.76, -136.88, 82.13, 301.14];
const POSTMATCH_SHOWCASE_PLAYER_Y = -225.09;
const POSTMATCH_SHOWCASE_STAT_Y = 139.92;
const POSTMATCH_SHOWCASE_CARD_WIDTH = 206.46;
const POSTMATCH_SHOWCASE_CARD_HEIGHT = 74.33;

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
    key: "most_nodes_ciphered_pedestal",
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
    key: "most_nodes_ciphered_anchor",
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
const SCREEN_UI_REFERENCE_HEIGHT = 1080;


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
            LIVE_SCORE_NODE_ROW_LEFT,
            LIVE_SCORE_NODE_ROW_TOP,
            LIVE_SCORE_NODE_SIZE,
            LIVE_SCORE_NODE_SIZE
          ),
          size: [LIVE_SCORE_NODE_SIZE, LIVE_SCORE_NODE_SIZE],
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
            LIVE_SCORE_NODE_ROW_LEFT + (LIVE_SCORE_NODE_SIZE + LIVE_SCORE_NODE_GAP),
            LIVE_SCORE_NODE_ROW_TOP,
            LIVE_SCORE_NODE_SIZE,
            LIVE_SCORE_NODE_SIZE
          ),
          size: [LIVE_SCORE_NODE_SIZE, LIVE_SCORE_NODE_SIZE],
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
            LIVE_SCORE_NODE_ROW_LEFT + ((LIVE_SCORE_NODE_SIZE + LIVE_SCORE_NODE_GAP) * 2),
            LIVE_SCORE_NODE_ROW_TOP,
            LIVE_SCORE_NODE_SIZE,
            LIVE_SCORE_NODE_SIZE
          ),
          size: [LIVE_SCORE_NODE_SIZE, LIVE_SCORE_NODE_SIZE],
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
            LIVE_SCORE_NODE_ROW_LEFT + ((LIVE_SCORE_NODE_SIZE + LIVE_SCORE_NODE_GAP) * 3),
            LIVE_SCORE_NODE_ROW_TOP,
            LIVE_SCORE_NODE_SIZE,
            LIVE_SCORE_NODE_SIZE
          ),
          size: [LIVE_SCORE_NODE_SIZE, LIVE_SCORE_NODE_SIZE],
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
      name: "Text_Mode_Cipher",
      type: "Text",
      position: [72, 22],
      size: [130, 42],
      anchor: mod.UIAnchor.TopCenter,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.Text_Mode_Cipher,
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
  const p = getValidHumanPlayerById(playerId);
  if (!p) return undefined;
  p.player = player;

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
  playerLifecyclePrematchRefreshPending = true;

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
  playerLifecyclePrematchRefreshPending = true;
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

function setLiveScorePanelVisible(visible: boolean): void {
  // Always hide the old shared objective HUD.
  // Cipher uses per-player widgets now.
  const rootHudWidgets = [
    "BG_Score_Container",
    "Container_A",
    "Container_B",
    "Container_C",
    "Container_D",
    "friendlyscore",
    "enemyscore",
    "matchtime",
    "LiveTimerIntroContainer",
  ];

  for (let i = 0; i < rootHudWidgets.length; i++) {
    const widget = mod.FindUIWidgetWithName(rootHudWidgets[i]);
    if (!widget) continue;
    SafeSetWidgetVisibleHandle(widget, false);
  }

  // Hard hide everything when leaving live/postmatch/prelive/countdown.
  if (!visible) {
    hideCipherLiveHudForAllPlayersHard();
    return;
  }

  serverPlayers.forEach((p) => {
    if (!p) return;

    const playerId = p.id;

    // Core live score HUD.
    // These should show during live.
    const coreLiveHudWidgets = [
      getPlayerLiveHudRootWidgetName(playerId),

      CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId,

      CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId,
      CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId,

      CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
      CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
      CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,
      CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,

      CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX + playerId,
      CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId,

      CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
      CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
    ];

    for (let i = 0; i < coreLiveHudWidgets.length; i++) {
      const widget = SafeFindWidget(coreLiveHudWidgets[i]);
      SafeSetWidgetVisibleHandle(widget, true);
    }

    // Runtime-controlled widgets are NOT force-shown here.
    // Their own systems decide when to show:
    // - carrier text
    // - ticker fills
    // - key event banner
    // - dropped key banner
    // - next key unlock countdown
    UpdateTopTicketBarsForPlayer(p);
  });

  SetUITime();
  UpdateBombCarrierUiForAllPlayers();
  refreshBombNoticeUiForAllPlayers();
  refreshNextKeyUnlockHudForAllPlayers(undefined, true);
}

function forceHideCipherLiveHudForPlayer(p: Player): void {
  const playerId = p.id;

  const widgets = [
    getPlayerLiveHudRootWidgetName(playerId),

    CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId,

    CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId,

    CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
    CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,

    CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX + playerId,

    CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
    CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,

    BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + playerId,

    NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId,
  ];

  for (let i = 0; i < widgets.length; i++) {
    const widget = mod.FindUIWidgetWithName(widgets[i]);
    if (!widget) continue;
    SafeSetWidgetVisibleHandle(widget, false);
  }

  // These are the stubborn fill containers that were surviving into postmatch.
  // Hide them by visibility AND alpha.
  const fillWidgets = [
    CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
  ];

  for (let i = 0; i < fillWidgets.length; i++) {
    const widget = mod.FindUIWidgetWithName(fillWidgets[i]);
    if (!widget) continue;
    SafeSetWidgetVisibleHandle(widget, false);
    try { mod.SetUIWidgetBgAlpha(widget, 0); } catch (_errAlpha) {}
  }
}

function hideCipherLiveHudForAllPlayersHard(): void {
  queuePhaseUiCleanupForKnownPlayers();
}

function hideCipherLiveHudForAllPlayers(): void {
  hideCipherLiveHudForAllPlayersHard();
}

/* -----------------------------------------------------------------------------------------------
   Match start Cipher splash
------------------------------------------------------------------------------------------------ */

const MATCH_START_BANNER_SHOW_SECONDS = 2.0;
let matchStartBannerRunning = false;
let hasShownMatchStartBanner = false;
let matchStartBannerToken = 0;

function resetMatchStartBannerState(resetShown: boolean = false): void {
  matchStartBannerToken += 1;
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
      position: safeRootPosFromTopCenter(0, 248, 650, 34),
      size: [650, 34],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0,
      bgFill: mod.UIBgFill.None,
      textLabel: (mod.stringkeys as any).CipherSplashSubtitle,
      textColor: [0.78, 0.82, 0.9],
      textAlpha: 1,
      textSize: 23,
      textAnchor: mod.UIAnchor.TopCenter,
    },
    {
      name: "Intro_CIPHER_Text",
      type: "Text",
      position: safeRootPosFromTopCenter(0, 196, 720, 76),
      size: [720, 76],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [0.13, 0.15, 0.18],
      bgAlpha: 0.86,
      bgFill: mod.UIBgFill.Blur,
      textLabel: mod.stringkeys.Text_CipherObliteration,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: 72,
      textAnchor: mod.UIAnchor.Center,
    },
    {
      name: "Intro_CIPHER_Line_Left",
      type: "Container",
      position: safeRootPosFromTopCenter(-410, 196, 96, 76),
      size: [96, 76],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [0.10, 0.55, 1.0],
      bgAlpha: 0.9,
      bgFill: mod.UIBgFill.GradientRight,
    },
    {
      name: "Intro_CIPHER_Line_Right",
      type: "Container",
      position: safeRootPosFromTopCenter(410, 196, 96, 76),
      size: [96, 76],
      anchor: mod.UIAnchor.Center,
      visible: true,
      padding: 0,
      bgColor: [1.0, 0.18, 0.72],
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
  matchStartBannerToken += 1;
  const token = matchStartBannerToken;
  let root: mod.UIWidget | undefined = undefined;

  try {
    await mod.Wait(0.8); // Wait for the match start stinger to finish playing
    if (token !== matchStartBannerToken || gameStatus !== 3) return;

    root = mod.FindUIWidgetWithName("Container_0NX1G");
    const textW = mod.FindUIWidgetWithName("Intro_CIPHER_Text");
    const subtitleW = mod.FindUIWidgetWithName("Text_Cipher_Presents");
    const leftW = mod.FindUIWidgetWithName("Intro_CIPHER_Line_Left");
    const rightW = mod.FindUIWidgetWithName("Intro_CIPHER_Line_Right");

    if (!root || !textW || !subtitleW || !leftW || !rightW) {
      return;
    }

    hasShownMatchStartBanner = true;
    mod.SetUIWidgetDepth(root!, mod.UIDepth.AboveGameUI);
    mod.SetUIWidgetVisible(root!, true);

    mod.SetUIWidgetBgAlpha(textW, 1);
    mod.SetUITextAlpha(textW, 1);
    mod.SetUITextAlpha(subtitleW, 1);
    SafeSetTextSizeHandle(textW, 72);

    mod.SetUIWidgetBgAlpha(leftW, 1);
    mod.SetUIWidgetBgAlpha(rightW, 1);

    for (let i = 0; i < 10; i++) {
      const progress = (i + 1) / 10;
      const titleSize = mod.Floor(Lerp(72, 46, progress));
      SafeSetTextSizeHandle(textW, titleSize);
      await mod.Wait(0.1);
      if (token !== matchStartBannerToken || gameStatus !== 3) return;
    }

    await mod.Wait(MATCH_START_BANNER_SHOW_SECONDS);
    if (token !== matchStartBannerToken || gameStatus !== 3) return;

    let currentLerpValue = 0;
    let lerpIncrement = 0;

    while (currentLerpValue < 1.0) {
      lerpIncrement += 0.1;
      currentLerpValue = Lerp(currentLerpValue, 1, lerpIncrement);

      const a = 1 - currentLerpValue;

      mod.SetUIWidgetBgAlpha(textW, a);
      mod.SetUITextAlpha(textW, a);
      mod.SetUITextAlpha(subtitleW, a);
      mod.SetUIWidgetBgAlpha(leftW, a);
      mod.SetUIWidgetBgAlpha(rightW, a);

      await mod.Wait(0.1);
      if (token !== matchStartBannerToken || gameStatus !== 3) return;
    }

    mod.SetUIWidgetVisible(root!, false);
  } catch (err) {
    LogRuntimeError("showMatchStartBannerOnce", err);
    if (root) {
      try {
        mod.SetUIWidgetVisible(root!, false);
      } catch (_hideErr) {}
    }
  } finally {
    if (token === matchStartBannerToken) matchStartBannerRunning = false;
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

  serverPlayers.forEach((playerInfo) => {
    if (!playerInfo) return;
    deletePrematchButtonWidgetsForPlayer(playerInfo.player);
  });
}
// Prematch roster UI lists centered player names with a light separator line under each row.

let prematchRosterTeam1Lines: (mod.UIWidget | null)[] = [];
let prematchRosterTeam2Lines: (mod.UIWidget | null)[] = [];
let prematchRosterBuildCursor = 0;
let prematchRosterBuildParent: mod.UIWidget | null = null;
let prematchRosterUpdateActive = false;
let prematchRosterUpdateDirty = false;
let prematchRosterUpdateCursor = 0;
let prematchRosterUpdateTeam1: Player[] = [];
let prematchRosterUpdateTeam2: Player[] = [];
let prematchRosterUpdateLayout: PrematchPanelLayout | undefined = undefined;

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
  prematchRosterBuildCursor = 0;
  prematchRosterBuildParent = null;
  prematchRosterUpdateActive = false;
  prematchRosterUpdateDirty = false;
  prematchRosterUpdateCursor = 0;
  prematchRosterUpdateTeam1 = [];
  prematchRosterUpdateTeam2 = [];
  prematchRosterUpdateLayout = undefined;
  prematchPanelLayoutKey = "";
}

function setStaticPrematchPanelWidgetsVisible(visible: boolean): void {
  const staticNames = [
    "Text_Cipher_Esports",
    "Text_Mode_Cipher",
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
  // Hiding the two roots hides every roster/ready child immediately. Deleting or
  // re-finding every child here created multi-thousand-call transition frames.
  SafeSetWidgetVisibleByName("PreMatchContainer", false);
  SafeSetWidgetVisibleByName(PREMATCH_PANEL_WIDGET_NAME, false);
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
    } else if (p.isDeployed) {
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

    const parent = prematchRosterBuildParent ?? SafeFindWidget(PREMATCH_PANEL_WIDGET_NAME);
    if (!parent) {
      warnPrematchUiGuardOnce(
        "prematch_roster_parent_missing",
        mod.Message("[PREMATCH ROSTER] missing parent widget {}", PREMATCH_PANEL_WIDGET_NAME)
      );
      return;
    }

    try {
      if (!prematchRosterBuildParent) {
        prematchRosterBuildParent = parent;
        const initialLayout = computePrematchPanelLayoutFromServerPlayers();
        applyPrematchPanelLayout(initialLayout, true);
        prematchRosterTeam1 = [];
        prematchRosterTeam2 = [];
        prematchRosterTeam1Lines = [];
        prematchRosterTeam2Lines = [];
        prematchRosterBuildCursor = 0;
      }

      const startY = PREMATCH_ROSTER_START_Y;
      const rowH = PREMATCH_ROSTER_ROW_HEIGHT;

      const textW = PREMATCH_ROSTER_TEXT_WIDTH;
      const textH = PREMATCH_ROSTER_TEXT_HEIGHT;

      const lineW = PREMATCH_ROSTER_LINE_WIDTH;
      const lineH = PREMATCH_ROSTER_LINE_HEIGHT;

      if (prematchRosterBuildCursor < MAX_ROSTER_LINES) {
          const i = prematchRosterBuildCursor;
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
          prematchRosterBuildCursor += 1;
          return;
      }
      prematchRosterBuilt = true;
      prematchRosterBuildParent = null;
    } catch (err) {
      LogRuntimeError("BuildPrematchRosterUI", err);
      warnPrematchUiGuardOnce(
        "prematch_roster_build_failed",
        mod.Message("[PREMATCH ROSTER] build failed (see runtime error log)")
      );
      resetPrematchRosterBuildState();
    }
}

function UpdatePrematchRosterUI(): void {
    if (gameStatus !== 0) return;
    if (!prematchRosterBuilt) {
      BuildPrematchRosterUI();
      if (!prematchRosterBuilt) return;
    }

    try {
      if (!prematchRosterUpdateActive) {
        prematchRosterUpdateTeam1 = [];
        prematchRosterUpdateTeam2 = [];
        serverPlayers.forEach((p) => {
            const t = mod.GetTeam(p.player);
            if (mod.Equals(t, team1)) prematchRosterUpdateTeam1.push(p);
            else if (mod.Equals(t, team2)) prematchRosterUpdateTeam2.push(p);
        });
        prematchRosterUpdateTeam1.sort((a, b) => a.id - b.id);
        prematchRosterUpdateTeam2.sort((a, b) => a.id - b.id);
        prematchRosterUpdateLayout = computePrematchPanelLayout(
          prematchRosterUpdateTeam1.length,
          prematchRosterUpdateTeam2.length
        );
        applyPrematchPanelLayout(prematchRosterUpdateLayout);
        prematchRosterUpdateCursor = 0;
        prematchRosterUpdateActive = true;
        prematchRosterUpdateDirty = false;
      }

      const layout = prematchRosterUpdateLayout;
      if (!layout) return;
      if (prematchRosterUpdateCursor >= MAX_ROSTER_LINES) {
        prematchRosterUpdateActive = false;
        prematchRosterUpdateLayout = undefined;
        return;
      }

      const i = prematchRosterUpdateCursor++;
      const updateTeamRow = (
        widget: mod.UIWidget | null,
        line: mod.UIWidget | null,
        players: Player[]
      ): void => {
        if (!widget || !line) return;
        if (i < players.length && i < layout.visibleRows) {
          const p = players[i];
          const ready = isBotBackfillPlayer(p.player) ? true : p.isReady();
          SafeSetWidgetVisibleHandle(widget, true);
          SafeSetWidgetVisibleHandle(line, true);
          SafeSetTextColorHandle(widget, ready ? mod.CreateVector(0, 1, 0) : mod.CreateVector(1, 0, 0));
          SafeSetTextLabelHandle(
            widget,
            ready
              ? mod.Message(mod.stringkeys.RosterReadyLine, p.player)
              : mod.Message(mod.stringkeys.RosterNotReadyLine, p.player)
          );
        } else {
          SafeSetWidgetVisibleHandle(widget, false);
          SafeSetWidgetVisibleHandle(line, false);
          SafeSetTextLabelHandle(widget, mod.Message(""));
        }
      };
      updateTeamRow(prematchRosterTeam1[i], prematchRosterTeam1Lines[i], prematchRosterUpdateTeam1);
      updateTeamRow(prematchRosterTeam2[i], prematchRosterTeam2Lines[i], prematchRosterUpdateTeam2);
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
  prematchRosterUpdateDirty = true;
  UpdatePrematchRosterUI();
}
/* -----------------------------------------------------------------------------------------------
   Per-player ReadyText (prematch)
------------------------------------------------------------------------------------------------ */

function getPrematchReadyTextWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ReadyText", playerId, sessionToken);
}

function replacePrematchReadyText(playerId: number, receiver: mod.Player): void {
  const readyTextName = getPrematchReadyTextWidgetName(playerId);
  safeDeleteWidgetByName("ReadyText" + playerId);
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
  const name = getPrematchReadyTextWidgetName(playerId);
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

function deletePlayerLiveHudWidgets(playerId: number, privateSessionToken?: number): void {
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
  safeDeleteWidgetByName(CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId);

  safeDeleteWidgetByName("FriendlyScorePulse" + playerId);
  safeDeleteWidgetByName("EnemyScorePulse" + playerId);
  safeDeleteWidgetByName("Text_BombCarrier" + playerId);
  safeDeleteWidgetByName("Text_BombNotice" + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName("Text_BombDroppedDeath" + playerId);
  safeDeleteWidgetByName(getPlayerLiveHudRootWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldArmingFillWidgetName(playerId, privateSessionToken));
  safeDeleteWidgetByName(getObjectiveHoldDisarmingFillWidgetName(playerId, privateSessionToken));
  safeDeleteWidgetByName(getObjectiveHoldArmingTextWidgetName(playerId, privateSessionToken));
  safeDeleteWidgetByName(getObjectiveHoldDisarmingTextWidgetName(playerId, privateSessionToken));
  safeDeleteWidgetByName(getObjectiveHoldContainerWidgetName(playerId, privateSessionToken));
  safeDeleteWidgetByName(getObjectiveHoldRootWidgetName(playerId, privateSessionToken));
  safeDeleteWidgetByName("ObjectiveHoldFillArming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldFillDisarming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldTextArming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldTextDisarming" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldContainer" + playerId);
  safeDeleteWidgetByName("ObjectiveHoldRoot" + playerId);
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneFillWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneTextWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerTitleWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerValueWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerPanelWidgetName(playerId, privateSessionToken));
  safeDeleteAllWidgetsByName(getDeployObjectiveTimerRootWidgetName(playerId, privateSessionToken));
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
  liveHudBuiltByPlayerId[playerId] = false;
  delete liveHudBuiltSessionTokenByPlayerId[playerId];
}

const PLAYER_LIVE_HUD_ROOT_WIDGET_NAME_PREFIX = "Container_SAFE_SCREEN_";
const CIPHER_UI_PANEL_BG_COLOR = mod.CreateVector(0.2, 0.2, 0.2);
const CIPHER_UI_TRACK_BG_COLOR = mod.CreateVector(0.3294, 0.3686, 0.3882);
const CIPHER_UI_GREY_TEXT_COLOR = mod.CreateVector(0.86, 0.9, 0.95);
const CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX = "Container_SCOREPANEL_";
const CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX = "Container_FRIENDLY_SCORE_BOX_";
const CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX = "Container_ENEMY_SCORE_BOX_";
const CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX = "Text_FRIENDLY_SCORE_";
const CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX = "Text_ENEMY_SCORE_";
const CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX = "Container_MATCH_TIME_BOX_";
const CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX = "Text_MATCH_TIME_";
const CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX = "Container_SCORE_LEAD_";
const CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX = "Text_SCORE_LEAD_";
const CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX = "Text_CARRIER_NAME_";
const CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX = "Container_FRIENDLY_TICKER_BG_";
const CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX = "Container_FRIENDLY_TICKER_FILL_";
const CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX = "Container_ENEMY_TICKER_BG_";
const CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX = "Container_ENEMY_TICKER_FILL_";
// -------------------------------------------------------------------------------------------------
// Cipher live HUD positions
// Score panel stays TopLeft.
// Event banner and next-key countdown use Center anchor with X = 0.
// -------------------------------------------------------------------------------------------------

// -------------------------------------------------------------------------------------------------
// Score panel nudged down a little.
// Old top was 42. New top is 60.
// -------------------------------------------------------------------------------------------------

const CIPHER_LIVE_PANEL_POS = mod.CreateVector(42, 60, 0);
const CIPHER_LIVE_PANEL_SIZE = mod.CreateVector(268, 104, 0);

const CIPHER_SCORE_BOX_POS = mod.CreateVector(54, 69, 0);
const CIPHER_ENEMY_SCORE_BOX_POS = mod.CreateVector(54, 115, 0);
const CIPHER_SCORE_BOX_SIZE = mod.CreateVector(68, 38, 0);

const CIPHER_LIVE_TIME_BOX_POS = mod.CreateVector(36, 17, 0);
const CIPHER_LIVE_TIME_BOX_SIZE = mod.CreateVector(100, 50, 0);
const CIPHER_LIVE_TIME_TEXT_POS = mod.CreateVector(36, 17, 0);
const CIPHER_LIVE_TIME_TEXT_SIZE = mod.CreateVector(100, 50, 0);
const CIPHER_LIVE_TIME_TEXT_FONT_SIZE = 24;

const CIPHER_LIVE_STATUS_POS = mod.CreateVector(122, 23, 0);
const CIPHER_LIVE_STATUS_SIZE = mod.CreateVector(100, 50, 0);

const CIPHER_FRIENDLY_PROGRESS_POS = mod.CreateVector(122, 77, 0);
const CIPHER_ENEMY_PROGRESS_POS = mod.CreateVector(122, 123, 0);

const CIPHER_SCORE_PROGRESS_WIDTH = 188;
const CIPHER_SCORE_PROGRESS_HEIGHT = 22;
const CIPHER_SCORE_TICKER_CAP = 8;

const CIPHER_LIVE_CARRIER_STATUS_POS = mod.CreateVector(34, 140, 0);
const CIPHER_LIVE_CARRIER_STATUS_SIZE = mod.CreateVector(276, 50, 0);

const CIPHER_SCORE_TEXT_SIZE = 24;
const CIPHER_STATUS_TEXT_SIZE = 20;

// Half size from 18. This fixes "YOU ARE CARRYING KEY" being too big.
const CIPHER_CARRIER_STATUS_TEXT_SIZE = 9;

const BOMB_CARRIER_WIDGET_NAME_PREFIX = CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX;
const BOMB_CARRIER_WIDGET_POS = CIPHER_LIVE_CARRIER_STATUS_POS;
const BOMB_CARRIER_WIDGET_SIZE = CIPHER_LIVE_CARRIER_STATUS_SIZE;
const BOMB_CARRIER_WIDGET_BG_COLOR = CIPHER_UI_PANEL_BG_COLOR;
const BOMB_CARRIER_WIDGET_TEXT_COLOR = mod.CreateVector(1, 1, 1);

const BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX = "Container_KEY_EVENT_BANNER_";
const BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX = "Container_OUTLINE_";
const BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX = "Container_DROPPED_KEY_";
const BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX = "Container_DROPPED_KEY_OUTLINE_";
const BOMB_NOTICE_WIDGET_NAME_PREFIX = "Text_KEY_EVENT_TEXT_";
const BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX = "Text_DROPPED_KEY_";
const BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX = "Container_PLAYER_NAME_";
const BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX = "Text_PLAYER_NAME_";

// Center event banner.
// X = 0 means true screen center.
// Y is raised higher than before.
const CIPHER_EVENT_BANNER_CENTER_Y = -382;
// This is the "NEXT KEY UNLOCKS IN 00:17" countdown banner.
// More negative Y = higher on screen.
const CIPHER_NEXT_KEY_BANNER_CENTER_Y = CIPHER_EVENT_BANNER_CENTER_Y - 75;

const BOMB_NOTICE_WIDGET_POS = mod.CreateVector(0, CIPHER_EVENT_BANNER_CENTER_Y, 0);
const BOMB_NOTICE_OUTLINE_POS = BOMB_NOTICE_WIDGET_POS;
const BOMB_NOTICE_TEXT_POS = BOMB_NOTICE_WIDGET_POS;

const BOMB_NOTICE_CONTAINER_SIZE = mod.CreateVector(464, 72, 0);
const BOMB_NOTICE_WIDGET_SIZE = mod.CreateVector(430, 50, 0);

// Left-side dropped-key banner.
const BOMB_DROPPED_NOTICE_POS = mod.CreateVector(42, 276, 0);
const BOMB_DROPPED_NOTICE_SIZE = mod.CreateVector(318, 56, 0);
const BOMB_DROPPED_NOTICE_TEXT_POS = mod.CreateVector(70, 279, 0);
const BOMB_DROPPED_NOTICE_TEXT_SIZE_VECTOR = mod.CreateVector(262, 50, 0);
const BOMB_DROPPED_PLAYER_CONTAINER_POS = mod.CreateVector(41, 242, 0);
const BOMB_DROPPED_PLAYER_CONTAINER_SIZE = mod.CreateVector(172, 32, 0);
const BOMB_DROPPED_PLAYER_TEXT_POS = mod.CreateVector(41, 233, 0);
const BOMB_DROPPED_PLAYER_TEXT_SIZE_VECTOR = mod.CreateVector(100, 50, 0);

const BOMB_NOTICE_WIDGET_BG_COLOR = CIPHER_UI_PANEL_BG_COLOR;
const BOMB_NOTICE_WIDGET_TEXT_COLOR = mod.CreateVector(1, 1, 1);
const BOMB_NOTICE_WIDGET_TEXT_SIZE = 30;
const BOMB_NOTICE_DETAIL_TEXT_SIZE = 24;
const BOMB_NOTICE_PLAYER_TEXT_SIZE = 24;
const BOMB_NOTICE_DURATION_SECONDS = 4.0;

const NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX = "Container_NextKeyUnlock_";
const NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX = "Text_NextKeyUnlock_";

// Key unlock countdown uses the same centered raised banner lane.
const NEXT_KEY_UNLOCK_WIDGET_POS = mod.CreateVector(0, CIPHER_NEXT_KEY_BANNER_CENTER_Y, 0);
const NEXT_KEY_UNLOCK_TEXT_POS = NEXT_KEY_UNLOCK_WIDGET_POS;
const NEXT_KEY_UNLOCK_CONTAINER_SIZE = BOMB_NOTICE_CONTAINER_SIZE;
const NEXT_KEY_UNLOCK_WIDGET_SIZE = mod.CreateVector(430, 50, 0);
const NEXT_KEY_UNLOCK_WIDGET_BG_COLOR = BOMB_NOTICE_WIDGET_BG_COLOR;
const NEXT_KEY_UNLOCK_WIDGET_TEXT_COLOR = mod.CreateVector(1, 1, 1);
const NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE = 24;
const NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET = mod.CreateVector(0, 1.15, 0);
const DROPPED_KEY_WORLD_ICON_OFFSET = NEXT_KEY_UNLOCK_WORLD_ICON_OFFSET;
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
  p.friendlyScoreWidget = SafeFindWidget(CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + p.id) as any;
  p.opponentScoreWidget = SafeFindWidget(CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + p.id) as any;
  p.friendlyScorePadWidget = null as any;
  p.opponentScorePadWidget = null as any;
  p.bombCarrierTextWidget = SafeFindWidget(BOMB_CARRIER_WIDGET_NAME_PREFIX + p.id) as any;
  p.bombNoticeContainerWidget = SafeFindWidget(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
  p.bombNoticeLeftAccentWidget = SafeFindWidget(BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + p.id) as any;
  p.bombNoticeRightAccentWidget = SafeFindWidget(BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + p.id) as any;
  p.bombNoticeTextWidget = SafeFindWidget(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id) as any;
  p.bombNoticeDetailWidget = SafeFindWidget(BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + p.id) as any;
  p.nextKeyUnlockContainerWidget = SafeFindWidget(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
  p.nextKeyUnlockTextWidget = SafeFindWidget(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + p.id) as any;
  p.bombCarrierUiLastVisible = false;
  p.bombCarrierUiLastVersion = -1;
  p.bombCarrierUiLastAlphaBucket = -1;
  p.bombNoticeUiLastStateKey = "";
  p.nextKeyUnlockHudLastStateKey = "";
  markCipherKeyHudReadyForPlayer(p.id, hasCipherKeyHudWidgetRefs(p));
}

function bindPlayerCipherKeyHudWidgetRefs(p: Player, force: boolean = false): void {
  if (force || !p.bombCarrierTextWidget) p.bombCarrierTextWidget = SafeFindWidget(BOMB_CARRIER_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.bombNoticeContainerWidget) p.bombNoticeContainerWidget = SafeFindWidget(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.bombNoticeLeftAccentWidget) p.bombNoticeLeftAccentWidget = SafeFindWidget(BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.bombNoticeRightAccentWidget) p.bombNoticeRightAccentWidget = SafeFindWidget(BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.bombNoticeTextWidget) p.bombNoticeTextWidget = SafeFindWidget(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.bombNoticeDetailWidget) p.bombNoticeDetailWidget = SafeFindWidget(BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.nextKeyUnlockTextWidget) p.nextKeyUnlockTextWidget = SafeFindWidget(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + p.id) as any;
  if (force || !p.nextKeyUnlockContainerWidget) p.nextKeyUnlockContainerWidget = SafeFindWidget(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
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
    CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId,
    CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
    CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId,
    CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX + playerId,
    CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
    CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
    CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
    BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId,
    NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId,
  ];

  for (let i = 0; i < names.length; i++) {
    const widget = SafeFindWidget(names[i]);
    if (!widget) continue;
    SafeSetWidgetDepthHandle(widget, mod.UIDepth.AboveGameUI);
  }
}


function hasValidRootTopScoreWidgets(playerId: number): boolean {
  const liveHudRoot = SafeFindWidget(getPlayerLiveHudRootWidgetName(playerId));
  const friendlyScore = SafeFindWidget(CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId);
  const enemyScore = SafeFindWidget(CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId);
  const friendlyScoreBox = SafeFindWidget(CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId);
  const enemyScoreBox = SafeFindWidget(CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId);
  const timeBox = SafeFindWidget(CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId);
  const timeText = SafeFindWidget(CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId);
  const livePanel = SafeFindWidget(CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId);
  const liveStatus = SafeFindWidget(CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId);
  const carrierStatus = SafeFindWidget(CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX + playerId);
  const friendlyProgressBg = SafeFindWidget(CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId);
  const friendlyProgressFill = SafeFindWidget(CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId);
  const enemyProgressBg = SafeFindWidget(CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId);
  const enemyProgressFill = SafeFindWidget(CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId);
  const bombCarrier = SafeFindWidget(BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId);
  const bombNoticeContainer = SafeFindWidget(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  const bombNoticeLeftAccent = SafeFindWidget(BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + playerId);
  const bombNoticeRightAccent = SafeFindWidget(BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + playerId);
  const bombNotice = SafeFindWidget(BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId);
  const bombNoticeDetail = SafeFindWidget(BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + playerId);
  const bombNoticePlayer = SafeFindWidget(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + playerId);
  const nextKeyUnlockContainer = SafeFindWidget(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  const nextKeyUnlock = SafeFindWidget(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId);

  if (
    !liveHudRoot ||
    !friendlyScore ||
    !enemyScore ||
    !friendlyScoreBox ||
    !enemyScoreBox ||
    !timeBox ||
    !timeText ||
    !livePanel ||
    !liveStatus ||
    !carrierStatus ||
    !friendlyProgressBg ||
    !friendlyProgressFill ||
    !enemyProgressBg ||
    !enemyProgressFill ||
    !bombCarrier ||
    !bombNoticeContainer ||
    !bombNoticeLeftAccent ||
    !bombNoticeRightAccent ||
    !bombNotice ||
    !bombNoticeDetail ||
    !bombNoticePlayer ||
    !nextKeyUnlockContainer ||
    !nextKeyUnlock
  ) {
    return false;
  }

  return true;
}

function rebuildPlayerTopScoreWidgets(p: Player, skipDelete: boolean = false): boolean {
  const playerId = p.id;
  const targetPlayer = p.player;

  if (!skipDelete) {
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
  safeDeleteWidgetByName(CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId);
  safeDeleteWidgetByName("Text_BombDroppedDeath" + playerId);
  safeDeleteWidgetByName(getPlayerLiveHudRootWidgetName(playerId));
  }

  const addHudNode = (node: any): void => {
    modlib.ParseUI({
      ...node,
      playerId: targetPlayer,
    });
  };

  try {
    // Dummy root only exists so the rest of the runtime can find the player's live HUD root.
    // The visible HUD pieces below are intentionally root-positioned for stable Portal rendering.
    addHudNode({
      name: getPlayerLiveHudRootWidgetName(playerId),
      type: "Container",
      position: [0, 0],
      size: [1, 1],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0,
      bgFill: mod.UIBgFill.None,
    });

    // Score panel shell.
    addHudNode({
      name: CIPHER_LIVE_PANEL_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [42, 60],
      size: [268, 104],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
    });

    // Hidden match-time widgets kept only because existing runtime code expects them.
        // Time remaining box above the score boxes.
    addHudNode({
      name: CIPHER_LIVE_TIME_BOX_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [36, 17],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.3294, 0.3686, 0.3882],
      bgAlpha: 0.8,
      bgFill: mod.UIBgFill.Blur,
    });

    addHudNode({
      name: CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [36, 17],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.TimeDefault,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: CIPHER_LIVE_TIME_TEXT_FONT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    // Winning / losing / tied label.
    addHudNode({
      name: CIPHER_LIVE_STATUS_CONTAINER_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [122, 23],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
    });

    addHudNode({
      name: CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [122, 5],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: getStringMessageWithFallback((mod.stringkeys as any).CipherStatusTie, "TIE"),
      textColor: [0.2902, 0.4471, 0.6588],
      textAlpha: 1,
      textSize: CIPHER_STATUS_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    // Friendly score box and score text.
    addHudNode({
      name: CIPHER_FRIENDLY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [54, 69],
      size: [68, 38],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.3294, 0.3686, 0.3882],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Blur,
    });

    addHudNode({
      name: CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [38, 63],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.Message((mod.stringkeys as any).Text_FRIENDLY_SCORE, getFriendlyScore(mod.GetTeam(targetPlayer))),
      textColor: [0.1255, 0.3725, 0.6941],
      textAlpha: 1,
      textSize: CIPHER_SCORE_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    // Friendly ticker bar.
    addHudNode({
      name: CIPHER_FRIENDLY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [122, 77],
      size: [188, 22],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.3294, 0.3686, 0.3882],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Blur,
    });

    addHudNode({
      name: CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [122, 77],
      size: [1, 22],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.2196, 0.4196, 0.6863],
      bgAlpha: 0.8,
      bgFill: mod.UIBgFill.Solid,
    });

    // Enemy score box and score text.
    addHudNode({
      name: CIPHER_ENEMY_SCORE_BOX_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [54, 115],
      size: [68, 38],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2118, 0.2235, 0.2353],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Blur,
    });

    addHudNode({
      name: CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [38, 109],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.Message((mod.stringkeys as any).Text_ENEMY_SCORE, getOpponentScore(mod.GetTeam(targetPlayer))),
      textColor: [0.8235, 0.098, 0.098],
      textAlpha: 1,
      textSize: CIPHER_SCORE_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    // Enemy ticker bar.
    addHudNode({
      name: CIPHER_ENEMY_PROGRESS_BG_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [122, 123],
      size: [188, 22],
      anchor: mod.UIAnchor.TopLeft,
      visible: true,
      padding: 0,
      bgColor: [0.3294, 0.3686, 0.3882],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Blur,
    });

    addHudNode({
      name: CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [122, 123],
      size: [1, 22],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.8235, 0.098, 0.098],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Solid,
    });

    // Carrier status text under the score panel.
    addHudNode({
      name: BOMB_CARRIER_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [34, 140],
      size: [276, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: getStringMessageWithFallback((mod.stringkeys as any).CipherYouCarryingKey, "YOU ARE CARRYING KEY"),
      textColor: [0.2863, 0.4353, 0.6431],
      textAlpha: 1,
      textSize: CIPHER_CARRIER_STATUS_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    // Top-center key event banner container.
    addHudNode({
      name: BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [0, CIPHER_EVENT_BANNER_CENTER_Y],
      size: [464, 72],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0.2902, 0.4392, 0.6431],
      bgAlpha: 0.58,
      bgFill: mod.UIBgFill.Blur,
    });

    // Top-center key event outline.
    // Color is overwritten at runtime by friendly/enemy tone.
    addHudNode({
      name: BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [0, CIPHER_EVENT_BANNER_CENTER_Y],
      size: [464, 72],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0.10, 0.55, 1.00],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.OutlineThick,
    });

    // Top-center key event text.
    addHudNode({
      name: BOMB_NOTICE_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [0, CIPHER_EVENT_BANNER_CENTER_Y],
      size: [430, 50],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.EmptyText,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: BOMB_NOTICE_WIDGET_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    // Left dropped-key banner.
    addHudNode({
      name: BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [42, 276],
      size: [318, 56],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.6588, 0.2667, 0.2549],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.Blur,
    });

    addHudNode({
      name: BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [70, 279],
      size: [262, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.EmptyText,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: BOMB_NOTICE_DETAIL_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    addHudNode({
      name: BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [41, 242],
      size: [172, 32],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.5922, 0.2627, 0.251],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.Solid,
    });

    addHudNode({
      name: BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [41, 233],
      size: [100, 50],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.EmptyText,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: BOMB_NOTICE_PLAYER_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });

    addHudNode({
      name: BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [42, 276],
      size: [318, 56],
      anchor: mod.UIAnchor.TopLeft,
      visible: false,
      padding: 0,
      bgColor: [1, 1, 1],
      bgAlpha: 1,
      bgFill: mod.UIBgFill.OutlineThin,
    });

    // Top-center next-key countdown container.
    // This is intentionally higher than the key event banner.
    addHudNode({
      name: NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + playerId,
      type: "Container",
      position: [0, CIPHER_NEXT_KEY_BANNER_CENTER_Y],
      size: [464, 72],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0.2, 0.2, 0.2],
      bgAlpha: 0.5,
      bgFill: mod.UIBgFill.Blur,
    });

    // Top-center next-key countdown text.
    addHudNode({
      name: NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + playerId,
      type: "Text",
      position: [0, CIPHER_NEXT_KEY_BANNER_CENTER_Y],
      size: [430, 50],
      anchor: mod.UIAnchor.Center,
      visible: false,
      padding: 0,
      bgColor: [0, 0, 0],
      bgAlpha: 0,
      bgFill: mod.UIBgFill.None,
      textLabel: mod.stringkeys.EmptyText,
      textColor: [1, 1, 1],
      textAlpha: 1,
      textSize: NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE,
      textAnchor: mod.UIAnchor.Center,
    });
  } catch (_errBuild) {
    return false;
  }

  bindPlayerTopScoreWidgetRefs(p);
  setTopScoreWidgetDepthForPlayer(playerId);
  refreshBombNoticeUiForPlayer(p, undefined, true);
  refreshNextKeyUnlockHudForPlayer(p, undefined, true);

  return hasValidRootTopScoreWidgets(playerId);
}

function isValidUiWidgetName(widgetName: string | undefined | null): widgetName is string {
  if (typeof widgetName !== "string") return false;
  return widgetName.trim().length > 0;
}

function safeDeleteWidgetByName(widgetName: string): void {
  if (!isValidUiWidgetName(widgetName)) return;
  let widget: mod.UIWidget | undefined = undefined;
  try {
    widget = mod.FindUIWidgetWithName(widgetName);
  } catch (_errFind) {
    return;
  }
  if (!widget) return;

  try {
    mod.DeleteUIWidget(widget);
  } catch (_err) {}
}

function safeDeleteAllWidgetsByName(widgetName: string): void {
  if (!isValidUiWidgetName(widgetName)) return;

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
  return "";
}

function getCipherAdminPanelWidgetName(playerId: number): string {
  return "";
}

function getCipherAdminTitleWidgetName(playerId: number): string {
  return "";
}

function getCipherAdminStatusWidgetName(playerId: number): string {
  return "";
}

function getCipherAdminActionCountWidgetName(playerId: number): string {
  return "";
}

function getCipherAdminButtonWidgetName(playerId: number, action: CipherAdminAction): string {
  return "";
}

function getCipherAdminButtonLabelWidgetName(playerId: number, action: CipherAdminAction): string {
  return "";
}

function getCipherAdminButtonBorderWidgetName(playerId: number, action: CipherAdminAction): string {
  return "";
}

function getCipherAdminActions(): CipherAdminAction[] {
  return undefined as any;
}

function getCipherAdminToggleBotsLabelKey(): any {
  return undefined as any;
}

function isCipherHumanServerPlayer(p: Player | undefined): boolean {
  if (!p || !mod.IsPlayerValid(p.player)) return false;
  if (isCipherRuntimeBotPlayerId(p.id)) return false;
  if (isBotBackfillPlayerSafe(p.player)) return false;
  return true;
}

function ensureCipherAdminAssigned(): void {
  return;
}

function assignCipherAdminFromJoiningPlayerIfNeeded(player: mod.Player): void {
  return;
}

function isCipherAdminPlayer(player: mod.Player): boolean {
  return false;
}

function getCipherAdminStatusStringKey(hasClock: boolean): any {
  return undefined as any;
}

function getCipherAdminCurrentClockRemainingSeconds(nowSec: number): number | undefined {
  return 0;
}

function getCipherAdminStatusLabel(): any {
  return undefined as any;
}

function refreshCipherAdminPanelForPlayerId(playerId: number): void {
  return;
}

function refreshCipherAdminPanels(): void {
  return;
}

function enableCipherAdminButtonEvents(widget: mod.UIWidget | undefined | null, enabled: boolean): void {
  return;
}

function disableCipherAdminButtonEventsForPlayerId(playerId: number): void {
  return;
}

function deleteCipherAdminPanelForPlayerId(playerId: number): void {
  return;
}

function clearCipherAdminPanelDeleteTimerForPlayerId(playerId: number): void {
  return;
}

function clearAllCipherAdminPanelDeleteTimers(): void {
  return;
}

function deleteCipherAdminPanelForPlayerIdDeferred(playerId: number, expectedToken: number): void {
  return;
}

function closeCipherAdminPanelForPlayerId(playerId: number, deleteImmediately: boolean = false): void {
  return;
}

function forceDeleteCipherAdminPanelForPlayerId(playerId: number): void {
  return;
}

function closeCipherAdminPanelsForAllPlayers(): void {
  return;
}

function forceDeleteCipherAdminPanelsForAllPlayers(): void {
  return;
}

function clearCipherAdminInteractPoint(context: string): void {
  return;
}

function clearCipherAdminRuntimeState(context: string): void {
  return;
}

function enableCipherAdminInteractPointById(interactId: number, enabled: boolean): void {
  return;
}

type CipherAdminInteractSpawnResult = {
  object?: mod.Object;
  interactPoint?: mod.InteractPoint;
  objId: number;
  reason: string;
};

function resolveCipherAdminInteractFromUnknown(target: unknown): CipherAdminInteractSpawnResult {
  return undefined as any;
}

function spawnCipherAdminRuntimeInteractPoint(
  pos: mod.Vector,
  context: string
): CipherAdminInteractSpawnResult {
  return undefined as any;
}

function getCipherAdminInteractSpawnPosition(player: mod.Player): mod.Vector | undefined {
  return undefined as any;
}

async function expireCipherAdminInteractPointAfterDelay(expectedToken: number): Promise<void> {
  return;
}

function spawnCipherAdminInteractPointForPlayer(player: mod.Player): void {
  return;
}

async function spawnCipherAdminInteractPointForPlayerAfterDelay(
  playerId: number,
  expectedToken: number,
  delaySeconds: number,
  context: string
): Promise<void> {
  return;
}

function queueCipherAdminInteractSpawnForPlayer(playerId: number, context: string): void {
  return;
}

function isCipherAdminInteractPointId(interactId: number): boolean {
  return false;
}

function tickCipherAdminInteractFallback(nowSec: number): void {
  return;
}


function setCipherAdminPanelWidgetsVisibleForPlayerId(playerId: number, visible: boolean): void {
  return;
}

function softCloseCipherAdminPanelForPlayerId(playerId: number): void {
  return;
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
  return;
}
function openCipherAdminPanelForPlayer(player: mod.Player): void {
  return;
}

function parseCipherAdminActionFromWidgetName(widgetName: string, playerId: number): CipherAdminAction | undefined {
  return undefined as any;
}

function getUiWidgetNameSafe(widget: mod.UIWidget): string {
  try {
    return mod.GetUIWidgetName(widget);
  } catch (_err) {
    return "";
  }
}

function resetCipherAdminPrimaryClickTrackerForPlayerId(playerId: number): void {
  return;
}

function isCipherAdminPrimaryClickEvent(eventUIButtonEvent: mod.UIButtonEvent): boolean {
  return false;
}

function getCipherAdminPrimaryClickPhase(eventUIButtonEvent: mod.UIButtonEvent): CipherAdminPrimaryClickPhase {
  return undefined as any;
}

function getCipherAdminClickTimeSeconds(): number {
  return 0;
}

function tryConsumeCipherAdminPrimaryClickEvent(
  playerId: number,
  widgetName: string,
  eventUIButtonEvent: mod.UIButtonEvent
): boolean {
  return false;
}

function isCipherAdminButtonDebounced(playerId: number, action: CipherAdminAction): boolean {
  return false;
}

function getCipherAdminScoreTeam(action: CipherAdminAction): mod.Team {
  return team1;
}

function syncCipherAdminActionEffects(context: string): void {
  return;
}

function getCipherAdminActionLogKey(action: CipherAdminAction): any {
  return undefined as any;
}

function recordCipherAdminAction(player: mod.Player, action: CipherAdminAction): void {
  return;
}

function applyCipherAdminScoreAdjustment(action: CipherAdminAction): boolean {
  return false;
}

function applyCipherAdminTimeAdjustment(deltaSeconds: number): boolean {
  return false;
}

function expireCipherAdminLiveTimer(): boolean {
  return false;
}

function resetCipherAdminLiveTimer(): boolean {
  return false;
}

function ensureCipherAdminLiveInitialized(): boolean {
  return false;
}

function forceCipherAdminLiveHalf(half: CipherHalfIndex): boolean {
  return false;
}

function startCipherAdminSuddenDeath(): boolean {
  return false;
}

function resetRuntimeBotSpawnerValidationState(): void {
  return;
}

function safeSendPortalLogToAdmin(source: string): void {
  return;
}

function clearRuntimeBotDebugPortalLogTimers(): void {
  return;
}

function scheduleRuntimeBotDebugPortalLogs(source: string): void {
  return;
}

function setCipherRuntimeBotsEnabled(enabled: boolean, context: string): boolean {
  return false;
}

function toggleCipherRuntimeBotsFromAdmin(context: string): boolean {
  return false;
}

function clearCipherRuntimeBotsFromAdmin(): boolean {
  return false;
}

function forceCipherRuntimeBotReconcileFromAdmin(): boolean {
  return false;
}

function executeCipherAdminAction(player: mod.Player, playerId: number, action: CipherAdminAction): void {
  return;
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


function rebuildPlayerLiveHudTopStage(p: Player): boolean {
  const sessionToken = playerSessionTokenByPlayerId[p.id];
  if (liveHudBuiltSessionTokenByPlayerId[p.id] !== sessionToken) {
    deletePlayerLiveHudWidgets(p.id, liveHudBuiltSessionTokenByPlayerId[p.id]);
    resetCipherTransitionHudRefsForPlayer(p);
  }
  bindPlayerTopScoreWidgetRefs(p);
  if (!hasValidRootTopScoreWidgets(p.id)) {
    if (!rebuildPlayerTopScoreWidgets(p)) {
      deletePlayerLiveHudWidgets(p.id);
      liveHudBuiltByPlayerId[p.id] = false;
      return false;
    }
  } else {
    setTopScoreWidgetDepthForPlayer(p.id);
  }
    UpdateTopTicketBarsForPlayer(p);
    return true;
}

function rebuildPlayerLiveHud(p: Player): void {
  try {
    if (!rebuildPlayerLiveHudTopStage(p)) return;
    rebuildObjectiveHoldProgressUiWidgetsForPlayer(p);
    rebuildDeployObjectiveTimerUiWidgetsForPlayer(p);
    liveHudBuiltByPlayerId[p.id] = true;
    liveHudBuiltSessionTokenByPlayerId[p.id] = playerSessionTokenByPlayerId[p.id];
    markCipherKeyHudReadyForPlayer(p.id, true);
  } catch (err) {
    LogRuntimeError("rebuildPlayerLiveHud/" + String(p?.id ?? -1), err);
    if (p) {
      liveHudBuiltByPlayerId[p.id] = false;
      delete liveHudBuiltSessionTokenByPlayerId[p.id];
      markCipherKeyHudDirtyForPlayer(p.id);
    }
  }
}

function getPrivatePlayerWidgetName(prefix: string, playerId: number, sessionToken?: number): string {
  const token = sessionToken ?? playerSessionTokenByPlayerId[playerId] ?? 0;
  return prefix + playerId + "_S" + token;
}

function getObjectiveHoldRootWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ObjectiveHoldRoot", playerId, sessionToken);
}

function getObjectiveHoldContainerWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ObjectiveHoldContainer", playerId, sessionToken);
}

function getObjectiveHoldArmingFillWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ObjectiveHoldFillArming", playerId, sessionToken);
}

function getObjectiveHoldDisarmingFillWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ObjectiveHoldFillDisarming", playerId, sessionToken);
}

function getObjectiveHoldArmingTextWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ObjectiveHoldTextArming", playerId, sessionToken);
}

function getObjectiveHoldDisarmingTextWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("ObjectiveHoldTextDisarming", playerId, sessionToken);
}

function rebuildObjectiveHoldProgressUiWidgetsForPlayer(p: Player): void {
  const playerId = p.id;
  safeDeleteWidgetByName(getObjectiveHoldArmingFillWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldDisarmingFillWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldArmingTextWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldDisarmingTextWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldContainerWidgetName(playerId));
  safeDeleteWidgetByName(getObjectiveHoldRootWidgetName(playerId));

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
}

function getDeployObjectiveTimerRootWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerRoot", playerId, sessionToken);
}

function getDeployObjectiveTimerPanelWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerPanel", playerId, sessionToken);
}

function getDeployObjectiveTimerLaneFillWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerLaneFill", playerId, sessionToken);
}

function getDeployObjectiveTimerLaneTextWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerLaneText", playerId, sessionToken);
}

function getDeployObjectiveTimerLaneOutlineTopWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerLaneOutlineTop", playerId, sessionToken);
}

function getDeployObjectiveTimerLaneOutlineBottomWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerLaneOutlineBottom", playerId, sessionToken);
}

function getDeployObjectiveTimerLaneOutlineLeftWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerLaneOutlineLeft", playerId, sessionToken);
}

function getDeployObjectiveTimerLaneOutlineRightWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerLaneOutlineRight", playerId, sessionToken);
}

function getDeployObjectiveTimerTitleWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerTitle", playerId, sessionToken);
}

function getDeployObjectiveTimerValueWidgetName(playerId: number, sessionToken?: number): string {
  return getPrivatePlayerWidgetName("DeployObjectiveTimerValue", playerId, sessionToken);
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
    TOP_HUD_NODE_FILL_BASE_ALPHA,
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
    TOP_HUD_NODE_OUTLINE_BASE_ALPHA,
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
    TOP_HUD_NODE_OUTLINE_BASE_ALPHA,
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
    TOP_HUD_NODE_OUTLINE_BASE_ALPHA,
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
    TOP_HUD_NODE_OUTLINE_BASE_ALPHA,
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
    TOP_HUD_NODE_TEXT_BASE_ALPHA,
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
    markCipherKeyHudDirtyForPlayer(p.id);
    queueLiveHudBuild(p.id, "deploy_timer_missing_widgets", "normal", 1);
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
  queuePhaseUiCleanupForKnownPlayers();
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
  SafeSetWidgetBgAlphaHandle(laneFill, TOP_HUD_NODE_FILL_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineTop, TOP_HUD_NODE_OUTLINE_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineBottom, TOP_HUD_NODE_OUTLINE_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineLeft, TOP_HUD_NODE_OUTLINE_BASE_ALPHA);
  SafeSetWidgetBgAlphaHandle(outlineRight, TOP_HUD_NODE_OUTLINE_BASE_ALPHA);
  SafeSetTextAlphaHandle(laneText, TOP_HUD_NODE_TEXT_BASE_ALPHA);

  if (p.deployObjectiveTimerLastShownCpId !== armedCpId) {
    SafeSetTextLabelHandle(laneText, mod.Message(getLaneStringKey(lane)));
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
    return;
  }

  const sampleNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const next = getNextValidHumanPlayerForUiLane(liveDeployTimerUiCursor);
  liveDeployTimerUiCursor = next.nextCursor;
  if (next.player) UpdateDeployObjectiveTimerUiForPlayer(next.player, sampleNowSec);
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
  const next = getNextValidHumanPlayerForUiLane(liveObjectiveHoldUiCursor);
  liveObjectiveHoldUiCursor = next.nextCursor;
  if (next.player) UpdateObjectiveHoldProgressUiForPlayer(next.player, sampleNowSec);
}

function HideAllObjectiveHoldProgressUi(): void {
  queuePhaseUiCleanupForKnownPlayers();
}

function queuePhaseUiCleanupForKnownPlayers(): void {
  const players = getValidHumanPlayersSnapshot();
  for (let i = 0; i < players.length; i++) {
    const playerId = players[i].id;
    if (phaseUiCleanupQueuedByPlayerId[playerId] === true) continue;
    phaseUiCleanupQueuedByPlayerId[playerId] = true;
    phaseUiCleanupPlayerIds.push(playerId);
  }
}

function processPhaseUiCleanupStep(): void {
  if (phaseUiCleanupCursor >= phaseUiCleanupPlayerIds.length) {
    phaseUiCleanupPlayerIds = [];
    phaseUiCleanupCursor = 0;
    phaseUiCleanupQueuedByPlayerId = {};
    return;
  }
  const playerId = phaseUiCleanupPlayerIds[phaseUiCleanupCursor++];
  delete phaseUiCleanupQueuedByPlayerId[playerId];
  const player = serverPlayers.get(playerId);
  if (!player) return;
  forceHideCipherLiveHudForPlayer(player);
  hideObjectiveHoldProgressForPlayer(playerId);
  hideDeployObjectiveTimerUiForPlayer(playerId);
  if (player.cipherSuddenDeathAliveRootWidget) {
    setCipherSuddenDeathAliveHudVisibleForPlayer(player, false);
  }
}


/* -----------------------------------------------------------------------------------------------
   Live HUD helpers
------------------------------------------------------------------------------------------------ */

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
    p.bombNoticeLeftAccentWidget &&
    p.bombNoticeRightAccentWidget &&
    p.bombNoticeTextWidget &&
    p.bombNoticeDetailWidget &&
    SafeFindWidget(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + p.id) &&
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

function repairDirtyCipherKeyHudCaches(maxRepairs: number = 2, allowRebuild: boolean = false): void {
  if (maxRepairs <= 0) return;

  let repaired = 0;
  const players = getCipherKeyUiPlayerSnapshot(true);
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (cipherKeyHudDirtyByPlayerId[p.id] !== true && cipherKeyHudReadyByPlayerId[p.id] === true) continue;
    repairCipherKeyHudCacheForPlayer(p, allowRebuild);
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

function UpdateBombCarrierUiForAllPlayers(_nowSec?: number, _force: boolean = false): void {
  const next = getNextValidHumanPlayerForUiLane(liveCarrierTicketUiCursor);
  liveCarrierTicketUiCursor = next.nextCursor;
  if (next.player) UpdateTopTicketBarsForPlayer(next.player);
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

function getActiveBombNoticeDetailForPlayer(p: Player, nowSec: number): any {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  if (playerVisibleUntilSec > nowSec) {
    return bombNoticeDetailMessageByPlayerId[p.id] ?? mod.Message((mod.stringkeys as any).CipherKeyEventDetail);
  }
  return mod.Message((mod.stringkeys as any).CipherKeyEventDetail);
}

function getActiveBombNoticeToneForPlayer(p: Player, nowSec: number): CipherEventBannerTone {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  if (playerVisibleUntilSec > nowSec) return bombNoticeToneByPlayerId[p.id] ?? "neutral";
  return "neutral";
}

function getActiveBombNoticeKindForPlayer(p: Player, nowSec: number): CipherEventBannerKind {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  if (playerVisibleUntilSec > nowSec) return bombNoticeKindByPlayerId[p.id] ?? "center";
  return "center";
}

function getCipherEventBannerColorForTone(tone: CipherEventBannerTone): mod.Vector {
  if (tone === "friendly") return COLOR_FRIENDLY;
  if (tone === "enemy") return COLOR_ENEMY;
  return COLOR_NEUTRAL;
}

function isBombNoticeVisibleForPlayer(p: Player, nowSec: number): boolean {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  return playerVisibleUntilSec > nowSec || bombNoticeVisibleUntilSec > nowSec;
}

function getBombNoticeUiStateKeyForPlayer(p: Player, nowSec: number): string {
  const playerVisibleUntilSec = bombNoticeVisibleUntilSecByPlayerId[p.id] ?? 0;
  if (playerVisibleUntilSec > nowSec) {
    return "p:" + String(bombNoticeTokenByPlayerId[p.id] ?? 0) + ":" + getActiveBombNoticeKindForPlayer(p, nowSec);
  }
  if (bombNoticeVisibleUntilSec > nowSec) {
    return "g:" + String(bombNoticeToken);
  }
  return "hidden";
}

function reassertBombNoticeWidgetLayoutForPlayer(p: Player): void {
  const container = p.bombNoticeContainerWidget;
  const leftAccent = p.bombNoticeLeftAccentWidget;
  const rightAccent = p.bombNoticeRightAccentWidget;
  const widget = p.bombNoticeTextWidget;
  const detail = p.bombNoticeDetailWidget;
  const playerContainer = SafeFindWidget(BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + p.id);
  const playerText = SafeFindWidget(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + p.id);
  const droppedOutline = SafeFindWidget(BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + p.id);

  const nowSec = getCurrentSchedulerNowSeconds();
  const tone = getActiveBombNoticeToneForPlayer(p, nowSec);
  const accentColor = getCipherEventBannerColorForTone(tone);

  // Center key event banner.
  SafeSetWidgetPositionHandle(container, BOMB_NOTICE_WIDGET_POS);
  SafeSetWidgetSizeHandle(container, BOMB_NOTICE_CONTAINER_SIZE);
  SafeSetWidgetDepthHandle(container, mod.UIDepth.AboveGameUI);
  SafeSetWidgetBgColorHandle(container, BOMB_NOTICE_WIDGET_BG_COLOR);
  try { if (container) mod.SetUIWidgetBgAlpha(container, 0.58); } catch (_errAlpha) {}
  try { if (container) mod.SetUIWidgetBgFill(container, mod.UIBgFill.Blur); } catch (_errFill) {}

  // Center key event outline. Friendly = blue. Enemy = red.
  SafeSetWidgetPositionHandle(leftAccent, BOMB_NOTICE_OUTLINE_POS);
  SafeSetWidgetSizeHandle(leftAccent, BOMB_NOTICE_CONTAINER_SIZE);
  SafeSetWidgetDepthHandle(leftAccent, mod.UIDepth.AboveGameUI);
  SafeSetWidgetBgColorHandle(leftAccent, accentColor);
  try { if (leftAccent) mod.SetUIWidgetBgFill(leftAccent, mod.UIBgFill.OutlineThick); } catch (_errFill) {}

  SafeSetWidgetPositionHandle(widget, BOMB_NOTICE_TEXT_POS);
  SafeSetWidgetSizeHandle(widget, BOMB_NOTICE_WIDGET_SIZE);
  SafeSetWidgetDepthHandle(widget, mod.UIDepth.AboveGameUI);
  SafeSetTextColorHandle(widget, BOMB_NOTICE_WIDGET_TEXT_COLOR);
  SafeSetTextSizeHandle(widget, BOMB_NOTICE_WIDGET_TEXT_SIZE);

  // Left dropped-key banner.
  SafeSetWidgetPositionHandle(rightAccent, BOMB_DROPPED_NOTICE_POS);
  SafeSetWidgetSizeHandle(rightAccent, BOMB_DROPPED_NOTICE_SIZE);
  SafeSetWidgetDepthHandle(rightAccent, mod.UIDepth.AboveGameUI);
  SafeSetWidgetBgColorHandle(rightAccent, accentColor);
  try { if (rightAccent) mod.SetUIWidgetBgFill(rightAccent, mod.UIBgFill.Blur); } catch (_errFill) {}

  SafeSetWidgetPositionHandle(detail, BOMB_DROPPED_NOTICE_TEXT_POS);
  SafeSetWidgetSizeHandle(detail, BOMB_DROPPED_NOTICE_TEXT_SIZE_VECTOR);
  SafeSetWidgetDepthHandle(detail, mod.UIDepth.AboveGameUI);
  SafeSetTextColorHandle(detail, BOMB_NOTICE_WIDGET_TEXT_COLOR);
  SafeSetTextSizeHandle(detail, BOMB_NOTICE_DETAIL_TEXT_SIZE);

  SafeSetWidgetPositionHandle(playerContainer, BOMB_DROPPED_PLAYER_CONTAINER_POS);
  SafeSetWidgetSizeHandle(playerContainer, BOMB_DROPPED_PLAYER_CONTAINER_SIZE);
  SafeSetWidgetDepthHandle(playerContainer, mod.UIDepth.AboveGameUI);
  SafeSetWidgetBgColorHandle(playerContainer, accentColor);

  SafeSetWidgetPositionHandle(playerText, BOMB_DROPPED_PLAYER_TEXT_POS);
  SafeSetWidgetSizeHandle(playerText, BOMB_DROPPED_PLAYER_TEXT_SIZE_VECTOR);
  SafeSetWidgetDepthHandle(playerText, mod.UIDepth.AboveGameUI);
  SafeSetTextColorHandle(playerText, mod.CreateVector(1, 1, 1));
  SafeSetTextSizeHandle(playerText, BOMB_NOTICE_PLAYER_TEXT_SIZE);

  // Dropped-key outline. Do not let this return to 0,0 or white.
  SafeSetWidgetPositionHandle(droppedOutline, BOMB_DROPPED_NOTICE_POS);
  SafeSetWidgetSizeHandle(droppedOutline, BOMB_DROPPED_NOTICE_SIZE);
  SafeSetWidgetDepthHandle(droppedOutline, mod.UIDepth.AboveGameUI);
  SafeSetWidgetBgColorHandle(droppedOutline, accentColor);
  try { if (droppedOutline) mod.SetUIWidgetBgFill(droppedOutline, mod.UIBgFill.OutlineThin); } catch (_errFill) {}
}

function refreshBombNoticeUiForPlayer(p: Player, nowSec?: number, force: boolean = false): void {
  let container = p.bombNoticeContainerWidget;
  let leftAccent = p.bombNoticeLeftAccentWidget;
  let rightAccent = p.bombNoticeRightAccentWidget;
  let widget = p.bombNoticeTextWidget;
  let detail = p.bombNoticeDetailWidget;
  let playerContainer = SafeFindWidget(BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + p.id);
  let playerText = SafeFindWidget(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + p.id);
  if ((!container || !leftAccent || !rightAccent || !widget || !detail) && force) {
    bindPlayerCipherKeyHudWidgetRefs(p, true);
    container = p.bombNoticeContainerWidget;
    leftAccent = p.bombNoticeLeftAccentWidget;
    rightAccent = p.bombNoticeRightAccentWidget;
    widget = p.bombNoticeTextWidget;
    detail = p.bombNoticeDetailWidget;
    playerContainer = SafeFindWidget(BOMB_NOTICE_PLAYER_CONTAINER_WIDGET_NAME_PREFIX + p.id);
    playerText = SafeFindWidget(BOMB_NOTICE_PLAYER_TEXT_WIDGET_NAME_PREFIX + p.id);
  }
  if (!container || !leftAccent || !rightAccent || !widget || !detail || !playerContainer || !playerText) {
    markCipherKeyHudDirtyForPlayer(p.id);
    return;
  }

  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const visible = gameStatus === 3 && isBombNoticeVisibleForPlayer(p, resolvedNowSec);
  const stateKey = visible ? getBombNoticeUiStateKeyForPlayer(p, resolvedNowSec) : "hidden";

  if (force || visible) reassertBombNoticeWidgetLayoutForPlayer(p);

  if (!force && p.bombNoticeUiLastStateKey === stateKey) return;
  p.bombNoticeUiLastStateKey = stateKey;

  const droppedOutline = SafeFindWidget(BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + p.id);

  // IMPORTANT:
  // When hidden, clear the text first, then hide everything.
  // This prevents the half-second UnknownString flash right before the banner disappears.
  if (!visible) {
    const empty = mod.Message(mod.stringkeys.EmptyText);

    SafeSetTextLabelHandle(widget, empty);
    SafeSetTextLabelHandle(detail, empty);
    SafeSetTextLabelHandle(playerText, empty);

    SafeSetWidgetBgAlphaHandle(leftAccent, 0);
    SafeSetWidgetBgAlphaHandle(rightAccent, 0);
    SafeSetWidgetBgAlphaHandle(playerContainer, 0);
    SafeSetWidgetBgAlphaHandle(droppedOutline, 0);

    SafeSetWidgetVisibleHandle(container, false);
    SafeSetWidgetVisibleHandle(leftAccent, false);
    SafeSetWidgetVisibleHandle(widget, false);
    SafeSetWidgetVisibleHandle(rightAccent, false);
    SafeSetWidgetVisibleHandle(detail, false);
    SafeSetWidgetVisibleHandle(playerContainer, false);
    SafeSetWidgetVisibleHandle(playerText, false);
    SafeSetWidgetVisibleHandle(droppedOutline, false);

    SafeSetTextAlphaHandle(widget, 0);
    SafeSetTextAlphaHandle(detail, 0);
    SafeSetTextAlphaHandle(playerText, 0);
    return;
  }

  try {
    const tone = getActiveBombNoticeToneForPlayer(p, resolvedNowSec);
    const kind = getActiveBombNoticeKindForPlayer(p, resolvedNowSec);
    const accentColor = getCipherEventBannerColorForTone(tone);
    const centerVisible = visible && kind === "center";
    const droppedVisible = visible && kind === "dropped";
    const droppedOutline = SafeFindWidget(BOMB_NOTICE_DROPPED_OUTLINE_WIDGET_NAME_PREFIX + p.id);
    const eventMessage = getActiveBombNoticeMessageForPlayer(p, resolvedNowSec);
    const detailMessage = getActiveBombNoticeDetailForPlayer(p, resolvedNowSec);
    SafeSetWidgetBgColorHandle(container, tone === "neutral" ? BOMB_NOTICE_WIDGET_BG_COLOR : accentColor);
    SafeSetWidgetBgColorHandle(leftAccent, accentColor);
    SafeSetWidgetBgColorHandle(rightAccent, accentColor);
    SafeSetWidgetBgColorHandle(playerContainer, accentColor);
    SafeSetWidgetBgColorHandle(droppedOutline, accentColor);
    SafeSetWidgetBgAlphaHandle(leftAccent, centerVisible ? 0.92 : 0);
    SafeSetWidgetBgAlphaHandle(rightAccent, droppedVisible ? 0.72 : 0);
    SafeSetWidgetBgAlphaHandle(playerContainer, droppedVisible ? 0.82 : 0);
    SafeSetWidgetBgAlphaHandle(droppedOutline, droppedVisible ? 1 : 0);
    SafeSetTextLabelHandle(widget, eventMessage);
    SafeSetTextLabelHandle(detail, eventMessage);
    SafeSetTextLabelHandle(playerText, detailMessage);
    SafeSetTextSizeHandle(widget, BOMB_NOTICE_WIDGET_TEXT_SIZE);
    SafeSetTextSizeHandle(detail, BOMB_NOTICE_DETAIL_TEXT_SIZE);
    SafeSetTextSizeHandle(playerText, BOMB_NOTICE_PLAYER_TEXT_SIZE);
    SafeSetWidgetVisibleHandle(container, centerVisible);
    SafeSetWidgetVisibleHandle(leftAccent, centerVisible);
    SafeSetWidgetVisibleHandle(widget, centerVisible);
    SafeSetWidgetVisibleHandle(rightAccent, droppedVisible);
    SafeSetWidgetVisibleHandle(detail, droppedVisible);
    SafeSetWidgetVisibleHandle(playerContainer, droppedVisible);
    SafeSetWidgetVisibleHandle(playerText, droppedVisible);
    SafeSetWidgetVisibleHandle(droppedOutline, droppedVisible);
    SafeSetTextAlphaHandle(widget, centerVisible ? 1 : 0);
    SafeSetTextAlphaHandle(detail, droppedVisible ? 1 : 0);
    SafeSetTextAlphaHandle(playerText, droppedVisible ? 1 : 0);
  } catch (_errNotice) {
    p.bombNoticeContainerWidget = null as any;
    p.bombNoticeLeftAccentWidget = null as any;
    p.bombNoticeRightAccentWidget = null as any;
    p.bombNoticeTextWidget = null as any;
    p.bombNoticeDetailWidget = null as any;
    markCipherKeyHudDirtyForPlayer(p.id);
  }
}

function refreshBombNoticeUiForAllPlayers(nowSec?: number, force: boolean = false): void {
  const resolvedNowSec = nowSec ?? getCurrentSchedulerNowSeconds();
  const next = getNextValidHumanPlayerForUiLane(liveBombNoticeUiCursor);
  liveBombNoticeUiCursor = next.nextCursor;
  const p = next.player;
  if (p) {

    if (
      force ||
      !p.bombNoticeContainerWidget ||
      !p.bombNoticeLeftAccentWidget ||
      !p.bombNoticeRightAccentWidget ||
      !p.bombNoticeTextWidget ||
      !p.bombNoticeDetailWidget
    ) {
      p.bombNoticeContainerWidget = SafeFindWidget(BOMB_NOTICE_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
      p.bombNoticeLeftAccentWidget = SafeFindWidget(BOMB_NOTICE_LEFT_ACCENT_WIDGET_NAME_PREFIX + p.id) as any;
      p.bombNoticeRightAccentWidget = SafeFindWidget(BOMB_NOTICE_RIGHT_ACCENT_WIDGET_NAME_PREFIX + p.id) as any;
      p.bombNoticeTextWidget = SafeFindWidget(BOMB_NOTICE_WIDGET_NAME_PREFIX + p.id) as any;
      p.bombNoticeDetailWidget = SafeFindWidget(BOMB_NOTICE_DETAIL_WIDGET_NAME_PREFIX + p.id) as any;
    }

    refreshBombNoticeUiForPlayer(p, resolvedNowSec, force);
  }
}

function getNextKeyUnlockHudStateKey(visible: boolean, remainingSeconds: number): string {
  if (!visible) return "hidden";
  return "unlock:" + String(nextKeyUnlockCountdownToken) + ":" + nextKeyUnlockLabelMode + ":" + String(remainingSeconds);
}

function reassertNextKeyUnlockWidgetLayoutForPlayer(p: Player): void {
  const container = p.nextKeyUnlockContainerWidget;
  const widget = p.nextKeyUnlockTextWidget;

  SafeSetWidgetPositionHandle(container, NEXT_KEY_UNLOCK_WIDGET_POS);
  SafeSetWidgetSizeHandle(container, NEXT_KEY_UNLOCK_CONTAINER_SIZE);
  SafeSetWidgetDepthHandle(container, mod.UIDepth.AboveGameUI);
  SafeSetWidgetBgColorHandle(container, NEXT_KEY_UNLOCK_WIDGET_BG_COLOR);
  try { if (container) mod.SetUIWidgetBgAlpha(container, 0.5); } catch (_errAlpha) {}
  try { if (container) mod.SetUIWidgetBgFill(container, mod.UIBgFill.Blur); } catch (_errFill) {}

  SafeSetWidgetPositionHandle(widget, NEXT_KEY_UNLOCK_TEXT_POS);
  SafeSetWidgetSizeHandle(widget, NEXT_KEY_UNLOCK_WIDGET_SIZE);
  SafeSetWidgetDepthHandle(widget, mod.UIDepth.AboveGameUI);
  SafeSetTextColorHandle(widget, NEXT_KEY_UNLOCK_WIDGET_TEXT_COLOR);
  SafeSetTextSizeHandle(widget, NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE);
}

function refreshNextKeyUnlockHudForPlayer(p: Player, nowSec?: number, force: boolean = false): void {
  let widget = p.nextKeyUnlockTextWidget;
  let container = p.nextKeyUnlockContainerWidget;
  if ((!widget || force) && gameStatus === 3) {
    p.nextKeyUnlockTextWidget = SafeFindWidget(NEXT_KEY_UNLOCK_WIDGET_NAME_PREFIX + p.id) as any;
    widget = p.nextKeyUnlockTextWidget;
  }
  if ((!container || force) && gameStatus === 3) {
    p.nextKeyUnlockContainerWidget = SafeFindWidget(NEXT_KEY_UNLOCK_CONTAINER_WIDGET_NAME_PREFIX + p.id) as any;
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
  if (force || visible) reassertNextKeyUnlockWidgetLayoutForPlayer(p);
  if (!force && p.nextKeyUnlockHudLastStateKey === stateKey) return;
  p.nextKeyUnlockHudLastStateKey = stateKey;
  nextKeyUnlockHudLastStateByPlayerId[p.id] = stateKey;

  try {
    SafeSetTextLabelHandle(widget, formatNextKeyHudTimerLabel(remainingSeconds));
    SafeSetTextSizeHandle(widget, NEXT_KEY_UNLOCK_WIDGET_TEXT_SIZE);
    SafeSetWidgetVisibleHandle(container, visible);
    SafeSetWidgetVisibleHandle(widget, visible);
    SafeSetTextAlphaHandle(widget, visible ? 1 : 0);
    SafeSetWidgetDepthHandle(container, mod.UIDepth.AboveGameUI);
    SafeSetWidgetDepthHandle(widget, mod.UIDepth.AboveGameUI);
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
  const next = getNextValidHumanPlayerForUiLane(liveNextKeyUiCursor);
  liveNextKeyUiCursor = next.nextCursor;
  if (next.player) refreshNextKeyUnlockHudForPlayer(next.player, resolvedNowSec, force);
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
  if (forceHudRefresh) {
    queueCipherKeyUiRefresh("clearNextKeyUnlockCountdown/" + context, { force: true, refreshNextKey: true }, 1);
  }
}

function clearBombNoticeState(): void {
  bombNoticeToken++;
  bombNoticeVisibleUntilSec = 0;
  bombNoticeMessageKeyByPlayerId = {};
  bombNoticeFallbackTextByPlayerId = {};
  bombNoticeDetailMessageByPlayerId = {};
  bombNoticeToneByPlayerId = {};
  bombNoticeKindByPlayerId = {};
  bombNoticeVisibleUntilSecByPlayerId = {};
  bombNoticeTokenByPlayerId = {};
  queueCipherKeyUiRefresh("clearBombNoticeState", { force: true, refreshBombNotice: true }, 1);
}

function scheduleBombNoticeHide(
  playerId: number,
  token: number,
  durationSeconds: number
): void {
  scheduleCipherGlobalTask(durationSeconds, "bomb_notice_hide/" + String(playerId), () => {
    if ((bombNoticeTokenByPlayerId[playerId] ?? 0) !== token) return;
    bombNoticeVisibleUntilSecByPlayerId[playerId] = 0;
    delete bombNoticeDetailMessageByPlayerId[playerId];
    delete bombNoticeToneByPlayerId[playerId];
    delete bombNoticeKindByPlayerId[playerId];
    queueCipherKeyUiRefresh(
      "scheduleBombNoticeHide/" + String(playerId),
      { force: true, refreshBombNotice: true },
      1
    );
  });
}

function showBombNoticeForAllPlayers(
  messageKey: any,
  fallbackText: string,
  durationSeconds: number = BOMB_NOTICE_DURATION_SECONDS
): void {
  if (gameStatus !== 3) return;

  refreshCipherKeyPlayerSnapshots("showBombNoticeForAllPlayers");
  const players = getCipherKeyUiPlayerSnapshot(false);
  for (let i = 0; i < players.length; i++) {
    showBombNoticeForPlayer(players[i].id, messageKey, fallbackText, durationSeconds);
  }
}

function showBombNoticeForPlayerDetailed(
  playerId: number,
  messageKey: any,
  fallbackText: string,
  detailMessage: any | undefined,
  tone: CipherEventBannerTone,
  durationSeconds: number = BOMB_NOTICE_DURATION_SECONDS,
  kind: CipherEventBannerKind = "center"
): void {
  if (gameStatus !== 3) return;

  const sp = getCipherKeyPlayerSnapshot(playerId) ?? serverPlayers.get(playerId);
  if (!sp) return;

  const token = (bombNoticeTokenByPlayerId[playerId] ?? 0) + 1;
  bombNoticeTokenByPlayerId[playerId] = token;
  bombNoticeMessageKeyByPlayerId[playerId] = messageKey;
  bombNoticeFallbackTextByPlayerId[playerId] = fallbackText;
  if (detailMessage !== undefined) {
    bombNoticeDetailMessageByPlayerId[playerId] = detailMessage;
  } else {
    delete bombNoticeDetailMessageByPlayerId[playerId];
  }
  bombNoticeToneByPlayerId[playerId] = tone;
  bombNoticeKindByPlayerId[playerId] = kind;
  const nowSec = getCurrentSchedulerNowSeconds();
  bombNoticeVisibleUntilSecByPlayerId[playerId] = nowSec + durationSeconds;
  queueCipherKeyUiRefresh(
    "showBombNoticeForPlayerDetailed/" + String(playerId),
    { force: true, refreshBombNotice: true },
    0
  );
  scheduleBombNoticeHide(playerId, token, durationSeconds);
}

function showBombNoticeForPlayer(
  playerId: number,
  messageKey: any,
  fallbackText: string,
  durationSeconds: number = BOMB_NOTICE_DURATION_SECONDS
): void {
  showBombNoticeForPlayerDetailed(playerId, messageKey, fallbackText, undefined, "neutral", durationSeconds);
}

function showCipherKeyPickupNoticeForTeam(keyTeam: mod.Team): void {
  if (mod.Equals(keyTeam, teamNeutral)) return;
  const keyTeamId = mod.Equals(keyTeam, team1) ? 1 : mod.Equals(keyTeam, team2) ? 2 : 0;
  if (keyTeamId <= 0) return;

  refreshCipherKeyPlayerSnapshots("showCipherKeyPickupNoticeForTeam");
  const players = getCipherKeyUiPlayerSnapshot(false);
  for (let i = 0; i < players.length; i++) {
    const viewer = players[i];
    const viewerTeamId = cipherKeyTeamIdByPlayerIdSnapshot[viewer.id];
    if (viewerTeamId !== 1 && viewerTeamId !== 2) continue;
    if (viewerTeamId === keyTeamId) {
      const isCarrier = bombCarrierPlayerId === viewer.id;
      showBombNoticeForPlayerDetailed(
        viewer.id,
        isCarrier
          ? (mod.stringkeys as any).CipherYouPickedUpKey
          : (mod.stringkeys as any).CipherWePickedUpKey,
        isCarrier ? "YOU PICKED UP KEY" : "WE PICKED UP KEY",
        mod.Message(mod.stringkeys.EmptyText),
        "friendly",
        BOMB_NOTICE_DURATION_SECONDS,
        "center"
      );
    } else {
      showBombNoticeForPlayerDetailed(
        viewer.id,
        (mod.stringkeys as any).CipherEnemyPickedUpKey,
        "ENEMY PICKED UP KEY",
        mod.Message(mod.stringkeys.EmptyText),
        "enemy",
        BOMB_NOTICE_DURATION_SECONDS,
        "center"
      );
    }
  }
}

function showCipherKeyDroppedNoticeForTeam(keyTeam: mod.Team, droppedPlayerId?: number): void {
  if (mod.Equals(keyTeam, teamNeutral)) return;
  const keyTeamId = mod.Equals(keyTeam, team1) ? 1 : mod.Equals(keyTeam, team2) ? 2 : 0;
  if (keyTeamId <= 0) return;

  let detailMessage: any = getStringMessageWithFallback((mod.stringkeys as any).Text_PLAYER_NAME, "PLAYER");
  if (droppedPlayerId !== undefined) {
    const droppedPlayer = serverPlayers.get(droppedPlayerId);
    if (droppedPlayer && mod.IsPlayerValid(droppedPlayer.player)) {
      detailMessage = mod.Message((mod.stringkeys as any).CipherKeyDroppedBy, droppedPlayer.player);
    }
  }

  refreshCipherKeyPlayerSnapshots("showCipherKeyDroppedNoticeForTeam");
  const players = getCipherKeyUiPlayerSnapshot(false);
  for (let i = 0; i < players.length; i++) {
    const viewer = players[i];
    const viewerTeamId = cipherKeyTeamIdByPlayerIdSnapshot[viewer.id];
    if (viewerTeamId !== 1 && viewerTeamId !== 2) continue;
    const friendly = viewerTeamId === keyTeamId;
    showBombNoticeForPlayerDetailed(
      viewer.id,
      friendly ? (mod.stringkeys as any).CipherWeDroppedKey : (mod.stringkeys as any).CipherEnemyDroppedKey,
      friendly ? "WE DROPPED KEY" : "ENEMY DROPPED KEY",
      detailMessage,
      friendly ? "friendly" : "enemy",
      BOMB_NOTICE_DURATION_SECONDS,
      "dropped"
    );
  }
}

function showCipherKeyDeliveryNoticeForTeam(
  attackingTeam: mod.Team,
  carrierPlayerId: number | undefined,
  deliveryPlayer: Player | undefined,
  symbol: any
): void {
  if (mod.Equals(attackingTeam, teamNeutral)) return;
  const attackingTeamId = mod.Equals(attackingTeam, team1) ? 1 : mod.Equals(attackingTeam, team2) ? 2 : 0;
  if (attackingTeamId <= 0) return;

  refreshCipherKeyPlayerSnapshots("showCipherKeyDeliveryNoticeForTeam");
  const players = getCipherKeyUiPlayerSnapshot(false);
  for (let i = 0; i < players.length; i++) {
    const viewer = players[i];
    const viewerTeamId = cipherKeyTeamIdByPlayerIdSnapshot[viewer.id];
    if (viewerTeamId !== 1 && viewerTeamId !== 2) continue;

    const friendly = viewerTeamId === attackingTeamId;
    const symbolText = String(symbol);
    const selfDelivered =
      friendly &&
      ((deliveryPlayer !== undefined && deliveryPlayer.id === viewer.id) ||
        (carrierPlayerId !== undefined && carrierPlayerId === viewer.id));
    const deliveryText = friendly
      ? selfDelivered
        ? "YOU CIPHERED " + symbolText + " NODE"
        : "WE CIPHERED " + symbolText + " NODE"
      : "ENEMY CIPHERED " + symbolText + " NODE";
    showBombNoticeForPlayerDetailed(
    viewer.id,
    deliveryText,
    deliveryText,
    mod.Message(mod.stringkeys.EmptyText),
    friendly ? "friendly" : "enemy",
    BOMB_NOTICE_DURATION_SECONDS,
    "center"
    );
  }
}

function refreshCipherKeyUiAndIconsImmediately(reason: string): void {
  if (gameStatus !== 3) return;

  queueCipherKeyUiRefresh(
    reason,
    {
      force: true,
      // Lightweight refresh only. HUD rebuilds must be explicit phase/join jobs, not key-event jobs.
      rebuildHud: false,
      refreshBombNotice: true,
      refreshNextKey: true,
      updateCarrierHud: true,
      updateScores: true,
      updateIcons: true,
      syncCarrierVisuals: true,
    },
    1
  );
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

function getCipherScoreProgressWidth(score: number): number {
  const cap = CIPHER_SCORE_TICKER_CAP > 0 ? CIPHER_SCORE_TICKER_CAP : 1;
  let ratio = score / cap;
  if (!Number.isFinite(ratio) || ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  const width = mod.Floor(CIPHER_SCORE_PROGRESS_WIDTH * ratio);
  if (score > 0 && width < 1) return 1;
  return width;
}

function getLiveScorePanelTimeLabel(nowSec?: number): any {
  const resolvedNow = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();
  if (isCipherLiveTransitionActive()) {
    return formatUiTimerLabel(mod.Max(0, mod.Ceiling(cipherTransitionCountdownSeconds)));
  }
  if (!liveClockStarted) return mod.Message(mod.stringkeys.TimeDefault);
  const remainingTime = getLiveClockRemainingSeconds(resolvedNow);
  const displaySeconds = remainingTime !== undefined ? mod.Max(0, mod.Ceiling(remainingTime)) : 0;
  return formatUiTimerLabel(displaySeconds);
}

let liveScorePanelTimeCursor = 0;

function UpdateLiveScorePanelTimeForAllPlayers(nowSec?: number): void {
  const label = getLiveScorePanelTimeLabel(nowSec);
  const players = getValidHumanPlayersSnapshot();
  if (players.length <= 0) return;
  if (liveScorePanelTimeCursor >= players.length) liveScorePanelTimeCursor = 0;
  const p = players[liveScorePanelTimeCursor++];
  const timeText = SafeFindWidget(CIPHER_LIVE_TIME_TEXT_WIDGET_NAME_PREFIX + p.id);
  SafeSetTextLabelHandle(timeText, label);
}

function getCipherViewerMatchStatusMessage(p: Player): { message: any; color: mod.Vector } {
  const team = mod.GetTeam(p.player);
  const friendly = getFriendlyScore(team);
  const enemy = getOpponentScore(team);
  if (friendly > enemy) {
    return {
      message: getStringMessageWithFallback((mod.stringkeys as any).CipherStatusWinning, "WINNING"),
      color: COLOR_FRIENDLY,
    };
  }
  if (enemy > friendly) {
    return {
      message: getStringMessageWithFallback((mod.stringkeys as any).CipherStatusLosing, "LOSING"),
      color: COLOR_ENEMY,
    };
  }
  return {
    message: getStringMessageWithFallback((mod.stringkeys as any).CipherStatusTie, "TIE"),
    color: COLOR_NEUTRAL,
  };
}

function getCipherCarrierStatusForPlayer(p: Player): { message: any; color: mod.Vector; visible: boolean } {
  if (bombCarrierPlayerId !== undefined) {
    const carrier = serverPlayers.get(bombCarrierPlayerId);
    if (carrier && mod.IsPlayerValid(carrier.player)) {
      const viewerTeam = mod.GetTeam(p.player);
      const carrierTeam = mod.GetTeam(carrier.player);
      if (bombCarrierPlayerId === p.id) {
        return {
          message: getStringMessageWithFallback((mod.stringkeys as any).CipherYouCarryingKey, "YOU ARE CARRYING KEY"),
          color: COLOR_FRIENDLY,
          visible: true,
        };
      }
      if (mod.Equals(viewerTeam, carrierTeam)) {
        return {
          message: getStringMessageWithFallback1(
            (mod.stringkeys as any).CipherPlayerCarryingKey,
            "{} IS CARRYING KEY",
            carrier.player
          ),
          color: COLOR_FRIENDLY,
          visible: true,
        };
      }
      return {
        message: getStringMessageWithFallback1(
          (mod.stringkeys as any).CipherPlayerCarryingKey,
          "{} IS CARRYING KEY",
          carrier.player
        ),
        color: COLOR_ENEMY,
        visible: true,
      };
    }
  }

  return {
    message: mod.Message(mod.stringkeys.EmptyText),
    color: COLOR_NEUTRAL,
    visible: false,
  };
}

// Ticket bar fills shrink with the viewer's friendly/opponent tickets.
function UpdateTopTicketBarsForPlayer(p: Player): void {
  if (gameStatus !== 3) {
    const friendlyFill = SafeFindWidget(CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + p.id);
    const enemyFill = SafeFindWidget(CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + p.id);

    SafeSetWidgetVisibleHandle(friendlyFill, false);
    SafeSetWidgetVisibleHandle(enemyFill, false);

    try { if (friendlyFill) mod.SetUIWidgetBgAlpha(friendlyFill, 0); } catch (_errFriendlyAlpha) {}
    try { if (enemyFill) mod.SetUIWidgetBgAlpha(enemyFill, 0); } catch (_errEnemyAlpha) {}

    return;
  }
  const currentTeam = mod.GetTeam(p.player);
  const friendly = getFriendlyScore(currentTeam);
  const enemy = getOpponentScore(currentTeam);

  const friendlyFill = SafeFindWidget(CIPHER_FRIENDLY_PROGRESS_FILL_WIDGET_NAME_PREFIX + p.id);
  const enemyFill = SafeFindWidget(CIPHER_ENEMY_PROGRESS_FILL_WIDGET_NAME_PREFIX + p.id);

  const friendlyScore =
    p.friendlyScoreWidget ??
    SafeFindWidget(CIPHER_FRIENDLY_SCORE_TEXT_WIDGET_NAME_PREFIX + p.id);

  const enemyScore =
    p.opponentScoreWidget ??
    SafeFindWidget(CIPHER_ENEMY_SCORE_TEXT_WIDGET_NAME_PREFIX + p.id);

  const status = SafeFindWidget(CIPHER_LIVE_STATUS_WIDGET_NAME_PREFIX + p.id);
  const carrierStatus = SafeFindWidget(CIPHER_LIVE_CARRIER_STATUS_WIDGET_NAME_PREFIX + p.id);

  const friendlyWidth = getCipherScoreProgressWidth(friendly);
  const enemyWidth = getCipherScoreProgressWidth(enemy);

  SafeSetTextLabelHandle(
    friendlyScore,
    mod.Message((mod.stringkeys as any).Text_FRIENDLY_SCORE, friendly)
  );

  SafeSetTextLabelHandle(
    enemyScore,
    mod.Message((mod.stringkeys as any).Text_ENEMY_SCORE, enemy)
  );

  // IMPORTANT FIX:
  // Always re-lock the fills to the left edge of the ticker lanes.
  // If the engine treats the fill as center-anchored after resizing, this prevents it from drifting.
  SafeSetWidgetPositionHandle(friendlyFill, CIPHER_FRIENDLY_PROGRESS_POS);
  SafeSetWidgetPositionHandle(enemyFill, CIPHER_ENEMY_PROGRESS_POS);

  SafeSetWidgetSizeHandle(
    friendlyFill,
    mod.CreateVector(friendlyWidth, CIPHER_SCORE_PROGRESS_HEIGHT, 0)
  );

  SafeSetWidgetSizeHandle(
    enemyFill,
    mod.CreateVector(enemyWidth, CIPHER_SCORE_PROGRESS_HEIGHT, 0)
  );

  SafeSetWidgetVisibleHandle(friendlyFill, friendlyWidth > 0);
  SafeSetWidgetVisibleHandle(enemyFill, enemyWidth > 0);

  SafeSetWidgetBgColorHandle(friendlyFill, COLOR_FRIENDLY);
  SafeSetWidgetBgColorHandle(enemyFill, COLOR_ENEMY);

  // Restore alpha when live starts again.
  // The postmatch hide path sets fill alpha to 0 to prevent leftover bars.
  try { if (friendlyFill) mod.SetUIWidgetBgAlpha(friendlyFill, 0.8); } catch (_errFriendlyAlpha) {}
  try { if (enemyFill) mod.SetUIWidgetBgAlpha(enemyFill, 0.5); } catch (_errEnemyAlpha) {}

  const statusState = getCipherViewerMatchStatusMessage(p);
  SafeSetTextLabelHandle(status, statusState.message);
  SafeSetTextColorHandle(status, statusState.color);

  const carrierState = getCipherCarrierStatusForPlayer(p);
  SafeSetTextLabelHandle(carrierStatus, carrierState.message);
  SafeSetTextColorHandle(carrierStatus, carrierState.color);
  SafeSetWidgetVisibleHandle(carrierStatus, carrierState.visible);
}


// -------------------------------------------------------------------------------------------------
// UI SAFE HELPERS
// Prevent runtime errors if a widget name does not exist yet (join-in-progress / rebuild races).
// These functions do nothing if the widget is missing.
// -------------------------------------------------------------------------------------------------


function SafeFindWidget(name: string | undefined | null): mod.UIWidget | null {
  if (!isValidUiWidgetName(name)) return null;

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
  SafeSetWidgetVisibleByName("LiveTimerIntroContainer", showIntro);
  SafeSetWidgetVisibleByName("matchtime", false);
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
  let hadAliveHud = false;
  serverPlayers.forEach((p) => {
    if (
      p.cipherSuddenDeathAliveRootWidget ||
      p.cipherSuddenDeathAlivePanelWidget ||
      p.cipherSuddenDeathFriendlyAliveSlotWidgets.length > 0 ||
      p.cipherSuddenDeathEnemyAliveSlotWidgets.length > 0
    ) hadAliveHud = true;
  });
  cipherSuddenDeathEliminatedByPlayerId = {};
  cipherSuddenDeathPostmatchPending = false;
  cipherSuddenDeathPostmatchToken += 1;
  cipherSuddenDeathUndeployIgnoreUntilSec = 0;
  cipherSuddenDeathForcedUndeployTokenCounter += 1;
  cipherSuddenDeathForcedUndeployTokenByPlayerId = {};
  if (hadAliveHud) deleteCipherSuddenDeathAliveHudForAllPlayers();
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
  if (gameStatus === 3) {
    showBombNoticeForAllPlayers(messageKey, fallbackText, durationSeconds);
  }
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

function getCipherTransitionAbsolutePos(relativePos: mod.Vector): mod.Vector {
  return mod.Add(CIPHER_TRANSITION_PANEL_POS, relativePos);
}

function getCipherTransitionProgressPosition(useDeployCenteredLayout: boolean): mod.Vector {
  return getCipherTransitionAbsolutePos(
    useDeployCenteredLayout ? CIPHER_TRANSITION_DEPLOY_PROGRESS_POS : CIPHER_TRANSITION_PROGRESS_POS
  );
}

function getCipherTransitionTimerPosition(useDeployCenteredLayout: boolean): mod.Vector {
  return getCipherTransitionAbsolutePos(
    useDeployCenteredLayout ? CIPHER_TRANSITION_DEPLOY_TIMER_POS : CIPHER_TRANSITION_TIMER_POS
  );
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
    uiRoot,
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
    getCipherTransitionAbsolutePos(CIPHER_TRANSITION_TITLE_POS),
    CIPHER_TRANSITION_TITLE_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
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
    getCipherTransitionAbsolutePos(CIPHER_TRANSITION_SUBTITLE_POS),
    CIPHER_TRANSITION_ROW_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
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
    getCipherTransitionProgressPosition(false),
    CIPHER_TRANSITION_ROW_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
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
    getCipherTransitionTimerPosition(false),
    CIPHER_TRANSITION_ROW_SIZE,
    mod.UIAnchor.Center,
    uiRoot,
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
  pruneCipherTransitionDeployTracking("deploy_counts");

  let required = 0;
  let ready = 0;
  const transitionToken = getCipherSecondHalfForceDeployToken();

  for (const playerIdKey in cipherSecondHalfDeployRequiredByPlayerId) {
    const playerId = Number(playerIdKey);
    const sp = serverPlayers.get(playerId);
    if (!sp || !isRequiredSecondHalfDeployPlayer(sp)) {
      continue;
    }

    required += 1;
    if (
      cipherSecondHalfDeployReadyByPlayerId[playerId] === true &&
      cipherTransitionDeploySeenByPlayerId[playerId] === true &&
      cipherTransitionDeployAckTokenByPlayerId[playerId] === transitionToken
    ) {
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
  const intermissionStage = cipherSecondHalfTransitionStage === "intermission";
  const predeployStage = cipherSecondHalfTransitionStage === "predeployReset";
  showCipherTransitionHudForAllPlayers(
    cipherTransitionDeployTitleKey,
    cipherTransitionDeployTitleFallback,
    cipherTransitionSubtitleKey,
    predeployStage ? "SETTING UP DEPLOYMENT" : cipherTransitionSubtitleFallback,
    intermissionStage
      ? (mod.stringkeys as any).CipherStartsIn
      : (mod.stringkeys as any).CipherForceDeployIn,
    intermissionStage ? "STARTS IN {}" : "FORCE DEPLOY IN {}",
    predeployStage ? 0 : cipherTransitionCountdownSeconds,
    !(intermissionStage || predeployStage),
    !(intermissionStage || predeployStage)
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
  const effectiveShowDeployProgress = showDeployProgress && cipherSecondHalfTransitionStage !== "intermission" && cipherSecondHalfTransitionStage !== "predeployReset";
  const timerLabel = getStringMessageWithFallback1(timerKey, timerFallback, secondsRemaining);
  const subtitleLabel = getStringMessageWithFallback(subtitleKey, subtitleFallback);

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!ensureCipherTransitionHudForPlayer(p)) return;
    SafeSetWidgetPositionHandle(p.cipherTransitionPanelWidget, CIPHER_TRANSITION_PANEL_POS);
    SafeSetWidgetSizeHandle(p.cipherTransitionPanelWidget, CIPHER_TRANSITION_PANEL_SIZE);
    SafeSetWidgetPositionHandle(p.cipherTransitionTitleWidget, getCipherTransitionAbsolutePos(CIPHER_TRANSITION_TITLE_POS));
    SafeSetWidgetSizeHandle(p.cipherTransitionTitleWidget, CIPHER_TRANSITION_TITLE_SIZE);
    SafeSetWidgetPositionHandle(p.cipherTransitionSubtitleWidget, getCipherTransitionAbsolutePos(CIPHER_TRANSITION_SUBTITLE_POS));
    SafeSetWidgetSizeHandle(p.cipherTransitionSubtitleWidget, CIPHER_TRANSITION_ROW_SIZE);
    SafeSetWidgetSizeHandle(p.cipherTransitionProgressWidget, CIPHER_TRANSITION_ROW_SIZE);
    SafeSetWidgetSizeHandle(p.cipherTransitionTimerWidget, CIPHER_TRANSITION_ROW_SIZE);
    setCipherTransitionHudDepthForPlayer(p);
    SafeSetTextLabelHandle(p.cipherTransitionTitleWidget, title);
    SafeSetTextLabelHandle(p.cipherTransitionSubtitleWidget, subtitleLabel);
    SafeSetTextLabelHandle(p.cipherTransitionProgressWidget, progressLabel);
    SafeSetTextLabelHandle(p.cipherTransitionTimerWidget, timerLabel);
    SafeSetWidgetPositionHandle(
      p.cipherTransitionProgressWidget,
      getCipherTransitionProgressPosition(useDeployCenteredLayout)
    );
    SafeSetWidgetPositionHandle(
      p.cipherTransitionTimerWidget,
      getCipherTransitionTimerPosition(useDeployCenteredLayout)
    );
    setCipherTransitionHudVisibleForPlayer(p, true);
    SafeSetWidgetVisibleHandle(p.cipherTransitionTitleWidget, !useDeployCenteredLayout);
    SafeSetWidgetVisibleHandle(p.cipherTransitionSubtitleWidget, !useDeployCenteredLayout);
    SafeSetWidgetVisibleHandle(p.cipherTransitionProgressWidget, effectiveShowDeployProgress);
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
const CIPHER_SD_ALIVE_PANEL_CENTER_X = CIPHER_SD_ALIVE_PANEL_POS_X + 144.01;
const CIPHER_SD_ALIVE_PANEL_CENTER_Y = CIPHER_SD_ALIVE_PANEL_POS_Y + 44;

function getCipherSuddenDeathAliveTextTopLeftPos(
  relativeX: number,
  relativeY: number,
  width: number,
  height: number
): mod.Vector {
  return mod.CreateVector(
    CIPHER_SD_ALIVE_PANEL_CENTER_X + relativeX - (width / 2),
    CIPHER_SD_ALIVE_PANEL_CENTER_Y + relativeY - (height / 2),
    0
  );
}

function getCipherSuddenDeathAliveTitlePos(): mod.Vector {
  return getCipherSuddenDeathAliveTextTopLeftPos(0, -30, 260, 20);
}

function getCipherSuddenDeathAliveFriendlyLabelPos(): mod.Vector {
  return getCipherSuddenDeathAliveTextTopLeftPos(-96, -6, 54, 22);
}

function getCipherSuddenDeathAliveEnemyLabelPos(): mod.Vector {
  return getCipherSuddenDeathAliveTextTopLeftPos(-96, 24, 54, 22);
}

function getCipherSuddenDeathAliveSlotPos(slotIndex: number, rowY: number): mod.Vector {
  const slotX = CIPHER_SD_ALIVE_SLOT_START_X + (slotIndex * CIPHER_SD_ALIVE_SLOT_SPACING_X);
  return getCipherSuddenDeathAliveTextTopLeftPos(slotX, rowY, 20, 24);
}

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

function reassertCipherSuddenDeathAliveHudLayoutForPlayer(p: Player): void {
  SafeSetWidgetPositionHandle(p.cipherSuddenDeathAlivePanelWidget, CIPHER_SD_ALIVE_PANEL_POS);
  SafeSetWidgetSizeHandle(p.cipherSuddenDeathAlivePanelWidget, CIPHER_SD_ALIVE_PANEL_SIZE);
  SafeSetWidgetBgColorHandle(p.cipherSuddenDeathAlivePanelWidget, CIPHER_TRANSITION_PANEL_COLOR);
  try { if (p.cipherSuddenDeathAlivePanelWidget) mod.SetUIWidgetBgAlpha(p.cipherSuddenDeathAlivePanelWidget, 0.5); } catch (_errAlpha) {}
  try { if (p.cipherSuddenDeathAlivePanelWidget) mod.SetUIWidgetBgFill(p.cipherSuddenDeathAlivePanelWidget, mod.UIBgFill.Solid); } catch (_errFill) {}

  SafeSetWidgetPositionHandle(p.cipherSuddenDeathAliveTitleWidget, getCipherSuddenDeathAliveTitlePos());
  SafeSetWidgetSizeHandle(p.cipherSuddenDeathAliveTitleWidget, CIPHER_SD_ALIVE_TITLE_SIZE);
  SafeSetTextSizeHandle(p.cipherSuddenDeathAliveTitleWidget, CIPHER_SD_ALIVE_TITLE_TEXT_SIZE);
  SafeSetTextColorHandle(p.cipherSuddenDeathAliveTitleWidget, CIPHER_TRANSITION_ACCENT_COLOR);

  SafeSetWidgetPositionHandle(p.cipherSuddenDeathFriendlyAliveWidget, getCipherSuddenDeathAliveFriendlyLabelPos());
  SafeSetWidgetSizeHandle(p.cipherSuddenDeathFriendlyAliveWidget, CIPHER_SD_ALIVE_LABEL_SIZE);
  SafeSetTextSizeHandle(p.cipherSuddenDeathFriendlyAliveWidget, CIPHER_SD_ALIVE_LABEL_TEXT_SIZE);

  SafeSetWidgetPositionHandle(p.cipherSuddenDeathEnemyAliveWidget, getCipherSuddenDeathAliveEnemyLabelPos());
  SafeSetWidgetSizeHandle(p.cipherSuddenDeathEnemyAliveWidget, CIPHER_SD_ALIVE_LABEL_SIZE);
  SafeSetTextSizeHandle(p.cipherSuddenDeathEnemyAliveWidget, CIPHER_SD_ALIVE_LABEL_TEXT_SIZE);

  for (let i = 0; i < CIPHER_SD_ALIVE_MAX_SLOTS_PER_TEAM; i++) {
    SafeSetWidgetPositionHandle(p.cipherSuddenDeathFriendlyAliveSlotWidgets[i], getCipherSuddenDeathAliveSlotPos(i, -6));
    SafeSetWidgetSizeHandle(p.cipherSuddenDeathFriendlyAliveSlotWidgets[i], CIPHER_SD_ALIVE_SLOT_SIZE);
    SafeSetWidgetPositionHandle(p.cipherSuddenDeathEnemyAliveSlotWidgets[i], getCipherSuddenDeathAliveSlotPos(i, 24));
    SafeSetWidgetSizeHandle(p.cipherSuddenDeathEnemyAliveSlotWidgets[i], CIPHER_SD_ALIVE_SLOT_SIZE);
  }

  setCipherSuddenDeathAliveHudDepthForPlayer(p);
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
    uiRoot,
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
    getCipherSuddenDeathAliveTitlePos(),
    CIPHER_SD_ALIVE_TITLE_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
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
    getCipherSuddenDeathAliveFriendlyLabelPos(),
    CIPHER_SD_ALIVE_LABEL_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
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
    getCipherSuddenDeathAliveEnemyLabelPos(),
    CIPHER_SD_ALIVE_LABEL_SIZE,
    mod.UIAnchor.TopLeft,
    uiRoot,
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
    mod.AddUIText(
      getCipherSuddenDeathFriendlyAliveSlotWidgetName(playerId, i),
      getCipherSuddenDeathAliveSlotPos(i, -6),
      CIPHER_SD_ALIVE_SLOT_SIZE,
      mod.UIAnchor.TopLeft,
      uiRoot,
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
      getCipherSuddenDeathAliveSlotPos(i, 24),
      CIPHER_SD_ALIVE_SLOT_SIZE,
      mod.UIAnchor.TopLeft,
      uiRoot,
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
  if (!visible) {
    bindCipherSuddenDeathAliveHudRefsForPlayer(p);
    if (!p.cipherSuddenDeathAliveRootWidget && !p.cipherSuddenDeathAlivePanelWidget) return;
  } else if (!ensureCipherSuddenDeathAliveHudForPlayer(p)) {
    return;
  }
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
  reassertCipherSuddenDeathAliveHudLayoutForPlayer(p);
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
  const next = getNextValidHumanPlayerForUiLane(suddenDeathAliveHudCursor);
  suddenDeathAliveHudCursor = next.nextCursor;
  if (next.player) updateCipherSuddenDeathAliveHudForPlayer(next.player);
}

function hideCipherSuddenDeathAliveHudForAllPlayers(): void {
  queuePhaseUiCleanupForKnownPlayers();
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
  if (!isValidHumanPlayerState(p)) return false;
  if (!mod.Equals(p.team, team1) && !mod.Equals(p.team, team2)) return false;
  return true;
}

function resetCipherSecondHalfDeployPlayerTracking(): void {
  cipherSecondHalfDeployRequiredByPlayerId = {};
  cipherSecondHalfDeployReadyByPlayerId = {};
  cipherTransitionDeploySeenByPlayerId = {};
  cipherTransitionDeployAckTokenByPlayerId = {};
  cipherTransitionTeleportedByPlayerId = {};
  cipherTransitionDeployReconcileCursor = 0;
  cipherTransitionDeployLastHudStateKey = "";
  cipherTransitionRosterLastDiagnostic = "";
  cipherTransitionForceDeployQueue = [];
  cipherTransitionForceDeployIssuedTokenByPlayerId = {};
  cipherTransitionForceFinishToken = 0;
  cipherTransitionForceFinishMinUntilSec = 0;
  cipherTransitionForceFinishDeadlineSec = 0;
}


function resetCipherSecondHalfDeployTracking(): void {
  resetCipherSecondHalfDeployPlayerTracking();
  cipherTransitionCountdownSeconds = 0;
  cipherTransitionDeployTitleKey = undefined;
  cipherTransitionDeployTitleFallback = "";
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
  cipherSecondHalfFrozenByPlayerId = {};
  hardUnlockCipherLiveInputsForAllPlayers("clear_second_half_freeze");
}

function applyCipherSecondHalfDeployFreezeForReadyPlayers(source: string): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;

  // During the full 30-second deploy phase and timeout force-deploy settle, every
  // deployed human stays frozen until the live finalizer releases input.
  serverPlayers.forEach((p) => {
    if (!p || !p.isDeployed || !mod.IsPlayerValid(p.player)) return;
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

  if (cipherSecondHalfTransitionStage === "deploy") {
    // Spawned humans and bots stay locked until the new phase actually goes live.
    applyCipherSecondHalfDeployFreezeForReadyPlayers(source);
    applyRuntimeBotPhaseLocksForAll(source + "_bots");
    return;
  }

  applyRuntimeBotPhaseLocksForAll(source + "_bots");
}

let pendingLiveInputUnlockPlayerIds: number[] = [];
let pendingLiveInputUnlockCursor = 0;

function processPendingLiveInputUnlock(): void {
  if (pendingLiveInputUnlockCursor >= pendingLiveInputUnlockPlayerIds.length) {
    pendingLiveInputUnlockPlayerIds = [];
    pendingLiveInputUnlockCursor = 0;
    return;
  }
  const playerId = pendingLiveInputUnlockPlayerIds[pendingLiveInputUnlockCursor++];
  const p = getValidHumanPlayerById(playerId);
  if (!p) return;
  try {
    clearCipherLiveInputRestrictionsForPlayer(p.player);
  } catch (err) {
    LogRuntimeError("TransitionHardUnlock/" + String(playerId), err);
  }
}

function hardUnlockCipherLiveInputsForAllPlayers(_source: string): void {
  cipherSecondHalfFrozenByPlayerId = {};
  if (pendingLiveInputUnlockPlayerIds.length <= 0) {
    pendingLiveInputUnlockPlayerIds = getValidHumanPlayersSnapshot().map((p) => p.id);
    pendingLiveInputUnlockCursor = 0;
  }
  processPendingLiveInputUnlock();
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
  preserveDeployRestoreCache: boolean = false,
  skipPlayerInputFanout: boolean = false
): void {
  clearDeferredCipherDeliveryTransitionTimer();
  clearDeferredCipherTimeoutTransitionTimer();

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
  if (!skipPlayerInputFanout) {
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

function scheduleCipherLiveInputUnlockReasserts(
  expectedStage: CipherMatchStage,
  source: string
): void {
  const delays = [0.25, 0.75, 1.0];
  for (let i = 0; i < delays.length; i++) {
    scheduleCipherGlobalTask(delays[i], "live_input_unlock/" + source, () => {
      if (gameStatus !== 3) return;
      if (cipherMatchStage !== expectedStage) return;
      if (cipherSecondHalfTransitionStage !== "none") return;
      hardUnlockCipherLiveInputsForAllPlayers(source);
    });
  }
}

function startCipherPostTransitionLiveInputUnlock(expectedStage: CipherMatchStage, source: string): void {
  hardUnlockCipherLiveInputsForAllPlayers(source);
  scheduleCipherLiveInputUnlockReasserts(expectedStage, source);
}

function markCipherSecondHalfDeployRequiredPlayers(): void {
  resetCipherSecondHalfDeployPlayerTracking();
  serverPlayers.forEach((p) => {
    if (!isRequiredSecondHalfDeployPlayer(p)) return;
    cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;
  });
}


function refreshCipherTransitionDeployRequiredRoster(source: string): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;
  const presentRequiredIds: { [playerId: number]: boolean } = {};

  serverPlayers.forEach((p) => {
    if (!isRequiredSecondHalfDeployPlayer(p)) return;
    presentRequiredIds[p.id] = true;
    cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;
  });

  for (const key in cipherSecondHalfDeployRequiredByPlayerId) {
    const playerId = Number(key);
    if (presentRequiredIds[playerId] === true) continue;
    delete cipherSecondHalfDeployRequiredByPlayerId[playerId];
    delete cipherSecondHalfDeployReadyByPlayerId[playerId];
    delete cipherTransitionDeploySeenByPlayerId[playerId];
    delete cipherTransitionDeployAckTokenByPlayerId[playerId];
    delete cipherTransitionTeleportedByPlayerId[playerId];
  }

  pruneCipherTransitionDeployTracking(source + "_post");

  const counts = getCipherDeployCounts();
  let deployed = 0;
  for (const key in presentRequiredIds) {
    const p = serverPlayers.get(Number(key));
    if (p?.isDeployed === true) deployed += 1;
  }
  const diagnostic = String(counts.required) + "/" + String(counts.ready) + "/" + String(deployed);
  if (diagnostic !== cipherTransitionRosterLastDiagnostic) {
    cipherTransitionRosterLastDiagnostic = diagnostic;
    emitPlayerLifecycleDiagnostic(
      "TRANSITION_ROSTER required=" + String(counts.required) +
        " ready=" + String(counts.ready) + " deployed=" + String(deployed)
    );
  }
}

function reconcileCipherTransitionDeployReadiness(source: string): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;

  refreshCipherTransitionDeployRequiredRoster(source);
  const transitionToken = getCipherSecondHalfForceDeployToken();

  const requiredIds: number[] = [];
  for (const key in cipherSecondHalfDeployRequiredByPlayerId) {
    const playerId = Number(key);
    const sp = serverPlayers.get(playerId);
    if (!sp || !isRequiredSecondHalfDeployPlayer(sp)) {
      delete cipherSecondHalfDeployRequiredByPlayerId[playerId];
      delete cipherSecondHalfDeployReadyByPlayerId[playerId];
      delete cipherTransitionDeploySeenByPlayerId[playerId];
      delete cipherTransitionDeployAckTokenByPlayerId[playerId];
      delete cipherTransitionTeleportedByPlayerId[playerId];
      continue;
    }
    requiredIds.push(playerId);
  }

  if (requiredIds.length <= 0) {
    cipherTransitionDeployReconcileCursor = 0;
    return;
  }

  if (cipherTransitionDeployReconcileCursor >= requiredIds.length) cipherTransitionDeployReconcileCursor = 0;

  let processed = 0;
  while (processed < CIPHER_TRANSITION_DEPLOY_RECONCILE_PLAYERS_PER_TICK && requiredIds.length > 0) {
    const index = cipherTransitionDeployReconcileCursor % requiredIds.length;
    const playerId = requiredIds[index];
    cipherTransitionDeployReconcileCursor = (index + 1) % requiredIds.length;
    processed += 1;

    const sp = serverPlayers.get(playerId);
    if (!sp || !mod.IsPlayerValid(sp.player)) continue;

    const acknowledged =
      cipherSecondHalfDeployReadyByPlayerId[playerId] === true &&
      cipherTransitionDeploySeenByPlayerId[playerId] === true &&
      cipherTransitionDeployAckTokenByPlayerId[playerId] === transitionToken;
    if (!acknowledged) {
      delete cipherSecondHalfDeployReadyByPlayerId[playerId];
      if (cipherTransitionDeployAckTokenByPlayerId[playerId] !== transitionToken) {
        delete cipherTransitionDeploySeenByPlayerId[playerId];
        delete cipherTransitionDeployAckTokenByPlayerId[playerId];
      }
      continue;
    }

    if (cipherTransitionTeleportedByPlayerId[playerId] !== true) {
      requestCipherSpawnAnchorForPlayer(playerId, true);
      requestCipherSpawnTeleportForPlayer(playerId, true);
    }
  }
}

function markCipherSecondHalfDeployRequiredForPlayer(p: Player): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;
  if (!isRequiredSecondHalfDeployPlayer(p)) return;
  cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;
}

function markCipherSecondHalfDeployReadyForPlayer(playerId: number, player: mod.Player, forced: boolean = false): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;
  if (cipherTransitionDeploySeenByPlayerId[playerId] !== true) return;
  if (cipherTransitionDeployAckTokenByPlayerId[playerId] !== getCipherSecondHalfForceDeployToken()) return;
  const sp = serverPlayers.get(playerId);
  if (!sp) return;
  const wasRequired = cipherSecondHalfDeployRequiredByPlayerId[playerId] === true;
  if (!wasRequired) {
    return;
  }
  if (cipherSecondHalfDeployRequiredByPlayerId[playerId] !== true) return;
  sp.isDeployed = true;
  cipherTransitionDeploySeenByPlayerId[playerId] = true;
  cipherSecondHalfDeployReadyByPlayerId[playerId] = true;
  void player;
  void forced;
}

function clearCipherSecondHalfDeployReadyForPlayer(playerId: number, force: boolean = false): void {
  delete cipherSecondHalfDeployReadyByPlayerId[playerId];
  delete cipherTransitionDeploySeenByPlayerId[playerId];
  delete cipherTransitionDeployAckTokenByPlayerId[playerId];
  void force;
}

function repairCipherTransitionSupervisorOwnershipForDeployAdvance(source: string): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;

  if (cipherLiveTransitionSupervisorKind === "secondHalf") {
    cipherSecondHalfTransitionActive = true;
    cipherSuddenDeathTransitionActive = false;
    if (cipherLiveTransitionSupervisorToken <= 0 && cipherSecondHalfTransitionToken > 0) {
      cipherLiveTransitionSupervisorToken = cipherSecondHalfTransitionToken;
    } else if (cipherLiveTransitionSupervisorToken > 0 && cipherSecondHalfTransitionToken !== cipherLiveTransitionSupervisorToken) {
      // The deploy stage is owned by the supervisor token. If another cleanup path
      // nudged the phase token, restore the active transition to the supervisor token instead
      // of leaving the deploy phase permanently stuck at DEPLOYED N/N.
      cipherSecondHalfTransitionToken = cipherLiveTransitionSupervisorToken;
    }
  } else if (cipherLiveTransitionSupervisorKind === "suddenDeath") {
    cipherSuddenDeathTransitionActive = true;
    cipherSecondHalfTransitionActive = false;
    if (cipherLiveTransitionSupervisorToken <= 0 && cipherSuddenDeathTransitionToken > 0) {
      cipherLiveTransitionSupervisorToken = cipherSuddenDeathTransitionToken;
    } else if (cipherLiveTransitionSupervisorToken > 0 && cipherSuddenDeathTransitionToken !== cipherLiveTransitionSupervisorToken) {
      cipherSuddenDeathTransitionToken = cipherLiveTransitionSupervisorToken;
    }
  } else if (cipherSecondHalfTransitionActive) {
    cipherLiveTransitionSupervisorKind = "secondHalf";
    cipherLiveTransitionSupervisorToken = cipherSecondHalfTransitionToken;
  } else if (cipherSuddenDeathTransitionActive) {
    cipherLiveTransitionSupervisorKind = "suddenDeath";
    cipherLiveTransitionSupervisorToken = cipherSuddenDeathTransitionToken;
  }

  void source;
}

function isCipherTransitionForceFinishActive(): boolean {
  const transitionToken = getCipherSecondHalfForceDeployToken();
  return transitionToken > 0 && cipherTransitionForceFinishToken === transitionToken;
}

function beginCipherTransitionForceDeployFinish(nowSec: number, source: string): boolean {
  if (cipherSecondHalfTransitionStage !== "deploy") return false;
  repairCipherTransitionSupervisorOwnershipForDeployAdvance(source + "_repair");

  const transitionToken = getCipherSecondHalfForceDeployToken();
  if (transitionToken <= 0) return false;
  if (cipherTransitionForceFinishToken === transitionToken) return true;

  cipherTransitionForceFinishToken = transitionToken;
  cipherTransitionForceFinishMinUntilSec = nowSec + CIPHER_SECOND_HALF_FORCE_DEPLOY_SETTLE_SECONDS;
  cipherTransitionForceFinishDeadlineSec = nowSec + CIPHER_SECOND_HALF_FORCE_DEPLOY_WATCHDOG_SECONDS;
  cipherTransitionForceDeployIssuedTokenByPlayerId = {};
  cipherTransitionForceDeployQueue = [];
  cipherTransitionForceDeployQueueToken = transitionToken;
  requestForceDeployForMissingCipherSecondHalfPlayers(source + "_force_missing");
  refreshCipherTransitionSupervisorSecond(0, true);
  return true;
}

function hasUnissuedCipherTransitionRequiredPlayer(transitionToken: number): boolean {
  for (const key in cipherSecondHalfDeployRequiredByPlayerId) {
    const playerId = Number(key);
    if (cipherSecondHalfDeployRequiredByPlayerId[playerId] !== true) continue;
    if (
      cipherSecondHalfDeployReadyByPlayerId[playerId] === true &&
      cipherTransitionDeploySeenByPlayerId[playerId] === true &&
      cipherTransitionDeployAckTokenByPlayerId[playerId] === transitionToken
    ) {
      continue;
    }
    if (cipherTransitionForceDeployIssuedTokenByPlayerId[playerId] === transitionToken) continue;
    return true;
  }
  return false;
}

function tickCipherTransitionForceDeployFinish(nowSec: number, source: string): boolean {
  if (!isCipherTransitionForceFinishActive()) return false;
  const transitionToken = getCipherSecondHalfForceDeployToken();

  refreshCipherTransitionDeployRequiredRoster(source + "_roster");
  queueMissingCipherTransitionForceDeployPlayers(source + "_queue_missing");
  processCipherTransitionForceDeployQueue(source + "_force_queue");
  applyCipherTransitionInputLocksForPlayers(source + "_locks");

  const timedOut = nowSec >= cipherTransitionForceFinishDeadlineSec;
  const settled = nowSec >= cipherTransitionForceFinishMinUntilSec;
  const forceWorkComplete =
    cipherTransitionForceDeployQueue.length <= 0 &&
    !hasUnissuedCipherTransitionRequiredPlayer(transitionToken);
  if (!timedOut && (!settled || !forceWorkComplete)) return true;

  if (timedOut && !forceWorkComplete) {
    LogRuntimeError("TransitionForceDeployWatchdog/" + source, String(transitionToken));
  }
  completeCipherTransitionSupervisor(nowSec);
  return true;
}

function tryFinishCipherDeployPhase(source: string, nowSec: number, remaining: number): boolean {
  if (gameStatus !== 3 || !isCipherLiveTransitionActive()) return false;
  if (cipherSecondHalfTransitionStage !== "deploy") return false;
  if (isCipherTransitionForceFinishActive()) {
    return tickCipherTransitionForceDeployFinish(nowSec, source + "_force_finish");
  }

  const counts = getCipherDeployCounts();
  if (counts.required > 0 && counts.ready >= counts.required) {
    completeCipherTransitionSupervisor(nowSec);
    return true;
  }
  if (remaining <= 0) {
    return beginCipherTransitionForceDeployFinish(nowSec, source + "_expired");
  }
  return false;
}

function getCipherSecondHalfForceDeployToken(): number {
  if (cipherLiveTransitionSupervisorToken > 0) return cipherLiveTransitionSupervisorToken;
  return cipherSecondHalfTransitionToken;
}

function queueMissingCipherTransitionForceDeployPlayers(source: string): void {
  if (!isCipherLiveTransitionActive()) return;
  pruneCipherTransitionDeployTracking(source + "_queue_missing");

  const transitionToken = getCipherSecondHalfForceDeployToken();
  if (transitionToken <= 0) return;

  if (cipherTransitionForceDeployQueueToken !== transitionToken) {
    cipherTransitionForceDeployQueueToken = transitionToken;
    cipherTransitionForceDeployQueue = [];
  }

  refreshCipherTransitionDeployRequiredRoster(source + "_refresh_roster");

  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;

    if (!isRequiredSecondHalfDeployPlayer(p)) {
      delete cipherSecondHalfDeployRequiredByPlayerId[p.id];
      delete cipherSecondHalfDeployReadyByPlayerId[p.id];
      delete cipherTransitionDeploySeenByPlayerId[p.id];
      delete cipherTransitionDeployAckTokenByPlayerId[p.id];
      delete cipherTransitionForceDeployIssuedTokenByPlayerId[p.id];
      return;
    }

    cipherSecondHalfDeployRequiredByPlayerId[p.id] = true;

    if (
      cipherSecondHalfDeployReadyByPlayerId[p.id] === true &&
      cipherTransitionDeploySeenByPlayerId[p.id] === true &&
      cipherTransitionDeployAckTokenByPlayerId[p.id] === transitionToken
    ) {
      return;
    }

    if (cipherTransitionForceDeployIssuedTokenByPlayerId[p.id] === transitionToken) return;

    if (cipherTransitionForceDeployQueue.indexOf(p.id) < 0) {
      cipherTransitionForceDeployQueue.push(p.id);
      cipherTransitionForceDeploySessionTokenByPlayerId[p.id] = ensurePlayerSessionToken(p.id);
    }
  });
}

function processCipherTransitionForceDeployQueue(source: string): void {
  if (!isCipherLiveTransitionActive()) return;
  if (cipherSecondHalfTransitionStage !== "deploy") return;
  pruneCipherTransitionDeployTracking(source + "_process_force");
  if (cipherTransitionForceDeployQueue.length <= 0) return;

  const transitionToken = getCipherSecondHalfForceDeployToken();
  if (transitionToken <= 0 || cipherTransitionForceDeployQueueToken !== transitionToken) {
    cipherTransitionForceDeployQueue = [];
    return;
  }

  let processed = 0;
  while (cipherTransitionForceDeployQueue.length > 0 && processed < CIPHER_TRANSITION_FORCE_DEPLOY_PLAYERS_PER_TICK) {
    const playerId = cipherTransitionForceDeployQueue.shift();
    if (playerId === undefined) continue;
    if (!isCurrentPlayerSession(playerId, cipherTransitionForceDeploySessionTokenByPlayerId[playerId])) continue;

    const p = serverPlayers.get(playerId);
    if (!p || !mod.IsPlayerValid(p.player)) continue;

    if (!isRequiredSecondHalfDeployPlayer(p)) {
      delete cipherSecondHalfDeployRequiredByPlayerId[playerId];
      delete cipherSecondHalfDeployReadyByPlayerId[playerId];
      delete cipherTransitionDeploySeenByPlayerId[playerId];
      delete cipherTransitionDeployAckTokenByPlayerId[playerId];
      delete cipherTransitionForceDeployIssuedTokenByPlayerId[playerId];
      continue;
    }

    cipherSecondHalfDeployRequiredByPlayerId[playerId] = true;

    if (
      cipherSecondHalfDeployReadyByPlayerId[playerId] === true &&
      cipherTransitionDeploySeenByPlayerId[playerId] === true &&
      cipherTransitionDeployAckTokenByPlayerId[playerId] === transitionToken
    ) {
      continue;
    }
    if (cipherTransitionForceDeployIssuedTokenByPlayerId[playerId] === transitionToken) continue;

    processed += 1;
    try {
      requestCipherSpawnAnchorForPlayer(playerId, true);
      mod.SetRedeployTime(p.player, 0);
      applyPhaseInputRestrictionsForPlayer(p.player);
      mod.DeployPlayer(p.player);
      cipherTransitionForceDeployIssuedTokenByPlayerId[playerId] = transitionToken;
    } catch (err) {
      LogRuntimeError("ForceDeploySecondHalf/" + source + "/" + String(playerId), err);
    }
  }
}

function forceDeployMissingCipherSecondHalfPlayersOnce(source: string): void {
  if (!isCipherLiveTransitionActive()) return;
  const transitionToken = getCipherSecondHalfForceDeployToken();
  if (transitionToken <= 0) return;

  if (cipherSecondHalfForceDeployIssuedForTransitionToken !== transitionToken) {
    cipherSecondHalfForceDeployIssuedForTransitionToken = transitionToken;
    cipherTransitionForceDeployQueue = [];
    cipherTransitionForceDeployQueueToken = transitionToken;
  }

  queueMissingCipherTransitionForceDeployPlayers(source);
  processCipherTransitionForceDeployQueue(source);
}

function requestForceDeployForMissingCipherSecondHalfPlayers(source: string): void {
  forceDeployMissingCipherSecondHalfPlayersOnce(source);
}

function handleCipherTransitionDeployedPlayer(
  playerId: number,
  player: mod.Player,
  source: string,
  forcedReady: boolean = false
): boolean {
  if (!isCipherLiveTransitionActive()) return false;
  if (!mod.IsPlayerValid(player) || !isPlayerAliveSafe(player)) return false;

  const sp = serverPlayers.get(playerId);
  if (!sp) return false;

  sp.team = mod.GetTeam(player);
  sp.isDeployed = true;

  try {
    mod.SetRedeployTime(player, 0);
  } catch (_errRedeploy) {}

  applyPrematch889HealthForPlayer(playerId);
  applyPhaseInputRestrictionsForPlayer(player);

  const isDeployReadinessStage = cipherSecondHalfTransitionStage === "deploy";

  if (isDeployReadinessStage) {
    const deployAckSeen =
      cipherTransitionDeploySeenByPlayerId[playerId] === true &&
      cipherTransitionDeployAckTokenByPlayerId[playerId] === getCipherSecondHalfForceDeployToken();
    markCipherSecondHalfDeployRequiredForPlayer(sp);
    setCipherSecondHalfDeployFreezeForPlayer(player, true, source + "_immediate_freeze");

    // Readiness is an explicit deploy acknowledgement, not an alive/position poll.
    // The deploy acknowledgement is set in OnPlayerDeployed after the transition
    // tracking state has been reset, so stale soldiers on the deploy map cannot skip
    // the full 30-second deployment window.
    if (deployAckSeen) {
      markCipherSecondHalfDeployReadyForPlayer(playerId, player, false);
    } else {
      refreshCipherTransitionHudForCurrentState();
    }
  }

  if (cipherTransitionTeleportedByPlayerId[playerId] !== true) {
    if (getCipherQueuedSpawnAnchorForPlayer(playerId) === undefined) {
      prepareCipherQueuedAnchorForPlayer(playerId);
    }

    const teleported = teleportCipherPlayerToRoutedAnchor(player, playerId);
    if (teleported && bombCarrierPlayerId === playerId) {
      syncCipherCarrierVisualsNow(getCurrentSchedulerNowSeconds(), "transition_deploy_teleport");
    }

    if (!teleported) {
      // Keep the native transition HQ spawn. Do not retry custom placement from
      // another scheduler lane after the single post-deploy attempt.
      delete cipherQueuedAnchorByPlayerId[playerId];
    }
  }

  clearTransitionSpawnStateForPlayer(playerId);

  if (isDeployReadinessStage) {
    setCipherSecondHalfDeployFreezeForPlayer(player, true, source + "_post_ready_freeze");
  } else {
    refreshCipherTransitionHudForCurrentState();
  }

  refreshCipherKeyPlayerSnapshots("handleCipherTransitionDeployedPlayer");
  void forcedReady;
  return true;
}

function runCipherTransitionStepWorkSafe(source: string): void {
  try {
    processCipherTransitionForceDeployQueue(source + "_force_queue");
  } catch (err) {
    LogRuntimeError("TransitionStep/processForceDeployQueue/" + source, err);
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

function hasCipherKeyAuthorityOrPending(): boolean {
  return (
    bombCarrierPlayerId !== undefined ||
    hasDroppedBombRuntimeObjects() ||
    hasBaseBombAuthorityOrPending()
  );
}

function resetCipherLiveKeyWatchdog(): void {
  cipherLiveKeyWatchdogActive = false;
  cipherLiveKeyWatchdogStartedAtSec = 0;
  cipherLiveKeyWatchdogLastAttemptAtSec = -999999;
  cipherLiveKeyWatchdogLastLogAtSec = -999999;
  cipherLiveKeyWatchdogHalf = cipherCurrentHalf;
  cipherLiveKeyWatchdogStage = cipherMatchStage;
}

function armCipherLiveKeyWatchdog(
  expectedHalf: CipherHalfIndex,
  expectedStage: CipherMatchStage,
  nowSec: number,
  _context: string
): void {
  cipherLiveKeyWatchdogActive = true;
  cipherLiveKeyWatchdogStartedAtSec = nowSec;
  cipherLiveKeyWatchdogLastAttemptAtSec = -999999;
  cipherLiveKeyWatchdogHalf = expectedHalf;
  cipherLiveKeyWatchdogStage = expectedStage;
}

function repairCipherLiveClockIfNeeded(nowSec: number, context: string): void {
  if (gameStatus !== 3 || initialization[3] !== true) return;
  if (isCipherLiveTransitionActive()) return;
  if (liveClockStarted && Number.isFinite(liveClockDeadlineAtSec) && liveClockDeadlineAtSec > 0) return;

  try {
    if (cipherMatchStage === "suddenDeath") {
      beginScriptOwnedLiveClockPhase(OVERTIME_TIME, nowSec, true);
    } else {
      beginScriptOwnedLiveClockPhase(ROUND_TIME, nowSec, cipherMatchStage === "half2");
    }
    emitLiveTransitionCheckpoint("live_watchdog_clock_repaired_" + context);
  } catch (err) {
    LogRuntimeError("LiveWatchdog/clock/" + context, err);
  }
}

function runCipherLiveKeyWatchdog(nowSec: number, context: string): void {
  if (gameStatus !== 3 || initialization[3] !== true) {
    resetCipherLiveKeyWatchdog();
    return;
  }
  if (isCipherLiveTransitionActive()) return;

  repairCipherLiveClockIfNeeded(nowSec, context);

  if (hasCipherKeyAuthorityOrPending()) {
    resetCipherLiveKeyWatchdog();
    return;
  }

  if (!cipherLiveKeyWatchdogActive) return;

  if (cipherLiveKeyWatchdogHalf !== cipherCurrentHalf || cipherLiveKeyWatchdogStage !== cipherMatchStage) {
    resetCipherLiveKeyWatchdog();
    return;
  }

  if (nowSec - cipherLiveKeyWatchdogStartedAtSec < CIPHER_LIVE_KEY_WATCHDOG_INITIAL_GRACE_SECONDS) return;
  if (nowSec - cipherLiveKeyWatchdogLastAttemptAtSec < CIPHER_LIVE_KEY_WATCHDOG_RETRY_SECONDS) return;

  cipherLiveKeyWatchdogLastAttemptAtSec = nowSec;
  if (nowSec - cipherLiveKeyWatchdogLastLogAtSec >= CIPHER_LIVE_KEY_WATCHDOG_LOG_SECONDS) {
    cipherLiveKeyWatchdogLastLogAtSec = nowSec;
    emitLiveTransitionCheckpoint("live_key_watchdog_retry_" + context);
  }

  try {
    if (!spawnBombPickupObjectAtLiveStart()) {
      scheduleCipherLiveStartKeyRetry("watchdog_" + context);
    }
  } catch (err) {
    LogRuntimeError("LiveWatchdog/key/" + context, err);
    scheduleCipherLiveStartKeyRetry("watchdog_exception_" + context);
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
    } else {
      resetCipherLiveKeyWatchdog();
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
  armCipherLiveKeyWatchdog(expectedHalf, expectedStage, getCurrentSchedulerNowSeconds(), context);
  cancelCipherGlobalTask(cipherDeferredLiveStartKeyTimerHandle);
  cipherDeferredLiveStartKeyTimerHandle = scheduleCipherGlobalTask(
    CIPHER_DEFERRED_LIVE_START_KEY_DELAY_SECONDS,
    "live_start_key/" + context,
    () => runDeferredCipherLiveStartKeySpawn(token, expectedHalf, expectedStage, context)
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
  cipherLiveTransitionSupervisorStageStartedAtMs = 0;
  cipherLiveTransitionSupervisorDeadlineAtMs = 0;
  cipherLiveTransitionSupervisorLastShownSeconds = -1;
  cipherTransitionForceDeployQueue = [];
  cipherTransitionForceDeployQueueToken = 0;
  cipherTransitionForceFinishToken = 0;
  cipherTransitionForceFinishMinUntilSec = 0;
  cipherTransitionForceFinishDeadlineSec = 0;
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
  const stageStartMs = Date.now();
  cipherLiveTransitionSupervisorDeadlineAtSec = nowSec + safeDurationSeconds;
  cipherLiveTransitionSupervisorDeadlineTick = serverTickCount + mod.Ceiling(safeDurationSeconds * TICK_RATE);
  cipherLiveTransitionSupervisorStageStartedAtMs = stageStartMs;
  cipherLiveTransitionSupervisorDeadlineAtMs = stageStartMs + safeDurationSeconds * 1000;
  cipherLiveTransitionSupervisorLastShownSeconds = -1;
  cipherTransitionDeployLastHudStateKey = "";
  cipherTransitionForceDeployQueue = [];
  if (stage === "deploy") {
    cipherTransitionForceFinishToken = 0;
    cipherTransitionForceFinishMinUntilSec = 0;
    cipherTransitionForceFinishDeadlineSec = 0;
  }
  setCipherTransitionCountdownSeconds(safeDurationSeconds);
}

function getCipherTransitionStageDurationSeconds(stage: CipherSecondHalfTransitionStage): number {
  if (stage === "intermission") return CIPHER_HALFTIME_INTERMISSION_SECONDS;
  if (stage === "predeployReset") return CIPHER_TRANSITION_PREDEPLOY_STAGE_SECONDS;
  if (stage === "deploy") return CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS;
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

function getCipherTransitionSupervisorWallRemainingSeconds(): number | undefined {
  if (cipherLiveTransitionSupervisorDeadlineAtMs <= 0) return undefined;
  const remainingMs = Math.max(0, cipherLiveTransitionSupervisorDeadlineAtMs - Date.now());
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

function getCipherTransitionSupervisorRemainingSeconds(nowSec: number): number {
  repairCipherTransitionSupervisorDeadlineIfMissing(nowSec);
  const wallRemainingSeconds = getCipherTransitionSupervisorWallRemainingSeconds();

  if (
    cipherSecondHalfTransitionStage === "intermission" ||
    cipherSecondHalfTransitionStage === "predeployReset" ||
    cipherSecondHalfTransitionStage === "deploy"
  ) {
    const remainingTicks = mod.Max(0, cipherLiveTransitionSupervisorDeadlineTick - serverTickCount);
    const tickRemainingSeconds = mod.Max(0, mod.Ceiling(remainingTicks / TICK_RATE));
    const timeRemainingSeconds = mod.Max(0, mod.Ceiling(cipherLiveTransitionSupervisorDeadlineAtSec - nowSec));
    let remainingSeconds = Math.min(tickRemainingSeconds, timeRemainingSeconds);
    if (wallRemainingSeconds !== undefined) {
      remainingSeconds = Math.min(remainingSeconds, wallRemainingSeconds);
    }
    return remainingSeconds;
  }

  let remainingSeconds = mod.Max(0, mod.Ceiling(cipherLiveTransitionSupervisorDeadlineAtSec - nowSec));
  if (wallRemainingSeconds !== undefined) {
    remainingSeconds = Math.min(remainingSeconds, wallRemainingSeconds);
  }
  return remainingSeconds;
}

function getCipherTransitionDeployHudStateKey(remainingSeconds: number): string {
  const counts = getCipherDeployCounts();
  return (
    String(remainingSeconds) +
    "/" +
    String(counts.ready) +
    "/" +
    String(counts.required) +
    "/" +
    (isCipherTransitionForceFinishActive() ? "force" : "ready")
  );
}

function showCipherTransitionSupervisorHud(remainingSeconds: number): void {
  if (cipherLiveTransitionSupervisorKind === "none") return;
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
    cipherTransitionDeployTitleKey,
    cipherTransitionDeployTitleFallback,
    cipherTransitionSubtitleKey,
    cipherTransitionSubtitleFallback,
    deployStage ? (mod.stringkeys as any).CipherForceDeployIn : (mod.stringkeys as any).CipherStartsIn,
    deployStage ? "FORCE DEPLOY IN {}" : "STARTS IN {}",
    remainingSeconds,
    !intermissionStage,
    deployStage
  );
}

function refreshCipherTransitionSupervisorSecond(remainingSeconds: number, force: boolean = false): void {
  const deployHudStateKey =
    cipherSecondHalfTransitionStage === "deploy"
      ? getCipherTransitionDeployHudStateKey(remainingSeconds)
      : "";
  if (
    !force &&
    cipherLiveTransitionSupervisorLastShownSeconds === remainingSeconds &&
    (cipherSecondHalfTransitionStage !== "deploy" || cipherTransitionDeployLastHudStateKey === deployHudStateKey)
  ) {
    return;
  }
  cipherLiveTransitionSupervisorLastShownSeconds = remainingSeconds;
  cipherTransitionDeployLastHudStateKey = deployHudStateKey;
  setCipherTransitionCountdownSeconds(remainingSeconds);
  showCipherTransitionSupervisorHud(remainingSeconds);
  if (cipherSecondHalfTransitionStage === "deploy" && remainingSeconds > 0 && remainingSeconds <= 5) {
    playCountdownHeartbeatSafe(
      cipherLiveTransitionSupervisorKind + "_supervisor_deploy_heartbeat_" + String(remainingSeconds),
      remainingSeconds <= 3 ? 0.85 : 0.6
    );
  }
}

function handleTransitionDeployAckMinimal(
  eventPlayer: mod.Player,
  identity: SafeEventPlayerIdentity,
  source: string
): boolean {
  if (gameStatus !== 3) return false;
  if (!isCipherLiveTransitionActive()) return false;
  if (cipherSecondHalfTransitionStage !== "deploy") return false;
  if (identity.isBot || (identity.teamId !== 1 && identity.teamId !== 2)) return false;

  const transitionToken = getCipherSecondHalfForceDeployToken();
  if (transitionToken <= 0) return false;

  const sp = adoptLatestHumanPlayerHandleFromEvent(identity, eventPlayer, true, false);
  if (!sp) return false;

  sp.team = identity.team;
  sp.isDeployed = true;
  cipherSecondHalfDeployRequiredByPlayerId[identity.playerId] = true;
  cipherTransitionDeploySeenByPlayerId[identity.playerId] = true;
  cipherSecondHalfDeployReadyByPlayerId[identity.playerId] = true;
  cipherTransitionDeployAckTokenByPlayerId[identity.playerId] = transitionToken;
  requestCipherTransitionReconcile(source);
  return true;
}

function handleTransitionUndeployAckMinimal(
  eventPlayer: mod.Player,
  identity: SafeEventPlayerIdentity,
  source: string
): boolean {
  if (gameStatus !== 3) return false;
  if (!isCipherLiveTransitionActive()) return false;
  if (cipherSecondHalfTransitionStage !== "deploy") return false;
  if (identity.isBot || (identity.teamId !== 1 && identity.teamId !== 2)) return false;

  const sp = adoptLatestHumanPlayerHandleFromEvent(identity, eventPlayer, true, false);
  if (!sp) return false;

  const preserveReady =
    cipherTransitionDeploySeenByPlayerId[identity.playerId] === true &&
    cipherSecondHalfDeployReadyByPlayerId[identity.playerId] === true &&
    cipherTransitionDeployAckTokenByPlayerId[identity.playerId] === getCipherSecondHalfForceDeployToken();
  sp.team = identity.team;
  sp.isDeployed = preserveReady;
  if (!preserveReady) {
    delete cipherTransitionDeploySeenByPlayerId[identity.playerId];
    delete cipherSecondHalfDeployReadyByPlayerId[identity.playerId];
    delete cipherTransitionDeployAckTokenByPlayerId[identity.playerId];
  }
  requestCipherTransitionReconcile(source);
  return true;
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

  // Native callbacks only queue reconciliation. The authoritative transition
  // supervisor immediately below this queue drain owns all engine work and timing.
  cipherTransitionLastCheckpoint = "reconcile_queued/" + reason;
  void nowSec;
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


function resetCipherTransitionPreDeployResetState(): void {
  cipherTransitionPreDeployResetStarted = false;
  cipherTransitionPreDeployResetSource = "";
  cipherTransitionPreDeployBotSpawnerCursor = 0;
  cipherTransitionPreDeployBotInternalCleared = false;
  cipherTransitionPreDeployHumanQueue = [];
  cipherTransitionPreDeployHumanSessionTokenByPlayerId = {};
  cipherTransitionPreDeploySettleUntilSec = 0;
  cipherTransitionPreDeployEnterDeployScheduled = false;
  cipherTransitionPreDeployFirstWorkAtSec = 0;
  cipherTransitionIntermissionHandoffScheduled = false;
  cipherTransitionPreDeployNextWorkAtSec = 0;
  cipherTransitionPreDeployBotPlayerQueue = [];
}

function safeUnspawnRuntimeBotSpawnerForTransition(spawnerObjId: number, source: string): void {
  return;
}

function safeClearRuntimeBotInternalsForTransition(source: string): void {
  return;
}

function buildCipherTransitionBotRemovalQueue(): void {
  return;
}

function safeRemoveOneRuntimeBotForTransition(playerId: number, source: string): void {
  return;
}

function detachNativeBombBeforeTransitionCleanup(source: string): void {
  try {
    forceReleaseCipherNativeBombCarrier(source + "_native_bomb_detach");
  } catch (err) {
    LogRuntimeError("TransitionPreDeployReset/nativeBombDetach/" + source, err);
  }
}

function buildCipherTransitionHumanUndeployQueue(): void {
  cipherTransitionPreDeployHumanQueue = [];
  cipherTransitionPreDeployHumanSessionTokenByPlayerId = {};
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!isRequiredSecondHalfDeployPlayer(p)) return;
    if (cipherTransitionPreDeployHumanQueue.indexOf(p.id) >= 0) return;
    cipherTransitionPreDeployHumanQueue.push(p.id);
    cipherTransitionPreDeployHumanSessionTokenByPlayerId[p.id] = ensurePlayerSessionToken(p.id);
  });
}

function safeUndeployOneHumanForTransition(playerId: number, source: string): void {
  const p = serverPlayers.get(playerId);
  if (!p || !mod.IsPlayerValid(p.player)) return;
  if (!isRequiredSecondHalfDeployPlayer(p)) return;

  try {
    setCipherSecondHalfDeployFreezeForPlayer(p.player, true, source);
  } catch (err) {
    LogRuntimeError("TransitionPreDeployReset/freeze/" + source + "/" + String(p.id), err);
  }

  try {
    mod.SetRedeployTime(p.player, 9999);
  } catch (err) {
    LogRuntimeError("TransitionPreDeployReset/redeployLock/" + source + "/" + String(p.id), err);
  }

  try {
    if (p.isDeployed) {
      mod.UndeployPlayer(p.player);
    }
  } catch (err) {
    LogRuntimeError("TransitionPreDeployReset/undeploy/" + source + "/" + String(p.id), err);
  }

  p.isDeployed = false;
  clearCipherSecondHalfDeployReadyForPlayer(p.id, true);
}

function beginCipherTransitionPreDeployReset(nowSec: number, source: string): void {
  if (gameStatus !== 3) return;
  if (!isCipherLiveTransitionActive()) return;
  if (cipherSecondHalfTransitionStage !== "intermission" && cipherSecondHalfTransitionStage !== "predeployReset") return;

  if (!cipherTransitionPreDeployResetStarted) {
    cipherTransitionPreDeployResetStarted = true;
    cipherTransitionPreDeployResetSource = source;
    cipherTransitionPreDeployBotSpawnerCursor = 0;
    cipherTransitionPreDeployBotInternalCleared = false;
    cipherTransitionPreDeploySettleUntilSec = 0;
    cipherTransitionPreDeployEnterDeployScheduled = false;
    cipherTransitionPreDeployFirstWorkAtSec = nowSec + 0.75;
    cipherTransitionPreDeployNextWorkAtSec = cipherTransitionPreDeployFirstWorkAtSec;
    detachNativeBombBeforeTransitionCleanup(source);
    buildCipherTransitionBotRemovalQueue();
    buildCipherTransitionHumanUndeployQueue();
    applyCipherIncomingSecondHalfHqProfile(source + "_hq_profile");
    startCipherTransitionSupervisorStage("predeployReset", CIPHER_TRANSITION_PREDEPLOY_STAGE_SECONDS, nowSec);
  }

  // Do not run unspawn/undeploy work in the same server frame that the 5-second intermission hits 0.
  // The supervisor tick/job scheduler will process the predeploy reset over later frames.
}

function tickCipherTransitionPreDeployReset(nowSec: number): void {
  if (gameStatus !== 3) return;
  if (!isCipherLiveTransitionActive()) return;
  if (cipherSecondHalfTransitionStage !== "predeployReset") return;

  const source = cipherTransitionPreDeployResetSource.length > 0
    ? cipherTransitionPreDeployResetSource
    : "predeploy_reset";

  cipherTransitionLastCheckpoint = "predeploy_reset/" + source;
  setCipherTransitionCountdownSeconds(0);

  showCipherTransitionHudSafe(
    source + "_predeploy_reset_hud",
    cipherTransitionDeployTitleKey,
    cipherTransitionDeployTitleFallback,
    cipherTransitionSubtitleKey,
    "SETTING UP DEPLOYMENT",
    (mod.stringkeys as any).CipherForceDeployIn,
    "FORCE DEPLOY IN {}",
    0,
    false
  );

  try {
    applyCipherTransitionInputLocksForPlayers(source + "_input_locks");
  } catch (err) {
    LogRuntimeError("TransitionPreDeployReset/inputLocks/" + source, err);
  }

  if (cipherTransitionPreDeployFirstWorkAtSec > 0 && nowSec < cipherTransitionPreDeployFirstWorkAtSec) {
    return;
  }
  if (cipherTransitionPreDeployNextWorkAtSec > 0 && nowSec < cipherTransitionPreDeployNextWorkAtSec) {
    return;
  }

  if (cipherTransitionPreDeployBotPlayerQueue.length > 0) {
    const botPlayerId = cipherTransitionPreDeployBotPlayerQueue.shift();
    if (botPlayerId !== undefined) {
      safeRemoveOneRuntimeBotForTransition(botPlayerId, source);
      cipherTransitionPreDeployNextWorkAtSec = nowSec + 0.25;
      return;
    }
  }

  const authoredSpawnerIds = [CIPHER_RUNTIME_BOT_TEAM1_SPAWNER_ID, CIPHER_RUNTIME_BOT_TEAM2_SPAWNER_ID];
  let botWork = 0;
  while (
    cipherTransitionPreDeployBotSpawnerCursor < authoredSpawnerIds.length &&
    botWork < CIPHER_TRANSITION_BOT_UNSPAWN_WORK_PER_TICK
  ) {
    const spawnerObjId = authoredSpawnerIds[cipherTransitionPreDeployBotSpawnerCursor];
    cipherTransitionPreDeployBotSpawnerCursor += 1;
    botWork += 1;
    safeUnspawnRuntimeBotSpawnerForTransition(spawnerObjId, source);
    cipherTransitionPreDeployNextWorkAtSec = nowSec + 0.35;
  }

  if (cipherTransitionPreDeployBotSpawnerCursor < authoredSpawnerIds.length) return;

  if (!cipherTransitionPreDeployBotInternalCleared) {
    safeClearRuntimeBotInternalsForTransition(source);
    cipherTransitionPreDeployBotInternalCleared = true;
    cipherTransitionPreDeployNextWorkAtSec = nowSec + 0.35;
    return;
  }

  let humanWork = 0;
  while (cipherTransitionPreDeployHumanQueue.length > 0 && humanWork < CIPHER_TRANSITION_HUMAN_UNDEPLOY_WORK_PER_TICK) {
    const playerId = cipherTransitionPreDeployHumanQueue.shift();
    if (playerId !== undefined) {
      if (!isCurrentPlayerSession(playerId, cipherTransitionPreDeployHumanSessionTokenByPlayerId[playerId])) {
        delete cipherTransitionPreDeployHumanSessionTokenByPlayerId[playerId];
        continue;
      }
      safeUndeployOneHumanForTransition(playerId, source);
      delete cipherTransitionPreDeployHumanSessionTokenByPlayerId[playerId];
      humanWork += 1;
      cipherTransitionPreDeployNextWorkAtSec = nowSec + 0.35;
    }
  }

  if (cipherTransitionPreDeployHumanQueue.length > 0) return;

  if (cipherTransitionPreDeploySettleUntilSec <= 0) {
    cipherTransitionPreDeploySettleUntilSec = nowSec + (CIPHER_TRANSITION_PREDEPLOY_SETTLE_MS / 1000);
    return;
  }

  if (nowSec < cipherTransitionPreDeploySettleUntilSec) return;
  if (cipherTransitionPreDeployEnterDeployScheduled) return;
  cipherTransitionPreDeployEnterDeployScheduled = true;

  // Move the heavy deploy-stage entry out of the same tick that finished undeploy/unspawn cleanup.
  // This avoids Portal crashing exactly when the 0-second switching-sides cleanup completes.
  scheduleCipherGlobalTask(0.15, "transition_predeploy/" + source, () => {
    const enterNowSec = getCurrentSchedulerNowSeconds();
    if (gameStatus !== 3) return;
    if (!isCipherLiveTransitionActive()) return;
    if (cipherSecondHalfTransitionStage !== "predeployReset") return;

    resetCipherTransitionPreDeployResetState();

    try {
      enterCipherSecondHalfDeploySupervisorStage(enterNowSec);
    } catch (err) {
      LogRuntimeError("TransitionPreDeployReset/enterDeploy/" + source, err);
      recoverCipherTransitionSupervisorTickFailure(enterNowSec, "predeployReset", err);
    }
  });
}

function prepareCipherTransitionDeployStageLight(kind: CipherLiveTransitionSupervisorKind, context: string): void {
  cipherCurrentHalf = 2;
  cipherMatchStage = kind === "suddenDeath" ? "suddenDeath" : "half2";
  cipherHalfScores = [0, 0];
  cipherPendingScoreTransitionTeam = teamNeutral;

  if (kind === "suddenDeath") {
    resetCipherSuddenDeathState();
    serverPlayers.forEach((p) => {
      if (p) cipherSuddenDeathEliminatedByPlayerId[p.id] = false;
    });
  } else {
    resetCipherSuddenDeathState();
  }

  try {
    resetCipherSpawnRoutingState();
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/lightSpawnRouting/" + context, err);
  }

  try {
    ConfigureLiveSpawns();
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/lightConfigureLiveSpawns/" + context, err);
  }
}

function enterCipherSecondHalfDeploySupervisorStage(nowSec: number): void {
  if (gameStatus !== 3) return;
  if (!isCipherLiveTransitionActive()) return;

  cipherSecondHalfForceDeployIssuedForTransitionToken = 0;
  cipherTransitionUndeployCursor = 0;

  const kind = cipherLiveTransitionSupervisorKind;
  const context = kind === "suddenDeath" ? "sudden_death_supervisor_deploy" : "second_half_supervisor_deploy";

  // Keep transition freeze state intact. Players remain locked through the single
  // 30-second deploy stage and any timeout force-deploy settlement.

  try {
    prepareCipherTransitionDeployStageLight(kind, context);
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/lightPrepare", err);
  }

  startCipherFirstDeployAnchorSession(
    kind === "suddenDeath" ? "suddenDeath" : "half2",
    context + "_first_deploy_anchors"
  );

  try {
    applyCipherSecondHalfHqSpawns(kind + "_supervisor_deploy");
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
      clearCipherSecondHalfDeployReadyForPlayer(p.id, true);
      delete cipherTransitionDeploySeenByPlayerId[p.id];
      if (isRequiredSecondHalfDeployPlayer(p)) {
        p.isDeployed = false;
      }
    } catch (err) {
      LogRuntimeError("TransitionDeployStage/playerPrep/" + String(p.id), err);
    }
  });

  try {
    markCipherSecondHalfDeployRequiredPlayers();
    refreshCipherTransitionDeployRequiredRoster("deploy_stage_enter");
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/markRequired", err);
    resetCipherSecondHalfDeployPlayerTracking();
  }
  startCipherTransitionSupervisorStage("deploy", CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS, nowSec);

  try {
    applyCipherSecondHalfHqSpawns(kind + "_supervisor_deploy_after_mark_required");
  } catch (err) {
    LogRuntimeError("TransitionDeployStage/hqAfterRequired", err);
  }

  resetRuntimeBotStagedSpawnSchedule();
  // Do not spawn a bot on the same frame that the 30-second deploy phase starts.
  // The first staged bot spawn happens from the deploy supervisor tick, then one bot per second.
  runtimeBotStagedSpawnNextTick = serverTickCount + CIPHER_RUNTIME_BOT_STAGED_SPAWN_INTERVAL_TICKS;

  // Do not process deploy spawn/teleport work on the same frame that the deploy phase starts.
  // Let the supervisor tick perform that work on the next frame to avoid Portal transition crashes.
  applyCipherTransitionInputLocksForPlayers(kind + "_supervisor_deploy_enter_lock");
  applyRuntimeBotPhaseLocksForAll(kind + "_supervisor_deploy_enter_bot_lock");
  refreshCipherTransitionSupervisorSecond(CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS);
}

function restoreCipherTransitionPlayersForLive(redeploySeconds: number, context: string): void {
  serverPlayers.forEach((p) => {
    try {
      if (!p || !mod.IsPlayerValid(p.player)) return;
      mod.SetRedeployTime(p.player, redeploySeconds);
      setReadyPhaseProtectionForPlayer(p.player, false);
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
  cipherTransitionForceDeployQueue = [];
  cipherTransitionForceDeployQueueToken = 0;
  resetCipherTransitionPreDeployResetState();
  cipherTransitionLastCheckpoint = checkpoint;
}

function logCipherTransitionCheckpoint(name: string): void {
  const key = String(cipherTransitionWorkToken) + "/" + name;
  if (liveTransitionCheckpointSeenByKey[key] === true) return;
  liveTransitionCheckpointSeenByKey[key] = true;
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
    void cpId;
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
}

function applyCipherIncomingSecondHalfHqProfile(_context: string): void {
  setCipherHqPhaseProfile("half2", [TEAM1_LIVE_HQ, TEAM2_LIVE_HQ]);
}

function applyCipherSecondHalfHqEnableOnly(context: string): void {
  applyCipherSecondHalfHqSpawns(context);
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
  endCipherFirstDeployAnchorSession(context + "_live_start");
  cipherSuppressObjectiveEventsUntilSec =
    getCurrentSchedulerNowSeconds() + CIPHER_TRANSITION_OBJECTIVE_EVENT_SUPPRESS_SECONDS;
  if (expectedStage === "suddenDeath") {
    cipherSuddenDeathUndeployIgnoreUntilSec = getCurrentSchedulerNowSeconds() + 8;
  }
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
    if (failedStage === "intermission" || failedStage === "predeployReset") {
      beginCipherTransitionPreDeployReset(nowSec, "transition_recovery_" + failedStage);
      return;
    }

    if (failedStage === "deploy") {
      beginCipherTransitionForceDeployFinish(nowSec, "transition_recovery_deploy");
      return;
    }

    if (failedStage === "finalizing") {
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

  if (gameStatus !== 3) {
    abortCipherTransitionSupervisor("transition_supervisor_game_status_mismatch");
    return true;
  }

  if (!isCipherTransitionSupervisorCurrent()) {
    // Do not crash or hard-abort into a broken state if a timer callback and live tick overlap.
    // Try to recover the active timeout/halftime transition once.
    recoverCipherTransitionSupervisorTickFailure(
      nowSec,
      cipherSecondHalfTransitionStage,
      "transition_supervisor_token_mismatch"
    );
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
      // During switching-sides intermission, freeze/lock only.
      // Do not undeploy humans and do not clear bots until the 5-second intermission reaches 0.
      applyCipherIntermissionFreezeForDeployedPlayers("second_half_supervisor_intermission");
      applyRuntimeBotPhaseLocksForAll(cipherLiveTransitionSupervisorKind + "_supervisor_intermission_bots");
    } catch (err) {
      LogRuntimeError("TransitionSupervisor/applyIntermissionFreeze", err);
    }

    if (remaining <= 0 && !cipherTransitionIntermissionHandoffScheduled) {
      cipherTransitionIntermissionHandoffScheduled = true;
      const handoffKind = cipherLiveTransitionSupervisorKind;
      scheduleCipherGlobalTask(0.75, "transition_intermission_handoff", () => {
        const handoffNowSec = getCurrentSchedulerNowSeconds();
        if (gameStatus !== 3) return;
        if (cipherLiveTransitionSupervisorKind !== handoffKind) return;
        if (cipherSecondHalfTransitionStage !== "intermission") return;
        beginCipherTransitionPreDeployReset(handoffNowSec, handoffKind + "_intermission_complete_delayed");
      });
    }

    return true;
  }

  if (cipherSecondHalfTransitionStage === "predeployReset") {
    tickCipherTransitionPreDeployReset(nowSec);
    return true;
  }

  if (cipherSecondHalfTransitionStage === "deploy") {
    refreshCipherTransitionSupervisorSecond(remaining);
    applyCipherTransitionInputLocksForPlayers(cipherLiveTransitionSupervisorKind + "_supervisor_deploy_lock_pre");

    if (isCipherTransitionForceFinishActive()) {
      tickCipherTransitionForceDeployFinish(
        nowSec,
        cipherLiveTransitionSupervisorKind + "_supervisor_deploy_force"
      );
      return true;
    }

    reconcileCipherTransitionDeployReadiness(cipherLiveTransitionSupervisorKind + "_supervisor_deploy");
    runCipherTransitionStepWorkSafe(cipherLiveTransitionSupervisorKind + "_supervisor_deploy");
    if (cipherSecondHalfTransitionStage !== "deploy") return true;
    tickRuntimeBotStagedSpawning(nowSec, cipherLiveTransitionSupervisorKind + "_supervisor_deploy");
    if (cipherSecondHalfTransitionStage !== "deploy") return true;
    // Re-apply after spawn processing too, because a human or bot can become deployed during this same tick.
    applyCipherTransitionInputLocksForPlayers(cipherLiveTransitionSupervisorKind + "_supervisor_deploy_lock_post");
    tryFinishCipherDeployPhase(
      cipherLiveTransitionSupervisorKind + "_supervisor_deploy",
      nowSec,
      remaining
    );
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

  resetCipherTransitionPreDeployResetState();
  cipherLiveTransitionSupervisorKind = "secondHalf";
  cipherLiveTransitionSupervisorToken = transitionToken;
  cipherLiveTransitionSupervisorReason = reason;
  cipherSecondHalfTransitionActive = true;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "intermission";

  // Do NOT clear bots or undeploy players here.
  // The 5-second switching-sides screen should play first.
  // Bot unspawn + human undeploy happens after intermission, right before the 30-second deploy phase.
  clearCipherLivePhaseTransitionRuntimeState("second_half_supervisor_enter", true, true);
  applyCipherIncomingSecondHalfHqProfile("second_half_supervisor_enter_hq_profile");

  cipherSecondHalfTransitionStage = "intermission";
  cipherTransitionUndeployCursor = 0;
  // Do not switch spawn mode or redeploy-lock players at the start of the 5-second switching-sides intermission.
  // Players must stay deployed and frozen until this intermission reaches 0.
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;
  try {
    clearAllCipherNodeRebootState("second_half_supervisor_enter", true);
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/nodeCleanup", err);
  }
  try {
    HideAllObjectiveHoldProgressUi();
    clearBombNoticeState();
  } catch (err) {
    LogRuntimeError("SecondHalfSupervisor/hideLiveUi", err);
  }
  cipherPhaseTransitionUndeployIgnoreUntilSec =
    nowSec +
    CIPHER_HALFTIME_INTERMISSION_SECONDS +
    CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS +
    CIPHER_SECOND_HALF_FORCE_DEPLOY_WATCHDOG_SECONDS +
    2;

  cipherTransitionDeployTitleKey = getFirstHalfResultTitleKey();
  cipherTransitionDeployTitleFallback = getFirstHalfResultTitleFallback();
  cipherTransitionSubtitleKey = (mod.stringkeys as any).CipherSwitchingSides;
  cipherTransitionSubtitleFallback = "SWITCHING SIDES";
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

  // Show the first intermission frame only.
  // Do not undeploy here; undeploy happens after the 5-second intermission reaches 0.
  tickCipherLiveTransitionSupervisor(nowSec);
}

function beginCipherSuddenDeathSupervisor(nowSec: number): void {
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  const transitionToken = beginCipherSuddenDeathTransitionOwnership();

  resetCipherTransitionPreDeployResetState();
  cipherLiveTransitionSupervisorKind = "suddenDeath";
  cipherLiveTransitionSupervisorToken = transitionToken;
  cipherSuddenDeathTransitionActive = true;
  cipherSecondHalfTransitionActive = false;
    cipherSecondHalfTransitionStage = "intermission";

  // Do NOT clear bots or undeploy players here.
  // Let the 5-second transition notice finish first.
  clearCipherLivePhaseTransitionRuntimeState("sudden_death_supervisor_enter", true, true);
  applyCipherIncomingSecondHalfHqProfile("sudden_death_supervisor_enter_hq_profile");

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
  cipherTransitionSubtitleKey = (mod.stringkeys as any).CipherNoRespawns;
  cipherTransitionSubtitleFallback = "NO RESPAWNS";
  cipherSuddenDeathUndeployIgnoreUntilSec =
    nowSec +
    CIPHER_HALFTIME_INTERMISSION_SECONDS +
    CIPHER_SECOND_HALF_DEPLOY_PHASE_SECONDS +
    CIPHER_SECOND_HALF_FORCE_DEPLOY_WATCHDOG_SECONDS +
    2;
  cipherPhaseTransitionUndeployIgnoreUntilSec = cipherSuddenDeathUndeployIgnoreUntilSec;
  // Do not switch spawn mode or redeploy-lock players at the start of the 5-second sudden-death intermission.
  // Players must stay deployed and frozen until this intermission reaches 0.
  startCipherTransitionSupervisorStage("intermission", CIPHER_HALFTIME_INTERMISSION_SECONDS, nowSec);

  // Show the first intermission frame only.
  // Do not undeploy here; undeploy happens after the 5-second intermission reaches 0.
  tickCipherLiveTransitionSupervisor(nowSec);
}


function beginCipherSecondHalf(
  nowSec?: number,
  reason: CipherHalfTransitionReason = "scoreCap"
): void {
  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) return;
  beginCipherSecondHalfSupervisor(nowSec ?? getCurrentSchedulerNowSeconds(), reason);
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

function normalizeCipherPostmatchWinnerTeam(candidate: mod.Team | undefined): mod.Team {
  if (candidate !== undefined) {
    if (mod.Equals(candidate, team1) || mod.Equals(candidate, team2)) return candidate;
  }

  const resolved = resolveWinningTeamFromScores();
  if (mod.Equals(resolved, team1) || mod.Equals(resolved, team2)) return resolved;

  return teamNeutral;
}

function clearDeferredCipherTimeoutTransitionTimer(): void {
  if (cipherTimeoutTransitionTimer !== undefined) {
    cancelCipherGlobalTask(cipherTimeoutTransitionTimer);
  }

  cipherTimeoutTransitionTimer = undefined;
}

function invalidateDeferredCipherTimeoutTransition(): void {
  cipherTimeoutTransitionToken += 1;
  cipherTimeoutTransitionPending = false;
  clearDeferredCipherTimeoutTransitionTimer();
}

function scheduleCipherTimeoutPhaseTransition(
  outcome: CipherTimeoutTransitionOutcome,
  winnerTeam: mod.Team,
  source: string
): void {
  if (gameStatus !== 3) return;
  if (cipherTimeoutTransitionPending === true) return;
  if (isCipherLiveTransitionActive()) return;

  cipherTimeoutTransitionPending = true;
  cipherTimeoutTransitionToken += 1;
  const token = cipherTimeoutTransitionToken;

  clearDeferredCipherTimeoutTransitionTimer();

  // Important:
  // Freeze the live clock now so OngoingGlobal does not schedule the same timeout transition every tick.
  liveClockStarted = false;
  liveClockTimeoutHoldActive = false;

  // Match the safer VIP Escort pattern: the timeout only requests a phase transition.
  // Heavy phase changes happen later from a clean timer/supervisor stack, not inside the live tick.
  cipherTimeoutTransitionTimer = scheduleCipherGlobalTask(0.25, "timeout_transition/" + source, () => {
    if (token !== cipherTimeoutTransitionToken) return;

    cipherTimeoutTransitionTimer = undefined;
    cipherTimeoutTransitionPending = false;

    if (gameStatus !== 3) return;
    if (isCipherLiveTransitionActive()) return;

    try {
      if (outcome === "secondHalf") {
        if (cipherMatchStage !== "half1") return;
        beginCipherSecondHalf(getCurrentSchedulerNowSeconds(), "timeExpired");
        return;
      }

      if (outcome === "suddenDeath") {
        if (cipherMatchStage !== "half2") return;
        beginCipherSuddenDeath(getCurrentSchedulerNowSeconds());
        return;
      }

      if (outcome === "postmatch") {
        enterPostmatchFromLive(normalizeCipherPostmatchWinnerTeam(winnerTeam));
        return;
      }
    } catch (err) {
      LogRuntimeError("DeferredCipherTimeoutTransition/" + source + "/" + outcome, err);

      // Last-resort fallback. Do not let timeout leave the match stuck in live with a dead clock.
      try {
        if (outcome === "secondHalf" && gameStatus === 3 && cipherMatchStage === "half1") {
          beginCipherSecondHalfSupervisor(getCurrentSchedulerNowSeconds(), "timeExpired");
        } else if (outcome === "suddenDeath" && gameStatus === 3 && cipherMatchStage === "half2") {
          beginCipherSuddenDeathSupervisor(getCurrentSchedulerNowSeconds());
        } else if (outcome === "postmatch" && gameStatus === 3) {
          enterPostmatchFromLive(normalizeCipherPostmatchWinnerTeam(winnerTeam));
        }
      } catch (fallbackErr) {
        LogRuntimeError("DeferredCipherTimeoutTransitionFallback/" + source + "/" + outcome, fallbackErr);
      }
    }
  });
}


function clearPostmatchEndTimer(): void {
  if (postmatchEndTimer !== undefined) {
    cancelCipherGlobalTask(postmatchEndTimer);
  }

  postmatchEndTimer = undefined;
}

function getSafePostmatchWinnerTeamForEndGameMode(): mod.Team {
  if (mod.Equals(postmatchWinnerTeam, team1) || mod.Equals(postmatchWinnerTeam, team2)) {
    return postmatchWinnerTeam;
  }

  const resolved = resolveWinningTeamFromScores();
  if (mod.Equals(resolved, team1) || mod.Equals(resolved, team2)) return resolved;

  // EndGameMode requires a Player or Team. If the match is genuinely tied, use Team 1 as a safe engine target.
  // The visible UI can still show DRAW, but this prevents postmatch from sticking forever on a neutral team handle.
  return team1;
}

function safeEndGameModeWithPostmatchWinner(source: string): void {
  if (gameStatus !== 4) return;

  const winner = getSafePostmatchWinnerTeamForEndGameMode();
  postmatchEndStep = 1;
  postmatchEndStepTick = serverTickCount;
  postmatchEndStepAtSec = getCurrentSchedulerNowSeconds();

  try {
    mod.EndGameMode(winner);
  } catch (err) {
    LogRuntimeError("PostmatchEndGameMode/" + source, err);
  }

  // Do not mark the end as completed locally.
  // If EndGameMode is delayed/ignored by the engine, keeping this at 0 allows the main loop and timer fallback to retry.
  postmatchEndStep = 0;
  postmatchEndStepTick = serverTickCount;
  postmatchEndStepAtSec = getCurrentSchedulerNowSeconds();
}

function schedulePostmatchEndGameModeFallback(source: string): void {
  clearPostmatchEndTimer();
  postmatchEndToken += 1;
  const token = postmatchEndToken;

  // Keep postmatch/showcase/scoreboard visible for the full configured postmatch duration.
  // If the engine ignores EndGameMode at 20s, retry every second after the first full-duration call.
  const delayMs = source.indexOf("_retry") >= 0 ? POSTMATCH_END_RETRY_MS : POSTMATCH_TIME * 1000;

  postmatchEndTimer = scheduleCipherGlobalTask(delayMs / 1000, "postmatch_end/" + source, () => {
    if (token !== postmatchEndToken) return;
    postmatchEndTimer = undefined;
    if (gameStatus !== 4) return;

    safeEndGameModeWithPostmatchWinner(source + "_timer");

    // If the engine did not end the match, retry every second instead of letting postmatch stay forever.
    if (gameStatus === 4) {
      schedulePostmatchEndGameModeFallback(source + "_retry");
    }
  });
}

function snapshotPostmatchPipelinePlayers(): number[] {
  const ids: number[] = [];
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    const team = mod.GetTeam(p.player);
    if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;
    ids.push(p.id);
  });
  ids.sort((a, b) => a - b);
  return ids;
}

function startPostmatchPipeline(): void {
  postmatchPipelineToken += 1;
  postmatchPipelineStage = "setup";
  postmatchPipelineSetupStep = 0;
  postmatchPipelinePlayerIds = snapshotPostmatchPipelinePlayers();
  // Showcase ownership is frozen before any revive/deploy work changes soldier state.
  postmatchShowcaseSlots = buildPostmatchShowcaseSlots();
  postmatchPlayerJobs = [];
  postmatchPlayerJobCursor = 0;
  postmatchCardUiBuildCursor = 0;
  for (let i = 0; i < postmatchPipelinePlayerIds.length; i++) {
    const playerId = postmatchPipelinePlayerIds[i];
    const player = serverPlayers.get(playerId);
    if (!player) continue;
    let showcaseSlotIndex = -1;
    for (let slotIndex = 0; slotIndex < postmatchShowcaseSlots.length; slotIndex++) {
      if (postmatchShowcaseSlots[slotIndex].player.id === playerId) {
        showcaseSlotIndex = slotIndex;
        break;
      }
    }
    const endingState: PostmatchEndingState = playerInMandownByPlayerId[playerId] === true
      ? "mandown"
      : player.isDeployed && isPlayerAliveSafe(player.player)
        ? "alive"
        : "undeployed";
    postmatchPlayerJobs.push({
      playerId,
      sessionToken: ensurePlayerSessionToken(playerId),
      endingState,
      showcaseSlotIndex,
      stage: endingState === "mandown"
        ? "revive"
        : endingState === "undeployed"
          ? "deploy"
          : showcaseSlotIndex >= 0
            ? "teleport"
            : "input",
      nextRetryTick: serverTickCount,
    });
  }
  postmatchPipelineCursor = 0;
  postmatchPipelineRetryByPlayerId = {};
  postmatchPipelineTeleportRetryByPlayerId = {};
  postmatchPipelineStageReadyTick = serverTickCount;
  postmatchRevealStep = 0;
  postmatchRevealSlotIndex = 0;
  postmatchRevealNextTick = serverTickCount;
  postmatchRevealSfxPlayerIds = [];
  postmatchEndTick = 0;
  countDown = POSTMATCH_TIME;
  clearPostmatchEndTimer();
  initialization[4] = true;
}

function getPostmatchPipelinePlayer(playerId: number): Player | undefined {
  const p = serverPlayers.get(playerId);
  if (!p || !mod.IsPlayerValid(p.player)) return undefined;
  const team = mod.GetTeam(p.player);
  return mod.Equals(team, team1) || mod.Equals(team, team2) ? p : undefined;
}

function advancePostmatchPipeline(stage: PostmatchPipelineStage): void {
  postmatchPipelineStage = stage;
  postmatchPipelineCursor = 0;
  postmatchPipelineStageReadyTick = serverTickCount + POSTMATCH_STAGE_SETTLE_TICKS;
}

function processPostmatchSetupStep(): void {
  if (postmatchPipelineSetupStep === 0) {
    clearAllCipherNodeRebootState("postmatch_pipeline", true);
  } else if (postmatchPipelineSetupStep === 1) {
    clearCipherLivePhaseTransitionRuntimeState("postmatch_pipeline", true, true);
  } else if (postmatchPipelineSetupStep === 2) {
    clearCipherNativeMinimapBomb("postmatch_pipeline");
  } else if (postmatchPipelineSetupStep === 3) {
    disableAllObjectiveCapturePointObjectives("postmatch_pipeline");
  } else if (postmatchPipelineSetupStep === 4) {
    disableAllObjectiveSurfaceSectors("postmatch_pipeline", true);
  } else if (postmatchPipelineSetupStep === 5) {
    disableAllObjectiveInteractPoints("postmatch_pipeline");
  } else if (postmatchPipelineSetupStep === 6) {
    resetCipherNodeStates("postmatch_pipeline");
  } else if (postmatchPipelineSetupStep === 7) {
    resetBombCarrierRuntimeState(true);
  } else if (postmatchPipelineSetupStep === 8) {
    setCipherHqPhaseProfile("postmatch_hq", [TEAM1_LIVE_HQ, TEAM2_LIVE_HQ]);
  } else if (postmatchPipelineSetupStep === 9) {
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
  } else if (postmatchPipelineSetupStep === 10) {
    const post = mod.FindUIWidgetWithName("PostMatchContainer");
    if (post) {
      SafeSetWidgetVisibleHandle(post, false);
      mod.SetUIWidgetDepth(post, mod.UIDepth.AboveGameUI);
      SafeSetWidgetSizeHandle(post, SAFE_UI_ROOT_SIZE);
    }
  } else if (postmatchPipelineSetupStep === 11) {
    SafeSetWidgetVisibleByName("LiveContainer", false);
  } else if (postmatchPipelineSetupStep === 12) {
    SetCountdownOverlayVisible(false);
  } else if (postmatchPipelineSetupStep === 13) {
    setLiveScorePanelVisible(false);
  } else if (postmatchPipelineSetupStep === 14) {
    hideCipherTransitionHudForAllPlayers();
  } else if (postmatchPipelineSetupStep === 15) {
    hideCipherSuddenDeathAliveHudForAllPlayers();
  } else if (postmatchPipelineSetupStep === 16) {
    deleteCipherSuddenDeathAliveHudForAllPlayers();
  } else if (postmatchPipelineSetupStep === 17) {
    HidePrematchUiForTransition();
  } else if (postmatchPipelineSetupStep === 18) {
    StopAllEndgameLoops();
  } else if (postmatchPipelineSetupStep === 19) {
    HideAllObjectiveHoldProgressUi();
  } else if (postmatchPipelineSetupStep === 20) {
    HideAllDeployObjectiveTimerUi();
  } else if (postmatchPipelineSetupStep === 21) {
    resetLiveTimerWidgetPresentation();
  } else if (postmatchPipelineSetupStep === 22) {
    syncDisabledBombAnchorObjectives();
  } else if (postmatchPipelineSetupStep === 23) {
    hideAllObjectiveArmedWorldIcons();
  } else if (postmatchPipelineSetupStep === 24) {
    enforceReadyupHqsDisabledOutsidePrematch("postmatch_pipeline");
  } else {
    advancePostmatchPipeline("showcaseWorld");
    return;
  }
  postmatchPipelineSetupStep += 1;
}

function processPostmatchPlayerUndeploy(): void {
  if (postmatchPipelineCursor >= postmatchPipelinePlayerIds.length) {
    advancePostmatchPipeline("undeploySettle");
    return;
  }
  const playerId = postmatchPipelinePlayerIds[postmatchPipelineCursor++];
  const p = getPostmatchPipelinePlayer(playerId);
  if (!p) return;
  try {
    mod.UndeployPlayer(p.player);
    p.isDeployed = false;
  } catch (err) {
    LogRuntimeError("PostmatchPipeline/undeploy/" + String(playerId), err);
  }
}

function processPostmatchPlayerDeploy(): void {
  if (postmatchPipelineCursor >= postmatchPipelinePlayerIds.length) {
    advancePostmatchPipeline("deploySettle");
    return;
  }
  const playerId = postmatchPipelinePlayerIds[postmatchPipelineCursor++];
  const p = getPostmatchPipelinePlayer(playerId);
  if (!p) return;
  try {
    mod.SetRedeployTime(p.player, 0);
    mod.EnablePlayerDeploy(p.player, true);
    mod.DeployPlayer(p.player);
    postmatchPipelineRetryByPlayerId[playerId] = 1;
  } catch (err) {
    postmatchPipelineRetryByPlayerId[playerId] = 1;
    LogRuntimeError("PostmatchPipeline/deploy/" + String(playerId), err);
  }
}

function processPostmatchDeploySettle(): void {
  if (serverTickCount < postmatchPipelineStageReadyTick) return;
  for (let i = 0; i < postmatchPipelinePlayerIds.length; i++) {
    const playerId = postmatchPipelinePlayerIds[i];
    const p = getPostmatchPipelinePlayer(playerId);
    if (!p || p.isDeployed) continue;
    const attempts = postmatchPipelineRetryByPlayerId[playerId] ?? 0;
    if (attempts >= POSTMATCH_PLAYER_RETRY_LIMIT) continue;
    try {
      mod.SetRedeployTime(p.player, 0);
      mod.DeployPlayer(p.player);
    } catch (err) {
      LogRuntimeError("PostmatchPipeline/deployRetry/" + String(playerId), err);
    }
    postmatchPipelineRetryByPlayerId[playerId] = attempts + 1;
    postmatchPipelineStageReadyTick = serverTickCount + POSTMATCH_STAGE_SETTLE_TICKS;
    return;
  }
  advancePostmatchPipeline("showcaseBuild");
}

function processPostmatchTeleport(): void {
  if (postmatchPipelineCursor >= postmatchShowcaseSlots.length) {
    advancePostmatchPipeline("input");
    return;
  }
  const slot = postmatchShowcaseSlots[postmatchPipelineCursor];
  const current = getPostmatchPipelinePlayer(slot.player.id);
  if (!current) {
    postmatchPipelineCursor += 1;
    return;
  }
  slot.player = current;
  let teleported = false;
  if (tryMakePostmatchShowcasePlayerAlive(current)) {
    current.isDeployed = true;
    teleported = teleportPostmatchShowcaseSlotPlayer(slot, "pipeline");
  }
  if (teleported) {
    postmatchPipelineCursor += 1;
    return;
  }
  const attempts = (postmatchPipelineTeleportRetryByPlayerId[current.id] ?? 0) + 1;
  postmatchPipelineTeleportRetryByPlayerId[current.id] = attempts;
  if (attempts >= POSTMATCH_PLAYER_RETRY_LIMIT) postmatchPipelineCursor += 1;
}

function processPostmatchInputPlayer(): void {
  if (postmatchPipelineCursor >= postmatchPipelinePlayerIds.length) {
    advancePostmatchPipeline("reportUi");
    return;
  }
  const playerId = postmatchPipelinePlayerIds[postmatchPipelineCursor++];
  const p = getPostmatchPipelinePlayer(playerId);
  if (!p) return;
  forceHideCipherLiveHudForPlayer(p);
  closeCipherAdminPanelForPlayerId(playerId, true);
  applyPostmatchInputStateForPlayer(p.player);
  setPostmatchShowcaseCameraForPlayer(p.player, true);
}

function processPostmatchStateAwarePlayerJob(): void {
  if (postmatchPlayerJobs.length <= 0) {
    advancePostmatchPipeline("reportUi");
    return;
  }

  let unfinished = 0;
  for (let i = 0; i < postmatchPlayerJobs.length; i++) {
    if (postmatchPlayerJobs[i].stage !== "done") unfinished += 1;
  }
  if (unfinished <= 0) {
    advancePostmatchPipeline("reportUi");
    return;
  }

  // Round-robin waiting jobs so a single slow revive/deploy cannot starve the other 15 players.
  for (let scanned = 0; scanned < postmatchPlayerJobs.length; scanned++) {
    const index = postmatchPlayerJobCursor % postmatchPlayerJobs.length;
    postmatchPlayerJobCursor = (index + 1) % postmatchPlayerJobs.length;
    const job = postmatchPlayerJobs[index];
    if (job.stage === "done") continue;
    if (!isCurrentPlayerSession(job.playerId, job.sessionToken)) {
      job.stage = "done";
      return;
    }
    const player = getPostmatchPipelinePlayer(job.playerId);
    if (!player) {
      job.stage = "done";
      return;
    }

    if (job.stage === "revive") {
      mod.ForceRevive(player.player);
      job.nextRetryTick = serverTickCount + TICK_RATE;
      job.stage = "awaitAlive";
      return;
    }
    if (job.stage === "awaitAlive") {
      if (isPlayerAliveSafe(player.player)) {
        player.isDeployed = true;
        job.stage = job.showcaseSlotIndex >= 0 ? "teleport" : "input";
      } else if (serverTickCount >= job.nextRetryTick) {
        job.stage = "revive";
      }
      return;
    }
    if (job.stage === "deploy") {
      mod.SetRedeployTime(player.player, 0);
      mod.EnablePlayerDeploy(player.player, true);
      mod.DeployPlayer(player.player);
      job.nextRetryTick = serverTickCount + TICK_RATE;
      job.stage = "awaitDeploy";
      return;
    }
    if (job.stage === "awaitDeploy") {
      if (player.isDeployed && isPlayerAliveSafe(player.player)) {
        job.stage = job.showcaseSlotIndex >= 0 ? "teleport" : "input";
      } else if (serverTickCount >= job.nextRetryTick) {
        job.stage = "deploy";
      }
      return;
    }
    if (job.stage === "teleport") {
      if (serverTickCount < job.nextRetryTick) return;
      const slot = postmatchShowcaseSlots[job.showcaseSlotIndex];
      if (!slot) {
        job.stage = "input";
        return;
      }
      slot.player = player;
      if (teleportPostmatchShowcaseSlotPlayer(slot, "state_aware")) {
        job.stage = "input";
      } else {
        job.nextRetryTick = serverTickCount + TICK_RATE;
      }
      return;
    }
    if (job.stage === "input") {
      forceHideCipherLiveHudForPlayer(player);
      closeCipherAdminPanelForPlayerId(job.playerId, true);
      applyPostmatchInputStateForPlayer(player.player);
      setPostmatchShowcaseCameraForPlayer(player.player, true);
      job.stage = "done";
      return;
    }
  }
}

function beginPostmatchCardReveal(slotIndex: number): void {
  postmatchRevealSlotIndex = slotIndex;
  postmatchRevealStep = 0;
  postmatchRevealNextTick = serverTickCount;
  postmatchPipelineStage = "cardFade";
}

function finishPostmatchReveal(): void {
  setPostMatchTextAlpha("PM_EndTimer_1", 1);
  setPostMatchTextAlpha("PM_EndTimer_2", 1);
  countDown = POSTMATCH_TIME;
  postmatchEndTick = serverTickCount + POSTMATCH_TIME * TICK_RATE;
  updatePostmatchEndTimerUi(POSTMATCH_TIME);
  schedulePostmatchEndGameModeFallback("postmatch_reveal_complete");
  postmatchPipelineStage = "complete";
}

function processPostmatchPipeline(): void {
  if (
    postmatchPipelineToken <= 0 ||
    gameStatus !== 4 ||
    postmatchPipelineStage === "idle" ||
    postmatchPipelineStage === "complete"
  ) return;
  if (postmatchPipelineStage === "setup") return processPostmatchSetupStep();
  if (postmatchPipelineStage === "undeploy") return processPostmatchPlayerUndeploy();
  if (postmatchPipelineStage === "undeploySettle") {
    if (serverTickCount < postmatchPipelineStageReadyTick) return;
    advancePostmatchPipeline("deploy");
    return;
  }
  if (postmatchPipelineStage === "deploy") return processPostmatchPlayerDeploy();
  if (postmatchPipelineStage === "deploySettle") return processPostmatchDeploySettle();
  if (postmatchPipelineStage === "showcaseBuild") return advancePostmatchPipeline("showcaseWorld");
  if (postmatchPipelineStage === "showcaseWorld") {
    showPostmatchShowcaseSpatialObjectsForPostmatch();
    advancePostmatchPipeline("playerJobs");
    return;
  }
  if (postmatchPipelineStage === "playerJobs") return processPostmatchStateAwarePlayerJob();
  if (postmatchPipelineStage === "teleport") return processPostmatchTeleport();
  if (postmatchPipelineStage === "input") return processPostmatchInputPlayer();
  if (postmatchPipelineStage === "reportUi") {
    BuildPostMatchReportUI();
    advancePostmatchPipeline("cardUi");
    return;
  }
  if (postmatchPipelineStage === "cardUi") {
    if (!buildPostmatchShowcaseScreenUi()) return;
    const post = mod.FindUIWidgetWithName("PostMatchContainer");
    if (post) SafeSetWidgetVisibleHandle(post, true);
    postmatchRevealSfxPlayerIds = getValidHumanPlayersSnapshot().map((p) => p.id);
    postmatchPipelineStage = "resultSfx";
    return;
  }
  if (postmatchPipelineStage === "resultSfx") {
    const playerId = postmatchRevealSfxPlayerIds.shift();
    if (playerId !== undefined) {
      const p = getValidHumanPlayerById(playerId);
      if (p) playPostMatchResultSfxForPlayer(p);
      return;
    }
    postmatchResultSfxPlayed = true;
    postmatchRevealStep = 0;
    postmatchRevealNextTick = serverTickCount;
    postmatchPipelineStage = "scoreFade";
    return;
  }
  if (postmatchPipelineStage === "scoreFade") {
    if (serverTickCount < postmatchRevealNextTick) return;
    postmatchRevealStep += 1;
    setPostmatchScoreRevealAlpha(postmatchRevealStep / POSTMATCH_SCORE_FADE_STEPS);
    postmatchRevealNextTick = serverTickCount + POSTMATCH_SCORE_FADE_STEP_TICKS;
    if (postmatchRevealStep >= POSTMATCH_SCORE_FADE_STEPS) {
      if (postmatchShowcaseSlots.length <= 0) finishPostmatchReveal();
      else beginPostmatchCardReveal(0);
    }
    return;
  }
  if (postmatchPipelineStage === "cardFade") {
    if (serverTickCount < postmatchRevealNextTick) return;
    postmatchRevealStep += 1;
    setPostmatchCardRevealAlpha(
      postmatchRevealSlotIndex,
      postmatchRevealStep / POSTMATCH_CARD_FADE_STEPS
    );
    postmatchRevealNextTick = serverTickCount + POSTMATCH_CARD_FADE_STEP_TICKS;
    if (postmatchRevealStep >= POSTMATCH_CARD_FADE_STEPS) {
      postmatchRevealSfxPlayerIds = getValidHumanPlayersSnapshot().map((p) => p.id);
      postmatchPipelineStage = "cardSfx";
    }
    return;
  }
  if (postmatchPipelineStage === "cardSfx") {
    const playerId = postmatchRevealSfxPlayerIds.shift();
    if (playerId !== undefined) {
      const p = getValidHumanPlayerById(playerId);
      if (p && SFX_ReadyUp) mod.PlaySound(SFX_ReadyUp, 0.8, p.player);
      return;
    }
    const nextSlot = postmatchRevealSlotIndex + 1;
    if (nextSlot >= postmatchShowcaseSlots.length) finishPostmatchReveal();
    else beginPostmatchCardReveal(nextSlot);
  }
}

function enterPostmatchFromLive(forcedWinner?: mod.Team): void {
  if (gameStatus === 4) return;
  if (cipherPostmatchTransitionStarted) return;
  cipherPostmatchTransitionStarted = true;
  cipherSuddenDeathPostmatchPending = true;
  cipherSuddenDeathPostmatchToken += 1;
  invalidateDeferredCipherDeliveryTransition();
  invalidateDeferredCipherTimeoutTransition();
  clearCipherAdminInteractPoint("enter_postmatch");
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  cipherPendingScoreTransitionTeam = teamNeutral;
  postmatchWinnerTeam = normalizeCipherPostmatchWinnerTeam(forcedWinner);
  postmatchEndStep = 0;
  postmatchEndStepTick = 0;
  postmatchEndStepAtSec = 0;
  gameStatus = 4;
  startPostmatchPipeline();
  liveTimerIntroActive = false;
  liveTimerIntroEndsAtSec = 0;
  liveClockTimeoutHoldActive = false;
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

function scheduleCipherSuddenDeathEliminatedPlayerCleanup(playerId: number, source: string): void {
  const sp = serverPlayers.get(playerId);
  if (!sp || !mod.IsPlayerValid(sp.player)) return;
  const sessionToken = ensurePlayerSessionToken(playerId);
  const expectedMatchStage = cipherMatchStage;

  cipherSuddenDeathForcedUndeployTokenCounter += 1;
  const token = cipherSuddenDeathForcedUndeployTokenCounter;
  cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId] = token;

  try {
    mod.SetRedeployTime(sp.player, 9999);
  } catch (err) {
    LogRuntimeError("SuddenDeathCleanupSetRedeploy/" + source + "/" + String(playerId), err);
  }

  scheduleCipherGlobalTask(0.1, "sudden_death_undeploy/" + source, () => {
    if (cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId] !== token) return;
    if (!isCurrentPlayerSession(playerId, sessionToken)) return;
    if (gameStatus !== 3 || cipherMatchStage !== expectedMatchStage) return;
    const latest = serverPlayers.get(playerId);
    if (!latest || !mod.IsPlayerValid(latest.player)) {
      delete cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId];
      return;
    }
    try {
      mod.SetRedeployTime(latest.player, 9999);
    } catch (err) {
      LogRuntimeError("SuddenDeathCleanupRedeployReassert/" + source + "/" + String(playerId), err);
    }

    try {
      mod.UndeployPlayer(latest.player);
    } catch (err) {
      LogRuntimeError("SuddenDeathCleanupUndeploy/" + source + "/" + String(playerId), err);
      delete cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId];
    }
  });
}

function scheduleCipherSuddenDeathPostmatch(winner: mod.Team, source: string): void {
  if (mod.Equals(winner, teamNeutral)) return;
  if (cipherSuddenDeathPostmatchPending === true) return;

  cipherSuddenDeathPostmatchPending = true;
  cipherSuddenDeathPostmatchToken += 1;
  const token = cipherSuddenDeathPostmatchToken;
  cipherPendingScoreTransitionTeam = teamNeutral;
  liveClockTimeoutHoldActive = false;

  try {
    updateCipherSuddenDeathAliveHudForAllPlayers();
  } catch (err) {
    LogRuntimeError("SuddenDeathPostmatchHud/" + source, err);
  }

  // Do not enter postmatch directly inside mandown/death/score event stacks.
  // Portal can crash if we clear objectives/UI/key state while the engine is still processing combat events.
  scheduleCipherGlobalTask(0.25, "sudden_death_postmatch/" + source, () => {
    if (token !== cipherSuddenDeathPostmatchToken) return;
    if (gameStatus !== 3 || cipherMatchStage !== "suddenDeath") {
      cipherSuddenDeathPostmatchPending = false;
      return;
    }

    try {
      enterPostmatchFromLive(winner);
    } catch (err) {
      LogRuntimeError("SuddenDeathPostmatch/" + source, err);
    }
  });
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
  recordScoreboardDeathForPlayer(sp);

  try {
    mod.SetRedeployTime(sp.player, 9999);
  } catch (err) {
    LogRuntimeError("SuddenDeathSetRedeployTime/" + source, err);
  }
  scheduleCipherSuddenDeathEliminatedPlayerCleanup(playerId, source);

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
  if (!liveClockStarted && !liveClockTimeoutHoldActive) return;
  if (!Number.isFinite(liveClockDeadlineAtSec) || liveClockDeadlineAtSec <= 0) return;
  if (cipherTimeoutTransitionPending === true) return;
  if (isCipherLiveTransitionActive()) return;

  const timeoutReached = nowSec >= liveClockDeadlineAtSec;
  if (!timeoutReached && !liveClockTimeoutHoldActive) return;

  if (getAllObjectivePendingAwardActive()) {
    liveClockTimeoutHoldActive = true;
    return;
  }

  liveClockTimeoutHoldActive = false;

  if (cipherMatchStage === "half1") {
    scheduleCipherTimeoutPhaseTransition(
      "secondHalf",
      teamNeutral,
      "half1_time_expired"
    );
    return;
  }

  if (cipherMatchStage === "half2") {
    const winner = resolveSecondHalfTimeoutWinner();

    if (!mod.Equals(winner, teamNeutral)) {
      scheduleCipherTimeoutPhaseTransition(
        "postmatch",
        winner,
        "half2_time_expired_winner"
      );
      return;
    }

    scheduleCipherTimeoutPhaseTransition(
      "suddenDeath",
      teamNeutral,
      "half2_time_expired_tie"
    );
    return;
  }

  if (cipherMatchStage === "suddenDeath") {
    const winner = resolveSecondHalfTimeoutWinner();

    if (!mod.Equals(winner, teamNeutral)) {
      scheduleCipherTimeoutPhaseTransition(
        "postmatch",
        winner,
        "sudden_death_timeout_winner"
      );
      return;
    }

    scheduleCipherTimeoutPhaseTransition(
      "postmatch",
      teamNeutral,
      "sudden_death_timeout_tie"
    );
    return;
  }

  const team1Score = serverScores[0];
  const team2Score = serverScores[1];

  if (team1Score > team2Score) {
    scheduleCipherTimeoutPhaseTransition("postmatch", team1, "fallback_timeout_team1");
    return;
  }

  if (team2Score > team1Score) {
    scheduleCipherTimeoutPhaseTransition("postmatch", team2, "fallback_timeout_team2");
    return;
  }

  scheduleCipherTimeoutPhaseTransition("postmatch", teamNeutral, "fallback_timeout_tie");
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
  const timeWidget = SafeFindWidget("RemainingTime");
  const introValueWidget = SafeFindWidget("LiveTimerIntroValue");
  if (!timeWidget && !introValueWidget) return;

  const resolvedNow = nowSec !== undefined ? nowSec : getCurrentSchedulerNowSeconds();

  if (isCipherLiveTransitionActive()) {
    const displaySeconds = mod.Max(0, mod.Ceiling(cipherTransitionCountdownSeconds));
    const displayLabel = formatUiTimerLabel(displaySeconds);
    SafeSetWidgetVisibleByName("LiveTimerIntroContainer", false);
    SafeSetWidgetVisibleByName("matchtime", false);
    if (timeWidget) mod.SetUITextLabel(timeWidget, displayLabel);
    if (introValueWidget) mod.SetUITextLabel(introValueWidget, displayLabel);
    UpdateLiveScorePanelTimeForAllPlayers(resolvedNow);
    return;
  }

  updateLiveTimerIntroState(resolvedNow);

  if (!liveClockStarted) {
    if (timeWidget) mod.SetUITextLabel(timeWidget, mod.Message(mod.stringkeys.TimeDefault));
    if (introValueWidget) mod.SetUITextLabel(introValueWidget, mod.Message(mod.stringkeys.TimeDefault));
    UpdateLiveScorePanelTimeForAllPlayers(resolvedNow);
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
  UpdateLiveScorePanelTimeForAllPlayers(resolvedNow);
}


function getFriendlyScore(team: mod.Team): number {
  return mod.Equals(team, team1) ? mod.Ceiling(serverScores[0]) : mod.Ceiling(serverScores[1]);
}

function getOpponentScore(team: mod.Team): number {
  return mod.Equals(team, team1) ? mod.Ceiling(serverScores[1]) : mod.Ceiling(serverScores[0]);
}


let liveScoreUpdateCursor = 0;

function SetUIScores(): void {
  const players = getValidHumanPlayersSnapshot();
  if (players.length <= 0) return;
  if (liveScoreUpdateCursor >= players.length) liveScoreUpdateCursor = 0;
  players[liveScoreUpdateCursor++].updateTickets();
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


// Keep player storage data-only. Engine validation belongs at the specific call
// site that crosses an engine boundary; doing it implicitly from every fan-out
// is unsafe while a player handle is changing between deploy-screen and soldier.
const serverPlayers = new Map<number, Player>();
type DisconnectedPlayerSnapshot = {
  playerId: number;
  scoreboard: number[];
  firstDeployPending: boolean;
};
type PendingPlayerSession = {
  playerId: number;
  nativeObjId: number;
  player: mod.Player;
  sessionToken: number;
  joinedAtMs: number;
  stableTeamId: number;
  stableSamples: number;
  nextRetryAtMs: number;
  isReconnect: boolean;
  deployAckSeen: boolean;
  watchdogLogged: boolean;
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
type PlayerLeaveCleanupJob = {
  playerId: number;
  sessionToken: number | undefined;
  wasCarrier: boolean;
  cachedPosition: mod.Vector | undefined;
  cachedTeam: mod.Team;
};
const disconnectedPlayerSnapshotById: { [playerId: number]: DisconnectedPlayerSnapshot | undefined } = {};
let pendingPlayerSessionById: { [playerId: number]: PendingPlayerSession | undefined } = {};
let playerActivatedSessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let safeSpawnCheckQueue: SafeSpawnCheckQueueItem[] = [];
let safeSpawnForcedQueue: ForcedSafeSpawnQueueItem[] = [];
let safeSpawnGenerationByPlayerId: { [playerId: number]: number | undefined } = {};
let safeSpawnCheckQueuedGenerationByPlayerId: { [playerId: number]: number | undefined } = {};
let safeSpawnForcedQueuedGenerationByPlayerId: { [playerId: number]: number | undefined } = {};
let safeSpawnUnsafePending: { [playerId: number]: boolean | undefined } = {};
let safeSpawnForcedUndeploy: { [playerId: number]: boolean | undefined } = {};
let safeSpawnForcedRedeploys: { [playerId: number]: number | undefined } = {};
let safeSpawnUnsafeHqObjIdByPlayerId: { [playerId: number]: number | undefined } = {};
let safeSpawnUnsafeSpawnerObjIdByPlayerId: { [playerId: number]: number | undefined } = {};
let lastLiveHqSpawnPointObjIdByPlayerId: { [playerId: number]: number | undefined } = {};
let lastForcedSafeSpawnHqObjIdByPlayerId: { [playerId: number]: number | undefined } = {};
const SAFE_SPAWN_CHECK_DELAY_TICKS = CIPHER_RESPAWN_POST_DEPLOY_DELAY_TICKS;
const SAFE_SPAWN_CHECKS_PER_TICK = 2;
const SAFE_SPAWN_FORCED_QUEUE_BUDGET_PER_TICK = 1;
const SAFE_SPAWN_FORCED_SPAWN_DELAY_TICKS = mod.Max(1, mod.Ceiling(0.2 * TICK_RATE));
const SAFE_SPAWN_MAX_FORCED_REDEPLOYS = 5;
const SAFE_SPAWN_ENEMY_RADIUS_METERS = 18;
const LIVE_SAFE_SPAWN_TEAM1_HQ_IDS: number[] = [TEAM1_INITIAL_HQ, TEAM1_LIVE_HQ];
const LIVE_SAFE_SPAWN_TEAM2_HQ_IDS: number[] = [TEAM2_INITIAL_HQ, TEAM2_LIVE_HQ];
const LIVE_SAFE_SPAWN_TEAM1_PLAYERSPAWNER_IDS: number[] = [11, 13];
const LIVE_SAFE_SPAWN_TEAM2_PLAYERSPAWNER_IDS: number[] = [12, 14];
const HQ_TO_PLAYERSPAWNER_ID: { [hqId: number]: number } = { 1: 11, 2: 12, 3: 13, 4: 14 };
let playerLeaveCleanupQueue: PlayerLeaveCleanupJob[] = [];
let playerLifecycleAdminRefreshPending = false;
let playerLifecyclePrematchRefreshPending = false;
let playerLifecycleSuddenDeathRefreshPending = false;
let playerLifecycleScoreboardRefreshPending = false;
const PLAYER_JOIN_STABILIZE_MS = 2000;
const PLAYER_JOIN_REQUIRED_STABLE_SAMPLES = 2;
const PLAYER_JOIN_WATCHDOG_MS = 10000;
let playerSessionTokenCounter = 0;
let playerSessionTokenByPlayerId: { [playerId: number]: number | undefined } = {};
let playerLifeGenerationByPlayerId: { [playerId: number]: number | undefined } = {};
let playerDisconnectedAtTickByPlayerId: { [playerId: number]: number | undefined } = {};
let cipherSuddenDeathJoinAliveExemptByPlayerId: { [playerId: number]: boolean | undefined } = {};
let cipherSuddenDeathJoinCleanupQueuedByPlayerId: { [playerId: number]: boolean | undefined } = {};

type SafeEventPlayerIdentity = {
  playerId: number;
  nativeObjId: number;
  team: mod.Team;
  teamId: number;
  isBot: boolean;
};

function beginPlayerSessionForJoin(playerId: number): number {
  playerSessionTokenCounter += 1;
  playerSessionTokenByPlayerId[playerId] = playerSessionTokenCounter;
  delete playerDisconnectedAtTickByPlayerId[playerId];
  playerLifeGenerationByPlayerId[playerId] = 0;
  return playerSessionTokenCounter;
}

function invalidatePlayerSessionForDisconnect(playerId: number): void {
  playerSessionTokenCounter += 1;
  playerSessionTokenByPlayerId[playerId] = playerSessionTokenCounter;
  playerDisconnectedAtTickByPlayerId[playerId] = serverTickCount;
  delete playerLifeGenerationByPlayerId[playerId];
}

function getPlayerLifeGeneration(playerId: number): number {
  return playerLifeGenerationByPlayerId[playerId] ?? 0;
}

function beginNextPlayerLife(playerId: number): number {
  const next = getPlayerLifeGeneration(playerId) + 1;
  playerLifeGenerationByPlayerId[playerId] = next;
  return next;
}

function isCurrentPlayerSession(playerId: number, token: number | undefined): boolean {
  return token !== undefined && playerSessionTokenByPlayerId[playerId] === token;
}

function ensurePlayerSessionToken(playerId: number): number {
  const current = playerSessionTokenByPlayerId[playerId];
  return current === undefined ? beginPlayerSessionForJoin(playerId) : current;
}

function tryGetSafeEventPlayerIdOnly(eventPlayer: mod.Player): number | undefined {
  try {
    if (!mod.IsPlayerValid(eventPlayer)) return undefined;
    return modlib.getPlayerId(eventPlayer);
  } catch (_err) {
    return undefined;
  }
}

function tryGetSafeEventPlayerIdentity(eventPlayer: mod.Player): SafeEventPlayerIdentity | undefined {
  try {
    if (!mod.IsPlayerValid(eventPlayer)) return undefined;
    const playerId = modlib.getPlayerId(eventPlayer);
    const nativeObjId = mod.GetObjId(eventPlayer);
    const team = mod.GetTeam(eventPlayer);
    const teamId = mod.Equals(team, team1) ? 1 : mod.Equals(team, team2) ? 2 : 0;
    return {
      playerId,
      nativeObjId,
      team,
      teamId,
      isBot: isBotBackfillPlayerSafe(eventPlayer),
    };
  } catch (_err) {
    return undefined;
  }
}

function adoptLatestHumanPlayerHandleFromEvent(
  identity: SafeEventPlayerIdentity,
  eventPlayer: mod.Player,
  allowCreate: boolean = true,
  reuseDisconnected: boolean = true
): Player | undefined {
  if (identity.isBot || (identity.teamId !== 1 && identity.teamId !== 2)) return undefined;
  if (playerDisconnectedAtTickByPlayerId[identity.playerId] !== undefined) return undefined;
  if (pendingPlayerSessionById[identity.playerId] !== undefined) return undefined;

  const p = serverPlayers.get(identity.playerId);
  if (!p) return undefined;
  if (p.nativeObjId !== identity.nativeObjId) return undefined;

  p.player = eventPlayer;
  p.nativeObjId = identity.nativeObjId;
  p.team = identity.team;
  serverPlayers.set(identity.playerId, p);
  ensurePlayerSessionToken(identity.playerId);
  playerActivatedSessionTokenByPlayerId[identity.playerId] = playerSessionTokenByPlayerId[identity.playerId];
  void allowCreate;
  void reuseDisconnected;
  return p;
}

function getQueuedPlayerWorkTransitionToken(): number {
  return isCipherLiveTransitionActive() ? getCipherSecondHalfForceDeployToken() : -1;
}

function isQueuedPlayerWorkCurrent(
  playerId: number,
  sessionToken: number | undefined,
  expectedGameStatus: number,
  expectedMatchStage: CipherMatchStage,
  expectedTransitionToken: number = 0
): boolean {
  if (!isCurrentPlayerSession(playerId, sessionToken)) return false;
  if (gameStatus !== expectedGameStatus || cipherMatchStage !== expectedMatchStage) return false;
  if (expectedTransitionToken > 0) {
    if (!isCipherLiveTransitionActive()) return false;
    if (getCipherSecondHalfForceDeployToken() !== expectedTransitionToken) return false;
  } else if (expectedTransitionToken < 0 && isCipherLiveTransitionActive()) {
    return false;
  }

  return getValidHumanPlayerById(playerId) !== undefined;
}

function resetPlayerSessionRefsForJoin(p: Player, preserveActiveLiveState: boolean): void {
  if (!preserveActiveLiveState) {
    p.isDeployed = false;
  }

  p.friendlyScoreWidget = null as any;
  p.opponentScoreWidget = null as any;
  p.friendlyScorePadWidget = null as any;
  p.opponentScorePadWidget = null as any;
  p.bombCarrierTextWidget = null as any;
  p.bombNoticeContainerWidget = null as any;
  p.bombNoticeLeftAccentWidget = null as any;
  p.bombNoticeRightAccentWidget = null as any;
  p.bombNoticeTextWidget = null as any;
  p.bombNoticeDetailWidget = null as any;
  p.nextKeyUnlockContainerWidget = null as any;
  p.nextKeyUnlockTextWidget = null as any;
  p.bombCarrierUiLastVisible = false;
  p.bombCarrierUiLastVersion = -1;
  p.bombCarrierUiLastAlphaBucket = -1;
  p.bombNoticeUiLastStateKey = "";
  p.nextKeyUnlockHudLastStateKey = "";
  p.objectiveHoldRootWidget = null as any;
  p.objectiveHoldContainerWidget = null as any;
  p.objectiveHoldFillArmingWidget = null as any;
  p.objectiveHoldFillDisarmingWidget = null as any;
  p.objectiveHoldTextArmingWidget = null as any;
  p.objectiveHoldTextDisarmingWidget = null as any;
  p.deployObjectiveTimerRootWidget = null as any;
  p.deployObjectiveTimerPanelWidget = null as any;
  p.deployObjectiveTimerLaneFillWidget = null as any;
  p.deployObjectiveTimerLaneTextWidget = null as any;
  p.deployObjectiveTimerLaneOutlineTopWidget = null as any;
  p.deployObjectiveTimerLaneOutlineBottomWidget = null as any;
  p.deployObjectiveTimerLaneOutlineLeftWidget = null as any;
  p.deployObjectiveTimerLaneOutlineRightWidget = null as any;
  p.deployObjectiveTimerTitleWidget = null as any;
  p.deployObjectiveTimerValueWidget = null as any;
  p.deployObjectiveTimerLastShownCpId = undefined;
  p.deployObjectiveTimerLastShownRemainingSeconds = -1;
  p.cipherTransitionRootWidget = null as any;
  p.cipherTransitionPanelWidget = null as any;
  p.cipherTransitionTitleWidget = null as any;
  p.cipherTransitionSubtitleWidget = null as any;
  p.cipherTransitionProgressWidget = null as any;
  p.cipherTransitionTimerWidget = null as any;
  p.cipherSuddenDeathAliveRootWidget = null as any;
  p.cipherSuddenDeathAlivePanelWidget = null as any;
  p.cipherSuddenDeathAliveTitleWidget = null as any;
  p.cipherSuddenDeathFriendlyAliveWidget = null as any;
  p.cipherSuddenDeathEnemyAliveWidget = null as any;
  p.cipherSuddenDeathFriendlyAliveSlotWidgets = [];
  p.cipherSuddenDeathEnemyAliveSlotWidgets = [];

  clearLiveHudQueueForPlayer(p.id);
  clearPhasePlayerOperationsForPlayer(p.id);
  clearTransitionSpawnStateForPlayer(p.id);
  delete postmatchShowcaseCameraAppliedByPlayerId[p.id];
  liveHudBuiltByPlayerId[p.id] = false;
  markCipherKeyHudDirtyForPlayer(p.id);
}

function rememberDisconnectedPlayerSnapshot(p: Player): void {
  disconnectedPlayerSnapshotById[p.id] = {
    playerId: p.id,
    scoreboard: p.getScoreboardSnapshot(),
    firstDeployPending: p.isFirstDeployPending(),
  };
}

function clearJoinSettleStateForPlayer(playerId: number): void {
  delete cipherSuddenDeathJoinAliveExemptByPlayerId[playerId];
  delete cipherSuddenDeathJoinCleanupQueuedByPlayerId[playerId];
}

function resetUniversalPlayerLifecycleQueues(clearReconnectSnapshots: boolean): void {
  pendingPlayerSessionById = {};
  playerActivatedSessionTokenByPlayerId = {};
  safeSpawnCheckQueue = [];
  safeSpawnForcedQueue = [];
  safeSpawnGenerationByPlayerId = {};
  safeSpawnCheckQueuedGenerationByPlayerId = {};
  safeSpawnForcedQueuedGenerationByPlayerId = {};
  safeSpawnUnsafePending = {};
  safeSpawnForcedUndeploy = {};
  safeSpawnForcedRedeploys = {};
  safeSpawnUnsafeHqObjIdByPlayerId = {};
  safeSpawnUnsafeSpawnerObjIdByPlayerId = {};
  lastLiveHqSpawnPointObjIdByPlayerId = {};
  lastForcedSafeSpawnHqObjIdByPlayerId = {};
  playerLeaveCleanupQueue = [];
  playerLifecycleAdminRefreshPending = false;
  playerLifecyclePrematchRefreshPending = false;
  playerLifecycleSuddenDeathRefreshPending = false;
  playerLifecycleScoreboardRefreshPending = false;
  liveHudBuiltSessionTokenByPlayerId = {};
  if (clearReconnectSnapshots) {
    for (const key in disconnectedPlayerSnapshotById) {
      delete disconnectedPlayerSnapshotById[Number(key)];
    }
  }
}

function clearCipherTransitionStateForPlayer(playerId: number, source: string): void {
  delete cipherSecondHalfDeployRequiredByPlayerId[playerId];
  delete cipherSecondHalfDeployReadyByPlayerId[playerId];
  delete cipherTransitionDeploySeenByPlayerId[playerId];
  delete cipherTransitionDeployAckTokenByPlayerId[playerId];
  delete cipherTransitionForceDeployIssuedTokenByPlayerId[playerId];
  delete cipherTransitionTeleportedByPlayerId[playerId];
  delete cipherSecondHalfFrozenByPlayerId[playerId];
  delete cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId];
  delete transitionSpawnRequestedByPlayerId[playerId];
  delete transitionSpawnLastAttemptTickByPlayerId[playerId];
  delete transitionSpawnInFlightByPlayerId[playerId];
  cipherTransitionForceDeployQueue = cipherTransitionForceDeployQueue.filter((queuedId) => queuedId !== playerId);
  delete cipherTransitionForceDeploySessionTokenByPlayerId[playerId];
  cipherTransitionPreDeployHumanQueue = cipherTransitionPreDeployHumanQueue.filter((queuedId) => queuedId !== playerId);
  delete cipherTransitionPreDeployHumanSessionTokenByPlayerId[playerId];
  clearPhasePlayerOperationsForPlayer(playerId);
  clearLiveHudQueueForPlayer(playerId);
  void source;
}

function clearObjectiveCaptureAttemptStateForPlayerDataOnly(playerId: number): void {
  for (let i = 0; i < OBJECTIVE_DEFINITIONS.length; i++) {
    const cpId = OBJECTIVE_DEFINITIONS[i].cpId;
    if (objectiveCaptureAttemptPlayerIdByCpId[cpId] !== playerId) continue;
    objectiveCaptureAttemptEnabledByCpId[cpId] = false;
    objectiveCaptureAttemptTeamByCpId[cpId] = teamNeutral;
    objectiveCaptureAttemptKindByCpId[cpId] = "arm";
    objectiveCaptureAttemptTokenByCpId[cpId] = (objectiveCaptureAttemptTokenByCpId[cpId] ?? 0) + 1;
    objectiveCaptureAttemptStartTickByCpId[cpId] = undefined;
    objectiveCaptureAttemptStartAtSecByCpId[cpId] = undefined;
    objectiveCaptureAttemptPlayerIdByCpId[cpId] = undefined;
    objectiveSurfaceSyncQueued = true;
  }
}

function clearVolatilePlayerSessionState(playerId: number, source: string): void {
  clearJoinSettleStateForPlayer(playerId);
  removeSafeSpawnCheckForPlayer(playerId);
  clearCipherTransitionStateForPlayer(playerId, source);
  clearLiveHudQueueForPlayer(playerId);
  clearPhasePlayerOperationsForPlayer(playerId);
  clearTransitionSpawnStateForPlayer(playerId);
  cipherPendingSpawnJobs = cipherPendingSpawnJobs.filter((item) => item.playerId !== playerId);
  cipherUrgentSpawnJobs = cipherUrgentSpawnJobs.filter((item) => item.playerId !== playerId);
  delete cipherQueuedAnchorByPlayerId[playerId];
  invalidateCipherRespawnRouteJobForPlayer(playerId);
  clearObjectiveCaptureAttemptStateForPlayerDataOnly(playerId);
  clearAllObjectiveAreaTriggerStateForPlayer(playerId);
  clearCipherPresenceForPlayer(playerId);
  clearBombCarrierDeployRestoreCacheForPlayer(playerId);
  clearCipherKeyHudCacheForPlayer(playerId);
  cancelPendingRestrictedLethalConfirmForPlayer(playerId);
  delete cipherAdminInteractSpawnTokenByPlayerId[playerId];
  delete bombNoticeTokenByPlayerId[playerId];
  delete nextKeyUnlockHudLastStateByPlayerId[playerId];
  delete dmgQueued[playerId];
  delete dmgQueuedTicksLeft[playerId];
  delete dmgQueuedGiverObjId[playerId];
}

function emitPlayerLifecycleDiagnostic(message: string): void {
  void message;
}

function clearDisconnectedPlayerStateDataOnly(playerId: number, leaving?: Player): void {
  if (leaving) resetPlayerSessionRefsForJoin(leaving, false);

  clearVolatilePlayerSessionState(playerId, "disconnect_immediate");
  removeSafeSpawnCheckForPlayer(playerId);
  clearOldSafeSpawnStateForPlayer(playerId);

  restrictedAreaCountdownToken[playerId] = (restrictedAreaCountdownToken[playerId] ?? 0) + 1;
  cancelPendingRestrictedLethalConfirmForPlayer(playerId);
  clearAllRestrictedTriggerStateForPlayer(playerId);
  delete playerInRestrictedArea[playerId];
  delete playerInMandownByPlayerId[playerId];
  delete restrictedAreaFeedbackSuppressedByPlayerId[playerId];
  delete restrictedAreaRootWidgetByPlayerId[playerId];
  delete restrictedAreaCounterWidgetByPlayerId[playerId];

  delete readyTextBuiltByPlayerId[playerId];
  delete readyTextWidgetByPlayerId[playerId];
  liveHudBuiltByPlayerId[playerId] = false;
  delete liveHudBuiltSessionTokenByPlayerId[playerId];
  delete liveHudBuildQueuedByPlayerId[playerId];
  delete cipherAdminPanelVisibleByPlayerId[playerId];
  delete cipherSuddenDeathEliminatedByPlayerId[playerId];
  delete botBackfillKnownByPlayerId[playerId];
  clearPrematch889StateForPlayer(playerId);
  clearBombCarrierDeployRestoreCacheForPlayer(playerId);
  clearCipherKeyHudCacheForPlayer(playerId);

  cipherKeyActivePlayerIdsSnapshot = cipherKeyActivePlayerIdsSnapshot.filter((id) => id !== playerId);
  delete cipherKeyPlayerByIdSnapshot[playerId];
  delete cipherKeyTeamByPlayerIdSnapshot[playerId];
  delete cipherKeyTeamIdByPlayerIdSnapshot[playerId];
}

function pruneCipherTransitionDeployTracking(source: string): void {
  if (cipherSecondHalfTransitionStage !== "deploy") return;

  for (const key in cipherSecondHalfDeployRequiredByPlayerId) {
    const playerId = Number(key);
    const sp = serverPlayers.get(playerId);
    if (sp && isRequiredSecondHalfDeployPlayer(sp)) continue;

    clearCipherTransitionStateForPlayer(playerId, source + "_stale_required");
  }

  for (const key in cipherSecondHalfDeployReadyByPlayerId) {
    const playerId = Number(key);
    if (cipherSecondHalfDeployRequiredByPlayerId[playerId] === true) continue;
    clearCipherTransitionStateForPlayer(playerId, source + "_stale_ready");
  }

  if (cipherTransitionForceDeployQueue.length > 0) {
    cipherTransitionForceDeployQueue = cipherTransitionForceDeployQueue.filter((playerId) => {
      const sp = serverPlayers.get(playerId);
      const keep =
        !!sp &&
        isRequiredSecondHalfDeployPlayer(sp) &&
        isCurrentPlayerSession(playerId, cipherTransitionForceDeploySessionTokenByPlayerId[playerId]);
      if (!keep) delete cipherTransitionForceDeploySessionTokenByPlayerId[playerId];
      return keep;
    });
  }

}

function settleJoinedPlayerForCurrentPhase(p: Player, source: string): void {
  if (!p || !mod.IsPlayerValid(p.player)) return;

  if (gameStatus === 0 || gameStatus === -1) {
    mod.SetRedeployTime(p.player, 0);
    mod.EnablePlayerDeploy(p.player, true);
    return;
  }

  if (gameStatus === 1) {
    mod.SetRedeployTime(p.player, 0);
    mod.EnablePlayerDeploy(p.player, true);
    return;
  }

  if (gameStatus === 2) {
    mod.SetRedeployTime(p.player, 0);
    mod.EnablePlayerDeploy(p.player, true);
    return;
  }

  if (gameStatus === 4) {
    mod.EnablePlayerDeploy(p.player, true);
    return;
  }

  if (gameStatus !== 3) return;

  if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) {
    try {
      mod.SetRedeployTime(p.player, 0);
    } catch (errRedeploy) {
      LogRuntimeError("JoinSettle/transitionRedeploy/" + source + "/" + String(p.id), errRedeploy);
    }

    if (cipherSecondHalfTransitionStage === "deploy") {
      markCipherSecondHalfDeployRequiredForPlayer(p);
      requestCipherTransitionReconcile("join_settle_transition/" + source);
      mod.EnablePlayerDeploy(p.player, true);
    } else {
      mod.EnablePlayerDeploy(p.player, false);
    }
    return;
  }

  if (isCipherSuddenDeathActive()) {
    try {
      mod.SetRedeployTime(p.player, 9999);
    } catch (errRedeploy) {
      LogRuntimeError("JoinSettle/suddenDeathRedeploy/" + source + "/" + String(p.id), errRedeploy);
    }

    if (cipherSuddenDeathJoinAliveExemptByPlayerId[p.id] !== true) {
      cipherSuddenDeathEliminatedByPlayerId[p.id] = true;
      playerInMandownByPlayerId[p.id] = true;
    }

    playerLifecycleSuddenDeathRefreshPending = true;
    mod.EnablePlayerDeploy(p.player, false);
    return;
  }

  try {
    mod.SetRedeployTime(p.player, REDEPLOY_TIME);
    mod.EnablePlayerDeploy(p.player, true);
  } catch (errLiveJoinSetup) {
    LogRuntimeError("JoinSettle/liveSetup/" + source + "/" + String(p.id), errLiveJoinSetup);
  }

  runtimeBotNextReconcileAtSec = 0;
}

function removeSafeSpawnCheckForPlayer(playerId: number): void {
  safeSpawnCheckQueue = safeSpawnCheckQueue.filter((job) => job.playerId !== playerId);
  delete safeSpawnCheckQueuedGenerationByPlayerId[playerId];
}

function getSafeSpawnGeneration(playerId: number): number {
  return safeSpawnGenerationByPlayerId[playerId] ?? 0;
}

function bumpSafeSpawnGeneration(playerId: number): number {
  const next = getSafeSpawnGeneration(playerId) + 1;
  safeSpawnGenerationByPlayerId[playerId] = next;
  return next;
}

function clearOldSafeSpawnStateForPlayer(playerId: number): void {
  removeSafeSpawnCheckForPlayer(playerId);
  safeSpawnForcedQueue = safeSpawnForcedQueue.filter((job) => job.playerId !== playerId);
  delete safeSpawnForcedQueuedGenerationByPlayerId[playerId];
  delete safeSpawnUnsafePending[playerId];
  delete safeSpawnForcedUndeploy[playerId];
  delete safeSpawnForcedRedeploys[playerId];
  delete safeSpawnUnsafeHqObjIdByPlayerId[playerId];
  delete safeSpawnUnsafeSpawnerObjIdByPlayerId[playerId];
  delete lastLiveHqSpawnPointObjIdByPlayerId[playerId];
  delete lastForcedSafeSpawnHqObjIdByPlayerId[playerId];
}

function queueSafeSpawnCheckForPlayer(playerId: number): void {
  if (safeSpawnUnsafePending[playerId] === true) return;
  const generation = getSafeSpawnGeneration(playerId);
  if (safeSpawnCheckQueuedGenerationByPlayerId[playerId] === generation) return;
  safeSpawnCheckQueuedGenerationByPlayerId[playerId] = generation;
  safeSpawnCheckQueue.push({
    playerId,
    generation,
    dueTick: serverTickCount + SAFE_SPAWN_CHECK_DELAY_TICKS,
  });
}

function activatePendingPlayerSession(pending: PendingPlayerSession): void {
  if (!isCurrentPlayerSession(pending.playerId, pending.sessionToken)) return;
  const identity = tryGetSafeEventPlayerIdentity(pending.player);
  if (!identity || identity.playerId !== pending.playerId) return;
  if (identity.teamId !== 1 && identity.teamId !== 2) return;

  const isPrematchAdmission = !gameModeStarted || gameStatus === -1 || gameStatus === 0;

  // Clear only script-owned state here. Native UI and soldier setup are deferred
  // until the current handle produces OnPlayerDeployed.
  try {
    clearVolatilePlayerSessionState(pending.playerId, "pending_join_activate");
  } catch (err) {
    LogRuntimeError("PendingJoinActivate/clearVolatile/" + String(pending.playerId), err);
  }

  const player = new Player(pending.player, pending.playerId, pending.nativeObjId, identity.team);
  const snapshot = disconnectedPlayerSnapshotById[pending.playerId];
  if (snapshot) player.restorePersistentSnapshot(snapshot);
  player.player = pending.player;
  player.nativeObjId = pending.nativeObjId;
  player.team = identity.team;
  player.isDeployed = false;

  // Admit the current session before doing soldier/UI phase work. The roster reads
  // this activated table, while deployment can occur before a soldier exists.
  serverPlayers.set(player.id, player);
  playerActivatedSessionTokenByPlayerId[player.id] = pending.sessionToken;
  delete pendingPlayerSessionById[player.id];
  emitPlayerLifecycleDiagnostic(
    "JOIN_ACTIVATED logicalId=" + String(player.id) + " session=" + String(pending.sessionToken)
  );

  if (isPrematchAdmission) {
    try {
      mod.SetRedeployTime(player.player, 0);
    } catch (_errRedeploy) {}
    try {
      mod.EnablePlayerDeploy(player.player, true);
    } catch (err) {
      LogRuntimeError("PendingJoinActivate/prematchDeployUnlock/" + String(player.id), err);
    }
  }

  try {
    settleJoinedPlayerForCurrentPhase(player, pending.isReconnect ? "join_reconnect" : "join_first_time");
  } catch (err) {
    LogRuntimeError("PendingJoinActivate/settle/" + String(player.id), err);

    if (!isPrematchAdmission) {
      // Preserve the stricter quarantine behavior for live joins. Prematch is
      // intentionally fail-open because input/health calls can fail before a
      // soldier exists on the deployment screen.
      serverPlayers.delete(player.id);
      delete playerActivatedSessionTokenByPlayerId[player.id];
      pending.stableSamples = 0;
      pendingPlayerSessionById[player.id] = pending;
      try { mod.EnablePlayerDeploy(pending.player, false); } catch (_errDeployLock) {}
      throw err;
    }
  }

  delete disconnectedPlayerSnapshotById[player.id];

  if (pending.deployAckSeen) {
    void Mode_OnPlayerDeployed(player.player);
  }

  cipherKeyActivePlayerIdsSnapshot = [];
  cipherKeyPlayerByIdSnapshot = {};
  cipherKeyTeamByPlayerIdSnapshot = {};
  cipherKeyTeamIdByPlayerIdSnapshot = {};
  requestCipherTransitionReconcile("pending_join_activate");
}

function processPendingPlayerSessions(): boolean {
  const nowMs = Date.now();
  for (const key in pendingPlayerSessionById) {
    const pending = pendingPlayerSessionById[Number(key)];
    if (!pending) continue;
    if (!isCurrentPlayerSession(pending.playerId, pending.sessionToken)) {
      delete pendingPlayerSessionById[pending.playerId];
      continue;
    }
    if (nowMs < pending.nextRetryAtMs) continue;

    const identity = tryGetSafeEventPlayerIdentity(pending.player);
    if (
      !identity ||
      identity.playerId !== pending.playerId ||
      identity.nativeObjId !== pending.nativeObjId ||
      identity.isBot ||
      (identity.teamId !== 1 && identity.teamId !== 2)
    ) {
      pending.stableSamples = 0;
      pending.stableTeamId = 0;
      pending.nextRetryAtMs = nowMs + 1000;
      if (!pending.watchdogLogged && nowMs - pending.joinedAtMs >= PLAYER_JOIN_WATCHDOG_MS) {
        pending.watchdogLogged = true;
        LogRuntimeError("PendingJoinWatchdog/" + String(pending.playerId), "handle_or_team_not_stable");
      }
      continue;
    }

    if (pending.stableTeamId === identity.teamId) pending.stableSamples += 1;
    else {
      pending.stableTeamId = identity.teamId;
      pending.stableSamples = 1;
    }
    pending.nextRetryAtMs = nowMs;

    // The prematch deploy screen is already a stable admission boundary. Waiting
    // two seconds and two samples here can deadlock the host: no roster entry and
    // no deploy event to help the pending session advance. Live joins retain the
    // full quarantine delay and sample requirement.
    const isPrematchAdmission = !gameModeStarted || gameStatus === -1 || gameStatus === 0;
    const requiredStableSamples = isPrematchAdmission ? 1 : PLAYER_JOIN_REQUIRED_STABLE_SAMPLES;
    if (pending.stableSamples < requiredStableSamples) continue;
    if (!isPrematchAdmission && nowMs - pending.joinedAtMs < PLAYER_JOIN_STABILIZE_MS) continue;

    activatePendingPlayerSession(pending);
    return true;
  }
  return false;
}

function getLiveSafeSpawnHqIdsForTeam(team: mod.Team): number[] {
  return mod.Equals(team, team1) ? LIVE_SAFE_SPAWN_TEAM1_HQ_IDS : LIVE_SAFE_SPAWN_TEAM2_HQ_IDS;
}

function getLiveSafeSpawnPlayerSpawnerIdsForTeam(team: mod.Team): number[] {
  return mod.Equals(team, team1)
    ? LIVE_SAFE_SPAWN_TEAM1_PLAYERSPAWNER_IDS
    : LIVE_SAFE_SPAWN_TEAM2_PLAYERSPAWNER_IDS;
}

function getLiveSafeSpawnPlayerSpawnerIdForHq(hqId: number): number {
  return HQ_TO_PLAYERSPAWNER_ID[hqId] ?? 0;
}

function isValidLiveSafeSpawnHqIdForTeam(team: mod.Team, hqId: number): boolean {
  return getLiveSafeSpawnHqIdsForTeam(team).indexOf(hqId) >= 0;
}

function isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team: mod.Team, spawnerId: number): boolean {
  return getLiveSafeSpawnPlayerSpawnerIdsForTeam(team).indexOf(spawnerId) >= 0;
}

function getDefaultLiveSafeSpawnHqObjIdForTeam(team: mod.Team): number {
  return getCipherLiveHqIdForTeam(team);
}

function tryGetSpawnPointPositionSafe(spawnPointId: number): mod.Vector | undefined {
  try {
    return mod.GetObjectPosition(mod.GetSpawnPoint(spawnPointId) as unknown as mod.Object);
  } catch (_err) {
    return undefined;
  }
}

function trySpawnPlayerFromSpawnPointSafe(player: mod.Player, spawnerObjId: number, context: string): boolean {
  if (!spawnerObjId || tryGetSpawnPointPositionSafe(spawnerObjId) === undefined) return false;
  try {
    mod.SpawnPlayerFromSpawnPoint(player, spawnerObjId);
    return true;
  } catch (err) {
    LogRuntimeError("SpawnPlayerFromSpawnPoint/" + context, err);
    return false;
  }
}

function getStoredOrDefaultLiveSafeSpawnHqObjId(playerId: number, team: mod.Team): number {
  const stored = lastLiveHqSpawnPointObjIdByPlayerId[playerId];
  return stored !== undefined && isValidLiveSafeSpawnHqIdForTeam(team, stored)
    ? stored
    : getDefaultLiveSafeSpawnHqObjIdForTeam(team);
}

function resolveForcedSafeSpawnHqObjId(playerId: number, team: mod.Team, attempt: number): number {
  const ids = getLiveSafeSpawnHqIdsForTeam(team);
  const base = getStoredOrDefaultLiveSafeSpawnHqObjId(playerId, team);
  const previous = lastForcedSafeSpawnHqObjIdByPlayerId[playerId] ?? base;
  const selected = attempt > 1 && ids.length > 1 ? (previous === ids[0] ? ids[1] : ids[0]) : base;
  const sanitized = isValidLiveSafeSpawnHqIdForTeam(team, selected)
    ? selected
    : getDefaultLiveSafeSpawnHqObjIdForTeam(team);
  lastForcedSafeSpawnHqObjIdByPlayerId[playerId] = sanitized;
  return sanitized;
}

function recordLastLiveHqSpawnSourceFromDeploy(player: mod.Player, playerId: number): void {
  if (!mod.IsPlayerValid(player) || !isPlayerAliveSafe(player)) return;
  const team = mod.GetTeam(player);
  const playerPos = getPlayerPosition(player);
  const hqIds = getLiveSafeSpawnHqIdsForTeam(team);
  let nearestHqId = 0;
  let nearestDistance = 999999;
  for (let i = 0; i < hqIds.length; i++) {
    const hqId = hqIds[i];
    const pos = tryGetSpawnPointPositionSafe(getLiveSafeSpawnPlayerSpawnerIdForHq(hqId));
    if (!pos) continue;
    const distance = mod.DistanceBetween(playerPos, pos);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestHqId = hqId;
    }
  }
  if (nearestHqId > 0 && nearestDistance <= 10) lastLiveHqSpawnPointObjIdByPlayerId[playerId] = nearestHqId;
}

function queueForcedSafeSpawnRetryForCurrentRoute(player: mod.Player, playerId: number): boolean {
  if (!mod.IsPlayerValid(player)) return false;
  const team = mod.GetTeam(player);
  if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return false;
  const used = safeSpawnForcedRedeploys[playerId] ?? 0;
  if (used >= SAFE_SPAWN_MAX_FORCED_REDEPLOYS) return false;
  const attempt = used + 1;
  const hqObjId = resolveForcedSafeSpawnHqObjId(playerId, team, attempt);
  const spawnerObjId = getLiveSafeSpawnPlayerSpawnerIdForHq(hqObjId);
  if (!isValidLiveSafeSpawnPlayerSpawnerIdForTeam(team, spawnerObjId)) return false;
  const generation = getSafeSpawnGeneration(playerId);
  if (safeSpawnForcedQueuedGenerationByPlayerId[playerId] === generation) return true;
  safeSpawnForcedRedeploys[playerId] = attempt;
  safeSpawnForcedUndeploy[playerId] = true;
  safeSpawnUnsafePending[playerId] = true;
  safeSpawnUnsafeHqObjIdByPlayerId[playerId] = hqObjId;
  safeSpawnUnsafeSpawnerObjIdByPlayerId[playerId] = spawnerObjId;
  safeSpawnForcedQueuedGenerationByPlayerId[playerId] = generation;
  safeSpawnForcedQueue.push({
    playerId,
    generation,
    hqObjId,
    spawnerObjId,
    stage: "undeploy",
    dueTick: serverTickCount + 1,
    waitTicks: 0,
  });
  return true;
}

function finishSafeSpawnAsNativeFriendlyOrSquadSpawn(player: mod.Player, playerId: number): void {
  safeSpawnForcedRedeploys[playerId] = 0;
  safeSpawnForcedUndeploy[playerId] = false;
  safeSpawnUnsafePending[playerId] = false;
  invalidateCipherRespawnRouteJobForPlayer(playerId);
  consumeCipherRouteForNativeFriendlySpawn(player, playerId);
}

function finalizeSafeSpawnDeploySuccess(player: mod.Player, playerId: number): void {
  if (safeSpawnUnsafePending[playerId] === true) return;
  if (getCipherQueuedSpawnAnchorForPlayer(playerId) === undefined) prepareCipherQueuedAnchorForPlayer(playerId);
  const teleported = teleportCipherPlayerToRoutedAnchor(player, playerId);
  if (!teleported) {
    queueForcedSafeSpawnRetryForCurrentRoute(player, playerId);
    return;
  }
  if (hasEnemyNearPosition(mod.GetTeam(player), getPlayerPosition(player), SAFE_SPAWN_ENEMY_RADIUS_METERS, playerId)) {
    if (queueForcedSafeSpawnRetryForCurrentRoute(player, playerId)) return;
  }
  safeSpawnForcedUndeploy[playerId] = false;
  queueCipherAdminInteractSpawnForPlayer(playerId, "safe_spawn_success");
}

function runSafeSpawnCheck(item: SafeSpawnCheckQueueItem): void {
  if (item.generation !== getSafeSpawnGeneration(item.playerId)) return;
  if (safeSpawnUnsafePending[item.playerId] === true) return;
  const p = serverPlayers.get(item.playerId);
  if (!p || !p.isDeployed || !mod.IsPlayerValid(p.player)) return;
  if (gameStatus !== 3 || isCipherLiveTransitionActive() || isCipherSuddenDeathActive()) return;
  if (!isPlayerAliveSafe(p.player)) return;
  if (isNativeFriendlyOrSquadSpawn(p.player, item.playerId) || isSquadSpawnBypassActive(item.playerId)) {
    finishSafeSpawnAsNativeFriendlyOrSquadSpawn(p.player, item.playerId);
    return;
  }
  if (
    hasEnemyNearPosition(
      mod.GetTeam(p.player),
      getPlayerPosition(p.player),
      SAFE_SPAWN_ENEMY_RADIUS_METERS,
      item.playerId
    )
  ) {
    queueForcedSafeSpawnRetryForCurrentRoute(p.player, item.playerId);
    return;
  }
  safeSpawnForcedRedeploys[item.playerId] = 0;
  finalizeSafeSpawnDeploySuccess(p.player, item.playerId);
}

function processSafeSpawnCheckQueue(): boolean {
  if (safeSpawnCheckQueue.length <= 0) return false;
  const remaining: SafeSpawnCheckQueueItem[] = [];
  let processed = 0;
  for (let i = 0; i < safeSpawnCheckQueue.length; i++) {
    const item = safeSpawnCheckQueue[i];
    if (safeSpawnCheckQueuedGenerationByPlayerId[item.playerId] !== item.generation) continue;
    if (item.generation !== getSafeSpawnGeneration(item.playerId)) continue;
    if (processed >= SAFE_SPAWN_CHECKS_PER_TICK || item.dueTick > serverTickCount) {
      remaining.push(item);
      continue;
    }
    delete safeSpawnCheckQueuedGenerationByPlayerId[item.playerId];
    processed += 1;
    try {
      runSafeSpawnCheck(item);
    } catch (err) {
      LogRuntimeError("SafeSpawnCheck/" + String(item.playerId), err);
    }
  }
  safeSpawnCheckQueue = remaining;
  return processed > 0;
}

function processForcedSafeSpawnQueue(): boolean {
  if (safeSpawnForcedQueue.length <= 0) return false;
  const remaining: ForcedSafeSpawnQueueItem[] = [];
  let processed = 0;
  for (let i = 0; i < safeSpawnForcedQueue.length; i++) {
    const item = safeSpawnForcedQueue[i];
    if (safeSpawnForcedQueuedGenerationByPlayerId[item.playerId] !== item.generation) continue;
    if (item.generation !== getSafeSpawnGeneration(item.playerId)) continue;
    if (processed >= SAFE_SPAWN_FORCED_QUEUE_BUDGET_PER_TICK || item.dueTick > serverTickCount) {
      remaining.push(item);
      continue;
    }
    const p = serverPlayers.get(item.playerId);
    if (!p || !mod.IsPlayerValid(p.player)) {
      delete safeSpawnForcedQueuedGenerationByPlayerId[item.playerId];
      safeSpawnUnsafePending[item.playerId] = false;
      continue;
    }
    processed += 1;
    if (item.stage === "undeploy") {
      p.isDeployed = false;
      mod.SetRedeployTime(p.player, 9999);
      mod.UndeployPlayer(p.player);
      remaining.push({ ...item, stage: "spawn", dueTick: serverTickCount + SAFE_SPAWN_FORCED_SPAWN_DELAY_TICKS });
      continue;
    }
    if (p.isDeployed && item.waitTicks < TICK_RATE) {
      remaining.push({ ...item, dueTick: serverTickCount + 1, waitTicks: item.waitTicks + 1 });
      continue;
    }
    safeSpawnUnsafePending[item.playerId] = false;
    safeSpawnForcedUndeploy[item.playerId] = false;
    delete safeSpawnForcedQueuedGenerationByPlayerId[item.playerId];
    invalidateCipherRespawnRouteJobForPlayer(item.playerId);
    lastLiveHqSpawnPointObjIdByPlayerId[item.playerId] = item.hqObjId;
    lastForcedSafeSpawnHqObjIdByPlayerId[item.playerId] = item.hqObjId;
    mod.SetRedeployTime(p.player, 0);
    trySpawnPlayerFromSpawnPointSafe(p.player, item.spawnerObjId, "SafeSpawnForcedQueue");
    mod.SetRedeployTime(p.player, isCipherSuddenDeathActive() ? 9999 : REDEPLOY_TIME);
  }
  safeSpawnForcedQueue = remaining;
  return processed > 0;
}

function processPlayerLeaveCleanupQueue(): boolean {
  const job = playerLeaveCleanupQueue.shift();
  if (!job) return false;
  const playerId = job.playerId;
  try {
    if (cipherAdminPlayerId === playerId) {
      cipherAdminPlayerId = undefined;
    }
    if (job.wasCarrier) {
      scheduleBombCarrierDropAfterCombatEvent(playerId, "disconnect", job.cachedPosition, job.cachedTeam);
    }
    delete lastKnownLivePositionByPlayerId[playerId];
    playerLifecycleAdminRefreshPending = true;
    playerLifecycleSuddenDeathRefreshPending = isCipherSuddenDeathActive();
    playerLifecyclePrematchRefreshPending = gameStatus === 0 || gameStatus === -1;
    playerLifecycleScoreboardRefreshPending = true;
    requestCipherTransitionReconcile("leave_cleanup");
  } catch (err) {
    LogRuntimeError("PlayerLeaveCleanup/" + String(playerId), err);
  }
  return true;
}

function processPlayerLifecycleDeferredFanout(): void {
  if (playerLifecycleAdminRefreshPending) {
    playerLifecycleAdminRefreshPending = false;
    ensureCipherAdminAssigned();
    return;
  }
  if (playerLifecycleSuddenDeathRefreshPending) {
    playerLifecycleSuddenDeathRefreshPending = false;
    updateCipherSuddenDeathAliveHudForAllPlayers();
    return;
  }
  if (playerLifecyclePrematchRefreshPending) {
    playerLifecyclePrematchRefreshPending = false;
    refreshPrematchReadyStateUi();
    return;
  }
  if (playerLifecycleScoreboardRefreshPending) {
    playerLifecycleScoreboardRefreshPending = false;
    UpdateScoreboard();
    return;
  }
}

function processPlayerLifecycleSupervisor(): void {
  if (processPlayerLeaveCleanupQueue()) return;
  if (processPendingPlayerSessions()) return;
  if (processForcedSafeSpawnQueue()) return;
  processSafeSpawnCheckQueue();
}

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

function isValidHumanPlayerState(p: Player | undefined): p is Player {
  if (!p) return false;
  if (pendingPlayerSessionById[p.id] !== undefined) return false;
  if (playerActivatedSessionTokenByPlayerId[p.id] !== playerSessionTokenByPlayerId[p.id]) return false;

  try {
    if (!mod.IsPlayerValid(p.player)) return false;
    if (mod.GetObjId(p.player) !== p.nativeObjId) return false;
  } catch (_errValid) {
    return false;
  }

  if (isCipherRuntimeBotPlayerId(p.id)) return false;

  try {
    if (isBotBackfillPlayerSafe(p.player)) return false;
  } catch (_errBot) {
    return false;
  }

  return true;
}

function getValidHumanPlayerById(playerId: number): Player | undefined {
  const p = serverPlayers.get(playerId);
  return isValidHumanPlayerState(p) ? p : undefined;
}

function isCurrentEventPlayerReference(playerId: number, eventPlayer: mod.Player): boolean {
  const identity = tryGetSafeEventPlayerIdentity(eventPlayer);
  if (!identity || identity.playerId !== playerId) return false;
  const current = serverPlayers.get(playerId);
  if (!current || current.nativeObjId !== identity.nativeObjId) return false;
  if (!identity.isBot) adoptLatestHumanPlayerHandleFromEvent(identity, eventPlayer, false);
  return true;
}

function getValidHumanPlayersSnapshot(): Player[] {
  const players: Player[] = [];
  serverPlayers.forEach((p) => {
    if (isValidHumanPlayerState(p)) players.push(p);
  });
  return players;
}

function getNextValidHumanPlayerForUiLane(cursor: number): { player?: Player; nextCursor: number } {
  const ids: number[] = [];
  serverPlayers.forEach((p) => {
    if (p) ids.push(p.id);
  });
  ids.sort((a, b) => a - b);
  if (ids.length <= 0) return { nextCursor: 0 };
  for (let scanned = 0; scanned < ids.length; scanned++) {
    const index = (cursor + scanned) % ids.length;
    const player = getValidHumanPlayerById(ids[index]);
    if (player) return { player, nextCursor: (index + 1) % ids.length };
  }
  return { nextCursor: 0 };
}

function queueLiveHudBuild(
  playerId: number,
  reason: string,
  priority: LiveHudQueuePriority = "normal",
  delayTicks: number = 0
): void {
  const p = getValidHumanPlayerById(playerId);
  if (!p) return;
  if (gameStatus !== 3) return;

  const dueTick = phaseTickCount + mod.Max(0, delayTicks);
  markCipherKeyHudDirtyForPlayer(playerId);

  if (liveHudBuildQueuedByPlayerId[playerId] === true) {
    for (let i = 0; i < liveHudBuildQueue.length; i++) {
      const item = liveHudBuildQueue[i];
      if (item.playerId !== playerId) continue;
      item.dueTick = Math.min(item.dueTick, dueTick);
      if (priority === "urgent") item.priority = "urgent";
      item.reason = reason;
      return;
    }

    delete liveHudBuildQueuedByPlayerId[playerId];
  }

  const item: LiveHudBuildQueueItem = {
    playerId,
    reason,
    dueTick,
    priority,
    sessionToken: ensurePlayerSessionToken(playerId),
    expectedGameStatus: gameStatus,
    expectedMatchStage: cipherMatchStage,
    stage: "top",
  };
  liveHudBuildQueuedByPlayerId[playerId] = true;
  if (priority === "urgent") liveHudBuildQueue.unshift(item);
  else liveHudBuildQueue.push(item);
}

function queueLiveHudBuildForAll(reason: string, priority: LiveHudQueuePriority = "normal", delayTicks: number = 0): void {
  const players = getValidHumanPlayersSnapshot();
  for (let i = 0; i < players.length; i++) {
    queueLiveHudBuild(players[i].id, reason, priority, delayTicks);
  }
}

function clearLiveHudQueueForPlayer(playerId: number): void {
  liveHudBuildQueue = liveHudBuildQueue.filter((item) => item.playerId !== playerId);
  delete liveHudBuildQueuedByPlayerId[playerId];
}

function clearLiveHudQueues(): void {
  liveHudBuildQueue = [];
  liveHudBuildQueuedByPlayerId = {};
}

function mergeCipherKeyUiRefreshFlags(
  base: CipherKeyUiRefreshFlags,
  incoming: CipherKeyUiRefreshFlags
): CipherKeyUiRefreshFlags {
  return {
    force: base.force === true || incoming.force === true,
    rebuildHud: base.rebuildHud === true || incoming.rebuildHud === true,
    refreshBombNotice: base.refreshBombNotice === true || incoming.refreshBombNotice === true,
    refreshNextKey: base.refreshNextKey === true || incoming.refreshNextKey === true,
    updateCarrierHud: base.updateCarrierHud === true || incoming.updateCarrierHud === true,
    updateScores: base.updateScores === true || incoming.updateScores === true,
    updateIcons: base.updateIcons === true || incoming.updateIcons === true,
    syncCarrierVisuals: base.syncCarrierVisuals === true || incoming.syncCarrierVisuals === true,
    syncHybridSurface: base.syncHybridSurface === true || incoming.syncHybridSurface === true,
    pickupNoticeTeamId: incoming.pickupNoticeTeamId ?? base.pickupNoticeTeamId,
  };
}

function queueCipherKeyUiRefresh(
  reason: string,
  flags: CipherKeyUiRefreshFlags,
  delayTicks: number = 1
): void {
  if (gameStatus !== 3) return;

  const dueTick = phaseTickCount + mod.Max(0, delayTicks);
  for (let i = 0; i < cipherKeyUiRefreshQueue.length; i++) {
    const item = cipherKeyUiRefreshQueue[i];
    const existingTeam = item.flags.pickupNoticeTeamId ?? 0;
    const incomingTeam = flags.pickupNoticeTeamId ?? 0;
    if (item.dueTick !== dueTick || existingTeam !== incomingTeam) continue;

    item.flags = mergeCipherKeyUiRefreshFlags(item.flags, flags);
    item.reason = item.reason + ";" + reason;
    return;
  }

  cipherKeyUiRefreshQueue.push({ reason, dueTick, flags });
}

function clearCipherKeyUiRefreshQueue(): void {
  cipherKeyUiRefreshQueue = [];
}

function runCipherKeyUiRefreshJob(item: CipherKeyUiRefreshQueueItem): void {
  if (gameStatus !== 3) return;

  const flags = item.flags;
  const nowSec = getCurrentSchedulerNowSeconds();
  refreshCipherKeyPlayerSnapshots(item.reason);

  if (flags.pickupNoticeTeamId === 1) {
    showCipherKeyPickupNoticeForTeam(team1);
  } else if (flags.pickupNoticeTeamId === 2) {
    showCipherKeyPickupNoticeForTeam(team2);
  }

  if (flags.rebuildHud === true) {
    // Safety: key UI refresh jobs are allowed to update existing widgets, but they must not
    // delete/recreate the whole live HUD. Full rebuilds during pickup/delivery are the
    // crash pattern. Missing HUDs are handled by explicit live-start/join build jobs.
    repairDirtyCipherKeyHudCaches(1, false);
  }

  if (flags.refreshBombNotice === true) {
    refreshBombNoticeUiForAllPlayers(nowSec, flags.force === true);
  }

  if (flags.refreshNextKey === true) {
    updateNextKeyUnlockCountdownVisuals(nowSec, flags.force === true);
  }

  if (flags.updateCarrierHud === true) {
    const carrierAlpha = getBombCarrierPulseAlpha(nowSec);
    const carrierAlphaBucket = mod.Floor(carrierAlpha * 100);
    const next = getNextValidHumanPlayerForUiLane(liveCarrierStatusUiCursor);
    liveCarrierStatusUiCursor = next.nextCursor;
    const p = next.player;
    if (p) {
      const visible = bombCarrierPlayerId === p.id;
      applyBombCarrierHudStateForPlayer(p, visible, visible ? carrierAlpha : 1, visible ? carrierAlphaBucket : 100, flags.force === true);
    }
    UpdateBombCarrierUiForAllPlayers(nowSec, flags.force === true);
  }

  if (flags.updateScores === true) {
    SetUIScores();
  }

  if (flags.syncCarrierVisuals === true && bombCarrierPlayerId !== undefined) {
    syncCipherCarrierVisualsNow(nowSec, item.reason);
    updateBombCarrierBeepLoopTick(nowSec);
  }

  if (flags.updateIcons === true) {
    ensureDroppedBombRuntimeWorldIconVisibleIfNeeded();
    ensureBaseBombRuntimeWorldIconVisibleIfNeeded();
  }

  if (flags.syncHybridSurface === true && gameStatus === 3 && initialization[3] === true) {
    syncLiveHybridObjectiveSurfaceState(item.reason);
  }
}

function processCipherKeyUiRefreshQueue(): void {
  if (gameStatus !== 3) {
    clearCipherKeyUiRefreshQueue();
    return;
  }

  let processed = 0;
  for (let i = 0; i < cipherKeyUiRefreshQueue.length && processed < CIPHER_KEY_UI_REFRESHES_PER_TICK;) {
    const item = cipherKeyUiRefreshQueue[i];
    if (item.dueTick > phaseTickCount) {
      i += 1;
      continue;
    }

    cipherKeyUiRefreshQueue.splice(i, 1);
    try {
      runCipherKeyUiRefreshJob(item);
    } catch (err) {
      LogRuntimeError("processCipherKeyUiRefresh/" + item.reason, err);
    }
    processed += 1;
  }
}

function takeNextDueLiveHudBuild(): LiveHudBuildQueueItem | undefined {
  let normalIndex = -1;

  for (let i = 0; i < liveHudBuildQueue.length; i++) {
    const item = liveHudBuildQueue[i];
    if (item.dueTick > phaseTickCount) continue;
    if (item.priority === "urgent") {
      liveHudBuildQueue.splice(i, 1);
      delete liveHudBuildQueuedByPlayerId[item.playerId];
      return item;
    }
    if (normalIndex < 0) normalIndex = i;
  }

  if (normalIndex >= 0) {
    const item = liveHudBuildQueue.splice(normalIndex, 1)[0];
    delete liveHudBuildQueuedByPlayerId[item.playerId];
    return item;
  }

  return undefined;
}

function processLiveHudQueues(): boolean {
  if (gameStatus !== 3) return false;

  let builds = 0;
  while (builds < LIVE_HUD_BUILDS_PER_TICK) {
    const item = takeNextDueLiveHudBuild();
    if (!item) break;

    if (!isQueuedPlayerWorkCurrent(
      item.playerId,
      item.sessionToken,
      item.expectedGameStatus,
      item.expectedMatchStage
    )) {
      continue;
    }

    const p = getValidHumanPlayerById(item.playerId);
    if (!p) continue;

    try {
      SafeSetWidgetVisibleByName("LiveContainer", true);
      if (item.stage === "top") {
        if (!restrictedAreaRootWidgetByPlayerId[p.id]) buildRestrictedAreaUiForPlayer(p);
        const sessionToken = playerSessionTokenByPlayerId[p.id];
        bindPlayerTopScoreWidgetRefs(p);
        if (liveHudBuiltSessionTokenByPlayerId[p.id] === sessionToken && hasValidRootTopScoreWidgets(p.id)) {
          setTopScoreWidgetDepthForPlayer(p.id);
          UpdateTopTicketBarsForPlayer(p);
          liveHudBuildQueuedByPlayerId[p.id] = true;
          liveHudBuildQueue.push({ ...item, stage: "objectiveHold", dueTick: phaseTickCount + 1 });
        } else {
          deletePlayerLiveHudWidgets(p.id, liveHudBuiltSessionTokenByPlayerId[p.id]);
          resetCipherTransitionHudRefsForPlayer(p);
          liveHudBuildQueuedByPlayerId[p.id] = true;
          liveHudBuildQueue.push({ ...item, stage: "topBuild", dueTick: phaseTickCount + 1 });
        }
      } else if (item.stage === "topBuild") {
        if (rebuildPlayerTopScoreWidgets(p, true)) {
          liveHudBuildQueuedByPlayerId[p.id] = true;
          liveHudBuildQueue.push({ ...item, stage: "topBind", dueTick: phaseTickCount + 1 });
        }
      } else if (item.stage === "topBind") {
        bindPlayerTopScoreWidgetRefs(p);
        setTopScoreWidgetDepthForPlayer(p.id);
        UpdateTopTicketBarsForPlayer(p);
        liveHudBuildQueuedByPlayerId[p.id] = true;
        liveHudBuildQueue.push({ ...item, stage: "objectiveHold", dueTick: phaseTickCount + 1 });
      } else if (item.stage === "objectiveHold") {
        rebuildObjectiveHoldProgressUiWidgetsForPlayer(p);
        liveHudBuildQueuedByPlayerId[p.id] = true;
        liveHudBuildQueue.push({ ...item, stage: "deployTimer", dueTick: phaseTickCount + 1 });
      } else {
        rebuildDeployObjectiveTimerUiWidgetsForPlayer(p);
        liveHudBuiltByPlayerId[p.id] = true;
        liveHudBuiltSessionTokenByPlayerId[p.id] = item.sessionToken;
        repairCipherKeyHudCacheForPlayer(p, false);
      }
    } catch (err) {
      LogRuntimeError("processLiveHudBuild/" + item.reason + "/" + String(item.playerId), err);
      liveHudBuiltByPlayerId[item.playerId] = false;
      delete liveHudBuiltSessionTokenByPlayerId[item.playerId];
      markCipherKeyHudDirtyForPlayer(item.playerId);
    }

    builds += 1;
  }

  if (builds > 0) return true;

  // Do not perform opportunistic live-HUD rebuilds from the 30 Hz live loop.
  // Full HUD rebuilds happen only through queued live-start/join jobs above.
  repairDirtyCipherKeyHudCaches(LIVE_HUD_REPAIRS_PER_TICK, false);
  return false;
}

function getPhasePlayerOperationQueueKey(playerId: number, kind: PhasePlayerOperationKind): string {
  return kind + ":" + String(playerId);
}

function queuePhasePlayerOperation(
  playerId: number,
  kind: PhasePlayerOperationKind,
  reason: string,
  delayTicks: number = 0
): void {
  const p = getValidHumanPlayerById(playerId);
  if (!p) return;

  const key = getPhasePlayerOperationQueueKey(playerId, kind);
  const dueTick = phaseTickCount + mod.Max(0, delayTicks);

  if (phasePlayerOperationQueuedByKey[key] === true) {
    for (let i = 0; i < phasePlayerOperationQueue.length; i++) {
      const item = phasePlayerOperationQueue[i];
      if (item.playerId !== playerId || item.kind !== kind) continue;
      item.dueTick = Math.min(item.dueTick, dueTick);
      item.reason = reason;
      return;
    }

    delete phasePlayerOperationQueuedByKey[key];
  }

  phasePlayerOperationQueuedByKey[key] = true;
  phasePlayerOperationQueue.push({
    playerId,
    kind,
    reason,
    dueTick,
    sessionToken: ensurePlayerSessionToken(playerId),
    expectedGameStatus: gameStatus,
    expectedMatchStage: cipherMatchStage,
    expectedTransitionToken: getQueuedPlayerWorkTransitionToken(),
  });
}

function queuePhasePlayerOperationForAll(kind: PhasePlayerOperationKind, reason: string, delayTicks: number = 0): void {
  const players = getValidHumanPlayersSnapshot();
  for (let i = 0; i < players.length; i++) {
    queuePhasePlayerOperation(players[i].id, kind, reason, delayTicks);
  }
}

function clearPhasePlayerOperationsForPlayer(playerId: number): void {
  phasePlayerOperationQueue = phasePlayerOperationQueue.filter((item) => item.playerId !== playerId);
  delete phasePlayerOperationQueuedByKey[getPhasePlayerOperationQueueKey(playerId, "deploy")];
  delete phasePlayerOperationQueuedByKey[getPhasePlayerOperationQueueKey(playerId, "undeploy")];
}

function clearPhasePlayerOperationQueues(): void {
  phasePlayerOperationQueue = [];
  phasePlayerOperationQueuedByKey = {};
  preliveTransitionSpawnPendingAfterUndeploy = false;
}

function hasPendingPhasePlayerOperations(kind?: PhasePlayerOperationKind): boolean {
  for (let i = 0; i < phasePlayerOperationQueue.length; i++) {
    if (kind === undefined || phasePlayerOperationQueue[i].kind === kind) return true;
  }
  return false;
}

function processPhasePlayerOperationQueue(): void {
  if (phasePlayerOperationQueue.length <= 0) return;

  let processed = 0;
  for (let i = 0; i < phasePlayerOperationQueue.length && processed < PHASE_PLAYER_OPS_PER_TICK;) {
    const item = phasePlayerOperationQueue[i];
    if (item.dueTick > phaseTickCount) {
      i += 1;
      continue;
    }

    phasePlayerOperationQueue.splice(i, 1);
    delete phasePlayerOperationQueuedByKey[getPhasePlayerOperationQueueKey(item.playerId, item.kind)];

    if (!isQueuedPlayerWorkCurrent(
      item.playerId,
      item.sessionToken,
      item.expectedGameStatus,
      item.expectedMatchStage,
      item.expectedTransitionToken
    )) {
      continue;
    }

    const p = getValidHumanPlayerById(item.playerId);
    if (!p) continue;

    try {
      if (item.kind === "undeploy") {
        mod.UndeployPlayer(p.player);
        p.isDeployed = false;
      } else {
        mod.SetRedeployTime(p.player, 0);
        mod.DeployPlayer(p.player);
      }
    } catch (err) {
      LogRuntimeError("processPhasePlayerOperation/" + item.kind + "/" + item.reason + "/" + String(item.playerId), err);
    }

    processed += 1;
  }
}

function flushPreliveTransitionSpawnRequestsAfterUndeploy(): void {
  if (!preliveTransitionSpawnPendingAfterUndeploy) return;
  if (hasPendingPhasePlayerOperations("undeploy")) return;

  preliveTransitionSpawnPendingAfterUndeploy = false;
  requestTransitionSpawnForAllTransitionPlayers("prelive_start");
}

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
let scoreboardDeathCountedByPlayerId: { [playerId: number]: boolean } = {};
let restrictedAreaFeedbackSuppressedByPlayerId: { [playerId: number]: boolean } = {};
let restrictedAreaPendingLethalConfirmTokenByPlayerId: { [playerId: number]: number } = {};
let restrictedAreaPendingLethalConfirmTimerByPlayerId: { [playerId: number]: number | undefined } = {};
let objectiveAreaActiveTriggersByPlayerId: { [playerId: number]: { [triggerId: number]: boolean } } = {};
let objectiveAreaLastEnteredTriggerByPlayerId: { [playerId: number]: number | undefined } = {};

let restrictedAreaRootWidgetByPlayerId: { [playerId: number]: mod.UIWidget } = {};
let restrictedAreaCounterWidgetByPlayerId: { [playerId: number]: mod.UIWidget } = {};

function clearScoreboardDeathCountForPlayerLife(playerId: number): void {
  delete scoreboardDeathCountedByPlayerId[playerId];
}

function recordScoreboardDeathForPlayer(p: Player): boolean {
  if (scoreboardDeathCountedByPlayerId[p.id] === true) return false;
  p.addDeath();
  scoreboardDeathCountedByPlayerId[p.id] = true;
  p.updateScoreboard();
  return true;
}

function isRestrictedAreaTriggerId(triggerId: number): boolean {
  return RESTRICTED_AREA_TRIGGER_IDS.indexOf(triggerId) >= 0;
}

function isObjectiveAreaTriggerId(triggerId: number): boolean {
  return OBJECTIVE_AREA_TRIGGER_IDS.indexOf(triggerId) >= 0;
}

function isRestrictedTriggerForPlayer(triggerId: number, playerTeam: mod.Team): boolean {
  return triggerId === RESTRICTED_AREA_TRIGGER &&
    (mod.Equals(playerTeam, team1) || mod.Equals(playerTeam, team2));
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
  cancelCipherGlobalTask(restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId]);
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
  const sessionToken = ensurePlayerSessionToken(playerId);
  const expectedMatchStage = cipherMatchStage;
  const expectedTransitionToken = getQueuedPlayerWorkTransitionToken();
  restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] = token;
  restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId] = scheduleCipherGlobalTask(
    RESTRICTED_AREA_LETHAL_CONFIRM_DELAY_MS / 1000,
    "restricted_lethal_confirm/" + String(playerId),
    () => {
    if (restrictedAreaPendingLethalConfirmTokenByPlayerId[playerId] !== token) return;
    delete restrictedAreaPendingLethalConfirmTimerByPlayerId[playerId];

    if (!isQueuedPlayerWorkCurrent(
      playerId,
      sessionToken,
      3,
      expectedMatchStage,
      expectedTransitionToken
    )) return;

    const latest = serverPlayers.get(playerId);
    if (!latest) return;

    if (!hasRestrictedAreaFeedbackOrSourcesActive(playerId)) return;
    if (!isRestrictedAreaLethalStateForPlayer(playerId, latest.player)) return;

    deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
    }
  );
  void player;
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

  const rootName = getPrivatePlayerWidgetName("Restricted_Area_UI_", playerId);
  const counterName = getPrivatePlayerWidgetName("Restricted_Area_CounterText_", playerId);

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
        name: getPrivatePlayerWidgetName("Restricted_Area_Faded_", playerId),
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
            name: getPrivatePlayerWidgetName("Restricted_Area_RedRect_", playerId),
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
                name: getPrivatePlayerWidgetName("Restricted_Area_Text_", playerId),
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
                name: getPrivatePlayerWidgetName("Restricted_Area_LeaveNow_", playerId),
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
            name: getPrivatePlayerWidgetName("Restricted_Area_Outline_", playerId),
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

function tickRestrictedAreaCountdown(
  playerId: number,
  token: number,
  sessionGeneration: number | undefined,
  secondsLeft: number
): void {
  if (restrictedAreaCountdownToken[playerId] !== token) return;
  if (!isCurrentPlayerSession(playerId, sessionGeneration)) return;
  const latest = serverPlayers.get(playerId);
  if (!latest || !mod.IsPlayerValid(latest.player)) return;
  if (syncRestrictedAreaStateFromSources(playerId) !== true) {
    deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
    return;
  }

  if (secondsLeft <= 0) {
    if (latest.isDeployed && isPlayerAlive(latest.player)) {
      deactivateRestrictedAreaFeedbackForPlayer(playerId, true);
      mod.DealDamage(latest.player, 9999);
    }
    return;
  }

  const counterWidget = restrictedAreaCounterWidgetByPlayerId[playerId];
  if (counterWidget) mod.SetUITextLabel(counterWidget, mod.Message(secondsLeft));
  scheduleCipherGlobalTask(1, "restricted_countdown/" + String(playerId), () => {
    tickRestrictedAreaCountdown(playerId, token, sessionGeneration, secondsLeft - 1);
  });
}

function startRestrictedAreaCountdown(p: Player): void {
  const playerId = p.id;
  const myToken = (restrictedAreaCountdownToken[playerId] ?? 0) + 1;
  restrictedAreaCountdownToken[playerId] = myToken;
  if (syncRestrictedAreaStateFromSources(playerId) !== true) {
    deactivateRestrictedAreaFeedbackForPlayer(playerId, false);
    return;
  }
  const sessionGeneration = playerSessionTokenByPlayerId[playerId];
  scheduleCipherGlobalTask(RESTRICTED_AREA_UI_ACTIVATION_DELAY_SECONDS, "restricted_activate/" + String(playerId), () => {
    if (restrictedAreaCountdownToken[playerId] !== myToken) return;
    if (!isCurrentPlayerSession(playerId, sessionGeneration)) return;
    const latest = serverPlayers.get(playerId);
    if (!latest || syncRestrictedAreaStateFromSources(playerId) !== true) return;
    showRestrictedAreaUi(playerId);
    startRestrictedAreaLoopSfxForPlayer(latest.player);
    tickRestrictedAreaCountdown(playerId, myToken, sessionGeneration, 3);
  });
}

function cleanupRestrictedAreaUiForPlayer(playerId: number): void {
  resetRestrictedAreaStateForPlayer(playerId);

  const root = restrictedAreaRootWidgetByPlayerId[playerId];
  if (root) mod.DeleteUIWidget(root);

  delete restrictedAreaRootWidgetByPlayerId[playerId];
  delete restrictedAreaCounterWidgetByPlayerId[playerId];
}

/* ----------------------------------------
   Player session UI and scoreboard state
---------------------------------------- */

class Player {
  public player: mod.Player;
  public id: number;
  public nativeObjId: number;
  public team: mod.Team;

  public isDeployed: boolean;

  public friendlyScoreWidget: mod.UIWidget;
  public opponentScoreWidget: mod.UIWidget;
  public friendlyScorePadWidget: mod.UIWidget;
  public opponentScorePadWidget: mod.UIWidget;
  public bombCarrierTextWidget: mod.UIWidget;
  public bombNoticeContainerWidget: mod.UIWidget;
  public bombNoticeLeftAccentWidget: mod.UIWidget;
  public bombNoticeRightAccentWidget: mod.UIWidget;
  public bombNoticeTextWidget: mod.UIWidget;
  public bombNoticeDetailWidget: mod.UIWidget;
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

  private _scoreboard: number[]; // [score, kills, deaths, keyTimeSeconds, nodeCiphers]
  private _firstDeploy: boolean;
  private _ready: boolean;

    constructor(
      player: mod.Player,
      logicalPlayerId?: number,
      nativeObjId?: number,
      cachedTeam?: mod.Team
    ) {
    this.player = player;
    this.id = logicalPlayerId ?? modlib.getPlayerId(this.player);
    this.nativeObjId = nativeObjId ?? mod.GetObjId(this.player);
    this.team = cachedTeam ?? mod.GetTeam(this.player);

    this._scoreboard = [0, 0, 0, 0, 0];
    this._firstDeploy = true;
    this._ready = false;

    this.isDeployed = false;

    // Live HUD widget refs start empty. They will be built when live starts or when joining during live.
    this.friendlyScoreWidget = null as any;
    this.opponentScoreWidget = null as any;
    this.friendlyScorePadWidget = null as any;
    this.opponentScorePadWidget = null as any;
    this.bombCarrierTextWidget = null as any;
    this.bombNoticeContainerWidget = null as any;
    this.bombNoticeLeftAccentWidget = null as any;
    this.bombNoticeRightAccentWidget = null as any;
    this.bombNoticeTextWidget = null as any;
    this.bombNoticeDetailWidget = null as any;
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


    // Do not build any Live HUD widgets here.
    // Building them here is what causes some players to keep the placeholder tickets and then get a second set in live.

    // Mark as not built so rebuildPlayerLiveHud will build cleanly when needed.
    liveHudBuiltByPlayerId[this.id] = false;
  }


  isFirstDeploy(): boolean {
    if (this._firstDeploy) {
      this._firstDeploy = false;
      return true;
    }
    return false;
  }

  isFirstDeployPending(): boolean {
    return this._firstDeploy;
  }

  restorePersistentSnapshot(snapshot: DisconnectedPlayerSnapshot): void {
    this._scoreboard = snapshot.scoreboard.slice(0, 5);
    while (this._scoreboard.length < 5) this._scoreboard.push(0);
    this._firstDeploy = snapshot.firstDeployPending;
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
  }

  addUI(): void {
    if (gameStatus !== 3) return;

    // Build once (if needed), then only apply authoritative state -> UI.
    rebuildPlayerLiveHud(this);

    // Pull from authoritative server state
    this.updateTickets();
    UpdateObjectiveHoldProgressUiForPlayer(this);
    UpdateDeployObjectiveTimerUiForPlayer(this);
    updateCipherSuddenDeathAliveHudForPlayer(this);
  }
  getScoreboardSnapshot(): number[] {
    // [score, kills, deaths, keyTimeSeconds, nodeCiphers]
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

    try {
      const currentTeam = mod.GetTeam(this.player);

      const friendly = getFriendlyScore(currentTeam);
      const enemy = getOpponentScore(currentTeam);

      SafeSetTextLabelHandle(this.friendlyScoreWidget, mod.Message((mod.stringkeys as any).Text_FRIENDLY_SCORE, friendly));
      SafeSetTextLabelHandle(this.opponentScoreWidget, mod.Message((mod.stringkeys as any).Text_ENEMY_SCORE, enemy));

      UpdateTopTicketBarsForPlayer(this);

    } catch (_err) {
      this.friendlyScoreWidget = null as any;
      this.opponentScoreWidget = null as any;
      markCipherKeyHudDirtyForPlayer(this.id);
    }
  }

}

/* ----------------------------------------
   Capture point wrapper
---------------------------------------- */

class CapturePoint {
  public capturePoint: mod.CapturePoint | undefined;
  public readonly symbol: ObjectiveLetter;
  public readonly id: number;
  private owner: mod.Team = teamNeutral;
  private resolveMissingWarned = false;

  constructor(id: number, symbol: ObjectiveLetter) {
    this.id = id;
    this.symbol = symbol;
  }

  resolveHandle(context: string): mod.CapturePoint | undefined {
    if (this.capturePoint) return this.capturePoint;
    try {
      this.capturePoint = mod.GetCapturePoint(this.id);
      return this.capturePoint;
    } catch (err) {
      if (!this.resolveMissingWarned) {
        this.resolveMissingWarned = true;
        LogRuntimeError("CapturePoint/GetCapturePoint/" + context + "/" + String(this.id), err);
      }
      return undefined;
    }
  }

  setOwner(owner: mod.Team): void {
    this.owner = owner;
  }

  getOwner(): mod.Team {
    return this.owner;
  }

  getColor(viewerTeam: mod.Team): mod.Vector {
    if (mod.Equals(viewerTeam, this.owner)) return COLOR_FRIENDLY;
    if (mod.Equals(this.owner, teamNeutral)) return COLOR_NEUTRAL;
    return COLOR_ENEMY;
  }
}

/* Display-only CapturePoint registry; handles resolve lazily after mode start. */
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
  const t1SpawnerObjId = getConfiguredInitialTransitionHqObjIdForTeam(team1);
  const t2SpawnerObjId = getConfiguredInitialTransitionHqObjIdForTeam(team2);
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
  snapshotReadyTransitionHumans();
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

function SafeEnableHQById(hqId: number, enabled: boolean, force: boolean = false): void {
  if (!force && hqEnabledStateById[hqId] === enabled) return;
  try {
    mod.EnableHQ(mod.GetHQ(hqId), enabled);
    hqEnabledStateById[hqId] = enabled;
  } catch (err) {
    warnSafeEnableHqOnce(hqId, enabled, String(err));
    LogRuntimeError("SafeEnableHQById/" + String(hqId), err);
  }
}

function getAllManagedCipherHqIds(): number[] {
  return MANAGED_CIPHER_HQ_IDS;
}

function applyCipherHqProfileNow(desiredIds: number[], force: boolean): void {
  const desiredById: { [hqId: number]: boolean | undefined } = {};
  for (let i = 0; i < desiredIds.length; i++) desiredById[desiredIds[i]] = true;

  // Enabling the incoming profile first guarantees that a live team never observes
  // a frame with no HQ while the native deploy graph is being updated.
  for (let i = 0; i < desiredIds.length; i++) {
    SafeEnableHQById(desiredIds[i], true, force);
  }

  const managedIds = getAllManagedCipherHqIds();
  for (let i = 0; i < managedIds.length; i++) {
    const hqId = managedIds[i];
    if (desiredById[hqId] === true) continue;
    SafeEnableHQById(hqId, false, force);
  }
}

function setCipherHqPhaseProfile(profileKey: string, desiredIds: number[]): void {
  let sameProfile = hqPhaseProfileKey === profileKey && hqPhaseProfileDesiredIds.length === desiredIds.length;
  if (sameProfile) {
    for (let i = 0; i < desiredIds.length; i++) {
      if (hqPhaseProfileDesiredIds[i] !== desiredIds[i]) {
        sameProfile = false;
        break;
      }
    }
  }
  if (sameProfile) return;

  hqPhaseProfileKey = profileKey;
  hqPhaseProfileDesiredIds = desiredIds.slice();
  hqPhaseProfileEpoch += 1;
  const epoch = hqPhaseProfileEpoch;
  applyCipherHqProfileNow(hqPhaseProfileDesiredIds, false);

  const reassert = (): void => {
    if (epoch !== hqPhaseProfileEpoch) return;
    applyCipherHqProfileNow(hqPhaseProfileDesiredIds, true);
  };
  scheduleCipherGlobalTask(0, "hq_profile_reconcile/" + profileKey, reassert);
}

function EnableAllBaseHQs(): void {
  setCipherHqPhaseProfile("half1", [TEAM1_INITIAL_HQ, TEAM2_INITIAL_HQ]);
}

function getCipherLiveHqIdForTeam(team: mod.Team): number {
  if (cipherCurrentHalf === 1) {
    return mod.Equals(team, team1) ? TEAM1_INITIAL_HQ : TEAM2_INITIAL_HQ;
  }
  return mod.Equals(team, team1) ? TEAM1_LIVE_HQ : TEAM2_LIVE_HQ;
}

function applyCipherSecondHalfHqSpawns(context: string = "second_half_hq_spawns"): void {
  setCipherHqPhaseProfile("half2", [TEAM1_LIVE_HQ, TEAM2_LIVE_HQ]);
  void context;
}

function EnableLiveBaseHQs(): void {
  if (cipherCurrentHalf === 2) {
    applyCipherSecondHalfHqSpawns("EnableLiveBaseHQs");
    return;
  }
  setCipherHqPhaseProfile("half1", [getCipherLiveHqIdForTeam(team1), getCipherLiveHqIdForTeam(team2)]);
}

function ConfigureLiveSpawns(): void {
  EnableLiveBaseHQs();
}

function ConfigurePreMatchSpawns(): void {
  // HQ is an opaque Portal SDK handle. GetObjId only accepts mod.Object, so attempting
  // to validate GetHQ(8888/8889) through GetObjId falsely reports both authored HQs as
  // missing. The spatial file is authoritative: prematch always uses 8888 and 8889.
  setCipherHqPhaseProfile("prematch_ready", [TEAM1_READYUP_HQ, TEAM2_READYUP_HQ]);
}


/* =================================================================================================
   10) TICKETS / BLEED / SCOREBOARD
================================================================================================= */


function UpdateScoreboard(): void {
  const next = getNextValidHumanPlayerForUiLane(liveScoreboardCursor);
  liveScoreboardCursor = next.nextCursor;
  if (next.player) next.player.updateScoreboard();
}


/* =================================================================================================
   12) PHASE INITIALIZATION
================================================================================================= */
function ResetRoutingStateForNewRound(): void {
  squadSpawnBypass = {};
  resetCipherSpawnRoutingState();
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
  cipherPostmatchTransitionStarted = false;
  postmatchWinnerTeam = teamNeutral;
  objectiveAreaActiveTriggersByPlayerId = {};
  objectiveAreaLastEnteredTriggerByPlayerId = {};
  playerInMandownByPlayerId = {};
  scoreboardDeathCountedByPlayerId = {};
  cipherSuddenDeathJoinAliveExemptByPlayerId = {};
  cipherSuddenDeathJoinCleanupQueuedByPlayerId = {};

  ResetRoutingStateForNewRound();

  // Restore all objectives to defending-owner defaults for the next round.
  registerObjectivesDeterministically();
  applyObjectiveRoundStartOwnership(true);

  // Reset the match timer baseline (your custom timer uses phaseTickCount + ROUND_TIME)
  phaseTickCount = 0;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  resetLiveClockState();
  prematchReadyPlayersByTeam = [0, 0];
  prematchTotalPlayersByTeam = [0, 0];
  prematchAllPlayersReady = false;
  prematchReadyLastHandledTickByPlayerId = {};
  prematchReadyDebounceWarnedByPlayerId = {};
  prematchPreliveGateWarnedByKey = {};
}


function resetLifecycleStateForFreshMatchStart(): void {
  resetCipherScheduledTasks();
  resetUniversalPlayerLifecycleQueues(true);
  // OnPlayerJoinGame can run before OnGameModeStarted for the hosting player.
  // A fresh mode start must invalidate old sessions, then explicitly bootstrap
  // every player who is still connected. Leaving stale Player wrappers here
  // makes the active-session filter hide them from prematch UI and lifecycle work.
  serverPlayers.clear();
  playerSessionTokenByPlayerId = {};
  playerLifeGenerationByPlayerId = {};
  playerDisconnectedAtTickByPlayerId = {};
  clearRuntimeBotState(true);
  initialization[0] = false;
  initialization[1] = false;
  initialization[2] = false;
  initialization[3] = false;
  initialization[4] = false;
  liveInitializationActive = false;
  liveInitializationStage = 0;
  liveInitializationPlayerIds = [];
  liveInitializationPlayerCursor = 0;
  liveInitializationObjectiveCursor = 0;
  preliveInitializationStage = 0;
  preliveInitializationPlayerIds = [];
  preliveInitializationPlayerCursor = 0;
  preliveInitializationObjectiveCursor = 0;
  phaseUiCleanupPlayerIds = [];
  phaseUiCleanupCursor = 0;
  phaseUiCleanupQueuedByPlayerId = {};
  liveCarrierTicketUiCursor = 0;
  liveBombNoticeUiCursor = 0;
  liveCarrierStatusUiCursor = 0;
  liveObjectiveHoldUiCursor = 0;
  liveDeployTimerUiCursor = 0;
  liveNextKeyUiCursor = 0;
  cipherCounterWorldIconCursor = 0;
  liveScoreboardCursor = 0;
  suddenDeathAliveHudCursor = 0;
  phaseTickCount = 0;
  currentFrameNowSec = 0;
  currentFrameHasEngineNowSec = false;
  countDown = COUNT_DOWN_TIME;
  liveGameModeLimitAtSec = 0;
  clearPhaseCountdownDeadline();
  resetEngineSchedulerCadenceState();
  resetLiveClockState();
  prematchReadyPlayersByTeam = [0, 0];
  prematchTotalPlayersByTeam = [0, 0];
  prematchAllPlayersReady = false;
  clearPostmatchEndTimer();
  postmatchEndToken += 1;
  clearPostmatchEndTimer();
  postmatchEndToken += 1;
  postmatchEndStep = 0;
  postmatchEndStepTick = 0;
  postmatchEndStepAtSec = 0;
  postmatchEndTick = 0;
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
  cipherPostmatchTransitionStarted = false;
  transitionFallbackActive = false;
  transitionFallbackNextAllowedTick = 0;
  transitionWarnedByKey = {};
  liveTransitionCheckpointSeenByKey = {};
  hqEnableWarnedById = {};
  hqEnabledStateById = {};
  hqPhaseProfileKey = "none";
  hqPhaseProfileEpoch += 1;
  hqPhaseProfileDesiredIds = [];
  prematchUiGuardWarnedByKey = {};
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
  clearLiveHudQueues();
  clearCipherKeyUiRefreshQueue();
  clearPhasePlayerOperationQueues();
  preliveZeroTransitionHandled = false;
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
  cipherPostmatchTransitionStarted = false;
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
  hideAllObjectiveArmedWorldIcons();
  HideAllDeployObjectiveTimerUi();
  ResetRoutingStateForNewRound();
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
  clearLiveHudQueues();
  clearCipherKeyUiRefreshQueue();
  clearPhasePlayerOperationQueues();

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
  const prematchPlayers = getValidHumanPlayersSnapshot();
  for (let i = 0; i < prematchPlayers.length; i++) {
    const p = prematchPlayers[i];
    p.resetReadyForNewRound();

    // Also force the per-player prematch ready text to update immediately
    // (recreate it so it cannot carry old label/color)
    replacePrematchReadyText(p.id, p.player);

    // Reset internal deploy bookkeeping so prematch behaves clean
    p.isDeployed = false;

    // Clear redeploy time so players can be placed into prematch world state.
    try {
      mod.SetRedeployTime(p.player, 0);
    } catch (errRedeploy) {
      LogRuntimeError("ReturnToPreMatchState/setRedeployTime/" + String(p.id), errRedeploy);
    }

    // Apply prematch restrictions (combat enabled, interact allowed)
    applyPhaseInputRestrictionsForPlayer(p.player);

  }

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
  forceEnablePrematchDeploymentForKnownPlayers("ReturnToPreMatchState");

  // --- Make sure prematch roster UI reflects the new prematch state immediately ---
  refreshPrematchReadyStateUi();
  ShowPrematchUi();
  applyPrematch889HealthForAllPlayers();

  // --- Put everyone back into the world in prematch through the bounded operation queue. ---
  queuePhasePlayerOperationForAll("deploy", "ReturnToPreMatchState");
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
  clearPostmatchShowcaseState();
  setLiveScorePanelVisible(false);
  disableAllObjectiveCapturePointObjectives("InitializePreMatch");
  disableAllObjectiveSurfaceSectors("InitializePreMatch", true);
  disableAllObjectiveInteractPoints("InitializePreMatch");
  syncDisabledBombAnchorObjectives();
  hideAllObjectiveArmedWorldIcons();
  HideAllDeployObjectiveTimerUi();
  invalidateCipherLiveTransitionOwnership();
  cipherSecondHalfTransitionActive = false;
  cipherSuddenDeathTransitionActive = false;
  cipherSecondHalfTransitionStage = "none";
  clearCipherLivePhaseTransitionRuntimeState("InitializePreMatch", true, true);
  resetLiveClockState();

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

  const prematchPlayers = getValidHumanPlayersSnapshot();
  for (let i = 0; i < prematchPlayers.length; i++) {
    prematchPlayers[i].setTeam();
  }

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
  forceEnablePrematchDeploymentForKnownPlayers("InitializePreMatch");

  refreshPrematchReadyStateUi();

  for (let i = 0; i < prematchPlayers.length; i++) {
    setReadyPhaseProtectionForPlayer(prematchPlayers[i].player, true);
  }
  applyPrematch889HealthForAllPlayers();

  initialization[0] = true;
  resetTransitionFallbackGuardIfPrematchReady();
}

function InitializeCountDown(): void {
  let initOk = false;
  try {
    liveTransitionCheckpointSeenByKey = {};
    emitLiveTransitionCheckpoint("countdown_init_enter");
    phaseTickCount = 0;
    countDown = COUNT_DOWN_TIME;
    clearPhaseCountdownDeadline();
    resetEngineSchedulerCadenceState();
    setLiveScorePanelVisible(false);
    hideCipherLiveHudForAllPlayers();
    syncDisabledBombAnchorObjectives();
    hideAllObjectiveArmedWorldIcons();
    HideAllDeployObjectiveTimerUi();
    resetBombCarrierRuntimeState(true);
    registerObjectivesDeterministically();
    applyObjectiveLiveHybridRoundStartState(true);
    resetMatchStartBannerState(true);
    resetLiveClockState();
    clearLiveHudQueues();
    clearCipherKeyUiRefreshQueue();
    clearPhasePlayerOperationQueues();
    resetTransitionSpawnQueueState(false);
    preliveZeroTransitionHandled = false;
    readyTransitionWaitingShown = false;


    // Show the countdown UI for the ready-up delay.
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

    EnableAllBaseHQs();
    enforceReadyupHqsDisabledOutsidePrematch("InitializeCountDown");
    resetTransitionSpawnQueueState(false);
    clearCipherSpawnJobQueues();

    const countdownPlayers = getValidHumanPlayersSnapshot();
    for (let i = 0; i < countdownPlayers.length; i++) {
      setReadyPhaseProtectionForPlayer(countdownPlayers[i].player, true);
    }
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
  try {
    if (preliveInitializationStage === 0) {
      liveTransitionCheckpointSeenByKey = {};
      emitLiveTransitionCheckpoint("prelive_init_enter");
      phaseTickCount = 0;
      countDown = PRELIVE_TIME;
      setPhaseCountdownDeadlineFromNow(PRELIVE_TIME);
      configureReadyTransitionDeployDueTicks();
      resetEngineSchedulerCadenceState();
      setLiveScorePanelVisible(false);
      syncDisabledBombAnchorObjectives();
      hideAllObjectiveArmedWorldIcons();
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
      preliveInitializationStage = 1;
      return;
    }
    if (preliveInitializationStage === 1) {
      clearCipherLivePhaseTransitionRuntimeState("InitializePreLive", true, false, false, true);
      resetCipherSuddenDeathState();
      resetCipherSpawnRoutingState();
      preliveTeamSanityWarnedByPlayerId = {};
      resetRuntimeBotStagedSpawnSchedule();
      clearLiveHudQueues();
      clearCipherKeyUiRefreshQueue();
      clearPhasePlayerOperationQueues();
      preliveZeroTransitionHandled = false;
      preliveInitializationStage = 2;
      return;
    }
    if (preliveInitializationStage === 2) {
      if (!validatePreLivePlayerTeamsFromEngine() || !validatePreLiveTransitionSpawnPrerequisites()) {
        throw new Error("prelive validation failed");
      }
      startCipherFirstDeployAnchorSession("half1", "InitializePreLive");
      preliveInitializationStage = 3;
      return;
    }
    if (preliveInitializationStage === 3) {
      SafeSetTextLabelByName("MatchStartsText", mod.Message(mod.stringkeys.MatchStarts));
      SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
      HidePrematchUiForTransition();
      SetCountdownOverlayVisible(true);
      SetCountdownOverlayDepthAboveGameUI();
      for (let i = 0; i < 4; i++) SafeEnableWorldIconById(WORLDICON_T1_SWITCH + i, false, false);
      SafeEnableInteractPointById(IP_T1_SWITCH, false);
      SafeEnableInteractPointById(IP_T1_READY, false);
      SafeEnableInteractPointById(IP_T2_SWITCH, false);
      SafeEnableInteractPointById(IP_T2_READY, false);
      disableAllObjectiveInteractPoints("InitializePreLive");
      preliveInitializationStage = 4;
      return;
    }
    if (preliveInitializationStage === 4) {
      mod.SetSpawnMode(mod.SpawnModes.Deploy);
      EnableLiveBaseHQs();
      enforceReadyupHqsDisabledOutsidePrematch("InitializePreLive");
      registerObjectivesDeterministically();
      preliveInitializationStage = 5;
      return;
    }
    if (preliveInitializationStage === 5) {
      beginCursorObjectiveLiveHybridRoundStartState();
      preliveInitializationObjectiveCursor = 0;
      preliveInitializationStage = 6;
      return;
    }
    if (preliveInitializationStage === 6) {
      if (preliveInitializationObjectiveCursor < OBJECTIVE_DEFINITIONS.length) {
        applyCursorObjectiveLiveHybridRoundStartForIndex(preliveInitializationObjectiveCursor++);
        return;
      }
      syncLiveHybridObjectiveSurfaceState("InitializePreLive");
      preliveInitializationPlayerIds = readyTransitionHumanPlayerIds.slice();
      preliveInitializationPlayerCursor = 0;
      preliveInitializationStage = 7;
      return;
    }
    if (preliveInitializationStage === 7) {
      if (preliveInitializationPlayerCursor < preliveInitializationPlayerIds.length) {
        const index = preliveInitializationPlayerCursor++;
        const playerId = preliveInitializationPlayerIds[index];
        const expectedSession = readyTransitionSessionTokenByPlayerId[playerId];
        if (expectedSession !== undefined && isCurrentPlayerSession(playerId, expectedSession)) {
          queuePhasePlayerOperation(playerId, "undeploy", "InitializePreLive", index);
        }
        return;
      }
      preliveInitializationPlayerIds = getValidHumanPlayersSnapshot().map((p) => p.id);
      preliveInitializationPlayerCursor = 0;
      preliveInitializationStage = 8;
      return;
    }
    if (preliveInitializationStage === 8) {
      if (preliveInitializationPlayerCursor < preliveInitializationPlayerIds.length) {
        const playerId = preliveInitializationPlayerIds[preliveInitializationPlayerCursor++];
        const player = getValidHumanPlayerById(playerId);
        if (player) setReadyPhaseProtectionForPlayer(player.player, true);
        return;
      }
      cipherPhaseTransitionUndeployIgnoreUntilSec = getCurrentSchedulerNowSeconds() + PRELIVE_TIME + 2;
      preliveTransitionSpawnPendingAfterUndeploy = true;
      preliveInitializationStage = 0;
      initialization[2] = true;
    }
  } catch (err) {
    LogRuntimeError("InitializePreLive", err);
    preliveInitializationStage = 0;
    initialization[2] = false;
    warnTransitionRecoveryOnce(
      "initfail/InitializePreLive",
      mod.Message("[TRANSITION INIT FAIL] phase/status/inits {}", "prelive/" + String(gameStatus) + "/" + getInitializationFlagSummary())
    );
  }
}

function processLiveInitializationStep(): void {
  if (!liveInitializationActive || gameStatus !== 3) return;
  if (liveInitializationStage === 0) {
    emitLiveTransitionCheckpoint("live_init_enter");
    clearLiveHudQueues();
    clearCipherKeyUiRefreshQueue();
    endCipherFirstDeployAnchorSession("InitializeLive");
    resetLiveClockState();
    liveGameModeLimitAtSec = mod.GetMatchTimeElapsed() + LIVE_ENGINE_TIME_LIMIT_SAFETY_SECONDS;
    mod.SetGameModeTimeLimit(liveGameModeLimitAtSec);
    liveInitializationStage = 1;
    return;
  }
  if (liveInitializationStage === 1) {
    syncDisabledBombAnchorObjectives();
    hideAllObjectiveArmedWorldIcons();
    invalidateCipherLiveTransitionOwnership();
    clearCipherLivePhaseTransitionRuntimeState("InitializeLive", true, false, false, true);
    liveInitializationStage = 2;
    return;
  }
  if (liveInitializationStage === 2) {
    serverScores = [INITIAL_TICKETS, INITIAL_TICKETS];
    cipherCurrentHalf = 1;
    cipherMatchStage = "half1";
    cipherHalfScores = [0, 0];
    resetCipherSuddenDeathState();
    cipherSecondHalfTransitionActive = false;
    cipherSuddenDeathTransitionActive = false;
    cipherSecondHalfTransitionStage = "none";
    resetCipherSpawnRoutingState();
    registerObjectivesDeterministically();
    liveInitializationStage = 3;
    return;
  }
  if (liveInitializationStage === 3) {
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
    ConfigureLiveSpawns();
    enforceReadyupHqsDisabledOutsidePrematch("InitializeLive");
    beginCursorObjectiveLiveHybridRoundStartState();
    liveInitializationObjectiveCursor = 0;
    liveInitializationStage = 4;
    return;
  }
  if (liveInitializationStage === 4) {
    if (liveInitializationObjectiveCursor < OBJECTIVE_DEFINITIONS.length) {
      applyCursorObjectiveLiveHybridRoundStartForIndex(liveInitializationObjectiveCursor++);
      return;
    }
    syncLiveHybridObjectiveSurfaceState("InitializeLive");
    liveInitializationObjectiveCursor = 0;
    liveInitializationStage = 5;
    return;
  }
  if (liveInitializationStage === 5) {
    if (liveInitializationObjectiveCursor < OBJECTIVE_DEFINITIONS.length) {
      const def = OBJECTIVE_DEFINITIONS[liveInitializationObjectiveCursor++];
      updateCipherCounterWorldIconForCp(def.cpId, true);
      return;
    }
    liveInitializationStage = 6;
    return;
  }
  if (liveInitializationStage === 6) {
    phaseTickCount = 0;
    clearPhaseCountdownDeadline();
    resetEngineSchedulerCadenceState();
    SetDepthAboveGameUI("UIContainer");
    SetDepthAboveGameUI("LiveContainer");
    SetDepthAboveGameUI("matchtime");
    SetDepthAboveGameUI("LiveTimerIntroContainer");
    SetDepthAboveGameUI("friendlyscore");
    SetDepthAboveGameUI("enemyscore");
    SetDepthAboveGameUI("BG_Score_Container");
    SetDepthAboveGameUI("Container_A");
    SetDepthAboveGameUI("Container_B");
    SetDepthAboveGameUI("Container_C");
    SetDepthAboveGameUI("Container_D");
    liveInitializationStage = 7;
    return;
  }
  if (liveInitializationStage === 7) {
    HidePrematchUiForTransition();
    SetCountdownOverlayVisible(false);
    SafeSetWidgetVisibleByName("LiveContainer", true);
    liveInitializationPlayerIds = getValidHumanPlayersSnapshot().map((p) => p.id);
    liveInitializationPlayerCursor = 0;
    beginRegulationClock(getCurrentSchedulerNowSeconds());
    liveInitializationStage = 8;
    return;
  }
  if (liveInitializationStage === 8 && liveInitializationPlayerCursor < liveInitializationPlayerIds.length) {
    const playerId = liveInitializationPlayerIds[liveInitializationPlayerCursor++];
    const p = getValidHumanPlayerById(playerId);
    if (!p) return;
    try {
      hideDeployObjectiveTimerUiForPlayer(playerId);
      setReadyPhaseProtectionForPlayer(p.player, false);
      p.setTeam();
      mod.SetRedeployTime(p.player, REDEPLOY_TIME);
      clearCipherLiveInputRestrictionsForPlayer(p.player);
      if (p.isDeployed) p.isFirstDeploy();
      queueLiveHudBuild(playerId, "InitializeLive", "normal", liveInitializationPlayerCursor);
    } catch (errPlayerSetup) {
      LogRuntimeError("InitializeLive/playerSetup/" + String(playerId), errPlayerSetup);
    }
    return;
  }

  if (liveInitializationStage === 8) liveInitializationStage = 9;
  if (liveInitializationStage !== 9) return;

  refreshCipherKeyPlayerSnapshots("InitializeLive");
  startRuntimeBotLiveStartSettle("half1", "InitializeLive");
  requestLiveBotSpawnsForAllBots("InitializeLive");
  mod.SetScoreboardColumnNames(
    mod.Message(mod.stringkeys.ScoreboardScore),
    mod.Message(mod.stringkeys.ScoreboardKills),
    mod.Message(mod.stringkeys.ScoreboardDeaths),
    mod.Message(mod.stringkeys.ScoreboardAssists),
    mod.Message(mod.stringkeys.ScoreboardCaptures)
  );
  SetUITime();
  SetUIScores();
  liveInitializationActive = false;
  liveInitializationStage = 0;
  liveInitializationPlayerIds = [];
  initialization[3] = true;
  try {
    scheduleCipherLiveStartKeySpawn(1, "half1", "InitializeLive");
  } catch (bombErr) {
    LogRuntimeError("InitializeLive/bombSchedule", bombErr);
  }
}

function InitializeLive(): void {
  try {
    if (!liveInitializationActive) {
      liveInitializationActive = true;
      liveInitializationStage = 0;
      liveInitializationPlayerIds = [];
      liveInitializationPlayerCursor = 0;
      liveInitializationObjectiveCursor = 0;
    }
    processLiveInitializationStep();
  } catch (err) {
    LogRuntimeError("InitializeLive/stage" + String(liveInitializationStage), err);
    liveInitializationActive = false;
    liveInitializationStage = 0;
    initialization[3] = false;
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
  void p;
  void statKind;
  return true;
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

function buildPostmatchShowcaseSlots(): PostmatchShowcaseSlot[] {
  const winner = getWinningTeam();
  if (mod.Equals(winner, teamNeutral)) return [];

  const candidates: Player[] = [];
  serverPlayers.forEach((p) => {
    if (!p || !mod.IsPlayerValid(p.player)) return;
    if (!mod.Equals(mod.GetTeam(p.player), winner)) return;

    // Runtime bots are kept through postmatch now, so winning-team bots with stats can appear on showcase pedestals.
    candidates.push(p);
  });

  const usedPlayerIds: { [playerId: number]: boolean } = {};
  const slots: PostmatchShowcaseSlot[] = [];
  for (let i = 0; i < POSTMATCH_SHOWCASE_SLOT_CONFIGS.length; i++) {
    const config = POSTMATCH_SHOWCASE_SLOT_CONFIGS[i];
    const player = selectPostmatchShowcasePlayer(candidates, usedPlayerIds, config.statKind);
    if (!player) break;
    slots.push({
      anchorId: config.anchorId,
      statKind: config.statKind,
      player,
      statValue: getPostmatchShowcaseStatValue(player, config.statKind),
    });
  }
  return slots;
}

const POSTMATCH_LOSING_TEAM_RESTRICTED_INPUTS: mod.RestrictedInputs[] = [
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

function isPostmatchWinnerTeam(team: mod.Team): boolean {
  const winner = getWinningTeam();
  if (!mod.Equals(winner, team1) && !mod.Equals(winner, team2)) return false;
  return mod.Equals(team, winner);
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
  setPostmatchRestrictedInputsForPlayer(
    player,
    [
      mod.RestrictedInputs.MoveForwardBack,
      mod.RestrictedInputs.MoveLeftRight,
    ],
    true
  );
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
    setPostmatchRestrictedInputsForPlayer(player, POSTMATCH_LOSING_TEAM_RESTRICTED_INPUTS, false);
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

const POSTMATCH_SHOWCASE_SPAWN_SETTLE_MS = 100;

function schedulePostmatchCameraForPlayerAfterSettle(player: mod.Player, context: string): void {
  const playerId = modlib.getPlayerId(player);
  const sessionToken = ensurePlayerSessionToken(playerId);
  const expectedMatchStage = cipherMatchStage;
  scheduleCipherGlobalTask(POSTMATCH_SHOWCASE_SPAWN_SETTLE_MS / 1000, "postmatch_camera/" + context, () => {
    if (!isQueuedPlayerWorkCurrent(playerId, sessionToken, 4, expectedMatchStage)) return;
    const latest = getValidHumanPlayerById(playerId);
    if (!latest) return;
    try {
      applyPostmatchInputStateForPlayer(latest.player);
      setPostmatchShowcaseCameraForPlayer(latest.player, true);
    } catch (err) {
      LogRuntimeError("PostmatchCameraSettle/" + context + "/" + String(playerId), err);
    }
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

  try {
    mod.SetRedeployTime(p.player, 0);
    tryDeployPlayerSafe(p.player, "postmatch_showcase");
  } catch (_errSpawn) {}

  return isPlayerAliveSafe(p.player);
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
    // Teleport directly to the showcase anchor, then reassert once more because fixed camera
    // and postmatch spawn settling can nudge the soldier on the first frame.
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

function clearPostmatchShowcaseState(): void {
  const hadRuntimePresentation =
    postmatchPipelineStage !== "idle" ||
    postmatchShowcaseSlots.length > 0 ||
    postMatchWidgetsToDelete.length > 0;
  postmatchPipelineToken += 1;
  postmatchPipelineStage = "idle";
  postmatchPipelinePlayerIds = [];
  postmatchPipelineCursor = 0;
  postmatchPipelineRetryByPlayerId = {};
  postmatchPipelineTeleportRetryByPlayerId = {};
  postmatchPlayerJobs = [];
  postmatchPlayerJobCursor = 0;
  postmatchCardUiBuildCursor = 0;
  postmatchRevealSfxPlayerIds = [];
  postmatchShowcaseSlots = [];
  postmatchEndTick = 0;

  if (!hadRuntimePresentation) return;
  deletePostMatchReportUI();

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

  const widget = mod.FindUIWidgetWithName(name);
  if (widget) mod.SetUIWidgetDepth(widget, mod.UIDepth.AboveGameUI);

  postMatchWidgetsToDelete.push(name);
}

function setPostMatchText(name: string, label: any): void {
  const w = mod.FindUIWidgetWithName(name);
  if (w) mod.SetUITextLabel(w, label);
}

function setPostMatchTextAlpha(name: string, alpha: number): void {
  const widget = mod.FindUIWidgetWithName(name);
  if (widget) mod.SetUITextAlpha(widget, clampNumber(alpha, 0, 1));
}

function setPostMatchContainerAlpha(name: string, alpha: number): void {
  const widget = mod.FindUIWidgetWithName(name);
  if (widget) mod.SetUIWidgetBgAlpha(widget, clampNumber(alpha, 0, 1));
}

function setPostmatchScoreRevealAlpha(alpha: number): void {
  for (let teamId = 1; teamId <= 2; teamId++) {
    const suffix = String(teamId);
    setPostMatchTextAlpha("PM_Result_" + suffix, alpha);
    setPostMatchTextAlpha("PM_FriendlyScore_" + suffix, alpha);
    setPostMatchTextAlpha("PM_ScoreSeparator_" + suffix, alpha);
    setPostMatchTextAlpha("PM_EnemyScore_" + suffix, alpha);
  }
}

function setPostmatchCardRevealAlpha(slotIndex: number, alpha: number): void {
  const progress = clampNumber(alpha, 0, 1);
  for (let teamId = 1; teamId <= 2; teamId++) {
    const suffix = "_" + String(teamId) + "_" + String(slotIndex + 1);
    setPostMatchContainerAlpha("PM_PlayerContainer" + suffix, 0.5 * progress);
    setPostMatchContainerAlpha("PM_PlayerOutline" + suffix, 0.85 * progress);
    setPostMatchTextAlpha("PM_PlayerText" + suffix, progress);
    setPostMatchContainerAlpha("PM_StatContainer" + suffix, 0.5 * progress);
    setPostMatchContainerAlpha("PM_StatOutline" + suffix, 0.85 * progress);
    setPostMatchTextAlpha("PM_StatText" + suffix, progress);
  }
}

function addPostMatchContainer(
  name: string,
  posX: number,
  posY: number,
  color: mod.Vector,
  alpha: number,
  fill: mod.UIBgFill,
  receiver: mod.Team
): void {
  const parent = mod.FindUIWidgetWithName("PostMatchContainer");
  if (!parent) return;
  mod.AddUIContainer(
    name,
    mod.CreateVector(posX, posY, 0),
    mod.CreateVector(POSTMATCH_SHOWCASE_CARD_WIDTH, POSTMATCH_SHOWCASE_CARD_HEIGHT, 0),
    mod.UIAnchor.Center,
    parent,
    true,
    0,
    color,
    alpha,
    fill,
    receiver
  );
  const widget = mod.FindUIWidgetWithName(name);
  if (widget) mod.SetUIWidgetDepth(widget, mod.UIDepth.AboveGameUI);
  postMatchWidgetsToDelete.push(name);
}

function getPostmatchShowcaseColorForReceiver(receiver: mod.Team): mod.Vector {
  const winner = getWinningTeam();
  if (mod.Equals(winner, teamNeutral)) return COLOR_NEUTRAL;
  return mod.Equals(receiver, winner) ? COLOR_FRIENDLY : COLOR_ENEMY;
}

function buildPostmatchShowcaseScreenUi(): boolean {
  const receivers = [team1, team2];
  const textColor = mod.CreateVector(1, 1, 1);
  const slotCount = Math.min(postmatchShowcaseSlots.length, 4);
  const itemCount = receivers.length * slotCount;
  if (postmatchCardUiBuildCursor >= itemCount || slotCount <= 0) return true;
  const receiverIndex = Math.floor(postmatchCardUiBuildCursor / slotCount);
  const slotIndex = postmatchCardUiBuildCursor % slotCount;
  postmatchCardUiBuildCursor += 1;
  const receiver = receivers[receiverIndex];
    const teamSuffix = String(modlib.getTeamId(receiver));
    const color = getPostmatchShowcaseColorForReceiver(receiver);
      const slot = postmatchShowcaseSlots[slotIndex];
      if (!slot) return postmatchCardUiBuildCursor >= itemCount;
      const x = POSTMATCH_SHOWCASE_SCREEN_X[slotIndex];
      const suffix = "_" + teamSuffix + "_" + String(slotIndex + 1);
      const playerContainer = "PM_PlayerContainer" + suffix;
      const playerOutline = "PM_PlayerOutline" + suffix;
      const playerText = "PM_PlayerText" + suffix;
      const statContainer = "PM_StatContainer" + suffix;
      const statOutline = "PM_StatOutline" + suffix;
      const statText = "PM_StatText" + suffix;

      addPostMatchContainer(playerContainer, x, POSTMATCH_SHOWCASE_PLAYER_Y, color, 0, mod.UIBgFill.Blur, receiver);
      addPostMatchContainer(playerOutline, x, POSTMATCH_SHOWCASE_PLAYER_Y, color, 0, mod.UIBgFill.OutlineThick, receiver);
      addPostMatchText(playerText, x, POSTMATCH_SHOWCASE_PLAYER_Y, POSTMATCH_SHOWCASE_CARD_WIDTH, 42, 20, textColor, 0, receiver, mod.UIAnchor.Center);
      setPostMatchText(playerText, mod.Message(mod.stringkeys.PostMatchPlayerName, slot.player.player));

      addPostMatchContainer(statContainer, x, POSTMATCH_SHOWCASE_STAT_Y, color, 0, mod.UIBgFill.Blur, receiver);
      addPostMatchContainer(statOutline, x, POSTMATCH_SHOWCASE_STAT_Y, color, 0, mod.UIBgFill.OutlineThick, receiver);
      addPostMatchText(statText, x, POSTMATCH_SHOWCASE_STAT_Y, POSTMATCH_SHOWCASE_CARD_WIDTH, 42, 20, textColor, 0, receiver, mod.UIAnchor.Center);
      setPostMatchText(
        statText,
        mod.Message(getPostmatchShowcaseStatLabelKey(slot.statKind), mod.Ceiling(slot.statValue))
      );
  return postmatchCardUiBuildCursor >= itemCount;
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
      0,
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
      52,
      COLOR_FRIENDLY,
      0,
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
      0,
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
      52,
      COLOR_ENEMY,
      0,
      receiver,
      mod.UIAnchor.Center
    );
        setPostMatchText(
      "PM_EnemyScore_" + teamSuffix,
      mod.Message((mod.stringkeys as any).PostMatchScoreValue, mod.Ceiling(enemyScore))
    );

    addPostMatchText(
      "PM_EndTimer_" + teamSuffix,
      0,
      POSTMATCH_END_TIMER_TEXT_Y,
      POSTMATCH_END_TIMER_TEXT_WIDTH,
      POSTMATCH_END_TIMER_TEXT_HEIGHT,
      POSTMATCH_END_TIMER_TEXT_SIZE,
      COLOR_NEUTRAL,
      0,
      receiver,
      mod.UIAnchor.Center
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

function updatePostmatchEndTimerUi(secondsRemaining: number): void {
  const safeSeconds = mod.Max(0, mod.Ceiling(secondsRemaining));
  const label = mod.Message((mod.stringkeys as any).PostMatchEndsIn, safeSeconds);
  setPostMatchText("PM_EndTimer_1", label);
  setPostMatchText("PM_EndTimer_2", label);
}

function InitializePostmatch(): void {
  try {
    phaseTickCount = 0;
    postmatchEndStep = 0;
    postmatchEndStepTick = 0;
    postmatchEndStepAtSec = 0;
    clearPhaseCountdownDeadline();
    resetEngineSchedulerCadenceState();
    if (serverScores[0] < 0) serverScores[0] = 0;
    if (serverScores[1] < 0) serverScores[1] = 0;
    if (postmatchPipelineStage === "idle") startPostmatchPipeline();
    initialization[4] = true;
  } catch (err) {
    LogRuntimeError("InitializePostmatch", err);
    initialization[4] = false;
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
  void nowSec;
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

function isCipherTransitionClockActive(): boolean {
  return (
    cipherLiveTransitionSupervisorKind !== "none" ||
    cipherSecondHalfTransitionActive ||
    cipherSuddenDeathTransitionActive ||
    cipherSecondHalfTransitionStage !== "none"
  );
}

function getCurrentSchedulerNowSeconds(): number {
  if (currentFrameHasEngineNowSec && shouldUseEngineScheduler(currentFrameNowSec)) return currentFrameNowSec;
  const engineNow = tryGetEngineMatchTimeElapsedSeconds();
  if (shouldUseEngineScheduler(engineNow)) return engineNow;
  return serverTickCount / TICK_RATE;
}

function shouldUseEngineScheduler(nowSec: number | undefined): nowSec is number {
  if (gameStatus === 4) return false;
  if (isCipherTransitionClockActive()) return false;
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
  resetVisualSubtickClockState();
  resetCarrierIconVisualFollowState();
}

function setPhaseCountdownDeadlineFromNow(durationSeconds: number): void {
  const nowSec = getCurrentSchedulerNowSeconds();
  phaseCountdownDeadlineAtSec = nowSec + durationSeconds;
  phaseCountdownLastShownSeconds = clampCountdownDisplaySeconds(durationSeconds);
}

function clearPhaseCountdownDeadline(): void {
  phaseCountdownDeadlineAtSec = 0;
  phaseCountdownLastShownSeconds = -1;
}

function clampCountdownDisplaySeconds(rawSeconds: number): number {
  if (!Number.isFinite(rawSeconds) || rawSeconds <= 0.0001) return 0;
  return mod.Max(0, mod.Ceiling(rawSeconds));
}

function emitPerfTelemetryLog(message: any): void {
  void message;
}

function updatePerfTelemetryFrame(nowSec: number): void {
  void nowSec;
}

function trackBombPickupScanCandidates(sampleCount: number): void {
  void sampleCount;
}

function warnTransitionRecoveryOnce(key: string, message: any): void {
  void key;
  void message;
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


function forceEnablePrematchDeploymentForKnownPlayers(
  source: string,
  extraHandles: mod.Player[] = []
): void {
  if (gameStatus !== -1 && gameStatus !== 0) return;

  // Manual ready-up spawning requires both the deploy spawn mode and the global
  // deploy gate. Per-player EnablePlayerDeploy(true) cannot override a global
  // gate that was left disabled by an earlier lifecycle phase.
  try {
    mod.SetSpawnMode(mod.SpawnModes.Deploy);
  } catch (err) {
    LogRuntimeError("PrematchDeploy/SetSpawnMode/" + source, err);
  }
  try {
    mod.EnableAllPlayerDeploy(true);
  } catch (err) {
    LogRuntimeError("PrematchDeploy/EnableAll/" + source, err);
  }

  const unlockedByPlayerId: { [playerId: number]: boolean | undefined } = {};
  const unlock = (player: mod.Player | undefined): void => {
    if (!player) return;
    const playerId = tryGetSafeEventPlayerIdOnly(player);
    if (playerId === undefined || unlockedByPlayerId[playerId] === true) return;
    unlockedByPlayerId[playerId] = true;
    try {
      mod.SetRedeployTime(player, 0);
    } catch (_errRedeploy) {}
    try {
      mod.EnablePlayerDeploy(player, true);
    } catch (err) {
      LogRuntimeError("PrematchDeploy/EnablePlayer/" + source + "/" + String(playerId), err);
    }
  };

  for (let i = 0; i < extraHandles.length; i++) unlock(extraHandles[i]);
  for (const key in pendingPlayerSessionById) unlock(pendingPlayerSessionById[Number(key)]?.player);
  serverPlayers.forEach((p) => unlock(p.player));
}

function collectConnectedHumanPlayerHandlesForGameModeStart(): mod.Player[] {
  const handlesByPlayerId: { [playerId: number]: mod.Player | undefined } = {};

  const rememberHandle = (player: mod.Player | undefined): void => {
    if (!player) return;
    const playerId = tryGetSafeEventPlayerIdOnly(player);
    if (playerId === undefined) return;
    try {
      if (isBotBackfillPlayerSafe(player) || isCipherRuntimeBotPlayerId(playerId)) return;
    } catch (_errBotCheck) {}
    handlesByPlayerId[playerId] = player;
  };

  // Preserve handles delivered before OnGameModeStarted. The startup reset below
  // intentionally clears these lifecycle tables, so collect them first.
  for (const key in pendingPlayerSessionById) {
    rememberHandle(pendingPlayerSessionById[Number(key)]?.player);
  }
  serverPlayers.forEach((player) => rememberHandle(player.player));

  // Also reconcile against the authoritative engine list in case the join event
  // was delivered before this script's callback table was fully active.
  try {
    const allPlayers = mod.AllPlayers();
    const playerCount = mod.CountOf(allPlayers);
    for (let i = 0; i < playerCount; i++) {
      rememberHandle(mod.ValueInArray(allPlayers, i) as mod.Player);
    }
  } catch (err) {
    LogRuntimeError("GameModeStart/CollectConnectedPlayers", err);
  }

  const handles: mod.Player[] = [];
  for (const key in handlesByPlayerId) {
    const handle = handlesByPlayerId[Number(key)];
    if (handle) handles.push(handle);
  }
  return handles;
}

function bootstrapConnectedHumanPlayerForGameModeStart(eventPlayer: mod.Player): void {
    const nowMs = Date.now();
    const playerId = tryGetSafeEventPlayerIdOnly(eventPlayer);
    if (playerId === undefined) return;

    const identity = tryGetSafeEventPlayerIdentity(eventPlayer);
    if (identity?.isBot === true || isCipherRuntimeBotPlayerId(playerId)) return;

    const sessionToken = beginPlayerSessionForJoin(playerId);
    const stableTeamId = identity && (identity.teamId === 1 || identity.teamId === 2)
      ? identity.teamId
      : 0;
    const pending: PendingPlayerSession = {
      playerId,
      nativeObjId: identity?.nativeObjId ?? playerId,
      player: eventPlayer,
      sessionToken,
      // This is not a new network join; it is recovery of a player already present
      // when OnGameModeStarted reset the runtime. Do not add another two-second delay.
      joinedAtMs: nowMs - PLAYER_JOIN_STABILIZE_MS,
      stableTeamId,
      stableSamples: stableTeamId > 0 ? PLAYER_JOIN_REQUIRED_STABLE_SAMPLES : 0,
      nextRetryAtMs: 0,
      isReconnect: false,
      deployAckSeen: false,
      watchdogLogged: false,
    };
    pendingPlayerSessionById[playerId] = pending;
    emitPlayerLifecycleDiagnostic(
      "JOIN_PENDING logicalId=" + String(playerId) + " session=" + String(sessionToken)
    );

    if (stableTeamId > 0) {
      try {
        activatePendingPlayerSession(pending);
        return;
      } catch (err) {
        LogRuntimeError("GameModeStart/ActivateConnectedPlayer/" + String(playerId), err);
      }
    }

    // Never strand the initial host on "Deployment unavailable" while waiting
    // for the team handle to stabilize. A deploy acknowledgement updates the
    // pending handle and the normal supervisor completes activation safely.
    try {
      mod.EnablePlayerDeploy(eventPlayer, true);
    } catch (err) {
      LogRuntimeError("GameModeStart/UnlockConnectedPlayer/" + String(playerId), err);
    }
}

function bootstrapConnectedHumanPlayersForGameModeStart(startupHandles: mod.Player[]): void {
  for (let i = 0; i < startupHandles.length; i++) {
    bootstrapConnectedHumanPlayerForGameModeStart(startupHandles[i]);
  }
}

function getStartupSpawnAnchorIds(): number[] {
  return [
    ...CIPHER_FIRST_DEPLOY_NORTH_ANCHORS,
    ...CIPHER_FIRST_DEPLOY_SOUTH_ANCHORS,
    ...CIPHER_NORTH_EAST_NORTH_ANCHORS,
    ...CIPHER_NORTH_EAST_SOUTH_ANCHORS,
    ...CIPHER_NORTH_WEST_NORTH_ANCHORS,
    ...CIPHER_NORTH_WEST_SOUTH_ANCHORS,
    ...CIPHER_SOUTH_EAST_NORTH_ANCHORS,
    ...CIPHER_SOUTH_EAST_SOUTH_ANCHORS,
    ...CIPHER_SOUTH_WEST_NORTH_ANCHORS,
    ...CIPHER_SOUTH_WEST_SOUTH_ANCHORS,
  ];
}

function processStartupPipelineStep(): void {
  if (!startupPipelineActive || gameStatus !== 0) return;

  if (startupPipelineStage === 0) {
    if (startupPipelineAnchorCursor < startupPipelineAnchorIds.length) {
      getCachedCipherAnchorPosition(startupPipelineAnchorIds[startupPipelineAnchorCursor]);
      startupPipelineAnchorCursor += 1;
      return;
    }
    startupPipelineStage = 1;
    return;
  }

  if (startupPipelineStage === 1) {
    ValidateObjectiveConfiguration();
    resetObjectiveRuntimeState();
    resetObjectiveDisableAndAwardFxState();
    resetBombCarrierRuntimeState(true);
    ensureAudioSpawned();
    startupPipelineStage = 2;
    return;
  }

  if (startupPipelineStage === 2) {
    spawnTeamVoModulesForMatchStart();
    postmatchResultSfxPlayed = false;
    startupPipelineStage = 3;
    return;
  }

  if (startupPipelineStage === 3) {
    if (startupPipelinePlayerCursor < startupPipelinePlayerHandles.length) {
      bootstrapConnectedHumanPlayerForGameModeStart(
        startupPipelinePlayerHandles[startupPipelinePlayerCursor]
      );
      startupPipelinePlayerCursor += 1;
      return;
    }
    startupPipelinePreparedPlayerIds = getValidHumanPlayersSnapshot().map((p) => p.id);
    startupPipelinePreparedPlayerCursor = 0;
    startupPipelineStage = 4;
    return;
  }

  if (startupPipelineStage === 4) {
    if (startupPipelinePreparedPlayerCursor < startupPipelinePreparedPlayerIds.length) {
      const playerId = startupPipelinePreparedPlayerIds[startupPipelinePreparedPlayerCursor++];
      const player = getValidHumanPlayerById(playerId);
      if (player) {
        player.setTeam();
        setReadyPhaseProtectionForPlayer(player.player, true);
        applyPrematch889HealthForPlayer(playerId);
      }
      return;
    }
    startupPipelineStage = 5;
    return;
  }

  if (startupPipelineStage === 5) {
    forceEnablePrematchDeploymentForKnownPlayers(
      "OnGameModeStarted_after_bootstrap",
      startupPipelinePlayerHandles
    );
    startupPipelineStage = 6;
    return;
  }

  if (startupPipelineStage === 6) {
    BuildPrematchRosterUI();
    if (!prematchRosterBuilt) return;
    refreshPrematchReadyStateUi();
    startupPipelineStage = 7;
    return;
  }

  initialization[0] = true;
  startupPipelineActive = false;
  startupPipelinePlayerHandles = [];
  startupPipelineAnchorIds = [];
  startupPipelinePreparedPlayerIds = [];
  resetTransitionFallbackGuardIfPrematchReady();
}

function Mode_OnGameModeStarted(): void {
  const startupPlayerHandles = collectConnectedHumanPlayerHandlesForGameModeStart();
  resetLifecycleStateForFreshMatchStart();

  // Establish a functional, safe prematch before any deferred preparation.
  serverTickCount = 0;
  gameModeStarted = true;
  gameStatus = 0;
  SetDepthAboveGameUI("PreMatchContainer");
  SetDepthAboveGameUI(PREMATCH_PANEL_WIDGET_NAME);
  SetCountdownOverlayVisible(false);
  disableAllObjectiveCapturePointObjectives("OnGameModeStarted");
  disableAllObjectiveSurfaceSectors("OnGameModeStarted", true);
  disableAllObjectiveInteractPoints("OnGameModeStarted");
  syncDisabledBombAnchorObjectives();
  hideAllObjectiveArmedWorldIcons();
  ConfigurePreMatchSpawns();
  SafeSetWidgetVisibleByName("PreMatchContainer", true);
  SafeSetWidgetVisibleByName(PREMATCH_PANEL_WIDGET_NAME, true);
  setStaticPrematchPanelWidgetsVisible(true);
  mod.SetSpawnMode(mod.SpawnModes.Deploy);
  mod.EnableAllPlayerDeploy(true);

  SafeSetWorldIconTextById(WORLDICON_T1_SWITCH, mod.Message(mod.stringkeys.SwitchTeam));
  SafeSetWorldIconTextById(WORLDICON_T1_READY, mod.Message(mod.stringkeys.Ready));
  SafeSetWorldIconTextById(WORLDICON_T2_SWITCH, mod.Message(mod.stringkeys.SwitchTeam));
  SafeSetWorldIconTextById(WORLDICON_T2_READY, mod.Message(mod.stringkeys.Ready));
  for (let i = 0; i < 4; i++) SafeEnableWorldIconById(WORLDICON_T1_SWITCH + i, true, true);
  SafeEnableInteractPointById(IP_T1_SWITCH, true);
  SafeEnableInteractPointById(IP_T1_READY, true);
  SafeEnableInteractPointById(IP_T2_SWITCH, true);
  SafeEnableInteractPointById(IP_T2_READY, true);
  mod.SetScoreboardType(mod.ScoreboardType.CustomTwoTeams);
  mod.SetGameModeTimeLimit(60000);

  startupPipelineActive = true;
  startupPipelineStage = 0;
  startupPipelinePlayerCursor = 0;
  startupPipelinePlayerHandles = startupPlayerHandles;
  cipherAnchorPositionByObjectId = {};
  startupPipelineAnchorIds = getStartupSpawnAnchorIds();
  startupPipelineAnchorCursor = 0;
  startupPipelinePreparedPlayerIds = [];
  startupPipelinePreparedPlayerCursor = 0;
}
function Mode_OnGameModeEnding(): void {
  clearCipherAdminRuntimeState("Mode_OnGameModeEnding");
  cancelAllCipherRespawnRouteJobs();
  clearLiveHudQueues();
  clearCipherKeyUiRefreshQueue();
  clearPhasePlayerOperationQueues();
  resetUniversalPlayerLifecycleQueues(true);
  clearRuntimeBotState(true);
  stopAllObjectiveAwardBursts();
  hideAllObjectiveArmedWorldIcons();
  disableAllObjectiveSurfaceSectors("Mode_OnGameModeEnding", true);
  resetCipherNodeStates("Mode_OnGameModeEnding");
  resetBombCarrierRuntimeState(true);
  clearVoModuleState();
}

function Mode_OngoingGlobal(): void {
  if (!gameModeStarted) return;
  try {
    OngoingGlobal_Inner();
  } catch (err) {
    try {
      LogRuntimeError("OngoingGlobal", err);
    } catch (_errLog) {}
  }
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
  if (processCipherScheduledTasks(nowSec)) return;
  processPendingLiveInputUnlock();
  processPhaseUiCleanupStep();
  if (startupPipelineActive) {
    processStartupPipelineStep();
    return;
  }
  updatePerfTelemetryFrame(nowSec);
  processPlayerLifecycleSupervisor();
  processPlayerLifecycleDeferredFanout();
  tickCipherAdminInteractFallback(nowSec);
  processPhasePlayerOperationQueue();

  if (gameStatus === 0) {
    if (!initialization[0]) InitializePreMatch();
    if (prematchRosterUpdateActive || prematchRosterUpdateDirty) UpdatePrematchRosterUI();
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
        // Existing ready-up delay ends here; pre-live init will queue bounded undeploys.
        gameStatus = 2;
      }
    }
  } else if (gameStatus === 2) {
    if (!initialization[2]) {
      InitializePreLive();
      if (!initialization[2] && preliveInitializationStage === 0) {
        forceReturnToPrematchFromTransitionFailure("InitializePreLive");
      }
      return;
    }

    flushPreliveTransitionSpawnRequestsAfterUndeploy();
    processTransitionSpawnQueue("prelive_countdown");
    processCipherSpawnJobs("prelive_countdown");
    tickRuntimeBotStagedSpawning(nowSec, "prelive_countdown");
    applyCipherTransitionInputLocksForPlayers("prelive_countdown_lock");
    applyRuntimeBotPhaseLocksForAll("prelive_countdown_bot_lock");

    if (phaseCountdownDeadlineAtSec <= 0) setPhaseCountdownDeadlineFromNow(countDown);
    const displaySeconds = clampCountdownDisplaySeconds(phaseCountdownDeadlineAtSec - nowSec);
    if (displaySeconds !== phaseCountdownLastShownSeconds || displaySeconds <= 0) {
      const displayChanged = displaySeconds !== phaseCountdownLastShownSeconds;
      phaseCountdownLastShownSeconds = displaySeconds;
      countDown = displaySeconds;
      if (displayChanged) {
        const vol = countDown <= 3 ? 0.85 : 0.6;
        playCountdownHeartbeatToAll(vol);
      }

      if (displayChanged) SafeSetTextLabelByName("CountDownText", mod.Message(countDown));
      if (countDown === 0 && !preliveZeroTransitionHandled) {
        if (!areReadyTransitionHumansTerminal()) {
          if (!readyTransitionWaitingShown) {
            readyTransitionWaitingShown = true;
            SafeSetTextLabelByName("MatchStartsText", mod.Message("WAITING FOR PLAYERS"));
          }
          return;
        }
        preliveZeroTransitionHandled = true;
        emitLiveTransitionCheckpoint("prelive_zero_enter");
        playMatchStartStingerToAll(1.0);
        emitLiveTransitionCheckpoint("prelive_zero_stinger_after");
        if (!hasShownMatchStartBanner) {
          emitLiveTransitionCheckpoint("prelive_zero_banner_start");
          void showMatchStartBannerOnce();
          emitLiveTransitionCheckpoint("prelive_zero_banner_after");
        }
        emitLiveTransitionCheckpoint("prelive_zero_set_live_before");
        endCipherFirstDeployAnchorSession("prelive_zero_live");
        gameStatus = 3;
        emitLiveTransitionCheckpoint("prelive_zero_set_live_after");
      }
    }
  } else if (gameStatus === 3) {
    if (!initialization[3]) {
      InitializeLive();
      if (!initialization[3] && !liveInitializationActive) {
        forceReturnToPrematchFromTransitionFailure("InitializeLive");
      }
      return;
    }

    if (processLiveHudQueues()) return;
    processCipherKeyUiRefreshQueue();
    runCipherLiveKeyWatchdog(nowSec, "live_tick");
    runQueuedCipherTransitionReconcile(nowSec);

    if (cipherSecondHalfTransitionActive || cipherSuddenDeathTransitionActive) {
      tickCipherLiveTransitionSupervisor(nowSec);
      return;
    }

    processCipherSpawnJobs("live_scheduler");

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
    evaluateCipherNodeRebootDeadlines(nowSec);
    EvaluatePostCaptureAwardTimers();
    if (gameStatus !== 3) {
      HideAllObjectiveHoldProgressUi();
      return;
    }
    UpdateObjectiveHoldProgressUiForAllPlayers(visualNowSec);
    UpdateDeployObjectiveTimerUiForAllPlayers();

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
      updateCipherNativeMinimapBombForCarrier(iconLaneNowSec, "icon_lane");
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
      EvaluateBombPickupAndCarrierState();
      ensureDroppedBombRuntimeWorldIconVisibleIfNeeded();
      ensureBaseBombRuntimeWorldIconVisibleIfNeeded();

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
      SetUIScores();
      UpdateScoreboard();
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
    // The postmatch state machine advances at most one setup/player/reveal substep per tick.
    processPostmatchPipeline();
    if (postmatchPipelineStage !== "complete") return;
    if (postmatchEndStep !== 0) {
      return;
    }

    if (postmatchEndTick <= 0) postmatchEndTick = serverTickCount + countDown * TICK_RATE;
    const remainingTicks = mod.Max(0, postmatchEndTick - serverTickCount);
    const displaySeconds = mod.Max(0, mod.Ceiling(remainingTicks / TICK_RATE));
    const postmatchSecondDue = displaySeconds !== countDown;
    if (postmatchSecondDue) {
      countDown = displaySeconds;
      updatePostmatchEndTimerUi(countDown);
    }

    if (postmatchSecondDue && countDown === 0) {
      safeEndGameModeWithPostmatchWinner("postmatch_countdown");
      return;
    }
  }


  if (serverTickCount === 10000000) serverTickCount = 137;
}

/* =================================================================================================
   14) PLAYER EVENTS (JOIN / LEAVE / DEPLOY / UNDEPLOY / INTERACT)
================================================================================================= */

function findServerPlayerByObjId(playerObjId: number): Player | undefined {
  for (const entry of serverPlayers.entries()) {
    const sp = entry[1];
    if (sp && sp.nativeObjId === playerObjId) return sp;
  }
  return undefined;
}

function findPendingPlayerSessionByObjId(playerObjId: number): PendingPlayerSession | undefined {
  for (const key in pendingPlayerSessionById) {
    const pending = pendingPlayerSessionById[Number(key)];
    if (pending && pending.nativeObjId === playerObjId) return pending;
  }
  return undefined;
}

function Mode_OnPlayerJoinGame(eventPlayer: mod.Player): void {
  try {
    const identity = tryGetSafeEventPlayerIdentity(eventPlayer);
    if (!identity) return;
    const joiningId = identity.playerId;
    const joiningObjId = identity.nativeObjId;
    emitPlayerLifecycleDiagnostic(
      "JOIN_EVENT objId=" + String(joiningObjId) + " logicalId=" + String(joiningId)
    );

    const pending = pendingPlayerSessionById[joiningId];
    if (pending && isCurrentPlayerSession(joiningId, pending.sessionToken)) {
      if (pending.nativeObjId === joiningObjId) {
        pending.player = eventPlayer;
        return;
      }
      emitPlayerLifecycleDiagnostic(
        "JOIN_REPLACED_STALE_HANDLE logicalId=" + String(joiningId) +
          " oldObjId=" + String(pending.nativeObjId) + " newObjId=" + String(joiningObjId)
      );
      invalidatePlayerSessionForDisconnect(joiningId);
      delete pendingPlayerSessionById[joiningId];
      clearDisconnectedPlayerStateDataOnly(joiningId);
    }

    const active = serverPlayers.get(joiningId);
    if (
      active &&
      playerActivatedSessionTokenByPlayerId[joiningId] === playerSessionTokenByPlayerId[joiningId] &&
      playerDisconnectedAtTickByPlayerId[joiningId] === undefined &&
      active.nativeObjId === joiningObjId
    ) return;

    if (active) {
      const oldSessionToken = playerSessionTokenByPlayerId[joiningId];
      const oldObjId = active.nativeObjId;
      const cachedPosition = lastKnownLivePositionByPlayerId[joiningId];
      const cachedTeam = active.team;
      const wasCarrier = gameStatus === 3 && bombCarrierPlayerId === joiningId;
      rememberDisconnectedPlayerSnapshot(active);
      emitPlayerLifecycleDiagnostic(
        "JOIN_REPLACED_STALE_HANDLE logicalId=" + String(joiningId) +
          " oldObjId=" + String(oldObjId) + " newObjId=" + String(joiningObjId)
      );
      invalidatePlayerSessionForDisconnect(joiningId);
      delete playerActivatedSessionTokenByPlayerId[joiningId];
      serverPlayers.delete(joiningId);
      clearDisconnectedPlayerStateDataOnly(joiningId, active);
      playerLeaveCleanupQueue.push({
        playerId: joiningId,
        sessionToken: oldSessionToken,
        wasCarrier,
        cachedPosition,
        cachedTeam,
      });
    }

    const sessionToken = beginPlayerSessionForJoin(joiningId);
    delete playerActivatedSessionTokenByPlayerId[joiningId];
    serverPlayers.delete(joiningId);
    pendingPlayerSessionById[joiningId] = {
      playerId: joiningId,
      nativeObjId: joiningObjId,
      player: eventPlayer,
      sessionToken,
      joinedAtMs: Date.now(),
      stableTeamId: 0,
      stableSamples: 0,
      nextRetryAtMs: 0,
      isReconnect: disconnectedPlayerSnapshotById[joiningId] !== undefined,
      deployAckSeen: false,
      watchdogLogged: false,
    };
    emitPlayerLifecycleDiagnostic(
      "JOIN_PENDING logicalId=" + String(joiningId) + " session=" + String(sessionToken)
    );
    const keepPrematchDeployAvailable = !gameModeStarted || gameStatus === -1 || gameStatus === 0;
    try {
      // Midmatch joins remain quarantined until their handle/team is stable.
      // Prematch joins are unlocked globally and per player so the host can use
      // the authored ready-up HQ immediately.
      mod.EnablePlayerDeploy(eventPlayer, keepPrematchDeployAvailable);
    } catch (_errDeployLock) {}

    if (keepPrematchDeployAvailable) {
      const prematchPending = pendingPlayerSessionById[joiningId];
      if (
        prematchPending &&
        (identity.teamId === 1 || identity.teamId === 2) &&
        isCurrentPlayerSession(joiningId, prematchPending.sessionToken)
      ) {
        prematchPending.stableTeamId = identity.teamId;
        prematchPending.stableSamples = 1;
        prematchPending.joinedAtMs = Date.now() - PLAYER_JOIN_STABILIZE_MS;
        try {
          activatePendingPlayerSession(prematchPending);
        } catch (err) {
          LogRuntimeError("OnPlayerJoinGame/PrematchActivate/" + String(joiningId), err);
        }
      }
    }
  } catch (err) {
    LogRuntimeError("OnPlayerJoinGame", err);
  }
}

function Mode_OnPlayerLeaveGame(eventNumber: number): void {
  try {
    emitPlayerLifecycleDiagnostic("LEAVE_EVENT eventId=" + String(eventNumber));
    const leaving = findServerPlayerByObjId(eventNumber) ?? serverPlayers.get(eventNumber);
    const pending =
      findPendingPlayerSessionByObjId(eventNumber) ?? pendingPlayerSessionById[eventNumber];
    if (!pending && !leaving) {
      emitPlayerLifecycleDiagnostic("LEAVE_UNRESOLVED eventId=" + String(eventNumber));
      return;
    }
    const playerId = leaving?.id ?? pending?.playerId;
    if (playerId === undefined) {
      emitPlayerLifecycleDiagnostic("LEAVE_UNRESOLVED eventId=" + String(eventNumber));
      return;
    }
    const nativeObjId = leaving?.nativeObjId ?? pending?.nativeObjId ?? eventNumber;
    const sessionToken = pending?.sessionToken ?? playerSessionTokenByPlayerId[playerId];
    emitPlayerLifecycleDiagnostic(
      "LEAVE_RESOLVED logicalId=" + String(playerId) + " objId=" + String(nativeObjId)
    );

    if (leaving) {
      if (gameStatus === 3) leaving.addDeath();
      rememberDisconnectedPlayerSnapshot(leaving);
    }
    const cachedTeam = leaving?.team ?? teamNeutral;
    const cachedPosition = lastKnownLivePositionByPlayerId[playerId];
    const wasCarrier = gameStatus === 3 && bombCarrierPlayerId === playerId;
    invalidatePlayerSessionForDisconnect(playerId);
    delete pendingPlayerSessionById[playerId];
    delete playerActivatedSessionTokenByPlayerId[playerId];
    serverPlayers.delete(playerId);
    clearDisconnectedPlayerStateDataOnly(playerId, leaving);
    if (pending) {
      emitPlayerLifecycleDiagnostic("LEAVE_PENDING_REMOVED logicalId=" + String(playerId));
    }
    if (leaving) {
      emitPlayerLifecycleDiagnostic(
        "LEAVE_ACTIVE_REMOVED logicalId=" + String(playerId) + " session=" + String(sessionToken)
      );
    }
    playerLeaveCleanupQueue.push({ playerId, sessionToken, wasCarrier, cachedPosition, cachedTeam });
  } catch (err) {
    LogRuntimeError("OnPlayerLeaveGame", err);
  }
}

async function Mode_OnPlayerDeployed(eventPlayer: mod.Player): Promise<void> {
  try {
    if (!mod.IsPlayerValid(eventPlayer)) return;
    const playerId = modlib.getPlayerId(eventPlayer);
    const pending = pendingPlayerSessionById[playerId];
    if (pending && isCurrentPlayerSession(playerId, pending.sessionToken)) {
      pending.player = eventPlayer;
      pending.deployAckSeen = true;
      return;
    }
    const p = serverPlayers.get(playerId);
    if (!p) return;
    const team = mod.GetTeam(eventPlayer);
    if (!mod.Equals(team, team1) && !mod.Equals(team, team2)) return;

    p.player = eventPlayer;
    p.nativeObjId = mod.GetObjId(eventPlayer);
    p.team = team;
    p.isDeployed = true;

    // Enable Night Mode for this player whenever they deploy.
    // mod.EnableScreenEffect(eventPlayer, mod.ScreenEffects.Night, true);

    clearScoreboardDeathCountForPlayerLife(playerId);
    delete playerInMandownByPlayerId[playerId];
    cancelPendingRestrictedLethalConfirmForPlayer(playerId);
    clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);
    hideDeployObjectiveTimerUiForPlayer(playerId);
    clearTransitionSpawnStateForPlayer(playerId);
    clearAllObjectiveAreaTriggerStateForPlayer(playerId);
    clearCipherPresenceForPlayer(playerId);
    cancelObjectiveCaptureAttemptsForPlayer(playerId);
    dmgSpreadClearForPlayer(eventPlayer);

    if (gameStatus === 0) {
      applyPrematch889HealthForPlayer(playerId);
      replacePrematchReadyText(playerId, eventPlayer);
      playerLifecyclePrematchRefreshPending = true;
      return;
    }
    if (gameStatus === 1) {
      applyPrematch889HealthForPlayer(playerId);
      stripLoadoutToMeleeOnly(eventPlayer);
      return;
    }
    if (gameStatus === 2) {
      applyPrematch889HealthForPlayer(playerId);
      if (getCipherQueuedSpawnAnchorForPlayer(playerId) === undefined) prepareCipherQueuedAnchorForPlayer(playerId);
      teleportCipherPlayerToRoutedAnchor(eventPlayer, playerId);
      return;
    }
    if (gameStatus === 4) {
      applyPostmatchInputStateForPlayer(eventPlayer);
      schedulePostmatchCameraForPlayerAfterSettle(eventPlayer, "OnPlayerDeployed_Postmatch");
      return;
    }
    if (gameStatus !== 3) return;

    if (isCipherLiveTransitionActive()) {
      if (cipherSecondHalfTransitionStage === "deploy") {
        if (isBotBackfillPlayerSafe(eventPlayer) || isCipherRuntimeBotPlayerId(playerId)) {
          clearCipherTransitionStateForPlayer(playerId, "OnPlayerDeployed_Transition_Bot");
        } else {
          const transitionToken = getCipherSecondHalfForceDeployToken();
          cipherSecondHalfDeployRequiredByPlayerId[playerId] = true;
          cipherTransitionDeploySeenByPlayerId[playerId] = true;
          cipherTransitionDeployAckTokenByPlayerId[playerId] = transitionToken;
        }
      }
      handleCipherTransitionDeployedPlayer(playerId, eventPlayer, "OnPlayerDeployed_Transition");
      requestCipherTransitionReconcile("OnPlayerDeployed_Transition");
      return;
    }
    if (isCipherSuddenDeathActive() && cipherSuddenDeathEliminatedByPlayerId[playerId] === true) {
      playerInMandownByPlayerId[playerId] = true;
      mod.SetRedeployTime(eventPlayer, 9999);
      mod.UndeployPlayer(eventPlayer);
      return;
    }

    // Known-good live respawn path: repair existing refs only. Never build,
    // delete, or recreate HUD widgets while the engine is completing deploy.
    repairCipherKeyHudCacheForPlayer(p, false);
    updateCipherSuddenDeathAliveHudForPlayer(p);
    applyPrematch889HealthForPlayer(playerId);
    recordLastLiveHqSpawnSourceFromDeploy(eventPlayer, playerId);
    applyPhaseInputRestrictionsForPlayer(eventPlayer);

    const enteringForcedSafeSpawnFlow = safeSpawnForcedUndeploy[playerId] === true;
    if (!enteringForcedSafeSpawnFlow) {
      bumpSafeSpawnGeneration(playerId);
      removeSafeSpawnCheckForPlayer(playerId);
    }
    if (!enteringForcedSafeSpawnFlow && isNativeFriendlyOrSquadSpawn(eventPlayer, playerId)) {
      mod.SetRedeployTime(eventPlayer, REDEPLOY_TIME);
      p.isFirstDeploy();
      finishSafeSpawnAsNativeFriendlyOrSquadSpawn(eventPlayer, playerId);
      return;
    }

    mod.SetRedeployTime(eventPlayer, REDEPLOY_TIME);
    finalizeCipherRespawnRouteJobForPlayer(playerId, "OnPlayerDeployed_Live");
    requestCipherSpawnAnchorForPlayer(playerId, true);
    processCipherSpawnJobs("OnPlayerDeployed_LiveAnchor");
    p.isFirstDeploy();
    queueSafeSpawnCheckForPlayer(playerId);
  } catch (err) {
    LogRuntimeError("OnPlayerDeployed", err);
  }
}


async function Mode_OnPlayerUndeploy(eventPlayer: mod.Player): Promise<void> {
  try {
  if (!mod.IsPlayerValid(eventPlayer)) return;
  const playerId = modlib.getPlayerId(eventPlayer);
  const pending = pendingPlayerSessionById[playerId];
  if (pending && isCurrentPlayerSession(playerId, pending.sessionToken)) {
    pending.player = eventPlayer;
    pending.deployAckSeen = false;
    return;
  }
  const p = serverPlayers.get(playerId);
  if (!p) return;
  p.player = eventPlayer;
  const wasDeployed = p.isDeployed === true;
  const isForcedSafeSpawnFlow = safeSpawnForcedUndeploy[playerId] === true;
  if (!isForcedSafeSpawnFlow) {
    bumpSafeSpawnGeneration(playerId);
    removeSafeSpawnCheckForPlayer(playerId);
    safeSpawnForcedQueue = safeSpawnForcedQueue.filter((item) => item.playerId !== playerId);
    delete safeSpawnForcedQueuedGenerationByPlayerId[playerId];
    invalidateCipherRespawnRouteJobForPlayer(playerId);
  }
  beginNextPlayerLife(playerId);
  const keepTransitionReady =
    cipherSecondHalfTransitionStage === "deploy" &&
    cipherSecondHalfDeployReadyByPlayerId[playerId] === true &&
    cipherTransitionDeployAckTokenByPlayerId[playerId] === getCipherSecondHalfForceDeployToken();
  p.isDeployed = keepTransitionReady;
  if (!keepTransitionReady) clearCipherSecondHalfDeployReadyForPlayer(playerId);

  closeCipherAdminPanelForPlayerId(playerId);
  dmgSpreadClearForPlayer(eventPlayer);
  prematchHealthInside889ByPlayerId[playerId] = false;
  delete prematchHealthAppliedMaxByPlayerId[playerId];
  invalidateBombDeployLoadoutApplyForPlayer(playerId);
  invalidateBombCarrierRestoreInsertForPlayer(playerId);
  resetRestrictedAreaStateForPlayer(playerId);
  clearAllObjectiveAreaTriggerStateForPlayer(playerId);
  clearCipherPresenceForPlayer(playerId);
  clearCipherSpawnJobsForPlayer(playerId);
  delete cipherQueuedAnchorByPlayerId[playerId];
  cancelObjectiveCaptureAttemptsForPlayer(playerId);

  if (isForcedSafeSpawnFlow) return;

  if (isCipherLiveTransitionActive()) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    if (cipherSecondHalfTransitionStage === "deploy") {
      setCipherSecondHalfDeployFreezeForPlayer(eventPlayer, keepTransitionReady, "transition_deploy_undeploy");
    } else {
      applyPhaseInputRestrictionsForPlayer(eventPlayer);
    }
    mod.SetRedeployTime(eventPlayer, 0);
    requestCipherTransitionReconcile("OnPlayerUndeploy_Transition");
    return;
  }

  const suddenDeathScriptForcedUndeploy =
    cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId] !== undefined;
  if (suddenDeathScriptForcedUndeploy && isCipherSuddenDeathActive()) {
    delete cipherSuddenDeathForcedUndeployTokenByPlayerId[playerId];
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    mod.SetRedeployTime(eventPlayer, 9999);
    return;
  }

  if (gameStatus === 3 && bombCarrierPlayerId === playerId) {
    const pos = tryGetPlayerPositionSafe(eventPlayer);
    if (pos) lastKnownLivePositionByPlayerId[playerId] = pos;
    scheduleBombCarrierDropAfterCombatEvent(playerId, "undeploy", pos);
  }

  if (
    isCipherSuddenDeathActive() &&
    !isCipherLiveStartSettling() &&
    wasDeployed &&
    !isPlayerAliveSafe(eventPlayer) &&
    getCurrentSchedulerNowSeconds() >= cipherSuddenDeathUndeployIgnoreUntilSec
  ) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    consumeCipherSuddenDeathLife(playerId, "undeploy");
    return;
  }

  if (gameStatus === 1 || gameStatus === 2) {
    invalidateCipherRespawnRouteJobForPlayer(playerId);
    applyPhaseInputRestrictionsForPlayer(eventPlayer);
    mod.SetRedeployTime(eventPlayer, 0);
    requestTransitionSpawn(playerId, "OnPlayerUndeploy_Transition");
    return;
  }

  if (gameStatus === 3 && getCurrentSchedulerNowSeconds() >= cipherPhaseTransitionUndeployIgnoreUntilSec) {
    startCipherRespawnRouteJobForPlayer(playerId, wasDeployed, "OnPlayerUndeploy_Live");
    // Match the known-good script: mutate stored stats only. Engine-facing
    // scoreboard rendering happens later from a safe deployed/global update.
    p.addDeath();
  }
  requestCipherTransitionReconcile("OnPlayerUndeploy");
  } catch (err) {
    LogRuntimeError("OnPlayerUndeploy", err);
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
  try {
    if (!mod.IsPlayerValid(eventPlayer)) return;

    const playerId = getPlayerIdSafe(eventPlayer);
    if (playerId === undefined) return;

    if (gameStatus === 3) {
      if (playerInMandownByPlayerId[playerId] !== true) {
        clearScoreboardDeathCountForPlayerLife(playerId);
      }
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

    forcePrematchOutside889FullHeal(eventPlayer, playerId);
  } catch (err) {
    LogRuntimeError("OnMandown", err);
  }
}

function Mode_OnRevived(eventPlayer: mod.Player, _eventOtherPlayer: mod.Player): void {
  try {
    const playerId = getPlayerIdSafe(eventPlayer);
    if (playerId === undefined) return;

    cancelPendingRestrictedLethalConfirmForPlayer(playerId);

    if (isCipherSuddenDeathActive() && cipherSuddenDeathEliminatedByPlayerId[playerId] === true) {
      scheduleCipherSuddenDeathEliminatedPlayerCleanup(playerId, "revived");
      return;
    }

    delete playerInMandownByPlayerId[playerId];
    clearScoreboardDeathCountForPlayerLife(playerId);
    clearRestrictedAreaFeedbackSuppressionForPlayer(playerId);

    if (gameStatus !== 3) return;

    handleRuntimeBotRevivedForPlayer(playerId, eventPlayer, "Mode_OnRevived");

    const p = serverPlayers.get(playerId);
    if (!p) return;

    startRestrictedCountdownIfNeeded(p);
    UpdateObjectiveCaptureInteractionState();
    requestCipherTransitionReconcile("OnRevived");
  } catch (err) {
    LogRuntimeError("OnRevived", err);
  }
}


function Mode_OnPlayerDied(
  eventPlayer: mod.Player,
  _eventOtherPlayer: mod.Player,
  _eventDeathType: mod.DeathType,
  _eventWeaponUnlock: mod.WeaponUnlock
): void {
  try {
    const playerId = getPlayerIdSafe(eventPlayer);
    if (playerId === undefined) return;

    invalidateBombCarrierRestoreInsertForPlayer(playerId);

    if (gameStatus !== 3) return;

    if (playerInMandownByPlayerId[playerId] !== true) {
      clearScoreboardDeathCountForPlayerLife(playerId);
    }
    playerInMandownByPlayerId[playerId] = true;
    deactivateRestrictedAreaFeedbackForPlayer(playerId, true);

    const deathPos = tryGetPlayerPositionSafe(eventPlayer);
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

    if (bombCarrierPlayerId === playerId) {
      scheduleBombCarrierDropAfterCombatEvent(playerId, "death", deathPos);
    }

    const runtimeBotSlot = getRuntimeBotSlotForPlayerId(playerId);
    if (runtimeBotSlot) {
      markRuntimeBotSlotForRespawn(playerId, CIPHER_RUNTIME_BOT_DEATH_RESPAWN_DELAY_SECONDS);
    }

    if (isCipherTransitionObjectiveEventSuppressed()) {
      return;
    }

    botObjectiveNextThinkAtSec = 0;
    requestCipherTransitionReconcile("OnPlayerDied");
  } catch (err) {
    LogRuntimeError("OnPlayerDied", err);
  }
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
    killer.updateScoreboard();
  }

  const victim = serverPlayers.get(victimId);
  if (victim) {
    recordScoreboardDeathForPlayer(victim);
  }
}

function Mode_OnPlayerEarnedKillAssist(eventPlayer: mod.Player, eventOtherPlayer: mod.Player): void {
  if (gameStatus !== 3) return;

  const p = serverPlayers.get(modlib.getPlayerId(eventPlayer));
  if (!p) return;

  // Assist score remains, but the old assists stat slot is now Armed.
  p.addScore(50);
  p.updateScoreboard();
}

/* =================================================================================================
   17) DAMAGE ZONE EVENTS
================================================================================================= */

function Mode_OnPlayerEnterAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void {
  const triggerId = getObjIdSafe(eventAreaTrigger);
  const playerId = getPlayerIdSafe(eventPlayer);
  if (triggerId < 0 || playerId === undefined) return;

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

  const p = serverPlayers.get(playerId);
  if (!p) return;

  if (triggerId === COMBAT_BOUNDARY_TRIGGER_ID) {
    delete playerOutsideCombatBoundaryByPlayerId[playerId];
    clearRestrictedCountdownIfNoSourcesRemain(playerId);
    return;
  }

  // Cairo has one authored restricted area (7003).
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
  const triggerId = getObjIdSafe(eventAreaTrigger);
  const playerId = getPlayerIdSafe(eventPlayer);
  if (triggerId < 0 || playerId === undefined) return;

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

export function isCipherLivePhase(): boolean {
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
