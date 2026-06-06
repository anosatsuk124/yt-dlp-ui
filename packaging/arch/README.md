# Arch Linux package

`PKGBUILD` builds the native desktop app (`yt-dlp-ui-desktop-git`) from this
repository. It **uses the system `yt-dlp` / `ffmpeg`** (which always live in
`/usr/bin`) but **bundles its own `node`** — version managers like fnm/nvm are
not visible to GUI launchers, so relying on the launch PATH for node made the
app hang on its splash when started from GNOME. It opens **no network port**
(the Go downloader and Next.js server talk over a Unix socket) and installs
everything under `/usr/lib/yt-dlp-ui` with a single `/usr/bin/yt-dlp-ui`
launcher — nothing extra lands in `/usr/bin`.

```bash
cd packaging/arch
makepkg -si      # build + install
```

- **Runtime deps:** `webkit2gtk-4.1`, `gtk3`, `libsoup3`, `ffmpeg`, `yt-dlp`
- **Build deps:** `rust`, `cargo`, `go`, `npm`, `git`, `curl`

Notes:
- `build()` runs `npm`/`cargo` and downloads the official `node` runtime, all of
  which need the network (as is typical for `-git` packages).
- The bundled `node` (installed to `/usr/lib/yt-dlp-ui/bin/node`) is also used to
  build the production `node_modules`, so `better-sqlite3`'s native addon matches
  it. The app launches this node by absolute path — no PATH dependence.
- Finished downloads go to `~/Downloads/yt-dlp-ui`; the SQLite DB, cookies and
  certs live under the per-user app-data dir.
- Edit `_branch` in the `PKGBUILD` once the desktop work lands on `main` (or
  switch the `source=` to a release tag).
