# CLAUDE.md

Working notes for `avila.docker`, an Omarchy shell plugin. Read this before
changing anything here.

## Development loop

The plugin is installed as a symlink:

```
~/.config/omarchy/plugins/avila.docker -> ~/orca/omarchy_docker
```

**The shell's file watcher does not follow that symlink.** Saving a file here
does *not* hot-reload the plugin, and neither does
`omarchy-shell shell rescanPlugins` — it will happily keep running the code it
loaded at startup while you edit and wonder why nothing changes. This cost real
time once already.

```bash
node test_docker.js       # first, always: the logic is testable without a shell
omarchy restart shell     # the only reliable way to load edited QML from here
```

To see what the running widget actually thinks, log from QML and read it back:

```bash
journalctl --user --since "-30s" -p debug | grep 'DEBUG qml'
```

To see what it actually *looks* like, screenshot the bar. The widget is small
and a wrong colour or a clipped row is invisible in any other kind of check:

```bash
hyprctl monitors -j            # bar sits at the bottom edge of each monitor
grim -g "<x>,<y> <w>x30" - | magick - -scale 800% /tmp/bar.png
```

## Checks

`node test_docker.js` — 157 checks, plain node, no framework, no network, no daemon.

`Docker.js` is a QML `.js` resource and cannot carry `export`, so the test file
`eval`s it into scope. Keep `Docker.js` free of QML types (`Process`, `Timer`,
`Color`) or the tests stop running.

`fixtures/` holds real `docker` output, captured from the throwaway stack in
`fixtures/demo/`. That stack exists so the awkward states are real rather than
hand-written JSON: a clean exit, a failed exit, a restart loop, a failing
healthcheck, and containers started outside compose.

```bash
docker compose -f fixtures/demo/compose.yml -p web-shop up -d
docker compose -f fixtures/demo/compose.metrics.yml -p metrics up -d
docker run -d --name scratchpad alpine sh -c 'while true; do sleep 30; done'
docker run --name legacy-tool alpine sh -c 'exit 127'
docker run --name importer alpine sh -c 'exit 143'

# capture while web-shop-flaky-1 is mid-restart, or the restarting state is lost
docker ps -a --no-trunc --format '{{json .}}' > fixtures/ps.jsonl
docker stats --no-stream --format '{{json .}}' > fixtures/stats.jsonl
```

## Architecture

```
bin/            shell helpers, kept runnable by hand
manifest.json   kinds: service + bar-widget; `schema` becomes the settings UI
Service.qml     one per shell session: reads docker, owns every process
Panel.qml       one per monitor: the bar widget and the popup
Mosaic.qml      turns a plan into pixels, nothing else
Docker.js       all the logic, and the only part with tests
```

The split that matters is inside `Service.qml`, between two data sources with
very different costs:

- **state** — `docker ps`, triggered by a long-lived `docker events` stream with
  a 300ms debounce and a 60s safety poll. Live, and free while idle.
- **metrics** — `docker stats --no-stream`, on its own 30s timer. Measured at
  **2.1 seconds for 20 containers**. Never on the event path, never re-entrant,
  paused when no widget is visible and (by default) on battery.

Merging those two clocks would turn a light widget into one that freezes the
shell every time you run `docker compose up`. Do not merge them.

## Things that will bite you

- **The symlink is not watched.** See the development loop above. `omarchy
  restart shell` or you are testing yesterday's code.

- **`exitCode` is not valid inside `onStreamFinished`.** The payload and the
  exit status arrive on different signals: at `exited` the collector may not
  hold the whole output yet, and at `streamFinished` the exit code is not set.
  Reading it there reports a failure that did not happen, and a healthy machine
  renders as a dead daemon. Both processes wait for the two signals and apply
  once.

- **`service` is null in `Component.onCompleted`.** The host injects `bar` after
  the widget is constructed, so `bar.shell.serviceFor(...)` resolves later.
  Registering visibility only at completion silently loses it, the service
  counts zero watchers forever, and metrics never sample. Register on
  `onServiceChanged` as well, guarded by `registeredVisible`.

- **`docker stats` reports 12-character ids, `docker ps --no-trunc` reports 64.**
  Indexing on one of them alone matches nothing and every metric stays blank
  forever, with no error anywhere. Samples are indexed under both.

- **`omarchy-launch-or-focus` matches `/\bPATTERN\b/i` against the window
  class**, so window ids that share a prefix collide: `stack-web-shop` matches
  the window of `stack-web-shop-dev`, because `-` is a word boundary. Ids use
  `_` as separator, which is a word character, so a longer id cannot match a
  shorter one. `lazydockerAppId` owns this; do not "tidy" the underscores.

- **`omarchy-launch-or-focus-tui` rebuilds argv into a string and `eval`s it.**
  Any path with a space has to arrive already quoted. `shellQuote` in
  `Docker.js` does that; removing it breaks every project stored under a path
  with a space in it.

- **`exec cmd || fallback` is silently fatal in `sh`.** When `exec` fails in a
  non-interactive shell, POSIX says the shell exits — the `||` branch never
  runs. `sh -c 'exec bash 2>/dev/null || exec sh'` therefore kills the terminal
  the instant it opens on any image without bash (redis:alpine, for one), with
  no error anywhere. Probe with `command -v` first, then exec.

- **A bar click does not move keyboard focus.** A terminal launched from the
  widget opens on whatever monitor was focused, which on a multi-monitor desk is
  usually not the one that was clicked — indistinguishable from the click doing
  nothing. Every launch dispatches `focusmonitor` for the widget's own screen
  first.

- **The bar host has no `screen`.** `bar.screen.name` yields an empty string, so
  every monitor-aware behaviour built on it silently becomes a no-op — the fix
  above shipped broken exactly once for this reason, and looked correct while
  doing nothing. The monitor comes from the Quickshell window instead:
  `QsWindow.window.screen.name`.

- **`IpcHandler` needs `import Quickshell.Io`.** Without it the whole of
  `Panel.qml` fails to load and the widget silently disappears from the bar.

- **Cell sizes must be whole DEVICE pixels, not whole logical ones.**
  `QT_SCALE_FACTOR` is a supported setting and this was found at 0.85: a
  4-logical-pixel cell is 3.4 device pixels, and the renderer resolves some
  cells at three pixels and others at four. A grid of identical cells then draws
  as a grid of visibly different ones, with every number in the layout correct.
  `planMosaic` takes `devicePixelRatio` and snaps cell, gap and block gap onto
  that grid; cells use `floorToDevice` so rounding can never ask for more height
  than the bar has.

  Chasing the widget's fractional position instead does NOT work, and two
  attempts are buried in the history: our own `x` never moves (we are first in
  the row), the row shifts without telling us, `mapToItem` is a call rather than
  a binding, and `layer.enabled` composites the finished texture at the same
  fractional offset. Whole-pixel PITCH is the thing that matters — it makes
  every cell share one sub-pixel phase and rasterise identically, wherever the
  bar puts the widget.

- **Do not claim a width verdict for grouping.** Grouped wastes slots in partial
  columns and pays a gap per boundary; the flat layout biases towards fewer rows
  for looks and so runs wider per cell. Which one is narrower depends on the
  counts, and it has flipped twice already on real data. `groupStacks` is a
  preference, not an optimisation. The tests lock down the structure — whole
  columns per stack, one extra gap per boundary — not a measurement.

- **Never stretch a short row.** Filling the width makes its cells render wider,
  which reads as a signal and carries none. Cells are uniform and the short row
  is centred. `layout()` owns this.

- **Never sort mosaic cells by state.** This bit once in stack mode: cells came
  from `sortGroups()`, which puts degraded stacks first, so a stack jumped
  position the moment it broke. `stableGroupOrder()` is what the mosaic uses;
  `sortGroups()` is for the popup list only. Cells that move when a container
  restarts destroy the only thing the mosaic is for: knowing which cell is which
  without reading anything. Order is `(project, service, name)`, full stop.

- **Never let the metric label size to its current value.** It rotates every few
  seconds, and a label that changes width shoves every widget to its right
  across the bar on each tick. `metricWidthSample` reserves the widest value the
  configured metrics can produce, once.

- **A daemon that is down is not a machine with no containers.** Different
  state, different colour, different text. Confusing them makes the widget lie
  in the one situation where you most need it not to.

- **No sample yet is not zero.** The label shows `—` until a real measurement
  lands. Zero is a measurement.

- **Do not update the UI optimistically after an action.** A restart can fail,
  and the screen would be lying until the next poll. The truth comes back
  through `docker events`.

- **Compose labels, never name parsing.** On this machine `web-shop-db` belongs to
  `web-shop` and `collector` to `metrics`. Any heuristic over
  container names misfiles both.

- **The mosaic is laid out wide, not square.** A bar is a horizontal strip: a
  square grid wastes it and shrinks every cell. `rowsForHeight()` derives the row
  count from the bar height and the wanted cell size, and the flat layout
  balances rows (7 cells become 4 and 3) — the old square grid produced rows of
  3, 3 and 1, and that lone stretched cell was what made the widget look
  accidental.

- **A cell below ~5px communicates nothing.** Collapsing to stacks and then to a
  single block is a legibility requirement, not an optimization.

- **Font glyphs are not guaranteed.** The empty and error states are drawn
  rectangles, not nerd-font icons, because a missing glyph renders as nothing
  and the widget looks broken rather than empty.

## Disk cleanup

`docker system df` is sampled when the popup opens, not on a timer: nobody needs
to know how much build cache they have until they are looking at it, and finding
out walks the whole image store.

**The df row and the prune command are not one to one, and the obvious reading
is wrong.** df's Reclaimable for Images counts every image no container uses,
which is what `image prune -a` removes; plain `image prune` takes only dangling
layers. Pairing the number with the wrong command makes the panel a liar. They
are separate entries in `PRUNE_TARGETS`, and dangling images carry
`reclaimable: -1` — unknown, not zero, because `0B` would read as nothing to do.

**Volumes stay out of `PRUNE_TARGETS` permanently.** Everything else on that
list can be rebuilt or pulled again. There is a test asserting no target
mentions volumes; do not "complete" the list.

## Surfaces

**The popup is a `KeyboardPanel`, not a `PopupCard`.** PopupCard is a
PopupWindow and takes no keyboard focus at all: the search field looked like a
text field, was one, and never received a keystroke. KeyboardPanel is the qs.Ui
surface built for this, on PanelWindow with a keyboard focus prime.

**`ConfirmDialog` fills the surface it is a child of.** Placed on the plugin
root — which is the bar widget, about a hundred pixels wide — its scrim
anchored to that, so every confirmation rendered inside the bar where nobody
could see or click it, and every destructive button silently did nothing. It
belongs inside the panel, `anchors.fill: parent`.

## Shared modules

**`.pragma library` is not optional on `Docker.js` and `I18n.js`.** Without it,
every QML file that imports a `.js` resource gets its OWN copy: `Service.qml`
switched the language on its instance while `Panel.qml` kept rendering from an
untouched one, and the engine chosen in one was not the engine the other built
commands with. The symptom is a setting that visibly does nothing while every
piece works when tested alone.

`.pragma library` is a QML directive, not JavaScript, so `test_docker.js` strips
it before `eval`.

## Translation

Strings live in `I18n.js`; `Docker.js` deals in keys and data and never in prose
the panel will show. Three rules the tests enforce:

- **Both tables carry the same keys**, and the same placeholders in each. A key
  present in one and missing in the other is a string that silently changes
  language mid-panel.
- **No sentence is concatenated from translated fragments.** Word order is not
  universal. Anything with a value in it is a template.
- **English is the fallback**, not the key: a panel reading `state.failed` is
  worse than one reading it in the wrong language.

**Every translated binding must read `languageEpoch`.** `I18n.t()` is a function
call, so QML records no dependency on it and a language change repaints nothing.
The `tr()` helpers on `Panel.qml` exist to make that read happen. Declaring the
property without reading it — which is exactly how this shipped once — looks
correct and does nothing.

Durations are parsed into a count and a unit rather than translated word by
word: "About an hour" became "cerca de an hora" that way, and putting articles
in the table would be encoding grammar in a lookup. The numeral sidesteps
articles in both languages.

## Trust model

The plugin runs as the user, through the `docker` group. No root, no polkit.

**Image labels are hostile input.** `com.docker.compose.project` and `.service`
come from labels, and any image can set them to anything — Docker rejects a `<`
in a container *name*, but a label takes it happily. Every Text that renders a
label-derived string sets `textFormat: Text.PlainText`; without it Qt's
`AutoText` parses a crafted value as rich text.

Everything that reaches a shell goes through `shellQuote`. This was verified
against the real launcher, not in the abstract: `omarchy-launch-or-focus`
rebuilds argv into a string and `eval`s it, and single-quoting survives that —
but only because the value arrives as an argument. A quick mental repro that
inlines the payload into the assignment "proves" an injection that does not
exist. Test through the actual script.

## Agent handoff

`bin/omarchy-docker-ask-agent` follows `omarchy-agent-crash`: gather facts, write
the bulky part to a file, pass a prompt that points at it, then
`exec omarchy-agent --prompt`. Never put a log in argv.

`omarchy-default-agent` prints the chosen agent and prints nothing when none is
set — Omarchy deliberately picks none for you, so the empty case is normal and
gets a notification, not an error nobody sees. The widget runs the script
detached, so `stderr` goes nowhere a user will look; `notify-send` is the only
channel that reaches them.

The script runs `umask 077` and verifies the log directory is a real directory
it owns: logs routinely carry connection strings and tokens, and the `/tmp`
fallback is a shared directory where a planted symlink would redirect the write.

`docker logs` is captured with `2>&1` on purpose: container errors overwhelmingly
arrive on stderr, and splitting the streams hides the interesting half.

## lazydocker specifics

`lazydocker --help` in 0.25.2 offers exactly `-f/--file` and `-p/--project`.
There is **no** flag to open focused on a container, and no IPC. So:

- whole daemon → `lazydocker`
- one stack → `lazydocker -p <project> -f <each config file>`
- one container → not possible; use `docker logs` / `docker exec` in their own
  windows instead

The `-p` and `-f` values come from the labels compose writes on every container:
`com.docker.compose.project`, `.project.working_dir`, `.project.config_files`
(comma separated when there is more than one file). Containers started outside
compose have none of these, cannot be scoped, and fall back to the whole daemon.
