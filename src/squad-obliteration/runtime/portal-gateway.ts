/**
 * The engine boundary used by pure Cipher state machines. Portal handles never
 * become authoritative state; callers retain stable ids and generation tokens.
 */
export interface PortalGateway {
    nowSeconds(): number;
    isPlayerValid(player: mod.Player): boolean;
    isPlayerAlive(player: mod.Player): boolean;
    getPlayerTeam(player: mod.Player): mod.Team;
    getObjectPosition(objectId: number): mod.Vector | undefined;
    setCapturePointDisplayOwner(capturePointId: number, team: mod.Team): boolean;
    setCapturePointGameplayEnabled(capturePointId: number, enabled: false): boolean;
    setHqEnabled(hqId: number, enabled: boolean): boolean;
    setNativeDeploymentEnabled(player: mod.Player, enabled: boolean): boolean;
    teleportPlayerOnce(player: mod.Player, position: mod.Vector): boolean;
}
