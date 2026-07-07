import {
  initialize,
  Track,
  TakeLane,
  DataModelObject,
  Chain,
  RackDevice,
  type ActivationContext,
  type ArrangementSelection,
  type Device,
  type DeviceParameter,
  type Handle,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// esbuild inlines the dialog HTML as a string (loader ".html": "text").
import dialogHtml from "./interface.html";

/**
 * AM Transition Tool (v2) — standalone extension. Spec: KONZEPT.md + EFFECTS.md.
 *
 * Entry point (as of 2026-07-01): right-click on an ARRANGEMENT TIME SELECTION
 * (`AudioTrack.ArrangementSelection` / `MidiTrack.ArrangementSelection`) — the
 * marked time range `[time_selection_start, time_selection_end)` defines the
 * time window exactly for ALL tracks assigned later (identical, no rounding/
 * snapping needed — fully replaces the earlier clip-click entry point).
 * The tracks/lanes already captured while dragging the selection
 * (`selected_lanes`) are immediately assigned to the newly created transition;
 * the matrix view in the dialog only serves for adjusting this afterward. In the
 * dialog, the user builds a library of transitions and assigns tracks to each.
 * Per transition, one slice track is created per assigned track in the chosen
 * range [end - len, end).
 *
 * Validated mechanic (transition-slice-test, v1): duplicateTrack (native full
 * copy, retains all clip properties) + clearClipsInRange (edge-accurate
 * truncation). The original loses the region, each copy keeps only its slice +
 * effect stack.
 *
 * STATUS: host scaffolding + slice mechanic complete. All 11 effects are wired
 * in `applyOneEffect` (see EFFECTS.md for the per-effect `[verify in Live]`
 * notes on Hz/ms mappings and unresolved rate/sync). The SDK can't do
 * automation (→ step sweep) or load `.adg` racks.
 *
 * Effect length = length of the time selection. If silence is additionally
 * active, its duration is subtracted from the end of the selection and the
 * effect range shifts forward accordingly (see buildForTrack).
 */

type V = "1.0.0";
type DeviceHost = Track<V> | Chain<V>; // effects land either directly on the track or inside a rack chain
const BEATS_PER_BAR = 4; // assumes 4/4
const NAME_PREFIX = ">> "; // marks generated transition tracks (ASCII — "▸" doesn't render in Ableton track names)
const STORE_FILE = "am-transition-tool.json";
const DIALOG_W = 620; // wider than v1 (480) — long library titles (many effects) need more room
const DIALOG_H = 720;

/** "#rrggbb" → 0xRRGGBB (Clip.color is a BigInt-like numeric value at runtime). */
function colorToNum(hex: string | undefined): number | null {
  if (!hex) return null;
  const n = parseInt(hex.replace(/^#/, ""), 16);
  return Number.isFinite(n) ? n : null;
}

// ── Payload types (1:1 with the webview, src/interface.html) ────────────────
interface EffectParams {
  on: boolean;
  // Filter
  typeSel?: string;
  cutoff?: number; cutoffTo?: number;
  resonance?: number; resonanceTo?: number;
  // Delay / Echo / Phaser-Flanger (sync) or Auto Pan/PF (rate list)
  sync?: string;
  rate?: string | number; rateTo?: string;
  feedback?: number;
  pingpong?: boolean;
  // Reverb
  decay?: number; decayTo?: number;
  size?: number;
  // shared
  dryWet?: number; dryWetTo?: number;
  amount?: number; amountTo?: number;
  // Auto Pan
  shape?: number;
  // Chorus-Ensemble
  time?: string;
  width?: number; widthTo?: number;
  // Echo
  mode?: string;
  // Erosion
  noiseBlend?: number; noiseBlendTo?: number;
  stereo?: number; stereoTo?: number;
  freq?: number; freqTo?: number;
  // Phaser-Flanger
  notches?: number; center?: number;
  spread?: number; spreadTo?: number;
  timeFlanger?: number; timeDoubler?: number;
  // Filter
  slope?: string;
  // EQ Eight
  scale?: number; scaleTo?: number;
  // Raw-value snapshot of the parameters NOT shown in the window (from a captured
  // effect chain) — applied before the curated fields above, so the latter can
  // override it (see applyOneEffect). For EQ Eight/Vocoder this is effectively
  // the entire parameter set, since almost nothing else is curated for them.
  snapshot?: Record<string, number> | null;
}
interface TransitionCfg {
  // Effect length no longer comes from cfg — it's derived at apply time from the
  // (session-wide, shared) clip length and cfg.silenceBars if applicable.
  sweepOn: boolean;
  sweepSteps: number;
  applyToOriginal: boolean;
  order: string[];
  effects: Record<string, EffectParams>;
  // Silence duration in bars; 0 = no silence subtracted (tile-based UI, no separate on/off).
  silenceBars?: number;
  color?: string;
  title: string;
}
interface PlanItem {
  cfg: TransitionCfg;
  trackIds: number[];
}
/** Working state from the webview — for session persistence + re-injection. */
interface Draft {
  defs?: unknown[];
  matrixAssign?: Record<string, number[]>;
  userPresets?: unknown[];
  libPresets?: unknown[];
  activeLibPreset?: string;
}
interface DialogResult {
  cancelled: boolean;
  plan: PlanItem[];
  draft: Draft;
}
interface PersistState {
  userPresets: unknown[];
  libPresets: unknown[];
}

// ── Effect chain capture (HANDOVER.md §9) ───────────────────────────────────
// A second context-menu command (track scope) reads a track's devices and holds
// them in an in-memory variable (see activate()) — exactly the pattern from
// examples/JS-Sweeper-1.3.0.ablx (one extension, two commands, a shared closure
// variable instead of cross-extension IPC). The transition dialog can then insert
// the captured chain via "Insert captured chain"; unrecognized devices are skipped.
interface CapturedEffect { type: string; params: EffectParams; }
interface CapturedChain { chain: CapturedEffect[]; skipped: string[]; }

const effectType = (instanceId: string): string => instanceId.replace(/_\d+$/, "");

/** Sweep value: the fixed value without a sweep, otherwise linear `from→to` across N steps. */
function sweepNum(from: number | undefined, to: number | undefined, i: number, n: number, on: boolean): number {
  const a = from ?? 0;
  if (!on) return a;
  const b = to ?? a;
  const frac = n > 1 ? i / (n - 1) : 0;
  return a + frac * (b - a);
}

function findParam(device: Device<V>, substr: string): DeviceParameter<V> | undefined {
  return device.parameters.find((p) => p.name.toLowerCase().includes(substr.toLowerCase()));
}

/** Set a parameter from a percent (0–100) onto its real value range. */
async function setPercent(param: DeviceParameter<V> | undefined, percent: number, label: string): Promise<void> {
  if (!param) {
    console.warn(`[am-transition-tool] Parameter "${label}" not found.`);
    return;
  }
  const frac = Math.max(0, Math.min(100, percent)) / 100;
  await param.setValue(param.min + frac * (param.max - param.min));
}

/** Set a quantized parameter (valueItems) to the first regex match. */
async function setQuantized(param: DeviceParameter<V> | undefined, want: RegExp, label: string): Promise<void> {
  if (!param) { console.warn(`[am-transition-tool] Quantized parameter "${label}" not found.`); return; }
  const idx = param.valueItems.findIndex((v) => want.test(v.name));
  if (idx >= 0) await param.setValue(idx);
  else console.warn(`[am-transition-tool] "${label}": no matching valueItem for ${want}.`);
}

/** Auto Filter type (LP/HP/BP) via the quantized "Filter Type" parameter (exact
 * name match instead of the earlier low/high heuristic — that one potentially
 * collided with "S/C EQ Type", see EFFECTS.md §1). */
async function setFilterType(device: Device<V>, type: string | undefined): Promise<void> {
  const typeParam = device.parameters.find((p) => p.name.toLowerCase() === "filter type");
  if (!typeParam) return;
  const want = type === "hp" ? /high/i : type === "bp" ? /band/i : /low/i;
  const idx = typeParam.valueItems.findIndex((v) => want.test(v.name));
  if (idx >= 0) await typeParam.setValue(idx);
}

/** Set a direct value (no 0–100 percent basis), clamped to min/max — for parameters
 * like "Notches" or Echo's "L 16th" that have a real value range instead of 0–1. */
async function setRaw(param: DeviceParameter<V> | undefined, value: number, label: string): Promise<void> {
  if (!param) { console.warn(`[am-transition-tool] Parameter "${label}" not found.`); return; }
  await param.setValue(Math.max(param.min, Math.min(param.max, value)));
}

/** Logarithmic scale (analogous to `pctFromHz`), generalized for Decay/Size/Center/Time —
 * every range still marked [verify in Live] uses the same log-mapping approach as the
 * already-confirmed Auto Filter cutoff, pending Live calibration. */
function logMap(value: number, lo: number, hi: number): number {
  const a = Math.log(Math.max(lo, Math.min(hi, value)));
  return (a - Math.log(lo)) / (Math.log(hi) - Math.log(lo));
}
function invLogMap(frac: number, lo: number, hi: number): number {
  return Math.exp(Math.log(lo) + Math.max(0, Math.min(1, frac)) * (Math.log(hi) - Math.log(lo)));
}

/** Write a captured effect chain's raw-value snapshot back onto a freshly inserted device
 * (matched by name, since source and target are the same stock device — see EFFECTS.md §8).
 * Runs BEFORE the curated setter calls in applyOneEffect, so the latter can deliberately
 * override it (e.g. Dry/Wet, Cutoff, Decay — the fields visible/adjustable in the window). */
async function applySnapshot(device: Device<V>, snapshot: Record<string, number> | null | undefined): Promise<void> {
  if (!snapshot) return;
  for (const p of device.parameters) {
    const v = snapshot[p.name];
    if (v === undefined) continue;
    try { await p.setValue(v); } catch { /* value outside the target's range — skip */ }
  }
}

/** Live device name per effect type (used both for insertion AND for recognition when capturing, see EFFECTS.md per effect). */
const EFFECT_DEVICE_NAMES: Record<string, string> = {
  filter: "Auto Filter",
  delay: "Delay",
  reverb: "Reverb",
  autopan: "Auto Pan-Tremolo",
  chorus: "Chorus-Ensemble",
  echo: "Echo",
  erosion: "Erosion",
  eq8: "EQ Eight",
  phaserflanger: "Phaser-Flanger",
  saturator: "Saturator",
  vocoder: "Vocoder",
};
/** Reverse lookup for capturing: Live device name → our effect type key.
 * Reverb sometimes shows internally as "ADRKT_Default_Reverb" instead of "Reverb" (EFFECTS.md §3). */
function matchEffectType(deviceName: string): string | null {
  for (const key of Object.keys(EFFECT_DEVICE_NAMES)) {
    if (EFFECT_DEVICE_NAMES[key] === deviceName) return key;
  }
  if (deviceName === "ADRKT_Default_Reverb") return "reverb";
  return null;
}
const CHORUS_TIME_ITEMS = ["Auto", "7ms", "10ms", "20ms", "35ms", "50ms"]; // order = Live valueItems
const SATURATOR_TYPES = [
  "Analog Clip", "Soft Sine", "Bass Shaper", "Medium Curve",
  "Hard Curve", "Sinoid Fold", "Digital Clip", "Waveshaper",
]; // order = Live valueItems (confirmed via fx-inspect-test, 2026-07-06)

/** Small standalone notice dialog (not the main interface.html) — used only to flag a
 * problem right when it happens (e.g. an unrecognized device during capture), since the
 * user may not reach "Insert captured chain" for a long time afterward, if ever. Kept
 * minimal on purpose: a message + a single "OK" button, styled to match the main dialog. */
function noticeHtml(message: string): string {
  const esc = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px;background:#fbfbfa;color:#1d1d1f;}
  .wrap{box-sizing:border-box;padding:16px;display:flex;flex-direction:column;height:100vh;}
  .msg{flex:1;line-height:1.5;white-space:pre-line;overflow:auto;}
  .ft{display:flex;justify-content:flex-end;}
  button{height:30px;border:1px solid #2f6fed;border-radius:6px;background:#2f6fed;color:#fff;padding:0 16px;font:inherit;cursor:pointer;}
</style></head><body><div class="wrap"><div class="msg">${esc}</div><div class="ft"><button id="ok">OK</button></div></div>
<script>
function close(){ const m={method:'close_and_send',params:['']};
  if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live) window.webkit.messageHandlers.live.postMessage(m);
  else if(window.chrome&&window.chrome.webview) window.chrome.webview.postMessage(m);
}
document.getElementById('ok').onclick=close;
</script></body></html>`;
}

export function activate(activation: ActivationContext) {
  const api = initialize(activation, "1.0.0");

  console.log('[am-transition-tool] loaded ✓ — draw a time selection in the Arrangement, then right-click → "Create transition…"');

  // ── Persistence (storageDirectory → platform-appropriate app-data folder → ~/.am-transition-tool) ──
  // All candidates use plain cross-platform fs/path calls, so persistence works on any OS
  // regardless of order — but the ORDER matters for landing in the conventional location on the
  // first try. `%APPDATA%` is checked first on Windows (previously last, after an always-creatable
  // but non-idiomatic "Library/Application Support" folder that Windows has no concept of —
  // harmless functionally, just not where a Windows user would expect to find it). Ported from
  // the equivalent fix in extensions/am-drum-fill-generator.
  function storeCandidates(): string[] {
    const out: string[] = [];
    const sd = api.environment.storageDirectory;
    if (sd) out.push(sd);
    try {
      const home = os.homedir();
      const appData = process.env.APPDATA;
      if (process.platform === "win32" && appData) out.push(path.join(appData, "am-transition-tool"));
      if (home) {
        out.push(path.join(home, "Library", "Application Support", "am-transition-tool"));
        out.push(path.join(home, ".am-transition-tool"));
      }
      if (appData) out.push(path.join(appData, "am-transition-tool"));
    } catch { /* os.homedir not available */ }
    return out;
  }
  let storeDir: string | null = null;
  (function resolveStore() {
    for (const dir of storeCandidates()) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, ".probe");
        fs.writeFileSync(probe, "ok");
        const ok = fs.readFileSync(probe, "utf8") === "ok";
        fs.unlinkSync(probe);
        if (ok) { storeDir = dir; break; }
      } catch { /* try the next candidate */ }
    }
    console.log(storeDir ? `[am-transition-tool] Persistence → ${storeDir}` : "[am-transition-tool] No writable location found → session only.");
  })();

  function loadState(): PersistState {
    const fallback: PersistState = { userPresets: [], libPresets: [] };
    if (!storeDir) return fallback;
    try {
      return { ...fallback, ...(JSON.parse(fs.readFileSync(path.join(storeDir, STORE_FILE), "utf8")) as PersistState) };
    } catch { return fallback; }
  }
  function saveState(s: PersistState): void {
    if (!storeDir) return;
    try { fs.writeFileSync(path.join(storeDir, STORE_FILE), JSON.stringify(s)); }
    catch (e) { console.error(`[am-transition-tool] Failed to write ${STORE_FILE}: ${e}`); }
  }

  // Working state for the Live session (in-memory only; doesn't survive a Live
  // restart, exactly as wanted). Injected on open and updated on close.
  let lastDraft: Draft | null = null;
  // Captured effect chain (in-memory, like lastDraft — no file persistence, see
  // HANDOVER.md §9). Set by "Capture effect chain" (track context menu) and
  // injected when the transition dialog opens; can be inserted into any number
  // of transitions.
  let capturedChain: CapturedChain | null = null;

  /** Fraction (0–100) of the raw value `raw` within `[param.min, param.max]`. */
  function percentOf(param: DeviceParameter<V>, raw: number): number {
    return param.max > param.min ? ((raw - param.min) / (param.max - param.min)) * 100 : 0;
  }
  /** 0 if the parameter doesn't exist (shouldn't happen with the known Live devices)
   * — avoids `undefined` assignments onto the (non-optional) number fields of
   * `EffectParams` under `exactOptionalPropertyTypes`. */
  async function readPercent(device: Device<V>, substr: string): Promise<number> {
    const p = findParam(device, substr);
    if (!p) return 0;
    return percentOf(p, await p.getValue());
  }

  /** Rounding for captured values: most tile sliders show whole numbers, so unrounded
   * `percentOf`/`invLogMap` results (e.g. "63.47826089859008 %") would overlap the window
   * once Step Sweep shows two of them side by side. A few fields intentionally keep fine
   * decimal precision because their own range is narrow (their display formatter already
   * uses `.toFixed(n)`) — those are rounded to that same precision here instead of to a
   * whole number, so the stored value matches what's shown. */
  const rInt = (v: number): number => Math.round(v);
  const rDec = (v: number, digits: number): number => {
    const f = 10 ** digits;
    return Math.round(v * f) / f;
  };

  /** Reads a device's curated parameters (the ones shown in the window) + a raw-value
   * snapshot of ALL parameters (for the ones not shown, see `applySnapshot`). Mappings
   * still marked `[verify in Live]` in EFFECTS.md (Hz/ms/Q scales) use the same log
   * approximation here as applyOneEffect — so capture→insert→apply stays internally
   * consistent even while the absolute calibration against the Live display remains open. */
  async function captureEffectParams(type: string, device: Device<V>): Promise<EffectParams> {
    const snapshot: Record<string, number> = {};
    for (const p of device.parameters) snapshot[p.name] = await p.getValue();
    const params: EffectParams = { on: true, snapshot };
    switch (type) {
      case "filter": {
        const typeP = device.parameters.find((p) => p.name.toLowerCase() === "filter type");
        const idx = typeP ? await typeP.getValue() : 0;
        params.typeSel = idx === 1 ? "hp" : idx === 2 ? "bp" : "lp";
        params.cutoff = rInt(invLogMap((await readPercent(device, "frequency")) / 100, 20, 20000));
        params.resonance = rInt(await readPercent(device, "resonance"));
        const slopeP = device.parameters.find((p) => p.name.toLowerCase() === "filter slope");
        if (slopeP) params.slope = (await slopeP.getValue()) === 1 ? "24" : "12";
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        break;
      }
      case "delay": {
        const l16 = findParam(device, "l 16th");
        if (l16) { const v = l16.valueItems[Math.round(await l16.getValue())]; if (v) params.sync = `${v.name}/16`; }
        params.feedback = rInt(await readPercent(device, "feedback"));
        const pp = device.parameters.find((p) => p.name.toLowerCase() === "ping pong");
        if (pp) params.pingpong = (await pp.getValue()) === 1;
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        break;
      }
      case "reverb": {
        // Size stays unrounded: the UI's `fmtSz` picks its own precision depending on
        // magnitude (toFixed(2)/(1)/round) — unlike Decay/Cutoff/%, it has no "bare"
        // display without its own rounding.
        params.decay = rInt(invLogMap((await readPercent(device, "decay time")) / 100, 200, 10000));
        params.size = invLogMap((await readPercent(device, "room size")) / 100, 0.22, 500);
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        break;
      }
      case "autopan": {
        const modeP = device.parameters.find((p) => p.name.toLowerCase() === "mode");
        params.typeSel = modeP && (await modeP.getValue()) === 1 ? "tremolo" : "panning";
        params.amount = rInt(await readPercent(device, "amount"));
        params.shape = rInt(await readPercent(device, params.typeSel === "tremolo" ? "tremolo shape" : "panning shape"));
        // Rate/Sync + Dry/Wet (no native Dry/Wet): mapping/rack route still open, see EFFECTS.md §4.
        break;
      }
      case "chorus": {
        const modeP = device.parameters.find((p) => p.name.toLowerCase() === "mode");
        const modeIdx = modeP ? await modeP.getValue() : 0;
        params.typeSel = modeIdx === 1 ? "ensemble" : modeIdx === 2 ? "vibrato" : "chorus";
        // Rate keeps 2 decimal places (the UI shows `toFixed(2)` — typical chorus rates
        // are below 1 Hz, rounding to whole numbers would collapse the slider's range).
        params.rate = rDec(invLogMap((await readPercent(device, "rate")) / 100, 0.1, 15), 2);
        params.amount = rInt(await readPercent(device, "amount"));
        params.feedback = rInt(await readPercent(device, "feedback"));
        const timeP = device.parameters.find((p) => p.name.toLowerCase() === "delay time");
        if (timeP) params.time = CHORUS_TIME_ITEMS[Math.round(await timeP.getValue())] ?? "Auto";
        params.width = rInt((await readPercent(device, "width")) * 2); // scale confirmed: raw*200 (EFFECTS.md §5)
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        break;
      }
      case "echo": {
        const modeP = device.parameters.find((p) => p.name.toLowerCase() === "channel mode");
        const modeIdx = modeP ? await modeP.getValue() : 0;
        params.mode = modeIdx === 1 ? "pingpong" : modeIdx === 2 ? "midside" : "stereo";
        params.feedback = rInt(await readPercent(device, "feedback"));
        params.dryWet = rInt(await readPercent(device, "dry wet")); // the Live name has a space, no slash
        // Rate/Sync: L Sync Mode/L 16th/L Synced mapping not yet fully confirmed, see EFFECTS.md §6.
        break;
      }
      case "erosion": {
        params.noiseBlend = rInt(await readPercent(device, "noise blend"));
        params.stereo = rInt(await readPercent(device, "stereo width"));
        // Width keeps 2 decimal places (the UI shows `toFixed(2)`, narrow range 0.1–2.5).
        params.width = rDec(0.1 + ((await readPercent(device, "filter width")) / 100) * 2.4, 2); // scale confirmed (EFFECTS.md §7)
        params.freq = rInt(invLogMap((await readPercent(device, "frequency")) / 100, 20, 20000));
        params.amount = rInt(await readPercent(device, "amount"));
        // No native Dry/Wet.
        break;
      }
      case "phaserflanger": {
        const modeP = device.parameters.find((p) => p.name.toLowerCase() === "mode");
        const modeIdx = modeP ? await modeP.getValue() : 0;
        params.typeSel = modeIdx === 1 ? "flanger" : modeIdx === 2 ? "doubler" : "phaser";
        params.amount = rInt(await readPercent(device, "amount"));
        const notchesP = device.parameters.find((p) => p.name.toLowerCase() === "notches");
        if (notchesP) params.notches = Math.round(await notchesP.getValue());
        params.center = rInt(invLogMap((await readPercent(device, "center freq")) / 100, 70, 18500));
        params.spread = rInt(await readPercent(device, "spread"));
        // Flanger Time keeps 1 decimal place (the UI shows `toFixed(1)`, narrow range 0.1–20 ms).
        params.timeFlanger = rDec(invLogMap((await readPercent(device, "flanger time")) / 100, 0.1, 20), 1);
        params.timeDoubler = rInt(invLogMap((await readPercent(device, "doubler time")) / 100, 20, 150));
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        // Rate/Sync: index↔division mapping not yet confirmed, see EFFECTS.md §9.
        break;
      }
      case "eq8": {
        // Scale keeps 2 decimal places (the UI shows `toFixed(2)`, narrow range −2…2).
        // No native Dry/Wet to read (confirmed in Live).
        const scaleP = device.parameters.find((p) => p.name.toLowerCase() === "scale");
        if (scaleP) params.scale = rDec(await scaleP.getValue(), 2);
        break;
      }
      case "saturator": {
        const typeP = device.parameters.find((p) => p.name.toLowerCase() === "type");
        const typeIdx = typeP ? Math.round(await typeP.getValue()) : 0;
        params.typeSel = SATURATOR_TYPES[typeIdx] ?? "Analog Clip";
        params.amount = rInt(await readPercent(device, "drive"));
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        break;
      }
      case "vocoder": {
        params.dryWet = rInt(await readPercent(device, "dry/wet"));
        break;
      }
    }
    return params;
  }

  // ── Group detection + clip color (like andiranger) ───────────────────────
  function analyzeGroups(tracks: Track<V>[]) {
    const indexOf = new Map<Track<V>, number>();
    tracks.forEach((t, i) => indexOf.set(t, i));
    const groupSet = new Set<Track<V>>();
    for (const t of tracks) { const g = t.groupTrack; if (g) groupSet.add(g); }
    return {
      isGroup: (t: Track<V>) => groupSet.has(t),
      parentIdx: (t: Track<V>) => { const g = t.groupTrack; return g ? indexOf.get(g) ?? null : null; },
    };
  }
  function firstClipColor(t: Track<V>): string | null {
    const clip = t.arrangementClips[0];
    if (!clip) return null;
    const n = Number(clip.color) & 0xffffff; // color is BigInt-like at runtime
    return "#" + n.toString(16).padStart(6, "0");
  }

  /** Sync division ("3/16" etc.) onto Delay's quantized "L 16th" parameter (valueItems
   * are plain numbers "1".."16" = count of 16th notes, see EFFECTS.md §2). */
  async function setDelaySync(d: Device<V>, sync: string | undefined): Promise<void> {
    await setQuantized(findParam(d, "l sync"), /on/i, "L Sync");
    await setQuantized(findParam(d, "link"), /on/i, "Link");
    const num = String(sync ?? "3/16").split("/")[0] ?? "3";
    await setQuantized(findParam(d, "l 16th"), new RegExp(`^${num}$`), "L 16th");
  }

  // ── Effect stack onto a track OR a rack chain (step i of n) ──────────────
  // All 11 EFFECTS.md effects are wired up (parameter fine-tuning/Hz-ms scales are
  // still `[verify in Live]`, see the comments per effect). `host` is either the
  // transition track directly (the normal case) or the first chain of an Audio
  // Effect Rack ("Insert as effect group"). Order per effect: first `applySnapshot`
  // (raw values from a captured chain, if present — covers all parameters NOT
  // shown in the window), then the curated setters below, which deliberately
  // override the fields visible/adjustable in the window.
  async function applyOneEffect(host: DeviceHost, type: string, c: EffectParams, i: number, n: number, sweepOn: boolean): Promise<void> {
    const idx = host.devices.length;
    const deviceName = EFFECT_DEVICE_NAMES[type];
    if (!deviceName) { console.warn(`[am-transition-tool] Unknown effect type "${type}" (skipped).`); return; }
    const dev = await host.insertDevice(deviceName, idx);
    await applySnapshot(dev, c.snapshot);
    switch (type) {
      case "filter": {
        await setFilterType(dev, c.typeSel);
        await setPercent(findParam(dev, "frequency"), logMap(sweepNum(c.cutoff, c.cutoffTo, i, n, sweepOn), 20, 20000) * 100, "Cutoff");
        await setPercent(findParam(dev, "resonance"), sweepNum(c.resonance, c.resonanceTo, i, n, sweepOn), "Resonance");
        await setQuantized(findParam(dev, "filter slope"), c.slope === "24" ? /24/ : /12/, "Filter Slope");
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        break;
      }
      case "delay": {
        await setDelaySync(dev, c.sync);
        await setPercent(findParam(dev, "feedback"), c.feedback ?? 0, "Feedback");
        await setQuantized(findParam(dev, "ping pong"), c.pingpong ? /on/i : /off/i, "Ping Pong");
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        break;
      }
      case "reverb": {
        // Decay/Size: 0–1 normalized parameters, log mapping (ms/scale) still [verify in Live].
        await setPercent(findParam(dev, "decay time"), logMap(sweepNum(c.decay, c.decayTo, i, n, sweepOn), 200, 10000) * 100, "Decay");
        await setPercent(findParam(dev, "room size"), logMap(c.size ?? 50, 0.22, 500) * 100, "Size");
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        break;
      }
      case "autopan": {
        await setQuantized(findParam(dev, "mode"), c.typeSel === "tremolo" ? /tremolo/i : /panning/i, "Mode");
        await setPercent(findParam(dev, "amount"), sweepNum(c.amount, c.amountTo, i, n, sweepOn), "Amount");
        await setPercent(findParam(dev, c.typeSel === "tremolo" ? "tremolo shape" : "panning shape"), c.shape ?? 50, "Shape");
        // Rate/Sync: "Rate" is not quantized (no valueItems) → index↔division mapping not
        // yet confirmed, the device stays at its inserted default [verify in Live].
        // Dry/Wet: no native parameter, would need a rack Dry/Wet wrapper (not yet implemented).
        break;
      }
      case "chorus": {
        await setQuantized(findParam(dev, "mode"), c.typeSel === "ensemble" ? /ensemble/i : c.typeSel === "vibrato" ? /vibrato/i : /chorus/i, "Mode");
        await setPercent(findParam(dev, "rate"), logMap(Number(c.rate ?? 1), 0.1, 15) * 100, "Rate");
        await setPercent(findParam(dev, "amount"), sweepNum(c.amount, c.amountTo, i, n, sweepOn), "Amount");
        if (c.typeSel === "chorus" || c.typeSel === "ensemble") await setPercent(findParam(dev, "feedback"), c.feedback ?? 0, "Feedback");
        if (c.typeSel === "chorus") {
          const timeIdx = CHORUS_TIME_ITEMS.indexOf(c.time ?? "Auto");
          await setRaw(findParam(dev, "delay time"), timeIdx >= 0 ? timeIdx : 0, "Delay Time");
        }
        await setPercent(findParam(dev, "width"), (sweepNum(c.width, c.widthTo, i, n, sweepOn) / 2), "Width"); // scale confirmed: raw*200
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        break;
      }
      case "echo": {
        await setQuantized(findParam(dev, "channel mode"), c.mode === "pingpong" ? /ping/i : c.mode === "midside" ? /mid/i : /stereo/i, "Channel Mode");
        await setPercent(findParam(dev, "feedback"), c.feedback ?? 0, "Feedback");
        await setPercent(findParam(dev, "dry wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        // Rate/Sync: L Sync Mode (Synced/Triplet/Dotted/16th) + the meaning of L Synced are not
        // yet fully confirmed [verify in Live] — the device stays at its inserted default.
        break;
      }
      case "erosion": {
        await setPercent(findParam(dev, "noise blend"), sweepNum(c.noiseBlend, c.noiseBlendTo, i, n, sweepOn), "Noise Blend");
        await setPercent(findParam(dev, "stereo width"), sweepNum(c.stereo, c.stereoTo, i, n, sweepOn), "Stereo");
        const widthFrac = ((sweepNum(c.width, c.widthTo, i, n, sweepOn) - 0.1) / 2.4) * 100; // scale confirmed (EFFECTS.md §7)
        await setPercent(findParam(dev, "filter width"), widthFrac, "Width");
        await setPercent(findParam(dev, "frequency"), logMap(sweepNum(c.freq, c.freqTo, i, n, sweepOn), 20, 20000) * 100, "Frequency");
        await setPercent(findParam(dev, "amount"), sweepNum(c.amount, c.amountTo, i, n, sweepOn), "Amount");
        // No native Dry/Wet, would need a rack wrapper (not yet implemented).
        break;
      }
      case "phaserflanger": {
        await setQuantized(findParam(dev, "mode"), c.typeSel === "flanger" ? /flanger/i : c.typeSel === "doubler" ? /doubler/i : /phaser/i, "Mode");
        await setPercent(findParam(dev, "amount"), sweepNum(c.amount, c.amountTo, i, n, sweepOn), "Amount");
        if (c.typeSel === "phaser") {
          await setRaw(findParam(dev, "notches"), c.notches ?? 8, "Notches");
          await setPercent(findParam(dev, "center freq"), logMap(c.center ?? 1000, 70, 18500) * 100, "Center");
          await setPercent(findParam(dev, "spread"), sweepNum(c.spread, c.spreadTo, i, n, sweepOn), "Spread");
        }
        if (c.typeSel === "flanger") await setPercent(findParam(dev, "flanger time"), logMap(c.timeFlanger ?? 5, 0.1, 20) * 100, "Flanger Time");
        if (c.typeSel === "doubler") await setPercent(findParam(dev, "doubler time"), logMap(c.timeDoubler ?? 50, 20, 150) * 100, "Doubler Time");
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        // Rate/Sync: same as Auto Pan-Tremolo, not yet confirmed, device stays at its default.
        break;
      }
      case "eq8": {
        // Read-only: applySnapshot above has already copied all band parameters 1:1.
        // Scale is the only exception with its own, sweepable slider (EFFECTS.md §8).
        // EQ Eight has no native Dry/Wet (confirmed in Live) — no rack wrapper for it either
        // (a lone EQ Eight is never >1 active effect on its own), so nothing to set here.
        if (c.scale !== undefined) await setRaw(findParam(dev, "scale"), sweepNum(c.scale, c.scaleTo, i, n, sweepOn), "Scale");
        break;
      }
      case "saturator": {
        const typeIdx = SATURATOR_TYPES.indexOf(c.typeSel ?? "Analog Clip");
        await setRaw(findParam(dev, "type"), typeIdx >= 0 ? typeIdx : 0, "Type");
        await setPercent(findParam(dev, "drive"), sweepNum(c.amount, c.amountTo, i, n, sweepOn), "Drive");
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        break;
      }
      case "vocoder": {
        // Read-only: applySnapshot above has already copied all parameters 1:1.
        await setPercent(findParam(dev, "dry/wet"), sweepNum(c.dryWet, c.dryWetTo, i, n, sweepOn), "Dry/Wet");
        break;
      }
    }
  }

  /** Disable everything inserted at/after `fromIdx` on `track` by setting each device's
   * "Device On" to Off — used for "Also load effects on the original track" (present as a
   * static, silent placeholder for automation drawn in later, per HANDOVER.md §1). Works
   * uniformly whether one Rack device landed there or several serial devices did. */
  async function disableDevicesFrom(track: Track<V>, fromIdx: number): Promise<void> {
    for (let idx = fromIdx; idx < track.devices.length; idx++) {
      const dev = track.devices[idx];
      if (dev) await setQuantized(findParam(dev, "device on"), /off/i, "Device On");
    }
  }

  async function applyFx(track: Track<V>, cfg: TransitionCfg, i: number, n: number, disabled = false): Promise<void> {
    const activeIds = cfg.order.filter((id) => cfg.effects[id]?.on);
    const startIdx = track.devices.length;

    // Insert as an effect group (Rack) whenever there's more than one active effect — no
    // longer an opt-in checkbox, always attempted. Device name + return type are untested
    // [verify in Live] — on any failure, falls back to normal serial insertion (no data
    // loss, only the Rack grouping is skipped).
    if (activeIds.length > 1) {
      try {
        const rackIdx = track.devices.length;
        const rack = await track.insertDevice("Audio Effect Rack", rackIdx);
        if (rack instanceof RackDevice) {
          const chain = rack.chains[0] ?? (await rack.insertChain(0));
          for (const instanceId of activeIds) {
            await applyOneEffect(chain, effectType(instanceId), cfg.effects[instanceId]!, i, n, cfg.sweepOn);
          }
          if (disabled) await disableDevicesFrom(track, startIdx);
          return;
        }
        console.warn(
          `[am-transition-tool] Inserted "Audio Effect Rack" but got no RackDevice back ` +
            `(${rack.constructor.name}) — falling back to serial insertion. [verify in Live]`,
        );
        await track.deleteDevice(rack);
      } catch (e) {
        console.warn(`[am-transition-tool] Rack creation failed (${e}) — falling back to serial insertion. [verify in Live: device name "Audio Effect Rack"?]`);
      }
    }

    for (const instanceId of activeIds) {
      await applyOneEffect(track, effectType(instanceId), cfg.effects[instanceId]!, i, n, cfg.sweepOn);
    }
    if (disabled) await disableDevicesFrom(track, startIdx);
  }

  // ── Build one transition on a track (end = end of the clicked clip) ──────
  // Effect length = clip length (`clipLenBeats`, the same session-wide for all
  // transitions/tracks) minus the active silence duration. Silence always sits at
  // the end of the signal chain: [end - silenceBars, end). If an effect is also
  // active, its range shifts directly in front of it. Without silence, the effect
  // fills the whole clip. The original is cleared over the (contiguous) total
  // span, the effect copy only covers its own part.
  async function buildForTrack(track: Track<V>, end: number, clipLenBeats: number, cfg: TransitionCfg): Promise<void> {
    const hasFx = cfg.order.some((id) => cfg.effects[id]?.on);
    const silLen = (cfg.silenceBars ?? 0) * BEATS_PER_BAR;
    const silStart = end - silLen;
    const effLen = hasFx ? Math.max(0, clipLenBeats - silLen) : 0;
    const effEnd = hasFx && silLen > 0 ? silStart : end;
    const effStart = effEnd - effLen;
    const colorNum = colorToNum(cfg.color);

    // With no clip content in the range to process, there's nothing to do — so don't
    // create an (empty) slice track either. Range = [effStart, end) with an effect, otherwise [silStart, end).
    const regionStart = Math.max(0, hasFx ? effStart : silStart);
    const hasClipInRegion = track.arrangementClips.some((c) => Number(c.startTime) < end && Number(c.endTime) > regionStart);
    if (!hasClipInRegion) {
      console.log(`[am-transition-tool] "${track.name}" has no clip in the processing range — skipped (no new track created).`);
      return;
    }

    if (!hasFx) {
      // Pure silence (or an empty transition): just remove the silence region.
      if (silLen > 0) await track.clearClipsInRange(Math.max(0, silStart), end);
      return;
    }
    if (effLen <= 0) {
      // Silence duration >= clip length (e.g. a stale preset on a shorter clip) — no room
      // left for the effect; just apply the silence instead of building a 0-bar slice.
      console.warn(`[am-transition-tool] Effect length <= 0 for "${cfg.title || "Transition"}" (silence duration >= selection length) — effect skipped.`);
      if (silLen > 0) await track.clearClipsInRange(Math.max(0, silStart), end);
      return;
    }

    const clearStart = Math.max(0, effStart);
    const n = cfg.sweepOn && (cfg.sweepSteps === 2 || cfg.sweepSteps === 4 || cfg.sweepSteps === 8) ? cfg.sweepSteps : 1;
    const sliceLen = effLen / n;

    // 1) Draw copies from the intact original (native full copies). `duplicateTrack`
    // always inserts the copy track DIRECTLY AFTER the original — with ascending
    // creation, step N (created last) would end up right behind the original and
    // step 1 furthest away. So create them in descending order (step N first, step 1
    // last), so the last-created step 1 ends up directly behind the original and the
    // track order afterward is ascending: original → step 1 → step 2 → … → step N.
    const dups: Track<V>[] = new Array(n);
    for (let i = n - 1; i >= 0; i--) dups[i] = (await api.application.song.duplicateTrack(track)) as Track<V>;

    // 2) Clear the original over the union (effect + any longer silence).
    await track.clearClipsInRange(clearStart, end);

    // 3) Per copy, keep only its effect slice + color + effect stack.
    for (let i = 0; i < n; i++) {
      const dup = dups[i];
      if (!dup) continue;
      const s = Math.max(0, effStart + i * sliceLen);
      const e = s + sliceLen;
      if (s > 0) await dup.clearClipsInRange(0, s);
      await dup.clearClipsInRange(e, e + 1e9);
      dup.name = NAME_PREFIX + track.name + (n > 1 ? ` TR ${i + 1}/${n}` : " TR");
      if (colorNum != null) for (const cl of dup.arrangementClips) cl.color = colorNum;
      await applyFx(dup, cfg, i, n);
    }

    // 4) Optionally load the same devices (statically, disabled) onto the original track too —
    //    for automation drawn in manually later (KONZEPT: workaround for "no automation").
    //    Disabled so they don't affect the original track's sound until the user re-enables them.
    if (cfg.applyToOriginal) await applyFx(track, cfg, 0, 1, true);
  }

  // ── Command: transition from an arrangement time selection ───────────────
  api.commands.registerCommand("transition.fromSelection", (arg: unknown) =>
    void (async () => {
      const sel = arg as ArrangementSelection;
      const clipStart = Number(sel.time_selection_start);
      const clipEnd = Number(sel.time_selection_end);
      if (!(clipEnd > clipStart)) {
        console.error("[am-transition-tool] No valid time selection (range is empty).");
        return;
      }
      const clipLenBeats = clipEnd - clipStart;
      const clipBars = clipLenBeats / BEATS_PER_BAR;

      const song = api.application.song;
      const tracks = song.tracks;
      const grp = analyzeGroups(tracks);

      // Resolve the marked tracks (Track directly; TakeLane → its parent track),
      // dedupe, as an index into `tracks` (= the ids the dialog uses). Tracks we
      // generated ourselves (name prefix) are filtered out here just like below for
      // `data.tracks` — otherwise an id would end up in `selectedTrackIds` that
      // doesn't exist in `data.tracks`/`byId` at all (bugfix: this used to crash
      // rendering the track pills/library list → a blank window that persisted
      // across the saved draft, since `defaultMatrixAssign` permanently picked up
      // the broken id).
      const selectedTrackIds: number[] = [];
      const seenTracks = new Set<Track<V>>();
      for (const h of sel.selected_lanes) {
        const obj = api.getObjectFromHandle(h, DataModelObject);
        let t: Track<V> | null = null;
        if (obj instanceof Track) t = obj as Track<V>;
        else if (obj instanceof TakeLane && obj.parent instanceof Track) t = obj.parent as Track<V>;
        if (t && !seenTracks.has(t) && !t.name.startsWith(NAME_PREFIX)) {
          seenTracks.add(t);
          const idx = tracks.indexOf(t);
          if (idx >= 0) selectedTrackIds.push(idx);
        }
      }

      const persisted = loadState();
      const data = {
        clipBars,
        selectedTrackIds, // immediately assigned to the newly created transition in the dialog
        // Tracks we generated ourselves (name prefix) aren't targets for another
        // transition — hide them from the selection/assignment list on reopen.
        // `id` stays the real index in `tracks` (the array is filtered after the mapping, not before).
        tracks: tracks
          .map((t, i) => ({
            id: i,
            name: t.name,
            isGroup: grp.isGroup(t),
            group: grp.parentIdx(t),
            // Only tracks with content IN THE SELECTED RANGE count as "hasContent" (not globally).
            hasContent: t.arrangementClips.some((c) => Number(c.startTime) < clipEnd && Number(c.endTime) > clipStart),
            color: firstClipColor(t),
          }))
          .filter((_, i) => !tracks[i]!.name.startsWith(NAME_PREFIX)),
        userPresets: persisted.userPresets,
        libPresets: persisted.libPresets,
        draft: lastDraft, // this session's in-memory working state (library/assignments)
        capturedChain, // in-memory, see "transition.captureChain" below (HANDOVER.md §9)
      };

      const html = dialogHtml.replace("__TRANSITION_DATA__", JSON.stringify(data));
      const raw = await api.ui.showModalDialog(`data:text/html,${encodeURIComponent(html)}`, DIALOG_W, DIALOG_H);
      const result = JSON.parse(raw) as DialogResult | null;
      if (!result) { console.log("[am-transition-tool] Dialog closed without a result."); return; }

      // Remember the working state (session) + persist presets — always, even on
      // cancel, so the next invocation shows the latest state.
      lastDraft = result.draft ?? lastDraft;
      const draft = result.draft ?? {};
      saveState({
        userPresets: Array.isArray(draft.userPresets) ? draft.userPresets : persisted.userPresets,
        libPresets: Array.isArray(draft.libPresets) ? draft.libPresets : persisted.libPresets,
      });

      if (result.cancelled) { console.log("[am-transition-tool] Cancelled — work kept for this session."); return; }

      // Combine all mutations (all transitions × all tracks) into ONE undo step.
      // withinTransaction requires a synchronous callback, but accepts any Promise it
      // returns (even with sequential awaits inside) — the transaction stays open
      // until that Promise resolves (SDK docs: "returning Promise.all([...]) lets
      // you group multiple async operations into one undo step").
      let built = 0;
      const total = result.plan.reduce((sum, item) => sum + item.trackIds.length, 0);
      const runApply = async (update?: (text: string, progress?: number) => Promise<void>) => {
        await api.withinTransaction(() =>
          (async () => {
            let step = 0;
            for (const item of result.plan) {
              for (const id of item.trackIds) {
                const track = tracks[id];
                if (!track) continue;
                step++;
                if (update) {
                  const percent = Math.round((step / total) * 100);
                  await update(`Applying "${item.cfg.title || "Transition"}" to "${track.name}" (${step}/${total})…`, percent);
                }
                try {
                  await buildForTrack(track, clipEnd, clipLenBeats, item.cfg);
                  built++;
                } catch (e) {
                  console.error(`[am-transition-tool] Error for "${track.name}" / "${item.cfg.title || "Transition"}": ${e}`);
                }
              }
            }
          })(),
        );
      };
      // A progress dialog is only worth showing when there's actually something to wait for
      // (a complex transition with several sweep tracks/effects can take a few seconds).
      if (total > 0) await api.ui.withinProgressDialog("Applying transitions…", { progress: 0 }, (update) => runApply(update));
      else await runApply();
      console.log(
        `[am-transition-tool] ✓ ${result.plan.length} transition(s), ${built} track application(s) ` +
          `at selection end (beat ${clipEnd}, length ${clipBars} bars). ` +
          `Grouping is not possible via the SDK → "${NAME_PREFIX}" name prefix used instead.`,
      );
    })().catch((e) => console.error(`[am-transition-tool] ${e}`)),
  );

  for (const scope of ["AudioTrack.ArrangementSelection", "MidiTrack.ArrangementSelection"] as const) {
    api.ui.registerContextMenuAction(scope, "Create transition…", "transition.fromSelection");
  }

  // ── Command: capture a track's effect chain (HANDOVER.md §9) ─────────────
  // Second command of the same extension (no cross-extension IPC, see the
  // JS-Sweeper reference in §9) — reads all of a track's devices, matches them
  // against the 11 known Live device names, and stores the result in
  // `capturedChain`. Unrecognized devices are skipped; their names go into
  // `skipped` for the hint shown when inserting in the transition window.
  api.commands.registerCommand("transition.captureChain", (arg: unknown) =>
    void (async () => {
      const track = api.getObjectFromHandle(arg as Handle, Track);
      const chain: CapturedEffect[] = [];
      const skipped: string[] = [];
      // Racks/groups can nest devices inside their chains (RackDevice.chains[].devices) —
      // recurse so effects loaded into a Rack (e.g. via "Insert as effect group") on the
      // source track are captured too, not just the top-level device list.
      const flatDevices: Device<V>[] = [];
      // Rack containers themselves are pure pass-throughs (not a recognized effect type,
      // and not worth reporting as "skipped") — only their nested chain devices are collected.
      const collect = (devices: Device<V>[]) => {
        for (const d of devices) {
          if (d instanceof RackDevice) { for (const ch of d.chains) collect(ch.devices); continue; }
          flatDevices.push(d);
        }
      };
      collect(track.devices);

      const total = flatDevices.length;
      // A device with many parameters (e.g. Roar had 93) can take a noticeable amount of
      // time to read one-by-one — a progress dialog makes the wait visible instead of the
      // user assuming nothing happened and reopening the extension mid-capture.
      if (total > 0) {
        await api.ui.withinProgressDialog(`Capturing effect chain from "${track.name}"…`, { progress: 0 }, async (update) => {
          for (let i = 0; i < total; i++) {
            const device = flatDevices[i]!;
            const percent = Math.round(((i + 1) / total) * 100);
            const type = matchEffectType(device.name);
            if (!type) {
              skipped.push(device.name);
              await update(`Skipping "${device.name}" — not recognized (${i + 1}/${total})…`, percent);
              continue;
            }
            await update(`Capturing "${device.name}" (${i + 1}/${total})…`, percent);
            chain.push({ type, params: await captureEffectParams(type, device) });
          }
        });
      }
      capturedChain = { chain, skipped };
      console.log(
        `[am-transition-tool] Captured ${chain.length} effect(s) from "${track.name}"` +
          (skipped.length ? ` — skipped (not recognized): ${skipped.join(", ")}` : "") + ".",
      );
      // Surface this immediately — the user may not open "Insert captured chain" for a
      // long time afterward (or at all), so a console-only log is easy to miss entirely.
      // Deliberately silent on full success (no popup needed when everything worked).
      if (skipped.length > 0) {
        const capturedNames = chain.map((c) => EFFECT_DEVICE_NAMES[c.type] ?? c.type).join("\n");
        const msg =
          `Captured ${chain.length} effect(s) from "${track.name}".\n\n` +
          (capturedNames ? `${capturedNames}\n\n` : "") +
          `Skipped ${skipped.length} unrecognized device(s): ${skipped.join(", ")}.\n` +
          `Only Ableton's default device names are recognized — if you renamed one, rename it back and capture again.`;
        await api.ui.showModalDialog(`data:text/html,${encodeURIComponent(noticeHtml(msg))}`, 420, 300);
      }
    })().catch((e) => console.error(`[am-transition-tool] Capture failed: ${e}`)),
  );
  for (const scope of ["AudioTrack", "MidiTrack"] as const) {
    api.ui.registerContextMenuAction(scope, "Capture effect chain", "transition.captureChain");
  }
}
