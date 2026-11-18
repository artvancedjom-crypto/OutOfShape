# OutOfShape Lab

A browser-only learning studio that combines:

- **PLC simulation in 3D**: six classic automation exercises in a chunky toy-brick world, driven by a real IEC 61131-3 PLC engine that you program in Structured Text or Ladder Diagram.
- **Electronic circuit simulation**: standard teaching circuits solved with Modified Nodal Analysis, shown as live SVG schematics with an oscilloscope.
- **A note-taking PDF editor** (in the spirit of GoodNotes/Notability) that reads your documents, recognises when they describe one of the simulations, and launches it pre-configured with the document's values.

There is no backend and there are no paid services. Everything, including PDF parsing, matching, simulation and storage (IndexedDB), runs in the browser.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests: PLC engine, circuit solver, PDF matcher
npm run build      # static production build in dist/ (open via any static server)
npm run preview    # serve the production build
```

Requires Node 18+ and a modern desktop browser with WebGL (Chrome, Edge, Firefox or Safari).

### A 2-minute tour

1. **Library → ✨ Sample documents** adds five generated PDFs: a traffic-light lab sheet, an RC experiment, a tank spec, an electronics handout and a motor-control worksheet. Each card already shows its matched simulation and a confidence score.
2. Open **“Experiment – RC Time Constant”**. Draw with the pen (P) or highlighter (H), add a text box (T) and a shape (R), then use **⬇ Export PDF**.
3. In the right panel, expand **“Why?”** under *RC Charging & Discharging* to see the keyword hits and the extracted values (R = 22 kΩ, C = 47 µF, V = 9 V). Press **▶ Launch**. The circuit opens with those values, and **← Experiment…** takes you back to the same page.
4. **Simulation Lab → Traffic Light Intersection.** The solution program is already running. Press **🚶 First person** (or C) and walk around with WASD and the mouse. Click the yellow pedestrian button. Then open **Program ▾ → Exercise starter** and write your own controller.

## What's included

### 1. PLC scenarios (3D, toy-brick style)

| Scenario | Difficulty | What you practise |
|---|---|---|
| ⚙️ Motor start/stop with interlocks | Beginner | Seal-in circuit, NC stop, E-stop, thermal overload with a heat model (Ladder solution) |
| 🚦 Traffic light intersection | Intermediate | CASE state machine, timers, car-detection loops, pedestrian request, night flashing. The sim counts signal conflicts and crashes |
| 🛢️ Tank level control | Intermediate | Hysteresis (two-point) control, analog transmitter with adjustable noise, dry-run and overflow protection, auto/manual |
| 📦 Conveyor sorting station | Intermediate | Edge detection (R_TRIG), tracking latch, pneumatic pusher with limit switches, CTU counters, mis-sort detection |
| 🍾 Bottling line (fill & cap) | Advanced | Indexing step chain with parallel stations, level sensor, batch counter, "moved while capper down" detection |
| 🛗 3-floor elevator | Advanced | Call memory, direction preference, door cycle, interlocks and overtravel. You can ride the car in first-person mode |

Each scenario has a working solution, an exercise starter, objectives, an I/O assignment table (with `%I`/`%Q` addresses), tunable process parameters and HMI setpoints. Every process is physics-driven and reacts only to the PLC outputs; nothing is pre-animated.

**PLC workbench features**
- **Structured Text** editor with syntax highlighting, line numbers and error lines. Supported: `VAR`/`VAR CONSTANT`, `IF/ELSIF/ELSE`, `CASE` (ranges and constants), `FOR/WHILE/REPEAT/EXIT/RETURN`, arithmetic, boolean and bitwise operators, `T#1m2s500ms` literals, `ABS/MIN/MAX/LIMIT/SEL/…`, `*_TO_*` conversions, and the `TON/TOF/TP`, `CTU/CTD/CTUD`, `R_TRIG/F_TRIG` and `SR/RS` function blocks.
- **Ladder Diagram** editor:
  - NO/NC/P/N contacts in series and parallel branches.
  - Coil, negated coil, set and reset outputs.
  - TON/TOF/TP timers and CTU/CTD counters.
  - Live power-flow highlighting while running.
  - Compiles to ST; use "View generated ST" to see the result.
- **CPU modes**: RUN/STOP (outputs drop out in STOP), single-scan stepping, reset, and 0.25×–4× speed. The scan cycle is a fixed 20 ms of simulated time. A watchdog catches endless loops, and runtime faults show the offending line.
- **Live I/O panel**:
  - Inputs, outputs, internal variables, and timers/counters with ET/PT and CV/PV bars.
  - Manual push/toggle buttons.
  - **Forcing** of any I/O point (none → TRUE → FALSE).
- **Programs**: the working copy autosaves. You can also *Save*/*Save as*, export or import `.json`/`.st` files, and browse saved programs under Lab → My programs.
- **Cameras**: an orbit/pan/zoom overview, and a first-person mode with WASD, Shift to run, pointer-lock mouse look (drag-look fallback), collisions, and clicking scene buttons through the crosshair.

### 2. Circuits

Series–parallel divider · LED with series resistor (Shockley model, overcurrent warning) · RC charge/discharge (transient with oscilloscope and 63 % marker) · NPN transistor switch (Ebers–Moll model; shows the cut-off, active and saturation regions) · relay self-holding circuit (coil hysteresis, flyback diode, NO/NC poles).

Every circuit has sliders (E12-snapped log sliders for R and C), clickable switches and momentary push buttons, node-voltage probes, per-component V/I readouts, glowing loads, and animated current flow along the wires.

### 3. PDF → interactive simulation

- **Import**:
  - PDF files are parsed client-side with PDF.js.
  - PNG, JPG, WebP and GIF images, and TXT or Markdown files, are converted to PDF client-side with pdf-lib, so everything ends up in the editor.
  - Blank ruled, grid or dot notebooks can be generated.
- **Text extraction** runs per page, and you can view the extracted text in the panel.
- **Matching** is transparent:
  - Each scenario and circuit declares weighted keywords and regex parameter rules.
  - Score = Σ weight·(1 + log₂ count) + domain context, and confidence = 1 − e^(−score/10).
  - The panel lists every hit (term, count, weight, contribution) and every extracted value with the source snippet and the regex used.
- **Override and edit**:
  - You can edit any extracted value before launching.
  - You can link any page to any simulation manually.
  - Links appear as chips on the page and as dots on the thumbnails.
  - Values travel in the URL, so a reload keeps them, and the simulation shows a "← back to document" button.

### 4. Document editor

- **Tools**:
  - Pen with real pressure from styluses and simulated pressure for mice (perfect-freehand smoothing).
  - Multiply-blend highlighter.
  - Object eraser.
  - Text boxes with wrapping.
  - Rectangle, ellipse, line and arrow shapes (Shift for square or circle).
  - Image insertion.
  - Select, move, resize and delete.
- **Editing**: undo/redo (Ctrl+Z / Ctrl+Shift+Z), zoom (Ctrl+wheel, +/−, Fit), page thumbnails and navigation, and keyboard shortcuts (V P H E T R I).
- **Non-destructive layers**: annotations are stored separately from the untouched original PDF bytes, in PDF-point coordinates. You can create, rename, hide and delete layers.
- **Export** flattens the visible layers into a copy of the PDF with pdf-lib. Strokes become vector paths, highlights use multiply blending, text uses Helvetica, and images are embedded. Crop-box offsets are respected.
- **Persistence**: IndexedDB stores documents, original files, annotations, thumbnails, links and programs, so everything survives reloads.
- **Palm rejection**: once a stylus has been used, touch input stops drawing.

## Architecture

```
src/
  main.js                 app shell, nav, routes
  styles.css              design tokens, light/dark themes, all view styles
  core/                   framework-free infrastructure
    db.js                 IndexedDB wrapper (docs, files, annotations, programs, thumbs)
    dom.js                h() element helper, toast, modal, prompt, unit formatting
    router.js             hash router (#/library, #/doc/:id, #/lab, #/plc/:id, #/circuit/:id)
    bus.js, theme.js      event bus, theme persistence
  plc/                    PLC engine (no DOM or Three.js dependencies, unit-tested in Node)
    st-lexer.js           tokens, time literals
    st-parser.js          recursive-descent parser → AST
    st-compiler.js        static checks + compile AST → JS closures
    function-blocks.js    TON/TOF/TP/CTU/CTD/CTUD/R_TRIG/F_TRIG/SR/RS
    ladder.js             ladder model + ladder → ST compiler
    runtime.js            process image, forcing, scan cycle, watchdog
  circuits/               circuit layer
    mna.js                MNA solver: Newton–Raphson + damping, backward-Euler transient
    library.js            circuit definitions (netlist + schematic layout + params + match rules)
    schematic.js          SVG renderer with live readouts and current animation
  three/                  3D layer
    bricks.js             studded brick geometry kit (merged + cached), lamps, buttons, labels
    world.js              renderer, lighting, baseplate, orbit + FPS cameras, picking, collisions
  scenarios/              one module per PLC exercise + registry (index.js)
  docs/                   document layer
    pdf.js                PDF.js loading, text extraction, txt/image/notebook → PDF
    store.js              import pipeline + persistence API
    matcher.js            transparent keyword/regex matcher
    annotations.js        annotation model, canvas rendering, hit tests, pdf-lib export
    samples*.js           built-in sample documents
  ui/                     reusable widgets: ST code editor, ladder editor, live I/O panel
  views/                  library, lab browser, PLC workbench, circuit lab, document editor
tests/                    node:test suites for the PLC engine, circuit solver and matcher
```

**Key decisions**

- **Vanilla ES modules, Vite, Three.js, PDF.js, pdf-lib and perfect-freehand.** No UI framework: the views are small and imperative, and the heavy parts (3D, PDF, solvers) are framework-agnostic anyway. This keeps the bundle and the mental model small.
- **The PLC engine is a compiler, not a canned animation.** ST is parsed to an AST and statically checked (undeclared variables, unknown FB pins, writes to inputs or constants), then compiled to closures. Ladder diagrams compile to ST, so both languages share one runtime, and the generated ST is visible to the learner.
- **Process models are separate from the PLC.** Each scenario's `update(dt)` reads only PLC outputs and writes only sensor inputs. The view interleaves process and scan at a fixed 20 ms step, so behaviour doesn't depend on frame rate (rendering is decoupled in `render(dt)`).
- **The circuit solver is general-purpose.** Circuits are data (netlist + layout), and new circuits need no solver changes.
- **Annotations live in PDF points, outside the PDF**, which makes them resolution-independent, non-destructive, and straightforward to flatten.

### Extending

- **New PLC scenario**: copy `src/scenarios/motor.js`. Define `io`, `params` (a param with `input:` feeds an HMI setpoint), `programs`, `match` and `build(world, io, params) → { reset, update, render, status }`, then add it to `scenarios/index.js`. It appears in the lab, the matcher and the link dialog automatically.
- **New circuit**: add an entry to `circuits/library.js` with components (with `sch` placement), wires, probes, params, readouts and match rules.
- **New import format**: extend `fileToPdfBytes` in `docs/store.js`.

## Status: what is complete and what is limited

**Complete and tested end to end (headless Chromium plus unit tests):**
- Open a scenario, switch cameras, edit and run ST or ladder, and watch the 3D process react.
- The I/O panel and forcing.
- Saving programs.
- The circuit lab.
- Importing a PDF, annotating it, exporting it flattened, and launching the matched simulation with extracted parameters.
- Manual links.
- Persistence across reloads.
- Dark and light themes.

**Known limitations**
- The ST subset has no arrays, structs, user-defined functions or function blocks, `POINTERs`, or multiple tasks/POUs. Ladder has no compare or math boxes; use ST for those (a ladder program can be switched to its generated ST).
- Circuits are DC operating point plus transient only (no AC/frequency analysis or sine sources). The schematic layouts are fixed per circuit; there is no free-form schematic drawing.
- PDF pages with a `/Rotate` entry are displayed and annotated unrotated. Scanned PDFs without a text layer can't be matched automatically (no OCR), but you can still link them manually.
- Text annotations use the standard Helvetica font on export (WinAnsi characters only; others are transliterated). The eraser removes whole objects (no partial erasing), and there is no lasso selection.
- Office formats (DOCX/PPTX) are not imported. Export them to PDF first.
- First-person mode uses pointer lock. In embedded or iframe contexts where that is blocked, it falls back to drag-to-look.
- For debugging, the PLC view exposes `window.__oos = { world, rt, sim }`.
