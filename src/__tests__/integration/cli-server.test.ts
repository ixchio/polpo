import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";

import type { Orchestrator } from "../../core/orchestrator.js";
import type { SSEBridge } from "../../server/sse-bridge.js";

const execFileAsync = promisify(execFile);

/**
 * CLI ↔ Local Server integration tests.
 *
 * Runs the **real compiled binary** (`node dist/cli/index.js`) against
 * a live Polpo HTTP server.  No mocks, no Commander imports — the full
 * CLI binary is exercised end-to-end.
 *
 * Requires `pnpm build` to have been run first (tests the compiled output).
 */

// ── Path to the built CLI binary ─────────────────────────────────────
const __dirname_test = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname_test, "..", "..", "..", "dist", "cli", "index.js");
const ROOT = resolve(__dirname_test, "..", "..", "..");

// ── Helper: run the CLI binary and capture output ────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute the polpo CLI binary via `node dist/cli/index.js`.
 * Returns stdout, stderr, and the exit code.
 */
async function run(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI, ...args], {
      cwd: opts?.cwd ?? ROOT,
      timeout: opts?.timeout ?? 30_000,
      env: {
        ...process.env,
        FORCE_COLOR: "0",              // no ANSI escape codes
        NO_COLOR: "1",                 // respected by chalk + disables update checker
        NODE_NO_WARNINGS: "1",        // suppress experimental warnings
        POLPO_NO_UPDATE_CHECK: "1",   // explicitly skip npm update check
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    // execFile rejects on non-zero exit. err still has stdout/stderr.
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

// ── Config shared by server + CLI ────────────────────────────────────

const POLPO_CONFIG = JSON.stringify({
  project: "cli-integration",
  team: {
    name: "test-team",
    agents: [
      { name: "agent-1", role: "Test agent" },
    ],
  },
  settings: { maxRetries: 2, logLevel: "quiet" },
}, null, 2);

// ── Shared state ─────────────────────────────────────────────────────

let tmpDir: string;
let orchestrator: Orchestrator;
let sseBridge: SSEBridge;
let server: ReturnType<typeof import("@hono/node-server").serve>;
let port: number;

// =====================================================================
// 1. Standalone CLI commands (no server needed)
// =====================================================================

describe("CLI standalone (no server)", () => {
  it("polpo --version — prints version and exits 0", async () => {
    const r = await run(["--version"]);
    expect(r.exitCode).toBe(0);
    // Version string should be a semver-like pattern (e.g. "0.4.0")
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("polpo --help — prints help text", async () => {
    const r = await run(["--help"]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out).toContain("polpo-ai");
    expect(out).toContain("deploy");
    expect(out).toContain("login");
  });

  it.skip("polpo models list --json — requires Gateway access", async () => {
    // Skipped: model catalog comes from AI Gateway API (requires network).
    // In CI without Gateway access, listModels() returns [].
    const r = await run(["models", "list", "--json"]);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(Array.isArray(parsed)).toBe(true);
  });

  // polpo init removed — agents are defined in files directly
});

// =====================================================================
// 2. Project-scoped CLI commands (need a project dir + server)
// =====================================================================

describe("CLI with project directory", () => {
  beforeAll(async () => {
    // 1. Create a temp workspace with a valid polpo config
    tmpDir = await mkdtemp(join(tmpdir(), "polpo-cli-integration-"));
    await mkdir(join(tmpDir, ".polpo"), { recursive: true });
    await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

    // Seed teams.json and agents.json (required by FileTeamStore/FileAgentStore)
    await writeFile(
      join(tmpDir, ".polpo", "teams.json"),
      JSON.stringify([{ name: "test-team", agents: [] }], null, 2),
    );
    await writeFile(
      join(tmpDir, ".polpo", "agents.json"),
      JSON.stringify([{ agent: { name: "agent-1", role: "Test agent" }, teamName: "test-team" }], null, 2),
    );

    // 2. Boot orchestrator + SSE bridge + Hono server
    const { Orchestrator: OrchestratorClass } = await import("../../core/orchestrator.js");
    const { SSEBridge: SSEBridgeClass } = await import("../../server/sse-bridge.js");
    const { createApp } = await import("../../server/app.js");
    const { serve } = await import("@hono/node-server");

    orchestrator = new OrchestratorClass(tmpDir);
    await orchestrator.initInteractive("cli-integration", {
      name: "test-team",
      agents: [{ name: "agent-1", role: "Test agent" }],
    });

    sseBridge = new SSEBridgeClass(orchestrator);
    sseBridge.start();

    const app = createApp(orchestrator, sseBridge, { workDir: tmpDir });

    const listening = new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, (info: AddressInfo) => {
        resolve(info.port);
      });
    });

    port = await listening;
  }, 30_000);

  afterAll(async () => {
    server?.close();
    sseBridge?.dispose();
    if (orchestrator?.isInitialized) {
      await orchestrator.gracefulStop();
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── Status ─────────────────────────────────────────────────────────

  it("polpo status — exits gracefully", async () => {
    const r = await run(["status", "-d", tmpDir]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout + r.stderr;
    expect(out.length).toBeGreaterThan(0);
  });
});
