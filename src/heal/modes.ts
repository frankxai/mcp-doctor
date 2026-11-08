/**
 * The single source of truth for the doctor's verb table (PRD-005 criterion 5).
 * Both surfaces that describe the verbs — the MCP `mcp_doctor_modes` response
 * and the CLI help's verb section — read from this one list, so the two cannot
 * drift: edit a row here and both change with the next build.
 */

/**
 * The one table both surfaces read from; PRD-005 §2-§3. Every row states what
 * the verb reads, its write class and exactly what it writes, so an agent can
 * decide whether it is allowed to act or only report. The server's verb
 * annotations are graded against this table (see test/serve.test.mjs) and the
 * CLI's `heal` flags mirror the same classes (heal-plan writes nothing;
 * heal apply/rollback target exactly one named config).
 */
export interface DoctorVerbRow {
  verb: string;
  /** CLI verb this MCP tool maps to; PRD-005 §2. */
  mapsTo: string;
  writeClass: "read-only" | "named-config-write";
  /** What the verb reads. */
  target: string;
  /** Exactly what it writes. */
  writes: string;
}

export const DOCTOR_VERBS: DoctorVerbRow[] = [
  {
    verb: "mcp_doctor_audit",
    mapsTo: "audit [--quick] [--project <substr>]",
    writeClass: "read-only",
    target: "every agent config this machine holds",
    writes: "nothing (quick=false launches each configured server once to test its handshake)",
  },
  {
    verb: "mcp_doctor_agents",
    mapsTo: "agents",
    writeClass: "read-only",
    target: "coding agent config files",
    writes: "nothing",
  },
  {
    verb: "mcp_doctor_misplaced_configs",
    mapsTo: "audit (misplaced section)",
    writeClass: "read-only",
    target: "Claude Code settings.json files",
    writes: "nothing",
  },
  {
    verb: "mcp_doctor_preset_packs",
    mapsTo: "recommend [<pack>]",
    writeClass: "read-only",
    target: "static pack data",
    writes: "nothing",
  },
  {
    verb: "mcp_doctor_modes",
    mapsTo: "—",
    writeClass: "read-only",
    target: "this table",
    writes: "nothing",
  },
  {
    verb: "mcp_doctor_heal_plan",
    mapsTo: "heal --plan --config <path>",
    writeClass: "read-only",
    target: "the config named by configPath (required; its stdio entries are health-probed)",
    writes: "nothing",
  },
  {
    verb: "mcp_doctor_heal_apply",
    mapsTo: "heal --apply --config <path> --yes",
    writeClass: "named-config-write",
    target: "the config named by configPath (required; never the ambient profile)",
    writes: "the named config only: dead entries quarantined byte-surgically, receipts and 0600 pre-images recorded beside it",
  },
  {
    verb: "mcp_doctor_heal_rollback",
    mapsTo: "heal --rollback <id> --config <path>",
    writeClass: "named-config-write",
    target: "the config named by configPath (required; a receipt naming any other path is refused)",
    writes: "the named config only, restored byte-exactly from the receipt's 0600 pre-image",
  },
];
