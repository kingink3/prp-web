# Rules for agents working in this repository

This is a PUBLIC repository. It holds only the code of a static web page.

## Never
- Never commit personal data, real repository names of the owner, tokens, or real Lab content.
  The data repository (`owner/repo`) is entered by the user in the page's settings. Tests use `fixtures/lab/` only.
- Never add third-party scripts, styles, fonts, CDNs, analytics or npm runtime dependencies.
  Everything the page runs is in this repository.
- Never insert data from the data repository as HTML (`innerHTML` with data, `insertAdjacentHTML`, template
  strings into `innerHTML`) unless every value passes through the single `esc()` helper. Prefer `textContent`.
- Never send the GitHub token anywhere except `https://api.github.com`. The only other allowed host is
  `https://api.anthropic.com` (the owner's routine «instant request»), with its own token. Never log tokens,
  never put them in a URL.

## Always
- Keep the Content-Security-Policy meta tag in `index.html` strict:
  `default-src 'self'; connect-src https://api.github.com; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
  The one allowed extension: `connect-src https://api.github.com https://api.anthropic.com` (instant request).
  No inline scripts or inline event handlers (CSP forbids them).
- Token: stored in `localStorage` under one key, entered on a settings screen, with "forget token" button.
  Show a warning when the GitHub API reports the token expires within 7 days
  (response header `github-authentication-token-expiration`).
- Writes go through the Contents API with the file's `sha`; on 409/422 (stale sha) re-read, re-apply the
  change to the fresh content and retry (max 3). One commit per user action, message `lab: web — <what>`.
- Behaviour mirrors the desktop Console (`docs/console-behaviour.md`); field names follow `docs/lab-schema.md`.
- UI text in Russian (labels in one `strings.js`), code and docs in English. Mobile first (iPhone/iPad), works on desktop.
- Tests: `node --test` (Node ≥ 20, no dependencies) for pure logic in `js/` modules — mutations of
  today.json / todo.json / reminders.json, parsing of markdown front matter, ordering. CI runs them on every PR.
