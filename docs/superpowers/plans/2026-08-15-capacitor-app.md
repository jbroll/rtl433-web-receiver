# Capacitor App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Capacitor 7 Android and iOS shell for the existing dashboard, make source discovery explicit and reliable, and add reproducible Android and iOS compilation checks.

**Architecture:** `dashboard/build.js` remains the only web artifact producer. `app/capacitor.config.ts` points Capacitor at `../dashboard/dist`, and platform trees are generated once and committed. Dashboard source discovery uses the existing SSE stream as a bounded probe for an absent storage key, while an explicitly stored empty list stays empty.

**Tech Stack:** Vanilla JavaScript, Node test runner, Playwright, Capacitor 7, Android Gradle, Xcode, GitHub Actions, simple-ci.

## Global Constraints

- App ID and Android package: `com.rkroll.rtl433`
- App name: `rtl_433`
- `webDir: "../dashboard/dist"`
- `server.androidScheme` is `"http"`.
- Android uses Capacitor 7, internet and network-state permissions, and a network security base config with `cleartextTrafficPermitted="true"`.
- Build order is dashboard build, Capacitor sync, then platform build.
- An absent source key probes `location.origin` through SSE and adopts it only after `live` within 1500 ms.
- Probe failure on `reconnecting` or timeout removes the probe stream, open-map entry, source state, and received data, then selects Sources.
- A stored empty list performs no probe and selects Sources; a stored non-empty list selects Cards.
- Generated Android and iOS trees are committed; build output, local SDK configuration, and synced web assets are ignored.
- iOS verification is unsigned with `CODE_SIGNING_ALLOWED=NO`; creating an installable IPA is out of scope.

---

### Task 1: Make Dashboard Sources Explicit

**Files:**
- Modify: `dashboard/src/index.html`
- Modify: `dashboard/src/style.css`
- Modify: `dashboard/src/main.js`
- Modify: `dashboard/src/sources.js`
- Modify: `dashboard/src/stream.js` only if probe cleanup needs a public state hook
- Test: `dashboard/test/sources.spec.js`
- Test: `dashboard/test/sources.test.js`

**Interfaces:**
- `sources()` returns only the normalized stored list and may return `[]`.
- `loadSources()` records whether the key was absent, empty, or populated and exposes that state to startup without changing add/remove APIs.
- `openSource(base, handlers)` continues to return `{ base, state, close }`; `close()` remains the cleanup boundary.

- [ ] **Step 1: Add browser tests for the four required source cases.**

  Extend `dashboard/test/sources.spec.js` with tests that use a page served by a static HTTP server, a binding server with `location.origin`, a reload after removing the last source, and a second source added from a device-served page. Assert the selected tab through `aria-selected`, stored source list, source row count, and rendered device data.

- [ ] **Step 2: Add unit coverage for storage state and no fallback.**

  Update `dashboard/test/sources.test.js` so an absent key is distinguishable from `[]`, `sources()` returns `[]` for an explicitly empty list, malformed storage does not create an origin source, and a storage exception leaves successful adoption in memory while later saves are no-ops.

- [ ] **Step 3: Run the focused tests and verify they fail for the current implementation.**

  Run `node --test test/sources.test.js` and `npx playwright test test/sources.spec.js` from `dashboard/`. Expected: the new tests fail because the gear control, origin fallback, and startup behavior still exist.

- [ ] **Step 4: Replace the gear control with a fourth Sources tab.**

  Add `<button id="tab-sources" aria-selected="false">Sources</button>` after Cards, remove `#sources-toggle`, make `TABS` equal `['devices', 'log', 'cards', 'sources']`, and have `showTab()` render the existing `#view-sources` section. Delete the `#sources-toggle` rule and its fixed-position declarations, and change `#view-sources` from fixed positioning to a normal section with the existing border, padding, and width behavior.

- [ ] **Step 5: Implement stored-list-only loading and the bounded origin probe.**

  In `sources.js`, preserve the distinction between `localStorage.getItem(...) === null` and a parsed empty array, remove the `[location.origin]` fallback, and add the smallest startup-state accessors needed by `main.js`. In `main.js`, open `location.origin` only for an absent key, register it in `open` before synchronization, adopt it on `live`, and select Cards. `syncSources()` closes any open stream not in `sources()`, so while the probe is undecided the probe base must be treated as wanted — track the pending probe and exempt it from the prune loop until the probe resolves, or the startup `syncSources()` call will close the probe before it can report. On `reconnecting` or a 1500 ms timeout, call the same stream close and source cleanup path used by removal, clear source devices and aliases, and select Sources. The probe stream's `onMessage` and `onAlias` handlers remain the normal handlers, so messages received before adoption render normally. A successful adoption must save the origin and reuse the already-open stream rather than opening a second stream. `installSourcePanel()` remains installed at startup and retains the form and source-list wiring.

- [ ] **Step 6: Run the focused and complete dashboard tests.**

  Run `npm test` from `dashboard/`. Expected: all unit and browser tests pass, including the four new browser cases.

- [ ] **Step 7: Commit the dashboard change.**

  Run `git add dashboard/src dashboard/test && git commit -m "feat: make dashboard sources an explicit tab"`.

### Task 2: Add Capacitor Android and iOS Shell

**Files:**
- Create: `app/package.json`, `app/package-lock.json`, `app/tsconfig.json`, `app/capacitor.config.ts`, `app/.gitignore`
- Generate and commit: `app/android/`
- Generate and commit: `app/ios/`
- Modify generated: `app/android/app/src/main/AndroidManifest.xml`, `app/android/app/src/main/res/xml/network_security_config.xml`, `app/ios/App/App/Info.plist`
- Test: `app` sync and platform build commands

**Interfaces:**
- `app/package.json` provides `cap sync android`, `cap sync ios`, and platform build support using `@capacitor/core`, `@capacitor/cli`, `@capacitor/android`, and `@capacitor/ios`, all on Capacitor 7.
- `app/capacitor.config.ts` exports `appId: "com.rkroll.rtl433"`, `appName: "rtl_433"`, `webDir: "../dashboard/dist"`, Android path `android`, iOS path `ios`, and `server.androidScheme: "http"`.

- [ ] **Step 1: Add the app manifest and exact Capacitor configuration.**

  Create the package manifest with this scripts block and Capacitor 7 dependencies, then install dependencies with `npm install`:

  ```json
  "scripts": {
    "sync:android": "cap sync android",
    "sync:ios": "cap sync ios",
    "build:android": "cap sync android && cd android && ./gradlew assembleDebug",
    "build:ios": "cap sync ios && xcodebuild -workspace ios/App/App.xcworkspace -scheme App -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO"
  }
  ```

  Create `capacitor.config.ts` using the exact identity and paths above.

- [ ] **Step 2: Generate the platform trees from the dashboard artifact.**

  Run `cd dashboard && npm run build`, then `cd ../app && npx cap add android && npx cap add ios && npx cap sync android && npx cap copy ios`. `cap sync ios` runs `pod install`, which exists only on macOS, so the local run uses `cap copy ios` for the web-asset half; the macOS runner in Task 4 runs the full sync. Keep the generated source trees in git, and add these exact generated-only paths to `app/.gitignore`: `android/app/build/`, `android/build/`, `android/.gradle/`, `android/local.properties`, `android/app/src/main/assets/public/`, `android/app/src/main/assets/capacitor.config.json`, `android/app/src/main/assets/capacitor.plugins.json`, `ios/build/`, `ios/DerivedData/`, and `ios/App/Pods/`.

- [ ] **Step 3: Configure Android cleartext LAN access.**

  Add `android.permission.INTERNET` and `android.permission.ACCESS_NETWORK_STATE` to the manifest, point `android:networkSecurityConfig` at `@xml/network_security_config`, and set that file to `<base-config cleartextTrafficPermitted="true" />`.

- [ ] **Step 4: Configure iOS local-network and cleartext access.**

  Add `NSLocalNetworkUsageDescription` to `Info.plist` with text explaining that the app connects to rtl_433 receivers and bridges on the local network. Add this ATS dictionary so cleartext HTTP LAN endpoints remain reachable without permitting arbitrary remote loads:

  ```xml
  <key>NSAppTransportSecurity</key>
  <dict>
      <key>NSAllowsLocalNetworking</key>
      <true/>
  </dict>
  ```

- [ ] **Step 5: Verify locally what this host can verify.**

  Run `cd dashboard && npm run build`, `cd ../app && npx cap sync android`, and `npx cap copy ios`. Expected: all three succeed. This host has no Android SDK, no JDK 21, and no Xcode, so compilation is deliberately not local: Android compilation is Task 3's `ci/android` job on `gpu`, and iOS compilation is Task 4's workflow on `macos-latest`. Do not run `./gradlew assembleDebug` or `xcodebuild` here.

- [ ] **Step 6: Commit the shell.**

  Run `git add app && git commit -m "feat: add Capacitor mobile shell"`.

### Task 3: Add Android simple-ci Job and Device Smoke Check

**Files:**
- Create: `ci/android`
- Create: `ci/simple-ci.conf`
- Modify: `.gitignore` only for job-generated manifests if required by simple-ci
- Test: `ci/android` shell execution and Android build

**Interfaces:**
- `ci/android` is an executable Bash simple-ci job named `ci/android`, targets host `gpu`, and leaves the debug APK in the job worktree.
- The job exports `JAVA_HOME=/usr/lib/jvm/openjdk21` and `ANDROID_HOME=$HOME/android-sdk` before invoking npm, Capacitor, or Gradle.

- [ ] **Step 1: Write a shell-level job test or dry-run assertions.**

  Verify the script is executable, contains the exact environment exports, runs dashboard build before `npx cap sync android`, and runs `./gradlew assembleDebug` from `app/android`. Verify the optional device path uses `if adb devices | grep -q '[[:space:]]device$'; then ... else echo 'device smoke skipped: no adb device'; fi` and reports skipped when no tablet is connected.

- [ ] **Step 2: Create the missing host workspace clone.**

  The simple-ci quickstart requires a clone at `gpu:~/ci-workspace/rtl433-web-receiver`, which the backlog records as not existing yet. Run `ssh gpu 'test -d ~/ci-workspace/rtl433-web-receiver || git clone <this-repo-url> ~/ci-workspace/rtl433-web-receiver'`, using the repository's own remote URL, and confirm the clone can fetch this branch.

- [ ] **Step 3: Implement the simple-ci configuration and job.**

  Follow the repository's existing simple-ci shape in `/home/john/src/KinoQ/ci/simple-ci.conf`: source `~/.config/simple-ci.conf` from `ci/simple-ci.conf`, set the job host to `gpu` in that config, and do not store host details in the repository. The executable job must run `npm ci` in `dashboard` and `app` as needed, build the dashboard, sync Android, assemble the debug APK, and then run the device check only when an adb device is present.

- [ ] **Step 4: Implement the CDP smoke path.**

  When a tablet is connected, install the debug APK with `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`, forward the WebView DevTools socket with `adb forward tcp:9222 localabstract:webview_devtools_remote`, and use a Node Playwright smoke script with `chromium.connectOverCDP('http://127.0.0.1:9222')` to launch the app, assert the empty Sources landing state, add a receiver, and assert receiver data renders. When no device is connected, print a skip line and return success.

- [ ] **Step 5: Run the job and platform verification.**

  Run `bash -n ci/android`, `./ci/android` through the configured simple-ci host, and the local dashboard/app build sequence. Expected: APK compilation succeeds; the device portion either passes or is explicitly skipped.

- [ ] **Step 6: Commit CI support.**

  Run `git add ci && git commit -m "ci: build Android app on gpu"`.

### Task 4: Add Unsigned iOS Workflow and Documentation

**Files:**
- Create: `.github/workflows/ios.yml`
- Create: `app/README.md`
- Create: `app/docs/development.md`
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/backlog.md`

**Interfaces:**
- The workflow runs on `macos-latest`, installs dependencies in `dashboard` and `app`, builds the dashboard, synchronizes iOS, runs unsigned `xcodebuild` with `CODE_SIGNING_ALLOWED=NO`, and uploads the build output.
- App docs cover local builds, platform sync, adb installation, CDP forwarding, and unsigned verification versus signed distribution.

- [ ] **Step 1: Add the GitHub workflow.**

  Create a workflow triggered by pushes and pull requests that checks out the repository, runs `npm ci` in `dashboard` and `app`, runs `npm run build` in `dashboard`, runs `npx cap sync ios` in `app`, invokes `xcodebuild -workspace ios/App/App.xcworkspace -scheme App -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -configuration Debug -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO`, and uploads `app/ios/DerivedData/Build/Products/Debug-iphonesimulator` as artifact `rtl433-ios-unsigned-build`.

- [ ] **Step 2: Write app documentation.**

  In `app/README.md` provide the app identity and one dashboard-build-to-platform-build example. In `app/docs/development.md`, use headings `Local Android`, `Local iOS`, `Platform Sync`, `Android Installation`, `CDP Smoke Check`, and `Unsigned Versus Signed`; document the exact Android and iOS build order, `npx cap sync` behavior, `adb install -r` installation, adb DevTools socket forwarding and CDP smoke checks, local-network cleartext requirements, and that signed distribution and IPA creation require Apple credentials and provisioning.

- [ ] **Step 3: Update permanent project documentation.**

  Update the root README project index and example to include `app/`. Update `docs/architecture.md` with the dashboard-build-to-Capacitor-sync data flow and committed/generated asset boundary. Remove the completed native-app, Android CI, and iOS workflow entries from `docs/backlog.md` while retaining unrelated backlog items.

- [ ] **Step 4: Run documentation and workflow validation.**

  Run `git diff --check`, parse `.github/workflows/ios.yml` as YAML with the repository's available tooling, and rerun the dashboard test suite plus the Android/iOS build commands. Expected: no whitespace errors, a valid workflow, and all platform checks pass or are unavailable only for explicitly reported environment reasons.

- [ ] **Step 5: Commit documentation and workflow.**

  Run `git add .github app/README.md app/docs README.md docs/architecture.md docs/backlog.md && git commit -m "docs: document Capacitor app builds"`.

### Task 5: Whole-Branch Review and Final Verification

**Files:**
- Review: all changes from the branch base through `HEAD`

- [ ] **Step 1: Run the complete verification matrix.**

  Run `npm test` in `dashboard`, the dashboard build plus `npx cap sync android` and `npx cap copy ios`, the `ci/android` job on `gpu` (which performs `./gradlew assembleDebug`), `git diff --check`, and `git status --short`. The unsigned `xcodebuild` is verified by the Task 4 workflow on `macos-latest`, not locally. Record device smoke as passed or skipped with its reason.

- [ ] **Step 2: Review the branch against the design spec.**

  Check every requirement in `docs/superpowers/specs/2026-08-15-capacitor-app-design.md`, including probe cleanup, storage failure behavior, generated-tree ignore rules, exact app identity, CI environment variables, and documentation updates. Fix any Critical or Important finding before completion.

- [ ] **Step 3: Remove the working plan.**

  After the delivered behavior is documented, remove `docs/superpowers/plans/2026-08-15-capacitor-app.md` from the final branch as required for working plans.
