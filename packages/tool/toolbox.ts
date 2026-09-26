import type { Tool } from "./tool.js";

/** The tools one agent can use, looked up by the name the model calls them by. */
export interface Toolbox {
  /** The tool called `name`; throws naming it when unknown. */
  get(name: string): Tool;
  /** The tools' name, description and parameters as JSON, in the order given. */
  toJson(): string;
}

export class DefaultToolbox implements Toolbox {
  private readonly toolsByName = new Map<string, Tool>();

  /** Throws when two of `tools` share a name. */
  constructor(tools: Tool[]) {
    for (const tool of tools) {
      if (this.toolsByName.has(tool.name)) throw new Error(`Duplicate tool name: "${tool.name}".`);
      this.toolsByName.set(tool.name, tool);
    }
  }

  get(name: string): Tool {
    const tool = this.toolsByName.get(name);
    if (!tool) throw new Error(`Unknown tool: "${name}".`);
    return tool;
  }

  toJson(): string {
    return JSON.stringify(
      [...this.toolsByName.values()].map(({ name, description, parameters }) => ({ name, description, parameters })),
    );
  }
}
