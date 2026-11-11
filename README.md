# cf-container-runners

Ephemeral GitHub Actions self-hosted runners on [Cloudflare Containers](https://developers.cloudflare.com/containers/).

A Cloudflare Worker receives GitHub's `workflow_job` webhook. For each queued job whose labels match, it starts **one container**. The container registers a **just-in-time (JIT) runner**, runs exactly that one job, exits, and billing stops. Nothing runs between jobs, so **idle costs $0**.

## The 60-second version

**What:** `runs-on: [self-hosted, cf-runner]` in a workflow → a fresh 1 vCPU / 3 GiB container (or 4 vCPU / 12 GiB with `cf-runner-heavy`) boots, runs the job and disappears.

**Why:**
- **No VM to keep warm.** No autoscaler, no idle box, no patching. Every job gets a clean machine.
- **Bigger machines than the free hosted runners**, billed per second, only while a job runs.
- **Bounded worst case.** Spend can never exceed `MAX_CONCURRENT` containers × `MAX_JOB_MINUTES` each. That bound is structural (a Durable Object alarm kills each container at its deadline), not a counter that can drift.
- **Secure by default.** Webhooks are HMAC-verified, the container only ever sees a single-use JIT config, only allowlisted repos are served, and public repos are refused unless you opt each one in.

**Who it's for:** a team with a Cloudflare **Workers Paid** plan that wants cheap, larger runners for **private** repos without running infrastructure.

```
GitHub ── workflow_job (queued) ──▶ Worker /webhook
                                     │ verify HMAC → allowlist → route label → class
                                     ▼
                              Dispatcher (Durable Object, singleton)
                                     │ admit under MAX_CONCURRENT, space starts
                                     │ POST generate-jitconfig (single-use runner)
                                     ▼
                         LightRunner / HeavyRunner (one DO + container per job)
                                     │ ./run.sh --jitconfig …  → one job → exit
                                     │ alarm every 15 s: liveness + hard deadline
                                     ▼
                              container exits → billing stops
```

## Cost model

Cloudflare Containers bill **per second** while a container runs, for:

| resource | unit price (check the [current pricing page](https://developers.cloudflare.com/containers/pricing/)) |
|---|---|
| CPU | per vCPU-second of active use |
| memory | per GiB-second provisioned |
| disk | per GB-second provisioned |
| egress | per GB, beyond the included allowance |

Workers Paid includes a monthly allowance of each. A stopped container costs nothing, and a container here only exists for the length of one job (plus about a minute of boot and, if no job arrives, a 90-second idle exit).

**Estimate your bill:**

```
cost per job ≈ (job minutes + ~1.5 min boot) × 60 × (vCPU × cpu_price × cpu_utilisation
                                                    + GiB × mem_price
                                                    + GB  × disk_price)
monthly      ≈ Σ over jobs, minus the included allowance
worst case   = MAX_CONCURRENT × 60 min/hour × per-container-hour price
```

At list prices when this was written ($0.000020/vCPU-s, $0.0000025/GiB-s, $0.00000007/GB-s), a fully busy heavy container (4 vCPU, 12 GiB, 20 GB) costs at most about **$0.40/hour** and a light one (1 vCPU, 3 GiB, 6 GB) about **$0.10/hour**. CPU is billed on active use, so real jobs that wait on the network cost less.

Concurrency changes how fast a backlog drains, not what it costs: the same jobs take the same container-minutes at 4-wide or 40-wide.

The optional `SOFT_DAILY_BUDGET_MINUTES` logs `BUDGET ALERT:` once a day when crossed. **It never refuses a job.** See [docs/LESSONS.md](docs/LESSONS.md): a refused spawn leaves the job silently `queued` until GitHub expires it 24 hours later, which is worse than any bill.

## Deploy

You need: a Cloudflare account on **Workers Paid** (Containers require it), Docker running locally (wrangler builds the images), Node 20+ and pnpm.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<REPO_URL>)

> Replace `<REPO_URL>` with this repository's URL. The button clones the repo into your account and deploys it; you still do steps 1, 3 and 5 below.

### 1. Create a GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App** (under the organization if the repos belong to one).

- **Webhook URL:** `https://<your-worker>.<your-subdomain>.workers.dev/webhook` (you can fill this in after step 4)
- **Webhook secret:** a long random string (`openssl rand -hex 32`). Keep it for step 3.
- **Subscribe to events:** **Workflow job** only.
- **Where can this App be installed:** Only on this account.

**Permissions** (grant exactly these; nothing else is used):

`RUNNER_SCOPE=repo` (default, runners registered per repository):

| permission | access | used for |
|---|---|---|
| Repository → Administration | Read and write | `generate-jitconfig`, list and delete this service's runner registrations |
| Repository → Actions | Read-only | job status (liveness checks), listing queued runs (reconcile) |
| Repository → Metadata | Read-only | mandatory for every App |

`RUNNER_SCOPE=org` (runners registered to the organization):

| permission | access | used for |
|---|---|---|
| Organization → Self-hosted runners | Read and write | `generate-jitconfig`, list and delete runner registrations |
| Repository → Actions | Read-only | job status, reconcile |
| Repository → Metadata | Read-only | mandatory |

**Which token each call uses.** Every installation token is minted with `repositories: [<the job's repo>]`, so it can only touch the repository that owns the job: job status, queued runs, run cancel, and (repo scope) the runner endpoints. The one exception is org scope's `/orgs/{org}/actions/runners/*` calls (generate-jitconfig, list, delete): organization permissions don't ride on a repository-narrowed token, so those use an installation-wide token, and only those.

Only if you set `UNWEDGE_CANCEL=1`: raise **Repository → Actions** to **Read and write** (it cancels the run pinning a wedged runner).

Create the App, note its **App ID**, generate a **private key** (`.pem`), then **Install App** on the repositories you will allowlist (choose "Only select repositories").

> No App? A fine-grained personal access token with the same repository permissions works too (secret `GITHUB_PAT`). The App is preferred: its tokens are short-lived and scoped to the installation.

### 2. Configure

```bash
git clone <REPO_URL> cf-container-runners && cd cf-container-runners
pnpm install
```

Edit `wrangler.jsonc` → `vars`:

| var | default | meaning |
|---|---|---|
| `ALLOWED_REPOS` | `""` | **Required.** `owner/repo` or `owner/*`, comma separated. Empty serves nothing. |
| `ALLOW_PUBLIC_REPOS` | `""` | Public repos to serve anyway, by exact name. Read [SECURITY.md](SECURITY.md) first. |
| `RUNNER_LABELS` | `cf-runner=light,cf-runner-heavy=heavy` | `label=class` pairs. A job must request `self-hosted` and exactly one of these (plus optional `linux`, `x64`). |
| `MAX_CONCURRENT` | `4` | Containers alive at once, all classes together. |
| `MAX_JOB_MINUTES` | `60` | Hard kill per container. |
| `SOFT_DAILY_BUDGET_MINUTES` | `0` | Log-only alert threshold. `0` disables. |
| `RUNNER_SCOPE` | `repo` | `repo` or `org`. |
| `RUNNER_GROUP_ID` | `1` | Org scope only. |
| `RUNNER_NAME_PREFIX` | `ccr` | Runner names start with this; cleanup only touches this prefix. |
| `IDLE_GRACE_SECONDS` | `""` (90) | How long a booted runner waits for a job before exiting. |
| `SPAWN_SPACING_MS` | `2000` | Minimum gap between container starts. |
| `UNWEDGE_CANCEL` | `0` | `1` = auto-clear wedged runners (needs Actions: write). |
| `DISPATCH_ENABLED` | `1` | `0` = kill switch: start nothing. |

Then in `containers[]`, for each class:

- `max_instances` **≥ `MAX_CONCURRENT`**, or Cloudflare refuses starts the Dispatcher admitted;
- `rollout_active_grace_period` **≥ `MAX_JOB_MINUTES` × 60**, so a deploy never preempts a running job;
- `instance_type` to taste (Cloudflare's limits: up to 4 vCPU / 12 GiB / 20 GB per instance).

Don't need the heavy class? Delete its `containers[]` entry and `RUNNER_HEAVY` binding and drop it from `RUNNER_LABELS`.

### 3. Secrets

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET     # the webhook secret from step 1
npx wrangler secret put GITHUB_APP_ID             # numeric App ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < your-app.private-key.pem
npx wrangler secret put ADMIN_TOKEN               # optional: enables GET /stats
```

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`.

### 4. Deploy

```bash
npx wrangler deploy
```

This builds both images with your local Docker, pushes them to Cloudflare's registry and deploys the Worker. The first deploy takes a few minutes. Put the printed URL + `/webhook` into the App's webhook settings and check **Recent Deliveries** shows a green `ping`.

### 5. Use it

```yaml
jobs:
  build:
    runs-on: [self-hosted, cf-runner]        # light: 1 vCPU / 3 GiB
  test:
    runs-on: [self-hosted, cf-runner-heavy]  # heavy: 4 vCPU / 12 GiB
```

Check on it:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<your-worker>/stats
npx wrangler tail          # live logs
```

## Operating it

`/stats` shows live containers, the pending queue (and what each job waits on: `at-capacity`, `cf-capacity`, `spacing` or `github`), today's container-minutes, and three lists that should be empty:

- **`stranded`**: jobs the Dispatcher gave up on (each line says why). They will not self-heal: re-run the workflow.
- **`deadlineKilled`**: jobs killed at `MAX_JOB_MINUTES`.
- **`reconciled`**: jobs GitHub still listed as queued that we had no record of (lost webhooks). Occasional is fine; a steady stream means webhooks are failing.

Self-healing that runs without you: a cron tick every 5 minutes re-checks GitHub's queued jobs, reclaims containers whose exit report was lost (two reads + GitHub's word before declaring one dead), and deletes stale runner registrations this service minted (never one younger than 10 minutes, never another prefix).

## Updating the runner image

Both Dockerfiles pin three things; bump them together and redeploy:

- **Base image** `ubuntu:24.04@sha256:…`: the multi-arch index digest, last fetched **2026-11-11 (UTC)**. Get the current one read-only from the Docker Hub registry API (no Docker needed):

  ```bash
  TOKEN=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/ubuntu:pull" | jq -r .token)
  curl -fsSI -H "Authorization: Bearer $TOKEN" \
    -H "Accept: application/vnd.oci.image.index.v1+json" \
    -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json" \
    https://registry-1.docker.io/v2/library/ubuntu/manifests/24.04 | grep -i docker-content-digest
  ```

  Update the digest and the fetch date in the Dockerfile comments and here.
- **`RUNNER_VERSION` + `RUNNER_SHA256`**: from the [actions/runner releases](https://github.com/actions/runner/releases). GitHub refuses runners well behind the latest, so do this at least monthly.
- **`NODE_VERSION` + `NODE_SHA256`**: from `https://nodejs.org/dist/v<version>/SHASUMS256.txt` (the `linux-x64.tar.xz` line).

## Troubleshooting

| symptom | likely cause | fix |
|---|---|---|
| Job stays `Queued`, nothing in `/stats` | Webhook not arriving or refused | App → Advanced → Recent Deliveries: `401` = secret mismatch; `403` = repo not allowlisted or public; `not ours: …` = labels don't match `RUNNER_LABELS` exactly |
| `not ours: labels no minted runner carries` | Job asks for a label we don't mint | Use only `self-hosted` + one configured label (+ `linux`/`x64`) |
| Pending with `waitingOn: github` | `generate-jitconfig` refused | `wrangler tail` names the HTTP status: `403` = App permission missing, `404` = App not installed on the repo, `5xx` = GitHub outage (retried for up to 6 h) |
| Pending with `waitingOn: cf-capacity` | Cloudflare has no instance to give | Retried every 30 s for up to 2 h. Lower `MAX_CONCURRENT` or raise `SPAWN_SPACING_MS` if it is frequent |
| Pending with `waitingOn: at-capacity` | `MAX_CONCURRENT` reached | Expected under load; raise it (and `max_instances`) if waits hurt |
| `config error: …` in deliveries | Invalid `vars` | The message names the variable |
| Job fails with "lost communication with the server" | Killed at the deadline, or the container died | Check `deadlineKilled`; raise `MAX_JOB_MINUTES` (and the rollout grace period) |
| Every job dies right after starting | Runner version too old: GitHub refuses runners well behind the latest | Bump `RUNNER_VERSION` + `RUNNER_SHA256` in both Dockerfiles, redeploy |
| `WEDGED runner …` in logs | Runner offline but GitHub still thinks it is busy | Cancel that run by hand, or set `UNWEDGE_CANCEL=1` |
| `exited … reason=no-instance` | Container accepted, then not placed | Re-queued automatically up to 3 times, then stranded with that reason |

## When NOT to use this

- **Public repositories.** Anyone can open a pull request, and a self-hosted runner then runs their code on your account. Use GitHub-hosted runners. See [SECURITY.md](SECURITY.md).
- **Jobs that need Docker**: `services:`, `container:`, `docker build`, Testcontainers. There is no Docker daemon or privileged mode inside a Cloudflare Container.
- **More than 4 vCPU / 12 GiB / 20 GB disk**, GPUs, macOS, Windows or arm64.
- **Latency-critical tiny jobs.** Each job pays a cold boot (roughly a minute) on a fresh machine with no cache. A 5-second lint job is faster on a hosted runner.
- **Jobs that rely on a warm cache or local state** between runs. Every container is new; use `actions/cache` or bake dependencies into the image.
- **Jobs longer than a few hours**, or that need a fixed egress IP.
- **No Workers Paid plan.** Containers are not available on the free plan.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Tests run in plain Node with fakes for Durable Object storage, container handles and GitHub. No Docker or Cloudflare account needed.

Layout: `src/index.ts` (Worker: webhook, routes, cron), `src/dispatcher.ts` (queue + admission DO), `src/runner.ts` (per-container DO), `src/policy.ts` (every decision as a pure function), `src/github.ts` (App auth + REST), `src/routing.ts` (labels, allowlist, runner names), `src/env-guard.ts`, `src/signature.ts`, `container/` (images + entrypoint).

Further reading: [SECURITY.md](SECURITY.md), [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md), [docs/LESSONS.md](docs/LESSONS.md).

## License

MIT, see [LICENSE](LICENSE).
