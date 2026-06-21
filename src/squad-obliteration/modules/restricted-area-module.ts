import { Events } from 'bf6-portal-utils/events/index.ts';

import { restrictedAreaRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installRestrictedAreaModule(context: ModeContext): void {
    installModule(context, 'restricted-area', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerEnterAreaTrigger.subscribe(restrictedAreaRuntimeHandlers.onPlayerEnterAreaTrigger)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerExitAreaTrigger.subscribe(restrictedAreaRuntimeHandlers.onPlayerExitAreaTrigger)
        );
    });
}
