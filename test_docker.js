// Checks for Docker.js: parsing, grouping, mosaic partitioning, metric
// formatting and the command shapes the plugin runs.
//
// Run with `node test_docker.js`. Nothing here talks to the Docker daemon —
// fixtures/ holds real output captured from a live machine.
//
// Docker.js is a QML .js resource and cannot carry `export` statements, so it
// is eval'd into this scope rather than imported.

const assert = require("assert")
const fs = require("fs")

eval(fs.readFileSync(__dirname + "/Docker.js", "utf8"))

const psFixture = fs.readFileSync(__dirname + "/fixtures/ps.jsonl", "utf8")
const statsFixture = fs.readFileSync(__dirname + "/fixtures/stats.jsonl", "utf8")

let passed = 0
function check(name, run) {
  try {
    run()
    passed++
  } catch (error) {
    console.error("FAIL " + name + "\n  " + error.message)
    process.exitCode = 1
  }
}

// --------------------------------------------------------- mosaic grid

check("few containers make one row of bars", () => {
  for (const n of [1, 2, 3]) {
    const result = balancedLayout(n, 2)
    assert.strictEqual(result.rows, 1, "count " + n)
    assert.strictEqual(result.cells.length, n)
  }
})

check("four containers make four squares", () => {
  const result = balancedLayout(4, 2)
  assert.strictEqual(result.rows, 2)
  assert.deepStrictEqual(rowSizes(result), [2, 2])
})

check("flat rows are balanced, never lopsided", () => {
  assert.deepStrictEqual(rowSizes(balancedLayout(5, 2)), [3, 2])
  assert.deepStrictEqual(rowSizes(balancedLayout(7, 2)), [4, 3])
  assert.deepStrictEqual(rowSizes(balancedLayout(20, 2)), [10, 10])

  for (let n = 1; n <= 40; n++) {
    const sizes = rowSizes(balancedLayout(n, 2))
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, "count " + n)
  }
})

function rowSizes(result) {
  const sizes = []
  for (const cell of result.cells) sizes[cell.row] = (sizes[cell.row] || 0) + 1
  return sizes
}

check("a short flat row is centred under the long one", () => {
  const result = balancedLayout(7, 2)
  const bottom = result.cells.filter(cell => cell.row === 1)
  assert.ok(Math.abs(bottom[0].column - 0.5) < 1e-9, "inset by half a cell")
})

check("an empty mosaic does not divide by zero", () => {
  assert.deepStrictEqual(balancedLayout(0, 2), { rows: 0, columns: 0, blocks: 0, cells: [] })
  assert.deepStrictEqual(blockLayout([], 2), { rows: 0, columns: 0, blocks: 0, cells: [] })
})

check("every container gets exactly one cell", () => {
  for (let n = 1; n <= 40; n++) {
    assert.strictEqual(balancedLayout(n, 2).cells.length, n, "count " + n)
  }
})

// ------------------------------------------------------ grouped layout

const GROUPED = [
  { group: "a" }, { group: "a" }, { group: "a" }, { group: "a" },
  { group: "b" }, { group: "b" },
  { group: "c" }
]

check("each stack occupies its own contiguous columns", () => {
  const grid = blockLayout(GROUPED, 2)
  const columnsOf = block => new Set(
    grid.cells.filter((_, i) => grid.cells[i].block === block).map(cell => cell.column))

  // a: 4 cells over 2 rows = 2 columns; b: 1 column; c: 1 column.
  assert.deepStrictEqual([...columnsOf(0)].sort(), [0, 1])
  assert.deepStrictEqual([...columnsOf(1)].sort(), [2])
  assert.deepStrictEqual([...columnsOf(2)].sort(), [3])
  assert.strictEqual(grid.blocks, 3)
  assert.strictEqual(grid.columns, 4)
})

check("no column is ever shared by two stacks", () => {
  const grid = blockLayout(GROUPED, 2)
  const owner = {}
  for (const cell of grid.cells) {
    if (owner[cell.column] === undefined) owner[cell.column] = cell.block
    assert.strictEqual(owner[cell.column], cell.block,
      "column " + cell.column + " belongs to one stack only")
  }
})

check("cells fill top to bottom before moving right", () => {
  const grid = blockLayout(GROUPED, 2)
  assert.deepStrictEqual(
    grid.cells.slice(0, 4).map(cell => [cell.column, cell.row]),
    [[0, 0], [0, 1], [1, 0], [1, 1]])
})

check("grouping packs each stack into its own whole columns", () => {
  // The invariant worth locking down is the structure, not a width comparison:
  // which layout is narrower flips with the container counts.
  const containers = parsePs(psFixture)
  const plan = planMosaic(containers, {
    heightPx: 16, gapPx: 2, blockGapPx: 3, cellSizePx: 4, maxWidthPx: 0,
    groupBy: "container", groupStacks: true
  })

  const groups = stableGroupOrder(groupByProject(containers))
  let expectedColumns = 0
  for (const group of groups) expectedColumns += Math.ceil(group.containers.length / plan.rows)

  assert.strictEqual(plan.grid.blocks, groups.length, "one block per stack")
  assert.strictEqual(plan.grid.columns, expectedColumns, "whole columns per stack")
})

check("every boundary costs exactly one extra gap", () => {
  const containers = parsePs(psFixture)
  const options = {
    heightPx: 16, gapPx: 2, cellSizePx: 4, maxWidthPx: 0,
    groupBy: "container", groupStacks: true
  }
  const tight = planMosaic(containers, Object.assign({}, options, { blockGapPx: 1 }))
  const loose = planMosaic(containers, Object.assign({}, options, { blockGapPx: 5 }))

  const boundaries = tight.grid.blocks - 1
  assert.ok(boundaries > 0)
  assert.ok(Math.abs((loose.width - tight.width) - boundaries * 4) < 1e-6,
    "widening the boundary gap by 4 costs 4 per boundary and nothing else")
})

// -------------------------------------------------------- sizing rules

check("a smaller cell buys rows, and rows buy width", () => {
  // The point of the setting: halving the cell does not halve the mosaic, it
  // fits another row and the width falls much further than that.
  const containers = parsePs(psFixture)
  const at = size => planMosaic(containers, {
    groupBy: "container", groupStacks: true,
    heightPx: 16, gapPx: 1, blockGapPx: 3, cellSizePx: size, maxWidthPx: 0
  })

  const big = at(7)
  const small = at(4)
  const tiny = at(3)

  assert.ok(small.rows > big.rows, "a smaller cell fits more rows")
  assert.ok(small.width < big.width * 0.75, "and much less than proportionally wide")
  assert.ok(tiny.rows >= small.rows)
  assert.ok(tiny.width < small.width)
})

check("sizes land on whole device pixels, not whole logical ones", () => {
  // QT_SCALE_FACTOR is a supported setting and this was found at 0.85, where a
  // 4-logical-pixel cell is 3.4 device pixels: the renderer resolves some cells
  // at three pixels and some at four, and a grid of identical cells shows up as
  // a grid of visibly different ones.
  const containers = parsePs(psFixture)

  for (const dpr of [1, 0.85, 1.25, 1.5, 2]) {
    const plan = planMosaic(containers, {
      groupBy: "container", groupStacks: true,
      heightPx: 18, gapPx: 2, blockGapPx: 3, cellSizePx: 4, maxWidthPx: 0,
      devicePixelRatio: dpr
    })

    const device = value => value * dpr
    const isWhole = value => Math.abs(value - Math.round(value)) < 1e-6

    assert.ok(isWhole(device(plan.cellPx)), "dpr " + dpr + " cell " + plan.cellPx)
    assert.ok(isWhole(device(plan.gapPx)), "dpr " + dpr + " gap")
    assert.ok(isWhole(device(plan.blockGapPx)), "dpr " + dpr + " block gap")

    // The pitch matters most: whole-pixel pitch is what makes every cell share
    // the same sub-pixel phase and rasterise identically, wherever the bar puts
    // the widget.
    assert.ok(isWhole(device(plan.cellPx + plan.gapPx)), "dpr " + dpr + " pitch")
  }
})

check("device rounding never overflows the bar", () => {
  // Rounding up to the device grid can ask for more height than there is.
  for (const dpr of [0.85, 1, 1.25, 1.5]) {
    for (const height of [6, 8, 10, 14, 18, 26]) {
      const plan = planMosaic(parsePs(psFixture), {
        groupBy: "container", groupStacks: true,
        heightPx: height, gapPx: 2, blockGapPx: 3, cellSizePx: 4, maxWidthPx: 0,
        devicePixelRatio: dpr
      })
      assert.ok(plan.height <= height + 1e-6,
        "dpr " + dpr + " height " + height + " used " + plan.height)
      assert.ok(plan.cellPx >= 1)
    }
  }
})

check("a scale factor of one changes nothing", () => {
  assert.strictEqual(snapToDevice(4, 1), 4)
  assert.strictEqual(snapToDevice(4.4, 1), 4)
  assert.strictEqual(snapToDevice(0.2, 1), 1, "never disappears")
  assert.strictEqual(floorToDevice(4.9, 1), 4, "cells round down, never up")

  // Never larger than what was asked for, and always a whole device pixel.
  for (const dpr of [0.85, 1.25, 1.5]) {
    for (const px of [3, 4, 8, 10.4]) {
      const snapped = floorToDevice(px, dpr)
      assert.ok(snapped <= px + 1e-9, dpr + " " + px + " -> " + snapped)
      assert.ok(Math.abs(snapped * dpr - Math.round(snapped * dpr)) < 1e-6)
    }
  }
})

check("row count follows the bar height", () => {
  assert.strictEqual(rowsForHeight(16, 1, 4), 3)
  assert.strictEqual(rowsForHeight(16, 1, 7), 2)
  assert.strictEqual(rowsForHeight(10, 1, 4), 2)
  assert.strictEqual(rowsForHeight(8, 1, 4), 1, "a short bar gets a single row")
  assert.strictEqual(rowsForHeight(0, 1, 4), 1, "no height yet still lays out")
})

check("a short bar collapses to stacks instead of eating the bar", () => {
  // On a bar too short for more than one row, one cell per container would run
  // to hundreds of pixels. The width budget catches that on its own.
  const containers = parsePs(psFixture)
  const short = planMosaic(containers, {
    groupBy: "auto", groupStacks: true,
    heightPx: 8, gapPx: 2, blockGapPx: 3, cellSizePx: 4, maxWidthPx: 60
  })

  assert.strictEqual(short.rows, 1, "only one row fits")
  assert.strictEqual(short.mode, "stack")
  assert.ok(short.width <= 60)
})

check("the width budget is what decides the mode, not a cell count", () => {
  const containers = parsePs(psFixture)
  const at = budget => planMosaic(containers, {
    groupBy: "auto", groupStacks: true,
    heightPx: 8, gapPx: 2, blockGapPx: 3, cellSizePx: 4, maxWidthPx: budget
  })

  assert.strictEqual(at(400).mode, "container", "room to spare")
  assert.strictEqual(at(60).mode, "stack", "not enough for one cell per container")
  assert.strictEqual(at(10).mode, "single", "not enough even for one cell per stack")

  for (const budget of [400, 60]) {
    assert.ok(at(budget).width <= budget, "stays inside " + budget)
  }
})

check("an explicit groupBy overrides the budget", () => {
  const containers = parsePs(psFixture)
  const forced = planMosaic(containers, {
    groupBy: "container", groupStacks: true,
    heightPx: 16, gapPx: 1, blockGapPx: 3, cellSizePx: 4, maxWidthPx: 10
  })
  assert.strictEqual(forced.mode, "container")
})

// --------------------------------------------------------- stable order

check("cell order ignores input order", () => {
  const containers = parsePs(psFixture)
  const shuffled = containers.slice().reverse()

  const a = sortContainers(containers).map(c => c.id)
  const b = sortContainers(shuffled).map(c => c.id)
  assert.deepStrictEqual(a, b)
})

check("a stack changing state does not move its cell", () => {
  // The popup sorts degraded stacks to the top because it is a list you read.
  // The mosaic must not: a cell that moves when its stack breaks destroys the
  // only thing the mosaic is for.
  const containers = parsePs(psFixture)
  const before = resolveCells(containers, { groupBy: "stack" }).cells.map(cell => cell.key)

  const mutated = containers.map(container =>
    container.project === "metrics"
      ? Object.assign({}, container, { state: "exited", status: "Exited (1) 1 second ago", cell: "bad" })
      : container)
  const after = resolveCells(mutated, { groupBy: "stack" }).cells.map(cell => cell.key)

  assert.deepStrictEqual(after, before)
})

check("loose containers sit last in the mosaic too, matching the popup", () => {
  const cells = resolveCells(parsePs(psFixture), { groupBy: "stack" }).cells
  assert.strictEqual(cells[cells.length - 1].key, "(avulsos)")
})

check("a container changing state does not move its cell", () => {
  const containers = parsePs(psFixture)
  const before = sortContainers(containers).map(c => c.id)

  const mutated = containers.map(c =>
    Object.assign({}, c, { state: "exited", cell: "bad" }))
  const after = sortContainers(mutated).map(c => c.id)

  assert.deepStrictEqual(after, before)
})

// ------------------------------------------------------------- parsing

check("real ps fixture parses completely", () => {
  const containers = parsePs(psFixture)
  const lines = psFixture.trim().split("\n").length
  assert.strictEqual(containers.length, lines)
  for (const container of containers) {
    assert.ok(container.id, "every container has an id")
    assert.ok(container.name, "every container has a name")
  }
})

check("running containers are ok, unhealthy ones are warn", () => {
  assert.strictEqual(classify({ State: "running", HealthStatus: "none" }), "ok")
  assert.strictEqual(classify({ State: "running", HealthStatus: "healthy" }), "ok")
  assert.strictEqual(classify({ State: "running", HealthStatus: "unhealthy" }), "warn")
  assert.strictEqual(classify({ State: "running", HealthStatus: "starting" }), "ok")
})

check("restarting and paused are warn, dead is bad", () => {
  assert.strictEqual(classify({ State: "restarting", Status: "Restarting (1) 39 seconds ago" }), "warn")
  assert.strictEqual(classify({ State: "paused" }), "warn")
  assert.strictEqual(classify({ State: "dead" }), "bad")
})

check("exit code decides whether a stopped container is a failure", () => {
  assert.strictEqual(classify({ State: "exited", Status: "Exited (0) 5 weeks ago" }), "idle")
  assert.strictEqual(classify({ State: "exited", Status: "Exited (1) 2 months ago" }), "bad")
  assert.strictEqual(classify({ State: "exited", Status: "Exited (127) 6 days ago" }), "bad")
  assert.strictEqual(classify({ State: "exited", Status: "Exited (143) 5 weeks ago" }), "bad")
  assert.strictEqual(classify({ State: "exited", Status: "Exited (255) 3 weeks ago" }), "bad")
})

check("stale health on an exited container is ignored", () => {
  // Docker keeps the last health value after the container stops; a clean exit
  // must not be painted as a failure because of it.
  assert.strictEqual(
    classify({ State: "exited", HealthStatus: "unhealthy", Status: "Exited (0) 5 weeks ago" }),
    "idle")
})

check("created containers are idle", () => {
  assert.strictEqual(classify({ State: "created" }), "idle")
})

check("compose labels drive grouping, not names", () => {
  const containers = parsePs(psFixture)
  const byName = {}
  for (const container of containers) byName[container.name] = container

  // The service is the compose service, not the container name.
  assert.strictEqual(byName["web-shop-cache-1"].project, "web-shop")
  assert.strictEqual(byName["web-shop-cache-1"].service, "cache")
  assert.strictEqual(byName["metrics-db-1"].project, "metrics")
  assert.strictEqual(byName["metrics-db-1"].service, "db")

  // And a container started outside compose has no project at all, however
  // structured its name looks.
  assert.strictEqual(byName["scratchpad"].project, "")
  assert.strictEqual(byName["scratchpad"].service, "scratchpad",
    "falling back to the container name")
})

check("containers without compose labels land in the loose group", () => {
  const groups = groupByProject(parsePs(psFixture))
  const loose = groups.find(group => group.loose)
  assert.ok(loose, "loose group exists")
  assert.ok(loose.containers.some(c => c.name === "scratchpad"))
  for (const container of loose.containers) assert.strictEqual(container.project, "")
})

check("labels containing = keep their value intact", () => {
  const labels = parseLabels("a=1,com.docker.compose.project=x,desc=k=v")
  assert.strictEqual(labels["desc"], "k=v")
  assert.strictEqual(labels["com.docker.compose.project"], "x")
})

check("only published ports are listed", () => {
  assert.deepStrictEqual(parsePorts("0.0.0.0:8080->80/tcp"), ["8080"])
  assert.deepStrictEqual(parsePorts("80/tcp, 443/tcp"), [])
  assert.deepStrictEqual(parsePorts(""), [])
  assert.deepStrictEqual(parsePorts("[::]:5432->5432/tcp, 0.0.0.0:5432->5432/tcp"), ["5432"])
})

check("garbage lines are skipped, not fatal", () => {
  const good = psFixture.trim().split("\n")[0]
  const containers = parsePs(good + "\n{not json\n" + good.replace(/"ID":"[a-f0-9]+"/, '"ID":"deadbeef"'))
  assert.strictEqual(containers.length, 2)
})

check("empty output means zero containers, not a crash", () => {
  assert.deepStrictEqual(parsePs(""), [])
  assert.deepStrictEqual(parsePs("\n\n"), [])
})

// ------------------------------------------------------------- rollups

check("worst state wins a rollup", () => {
  const summary = rollup([
    { state: "running", cell: "ok" },
    { state: "running", cell: "warn" },
    { state: "exited", cell: "bad" }
  ])
  assert.strictEqual(summary.worst, "bad")
  assert.strictEqual(summary.running, 2)
  assert.strictEqual(summary.total, 3)
})

check("degraded stacks sort before healthy ones", () => {
  const groups = sortGroups(groupByProject(parsePs(psFixture)))
  const realGroups = groups.filter(group => !group.loose)
  const severities = realGroups.map(group => severity(group.worst))

  for (let i = 1; i < severities.length; i++) {
    assert.ok(severities[i] <= severities[i - 1], "severity never increases down the list")
  }
})

check("loose containers sort last even when degraded", () => {
  const groups = sortGroups(groupByProject(parsePs(psFixture)))
  assert.ok(groups[groups.length - 1].loose, "loose group is last")
  assert.strictEqual(groups[groups.length - 1].worst, "bad", "and it is degraded")
})

// ------------------------------------------------------------- filters

check("hidden projects drop out without breaking the rest", () => {
  const containers = parsePs(psFixture)
  const filtered = applyFilters(containers, { hideProjects: "web-shop" })

  assert.ok(containers.length > filtered.length)
  assert.ok(!filtered.some(c => c.project === "web-shop"))
  assert.ok(filtered.some(c => c.project === "metrics"))
})

check("hideProjects tolerates spacing and empty entries", () => {
  assert.deepStrictEqual(hiddenProjects(" a , ,b "), ["a", "b"])
  assert.deepStrictEqual(hiddenProjects(""), [])
})

check("showStopped false keeps restarting containers visible", () => {
  const containers = parsePs(psFixture)
  const filtered = applyFilters(containers, { showStopped: false })

  assert.ok(!filtered.some(c => c.state === "exited"))
  assert.ok(filtered.some(c => c.state === "restarting"),
    "a restarting container is a problem, not a stopped one")
})

// -------------------------------------------------------- cell resolution

check("a stack cell carries the worst state of its containers", () => {
  const containers = parsePs(psFixture)
  const result = resolveCells(containers, { groupBy: "stack" })
  const groups = sortGroups(groupByProject(containers))

  for (const cell of result.cells) {
    const group = groups.find(candidate => candidate.project === cell.key)
    assert.strictEqual(cell.cell, group.worst, cell.key)
  }
})

check("real stats fixture parses completely", () => {
  const stats = parseStats(statsFixture)
  const lines = statsFixture.trim().split("\n").length
  // Each sample is indexed under both id lengths, so count distinct samples.
  const samples = new Set(Object.keys(stats).map(key => stats[key]))
  assert.strictEqual(samples.size, lines)
})

check("percentages lose their sign", () => {
  assert.strictEqual(parsePercent("0.08%"), 0.08)
  assert.strictEqual(parsePercent("2.50%"), 2.5)
  assert.strictEqual(parsePercent(""), 0)
  assert.strictEqual(parsePercent("--"), 0)
})

check("memory usage splits into used and limit", () => {
  const memory = parseMemUsage("33.53MiB / 31.08GiB")
  assert.strictEqual(Math.round(memory.used), Math.round(33.53 * 1048576))
  assert.strictEqual(Math.round(memory.limit), Math.round(31.08 * 1073741824))
})

check("binary and decimal units are both understood", () => {
  assert.strictEqual(parseBytes("1KiB"), 1024)
  assert.strictEqual(parseBytes("1kB"), 1000)
  assert.strictEqual(parseBytes("1GiB"), 1073741824)
  assert.strictEqual(parseBytes("512B"), 512)
  assert.strictEqual(parseBytes("0B"), 0)
  assert.strictEqual(parseBytes(""), 0)
})

check("mixed units in one run add up correctly", () => {
  const containers = [{ id: "a" }, { id: "b" }, { id: "c" }]
  const stats = {
    a: { cpu: 1, memUsed: parseBytes("1KiB"), memLimit: 100, memPerc: 0, net: { rx: 0, tx: 0 } },
    b: { cpu: 2, memUsed: parseBytes("1MiB"), memLimit: 100, memPerc: 0, net: { rx: 0, tx: 0 } },
    c: { cpu: 3, memUsed: parseBytes("1GiB"), memLimit: 100, memPerc: 0, net: { rx: 0, tx: 0 } }
  }
  const total = aggregateStats(containers, stats)

  assert.strictEqual(total.memUsed, 1024 + 1048576 + 1073741824)
  assert.strictEqual(total.cpu, 6)
  assert.strictEqual(total.samples, 3)
})

check("the host memory limit is taken once, not summed", () => {
  const limit = parseBytes("31.08GiB")
  const containers = [{ id: "a" }, { id: "b" }]
  const stats = {
    a: { cpu: 0, memUsed: 100, memLimit: limit, memPerc: 0, net: { rx: 0, tx: 0 } },
    b: { cpu: 0, memUsed: 100, memLimit: limit, memPerc: 0, net: { rx: 0, tx: 0 } }
  }

  assert.strictEqual(aggregateStats(containers, stats).memLimit, limit)
})

check("containers without a sample are skipped, not counted as zero", () => {
  const total = aggregateStats([{ id: "a" }, { id: "missing" }], {
    a: { cpu: 5, memUsed: 10, memLimit: 100, memPerc: 0, net: { rx: 0, tx: 0 } }
  })
  assert.strictEqual(total.samples, 1)
  assert.strictEqual(total.cpu, 5)
})

check("aggregating the real fixtures produces sane totals", () => {
  const containers = parsePs(psFixture)
  const total = aggregateStats(containers, parseStats(statsFixture))

  assert.ok(total.samples > 0, "running containers reported stats")
  assert.ok(total.cpu >= 0 && total.cpu < 100 * total.samples)
  assert.ok(total.memUsed > 0)
  assert.ok(total.memPerc > 0 && total.memPerc <= 100)
})

// ------------------------------------------------------------- metrics

check("metric list parses and rejects unknown names", () => {
  assert.deepStrictEqual(metricList("cpu,mem"), ["cpu", "mem"])
  assert.deepStrictEqual(metricList("mem, cpu"), ["mem", "cpu"], "order is preserved")
  assert.deepStrictEqual(metricList("cpu,bogus,cpu"), ["cpu"], "unknown and duplicate dropped")
  assert.deepStrictEqual(metricList(""), [], "empty hides the label")
  assert.deepStrictEqual(metricList(undefined), ["cpu", "mem"], "default")
})

check("a missing sample reads as an em dash, never as zero", () => {
  const summary = { running: 19, total: 20 }
  assert.strictEqual(metricLabel("cpu", { samples: 0 }, summary), "—")
  assert.strictEqual(metricLabel("mem", null, summary), "—")
  // count needs no sample: it comes from ps, which is always fresh.
  assert.strictEqual(metricLabel("count", null, summary), "19/20")
})

check("metric labels format the way the bar shows them", () => {
  const summary = { running: 19, total: 20 }
  const aggregate = {
    samples: 3, cpu: 15.04, memUsed: 3.2e9, memLimit: 3.2e10,
    memPerc: 10, net: { rx: 7.24e6, tx: 2.14e6 }
  }

  assert.strictEqual(metricLabel("cpu", aggregate, summary), "15%")
  assert.strictEqual(metricLabel("mem", aggregate, summary), "3.2GB")
  assert.strictEqual(metricLabel("memPerc", aggregate, summary), "10%")
  assert.strictEqual(metricLabel("net", aggregate, summary), "7.2MB↓")
})

check("byte formatting crosses units cleanly", () => {
  assert.strictEqual(formatBytes(0), "0B")
  assert.strictEqual(formatBytes(999), "999B")
  assert.strictEqual(formatBytes(1000), "1KB")
  assert.strictEqual(formatBytes(1500), "1.5KB")
  assert.strictEqual(formatBytes(3.2e9), "3.2GB")
  assert.strictEqual(formatBytes(1.5e12), "1.5TB")
})

check("percent formatting drops decimals once it stops mattering", () => {
  assert.strictEqual(formatPercent(0), "0%")
  assert.strictEqual(formatPercent(15.04), "15%")
  assert.strictEqual(formatPercent(2.55), "2.6%")
  assert.strictEqual(formatPercent(100), "100%")
  assert.strictEqual(formatPercent(240.7), "241%")
})

check("reserved label width covers every configured metric", () => {
  const summary = { running: 19, total: 20 }
  const aggregate = {
    samples: 1, cpu: 999, memUsed: 9.99e11, memLimit: 1e12,
    memPerc: 99.9, net: { rx: 9.99e11, tx: 0 }
  }

  // And the reservation stays tight: a generic wide sample would leave a hole
  // in the bar next to a label that never reaches it.
  assert.strictEqual(metricWidthSample(["cpu"], summary).length, 4)
  assert.strictEqual(metricWidthSample(["cpu", "mem"], summary), "99.9GB")

  for (const metrics of [["cpu", "mem"], ["count"], ["cpu", "mem", "net", "count"]]) {
    const reserved = metricWidthSample(metrics, summary)
    for (const metric of metrics) {
      const rendered = metricLabel(metric, aggregate, summary)
      assert.ok(rendered.length <= reserved.length,
        metric + " (" + rendered + ") fits in " + reserved)
    }
  }
})

// ------------------------------------------------------------ commands

check("containers are always addressed by id", () => {
  assert.deepStrictEqual(containerCommand("restart", "abc123"), ["docker", "restart", "abc123"])
  assert.deepStrictEqual(containerCommand("stop", "abc123"), ["docker", "stop", "abc123"])
})

check("starting a stack is not the mirror of stopping it", () => {
  // `compose start` cannot bring back a removed container and ignores edits to
  // the compose file; `up -d` does both, which is what "start this stack"
  // means. Stopping stays `stop` — `down` would delete the containers.
  const group = {
    project: "web-shop", loose: false,
    workingDir: "/srv/stacks/web-shop",
    configFiles: ["/srv/stacks/web-shop/compose.yml"],
    containers: [{ id: "a" }]
  }

  const start = stackCommand("start", group, true)
  assert.deepStrictEqual(start.slice(-2), ["up", "-d"])
  assert.ok(start.includes("--project-directory"), "compose is told where to look")
  assert.ok(start.includes("'/srv/stacks/web-shop/compose.yml'"))

  assert.deepStrictEqual(stackCommand("stop", group, true).slice(-1), ["stop"])
  assert.deepStrictEqual(stackCommand("restart", group, true).slice(-1), ["restart"])

  for (const action of ["start", "stop", "restart"]) {
    assert.ok(!stackCommand(action, group, true).includes("down"), "never down")
  }
})

check("stack paths reach compose through the launcher's eval intact", () => {
  const group = {
    project: "my stack", loose: false,
    workingDir: "/srv/my stacks/web",
    configFiles: ["/srv/my stacks/web/compose.yml"],
    containers: []
  }
  const command = stackCommand("start", group, true)
  assert.ok(command.includes("'/srv/my stacks/web'"))
  assert.ok(command.includes("'my stack'"))
})

check("stack actions fall back to container ids without compose", () => {
  const loose = { loose: true, containers: [{ id: "a" }, { id: "b" }] }
  assert.deepStrictEqual(stackCommand("start", loose, false), ["docker", "start", "a", "b"])
  assert.deepStrictEqual(stackCommand("stop", loose, false), ["docker", "stop", "a", "b"])
})

// ------------------------------------------------------ per-state actions

check("a container only offers what its state allows", () => {
  const running = containerActions({ state: "running" })
  assert.ok(running.canStop && running.canRestart && running.canShell)
  assert.ok(!running.canStart && !running.canRemove, "cannot remove a running container")

  const exited = containerActions({ state: "exited" })
  assert.ok(exited.canStart && exited.canRemove)
  assert.ok(!exited.canStop && !exited.canShell)

  const restarting = containerActions({ state: "restarting" })
  assert.ok(restarting.canStop, "a restart loop is stoppable")
  assert.ok(!restarting.canRemove)
  assert.ok(!restarting.canShell, "there is nothing to attach to between restarts")
})

check("a paused container counts as running", () => {
  // It is frozen, not gone: removing it would need -f, and a button that
  // quietly forces eventually deletes something someone was using.
  const paused = containerActions({ state: "paused" })
  assert.ok(paused.canUnpause)
  assert.ok(!paused.canRemove, "never offer remove on a paused container")
  assert.ok(!paused.canStart)
  assert.ok(paused.canStop)
})

check("every container in the fixture gets a coherent action set", () => {
  for (const container of parsePs(psFixture)) {
    const actions = containerActions(container)
    assert.ok(!(actions.canStart && actions.canStop), container.name + " is not both")
    assert.ok(!(actions.canRemove && actions.canStop), container.name + " removable while up")
  }
})

check("a published port becomes something you can open", () => {
  assert.strictEqual(portUrl(8080), "http://localhost:8080")
  assert.strictEqual(portUrl("5432"), "http://localhost:5432")
})

check("read commands have the shape the service runs", () => {
  assert.deepStrictEqual(psCommand(), ["docker", "ps", "-a", "--no-trunc", "--format", "{{json .}}"])
  assert.deepStrictEqual(statsCommand(), ["docker", "stats", "--no-stream", "--format", "{{json .}}"])
  assert.deepStrictEqual(eventsCommand(), ["docker", "events", "--format", "{{json .}}"])
  assert.strictEqual(logsCommand("abc", 200), "docker logs -f --tail 200 abc")
})

// -------------------------------------------------------------- events

check("container lifecycle events trigger a refresh", () => {
  for (const action of ["start", "die", "stop", "create", "destroy", "restart", "pause"]) {
    assert.ok(shouldRefresh(JSON.stringify({ Type: "container", Action: action })), action)
  }
})

check("health transitions trigger a refresh", () => {
  assert.ok(shouldRefresh(JSON.stringify({
    Type: "container", Action: "health_status: unhealthy"
  })))
})

check("noise on the event stream is ignored", () => {
  assert.ok(!shouldRefresh(JSON.stringify({ Type: "image", Action: "pull" })))
  assert.ok(!shouldRefresh(JSON.stringify({ Type: "network", Action: "connect" })))
  assert.ok(!shouldRefresh(JSON.stringify({ Type: "container", Action: "exec_start" })))
  assert.ok(!shouldRefresh("{partial"))
  assert.ok(!shouldRefresh(""))
})

check("reconnect backoff doubles and then holds at the cap", () => {
  assert.strictEqual(backoffMs(0, 1000, 30000), 1000)
  assert.strictEqual(backoffMs(1, 1000, 30000), 2000)
  assert.strictEqual(backoffMs(2, 1000, 30000), 4000)
  assert.strictEqual(backoffMs(20, 1000, 30000), 30000, "a container in a restart loop cannot escalate forever")
})


// Appended after the id-length join bug was found by the fixture check above.
check("stats join works across docker's two id lengths", () => {
  // ps --no-trunc reports 64 characters, stats reports 12. Indexing on one
  // alone matches nothing and leaves every metric blank forever.
  const stats = parseStats(statsFixture)
  const containers = parsePs(psFixture)
  const running = containers.filter(c => c.state === "running")

  assert.ok(running.length > 0, "the fixture has running containers")
  for (const container of running) {
    assert.strictEqual(container.id.length, 64, "ps ids are full length")
    assert.ok(lookupStats(stats, container.id), "matched " + container.name)
  }

  // And the short form still resolves, for callers that did not pass --no-trunc.
  assert.ok(lookupStats(stats, running[0].id.slice(0, 12)))
})

// --------------------------------------------------------- lazydocker

check("the global window id cannot match a stack-scoped one", () => {
  // omarchy-launch-or-focus focuses the first window matching /\bPATTERN\b/i
  // against the window class. A generic "org.omarchy.lazydocker" matches every
  // scoped window too, so clicking "all" would focus some stack's window.
  const all = lazydockerAppId("")
  const scoped = lazydockerAppId("web-shop")
  const matches = (pattern, windowClass) =>
    new RegExp("\\b" + pattern + "\\b", "i").test(windowClass)

  assert.ok(matches(all, all), "the global id finds its own window")
  assert.ok(matches(scoped, scoped), "a scoped id finds its own window")
  assert.ok(!matches(all, scoped), "the global id must not grab a stack window")
  assert.ok(!matches(scoped, all), "a stack id must not grab the global window")

  // And no two stacks may collide — including the case that actually bit:
  // one project name being a prefix of another.
  for (const [a, b] of [["web-shop", "web-shop-dev"], ["api", "api2"], ["do", "metrics"]]) {
    const left = lazydockerAppId(a)
    const right = lazydockerAppId(b)
    assert.notStrictEqual(left, right, a + " vs " + b)
    assert.ok(!matches(left, right), left + " must not grab " + right)
    assert.ok(!matches(right, left), right + " must not grab " + left)
  }
})

check("no argument opens lazydocker for the whole daemon", () => {
  assert.deepStrictEqual(lazydockerCommand(null), [
    "omarchy-launch-or-focus-tui",
    "--app-id=org.omarchy.lazydocker.all",
    "lazydocker"
  ])
})

check("a stack is scoped with the project name and its compose files", () => {
  const group = {
    project: "web-shop",
    loose: false,
    configFiles: ["/home/avila/web-shop/docker-compose.yml"]
  }

  assert.deepStrictEqual(lazydockerCommand(group), [
    "omarchy-launch-or-focus-tui",
    "--app-id=org.omarchy.lazydocker.stack_web_shop",
    "lazydocker",
    "-p", "'web-shop'",
    "-f", "'/home/avila/web-shop/docker-compose.yml'"
  ])
})

check("multiple compose files each get their own -f", () => {
  const group = {
    project: "stack",
    loose: false,
    configFiles: ["/a/docker-compose.yml", "/a/override.yml"]
  }
  const command = lazydockerCommand(group)
  const files = command.filter((_, index) => command[index - 1] === "-f")

  assert.strictEqual(files.length, 2)
  assert.deepStrictEqual(files, ["'/a/docker-compose.yml'", "'/a/override.yml'"])
})

check("paths with spaces survive the eval in launch-or-focus", () => {
  // omarchy-launch-or-focus-tui joins its arguments into one string and runs it
  // through `eval`; an unquoted path with a space would split in half there.
  const group = {
    project: "my stack",
    loose: false,
    configFiles: ["/home/avila/my project/docker-compose.yml"]
  }
  const command = lazydockerCommand(group)

  assert.ok(command.includes("'/home/avila/my project/docker-compose.yml'"))
  assert.ok(command.includes("'my stack'"))
})

check("quoting is not fooled by a single quote in a path", () => {
  assert.strictEqual(shellQuote("it's"), "'it'\\''s'")
})

check("loose containers cannot be scoped and fall back to the whole daemon", () => {
  const groups = sortGroups(groupByProject(parsePs(psFixture)))
  const loose = groups.find(group => group.loose)

  assert.ok(loose, "the fixture has containers outside compose")
  assert.strictEqual(canScopeLazydocker(loose), false)
  assert.deepStrictEqual(lazydockerCommand(loose), lazydockerCommand(null))
})

check("every compose stack in the fixture can be scoped", () => {
  const groups = sortGroups(groupByProject(parsePs(psFixture)))

  for (const group of groups) {
    if (group.loose) continue
    assert.ok(canScopeLazydocker(group), group.project)
    assert.ok(group.configFiles.length > 0, group.project + " knows its compose file")
    assert.ok(group.workingDir, group.project + " knows its working dir")
  }
})

check("app ids stay valid for awkward project names", () => {
  assert.strictEqual(lazydockerAppId("Foo Bar"), "org.omarchy.lazydocker.stack_foo_bar")
  assert.strictEqual(lazydockerAppId("a.b/c"), "org.omarchy.lazydocker.stack_a_b_c")
  assert.strictEqual(lazydockerAppId("já"), "org.omarchy.lazydocker.stack_j_")
})

check("container views lazydocker cannot give get their own windows", () => {
  const container = { id: "abc123def456789", name: "web-shop-cache-1" }

  const logs = containerTuiCommand("logs", container, 200)
  assert.deepStrictEqual(logs, [
    "omarchy-launch-or-focus-tui",
    "--app-id=org.omarchy.docker.logs_web_shop_cache_1",
    "docker", "logs", "-f", "--tail", "200", "abc123def456789"
  ])

  const shell = containerTuiCommand("shell", container, 0)
  assert.strictEqual(shell[1], "--app-id=org.omarchy.docker.shell_web_shop_cache_1")
  assert.ok(shell.includes("-it"))

  // `exec bash || exec sh` is wrong and silently fatal: when exec fails in a
  // non-interactive shell the shell exits, so the fallback never runs and the
  // terminal dies the moment it opens. Probe, then exec.
  const script = shell[shell.length - 1]
  assert.ok(script.indexOf("command -v bash") > 0, "probes before exec")
  assert.ok(script.indexOf("exec bash ||") < 0, "never chains off a failed exec")
  assert.ok(script.indexOf("else exec sh") > 0, "still falls back")
})

check("logs and shell windows for the same container stay distinct", () => {
  const container = { id: "abc", name: "api" }
  const logs = containerTuiCommand("logs", container, 200)[1]
  const shell = containerTuiCommand("shell", container, 200)[1]

  assert.notStrictEqual(logs, shell)
})


// --------------------------------------------------------- disk cleanup

const DF_FIXTURE = [
  '{"Active":"23","Reclaimable":"4.2GB (7%)","Size":"53.91GB","TotalCount":"32","Type":"Images"}',
  '{"Active":"2","Reclaimable":"530.6MB (99%)","Size":"531.8MB","TotalCount":"25","Type":"Containers"}',
  '{"Active":"14","Reclaimable":"323.1MB (14%)","Size":"2.256GB","TotalCount":"22","Type":"Local Volumes"}',
  '{"Active":"0","Reclaimable":"221.2GB","Size":"250.2GB","TotalCount":"598","Type":"Build Cache"}'
].join("\n")

check("system df parses with and without a percentage", () => {
  const rows = parseSystemDf(DF_FIXTURE)
  assert.strictEqual(rows.length, 4)

  const images = dfRow(rows, "Images")
  assert.strictEqual(images.total, 32)
  assert.strictEqual(images.active, 23)
  assert.ok(Math.abs(images.reclaimable - 4.2e9) < 1e6, "4.2GB (7%) drops the percentage")

  const cache = dfRow(rows, "Build Cache")
  assert.ok(Math.abs(cache.reclaimable - 221.2e9) < 1e8, "bare 221.2GB parses too")
})

check("malformed df lines are skipped, not fatal", () => {
  assert.deepStrictEqual(parseSystemDf(""), [])
  assert.strictEqual(parseSystemDf(DF_FIXTURE + "\n{broken").length, 4)
})

check("unused images map to prune -a, dangling to plain prune", () => {
  // df's Reclaimable for Images counts every image no container uses, which is
  // what `image prune -a` removes. Plain `image prune` only takes dangling
  // layers and frees far less. Showing one number and running the other command
  // makes the widget a liar, so they are separate entries.
  const targets = pruneTargets(parseSystemDf(DF_FIXTURE))
  const byId = {}
  for (const target of targets) byId[target.id] = target

  assert.deepStrictEqual(byId.unusedImages.command, ["docker", "image", "prune", "-a", "-f"])
  assert.ok(byId.unusedImages.known, "and it is the one that carries the df number")

  assert.deepStrictEqual(byId.danglingImages.command, ["docker", "image", "prune", "-f"])
  assert.strictEqual(byId.danglingImages.known, false)
  assert.strictEqual(byId.danglingImages.reclaimable, -1,
    "unknown, not zero — 0B would read as nothing to do")
})

check("volumes are never in the prune list", () => {
  // Everything offered can be rebuilt or pulled again. A volume is the one
  // thing that is somebody's data.
  const targets = pruneTargets(parseSystemDf(DF_FIXTURE))
  for (const target of targets) {
    assert.ok(!/volume/i.test(target.label), target.label)
    assert.ok(!target.command.includes("volume"), target.command.join(" "))
  }
  assert.ok(VOLUMES_ARE_NOT_PRUNED.length > 0, "and the panel says why")
})

check("every prune command is non-interactive and scoped", () => {
  for (const target of pruneTargets(parseSystemDf(DF_FIXTURE))) {
    assert.strictEqual(target.command[0], "docker")
    assert.ok(target.command.includes("-f"), target.id + " must not stop to ask")
    assert.ok(!target.command.includes("system"), target.id + " never `system prune`")
  }
})

check("the total counts only what a button can actually reclaim", () => {
  const rows = parseSystemDf(DF_FIXTURE)
  const total = totalReclaimable(rows)
  const volumes = dfRow(rows, "Local Volumes").reclaimable

  assert.ok(total > 200e9, "the build cache dominates")
  assert.ok(Math.abs(total - (221.2e9 + 4.2e9 + 530.6e6)) < 1e8)
  assert.ok(total < 226e9 + volumes, "volumes are not promised")
})

check("the confirmation names the thing and the size", () => {
  const target = pruneTargets(parseSystemDf(DF_FIXTURE)).find(t => t.id === "buildCache")
  const message = pruneConfirmMessage(target)

  assert.ok(message.indexOf("build cache") > 0)
  assert.ok(message.indexOf("221GB") > 0, "the number is the reason to click")

  const unknown = pruneConfirmMessage({ label: "dangling images", reclaimable: -1, detail: "x" })
  assert.ok(unknown.indexOf("(") < 0, "no size invented when it is not known")
})

// -------------------------------------------------------- state changes

function containersWith(overrides) {
  return parsePs(psFixture).map(container =>
    overrides[container.name]
      ? Object.assign({}, container, overrides[container.name])
      : container)
}

check("nothing changing produces no noise", () => {
  const containers = parsePs(psFixture)
  assert.deepStrictEqual(stateChanges(containers, containers), [])
})

check("a container going bad is worth interrupting for", () => {
  const before = containersWith({ "web-shop-cache-1": { state: "running", cell: "ok" } })
  const after = containersWith({
    "web-shop-cache-1": { state: "running", health: "unhealthy", cell: "warn" }
  })

  const changes = stateChanges(before, after)
  assert.strictEqual(changes.length, 1)
  assert.strictEqual(changes[0].kind, "unhealthy")
  assert.strictEqual(changeNotification(changes[0]).urgency, "critical")
})

check("a restart loop reports as a loop, not as a failure", () => {
  const before = containersWith({ "web-shop-proxy-1": { state: "running", cell: "ok" } })
  const after = containersWith({ "web-shop-proxy-1": { state: "restarting", cell: "warn" } })

  assert.strictEqual(stateChanges(before, after)[0].kind, "restarting")
})

check("recovery is announced once, and quietly", () => {
  const before = containersWith({ "web-shop-cache-1": { state: "exited", cell: "bad" } })
  const after = containersWith({ "web-shop-cache-1": { state: "running", cell: "ok" } })

  const change = stateChanges(before, after)[0]
  assert.strictEqual(change.kind, "recovered")
  assert.strictEqual(changeNotification(change).urgency, "low")

  // And not again on the next round, because nothing changed.
  assert.deepStrictEqual(stateChanges(after, after), [])
})

check("a container someone just started is not a recovery", () => {
  // It was stopped cleanly, so there was nothing to recover from.
  const before = containersWith({ "web-shop-migrate-1": { state: "exited", cell: "idle" } })
  const after = containersWith({ "web-shop-migrate-1": { state: "running", cell: "ok" } })

  assert.deepStrictEqual(stateChanges(before, after), [])
})

check("containers that appear are not news", () => {
  const before = parsePs(psFixture).slice(1)
  const after = parsePs(psFixture)
  assert.deepStrictEqual(stateChanges(before, after), [])
})

check("notifications carry the container name and reach the user", () => {
  const change = { container: { name: "web-shop-api-1" }, kind: "unhealthy" }
  const notification = changeNotification(change)
  const command = notifyCommand(notification)

  assert.strictEqual(command[0], "notify-send")
  assert.ok(command.includes("web-shop-api-1"))
  assert.ok(command.includes("critical"))
})


// --------------------------------------------------------------- engine

check("the engine prefixes every command", () => {
  try {
    setEngine("podman")
    assert.strictEqual(engine(), "podman")
    assert.strictEqual(engineLabel(), "Podman")
    assert.strictEqual(psCommand()[0], "podman")
    assert.strictEqual(statsCommand()[0], "podman")
    assert.strictEqual(imagesCommand()[0], "podman")
    assert.strictEqual(containerCommand("restart", "abc")[0], "podman")
    assert.deepStrictEqual(daemonCommand("start"), ["systemctl", "start", "podman.service"])
    assert.strictEqual(pruneTargets([])[0].command[0], "podman")
  } finally {
    setEngine("docker")
  }
  assert.strictEqual(psCommand()[0], "docker")
})

check("anything that is not podman is docker", () => {
  assert.strictEqual(setEngine("nonsense"), "docker")
  assert.strictEqual(setEngine(""), "docker")
})

check("both output shapes parse: one object per line, or one array", () => {
  // Docker prints JSON lines; Podman prints a JSON array.
  const lines = '{"a":1}\n{"a":2}'
  const array = '[{"a":1},{"a":2}]'

  assert.deepStrictEqual(parseRows(lines), [{ a: 1 }, { a: 2 }])
  assert.deepStrictEqual(parseRows(array), [{ a: 1 }, { a: 2 }])
  assert.deepStrictEqual(parseRows(""), [])
  assert.deepStrictEqual(parseRows("[not json"), [])
  assert.deepStrictEqual(parseRows('{"a":1}\n{broken\n{"a":2}'), [{ a: 1 }, { a: 2 }],
    "a broken line drops itself, not the batch")
})

// --------------------------------------------------------------- search

check("search matches the four things someone might remember", () => {
  const containers = parsePs(psFixture)
  const byName = name => searchContainers(containers, { query: name })

  assert.ok(byName("cache").length >= 1, "the service")
  assert.ok(byName("web-shop").length >= 1, "the stack")
  assert.ok(byName("scratchpad").length === 1, "the container name")
  assert.ok(byName("redis").length >= 1, "the image")
  assert.strictEqual(byName("nothing-like-this").length, 0)
})

check("search ignores case and surrounding space", () => {
  const containers = parsePs(psFixture)
  assert.deepStrictEqual(
    searchContainers(containers, { query: "  CACHE " }).map(c => c.id),
    searchContainers(containers, { query: "cache" }).map(c => c.id))
})

check("an empty query hides nothing", () => {
  const containers = parsePs(psFixture)
  assert.strictEqual(searchContainers(containers, { query: "" }).length, containers.length)
  assert.strictEqual(searchContainers(containers, {}).length, containers.length)
})

check("the view chips split running from stopped, with nothing lost", () => {
  const containers = parsePs(psFixture)
  const running = searchContainers(containers, { view: "running" })
  const stopped = searchContainers(containers, { view: "stopped" })

  assert.strictEqual(running.length + stopped.length, containers.length,
    "every container is in exactly one of the two")
  assert.ok(running.every(c => c.state === "running" || c.state === "restarting"))
  assert.ok(stopped.every(c => c.state !== "running" && c.state !== "restarting"))
})

check("a restarting container counts as running, not stopped", () => {
  // It is trying. Filing it under "stopped" hides the thing most worth seeing.
  const containers = parsePs(psFixture)
  const restarting = containers.find(c => c.state === "restarting")

  assert.ok(restarting, "the fixture has one")
  assert.ok(searchContainers([restarting], { view: "running" }).length === 1)
  assert.ok(searchContainers([restarting], { view: "stopped" }).length === 0)
})

check("chip and query compose", () => {
  const containers = parsePs(psFixture)
  const both = searchContainers(containers, { view: "stopped", query: "web-shop" })

  assert.ok(both.length > 0)
  assert.ok(both.every(c => c.state !== "running" && c.project === "web-shop"))
})

// -------------------------------------------------------- port conflicts

check("a stopped container is told who is holding its port", () => {
  // The engine's own error at that moment names the port and not the culprit,
  // which is exactly the half you need.
  const containers = [
    { id: "up", name: "proxy", state: "running", ports: ["8080"] },
    { id: "down", name: "old-proxy", state: "exited", ports: ["8080", "9000"] }
  ]

  const conflicts = portConflicts(containers)
  assert.ok(conflicts.down, "the stopped one is flagged")
  assert.deepStrictEqual(conflicts.down, [{ port: "8080", heldBy: "proxy" }])
  assert.strictEqual(conflicts.up, undefined, "a running container is not in conflict with itself")
  assert.ok(conflictText(conflicts.down).indexOf("proxy") > 0)
})

check("free ports raise no conflict", () => {
  const containers = [
    { id: "up", name: "proxy", state: "running", ports: ["8080"] },
    { id: "down", name: "worker", state: "exited", ports: ["9000"] }
  ]
  assert.deepStrictEqual(portConflicts(containers), {})
  assert.strictEqual(conflictText([]), "")
})

check("a restarting container still counts as holding its port", () => {
  const containers = [
    { id: "loop", name: "flaky", state: "restarting", ports: ["5432"] },
    { id: "down", name: "db", state: "exited", ports: ["5432"] }
  ]
  assert.deepStrictEqual(portConflicts(containers).down, [{ port: "5432", heldBy: "flaky" }])
})

// ------------------------------------------------------------ resources

const IMAGES_FIXTURE = [
  '{"Containers":"1","CreatedSince":"2 days ago","ID":"9f0352b92205","Repository":"web-shop-api","Size":"764MB","Tag":"latest"}',
  '{"Containers":"0","CreatedSince":"4 days ago","ID":"e5da6bcfd583","Repository":"<none>","Size":"2.78GB","Tag":"<none>"}'
].join("\n")

const VOLUMES_FIXTURE = [
  '{"Driver":"local","Labels":"com.docker.volume.anonymous=","Name":"1b6e6559aea5","Size":"N/A"}',
  '{"Driver":"local","Labels":"com.docker.compose.project=web-shop","Name":"web-shop_db","Size":"N/A"}'
].join("\n")

const NETWORKS_FIXTURE = [
  '{"Driver":"bridge","ID":"fa2d23130033","Labels":"com.docker.compose.project=web-shop","Name":"web-shop_default"}',
  '{"Driver":"bridge","ID":"583fcd34ec9e","Labels":"","Name":"bridge"}',
  '{"Driver":"host","ID":"aaaa","Labels":"","Name":"host"}'
].join("\n")

check("images carry their tag, size and whether anything uses them", () => {
  const images = parseImages(IMAGES_FIXTURE)
  assert.strictEqual(images[0].name, "web-shop-api:latest")
  assert.ok(Math.abs(images[0].size - 764e6) < 1e6)
  assert.strictEqual(images[0].inUse, true)

  assert.strictEqual(images[1].name, "<none>", "an untagged image is not called <none>:<none>")
  assert.strictEqual(images[1].inUse, false)
})

check("anonymous volumes are grouped by the stack that made them", () => {
  // 64 hex characters of nothing; the project label is the only way to tell
  // one from another.
  const volumes = parseVolumes(VOLUMES_FIXTURE)
  assert.strictEqual(volumes[0].anonymous, true)
  assert.strictEqual(volumes[0].group, "(loose)")
  assert.strictEqual(volumes[1].group, "web-shop")
  assert.strictEqual(volumes[1].anonymous, false)
})

check("the engine's own networks are listed and never removable", () => {
  const networks = parseNetworks(NETWORKS_FIXTURE)
  const byName = {}
  for (const network of networks) byName[network.name] = network

  assert.strictEqual(byName["web-shop_default"].protected, false)
  assert.ok(canRemoveResource(byName["web-shop_default"]))

  for (const name of ["bridge", "host"]) {
    assert.strictEqual(byName[name].protected, true, name)
    assert.strictEqual(canRemoveResource(byName[name]), false, name)
  }
})

check("each resource kind knows how it is removed", () => {
  assert.deepStrictEqual(
    resourceRemoveCommand({ kind: "image", id: "abc" }), ["docker", "rmi", "abc"])
  assert.deepStrictEqual(
    resourceRemoveCommand({ kind: "volume", name: "data" }), ["docker", "volume", "rm", "data"])
  assert.deepStrictEqual(
    resourceRemoveCommand({ kind: "network", id: "net" }), ["docker", "network", "rm", "net"])
  assert.deepStrictEqual(resourceRemoveCommand({ kind: "mystery" }), [])
})

check("no removal ever forces", () => {
  // If the engine refuses because something is still using it, that refusal is
  // information, not an obstacle.
  for (const kind of ["image", "volume", "network"]) {
    const command = resourceRemoveCommand({ kind: kind, id: "x", name: "x" })
    assert.ok(!command.includes("-f"), kind)
    assert.ok(!command.includes("--force"), kind)
  }
})

check("bulk removal asks once, with the count and the size", () => {
  // A dialog that appears eleven times is a dialog nobody reads.
  const one = resourceConfirmMessage([{ kind: "image", name: "api:latest", size: 1e9 }])
  assert.ok(one.indexOf("api:latest") > 0)

  const many = resourceConfirmMessage([
    { kind: "image", name: "a", size: 1e9 },
    { kind: "image", name: "b", size: 2e9 }
  ])
  assert.ok(many.indexOf("2 items") > 0)
  assert.ok(many.indexOf("3GB") > 0)
})

// --------------------------------------------------------------- gauges

check("every gauge shows its denominator", () => {
  // A percentage with no denominator is a number nobody can act on.
  const aggregate = { samples: 3, cpu: 15, memUsed: 3.2e9, memLimit: 31e9 }
  const df = parseSystemDf(DF_FIXTURE)
  const g = gauges(aggregate, df, { used: 300e9, total: 510e9 })

  assert.strictEqual(g.cpu.text, "15%")
  assert.strictEqual(g.memory.text, "3.2GB/31GB")
  assert.ok(g.disk.text.indexOf("/510GB") > 0, "the engine against the filesystem")
})

check("the disk gauge measures the engine against the disk, not against itself", () => {
  const df = parseSystemDf(DF_FIXTURE)
  const g = gauges({ samples: 1, cpu: 0, memUsed: 0, memLimit: 1 }, df, { used: 0, total: 510e9 })

  assert.ok(g.disk.value > 0)
  assert.strictEqual(g.disk.max, 510e9)
  assert.ok(g.disk.value < g.disk.max, "otherwise it would always read as full")
})

check("gauges with no sample say so instead of showing zero", () => {
  const g = gauges({ samples: 0, cpu: 0, memUsed: 0, memLimit: 0 }, [], { used: 0, total: 0 })
  assert.strictEqual(g.cpu.text, "—")
  assert.strictEqual(g.memory.text, "—")
  assert.strictEqual(g.disk.text, "—")
})

check("host disk parses the df output it asks for", () => {
  const out = "     USED      SIZE\n307793186816 509943480320\n"
  assert.deepStrictEqual(parseHostDisk(out), { used: 307793186816, total: 509943480320 })
  assert.deepStrictEqual(parseHostDisk(""), { used: 0, total: 0 })
  assert.deepStrictEqual(hostDiskCommand(), ["df", "-B1", "--output=used,size", "/"])
})

// -------------------------------------------------------- daemon control

check("the daemon is driven as the user, never as root", () => {
  // systemctl authenticates through the ordinary polkit prompt. No sudo, no
  // pkexec, nothing setuid.
  for (const action of ["start", "stop", "enable", "disable"]) {
    const command = daemonCommand(action)
    assert.strictEqual(command[0], "systemctl", action)
    assert.ok(!command.includes("sudo") && !command.includes("pkexec"), action)
  }
  assert.deepStrictEqual(daemonCommand("nonsense"), [])
})

check("stopping the daemon takes the socket with it", () => {
  // Leaving docker.socket up means the next command silently starts it again.
  assert.ok(daemonCommand("stop").includes("docker.socket"))
  assert.ok(!daemonCommand("start").includes("docker.socket"))
})


// ------------------------------------------------------------ selection

check("selection is rebuilt, never mutated", () => {
  // QML re-evaluates a binding when the object identity changes; a mutated map
  // updates nothing on screen.
  const before = {}
  const after = toggleSelection(before, "a")

  assert.notStrictEqual(before, after)
  assert.deepStrictEqual(before, {}, "the original is untouched")
  assert.deepStrictEqual(after, { a: true })
  assert.deepStrictEqual(toggleSelection(after, "a"), {}, "and it toggles back")
})

check("a group is checked only when every row is", () => {
  // Half-checked is a lie people click twice.
  const items = [{ id: "a" }, { id: "b" }]
  assert.strictEqual(groupChecked(items, { a: true }), false)
  assert.strictEqual(groupChecked(items, { a: true, b: true }), true)
  assert.strictEqual(groupChecked([], { a: true }), false, "an empty group is not checked")
})

check("selecting a whole group is one call, and so is clearing it", () => {
  const ids = ["a", "b", "c"]
  const all = setSelection({}, ids, true)
  assert.strictEqual(selectionCount(all), 3)
  assert.deepStrictEqual(setSelection(all, ids, false), {})
})

check("rows filtered away drop out of the selection", () => {
  // Acting on rows that are no longer on screen is how a bulk action becomes a
  // surprise.
  const selection = { a: true, gone: true }
  const onScreen = [{ id: "a" }, { id: "b" }]

  assert.deepStrictEqual(pruneSelection(selection, onScreen), { a: true })
  assert.deepStrictEqual(pruneSelection({}, onScreen), {})
})

check("the selection resolves back to the objects it names", () => {
  const items = [{ id: "a", name: "one" }, { id: "b", name: "two" }]
  assert.deepStrictEqual(selectedFrom(items, { b: true }), [{ id: "b", name: "two" }])
  assert.deepStrictEqual(selectedFrom(items, {}), [])
})

// ---------------------------------------------------- grouped resources

check("resources group the same way containers do", () => {
  const images = parseImages(IMAGES_FIXTURE)
  const groups = groupResources(images)

  assert.ok(groups.length >= 1)
  for (const group of groups) {
    assert.ok(group.items.length > 0)
    assert.strictEqual(group.size, group.items.reduce((sum, i) => sum + i.size, 0))
  }
})

check("loose resources sort last, matching the container list", () => {
  const groups = groupResources([
    { id: "1", name: "z", group: "(loose)", size: 0 },
    { id: "2", name: "a", group: "web-shop", size: 0 }
  ])
  assert.strictEqual(groups[0].project, "web-shop")
  assert.ok(groups[groups.length - 1].loose)
})

check("resource search covers the name, the group and the detail", () => {
  const items = [
    { id: "1", name: "web-shop-api:latest", group: "web-shop-api", detail: "2 days ago" },
    { id: "2", name: "redis:7-alpine", group: "redis", detail: "3 weeks ago" }
  ]
  assert.strictEqual(searchResources(items, "redis").length, 1)
  assert.strictEqual(searchResources(items, "WEEKS").length, 1)
  assert.strictEqual(searchResources(items, "").length, 2)
  assert.strictEqual(searchResources(items, "nope").length, 0)
})

console.log(passed + " checks passed")
