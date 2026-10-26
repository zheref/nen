// src/audit/osv.ts -- OSV's querybatch, then each returned id at its vuln
// endpoint for its severity (zheref/nen#508; ported from Hatsu's interim
// resolver's query()).
//
// THE DESTINATION IS THE ROW'S (AC-4): `endpoint` and `vulnEndpoint` come from
// the declaring contract and nowhere else, redirects are refused rather than
// followed, and the request carries one header, `content-type`. No credential,
// token or cookie of the caller's is attached -- there is none to attach,
// because nothing here reads the environment.
//
// NOTHING MALFORMED IS DROPPED (AC-7). A querybatch answer whose `results`
// is not an array of the asked length, a result that is not an object, a
// `vulns` that is not an array, an id that does not look like an advisory id,
// a non-2xx answer, a body over `maxResponseBytes`, a body that is not JSON,
// the `timeoutSeconds` budget running out, and an endpoint that cannot be
// reached are each NOT SCANNED, named. An id whose severity is missing or
// outside the row's `severityLevels` is UNRATED, and UNRATED COUNTS as a
// finding: an advisory nobody graded is not an advisory to ignore.
//
// TRANSPORT, said plainly. The runtime's `fetch` honours the host's proxy
// variables (HTTPS_PROXY, HTTP_PROXY, NO_PROXY) and its TLS trust store; those
// are the host's network configuration and are documented as such in USAGE.
// Over https a proxy carries the tunnel and cannot read or forge OSV's answer;
// what it can do is block it, which is NOT SCANNED, never clean.

import { isRecord, type AuditRow } from "./row.js";
import { NotScanned, notScanned, type Pin } from "./verdict.js";

/** The `fetch` this module calls; a parameter so a test can stand in for OSV. */
export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;

/** One advisory id, its severity as read, and every pin it was returned for. */
export interface Finding {
  readonly id: string;
  /** Upper-cased, or `UNRATED` when missing or outside `severityLevels`. */
  readonly severity: string;
  /** True when the severity is on the floor, or UNRATED. */
  readonly atFloor: boolean;
  readonly pins: readonly Pin[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MALFORMED = "OSV returned a malformed querybatch response";
const BATCH = 1000;
const MAX_PAGES = 20;
const VULN_CONCURRENCY = 10;

async function fetchRetry(fetcher: Fetch, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    // One retry on a network-level TypeError (a reset connection), never on a timeout.
    if ((error as Error | undefined)?.name !== "TypeError" || init.signal?.aborted === true) throw error;
    return fetcher(url, init);
  }
}

async function readJson(response: Response, row: AuditRow, url: URL): Promise<unknown> {
  if (!response.ok) notScanned(`OSV answered HTTP ${String(response.status)} at ${url.host}`);
  const reader = response.body?.getReader();
  if (reader === undefined) notScanned("OSV returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > row.maxResponseBytes) {
      await reader.cancel().catch((): undefined => undefined);
      notScanned(`OSV response exceeded ${String(row.maxResponseBytes)} bytes (maxResponseBytes)`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function queryAll(row: AuditRow, pins: readonly Pin[], fetcher: Fetch, signal: AbortSignal): Promise<Finding[]> {
  const hits = new Map<string, Pin[]>();
  for (let i = 0; i < pins.length; i += BATCH) {
    let pending = pins.slice(i, i + BATCH).map((pin: Pin): { pin: Pin; token: string | undefined } => ({ pin, token: undefined }));
    for (let page = 0; pending.length > 0; page += 1) {
      if (page > MAX_PAGES) notScanned(`OSV kept paging past ${String(MAX_PAGES)} pages`);
      const body = {
        queries: pending.map(({ pin, token }): Record<string, unknown> => ({
          package: { name: pin.name, ecosystem: row.ecosystem },
          version: pin.version,
          ...(token !== undefined ? { page_token: token } : {}),
        })),
      };
      const response = await fetchRetry(fetcher, row.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
      const answer = await readJson(response, row, row.endpoint);
      const results = isRecord(answer) ? answer["results"] : undefined;
      if (!Array.isArray(results) || results.length !== pending.length) notScanned(MALFORMED);
      const next: typeof pending = [];
      results.forEach((result: unknown, k: number): void => {
        const asked = pending[k] as { pin: Pin; token: string | undefined };
        if (!isRecord(result)) notScanned(MALFORMED);
        const vulns = result["vulns"];
        if (vulns !== undefined && !Array.isArray(vulns)) notScanned(MALFORMED);
        for (const vuln of (vulns ?? []) as unknown[]) {
          const id = isRecord(vuln) ? vuln["id"] : undefined;
          if (typeof id !== "string" || !ID.test(id)) notScanned("OSV returned a malformed vulnerability id");
          hits.set(id, [...(hits.get(id) ?? []), asked.pin]);
        }
        const token = result["next_page_token"];
        if (token !== undefined) {
          if (typeof token !== "string" || token === "") notScanned(MALFORMED);
          next.push({ pin: asked.pin, token });
        }
      });
      pending = next;
    }
  }
  const ids = [...hits.keys()].sort();
  const severities = new Map<string, string>();
  for (let i = 0; i < ids.length; i += VULN_CONCURRENCY) {
    await Promise.all(ids.slice(i, i + VULN_CONCURRENCY).map(async (id: string): Promise<void> => {
      const url = new URL(encodeURIComponent(id), row.vulnEndpoint);
      const vuln = await readJson(await fetchRetry(fetcher, url, { signal, redirect: "error" }), row, url);
      const specific = isRecord(vuln) ? vuln["database_specific"] : undefined;
      const raw = isRecord(specific) ? specific["severity"] : undefined;
      const severity = typeof raw === "string" ? raw.toUpperCase() : "";
      severities.set(id, row.severityLevels.includes(severity) ? severity : "UNRATED");
    }));
  }
  return ids.map((id: string): Finding => {
    const severity = severities.get(id) ?? "UNRATED";
    return { id, severity, atFloor: severity === "UNRATED" || row.severityFloor.includes(severity), pins: hits.get(id) ?? [] };
  });
}

/**
 * Query every pin and read every returned id's severity. Throws {@link NotScanned}
 * for every way the service could not be read; never returns a partial answer.
 */
export async function queryOsv(row: AuditRow, pins: readonly Pin[], fetcher: Fetch): Promise<Finding[]> {
  if (pins.length === 0) return [];
  const signal = AbortSignal.timeout(row.timeoutSeconds * 1000);
  try {
    return await queryAll(row, pins, fetcher, signal);
  } catch (error) {
    if (error instanceof NotScanned) throw error;
    const name = (error as Error | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError" || signal.aborted) notScanned(`OSV query timed out after ${String(row.timeoutSeconds)}s`);
    if (name === "SyntaxError") notScanned("OSV returned a response that is not JSON");
    notScanned(`OSV unreachable at ${row.endpoint.host}`);
  }
}
