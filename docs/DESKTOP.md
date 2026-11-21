# OutOfShape Lab as a Windows desktop app

The same codebase runs three ways:

| How | Command | Data lives in |
|---|---|---|
| Browser (development) | `npm run dev` | the browser's IndexedDB for `localhost:5173` |
| Browser (static site) | `npm run build`, then host `dist/` | the browser's IndexedDB for that site |
| Windows desktop | `npm run dist` → files in `release/` | portable: `data\` next to the app; installed: `%APPDATA%\OutOfShape Lab` |

Use **⚙ → Export all data / Import data** to move everything between them (see [Backup](#backup-and-moving-data)).

## Why Electron and not Tauri

| | Electron (chosen) | Tauri 2 |
|---|---|---|
| Rendering engine | Chromium, shipped inside the app | Microsoft Edge **WebView2**, taken from the PC |
| Runtime needed on the target PC | none | WebView2 Runtime. Present on Windows 11 and on most updated Windows 10 PCs, but not guaranteed (LTSC, stripped or offline school/company images). Installing it needs a download or a bundled 180 MB installer, and normally admin rights |
| Download size | about 105–145 MB (measured below) | about 10–15 MB (plus WebView2 if missing) |
| Cold start | about 1–2 s installed or from the ZIP folder; several seconds for the single-file portable .exe (it unpacks itself first) | under 1 s |
| WebGL / Three.js | same engine and GPU path as desktop Chrome, identical on every PC | same Chromium family through WebView2, but the version is whatever the PC has |
| PDF.js and pdf-lib | exactly the engine the app was developed and tested on | work in WebView2 as well; behaviour follows the installed version |
| Data next to the .exe | one call (`app.setPath('userData', …)`) moves IndexedDB and all caches | possible (WebView2 user-data folder), more setup |
| Build tooling | Node.js only | Node.js + Rust toolchain + MSVC build tools (several GB) |

The decisive points for this app are the portable requirement and predictability. A USB-stick version must start on a PC where you have no admin rights and cannot install anything; Electron needs nothing from the host, Tauri needs WebView2 to be there already. A 3D + PDF app also benefits from running on one known browser engine instead of whichever WebView2 version a machine happens to have. The price is download size (100 MB or more on top) and a slower start for the single-file .exe. If size ever matters more than the no-runtime guarantee, the web build and the platform layer (`src/platform/`) carry over to Tauri unchanged; only `electron/` would be replaced.

## What gets built

`npm run dist` writes these files to `release/` (version taken from `package.json`):

| File | What it is | Expected size |
|---|---|---|
| `OutOfShape-Lab-1.0.0-win-x64-portable.zip` | Portable folder. Unzip anywhere (USB stick, Downloads) and start `OutOfShape Lab.exe`. Recommended portable form: starts fast | 144 MB (measured) |
| `OutOfShape-Lab-1.0.0-win-x64-portable.exe` | Portable single file. Unpacks itself to a temp folder on every start, so it takes longer to open, especially from a slow stick | 104 MB (measured) |
| `OutOfShape-Lab-1.0.0-win-x64-setup.exe` | One-click installer (NSIS). Per-user, no admin rights, Start-menu entry, desktop shortcut, uninstaller | about 115 MB (estimate) |
| `SHA256SUMS.txt` | Checksums of the files above | under 1 KB |

Unzipped or installed, the app takes about 315 MB on disk. Almost all of that is the Electron 45 runtime (the .exe alone is 250 MB); the app itself is about 6 MB.

## Build on Windows, from a fresh clone

Requirements: Windows 10/11 x64, [Node.js 22 or newer](https://nodejs.org), [Git](https://git-scm.com/download/win), and an internet connection for the first build (it downloads Electron and the NSIS tools once, about 150 MB, into `%LOCALAPPDATA%\electron\Cache` and `%LOCALAPPDATA%\electron-builder\Cache`).

In PowerShell (use `npm.cmd` instead of `npm` if PowerShell blocks scripts):

```powershell
git clone https://github.com/artvancedjom-crypto/OutOfShape.git
cd OutOfShape
npm.cmd install
npm.cmd test              # optional: 14 unit tests
npm.cmd run desktop       # optional: build the web app and start it in the desktop shell, unpackaged
npm.cmd run dist          # portable .exe + portable .zip + installer → release\
```

Single targets:

```powershell
npm.cmd run dist:portable     # only the portable .exe and .zip
npm.cmd run dist:installer    # only the installer
```

If the build stops with *"Cannot create symbolic link: A required privilege is not held by the client"* while it unpacks `winCodeSign`, turn on **Developer Mode** (Windows Settings → System → For developers) or run that one build from an administrator PowerShell. This is a known electron-builder issue on Windows and only affects the first build.

To release a new version, change `"version"` in `package.json` and run `npm.cmd run dist` again. The version appears in the file names, the window's About dialog and the installer.

## Where the data is stored

The decision is made in `electron/main.cjs` before the app starts:

1. **Portable single .exe**: the launcher reports the folder it was started from; data goes to `data\` in that folder.
2. **Portable ZIP folder**: the folder contains a marker file `portable.flag` next to the .exe; data goes to `data\` in the same folder. Delete the marker and the app behaves like an installed copy.
3. **Installed**: `%APPDATA%\OutOfShape Lab` (the normal per-user location).

`data\` holds everything: documents, original PDFs, annotations, saved PLC programs (all inside `data\IndexedDB`), the theme, window size and position, settings and Chromium's caches. Take the whole app folder to another PC and the data comes along. Both portable forms use the same `data\` folder when they sit side by side.

If the portable folder is not writable (read-only stick, or the folder was copied into `C:\Program Files`), the app says so at start and stores data in the user profile for that session.

Uninstalling the installed version keeps `%APPDATA%\OutOfShape Lab`, so documents survive a reinstall or update. Delete that folder by hand to remove the data too. **⚙ → Open data folder** shows it.

The window position is saved with the data. On a different PC or monitor setup an off-screen position is ignored and the window opens on the main screen.

## Backup and moving data

**⚙ → Export all data (ZIP)…** writes one file, `OutOfShape-Lab-backup-<date>.zip`, containing all documents with their original PDFs, annotations and layers, document links, saved PLC programs and working copies, thumbnails and the theme. **⚙ → Import data…** reads it back and offers:

- **Merge**: keeps what is there and adds the backup. Items present in both are replaced by the backup copy.
- **Replace everything**: clears the app's data first.

The format is the same in the browser, portable and installed versions, so this is the way to move from one to another. The archive is plain: `manifest.json`, `docs.json`, `annotations.json`, `programs.json`, `thumbs.json`, `settings.json` and `files/<id>.pdf`.

## Opening PDFs from outside

- **File → Open document…** (Ctrl+O) or **⚙ → Open document…**: native file dialog; the file is imported into the library and opened.
- **Drag a file onto the window**: imported and opened, from any view.
- **Drag a file onto `OutOfShape Lab.exe` or its shortcut**, or run `"OutOfShape Lab.exe" C:\path\file.pdf`: the app starts and opens it. If the app is already running, the existing window takes the file.

The installer does not register the app as a PDF handler, so it never changes which program opens PDFs on double-click.

## Offline behaviour

Nothing is loaded from the network at runtime:

- The web build is served from inside the app through a private `app://` address. No local web server runs and no port is opened. This also avoids the usual `file://` problems: ES modules, the PDF.js worker and relative asset paths load exactly as they do from a web server, and the data's storage address does not depend on the folder the app sits in.
- The PDF.js worker, its character maps and its standard fonts are part of the build (`scripts/copy-pdf-assets.mjs` copies them into `public/pdfjs/` before every build).
- The interface uses fonts already on the PC. The 3D scenes are generated in code; there are no texture or model files to fetch.
- A content security policy in the shell blocks every outside address.

The one exception is the optional update check.

## Update check (off by default)

**⚙ → Check for updates…** asks GitHub for the newest release of the repository named in `package.json` → `repository` and compares it with the running version. If there is a newer one it offers to open the release page; it never downloads or installs anything by itself. **⚙ → About** has a checkbox to run this check at every start. It is off unless ticked.

For it to find anything, publish a GitHub Release whose tag is the version (`v1.0.1`) and attach the files from `release/`. With a private repository the check reports that no public release was found.

## Unsigned builds: SmartScreen, and what signing takes

The builds are not code-signed. What users see:

- **Downloaded .exe (installer or portable):** a blue window, *"Windows protected your PC – Microsoft Defender SmartScreen prevented an unrecognized app from starting"*, publisher *Unknown publisher*. Click **More info**, then **Run anyway**. It appears once per downloaded file.
- **Downloaded ZIP:** Windows marks the ZIP as coming from the internet and passes that mark to the files inside when you extract with Explorer, so the same blue window appears at first start. To avoid it, right-click the ZIP **before** extracting → **Properties** → tick **Unblock** → OK.
- **Copied from a USB stick or a network share** (not downloaded with a browser): usually no warning at all.
- **Managed PCs** (school or company) may block unknown programs completely (Smart App Control on Windows 11, AppLocker, WDAC). There is no way around that from the user's side; the browser version still works there.
- Some antivirus programs flag unsigned, freshly built Electron apps, most often the self-extracting single-file portable .exe. See [Troubleshooting](#troubleshooting).

What signing would need later:

1. A code-signing certificate issued to you or your organisation (identity check required). Options:
   - **Azure Trusted Signing**: a Microsoft cloud service, monthly fee, no hardware. Availability depends on country and on whether you sign as a company or an individual.
   - **OV certificate** from a certificate authority: yearly fee. The private key must be on a hardware token or in a cloud HSM.
   - **EV certificate**: more expensive, stricter identity check.
2. Configuration: the place is prepared in `scripts/builder-config.mjs` under `win:` with the three variants commented (`CSC_LINK`/`CSC_KEY_PASSWORD` environment variables, `signtoolOptions`, `azureSignOptions`). Nothing else in the build changes; electron-builder signs the app, the installer and the uninstaller.
3. Signing removes *Unknown publisher*. SmartScreen's warning for a new publisher fades as downloads accumulate; an EV certificate no longer skips that step automatically.

## Troubleshooting

**Blank or white window**
- Press **Ctrl+Shift+I** (or View → Toggle Developer Tools) and look at the Console tab; the red message names the cause.
- *"The web build is missing"* at start, or `Not found: /index.html`: `dist/` was not built before packaging. Run `npm.cmd run dist` (it builds the web app first); do not call electron-builder directly.
- After an update the window stays white: start once with the cache cleared by deleting `Cache`, `Code Cache` and `GPUCache` in the data folder (not `IndexedDB`, that is your data).
- Window not visible at all: the app is running off-screen or behind another window. Delete `window-state.json` in the data folder.

**PDF pages stay empty, or "Setting up fake worker failed"**
- The PDF.js worker file is missing from the build. Check that `dist\assets\pdf.worker.min-*.mjs` exists after `npm.cmd run build`; if not, delete `node_modules` and run `npm.cmd install` again.
- Text in a PDF shows as boxes or is missing: `dist\pdfjs\cmaps` and `dist\pdfjs\standard_fonts` are missing. They are copied by the `prebuild` step, which only runs through `npm run build`, not through a bare `npx vite build`.

**3D view is black, or "WebGL is not available"**
- Update the graphics driver, then restart the app.
- Remote Desktop sessions and virtual machines often have no GPU. Start the app with software rendering: `"OutOfShape Lab.exe" --use-angle=swiftshader --enable-unsafe-swiftshader` (slow, but it works).
- Driver crashes or flicker: try `"OutOfShape Lab.exe" --disable-gpu-compositing`, or `--use-angle=d3d9` on very old graphics chips.
- To see what the engine detected, open Developer Tools and run `document.createElement('canvas').getContext('webgl2')`; `null` means WebGL is off.

**Antivirus removes or blocks the .exe**
- This is a false positive typical for unsigned, self-extracting programs. Prefer the **portable ZIP** or the **installer** over the single-file portable .exe; they are flagged far less often.
- Compare the file with `release\SHA256SUMS.txt` (`Get-FileHash file.exe` in PowerShell) to be sure it is the file you built.
- Add an exclusion for the app folder in the antivirus, or restore the file from quarantine.
- You can report the false positive to the vendor (Microsoft: `https://www.microsoft.com/wdsi/filesubmission`). Code signing is the lasting fix.

**The portable version forgot my data**
- The app was started from inside the ZIP without extracting it (Explorer runs it from a temp folder). Extract the ZIP first.
- The folder is not writable; the app shows a warning at start in that case. Move it out of `Program Files` or off the read-only medium.
- The single-file .exe was moved to another folder without its `data\` folder. Move both together.

**"npm" is not recognised / scripts are disabled** – see the main README: use `npm.cmd`, or allow local scripts with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## What was tested, and what was not

Tested in a Linux container (no Windows machine was available):

- **The desktop shell, running for real** (Electron 45 for Linux, same `electron/` and `dist/` code, driven by an automated script):
  - loads from `app://local` with the correct window title and no console errors;
  - makes no request to any outside address;
  - renders PDFs through the bundled worker and runs a 3D PLC scenario;
  - stores IndexedDB, settings and `window-state.json` in the chosen data folder, and finds the documents again after a restart;
  - restores window size and position;
  - exports an annotated PDF and a backup ZIP through the save dialog (the dialog itself was replaced by a stub that returns a path);
  - imports that backup into a second, empty data folder with the annotations intact;
  - opens a PDF given on the command line.
- **Windows packaging, cross-built:** `portable.exe` (104 MB) and `portable.zip` (144 MB) were produced, with `portable.flag` next to the .exe and no `node_modules` inside the app archive. For the installer, the NSIS script compiled and the 114 MB payload was packed, but the final step (creating the uninstaller) needs Wine off Windows, so no finished `setup.exe` was produced. Its size above is an estimate from the payload.
- **Browser version:** unit tests, plus import, backup export and backup import through the new platform layer.

**Not tested: anything that needs Windows itself.**

- Starting any of the three Windows files. The Windows binaries were built but never run.
- The portable data folder on Windows: the `PORTABLE_EXECUTABLE_DIR` path of the single .exe and the `portable.flag` path of the ZIP folder. The data-folder logic was exercised only through the `OOS_DATA_DIR` override.
- Running the installer: shortcuts, Start-menu entry, uninstall, install time.
- The app icon inside the .exe and installer (embedding it requires a Windows build), and how the generated `icon.ico` looks in Explorer at small sizes.
- Dragging a file onto the .exe or shortcut, and passing a file to an already running app on Windows.
- Real native file dialogs (stubbed in the test).
- SmartScreen and antivirus behaviour, described above from how Windows normally treats unsigned programs.
- The update check against a real published release. With no release it reports "no public release found".
- Startup times; the figures in the comparison table are typical values, not measurements of this app.
