import { createModeContext } from './state/mode-context.ts';
import { installCipherModules } from './modules/index.ts';

const context = createModeContext();

installCipherModules(context);
