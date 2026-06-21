export class CapturePointState {
    public constructor(
        public capturePoint: mod.CapturePoint,
        public id: number,
        public lane: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'
    ) {}

    private _owner: mod.Team = mod.GetTeam(0);
    private _capturingTeam: mod.Team = mod.GetTeam(0);
    private _onPointPlayerIds: number[] = [];
    private _captureProgress = 0;
    private _previousCaptureProgress = 0;

    public objectiveAwardPending = false;

    public get owner(): mod.Team {
        return this._owner;
    }

    public set owner(value: mod.Team) {
        this._owner = value;
    }

    public get capturingTeam(): mod.Team {
        return this._capturingTeam;
    }

    public set capturingTeam(value: mod.Team) {
        this._capturingTeam = value;
    }

    public get captureProgress(): number {
        return this._captureProgress;
    }

    public set captureProgress(value: number) {
        this._previousCaptureProgress = this._captureProgress;
        if (value < 0) {
            this._captureProgress = 0;
            return;
        }
        if (value > 1) {
            this._captureProgress = 1;
            return;
        }
        this._captureProgress = value;
    }

    public get previousCaptureProgress(): number {
        return this._previousCaptureProgress;
    }

    public addPlayerOnPoint(playerId: number): void {
        if (this._onPointPlayerIds.includes(playerId)) return;
        this._onPointPlayerIds.push(playerId);
    }

    public removePlayerOnPoint(playerId: number): void {
        const index = this._onPointPlayerIds.indexOf(playerId);
        if (index >= 0) this._onPointPlayerIds.splice(index, 1);
    }

    public clearOnPointPlayers(): void {
        this._onPointPlayerIds = [];
    }

    public getOnPointPlayers(): number[] {
        return [...this._onPointPlayerIds];
    }
}
