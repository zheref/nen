// Fixed public false-positive corpus, never caller-provided policy.
// Exact candidate bytes only; adding text or changing case is not an exception.
export const PUBLIC_EVIDENCE_PROSE = [{
  candidate: "matchingmanualcapturewithGitTree/buildproof/JUnitLCOVhashes",
  source: "https://github.com/zheref/nen/issues/580",
  reason: "Caller-owned build-verification prose explicitly established harmless in the public issue; original note bytes remain unchanged.",
}] as const;
