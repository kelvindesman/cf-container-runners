# Postmortem data: four months of CI on Cloudflare Containers (2026-07-10 to 2026-11-10)

This folder backs the write-up about running all CI for one production repo on this runner design.

- `findings.md` — the numbers, the incident timeline and the verdict, each tied to a line in `analysis-output.txt`.
- `analysis-output.txt` — the full output of the analysis script, run 2026-11-12. Every figure in the write-up appears here.
- `list-prices-2026-11-12.json` — the GitHub-hosted and Blacksmith list prices used for the comparison, with source URLs and fetch date.
- `speed-output.txt` — CI run time per PR and job queue wait by era (old VMs vs containers).
- `ci_pr_run_durations.csv` — the raw rows behind it: one row per successful first-attempt PR run of the main CI workflow, 2026-06-26 to 2026-10-17 (4,559 rows: start time, era, wall minutes).
- `job_queue_waits.csv` — sampled successful jobs: start time, era, minutes queued, minutes running. Job names removed.
- `ci-run-duration-by-era.png` / `.svg` — the chart drawn from those rows.
- `github-actions-usage-2026-11-12.png`, `github-actions-performance-2026-11-12.png` — GitHub's own Actions usage and performance pages for the repo, last 90 days, captured 2026-11-12.

## What is not here

The raw inputs (GitHub Actions run and job records, Cloudflare container usage per day, CI log listings, git history) come from a private repository and include branch names, PR titles and account identifiers, so they are not published, except the two CSVs above, which carry only timestamps and durations. The analysis script and raw data are kept in that repository; the output above is reproduced from them byte for byte.

Dollar figures are usage multiplied by Cloudflare list price, not an invoice. The Cloudflare usage API keeps 32 days, so some early days are estimates; `findings.md` marks which.

PR numbers in `findings.md` (for example #2591) refer to the private repository.
