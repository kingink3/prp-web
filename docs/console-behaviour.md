# Desktop Console behaviour to mirror

The desktop Console is a local server over a clone of the data repository. The web client does the
same through the GitHub Contents API. Each bullet = one user action = one commit.

## Today (`today.json`, `todo.json`)
- Plan groups, in this order: **Задачи** (items without a learning/project ref + all to-dos from todo.json),
  **Обучение** (kind learning), **Проекты** (project / experiment / idea refs).
  Within a group: open ⭐ `important` first, then open, then done. Paused items (ref status parked/paused) hidden.
- toggle item done (`done`, `done_at` = local ISO minutes; untick clears `done_at`).
- postpone item → `postponed` list with `until` = tomorrow, new id `pp-<unix>`; unpostpone moves it back.
- reorder items / to-dos (drag): permute ids, keep positions of ids not in the list.
- item notes: `comment`, `blocker` (empty string removes the key); `important: true` toggled by long-press / right click.
- to-dos: add `{id: "td-<unix>", text, done:false, created: YYYY-MM-DD}`, toggle, update notes, clear done, to-idea.
- Header counter: done / total items, done minutes / planned minutes.
- A day before 04:00 still belongs to yesterday's plan (evening check-in).

## Reminders (`reminders.json`)
- Show today's and overdue ones; later ones as "позже: N (ближайшее — …)".
- add `{id, text, at: "YYYY-MM-DDTHH:MM", repeat: null|"daily"|"weekdays", done:false, created_by: "web"}`,
  done (repeating ones move `at` to the next occurrence; one-offs get `done_at`), snooze (+10 min / +1 h).

## Directions (objects)
- Objects are markdown files with YAML front matter in `projects/`, `learning/`, `ideas/`, `experiments/`.
  Board = columns from `config/areas.yaml`; card shows title, status, next_step, task progress
  (`## Задачи` checklist), last_touched age.
- Project tasks: add / tick / move up / remove lines in `## Задачи`; `next_step` = first open task.
- Every object edit updates `last_touched` and appends a line to `journal/<YYYY-MM-DD>.md`.

## Ideas
- Today's ideas in `today.json.ideas`: reactions 👍 like / 🧪 test / ✕ dismiss (field `reaction`),
  owner comment (`comment`) — the comment reshapes the idea for every later step.

## Calendar
- `history/<YYYY-MM-DD>.json` snapshots: list of days, items done / postponed, search by text.

## Instant request
- A text box that fires the owner's cloud routine (URL + token stored on the device, same rules as the
  GitHub token). Supported payloads: `extra_lesson`, `ideas: …`, `critic: <idea id>`, `кодекс: …`,
  `codex-review: <n>`, `ок: <n>`.

## Codex tasks (`codex.json`)
- List by status ready → sent → review → changes → merged/cancelled; "copy prompt" builds the task prompt
  (see `codex.json` in the schema); "✓ Влить" fires `ок: <n>`.

## Timers
- Local to the device (localStorage), default length 20 min, editable before start; end → sound +
  "Отметить выполненным?".
