import { AzureCliGenerateTool } from "./builtin/azure-cli.js";
import { AzureShellTool } from "./builtin/azure-shell.js";
import { EditTool } from "./builtin/file/edit.js";
import { ReadMediaTool } from "./builtin/file/read-media.js";
import { ReadTool } from "./builtin/file/read.js";
import { WriteTool } from "./builtin/file/write.js";
import type { AzureLogin } from "./builtin/helper/authenticated-shell.js";
import type { Tool } from "./tool.js";

/** The tools one agent can use, looked up by the name the model calls them by. */
export interface Toolbox {
  /** The tool called `name`; throws naming it when unknown. */
  get(name: string): Tool;
  /** The tools' name, description and parameters as JSON, in the order given. */
  toJson(): string;
}

/** Lena's built-in tools for one session, all working in `workDir`. */
export class StandardToolbox implements Toolbox {
  private readonly toolsByName = new Map<string, Tool>();

  /** `workDir` is where the shell runs and relative file paths resolve; the caller creates it. */
  constructor(workDir: string, azureLogin: AzureLogin) {
    const builtinTools: Tool[] = [
      new AzureShellTool(workDir, azureLogin),
      new AzureCliGenerateTool(),
      new ReadTool(workDir),
      new ReadMediaTool(workDir),
      new WriteTool(workDir),
      new EditTool(workDir),
    ];

    for (const tool of builtinTools) this.toolsByName.set(tool.name, tool);
  }

  get(name: string): Tool {
    const tool = this.toolsByName.get(name);
    if (!tool) throw new Error(`Unknown tool: "${name}".`);
    return tool;
  }

  toJson(): string {
    return JSON.stringify(
      [...this.toolsByName.values()].map(
        ({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        }),
      ),
    );
  }
}
