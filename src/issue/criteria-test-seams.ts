// Existing issue fixtures explicitly declare an empty comment page for the
// added criteria-source read. Tests of comment behavior script their own pages.
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
export class CriteriaTestSeams extends ScriptedSeams {
  constructor(script: readonly ScriptedCall[], options?: ConstructorParameters<typeof ScriptedSeams>[1]) {
    super(script.flatMap((call): ScriptedCall[] => {
      const match = /^gh api (repos\/[^/]+\/[^/]+\/issues\/\d+)$/.exec(call.match);
      if (match === null || script.some((other) => other.match.startsWith(`gh api ${match[1]}/comments`))) return [call];
      return [call, { match: `gh api ${match[1]}/comments?per_page=100&page=1`, result: { stdout: "[]" } }];
    }), options);
  }
}
