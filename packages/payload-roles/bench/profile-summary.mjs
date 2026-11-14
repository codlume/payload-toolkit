// Summarizes a `.cpuprofile` written by `bench/run.mjs --cpu-profile`: self time by package, then
// the hottest functions.
//
//   node bench/profile-summary.mjs <file.cpuprofile> [top=25]
import { readFileSync } from "node:fs";

const [file, top = "25"] = process.argv.slice(2);
if (!file) {
  throw new Error("Pass the .cpuprofile file to summarize.");
}
const { nodes, samples, timeDeltas } = JSON.parse(readFileSync(file, "utf8"));

const selfMicros = new Map();
samples.forEach((id, index) => {
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + (timeDeltas[index] ?? 0));
});

const bucketOf = ({ functionName, url }) => {
  if (functionName === "(idle)" || functionName === "(program)") {
    return functionName;
  }
  if (functionName === "(garbage collector)") {
    return "(gc)";
  }
  if (url.includes("/payload-roles/dist/")) {
    return "payload-roles";
  }
  if (url.includes("/payload-roles/bench/")) {
    return "bench";
  }
  const dependency = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/u.exec(
    url,
  );
  if (dependency) {
    return dependency[1];
  }
  return url.startsWith("node:") || url === "" ? "node" : url;
};

const byBucket = new Map();
const byFunction = new Map();
let total = 0;
for (const node of nodes) {
  const micros = selfMicros.get(node.id) ?? 0;
  if (micros === 0) {
    continue;
  }
  const bucket = bucketOf(node.callFrame);
  byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + micros);
  if (bucket !== "(idle)") {
    total += micros;
    const { functionName, lineNumber, url } = node.callFrame;
    const label = `${functionName || "(anonymous)"}  ${bucket}${url ? `:${url.split("/").at(-1)}:${lineNumber + 1}` : ""}`;
    byFunction.set(label, (byFunction.get(label) ?? 0) + micros);
  }
}

const table = (entries, limit) =>
  [...entries]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(
      ([label, micros]) =>
        `${(micros / 1000).toFixed(1).padStart(10)} ms ${((micros / total) * 100).toFixed(1).padStart(6)}%  ${label}`,
    )
    .join("\n");

byBucket.delete("(idle)");
console.log(`CPU self time, ${(total / 1000).toFixed(1)} ms without idle\n`);
console.log(`By package\n${table(byBucket, 20)}\n`);
console.log(`By function\n${table(byFunction, Number(top))}`);
