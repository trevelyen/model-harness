import { useState } from "react";
import { updateVoice } from "../state/store";
import { stopVoiceServer } from "../voice/client";
import { Modal } from "./Modal";
import { Switch } from "./Switch";

/** Asked on leaving a voice chat while the voice server holds its models in GPU memory. */
export function StopVoiceDialog({ onClose }: { onClose: () => void }) {
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");

  const choose = async (choice: "stop" | "keep") => {
    if (remember) updateVoice({ onLeave: choice });
    if (choice === "stop") {
      try {
        await stopVoiceServer();
      } catch (e) {
        return setError((e as Error).message);
      }
    }
    onClose();
  };

  return (
    <Modal className="confirm-dialog" alert labelledBy="stop-voice-title" onDismiss={() => void choose("keep")}>
      <h2 id="stop-voice-title">Stop the voice server?</h2>
      <p>It keeps its voice models in GPU memory, which a local model may need. It starts again with the next voice chat.</p>
      {error && <p className="confirm-error">{error}</p>}
      <div className="confirm-foot">
        <label className="confirm-remember">
          <Switch small on={remember} onChange={setRemember} />
          Don't ask again
        </label>
        <div className="confirm-actions">
          <button type="button" className="button is-ghost" onClick={() => void choose("keep")}>Keep running</button>
          <button type="button" className="button" onClick={() => void choose("stop")}>Stop</button>
        </div>
      </div>
    </Modal>
  );
}
