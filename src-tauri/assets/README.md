# Claudia app icon

`claudia-app-icon.png` is the 1024×1024 source for the application/tray icon — three
overlapping rounded tiles in the app's own accent colour (`--color-accent` / `--color-bg` from
`web/src/nocturne.css`), standing in for "several session tiles supervised at once" rather than
a literal letterform. Generated programmatically (Pillow), not hand-drawn — feel free to replace
it with real artwork.

Regenerate the platform icon set from `src-tauri/`:

```bash
npx --yes @tauri-apps/cli@2.11.2 icon assets/claudia-app-icon.png --output icons
```

The generator also emits iOS/Android/Windows-Store assets this desktop-only app doesn't ship;
delete `icons/android/` and `icons/ios/` afterwards (`icons/Square*Logo.png` and
`icons/StoreLogo.png` are harmless and already gitignored — see `../../.gitignore`).

`loading.html` in this same directory is the splash shown while the shell decides whether to
attach to an already-running Claudia or spawn one — served from the `claudia-splash://` custom
protocol registered in `src/main.rs`, not through `web/dist`, so it never depends on the web
workspace being built.
