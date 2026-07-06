import { createModeContext } from './state/mode-context.ts';
import { installSquadObliterationModules } from './modules/index.ts';

const context = createModeContext();

installSquadObliterationModules(context);
