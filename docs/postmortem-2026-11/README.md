# Postmortem data: four months of CI on Cloudflare Containers (2026-07-10 to 2026-11-10)

This folder backs the write-up about running all CI for one production repo on this runner design.

- `findings.md` — the numbers, the incident timeline and the verdict, each tied to a line in `analysis-output.txt`.
- `analysis-output.txt` — the full output of the analysis script, run 2026-11-12. Every figure in the write-up appears here.
- `list-prices-2026-11-12.json` — the GitHub-hosted and Blacksmith list prices used for the comparison, with source URLs and fetch date.

## What is not here

The raw inputs (GitHub Actions run and job records, Cloudflare container usage per day, CI log listings, git history) come from a private repository and include branch names, PR titles and account identifiers, so they are not published. The analysis script and raw data are kept in that repository; the output above is reproduced from them byte for byte.

Dollar figures are usage multiplied by Cloudflare list price, not an invoice. The Cloudflare usage API keeps 32 days, so some early days are estimates; `findings.md` marks which.

PR numbers in `findings.md` (for example #2591) refer to the private repository.
