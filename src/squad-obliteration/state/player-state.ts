export type PlayerScoreboardSnapshot = [number, number, number, number, number];

export interface PlayerUiState {
    friendlyCapture?: mod.UIWidget | null;
    enemyCapture?: mod.UIWidget | null;
    progressBar?: mod.UIWidget | null;
    friendlyScore?: mod.UIWidget | null;
    enemyScore?: mod.UIWidget | null;
    friendlyScorePad?: mod.UIWidget | null;
    enemyScorePad?: mod.UIWidget | null;
    bombCarrierText?: mod.UIWidget | null;
    objectiveHoldRoot?: mod.UIWidget | null;
    objectiveHoldContainer?: mod.UIWidget | null;
    objectiveHoldFillArming?: mod.UIWidget | null;
    objectiveHoldFillDisarming?: mod.UIWidget | null;
    objectiveHoldTextArming?: mod.UIWidget | null;
    objectiveHoldTextDisarming?: mod.UIWidget | null;
    activeFlagContainer?: mod.UIWidget | null;
    activeFlagFriendly?: mod.UIWidget | null;
    activeFlagEnemy?: mod.UIWidget | null;
    activeFlag?: mod.UIWidget | null;
    flagWidgets: Record<string, mod.UIWidget | null>;
}

export class PlayerState {
    public constructor(
        public player: mod.Player,
        public id: number,
        public team: mod.Team
    ) {}

    public isDeployed = false;
    public isReady = false;
    public activeCapturePoint: mod.CapturePoint | null = null;
    public ui: PlayerUiState = {
        flagWidgets: {},
    };

    // [score, kills, deaths, armed, destroyed]
    private _scoreboard: PlayerScoreboardSnapshot = [0, 0, 0, 0, 0];
    private _firstDeployPending = true;

    public setTeam(team: mod.Team): void {
        this.team = team;
    }

    public setCapturePoint(capturePoint: mod.CapturePoint | null): void {
        this.activeCapturePoint = capturePoint;
    }

    public getCapturePoint(): mod.CapturePoint | null {
        return this.activeCapturePoint;
    }

    public toggleReady(): boolean {
        this.isReady = !this.isReady;
        return this.isReady;
    }

    public resetReady(): void {
        this.isReady = false;
    }

    public consumeFirstDeploy(): boolean {
        if (!this._firstDeployPending) return false;
        this._firstDeployPending = false;
        return true;
    }

    public resetForNewRound(): void {
        this._scoreboard = [0, 0, 0, 0, 0];
        this.isDeployed = false;
        this.isReady = false;
        this.activeCapturePoint = null;
        this._firstDeployPending = true;
    }

    public addScore(value: number): void {
        this._scoreboard[0] += value;
    }

    public addKill(): void {
        this._scoreboard[1] += 1;
    }

    public addDeath(): void {
        this._scoreboard[2] += 1;
    }

    public addArmed(): void {
        this._scoreboard[3] += 1;
    }

    public addDestroyed(): void {
        this._scoreboard[4] += 1;
    }

    public getScoreboardSnapshot(): PlayerScoreboardSnapshot {
        return [...this._scoreboard] as PlayerScoreboardSnapshot;
    }
}
