# Findings: CI on Cloudflare Containers, 2026-07-10 to 2026-11-10

Every number comes from `data/analyze_output.txt` (regenerate: `python3 -I analyze.py`;
re-run 2026-11-12 00:42Z, output byte-identical). Dollar figures are usage x Cloudflare list
price, not an invoice (billing API 403, see README "Limits").

## What changed and when

- 2026-07-10: GitHub Actions jobs start running on ephemeral Cloudflare Containers (one
  container per job, exits after the job, $0 idle).
- 2026-07-20: the three GCP runner VMs are deleted. Containers are the whole fleet.
- 2026-10-17: the GitHub account hits a billing lock. From 12:47Z every Actions run ends
  `startup_failure` (511 such runs). Self-hosted runners do not help: no run means no job.
  Branch protection also goes (403 "Upgrade to GitHub Pro").
- 2026-10-18: "direct mode". The Cloudflare Worker takes the `pull_request` webhook itself,
  starts containers, and posts commit statuses. GitHub stays the git host and PR UI; Actions
  is out of the loop.

## Cost

| Window | Cloudflare $/day (observed days) |
|---|---|
| Actions era 07-27..10-17 (74 days) | $22.72 |
| Peak, 10-01..10-16 (agent PR flood) | $34.91 |
| Direct mode with a $ gate, 10-18..11-10 (24 days) | $17.77 |
| Whole period, best estimate incl. gap days | $19.88 (about $2,466 total) |

- 97 to 98% of all container spend is the CI heavy runner (4 vCPU / 12 GiB).
- Effective heavy price: $0.0039 per billed container-minute, because vCPU bills on actual use
  (about 41% busy). GitHub 4-core list is $0.012, Blacksmith 4 vCPU $0.008.
- Before: three GCP boxes, about $300/month (from commit messages, no invoice), doing about
  2,536 job-min/day. Sep-Oct on containers: about 7,312 job-min/day (2.9x the work for roughly
  2x the money).
- $ per merged PR by month: Jul 0.36, Aug 0.53, Sep 0.53, Oct 0.63, Nov 0.44. Worst week 0.88
  (W41, agent flood).

## Counterfactual for the same work (prices fetched 2026-11-12)

GitHub's own 90-day figure (554,030 job-min, 2026-08-14..11-11):

| Where | Cost |
|---|---|
| Cloudflare, actually billed (list) | about $1,608 |
| GitHub-hosted, 4-core heavy + 2-core light | $6,502 |
| GitHub-hosted, all 2-core (only shape a personal account can buy) | $3,288 |
| Blacksmith | $4,322 |

So containers cost about a quarter of GitHub-hosted 4-core and about 40% of the nearest
managed vendor, for this workload.

## What it cost in engineering

- 433 non-merge commits touched the CI system (ci-runner, runner-router, workflows) in 125 days;
  54% are `fix`. Active on 85 of 125 days. 94 commits touch only the runner code.
- That is the real price. The cloud bill is small next to it.

## Waste

- Failed or cancelled jobs: 13.4% of Actions-era job-minutes, about $225 of $1,681.
  GitHub's page says 9.4%.
- Direct mode: 12.8% of heavy spend (11-03..11-09) has no lane log (superseded, failed or idle).

## The GitHub dashboard is not the truth

- 25 of the 90 days in GitHub's window have zero Actions jobs, because CI ran in direct mode.
  Direct mode since 10-18: 15,492 lane logs, 2,364 tested commits, 104,016 heavy
  container-minutes, none visible on GitHub's usage page.
- Job count matches (our estimate 153,050 vs GitHub 151,091). GitHub's minutes are 1.28x ours
  (cause not checked; per-job rounding is a guess).

## Incidents (dates from git log and run data; fixes not re-tested)

| Date | What broke | Fix | Rule it left |
|---|---|---|---|
| 07-17..07-20 | "Runner lost communication" on about 10-14 runs/day. Looked like a Cloudflare flake; it was our own teardown killing live builds, because GitHub does not bind a JIT runner to the job it was minted for | #2591, then 7 fix PRs on 07-20 | Key teardown by the job a container is actually running, never by the job that spawned it |
| 07-21..07-22 | A ledger bug read 9,002 min/day, the hard daily cap refused every container | #2688 | Never put a hard minute cap on CI; bound spend by concurrency x per-job deadline |
| 08-22..08-24 | Google Cloud Storage returned 403 to Chrome downloads from containers; every zone e2e failed | #3989 (Chrome mirrored in R2) | Bake or mirror every download a job needs |
| 09-02 | False "could not heal" page, misdiagnosed by three sessions | #4716, #4736 | Record a container's exit reason; a watchdog that cannot see must say so |
| 10-17..10-18 | GitHub billing lock, every Actions run `startup_failure` | direct mode #7084 and follow-ups | Keep orchestration in your own code; treat Actions as replaceable |
| 10-21 | 10 lane containers exited: no instance free | #7206 | "No instance" is capacity, retry with backoff |
| 10-23 | One env var over 16,000 bytes, containers would not start | #7252 | Check env size before start |
| 10-18..10-31 | The $12/day gate read our ledger, not the bill; billed spend passed it on 8 of 14 days (max $37.50) | #7681 | Gate on billed spend, not your own bookkeeping |

Correction: the 07-22 commit says "173 runs queued about 23 h". Run data shows 88 runs created
07-20..07-22 took over 6 h from create to finish (57 of them still succeeded). The original
claim is not supported and must not be published.

## Verdict

- For a small team with heavy, bursty CI (many AI-agent PRs, Playwright e2e, big builds),
  per-second containers are the cheapest option measured here, at a quarter of GitHub-hosted.
- The bill is not the cost. Building it took 433 commits, more than half of them fixes, over
  four months. A managed runner vendor costs about 2.7x the cloud bill here (Blacksmith $4,322
  vs Cloudflare $1,608 for the same 90 days; at the 10-01..10-17 peak $72.93/day vs $33.56/day).
  Engineering hours were not measured, so whether the saving paid for the time is open; for a
  team paying salaried engineers it likely did not.
- Build it yourself only if: CI is more than about $1,000/month on hosted runners, someone owns
  it, and you need something vendors do not sell (here: surviving a GitHub billing lock).
