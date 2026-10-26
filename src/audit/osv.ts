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
// TRANSPORT, said plainly. Certificate verification is FORCED on, per
// request (`tls: { rejectUnauthorized: true }`, F3 / SEC-4), so a host with
// NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn an unverified answer into a
// clean audit. Two parts of the host's environment still reach the query, and
// USAGE names both: the runtime's `fetch` honours the proxy variables
// (HTTPS_PROXY, HTTP_PROXY, NO_PROXY), and NODE_EXTRA_CA_CERTS, the one
// trust-store input it honours, can add a certificate authority. Over https a
// proxy carries the tunnel and cannot read or forge OSV's answer; what it can
// do is block it, which is NOT SCANNED, never clean.
//
// REDIRECTS ARE NOT FOLLOWED AND NOT RETRIED (N4). The fetch runs with
// `redirect: "manual"`, and any 3xx (or an opaque redirect) is NOT SCANNED,
// named as a redirect -- never posted a second time and never reported as an
// unreachable host. Only a connection-level failure is retried, once; any
// other rejection from `fetch` is the endpoint being unreachable (NOT
// SCANNED), and an error raised by this module's own code is not caught here
// at all, so it reaches the command as the wiring stop (exit 2) it is.

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

/** Connection-level failures, the only ones worth one retry: a reset or refused socket. */
const CONNECTION_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "UND_ERR_SOCKET", "ConnectionRefused", "ConnectionClosed"]);

function connectionFailure(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && CONNECTION_CODES.has(code);
}

/** The init every OSV request carries: no redirect followed, certificates verified whatever the host says. */
function requestInit(init: RequestInit): RequestInit {
  return { ...init, redirect: "manual", tls: { rejectUnauthorized: true } } as RequestInit;
}

async function send(fetcher: Fetch, url: URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetcher(url, requestInit(init));
    } catch (error) {
      if (init.signal?.aborted === true) throw error; // the timeout: reported by queryOsv
      if (attempt === 0 && connectionFailure(error)) continue;
      notScanned(`OSV unreachable at ${url.host}`);
    }
  }
}

async function readJson(response: Response, row: AuditRow, url: URL): Promise<unknown> {
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch((): undefined => undefined);
    notScanned(`OSV answered a redirect at ${url.host}, never followed`);
  }
  if (!response.ok) notScanned(`OSV answered HTTP ${String(response.status)} at ${url.host}`);
  const reader = response.body?.getReader();
  if (reader === undefined) notScanned("OSV returned no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      if (name === "TimeoutError" || name === "AbortError") throw error;
      notScanned(`OSV's answer was cut off at ${url.host}`);
    }
    const { done, value } = chunk;
    if (done) break;
    size += value.byteLength;
    if (size > row.maxResponseBytes) {
      await reader.cancel().catch((): undefined => undefined);
      notScanned(`OSV response exceeded ${String(row.maxResponseBytes)} bytes (maxResponseBytes)`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    notScanned("OSV returned a response that is not JSON");
  }
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
      const response = await send(fetcher, row.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
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
      const vuln = await readJson(await send(fetcher, url, { signal }), row, url);
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
    throw error; // nen's own failure: the command turns it into a wiring stop (exit 2), never a verdict
  }
}
