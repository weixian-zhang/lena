import type { LLM, LLMMessage } from "@lena/llm";
import type { Tool, Toolbox } from "@lena/tool";
import { AgentLoop } from "../loop.js";
import type { AgentContext, LoopEvent, TurnInput } from "../types.js";

export function createContext(
  llm: LLM,
  tools: Tool[],
  history: LLMMessage[] = [],
): AgentContext {
  return {
    llm,
    toolbox: new ListToolbox(tools),
    systemPrompt: "You are Lena.",
    history,
  };
}

export async function runAgentLoop(
  context: AgentContext,
  turn: TurnInput = {},
): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of new AgentLoop(context).runTurn(turn))
    events.push(event);
  return events;
}

export function countSteps(events: LoopEvent[]): number {
  return events.filter((event) => event.type === "step_start").length;
}

/** Returns `messages` on the first call and nothing after, like a prompt waiting in the inbox. */
export function drainOnce(messages: LLMMessage[]): () => LLMMessage[] {
  return () => messages.splice(0);
}

export function user(content: string): LLMMessage {
  return { role: "user", content };
}

/** Real in-process tools, looked up by name like the standard toolbox. */
class ListToolbox implements Toolbox {
  constructor(private readonly tools: Tool[]) {}

  get(name: string): Tool {
    const tool: Tool | undefined = this.tools.find(
      (candidate) => candidate.name === name,
    );
    if (!tool) throw new Error(`Unknown tool: "${name}".`);
    return tool;
  }

  list(): readonly Tool[] {
    return this.tools;
  }

  toJson(): string {
    return JSON.stringify(
      this.tools.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    );
  }
}
