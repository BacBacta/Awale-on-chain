"use client";

import Link from "next/link";
import { Icon } from "./Icon.js";
import type { QuestState } from "../lib/profile.js";

// Today's three quests on the lobby — short objectives that turn "open the
// app" into "play a couple of games". Progress comes resolved from the server
// profile; completing all three counts a Perfect day.
export function DailyQuests({ quests, perfectDays }: { quests: QuestState[]; perfectDays: number }) {
  if (quests.length === 0) return null;
  const allDone = quests.every((q) => q.done);

  return (
    <div className="card stack animate-in" style={{ gap: 10, padding: "14px 16px" }}>
      <div className="row">
        <span style={{ fontWeight: 700, fontSize: 14.5 }}>Today&apos;s quests</span>
        {allDone ? (
          <span className="chip gold">✨ Perfect day{perfectDays > 1 ? ` · ${perfectDays}` : ""}</span>
        ) : (
          <span className="faint">
            {quests.filter((q) => q.done).length}/{quests.length}
          </span>
        )}
      </div>
      {quests.map((q) => {
        const href = q.id === "solveDaily" ? "/daily" : "/";
        const inner = (
          <>
            <span
              className="lead neutral"
              style={{ width: 26, height: 26, borderRadius: 8, fontSize: 13, color: q.done ? "var(--accent)" : "var(--faint)" }}
            >
              {q.done ? "✓" : q.id === "solveDaily" ? <Icon name="bolt" size={13} /> : <Icon name="play" size={13} />}
            </span>
            <span className={q.done ? "faint" : "muted"} style={{ flex: 1, textDecoration: q.done ? "line-through" : "none" }}>
              {q.label}
            </span>
            {q.target > 1 && (
              <span className="faint">
                {q.count}/{q.target}
              </span>
            )}
          </>
        );
        // the puzzle quest links straight to the puzzle; game quests are played from here
        return q.id === "solveDaily" && !q.done ? (
          <Link key={q.id} href={href} className="row" style={{ gap: 10, textDecoration: "none" }}>
            {inner}
          </Link>
        ) : (
          <span key={q.id} className="row" style={{ gap: 10 }}>
            {inner}
          </span>
        );
      })}
    </div>
  );
}
