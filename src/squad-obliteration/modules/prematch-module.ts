import { Events } from 'bf6-portal-utils/events/index.ts';

import { prematchRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installPrematchModule(context: ModeContext): void {
    installModule(context, 'prematch', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerInteract.subscribe(prematchRuntimeHandlers.onPlayerInteract)
        );
    });
}
