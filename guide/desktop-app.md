# Desktop app

The same console also ships as a Windows x64 desktop app (Electron): one window instead of a browser tab, with the server running inside the app. It is the same code and the same `%APPDATA%\andromedacli` settings, so nothing changes in how you use it; closing the window asks first when agents are running, then stops everything. Like the console, it only uses the PATH it was started with.

| Command | What it does |
|---|---|
| `npm run build:app` | Bundles the UI, the server and the shipped folders into `out/` |
| `npm run dist:dir` | An unpacked app in `release/win-unpacked` |
| `npm run dist` | The same, plus the NSIS installer |
| `npm run smoke:app` | Starts the unpacked app with the fake agent and checks the window, a terminal, Options and that nothing is left after closing (run `dist:dir` first) |

Pushing a tag `v<version>` runs `.github/workflows/release.yml`, which builds the installer and publishes it as a GitHub release. The installer is not code-signed, so Windows SmartScreen may warn. The app looks at the GitHub releases for a newer version and shows a chip in the status bar (download, then restart); you can also run the new installer over the old one (settings and projects stay).
