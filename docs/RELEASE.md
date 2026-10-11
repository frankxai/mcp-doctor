# Release MCP Doctor

Release verification reuses the protocol-health workflow. It runs the compiled
workspace and installed audit consumer on Windows/Linux with Node 18 and 24.
The handoff selects the tested Linux Node 24 archive. The publisher does not
rebuild or repack it.

Run Npm release on main with the manifest version, full accepted commit and
operation verify. Source checks refuse other refs, changed commits, package
substitutions and version mismatches. Archive checks bind recorded SHA256/SHA512,
actual paths, package metadata and the installed-consumer matrix. Registry
failures do not count as a missing version. A byte collision stops the release;
a matching version is reported without rewriting tags.

Operation stage waits at the existing npm-publish environment, whose current
policy permits main and requires frankxai review. The job rechecks that artifact
and registry version, then runs npm stage publish with OIDC provenance. There is
no NPM_TOKEN or NODE_AUTH_TOKEN fallback.

The npm trusted publisher must bind GitHub owner frankxai, repository mcp-doctor,
workflow npm-publish.yml, environment npm-publish and action npm stage publish.
The workflow does not configure this account permission. Collaborator read-write
access does not prove matching trust or permission to approve a stage.

Staging reserves a version without making it publicly installable. Final npm
stage approval requires human proof-of-presence and 2FA. Inspect the stage ID and
downloaded bytes against verified-release first. Preserve existing SIS stages.

Use supported npm stage list/view/download commands to recover interruption.
Do not retry an ambiguous result; inspect the exact package/version first.
After approval, reconcile registry integrity and provenance against the verified
archive and perform a clean installed consumer check before reporting released.

Sources: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm staged publishing](https://docs.npmjs.com/cli/v11/commands/npm-stage/).
