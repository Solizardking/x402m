pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
    }
}

rootProject.name = "musebook-kotlin-x402-harness-client"
// Modified for Musebook: use the supplied local Pay Kit SDK.
val payKitSource = System.getenv("PAY_KIT_SOURCE_DIR")?.let { file(it) }
    ?: file("../../pay-kit-main")
require(payKitSource.resolve("kotlin/build.gradle.kts").isFile) {
    "PAY_KIT_SOURCE_DIR must point to the supplied pay-kit-main checkout"
}
includeBuild(payKitSource.resolve("kotlin"))
