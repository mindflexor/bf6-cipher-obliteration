import type { ModeContext } from '../state/mode-context.ts';
import { installModule } from './module-utils.ts';

export function installUiModule(context: ModeContext): void {
    installModule(context, 'ui');
}
