// Marked issue comments provide a body-independent criteria source (#610).
import { GH, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { extractCriteria, type CriteriaReport } from "./criteria.js";
import type { IssueSectionsCatalogue } from "./shape.js";

export const CRITERIA_MARKER = "<!-- nen:issue-criteria -->";
export interface CriteriaSourceReport extends CriteriaReport {
  readonly criteriaSource: { readonly kind: "body" | "comment"; readonly url: string; readonly ignored: readonly string[] };
}

/** All pages are required; multiple active markers are ambiguous and refused. */
export function readIssueCriteria(seams: Seams, target: Target, number: number, body: string, catalogue: IssueSectionsCatalogue | null): CriteriaSourceReport {
  const marked: { body: string; url: string }[] = [];
  for (let page = 1; ; page += 1) {
    const result = seams.run(GH, ["api", `repos/${target.slug}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (result.code !== 0) throw new Error(`could not read ${target.slug}#${number}'s criteria comments: ${result.stderr}`);
    const comments: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(comments)) throw new Error(`could not read ${target.slug}#${number}'s criteria comments: expected an array`);
    for (const comment of comments as { body?: unknown; html_url?: unknown; node_id?: unknown }[]) {
      if (typeof comment.body !== "string") throw new Error("criteria comment has no body");
      if (!comment.body.replace(/\r\n?/g, "\n").trimStart().startsWith(CRITERIA_MARKER)) continue;
      if (typeof comment.html_url !== "string") throw new Error("marked criteria comment has no URL");
      if (typeof comment.node_id !== "string") throw new Error("marked criteria comment has no node identity");
      const provenance = seams.run(GH, ["api", "graphql", "-f", "query=query($id:ID!){node(id:$id){... on IssueComment{body url authorAssociation author{login} editor{login}}}}", "-f", `id=${comment.node_id}`]);
      if (provenance.code !== 0) throw new Error("could not read marked criteria comment provenance");
      const node = (JSON.parse(provenance.stdout) as { data?: { node?: { body?: string; url?: string; authorAssociation?: string; author?: { login?: string }; editor?: { login?: string } | null } } }).data?.node;
      if (node?.body !== comment.body || node.url !== comment.html_url) throw new Error("marked criteria comment changed during the provenance read");
      if (!["OWNER", "MEMBER", "COLLABORATOR"].includes(node.authorAssociation ?? "") || typeof node.author?.login !== "string" || (node.editor !== null && node.editor?.login !== node.author.login)) {
        throw new Error(`untrusted marked criteria comment: ${comment.html_url}; require repository owner/member/collaborator and intact author/editor provenance`);
      }
      marked.push({ body: comment.body, url: comment.html_url });
    }
    if (comments.length < 100) break;
    if (page >= 100) throw new Error("criteria comments exceed 100 pages; refusing a partial read");
  }
  if (marked.length > 1) throw new Error(`multiple active criteria comments: ${marked.map((comment) => comment.url).join(", ")}; retain one marker`);
  const selected = marked[0];
  const bodyUrl = `https://github.com/${target.slug}/issues/${number}`;
  return {
    ...extractCriteria(selected?.body ?? body, catalogue),
    criteriaSource: { kind: selected === undefined ? "body" : "comment", url: selected?.url ?? bodyUrl, ignored: selected === undefined ? [] : [bodyUrl] },
  };
}
