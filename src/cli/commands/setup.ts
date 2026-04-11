import { resolve, basename } from "node:path";
import { getPolpoDir } from "../../core/constants.js";
import readline from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault } from "../../core/config.js";
import { createCliTeamAndAgentStores } from "../stores.js";
import { PROVIDER_ENV_MAP } from "../../llm/pi-client.js";
import {
  detectProviders,
  persistToEnvFile,
  getAuthOptions,
  getProviderModels,
  modelLabel as rawModelLabel,
  type DetectedProvider,
  type ModelInfo,
} from "../../setup/index.js";

// ── Readline helpers ────────────────────────────────

function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function promptWithDefault(label: string, defaultVal: string): Promise<string> {
  const answer = await promptUser(`  ${label} ${chalk.dim(`[${defaultVal}]`)}: `);
  return answer || defaultVal;
}

async function pickFromList(items: string[], prompt: string): Promise<number> {
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${chalk.cyan(`${i + 1}.`)} ${items[i]}`);
  }
  console.log();
  const answer = await promptUser(`  ${prompt}: `);
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= items.length) return -1;
  return idx;
}

// ── Chalk model label ──────────────────────────────

function modelLabel(m: ModelInfo): string {
  const { name, tags, costStr } = rawModelLabel(m);
  const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
  return `${name}${tagStr}${costStr ? ` ${chalk.dim(costStr)}` : ""}`;
}

// ── Auth step ───────────────────────────────────────

async function runAuthStep(providers: DetectedProvider[], polpoDir: string): Promise<void> {
  console.log();
  console.log(chalk.bold("  Select a provider:"));
  console.log();
  const allProviders = Object.entries(PROVIDER_ENV_MAP)
    .filter(([, envVar], idx, arr) => arr.findIndex(([, ev]) => ev === envVar) === idx);
  const labels = [
    ...allProviders.map(([p, ev]) => `${chalk.bold(p)} ${chalk.dim(`(${ev})`)}`),
    chalk.dim("Skip"),
  ];

  const pIdx = await pickFromList(labels, `Select (1-${labels.length})`);
  if (pIdx < 0 || pIdx >= allProviders.length) return;

  const [provider, envVar] = allProviders[pIdx];
  const key = await promptUser(`  ${envVar}: `);
  if (key) {
    process.env[envVar] = key;
    persistToEnvFile(polpoDir, envVar, key);
    console.log(chalk.green(`  ${envVar} saved to .polpo/.env`));
    providers.push({ name: provider, source: "env", envVar, hasKey: true });
  }
}

// ── Setup wizard ────────────────────────────────────

export interface SetupOptions {
  polpoDir?: string;
  workDir?: string;
  nonInteractive?: boolean;
}

export async function runSetupWizard(options?: SetupOptions): Promise<void> {
  const workDir = options?.workDir ?? process.cwd();
  const polpoDir = options?.polpoDir ?? getPolpoDir(workDir);
  const isInteractive = !options?.nonInteractive && process.stdin.isTTY;
  const existing = loadPolpoConfig(polpoDir);
  const projectName = existing?.project ?? basename(workDir);

  console.log();
  console.log(chalk.bold("  Polpo Setup"));
  console.log();

  // ── Non-interactive fallback ──
  if (!isInteractive) {
    const model = process.env.POLPO_MODEL;
    const config = generatePolpoConfigDefault(projectName, {
      model: model ?? undefined,
    });
    savePolpoConfig(polpoDir, config);

    // Populate stores with a default agent
    const { teamStore: ts, agentStore: as_ } = await createCliTeamAndAgentStores(polpoDir);
    const teams = await ts.getTeams();
    if (teams.length === 0) {
      await ts.createTeam({ name: "default", description: "Default Polpo team", agents: [] });
    }
    const agents = await as_.getAgents();
    if (agents.length === 0) {
      const agent: Record<string, unknown> = { name: "agent-1", role: "founder" };
      if (model) agent.model = model;
      await as_.createAgent(agent as any, "default");
    }

    if (!model) {
      console.log(chalk.yellow("  No model configured. Set POLPO_MODEL or run 'polpo setup' interactively."));
    } else {
      console.log(chalk.green(`  Config saved with model: ${model}`));
    }
    return;
  }

  // ── Step 1: Auth ──────────────────────────────────
  const providers = detectProviders().filter((p) => p.hasKey);

  if (providers.length > 0) {
    console.log(chalk.dim("  Detected providers:"));
    for (const p of providers) {
      const source = p.source === "env" ? `env: ${p.envVar}` : "OAuth profile";
      console.log(`  ${chalk.green("✓")} ${chalk.bold(p.name)} ${chalk.dim(`(${source})`)}`);
    }
    console.log();
  } else {
    console.log(chalk.bold("  Step 1 — Auth with a provider"));
    console.log();
    await runAuthStep(providers, polpoDir);
    console.log();
  }

  // If still no providers after auth step, bail early with guidance
  if (providers.length === 0) {
    console.log(chalk.yellow("  No provider configured."));
    console.log(chalk.dim("  Run 'polpo setup' again or 'polpo auth login' to add one."));
    console.log();
    savePolpoConfig(polpoDir, generatePolpoConfigDefault(projectName));
    return;
  }

  // ── Step 2: Orchestrator model ────────────────────
  console.log(chalk.bold("  Step 2 — Select the orchestrator model"));
  console.log();

  let selectedModel: string | undefined;
  const allModels: { spec: string; label: string }[] = [];
  for (const p of providers) {
    for (const m of getProviderModels(p.name)) {
      allModels.push({ spec: `${p.name}:${m.id}`, label: modelLabel(m) });
    }
  }

  if (allModels.length > 0) {
    const capped = allModels.slice(0, 15);
    const labels = [
      ...capped.map((m) => `${chalk.bold(m.spec)} ${chalk.dim(`— ${m.label}`)}`),
      chalk.dim("Enter custom model"),
    ];

    const idx = await pickFromList(labels, `Select (1-${labels.length})`);
    if (idx >= 0 && idx < capped.length) {
      selectedModel = capped[idx].spec;
    } else {
      const custom = await promptUser("  Model spec (provider:model): ");
      if (custom) selectedModel = custom;
    }
  } else {
    const custom = await promptUser("  Model spec (provider:model): ");
    if (custom) selectedModel = custom;
  }

  if (!selectedModel) {
    console.log(chalk.yellow("  No model selected. You can set it later in .polpo/polpo.json"));
    console.log();
  }

  // ── Step 3: First agent ───────────────────────────
  console.log();
  console.log(chalk.bold("  Step 3 — First agent"));
  console.log();

  // Read agent defaults from stores
  const { teamStore, agentStore } = await createCliTeamAndAgentStores(polpoDir);
  const existingAgents = await agentStore.getAgents();
  const defaultAgentName = existingAgents[0]?.name ?? "agent-1";
  const defaultAgentRole = existingAgents[0]?.role ?? "founder";

  const agentName = await promptWithDefault("Agent name", defaultAgentName);
  const agentRole = await promptWithDefault("Agent role", defaultAgentRole);

  // ── Write config (project/settings/providers only) ──
  const config = generatePolpoConfigDefault(projectName, {
    model: selectedModel,
  });
  savePolpoConfig(polpoDir, config);

  // ── Populate agent and team stores ──
  const existingTeams = await teamStore.getTeams();
  if (existingTeams.length === 0) {
    await teamStore.createTeam({ name: "default", description: "Default Polpo team", agents: [] });
  }

  const existingAgent = await agentStore.getAgent(agentName);
  if (!existingAgent) {
    const agentConfig: Record<string, unknown> = { name: agentName, role: agentRole };
    if (selectedModel) agentConfig.model = selectedModel;
    await agentStore.createAgent(agentConfig as any, "default");
  }

  // ── Summary ──
  console.log();
  console.log(chalk.green("  Ready!"));
  console.log();
  console.log(`  ${chalk.dim("Project:")} ${projectName}`);
  console.log(`  ${chalk.dim("Model:")}  ${selectedModel ?? chalk.yellow("not set")}`);
  console.log(`  ${chalk.dim("Agent:")}  ${agentName} (${agentRole})`);
  console.log();
  console.log(chalk.dim("  Config saved to .polpo/"));
  console.log(chalk.dim("  Run: polpo start"));
  console.log();
}

// ── CLI command registration ────────────────────────

export function registerSetupCommand(parent: Command): void {
  parent
    .command("setup")
    .description("Interactive setup wizard — auth, model, and first agent")
    .option("-d, --dir <path>", "Working directory", ".")
    .action(async (opts) => {
      const workDir = resolve(opts.dir);
      await runSetupWizard({ workDir });
    });
}
