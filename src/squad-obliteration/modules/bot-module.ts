import { Events } from 'bf6-portal-utils/events/index.ts';

import { botRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installBotModule(context: ModeContext): void {
    installModule(context, 'bots', (runtimeContext) => {
        subscribeModuleHandler(runtimeContext, Events.OnAIMoveToFailed.subscribe(botRuntimeHandlers.onAiMoveToFailed));
        subscribeModuleHandler(runtimeContext, Events.OnAIMoveToSucceeded.subscribe(botRuntimeHandlers.onAiMoveToSucceeded));
        subscribeModuleHandler(runtimeContext, Events.OnSpawnerSpawned.subscribe(botRuntimeHandlers.onSpawnerSpawned));
    });
}
