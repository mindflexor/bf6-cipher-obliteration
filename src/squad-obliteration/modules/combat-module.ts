import { CipherEvents as Events } from '../events/cipher-events.ts';

import { combatRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installCombatModule(context: ModeContext): void {
    installModule(context, 'combat', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerDamaged.subscribe(combatRuntimeHandlers.onPlayerDamaged)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnMandown.subscribe(combatRuntimeHandlers.onMandown)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnRevived.subscribe(combatRuntimeHandlers.onRevived)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerDied.subscribe(combatRuntimeHandlers.onPlayerDied)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerEarnedKill.subscribe(combatRuntimeHandlers.onPlayerEarnedKill)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerEarnedKillAssist.subscribe(combatRuntimeHandlers.onPlayerEarnedKillAssist)
        );
    });
}
