// TEST FIXTURE -- the desktop lane's build file. The block below is the
// marker, spelled the way the DSL spells it: the receiver is `compose.desktop`
// and `application` is a block INSIDE it, so `compose.desktop.application`
// never appears as one literal anywhere in a real file either.
plugins {
    id("org.jetbrains.compose")
}

compose.desktop {
    application {
        mainClass = "placeholder.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
        }
    }
}
