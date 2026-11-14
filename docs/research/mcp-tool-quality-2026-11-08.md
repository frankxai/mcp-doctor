# MCP tool-quality spec research — 2026-11-08

Read date for every URL below: **2026-11-08**. Spec revision settled on: **`2026-07-28`**
(stable, released 2026-07-28; "current" per the live changelog/releases). See caveat in §1.

---

## Verified

1. **Current revision is `2026-07-28`** (stable). The 2026-07-28 release is the latest stable tag;
   the 2026-07-28 changelog is live and canonical.
   - URL: https://github.com/modelcontextprotocol/modelcontextprotocol/releases (2026-07-28 stable, tag `2026-07-28`, commit `5f5440b`)
   - URL: https://modelcontextprotocol.io/specification/2026-07-28/changelog
   - CAVEAT: the `/specification` versioning index page still renders "The current protocol version is
     2025-06-18" in some cached copies. The releases page and the dated `/specification/2026-07-28/`
     tree are authoritative; treat the older index string as stale.

2. **Changelog since 2025** — three dated revisions exist after 2025-06-18:
   - `2025-11-25` (2025-11-25): OAuth OIDC discovery, tool icons, URL elicitation, incremental
     consent, experimental tasks, SDK tiers, "guidance on tool names" (SEP-986).
   - `2026-07-28` (2026-07-28): **stateless core** — removed sessions/`Mcp-Session-Id`, removed
     `initialize` handshake (per-request `_meta` now carries protocol version + capabilities); added
     `server/discover`; `subscriptions/listen` replaces GET stream; removed `ping`/`logging/setLevel`/
     `notifications/roots/list_changed`; tasks moved to extension; Multi Round-Trip Requests (MRTR);
     required `resultType` on all results; required `Mcp-Method`/`Mcp-Name` headers; `CacheableResult`
     adds `ttlMs`+`cacheScope` on list results; loosened `inputSchema`/`outputSchema` to any JSON
     Schema 2020-12 keyword; servers SHOULD return `tools/list` in deterministic order.
   - URL: https://modelcontextprotocol.io/specification/2026-07-28/changelog
   - URL: https://modelcontextprotocol.io/specification/2025-11-25/changelog

3. **Tool `annotations` — verbatim from schema** (`ToolAnnotations`, all optional "hints"):
   - `title?: string` — human-readable title.
   - `readOnlyHint?: boolean` — "If true, the tool does not modify its environment." **Default: false.**
   - `destructiveHint?: boolean` — "If true, the tool may perform destructive updates... meaningful
     only when `readOnlyHint == false`." **Default: true.**
   - `idempotentHint?: boolean` — repeated same-args call has no further effect (only when
     `readOnlyHint == false`). **Default: false.**
   - `openWorldHint?: boolean` — interacts with open world of external entities. **Default: true.**
   - Explicit note: "all properties in `ToolAnnotations` are **hints**... Clients should never make
     tool use decisions based on `ToolAnnotations` received from untrusted servers" and clients
     "**MUST** consider tool annotations to be untrusted unless they come from trusted servers."
   - URL: https://raw.githubusercontent.com/modelcontextprotocol/specification/main/schema/2026-07-28/schema.ts (lines ~1912–1954)

4. **`title`** — declared twice: top-level `Tool.title?` (optional) AND `annotations.title?`
   (optional). Display precedence order: **`title`, then `annotations.title`, then `name`.**
   - URL: schema.ts (Tool interface, ~lines 1979–2026)

5. **`outputSchema` / `structuredContent`** — both optional.
   - `outputSchema?` — "An optional JSON Schema object defining the structure of the tool's output
     returned in the `structuredContent` field." If provided: "Servers **MUST** provide structured
     results that conform to this schema. Clients **SHOULD** validate."
   - `structuredContent` — "returned as a JSON value in the `structuredContent` field... can be any
     JSON value... that conforms to the tool's `outputSchema` if one is defined." For backwards compat
     a tool that returns structured content "SHOULD also return the serialized JSON in a TextContent
     block." `structuredContent` is explicitly "unrelated to LLM 'structured outputs'."
   - URL: https://modelcontextprotocol.io/specification/2026-07-28/server/tools (Output Schema /
     Structured Content sections)

6. **Pagination (`cursor` / `nextCursor`)** — verbatim model:
   - "Pagination in MCP uses an opaque cursor-based approach, instead of numbered pages."
   - "The **cursor** is an opaque string token... **Page size** is determined by the server, and
     clients **MUST NOT** assume a fixed page size."
   - Response carries current page + optional `nextCursor` (absent = end). Request carries `cursor`.
   - Pagination applies to the **protocol list RPCs**: `resources/list`, `resources/templates/list`,
     `prompts/list`, `tools/list` (NOT to arbitrary domain tools).
   - Invalid cursors SHOULD error with `-32602`.
   - URL: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination

7. **No spec-level description-length, input-shape, or limit-bounding mandate.**
   - `description?: string` — "human-readable description... like a 'hint' to the model." No min length.
   - `inputSchema` — MUST be a valid JSON Schema object with root `type: "object"`; any 2020-12 keyword
     allowed. For no-parameter tools, `{ type:"object", additionalProperties:false }` is
     "**Recommended**" (not required).
   - Tool names: SHOULD be 1–128 chars, allowed `[A-Za-z0-9_.-]`, unique within a server; for
     aggregated servers clients "**SHOULD** implement a disambiguation strategy such as prefixing tool
     names with a server identifier" — i.e. prefixing is recommended only for aggregation, not required.
   - The spec does NOT require any tool to expose a `limit` parameter, nor to bound one.
   - URL: https://modelcontextprotocol.io/specification/2026-07-28/server/tools (Tool Names, Data Types)

---

## Public MCP servers that implement this well (verified)

All read 2026-11-08.

### A. `github/github-mcp-server` — **v2.1.0** (released 2026-11-03, target `main`)
Strongest all-round match. Declares annotations (incl. `Title`, `ReadOnlyHint`, `OpenWorldHint`),
titles, **outputSchema** on typed tools, and bounded/paginated collection tools.
- Verified: a repo-wide test enforces "every `mcp.Tool` literal MUST set `Annotations.ReadOnlyHint`"
  (AST scan `pkg/toolvalidation`); `openWorldHint` added to 60+ read-only tools; typed output schemas
  ("feat(context): add typed tool schemas and outputs") advertised only to `2026-07-28` clients.
- Concrete tool — `get_file_blame` (`pkg/github/repositories.go`): sets `OutputSchema`, `Title`
  ("Get file blame information"), and documents `perPage`/`after` cursor paging
  ("use 'perPage'/'after' to cursor-page through returned ranges... capped at 1000").
- Concrete tool — `list_repository_collaborators`: `Title` + pagination `page` (min 1) and `perPage`.
- A test (`TestAllToolInputSchemasUseCanonicalPaginationNames`) enforces canonical `page`/`perPage`/
  `after`/`before` pagination names across all tools.
- URLs: https://github.com/github/github-mcp-server/releases/tag/v2.1.0 ;
  https://github.com/github/github-mcp-server/blob/main/pkg/github/repositories.go ;
  https://github.com/github/github-mcp-server/blob/main/pkg/github/tools_validation_test.go

### B. `cloudflare/mcp-server-cloudflare` — **v0.20.x** (`main`, 2026)
Declares titles + annotations on all tools, outputSchema on at least one tool, and paginated
collection tools with bounded `limit`.
- Verified: v0.1.5 "Add MCP tool titles and hints to all Cloudflare tools"; #384 flattened nested
  annotations so `readOnlyHint`/`destructiveHint` sit correctly on `tool.annotations`; #394 added
  `outputSchema` + `structuredContent` to `search_cloudflare_documentation`.
- Concrete tool — `auditlogs_by_account_id` (`apps/auditlogs/src/tools/auditlogs.tools.ts`): has
  `limit` (`z.number().min(1).max(1000)` — bounded) + `cursor` (opaque), ReadOnlyHint via the
  registration pattern, and a description explaining cursor pagination.
- Concrete tool — `search_cloudflare_documentation`: carries `outputSchema` + `structuredContent`.
- Pagination also present on `r2_buckets_list` (`per_page` + cursor) and the implementation guide shows
  the recommended `readOnlyHint`/title pattern.
- URLs: https://github.com/cloudflare/mcp-server-cloudflare/blob/main/apps/auditlogs/src/tools/auditlogs.tools.ts ;
  https://github.com/cloudflare/mcp-server-cloudflare/pull/394 ;
  https://github.com/cloudflare/mcp-server-cloudflare/issues/368 (documents the annotation-flattening fix)

### C. `modelcontextprotocol/typescript-sdk` — `examples/guides/servers/tools.examples.ts` (canonical reference)
The spec's own reference server illustrating every pattern in one place.
- Verified: `search` tool uses `limit: z.number().int().max(50).optional()` (bounded); `product-details`
  declares `outputSchema` and returns `structuredContent`; `clear-catalog` declares
  `annotations: { readOnlyHint:false, destructiveHint:true, idempotentHint:true }` and `title`.
- Note: this is the SDK example/demo, not a production SaaS server, but it is the authoritative public
  demonstration of the spec's recommended tool surface.
- URL: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/guides/servers/tools.examples.ts

### (Partial, noted) `stripe/agent-toolkit` (now deprecated -> `mcp.stripe.com`)
- Verified annotations + title: `searchDocumentationAnnotations()` returns
  `{ destructiveHint:false, idempotentHint:true, openWorldHint:true, readOnlyHint:true, title:'Search Stripe documentation' }` (v0.7.11, 2025-08).
- **Not observed** in the examined toolkit source: `outputSchema` on tools, and any tool-level
  `limit`/`cursor` parameter. Marked `[OPEN]` below — the deprecated status means the live surface is
  now the hosted `mcp.stripe.com`, whose tool definitions were not inspected here.
- URL: https://github.com/stripe/agent-toolkit/blob/74b4f762/typescript/src/shared/documentation/searchDocumentation.ts

---

## [OPEN]

- **Live `mcp.stripe.com` tool surface** (the current Stripe MCP): I inspected the *deprecated*
  `stripe/ai` toolkit, not the hosted server's `tools/list`. Could not confirm whether the hosted
  server emits `outputSchema` or tool-level `limit`/`cursor`. To close: `tools/list` against
  `https://mcp.stripe.com/mcp` (OAuth) and inspect the wire JSON.
- **Cloudflare `outputSchema` coverage breadth**: confirmed on `search_cloudflare_documentation`; the
  broader `cloudflare/mcp` API server is adding response schemas gradually (issue #320, "soak and fix"
  as of 2026-10, not yet advertised on all tools). Could not confirm outputSchema on *every* Cloudflare
  tool — only that the pattern exists and is rolling out.
- **`server/discover` `instructions` field and `CacheableResult` (`ttlMs`/`cacheScope`)** are now
  spec-level and ARE good tool-surface signals, but I did not scan public servers for their adoption.
- **Spec "current = 2025-06-18" stale index string**: a cached copy of the versioning page showed the
  old current version. I treat `2026-07-28` as current based on the releases page + live dated spec
  tree; if the index page is the governed source of truth, that is a contradiction worth flagging to
  the protocol repo.

---

## Criteria delta (estate `score.ts` vs current spec `2026-07-28`)

| Criterion | What the spec says (`2026-07-28`) | What `score.ts` checks | Verdict |
|---|---|---|---|
| `annotations` | `ToolAnnotations` entirely **optional** "hints"; defaults encode unannotated = `readOnlyHint:false`, `destructiveHint:true`, `openWorldHint:true`; clients MUST treat as untrusted. | Requires `readOnlyHint` set; passes if `readOnlyHint:true` OR (`destructiveHint`+`idempotentHint`) set. | **stricter-than-spec** (and slightly *behind* the spec's nuance: spec frames these as untrusted hints with defaults, not a binary safety gate) |
| `titles` | `title` and `annotations.title` both **optional**; display fallback chain title→annotations.title→name. | Requires `title ?? annotations.title` present on every tool. | **stricter-than-spec** |
| `namespace` | Tool names SHOULD be 1–128 chars / `[A-Za-z0-9_.-]`; prefixing recommended **only** for aggregated servers. | Requires every tool name to carry the service prefix. | **stricter-than-spec** |
| `descriptions` | `description?` "hint to the model"; **no minimum length** anywhere. | Requires ≥80 chars (`MIN_DESCRIPTION`). | **stricter-than-spec** |
| `inputs` | `inputSchema` root MUST be `type:object`; any 2020-12 keyword allowed; no per-property description/bounding rule; `additionalProperties:false` only **Recommended** for no-param tools. | Requires every property described + bounded; no-param tools must set `additionalProperties:false`. | **stricter-than-spec** |
| `structured_output` | `outputSchema` **optional**; if present, server MUST conform and client SHOULD validate. | Requires `outputSchema` on every tool. | **stricter-than-spec** |
| `paging` | Pagination is a **protocol-level** feature on `tools/list` etc. using opaque `cursor`; page size is server-determined; clients MUST NOT assume a fixed size. Spec does **not** require any domain tool to expose `limit`/`cursor`. | Requires list/search/find/query/browse/all tools to take a bounded `limit` OR a `cursor`. | **stricter-than-spec** (and mis-scoped: grades tool-level params the spec leaves to server discretion; the spec's real pagination machinery — opaque cursor + server page size — is not what is being graded) |

### Which criteria the spec has *moved past*
- **`annotations`**: the spec now explicitly reframes annotations as *untrusted hints with defined
  defaults* (unannotated ⇒ destructive + open-world) and tells clients to ignore them from untrusted
  servers. `score.ts` still grades binary presence and does not model the trust/default semantics.
- **`paging`**: the spec's actual paging model is protocol-level opaque-cursor pagination with
  server-chosen page size, plus deterministic `tools/list` ordering and `CacheableResult`
  (`ttlMs`/`cacheScope`) caching hints — none of which `score.ts` measures. The estate's "tool-level
  bounded limit/cursor" is a reasonable proxy but is not the spec's machinery.
- The spec also added **`server/discover` `instructions`**, **deterministic ordering**, and
  **caching hints** as first-class tool-surface quality signals that `score.ts` does not check at all.

### Which criteria the spec does *not require at all* (over-grading risk)
All seven criteria above are stricter-than-spec: the spec makes `annotations`, `title`, and
`outputSchema` **optional**, sets **no description length**, imposes **no per-property bounding** rule,
recommends (not requires) `additionalProperties:false` and server-name prefixing, and does **not**
mandate tool-level `limit`/`cursor`. `mcp-doctor` is therefore grading to an *estate-native contract*
that exceeds the protocol — defensible as a quality bar, but it should not be read as "spec
compliance."
