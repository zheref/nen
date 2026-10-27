### Added

- One host-shared capacity budget for participating local Shu invocations and same-host CI, defaulting to one heavy workload. Atomic owner claims, single-use per-step supervisor registration bound to request/coordinator identity, a pre-exec process-group handshake, inherited nested ownership and quiescence checks fail closed on unreadable or unresolved state. Host provisioning and shared interactive/CI adoption are explicit; Local/POSIX CI adoption is staged behind explicit activation; inactive launches visibly require the existing serialized fallback. Activated and explicit Windows launches refuse until an authoritative provider exists, while existing Windows CI remains unchanged and unprotected.

- Activated Shu rows with declared stall remedies refuse before admission until the owned remedy/cancellation integration is available; inactive behavior and dry runs retain their existing contract.

Document the complete host verb/JSON surface and use explicit current-runtime entry adapters for compiled, source and pre-install CI supervisor re-execution.
