# Lessons

Each line is a failure seen running ephemeral runners on Cloudflare Containers in production, and the rule this codebase follows because of it. Format: **symptom → rule**.

## Spend and admission

1. A hard daily spend cap refused spawns; jobs sat `queued` for 24 h and expired silently → budgets alert, never gate. Bound spend structurally with `MAX_CONCURRENT` × `MAX_JOB_MINUTES`.
2. A stored "minutes used" counter drifted from reality after lost exit reports → derive usage from a ledger of start/end timestamps, never from a running counter.
3. Concurrency slots leaked when a read-modify-write raced an alarm across an `await` → mutate storage as deltas per key; never snapshot, await, then write the whole map back.
4. A burst of starts in the same second was refused by the platform → space container starts (`SPAWN_SPACING_MS`).
5. Platform `max_instances` below the dispatcher's own limit made admitted jobs fail to start → keep every class's `max_instances` ≥ `MAX_CONCURRENT`.

## Liveness and recovery

6. One failed status read marked a healthy container dead and freed its slot twice → declare a container dead only after two reads at least 30 s apart, with GitHub's job state as tiebreak.
7. A job whose runner was replaced mid-flight was never re-queued → key entries by container instance, and re-queue the displaced job when an instance is re-keyed.
8. Re-using a runner name across retries made GitHub reject registration ("already exists") → name every spawn uniquely: `<prefix>-<jobId>-s<spawnId>`.
9. The cleanup sweep deleted a runner registered seconds earlier, before its container connected → never reap a registration younger than 10 minutes.
10. The cleanup sweep only saw the first 30 runners → paginate every GitHub list call.
11. Transient 5xx on list calls aborted cleanup and reconcile for the whole tick → retry idempotent GETs with backoff; never retry POSTs blindly.
12. Generic "GitHub error" messages hid whether the cause was permissions, a missing install or an outage → name the cause per status code (403 permission, 404 not installed, 5xx upstream).
13. Webhooks dropped during deploys or outages left jobs queued forever → periodically reconcile against GitHub's own list of queued jobs.
14. Lost exit reports left slots occupied until the deadline → run a heartbeat alarm in each runner object, and treat the container's exit report as authoritative when it arrives.
15. Acting on an unreadable state (timeout, 5xx) deleted live runners → when state is unknown, do nothing and look again next tick.

## Platform behaviour

16. "There is no container instance that can be provided" was treated as a crash and stranded jobs → classify it as platform capacity and retry it on its own budget.
17. A container accepted, then never placed, exited with no reason in logs → retry no-instance exits a bounded number of times and record the reason on the stranded entry.
18. Retry budgets counted in attempts gave up in seconds during a long outage → budget retries in wall-clock time: 30 s steps for up to 2 h on capacity, 30 s rising to 90 s for up to 6 h on upstream errors.
19. Container env larger than 16,000 bytes failed the start with an opaque error → check env size before starting, and name the variable that is too big.
20. Deploys killed in-flight jobs → set `rollout_active_grace_period` ≥ the longest job, and have the entrypoint handle SIGTERM by finishing the current job.
21. Awaiting the container's `monitor()` promise held the Durable Object open and timed out → poll container state from an alarm instead of awaiting the monitor.
22. Durable Object calls failed with "instance is no longer active" after eviction → retry once with a fresh stub; answer 503 and let reconcile recover after that.
23. Two Durable Objects calling each other synchronously deadlocked under load → no re-entrant calls between objects; report with fire-and-forget fetches and let alarms reconcile.

## Runner lifecycle

24. Destroying the container on the `completed` webhook cut off the runner's final log upload → never destroy on `completed`; let the runner exit by itself, the deadline is the backstop.
25. Runners that booted but never got a job billed until the deadline → exit after an idle grace when no job has started, configurable as a var.
26. Idle detection from runner log lines missed jobs when the log format changed → detect a running job from two signals (log line or the `Runner.Worker` process), and settle briefly before exiting.
27. Jobs killed at the time limit looked like mysterious failures → record each deadline kill with job id and repo, visible in `/stats`.
28. A runner offline but still marked busy by GitHub blocked its job forever → detect "offline + busy" after 20 minutes, cancel the pinned run (opt-in), then delete the registration.
29. Every job started failing on the same day with no code change → GitHub stops serving runners far behind the latest release; keep the pinned runner version current.
