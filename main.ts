// Entry point for the github-core-clone-01 submission.
//
// Spawns ./forge, reads the PORT=<n> line it prints on stdout, registers
// that port with the trial environment, waits until the environment reports
// done, then terminates the child and exits 0. Exits 1 at once when
// MAKEFUN_ENV_URL is not set.
//
// The forge binary is resolved next to this file (import.meta.url), NOT
// relative to the process working directory: the live harness starts the
// entrypoint from a directory other than the repo root, and a bare
// "./forge" spawn fails there with ENOENT (round 3 scored 0 live for
// exactly this reason: the trial made 0 requests, working false).
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  console.error("MAKEFUN_ENV_URL is not set");
  process.exit(1);
}

const forgePath = join(dirname(fileURLToPath(import.meta.url)), "forge");
const child = spawn(forgePath, [], { stdio: ["ignore", "pipe", "inherit"] });
child.on("error", (err) => {
  console.error(`failed to start ${forgePath}: ${err.message}`);
  process.exit(1);
});

let port: number | null = null;
let buffered = "";
const portReady = new Promise<number>((resolve, reject) => {
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    const m = buffered.match(/PORT=(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  child.on("exit", (code) => reject(new Error(`forge exited early with ${code}`)));
});

try {
  port = await portReady;
} catch (err) {
  console.error(err);
  process.exit(1);
}

const base = envUrl.replace(/\/$/, "");
async function register(): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return true;
    } catch {
      // retry
    }
    await sleep(500);
  }
  return false;
}

if (!(await register())) {
  console.error("failed to register with the environment");
  child.kill("SIGTERM");
  process.exit(1);
}

for (;;) {
  await sleep(500);
  try {
    const res = await fetch(`${base}/done`);
    if (res.ok) {
      const body = (await res.json()) as { done?: boolean };
      if (body.done) break;
    }
  } catch {
    // keep polling
  }
}

child.kill("SIGTERM");
process.exit(0);
