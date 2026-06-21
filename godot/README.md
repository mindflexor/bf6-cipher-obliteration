# Godot Map Assets

This folder contains Godot scene sources and reference assets used during map authoring.

## Included

- `levels/MF_Cairo_SQOMCOMS.tscn`
- `reference/MF_Cairo_SQOMCOMS.spatial.json`

## Note

The `.tscn` file references external PortalSDK/Godot resources (paths under `res://...`) that are not fully vendored in this repository.

Use your local PortalSDK/Godot project to open and edit the scene.

`reference/MF_Cairo_SQOMCOMS.spatial.json` is a reference-only asset for open-source users who want to copy objects into other maps in Godot. It is not part of `npm run build` or `npm run deploy`.
