// import { fileURLToPath } from "node:url";
// import { expect, test } from "vitest";
// import { azureCliGenerateTool } from "../src/agent/tools/azure-mcp/azure-cli.js";

// // Live integration test for the azure_cli_generate tool. It spawns the real Azure MCP
// // server (`@azure/mcp`, `extension` namespace) over stdio, which authenticates via the
// // service-principal env vars (AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET). So this asserts
// // two things at once:
// //   1. the MCP server starts AND authenticates (a bad SP surfaces as an isError / throw);
// //   2. it returns a real `az` command for a rich, multi-constraint provisioning intent.
// // It only generates command TEXT — nothing is provisioned, so there's nothing to clean up.
// //
// // SKIPS (not fails) when the SP creds are absent, e.g. CI without secrets.

// // Same as agent.provision.test.ts: load the backend .env from source so the SP creds
// // resolve when running from the repo rather than a build.
// try {
//   process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
// } catch {
//   // No .env — rely on the ambient environment (e.g. CI secrets).
// }

// // azure_cli_generate is currently DISABLED in the tool registry (its MCP backend only
// // accepts a user/delegated token — it 401s on the service-principal token a hosted Lena
// // uses). This test exercises the tool directly, so it's gated to the one setup where the
// // endpoint actually works: a local `az login` user, selected via AzureCliCredential. It
// // SKIPS everywhere else (SP-only, or no creds — e.g. CI/hosted) instead of red-failing.
// function cliGenerateUsable(): boolean {
//   return process.env.AZURE_TOKEN_CREDENTIALS === "AzureCliCredential";
// }

// // A deliberately complex intent: series + region + image + auth + networking + tags. If
// // the server authenticates and understands it, the generated `az vm create` should carry
// // these constraints through as flags.
// const INTENT = [
//   "Create a Linux virtual machine in the Southeast Asia region running an Ubuntu 22.04 LTS",
//   "image, using a Standard_D-series size (Standard_D2s_v5), admin username azureuser with",
//   "SSH public-key authentication (generate the key pair), placed in resource group",
//   "rg-lena-test, and tag it owner=lena env=test.",
// ].join(" ");

// /** Flatten the tool's text content blocks into one string. */
// function textOf(result: Awaited<ReturnType<typeof azureCliGenerateTool.execute>>): string {
//   return result.content
//     .filter((c): c is { type: "text"; text: string } => c.type === "text")
//     .map((c) => c.text)
//     .join("\n");
// }

// // The tool returns a DOUBLE-encoded JSON blob, not a bare command:
// //   { status, message, results: { command: "<json string>", cliType }, duration }
// // and results.command is itself JSON: { data: [{ commandSet: [{ example }, …] }] }.
// // The actual `az`/shell lines live at data[].commandSet[].example.
// type CliGenerateStep = { example?: string; command?: string };
// type CliGenerateData = { commandSet?: CliGenerateStep[] };

// /** Parse the nested response and return every generated command `example`, in order. */
// function extractCommands(text: string): string[] {
//   const outer = JSON.parse(text) as { results?: { command?: string } };
//   const commandJson = outer.results?.command;
//   if (!commandJson) throw new Error(`response had no results.command: ${text.slice(0, 200)}`);
//   const inner = JSON.parse(commandJson) as { data?: CliGenerateData[] };
//   return (inner.data ?? [])
//     .flatMap((d) => d.commandSet ?? [])
//     .map((step) => step.example)
//     .filter((ex): ex is string => typeof ex === "string" && ex.length > 0);
// }

// test.skipIf(!cliGenerateUsable())(
//   "azure_cli_generate - MCP server authenticates and returns an `az` command for a complex VM request",
//   // Generous: the first run has `npx` download @azure/mcp (STARTUP_TIMEOUT_MS 120s) on
//   // top of the generate call (CALL_TIMEOUT_MS 60s).
//   { timeout: 240_000 },
//   async () => {
//     const controller = new AbortController();

//     // Throws if the server fails to start/authenticate, or if the tool returns isError.
//     const result = await azureCliGenerateTool.execute(
//       "test-azure-cli-generate",
//       { intent: INTENT },
//       controller.signal,
//     );

//     const text = textOf(result);
//     expect(text.trim(), "tool returned no content").not.toBe("");
//     expect(text, "tool returned its empty fallback").not.toContain("(no command generated)");

//     // Parse the nested JSON and pull out the generated command lines.
//     const commands = extractCommands(text);
//     console.log(`[azure_cli_generate] extracted commands:\n${commands.map((c) => `  • ${c}`).join("\n")}`);
//     expect(commands.length, "expected at least one generated command").toBeGreaterThan(0);

//     // The core deliverable: an `az vm create` command...
//     const vmCreate = commands.find((c) => c.startsWith("az vm create"));
//     expect(vmCreate, `no "az vm create" among: ${commands.join(" | ")}`).toBeDefined();

//     // ...that carried the request's key constraints through as real flags.
//     const lower = (vmCreate ?? "").toLowerCase();
//     expect(lower, "expected --location southeastasia").toContain("--location southeastasia");
//     expect(lower, "expected --image with the Ubuntu image").toMatch(/--image\s+ubuntu/);
//     expect(lower, "expected --size Standard_D2s_v5").toContain("--size standard_d2s_v5");
//     expect(lower, "expected --admin-username azureuser").toContain("--admin-username azureuser");
//   },
// );
