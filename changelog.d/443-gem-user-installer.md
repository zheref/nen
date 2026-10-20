### Added

- `shu tools --install` can install an exactly pinned Ruby gem into the current user's gem home on macOS and Linux. It checks for Ruby 3.2 or later, refuses incompatible gem pins and unsupported hosts, and re-probes the declared tool after installation. The new `gem-user` installer supports Bashcov provisioning for Hatsu's shell coverage work (zheref/nen#443).

### Fixed

- A RubyGems prerelease such as `3.3.0.pre.1` is no longer mistaken for the pinned stable `3.3.0` by `first-semver-on-stdout` probes.
