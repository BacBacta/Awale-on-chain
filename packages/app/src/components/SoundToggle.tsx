"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon.js";
import { isMuted, toggleMuted } from "../lib/sound.js";

// Mute toggle for the game screens. Reads the persisted state after mount to
// avoid a hydration mismatch.
export function SoundToggle() {
  const [muted, setMuted] = useState(false);
  useEffect(() => setMuted(isMuted()), []);
  return (
    <button
      className="icon-btn"
      aria-label={muted ? "Unmute" : "Mute"}
      aria-pressed={muted}
      onClick={() => setMuted(toggleMuted())}
      style={{ color: muted ? "var(--faint)" : "var(--text)" }}
    >
      <Icon name={muted ? "mute" : "sound"} size={18} />
    </button>
  );
}
