import type { ChildProcess } from "node:child_process";

/**
 * Registry of running child processes, keyed by command.
 *
 * Each whitelisted command (one-shot scripts AND long-running watchers) has at
 * most one child at a time, but DIFFERENT commands run concurrently — so all HK
 * watchers can run at once. /api/run/abort kills a specific command's child.
 *
 * Was a single `current` (one-at-a-time) until 2026-06-04 — that capped the
 * dashboard at one watcher. Now keyed by command for concurrent watchers.
 */
type Current = {
  child: ChildProcess;
  command: string;
  startedAt: number;
};

const children = new Map<string, Current>();

export function registerChild(c: Current) {
  children.set(c.command, c);
}

export function clearChild(command: string, child: ChildProcess) {
  // Only clear if still pointing at this child — guards against a race where a
  // new run for the same command started after this one's kill.
  const cur = children.get(command);
  if (cur?.child === child) children.delete(command);
}

export function getChild(command: string): Current | null {
  return children.get(command) ?? null;
}

export function listChildren(): Current[] {
  return [...children.values()];
}

export function killChild(command: string): { killed: boolean; command?: string } {
  const cur = children.get(command);
  if (!cur) return { killed: false };
  const { child } = cur;
  try {
    child.kill("SIGTERM");
  } catch {
    // best effort
  }
  // Escalate to SIGKILL after 3s if still alive
  setTimeout(() => {
    const c2 = children.get(command);
    if (c2?.child === child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 3000);
  return { killed: true, command };
}
