# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub security advisories](https://github.com/nilsonsfj/steamtrain/security/advisories/new)
rather than opening a public issue. Include reproduction steps and the version
(commit) you tested. You should receive a response within a week.

## Threat model, in brief

steamtrain is a **local developer tool that spawns real coding-agent CLIs**
(`claude`, `opencode`, `codex`, `amp`) with your local credentials, executes
workflow `command` steps with your shell, and writes to your repository
through git worktrees. Anyone who can drive a steamtrain process can do what
those agents can do. Treat access to it like access to your shell.

Key properties and expectations:

- **The web UI is a privileged control plane.** It defaults to
  `127.0.0.1`. Binding to any non-local host requires an auth token
  (`--auth-token` / `STEAMTRAIN_AUTH_TOKEN`; one is auto-generated when
  neither is given) unless you explicitly pass `--no-auth`, which is unsafe
  outside a trusted network. A separate `--read-token` /
  `STEAMTRAIN_READ_TOKEN` (or process-wide `--read-only`) can mint viewer
  sessions that cannot launch runs or edit config, but those sessions still
  see full step outputs and history - treat a read token like access to this
  project's run artifacts. Requests are CSRF-checked, bodies are
  size-limited, and responses carry a restrictive CSP. There is no TLS —
  put a reverse proxy (with `--trust-proxy`) in front for anything beyond
  localhost.
- **Run artifacts may contain sensitive data.** `.steamtrain/history/`
  records every step's full output in the project directory.
  `steamtrain init` offers to add `.steamtrain/` to your `.gitignore`;
  accept it (or add the entry yourself) so history never lands in commits.
- **Workflow specs execute commands.** A `steamtrain.json` from an
  untrusted source can run arbitrary shell via `command` steps and arbitrary
  agent prompts with your credentials. Review project configs like you would
  review a Makefile.
- **Agent subprocesses are spawned without shell interpolation**, and config
  files are schema-validated (zod) at load time.
