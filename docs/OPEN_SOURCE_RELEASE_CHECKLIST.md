# Open-Source Release Checklist

## Legal and Attribution

- [x] MIT license updated with project owner attribution
- [x] Restrictive proprietary language removed from mode header comments
- [x] Contributor credits documented in `CREDITS.md`

## Project Documentation

- [x] Repository README rewritten for Squad Obliteration project context
- [x] Mode documentation added (`docs/SQUAD_OBLITERATION_MODE.md`)
- [x] Authorship statement added (`AUTHORSHIP.md`)
- [x] Provenance hashes added (`PROVENANCE.sha256`)

## Metadata and Hygiene

- [x] `package.json` author/description/repository metadata updated
- [x] `.env` remains gitignored
- [x] `node_modules/` and `dist/` remain gitignored
- [x] `package-lock.json` no longer ignored (for reproducibility)

## Assets

- [x] Cairo reference spatial file added to `godot/reference/`
- [x] Cairo Godot scene file added to `godot/levels/`
- [x] Godot asset usage note added (`godot/README.md`)

## Validation

- [x] `npx.cmd tsc --noEmit --pretty false`
- [x] `npm.cmd run build`

## Publish Steps (Manual)

- [ ] Commit changes with an OSS-release-prep message
- [ ] Create annotated tag (example: `v1.0.0-oss`)
- [ ] Publish GitHub release notes linking `AUTHORSHIP.md` and `PROVENANCE.sha256`
