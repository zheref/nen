// src/spec/tasks.ts -- `nen spec tasks groups`: a folder's tasks.md as
// story-grouped, dependency-ordered task groups, each rendered as the issue
// body a dispatch files (zheref/nen#493 AC-9; Hatsu docs/config/spec-repo.md §
// The issue a dispatch files).
//
// THE GROUPING IS THE FILE'S OWN. A task is a `- [ ] T<nnn> …` / `- [x] …` line;
// its story is its `[US<k>]` tag, else the `User Story <k>` / `US-<k>` its
// phase heading names; its platform is its `[platform:<name>]` tag, else the
// nearest `### Platform: <name>` heading. A task with neither story nor
// platform belongs to its phase's group (Setup, Foundational).
//
// THE STATE IS COMPUTED, NEVER CLAIMED. A group with an open task is
// `clarifying` when its story heading or a requirement its tasks name carries
// a marker in spec.md (a story holding any marker is excluded from every
// dispatch), else `open`; a group whose every task is ticked is `delivered`
// when each says `delivered`, else `captured`.
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

import { markersIn, proseLines, requirementOf, trailingAnnotation } from "./lines.js";

export const SPEC_TASKS_CONTRACT = "nen.spec.tasks/v0.1";

export type GroupState = "open" | "clarifying" | "captured" | "delivered";
export type TasksVerdict = "grouped" | "refused" | "could-not-read";

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

const TASK = /^\s*[-*]\s+\[([ xX])\]\s+(T\d{3,})\b(.*)$/;

export function parseTasks(text: string): Task[] {
  const tasks: Task[] = [];
  let phase: number | null = null;
  let phaseStory: number | null = null;
  let platform: string | null = null;
  for (const line of proseLines(text)) {
    const phaseHeading = /^##\s+Phase\s+(\d+)\b(.*)$/i.exec(line.text);
    if (phaseHeading !== null) {
      phase = Number(phaseHeading[1]);
      const story = /\b(?:User Story\s+(\d+)|US-?(\d+))\b/i.exec(phaseHeading[2] as string);
      phaseStory = story === null ? null : Number(story[1] ?? story[2]);
      platform = null;
      continue;
    }
    const platformHeading = /^#{3,6}\s+Platform:\s*(\S.*?)\s*$/i.exec(line.text);
    if (platformHeading !== null) {
      platform = platformHeading[1] as string;
      continue;
    }
    const match = TASK.exec(line.text);
    if (match === null) continue;
    const rest = match[3] as string;
    const tagStory = /\[US(\d+)\]/.exec(rest);
    const tagPlatform = /\[platform:\s*([^\]\s]+)\s*\]/i.exec(rest);
    tasks.push({
      id: match[2] as string,
      line: line.number,
      done: match[1] !== " ",
      delivered: match[1] !== " " && /\bdelivered\b/i.test(rest),
      story: tagStory === null ? phaseStory : Number(tagStory[1]),
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
    if (current !== null && /^\s*\d+\.\s+(?:\*\*)?Given\b/.test(line.text)) {
      ac += 1;
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
  return body.replace(/^\s*\d+\.\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
}

export interface TasksInput {
  readonly repo: string;
  readonly folder: string;
  readonly nnn: string;
  /** The spec repository commit the body pins, or null when unread. */
  readonly sha: string | null;
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
    if (first.story !== null) {
      const platform = first.platform ?? "all";
      title = `spec: ${story?.title ?? `User Story ${first.story}`} (F${input.nnn}/US${first.story} · ${platform})`;
      const qualify = (requirement: string): string => `F${input.nnn}-${requirement.replace(/-(\d+)$/, (_, digits: string): string => `-${digits.padStart(3, "0")}`)}`;
      const scenarios = story?.scenarios ?? [];
      const scs = requirements.filter((requirement): boolean => requirement.startsWith("SC-"));
      const verbatim = [...scenarios.map((scenario): string => scenario.text), ...scs.map((sc): string => lines.get(sc) ?? sc)].join("\n");
      const fence = fenceFor(verbatim);
      body = [
        `Spec: ${base.spec ?? `${input.folder}@<unread>`}`,
        "",
        `Requirements: ${requirements.filter((requirement): boolean => requirement.startsWith("FR-")).map(qualify).join(", ") || "none"} · Success criteria: ${scs.map(qualify).join(", ") || "none"}`,
        `Tasks: ${members.map((task): string => task.id).join(", ")} · Platform: ${platform} · Depends on: ${deps.join(", ") || "none"}`,
        "",
        ...(scenarios.length === 0 ? ["No acceptance scenario is written under this story yet."] : scenarios.map((scenario, index): string => `- AC-${index + 1}: ${scenarioSentence(scenario.text)} (F${input.nnn}-AC-${String(scenario.ac).padStart(3, "0")})`)),
        "",
        `${fence}source-data`,
        verbatim,
        fence,
        "",
      ].join("\n");
    }
    return { id, phase: first.phase, story: first.story, storyTitle: story?.title ?? null, platform: first.platform, state, tasks: members.map((task): string => task.id), requirements, dependsOn: deps, title, body };
  });
  return { contract: base.contract, verdict: problems.length === 0 ? "grouped" : "refused", repo: base.repo, folder: base.folder, spec: base.spec, groups, order, reason: problems.length === 0 ? (groups.length === 0 ? "tasks.md defines no T<nnn> task" : null) : problems.join("; ") };
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
    lines.push(`  ${group.id} ${group.state} · ${group.tasks.join(", ")}${group.dependsOn.length === 0 ? "" : ` · after ${group.dependsOn.join(", ")}`}${group.title === null ? "" : ` · ${group.title}`}`);
  }
  return lines;
}
