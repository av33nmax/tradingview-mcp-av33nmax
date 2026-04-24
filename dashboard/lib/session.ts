/**
 * Session-time helpers.
 *
 * The dashboard is used from SGT, but US trading operates on ET.
 * Everything about "when" comes from these helpers.
 */

export type SessionPhase =
  | "pre-market"      // before 9:30 ET
  | "opening"         // 9:30 - 9:45 ET (ORB forming)
  | "post-orb"        // 9:45 - 10:30 ET (primary trade window)
  | "morning"         // 10:30 - 12:00 ET
  | "lunch"           // 12:00 - 13:30 ET (chop)
  | "power-hour"      // 13:30 - 14:30 ET
  | "close"           // 14:30 - 15:30 ET
  | "hard-close"      // 15:30 - 16:00 ET
  | "after-hours";    // after 16:00 ET

export type ClockState = {
  sgt: string;        // "09:45 SGT"
  et: string;         // "21:45 ET"
  phase: SessionPhase;
  phaseLabel: string;
  phaseColor: "bull" | "bear" | "warn" | "muted";
  minsToNextPhase: number;
  nextPhaseLabel: string;
};

function etParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
  const m = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
  return { h, m, totalMin: h * 60 + m };
}

function sgtStr(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Singapore",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(now) + " SGT";
}

function etStr(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(now) + " ET";
}

const PHASES: Array<{
  name: SessionPhase;
  label: string;
  startMin: number;
  endMin: number;
  color: "bull" | "bear" | "warn" | "muted";
}> = [
  { name: "pre-market", label: "Pre-market",  startMin: 0,           endMin: 9 * 60 + 30,  color: "muted" },
  { name: "opening",    label: "ORB forming", startMin: 9 * 60 + 30, endMin: 9 * 60 + 45,  color: "warn" },
  { name: "post-orb",   label: "Trade window",startMin: 9 * 60 + 45, endMin: 10 * 60 + 30, color: "bull" },
  { name: "morning",    label: "Morning",     startMin: 10 * 60 + 30,endMin: 12 * 60,      color: "bull" },
  { name: "lunch",      label: "Lunch chop",  startMin: 12 * 60,     endMin: 13 * 60 + 30, color: "warn" },
  { name: "power-hour", label: "Power hour",  startMin: 13 * 60 + 30,endMin: 14 * 60 + 30, color: "bull" },
  { name: "close",      label: "Close approach",startMin: 14 * 60 + 30, endMin: 15 * 60 + 30, color: "warn" },
  { name: "hard-close", label: "HARD CLOSE",  startMin: 15 * 60 + 30,endMin: 16 * 60,      color: "bear" },
  { name: "after-hours",label: "After-hours", startMin: 16 * 60,     endMin: 24 * 60,      color: "muted" },
];

export function getClockState(now = new Date()): ClockState {
  const { totalMin } = etParts(now);
  const phaseIdx = PHASES.findIndex((p) => totalMin >= p.startMin && totalMin < p.endMin);
  const phase = phaseIdx >= 0 ? PHASES[phaseIdx] : PHASES[PHASES.length - 1];
  const next = phaseIdx >= 0 && phaseIdx < PHASES.length - 1 ? PHASES[phaseIdx + 1] : null;

  const minsToNext = next ? next.startMin - totalMin : 24 * 60 - totalMin;

  return {
    sgt: sgtStr(now),
    et: etStr(now),
    phase: phase.name,
    phaseLabel: phase.label,
    phaseColor: phase.color,
    minsToNextPhase: minsToNext,
    nextPhaseLabel: next ? next.label : "tomorrow pre-market",
  };
}
