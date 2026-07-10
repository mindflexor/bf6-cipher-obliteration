import { AUDIO_CONFIG } from '../config/audio.ts';
import { BOMB_CONFIG } from '../config/bomb.ts';
import { CIPHER_OBJECTIVE_CONFIGS, CIPHER_ROUTING_CAPTURE_POINT_IDS } from '../config/objectives.ts';
import { PHASE_CONFIG } from '../config/phases.ts';
import { WORLD_IDS, type WorldIdsConfig } from '../config/world-ids.ts';
import { RULES } from '../config/rules.ts';
import { SPAWN_ROUTING_CONFIG } from '../config/spawn-routing.ts';
import { UI_CONFIG } from '../config/ui.ts';
import { CapturePointState } from './capture-point-state.ts';
import { createRuntimeState, type RuntimeState } from './runtime-state.ts';

export interface ModeContext {
    runtime: RuntimeState;
    worldIds: WorldIdsConfig;
    rules: typeof RULES;
    phases: typeof PHASE_CONFIG;
    bomb: typeof BOMB_CONFIG;
    audio: typeof AUDIO_CONFIG;
    ui: typeof UI_CONFIG;
    spawnRouting: typeof SPAWN_ROUTING_CONFIG;
    objectives: {
        definitions: typeof CIPHER_OBJECTIVE_CONFIGS;
        routingCapturePointIds: typeof CIPHER_ROUTING_CAPTURE_POINT_IDS;
    };
}

export function createModeContext(): ModeContext {
    const runtime = createRuntimeState();

    for (const definition of CIPHER_OBJECTIVE_CONFIGS) {
        runtime.capturePoints.set(
            definition.cpId,
            new CapturePointState(
                definition.cpId,
                definition.lane,
                definition.half,
                definition.defendingTeamId
            )
        );
    }

    return {
        runtime,
        worldIds: WORLD_IDS,
        rules: RULES,
        phases: PHASE_CONFIG,
        bomb: BOMB_CONFIG,
        audio: AUDIO_CONFIG,
        ui: UI_CONFIG,
        spawnRouting: SPAWN_ROUTING_CONFIG,
        objectives: {
            definitions: CIPHER_OBJECTIVE_CONFIGS,
            routingCapturePointIds: CIPHER_ROUTING_CAPTURE_POINT_IDS,
        },
    };
}

export function markModuleInstalled(context: ModeContext, moduleName: string): boolean {
    if (context.runtime.modules.installed[moduleName]) return false;

    context.runtime.modules.installed[moduleName] = true;
    context.runtime.modules.installOrder.push(moduleName);
    return true;
}

export function trackModuleSubscription(context: ModeContext, unsubscribe: () => void): void {
    context.runtime.modules.subscriptions.push(unsubscribe);
}
