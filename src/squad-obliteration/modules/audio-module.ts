import type { ModeContext } from '../state/mode-context.ts';
import { installModule } from './module-utils.ts';

export function installAudioModule(context: ModeContext): void {
    installModule(context, 'audio');
}
