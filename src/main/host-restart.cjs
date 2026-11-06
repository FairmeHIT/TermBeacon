/**
 * PTY host restart policy.
 *
 * A host that crashes immediately must not be restarted in a tight loop. A
 * host that has been stable for a while should get a fresh retry budget. These
 * helpers are kept as plain CJS so they can be unit tested without Electron.
 */
const DEFAULT_POLICY = {
  baseMs: 250,
  maxMs: 8000,
  maxAttempts: 6,
  stableMs: 10000,
};

function restartDelay(attempt, policy = DEFAULT_POLICY) {
  const config = { ...DEFAULT_POLICY, ...policy };
  const exponent = Math.max(0, Math.floor(attempt));
  return Math.min(config.maxMs, config.baseMs * 2 ** exponent);
}

/**
 * @param {{attempts:number, uptimeMs:number}} state
 * @returns {{attempts:number, delayMs:number, giveUp:boolean}}
 */
function planRestart(state, policy = DEFAULT_POLICY) {
  const config = { ...DEFAULT_POLICY, ...policy };
  const attempts = Number.isFinite(state?.attempts) ? Math.max(0, Math.floor(state.attempts)) : 0;
  const uptimeMs = Number.isFinite(state?.uptimeMs) ? Math.max(0, state.uptimeMs) : 0;

  // A long-lived host gets a fresh budget: this crash is not a start loop.
  if (uptimeMs >= config.stableMs) {
    return { attempts: 1, delayMs: config.baseMs, giveUp: false };
  }

  const next = attempts + 1;
  if (next > config.maxAttempts) {
    return { attempts: next, delayMs: 0, giveUp: true };
  }
  return { attempts: next, delayMs: restartDelay(attempts, config), giveUp: false };
}

module.exports = { DEFAULT_POLICY, restartDelay, planRestart };
