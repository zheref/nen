// src/spec/tasks.ts -- `nen spec tasks groups`: a folder's tasks.md as
// story-grouped, dependency-ordered task groups, each rendered as the issue
// body a dispatch files (zheref/nen#493 AC-9; Hatsu docs/config/spec-repo.md §
// The issue a dispatch files).
//
// THE GROUPING IS THE FILE'S OWN. A task is a `- [ ] …` / `- [x] …` line, with
// a Spec Kit `T<nnn>` id or, in Hatsu's id-less grammar (`[x] captured —
// <cite>`, `[ ]`, `[x] delivered — <PR>`), the id `L<line>`; its story is its
// `[US<k>]` / `[US-<k>]` tag, else the `User Story <k>` / `US-<k>` its nearest
// phase or story heading names; its platform is its `[platform:<name>]` tag,
// else the nearest `### Platform: <name>` heading (both tags are nen's
// proposal until Hatsu's spec-repo.md states them). A task with neither story
// nor platform belongs to its phase's group (Setup, Foundational).
//
// THE STATE IS READ FROM THE FILE'S OWN CLAIMS, NAMED AS CLAIMS. A group with
// an open task is `clarifying` when its story heading or a requirement its
// tasks name carries a marker in spec.md (a story holding any marker is
// excluded from every dispatch), else `open`; a group whose every task is
// ticked is `delivered` when each reads `delivered — <PR>` (Hatsu writes that
// only from a merged PR's Development link), else `captured`.
//
// THE ORDER. A story group depends on every phase group of an earlier phase
// (Spec Kit: user stories start after Setup and Foundational), and on the
// group of any task its own tasks name with `depends on T<nnn>`. Groups are
// ordered topologically, ties by first appearance; a cycle is refused by name.
//
// THE BODY QUOTES THE SCENARIOS AS SOURCE DATA (SP-4). Each acceptance
// scenario becomes one unfenced `- AC-<n>: Given … When … Then …
// (F<nnn>-AC-<###>)` row, numbered from 1, and the scenarios and success
// criteria are repeated verbatim inside a `source-data` fence one character
// longer than the longest backtick run they hold.

import { markersIn, proseLines, qualifiedId, requirementOf, trailingAnnotation } from "./lines.js";

export const SPEC_TASKS_CONTRACT = "nen.spec.tasks/v0.1";

export type GroupState = "open" | "clarifying" | "captured" | "delivered";
export type TasksVerdict = "grouped" | "no-tasks" | "refused" | "could-not-read";

export interface Task {
  readonly id: string;
  readonly line: number;
  readonly done: boolean;
  readonly delivered: boolean;
  readonly story: number | null;
  readonly platform: string | null;
  readonly phase: number | null;
  readonly requirements: readonly string[];
  readonly dependsOn: readonly string[];
  readonly text: string;
}

export interface TaskGroup {
  readonly id: string;
  readonly phase: number | null;
  readonly story: number | null;
  readonly storyTitle: string | null;
  readonly platform: string | null;
  readonly state: GroupState;
  readonly tasks: readonly string[];
  readonly requirements: readonly string[];
  readonly dependsOn: readonly string[];
  readonly title: string | null;
  readonly body: string | null;
  /** Why a story group renders no title or body, or null. */
  readonly note: string | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface TasksReport {
  readonly contract: string;
  readonly verdict: TasksVerdict;
  readonly repo: string;
  readonly folder: string;
  readonly spec: string | null;
  readonly groups: readonly TaskGroup[];
  readonly order: readonly string[];
  readonly reason: string | null;
}

/** A task line: Spec Kit's `- [ ] T012 …`, or Hatsu's id-less `- [ ] …` / `- [x] captured — <cite>` / `- [x] delivered — <PR>`. */
const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(?:(T\d{3,})\b)?(.*)$/;
/** `delivered — <PR>`: the claim Hatsu's tasks.md makes only from a merged PR's Development link, and the only one read as delivered. */
const DELIVERED = /\bdelivered\s+[—–-]{1,2}\s+(?:[A-Z][A-Z0-9]{1,7}-PR-#\d+|[A-Za-z0-9-]+\/[A-Za-z0-9._-]+#\d+|[A-Z][A-Z0-9]{1,7}#\d+|#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)/i;
const STORY_NAMED = /\b(?:User Story\s+(\d+)|US-?(\d+))\b/i;

export function parseTasks(text: string): Task[] {
  const tasks: Task[] = [];
  let phase: number | null = null;
  let headingStory: number | null = null;
  let platform: string | null = null;
  for (const line of proseLines(text)) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line.text);
    if (heading !== null) {
      const body = heading[2] as string;
      const phaseHeading = /^Phase\s+(\d+)\b(.*)$/i.exec(body);
      const platformHeading = /^Platform:\s*(\S.*?)$/i.exec(body);
      const story = STORY_NAMED.exec(body);
      if (phaseHeading !== null) {
        phase = Number(phaseHeading[1]);
        const named = STORY_NAMED.exec(phaseHeading[2] as string);
        headingStory = named === null ? null : Number(named[1] ?? named[2]);
        platform = null;
      } else if (platformHeading !== null) platform = platformHeading[1] as string;
      else if (story !== null) {
        // Hatsu's tasks.md groups gaps under story headings with no phase (docs/config/spec-repo.md, tasks.md row).
        headingStory = Number(story[1] ?? story[2]);
        platform = null;
      }
      continue;
    }
    const match = TASK.exec(line.text);
    if (match === null) continue;
    const rest = match[3] as string;
    const tagStory = /\[US-?(\d+)\]/i.exec(rest);
    const tagPlatform = /\[platform:\s*([^\]\s]+)\s*\]/i.exec(rest);
    tasks.push({
      id: match[2] ?? `L${line.number}`,
      line: line.number,
      done: match[1] !== " ",
      delivered: match[1] !== " " && DELIVERED.test(rest),
      story: tagStory === null ? headingStory : Number(tagStory[1]),
      platform: tagPlatform === null ? platform : (tagPlatform[1] as string),
      phase,
      requirements: [...new Set([...rest.matchAll(/\b(?:FR|SC)-\d+\b/g)].map((entry): string => entry[0]))],
      dependsOn: [...new Set([...rest.matchAll(/\bdepends on ((?:T\d{3,}(?:\s*,\s*|\s+and\s+)?)+)/gi)].flatMap((entry): string[] => [...(entry[1] as string).matchAll(/T\d{3,}/g)].map((id): string => id[0])))],
      text: rest.trim(),
    });
  }
  return tasks;
}

interface Story {
  readonly number: number;
  readonly title: string;
  readonly marked: boolean;
  /** Acceptance scenario lines, verbatim, with their folder-global number. */
  readonly scenarios: readonly { readonly ac: number; readonly text: string }[];
}

/** The stories, their acceptance scenarios (numbered folder-globally), and the marker state of each FR/SC line. */
export function readStories(spec: string): { stories: Map<number, Story>; marked: Set<string>; lines: Map<string, string> } {
  const stories = new Map<number, Story>();
  const marked = new Set<string>();
  const lines = new Map<string, string>();
  let current: { number: number; title: string; marked: boolean; scenarios: { ac: number; text: string }[] } | null = null;
  let ac = 0;
  let storyLevel = 0;
  for (const line of proseLines(spec)) {
    const requirement = requirementOf(line.text);
    const heading = /^(#{1,6})\s/.exec(line.text);
    if (requirement?.kind === "US") {
      storyLevel = heading === null ? 0 : (heading[1] as string).length;
      const title = line.text.replace(/^#{1,6}\s+(?:User Story\s+\d+|US-\d+)\s*[-–—:]?\s*/i, "").replace(/\s*\(Priority:.*$/i, "").replace(/\s*\[[^\]]*\]\s*$/g, "").trim();
      current = { number: Number(requirement.id.slice(3)), title, marked: markersIn(line.text).length > 0, scenarios: [] };
      stories.set(current.number, current);
      continue;
    }
    // A heading at the story's own level or above ends it (`### Edge Cases`, `## Requirements`).
    if (heading !== null && (heading[1] as string).length <= storyLevel) current = null;
    if (requirement !== null) {
      lines.set(requirement.id, line.text.trim());
      if (markersIn(line.text).length > 0) marked.add(requirement.id);
    }
    const scenario = /^\s*\d+\.\s+(?:\*\*AC-(\d+)\*\*:?\s*)?(?:\*\*)?Given\b/.exec(line.text);
    if (current !== null && scenario !== null) {
      // A written `**AC-###**:` label is the scenario's id (SP-10); an unlabelled one continues the folder-global count.
      ac = scenario[1] === undefined ? ac + 1 : Number(scenario[1]);
      current.scenarios.push({ ac, text: line.text.trim() });
      if (markersIn(line.text).length > 0) current.marked = true;
    }
  }
  return { stories, marked, lines };
}

/** The shortest fence of `char` longer than every run of it in `text`, at least three. */
export function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match): number => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** `1. **Given** a, **When** b, **Then** c. [src: …]` -> `Given a, When b, Then c.` */
export function scenarioSentence(text: string): string {
  const { citations, markers, malformed, ruled, stale } = trailingAnnotation(text);
  let body = text;
  for (const token of [...citations.map((entry): string => entry.text), ...markers.map((entry): string => entry.text), ...malformed, ...ruled.map((id): string => `[ruled: ${id}]`), ...stale]) body = body.replace(token, "");
  return body.replace(/^\s*\d+\.\s+/, "").replace(/^\*\*AC-\d+\*\*:?\s*/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

export interface TasksInput {
  readonly repo: string;
  readonly folder: string;
  readonly nnn: string;
  /** The spec repository commit the body pins, or null when unread. */
  readonly sha: string | null;
  /**
   * The member a platform names, for the plan.md pointer: Hatsu's plan.md keys its `## Platform: <member>`
   * sections by MEMBER, while a task's platform is `families[].members[].platform` (spec-repo.md, tasks.md
   * and plan.md rows). Null when the family declares no single member on that platform.
   */
  readonly memberFor?: (platform: string) => string | null;
}

export function taskGroups(input: TasksInput, specText: string, tasksText: string): TasksReport {
  const base = { contract: SPEC_TASKS_CONTRACT, repo: input.repo, folder: input.folder, spec: input.sha === null ? null : `${input.folder}@${input.sha}` };
  const tasks = parseTasks(tasksText);
  const { stories, marked, lines } = readStories(specText);
  const groupKey = (task: Task): string => (task.story === null ? (task.platform === null ? `phase-${task.phase ?? 0}` : `phase-${task.phase ?? 0}/${task.platform}`) : `US${task.story}/${task.platform ?? "all"}`);
  const grouped = new Map<string, Task[]>();
  for (const task of tasks) grouped.set(groupKey(task), [...(grouped.get(groupKey(task)) ?? []), task]);
  const ownerOf = new Map(tasks.map((task): [string, string] => [task.id, groupKey(task)]));
  const problems: string[] = [];
  const draft = [...grouped.entries()].map(([id, members]) => {
    const first = members[0] as Task;
    const deps = new Set<string>();
    if (first.story !== null) {
      for (const [other, otherTasks] of grouped) if ((otherTasks[0] as Task).story === null && ((otherTasks[0] as Task).phase ?? 0) < (first.phase ?? Number.MAX_SAFE_INTEGER)) deps.add(other);
    }
    for (const task of members) {
      for (const dep of task.dependsOn) {
        const owner = ownerOf.get(dep);
        if (owner === undefined) problems.push(`${task.id} depends on ${dep}, which tasks.md does not define`);
        else if (owner !== id) deps.add(owner);
      }
    }
    return { id, members, first, deps: [...deps] };
  });
  // Kahn's algorithm, ties by first appearance.
  const order: string[] = [];
  const pending = new Map(draft.map((group): [string, Set<string>] => [group.id, new Set(group.deps)]));
  while (pending.size > 0) {
    const ready = draft.find((group): boolean => pending.has(group.id) && [...(pending.get(group.id) as Set<string>)].every((dep): boolean => !pending.has(dep)));
    if (ready === undefined) {
      problems.push(`task groups ${[...pending.keys()].join(", ")} depend on each other in a cycle`);
      break;
    }
    order.push(ready.id);
    pending.delete(ready.id);
  }
  const groups: TaskGroup[] = draft.map(({ id, members, first, deps }): TaskGroup => {
    const requirements = [...new Set(members.flatMap((task): readonly string[] => task.requirements))].sort();
    const story = first.story === null ? null : (stories.get(first.story) ?? null);
    const open = members.some((task): boolean => !task.done);
    const clarifying = (story?.marked ?? false) || requirements.some((requirement): boolean => marked.has(requirement));
    const state: GroupState = open ? (clarifying ? "clarifying" : "open") : members.every((task): boolean => task.delivered) ? "delivered" : "captured";
    let title: string | null = null;
    let body: string | null = null;
    let note: string | null = null;
    if (first.story !== null && first.platform === null) note = "no platform is named for this story group (a [platform:<p>] tag or a '### Platform: <p>' heading); a dispatch title's tail is '(F<nnn>/US<k> · <platform>)', so no title or body is rendered";
    if (first.story !== null && first.platform !== null) {
      const platform = first.platform;
      title = `spec: ${story?.title ?? `User Story ${first.story}`} (F${input.nnn}/US${first.story} · ${platform})`;
      const qualify = (requirement: string): string => qualifiedId(input.nnn, requirement);
      const frs = requirements.filter((requirement): boolean => requirement.startsWith("FR-")).map(qualify);
      const scenarios = story?.scenarios ?? [];
      const scs = requirements.filter((requirement): boolean => requirement.startsWith("SC-"));
      const verbatim = [...scenarios.map((scenario): string => scenario.text), ...scs.map((sc): string => lines.get(sc) ?? sc)].join("\n");
      const fence = fenceFor(verbatim);
      body = [
        `Spec: ${base.spec ?? `${input.folder}@<unread>`}`,
        "",
        `Requirements: ${frs.join(", ") || "none"} · Success criteria: ${scs.map(qualify).join(", ") || "none"}`,
        `Tasks: ${members.map((task): string => task.id).join(", ")} · Platform: ${platform} · Depends on: ${deps.join(", ") || "none"}`,
        `Parity: ${input.folder}/parity.md · ${frs.length === 0 ? "no FR row" : frs.map((fr): string => `${fr} × ${platform}`).join(", ")}`,
        `Plan: ${input.folder}/plan.md § Platform: ${input.memberFor?.(platform) ?? `<the member on ${platform}, unresolved through families[]>`} (the section is keyed by member; this group's platform tag is ${platform})`,
        "",
        ...(scenarios.length === 0 ? ["No acceptance scenario is written under this story yet."] : scenarios.map((scenario, index): string => `- AC-${index + 1}: ${scenarioSentence(scenario.text)} (${qualifiedId(input.nnn, `AC-${scenario.ac}`)})`)),
        "",
        `${fence}source-data`,
        verbatim,
        fence,
        "",
      ].join("\n");
    }
    return { id, phase: first.phase, story: first.story, storyTitle: story?.title ?? null, platform: first.platform, state, tasks: members.map((task): string => task.id), requirements, dependsOn: deps, title, body, note };
  });
  // Zero tasks is its own answer, never a pass over nothing (Nobunaga F3).
  const verdict: TasksVerdict = groups.length === 0 ? "no-tasks" : problems.length === 0 ? "grouped" : "refused";
  return { contract: base.contract, verdict, repo: base.repo, folder: base.folder, spec: base.spec, groups, order, reason: problems.length === 0 ? (groups.length === 0 ? "tasks.md holds no task line ('- [ ] …', '- [x] …')" : null) : problems.join("; ") };
}

export function unreadableTasks(input: TasksInput, reason: string): TasksReport {
  return { contract: SPEC_TASKS_CONTRACT, verdict: "could-not-read", repo: input.repo, folder: input.folder, spec: null, groups: [], order: [], reason };
}

export function renderTasks(report: TasksReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.folder} -- ${report.reason ?? ""}`];
  const lines = [`${report.verdict}: ${report.folder} -- ${report.groups.length} group(s) in order ${report.order.join(" -> ") || "(none)"}${report.spec === null ? "" : ` · pinned ${report.spec}`}`];
  if (report.reason !== null) lines.push(`  ${report.reason}`);
  for (const id of report.order) {
    const group = report.groups.find((entry): boolean => entry.id === id) as TaskGroup;
    lines.push(`  ${group.id} ${group.state} · ${group.tasks.join(", ")}${group.dependsOn.length === 0 ? "" : ` · after ${group.dependsOn.join(", ")}`}${group.title === null ? "" : ` · ${group.title}`}${group.note === null ? "" : ` -- ${group.note}`}`);
  }
  return lines;
}
