---
name: alpha
description: Warm a working copy and cut the branch an effort runs on. Use when a
  new effort starts, or when the caller invokes demo:alpha by name.
allowed-tools: Bash(git:*), Read, Write
model: opus
license: MIT
metadata:
  owner: fixtures
---

# alpha

Run `demo:alpha` first, before anything else touches the tree.

## 1. Invocation

```text
demo:alpha <descriptor>
```

`demo:beta` runs after this one. A body line that merely *mentions* the word
alpha, without the prefix, is left alone.

| Step | Verb |
|---|---|
| classify | `nen wc classify` |
