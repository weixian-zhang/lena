import type { Tool } from "./types.js";

/** The tools one agent can use, looked up by the name the model calls them by. */
export type Toolbox = {
  /** The tool called `name`; throws naming it when unknown. */
  get(name: string): Tool;
  /** The tools' name, description and parameters as JSON, in the order given. */
  toJson(): string;
};

/** Build a toolbox from `tools`; throws when two share a name. */
export function createToolbox(tools: Tool[]): Toolbox {
  const toolsByName = new Map<string, Tool>();
  for (const tool of tools) {
    if (toolsByName.has(tool.name)) throw new Error(`Duplicate tool name: "${tool.name}".`);
    toolsByName.set(tool.name, tool);
  }

  return {
    get(name) {
      const tool = toolsByName.get(name);
      if (!tool) throw new Error(`Unknown tool: "${name}".`);
      return tool;
    },
    toJson: () =>
      JSON.stringify([...toolsByName.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))),
  };
}
