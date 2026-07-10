import { CipherEvents as Events } from '../events/cipher-events.ts';

import { lifecycleRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installLifecycleModule(context: ModeContext): void {
    installModule(context, 'lifecycle', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnGameModeStarted.subscribe(lifecycleRuntimeHandlers.onGameModeStarted)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnGameModeEnding.subscribe(lifecycleRuntimeHandlers.onGameModeEnding)
        );
    });
}
