# AM Transition Tool — Developer Handover

Status: 2026-07-06 · Version 1.0.0 · `minimumApiVersion` 1.0.0 · internal name (folder/npm package) `am-transition-tool`

> Tested in Live and approved by the user. This document describes the **current**
> implementation only — see git history for how it got here. User-facing
> description (what the tool does, why some things work the way they do) lives in
> [`README.md`](README.md); this document is for continuing development.

---

## 1. What it does

Right-click an **arrangement time selection** (`AudioTrack.ArrangementSelection` /
`MidiTrack.ArrangementSelection`) → **"Create transition…"**. The marked time
range (`time_selection_start`/`time_selection_end`, beats) defines the transition's
exact length — independent of clip boundaries, no cutting required. The tracks
already captured while dragging the selection (`selected_lanes`) are immediately
assigned to a new transition; the dialog opens directly in that transition's
editor.

**Library flow:** the user builds a library of transitions (title, preset, effect
chain, silence, sweep) and assigns tracks to each. Three ways to commit:
- **Apply** (in the editor) — applies just the transition being edited to its
  currently-assigned tracks, then closes the dialog.
- **Save to library** — persists the transition as a reusable template, **without**
  any track assignment (stays in the editor; assign tracks separately via "Assign"
  or the Matrix view).
- **Apply and close** (library list) — applies every transition in the library to
  its assigned tracks in one pass.

**Per transition × assigned track**, a slice track is created:
1. `song.duplicateTrack(track)` — native full copy (keeps warp/BPM/gain/pitch/
   reverse/groove/program change).
2. Original: `clearClipsInRange(start, end)` clears the transition's time range —
   this is the "silence" on the original.
3. Copy: everything outside `[start, end)` is cleared, leaving only the transition
   range.
4. Effect stack applied to the copy (as a Rack if more than one effect is active).

Generated tracks are named with a `>> ` prefix (no track grouping via the SDK, see
§5) and filtered out of the track list/matrix on the next open.

**Silence** (`silenceBars`, segmented tiles: Off/0.25/0.5/1/2/4) sits at the end of
the range; an active effect's range shifts in front of it, shortened accordingly.
Without silence, the effect fills the whole range.

**Step sweep** splits a transition into 2/4/8 equal slices (depending on length),
one track per slice with an interpolated fixed value (staircase — the SDK can't
do real automation, see §5). Quantized/boolean parameters stay constant across
all steps.

**Silence/Sweep auto-downgrade:** if a saved value no longer fits the current
selection (e.g. a 4-step sweep loaded against a now-shorter selection), it's
downgraded to the largest still-valid value instead of being reset — silently
during ordinary editing, but with a one-time notice when triggered by loading a
preset or a whole library (`clampCfgToSelection`/`validateDefsAgainstSelection` in
`interface.html`).

**"Also load effects on the original track"** loads the same device stack
statically on the original track too, but **disabled** (`Device On` = Off, as a
Rack if grouped) — a placeholder for automation drawn in manually later.

---

## 2. Effect catalog

11 effects, wired in `applyOneEffect`/`captureEffectParams` (`extension.ts`):
Filter (Auto Filter), Delay, Reverb, Auto Pan-Tremolo, Chorus-Ensemble, Echo,
Erosion, EQ Eight, Phaser-Flanger, Saturator, Vocoder. Full parameter tables,
units, and Live device names: **EFFECTS.md**.

Effects only ever enter a transition via **"Capture effect chain"** (§3) — there
is no manual "add effect" picker. Each curated parameter (the handful shown as
sliders in the window) is applied *after* a raw-value snapshot restore
(`applySnapshot`), so it can deliberately override the snapshot for the fields
that are actually adjustable; everything else the device had comes along
unchanged via the snapshot.

**Rack:** whenever more than one effect is active, `applyFx` always wraps them in
an Audio Effect Rack (`track.insertDevice("Audio Effect Rack", idx)`,
`instanceof RackDevice` → insert into `rack.chains[0] ?? rack.insertChain(0)`),
falling back to serial insertion on any failure. Confirmed working in Live.

**EQ Eight** has no native Dry/Wet parameter at all (not even via a rack) —
`Scale` is its only curated control, shown in the window as a percentage
(−200%..200%) even though the underlying device parameter is −2..2 (a pure
UI-layer scaling, `c.scale*100` for display / `v/100` on input).

**Devices without native Dry/Wet** (Auto Pan-Tremolo, Erosion): no Dry/Wet
control is shown in the window and none is applied when building — a rack
Dry/Wet wrapper would be needed to offer one, and isn't implemented.

**Some device controls aren't `DeviceParameter`s at all** — found via Roar's
Single/Multiband "Routing" switch, which turned out to be a purely structural,
unreadable/unwritable control (confirmed by dumping `fx-inspect-test` output
across every routing mode: identical parameter list, names, ranges, and current
values in all of them). No workaround exists via the Extensions API for this
class of control — Roar was removed from the catalog for this reason and
replaced by Saturator. Worth checking for on any future effect with a similarly
prominent macro/mode selector.

**Renamed devices aren't recognized** during capture — matching is purely by
`device.name`, and the SDK exposes no renaming-proof device-class identifier.
Documented as a user-facing limitation in README.md, not something the code can
detect or work around.

---

## 3. Captured effect chain

Manual effect selection doesn't exist — instead, the user builds the desired
chain directly in Live (real device UI, any parameter), and the extension reads
it in.

**Two context-menu commands of the same extension** (no cross-extension IPC —
Developer Mode only connects one Extension Host process at a time, so two
separately-started extensions couldn't share state anyway):
- **"Capture effect chain"** (`AudioTrack`/`MidiTrack` scope): reads
  `track.devices`, recursing into `RackDevice.chains[].devices` (a Rack container
  itself is a pass-through, not reported as unrecognized). Matches each
  `device.name` against the known Live device names (`EFFECT_DEVICE_NAMES`); an
  unrecognized device is skipped and its name collected. Result lands in an
  in-memory `capturedChain` (session-only, like `lastDraft` — no file
  persistence; if the user likes a captured chain, they save it as a preset,
  which then flows through the existing preset persistence).
- **"Insert captured chain"** (button in the transition editor): appends
  `capturedChain`'s effects to the transition being edited — reusable, doesn't
  consume the capture.

**Progress + feedback while capturing:** reading many parameters per device (some
devices have 20–90+) can take a few seconds — `api.ui.withinProgressDialog` shows
live text + percent per device ("Capturing "X" (2/5)…" / "Skipping "Y" — not
recognized (3/5)…") so the operation's progress is visible instead of silent.
Once it resolves: **silent on full success**, but a small notice dialog
(`noticeHtml`) lists what was captured and what was skipped whenever at least one
device wasn't recognized.

**Applying** (both the editor's direct "Apply" and the library list's "Apply and
close") is wrapped the same way: `api.ui.withinProgressDialog` shows live
text + percent per track × transition combination while `buildForTrack` runs
inside `api.withinTransaction` (all mutations collapse into one undo step).

---

## 4. Library / preset data flow

**State:**
- `defaultDefs`/`defaultMatrixAssign` — the session-persistent "Default" library.
  `defs`/`matrixAssign` point to these by reference while Default is active, so
  edits land there automatically.
- Named libraries (`libPresets`) and single-transition presets (`userPresets`) are
  saved/loaded by name, each cloned fresh on load (a read-only template until
  edited).
- `pendingAssignedIds` + `pendingIsCommitted` — track assignment for the
  transition currently being edited. While `pendingIsCommitted` is `false` (a
  brand-new or "Save to library"-only transition), the editor shows
  `pendingAssignedIds` without ever writing into the shared `matrixAssign` — so
  "Save to library" can never accidentally double-assign a track. Only an
  explicit **"Assign"** click (or opening an already-assigned entry via "Edit")
  commits into `matrixAssign` and flips the flag to `true`.

**Host ↔ webview:** `api.ui.showModalDialog(dataUrl, 620, 720)` — the host
injects `data` once (`clipBars`, `selectedTrackIds`, `tracks`, `userPresets`,
`libPresets`, `draft`, `capturedChain`); the webview returns exactly one
`{cancelled, plan, draft}` object via `postMessage({method:"close_and_send", …})`
— even on Cancel, so the working state (`draft`) is preserved for the next open.
`draft` is held in-memory host-side (`lastDraft`, survives dialog reopens within
one Live session, not a Live restart); presets/libraries are additionally
persisted to `am-transition-tool.json`.

```
TransitionCfg = {
  sweepOn: boolean, sweepSteps: number, applyToOriginal: boolean,
  order: string[],              // ["filter_0", "reverb_0", …]
  effects: Record<string, EffectParams>,
  silenceBars?: number, color?: string, title: string, activePreset?: string,
}
```
No `lengthBars` (derived from `clipBars`/`silenceBars` at apply time), no
`silence` boolean (derived from `silenceBars > 0`), no `asRack` (Rack is always
attempted for >1 active effect).

**Save popups:** both single-transition preset save and library save use the
same modal (`#save-modal`, `saveModalTarget` = `'preset'|'library'`) — a small
backdrop+card dialog (name input, inline error, Cancel/Save, Enter-to-save/
Escape-to-cancel), matching the style used in the sibling extension
`am-drum-fill-generator`.

**Library list reorder:** drag-and-drop with a drop-position indicator (a thin
accent line above/below the hovered row), backed by a generic `wireDragReorder`
helper shared with the effect-tile reorder inside the editor. Reordering the
library list remaps `matrixAssign`'s index-keyed entries (`remapAssignForMove`)
to follow the move; the Matrix view needs no extra code since it always renders
from the live `defs` array.

---

## 5. SDK knowledge & hard limits

**Arrangement time-selection entry point**
- Scopes `"AudioTrack.ArrangementSelection"` / `"MidiTrack.ArrangementSelection"`.
  `registerContextMenuAction(scope, title, commandId)` — the command receives an
  `ArrangementSelection` object directly: `{ time_selection_start,
  time_selection_end, selected_lanes: Handle[] }` (beats).
- `selected_lanes` are handles to **Track or TakeLane** — resolve via
  `api.getObjectFromHandle(h, DataModelObject)`; `instanceof Track` directly, or
  for `instanceof TakeLane` take `.parent` (must be a `Track`). Deduplicated via
  `Set<Track<V>>`.

**Clips / Tracks**
- `track.clearClipsInRange(start, end)` truncates boundary clips exactly at the
  edge (the basis of the slice mechanic).
- `track.arrangementClips` (array), `track.groupTrack` (parent group or null,
  read-only). **Track has no `color`** → derive from `arrangementClips[0].color`.
  **No `isGroup` flag** → a group is whichever track another track's
  `groupTrack` points to.

**Devices / parameters**
- `track.insertDevice(name, index)` — only built-in devices with their default
  preset (no `.adg` loading). `DeviceParameter`: `min`/`max`/`isQuantized`/
  `valueItems`/`getValue()`/`setValue(v)` (async). Percent→value:
  `min + pct/100*(max-min)`. Quantized (type/sync/mode): find the index in
  `valueItems` via a name regex, then `setValue(idx)`.

**Persistence**
- `api.environment.storageDirectory` is often `undefined` → fallback chain
  (Windows checks `%APPDATA%/am-transition-tool` first; macOS/Linux checks
  `~/Library/Application Support/am-transition-tool` then `~/.am-transition-tool`
  first, with `%APPDATA%` as a final catch-all). File:
  `am-transition-tool.json` = `{ userPresets, libPresets }`.

**Undo grouping**
- `api.withinTransaction<T>(fn: () => T): T` — the callback must be synchronous,
  but its return value may be a Promise; the transaction stays open until that
  Promise resolves. Async work (`duplicateTrack`/`insertDevice`/…) can be bundled
  into one undo step by wrapping the whole flow in
  `await api.withinTransaction(() => (async () => { … })())`.

**Progress dialogs**
- `api.ui.withinProgressDialog(text, {progress}, async (update, abortSignal) =>
  {...})` — shows a native progress dialog while the callback runs; `update(text,
  percent)` changes the displayed text/percentage live, the dialog closes
  automatically when the callback resolves or rejects. Used for both "Capture
  effect chain" and "Apply".

### Hard SDK limits

- **No track grouping/sorting/moving** (`groupTrack` is read-only) → slice
  tracks can't be grouped; a `>> ` name prefix marks them instead.
- **No automation/envelopes** → only static values per track (hence the step
  sweep, which fakes a sweep with N discrete tracks instead of one automated
  parameter).
- **No loading of `.adg` racks/plugins**, only built-in devices with their
  factory default — hence "Capture effect chain" (read live values from a
  track you built by hand) instead of loading a saved preset file.
- **No freeze/bounce/render-with-effect** — `resources.renderPreFxAudio` only
  ever returns the pre-FX (dry) signal; there's no way to render a track's
  post-FX/wet output. The only option is manually freezing the generated
  `>> `-tracks afterward in Live itself.
- **Webview = modal, one-shot communication** — no Live access while a modal
  dialog is open, and no way to push updates into it after it opens (hence
  "Capture effect chain" reads from the track host-side, before any dialog
  opens, and progress dialogs are a separate, purpose-built API rather than a
  webview).
- **manifest `version` must be plain `X.Y.Z`** (no `-beta` suffix).
- **Some device controls aren't `DeviceParameter`s at all** — see §2 (Roar's
  Routing).

---

## 6. Files & structure

```
extensions/am-transition-tool/
  src/extension.ts     ← host: commands, track tree, buildForTrack, applyFx, persistence
  src/interface.html   ← PRODUCTION webview (derived from MOCKUP.html), inlined via esbuild
  src/html.d.ts        ← declares *.html imports as string
  MOCKUP.html          ← design sandbox (standalone, kept in sync with interface.html)
  EFFECTS.md           ← effect catalog (parameters, units, Live device names)
  README.md            ← user-facing description + known limitations
  _serve.cjs           ← mini Node static server for browser preview (dev-only)
  build.ts             ← esbuild (cjs, platform node, loader{".html":"text"})
  manifest.json        ← name="AM Transition Tool", entry=dist/extension.js, version 1.0.0
  tsconfig.json        ← nodenext, strict, noUncheckedIndexedAccess, "types":["node"]
```

**Build/run:**
```
cd extensions/am-transition-tool
npm run build:dev      # tsc --noEmit && esbuild  (typecheck + bundle)
npm start              # build + extensions-cli run  (only ONE extension at a time!)
```
Live: Developer Mode on (Preferences → Extensions), a Set open in Arrangement
View. Shows up as **"AM Transition Tool"** in Preferences → Extensions.

**Test the GUI locally (without Live):** `.claude/launch.json`
(`am-transition-tool-mockup`) starts `_serve.cjs` on port 8753; `/` =
MOCKUP.html, `/src/interface.html` = production. Both fall back to demo data
when `__TRANSITION_DATA__` isn't injected by a host.

⚠️ `dialogHtml.replace("__TRANSITION_DATA__", …)` only replaces the **first**
occurrence — the placeholder may only appear once in `interface.html` (in code,
not in a comment).

---

## 7. References

- **Effect catalog:** `EFFECTS.md`.
- **Arrangement time-selection pattern:** `../../examples/arrangementselection/src/extension.ts`.
- **Do not confuse with:** `../../examples/ReverseVerb-1.0.0/src/extension.ts` —
  uses the `AudioClip` scope + `clip.startTime/endTime` (always the full clip, no
  free selection), a different mechanism than this extension's entry point.
- **Device pattern:** `../transition-builder-demo/src/` (`setFilterType`,
  `setPercent`, `findParam`).
- **Persistence/track-tree/group pattern:** `../andiranger/src/extension.ts`.
- **SDK types:** `node_modules/@ableton-extensions/sdk/dist/index.d.mts`.
