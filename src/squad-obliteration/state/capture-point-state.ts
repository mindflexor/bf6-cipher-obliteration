/** Script-owned metadata for a disabled native CapturePoint display surface. */
export class CapturePointState {
    public constructor(
        public id: number,
        public lane: 'A' | 'B' | 'C' | 'D',
        public half: 1 | 2,
        public defendingTeamId: 1 | 2
    ) {}
}
