# Antigravity hook serialization regression (#543)

The native format is the unversioned [CLI hooks format](https://antigravity.google/docs/hooks?tab=cli), read 2026-10-26. Hook names map to definitions; SessionStart and Stop take direct handler arrays, and PreToolUse takes matcher groups. Ownership is the generated definition's name, so every top-level value remains a native definition. No hook is disabled.

`antigravity-native-hooks.json` is the complete expected output for `hooks.json`, with stamp `0.143.1` and root `/opt/demo`. `antigravity-legacy-hooks.json` preserves Nen 0.28.0's string-marker, generic-wrapper and PreInvocation mapping, reported rejected by agy 1.4.3 in #543. These static fixtures cover the format and migration; they are not a substitute for native parsing.

The opt-in test in `antigravity-native.test.ts` runs `agy plugin validate` against fresh generated hooks in a minimal plugin, then checks the legacy file is rejected. Set `NEN_TEST_AGY=1` when running that test through the selected focused lane. It prints the installed version and full validator reports, fails if the requested CLI is absent, and otherwise is explicitly skipped. The local available validator is agy 1.4.7; historical 1.4.3 execution is not claimed. Validation parses configuration and does not execute hook commands.
