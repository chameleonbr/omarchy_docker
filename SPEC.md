# Ultra Docker — design notes

Why the plugin is shaped the way it is. `README.md` is for using it; this is for
deciding whether a change is a good idea.

## The problem

`docker ps` on a development machine does not fit on a screen. The machine this
was built on runs 25 containers across 7 compose stacks, and a container stuck
in `Restarting` sits there unnoticed for hours — it did, for two days, while
this was being written.

So the widget shows no number you have to read. The shape says how many
containers there are, the colours say how they are doing, and the single cell
that pulses is the one that wants you.

## Scope

**In:** container state, CPU and memory, grouping by compose stack, per-container
and per-stack actions, logs, a shell, lazydocker scoped to a stack, and handing a
log to the default coding agent.

**Out:** remote hosts, Swarm, Kubernetes, image/volume/network management,
editing compose files, metric history. Anything deeper than a glance is
lazydocker's job, and the plugin opens it rather than reimplementing it.

## The mosaic

The bar is a horizontal strip, so the mosaic grows sideways rather than into a
square. A square grid wastes the width it has and shrinks every cell to nothing.

### Rows come from the bar, not from a constant

```
rows = min(5, floor((height + gap) / (cellSize + gap)))
```

`cellSize` is a preference, not the final size: the cell is then sized to fill
whatever the rows leave. This is also the whole answer to a short bar — fewer
rows fit, and the layout adapts without a special case.

**A smaller cell is not simply a smaller mosaic.** It fits another row, and the
width falls away much faster than the cell does. On a 26px bar with 25
containers in 7 stacks:

| cellSize | rows | width |
|---|---|---|
| 7px | 2 | 128px |
| 5px | 3 | 83px |
| 3px | 4 | 61px |

### Sizes are chosen in device pixels

`QT_SCALE_FACTOR` is a supported thing to set, and this was built on a machine
running 0.85. There, a 4-logical-pixel cell is 3.4 device pixels: the renderer
draws some cells three pixels wide and others four, and a grid of identical
cells appears as a grid of visibly different ones while every number in the
layout is correct.

Cell, gap and stack gap are each rounded onto the device grid. Cells round
**down** (`floorToDevice`) so the rounding can never ask for more height than
the bar has.

What actually matters is that the **pitch** is a whole device pixel: then every
cell shares one sub-pixel phase and rasterises identically, wherever the bar
happens to place the widget.

Chasing the widget's fractional position instead does not work, and two attempts
are buried in the history — see "What will bite you".

### Two layouts

**Grouped** (`groupStacks`, default): each stack owns a contiguous block of
columns, filled top to bottom before moving right, with a wider gap at each
boundary. Wrapping cells in a flat grid put a stack's containers beside each
other but gave no way to see where one ended: adjacency is not separation.

**Flat**: cells wrapped into balanced rows, no boundaries. 7 cells become rows of
4 and 3, never 4 and 3 with a hole, and never one row carrying a single cell
stretched across the width — that lopsided shape was what made the first version
look accidental.

Neither is reliably narrower. Grouping wastes slots in partial columns and pays
a gap per boundary; the flat layout biases towards fewer rows for looks and runs
wider per cell. Which wins depends on the counts, and it has flipped twice on
real data. `groupStacks` is a preference, not an optimisation.

### Every cell is the same size

A row with fewer cells is centred, never stretched to fill the width. A wider
cell looks like it means something — a bigger stack? more containers? — and it
means nothing at all. **Position and colour carry the information; size and
shape carry none.**

### Cells never move

Ordered by project, then service, then name, with containers started outside
compose last. **Never by state.**

A cell that jumps when its stack breaks destroys the one thing the mosaic is
for: knowing which cell is which without reading anything. The popup does sort
degraded stacks to the top, because that is a list you read top to bottom rather
than a shape you recognise. Two functions, deliberately: `stableGroupOrder` for
the mosaic, `sortGroups` for the popup.

### Colour

| state | colour |
|---|---|
| running, healthy or without a healthcheck | foreground |
| unhealthy, restarting, paused | accent |
| exited non-zero, dead | urgent |
| exited cleanly, created | foreground at 35% |

A cell whose container is `restarting` pulses on a 2s cycle. It is the only
movement in the widget, spent on the one state that otherwise goes unnoticed.

Health is read only while the container runs: Docker keeps the last health value
after a container stops, and a clean exit must not be painted as a failure
because of it.

### A width budget, not a container count

The first rule was "more than N containers collapses to stacks". That ignored
the thing that matters, which is how much bar the mosaic eats — a number that
depends on the bar height, the cell size and the stack count, none of which a
cell count knows about.

`auto` now takes the most detail that fits `maxWidth`: one cell per container,
else one per stack, else a single block reporting the worst state. `groupBy`
overrides it when you want one or the other regardless.

## The metric label

Beside the mosaic, one short value rotating every `metricRotateMs` through the
configured `metrics` (`cpu`, `mem`, `memPerc`, `net`, `count`):

```
15%  →  3.2GB  →  15%  →  …
```

Its width is reserved once, from the widest value each configured metric can
realistically produce. Sizing to the current value would shove every widget to
its right across the bar every few seconds.

With no sample yet it shows `—`, never `0%`. Zero is a measurement; this is the
absence of one.

## Interactions

**Bar:** left opens the popup (or lazydocker, with `primaryAction`), middle
opens lazydocker for the whole daemon, right opens `dockerUrl` or refreshes,
scroll advances the metric.

**Popup:** degraded stacks first. A stack starts, stops and restarts as a unit,
or opens lazydocker scoped to itself. Each container has logs, a shell,
start/stop, restart, and one button that hands its log to the default coding
agent.

## Data: two sources, very different costs

Keeping these apart is the single most important thing in the implementation.

**State — cheap, live.** `docker ps -a --no-trunc --format '{{json .}}'`,
triggered by a long-lived `docker events` stream with a 300ms debounce (one
`compose up` emits dozens of events in a second) and a 60s safety poll in case
the stream dies quietly. Reconnect backs off 1s → 2s → 4s, capped at 30s.

**Metrics — expensive, its own clock.** `docker stats --no-stream` measured
**2.1 seconds for 20 containers**. It runs on a 30s timer, never on the event
path, never twice at once, and not at all while no widget is visible or while on
battery. Merging the two clocks would turn a light widget into one that freezes
the shell on every `compose up`.

Grouping comes from compose labels — `com.docker.compose.project`, `.service`,
`.project.working_dir`, `.project.config_files` — never from parsing container
names. On the machine this was built for, two containers' names bore no
relation to their project, and any heuristic misfiled both.

## Actions

Always by container id, never by name: names get reused across compose runs, ids
do not. The user is in the `docker` group, so no root and no polkit.

Stack actions use `docker compose -p <project> <action>`, falling back to a loop
over the group's container ids when the compose binary is absent.

Nothing is updated optimistically. A restart can fail, and the screen would be
lying until the next poll — the truth comes back through `docker events`.

## lazydocker

Its CLI takes `-f/--file` and `-p/--project` and nothing else: there is **no**
way to open it focused on one container, and no IPC. So the plugin offers
exactly what the tool supports and uses plain docker for the rest.

| target | how |
|---|---|
| whole daemon | `lazydocker` |
| one stack | `lazydocker -p <project> -f <each config file>` |
| one container | not possible — logs and shell open in docker instead |

Everything goes through `omarchy launch or focus tui`, so a second click focuses
the window already open instead of stacking another terminal, and each scope
gets its own window id.

### Two traps, both verified on the machine

**Window ids collide by word boundary.** `omarchy-launch-or-focus` finds a window
with `/\bPATTERN\b/i` against the class. A generic `org.omarchy.lazydocker`
matches every scoped window, and `…stack-a` matches the window of `…stack-a-dev`
because `-` is a word boundary. Ids use `_`, which is a word character, so a
longer id cannot match a shorter one. There is a regression test.

**The launcher passes argv through `eval`.** `omarchy-launch-or-focus-tui`
rebuilds its arguments into one string and evaluates it, so any path containing
a space must arrive already quoted.

## Agent handoff

`bin/omarchy-docker-ask-agent` follows `omarchy-agent-crash`: gather the facts,
write the bulky part to a file, pass a prompt that points at it. A few hundred
lines of container output does not belong in argv, and every agent reads files.

It sends state, exit code, restart count, health, image and the compose stack —
the restart count alone usually explains a container that will not stay up. The
agent starts in the stack's own directory when compose recorded one, and the
prompt asks it to change nothing without asking first, because `omarchy-agent`
launches without approval prompts.

With no default agent set, the button says so through `notify-send`: the widget
runs the script detached, so stderr reaches nobody.

## Settings

| key | default | what it decides |
|---|---|---|
| `primaryAction` | `popup` | what a left click opens |
| `groupBy` | `auto` | cell per container, per stack, or by budget |
| `cellSize` | 4 | wanted cell size; smaller buys rows, rows buy width |
| `cellGap` | 2 | space between cells of one stack |
| `stackGap` | 3 | extra space marking a stack boundary |
| `groupStacks` | true | off drops the boundaries for plain rows |
| `maxWidth` | 160 | where `auto` gives up on detail |
| `pulseRestarting` | true | the only movement in the widget |
| `metrics` | `cpu,mem` | rotation order; empty hides the label |
| `metricRotateMs` | 4000 | how fast it rotates |
| `statsIntervalMs` | 30000 | `docker stats` is slow; this is why |
| `statsOnBattery` | false | sample metrics on battery too |
| `pollIntervalMs` | 60000 | backstop for the events stream |
| `openPollIntervalMs` | 3000 | state refresh while the popup is open |
| `showStopped` | true | include stopped containers |
| `hideProjects` | — | stacks to leave out |
| `dockerUrl` | — | opened on right click |
| `logTail` | 200 | lines given to logs and to the agent |

## Files

```
manifest.json   kinds: service + bar-widget; `schema` becomes the settings UI
Service.qml     one per shell session: reads docker, owns every process
Panel.qml       one per monitor: the bar widget and the popup
Mosaic.qml      turns a plan into pixels, nothing else
Docker.js       all the logic, and the only part with tests
bin/            shell helpers, kept runnable by hand
fixtures/demo/  throwaway compose stacks that generate the fixtures
```

`Docker.js` is a QML `.js` resource and cannot carry `export`, so the tests
`eval` it. Keep QML types out of it or the tests stop running.

## Checks

`node test_docker.js` — 79 checks, no framework, no network, no daemon.

Fixtures are real `docker` output captured from `fixtures/demo/`, which exists so
the awkward states are real rather than hand-written: a clean exit, a failed
exit, a restart loop, a failing healthcheck, and containers started outside
compose.

The checks cover the layout rules (row counts, balance, uniform cell size,
centring, device-pixel snapping, budget collapse), parsing (every state, exit
codes, compose labels, memory units, malformed lines), ordering stability,
metric formatting and reserved width, command shapes, and the two lazydocker
traps above.

## Bugs found during implementation

None of these appear in any error log. Each was found by a test or a screenshot,
and each left behind a regression test or a note.

| symptom | cause |
|---|---|
| metric stuck at `—` forever | `docker stats` reports 12-character ids, `docker ps --no-trunc` reports 64; the join never matched |
| healthy machine shown as a dead daemon | `exitCode` read inside `onStreamFinished`, where it is not yet valid |
| metrics never sampled | `service` is still null in `Component.onCompleted`; the host injects `bar` later, so the registration was lost |
| popup opened invisible | children of a `Flickable` are reparented onto its `contentItem`, whose width is zero; the column collapsed |
| buttons that simply were not there | Font Awesome glyphs missing from the bar font; a missing glyph renders as nothing |
| lazydocker focusing the wrong window | `\b` treats `-` as a boundary, so `stack-a` matches `stack-a-dev` |
| container terminal dying as it opened | `exec bash \|\| exec sh`: when `exec` fails, a non-interactive shell exits and the `\|\|` never runs |
| clicks appearing to do nothing | a bar click does not move keyboard focus, so the window opened on another monitor |
| widget vanishing from the bar | `IpcHandler` without `import Quickshell.Io` takes the whole of `Panel.qml` down |
| cells of visibly different sizes | `QT_SCALE_FACTOR=0.85`: whole logical pixels are fractional device pixels |
| monitor-aware behaviour doing nothing | the bar host has no `screen`, so `bar.screen.name` was always an empty string |

## What will bite you

- **Never sort mosaic cells by state**, and never stretch a short row. Both turn
  a shape you can learn into noise.
- **Never let the metric label size to its current value.**
- **A daemon that is down is not a machine with no containers.** Different
  state, different colour, different text; confusing them makes the widget lie
  in the one case where it must not.
- **No sample yet is not zero.**
- **Compose labels, never name parsing.**
- **A cell below about five device pixels communicates nothing.** Collapsing is
  a legibility requirement, not an optimisation.
- **Font glyphs are not guaranteed.** The empty and error states are drawn
  rectangles for exactly this reason.
- **The plugin installed as a symlink is not watched** by the shell's file
  watcher. Editing the repo reloads nothing; only `omarchy restart shell` does.
