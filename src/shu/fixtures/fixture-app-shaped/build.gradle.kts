// TEST FIXTURE -- the root build file. It NAMES the Android application plugin
// the way a real root does, without applying it, which is why the marker the
// scan reports is the module's build file and never this one.
plugins {
    id("com.android.application") apply false
    id("org.jetbrains.kotlin.plugin.compose") apply false
}
