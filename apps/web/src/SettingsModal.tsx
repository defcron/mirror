import { useState } from "react";
import { saveSession } from "./api.js";

export function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [sessionToken, setSessionToken] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSave() {
    setStatus("saving");
    setMessage("");
    try {
      const res = await saveSession(sessionToken.trim());
      setStatus("ok");
      setMessage(res.email ? `Connected as ${res.email}` : "Session saved.");
      setTimeout(onSaved, 600);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not verify this token. Your previous session was kept.");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Connect your ChatGPT account</h2>
        <ol className="steps">
          <li>
            Open <code>chatgpt.com</code> in your browser and make sure you're signed in.
          </li>
          <li>
            Visit{" "}
            <a href="https://chatgpt.com/api/auth/session" target="_blank" rel="noreferrer">
              chatgpt.com/api/auth/session
            </a>{" "}
            in a new tab.
          </li>
          <li>
            Copy the <code>sessionToken</code> value from the JSON you see and paste it below. This is
            longer-lived than <code>accessToken</code> — the app mints fresh accessTokens from it
            automatically, so you shouldn't need to come back and re-paste every couple weeks.
          </li>
        </ol>

        <label>
          sessionToken
          <textarea
            rows={4}
            placeholder="eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..."
            value={sessionToken}
            onChange={(e) => setSessionToken(e.target.value)}
          />
        </label>

        {message && <p className={`status-msg ${status}`}>{message}</p>}

        <div className="modal-actions">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!sessionToken.trim() || status === "saving"}
            className="btn-primary"
          >
            {status === "saving" ? "Verifying…" : "Save & Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
