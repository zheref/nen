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

import type { Command } from "./command.js";
import { backlogCommand } from "../backlog/command.js";
import { boardCommand } from "../board/command.js";
import { changelogCommand } from "../changelog/command.js";
import { colorCommand } from "../color/command.js";
import { fanoutCommand } from "../fanout/command.js";
import { gateCommand } from "../gate/command.js";
import { labelCommand } from "../label/command.js";
import { parseCommand } from "../grammar/command.js";
import { prCommand } from "../pr/command.js";
import { refCommand } from "../ref/command.js";
import { releaseCommand } from "../release/command.js";
import { repoCommand } from "../repo/command.js";
import { stopCommand } from "../stop/command.js";
import { wakeCommand } from "../wake/command.js";
import { warmupCommand } from "../warmup/command.js";

export const COMMANDS: readonly Command[] = [
  backlogCommand,
  boardCommand,
  changelogCommand,
  colorCommand,
  fanoutCommand,
  gateCommand,
  labelCommand,
  parseCommand,
  prCommand,
  refCommand,
  releaseCommand,
  repoCommand,
  stopCommand,
  wakeCommand,
  warmupCommand,
];

export function findCommand(name: string): Command | undefined {
  return COMMANDS.find((command): boolean => command.name === name);
}
