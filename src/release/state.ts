import { emit, requireValue, VerbUsageError, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { GH } from "../seam/exec.js";

// A query can see draft releases by pending tag name. REST's by-tag endpoint
// only finds published releases. Require a viewer allowed to see drafts before
// interpreting null as absence. No release/tag mutation or asset download.
const QUERY = `query ReleaseState($owner:String!,$name:String!,$tag:String!,$cursor:String) {
  repository(owner:$owner,name:$name) {
    viewerPermission
    release(tagName:$tag) {
      id tagName isDraft updatedAt
      releaseAssets(first:100,after:$cursor) {
        totalCount nodes { id name size downloadUrl }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed response");
  return value as Obj;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value === "") throw new Error("malformed response");
  return value;
};
interface Asset { readonly id: string; readonly name: string; readonly size: number; readonly downloadUrl: string }

export function releaseState(context: CommandContext): number {
  const kind = requireValue(context.args, "kind", "The destination kind; github has readable release state.");
  if (kind !== "github") throw new VerbUsageError(`release state: destination kind '${plainLine(kind)}' has no supported state reader`);
  const repo = requireValue(context.args, "repo-slug", "The GitHub owner/name.");
  const tag = requireValue(context.args, "tag", "The exact tag's release to read.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some(part => part === "." || part === "..")) throw new VerbUsageError("--repo-slug must be owner/name");
  if (/[\u0000-\u0020\u007f-\u009f]/.test(tag) || tag.length > 1024) throw new VerbUsageError("--tag must be a nonempty tag without whitespace or control characters (at most 1024 characters)");
  for (const key of Object.keys(context.args.values)) if (!["kind", "repo-slug", "tag", "repo"].includes(key)) throw new VerbUsageError(`release state does not read --${key}`);
  if (context.args.positionals.length !== 2 || context.args.passthrough.length > 0) throw new VerbUsageError("release state takes flags only");
  const base = { contract: "nen.release.state/v0.1", kind, repo, tag };
  const fail = (reason: string): number => { emit(context.io, context.json, {...base,state:null,assets:null,reason:`could not look: ${reason}`}, [`release state: could not look: ${reason}`]); return 1; };
  const [owner, name] = repo.split("/");
  const assets: Asset[] = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null, snapshot: string | null = null;
  try {
    for (let page = 0; page < 1000; page++) {
      const result = context.seams.run(GH, ["api", "graphql", "--hostname", "github.com", "--input", "-"], { stdin: JSON.stringify({query:QUERY,variables:{owner,name,tag,cursor}}) });
      if (result.spawnFailed || result.code !== 0) return fail("GitHub query failed (credential, transport, timeout or tool failure); no release state established");
      const response = object(JSON.parse(result.stdout));
      if (response["errors"] !== undefined && (!Array.isArray(response["errors"]) || response["errors"].length !== 0)) return fail("GitHub returned query errors");
      const repository = object(object(response["data"])["repository"]);
      if (!["ADMIN","MAINTAIN","WRITE"].includes(String(repository["viewerPermission"]))) return fail("draft visibility requires an authenticated viewer with repository write access");
      if (repository["release"] === null) {
        if (page !== 0) return fail("release changed during the read");
        emit(context.io, context.json, {...base,state:"absent",assets:[]}, [`release state: ${plainLine(repo)} ${plainLine(tag)}: absent`]); return 0;
      }
      const release = object(repository["release"]), connection = object(release["releaseAssets"]), info = object(connection["pageInfo"]);
      if (release["tagName"] !== tag || typeof release["isDraft"] !== "boolean") return fail("release identity or state is unreadable");
      const total = connection["totalCount"];
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(connection["nodes"]) || typeof info["hasNextPage"] !== "boolean") return fail("asset connection is unreadable");
      const current = JSON.stringify([text(release["id"]),release["isDraft"],text(release["updatedAt"]),total]);
      if (snapshot !== null && snapshot !== current) return fail("release changed during asset pagination");
      snapshot = current;
      for (const node of connection["nodes"]) {
        const item = object(node), id = text(item["id"]), size = item["size"];
        if (ids.has(id) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return fail("duplicate or malformed asset evidence");
        const asset = {id,name:text(item["name"]),size,downloadUrl:text(item["downloadUrl"])};
        if (!asset.downloadUrl.startsWith("https://")) return fail("asset URL is unreadable");
        ids.add(id); assets.push(asset);
      }
      if (assets.length > total) return fail("asset count changed during the read");
      if (!info["hasNextPage"]) {
        if (assets.length !== total) return fail("asset evidence is incomplete");
        const state = release["isDraft"] ? "draft" : "published";
        emit(context.io, context.json, {...base,state,assets}, [`release state: ${plainLine(repo)} ${plainLine(tag)}: ${state}; ${assets.length} asset(s)`, ...assets.map(asset => `  ${plainLine(asset.name)} (${asset.size} bytes)`)]); return 0;
      }
      cursor = text(info["endCursor"]);
      if (cursors.has(cursor) || connection["nodes"].length === 0) return fail("asset pagination did not advance");
      cursors.add(cursor);
    }
    return fail("asset pagination exceeded 1000 pages");
  } catch { return fail("malformed or unavailable GitHub response"); }
}
