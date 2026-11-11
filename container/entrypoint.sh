#!/usr/bin/env bash
# Run at most ONE GitHub Actions job, then exit so the container stops and
# billing stops with it. If no job arrives within IDLE_GRACE_SECONDS, exit
# anyway: GitHub hands a JIT runner ANY queued job with matching labels, so the
# job this container was minted for may already have been taken elsewhere.
#
# The only credential in here is RUNNER_JITCONFIG: single-use, one runner,
# deregistered after one job.
#
# `set -e` is deliberately off: the runner is backgrounded and every exit path
# is handled explicitly; -e would abort on the first non-zero poll.
set -uo pipefail

IDLE_GRACE="${IDLE_GRACE_SECONDS:-90}"
IDLE_SETTLE="${IDLE_SETTLE_SECONDS:-10}"

if [ -z "${RUNNER_JITCONFIG:-}" ]; then
  echo "RUNNER_JITCONFIG is empty: the dispatcher must inject it" >&2
  exit 1
fi

cd /home/runner || exit 1
log=/tmp/runner.log
: > "$log"
runner_pid=""

# Job detection uses TWO independent signals. The log phrase alone is not
# enough: a runner update can change its wording (GitHub force-updates old
# runners under a pinned image), and then an idle-exit would kill a runner
# that is genuinely building. Runner.Listener only spawns Runner.Worker to
# execute a job, so its existence IS the job.
job_started() {
  grep -q "Running job:" "$log" 2>/dev/null && return 0
  pgrep -f "Runner.Worker" >/dev/null 2>&1 && return 0
  return 1
}

# A platform rollout or maintenance SIGTERMs the container. Mid-job, ride it
# out inside the platform's force-kill window instead of killing the runner
# (which GitHub reports as "lost communication with the server", no logs).
# shellcheck disable=SC2329  # invoked via trap
on_sigterm() {
  if [ -n "$runner_pid" ] && kill -0 "$runner_pid" 2>/dev/null && job_started; then
    echo "SIGTERM mid-job: letting the job finish inside the force-kill window"
    waited=0
    while kill -0 "$runner_pid" 2>/dev/null && [ "$waited" -lt 840 ]; do
      sleep 5
      waited=$((waited + 5))
    done
  else
    echo "SIGTERM while idle: exiting"
    [ -n "$runner_pid" ] && kill -INT "$runner_pid" 2>/dev/null
  fi
  exit 0
}
trap on_sigterm TERM

# Clear the credential from this shell's environment once it is handed over.
jit="$RUNNER_JITCONFIG"
unset RUNNER_JITCONFIG
./run.sh --jitconfig "$jit" >"$log" 2>&1 &
runner_pid=$!
unset jit

got_job=0
for _ in $(seq 1 "$IDLE_GRACE"); do
  if job_started; then got_job=1; break; fi
  kill -0 "$runner_pid" 2>/dev/null || break
  sleep 1
done

# Assignment and the log line are not atomic: settle once more before giving up.
if [ "$got_job" -eq 0 ] && kill -0 "$runner_pid" 2>/dev/null; then
  sleep "$IDLE_SETTLE"
  if job_started; then got_job=1; fi
fi

if [ "$got_job" -eq 0 ] && kill -0 "$runner_pid" 2>/dev/null; then
  echo "idle-exit: no job within ${IDLE_GRACE}s (+${IDLE_SETTLE}s); deregistering"
  # SIGINT: actions/runner traps it and deregisters cleanly.
  kill -INT "$runner_pid" 2>/dev/null || true
  for _ in $(seq 1 15); do kill -0 "$runner_pid" 2>/dev/null || break; sleep 1; done
  # Last-moment reprieve: a job that landed during shutdown runs to completion.
  if kill -0 "$runner_pid" 2>/dev/null && job_started; then
    echo "idle-exit aborted: a job landed during shutdown"
  else
    kill -KILL "$runner_pid" 2>/dev/null || true
    tail -n 15 "$log" 2>/dev/null || true
    exit 0
  fi
fi

echo "job accepted; running it to completion"
# run.sh's exit code is the RUNNER's health, not the job's result (GitHub
# reports job failures itself). Non-zero here means the runner broke.
code=0
wait "$runner_pid" || code=$?
tail -n 5 "$log" 2>/dev/null || true
echo "runner exited with ${code}; container stops now"
exit "$code"
