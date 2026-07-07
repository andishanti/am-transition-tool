# AM Transition Tool — Concept & Functional Description (v2, ARCHIVED)

> **This document is an archived early planning draft, kept for history only —
> it does not describe the current implementation.** See
> [`HANDOVER.md`](HANDOVER.md) (+ [`EFFECTS.md`](EFFECTS.md)) for how the
> extension actually works today.

Foundational document for the Ableton Live extension `am-transition-tool` (display
name "AM Transition Tool"), split off from
`andiranger`. Replaces/extends the v1 recorded in `HANDOVER.md` — this version
takes into account the user requirements from 2026-06-28 (wizard flow, clip entry
point, effect tiles, presets, design like `andiranger`).

Status: 2026-06-28 · **no code for v2 yet** — this document is step 1 (concept).
Step 2 = mockup, step 3 = implementation.

> **Superseded since implementation:** the iterative "choose tracks → define
> transition → more tracks" wizard from this document was replaced by the final
> **library flow** (build a library, assign tracks via matrix/button). **§2 Entry
> point** is also superseded: instead of clicking a single clip
> (`AudioClip`/`MidiClip` scope), the extension has used an **arrangement time
> selection** since 2026-07-01 (`AudioTrack.ArrangementSelection`/
> `MidiTrack.ArrangementSelection`) — the marked time range exactly defines the
> transition range for all captured tracks, without clip boundaries or step
> snapping. **The current, binding docs are [`HANDOVER.md`](HANDOVER.md)**
> (+ [`EFFECTS.md`](EFFECTS.md) for the effect catalog). This document only remains
> as a history of ideas/decisions.

---

## 1. Goal & basic idea

A transition is an **effect section at the end of a clip** that gets moved onto
its own, new track (the original stays untouched except for being trimmed at the
end). The extension guides the user through a **wizard** that works iteratively:
choose tracks → define a transition for these tracks → choose further (not yet
chosen) tracks → define the next transition → … until the user finishes or no
tracks are left.

**Design language and construction principles like `andiranger`:**
- A webview wizard that only **collects** — all Live changes only happen in the
  final **Apply** step (one modal, one-shot webview, no interim access).
- **Look & feel identical to `andiranger`** (`ui/interface.html`): light theme
  (`--bg:#fbfbfa`, `--acc:#2f6fed`, segmented controls, rounded buttons, tile
  grid), no design language of its own.
- Groups are **shown** in the track list, but are **not selectable** (analogous to
  "groups are never relevant" in `andiranger`).
- Save/load presets like `andiranger` (dropdown + custom presets, file fallback
  `~/Library/Application Support/am-transition-tool`).

---

## 2. Entry point: clicking a clip

**Changed vs. v1** (v1 used `*.ArrangementSelection` via a time-selection drag).
The SDK offers its own context-menu scopes **`AudioClip`** and **`MidiClip`**
(`api/types/ContextMenuScope.html`, confirmed) — right-clicking a **single clip**
delivers the clip handle directly, without a selection gesture:

```
api.ui.registerContextMenuAction("AudioClip", "Transition…", "transition.open");
api.ui.registerContextMenuAction("MidiClip", "Transition…", "transition.open");
```

From the clip handle you can resolve: `clip.track`, `clip.startTime`,
`clip.endTime`/`clip.duration` (→ bars). The **anchor clip** determines the
**reference length** (how many bars it lasts) for step 1 of the transition window
(§5). The **tracks** chosen in the wizard (§4) are handled independently of that:
per track, **its own** last clip in the relevant range is used (tracks can have
content of different lengths) — but the reference for orientation throughout is
the length of the anchor clip the wizard was opened with.

> Open for step 2/3: if a chosen track's ending is shorter/longer than the anchor
> clip, the mechanic from §6 still applies per track individually (`maxEnd` per
> track, not global) — only the **length's default value** in the transition
> window comes from the anchor clip.

---

## 3. Wizard flow (iterative, target spec)

One webview, several internal pages, a **repeatable cycle**:

```
[Choose tracks] → [Configure transition] → done? ──no──┐
        ▲                                                │
        └──────────────── (only tracks not yet chosen) ──┘
                            │
                           yes
                            ▼
                        [Apply]
```

**Page A — choose tracks** (like `andiranger`'s step 1/3 track list):
- List of all tracks in the Set, groups shown as **non-selectable** headers (grey,
  clicking has no effect) — analogous to the `isGroup`/`groupTrack` detection from
  `andiranger` (`[[andiranger-apply]]`).
- Tracks already assigned in an **earlier round of this wizard run** are **no
  longer offered** (greyed out/removed) — a track gets **at most one** transition
  per run.
- Multi-select (checkboxes), at least 1 track required to continue.
- Default selection: the anchor clip from §2 is pre-selected in the list.

**Page B — configure transition** (§5) for the tracks chosen on page A:
- Applies **identically** to **all** tracks chosen in this step (one configuration
  set per round — anyone wanting different transitions per track does multiple
  rounds with one track each).
- After "Apply" → back to page A with the **remaining** tracks, **or** "Apply &
  finish wizard" (jump straight to Apply).
- If **no** tracks remain after a round, page A is skipped automatically and it
  goes straight to Apply.

**Cancelable at any time:** "Cancel" / Escape on any page →
`close_and_send(null)`, the Set stays unchanged (analogous to `andiranger` §7).

**Apply (final):** for every round (track group + transition configuration), the
mechanic from §6 is executed. Progress across multiple rounds/tracks, if needed,
via `withinProgressDialog` (as planned in `andiranger`).

---

## 4. Track selection (page A) — details

Carried over from `andiranger`:
- **Group detection** via object identity of `track.groupTrack` (cache handles,
  `===` comparison) — groups are **visible** in the list (as headers/indented
  children), but marked with a `disabled` look.
- **Only tracks with content** are meaningfully selectable (empty track → note/
  greyed out, since no transition is possible without a clip).
- The list must stay scrollable/compact with many tracks (40+) (like
  `andiranger`'s step 1 "exclude tracks").

---

## 5. Transition window (page B) — details

**Header area:**
- Display: **"Clip length: N bars"** (from the anchor clip, read-only info).

**Effect length:**
- Input/selection of the **transition length** from the fixed value list
  **0.5 · 1 · 2 · 4 · 8 · 16 bars** (segmented control or dropdown, no free text).
- **Validation:** transition length ≤ the anchor's clip length (otherwise
  pre-select/disable the largest allowed option). Per track, at apply time it's
  additionally checked against the **actual** track length (§6) — shorter tracks
  may get an error message/be skipped.

**Step sweep:**
- "Step sweep" toggle — only enable-able from **4 bars** of transition length upward.
- Choice of **2 or 4 steps**, allowed depending on length (see table, identical to
  v1/§9 of the `andiranger` concept):

  | Length | Step options |
  |-------|------------------|
  | 0.5 / 1 / 2 bars | — (fixed value only) |
  | 4 bars | 2×2 |
  | 8 bars | 2×4 · 4×2 |
  | 16 bars | 2×8 · 4×4 |

- With step sweep active, the **steppable** effect parameters (see `EFFECTS.md`)
  show a **from → to** field instead of a single value; secondary parameters stay
  constant across the steps.

**Effect selection — tiles instead of a form:**
- Every effect type (Filter, Reverb, Delay) is a **tile** in a list. A tile has an
  **enable toggle** in its header; only active tiles show their controls (sliders)
  expanded.
- **The chain order can be moved via click-and-drag** (handle `⠿`, like the
  drag-reorder from `andiranger` — `[[andiranger-ui-next]]`, HTML5 DnD with an
  insertion line). The order of the active tiles determines the device chain on
  the transition track.
- Additional option **"Silence"**: its own tile/radio button at the top of the
  list — selecting it disables/hides all effect tiles (silence excludes effects,
  see §6).
- A control per effect parameter as a **slider** with a live value display
  (analogous to the `transition-builder-demo`/`andiranger` slider style).
- The effect catalog (types, parameters, step-sweep capability) is factored out
  into **`EFFECTS.md`** — this file is the extensible foundation, the transition
  window renders its tiles from this catalog.

**"Also load effects on the original track" checkbox:**
- See §6 — affects the **original** track (in addition to the new transition
  track), default **off**.

**Footer:** "Cancel" · "Apply, choose more tracks" · "Apply & finish wizard".

---

## 6. Mechanics (Apply)

**Basic principle, refined per the user's spec** (identical to the already
validated demo mechanic, only the description of the clip trimming refined):

> The effect length is subtracted from the **end of the original clip**. Example:
> the clip is 4 bars (bars 1–4), transition length = 1 bar → after processing the
> original clip is **3 bars** long (bars 1–3); the transition sits on
> **bar 4** (1 bar) on the new track.

Steps per track/round:
1. **Duplicate first:** `song.duplicateTrack(track)` — native full copy, retains
   all clip properties (warp/BPM, gain, pitch, reverse, groove, program change).
2. **Trim the original:** remove the last N bars via
   `track.clearClipsInRange(start, end)` → the original now only plays up to `start`.
3. **Trim the copy:** remove everything **before** `start`
   (`clearClipsInRange(0, start)`) → the copy only plays the last N bars.
4. **Effect stack** on the copy (device chain in the order set via drag-and-drop,
   parameters from `EFFECTS.md`).
5. With **step sweep**: repeat step 3+4 for **N step tracks** instead of one copy
   — each step = its own slice (`clearClipsInRange` on its sub-range) with the
   effect at its interpolated fixed value (cutoff logarithmic, Dry/Wet linear).
6. With **"silence"**: only step 1+2 (trim the original) — **no** copy/FX track
   needed, the cut-off part simply disappears.

**New option — also load effects on the original track:**
- Checkbox in the transition window (§5). When enabled, the same effect stack
  (same devices, same order, **start values** of the step-sweep parameters if
  active) is **additionally** loaded onto the **original** track (not instead of
  the transition copy — both get the devices).
- **Purpose (user workflow):** the transition track carries a *static* effect (the
  SDK can't do automation, §7). The user can later draw automation **manually in
  Live** onto the (already present) devices on the original track. If they then
  move the clip back onto the original track, **the devices including automation
  are preserved** (the devices are already there) — the extension has thus only
  prepared the *starting point* for automation added manually afterward.
- Does **not** apply to "silence" (no effect stack present).

---

## 7. Effect catalog → its own file `EFFECTS.md`

The effects listed in the brief (Filter/Reverb/Delay + silence) are maintained in
a dedicated, extensible spec file, **[`EFFECTS.md`](EFFECTS.md)** (types,
parameters, value ranges, step-sweep capability, mapping onto Live
devices/parameters). New effects can be added there as another entry without
changing this concept document. `EFFECTS.md` is the **data source** for the tiles
in §5 and for building the device stack in §6.

---

## 8. Presets (like `andiranger`)

- **Dropdown** with built-in example presets (typical transition setups, e.g.
  "High filter sweep", "Tape stop" or similar — content `[open]`, to be defined
  later) + **custom presets** in an `<optgroup>`.
- **Save:** a "Save as preset" checkbox + name field in the transition window
  (§5) — analogous to `andiranger`'s `savePresetName`.
- **Load:** selecting it in the dropdown applies the complete effect configuration
  (tiles, values, order, step-sweep settings) on page B.
- **Delete:** button, only active when a custom preset is selected (`user:`
  prefix like in `andiranger`).
- **Persistence:** same fallback mechanism as `andiranger`
  (`api.environment.storageDirectory` is `undefined` in the beta →
  `~/Library/Application Support/am-transition-tool/am-transition-tool-presets.json`,
  otherwise session memory only). File I/O is "best effort" only, the wizard also
  works without write permissions (see `[[ableton-ext-setup]]`).

---

## 9. Hard SDK limits (still apply, carried over from `andiranger`/v1)

- **No automation/envelopes** → the effect is static per slice (hence the step
  sweep instead of a real sweep; hence the checkbox in §6 as a workaround for
  *manual* automation added later).
- **No track grouping/sorting/moving** (`groupTrack` read-only, no `createGroup`)
  → generated transition tracks stay separate, order as dictated by
  `duplicateTrack` (directly after the original).
- **No loading of saved racks (.adg)/plugins** — only built-in devices (Auto
  Filter, Delay, Reverb), default preset, parameters determined at runtime via
  `min`/`max`/`isQuantized`/`valueItems`.
- **No freeze/bounce/render-with-effect** — stays a manual step in Live (document
  this as a note in the wizard).
- The **`AudioClip`/`MidiClip`** context-menu scope delivers the clip handle, but
  clip properties (`startTime`/`endTime`) are **read-only** — no moving the clip,
  only reading + `clearClipsInRange`.

---

## 10. Open points before step 2 (mockup)

1. **Reverb "type"** (the brief mentions a type field without values) — which
   algorithm choices does the built-in Live reverb device actually offer as a
   quantized parameter? Needs to be checked at runtime (`valueItems`) — see the
   placeholder in `EFFECTS.md`.
2. **Delay ping-pong + 16th-note sync** — verify the mapping onto the real Delay
   parameters (sync division as a quantized parameter, ping-pong as an on/off
   parameter) at runtime (analogous to the filter-type detection in
   `transition-builder-demo`).
3. **Bandpass** is new compared to v1 (only LP/HP) — check whether "Auto Filter"
   has a bandpass mode in its type parameter (`valueItems` may contain "Band").
4. **Preset content** (which example presets should be provided) — coordinate
   with the user once the mockup is in place.
5. **Multiple tracks in one round + step sweep together** — does that create N
   tracks **per** chosen track (i.e. tracks × steps), or is step sweep limited to
   single-track rounds? `[to be clarified]`.

---

## 11. References

- Track selection/group detection/preset persistence: `[[andiranger-apply]]`,
  `[[andiranger-ui-next]]`, `../andiranger/KONZEPT.md` (§7, §8).
- Validated slice mechanic: `../transition-slice-test/src/extension.ts`.
- Device parameter pattern (filter type, percent mapping): `../transition-builder-demo/src/extension.ts`.
- v1 state (time-selection entry point, code already exists, being migrated to v2): `HANDOVER.md`.
- Effect catalog: `EFFECTS.md`.
