# Threat model

Scope: the Worker, its Durable Objects, the runner images, and the GitHub App credentials. Out of scope: the security of the code your workflows run (that is your CI's threat model) and Cloudflare/GitHub platform compromise.

## Assets

- **A1 GitHub App private key / PAT.** Can register runners and, with Administration write, change repository settings. Highest value.
- **A2 Installation tokens.** One-hour, installation-scoped versions of A1.
- **A3 Webhook secret.** Lets the holder forge webhooks.
- **A4 JIT runner configs.** Each lets one runner take one job.
- **A5 Spend.** Container time on the deployer's Cloudflare account.
- **A6 Job integrity.** A job must run on a fresh machine, and only for allowed repositories.
- **A7 Operational data.** Job ids, repository names, spend (`/stats`).

## Trust boundaries

1. Internet → Worker `/webhook` (anyone can send requests).
2. Worker → GitHub API (authenticated with A1/A2).
3. Worker/Dispatcher → container (A4 crosses here).
4. Container → internet (job code, possibly untrusted).
5. Operator → `/stats`.

## Threats and mitigations

| # | threat (STRIDE) | example | mitigation | residual risk |
|---|---|---|---|---|
| T1 | Spoofing: forged webhook | attacker POSTs `workflow_job: queued` to mint runners and burn A5 | HMAC-SHA256 over the raw body, constant-time compare, before parsing; missing secret refuses all | if A3 leaks, attacker can start up to `MAX_CONCURRENT` containers that idle-exit in ~90 s (no job to take) and register runners for allowlisted repos only |
| T2 | Elevation: untrusted code on our runner | fork PR on a public repo runs on our container | public repos denied unless named in `ALLOW_PUBLIC_REPOS`; unknown visibility treated as public; SECURITY.md guidance on fork approvals | deployer opts a public repo in; private-repo fork workflows if enabled in repo settings |
| T3 | Elevation: credential theft from a container | job code reads env or metadata for the App key | key and installation tokens never leave the Worker; container env allowlist enforced in code; only the single-use JIT config is passed | job code can read its own JIT config (already consumed) |
| T4 | Elevation: cross-job contamination | a job leaves a backdoor for the next one | one container per job, destroyed on exit; ephemeral JIT runners take exactly one job | none within this design |
| T5 | Elevation: job for a non-allowlisted repo lands on our runner | org-scoped runner group shared with other repos | default `RUNNER_SCOPE=repo`; org scope documented to restrict the runner group to allowlisted repos and exclude public repos | misconfigured org runner group |
| T6 | Denial of wallet | flood of legitimate-looking queued jobs from an allowlisted repo | spend bounded by `MAX_CONCURRENT` × `MAX_JOB_MINUTES`; per-container DO alarm deadline; optional soft budget alert | bound is reached while abuse lasts; budget alert is log-only by design (gating strands real jobs) |
| T7 | Denial of service: pipeline stuck | lost webhooks, leaked slots, wedged registrations | reconcile against GitHub's queued list, sweep with two-read rule, exit reports, reaper, wedge detection, stranded list in `/stats` | GitHub or Cloudflare outage longer than the 6 h / 2 h retry walls |
| T8 | Tampering: malicious image supply chain | swapped runner tarball | runner and Node pinned by version and SHA-256; base image by tag | `ubuntu:24.04` tag and apt packages are not digest-pinned (pin the base digest if you need reproducibility) |
| T9 | Info disclosure: `/stats` | competitor reads job ids and repo names | bearer `ADMIN_TOKEN`, constant-time compare, 404 when unset | token leak |
| T10 | Tampering: cleanup deletes someone else's runner | reaper deletes a team's own self-hosted box | cleanup only touches `RUNNER_NAME_PREFIX` names, never within 10 min of mint, never on an unreadable state | another fleet using the same prefix |
| T11 | Repudiation | who started that container? | every spawn, exit (with reason), deadline kill, strand and reconcile is logged with job id and repo; Workers observability on | logs retention is Cloudflare's |
| T12 | Spoofing: timing attack on secrets | measure compare time on `/stats` or signatures | constant-time compares | none practical |
| T13 | DoS: oversized webhook bodies | multi-MB POSTs to exhaust CPU | 1 MB body cap before HMAC | Cloudflare request limits apply |

## Permissions held (least privilege)

Repo scope: Administration RW, Actions R, Metadata R. Org scope: Self-hosted runners RW (org), Actions R, Metadata R. Actions RW only with `UNWEDGE_CANCEL=1`. Administration RW is broader than this service needs (GitHub offers no narrower permission for repository runners); prefer org scope with a restricted runner group if that matters to you.

## Assumptions

- Cloudflare isolates containers from each other and from the Worker's secrets.
- GitHub's JIT runner configs are single-use and bound to one runner registration.
- The deployer keeps `wrangler.jsonc` vars under review (they are the allowlist).
