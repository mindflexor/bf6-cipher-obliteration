# Squad Obliteration Mode Documentation

## Overview

Squad Obliteration is a round-based objective mode with a prematch ready-up phase, timed round lifecycle, objective control flow, and bomb interaction systems.

## Match Lifecycle

- Prematch: team assignment, ready-up, roster display
- Countdown: short transition into round start
- Prelive: limited transition state before full live play
- Live: objective/bomb gameplay and scoring
- Postmatch: result presentation and round reset flow

## Core Systems

- Objective control and ownership transitions
- Bomb pickup/carrier/drop/return behavior
- Spawn routing and safety enforcement
- Combat event handling (damage, kill, assist)
- Restricted area handling and messaging
- Optional zipline traversal module driven by authored world IDs
- Live and prematch UI state management

## UI Summary

- Prematch panel with team rosters and ready status
- Live HUD objective lanes and score displays
- Match-start and state-transition UI messaging

## Event-Driven Structure

Entry wiring is done from `src/squad-obliteration/index.ts`, which creates a single mode context and installs module-owned event subscriptions from `src/squad-obliteration/modules/`.

The active gameplay runtime lives in `src/squad-obliteration/runtime/mode-runtime.ts`.

The pre-cutover implementation is preserved as a frozen archive in `src/squad-obliteration/archive/squad-obliteration-mode.v1.ts`.

## Map and World Dependencies

The mode assumes specific IDs and placements for:

- Capture points and objective entities
- Interact points and world icons
- Spawner and area trigger objects

Configuration files under `src/squad-obliteration/config/` and embedded mappings in legacy mode code must match map setup.

The zipline subsystem is configured in `src/squad-obliteration/config/zipline.ts`. It does not add its own UI or strings and only becomes active when valid interact point, area trigger, and anchor object IDs are supplied.

`npm run build` outputs the script bundle plus minified build-input spatial artifacts under `dist/spatials/`. Reference-only Godot assets under `godot/reference/` are excluded from both build and deploy. Portal deploy still uploads only the bundled script and existing strings attachment, so spatial and Godot asset updates remain a manual authoring/import step.

## Key Files

- `src/squad-obliteration/runtime/mode-runtime.ts`
- `src/squad-obliteration/zipline-runtime.ts`
- `src/squad-obliteration/zipline-module.ts`
- `src/squad-obliteration/archive/squad-obliteration-mode.v1.ts`
- `src/squad-obliteration/modules/index.ts`
- `src/squad-obliteration/config/world-ids.ts`
- `src/squad-obliteration/config/zipline.ts`
- `src/strings.json`
