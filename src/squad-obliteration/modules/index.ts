import type { ModeContext } from '../state/mode-context.ts';
import { installAudioModule } from './audio-module.ts';
import { installCombatModule } from './combat-module.ts';
import { installLifecycleModule } from './lifecycle-module.ts';
import { installObjectiveModule } from './objective-module.ts';
import { installPlayerSessionModule } from './player-session-module.ts';
import { installPrematchModule } from './prematch-module.ts';
import { installRestrictedAreaModule } from './restricted-area-module.ts';
import { installSchedulerModule } from './scheduler-module.ts';
import { installSpawnRoutingModule } from './spawn-routing-module.ts';
import { installUiModule } from './ui-module.ts';

export function installSquadObliterationModules(context: ModeContext): void {
    installLifecycleModule(context);
    installPlayerSessionModule(context);
    installPrematchModule(context);
    installObjectiveModule(context);
    installSpawnRoutingModule(context);
    installCombatModule(context);
    installRestrictedAreaModule(context);
    installUiModule(context);
    installAudioModule(context);
    installSchedulerModule(context);
}
