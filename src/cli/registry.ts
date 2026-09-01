// src/cli/registry.ts -- every verb family this binary carries, in ONE list.
//
// ONE LINE PER FAMILY, ALPHABETICALLY. That is a merge discipline, not a
// stylistic preference: verb families arrive from parallel sessions, and a
// registry whose entries are one import plus one array element -- in a canonical
// order -- makes two independent additions land in different places and merge
// without a conflict. A dispatcher with a `case` per subcommand would put every
// family's arrival on the same three lines of the same switch.
//
// A FAMILY IS NOT LISTED UNTIL IT DOES SOMETHING. An entry that printed "not
// implemented" would be a surface other repositories could start depending on
// before it means anything (../index.ts's own rule, carried here).
//
// THIS LIST IS THE MERGED UNION of zheref/nen#3's (PR #11) original fifteen
// and zheref/nen#4's (verbs/4-remainders) twenty-one, with four family NAMES
// that collided -- "parse", "pr", "release", "repo" -- resolved as ONE
// Command each carrying the UNION of both sides' subcommands (see each of
// those files' own header for how). "dev" also moved here from ../index.ts's
// three pre-registry commands: zheref/nen#4's dev/command.ts already covers
// 'test' (../index.ts's own pre-registry implementation) plus 'lint' and
// 'replay', so keeping a second, narrower hard-coded 'dev test' switch case
// alongside a fuller registered one would have been the exact "two entry
// points for one name" mistake this file's own discipline refuses everywhere
// else. 'bootstrap', 'schema' and 'version' stay pre-registry, unchanged --
// see ../index.ts's header for why those three specifically do.

import type { Command } from "./command.js";
import { backlogCommand } from "../backlog/command.js";
import { boardCommand } from "../board/command.js";
import { canonCommand } from "../canon/command.js";
import { changelogCommand } from "../changelog/command.js";
import { colorCommand } from "../color/command.js";
import { commitCommand } from "../commit/command.js";
import { devCommand } from "../dev/command.js";
import { effortCommand } from "../effort/command.js";
import { epicCommand } from "../epic/command.js";
import { fanoutCommand } from "../fanout/command.js";
import { gateCommand } from "../gate/command.js";
import { ideaCommand } from "../idea/command.js";
import { issueCommand } from "../issue/command.js";
import { labelCommand } from "../label/command.js";
import { labelsCommand } from "../labels/command.js";
import { loopCommand } from "../loop/command.js";
import { parseCommand } from "../grammar/command.js";
import { prCommand } from "../pr/command.js";
import { qualityCommand } from "../quality/command.js";
import { refCommand } from "../ref/command.js";
import { releaseCommand } from "../release/command.js";
import { repoCommand } from "../repo/command.js";
import { runCommand } from "../run/command.js";
import { scaffoldCommand } from "../scaffold/command.js";
import { splitCommand } from "../split/command.js";
import { stageCommand } from "../stage/command.js";
import { stopCommand } from "../stop/command.js";
import { tagCommand } from "../tag/command.js";
import { wakeCommand } from "../wake/command.js";
import { warmupCommand } from "../warmup/command.js";
import { watchCommand } from "../watch/command.js";
import { wcCommand } from "../wc/command.js";

export const COMMANDS: readonly Command[] = [
  backlogCommand,
  boardCommand,
  canonCommand,
  changelogCommand,
  colorCommand,
  commitCommand,
  devCommand,
  effortCommand,
  epicCommand,
  fanoutCommand,
  gateCommand,
  ideaCommand,
  issueCommand,
  labelCommand,
  labelsCommand,
  loopCommand,
  parseCommand,
  prCommand,
  qualityCommand,
  refCommand,
  releaseCommand,
  repoCommand,
  runCommand,
  scaffoldCommand,
  splitCommand,
  stageCommand,
  stopCommand,
  tagCommand,
  wakeCommand,
  warmupCommand,
  watchCommand,
  wcCommand,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command): boolean => command.name === name);
}
