A repository-shaped tree for the relative-link rewrite (zheref/nen#270):
`plugin/skills`, `plugin/agents` and `plugin/rules` are the sources, `docs/`
and `templates/` are what their links reach outside the mirror. The tests copy
it into a temporary directory and write the mirrors under `surfaces/<surface>/`
beside it, at the depths a real consumer commits them at.

Every relative link in the sources resolves where it is written, so a mirror
with a single dangling link is the generator's defect and nobody else's. The
forms that are carried AS WRITTEN (`~/`, a regex that only looks like a link,
`](a b)`, a footnote) are proved on strings in `../../links.test.ts`, not here,
because a link guard would read them as dangling in the source too.

`scripts/tool.sh`, which `warm` links to, is written by the test itself: this
repository tracks exactly one shell file (AK-11), and a link's suffix is all the
rewrite cares about.
