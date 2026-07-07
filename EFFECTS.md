# AM Transition Tool — Effect Catalog

Specification of the effects the transition window offers as tiles and that
`applyFx` applies to the transition track(s) — the binding reference for
`interface.html`/`MOCKUP.html` (`freshParams`, `render<Name>Body`) and
`extension.ts` (`captureEffectParams`, `applyOneEffect`).

Effects only ever enter a transition via **"Capture effect chain"** — there is
no manual "add effect" picker. Each effect below lists which of its parameters
are curated (shown as sliders in the window); everything else comes along
unchanged as a raw value snapshot when captured (see HANDOVER.md §3).

## Global rules

- Every effect can be inserted **multiple times** in one transition (its own
  instance id per entry), reordered via drag-and-drop, individually
  enabled/disabled/removable.
- **Dry/Wet**, where the device has a native parameter for it, always sits
  **last** and is **sweepable**. Auto Pan-Tremolo and Erosion have no native
  Dry/Wet and no rack wrapper is implemented to provide one, so no Dry/Wet
  control is shown for either. EQ Eight has no Dry/Wet at all.
- **Silence** is its own tile below the effects (segmented control, not part
  of the effect chain) with its own duration. Combinable with effects — silence
  always sits **at the end of the time selection**; an active effect's range
  shifts forward by exactly the silence duration (see "Length & steps").
- **Step sweep** replaces a fixed value with `{from, to}` on sweepable
  parameters, interpolated linearly (or logarithmically for Hz parameters)
  across N steps — the SDK can't do real automation, so this fakes a sweep
  with N discrete tracks instead. Non-sweepable (quantized/boolean) parameters
  stay constant across all steps. "Rate (Sync)" is chosen in the sweep via two
  dropdowns (from→to) where sweepable at all.

## Length & steps

**Effect length = length of the arrangement time selection.** The user drags a
time selection in Ableton over the desired range (independent of clip
boundaries) and invokes the extension via right-click on it — the effect
length is exactly this selection's length. All tracks the transition is
assigned to are processed for the same length (the selection's end is an
absolute time position, shared across all assigned tracks).

**Silence duration** (`silenceBars`) is its own segmented-tile control: Off /
0.25 / 0.5 / 1 / 2 / 4 bars. With an active effect, at least 0.5 bars stay
reserved for it; without one, silence may take up the whole selection. A value
that no longer fits the current selection (e.g. loaded from a preset built for
a longer one) is downgraded to the largest still-valid tile rather than reset.

If silence is active alongside an effect, the **effective effect length** is
`selection length − silence duration` (min. 0.5 bars). The step sweep option
count is based on this derived length (`stepOptionsForLength`): `<1` bar → no
steps · `1–<2` → max. 2 · `2–<8` → max. 2/4 · `≥8` → max. 2/4/8. The same
downgrade-to-largest-valid-value rule applies to `sweepSteps`.

---

## 0 · Silence (special tile)

No device — a clip cut, not an effect. Always sits at the end of the range:
`[sectionEnd − silenceBars, sectionEnd)`. If an effect is also active, its
range sits directly in front of it, not overlapping the silence. Without
silence, the effect fills the whole selection.

## 1 · Filter — `Auto Filter`

46 parameters total (confirmed via `fx-inspect-test`).

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Type | Low-pass / High-pass / Band-pass / Notch / Morph / DJ / Comb / Resampling / Notch+LP / Vowel | – | `"Filter Type"`, quantized 0–9 | ✅ confirmed, exact name |
| Cutoff | internally 0–1 normalized (not Hz) | ✅ | `"Frequency"`, min=0 max=1, default≈0.8997 | ⚠️ range confirmed; log. Hz mapping (`logMap`, 20–20000 Hz) still `[verify in Live]` against the Hz shown in Live |
| Resonance | internally 0–1 | ✅ | `"Resonance"`, min=0 max=1 | ✅ confirmed, linear, `setPercent` fits directly |
| Filter Slope | 12dB / 24dB | – | `"Filter Slope"`, quantized 0–1 | ✅ confirmed, exact name |
| Dry/Wet | internally 0–1 | ✅ | `"Dry/Wet"`, min=0 max=1, default=1 | ✅ natively present |

Not shown, but retained as a raw value when captured: `Filter Morph`, `Morph
Slope`, `Circuit` (SVF/DFM/MS2/PRD), `Drive`, `Control`, `Pitch`, `Formant`,
the entire `LFO *`/`Env *` sets, `Output`, `Soft Clip On`, the `S/C *`
sidechain-EQ set, `Side Chain Listen`.

`setFilterType` matches the exact name `"filter type"` (not a heuristic) —
`device.parameters` also has an unrelated `"S/C EQ Type"` with a similarly
shaped `valueItems` list that an exact match avoids colliding with.

Default (unchanged): low-pass, cutoff 800 Hz, resonance 20%, Dry/Wet 100%.

## 2 · Delay — `Delay`

27 parameters total.

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Rate (Sync) | 1/16 · 2/16 · 3/16 · 4/16 | – | see below | ✅ implemented |
| Feedback | internally 0–1 normalized | – | `"Feedback"` | ✅ confirmed, `setPercent` fits |
| Ping Pong | on / off | – | `"Ping Pong"`, quantized Off/On | ✅ confirmed |
| Dry/Wet | internally 0–1, default 0.5 | ✅ | `"Dry/Wet"` | ✅ natively present |

**Sync implementation** (`setDelaySync`): the device has no single "division"
parameter — sync is split across `"L Sync"`/`"R Sync"` (Off/On, must be On for
the sync division to apply instead of the free `"L Time"`/`"R Time"`),
`"Link"` (On makes R follow L, so setting only L is enough), and `"L
16th"`/`"R 16th"` (quantized, plain numbers `"1".."16"` = count of 16th notes,
not "x/16" notation — `"3/16"` maps to numerator `"3"`).

Not shown, but retained as a raw value when captured: `Smoothing`
(Repitch/Fade/Jump), `L/R Offset`, `Freeze`, the built-in `Filter On`/`Filter
Freq`/`Filter Width` bandpass, the entire `LFO *` modulation set.

Default: 3/16, Feedback 40%, Ping Pong off, Dry/Wet 35%.

## 3 · Reverb — `Reverb`

33 parameters total. The inserted device's `device.name` reads as
`"ADRKT_Default_Reverb"`, not `"Reverb"` — `matchEffectType` accounts for this
when recognizing a captured Reverb; `insertDevice("Reverb", idx)` still works
for insertion (the display name is what the SDK expects there).

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Decay | internally 0–1 normalized (not ms) | ✅ | `"Decay Time"` | ⚠️ range confirmed, ms mapping (`logMap`, 200–10000ms) `[verify in Live]` |
| Size | internally 0–1 normalized (not 0.22–500) | – | `"Room Size"` | ⚠️ range confirmed, scale mapping (`logMap`, 0.22–500) `[verify in Live]` |
| Dry/Wet | internally 0–1, default 0.55 | ✅ | `"Dry/Wet"` | ✅ natively present |

Everything else (Pre-Delay, Diffusion, Density, Hi-/Lo-Shelf, Chorus, Reflect,
Spin, Scale, the input filter, freeze/flat/cut toggles, stereo image) comes
along as a raw snapshot only — no dedicated UI, since the only way to set a
reverb's overall character is to build it in Live and capture it.

Default: Decay 2.5 s, Size 50, Dry/Wet 50%.

## 4 · Auto Pan — `Auto Pan-Tremolo`

20 parameters total. Device name is `"Auto Pan-Tremolo"`, not `"Auto Pan"`
(Live 12 merged the two devices) — `insertDevice("Auto Pan-Tremolo", idx)`.

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Type | Panning / Tremolo | – | `"Mode"`, quantized 0–1 | ✅ confirmed |
| Rate (Sync) | 1/64 … 4 bars | – | `"Time Mode"` + `"Rate"` (0–21, not quantized) | ⚠️ index↔division mapping not resolved — device stays at its inserted default, `[verify in Live]` |
| Amount | internally 0–1 normalized | ✅ | `"Amount"` | ✅ confirmed, `setPercent` fits |
| Shape | internally 0–1 normalized | – | `"Panning Shape"` (Mode=Panning) or `"Tremolo Shape"` (Mode=Tremolo) — no single "Shape" parameter | ✅ code sets whichever matches the current Mode |

No Dry/Wet control — no native parameter, no rack wrapper implemented.

Not shown, but retained as a raw value when captured: `Waveform`, `Invert`,
`Frequency`/`Time`/`16th` (the other Time-Mode branches), `Phase`, `Offset`,
`Stereo Mode`, `Spin`, `Attack Time`, `Dyn Mod`, `Harmonic`, `Vintage`.

Default: Panning, Rate 1/4, Amount 50%, Shape 50%.

## 5 · Chorus-Ensemble — `Chorus-Ensemble`

16 parameters total.

| Parameter | Unit / values | Sweep | Applies to | Live param | Status |
|-----------|------------------|-------|----------|------------|--------|
| Type | Chorus / Ensemble / Vibrato | – | all | `"Mode"`, quantized 0–2 | ✅ confirmed |
| Rate | internally 0–1 (0.1–15 Hz) | – | all | `"Rate"` | ⚠️ range confirmed, Hz mapping (`logMap`) `[verify in Live]` |
| Amount | internally 0–1 | ✅ | all | `"Amount"` | ✅ confirmed |
| Feedback | internally 0–1 | – | Chorus, Ensemble | `"Feedback"` | ✅ confirmed |
| Time | Auto · 7 ms · 10 ms · 20 ms · 35 ms · 50 ms | – | Chorus only | `"Delay Time"`, quantized 0–5 | ✅ `valueItems` match exactly, index-based |
| Width | internally 0–1, default 0.5 (raw × 200 = display) | ✅ | all | `"Width"` | ✅ scale confirmed |
| Dry/Wet | internally 0–1, default 0.5 | ✅ | all | `"Dry/Wet"` | ✅ natively present |

Not shown, but retained as a raw value when captured: `Shape`, `Delay Taps`,
`Offset`, `HP On`/`HP Freq`, `Warmth`, `Output`.

Default: Chorus, Rate 1.0 Hz, Amount 50%, Feedback 20%, Time Auto, Width 100,
Dry/Wet 50%.

## 6 · Echo — `Echo`

53 parameters total.

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Mode | Stereo / Ping Pong / Mid/Side | – | `"Channel Mode"`, quantized 0–2 | ✅ confirmed |
| Rate (Sync) | 1/64 · 1/32 · 1/16 · 1/8 · 1/4 · 1/2 · 1 | – | complex L/R sync system | ⚠️ not implemented — device stays at its inserted default, `[verify in Live]` |
| Feedback | internally 0–1, default≈0.333 | – | `"Feedback"` | ✅ confirmed |
| Dry/Wet | internally 0–1, default 0.7 | ✅ | `"Dry Wet"` (space, no slash) | ✅ present |

**Sync structure** (more complex than Delay, unresolved): separate L/R
channels like Delay, plus an additional `"L Sync Mode"`/`"R Sync Mode"`
(Synced/Triplet/Dotted/16th) choosing between `"L 16th"` (plain number,
1–16) and `"L Synced"` (−6 to 0, integer, meaning of the steps not
confirmed). Would need the same treatment as Delay's `setDelaySync`, plus
resolving what the `L Synced` integer steps mean in Live — left unimplemented
for now.

Not shown, but retained as a raw value when captured: `Repitch`/`Repitch
Smoothing`, `Input Gain`/`Output`, `Clip Dry`, `Gate`, `Duck`, the filter
`HP/LP Freq/Res`, the entire `Mod *` set, the built-in reverb send, `Noise`,
`Wobble`, `Stereo Width`.

Default: Stereo, Rate 1/4, Feedback 50%, Dry/Wet 50%.

## 7 · Erosion — `Erosion`

Only 6 parameters total — the simplest device in the catalog.

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Noise Blend | internally 0–1, default 0.5 | ✅ | `"Noise Blend"` | ✅ confirmed |
| Stereo | internally 0–1, default 0.25 | ✅ | `"Stereo Width"` | ✅ confirmed |
| Width | internally 0–1, default 0.375 (display 0.1–2.5: `0.1 + raw×2.4`) | ✅ | `"Filter Width"` | ✅ scale confirmed |
| Frequency | internally 0–1 (20–20000 Hz log) | ✅ | `"Frequency"` | ⚠️ range confirmed, Hz mapping (`logMap`) `[verify in Live]` |
| Amount | internally 0–1, default 0.2 | ✅ | `"Amount"` | ✅ confirmed |

All 5 real parameters are shown — nothing left to omit. No Dry/Wet control —
no native parameter, no rack wrapper implemented.

Default: Noise Blend 50%, Stereo 0%, Width 1.0, Frequency 1 kHz, Amount 50%.

## 8 · EQ Eight — `EQ Eight`

84 parameters total. All band parameters are read from a track (snapshot, via
"Insert captured chain") and applied 1:1 — no manual control panel, since
matching parameter names 1:1 between the same stock device is enough (no
semantic understanding of Hz/Q/dB scales needed for a pure copy).

**No native Dry/Wet parameter at all** (confirmed in Live) — not even via a
rack wrapper (a lone EQ Eight is never itself wrapped in a rack, since
wrapping only kicks in at 2+ active effects). No Dry/Wet control shown.

**`Scale` is the only curated parameter** — a sweepable slider, shown as a
percentage (−200%..200%) though the underlying device parameter is directly
−2 to 2 (default 1), presumably a global gain multiplier across all 8 bands.
The percentage display is purely a UI-layer scaling (`c.scale*100` for
display, `v/100` on input) — the value stored in `cfg`/presets and the raw
value written via `setValue` stay −2..2.

Structure: per band `N` (1–8), per stage `A`/`B` — `"{N} Filter On A/B"`,
`"{N} Filter Type A/B"` (quantized 0–7), `"{N} Frequency A/B"`, `"{N} Gain
A/B"` (−15 to 15 dB, direct), `"{N} Q A/B"`. Global: `"Output"` (−12 to 12 dB),
`"Scale"`, `"Adaptive Q"`.

## 9 · Phaser-Flanger — `Phaser-Flanger`

31 parameters total.

| Parameter | Unit / values | Sweep | Applies to | Live param | Status |
|-----------|------------------|-------|----------|------------|--------|
| Type | Phaser / Flanger / Doubler | – | all | `"Mode"`, quantized 0–2 | ✅ confirmed |
| Rate (Sync) | 1/64 … 4 bars | – | all | `"Mod Freq"`/`"Mod Sync"`/`"Mod Rate"` | ⚠️ not implemented — device stays at its inserted default, `[verify in Live]` |
| Amount | internally 0–1, default 1 | ✅ | all | `"Amount"` | ✅ confirmed |
| Notches | 1–42, direct (no mapping) | – | Phaser only | `"Notches"` | ✅ confirmed, `setValue` directly |
| Center | internally 0–1 (70–18500 Hz log) | – | Phaser only | `"Center Freq"` | ⚠️ range confirmed, Hz mapping (`logMap`) `[verify in Live]` |
| Spread | internally 0–1, default 0.5 | ✅ | Phaser only | `"Spread"` | ✅ confirmed |
| Time | internally 0–1 (0.1–20 ms) | – | Flanger only | `"Flanger Time"` | ⚠️ range confirmed, ms mapping (`logMap`) `[verify in Live]` |
| Time | internally 0–1 (20–150 ms) | – | Doubler only | `"Doubler Time"` | ⚠️ range confirmed, ms mapping (`logMap`) `[verify in Live]` |
| Dry/Wet | internally 0–1, default 1 | ✅ | all | `"Dry/Wet"` | ✅ natively present |

Not shown, but retained as a raw value when captured: `Duty Cycle`, `Lfo
Blend`, `Mod Phase`, `Spin Enabled`/`Spin`, the envelope-modulation set,
`Mod Blend`, `Feedback`/`FB Invert`, `Warmth`, `Safe Freq`, `Output`.

Default: Phaser, Rate 1/4, Amount 50%, Notches 8, Center 1 kHz, Spread 50%,
Dry/Wet 50%.

## 10 · Saturator — `Saturator`

19 parameters total.

| Parameter | Unit / values | Sweep | Live param | Status |
|---|---|---|---|---|
| Type | Analog Clip / Soft Sine / Bass Shaper / Medium Curve / Hard Curve / Sinoid Fold / Digital Clip / Waveshaper | – | `"Type"`, quantized 0–7 | ✅ confirmed, exact order |
| Drive | internally 0–1, default 0.5 | ✅ | `"Drive"` | ✅ confirmed |
| Dry/Wet | internally 0–1, default 1 | ✅ | `"Dry/Wet"` | ✅ natively present |

Everything else (`Pre Dc Filter`, the `Color *` tone-shaping section, `Post
Clip Mode`, `Output`, `Threshold`, the `WS *` Waveshaper section) comes along
as a raw snapshot only.

Replaces Roar in the catalog — Roar's Single/Multiband "Routing" turned out to
be a purely structural device switch, not a `DeviceParameter` at all
(confirmed by comparing `fx-inspect-test` dumps across every routing mode: the
parameter list — names, ranges, and current values — was identical in all of
them, meaning there was never a "Routing" parameter to read or write via the
Extensions API). See HANDOVER.md §2 for the full finding.

Default: Analog Clip, Drive 50%, Dry/Wet 100%.

## 11 · Vocoder — `Vocoder`

24 parameters total. Almost everything is a pure name-based copy (snapshot),
same pattern as EQ Eight (§8) — only Dry/Wet is curated.

| Parameter | Unit / values | Sweep | Live param | Status |
|-----------|------------------|-------|------------|--------|
| Dry/Wet | internally 0–1, default 1 | ✅ | `"Dry/Wet"` | ✅ natively present, no rack wrapper needed |

Several non-curated parameters aren't 0–1 normalized but sit directly as
`log10(Hz)` (e.g. `"Lower Filter Band"`, `"Noise Rate"`, the pitch-detection
pair) — irrelevant for the extension since they're only ever copied 1:1, never
interpreted.

---

## Effect group / rack

Whenever **more than one** effect is active, `applyFx` always wraps them in an
Audio Effect Rack (`track.insertDevice("Audio Effect Rack", idx)`, devices
inserted into `rack.chains[0]`) — no opt-in choice. Purpose: clean grouping on
the transition track, and lets "also load on the original track, disabled"
toggle the whole chain via the rack's own "Device On" instead of every device
individually. Falls back to serial insertion on any failure.

## Device chain

Order of the active tiles = order of the devices on the transition track
(`track.insertDevice(name, index)` in that order). Silence is orthogonal (a
clip cut, not a device).

## Extending

A new effect = a new section here + an entry in `CATALOG` (interface) +
`freshParams` defaults + a `render<Name>Body` + a case in
`captureEffectParams`/`applyOneEffect` (`extension.ts`). An effect with very
few curatable controls (like Vocoder) only needs its `render<Name>Body` to
expose Dry/Wet — the rest comes along automatically via the snapshot.
