# Release Strategy

## Branching Model

Trunk-based development. `main` is the single source of truth.

- All work happens in short-lived feature branches
- PRs are opened, reviewed, and squash-merged into `main`
- No staging branch, no develop branch, no long-lived branches
- `main` is always releasable but does not auto-ship to users

## Branch Rules (enforced via GitHub rulesets)

- No direct pushes to `main`
- PRs require 1 approval
- Stale reviews dismissed on new pushes
- All CI checks must pass (Rust, Go, TypeScript)
- All review conversations must be resolved
- Squash or rebase merge only (linear history)
- No force pushes, no branch deletion

## Release Flow

```
PR merged to main
    |
    v
Manual version tag (v0.1.0, v0.2.0, etc.)
    |
    v
CI builds for all platforms (draft release)
    |
    v
Internal testing (compile locally, edge case testing)
    |
    v
Promote to pre-release (canary)
    |    - Beta testers auto-update to this
    |    - Monitor for regressions
    v
Promote to full release (production)
         - All users auto-update to this
```

### Draft Release

Created automatically by CI when a version tag is pushed. Binaries are built for Windows, macOS (both architectures), and Linux. Not visible to users. Team downloads and tests locally.

### Pre-release (Canary)

Draft promoted to pre-release manually after internal testing passes. Users who opted into the beta channel receive this update via Tauri's auto-updater. Monitor crash reports and telemetry (if opted in) before promoting.

### Full Release (Production)

Pre-release promoted to full release after canary validation. All users on the stable channel receive this update. If a critical issue is found, tag a new patch version and repeat the flow.

### Hotfixes

Same flow, just faster. Branch from main, fix, PR, merge, tag, build, test, ship. No special hotfix branch.

## Auto-Updater Channels

Tauri's auto-updater checks GitHub Releases.

| Channel | Includes                     | Default             |
| ------- | ---------------------------- | ------------------- |
| Stable  | Full releases only           | Yes                 |
| Beta    | Full releases + pre-releases | Opt-in via settings |

The updater endpoint JSON is generated per release. The beta channel endpoint includes pre-releases in its version check.

## Feature Flags

No external feature flag server (no backend to host one).

### Compile-time Flags

Rust `cargo features` and Vite build-time env vars. A feature is compiled in or out at build time. Used for gating in-progress features during development.

```toml
# src-tauri/Cargo.toml
[features]
kick = []           # Phase 5: Kick integration
extensions = []     # Phase 5: Plugin API
stream-mgmt = []    # Phase 6: Stream management
```

### Remote Config

A static JSON file hosted on prismoid.org (or GitHub Pages), fetched on app launch. Used for:

- Enabling canary features for specific build versions
- Kill switches (disable a feature that's causing issues without shipping a new build)
- A/B testing if needed later

The remote config is non-blocking. If the fetch fails, the app uses its compiled-in defaults. No degradation.

## Versioning

Semantic versioning: `MAJOR.MINOR.PATCH`

- `MAJOR`: breaking changes to user-facing behavior or data (e.g., config format change requiring migration)
- `MINOR`: new features (new platform, new UI capability)
- `PATCH`: bug fixes, performance improvements

Pre-1.0 releases use `0.x.y` where minor bumps may include breaking changes.
