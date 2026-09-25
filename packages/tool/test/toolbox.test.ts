import { Type } from "typebox";
import { expect, test } from "vitest";
import { createToolbox } from "../toolbox.js";
import type { Tool } from "../types.js";

test("toJson keeps the order the tools were given", () => {
  const toolbox = createToolbox([echoTool("a"), echoTool("b")]);

  expect(JSON.parse(toolbox.toJson()).map((tool: { name: string }) => tool.name)).toEqual(["a", "b"]);
});

test("get returns the tool by name and it runs", async () => {
  const toolbox = createToolbox([echoTool("echo")]);

  expect(await toolbox.get("echo").execute({ text: "hi" })).toBe("echo: hi");
});

test("get throws naming an unknown tool", () => {
  const toolbox = createToolbox([echoTool("echo")]);

  expect(() => toolbox.get("missing")).toThrow('Unknown tool: "missing".');
});

test("two tools with the same name are rejected", () => {
  expect(() => createToolbox([echoTool("echo"), echoTool("echo")])).toThrow('Duplicate tool name: "echo".');
});

test("toJson describes each tool without its execute function", () => {
  const tool = echoTool("echo");

  expect(JSON.parse(createToolbox([tool]).toJson())).toEqual([
    { name: "echo", description: tool.description, parameters: tool.parameters },
  ]);
});

function echoTool(name: string): Tool {
  const parameters = Type.Object({ text: Type.String() });
  const tool: Tool<typeof parameters> = {
    name,
    description: "Echo the text back.",
    parameters,
    execute: async ({ text }) => `${name}: ${text}`,
  };
  return tool;
}
