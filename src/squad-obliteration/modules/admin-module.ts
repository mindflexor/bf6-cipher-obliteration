import { CipherEvents as Events } from '../events/cipher-events.ts';

import { adminRuntimeHandlers } from '../runtime/mode-runtime.ts';
import type { ModeContext } from '../state/mode-context.ts';
import { installModule, subscribeModuleHandler } from './module-utils.ts';

export function installAdminModule(context: ModeContext): void {
    installModule(context, 'admin', (runtimeContext) => {
        subscribeModuleHandler(
            runtimeContext,
            Events.OnPlayerUIButtonEvent.subscribe(adminRuntimeHandlers.onPlayerUIButtonEvent)
        );
    });
}
