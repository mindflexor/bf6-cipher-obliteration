# Squad Obliteration - CCL [DevKit]

Open-source Battlefield 6 Portal game mode project for **Squad Obliteration**.

This repository contains the TypeScript mode implementation, strings, deployment tooling, and map-authoring artifacts used to build and publish the experience.

## What This Project Includes

- Squad Obliteration active runtime (`src/squad-obliteration/runtime/mode-runtime.ts`)
- Module-owned event wiring under `src/squad-obliteration/modules/`
- Archived legacy reference at `src/squad-obliteration/archive/squad-obliteration-mode.v1.ts`
- Build and deploy workflow via `bf6-portal-bundler` and `@bf6mods/portal`
- Build-input spatial map data in `spatials/`
- Minified spatial build artifacts in `dist/spatials/`
- Godot editor scene and reference artifacts in `godot/`
- Attribution and proof-of-work files for public sharing

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Build bundle + strings + minified build-input spatial artifacts:

```bash
npm run build
```

3. Configure deploy credentials in `.env`:

```env
SESSION_ID="..."
MOD_ID="..."
```

4. Deploy to Portal:

```bash
npm run deploy
```

## Repository Layout

- `src/index.ts`: mode entrypoint
- `src/squad-obliteration/index.ts`: composition root
- `src/squad-obliteration/runtime/mode-runtime.ts`: active gameplay runtime
- `src/squad-obliteration/zipline-runtime.ts`: zipline ride runtime
- `src/squad-obliteration/zipline-module.ts`: zipline event wiring
- `src/squad-obliteration/archive/squad-obliteration-mode.v1.ts`: frozen legacy reference
- `src/squad-obliteration/modules/`: module installers and direct event subscriptions
- `src/squad-obliteration/config/zipline.ts`: zipline map/object config
- `src/strings.json`: localized mode strings
- `spatials/`: portal spatial JSON files included in `npm run build`
- `dist/spatials/`: minified spatial JSON output from `npm run build`
- `godot/levels/`: Godot scene source files used for map authoring
- `godot/reference/`: Godot/reference-only spatial JSON assets excluded from build and deploy
- `docs/SQUAD_OBLITERATION_MODE.md`: mode documentation
- `docs/OPEN_SOURCE_RELEASE_CHECKLIST.md`: OSS publish checklist
- `AUTHORSHIP.md`: authorship/provenance statement
- `PROVENANCE.sha256`: file hash snapshot
- `CREDITS.md`: contribution and attribution details

## Documentation

- Mode documentation: [docs/SQUAD_OBLITERATION_MODE.md](docs/SQUAD_OBLITERATION_MODE.md)
- Open-source release checklist: [docs/OPEN_SOURCE_RELEASE_CHECKLIST.md](docs/OPEN_SOURCE_RELEASE_CHECKLIST.md)
- Authorship statement: [AUTHORSHIP.md](AUTHORSHIP.md)
- Credits: [CREDITS.md](CREDITS.md)

## Zipline Authoring

The zipline module is bundled into the main SQO script, but it stays inert until you add real IDs in `src/squad-obliteration/config/zipline.ts`.
Configure one shared interact point under `ZIPLINE_CONFIG.interactPointId`, then add each zipline under `ZIPLINE_CONFIG.ziplines` with its own `areaTriggerId` and `anchorObjectId`.

Map objects for ziplines are authored manually in Godot and exported through the spatial JSON workflow. `npm run build` minifies only the build-input Portal spatial JSON files under `spatials/` into `dist/spatials/`. Reference assets under `godot/reference/`, including `MF_Cairo_SQOMCOMS.spatial.json`, stay out of build and deploy, while `npm run deploy` still uploads only `dist/bundle.ts` and `dist/bundle.strings.json` to Portal.

## Attribution

Attribution and contribution boundaries are documented in [CREDITS.md](CREDITS.md).

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
