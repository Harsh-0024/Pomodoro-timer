# Releasing the Android app

The Android app is released with everything else: bump `version.py`, add a
`release_notes.py` entry, tag `vX.Y.Z`, push the tag. GitHub Actions
(`.github/workflows/release.yml`, job `android`) builds the pages, signs the
app and attaches `Muhurta-Pomodoro-android.apk` to the release. The website's
`download.html?os=android` always points at the latest one, and copies of the
app see it through Settings > About and the update notice.

## The signing key (do not lose it)

Android installs an update only if it is signed with the same key as the copy
already on the phone. The key lives on the owner's Mac in
`~/MuhurtaAndroidKey/` (`muhurta-release.jks` and `README-KEEP-SAFE.txt` with
its password). Keep a second copy somewhere safe (a password manager, an
encrypted drive). If it is lost, a new key means everyone has to uninstall the
app once to get updates.

GitHub holds it as two repository secrets (Settings > Secrets and variables >
Actions):

- `ANDROID_KEYSTORE_B64`: the keystore file, base64 (`base64 -i muhurta-release.jks`)
- `ANDROID_KEYSTORE_PASSWORD`: the password from `README-KEEP-SAFE.txt`

The workflow refuses to release an app signed with any other key: it checks
the certificate fingerprint in `RELEASE_CERT_SHA256`.

## Building on a Mac

    cd mobile
    python build_web.py          # templates/ + static/ -> mobile/www
    npx cap sync android
    cd android && ./gradlew assembleDebug     # a test copy (debug key)

A debug copy and a release copy are signed with different keys, so one cannot
be installed over the other: uninstall first (the history is in the account).
