### Fixed

- `pr sections resolve --overrides` reads Hatsu's `pr.sections` envelope (`max`, `variants`, `$canon`), honors a consumer cap within the catalogue cap, and reports invalid nested cells at their actual pointers. Existing flat cell maps remain supported; metadata does not affect resolution. (NN-IS-#464)
