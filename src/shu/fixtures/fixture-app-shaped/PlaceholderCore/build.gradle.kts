// TEST FIXTURE -- the LIBRARY module. It applies no Android application
// plugin, which is what leaves it as the one module the settings file names
// that `{unitTestTask}` can be answered from.
//
// IT ALSO CARRIES THE SCREENSHOT PLUGIN, and that is what makes this tree the
// PROPOSED side of the `test` / `ui-test` cross-check: those two rows run that
// plugin's own task, so a lane that does not apply it anywhere gets a seat
// instead (see `markers/gradle-android/` and `expo-bare/android/`, which do
// not). It is applied HERE rather than in `app/` on purpose: several tests
// rewrite the application module's build file to prove the module classifier,
// and the evidence for a different rule must not vanish when they do.
plugins {
    id("org.jetbrains.kotlin.jvm")
    id("app.cash.paparazzi")
}
