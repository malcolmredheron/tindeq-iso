import { useCallback, useEffect, useRef, useState } from "react";
import {
  TindeqProgressor,
  UserCancelledError,
  type ForceSample,
} from "./tindeq.ts";
import { playFinalBeep, playHoldBeep, unlockAudio } from "./sounds.ts";

const HOLD_SECONDS = 6;
const HOLD_MS = HOLD_SECONDS * 1000;

// A drop-out only counts as a failure if the hold lasted at least this long;
// brief taps above the threshold are ignored.
const MIN_FAIL_MS = 1000;

type ConnState = "disconnected" | "connecting" | "connected";
type Phase = "idle" | "waiting" | "holding" | "success";

export function App() {
  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [targetKg, setTargetKg] = useState(20);

  // Live values are rendered from a requestAnimationFrame loop reading refs, so
  // the incoming stream of samples never floods React with state updates.
  const [force, setForce] = useState(0);
  const [remaining, setRemaining] = useState(HOLD_MS);
  const [phase, setPhase] = useState<Phase>("idle");
  const [successes, setSuccesses] = useState(0);
  const [failures, setFailures] = useState(0);

  // Mutable state read inside the BLE sample handler (which is registered once).
  const targetRef = useRef(targetKg);
  const holdStartRef = useRef<number | null>(null);
  // Index of the next per-second progress beep (0..5) to play in this hold.
  const nextBeepRef = useRef(0);
  const forceRef = useRef(0);
  const phaseRef = useRef<Phase>("idle");

  const deviceRef = useRef<TindeqProgressor | null>(null);

  useEffect(() => {
    targetRef.current = targetKg;
    // Changing the target weight starts a fresh set — reset the counters.
    setSuccesses(0);
    setFailures(0);
  }, [targetKg]);

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
            // Beeps just stop — going silent is the out-of-range cue.
            // Only a hold that survived a full second counts as a failed rep.
            if (heldMs >= MIN_FAIL_MS) setFailures((n) => n + 1);
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
      } else if (phaseRef.current !== "success") {
        setRemaining(HOLD_MS);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
      },
    });
    deviceRef.current = dev;
    try {
      setConnState("connecting");
      await dev.connect();
      await dev.startMeasurement();
      setConnState("connected");
      holdStartRef.current = null;
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
  const remainingSec = remaining / 1000;
  const inRange = force >= targetKg;

  return (
    <div className={`app phase-${phase}`}>
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
            type="number"
            min={0}
            step={0.5}
            value={targetKg}
            onChange={(e) => setTargetKg(Number(e.target.value))}
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

      {error && <p className="warn">{error}</p>}

      <section className="readout">
        <div className="force">
          <span className="value">{force.toFixed(1)}</span>
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

        <div className="timer">
          {phase === "holding" ? remainingSec.toFixed(1) : HOLD_SECONDS.toFixed(1)}
          <span className="unit">s</span>
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
      </section>
    </div>
  );
}

function statusText(conn: ConnState, phase: Phase, inRange: boolean): string {
  if (conn === "disconnected") return "Connect your Progressor to begin.";
  if (conn === "connecting") return "Connecting…";
  if (phase === "success") return "✅ Success! Release to reset.";
  if (phase === "holding") return "💪 In range — keep holding!";
  if (inRange) return "In range…";
  return "Pull up to the target weight.";
}
