# Pinned shell coverage provisioning — Nen #443

Transmuter; provisioning only. Hatsu #148 owns its focused lanes and 80/85/90
floor. No Hatsu declaration is changed here.

## Selection and official sources

Read 2026-10-19:

- [Bashcov installation](https://github.com/infertux/bashcov/blob/master/INSTALL.md)
  distributes the tool as a RubyGem. Its [gemspec](https://github.com/infertux/bashcov/blob/master/bashcov.gemspec)
  requires Ruby `>= 3.2.0` for the selected 4.0.0 release.
- [RubyGems install reference](https://guides.rubygems.org/command-reference/#gem-install)
  documents exact `--version`, `--install-dir`, `--bindir`, `--no-document` and
  `--norc`. The latter is a command option, after `install`, on RubyGems 3.6.9.
- [Kcov installation](https://github.com/SimonKagstrom/kcov/blob/master/INSTALL.md)
  requires a native build and platform libraries, with macOS signing
  considerations. This change selects the smaller RubyGem installation surface.
- Bashcov's [runner](https://github.com/infertux/bashcov/blob/master/lib/bashcov/runner.rb)
  uses `BASH_XTRACEFD`. Bash 4.1+ is required for this mechanism: the macOS
  system Bash 3.2 smoke run produced an empty report and is unsuitable.

The closed `gem` installer accepts only `bashcov`, a complete numeric release
pin, a version-reading probe and darwin/linux hosts. It preflights existing
`ruby` and `gem`, then installs the declared release and its tool runtime
 dependencies beneath the lane's `.nen/tools/`. It runs no Bundler, project
installation, elevation, shell profile or PATH modification. RubyGems checks
that the chosen release can run on the existing Ruby. Runtime upgrades remain
a host prerequisite, never an installer fallback.

## Contract Hatsu #148 can adopt

Merge into `project` with the desired focused runner. Select an existing
compatible Ruby/RubyGems pair before running Nen; `ruby` and `gem` must refer
to that pair. The tools report lists this and the compatible Bash requirement.
Replace `/absolute/path/to/bash` with an already provisioned Bash 4.1+ executable.
Paths are relative to lane `cwd`.

```json
{
  "lanes": { "shell-focused": { "stack": "shell", "cwd": "." } },
  "toolchain": {
    "bashcov": {
      "version": "4.0.0",
      "installer": "gem",
      "probe": ["ruby", "-e", "Gem.use_paths(File.expand_path('.nen/tools/gems')); gem 'bashcov', '= 4.0.0'; require 'bashcov/version'; puts Bashcov::VERSION"],
      "versionFrom": "whole-line-stdout",
      "why": "Shell line coverage; existing Ruby >=3.2 and Bash >=4.1 required."
    }
  },
  "verbs": {
    "shell-focused": {
      "test": {
        "exe": "ruby",
        "argv": ["-e", "Gem.use_paths(File.expand_path('.nen/tools/gems')); load Gem.bin_path('bashcov', 'bashcov', '4.0.0')", "--", "--bash-path", "/absolute/path/to/bash", "--root", ".", "--", "scripts/focused-fixtures.sh"],
        "artifacts": ["coverage/lcov.info"],
        "why": "Execute and instrument focused shell fixtures with the pinned local tool."
      },
      "coverage": {
        "exe": "ruby",
        "argv": ["-e", "raise 'Missing or empty focused capture' unless File.file?('coverage/lcov.info') && File.size?('coverage/lcov.info')"],
        "artifacts": ["coverage/lcov.info"],
        "why": "Verify the existing nonempty LCOV capture for Nen to parse; run no fixtures."
      }
    }
  }
}
```

Provision with `nen shu tools --repo <hatsu> --lane shell-focused --only bashcov
--install`; preview with `--dry-run`. A successful gem command never certifies
the tool: Nen re-runs the declared version probe. Missing runtimes, failed
installation and wrong post-install versions remain failures. Only the selected
Bashcov release is pinned; RubyGems resolves its transitive runtime dependencies.
This is not a hermetic tool dependency lock.

Bashcov loads `.simplecov` from the consumer root. This dependency-free formatter
emits LCOV, already readable by Nen:

```ruby
SimpleCov.formatter Class.new {
  def format(result)
    File.open('coverage/lcov.info', 'w') do |out|
      result.files.each do |file|
        out.puts "SF:#{file.filename}"
        file.lines.each do |line|
          out.puts "DA:#{line.line_number},#{line.coverage}" unless line.coverage.nil?
        end
        out.puts 'end_of_record'
      end
    end
  end
}
```

Hatsu's kotoamatsukami test phase owns fixture execution and instrumentation:
`nen shu test --lane shell-focused` writes the LCOV capture. Both rows name the
same artifact so Nen can record capture provenance. Byakugan's coverage phase
only verifies and parses that existing capture; it never re-runs fixtures.
Hatsu must verify capture freshness before extraction and return missing or stale
captures to the test phase. The coverage row above checks presence and size,
not source-tree provenance by itself. Hatsu must also choose whether to reset or
merge SimpleCov result caches between focused runs. Nen erases no reports and
changes no consumer configuration.

## Real macOS smoke evidence

On 2026-10-19, installed Bashcov **4.0.0** with existing Ruby **3.4.4** /
RubyGems **3.6.9**, into ignored effort-local `.nen/tools/gems`. RubyGems installed
SimpleCov **1.3.2** as the tool's runtime dependency. No PATH/profile changed.
An existing Ruby executable was invoked by absolute path; pinned GNU Bash **5.3**
was source-built in ignored scratch solely for this demonstration, without
system installation or elevation.

The fixture deliberately leaves one branch unexecuted:

```bash
#!/bin/bash
value=covered
if [ "$value" = covered ]; then
  echo measured
else
  echo missed
fi
```

The real capture emitted:

```text
SF:<absolute-demo-root>/script.sh
DA:2,1
DA:3,1
DA:4,1
DA:6,0
end_of_record
```

A temporary Git fixture committed the script, then a comment-only touch. This
branch's `nen shu coverage --touched --base HEAD~1 --lane shell` executed Bashcov
against that fixture, parsed the LCOV and returned the result below. This
historical smoke combined capture and parsing solely to demonstrate Nen's
file-level LCOV join. It is not the Hatsu execution arrangement: the adopter
contract above puts execution/capture in `test` and extraction in `coverage`.

```json
{
  "total": { "lines": { "covered": 3, "total": 4, "percent": 75 } },
  "targets": [{ "name": "script.sh", "lines": { "covered": 3, "total": 4, "percent": 75 }, "band": "under-minimum" }],
  "touched": { "files": ["script.sh"], "matched": ["script.sh"], "unmatched": [] },
  "exitCode": 0
}
```

No threshold was requested: **75% deliberately proves an uncovered line**.
Hatsu #148 owns its lane selection and threshold checks. Local raw evidence:
`.nen/shell-coverage-demo/coverage/lcov.info` and
`.nen/shell-coverage-demo/nen-result.json`. Generated evidence is not shipped.
