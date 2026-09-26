/**
 * Quality score for an MCP server's tool surface, from what tools/list reveals.
 * Criteria come from the MCP spec (annotations, outputSchema/structuredContent) and the
 * practices that separate leading servers (GitHub, Stripe, Sentry, Cloudflare) and
 * Anthropic's "Writing effective tools for agents".
 */

export interface ScoredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, JsonSchema>; additionalProperties?: unknown };
  outputSchema?: unknown;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

interface JsonSchema {
  type?: string | string[];
  description?: string;
  maxLength?: number;
  pattern?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  maximum?: number;
}

export interface Criterion {
  id: string;
  label: string;
  points: 0 | 1 | 2;
  /** Tools the criterion applies to. */
  applicable: number;
  failing: string[];
  advice: string;
}

export interface ScoreReport {
  points: number;
  max: number;
  percent: number;
  criteria: Criterion[];
  manual: string[];
}

const MIN_DESCRIPTION = 80;
const LIST_LIKE = /(^|[_.-])(list|search|find|query)|^(list|search|find|query)/i;
const PAGING_PARAMS = new Set(["limit", "page_size", "pageSize", "max_results", "maxResults", "cursor", "page", "per_page"]);

export const MANUAL_CHECKS = [
  "Errors: validation and business failures return isError:true with a fix hint; only unknown tools and malformed requests use JSON-RPC errors",
  "Narrowing: read-only mode, toolsets or a per-tool allowlist, with a small default surface",
  "Responses: resolve IDs to readable names, drop noise fields, stay well under 25,000 tokens",
  "Access: remote Streamable HTTP with OAuth or scoped keys, and human confirmation for irreversible actions",
  "Evals: realistic multi-call tasks with verifiers, tracking accuracy, calls, tokens and errors",
];

function points(passing: number, applicable: number): 0 | 1 | 2 {
  if (applicable === 0) return 2;
  const ratio = passing / applicable;
  return ratio === 1 ? 2 : ratio >= 0.5 ? 1 : 0;
}

function criterion(
  id: string,
  label: string,
  tools: ScoredTool[],
  applies: (tool: ScoredTool) => boolean,
  passes: (tool: ScoredTool) => boolean,
  advice: string,
): Criterion {
  const relevant = tools.filter(applies);
  const failing = relevant.filter((tool) => !passes(tool)).map((tool) => tool.name);
  return { id, label, points: points(relevant.length - failing.length, relevant.length), applicable: relevant.length, failing, advice };
}

/** "@scope/fixture-mcp" -> "fixture" */
export function servicePrefix(serverName: string): string {
  const bare = serverName.replace(/^@[^/]+\//, "").toLowerCase();
  return bare.split(/[^a-z0-9]+/).filter(Boolean)[0] ?? bare;
}

function namespaceCriterion(tools: ScoredTool[], serverName: string): Criterion {
  const prefix = `${servicePrefix(serverName)}_`;
  const failing = tools.filter((tool) => !tool.name.startsWith(prefix)).map((tool) => tool.name);
  const firstSegments = new Set(tools.map((tool) => tool.name.split(/[_.-]/)[0]));
  const pts: 0 | 1 | 2 = failing.length === 0 ? 2 : tools.length > 1 && firstSegments.size === 1 ? 1 : 0;
  return {
    id: "namespace",
    label: `Tool names carry the service prefix "${prefix}"`,
    points: pts,
    applicable: tools.length,
    failing,
    advice: "Prefix every tool with the service name so agents with many servers loaded pick the right one.",
  };
}

function inputIsDocumentedAndBounded(tool: ScoredTool): boolean {
  const properties = Object.values(tool.inputSchema?.properties ?? {});
  if (properties.length === 0) return tool.inputSchema?.additionalProperties === false;
  return properties.every((property) => {
    if (!property.description?.trim()) return false;
    const types = Array.isArray(property.type) ? property.type : [property.type];
    if (types.includes("string")) {
      return property.maxLength !== undefined || property.pattern !== undefined || property.enum !== undefined || property.const !== undefined || property.format !== undefined;
    }
    if (types.includes("integer") || types.includes("number")) return property.maximum !== undefined || property.enum !== undefined;
    return true;
  });
}

function annotated(tool: ScoredTool): boolean {
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === undefined) return false;
  return hints.readOnlyHint === true || (hints.destructiveHint !== undefined && hints.idempotentHint !== undefined);
}

export function scoreTools(tools: ScoredTool[], serverName: string): ScoreReport {
  const every = () => true;
  const criteria: Criterion[] = [
    criterion("annotations", "Safety annotations (readOnlyHint; writers add destructiveHint and idempotentHint)", tools, every, annotated,
      "Unannotated tools default to destructive and open-world, and some clients drop them. Set readOnlyHint on every tool."),
    criterion("titles", "Human-readable title", tools, every, (tool) => Boolean(tool.title ?? tool.annotations?.title),
      "Add a title so hosts can show a readable name."),
    namespaceCriterion(tools, serverName),
    criterion("descriptions", `Descriptions of ${MIN_DESCRIPTION}+ characters (when to use, what it returns, cost)`, tools, every,
      (tool) => (tool.description ?? "").trim().length >= MIN_DESCRIPTION,
      "Say when to use the tool, when not to, and how large or costly the response is."),
    criterion("inputs", "Every input described and bounded; no-input tools set additionalProperties:false", tools, every, inputIsDocumentedAndBounded,
      "Describe each property; give strings maxLength/pattern/enum and numbers a maximum."),
    criterion("structured_output", "Declares outputSchema (and returns structuredContent)", tools, every, (tool) => tool.outputSchema !== undefined,
      "Declare an object outputSchema, return structuredContent, and keep the JSON text block for older clients."),
    criterion("paging", "List and search tools take a limit or cursor", tools, (tool) => LIST_LIKE.test(tool.name),
      (tool) => Object.keys(tool.inputSchema?.properties ?? {}).some((key) => PAGING_PARAMS.has(key)),
      "Give list and search tools a limit (with a sensible default) or a cursor so responses stay small."),
  ];
  const earned = criteria.reduce((sum, item) => sum + item.points, 0);
  const max = criteria.length * 2;
  return { points: earned, max, percent: Math.round((earned / max) * 100), criteria, manual: MANUAL_CHECKS };
}
