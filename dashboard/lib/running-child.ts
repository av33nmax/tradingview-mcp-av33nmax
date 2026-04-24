import type { ChildProcess } from "node:child_process";

/**
 * Module-level registry of the currently running child process.
 *
 * We enforce one-at-a-time on the client, so there is at most one active
 * spawned process at any time. Tracking it here lets /api/run/abort kill
 * it on demand.
 */
type Current = {
  child: ChildProcess;
  command: string;
  startedAt: number;
};

let current: Current | null = null;

export function setCurrentChild(c: Current) {
  current = c;
}

export function clearCurrentChild(child: ChildProcess) {
  // Only clear if still pointing at this child — guards against race where
  // a new run started after kill.
  if (current?.child === child) current = null;
}

export function getCurrentChild(): Current | null {
  return current;
}

export function killCurrentChild(): {
  killed: boolean;
  command?: string;
} {
  if (!current) return { killed: false };
  const { child, command } = current;
  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }
  // Escalate to SIGKILL after 3s if still alive
  setTimeout(() => {
    if (current?.child === child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 3000);
  return { killed: true, command };
}
