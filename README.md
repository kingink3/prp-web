# PRP Web

A static web client for a PRP / "Lab" data repository (personal resource planning:
today's plan, to-dos, learning tracks, projects, ideas, reminders).

* **No server, no build step, no third-party code.** Plain HTML/CSS/ES modules, served by GitHub Pages.
* **No data here.** The page reads and writes a *separate, private* data repository through the
  GitHub REST API, using a fine-grained token that the owner enters once per device.
* Data formats: [`docs/lab-schema.md`](docs/lab-schema.md). Behaviour to mirror:
  [`docs/console-behaviour.md`](docs/console-behaviour.md). Fake sample data for tests: `fixtures/lab/`.

## Token (per device)
GitHub → Settings → Developer settings → Fine-grained tokens → *Only select repositories*: the data
repository → Repository permissions: **Contents: Read and write** (nothing else) → expiry 60–90 days.
One token per device, so a lost device is revoked alone.


## Local fixtures

Run `node scripts/serve.js` from the repository root and open
`http://127.0.0.1:8000/?fixtures=1#today`. This loopback-only mode reads `fixtures/lab/`.
Edits are simulated in memory and reset on reload. The static server handles reads only.
Run `node --test` for unit tests and
`node --experimental-websocket scripts/check-browser.js` for Chromium checks
(set `CHROME_BIN` if the browser executable is outside PATH).
