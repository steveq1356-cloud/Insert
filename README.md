# InsertPress Planner

Load an STL, pick the holes that get heat-set inserts, and download G-code for
a GRBL 1.1 insert press. Runs entirely in the browser: no install, no build step,
no server.

![Screenshot](docs/screenshot.png)
<!-- Add a screenshot: load the example block, click "Use all found", save as docs/screenshot.png -->

## Try it

- **Locally:** open `index.html` in Chrome, Firefox, or Edge. An internet
  connection is needed the first time so Three.js can load from jsDelivr.
- **GitHub Pages:** push this repo, then Settings → Pages → Deploy from branch →
  `main` / root. The app will be at `https://<you>.github.io/<repo>/`.

Click **Try the example block** to see it work without your own part.

If Three.js can't load (offline, or a network that blocks CDNs), the app
switches to a 2D top view. Picking, placing, and G-code all still work.

## Workflow

The sidebar walks through four steps: **Part**, **Holes**, **Machine**, **Export**.

1. **Open STL** (or drag one onto the view). Use **Turn 90°** until the side
   with the insert holes faces up. Set **File units** to inches if your CAD
   exported in inches.
2. Insert-sized holes that open upward are found automatically and shown as
   white rings. Click a ring (or its row) to add it to the press order. Brass
   number tags show the order.
3. **Place by hand** lets you click any flat top surface to add a hole the
   finder missed.
4. Drag the number tags to reorder, or press **Shortest path**.
5. Pick the insert size per hole. Sizes are guessed from the hole diameter.
   Click a row to set a per-hole finish depth.
6. Tune feeds and heights on **Machine**, then check **Export** for warnings and **Download G-code**.
7. **Save job** writes a small `.ipjob.json` with your picks and settings.
   **Open job**, then open the same STL, to pick up where you left off.

## Machine setup this G-code assumes

| What | Convention |
|---|---|
| X0 Y0 | Inside corner of the fence. The part is pushed into the corner. |
| Z0 | Tip touching the bed with the spring float relaxed (paper test). |
| Units / mode | `G21 G90`, work coordinates `G54` |
| Float sensor | Wired to the GRBL probe pin (A5) |

Set the origin once per session, for example: jog the tip into the fence
corner and run `G10 L20 P1 X0 Y0`, then touch off on the bed and run
`G10 L20 P1 Z0`.

Each hole runs this sequence:

```
G0 X.. Y..             travel at clear height
(MSG,...) M0           pause: place the insert, then Cycle Start
G0 Z(H + L + gap)      drop to just above the insert
G38.3 Z(H - sink) F..  press; halts early if the float sensor trips
G4 P..                 hold at depth while the plastic sets around the knurl
G1 Z.. F..             slow lift off the insert
G0 Z(clear)            back to travel height
```

`H` is the surface height at the hole (from the model), `L` is the insert
length, and clear height is part top + longest insert + clearance. With the
spring float, the carriage reaches the target ahead of the melt and the
springs keep pushing during the dwell, so the insert catches up.

**Z only mode** is for the press head before the gantry exists: no X/Y moves,
and the job pauses at each hole with its coordinates so you can slide the
part under the tip.

**First run:** do an air pass with the iron cold and Z0 set 20 mm above the
bed, then a test print with one hole, before running a real part.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Finish below surface | 0.1 mm | Per-hole override in the hole row |
| Slow down above insert | 1 mm | Gap above the insert top where press feed starts |
| Press speed | 60 mm/min | Lower for big inserts or PETG |
| Hold at depth | 2 s | |
| Slow lift | 2 mm at 120 mm/min | |
| Clearance | 5 mm | Above the tallest insert top |
| Travel | 200 × 200 mm | Holes outside this are errors and block export |
| Hole finding | 2.5–7 mm | Diameter range treated as insert holes |

Settings are remembered in the browser and saved inside job files.
Insert sizes live in `js/gcode.js` (`INSERTS`). Edit them to match the inserts
you buy.

## How hole finding works

STL files are only triangles, so holes are found geometrically: near-vertical
triangles are grouped into connected wall patches, each patch gets a circle
fit, and a patch counts as a hole when it is round, wraps most of the way
around, and its normals face the axis (a round boss faces outward and is
skipped). If any material covers the hole's center above its top, it opens
downward and is skipped. Blind holes are flagged when they are shorter than
the insert.

Limits: holes must be vertical in the chosen orientation; very low-poly
exports (under about 8 segments per circle) or holes cut by other features
may be missed. Place those by hand.

## Project layout

```
index.html          page shell
css/style.css       styles
js/stl.js           STL parsing, rotation, placement in the fence corner
js/holes.js         hole detection
js/gcode.js         insert sizes, defaults, checks, G-code, path ordering
js/viewer.js        Three.js view and picking
js/viewer2d.js      2D top-view fallback with the same interface
js/app.js           UI state and wiring
js/example.js       built-in example block
examples/           example-block.stl
test/run-tests.js   Node tests for the core logic
tools/              example STL generator
```

## Tests

```
node test/run-tests.js
```

No dependencies. Covers STL parsing, detection on the example block in
several orientations, insert guessing, G-code output, and path ordering.

## Roadmap

- Per-hole surface touch-off for parts that warp
- Warn on holes too close to a wall for the iron's tip
- Feeder support: pick-up moves instead of load pauses
- STEP/3MF import

## License

MIT
