import { createModeContext } from './state/mode-context.ts';
import { installSquadObliterationModules } from './modules/index.ts';
import { installZiplineModule } from './zipline-module.ts';

const context = createModeContext();

installSquadObliterationModules(context);
installZiplineModule(context);
