// Compares groups of `bench/run.mjs` summaries, one group per side, several runs per group.
// Each cell shows the median of the runs' medians with its range, and the change against the
// first group. A change is called noise when the two ranges overlap.
//
//   node bench/compare.mjs on=on-1.json,on-2.json,on-3.json off=off-1.json,off-2.json,off-3.json
import { readFileSync } from "node:fs";

const groups = process.argv.slice(2).map((argument) => {
  const [label, files] = argument.split("=");
  if (!label || !files) {
    throw new Error(`Expected label=file[,file...]; received ${argument}.`);
  }
  return { label, runs: files.split(",").map((file) => JSON.parse(readFileSync(file, "utf8"))) };
});
if (groups.length === 0) {
  throw new Error("Pass at least one label=file[,file...] group.");
}

const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const cellKey = ({ op, variant, actor }) => `${op}|${variant}|${actor}`;

const summarize = ({ label, runs }) => {
  const cells = new Map();
  for (const run of runs) {
    for (const row of run.results) {
      const cell = cells.get(cellKey(row)) ?? { medians: [], p95s: [], queries: new Set() };
      cell.medians.push(row.medianMs);
      cell.p95s.push(row.p95Ms);
      cell.queries.add(`${row.sql}/${row.pluginSql}`);
      cells.set(cellKey(row), cell);
    }
  }
  const [{ meta, dataset }] = runs;
  return { label, cells, meta, dataset, count: runs.length };
};

const summaries = groups.map(summarize);
const [base, ...others] = summaries;

for (const { label, meta, dataset, count } of summaries) {
  console.log(
    `${label}: ${count} runs, commit ${meta.commit.slice(0, 7)}${meta.srcDirty ? "+dirty" : ""}, dist ${meta.distSha256}, enforcement ${meta.enforcement}, Node ${meta.node}, dataset ${JSON.stringify(dataset)}`,
  );
}

const fixed = (value) => value.toFixed(3);
const describe = (cell) =>
  cell
    ? `${fixed(median(cell.medians))} [${fixed(Math.min(...cell.medians))}-${fixed(Math.max(...cell.medians))}] p95 ${fixed(median(cell.p95s))} sql ${[...cell.queries].join(" or ")}`
    : "-";

const change = (from, to) => {
  if (!from || !to) {
    return "";
  }
  const delta = median(to.medians) - median(from.medians);
  const overlap =
    Math.min(...to.medians) <= Math.max(...from.medians) &&
    Math.min(...from.medians) <= Math.max(...to.medians);
  const percent = (delta / median(from.medians)) * 100;
  return `${delta >= 0 ? "+" : ""}${fixed(delta)} ms (${percent >= 0 ? "+" : ""}${percent.toFixed(0)}%)${overlap ? " noise" : ""}`;
};

console.log("\nmedian ms [range of run medians], p95, sql total/from plugin\n");
for (const [key, cell] of base.cells) {
  console.log(key.replaceAll("|", "  "));
  console.log(`  ${base.label.padEnd(10)} ${describe(cell)}`);
  for (const other of others) {
    const theirs = other.cells.get(key);
    console.log(`  ${other.label.padEnd(10)} ${describe(theirs)}  ${change(cell, theirs)}`);
  }
}
