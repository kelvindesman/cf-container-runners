# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** (Security → Advisories) on this repository rather than in a public issue. Include the version, configuration (redact secrets), and steps to reproduce. You will get an acknowledgement within a few days.

## What this service is trusted with

| asset | where it lives | who can read it |
|---|---|---|
| GitHub App private key / PAT | Worker secret | the Worker only; never sent to a container |
| Installation tokens (1 h) | Worker isolate memory | the Worker only; narrowed to the job's repository (org runner endpoints excepted, see README) |
| Webhook secret | Worker secret | the Worker only |
| JIT runner config | one container's env | that container's job, for that one job |
| Your Cloudflare bill | `MAX_CONCURRENT` × `MAX_JOB_MINUTES` | anyone who can make jobs queue (see below) |

## Controls

1. **Webhook authentication.** Every request to `/webhook` is checked with HMAC-SHA256 over the raw body against `GITHUB_WEBHOOK_SECRET`, compared in constant time, **before** the body is parsed. A missing secret refuses every webhook. Bodies over 1 MB are refused.
2. **JIT runners only.** Each container gets a config from `generate-jitconfig`: an ephemeral runner, pre-registered with one label, that takes **one** job and deregisters. No registration token, App key or installation token ever enters a container.
3. **Container env allowlist.** Only `RUNNER_JITCONFIG` and `IDLE_GRACE_SECONDS` may be passed to a container; anything else is refused by code, as is any value over Cloudflare's 16,000-byte limit (the error names the variable).
4. **Repository allowlist.** Jobs from repositories not in `ALLOWED_REPOS` are refused with `403`. An empty allowlist serves nothing; there is no allow-all mode.
5. **Public repositories are denied by default.** See below. Opt-in is per repository by exact name (`ALLOW_PUBLIC_REPOS`), never by wildcard. A repository whose visibility is unknown is treated as public.
6. **Strict label routing.** A job is served only if its labels are exactly `self-hosted` + one configured label (+ `linux`/`x64`). Runners register with that one label.
7. **Bounded spend.** At most `MAX_CONCURRENT` containers; each is destroyed by its own Durable Object alarm at `MAX_JOB_MINUTES`. Abuse can cost at most that bound for as long as it lasts.
8. **Closed admin surface.** `/stats` (job ids, repos, spend) requires `Authorization: Bearer $ADMIN_TOKEN` (constant-time compare) and returns 404 when the token is unset. `/health` returns `ok` and nothing else.
9. **Cleanup is scoped.** The reaper and wedge sweeper only touch runners whose names start with `RUNNER_NAME_PREFIX`, never one minted in the last 10 minutes, and only act on states read from GitHub (an unreadable state means "do nothing").
10. **Least-privilege App and tokens.** The exact permission set is in the README. Each installation token is minted with `repositories: [<job's repo>]`; only org-scoped runner registration calls use an installation-wide token, because organization permissions need one. Actions write is needed only for the opt-in `UNWEDGE_CANCEL`.
11. **Pinned images.** The `ubuntu:24.04` base is pinned by digest, and the runner and Node tarballs by version **and** SHA-256; the runner user is non-root (the heavy image adds passwordless sudo inside the single-use container; remove it if you don't need it).

## Public repositories: why they are denied

On a public repository, anyone can fork it and open a pull request. Workflows triggered by `pull_request` run the **fork's** code. On a GitHub-hosted runner that code runs on GitHub's machine; on a self-hosted runner it runs on **yours**, with internet access, for up to `MAX_JOB_MINUTES`, at your expense, and can try to reach anything the container can reach.

GitHub's own guidance is that self-hosted runners should almost never be used with public repositories. If you list one in `ALLOW_PUBLIC_REPOS` anyway:

- Under **Settings → Actions → General**, require approval for fork pull request workflows from **all outside collaborators**.
- Never trigger self-hosted jobs from `pull_request_target` or `workflow_run` with untrusted refs checked out.
- Treat every container as hostile: don't add secrets to those workflows that you would not hand to the PR author.

The same applies to **private** repositories that allow workflows from fork pull requests (Settings → Actions → "Fork pull request workflows in private repositories"). Keep that off, or require approval.

## Org-scoped runners

With `RUNNER_SCOPE=org`, a JIT runner is registered to the organization's runner group, and GitHub may assign it a job from **any** repository that group can use, not just the one it was minted for. The allowlist checks the webhook's repository, not the job the runner later picks. So:

- Restrict the runner group (`RUNNER_GROUP_ID`) to the allowlisted repositories ("Selected repositories").
- Leave the group's **Allow public repositories** unchecked.

`RUNNER_SCOPE=repo` (the default) has no such gap: a repo-level runner can only take that repository's jobs.

## Known limits

- The JIT config stays readable in the container's initial process environment (`/proc/1/environ`) for the life of the container. It is single-use and already consumed by the time a job step runs, so it is of no value to that job; the entrypoint also removes it from the environment the runner inherits.
- Containers have outbound internet access (the runner must reach GitHub). There is no egress filtering.
- GitHub does not sign which job a JIT runner will receive; matching is by label only. Use distinctive labels.
