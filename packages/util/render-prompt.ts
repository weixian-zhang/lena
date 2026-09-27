import nunjucks from "nunjucks";

// Prompts aren't HTML, so no escaping; a missing variable throws instead of leaking `{{ name }}` to the model.
const env = new nunjucks.Environment(null, { autoescape: false, throwOnUndefined: true });

/** Render a nunjucks prompt template (`{{ var }}`, `{% if %}`) with `vars`. */
export function renderPrompt(template: string, vars: Record<string, unknown>): string {
  return env.renderString(template, vars);
}
