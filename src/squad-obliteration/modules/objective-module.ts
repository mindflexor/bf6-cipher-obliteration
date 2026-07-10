import type { ModeContext } from '../state/mode-context.ts';
import { installModule } from './module-utils.ts';

export function installObjectiveModule(context: ModeContext): void {
    // Cipher objective authority is provided by InteractPoint and AreaTrigger events.
    // Native objective gameplay events are intentionally not subscribed.
    installModule(context, 'objectives');
}
