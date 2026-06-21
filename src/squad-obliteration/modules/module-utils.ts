import type { ModeContext } from '../state/mode-context.ts';
import { markModuleInstalled, trackModuleSubscription } from '../state/mode-context.ts';

export function installModule(
    context: ModeContext,
    moduleName: string,
    install?: (context: ModeContext) => void
): void {
    if (!markModuleInstalled(context, moduleName)) return;
    install?.(context);
}

export function subscribeModuleHandler(context: ModeContext, unsubscribe: () => void): void {
    trackModuleSubscription(context, unsubscribe);
}
