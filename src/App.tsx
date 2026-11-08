import { useCallback, useEffect, useRef, useState } from "react";
import {
  TindeqProgressor,
  UserCanceledError,
  type ForceSample,
} from "./tindeq.ts";
import { playFinalBeep, playHoldBeep, unlockAudio } from "./sounds.ts";

const HOLD_SECONDS = 6;
const HOLD_MS = HOLD_SECONDS * 1000;
// Reps in a set; the round counter's color tracks progress toward it.
const SET_REPS = 6;
// The load that counts as "the user is pulling". Doubles as the floor for the
// target weight: a mistyped target this low is exceeded by almost any resting
// load, which would drop the app straight into the hold view where the field is
// hidden and the target can no longer be corrected.
const MIN_TARGET_KG = 2;

type ConnState = "disconnected" | "connecting" | "connected";
type Phase = "idle" | "waiting" | "holding" | "success";

// 0 is the left side, 1 the right. With alternation off only side 0 is used.
type Side = 0 | 1;
const SIDE_NAMES = ["left", "right"] as const;
const SIDE_LETTERS = ["L", "R"] as const;

// Each side of the body has its own target and its own set. The committed
// target and the raw field text diverge while the field holds a rejected value
// (empty or below MIN_TARGET_KG): the previous target stays in force so a typo
// can't strand the app in the hold view.
interface SideState {
  targetKg: number;
  targetText: string;
  successes: number;
  failures: number;
}

function freshSide(targetKg: number): SideState {
  return { targetKg, targetText: String(targetKg), successes: 0, failures: 0 };
}

function updateSide(
  sides: readonly [SideState, SideState],
  side: Side,
  f: (s: SideState) => SideState,
): [SideState, SideState] {
  return side === 0 ? [f(sides[0]), sides[1]] : [sides[0], f(sides[1])];
}

function isValidTarget(raw: string): boolean {
  const value = Number(raw);
  return raw.trim() !== "" && Number.isFinite(value) && value >= MIN_TARGET_KG;
}

export function App() {
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [sides, setSides] = useState<[SideState, SideState]>(() => [
    freshSide(20),
    freshSide(20),
  ]);
  // Whether the user is training one side at a time, alternating between them.
  const [alternating, setAlternating] = useState(false);
  // The side whose target is in force and whose counter the next rep goes to.
  const [active, setActive] = useState<Side>(0);
  const targetKg = sides[active].targetKg;

  // Live values are rendered from a requestAnimationFrame loop reading refs, so
  // the incoming stream of samples never floods React with state updates.
  const [force, setForce] = useState(0);
  const [remaining, setRemaining] = useState(HOLD_MS);
  const [restMs, setRestMs] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");

  // Mutable state read inside the BLE sample handler (which is registered once).
  const targetRef = useRef(targetKg);
  const holdStartRef = useRef<number | null>(null);
  // Timestamp of when the current rest period started, or null while a rep is
  // under way. Set when the detailed screen comes back; cleared when a rep
  // starts.
  const restStartRef = useRef<number | null>(null);
  // Index of the next per-second progress beep (0..5) to play in this hold.
  const nextBeepRef = useRef(0);
  const forceRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");
  const activeRef = useRef<Side>(0);
  // The side whose target field holds focus. Independent of the active side:
  // clicking a field lets the user edit either side's target without changing
  // whose turn it is.
  const focusedSideRef = useRef<Side>(0);
  const alternatingRef = useRef(false);
  // Set when a hold succeeds; the side then switches once the user lets go and
  // the detailed screen returns. Switching at the moment of success would swap
  // the target under the big readout while they're still pulling.
  const pendingSwitchRef = useRef(false);
  // The sides that failures were logged against, most recent last, so that
  // Shift+Space can take a failure back off the side it was logged on.
  const failureLogRef = useRef<Side[]>([]);

  const deviceRef = useRef<TindeqProgressor | null>(null);
  const targetInputRefs = useRef<(HTMLInputElement | null)[]>([null, null]);

  useEffect(() => {
    targetRef.current = targetKg;
  }, [targetKg]);

  const selectSide = useCallback((side: Side) => {
    activeRef.current = side;
    setActive(side);
  }, []);

  const onTargetChange = useCallback(
    (side: Side, raw: string) => {
      if (!isValidTarget(raw) || Number(raw) === sides[side].targetKg) {
        setSides((prev) =>
          updateSide(prev, side, (s) => ({ ...s, targetText: raw })),
        );
        return;
      }
      // Changing the target weight starts a fresh set — reset the counters.
      failureLogRef.current = failureLogRef.current.filter((s) => s !== side);
      setSides((prev) =>
        updateSide(prev, side, () => ({
          ...freshSide(Number(raw)),
          targetText: raw,
        })),
      );
    },
    [sides],
  );

  // Switching modes starts a fresh set on both sides, each from the target
  // that was in use.
  const setAlternatingMode = useCallback(
    (on: boolean) => {
      alternatingRef.current = on;
      setAlternating(on);
      pendingSwitchRef.current = false;
      failureLogRef.current = [];
      selectSide(0);
      // The right field goes away when alternation is switched off.
      focusedSideRef.current = 0;
      setSides(([left]) => [
        freshSide(left.targetKg),
        freshSide(left.targetKg),
      ]);
    },
    [selectSide],
  );

  const setPhaseBoth = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const handleSample = useCallback(
    (sample: ForceSample) => {
      const f = sample.weight;
      forceRef.current = f;

      const phase = phaseRef.current;
      if (phase === "idle") return; // not connected / not measuring
      const target = targetRef.current;

      switch (phase) {
        case "waiting":
          // Below target, ready. Start the countdown once force reaches target.
          // The per-second progress beeps are fired from the render loop; arming
          // beep 0 here makes it sound the instant we cross the threshold.
          if (f >= target) {
            holdStartRef.current = performance.now();
            restStartRef.current = null; // rep started — stop the rest timer
            nextBeepRef.current = 0;
            setPhaseBoth("holding");
          }
          break;
        case "holding": {
          // Counting down — check for drop-out or completion.
          const heldMs =
            holdStartRef.current === null
              ? 0
              : performance.now() - holdStartRef.current;
          if (f < target) {
            holdStartRef.current = null;
            setPhaseBoth("waiting");
            // Beeps just stop — going silent is the out-of-range cue. Failed
            // reps aren't auto-counted; the user logs them with the Space key.
          } else if (heldMs >= HOLD_MS) {
            holdStartRef.current = null;
            setPhaseBoth("success");
            playFinalBeep(); // the emphatic 7th beep
            setSides((prev) =>
              updateSide(prev, activeRef.current, (s) => ({
                ...s,
                successes: s.successes + 1,
              })),
            );
            pendingSwitchRef.current = true;
          }
          break;
        }
        case "success":
          // Hold completed. Wait for a release below target before arming the
          // next rep, so a sustained pull doesn't immediately re-trigger.
          if (f < target) setPhaseBoth("waiting");
          break;
      }
    },
    [setPhaseBoth],
  );

  // Render loop for smooth live force + countdown.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setForce(forceRef.current);
      if (holdStartRef.current !== null) {
        const elapsed = performance.now() - holdStartRef.current;
        setRemaining(Math.max(0, HOLD_MS - elapsed));
        // Fire the per-second progress beeps (t = 0..5s) as their marks pass.
        // The t=6s beep is the emphatic final one, played on success instead.
        while (
          nextBeepRef.current < HOLD_SECONDS &&
          elapsed >= nextBeepRef.current * 1000
        ) {
          playHoldBeep(nextBeepRef.current);
          nextBeepRef.current += 1;
        }
      } else {
        if (phaseRef.current !== "success") setRemaining(HOLD_MS);
        // Below the threshold and resting: run the count-up rest timer.
        if (restStartRef.current !== null) {
          setRestMs(performance.now() - restStartRef.current);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const connected = connState === "connected";
  const inRange = force >= targetKg;
  // The distraction-free view takes over as soon as there is real load on the
  // device, not just during a qualifying hold: once the user is pulling they
  // can't read the detailed layout anyway, and seeing the big number while
  // still short of the target is what tells them how much harder to pull.
  const simplified = connected && force > MIN_TARGET_KG;

  // Focus the last-focused weight field with its contents selected, so the
  // next digit typed replaces the old target instead of being appended to it.
  const selectTarget = useCallback(() => {
    const input = targetInputRefs.current[focusedSideRef.current];
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  // Keep the weight field focused: on first load, whenever we return to the
  // detailed view (e.g. force drops back below the threshold after a hold), and
  // when switching modes adds or removes the right side's field.
  const detailedView = !simplified;
  const detailedViewRef = useRef(detailedView);
  detailedViewRef.current = detailedView;
  useEffect(() => {
    if (detailedView) selectTarget();
  }, [detailedView, alternating, selectTarget]);

  // A successful hold hands over to the other side once the user lets go.
  useEffect(() => {
    if (!detailedView || !pendingSwitchRef.current) return;
    pendingSwitchRef.current = false;
    if (alternatingRef.current) selectSide(activeRef.current === 0 ? 1 : 0);
  }, [detailedView, selectSide]);

  // …and take it back if anything else steals it (clicking a button, or
  // returning to the tab). Bounced through a frame so the click that moved
  // focus is delivered to its target first.
  const refocusTarget = useCallback(() => {
    requestAnimationFrame(() => {
      if (detailedViewRef.current) selectTarget();
    });
  }, [selectTarget]);
  useEffect(() => {
    window.addEventListener("focus", refocusTarget);
    return () => window.removeEventListener("focus", refocusTarget);
  }, [refocusTarget]);

  // Rest is the gap between pulls, so it starts when the user lets go of the
  // device and this screen comes back — not when the force dips under the
  // target, which also happens mid-rep while they're still hanging on.
  useEffect(() => {
    if (connected && detailedView) restStartRef.current = performance.now();
  }, [connected, detailedView]);

  // Space logs a failed rep. Failures aren't auto-detected, so a mistimed or
  // aborted attempt is only recorded when the user presses Space. A failed rep
  // is still that side's turn, so when alternating it hands over to the other
  // side just as a success does.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Space corrects an over-count by decrementing (floored at 0),
          // and goes back to the side the failure was logged on.
          const side = failureLogRef.current.pop() ?? activeRef.current;
          setSides((prev) =>
            updateSide(prev, side, (s) => ({
              ...s,
              failures: Math.max(0, s.failures - 1),
            })),
          );
          if (alternatingRef.current) selectSide(side);
        } else {
          const side = activeRef.current;
          failureLogRef.current.push(side);
          setSides((prev) =>
            updateSide(prev, side, (s) => ({
              ...s,
              failures: s.failures + 1,
            })),
          );
          if (alternatingRef.current) selectSide(side === 0 ? 1 : 0);
        }
      } else if (
        alternatingRef.current &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        (e.key.toLowerCase() === "l" || e.key.toLowerCase() === "r")
      ) {
        // L and R pick a side by hand, e.g. to start on the right or to do two
        // reps in a row on one side.
        e.preventDefault();
        selectSide(e.key.toLowerCase() === "l" ? 0 : 1);
      } else if (e.key === "Enter") {
        // Nothing to submit — Enter just re-arms the field for a new target.
        e.preventDefault();
        selectTarget();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectTarget, selectSide]);

  const connect = useCallback(async () => {
    setError(null);
    await unlockAudio();
    const dev = new TindeqProgressor({
      onSample: handleSample,
      onDisconnect: () => {
        setConnState("disconnected");
        setPhaseBoth("idle");
        holdStartRef.current = null;
        restStartRef.current = null;
      },
    });
    deviceRef.current = dev;
    try {
      setConnState("connecting");
      await dev.connect();
      // Zero the scale on every connect; tare() also starts the measurement.
      await dev.tare();
      setConnState("connected");
      holdStartRef.current = null;
      setRestMs(0); // the effect above starts the clock for the first rep
      setPhaseBoth("waiting");
    } catch (e) {
      setConnState("disconnected");
      deviceRef.current = null;
      if (e instanceof UserCanceledError) {
        // User closed the device chooser — not really an error.
        return;
      }
      console.error("[tindeq] connect failed", e);
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }, [handleSample, setPhaseBoth]);

  const tare = useCallback(async () => {
    try {
      await deviceRef.current?.tare();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    return () => {
      void deviceRef.current?.disconnect();
    };
  }, []);

  // While pulling, show the distraction-free view: just the difference from the
  // target and the integer countdown, both large. The total weight stays
  // visible underneath in a smaller font. The difference is colored by whether
  // the target is actually met, so a short pull reads as short at a glance.
  if (simplified) {
    const countdownSec =
      phase === "success" ? 0 : Math.max(0, Math.ceil(remaining / 1000));
    // Round before picking the sign, so a hair under the target reads "+0.0"
    // rather than "−0.0".
    const excess = Number((force - targetKg).toFixed(1));
    return (
      <div className={`app phase-${phase} simplified`}>
        <div className="big-readout">
          {/* The app picks the side, so say which one to pull with. */}
          {alternating && (
            <div className="big-side">{SIDE_LETTERS[active]}</div>
          )}
          <div className="big-stack">
            <div className={`big-value ${inRange ? "force-good" : "force-bad"}`}>
              {excess < 0 ? "−" : "+"}
              {kg1(Math.abs(excess))}
              <span className="big-unit">kg</span>
            </div>
            <div className="big-subvalue">
              {kg1(force)}
              <span className="sub-unit">kg total</span>
            </div>
          </div>
          <div className="big-value">
            {countdownSec}
            <span className="big-unit">s</span>
          </div>
        </div>
      </div>
    );
  }

  const shownSides: Side[] = alternating ? [0, 1] : [0];
  const sideClass = (side: Side) =>
    alternating && side === active ? "active" : "";
  const sideLabel = (side: Side, label: string) =>
    alternating ? `${SIDE_NAMES[side]} ${label}` : label;

  return (
    <div className={`app phase-${phase}`}>
      {/* Deliberately only in the detailed view — the hold view stays bare. */}
      <a
        className="repo-link"
        href="https://github.com/malcolmredheron/tindeq-iso/"
        target="_blank"
        rel="noreferrer"
        title="Source on GitHub"
        aria-label="Source on GitHub"
      >
        <GitHubMark />
      </a>

      <h1>Tindeq Isometric Trainer</h1>

      {!TindeqProgressor.isSupported() && (
        <p className="warn">
          Web Bluetooth isn't available in this browser. Use Chrome, Edge, or
          another Chromium-based browser over https:// or localhost.
        </p>
      )}

      {shownSides.map(
        (side) =>
          !isValidTarget(sides[side].targetText) && (
            <p key={side} className="warn">
              {alternating
                ? `The ${SIDE_NAMES[side]} target weight`
                : "Target weight"}{" "}
              must be at least {MIN_TARGET_KG} kg — still using{" "}
              {sides[side].targetKg} kg.
            </p>
          ),
      )}

      {error && <p className="warn">{error}</p>}

      <section className={`readout ${alternating ? "alternating" : ""}`}>
        {/* Keep the press from taking focus off the weight field. Otherwise it
            is handed straight back with its text selected mid-click, and
            Chrome ignores a click on a label once text has been selected
            during it — so only a click on the box itself would register. */}
        <label
          className="hint mode-toggle"
          onMouseDown={(e) => e.preventDefault()}
        >
          <input
            type="checkbox"
            checked={alternating}
            onChange={(e) => setAlternatingMode(e.target.checked)}
          />
          Alternate left and right
        </label>
        {alternating && (
          <p className="hint">
            Sides swap after each rep. Press <kbd>L</kbd> or <kbd>R</kbd> to
            choose one.
          </p>
        )}

        {/* The weights, as one row of tiles matching the counters below. When
            alternating, each side gets its own column of target and counter,
            and the side whose turn it is is highlighted. */}
        <div className="tiles">
          {shownSides.map((side) => (
            <label
              key={side}
              className={`tile ${sideClass(side)}`}
            >
              <input
                ref={(el) => {
                  targetInputRefs.current[side] = el;
                }}
                type="number"
                min={MIN_TARGET_KG}
                step="any"
                autoFocus={side === 0}
                value={sides[side].targetText}
                aria-invalid={!isValidTarget(sides[side].targetText)}
                onChange={(e) => onTargetChange(side, e.target.value)}
                onFocus={() => {
                  focusedSideRef.current = side;
                }}
                onBlur={refocusTarget}
              />
              <span className="label">{sideLabel(side, "target (kg)")}</span>
            </label>
          ))}

          {/* Until the device is talking to us there is no weight to read, so
              connecting takes that slot. */}
          {connected ? (
            // Connecting tares, but the reading can drift or the device may
            // have been loaded then, so a click zeroes it again.
            <button
              className="tile"
              onClick={tare}
              title="Click to tare (reset to zero). Take the load off first."
            >
              <span className="value">{kg1(force)}</span>
              <span className="label">measured (kg)</span>
            </button>
          ) : (
            <button
              className="tile connect primary"
              onClick={connect}
              disabled={connState === "connecting"}
            >
              {connState === "connecting" ? "Connecting…" : "Connect Progressor"}
            </button>
          )}
        </div>

        <div className="tiles">
          {/* Orange once a rep has failed, red if the set has run its length
              with a failure in it, green for a clean full set, otherwise
              plain. */}
          {shownSides.map((side) => {
            const { successes, failures } = sides[side];
            return (
              <div
                key={side}
                className={`tile reps ${sideClass(side)} ${
                  failures > 0
                    ? successes + failures >= SET_REPS
                      ? "set-failed"
                      : "some-failed"
                    : successes >= SET_REPS
                      ? "set-succeeded"
                      : ""
                }`}
                onClick={() => selectSide(side)}
              >
                <span className="value">
                  {successes}/{successes + failures}
                </span>
                <span className="label">
                  {sideLabel(side, "succeeded / total")}
                </span>
              </div>
            );
          })}
          {/* Below the threshold: count up to track rest between reps. Whole
              seconds only — a M:SS clock reads as more precision than a rest
              gap needs, and the sibling counters are bare numbers. */}
          <div className="tile rest">
            <span className="value">{Math.floor(restMs / 1000)}</span>
            <span className="label">rest (s)</span>
          </div>
        </div>

        <p className="hint">Successful holds are counted automatically.</p>
        <p className="hint">
          <kbd>Space</kbd> to log failure, <kbd>Shift</kbd>+<kbd>Space</kbd> to
          undo
        </p>
      </section>
    </div>
  );
}

/** The GitHub "Octocat" mark, from https://github.com/logos. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}

/**
 * Format a weight to one decimal. A tiny negative reading — sensor noise around
 * zero, or an over-generous tare — would otherwise render as "-0.0"; collapse
 * that to "0.0".
 */
function kg1(kg: number): string {
  const rounded = Number(kg.toFixed(1));
  return (rounded === 0 ? 0 : rounded).toFixed(1);
}
