# AM Transition Tool

## At a glance

- Build a transition — insert an effect chain across multiple tracks at once, for a chosen time range.
- No more trimming clips one by one: cut the end off a loop on multiple tracks simultaneously.
- Save chains that work, reuse them instantly next time.
- A tool for staying in flow while arranging — quick enough to experiment, occasionally good for a happy accident.

An Ableton Live extension for building **transitions** — effect sections (filter
sweeps, reverb tails, delay throws, …) at the end of an arrangement section — as
their own generated tracks, without touching your original clips.

## Why I built this

I kept ending up with a good loop structure, duplicating it, and then facing
the same chore: spicing it up with a transition. In practice that meant a lot
of individual mouse clicks — dragging devices onto each track, dialing in the
same filter sweep or reverb tail again, then doing it all over on the next
track because the arrangement called for it there too.

I had effect racks for this already, but they'd often grow too complex, and
once I'd duplicated them across several tracks, the whole thing got
unmanageable. I'd end up automating parameters that, half the time, didn't
work out in the end. Even something as simple as a plain break — a moment of
silence — took more clicks than it should have.

Arranging transitions had just become tedious. So instead of doing it by hand
again, I started thinking about how an extension could take over the
repetitive part: apply one effect chain (or silence, or both) to a time
selection across as many tracks as I want, in one step.

The result puts me in a better starting position now, even if it isn't
perfect. The Extensions API still has real limitations — some of which
actually turned out to shape the tool for the better (more on that under
[Why it's built this way](#why-its-built-this-way)).

A note on how this got built: I have a background in media technology and
some programming experience from that, but not enough to have built something
this complex on my own. I'm generally skeptical of AI in a lot of areas —
music production very much included. I've only recently started working with
Claude, and this felt like a fitting use case: Ableton Extensions are a new
feature, which let me build something for myself — and hopefully for others —
that simply wouldn't have been possible for me a few years ago.

## Supported effects

- Auto Filter
- Auto Pan-Tremolo
- Chorus-Ensemble
- Delay
- Echo
- Erosion
- EQ Eight
- Phaser-Flanger
- Reverb
- Saturator
- Vocoder

See [EFFECTS.md](EFFECTS.md) for exactly which parameters are adjustable per
effect and which come along unchanged from the capture.

## Step by step

**1. Capture an effect chain.** Effect chains aren't picked from a dropdown —
you build them **in Live itself** (any stock device, any parameter) on a
track, then right-click that track and choose **"Capture effect chain"**.
The extension reads the whole chain (recursing into Racks) and remembers it
for the session.

**2. Define the transition.** Draw a time selection over the end of a
section in the Arrangement, select the tracks it should apply to,
right-click, and choose **"Create transition…"**. Click **"⬇ Insert
captured chain"** to drop in the chain from step 1, ready to fine-tune the
handful of parameters each effect exposes — type, cutoff, decay, drive, …
Everything else about the captured devices comes along unchanged. A
transition can also be pure silence instead of (or in addition to) an
effect — useful for a plain break at the end of a loop.

<br>

<img src="screenshots/02-effect-chain.png" alt="Effect chain editor" width="500">

<br>

**3. Save it for quick access later.** If there's a chance you'll want this
transition again, this is the point to save it as a preset or add it to your
library — before clicking Apply. That way it's one click away next time,
instead of inserting the captured effect chain and setting up the silence
duration from scratch.

<br>

<img src="screenshots/04-library.png" alt="Library" width="500">

<br>

**4. Apply.** The extension duplicates every selected track, clears the
original's content in that time range (so it plays silence there), trims the
duplicate down to just that range, and applies the effect chain (or silence,
or both) to the duplicate. The result: a `>> `-prefixed track per original
track holding the transition, while your original arrangement stays intact
except for the section it now hands off to.

**5. Reuse via Matrix view.** The Matrix view shows every transition in the
currently loaded library against every track at once, so you can assign
several transitions to different tracks in one place instead of hunting
through the Arrangement.

<br>

<img src="screenshots/05-matrix.png" alt="Matrix view" width="500">

## Further notes

1. The extension can't be reapplied to a track it already generated — run it
   again on the *original* track for another transition on the same section.
2. If a saved preset's silence duration is longer than your current
   selection, it's automatically reduced to the largest value that still
   fits (e.g. a 4-bar silence preset on a 2-bar selection becomes 2 bars) —
   you'll see a short notice when this happens.
3. The same applies to **step sweep**: if the selection is too short for the
   sweep step count a preset used (e.g. 4× on a range that now only allows
   2×), it's reduced the same way, with a notice.
4. When capturing an effect chain, any device that isn't one of the 11
   supported effects is silently skipped — you'll get a notice listing which
   device(s) were skipped (e.g. *"Skipped 1 unrecognized device(s):
   Utility"*), rather than the capture failing outright.
5. Saving a transition to your library deliberately doesn't carry over its
   track assignment — that's a technical constraint, not an oversight.
   Reassign it to tracks in seconds via the Matrix view instead.

## Hints & Tips

**Bringing a transition's automation back onto the original track.** The
Extensions API can't write automation (see
[Why it's built this way](#why-its-built-this-way)), but there's a manual
workaround if you want the transition's effect to live on the original track
instead of a separate one, using the **"Also load effects on the original
track"** option together with Arrangement automation:

1. On the original track, enable the effect (group), open its **Device On**
   automation, and set a breakpoint at bar 1 that keeps it permanently off.
2. On the transition track, open the same effect's **Device On** automation
   and set a breakpoint at bar 1 that keeps it active.
3. Drag the transition clip to where it belongs. With **Locking Envelopes**
   turned off, the automation breakpoints move with the clip — so the effect
   switches on only for the clip's duration. From there, fine-tune as needed.

**Prototype on a scratch track, not the original.** Loop the time range your
transition will cover, and dial in effects while listening back — freely,
without committing to anything yet. Once you're happy, group the devices and
drag that group onto a new, empty track. The extension captures the chain
from *that* empty track.

This matters because of how "Create transition" works: it duplicates the
selected track, including whatever devices are on it. If you leave your
transition effects sitting on the original track and then apply a
transition, you'll end up with those devices duplicated *and* the captured
chain added on top — doubled up. So before applying a transition, the
original track should be clean of the effects that transition is meant to
introduce.

**Save early, curate as you go.** As soon as an effect chain works well,
save it as a preset first — that's the fastest way to get it back. Once
you've built up several transitions, save them into a library. Ideally, once
your library is in good shape, you're no longer building transitions from
scratch — you're just working the Matrix view against a curated library.

## Why it's built this way

Ableton's Extensions API has some hard boundaries that shaped a few design
choices here:

- **No automation.** The API can't write automation envelopes — only static
  device values. **Step sweep** works around this by generating several
  tracks, each with a different fixed value, to fake a sweep across the
  transition.
- **No track grouping.** The API can't group tracks together, so generated
  transition tracks are marked with a `>> ` name prefix instead of being folded
  into a group.
- **No loading of saved device presets (`.adg`) or plugins**, only stock
  devices at their factory default. That's why effects are captured live from
  a track you configure yourself, rather than picked from a preset list.
- **No rendering/freezing a track's processed (post-effect) audio.** If you
  want to save CPU on a transition track afterward, freeze it manually in Live
  (right-click → Freeze Track) — the extension can't do this for you.
- **Renamed devices aren't recognized.** "Capture effect chain" matches
  devices by their name, and the API has no renaming-proof way to ask "what
  kind of device is this really?" If you rename a device on the track you're
  capturing from, rename it back (or leave it as-is) before capturing.
- **A couple of effects have parameters that can't be set from a script at
  all** — e.g. Roar's Single/Multiband routing switch isn't a regular device
  parameter, so it can't be read or written via the API. Roar was removed from
  the effect catalog for this reason (replaced by Saturator).

More technical detail on all of this, plus the current architecture, lives in
[HANDOVER.md](HANDOVER.md) for anyone continuing development.

## Outlook

I'd love to hear feedback and suggestions for improvement. I'll keep an eye
on where the Extensions SDK goes — if it eventually supports writing
automation, the workaround described above could become a lot simpler (or
unnecessary). I'll also add more effects if there's a need for them.

Mostly, though, I want to actually use this in practice and get back to
making music. Building it took a lot more time than I expected — but it was
fun.

## Requirements

Requires Ableton Live's Developer Mode (Preferences → Extensions) and a Set
open in Arrangement View.

## Build & run

```bash
cd extensions/am-transition-tool
npm run build:dev   # typecheck + bundle
npm start           # build + extensions-cli run (only ONE extension can connect at a time)
```
