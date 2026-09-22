// Unified backoff policy for auto-retrying a session whose engine process died without
// producing a result — whether from a mid-task crash or a server restart killing the child
// (systemd KillMode=mixed kills opencode/claude/codex children on every deploy/restart; see
// server.js resumePendingTasks comment for the 34-restarts/day measurement). Both retry paths
// (server.js resume-after-restart, runner/index.js mid-task incomplete) share this module so
// the attempt cap and delay schedule can't drift apart between them.
//
// Real timing in prod: the whole point is to let a deploy flurry or transient provider outage
// "settle" before retrying, so the delays are minutes, not seconds. In tests that would make
// every retry-covering test take minutes to run, so TEST_MODE=1 (existing repo-wide convention,
// see server.js:1981 and mainstream-tester/index.js) collapses the schedule to milliseconds —
// same shape, same attempt count, fast to assert on.
const PROD_DELAYS_MS = [30_000, 3 * 60_000, 10 * 60_000]; // 30s, 3min, 10min
const TEST_DELAYS_MS = [10, 20, 30];

const MAX_RETRIES = 3; // + the original attempt = 4 tries total

function isTestMode() {
  return process.env.TEST_MODE === '1';
}

// Delay before retry attempt N (1-based: 1 = first retry after the original failure).
// Returns null if N is out of range (caller should give up instead of retrying).
function getRetryDelayMs(attemptNumber) {
  const delays = isTestMode() ? TEST_DELAYS_MS : PROD_DELAYS_MS;
  if (attemptNumber < 1 || attemptNumber > delays.length) return null;
  return delays[attemptNumber - 1];
}

function getRetryDelays() {
  return isTestMode() ? TEST_DELAYS_MS.slice() : PROD_DELAYS_MS.slice();
}

module.exports = { MAX_RETRIES, getRetryDelayMs, getRetryDelays, isTestMode };
