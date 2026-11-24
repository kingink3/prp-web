# Object schema

All objects are markdown files with YAML frontmatter. Field names and enum values are
English; free text is in `lang`.

## Common fields (all types)

```yaml
id: idea-20261123-course-builder   # <type>-<YYYYMMDD>-<slug>
type: idea                         # idea | experiment | project | learning
title: "…"                          # in `lang`
lang: ru                            # ISO 639-1
area: projects                      # id from config/areas.yaml (column in Lab Console)
purpose: money                      # money | interest | learning | useful
status: new                         # see per-type enums
created: 2026-11-23
last_touched: 2026-11-23
source: chat                        # chat | chatgpt | codex | claude-code | widget | voice | link | inventory | generator
origin: owner                       # owner | agent   (agent-generated ideas are marked)
tags: []
links: []                           # related object ids or URLs
next_step: "…"                      # one concrete action, ≤45 min where possible
```

## idea
Status: `new | liked | testing | parked | done | killed`

Extra fields:
```yaml
quick_test: "…"        # how to check it in ≤2 h / ≤ per_test_max
success_signal: "…"    # what result counts as a yes
main_risk: "…"         # from the light critic
critic: none           # none | light | full
medium: ""             # digital | physical
mode: ""               # auto | directed  (generator ideas only)
direction: ""          # direction name or the owner's wording
```
Body: `## Суть`, `## Почему мне`, `## Тест`, `## Заметки`, optional `## Комментарии владельца`
(`- YYYY-MM-DD: text`, newest first; written by widgets/Console via labctl or directly).

## experiment
Status: `planned | running | done | abandoned`
```yaml
hypothesis: "…"
timebox_minutes: 120
budget_usd: 0
idea: idea-…           # parent idea, if any
result: pending        # pending | positive | negative | inconclusive
```
Body: `## Метод`, `## Результат`, `## Вывод и следующий шаг`.

## project
Status: `active | paused | blocked | done | dropped`
```yaml
goal: "…"
blocked_by: ""
```
Body: `## Цель`, `## Где остановился` (resume note, overwritten each session),
`## Лог сессий` (append-only, newest first).

## learning
Status: `active | paused | done | dropped`
```yaml
platform: ""            # e.g. chatgpt, coursera, youtube, book
location: ""            # where the material lives (URL, "ChatGPT project X")
progress: ""            # e.g. "module 3/10", "unknown"
why: "…"                # what it is for / linked project
cadence: ""             # e.g. "daily 15 min"
start_date: ""          # optional; coach ignores the track before this date
resume: false           # optional (project/learning): routine work, no «где остановился» notes in the evening
```
Body: `## Зачем`, `## Где остановился`, `## План`, `## Лог`.

## journal (journal/YYYY-MM-DD.md)
No frontmatter required. Append-only bullets: `- HH:MM [skill|owner] <what changed> (<id>)`.

## today.json (repo root)
Today's plan, written by `morning-brief`, edited by the desktop widget
(`tools/widget/`). Overwritten daily; each day's plan is copied to `history/<date>.json` by `labctl apply`.
```json
{
  "date": "2026-11-24",
  "budget_minutes": 180,
  "items": [
    {"id": "t1", "title": "…", "kind": "project|learning|experiment|idea|custom",
     "minutes": 45, "ref": "<object id or null>",
     "links": [{"title": "…", "url": "https://…"}],
     "done": false, "done_at": null, "carried": false}
  ],
  "candidates": [ {"ref": "project-…", "title": "…", "kind": "project|experiment", "minutes": 25} ],
  "dropped": [ {"title": "…", "reason": "…", "purpose": "money", "medium": "digital"} ],
  "reserve": [ /* spare lessons from coach, same item format; widget 🎓+ moves one into items */ ],
  "requests": [ {"type": "extra_lesson", "at": "2026-11-24T19:05"} ],
  "postponed": [ /* item format + "until": "2026-11-25", "postponed_on": "2026-11-24" */ ]
}
```
`evening` — the evening check-in from Console «🌙 Итоги»: `{"done_at": "…", "notes": [{"ref", "text"}]}`
(each note is also written to the object's `## Где остановился`); copied to `history/<date>.json`.
`postponed` — items the owner moved to a later day («→ завтра»). A new day keeps the list and moves
items with `until` ≤ date into `items` with `carried: true` (`labctl.new_day`, clients, brief, `apply`).

Optional item field `spent` is a non-negative integer with the actual minutes worked, measured by the
timer. It accumulates across sessions and is kept in history. A present `0` is a measured value.

## objects.json (repo root, generated)
Front matter of every object (`projects/`, `learning/`, `ideas/`, `experiments/`, `notes/`) in one file,
plus `path` and, for projects, `tasks_total` / `tasks_done`. Written by `labctl index` (CI, on every push);
never edit by hand. Clients use it for lists and read the single `.md` file only for a detail view.
```json
{"generated": "2026-11-24T12:00", "objects": [{"id": "idea-…", "type": "idea", "title": "…", "status": "liked",
  "area": "ideas", "purpose": "money", "main_risk": "…", "next_step": "…", "last_touched": "2026-11-24", "path": "ideas/idea-….md"}]}
```

## history/<YYYY-MM-DD>.json
Written by `labctl apply` (CI): the day's plan as it ended (`items` with done/done_at/comment/blocker),
`postponed` (moved away that day) and `todos` (plain to-dos done that day, kept here before
`todo.json` prunes them). Console tab «Таски» shows it as a calendar with search. Do not edit by hand.
Optional item field `timer: true` — the widgets show a ▶ countdown of `minutes`
(Windows: live countdown + pop-up at the end; iOS: local notification when time is up).
`candidates` — what the owner may pick for the project slot today (active projects with their next
step, testing ideas/experiments, liked ideas). Clients also treat today's ideas with reaction 👍/🧪 as
candidates. Picking adds an item `{id: "p-<ts>", kind, ref, minutes, title}`; nothing project-related
is planned without the owner's pick.
Item ids are unique within the day (`t1…tN` from the brief, `custom-<ts>` from the widget).
When processing the evening check-in or the next brief, done items update their `ref`
objects (log, `## Где остановился`, `last_touched`).

## Project in its own repository
A project may set `repo: owner/name` in its frontmatter. Codex tasks for it (`codex.json` → `repo`) are
done in that repository (Codex environment named after the repo); CI tracking in Lab does not see those
PRs — Claude reviews them on «PR готов» and logs the result in the Lab card.

## Project tasks (`## Задачи` in a project file)
Optional checklist `- [ ] …` / `- [x] …` (keep ≤ ~7 open). The first open task is the project's
`next_step` (kept in sync by Console and `labctl apply`). A `today.json` item may carry `task: "<exact
task text>"` — when it is done, `labctl apply` ticks that task in the project. No separate task objects.

## note (notes/note-YYYYMMDD-slug.md)
Lesson/reading notes, written by the `notes` skill. No lifecycle status.
```yaml
id: note-20261124-mcp-basics
type: note
title: "…"
lang: ru
created: 2026-11-24
last_touched: 2026-11-24
source: coach | owner | chatgpt | codex
track: learning-…          # learning object, if any
skills: [mcp]              # knowledge-map skill ids this note is evidence for
own_words: true            # owner answered the explain-it questions
links: []
```
Body: `## Главное`, `## Пример`, `## Своими словами`, `## Вопросы для повторения`
(`- Q: … / A: …`), `## Источник`, `## Связи` (`[[note-…]]`).

## Knowledge map (map/map.yaml)
Branches (development goals) → skill ids; domains → skills `{id, title, level 0–4|null,
target, evidence: [ids|links|"self: …"]}`. Rendered to `map/MAP.md` by `labctl map`.

## Archive
`archive/<type-folder>/` keeps archived objects unchanged (killed/abandoned >14 days,
untouched `new` ideas >30 days; monthly via CI). Ids stay valid; search it for duplicates.

## reminders.json (repo root)
Shared by the Windows widget, iOS (LabToday schedules local notifications) and agents.
```json
{"reminders": [{"id": "r-<unix ts>", "text": "…", "at": "2026-11-24T10:00",
                "repeat": null | "daily" | "weekdays", "done": false, "done_at": null,
                "created_by": "widget | ios | agent"}]}
```
`at` is local time of `profile.owner.timezone`, no offset. Done on a repeating reminder
moves `at` to the next occurrence. Done one-off reminders are pruned after 7 days by
`labctl apply`.

## codex.json (repo root)
Tasks delegated to Codex (owner pastes the prompt into Codex; Codex opens a PR; Claude reviews).
`model`/`effort` go into the prompt header — the owner picks them in Codex before running. Codex is
not limited to small chores: give it multi-file features too, with `effort: high` (or `xhigh`) and a
precise «Done when». Without `effort` it is derived from the task size (`labctl.codex_model`).
```json
{"tasks": [{"id": "cx-<unix ts>", "title": "…", "text": "what to do (English or Russian)",
            "done_when": "acceptance criteria", "ref": "project-…|idea-…|null", "repo": "<owner>/<data-repo>",
            "branch": "codex/<slug>", "model": "GPT-6.2 Sol", "effort": "low|medium|high|xhigh",
            "status": "ready", "pr": null, "fix": null, "note": "",
            "created": "2026-11-23T14:00", "updated": "2026-11-23T14:00"}]}
```
Status: `ready` (prepared, owner to send) → `sent` (owner copied it to Codex) → `review` (PR open,
waiting for Claude) → `changes` (Claude asked for fixes; `fix` holds the follow-up text to paste into
the same Codex task) → `merged` | `cancelled`. The prompt is built by `labctl.codex_prompt()`.
CI (`.github/workflows/codex.yml`) moves tasks to `review` / `merged` from PR events.

## todo.json (repo root)
Optional `important: true` on a to-do or a today.json item: ⭐, red, shown first (right click in Console / widget).
A plain to-do list — no planned minutes, no links, not tied to a day. Widget tab «Список»,
Console «Сегодня» → «Список дел».
```json
{"todos": [{"id": "td-<unix ts>", "text": "…", "done": false, "created": "2026-11-23", "done_at": null,
            "comment": "optional note", "blocker": "optional — what blocks it (absent = not blocked)"}]}
```
`comment` and `blocker` are optional free text (also allowed on `today.json` items) (owner's language); an empty value removes the field.
Optional `spent` follows the same rules as on `today.json` items.
Agents doing `checkin` / `weekly-review` mention open blockers. Done items are pruned after 7 days by `labctl apply`. Agents may add items here when the owner
says «добавь в список …».
