# Plan

What is still to build, and the decisions that go with each item. `SPEC.md`
covers what already exists and why it is shaped that way; this is the part that
is not written yet.

Ordered by wave. Each wave ends with `node test_docker.js` green, the widget
reloaded and screenshotted, and a commit.

## Where things stand

**Done and shipped:** the mosaic, metric rotation, the width budget, device-pixel
sizing, stack blocks, the popup with per-stack and per-container actions,
lazydocker scoping, the coding-agent handoff, disk cleanup with per-kind prune,
state-change notifications, clickable ports, state-aware action sets.

**Logic landed, UI pending** — `Docker.js` has these tested and nothing renders
them yet:

| piece | function |
|---|---|
| engine switch | `setEngine`, `engine`, `parseRows` |
| search and filter | `searchContainers`, `matchesQuery`, `matchesView` |
| port conflicts | `portConflicts`, `conflictText` |
| images / volumes / networks | `parseImages`, `parseVolumes`, `parseNetworks`, `resourceRemoveCommand` |
| gauges | `gauges`, `parseHostDisk` |
| daemon control | `daemonCommand`, `daemonStatusCommand` |

Wave 1 is therefore mostly wiring, not invention.

---

## Wave 1 — surface what already works

### 1.1 Search and filter

A text field and three chips (`all` / `running` / `stopped`) above the list.

- The field filters as you type, matching service, stack, container name or
  image — the four things someone might remember.
- Chips and query compose: `running` + `redis` is a valid question.
- The count in the header becomes `shown/total` while a filter is active, so a
  filtered list never looks like a machine that lost containers.
- Empty result says which filter is hiding everything, with a one-click reset.

**Risk:** a filter that survives across popup opens will eventually convince
someone their containers are gone. The query resets on close; the view chip
persists, because that one is a preference.

### 1.2 Port conflicts

A stopped container whose published port is already held by a running one gets
a marker on its port chip and a tooltip naming the holder.

The engine's own error at that moment names the port and not the culprit, which
is exactly the part you need. This is the highest value-per-line item in the
plan: the logic is already written and tested.

### 1.3 Gauges

Three slim bars in the popup header: CPU, memory, disk.

- CPU and memory come from the `stats` aggregate already collected.
- Disk is the engine's footprint from `system df` against the root filesystem,
  never against itself — "53GB of 53GB" would always read as full.
- Each shows its denominator. A percentage with no denominator is a number
  nobody can act on.
- Bars only; no sparklines yet (see 4.4).

### 1.4 Daemon control

Engine state in the header with start/stop, and a toggle for start-at-boot.

`systemctl` as the user, authenticated by the ordinary polkit prompt. No sudo,
no pkexec, nothing setuid. Stopping asks for confirmation and says what it will
take down with it.

When the daemon is down the popup shows this control and nothing else —
a list of zero containers with a dozen dead buttons is worse than a single
sentence explaining why.

---

## Wave 2 — the visual pass

The current popup is legible and plain. The complaint is fair: it reads like a
table dump, everything has the same weight, and the eye has nowhere to land.

### 2.1 What the redesign has to earn

Three things, in order: **find the broken one faster**, **make the numbers
readable at a glance**, **stop the row of buttons from shouting**.

Anything that does not serve one of those is decoration and does not ship.

### 2.2 Layout

```
┌──────────────────────────────────────────────────────────┐
│  Docker ●            19/25 containers        ↻  🐳  ⚙   │  header
│  CPU  ▓▓▓░░░░░  15%    RAM ▓▓░░░░ 3.2/31GB   DISK ▓▓▓ 53/510GB │  gauges
├──────────────────────────────────────────────────────────┤
│  Containers 25 │ Images 32 │ Volumes 22 │ Networks 14    │  tabs
│  [ search…            ]   all · running · stopped        │  toolbar
├──────────────────────────────────────────────────────────┤
│  ● web-shop                      3/6   ■ ↻ 🐳            │  stack
│    ● api        Up 22m     0% · 11MB  :8080   … actions  │
│    ◐ flaky      Restarting  —          ⚠:5432            │
│  ● metrics                       2/2   ■ ↻ 🐳            │
├──────────────────────────────────────────────────────────┤
│  226GB reclaimable                              expand ▾ │  footer
└──────────────────────────────────────────────────────────┘
```

### 2.3 Rules for the visual language

- **Colour is reserved for state.** Nothing else in the panel is coloured. A
  panel where six things are tinted teaches the eye to ignore tint.
- **Degraded rows get a tinted background and a coloured left edge**, healthy
  rows get neither. Problems should be findable without reading, which is the
  same principle the mosaic runs on. The tint alone washes out against a busy
  wallpaper; the edge is what actually carries down a long list.
- **Actions appear on row hover**, except on degraded rows, where they stay
  visible — the row you need to act on should not require a hover to discover.
  The row reserves their width either way, so nothing shifts on hover.
- **One family, hierarchy from size and weight.** The original rule here said
  two type roles, an interface font beside the monospace one. That was wrong for
  this platform: the whole Omarchy shell sets `fontFamily: "monospace"` on
  purpose, and a proportional font would read as a widget from somewhere else.
  Hierarchy comes from the size tokens — `bodySmall` for names, `caption` for
  numbers and status — and from weight.
- **Vertical rhythm over density.** The current 2px row spacing fits more and
  reads worse; go to one consistent step and let the list scroll.
- **Group headers are heavier than rows**, and collapsible. Collapsed state is
  remembered per stack, so the four stacks you never look at stay shut.

### 2.4 Bar widget

The mosaic stays exactly as it is. It is the part that already works, and the
device-pixel rules behind it are not worth risking for a nicer gradient.

One addition: a badge dot when something is degraded and the popup is closed,
so a glance at the bar answers "is anything broken" without counting cells.

---

## Wave 3 — the other resources

### 3.1 Tabs

Containers · Images · Volumes · Networks, with counts. The same list widget
serves all four: group header, rows, selection, a command bar.

Grouping per tab: images by repository, volumes and networks by compose project.

### 3.2 Selection and bulk actions

Checkboxes on rows and on group headers. The command bar appears only when
something is selected, and names the count: "Stop 4 containers".

- Containers: start · stop · restart · logs
- Images / volumes / networks: remove

Removal is one confirmation naming the count and the total size, not one prompt
per item — a dialog that appears eleven times is a dialog nobody reads.

### 3.3 Removal semantics

- Default networks (`bridge`, `host`, `none`) are listed and never removable.
- The engine refuses to delete anything still in use; that refusal is shown in
  the panel rather than worked around with `-f`.
- Volumes can be removed **individually and deliberately** here, which is not
  the same as the bulk prune button the cleanup section refuses to offer. One is
  a considered act on a named volume; the other is a single click that deletes
  everything unattached.

---

## Wave 4 — new ideas

Ours, not from the other plugins. Ranked by value over effort.

### 4.1 Hand a whole stack to the agent

The per-container handoff already works. A failing stack is usually a failing
*relationship* — the api cannot reach the db — and one container's log is half
the story. Collect every container's log in the stack plus the compose file,
and hand that over.

Highest value in this list: it is the thing the other three plugins cannot do at
all, and most of the machinery exists.

### 4.2 Restart-loop counter

`docker ps` does not carry a restart count; `inspect` does. Run `inspect` only
for containers currently restarting — usually zero, occasionally one — and show
the number. "Restarting" and "restarted 8846 times" are different problems, and
the second one is not obvious from the panel today.

### 4.3 What changed since you last looked

The notification pipeline already computes state changes. Keep the last few and
show them at the top of the popup when they happened while it was closed:
"3 containers stopped 12m ago". Answers the question people actually open the
panel with.

### 4.4 CPU sparkline per row

Keep the last N stats samples per container and draw a two-pixel trace. Cheap,
because the samples are already being collected and thrown away. Deferred behind
the visual pass so it lands into a layout that has room for it.

### 4.5 Compose file in the editor

The stack knows its `config_files`. One button to open it in the user's editor,
via `omarchy launch editor`. Small, and it closes the loop after the agent says
which line is wrong.

### 4.6 Disk pressure hint

When reclaimable space passes a threshold, or the root filesystem crosses 90%,
the cleanup footer changes colour. 226GB of build cache is not an emergency
until the disk is nearly full, and then it very much is.

---

## Wave 5 — i18n

Strings move to a table with English default and Portuguese alongside, chosen by
setting. The tooltips are Portuguese today in an otherwise English plugin, which
is the worst of both.

Rules: no string concatenation for grammar, no flags as language switches, and
untranslated keys fall back to English rather than showing the key.

---

## Explicitly not doing

- **Swarm and Kubernetes.** Different model, different tool.
- **Editing compose files in the panel.** Opening them in an editor is the right
  size for a bar widget.
- **Remote engines.** `DOCKER_HOST` is respected because the CLI respects it,
  but the panel will not manage a fleet.
- **`system prune`.** One button that removes four kinds of thing, one of which
  is data, is exactly the shape of the mistake this plugin is trying not to
  make.
- **`rm -f` anywhere.** If the engine refuses, the refusal is information.

## Acceptance

A wave is done when:

- `node test_docker.js` is green and the new logic has checks that would fail if
  it broke — not checks that restate the implementation.
- The widget has been reloaded with `omarchy restart shell` and screenshotted,
  because a wrong colour or a clipped row is invisible in any other check.
- `README.md` documents the feature and `CLAUDE.md` records anything that bit.
- Nothing destructive gained a path that skips its confirmation.
