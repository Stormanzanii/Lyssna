import { useEffect, useRef, useState } from "react";
import { rpc } from "./bridge";
import { Mic, X, LoaderCircle } from "lucide-react";
import { listen as listenEvent } from "@tauri-apps/api/event";

export function DJRequest({
  account,
  onClose,
  onSuccess,
}: {
  account: string;
  onClose: () => void;
  onSuccess: (transcript?: string) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"voice" | "request" | null>(null);
  const [error, setError] = useState("");
  const [heard, setHeard] = useState("");
  const active = useRef<string | null>(null);
  const voiceDialog = useRef(crypto.randomUUID());
  const live = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const meterListener = useRef<(() => void) | null>(null);
  const [meter, setMeter] = useState({
    level: 0,
    peak: 0,
    trail: 0,
    speech: false,
    stage: "listening",
    percent: 0,
  });
  const count = Array.from(text.trim()).length;
  const cancel = () => {
    const id = active.current;
    active.current = null;
    meterListener.current?.();
    meterListener.current = null;
    if (id) void rpc("dj_cancel", { id }).catch(() => {});
  };
  useEffect(() => {
    live.current = true;
    void rpc("dj_prepare", { account }).catch(() => {});
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      live.current = false;
      const id = active.current;
      active.current = null;
      meterListener.current?.();
      meterListener.current = null;
      void rpc("dj_release_voice", { dialog: voiceDialog.current }).catch(
        () => {},
      );
      if (id) void rpc("dj_cancel", { id }).catch(() => {});
      previous?.focus();
    };
  }, [account]);
  const close = () => {
    cancel();
    onClose();
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === "Tab") {
        const buttons = dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), textarea:not(:disabled)",
        );
        if (!buttons?.length) return;
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !dialog.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !dialog.current?.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const listen = async () => {
    const id = crypto.randomUUID();
    active.current = id;
    setHeard("");
    setBusy("voice");
    setError("");
    setMeter({
      level: 0,
      peak: 0,
      trail: 0,
      speech: false,
      stage: "preparing",
      percent: 0,
    });
    let unlisten: (() => void) | undefined;
    const dispose = () => {
      unlisten?.();
      unlisten = undefined;
    };
    meterListener.current = dispose;
    try {
      unlisten = await listenEvent<{
        id: string;
        account: string;
        level: number;
        speech: boolean;
        stage?: string;
        percent?: number;
      }>("spotiflex-dj-voice", ({ payload }) => {
        if (
          !live.current ||
          active.current !== id ||
          payload.id !== id ||
          payload.account !== account
        )
          return;
        const level = Number.isFinite(payload.level)
          ? Math.max(0, Math.min(100, payload.level))
          : 0;
        setMeter((previous) => ({
          level,
          peak: Math.max(level, previous.peak * 0.85),
          trail: previous.trail * 0.55 + level * 0.45,
          speech: payload.speech,
          stage: payload.stage || "listening",
          percent: payload.percent || 0,
        }));
      });
      if (!live.current || active.current !== id) return;
      const transcript = await rpc<string>("dj_voice", {
        account,
        id,
        dialog: voiceDialog.current,
      });
      dispose();
      if (meterListener.current === dispose) meterListener.current = null;
      if (live.current && active.current === id) {
        setHeard(transcript);
        setBusy("request");
        await rpc("dj_request", {
          account,
          id,
          text: transcript,
          input: "voice",
        });
        if (live.current && active.current === id) {
          active.current = null;
          onSuccess(transcript);
          onClose();
        }
      }
    } catch (reason) {
      if (live.current && active.current === id) setError(String(reason));
    } finally {
      dispose();
      if (meterListener.current === dispose) meterListener.current = null;
      if (live.current && active.current === id) {
        active.current = null;
        setBusy(null);
      }
    }
  };
  const send = async () => {
    if (busy || count === 0 || count > 500) return;
    const id = crypto.randomUUID();
    active.current = id;
    setBusy("request");
    setError("");
    try {
      await rpc("dj_request", { account, id, text, input: "text" });
      if (live.current && active.current === id) {
        active.current = null;
        onSuccess();
        onClose();
      }
    } catch (reason) {
      if (live.current && active.current === id) setError(String(reason));
    } finally {
      if (live.current && active.current === id) {
        active.current = null;
        setBusy(null);
      }
    }
  };
  return (
    <div
      className="dj-request-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        ref={dialog}
        className="dj-request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dj-request-title"
      >
        <button
          className="dj-request-close"
          aria-label="Close DJ request"
          onClick={close}
        >
          <X size={20} />
        </button>
        <h2 id="dj-request-title">Ask DJ</h2>
        <p>Tell DJ what you want to hear.</p>
        <textarea
          autoFocus
          aria-label="DJ request"
          placeholder="Describe music, artists, or a mood"
          value={text}
          disabled={busy !== null}
          onChange={(e) => {
            setText(e.target.value);
          }}
        />
        <div className="dj-request-meta">
          <span>Voice sends to DJ automatically after you stop speaking.</span>
          <span aria-live="polite">{count}/500</span>
        </div>
        {error && (
          <p role="alert" className="dj-request-error">
            {error}
          </p>
        )}
        {heard && (
          <p className="dj-heard" role="status">
            Heard: “{heard}”
          </p>
        )}
        {busy && (
          <p role="status">
            {busy === "voice"
              ? meter.stage === "preparing"
                ? `Preparing local speech recognition… ${meter.percent ? `${meter.percent}%` : ""}`
                : meter.stage === "transcribing"
                  ? "Recognizing your request…"
                  : "Listening… Speak, then pause to send (30 seconds max)."
              : "DJ is preparing your request…"}
          </p>
        )}
        {busy === "voice" && meter.stage === "listening" && (
          <div className="dj-voice-feedback">
            <div
              className="dj-voice-meter"
              role="meter"
              aria-label="Microphone input"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(meter.level)}
            >
              {[
                meter.trail * 0.5,
                meter.trail * 0.8,
                meter.level * 0.6,
                meter.peak * 0.8,
                meter.level,
                meter.peak,
                meter.level * 0.9,
                meter.peak * 0.7,
                meter.trail,
                meter.level * 0.5,
                meter.trail * 0.6,
              ].map((level, index) => (
                <i
                  key={index}
                  aria-hidden="true"
                  style={{ height: `${3 + Math.round(level * 0.23)}px` }}
                />
              ))}
            </div>
            <span>
              {meter.speech
                ? "Hearing speech"
                : meter.level > 0
                  ? "Sound detected"
                  : "Waiting for microphone input"}
            </span>
          </div>
        )}
        <div className="dj-request-actions">
          <button disabled={busy !== null} onClick={() => void listen()}>
            <Mic size={16} /> Use microphone
          </button>
          {busy ? (
            <button
              onClick={() => {
                cancel();
                setBusy(null);
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              disabled={count === 0 || count > 500}
              onClick={() => void send()}
            >
              Send to DJ
            </button>
          )}
          {busy === "request" && <LoaderCircle className="spin" size={18} />}
        </div>
      </section>
    </div>
  );
}
