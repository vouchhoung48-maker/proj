# App-scoped extensions

The app extension host is provider-neutral. Built-in delivery is an admission and packaging choice while the private contract stabilizes, not a different execution model. Moving a package outside this repository should change discovery/admission policy, not its activation code or the shared host.

## Admission and identity

`catalog.json` is app-owned policy: each admitted package maps its stable ID to a bundled relative directory and a host feature flag. A package cannot choose its own eligibility. Its manifest declares package version, compatible host contract, named activation entries, contributions, and requested capabilities; declarations do not grant authority or implement capabilities.

Policy errors and duplicate admissions are rejected for the requested package without disabling unrelated packages. Invalid JSON or records that cannot be decoded remain catalog-wide errors because the document cannot be interpreted reliably.

Static discovery validates IDs, declaration uniqueness, host compatibility, input schemas, contribution dependencies, and canonical path containment without executing JavaScript. App-owned Node activations can declare providers and canvases, including canvas-only activations. Provider metadata still exposes only the typed `provider.describe` capability. Requested capabilities do not imply a grant, and future unimplemented canvases belong in package documentation rather than the active contribution set.

Provider app requests are `app_extension_inspect` and `app_extension_describe_provider`, each taking a target with `packageId`, `activationId`, and `providerId`. The former is an inert developer diagnostic; the latter always obtains live typed metadata. Canvas requests use a distinct typed target with `canvasId`; provider and canvas IDs cannot collide in registration or routing. Neither surface accepts a filesystem path or an arbitrary operation dictionary.

## Activation lifetime

The host retains one generation per `(packageId, activationId)`, independent of projects, conversations, or provider count. Providers declared by that activation share its generation and runtime; separate activation keys are isolated. A running-generation UUID, hidden runtime session ID, and runtime discovery ID (`user:app-extension-control` within a private home) are not stable contribution identities.

An explicit description call stages one conventional bridge under a unique private control home, starts a dedicated SDK client with an exact-candidate launch resolver, and creates a no-turn session. The bridge completes the existing SDK stdio initialization, then invokes the package's default `activate(host)` export. Ordinary session clients, runtime code, and SDK APIs are unchanged.

A separate bounded loopback channel authenticates the activation using a per-generation credential and exact package/activation/generation/protocol identity. Each declared provider or canvas registers by ID and receives an acknowledgement. Canvas registration must match its exact declared action-name set. The activation must return a disposer and register exactly its declared contribution set before the host acknowledges readiness. A live child or runtime readiness timeout is not sufficient. Calls are correlated by activation identity, contribution ID, request ID, and, for canvases, logical instance ID.

The control process gets only a small OS environment allowlist plus explicitly replaced private-home settings, never the frontend WebSocket credential or ambient app secrets. SDK `env_remove` is applied last, so explicit private overrides are excluded from removal. This is isolation for trusted bundled code, not a sandbox against hostile same-user native processes.

Concurrent callers share startup. Provider or canvas callback errors leave valid registration intact; disconnects, missing/invalid registration, and protocol or call timeouts invalidate the generation. There is no automatic restart: another explicit description or canvas open/reopen may create a new generation after predecessor cleanup.

Startup uses one bounded deadline. Timeout errors identify the operation still pending (control-file preparation, runtime startup, session creation, or provider registration) without exposing private paths or credentials.

The selected host policy determines revocation. Feature-flag epochs preserve off/on revocation even if a subscriber sees only the later snapshot. Invalidation precedes bounded cleanup, and terminal app shutdown closes admission and retains force-stop access to both current and retiring runtimes. No helper enters visible session history or the app conversation database. The private home may contain runtime state files and is removed during normal cleanup; crash recovery is outside this slice.

CLI process diagnostics track these control runtimes under the `app_extension` role, including their child-process resource usage and package, activation, generation, and activation status. They are not also counted as untracked roots. Control session IDs and private credentials are not included in the ownership details.

## Evidence and scope

`src/app_extensions/fixtures/sample` is a test-only, differently named package with two providers and a canvas sharing one activation, an independent provider activation, and a canvas-only activation. Real-host Rust tests use the same catalog, admission, control runtime, bridge, and protocol as production. They exercise separate instances, generation and incarnation fences, delayed open/action versus close, gate revocation, and actual extension-process exit. The fixture is not shipped.

Azure DevOps is the first admitted package. Its rollout flag, catalog record, and narrowly targeted Debug tools action are the only provider-specific app configuration; its implementation stays in `azure-devops/`. Authentication, ADO network calls, repository/PR support, external installation/sharing, persistent recovery, and a general operation framework are not implemented here.

## App-owned canvases

`app_extension_list_canvases` inspects an admitted package without activation. `app_extension_open_canvas` takes a declared canvas target and input; the host allocates an opaque instance UUID. `app_extension_reopen_canvas` addresses an existing instance, and `app_extension_canvas_action` invokes one of that canvas's declared handlers. `app_extension_close_canvas` permanently closes the handle; another create gets a new UUID. Action and close calls include the expected generation and native incarnation.

Packages use `host.registerCanvas(id, { open, actions, onClose })`; each action has a `name` and `handler`. `open({ instanceId, input, reopen })` returns a loopback HTTP(S) URL and optional title. An action receives `{ instanceId, input }` and returns JSON. The host validates input using JSON Schema with external network/file resolution disabled, caps input and private frames, and rejects undeclared actions. `requires.forgeProvider` refers to a provider in the same activation, never an existing project.

App instances live only in memory. Versioned `app_extension_canvases_changed` snapshots use the existing backend-instance identity and a monotonic revision. Observers reconcile these events even when no canvas route is mounted, and read an inert `app_extension_canvas_state` snapshot on reconnect. Transport loss invalidates frontend rendering without activating anything. Closing or losing an activation removes renderable state before cleanup, and late callbacks cannot revive it.

The developer inspector opens a top-level main-content route using an already-created handle. Navigation hides the existing native child webview; reopening a ready instance keeps its state. Explicit recovery gets a new native incarnation, including when a recoverable canvas callback error left the activation alive. App instances join the existing native cleanup reconciler and use the existing isolated renderer, without session ownership, agent context, a privileged guest IPC bridge, or an iframe fallback. Legacy session canvases are unchanged.
