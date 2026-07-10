type CipherEventHandler<TArgs extends unknown[]> = (...args: TArgs) => void;

class CipherEventChannel<TArgs extends unknown[]> {
    private readonly handlers = new Set<CipherEventHandler<TArgs>>();

    public subscribe(handler: CipherEventHandler<TArgs>): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    public trigger(...args: TArgs): void {
        for (const handler of this.handlers) handler(...args);
    }
}

export const CipherEvents = {
    OngoingGlobal: new CipherEventChannel<[]>(),
    OnGameModeStarted: new CipherEventChannel<[]>(),
    OnGameModeEnding: new CipherEventChannel<[]>(),
    OnPlayerJoinGame: new CipherEventChannel<[mod.Player]>(),
    OnPlayerLeaveGame: new CipherEventChannel<[number]>(),
    OnPlayerDeployed: new CipherEventChannel<[mod.Player]>(),
    OnPlayerUndeploy: new CipherEventChannel<[mod.Player]>(),
    OnPlayerInteract: new CipherEventChannel<[mod.Player, mod.InteractPoint]>(),
    OnPlayerUIButtonEvent: new CipherEventChannel<[mod.Player, mod.UIWidget, mod.UIButtonEvent]>(),
    OnPlayerDamaged: new CipherEventChannel<[mod.Player, mod.Player, mod.DamageType, mod.WeaponUnlock]>(),
    OnMandown: new CipherEventChannel<[mod.Player, mod.Player]>(),
    OnRevived: new CipherEventChannel<[mod.Player, mod.Player]>(),
    OnPlayerDied: new CipherEventChannel<[mod.Player, mod.Player, mod.DeathType, mod.WeaponUnlock]>(),
    OnPlayerEarnedKill: new CipherEventChannel<[mod.Player, mod.Player, mod.DeathType, mod.WeaponUnlock]>(),
    OnPlayerEarnedKillAssist: new CipherEventChannel<[mod.Player, mod.Player]>(),
    OnPlayerEnterAreaTrigger: new CipherEventChannel<[mod.Player, mod.AreaTrigger]>(),
    OnPlayerExitAreaTrigger: new CipherEventChannel<[mod.Player, mod.AreaTrigger]>(),
    OnAIMoveToFailed: new CipherEventChannel<[mod.Player]>(),
    OnAIMoveToSucceeded: new CipherEventChannel<[mod.Player]>(),
    OnSpawnerSpawned: new CipherEventChannel<[mod.Player, mod.Spawner]>(),
};

export function OngoingGlobal(): void { CipherEvents.OngoingGlobal.trigger(); }
export function OnGameModeStarted(): void { CipherEvents.OnGameModeStarted.trigger(); }
export function OnGameModeEnding(): void { CipherEvents.OnGameModeEnding.trigger(); }
export function OnPlayerJoinGame(player: mod.Player): void { CipherEvents.OnPlayerJoinGame.trigger(player); }
export function OnPlayerLeaveGame(playerId: number): void { CipherEvents.OnPlayerLeaveGame.trigger(playerId); }
export function OnPlayerDeployed(player: mod.Player): void { CipherEvents.OnPlayerDeployed.trigger(player); }
export function OnPlayerUndeploy(player: mod.Player): void { CipherEvents.OnPlayerUndeploy.trigger(player); }
export function OnPlayerInteract(player: mod.Player, point: mod.InteractPoint): void {
    CipherEvents.OnPlayerInteract.trigger(player, point);
}
export function OnPlayerUIButtonEvent(
    player: mod.Player,
    widget: mod.UIWidget,
    event: mod.UIButtonEvent
): void { CipherEvents.OnPlayerUIButtonEvent.trigger(player, widget, event); }
export function OnPlayerDamaged(
    victim: mod.Player,
    attacker: mod.Player,
    damageType: mod.DamageType,
    weapon: mod.WeaponUnlock
): void { CipherEvents.OnPlayerDamaged.trigger(victim, attacker, damageType, weapon); }
export function OnMandown(player: mod.Player, otherPlayer: mod.Player): void {
    CipherEvents.OnMandown.trigger(player, otherPlayer);
}
export function OnRevived(player: mod.Player, otherPlayer: mod.Player): void {
    CipherEvents.OnRevived.trigger(player, otherPlayer);
}
export function OnPlayerDied(
    victim: mod.Player,
    killer: mod.Player,
    deathType: mod.DeathType,
    weapon: mod.WeaponUnlock
): void { CipherEvents.OnPlayerDied.trigger(victim, killer, deathType, weapon); }
export function OnPlayerEarnedKill(
    killer: mod.Player,
    victim: mod.Player,
    deathType: mod.DeathType,
    weapon: mod.WeaponUnlock
): void { CipherEvents.OnPlayerEarnedKill.trigger(killer, victim, deathType, weapon); }
export function OnPlayerEarnedKillAssist(player: mod.Player, victim: mod.Player): void {
    CipherEvents.OnPlayerEarnedKillAssist.trigger(player, victim);
}
export function OnPlayerEnterAreaTrigger(player: mod.Player, trigger: mod.AreaTrigger): void {
    CipherEvents.OnPlayerEnterAreaTrigger.trigger(player, trigger);
}
export function OnPlayerExitAreaTrigger(player: mod.Player, trigger: mod.AreaTrigger): void {
    CipherEvents.OnPlayerExitAreaTrigger.trigger(player, trigger);
}
export function OnAIMoveToFailed(player: mod.Player): void { CipherEvents.OnAIMoveToFailed.trigger(player); }
export function OnAIMoveToSucceeded(player: mod.Player): void { CipherEvents.OnAIMoveToSucceeded.trigger(player); }
export function OnSpawnerSpawned(player: mod.Player, spawner: mod.Spawner): void {
    CipherEvents.OnSpawnerSpawned.trigger(player, spawner);
}
