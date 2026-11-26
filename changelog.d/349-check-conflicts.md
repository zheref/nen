### Fixed

- `nen canon mirror check` reports a destination that holds a merge conflict as a conflict, naming the line, instead of calling it hand-edited. A marked orphan that holds a conflict is refused and left in place rather than deleted. A lone `=======` setext underline stays hand-written (zheref/nen#349).
