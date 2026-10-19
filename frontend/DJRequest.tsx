import { useEffect, useRef, useState } from "react";
import { rpc } from "./bridge";
import { Mic, X, LoaderCircle } from "lucide-react";

export function DJRequest({
  account,
  onClose,
  onSuccess,
}: {
  account: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [text, setText] = useState("");
  const [input, setInput] = useState<"text" | "voice">("text");
  const [busy, setBusy] = useState<"voice" | "request" | null>(null);
  const [error, setError] = useState("");
  const active = useRef<string | null>(null);
  const live = useRef(true);
  const dialog = useRef<HTMLElement>(null);
  const count = Array.from(text.trim()).length;
  const cancel = () => {
    const id = active.current;
    active.current = null;
    if (id) void rpc("dj_cancel", { id }).catch(() => {});
  };
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      live.current = false;
      const id = active.current;
      active.current = null;
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
    setBusy("voice");
    setError("");
    try {
      const transcript = await rpc<string>("dj_voice", { account, id });
      if (live.current && active.current === id) {
        setText(transcript);
        setInput("voice");
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
  const send = async () => {
    if (busy || count === 0 || count > 500) return;
    const id = crypto.randomUUID();
    active.current = id;
    setBusy("request");
    setError("");
    try {
      await rpc("dj_request", { account, id, text, input });
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
            setInput("text");
          }}
        />
        <div className="dj-request-meta">
          <span>Review voice transcripts before sending to Spotify.</span>
          <span aria-live="polite">{count}/500</span>
        </div>
        {error && (
          <p role="alert" className="dj-request-error">
            {error}
          </p>
        )}
        {busy && (
          <p role="status">
            {busy === "voice"
              ? "Listening… Speak your request (30 seconds max)."
              : "DJ is preparing your request…"}
          </p>
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
