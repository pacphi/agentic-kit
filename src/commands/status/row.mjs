// Shared row constructor for every `ak status` section. One row = one
// subsystem fact: a level (ok/info/warn/fail), a human message, and an
// optional `fix` string that `ak sync` uses to build its plan. Load-bearing:
// sync derives its plan from these exact fields, so no section may reshape
// this contract.
export const row = (subsystem, level, message, fix = null) => ({ subsystem, level, message, fix });
