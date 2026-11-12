import type { Seams } from "../seam/exec.js";
import { object, parseItem, type Item, type Tracker } from "./model.js";

const FIELDS = "__typename ... on Issue { number state url closedAt } ... on PullRequest { number state url closedAt }";
/** GraphQL batches fixed scope in groups of 50; no issue-by-issue subprocess loop. */
export function githubTracker(seams: Seams, target: string, cwd: string): Tracker {
  const [owner, name] = target.split("/");
  function graphql(query: string, variables: Record<string, unknown>): Record<string, unknown> {
    const result = seams.run("gh", ["api", "graphql", "--input", "-"], { cwd, stdin: JSON.stringify({ query, variables }) });
    if (result.spawnFailed || result.code !== 0) throw new Error("GitHub could not be read; check gh authentication and connectivity");
    const response = object(JSON.parse(result.stdout) as unknown);
    if (response.errors !== undefined) throw new Error("GitHub returned GraphQL errors");
    return object(response.data);
  }
  function scoped(raw: unknown): Item {
    const item = parseItem(raw);
    const url = new URL(item.url);
    const parts = url.pathname.split("/");
    if (url.protocol !== "https:" || `${parts[1]}/${parts[2]}`.toLowerCase() !== target.toLowerCase() || !["issues", "pull"].includes(parts[3] ?? "") || parts[4] !== String(item.number)) throw new Error("Tracker returned an item outside the requested repository");
    return item;
  }
  return {
    items(numbers): Item[] {
      const items: Item[] = [];
      for (let start = 0; start < numbers.length; start += 50) {
        const batch = numbers.slice(start, start + 50);
        const query = `query($owner:String!,$name:String!) { repository(owner:$owner,name:$name) { ${batch.map((n) => `n${n}:issueOrPullRequest(number:${n}) { ${FIELDS} }`).join(" ")} } }`;
        const repo = object(graphql(query, { owner, name }).repository);
        for (const n of batch) {
          const item = scoped(repo[`n${n}`]);
          if (item.number !== n) throw new Error(`Tracker returned the wrong item for #${n}`);
          items.push(item);
        }
      }
      return items;
    },
    query(query): Item[] {
      const items: Item[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      let expected: number | null = null;
      do {
        const response = graphql(`query($q:String!,$cursor:String,$owner:String!,$name:String!) { repository(owner:$owner,name:$name) { nameWithOwner } search(query:$q,type:ISSUE,first:100,after:$cursor) { issueCount nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } } }`, { q: `repo:${target} ${query}`, cursor, owner, name });
        const repository = object(response.repository);
        if (typeof repository.nameWithOwner !== "string" || repository.nameWithOwner.toLowerCase() !== target.toLowerCase()) throw new Error("Requested repository could not be verified");
        const data = object(response.search);
        if (!Number.isSafeInteger(data.issueCount) || (data.issueCount as number) < 0 || (data.issueCount as number) > 1000 || !Array.isArray(data.nodes)) throw new Error("Search is unreadable or exceeds GitHub's 1000-result limit");
        if (expected !== null && expected !== data.issueCount) throw new Error("Search changed during pagination; retry");
        expected = data.issueCount as number;
        items.push(...data.nodes.map(scoped));
        const page = object(data.pageInfo);
        if (typeof page.hasNextPage !== "boolean") throw new Error("Search pagination is unreadable");
        cursor = page.hasNextPage ? typeof page.endCursor === "string" ? page.endCursor : "" : null;
        if (cursor !== null && (!cursor || cursors.has(cursor))) throw new Error("Search pagination did not advance");
        if (cursor !== null) cursors.add(cursor);
        if (items.length > 1000) throw new Error("Search exceeds GitHub's result limit");
      } while (cursor !== null);
      if (items.length !== expected || new Set(items.map((i) => i.number)).size !== items.length) throw new Error("Search results are incomplete or changed while reading");
      return items;
    },
  };
}
