### Added

- `shu tools --install` adds `gem-user` alongside the existing lane-local Bashcov-only `gem` installer. It installs any declared unscoped Ruby gem with an exact stable pin into the current user’s gem home on macOS/Linux, checks Ruby >=3.2, bypasses `.gemrc`, reports prerequisites separately from the consumer reason, and verifies the declared version after installation. Presence-only probes, incompatible pins and unsupported hosts refuse before installation. Nen never installs a runtime, edits PATH/profiles, or installs project dependencies.
