/**
 * polpo cloud projects — manage projects via session token auth.
 */
import type { Command } from "commander";
import { loadCredentials, saveCredentials } from "./config.js";
import { createApiClient, type ApiClient } from "./api.js";
import { isTTY, prompt } from "./prompt.js";

/**
 * Fetch the user's first org ID. The server requires an orgId for
 * project list/create, so we resolve it automatically.
 */
async function resolveOrgId(client: ApiClient): Promise<string> {
  const res = await client.get<any[]>("/v1/orgs");
  if (res.status !== 200) {
    console.error(
      `Failed to fetch organizations (status ${res.status}). Are you logged in?`,
    );
    process.exit(1);
  }

  const orgs = Array.isArray(res.data) ? res.data : [];
  if (orgs.length === 0) {
    console.error(
      "No organizations found. Create one in the dashboard first.",
    );
    process.exit(1);
  }

  return orgs[0].id;
}

export function registerProjectsCommand(program: Command): void {
  const projects = program
    .command("projects")
    .description("Manage cloud projects");

  projects
    .command("list")
    .description("List projects")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error("Not logged in. Run: polpo login --api-key <key>");
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const orgId = opts.org ?? (await resolveOrgId(client));
        const res = await client.get<any[]>(
          `/v1/projects?orgId=${encodeURIComponent(orgId)}`,
        );

        if (res.status === 200) {
          const list = Array.isArray(res.data) ? res.data : [];
          if (list.length === 0) {
            console.log("No projects found.");
          } else {
            for (const p of list) {
              const status = p.status ? ` [${p.status}]` : "";
              const active = p.id === creds.projectId ? " *" : "  ";
              console.log(`${active}${p.name ?? p.id}${status}`);
            }
          }
        } else {
          const data = res.data as any;
          console.error(
            "Error: " + (data?.error ?? `status ${res.status}`),
          );
          process.exit(1);
        }
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });

  projects
    .command("create <name>")
    .description("Create a project")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (name: string, opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error("Not logged in. Run: polpo login --api-key <key>");
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const orgId = opts.org ?? (await resolveOrgId(client));

        // Derive slug from name: lowercase, replace non-alphanumeric with dashes
        const slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        const res = await client.post<any>("/v1/projects", {
          orgId,
          name,
          slug,
        });

        if (res.status >= 200 && res.status < 300) {
          const project = res.data;
          console.log(`Project "${name}" created.`);
          if (project?.id) {
            console.log(`  ID: ${project.id}`);
          }
          if (project?.slug) {
            console.log(`  Slug: ${project.slug}`);
          }
        } else {
          const data = res.data as any;
          console.error(
            "Error: " + (data?.error ?? JSON.stringify(data)),
          );
          process.exit(1);
        }
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });

  projects
    .command("set [name-or-id]")
    .description("Select the active project for CLI commands")
    .option("--org <org-id>", "Organization ID (auto-detected if omitted)")
    .action(async (nameOrId: string | undefined, opts: any) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error("Not logged in. Run: polpo login --api-key <key>");
        process.exit(1);
      }

      const client = createApiClient(creds);

      try {
        const orgId = opts.org ?? (await resolveOrgId(client));
        const res = await client.get<any[]>(
          `/v1/projects?orgId=${encodeURIComponent(orgId)}`,
        );

        if (res.status !== 200) {
          console.error("Error fetching projects.");
          process.exit(1);
        }

        const list = Array.isArray(res.data) ? res.data : [];
        if (list.length === 0) {
          console.error("No projects found. Create one first: polpo projects create <name>");
          process.exit(1);
        }

        // Non-interactive: match by name or ID
        if (nameOrId) {
          const match = list.find((p: any) =>
            p.id === nameOrId || p.name?.toLowerCase() === nameOrId.toLowerCase() || p.slug === nameOrId.toLowerCase()
          );
          if (!match) {
            console.error(`  Project "${nameOrId}" not found.`);
            console.error(`  Available: ${list.map((p: any) => p.name).join(", ")}`);
            process.exit(1);
          }
          saveCredentials(creds.apiKey, creds.baseUrl, match.id);
          console.log(`  Active project: ${match.name}`);
          process.exit(0);
        }

        if (list.length === 1) {
          saveCredentials(creds.apiKey, creds.baseUrl, list[0].id);
          console.log(`  Active project: ${list[0].name} (only project)`);
          process.exit(0);
        }

        // Multiple projects — show picker
        console.log("\n  Select a project:\n");
        for (let i = 0; i < list.length; i++) {
          const current = list[i].id === creds.projectId ? " (current)" : "";
          console.log(`    ${i + 1}. ${list[i].name}${current}`);
        }
        console.log();

        if (!isTTY()) {
          console.error("Multiple projects found. Pass project ID: polpo projects set --project <id>");
          process.exit(1);
        }

        const answer = await prompt(`  Select (1-${list.length}): `);
        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= list.length) {
          console.error("  Invalid selection.");
          process.exit(1);
        }

        saveCredentials(creds.apiKey, creds.baseUrl, list[idx].id);
        console.log(`\n  Active project: ${list[idx].name}\n`);
      } catch (err: any) {
        console.error("Error: " + err.message);
        process.exit(1);
      }
    });
}
