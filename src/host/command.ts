import { parseArgs } from "../cli/args.js";
import { emit, requireSubcommand, requireValue, refuseExtraPositionals, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { admitWorkload, HOST_STORE_ENV, supervise } from "./execute.js";
import { DEFAULT_CAPACITY, describeSlots, HostRefusal, initStore, openStore, slots } from "./store.js";

const USAGE = `nen host init --store <absolute-path> [--capacity <1..64>]
nen host status [--store <absolute-path>] [--json]
nen host run [--store <absolute-path>] -- <exe> [args...]
nen host _exec --store <path> --slot <n> --claim <id> --launch <step-id> -- <exe> [args...]

One host budget for participating local sessions and self-hosted CI, across
repositories, worktrees and accounts. NEN_HOST_STORE names that SAME absolute
provisioned directory in every account; no user-local or checkout fallback.
--repo is not read by this host-owned family.
Local Shu/CI adoption activates with NEN_HOST_ADMISSION=enabled. Unset reports
admission unavailable and an unprotected launch requiring serialized fallback.
Explicit host run always enforces admission, regardless of that rollout flag.
Explicit init provisions a NEW store (default capacity 1), never overwrites one.
Arrange shared group permissions during host setup; Nen never elevates itself.

run refuses immediately at capacity, naming owners (bounded wait 0ms). State
unreadable or unprovisioned, unknown ownership and unsupported platforms fail
closed. A dead coordinator, an old timestamp or a missing PID never reclaims a
slot. Normal completion AND successful group quiescence are required. Nested
participating commands inherit the parent's claim after group/ancestry proof.

POSIX process groups cover ordinary descendants. Commands deliberately escaping their session/group
and unwrapped third-party commands are outside this containment boundary.
Windows heavy execution refuses until an authoritative process-tree provider is
available. status and init do not launch heavy work. Internal _exec is solely the
supervisor handshake and requires the reserved claim's identity.

run inherits stdio; --json is supported only for init/status. A failed command or admission/state error returns 1; invalid arguments return 2.`;
const SUBCOMMANDS = ["init", "status", "run", "_exec"] as const;
function path(context: CommandContext): string {
  const value = context.args.values.store ?? context.seams.env[HOST_STORE_ENV];
  if (value === undefined || value === "") throw new HostRefusal("NEN_HOST_STORE / --store is missing; provision one host-shared budget. Nothing was launched.");
  return value;
}
export function hostAction(context: CommandContext): number {
  const verb = requireSubcommand("host", context.args, SUBCOMMANDS);
  if (verb === "run" || verb === "_exec") {
    if (context.args.positionals.length > 2) throw new VerbUsageError("command argv belongs after --");
  } else refuseExtraPositionals(context.args, 2);
  const values = context.args.values;
  const allowed = verb === "init" ? ["store", "capacity"] : verb === "_exec" ? ["store", "slot", "claim", "launch"] : ["store"];
  for (const flag of Object.keys(values)) if (!allowed.includes(flag)) throw new VerbUsageError(`--${flag} is not read by host ${verb}`);
  if (verb !== "run" && verb !== "_exec" && context.args.passthrough.length !== 0) throw new VerbUsageError(`host ${verb} takes no passthrough command`);
  if (verb === "init") {
    const text = values.capacity ?? String(DEFAULT_CAPACITY);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) > 64) throw new VerbUsageError("--capacity must be an integer 1..64");
    const store = initStore(path(context), Number(text));
    emit(context.io, context.json, { contract: "nen.host.init/v0.1", ...store }, [`host budget provisioned at ${store.root}: capacity ${store.config.capacity}, host ${store.config.hostId}`]);
    return 0;
  }
  if (verb === "status") {
    const store = openStore(path(context)); const owners = slots(store);
    emit(context.io, context.json, { contract: "nen.host.status/v0.1", ...store, owners }, [`host ${store.config.hostId}: capacity ${store.config.capacity}; ${owners.length} occupied`, ...(owners.length === 0 ? [] : [describeSlots(owners)])]);
    return 0;
  }
  if (context.json) throw new VerbUsageError(`host ${verb} inherits stdio and does not take --json`);
  const [exe, ...argv] = context.args.passthrough;
  if (exe === undefined || exe === "") throw new VerbUsageError(`host ${verb} requires -- <exe> [args...]`);
  if (verb === "_exec") {
    const slot = requireValue(context.args, "slot", "Internal supervisor slot"); const claim = requireValue(context.args, "claim", "Internal supervisor identity");
    if (!/^[1-9][0-9]*$/.test(slot) || !Number.isSafeInteger(Number(slot))) throw new VerbUsageError("--slot must be a positive integer");
    return supervise(path(context), Number(slot), claim, requireValue(context.args, "launch", "Internal unique per-step launch capability"), exe, argv);
  }
  const seams = { ...context.seams, env: { ...context.seams.env, [HOST_STORE_ENV]: path(context) } };
  const guard = admitWorkload(seams, "host run");
  try { return guard.seams.runInteractive(exe, argv).code === 0 ? 0 : 1; }
  finally { guard.finish(); }
}
export const hostCommand: Command = {
  name: "host", summary: "Admit heavy work against one shared host budget.", usage: USAGE,
  flags: { values: ["store", "capacity", "slot", "claim", "launch"] }, subcommands: SUBCOMMANDS,
  run: hostAction,
};
// Dependency-free CI entry uses this SAME parser/action, not a second guard.
export function standaloneArgs(argv: readonly string[]): ReturnType<typeof parseArgs> {
  return parseArgs(["host", ...argv], { values: ["store", "capacity", "slot", "claim", "launch"], booleans: ["json", "help"] });
}
