# Distribution

## Platforms

| Platform | Format                 | Signing                                           | Source                         |
| -------- | ---------------------- | ------------------------------------------------- | ------------------------------ |
| Windows  | `.msi` / `.exe` (NSIS) | Unsigned in v1 (SmartScreen warning, dismissible) | GitHub Releases + prismoid.org |
| macOS    | `.dmg`                 | Signed + notarized (Apple Developer, $99/yr)      | GitHub Releases + prismoid.org |
| Linux    | AppImage, `.deb`       | No signing needed                                 | GitHub Releases + prismoid.org |

Windows is the primary target. CI builds and tests Windows first.

## Auto-Updates

Tauri's built-in auto-updater checks GitHub Releases for new versions.

- Check at launch; an update found within the first seconds installs on its own behind a full-window update screen, then the app restarts
- Checks every 6 hours while running only nudge from the header and Settings; the install happens when the user asks for it
- The NSIS installer runs silently, so the app never shows an installer window
- Installers are signed with the updater key and the app refuses unsigned ones

## Build Pipeline

Tauri builds are produced by GitHub Actions CI on tagged releases. The release workflow:

1. Triggered by pushing a version tag (`v*`)
2. Builds for all three platforms (Windows, macOS, Linux) in parallel
3. macOS: builds both `aarch64-apple-darwin` and `x86_64-apple-darwin`
4. Signs and notarizes macOS builds
5. Uploads artifacts to GitHub Releases
6. Tauri auto-updater JSON is generated and attached

## Telemetry

Anonymous, opt-in only. Disabled by default.

Collected (when opted in):

- Crash/panic reports with stack traces
- Connection success/failure rates per platform
- Platform error frequencies
- Peak message throughput

Never collected:

- Message content
- User identifiers
- Chat data
- Account information

Likely Sentry free tier or similar hosted service. No self-hosted telemetry backend.
