import { Events } from 'bf6-portal-utils/events/index.ts';

import { objectiveRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installObjectiveModule(context: ModeContext): void {
    installModule(context, 'objectives', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerEnterCapturePoint.subscribe(objectiveRuntimeHandlers.onPlayerEnterCapturePoint)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerExitCapturePoint.subscribe(objectiveRuntimeHandlers.onPlayerExitCapturePoint)
        );
        subscribeModuleHandler(runtimeContext, Events.OngoingMCOM.subscribe(objectiveRuntimeHandlers.onOngoingMcom));
        subscribeModuleHandler(runtimeContext, Events.OnMCOMArmed.subscribe(objectiveRuntimeHandlers.onMcomArmed));
        subscribeModuleHandler(
            runtimeContext,
            Events.OnMCOMDefused.subscribe(objectiveRuntimeHandlers.onMcomDefused)
        );
        subscribeModuleHandler(
            runtimeContext,
            Events.OnMCOMDestroyed.subscribe(objectiveRuntimeHandlers.onMcomDestroyed)
        );
    });
}
