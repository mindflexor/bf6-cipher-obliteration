import { CipherEvents as Events } from '../events/cipher-events.ts';

import { playerSessionRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installPlayerSessionModule(context: ModeContext): void {
    installModule(context, 'player-session', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerJoinGame.subscribe(playerSessionRuntimeHandlers.onPlayerJoinGame)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerLeaveGame.subscribe(playerSessionRuntimeHandlers.onPlayerLeaveGame)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerDeployed.subscribe(playerSessionRuntimeHandlers.onPlayerDeployed)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerUndeploy.subscribe(playerSessionRuntimeHandlers.onPlayerUndeploy)
        );
    });
}
