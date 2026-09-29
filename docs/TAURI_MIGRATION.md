# Tauri desktop migration

Meridian’s window and renderer transport move from Electron to Tauri 2. The existing unframeworked DOM UI remains in place and is bundled with Vite. Tauri Rust commands proxy renderer calls to a Node sidecar over a random loopback port; the sidecar accepts only registered legacy IPC channels and requires a per-launch token. Its listener is bound to `127.0.0.1`, and the browser never talks to an unauthenticated local HTTP endpoint.

The sidecar deliberately retains the existing JavaScript domain layer, Node built-in SQLite store, capture/extraction code, scheduler, local agent server, optional sync service, and IPC handler set. This is a transitional compatibility architecture rather than a full Rust rewrite. It reduces behavior and data-migration risk while replacing Electron’s Chromium-based host and preload boundary; the Node backend runtime still has to ship with release builds.

## Data and supported platforms

The Tauri host explicitly reuses the historical `脉络` user-data directory:

- macOS: `~/Library/Application Support/脉络`
- Windows: `%APPDATA%\脉络`

Existing `meridian.json`, `meridian.sqlite`, raw JSONL, sync outbox, and local service files stay in that directory. A sidecar integration test launches against a pre-existing version-4 JSON ledger and checks that its theme remains readable.

Only macOS and Windows are release targets. Build on the target operating system and architecture so the staged Node runtime matches the bundle. macOS builds require Apple’s command-line build tools; Windows builds require the MSVC C++ toolchain and WebView2. Cross-compiling a release bundle from Linux is not configured.

## Runtime size and trade-off

The packaged Node 24.19.0 executable measured **125,989,464 bytes (about 120.1 MiB) uncompressed** and **44,325,482 bytes (about 42.3 MiB) with gzip -6** on the Linux build computer. The staged runtime is generated only for release packaging and is not committed. Actual DMG/NSIS sizes will vary with target architecture and installer compression; they have not been measured here.

This binary is a real cost of the compatibility sidecar. The migration removes Electron’s bundled Chromium but does not make the app intrinsically small; it still ships a Node runtime and keeps two runtimes (Rust/Tauri and Node) in the application. A later size-focused phase could port storage and domain services to Rust, or use a carefully maintained smaller Node build, but neither is included because either changes persistence or runtime behavior materially.

## Build and checks

```bash
npm install
npm test
npm run tauri:dev       # requires native Tauri prerequisites
npm run tauri:prepare   # stages this machine’s Node runtime under src-tauri/runtime
npm run tauri:build     # packages DMG on macOS or NSIS installer on Windows
```

The `test/tauri-backend.test.mjs` integration test covers loopback authentication, command allowlisting, legacy JSON loading, and event polling. `test/tauri-bridge.test.mjs` checks renderer API/channel compatibility, and `test/tauri-config.test.mjs` verifies bundle resource paths and targets. `npm run build:ui` can be run without native desktop libraries. Full `.dmg` and Windows installer validation requires the respective OS and toolchains.

## Not yet migrated or verified

- Domain logic remains JavaScript/Node; it has not been ported to Rust.
- Full native macOS vibrancy, Dock badge, and Electron-specific title-bar behavior are not replicated.
- The scheduler emits native Tauri notifications, but notification click-to-focus behavior is not yet wired to the prior Electron callback.
- The built-in HTTP/MCP ingestion server and opt-in sync endpoint are preserved through the sidecar but were not end-to-end retested against external clients in this migration.
- The existing service deployment scripts target a separate Linux service and are not part of the macOS/Windows desktop bundle.
- macOS and Windows app builds, signing, notarization, SmartScreen behavior, and measured installer sizes remain unverified in this Linux environment.
