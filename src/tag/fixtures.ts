import type { ScriptedCall } from "../seam/scripted.js";
export const SHA="a".repeat(40);
export function proofCalls(ancestorCode=0): ScriptedCall[] {
  return [
    {match:"git remote get-url origin",result:{stdout:"https://github.com/zheref/example.git"}},
    {match:"gh variable get RELEASE_HOLD --repo zheref/example",result:{stdout:"false"}},
    {match:"git rev-parse --verify --quiet refs/tags/v0.9.0^{commit}",result:{stdout:"b".repeat(40)}},
    {match:"git rev-parse --verify --end-of-options abc123^{commit}",result:{stdout:SHA}},
    {match:"git fetch origin main",result:{}},
    {match:`git merge-base --is-ancestor ${SHA} origin/main`,result:{code:ancestorCode}},
    ...(ancestorCode === 0 ? [{match:`git ls-tree -r --name-only -z ${SHA} -- :(literal)changelog.d`,result:{}}] : []),
  ];
}
