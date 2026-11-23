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
