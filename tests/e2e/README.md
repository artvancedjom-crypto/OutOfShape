# End-to-end tests

These scripts drive the real app in a headless Chromium (Playwright) and check it with real mouse and keyboard input.

| File | What it checks |
|---|---|
| `01-circuit-editor.cjs` | Build a circuit from nothing: place, wire, junctions, value dialog (`4k7`), undo/redo, move with attached wires, rotate, mirror, reshape wires, box select, copy/paste, error display, net labels, probes, hover values, zoom, persistence, templates (reset, save as) |
| `02-editor-extras.cjs` | Alt placement off the grid, right-angle routing, panning, values from a document applied to a template, momentary push buttons, circuits inside the backup ZIP |
| `03-current-flow.cjs` | Particles (WebGL), log scaling, sensitivity, flow direction, potential and power overlays, overload, burn-out and repair, a 200-part circuit |
| `04-catalog.cjs` | Catalog browsing, variant form with validation and curve preview, favourites, subcircuit, JSON export/import |
| `05-document-embeds.cjs` | Embed a circuit in a document, jump in, change a value, apply, return to the same place; undo/redo; draft marker; discard; new version; linked embeds; PLC scene; PDF export |

Run them:

```bash
npm i -D playwright
npx playwright install chromium
npm run test:e2e            # all
npm run test:e2e -- 05      # one file
```

Screenshots and exported files land in `tests/e2e/out/` (not committed). `05` also calls `pdftotext`, `pdfimages` and `pdftoppm` (Poppler) to inspect the exported PDF; without Poppler that last step fails.
