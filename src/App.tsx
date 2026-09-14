import { useCallback, useEffect, useRef, useState } from "react";
import {
  TindeqProgressor,
  UserCancelledError,
  type ForceSample,
} from "./tindeq.ts";
import { playFinalBeep, playHoldBeep, unlockAudio } from "./sounds.ts";

const HOLD_SECONDS = 6;
const HOLD_MS = HOLD_SECONDS * 1000;
// A mistyped target this low is exceeded by almost any resting load, which
// would drop the app straight into the hold view where the field is hidden and
// the target can no longer be corrected.
const MIN_TARGET_KG = 1;

type ConnState = "disconnected" | "connecting" | "connected";
type Phase = "idle" | "waiting" | "holding" | "success";

export function App() {
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  // The committed target, plus the raw field text. The two diverge while the
  // field holds a rejected value (empty or below MIN_TARGET_KG): the previous
  // target stays in force so a typo can't strand the app in the hold view.
  const [targetKg, setTargetKg] = useState(20);
  const [targetText, setTargetText] = useState("20");
  const [targetError, setTargetError] = useState<string | null>(null);

  // Live values are rendered from a requestAnimationFrame loop reading refs, so
  // the incoming stream of samples never floods React with state updates.
  const [force, setForce] = useState(0);
  const [remaining, setRemaining] = useState(HOLD_MS);
  const [restMs, setRestMs] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [successes, setSuccesses] = useState(0);
  const [failures, setFailures] = useState(0);

  // Mutable state read inside the BLE sample handler (which is registered once).
  const targetRef = useRef(targetKg);
  const holdStartRef = useRef<number | null>(null);
  // When below the threshold, timestamp of when the rest period started (used
  // for the count-up rest timer). Non-null only while phase is "waiting".
  const restStartRef = useRef<number | null>(null);
  // Index of the next per-second progress beep (0..5) to play in this hold.
  const nextBeepRef = useRef(0);
  const forceRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");

  const deviceRef = useRef<TindeqProgressor | null>(null);
  const targetInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    targetRef.current = targetKg;
    // Changing the target weight starts a fresh set — reset the counters.
    setSuccesses(0);
    setFailures(0);
  }, [targetKg]);

  const onTargetChange = useCallback(
    (raw: string) => {
      setTargetText(raw);
      const value = Number(raw);
      if (
        raw.trim() === "" ||
        !Number.isFinite(value) ||
        value < MIN_TARGET_KG
      ) {
        setTargetError(
          `Target weight must be at least ${MIN_TARGET_KG} kg — still using ${targetKg} kg.`,
        );
        return;
      }
      setTargetError(null);
      setTargetKg(value);
    },
    [targetKg],
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
            restStartRef.current = performance.now(); // start resting
            setPhaseBoth("waiting");
            // Beeps just stop — going silent is the out-of-range cue. Failed
            // reps aren't auto-counted; the user logs them with the Space key.
          } else if (heldMs >= HOLD_MS) {
            holdStartRef.current = null;
            setPhaseBoth("success");
            playFinalBeep(); // the emphatic 7th beep
            setSuccesses((n) => n + 1);
          }
          break;
        }
        case "success":
          // Hold completed. Wait for a release below target before arming the
          // next rep, so a sustained pull doesn't immediately re-trigger.
          if (f < target) {
            restStartRef.current = performance.now(); // start resting
            setPhaseBoth("waiting");
          }
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

  // Keep the weight field focused: on first load, and whenever we return to the
  // detailed view (e.g. force drops back below the threshold after a hold).
  const detailedView = !(phase === "holding" || phase === "success");
  const detailedViewRef = useRef(detailedView);
  detailedViewRef.current = detailedView;
  useEffect(() => {
    if (detailedView) targetInputRef.current?.focus();
  }, [detailedView]);

  // …and take it back if anything else steals it (clicking a button, or
  // returning to the tab). Bounced through a frame so the click that moved
  // focus is delivered to its target first.
  const refocusTarget = useCallback(() => {
    requestAnimationFrame(() => {
      if (detailedViewRef.current) targetInputRef.current?.focus();
    });
  }, []);
  useEffect(() => {
    window.addEventListener("focus", refocusTarget);
    return () => window.removeEventListener("focus", refocusTarget);
  }, [refocusTarget]);

  // Space logs a failed rep. Failures aren't auto-detected, so a mistimed or
  // aborted attempt is only recorded when the user presses Space.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        // Shift+Space corrects an over-count by decrementing (floored at 0).
        if (e.shiftKey) setFailures((n) => Math.max(0, n - 1));
        else setFailures((n) => n + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      await dev.startMeasurement();
      setConnState("connected");
      holdStartRef.current = null;
      restStartRef.current = performance.now(); // start resting before first rep
      setRestMs(0);
      setPhaseBoth("waiting");
    } catch (e) {
      setConnState("disconnected");
      deviceRef.current = null;
      if (e instanceof UserCancelledError) {
        // User closed the device chooser — not really an error.
        return;
      }
      console.error("[tindeq] connect failed", e);
      setError(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }
  }, [handleSample, setPhaseBoth]);

  const disconnect = useCallback(async () => {
    holdStartRef.current = null;
    restStartRef.current = null;
    setPhaseBoth("idle");
    await deviceRef.current?.disconnect();
    deviceRef.current = null;
    setConnState("disconnected");
  }, [setPhaseBoth]);

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

  const connected = connState === "connected";
  const inRange = force >= targetKg;

  // While above the threshold (an active hold), show the distraction-free view:
  // just the overshoot above target and the integer countdown, both large. The
  // total weight stays visible underneath in a smaller font.
  if (connected && (phase === "holding" || phase === "success")) {
    const countdownSec =
      phase === "success" ? 0 : Math.max(0, Math.ceil(remaining / 1000));
    // Round before picking the sign, so a hair under the target reads "+0.0"
    // rather than "−0.0".
    const excess = Number((force - targetKg).toFixed(1));
    return (
      <div className={`app phase-${phase} simplified`}>
        <div className="big-readout">
          <div className="big-stack">
            <div className="big-value force-color">
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

      <section className="controls">
        <label>
          Target weight (kg)
          <input
            ref={targetInputRef}
            type="number"
            min={MIN_TARGET_KG}
            step="any"
            autoFocus
            value={targetText}
            aria-invalid={targetError !== null}
            onChange={(e) => onTargetChange(e.target.value)}
            onBlur={refocusTarget}
          />
        </label>

        {!connected ? (
          <button
            className="primary"
            onClick={connect}
            disabled={connState === "connecting"}
          >
            {connState === "connecting" ? "Connecting…" : "Connect Progressor"}
          </button>
        ) : (
          <button onClick={disconnect}>Disconnect</button>
        )}
      </section>

      {connected && (
        <section className="controls">
          <button onClick={tare}>Tare (zero)</button>
        </section>
      )}

      {targetError && <p className="warn">{targetError}</p>}

      {error && <p className="warn">{error}</p>}

      <section className="readout">
        <div className="force">
          <span className="value">{kg1(force)}</span>
          <span className="unit">kg</span>
        </div>

        <div className="target-bar">
          <div
            className="fill"
            style={{
              width: `${Math.min(100, targetKg > 0 ? (force / targetKg) * 100 : 0)}%`,
            }}
          />
          <div className="threshold" />
        </div>

        {/* Below the threshold: count up to track rest between reps. */}
        <div className="timer rest">
          {formatRest(restMs)}
          <span className="timer-caption">rest</span>
        </div>

        <p className="status">{statusText(connState, phase, inRange)}</p>

        <div className="counters">
          <div className="counter success">
            <span className="count">{successes}</span>
            <span className="label">succeeded</span>
          </div>
          <div className="counter fail">
            <span className="count">{failures}</span>
            <span className="label">failed</span>
          </div>
        </div>

        <p className="hint">
          Successful holds are counted automatically. Press{" "}
          <kbd>Space</kbd> to log a failed rep, <kbd>Shift</kbd>+<kbd>Space</kbd>{" "}
          to undo one.
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

/** Format a rest duration (ms) as M:SS. */
function formatRest(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function statusText(conn: ConnState, phase: Phase, inRange: boolean): string {
  if (conn === "disconnected") return "Connect your Progressor to begin.";
  if (conn === "connecting") return "Connecting…";
  if (phase === "success") return "✅ Success! Release to reset.";
  if (inRange) return "In range…";
  return "Pull up to the target weight.";
}
