import type { ModeContext } from '../state/mode-context.ts';
import { installModule } from './module-utils.ts';

export function installSpawnRoutingModule(context: ModeContext): void {
    installModule(context, 'spawn-routing');
}
