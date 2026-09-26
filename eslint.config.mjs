import globals from "globals";

// CI gate: catch undefined variable references (the class of bug behind the
// 2026-09-25 GTD incident — `runThreadId is not defined` swallowed by try/catch
// silently killed GTD scheduling for every user, and no test noticed).
//
// Deliberately narrow: ONLY `no-undef` is enabled. This is not a style linter —
// it exists to turn "reference to a variable that isn't in scope" into a red CI
// check instead of a silent runtime failure. Add rules only if they catch bugs.
//
// Server code gets Node globals. A few src/ files are browser scripts injected
// into pages (login/connector flows), and src/web-ui is the SPA bundle — those
// get browser globals instead, so `document`/`window` are not false positives.
const BROWSER_INJECTED = [
  "src/getcourse-login.js",
  "src/mcp-skills/tools/80-getcourse.js",
  "src/nalog-login.js",
  "src/site-connector.js",
  "src/tilda-login.js",
];

export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: { "no-undef": "error" },
  },
  {
    files: BROWSER_INJECTED,
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ["src/web-ui/**/*.js"],
    languageOptions: {
      globals: { ...globals.browser, marked: "readonly" },
    },
  },
];
