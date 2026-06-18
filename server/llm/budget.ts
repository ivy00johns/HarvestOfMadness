/**
 * UTC-day decision budget counter (pure module, unit-testable).
 *
 * The proxy consumes one unit per decision forwarded upstream. Past the
 * ceiling, POST /api/agent/complete returns 429 budget_exceeded WITHOUT
 * calling upstream (contracts/openapi.yaml). The counter resets when the
 * UTC calendar day changes.
 *
 * A ceiling of `<= 0` means UNLIMITED (the default): FreeLLMAPI tokens are
 * free, so the proxy does not self-throttle. tryConsume() still counts usage
 * (for /api/health) but never refuses. Set a positive DAILY_CEILING only to
 * deliberately cap a session.
 */

export interface Budget {
  readonly ceiling: number;
  /** decisions consumed so far in the current UTC day */
  decisionsToday(): number;
  /** true (and increments) when under the ceiling; false past it */
  tryConsume(): boolean;
}

function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function createBudget(ceiling: number, now: () => number = Date.now): Budget {
  let day = utcDayKey(now());
  let count = 0;

  const rollDay = () => {
    const today = utcDayKey(now());
    if (today !== day) {
      day = today;
      count = 0;
    }
  };

  return {
    ceiling,
    decisionsToday() {
      rollDay();
      return count;
    },
    tryConsume() {
      rollDay();
      // ceiling <= 0 → unlimited: count usage but never refuse.
      if (ceiling > 0 && count >= ceiling) return false;
      count += 1;
      return true;
    },
  };
}
