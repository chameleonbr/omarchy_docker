# Docker for the Omarchy bar

One cell per container, coloured by state, sitting in the icon area of the bar.
CPU and memory cycle beside it. Clicking gets you stacks, restart and logs —
and hands anything deeper to lazydocker, already scoped to the stack you
clicked.

![Stacks, containers and per-container actions in the Omarchy bar](preview.png)

## Why a mosaic

`docker ps` on a development machine does not fit on a screen. The machine this
was written on runs 25 containers across 7 compose projects; a container stuck
in `Restarting` sits there unnoticed for hours.

So the widget shows no number you have to read. The shape tells you how many
containers there are, the colours tell you how they are doing, and the one cell
that pulses is the one that needs you.

Containers of the same compose stack sit together in their own block of
columns, filled top to bottom, with a wider gap marking where one stack ends and
the next begins. The blocks are what let you point at a stack; without them
adjacency is not separation.

**Cell size is the lever that matters.** A smaller cell does not merely shrink
the mosaic — it fits another row into the same bar, and the width falls away
much faster than the cell does. On a 26px bar with 25 containers in 7 stacks:

| Cell | Rows | Width |
|---|---|---|
| 7px | 2 | 128px |
| 5px | 3 | 83px |
| 3px | 4 | 61px |

**Cells are sized on the device pixel grid.** If you run with `QT_SCALE_FACTOR`
set — 0.85 here — a cell that is a whole number of logical pixels is a fraction
of a real one, and the renderer draws some cells a pixel wider than others. The
sizes are chosen so that the cell, the gap and the pitch are all whole device
pixels, which is what makes every cell come out identical.

**How wide it may get is a budget, not a container count.** Past `maxWidth` the
mosaic collapses to one cell per stack, and past that to a single block. This is
also what makes a short bar work: fewer rows fit, the detailed view would sprawl,
and it collapses on its own instead of eating the bar.

**Every cell is the same size**, and a row with fewer cells is centred rather
than stretched — a wider cell would look like it meant something (a bigger
stack? more containers?) when it means nothing. Position and colour carry the
information; size and shape carry none.

**Cells never move.** Ordered by project, then service, then name, with
containers started outside compose last. The order never depends on state, so a
cell stays put when its stack breaks. The popup does sort degraded stacks to the
top, because that is a list you read rather than a shape you recognise.

| Colour | Meaning |
|---|---|
| foreground | running, healthy or without a healthcheck |
| accent | unhealthy, restarting or paused |
| urgent | exited with a non-zero code, or dead |
| dimmed | stopped cleanly, or created and never started |

## Install

```bash
omarchy plugin add \
  https://github.com/chameleonbr/omarchy_docker.git \
  --enable \
  --yes
```

Requires `docker` (and your user in the `docker` group — no root, no polkit).
`lazydocker` is optional; the buttons that open it are only useful if you have
it installed.

## Using it

**In the bar**

| Action | What happens |
|---|---|
| left click | popup with stacks, containers and actions |
| middle click | lazydocker for the whole daemon |
| right click | your web UI if you set one, otherwise a refresh |
| scroll | jump to the next metric without waiting for the rotation |

Set `primaryAction` to `lazydocker` if you would rather have left click skip
the popup entirely.

**In the popup**

Stacks come first if they are degraded. A stack starts, stops and restarts as a
unit, or opens lazydocker scoped to itself. Each container gets logs, a shell,
start/stop, restart, and one button that hands its log to your coding agent.

## Asking the agent

The robot button on a container captures its recent log and opens your default
Omarchy agent on it, with the facts that usually explain a container that will
not stay up: state, exit code, restart count, health, image, and the compose
stack it belongs to.

The log goes to a file under `$XDG_RUNTIME_DIR/omarchy-docker/` and the prompt
points at it — a few hundred lines of container output does not belong in argv,
and every agent reads files. The agent starts in the stack's own directory when
compose recorded one, so the compose file it may need to edit is right there.
The prompt asks it to diagnose and to change nothing without asking first.

Set your agent with `omarchy default agent <name>` — without one the button says
so rather than failing quietly.

It also works by hand:

```bash
bin/omarchy-docker-ask-agent <container-id> [name] [tail]
```


## About the lazydocker buttons

lazydocker's CLI takes `-p <project>` and `-f <file>` and nothing else — there
is no way to open it focused on one container. So this plugin offers exactly
what lazydocker actually supports:

- **the whole daemon**, from the bar or the popup header
- **one compose stack**, using the `working_dir` and `config_files` that compose
  writes onto every container it starts

Container-level views that lazydocker cannot give you use plain docker instead:
logs open `docker logs -f`, the shell opens `docker exec -it` with a fallback
from bash to sh.

Every one of these goes through `omarchy launch or focus tui`, so clicking the
same button twice focuses the window that is already open instead of stacking
another terminal on your workspace. Each scope gets its own window id, so the
lazydocker you opened for one stack and the one you opened for another are two
windows that stay out of each other's way.

## Where the windows open

Clicking a bar widget does not move keyboard focus, so a terminal launched from
one lands on whichever monitor happened to be focused — often not the monitor
you clicked. Every launch focuses the widget's own screen first, so the window
appears where you asked for it.

## IPC

The same actions are reachable from a Hyprland binding:

```bash
omarchy-shell avila.docker toggle
omarchy-shell avila.docker toggleOn DP-1     # on one specific monitor
omarchy-shell avila.docker lazydocker
omarchy-shell avila.docker stack web-shop
omarchy-shell avila.docker refresh
```

## Settings

Every option is in the widget's settings screen. The ones worth knowing about:

| Setting | Default | Why you might change it |
|---|---|---|
| `groupBy` | `auto` | force one cell per container, or per stack |
| `cellSize` | 4 | smaller cells buy rows, and rows buy width |
| `maxWidth` | 160 | where `auto` gives up and collapses to stacks |
| `groupStacks` | true | off drops the stack blocks for plain balanced rows |
| `stackGap` | 3 | how far apart the stack blocks sit |
| `metrics` | `cpu,mem` | reorder, add `memPerc`/`net`/`count`, or empty to hide |
| `statsIntervalMs` | 30000 | `docker stats` is slow; see below |
| `statsOnBattery` | false | sample CPU and memory on battery too |
| `hideProjects` | — | stacks you never want to see |

## A note on cost

`docker stats --no-stream` took **2.1 seconds** for 20 containers on the machine
this was built for. That is why container state and container metrics are on
completely separate clocks:

- **state** follows the `docker events` stream, so it is live and costs nothing
  while nothing is happening
- **metrics** run on their own slow timer, never on the event path, never twice
  at once, and not at all while no widget is on screen or while you are on
  battery

If you make `statsIntervalMs` small, you are asking your machine to spend two
seconds of docker doing bookkeeping that often. It is your call, but the default
is 30 seconds for a reason.

## Development

```bash
node test_docker.js
```

79 checks, no framework, no network, no daemon. `fixtures/` holds real
`docker ps` and `docker stats` output; the tests run against that.

See `CLAUDE.md` for how the pieces fit and what has already bitten.

## License

MIT
