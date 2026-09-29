# Tauri desktop migration

Meridian is a Tauri 2 desktop app for **macOS and Windows**. The renderer remains an unframeworked DOM UI bundled by Vite. Rust exposes a small, authenticated loopback bridge to a Node sidecar; the sidecar registers and invokes named domain commands through `CommandRegistry`. Domain handlers receive only their declared arguments and depend on explicit runtime services—not on a simulated desktop API or a windowing framework. The Tauri renderer adapter owns native clipboard, external-link, data-directory, global-shortcut, notification, and window operations.

The application continues to use the existing JavaScript domain layer, Node built-in SQLite store, capture/extraction pipeline, scheduler, local agent server, and optional sync service. The split is intentional: Tauri owns desktop capabilities; domain services own application behavior and persistence; transport adapters connect them. JSON/SQLite/JSONL formats and existing command behavior remain unchanged.

## Data and supported platforms

The Tauri host explicitly reuses the historical `脉络` user-data directory:

- macOS: `~/Library/Application Support/脉络`
- Windows: `%APPDATA%\脉络`

Existing `meridian.json`, `meridian.sqlite`, raw JSONL, sync outbox, and local service files stay in that directory. The sidecar integration test starts from a pre-existing version-4 JSON ledger and confirms the theme remains readable. JSON continues to be used when no SQLite file exists; an existing SQLite database remains the authoritative store.

Only macOS and Windows are release targets. Build on the target operating system and architecture so the staged Node runtime matches the bundle. macOS builds require Apple’s command-line build tools; Windows builds require the MSVC C++ toolchain and WebView2. Cross-compiling a release bundle from Linux is not configured.

## Runtime size

The packaged Node 24.19.0 executable previously measured **125,989,464 bytes (about 120.1 MiB) uncompressed** and **44,325,482 bytes (about 42.3 MiB) with gzip -6** on the Linux build computer. The staged runtime is generated only for release packaging and is not committed. Actual DMG/NSIS sizes vary with target architecture and installer compression.

The Node runtime remains a material bundle cost, alongside the Tauri host. Replacing or removing it would require a separate runtime and persistence migration, and is outside this desktop-boundary refactor.

## Build and checks

```bash
npm install
npm test
npm run build:ui
npm run tauri:dev       # requires native Tauri prerequisites
npm run tauri:prepare   # stages this machine’s Node runtime under src-tauri/runtime
npm run tauri:build     # packages DMG on macOS or NSIS installer on Windows
```

The sidecar integration test covers loopback authentication, command allowlisting, legacy JSON loading, and event polling. The bridge test checks renderer API coverage and native desktop adapters; the configuration test verifies resource paths and macOS/Windows-only bundle targets. A Linux Rust/Tauri compile check validates the host code when its native prerequisites are installed, but Linux is not a supported release target. Full `.dmg` and Windows installer validation, signing, notarization, SmartScreen behavior, and installer sizes require the respective OS and toolchains.

## Remaining limitations

- Domain logic remains JavaScript/Node; it has not been ported to Rust.
- macOS vibrancy, Dock badges, and some platform-specific title-bar styling are not implemented by the current Tauri host.
- Scheduled notifications are delivered by Tauri, but notification click-to-focus behavior is not yet wired.
- The HTTP/MCP ingestion server and opt-in sync endpoint are preserved through the sidecar but still need end-to-end validation against external clients.
- The separate Linux service deployment scripts are not part of the macOS/Windows desktop bundle.
- macOS and Windows desktop builds have not been validated in a Linux-only environment.
