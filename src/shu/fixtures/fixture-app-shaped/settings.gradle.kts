// TEST FIXTURE -- the shape of a repository with two separate builds in one
// tree, from the inventory. Nothing here is run.
//
// `includeBuild` is DELIBERATELY HERE: it names a whole separate build brought
// in from a submodule, not a module of this one, and `detect` must not read it
// as a candidate for the unit-test task.
rootProject.name = "placeholder"

includeBuild("bankai/PlaceholderCore")

include(":app")
include(":PlaceholderCore")
