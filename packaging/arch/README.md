# Arch Linux package

`PKGBUILD` builds the native desktop app (`yt-dlp-ui-desktop-git`) from this
repository. Unlike the cross-platform bundles it **depends on the system
`yt-dlp` / `ffmpeg` / `nodejs`** instead of vendoring them, opens **no network
port** (the Go downloader and Next.js server talk to the app over a Unix
socket), and installs everything under `/usr/lib/yt-dlp-ui` with a single
`/usr/bin/yt-dlp-ui` launcher — nothing extra lands in `/usr/bin`.

```bash
cd packaging/arch
makepkg -si      # build + install
```

- **Runtime deps:** `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `nodejs`, `ffmpeg`, `yt-dlp`
- **Build deps:** `rust`, `cargo`, `go`, `npm`, `git`

Notes:
- `build()` runs `npm` and `cargo`, which fetch dependencies over the network
  (as is typical for `-git` packages).
- The production `node_modules` are built with the system `node`, so the
  `better-sqlite3` native addon matches the runtime node ABI.
- Finished downloads go to `~/Downloads/yt-dlp-ui`; the SQLite DB, cookies and
  certs live under the per-user app-data dir.
- Edit `_branch` in the `PKGBUILD` once the desktop work lands on `main` (or
  switch the `source=` to a release tag).
