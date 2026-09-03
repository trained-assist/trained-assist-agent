# Test Audit — CI Speed & Coverage Gaps

_Last updated: 2026-09-03_

## Current state

- **17 test files, 385 tests, ~1.7s total** — already very fast
- Tests run: syntax-check → unit tests → env-sync check
- Bottleneck in CI is **NOT the tests** — it's `npm ci` (~30–60s, includes Playwright) and SSH deploy steps

---

## CI speed wins

### 1. Cache `node_modules` in CI (biggest win — ~30–60s saved)

Playwright is the heaviest dependency. `npm ci` reinstalls it every run even if `package-lock.json` hasn't changed.

```yaml
# In the `ci` job, before `npm ci`:
- uses: actions/cache@v4
  with:
    path: |
      node_modules
      ~/.cache/ms-playwright
    key: ${{ runner.os }}-npm-${{ hashFiles('package-lock.json') }}
    restore-keys: ${{ runner.os }}-npm-
```

### 2. Expand `npm run check` to cover all src files

Currently only covers 5 hardcoded files. Should auto-discover:

```json
"check": "node --check src/**/*.js src/mcp-skills/**/*.js src/mcp-skills/tools/**/*.js"
```

Or use `find`:
```json
"check": "find src -name '*.js' | xargs node --check"
```

### 3. Parallelize syntax-check + env-sync check

Both are instant and independent of `npm test`. Run them in the same job step in parallel:

```yaml
- name: Checks
  run: |
    node scripts/check-env-sync.js &
    npm run check &
    wait
```

### 4. Vitest thread count (non-issue)

Tests finish in 1.7s — no parallelism tuning needed. Only re-evaluate if test count grows 10x.

---

## What tests are MISSING

### High priority — would have caught real bugs

| Gap | What bug it would catch |
|-----|------------------------|
| `secrets.js` unit tests | REQUIRED secret missing → crash instead of graceful error; `SECRETS_SOURCE=env` not tested |
| `/tokens` endpoint test | Token storage API never tested end-to-end |
| `listConnectedServices`, `revokeService`, `getSecretsLog` | Dead code risk — these run in prod but have zero test coverage |
| `generateConnectLink` + connect-pending expiry | Pending tokens never cleaned up = disk leak |
| `/health` endpoint fields | `vm` and `commit` fields added but never asserted |
| Nalog token expiry check | `/capabilities` returns `nalog` even for tokens expired hours ago |
| `check-env-sync.js` itself | The CI guard script has no tests — could have a bug silently passing broken state |

### Medium priority — prevent regressions

| Gap | Risk |
|-----|------|
| `loadUserTokens` — `.username` ownership marker | Migration could silently skip tokens or migrate wrong user's tokens |
| `runner.js` context injection | `USER_ID`, `GH_TOKEN` etc. env vars injected into Claude — never asserted |
| Session persistence across restart | `sessions.json` written/read correctly — not tested |
| `/classify` endpoint | Claude Haiku call never tested even with a mock |

### Low priority (nice to have)

| Gap | Notes |
|-----|-------|
| `check-env-sync.js` unit tests | Parse a fixture ci.yml and manifest, assert errors reported |
| HH OAuth token refresh | Token refresh flow tested only at integration level via mock-hh-server |
| Context store TTL | Entries expire after 30 days — no test for the TTL edge case |

---

## Specific test files to add

### `tests/unit/secrets.test.js`

```js
// SECRETS_SOURCE=env → reads from process.env
// Required secret missing → throws 'Required secret missing: ...'
// Optional secret missing → no throw, value is null
// GCP fallback: if loadFromGcp throws → falls back to env
```

### `tests/unit/user-tokens-service.test.js`

```js
// listConnectedServices('alice') → null when dir empty, array when tokens present
// revokeService('alice', 'github') → deletes file, returns 'github'
// revokeService('alice', 'nonexistent') → returns 'not_found'
// revokeService('alice', 'гитхаб') → alias works (Cyrillic)
// getSecretsLog('alice') → null when no log, last-20-lines reversed when log exists
// generateConnectLink('alice', 'github') → writes pending token, returns URL with ?t=
// generateConnectLink → cleanup deletes expired pending files
```

### `tests/unit/health-endpoint.test.js`

```js
// GET /health → 200, body has { status: 'alive', vm, commit }
// vm field matches VM_NAME env var
// commit field is non-empty string (git SHA or 'unknown')
```

### `tests/unit/capabilities-endpoint.test.js`

```js
// /capabilities?userId=alice → [] when no nalog token
// /capabilities?userId=alice → ['nalog'] when valid (non-expired) token exists
// /capabilities?userId=alice → [] when nalog token is expired
// /capabilities → 400 when userId missing
```

---

## Credential-specific CI checks

### Check: no hardcoded token patterns in source

Add to CI:

```yaml
- name: No hardcoded tokens
  run: |
    if grep -rn 'ghp_\|sk-ant-\|Bearer [A-Za-z0-9_-]\{20\}' src/ scripts/ 2>/dev/null; then
      echo "❌ Possible hardcoded token found"
      exit 1
    fi
    echo "✅ No hardcoded tokens"
```

### Check: secrets.env never committed

Add `.github/workflows/ci.yml` step:

```yaml
- name: No secrets.env in git
  run: |
    if git ls-files | grep -q 'secrets.env'; then
      echo "❌ secrets.env is tracked by git — remove it"
      exit 1
    fi
    echo "✅ secrets.env not tracked"
```

Both belong in the `ci` job, before or after the existing `Env-sync check` step.
