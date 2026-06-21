import { Events } from 'bf6-portal-utils/events/index.ts';

import { createZiplineRuntimeHandlers } from './zipline-runtime.ts';
import type { ModeContext } from './state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './modules/module-utils.ts';

export function installZiplineModule(context: ModeContext): void {
    installModule(context, 'zipline', (runtimeContext) => {
        const handlers = createZiplineRuntimeHandlers(runtimeContext);

        subscribeModuleHandler(runtimeContext, Events.OnGameModeStarted.subscribe(handlers.onGameModeStarted));
        subscribeModuleHandler(runtimeContext, Events.OnGameModeEnding.subscribe(handlers.onGameModeEnding));
        subscribeModuleHandler(runtimeContext, Events.OngoingGlobal.subscribe(handlers.onOngoingGlobal));
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerEnterAreaTrigger.subscribe(handlers.onPlayerEnterAreaTrigger)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerExitAreaTrigger.subscribe(handlers.onPlayerExitAreaTrigger)
        );
        subscribeModuleHandler(runtimeContext, Events.OnPlayerInteract.subscribe(handlers.onPlayerInteract));
        subscribeModuleHandler(runtimeContext, Events.OnPlayerLeaveGame.subscribe(handlers.onPlayerLeaveGame));
        subscribeModuleHandler(runtimeContext, Events.OnPlayerUndeploy.subscribe(handlers.onPlayerUndeploy));
    });
}
