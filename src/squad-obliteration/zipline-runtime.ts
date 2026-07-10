import { Timers } from 'bf6-portal-utils/timers/index.ts';

import type { ZiplineDefinition } from './config/zipline.ts';
import { isCipherLivePhase } from './runtime/mode-runtime.ts';
import type { ModeContext } from './state/mode-context.ts';

const ZERO_VECTOR = mod.CreateVector(0, 0, 0);

interface ResolvedZiplineGeometry {
    anchorPosition: mod.Vector;
    anchorRotation: mod.Vector;
}

interface ZiplineLineState {
    definition: ZiplineDefinition;
    resolutionStatus: 'unresolved' | 'resolved' | 'failed';
    geometry?: ResolvedZiplineGeometry;
    activeMoverObject: mod.Object | null;
    activeRideSfxObject: mod.SFX | null;
    activePlayerId: number | null;
    isMoving: boolean;
    movementToken: number;
    finishTimeoutId?: number;
    unlockTimeoutId?: number;
}

interface PlayerLockState {
    player: mod.Player;
    lockToken: number;
    isLocked: boolean;
}

export interface ZiplineRuntimeHandlers {
    onGameModeStarted(): void;
    onGameModeEnding(): void;
    onOngoingGlobal(): void;
    onPlayerEnterAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void;
    onPlayerExitAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void;
    onPlayerInteract(eventPlayer: mod.Player, eventInteractPoint: mod.InteractPoint): void;
    onPlayerLeaveGame(playerId: number): void;
    onPlayerUndeploy(eventPlayer: mod.Player): void;
}

class ZiplineRuntimeFacade {
    private readonly _context: ModeContext;
    private readonly _lineStatesByAreaTriggerId: Record<number, ZiplineLineState | undefined> = {};
    private readonly _playerTriggerOrder: Record<number, number[] | undefined> = {};
    private readonly _playerLocks: Record<number, PlayerLockState | undefined> = {};

    private _started = false;
    private _initialized = false;
    private _livePhaseActive = false;
    private _interactPointEnabled = false;
    private _interactPoint: mod.InteractPoint | null = null;

    public constructor(context: ModeContext) {
        this._context = context;
    }

    public onGameModeStarted(): void {
        this._started = true;
        this.resetRuntimeState();

        if (!this.ensureInitialized()) return;

        this.disableInteractPoint();
    }

    public onGameModeEnding(): void {
        this.releaseAllPlayerRideLocks();
        this.resetRuntimeState();
        this._started = false;
    }

    public onOngoingGlobal(): void {
        if (!this._started) return;
        if (!this.ensureInitialized()) return;

        const livePhaseNow = isCipherLivePhase();

        if (livePhaseNow === this._livePhaseActive) return;

        this._livePhaseActive = livePhaseNow;

        if (livePhaseNow) {
            this.refreshAllLineGeometry();
        } else {
            this.resetLivePhaseState();
        }

        this.syncInteractPointEnabledState();
    }

    public onPlayerEnterAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void {
        if (!this._started) return;
        if (!this.ensureInitialized()) return;

        const areaTriggerId = this.tryGetObjectId(eventAreaTrigger);
        const playerId = this.tryGetObjectId(eventPlayer);

        if (areaTriggerId === undefined || playerId === undefined) return;
        if (!this._lineStatesByAreaTriggerId[areaTriggerId]) return;

        this.addTriggerToPlayer(playerId, areaTriggerId);
        this.syncInteractPointEnabledState();
    }

    public onPlayerExitAreaTrigger(eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void {
        if (!this._started) return;
        if (!this.ensureInitialized()) return;

        const areaTriggerId = this.tryGetObjectId(eventAreaTrigger);
        const playerId = this.tryGetObjectId(eventPlayer);

        if (areaTriggerId === undefined || playerId === undefined) return;
        if (!this._lineStatesByAreaTriggerId[areaTriggerId]) return;

        this.removeTriggerFromPlayer(playerId, areaTriggerId);
        this.syncInteractPointEnabledState();
    }

    public onPlayerInteract(eventPlayer: mod.Player, eventInteractPoint: mod.InteractPoint): void {
        if (!this.isLivePhaseRuntimeActive()) return;
        if (!this.ensureInitialized()) return;

        const interactPointId = this.tryGetObjectId(eventInteractPoint);

        if (interactPointId === undefined || interactPointId !== this._context.zipline.interactPointId) return;

        const playerId = this.tryGetObjectId(eventPlayer);

        if (playerId === undefined) return;
        if (this._playerLocks[playerId]?.isLocked) return;

        const activeAreaTriggerId = this.getActiveAreaTriggerIdForPlayer(playerId);

        if (activeAreaTriggerId === undefined) return;

        const lineState = this._lineStatesByAreaTriggerId[activeAreaTriggerId];

        if (!lineState) return;
        if (lineState.isMoving) return;
        if (lineState.resolutionStatus !== 'resolved' || !lineState.geometry) return;

        this.startAscent(lineState, lineState.geometry, eventPlayer, playerId);
    }

    public onPlayerLeaveGame(playerId: number): void {
        this.clearPlayerRuntimeState(playerId, true);
        this.syncInteractPointEnabledState();
    }

    public onPlayerUndeploy(eventPlayer: mod.Player): void {
        const playerId = this.tryGetObjectId(eventPlayer);

        if (playerId === undefined) return;

        this.clearPlayerRuntimeState(playerId, true);
        this.syncInteractPointEnabledState();
    }

    private isLivePhaseRuntimeActive(): boolean {
        return this._started && this._livePhaseActive;
    }

    private ensureInitialized(): boolean {
        if (this._initialized) {
            return true;
        }

        const interactPoint = this.tryResolveInteractPoint();

        if (!interactPoint) {
            return false;
        }

        this._interactPoint = interactPoint;
        this._interactPointEnabled = false;

        for (const definition of this._context.zipline.ziplines) {
            this._lineStatesByAreaTriggerId[definition.areaTriggerId] = {
                definition,
                resolutionStatus: 'unresolved',
                activeMoverObject: null,
                activeRideSfxObject: null,
                activePlayerId: null,
                isMoving: false,
                movementToken: 0,
            };
        }

        this._initialized = true;
        return true;
    }

    private refreshAllLineGeometry(): void {
        for (const lineState of this.getLineStates()) {
            this.refreshLineGeometry(lineState);
        }
    }

    private refreshLineGeometry(lineState: ZiplineLineState): void {
        this.cancelRide(lineState, true);
        lineState.resolutionStatus = 'unresolved';
        lineState.geometry = undefined;

        try {
            mod.GetAreaTrigger(lineState.definition.areaTriggerId);

            const anchorObject = mod.GetSpatialObject(lineState.definition.anchorObjectId);

            lineState.geometry = {
                anchorPosition: mod.GetObjectPosition(anchorObject),
                anchorRotation: mod.GetObjectRotation(anchorObject),
            };
            lineState.resolutionStatus = 'resolved';
        } catch {
            lineState.resolutionStatus = 'failed';
            lineState.geometry = undefined;
        }
    }

    private startAscent(
        lineState: ZiplineLineState,
        geometry: ResolvedZiplineGeometry,
        rider: mod.Player,
        playerId: number
    ): void {
        this.cancelRide(lineState, false);

        const moverObject = this.trySpawnMover(lineState, geometry);

        if (!moverObject) return;

        const currentY = this.getObjectY(moverObject);
        const deltaY = this._context.zipline.finalTargetY - currentY;

        if (Math.abs(deltaY) <= this._context.zipline.movementEpsilon) {
            this.tryUnspawnObject(moverObject);
            return;
        }

        const movementToken = lineState.movementToken + 1;
        const ascentDurationSeconds = this.getAscentDurationSeconds(lineState);
        const earlyUnlockSeconds = this.getEarlyUnlockSeconds(lineState, ascentDurationSeconds);
        const lockToken = this.applyPlayerRideLock(playerId, rider);

        lineState.activePlayerId = playerId;
        lineState.activeMoverObject = moverObject;
        lineState.activeRideSfxObject = this.tryPlayRideSfx(lineState, rider);
        lineState.isMoving = true;
        lineState.movementToken = movementToken;

        mod.MoveObjectOverTime(
            moverObject,
            mod.CreateVector(0, deltaY, 0),
            ZERO_VECTOR,
            ascentDurationSeconds,
            false,
            false
        );

        const unlockDelayMs = Math.max(0, (ascentDurationSeconds - earlyUnlockSeconds) * 1_000);

        if (unlockDelayMs <= 0) {
            this.releasePlayerRideLockById(playerId, lockToken);
        } else {
            lineState.unlockTimeoutId = Timers.setTimeout(
                () => this.releasePlayerRideLockById(playerId, lockToken),
                unlockDelayMs
            );
        }

        lineState.finishTimeoutId = Timers.setTimeout(
            () => this.finishAscent(lineState.definition.areaTriggerId, movementToken),
            ascentDurationSeconds * 1_000
        );
    }

    private finishAscent(areaTriggerId: number, movementToken: number): void {
        const lineState = this._lineStatesByAreaTriggerId[areaTriggerId];

        if (!lineState) return;
        if (lineState.movementToken !== movementToken) return;

        if (lineState.activePlayerId !== null) {
            this.releasePlayerRideLockById(lineState.activePlayerId);
        }

        this.cancelRide(lineState, true);
    }

    private cancelRide(lineState: ZiplineLineState, invalidateMovementToken: boolean): void {
        Timers.clearTimeout(lineState.finishTimeoutId);
        Timers.clearTimeout(lineState.unlockTimeoutId);
        lineState.finishTimeoutId = undefined;
        lineState.unlockTimeoutId = undefined;

        if (lineState.activePlayerId !== null) {
            this.releasePlayerRideLockById(lineState.activePlayerId);
        }

        if (lineState.activeMoverObject) {
            this.tryUnspawnObject(lineState.activeMoverObject);
        }

        if (lineState.activeRideSfxObject) {
            this.tryDisposeSfx(lineState.activeRideSfxObject);
        }

        lineState.activeMoverObject = null;
        lineState.activeRideSfxObject = null;
        lineState.activePlayerId = null;
        lineState.isMoving = false;

        if (invalidateMovementToken) {
            lineState.movementToken += 1;
        }
    }

    private clearPlayerRuntimeState(playerId: number, releaseLock: boolean): void {
        delete this._playerTriggerOrder[playerId];

        for (const lineState of this.getLineStates()) {
            if (lineState.activePlayerId !== playerId) continue;

            this.cancelRide(lineState, true);
        }

        if (releaseLock) {
            this.releasePlayerRideLockById(playerId);
        }

        delete this._playerLocks[playerId];
    }

    private resetLivePhaseState(): void {
        for (const lineState of this.getLineStates()) {
            this.cancelRide(lineState, true);
            lineState.resolutionStatus = 'unresolved';
            lineState.geometry = undefined;
        }

        this.disableInteractPoint();
    }

    private resetRuntimeState(): void {
        this.resetLivePhaseState();

        for (const areaTriggerIdText of Object.keys(this._lineStatesByAreaTriggerId)) {
            delete this._lineStatesByAreaTriggerId[Number(areaTriggerIdText)];
        }

        for (const playerIdText of Object.keys(this._playerTriggerOrder)) {
            delete this._playerTriggerOrder[Number(playerIdText)];
        }

        for (const playerIdText of Object.keys(this._playerLocks)) {
            delete this._playerLocks[Number(playerIdText)];
        }

        this._interactPoint = null;
        this._initialized = false;
        this._livePhaseActive = false;
        this._interactPointEnabled = false;
    }

    private getLineStates(): ZiplineLineState[] {
        return Object.values(this._lineStatesByAreaTriggerId).filter(
            (lineState): lineState is ZiplineLineState => lineState !== undefined
        );
    }

    private addTriggerToPlayer(playerId: number, areaTriggerId: number): void {
        this.removeTriggerFromPlayer(playerId, areaTriggerId);

        let triggerIds = this._playerTriggerOrder[playerId];

        if (!triggerIds) {
            triggerIds = [];
            this._playerTriggerOrder[playerId] = triggerIds;
        }

        triggerIds.push(areaTriggerId);
    }

    private removeTriggerFromPlayer(playerId: number, areaTriggerId: number): void {
        const triggerIds = this._playerTriggerOrder[playerId];

        if (!triggerIds) return;

        const nextTriggerIds: number[] = [];

        for (const existingTriggerId of triggerIds) {
            if (existingTriggerId !== areaTriggerId) {
                nextTriggerIds.push(existingTriggerId);
            }
        }

        if (nextTriggerIds.length === 0) {
            delete this._playerTriggerOrder[playerId];
            return;
        }

        this._playerTriggerOrder[playerId] = nextTriggerIds;
    }

    private getActiveAreaTriggerIdForPlayer(playerId: number): number | undefined {
        const triggerIds = this._playerTriggerOrder[playerId];

        if (!triggerIds || triggerIds.length === 0) return undefined;

        return triggerIds[triggerIds.length - 1];
    }

    private getAscentDurationSeconds(lineState: ZiplineLineState): number {
        return Math.max(0.01, lineState.definition.ascentDurationSeconds ?? this._context.zipline.ascentDurationSeconds);
    }

    private getEarlyUnlockSeconds(lineState: ZiplineLineState, ascentDurationSeconds: number): number {
        return Math.min(
            ascentDurationSeconds,
            Math.max(0, lineState.definition.earlyUnlockSeconds ?? this._context.zipline.earlyUnlockSeconds)
        );
    }

    private trySpawnMover(lineState: ZiplineLineState, geometry: ResolvedZiplineGeometry): mod.Object | undefined {
        try {
            const moverObject = mod.SpawnObject(
                lineState.definition.moverPrefab ?? this._context.zipline.moverPrefab,
                geometry.anchorPosition,
                geometry.anchorRotation,
                lineState.definition.moverScale ?? this._context.zipline.moverScale
            ) as mod.Object;

            mod.GetObjId(moverObject);

            return moverObject;
        } catch {
            return undefined;
        }
    }

    private tryPlayRideSfx(lineState: ZiplineLineState, rider: mod.Player): mod.SFX | null {
        const rideSfxPrefab = lineState.definition.rideSfxPrefab ?? this._context.zipline.rideSfxPrefab;

        if (rideSfxPrefab === undefined) return null;

        try {
            const sfxObject = mod.SpawnObject(rideSfxPrefab, ZERO_VECTOR, ZERO_VECTOR) as mod.SFX;

            mod.PlaySound(
                sfxObject,
                lineState.definition.rideSfxAmplitude ?? this._context.zipline.rideSfxAmplitude,
                this.tryGetPlayerPosition(rider) ?? this.getTopRideSfxPosition(lineState),
                lineState.definition.rideSfxAttenuationRange ?? this._context.zipline.rideSfxAttenuationRange
            );

            return sfxObject;
        } catch {
            return null;
        }
    }

    private getTopRideSfxPosition(lineState: ZiplineLineState): mod.Vector {
        const anchorPosition = lineState.geometry?.anchorPosition ?? ZERO_VECTOR;

        return mod.CreateVector(
            mod.XComponentOf(anchorPosition),
            this._context.zipline.finalTargetY,
            mod.ZComponentOf(anchorPosition)
        );
    }

    private getObjectY(object: mod.Object): number {
        return mod.YComponentOf(mod.GetObjectPosition(object));
    }

    private tryGetPlayerPosition(player: mod.Player): mod.Vector | undefined {
        try {
            return mod.GetSoldierState(player, mod.SoldierStateVector.GetPosition);
        } catch {
            return undefined;
        }
    }

    private tryDisposeSfx(sfxObject: mod.SFX): void {
        try {
            mod.StopSound(sfxObject);
        } catch {
            // Ignore sound stop failures during cleanup.
        }

        this.tryUnspawnObject(sfxObject);
    }

    private tryUnspawnObject(object: mod.Object): void {
        try {
            mod.UnspawnObject(object);
        } catch {
            // Ignore runtime cleanup failures to keep the zipline reusable.
        }
    }

    private syncInteractPointEnabledState(): void {
        const shouldEnable = this.isLivePhaseRuntimeActive() && this.hasAnyPlayerInsideResolvedZiplineTrigger();

        if (shouldEnable) {
            this.enableInteractPoint();
            return;
        }

        this.disableInteractPoint();
    }

    private hasAnyPlayerInsideResolvedZiplineTrigger(): boolean {
        for (const triggerIds of Object.values(this._playerTriggerOrder)) {
            if (!triggerIds || triggerIds.length === 0) continue;

            for (const triggerId of triggerIds) {
                const lineState = this._lineStatesByAreaTriggerId[triggerId];

                if (!lineState) continue;
                if (lineState.resolutionStatus !== 'resolved' || !lineState.geometry) continue;

                return true;
            }
        }

        return false;
    }

    private tryResolveInteractPoint(): mod.InteractPoint | null {
        try {
            return mod.GetInteractPoint(this._context.zipline.interactPointId);
        } catch {
            return null;
        }
    }

    private setInteractPointEnabled(enabled: boolean): boolean {
        if (!this._interactPoint) return false;
        if (this._interactPointEnabled === enabled) return true;

        try {
            mod.EnableInteractPoint(this._interactPoint, enabled);
            this._interactPointEnabled = enabled;
            return true;
        } catch {
            return false;
        }
    }

    private enableInteractPoint(): boolean {
        return this.setInteractPointEnabled(true);
    }

    private disableInteractPoint(): boolean {
        return this.setInteractPointEnabled(false);
    }

    private applyPlayerRideLock(playerId: number, player: mod.Player): number {
        const previousLockState = this._playerLocks[playerId];
        const nextLockToken = previousLockState ? previousLockState.lockToken + 1 : 1;

        this._playerLocks[playerId] = {
            player,
            lockToken: nextLockToken,
            isLocked: true,
        };

        if (mod.IsPlayerValid(player)) {
            mod.EnableAllInputRestrictions(player, true);
            mod.EnableInputRestriction(player, mod.RestrictedInputs.CameraPitch, false);
            mod.EnableInputRestriction(player, mod.RestrictedInputs.CameraYaw, false);
        }

        return nextLockToken;
    }

    private releasePlayerRideLockById(playerId: number, expectedToken?: number): void {
        const lockState = this._playerLocks[playerId];

        if (!lockState) return;
        if (expectedToken !== undefined && lockState.lockToken !== expectedToken) return;
        if (!lockState.isLocked) return;

        lockState.isLocked = false;

        if (mod.IsPlayerValid(lockState.player)) {
            mod.EnableAllInputRestrictions(lockState.player, false);
        }
    }

    private releaseAllPlayerRideLocks(): void {
        for (const playerIdText of Object.keys(this._playerLocks)) {
            this.releasePlayerRideLockById(Number(playerIdText));
        }
    }

    private tryGetObjectId(object: mod.Object): number | undefined {
        try {
            return mod.GetObjId(object);
        } catch {
            return undefined;
        }
    }
}

export function createZiplineRuntimeHandlers(context: ModeContext): ZiplineRuntimeHandlers {
    const facade = new ZiplineRuntimeFacade(context);

    return {
        onGameModeStarted: (): void => facade.onGameModeStarted(),
        onGameModeEnding: (): void => facade.onGameModeEnding(),
        onOngoingGlobal: (): void => facade.onOngoingGlobal(),
        onPlayerEnterAreaTrigger: (eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void =>
            facade.onPlayerEnterAreaTrigger(eventPlayer, eventAreaTrigger),
        onPlayerExitAreaTrigger: (eventPlayer: mod.Player, eventAreaTrigger: mod.AreaTrigger): void =>
            facade.onPlayerExitAreaTrigger(eventPlayer, eventAreaTrigger),
        onPlayerInteract: (eventPlayer: mod.Player, eventInteractPoint: mod.InteractPoint): void =>
            facade.onPlayerInteract(eventPlayer, eventInteractPoint),
        onPlayerLeaveGame: (playerId: number): void => facade.onPlayerLeaveGame(playerId),
        onPlayerUndeploy: (eventPlayer: mod.Player): void => facade.onPlayerUndeploy(eventPlayer),
    };
}
