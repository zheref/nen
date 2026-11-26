### Added

- Add opt-in `approval_policy: merge-is-approval`, retaining one declared human approver while reporting readiness for their own PR's human merge decision. Keep other readiness conditions binding, identify a verified human merger without creating a review, and refuse this mode in bounded agent merge routes (#661).
