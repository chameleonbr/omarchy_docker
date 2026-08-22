.pragma library

// Shared, deliberately: without `.pragma library` each importing QML file gets
// its own copy, and the engine selected in Service.qml would not be the engine
// Panel.qml builds commands with.

// Pure logic for the avila.docker plugin: parsing docker output, grouping by
// compose stack, laying the mosaic grid out, and building command lines.
//
// Everything here is deterministic and free of QML types so test_docker.js can
// eval the file under plain node. Keep it that way — anything that touches
// Process, Timer, or Color belongs in Service.qml or Panel.qml.

// ----------------------------------------------------------------- engine
//
// Podman speaks almost the same CLI, so the difference is one word in front of
// every command — and one difference in output shape, handled in parseRows().
var ENGINE = "docker"

function setEngine(name) {
  ENGINE = name === "podman" ? "podman" : "docker"
  return ENGINE
}

function engine() {
  return ENGINE
}

function engineLabel() {
  return ENGINE === "podman" ? "Podman" : "Docker"
}

// Docker prints one JSON object per line; Podman prints a single JSON array.
// Accepting both is cheaper than branching at every call site.
function parseRows(stdout) {
  var text = String(stdout || "").trim()
  if (!text) return []

  if (text.charAt(0) === "[") {
    try {
      var array = JSON.parse(text)
      return Array.isArray(array) ? array : []
    } catch (error) {
      return []
    }
  }

  var rows = []
  var lines = text.split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    if (!line) continue
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      continue // a partial line mid-stream must not drop the whole refresh
    }
  }
  return rows
}

// ----------------------------------------------------------------- states

// Cell/severity buckets, worst last. Used for colors and for stack rollups.
var STATES = ["idle", "ok", "warn", "bad"]

function severity(state) {
  var index = STATES.indexOf(state)
  return index < 0 ? 0 : index
}

function worstOf(states) {
  var worst = "idle"
  for (var i = 0; i < states.length; i++) {
    if (severity(states[i]) > severity(worst)) worst = states[i]
  }
  return worst
}

// Which of the states a container is in, as a key. The word for it lives in
// I18n.js — this file deals in data, never in prose the panel will show.
function stateKey(container) {
  var state = String(container.state || "")
  var health = String(container.health || "none")

  if (state === "running") {
    if (health === "unhealthy") return "unhealthy"
    if (health === "starting") return "starting"
    return "running"
  }
  if (state === "restarting") return "restarting"
  if (state === "paused") return "paused"
  if (state === "removing") return "removing"
  if (state === "dead") return "dead"
  if (state === "created") return "created"
  if (state === "exited") return exitCode(container.status) === 0 ? "stopped" : "failed"
  return state
}

// The pieces that matter next to the word, and nothing else. An exit code is
// worth reading; the age is worth reading; the rest of docker's sentence is
// scaffolding between them.
function stateDetailParts(container) {
  var failed = String(container.state || "") === "exited" && exitCode(container.status) !== 0
  return {
    code: failed ? exitCode(container.status) : null,
    age: parseAge(container.status)
  }
}

// "Up 6 days (healthy)" -> { count: 6, unit: "day" }.
// "Exited (143) About an hour ago" -> { count: 1, unit: "hour", approx: true }.
//
// Structured rather than a string, because the string has to be rendered in
// whatever language the panel is in, and "an hour" does not survive a word by
// word translation.
function parseAge(status) {
  var text = String(status || "").trim()
  var match = /(?:Up|Exited \(\d+\)|Restarting \(\d+\))\s+(.+?)(?:\s+ago)?(?:\s+\(.*\))?$/
    .exec(text)
  if (!match) return { raw: text }

  var phrase = match[1].trim()
  var approx = /^About\s+/i.test(phrase)
  phrase = phrase.replace(/^About\s+/i, "")

  // "Less than a second" carries no count of its own.
  if (/^Less than/i.test(phrase)) return { count: 1, unit: "second", approx: true, raw: phrase }

  var parts = /^(\d+|a|an)\s+(second|minute|hour|day|week|month|year)s?$/i.exec(phrase)
  if (!parts) return { raw: phrase }

  var count = /^(a|an)$/i.test(parts[1]) ? 1 : Number(parts[1])
  return { count: count, unit: parts[2].toLowerCase(), approx: approx, raw: phrase }
}

// Docker reports health as "none" (not ""), and keeps the last health value on
// containers that have already exited — so health only counts while running.
function classify(container) {
  var state = String(container.State || "")
  var health = String(container.HealthStatus || "none")

  if (state === "running") return health === "unhealthy" ? "warn" : "ok"
  if (state === "restarting" || state === "paused" || state === "removing") return "warn"
  if (state === "dead") return "bad"
  if (state === "exited") return exitCode(container.Status) === 0 ? "idle" : "bad"
  return "idle" // created, and anything docker adds later
}

// "Exited (137) 6 days ago" -> 137. Absent code means we cannot prove failure,
// so treat it as a clean stop rather than inventing an error.
function exitCode(status) {
  var match = /^Exited \((\d+)\)/.exec(String(status || ""))
  return match ? Number(match[1]) : 0
}

// ------------------------------------------------------------- ps parsing

function parsePs(stdout) {
  var rows = parseRows(stdout)
  var containers = []

  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i]
    var labels = parseLabels(raw.Labels)
    var name = firstName(raw.Names)

    containers.push({
      id: String(raw.ID || ""),
      name: name,
      project: labels["com.docker.compose.project"] || "",
      // Compose service name is what a human reads; fall back to the container
      // name for anything started outside compose.
      service: labels["com.docker.compose.service"] || name,
      state: String(raw.State || ""),
      status: String(raw.Status || ""),
      health: String(raw.HealthStatus || "none"),
      image: String(raw.Image || ""),
      ports: parsePorts(raw.Ports),
      runningFor: String(raw.RunningFor || ""),
      // Compose records where the stack was defined. It is what lets a click
      // open lazydocker scoped to that stack instead of the whole daemon.
      workingDir: labels["com.docker.compose.project.working_dir"] || "",
      configFiles: splitList(labels["com.docker.compose.project.config_files"]),
      cell: classify(raw)
    })
  }

  return containers
}

// Compose joins multiple compose files with "," in the label value.
function splitList(value) {
  var out = []
  var parts = String(value || "").split(",")

  for (var i = 0; i < parts.length; i++) {
    var item = parts[i].trim()
    if (item) out.push(item)
  }

  return out
}

// docker ps joins names with "," when a container carries aliases.
function firstName(names) {
  return String(names || "").split(",")[0].trim()
}

// Labels arrive as a flat "k=v,k=v" string. Values may contain "=", keys never
// do, so split on the first "=" only.
function parseLabels(labels) {
  var out = {}
  var parts = String(labels || "").split(",")

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (!part) continue
    var split = part.indexOf("=")
    if (split <= 0) continue
    out[part.slice(0, split)] = part.slice(split + 1)
  }

  return out
}

// Ports is free-form text, not a list. Keep only published ports, and never let
// a shape we did not anticipate throw away the container.
function parsePorts(ports) {
  var out = []
  var parts = String(ports || "").split(",")

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim()
    if (!part || part.indexOf("->") < 0) continue
    var published = part.split("->")[0]
    var port = published.slice(published.lastIndexOf(":") + 1)
    if (port && out.indexOf(port) < 0) out.push(port)
  }

  return out
}

// ------------------------------------------------------------- ordering

// Stable, and deliberately independent of state: a cell that moves when its
// container restarts destroys the one thing the mosaic is for, which is
// learning where each service sits.
function sortContainers(containers) {
  return containers.slice().sort(function(left, right) {
    return compare(left.project, right.project)
      || compare(left.service, right.service)
      || compare(left.name, right.name)
  })
}

function compare(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

// ------------------------------------------------------------- grouping

var LOOSE = "(avulsos)"

function groupByProject(containers) {
  var order = []
  var byProject = {}

  var sorted = sortContainers(containers)
  for (var i = 0; i < sorted.length; i++) {
    var container = sorted[i]
    var key = container.project || LOOSE
    if (!byProject[key]) {
      byProject[key] = {
        project: key,
        loose: key === LOOSE,
        // Every container in a stack carries the same compose origin; the first
        // one to arrive is as good as any.
        workingDir: container.workingDir,
        configFiles: container.configFiles,
        containers: []
      }
      order.push(key)
    }
    byProject[key].containers.push(container)
  }

  var groups = []
  for (var j = 0; j < order.length; j++) {
    var group = byProject[order[j]]
    var summary = rollup(group.containers)
    group.running = summary.running
    group.total = summary.total
    group.worst = summary.worst
    groups.push(group)
  }

  return groups
}

// Degraded stacks first so the popup opens on what needs attention; loose
// containers last because they are the least likely to be what you came for.
function sortGroups(groups) {
  return groups.slice().sort(function(left, right) {
    if (left.loose !== right.loose) return left.loose ? 1 : -1
    var bySeverity = severity(right.worst) - severity(left.worst)
    if (bySeverity !== 0) return bySeverity
    return compare(left.project, right.project)
  })
}

// Deterministic and independent of state: loose containers last, matching where
// the popup puts them, then alphabetical. Used for the mosaic, where position
// has to be something you can learn.
function stableGroupOrder(groups) {
  return groups.slice().sort(function(left, right) {
    if (left.loose !== right.loose) return left.loose ? 1 : -1
    return compare(left.project, right.project)
  })
}

function rollup(containers) {
  var running = 0
  var states = []

  for (var i = 0; i < containers.length; i++) {
    if (containers[i].state === "running") running++
    states.push(containers[i].cell)
  }

  return { running: running, total: containers.length, worst: worstOf(states) }
}

// --------------------------------------------------------------- filters

function hiddenProjects(setting) {
  var out = []
  var parts = String(setting || "").split(",")

  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim()
    if (name) out.push(name)
  }

  return out
}

function applyFilters(containers, options) {
  var hidden = hiddenProjects(options.hideProjects)
  var showStopped = options.showStopped !== false
  var out = []

  for (var i = 0; i < containers.length; i++) {
    var container = containers[i]
    if (hidden.indexOf(container.project || LOOSE) >= 0) continue
    if (!showStopped && container.state !== "running" && container.state !== "restarting") continue
    out.push(container)
  }

  return out
}

// ------------------------------------------------------------ mosaic grid

// ---------------------------------------------------------- mosaic layout
//
// The bar is a horizontal strip, so the mosaic is laid out wide. How wide is
// decided by the cell size: a smaller cell does not merely shrink the mosaic,
// it fits more rows into the same bar height, and the width falls away much
// faster than the cell does. Halving the cell on a 16px bar takes 25 cells from
// two rows of 13 to three rows of 9 — a third of the width, not half.

var MAX_ROWS = 5

// Sizes are chosen in DEVICE pixels and handed back in logical ones.
//
// QT_SCALE_FACTOR is a supported thing to set, and this machine runs 0.85: a
// 4-logical-pixel cell is 3.4 device pixels, which the renderer resolves as
// three pixels for some cells and four for others depending on where each lands.
// The grid then shows cells of visibly different sizes even though every number
// in the layout is identical. Rounding each size to a whole device pixel first
// makes them identical by construction — and because the pitch is then a whole
// device pixel too, every cell shares the same sub-pixel phase and rasterises
// the same way, wherever the bar happens to put the widget.
function snapToDevice(px, dpr) {
  var ratio = Number(dpr) || 1
  if (ratio <= 0 || ratio === 1) return Math.max(1, Math.round(px))
  return Math.max(1, Math.round(px * ratio)) / ratio
}

// Cells round DOWN to the device grid. Rounding to nearest can hand back more
// than the space allowed — on a 8px bar at 0.85 it asks for 8.24 — and the
// mosaic then spills out of the bar it was measured for.
function floorToDevice(px, dpr) {
  var ratio = Number(dpr) || 1
  if (ratio <= 0 || ratio === 1) return Math.max(1, Math.floor(px))
  return Math.max(1, Math.floor(px * ratio)) / ratio
}

// How many rows of `cellSize` fit in the bar's icon area. This is also what
// makes a short bar work: the row count simply falls to one.
function rowsForHeight(heightPx, gapPx, cellSizePx) {
  var height = Number(heightPx) || 0
  var gap = Math.max(0, Number(gapPx) || 0)
  var cell = Math.max(2, Number(cellSizePx) || 6)
  if (height <= 0) return 1
  return Math.max(1, Math.min(MAX_ROWS, Math.floor((height + gap) / (cell + gap))))
}

var ASPECT_BIAS = 3

// Rows actually used for a flat mosaic: never more than the cells can fill.
function rowsFor(count, maxRows) {
  if (count <= 0) return 0
  var cap = Math.max(1, Number(maxRows) || 1)
  return Math.min(cap, Math.max(1, Math.ceil(Math.sqrt(count / ASPECT_BIAS))))
}

// Kept for callers that reason about how many rows fit before laying out.
function maxRowsFor(heightPx, gapPx, minCellPx) {
  return rowsForHeight(heightPx, gapPx, minCellPx)
}

// Flat layout: no grouping, cells wrapped into balanced rows.
//
// Every cell is the SAME size, and a row with fewer cells is centred under the
// one above rather than stretched to fill the width. Stretching made the short
// row render as wider rectangles, which looks like it means something — bigger
// stack? more containers? — when it means nothing at all.
function balancedLayout(count, maxRows) {
  var total = Math.max(0, Number(count) || 0)
  if (total === 0) return { rows: 0, columns: 0, blocks: 0, cells: [] }

  var rows = rowsFor(total, maxRows === undefined ? 2 : maxRows)
  var base = Math.floor(total / rows)
  var extra = total % rows
  var widest = base + (extra > 0 ? 1 : 0)

  var cells = []

  for (var row = 0; row < rows; row++) {
    var inRow = base + (row < extra ? 1 : 0)
    // Half a cell of padding when the row is one short, so it sits centred.
    var offset = (widest - inRow) / 2

    for (var column = 0; column < inRow; column++) {
      cells.push({
        row: row,
        column: offset + column,
        block: 0,
        rowCount: inRow,
        columns: widest
      })
    }
  }

  return { rows: rows, columns: widest, blocks: 1, cells: cells }
}

// Grouped layout: each stack gets a contiguous block of columns, filled top to
// bottom before moving right, and blocks are separated by a wider gap.
//
// Wrapping cells in a flat grid put a stack's containers next to each other but
// gave no way to see where one stack ended — adjacency is not separation. This
// makes each stack a shape you can point at.
//
// The two layouts trade differently and neither always wins: grouping wastes
// slots in partial columns and pays a gap per boundary, while the flat layout
// biases towards fewer rows for looks and so runs wider per cell. Which one is
// narrower depends on the counts, so `groupStacks` is a preference, not an
// optimisation — do not claim a fixed verdict for it, it has flipped twice
// already on real data.
function blockLayout(cells, rows) {
  var rowCount = Math.max(1, Number(rows) || 1)
  if (!cells || cells.length === 0) return { rows: 0, columns: 0, blocks: 0, cells: [] }

  // Group the incoming cells by their stack, preserving the order they arrive
  // in — that order is already stable and state-independent.
  var blocks = []
  var current = null

  for (var i = 0; i < cells.length; i++) {
    if (!current || cells[i].group !== current.group) {
      current = { group: cells[i].group, indexes: [] }
      blocks.push(current)
    }
    current.indexes.push(i)
  }

  var placed = new Array(cells.length)
  var column = 0

  for (var b = 0; b < blocks.length; b++) {
    var indexes = blocks[b].indexes
    var blockColumns = Math.ceil(indexes.length / rowCount)

    for (var n = 0; n < indexes.length; n++) {
      placed[indexes[n]] = {
        // Filled top to bottom, then across: partial columns pack tighter than
        // a wrapped final row, which is why this costs less width than the flat
        // layout despite adding gaps between stacks.
        row: n % rowCount,
        column: column + Math.floor(n / rowCount),
        block: b,
        rowCount: rowCount,
        columns: 0
      }
    }

    column += blockColumns
  }

  for (var k = 0; k < placed.length; k++) placed[k].columns = column

  return { rows: rowCount, columns: column, blocks: blocks.length, cells: placed }
}

// Pixels the mosaic needs. blockGap is the EXTRA space between stacks, on top
// of the ordinary gap.
function mosaicWidth(grid, cellPx, gapPx, blockGapPx) {
  if (!grid || grid.columns === 0) return 0
  var cell = Number(cellPx) || 0
  var gap = Number(gapPx) || 0
  var blockGap = Number(blockGapPx) || 0
  return grid.columns * cell
    + gap * (grid.columns - 1)
    + blockGap * Math.max(0, grid.blocks - 1)
}

// Kept as the single entry point the renderer calls.
function layout(count, maxRows) {
  return balancedLayout(count, maxRows)
}

// Deciding what one cell means, and how the whole mosaic is laid out.
//
// The old rule was a fixed cell count: more than N containers and it collapsed
// to stacks. That ignored the thing that actually matters, which is how much
// bar the mosaic eats — a number that depends on the bar's height, the cell
// size and the number of stacks, none of which a cell count knows about. The
// rule is now a width budget.
function planMosaic(containers, options) {
  var settings = options || {}
  var height = Number(settings.heightPx) || 0
  var dpr = Number(settings.devicePixelRatio) || 1
  var gap = snapToDevice(Math.max(1, Number(settings.gapPx) || 1), dpr)
  var blockGap = snapToDevice(Math.max(1, Number(settings.blockGapPx) || 3), dpr)
  var cellSize = Math.max(2, Number(settings.cellSizePx) || 5)
  var budget = Number(settings.maxWidthPx) || 0
  var grouped = settings.groupStacks !== false
  var groupBy = String(settings.groupBy || "auto")

  var groups = stableGroupOrder(groupByProject(containers))

  var byContainer = []
  for (var g = 0; g < groups.length; g++) {
    for (var c = 0; c < groups[g].containers.length; c++) {
      var container = groups[g].containers[c]
      byContainer.push({
        key: container.id,
        label: container.service,
        group: groups[g].project,
        cell: container.cell,
        containers: [container]
      })
    }
  }

  var byStack = []
  for (var i = 0; i < groups.length; i++) {
    byStack.push({
      key: groups[i].project,
      label: groups[i].project,
      // Each stack is its own group, so the flat layout is used for this mode.
      group: groups[i].project,
      cell: groups[i].worst,
      containers: groups[i].containers
    })
  }

  var maxRows = rowsForHeight(height, gap, cellSize)

  function plan(mode, cells) {
    var grid = mode === "container" && grouped
      ? blockLayout(cells, maxRows)
      : balancedLayout(cells.length, maxRows)
    var rows = grid.rows || 1
    // Whole pixels only. A fractional cell size puts cell edges on half pixels,
    // and a one-pixel gap then rounds away for some rows and not others — two
    // cells of the same colour merge into one tall block and the mosaic reads
    // as a different shape than it is. Losing a pixel of height is cheaper.
    var cell = height > 0
      ? floorToDevice((height - gap * (rows - 1)) / rows, dpr)
      : snapToDevice(cellSize, dpr)

    // Backstop: the gap is rounded to nearest, so a tall gap on a short bar can
    // still leave no room. Step down a device pixel at a time rather than
    // spill out of the bar.
    while (cell > 1 / (dpr || 1) && cell * rows + gap * (rows - 1) > height) {
      cell = floorToDevice(cell - 1 / (dpr || 1), dpr)
    }
    return {
      mode: mode,
      cells: cells,
      grid: grid,
      rows: rows,
      cellPx: cell,
      gapPx: gap,
      blockGapPx: mode === "container" && grouped ? blockGap : 0,
      width: mosaicWidth(grid, cell, gap,
        mode === "container" && grouped ? blockGap : 0),
      // What the rows actually occupy after rounding, so the caller can centre
      // the mosaic in the space it was given.
      height: rows * cell + gap * (rows - 1)
    }
  }

  if (groupBy === "container") return plan("container", byContainer)
  if (groupBy === "stack") return plan("stack", byStack)

  // auto: the most detail that fits the budget.
  var detailed = plan("container", byContainer)
  if (budget <= 0 || detailed.width <= budget) return detailed

  var collapsed = plan("stack", byStack)
  if (budget <= 0 || collapsed.width <= budget) return collapsed

  // Even one cell per stack does not fit. A single block reporting the worst
  // state is the honest end of that line.
  return plan("single", [{
    key: "all",
    label: "all",
    group: "all",
    cell: worstOfCells(byStack),
    containers: containers
  }])
}

// Kept for callers and tests that only care about what a cell represents.
function resolveCells(containers, options) {
  var plan = planMosaic(containers, Object.assign({
    heightPx: 16, gapPx: 1, cellSizePx: 5, maxWidthPx: 0
  }, options || {}))
  return { mode: plan.mode, cells: plan.cells }
}

function worstOfCells(cells) {
  var states = []
  for (var i = 0; i < cells.length; i++) states.push(cells[i].cell)
  return worstOf(states)
}

// ---------------------------------------------------------- stats parsing

function parseStats(stdout) {
  var rows = parseRows(stdout)
  var byId = {}

  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i]
    var memory = parseMemUsage(raw.MemUsage)
    var sample = {
      name: String(raw.Name || ""),
      cpu: parsePercent(raw.CPUPerc),
      memUsed: memory.used,
      memLimit: memory.limit,
      memPerc: parsePercent(raw.MemPerc),
      net: parseNetIO(raw.NetIO)
    }

    // `docker stats` reports ID truncated to 12 characters while
    // `docker ps --no-trunc` reports all 64, so indexing on one of them alone
    // silently never matches and every metric stays blank. Index on both.
    var full = String(raw.Container || "")
    var short = String(raw.ID || "")
    if (full) byId[full] = sample
    if (short) byId[short] = sample
  }

  return byId
}

function parsePercent(value) {
  var number = parseFloat(String(value || "").replace("%", ""))
  return isFinite(number) ? number : 0
}

// "33.53MiB / 31.08GiB" -> bytes for each half. Units are mixed within a single
// docker stats run, so both sides get parsed independently.
function parseMemUsage(value) {
  var parts = String(value || "").split("/")
  return {
    used: parseBytes(parts[0]),
    limit: parts.length > 1 ? parseBytes(parts[1]) : 0
  }
}

function parseNetIO(value) {
  var parts = String(value || "").split("/")
  return {
    rx: parseBytes(parts[0]),
    tx: parts.length > 1 ? parseBytes(parts[1]) : 0
  }
}

var UNITS = {
  b: 1,
  kb: 1000, mb: 1000000, gb: 1000000000, tb: 1000000000000,
  kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776
}

function parseBytes(value) {
  var match = /([0-9.]+)\s*([a-zA-Z]*)/.exec(String(value || "").trim())
  if (!match) return 0

  var number = parseFloat(match[1])
  if (!isFinite(number)) return 0

  var unit = String(match[2] || "b").toLowerCase()
  var scale = UNITS[unit]
  return scale ? number * scale : number
}

// Accepts either id length from either side of the join.
function lookupStats(statsById, id) {
  var key = String(id || "")
  return statsById[key] || statsById[key.slice(0, 12)] || null
}

function aggregateStats(containers, statsById) {
  var cpu = 0
  var memUsed = 0
  var memLimit = 0
  var rx = 0
  var tx = 0
  var samples = 0

  for (var i = 0; i < containers.length; i++) {
    var sample = lookupStats(statsById, containers[i].id)
    if (!sample) continue
    samples++
    cpu += sample.cpu
    memUsed += sample.memUsed
    // Every container reports the same host limit; take one, do not sum.
    if (sample.memLimit > memLimit) memLimit = sample.memLimit
    rx += sample.net.rx
    tx += sample.net.tx
  }

  return {
    samples: samples,
    cpu: cpu,
    memUsed: memUsed,
    memLimit: memLimit,
    memPerc: memLimit > 0 ? (memUsed / memLimit) * 100 : 0,
    net: { rx: rx, tx: tx }
  }
}

// --------------------------------------------------------------- metrics

var METRICS = ["cpu", "mem", "memPerc", "net", "count"]

function metricList(setting) {
  var out = []
  var parts = String(setting === undefined || setting === null ? "cpu,mem" : setting).split(",")

  for (var i = 0; i < parts.length; i++) {
    var name = parts[i].trim()
    if (METRICS.indexOf(name) >= 0 && out.indexOf(name) < 0) out.push(name)
  }

  return out
}

// No sample yet is not the same as a measurement of zero, and the label must
// not claim otherwise.
var NO_SAMPLE = "—"

function metricLabel(metric, aggregate, summary) {
  if (metric === "count") return summary.running + "/" + summary.total
  if (!aggregate || aggregate.samples === 0) return NO_SAMPLE

  if (metric === "cpu") return formatPercent(aggregate.cpu)
  if (metric === "mem") return formatBytes(aggregate.memUsed)
  if (metric === "memPerc") return formatPercent(aggregate.memPerc)
  if (metric === "net") return formatBytes(aggregate.net.rx) + "↓"
  return NO_SAMPLE
}

// The label rotates every few seconds; if its width followed the current value
// it would shove every widget to its right across the bar on each tick. Reserve
// the widest string each configured metric can produce, once.
function metricWidthSample(metrics, summary) {
  var widest = ""

  for (var i = 0; i < metrics.length; i++) {
    var candidate = WIDEST[metrics[i]]
    if (metrics[i] === "count") candidate = summary.running + "/" + summary.total
    if (candidate && candidate.length > widest.length) widest = candidate
  }

  return widest
}

// The widest value each metric can realistically reach. Reserving a generic
// "999.9GB" for all of them leaves a visible hole in the bar next to a label
// that never gets near it.
var WIDEST = {
  cpu: "999%",
  mem: "99.9GB",
  memPerc: "100%",
  net: "999MB↓",
  count: "99/99"
}

function formatPercent(value) {
  return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + "%"
}

function formatBytes(bytes) {
  var value = Number(bytes) || 0
  if (value < 1000) return Math.round(value) + "B"

  var units = ["KB", "MB", "GB", "TB"]
  var index = -1

  do {
    value = value / 1000
    index++
  } while (value >= 1000 && index < units.length - 1)

  return (value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + units[index]
}

// ------------------------------------------------------------- disk usage

// `docker system df --format '{{json .}}'` reports one row per resource type,
// with Reclaimable as human text: "4.2GB (7%)" or, for build cache, "221.2GB".
function parseSystemDf(stdout) {
  var parsed = parseRows(stdout)
  var rows = []

  for (var i = 0; i < parsed.length; i++) {
    var raw = parsed[i]
    var reclaimable = String(raw.Reclaimable || "")
    rows.push({
      type: String(raw.Type || ""),
      total: Number(raw.TotalCount) || 0,
      active: Number(raw.Active) || 0,
      size: parseBytes(raw.Size),
      // "4.2GB (7%)" -> the bytes are everything before the parenthesis.
      reclaimable: parseBytes(reclaimable.split(" (")[0])
    })
  }

  return rows
}

function dfRow(rows, type) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].type === type) return rows[i]
  }
  return null
}

// What the widget offers to reclaim.
//
// The mapping from `system df` to a prune command is not one to one, and the
// obvious reading is wrong: df's Reclaimable for Images counts every image no
// container is using, which is what `image prune -a` removes — plain
// `image prune` only takes dangling layers and will free far less than the
// number on screen. Showing one and running the other makes the widget a liar,
// so the two are separate entries.
//
// Volumes are listed and never pruned. Everything else here can be rebuilt or
// re-pulled; a volume is the one thing that is somebody's data.
var PRUNE_TARGETS = [
  {
    id: "buildCache",
    labelKey: "prune.buildCache",
    dfType: "Build Cache",
    args: ["builder", "prune", "-f"],
    risk: "safe",
    detailKey: "prune.detail.buildCache"
  },
  {
    id: "danglingImages",
    labelKey: "prune.danglingImages",
    dfType: null,
    args: ["image", "prune", "-f"],
    risk: "safe",
    detailKey: "prune.detail.danglingImages"
  },
  {
    id: "unusedImages",
    labelKey: "prune.unusedImages",
    dfType: "Images",
    args: ["image", "prune", "-a", "-f"],
    risk: "rebuildable",
    detailKey: "prune.detail.unusedImages"
  },
  {
    id: "stoppedContainers",
    labelKey: "prune.stoppedContainers",
    dfType: "Containers",
    args: ["container", "prune", "-f"],
    risk: "rebuildable",
    detailKey: "prune.detail.stoppedContainers"
  }
]

var VOLUMES_ARE_NOT_PRUNED =
  "Volumes are listed but never pruned from here: everything else on this list "
  + "can be rebuilt or pulled again, and a volume is the one thing that is "
  + "somebody's data. Use `docker volume prune` in a terminal if you mean it."

function pruneTargets(dfRows) {
  var out = []

  for (var i = 0; i < PRUNE_TARGETS.length; i++) {
    var target = PRUNE_TARGETS[i]
    var row = target.dfType ? dfRow(dfRows, target.dfType) : null
    out.push({
      id: target.id,
      labelKey: target.labelKey,
      command: [ENGINE].concat(target.args),
      risk: target.risk,
      detailKey: target.detailKey,
      // Unknown, not zero: dangling images have no row of their own in
      // `system df`, and claiming 0B would read as "nothing to do".
      reclaimable: row ? row.reclaimable : -1,
      known: !!row
    })
  }

  return out
}

function totalReclaimable(dfRows) {
  var total = 0
  for (var i = 0; i < PRUNE_TARGETS.length; i++) {
    var row = PRUNE_TARGETS[i].dfType ? dfRow(dfRows, PRUNE_TARGETS[i].dfType) : null
    if (row) total += row.reclaimable
  }
  return total
}

function systemDfCommand() {
  return [ENGINE, "system", "df", "--format", "{{json .}}"]
}

// ------------------------------------------------------------- filtering

var VIEWS = ["all", "running", "stopped"]

// Matches the things someone actually types: the service they know, the stack
// it belongs to, the container name docker made up, or the image.
function matchesQuery(container, query) {
  var needle = String(query || "").trim().toLowerCase()
  if (!needle) return true

  var haystack = [
    container.name, container.service, container.project, container.image
  ].join(" ").toLowerCase()

  return haystack.indexOf(needle) >= 0
}

function matchesView(container, view) {
  if (view === "running") return container.state === "running" || container.state === "restarting"
  if (view === "stopped") return container.state !== "running" && container.state !== "restarting"
  return true
}

function searchContainers(containers, options) {
  var settings = options || {}
  var out = []

  for (var i = 0; i < containers.length; i++) {
    if (!matchesView(containers[i], settings.view || "all")) continue
    if (!matchesQuery(containers[i], settings.query)) continue
    out.push(containers[i])
  }

  return out
}

// --------------------------------------------------------- port conflicts

// A stopped container will not come back if something else is already holding
// its published port, and the error docker gives at that moment names the port
// but not the culprit. This works out who is sitting on it, before the click.
function portConflicts(containers) {
  var holders = {}

  for (var i = 0; i < containers.length; i++) {
    var container = containers[i]
    if (container.state !== "running" && container.state !== "restarting") continue
    for (var p = 0; p < container.ports.length; p++) {
      if (!holders[container.ports[p]]) holders[container.ports[p]] = container.name
    }
  }

  var conflicts = {}

  for (var j = 0; j < containers.length; j++) {
    var candidate = containers[j]
    if (candidate.state === "running" || candidate.state === "restarting") continue

    var blocked = []
    for (var q = 0; q < candidate.ports.length; q++) {
      var port = candidate.ports[q]
      if (holders[port]) blocked.push({ port: port, heldBy: holders[port] })
    }

    if (blocked.length > 0) conflicts[candidate.id] = blocked
  }

  return conflicts
}

function conflictText(blocked) {
  if (!blocked || blocked.length === 0) return ""
  var parts = []
  for (var i = 0; i < blocked.length; i++) {
    parts.push(blocked[i].port + " held by " + blocked[i].heldBy)
  }
  return parts.join(", ")
}

// ------------------------------------------------------------- resources
//
// Images, volumes and networks. Listed so they can be found and removed; the
// engine refuses a delete while something still uses the resource, and that
// refusal is shown rather than worked around.

function imagesCommand() {
  return [ENGINE, "images", "--format", "{{json .}}"]
}

function volumesCommand() {
  return [ENGINE, "volume", "ls", "--format", "{{json .}}"]
}

function networksCommand() {
  return [ENGINE, "network", "ls", "--format", "{{json .}}"]
}

function parseImages(stdout) {
  var rows = parseRows(stdout)
  var images = []

  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i]
    var repository = String(raw.Repository || raw.repository || "<none>")
    var tag = String(raw.Tag || raw.tag || "")
    images.push({
      kind: "image",
      id: String(raw.ID || raw.Id || ""),
      name: tag && tag !== "<none>" ? repository + ":" + tag : repository,
      group: repository,
      size: parseBytes(raw.Size || raw.size),
      inUse: Number(raw.Containers) > 0,
      detail: String(raw.CreatedSince || "")
    })
  }

  return images
}

function parseVolumes(stdout) {
  var rows = parseRows(stdout)
  var volumes = []

  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i]
    var labels = parseLabels(raw.Labels)
    var name = String(raw.Name || raw.name || "")
    volumes.push({
      kind: "volume",
      id: name,
      name: name,
      // Anonymous volumes are 64 hex characters of nothing; showing the project
      // they belong to is the only way to tell them apart.
      group: labels["com.docker.compose.project"] || "(loose)",
      size: parseBytes(raw.Size),
      anonymous: labels["com.docker.volume.anonymous"] !== undefined,
      detail: String(raw.Driver || "")
    })
  }

  return volumes
}

var DEFAULT_NETWORKS = ["bridge", "host", "none"]

function parseNetworks(stdout) {
  var rows = parseRows(stdout)
  var networks = []

  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i]
    var labels = parseLabels(raw.Labels)
    var name = String(raw.Name || raw.name || "")
    networks.push({
      kind: "network",
      id: String(raw.ID || raw.Id || ""),
      name: name,
      group: labels["com.docker.compose.project"] || "(loose)",
      size: 0,
      // The engine's own networks are listed, because they are part of the
      // picture, and never removable, because removing them breaks the engine.
      protected: DEFAULT_NETWORKS.indexOf(name) >= 0,
      detail: String(raw.Driver || "")
    })
  }

  return networks
}

// Images carry no compose label — only containers do. But the whole panel is
// organised by stack, and an images tab organised by repository quietly drops
// that: `analise_pdfs-api` and `backlog-pipeline-api` become two unrelated rows
// when they are the heart of two different stacks.
//
// The relationship is recoverable from the containers already on hand, and from
// the naming compose uses for what it builds.
function projectForImage(image, containersByImage, projects) {
  // A container using the image says it outright, and says it correctly even
  // when the name looks like nothing.
  var direct = containersByImage[image.name] || containersByImage[image.group]
  if (direct) return direct

  // Compose names what it builds `<project>-<service>`. Longest project first,
  // so `web-shop-api` is not claimed by a project called `web`.
  for (var i = 0; i < projects.length; i++) {
    if (image.group.indexOf(projects[i] + "-") === 0) return projects[i]
  }

  return ""
}

function indexContainersByImage(containers) {
  var byImage = {}
  for (var i = 0; i < containers.length; i++) {
    var container = containers[i]
    if (!container.project) continue
    byImage[container.image] = container.project
    // Also without the tag, since an image row may carry one and the container
    // reference may not.
    byImage[container.image.split(":")[0]] = container.project
  }
  return byImage
}

function knownProjects(containers) {
  var seen = {}
  var projects = []
  for (var i = 0; i < containers.length; i++) {
    var project = containers[i].project
    if (!project || seen[project]) continue
    seen[project] = true
    projects.push(project)
  }
  // Longest first: prefix matching is only safe from the most specific end.
  return projects.sort(function(left, right) { return right.length - left.length })
}

// Images tagged with their stack, so the tab groups the way the rest of the
// panel does. Anything that belongs to no stack keeps its repository, which is
// the only grouping it has.
function attachProjects(images, containers) {
  var byImage = indexContainersByImage(containers)
  var projects = knownProjects(containers)
  var out = []

  for (var i = 0; i < images.length; i++) {
    var image = images[i]
    var project = projectForImage(image, byImage, projects)
    out.push(Object.assign({}, image, {
      project: project,
      group: project || image.group
    }))
  }

  return out
}

function resourceRemoveCommand(resource) {
  if (resource.kind === "image") return [ENGINE, "rmi", resource.id]
  if (resource.kind === "volume") return [ENGINE, "volume", "rm", resource.name]
  if (resource.kind === "network") return [ENGINE, "network", "rm", resource.id]
  return []
}

function canRemoveResource(resource) {
  if (!resource) return false
  if (resource.kind === "network") return !resource.protected
  return true
}

// The facts a confirmation needs; the sentence is assembled in I18n, because
// word order is not universal and a table of fragments cannot express that.
function resourceConfirmFacts(resources) {
  var bytes = 0
  for (var i = 0; i < resources.length; i++) bytes += resources[i].size || 0

  return {
    count: resources.length,
    kind: resources.length === 1 ? resources[0].kind : "",
    name: resources.length === 1 ? resources[0].name : "",
    bytes: bytes
  }
}

// ------------------------------------------------------------ selection
//
// Selection is a plain map of id -> true, rebuilt on every change rather than
// mutated: QML only re-evaluates a binding when the object identity changes,
// and a mutated map updates nothing on screen.

function toggleSelection(selection, id) {
  var next = Object.assign({}, selection)
  if (next[id]) delete next[id]
  else next[id] = true
  return next
}

function setSelection(selection, ids, on) {
  var next = Object.assign({}, selection)
  for (var i = 0; i < ids.length; i++) {
    if (on) next[ids[i]] = true
    else delete next[ids[i]]
  }
  return next
}

function selectionCount(selection) {
  return Object.keys(selection || {}).length
}

function selectedFrom(items, selection) {
  var out = []
  for (var i = 0; i < items.length; i++) {
    if (selection[items[i].id]) out.push(items[i])
  }
  return out
}

// A group is checked when every one of its rows is, which is also the state the
// header checkbox has to show — half-checked is a lie people click twice.
function groupChecked(items, selection) {
  if (items.length === 0) return false
  for (var i = 0; i < items.length; i++) {
    if (!selection[items[i].id]) return false
  }
  return true
}

// Anything that was selected and then filtered away is dropped: acting on rows
// that are no longer on screen is how a bulk action becomes a surprise.
function pruneSelection(selection, items) {
  var alive = {}
  for (var i = 0; i < items.length; i++) alive[items[i].id] = true

  var next = {}
  var keys = Object.keys(selection || {})
  for (var k = 0; k < keys.length; k++) {
    if (alive[keys[k]]) next[keys[k]] = true
  }
  return next
}

// ------------------------------------------------------ grouped resources

// The same shape the container list uses, so one list widget serves all four
// tabs: images by repository, volumes and networks by compose project.
function groupResources(items) {
  var order = []
  var byGroup = {}

  var sorted = items.slice().sort(function(left, right) {
    return compare(left.group, right.group) || compare(left.name, right.name)
  })

  for (var i = 0; i < sorted.length; i++) {
    var key = sorted[i].group || "(loose)"
    if (!byGroup[key]) {
      byGroup[key] = { project: key, loose: key === "(loose)", items: [], size: 0 }
      order.push(key)
    }
    byGroup[key].items.push(sorted[i])
    byGroup[key].size += sorted[i].size || 0
  }

  var groups = []
  for (var j = 0; j < order.length; j++) {
    var group = byGroup[order[j]]
    // A group of one is not a group. Most repositories hold a single tag, and
    // giving each its own header row makes every image cost two lines that say
    // nearly the same thing — same name, same size, twice, with two checkboxes
    // for one decision.
    group.single = group.items.length === 1
    groups.push(group)
  }

  // Loose last, matching where the container list puts it.
  return groups.sort(function(left, right) {
    if (left.loose !== right.loose) return left.loose ? 1 : -1
    return compare(left.project, right.project)
  })
}

function matchesResourceQuery(item, query) {
  var needle = String(query || "").trim().toLowerCase()
  if (!needle) return true
  return (item.name + " " + item.group + " " + (item.detail || "")).toLowerCase().indexOf(needle) >= 0
}

function searchResources(items, query) {
  var out = []
  for (var i = 0; i < items.length; i++) {
    if (matchesResourceQuery(items[i], query)) out.push(items[i])
  }
  return out
}

var TABS = ["containers", "images", "volumes", "networks"]

// --------------------------------------------------------------- gauges

// Three numbers against their real ceilings, because a percentage with no
// denominator is a number nobody can act on.
function gauges(aggregate, dfRows, hostDisk) {
  var images = dfRow(dfRows, "Images")
  var containers = dfRow(dfRows, "Containers")
  var volumes = dfRow(dfRows, "Local Volumes")
  var cache = dfRow(dfRows, "Build Cache")

  var engineBytes = (images ? images.size : 0)
    + (containers ? containers.size : 0)
    + (volumes ? volumes.size : 0)
    + (cache ? cache.size : 0)

  var diskTotal = hostDisk && hostDisk.total > 0 ? hostDisk.total : 0

  return {
    cpu: {
      value: aggregate ? aggregate.cpu : 0,
      max: 100,
      text: aggregate && aggregate.samples > 0 ? formatPercent(aggregate.cpu) : "—"
    },
    memory: {
      value: aggregate ? aggregate.memUsed : 0,
      max: aggregate ? aggregate.memLimit : 0,
      text: aggregate && aggregate.samples > 0
        ? formatBytes(aggregate.memUsed) + "/" + formatBytes(aggregate.memLimit)
        : "—"
    },
    disk: {
      value: engineBytes,
      max: diskTotal,
      // The engine's footprint against the filesystem it lives on, not against
      // itself: "53GB of 53GB" would always read as full.
      text: engineBytes > 0 && diskTotal > 0
        ? formatBytes(engineBytes) + "/" + formatBytes(diskTotal)
        : "—"
    }
  }
}

function hostDiskCommand() {
  return ["df", "-B1", "--output=used,size", "/"]
}

function parseHostDisk(stdout) {
  var lines = String(stdout || "").trim().split("\n")
  if (lines.length < 2) return { used: 0, total: 0 }

  var parts = lines[lines.length - 1].trim().split(/\s+/)
  return {
    used: Number(parts[0]) || 0,
    total: Number(parts[1]) || 0
  }
}

// ---------------------------------------------------------- daemon control
//
// systemctl as the user, which authenticates through the ordinary polkit
// prompt. No sudo, no pkexec, nothing setuid.

function daemonCommand(action) {
  if (action === "stop") return ["systemctl", "stop", ENGINE + ".service", ENGINE + ".socket"]
  if (action === "start") return ["systemctl", "start", ENGINE + ".service"]
  if (action === "enable") return ["systemctl", "enable", ENGINE + ".service"]
  if (action === "disable") return ["systemctl", "disable", ENGINE + ".service"]
  return []
}

function daemonStatusCommand() {
  return ["systemctl", "is-enabled", ENGINE + ".service"]
}

// -------------------------------------------------------------- commands

function psCommand() {
  return [ENGINE, "ps", "-a", "--no-trunc", "--format", "{{json .}}"]
}

function eventsCommand() {
  return [ENGINE, "events", "--format", "{{json .}}"]
}

function statsCommand() {
  return [ENGINE, "stats", "--no-stream", "--format", "{{json .}}"]
}

// Always address a container by id: names get reused across compose runs, ids
// do not.
function containerCommand(action, id) {
  return [ENGINE, action, id]
}

// Starting a stack is not the mirror image of stopping one.
//
// `compose start` only starts containers that still exist: it cannot bring back
// one that was removed, and it ignores edits to the compose file. `up -d` does
// both, which is what someone means by "start this stack". Stopping stays
// `stop` — never `down`, which would delete the containers and their networks.
function stackCommand(action, group, hasCompose) {
  var containers = (group && group.containers) || []

  if (hasCompose && group && group.project && !group.loose) {
    var command = [ENGINE, "compose"]

    // Compose needs to find the project's files; the labels record where they
    // were. Without this it looks in the current directory and finds nothing.
    if (group.workingDir) command.push("--project-directory", shellQuote(group.workingDir))
    var files = group.configFiles || []
    for (var f = 0; f < files.length; f++) command.push("-f", shellQuote(files[f]))
    command.push("-p", shellQuote(group.project))

    if (action === "start") command.push("up", "-d")
    else command.push(action)

    return command
  }

  var fallback = [ENGINE, action === "start" ? "start" : action]
  for (var i = 0; i < containers.length; i++) fallback.push(containers[i].id)
  return fallback
}

// Which actions a container can take right now. Offering "start" on a running
// container, or "remove" on one that is up, is how a panel teaches people that
// its buttons are decoration.
function containerActions(container) {
  var state = String(container.state || "")
  // Paused counts as running: the process is still there, just frozen. Offering
  // "remove" on it would need `rm -f`, and a button that quietly forces is a
  // button that eventually deletes something someone was using.
  var running = state === "running" || state === "restarting" || state === "paused"

  return {
    canStart: !running && state !== "removing",
    canStop: running,
    canRestart: running,
    canUnpause: state === "paused",
    canShell: state === "running",
    // Removing a running container needs -f, and a button that quietly forces
    // is a button that eventually deletes something someone was using.
    canRemove: !running && state !== "removing"
  }
}

function removeCommand(id) {
  return [ENGINE, "rm", id]
}

// A published port is a thing you want to open, not read out. Only ports bound
// on the host are offered — an internal port has nothing to click.
function portUrl(port) {
  return "http://localhost:" + String(port)
}

// ------------------------------------------------------------ lazydocker
//
// lazydocker has no way to open focused on one container: its CLI takes only
// `-p <project>` and `-f <file>`. So the plugin offers exactly what the tool
// actually supports — the whole daemon, or one compose stack — and uses plain
// docker for anything container-level.

// `omarchy-launch-or-focus` matches its pattern as /\bPATTERN\b/i against the
// window class, so a generic "org.omarchy.lazydocker" would also match
// "org.omarchy.lazydocker.stack-foo" and focus the wrong window. These two id
// shapes cannot match each other, which is the whole reason for the ".all".
var LAZYDOCKER_ALL = "org.omarchy.lazydocker.all"

function lazydockerAppId(project) {
  if (!project) return LAZYDOCKER_ALL
  return "org.omarchy.lazydocker.stack_" + slug(project)
}

// Underscore, not hyphen. `omarchy-launch-or-focus` anchors its pattern with
// \b, and a hyphen is a word boundary — so "stack-web-shop" would match the
// window of "stack-web-shop-dev" and focus the wrong stack. Underscore is a
// word character, so a longer id simply does not match a shorter one.
function slug(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_")
}

// omarchy-launch-or-focus-tui rebuilds its arguments into one string and runs
// it through `eval`, so any path containing a space has to arrive already
// quoted or it splits into two broken arguments.
function shellQuote(value) {
  return "'" + String(value === undefined || value === null ? "" : value).replace(/'/g, "'\\''") + "'"
}

// group === null opens the whole daemon.
function lazydockerCommand(group) {
  var project = group && !group.loose ? group.project : ""
  var command = [
    "omarchy-launch-or-focus-tui",
    "--app-id=" + lazydockerAppId(project),
    "lazydocker"
  ]

  if (project) {
    command.push("-p", shellQuote(project))
    var files = group.configFiles || []
    for (var i = 0; i < files.length; i++) command.push("-f", shellQuote(files[i]))
  }

  return command
}

// A stack only scopes cleanly when compose told us where it came from.
function canScopeLazydocker(group) {
  return !!group && !group.loose && !!group.project
}

// Container-level views lazydocker cannot give us. Each gets its own window id
// so a second click focuses the window already showing that container.
function containerTuiCommand(kind, container, tail) {
  var id = container.id
  var appId = "org.omarchy.docker." + kind + "_" + slug(container.name || id.slice(0, 12))

  if (kind === "logs") {
    return ["omarchy-launch-or-focus-tui", "--app-id=" + appId,
      ENGINE, "logs", "-f", "--tail", String(Number(tail) || 200), id]
  }

  if (kind === "shell") {
    // Not every image ships bash, so the shell is probed before it is used.
    //
    // The obvious `exec bash || exec sh` does NOT work: when `exec` fails in a
    // non-interactive shell, POSIX says the shell exits — the `||` branch never
    // runs, and the terminal window dies the instant it opens, with no error
    // anywhere. Test first, then exec.
    return ["omarchy-launch-or-focus-tui", "--app-id=" + appId,
      ENGINE, "exec", "-it", id,
      "sh", "-c", shellQuote(
        "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi")]
  }

  return []
}

// A bar click does not move keyboard focus, so a terminal launched from it
// opens on whatever monitor happened to be focused — frequently not the one the
// user just clicked on, which reads as "nothing happened". Focusing the
// widget's own monitor first puts the window where the click was.
// Hand a container's log to the default Omarchy coding agent. The heavy lifting
// (facts, log capture, prompt, picking the agent) lives in bin/, because it is
// shell work and because it stays runnable by hand.
function askAgentCommand(scriptPath, container, tail) {
  if (!scriptPath || !container) return []
  return [scriptPath, container.id, container.name, String(Number(tail) || 400)]
}

// A failing stack is usually a failing relationship — the api cannot reach the
// database — and one container's log is half of that conversation.
function askAgentStackCommand(scriptPath, group, tail) {
  if (!scriptPath || !group || !group.project || group.loose) return []
  return [scriptPath, group.project, String(Number(tail) || 200)]
}

// The stack knows where its compose file is; opening it closes the loop after
// the agent says which line is wrong.
function composeFileFor(group) {
  if (!group) return ""
  var files = group.configFiles || []
  return files.length > 0 ? files[0] : ""
}

function openComposeCommand(group) {
  var file = composeFileFor(group)
  if (!file) return []
  return ["omarchy-launch-editor", file]
}

// ------------------------------------------------------- restart loops
//
// `docker ps` carries no restart count; `inspect` does. Asked only for the
// containers currently restarting — usually none, occasionally one — because
// inspecting everything on every refresh is the cost this plugin avoids
// everywhere else.
function restartingIds(containers) {
  var ids = []
  for (var i = 0; i < containers.length; i++) {
    if (containers[i].state === "restarting") ids.push(containers[i].id)
  }
  return ids
}

function inspectRestartsCommand(ids) {
  if (!ids || ids.length === 0) return []
  return [ENGINE, "inspect", "--format", "{{.Id}} {{.RestartCount}}"].concat(ids)
}

function parseRestarts(stdout) {
  var byId = {}
  var lines = String(stdout || "").trim().split("\n")

  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length < 2) continue
    var count = Number(parts[1])
    if (isFinite(count)) byId[parts[0]] = count
  }

  return byId
}

// --------------------------------------------------------- disk pressure
//
// 226GB of reclaimable build cache is not an emergency until the disk is nearly
// full, and then it very much is. Neither number means much alone.
function diskPressure(dfRows, hostDisk, options) {
  var settings = options || {}
  var fullAt = Number(settings.fullAt) || 0.9
  var reclaimAt = Number(settings.reclaimAt) || 20e9

  var used = hostDisk && hostDisk.total > 0 ? hostDisk.used / hostDisk.total : 0
  var reclaimable = totalReclaimable(dfRows)

  if (used >= fullAt && reclaimable > 0) {
    return { level: "urgent", percent: Math.round(used * 100), bytes: reclaimable }
  }

  if (reclaimable >= reclaimAt) {
    return { level: "notice", percent: Math.round(used * 100), bytes: reclaimable }
  }

  return { level: "none", percent: Math.round(used * 100), bytes: reclaimable }
}

function focusMonitorCommand(monitor) {
  if (!monitor) return []
  return ["hyprctl", "dispatch", "focusmonitor", String(monitor)]
}

function logsCommand(id, tail) {
  return ENGINE + " logs -f --tail " + (Number(tail) || 200) + " " + id
}

// ---------------------------------------------------------- state changes
//
// What is worth interrupting someone for. Computed by comparing two snapshots
// rather than by watching the event stream: events fire for every intermediate
// step of a restart, and the only thing worth a notification is where a
// container ended up.
function stateChanges(before, after) {
  var previous = {}
  for (var i = 0; i < before.length; i++) previous[before[i].id] = before[i]

  var changes = []

  for (var j = 0; j < after.length; j++) {
    var now = after[j]
    var was = previous[now.id]
    if (!was) continue // new containers are not news

    if (was.cell === now.cell && was.state === now.state) continue

    var change = classifyChange(was, now)
    if (change) changes.push({ container: now, kind: change })
  }

  return changes
}

function classifyChange(was, now) {
  var wasBad = was.cell === "bad" || was.cell === "warn"
  var isBad = now.cell === "bad" || now.cell === "warn"

  if (!wasBad && isBad) {
    if (now.state === "restarting") return "restarting"
    if (now.health === "unhealthy") return "unhealthy"
    if (now.state === "exited") return "failed"
    return "degraded"
  }

  // Recovery is worth saying exactly once, and only for something that had
  // actually gone wrong — not for every container someone starts by hand.
  if (wasBad && !isBad && now.state === "running") return "recovered"

  return null
}

function changeNotification(change) {
  var name = change.container.name
  var kind = change.kind

  if (kind === "restarting") return { urgency: "critical", title: name, body: "está em loop de restart" }
  if (kind === "unhealthy") return { urgency: "critical", title: name, body: "ficou unhealthy" }
  if (kind === "failed") return { urgency: "critical", title: name, body: "saiu com erro" }
  if (kind === "degraded") return { urgency: "normal", title: name, body: "mudou de estado" }
  if (kind === "recovered") return { urgency: "low", title: name, body: "voltou ao normal" }
  return null
}

function notifyCommand(notification) {
  return ["notify-send", "-a", "Docker", "-u", notification.urgency,
    notification.title, notification.body]
}

// Docker emits a burst of events for a single `compose up`; only the ones that
// can change what the mosaic shows are worth a refresh.
var REFRESH_ACTIONS = [
  "create", "start", "stop", "die", "kill", "destroy", "pause", "unpause",
  "restart", "rename", "update", "health_status"
]

function shouldRefresh(line) {
  var raw
  try {
    raw = JSON.parse(String(line || "").trim())
  } catch (error) {
    return false
  }

  if (String(raw.Type || "") !== "container") return false

  var action = String(raw.Action || "")
  // health_status arrives as "health_status: healthy".
  var head = action.split(":")[0].trim()
  return REFRESH_ACTIONS.indexOf(head) >= 0
}

// Reconnect backoff for the events stream. Losing it is routine (daemon
// restart); hammering the socket afterwards is not.
function backoffMs(attempt, baseMs, capMs) {
  var base = Number(baseMs) || 1000
  var cap = Number(capMs) || 30000
  var delay = base * Math.pow(2, Math.max(0, attempt))
  return Math.min(cap, delay)
}
