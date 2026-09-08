// TEST FIXTURE -- the lane's OWN settings file, which the profile's first
// marker names in its own words ("not the repository root's"). It includes the
// module whose build file carries the desktop block, so the tasks this lane's
// wrapper can address are that module's.
rootProject.name = "placeholder-desktop"

include(":desktop")
