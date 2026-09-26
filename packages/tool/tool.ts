import type { Static, TSchema } from "typebox";

/** A tool the model can call and the agent can run. `parameters` is a typebox schema. */
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
  /**
   * Returns the result text for the model; throws on failure. Method syntax keeps
   * `args` bivariant, so a `Tool<typeof schema>` fits a `Tool[]` without a cast.
   */
  execute(args: Static<TParameters>, abortSignal?: AbortSignal): Promise<string>;
}
