# Azure DevOps app extension

**Status: developer-only app-canvas hosting preview.** The app statically discovers this built-in package, but activation is off by default behind the local `azure_devops` feature flag. Explicit activation registers a read-only provider description and one repository-picker hosting shell. It does not enable Azure DevOps accounts, repository connection, or pull requests.

## Package contract

`manifest.json` describes a private app contract, not a Copilot CLI extension manifest or a public SDK. Its active declarations match implemented callbacks: `provider.describe`, the `repository-picker` canvas, and the canvas's `refresh-description` action. Deferred repository, authentication, and PR declarations were moved out of the manifest into the future-work section below; they must not satisfy the host's readiness barrier.

`app.mjs` exports `activate(host)` and uses the generic private `registerProvider` and `registerCanvas` contributions. The canvas is served by a package-owned loopback server and explicitly states that repository connection is not implemented. Its refresh action reads the same provider description, updates a per-instance count, and makes no ADO API call. There is no `extension.mjs`, `session.mjs`, or `joinSession()` in this package: ordinary user sessions must not independently activate it.

The stable identities are package `com.microsoft.azure-devops`, declared activation `app`, and provider `azure-devops`. A non-secret UUID identifies each running generation. The package does not depend on its built-in location or on the app's rollout flag; those belong to the host's admission policy. Its activation code can move with the package when external delivery is introduced.

## Activation lifetime

The generic [app extension host](../README.md) validates admission and declarations, retains a project-independent lifetime per package/activation, and authenticates exact provider and canvas registration over a private channel. This package uses the same facade as any admitted package. Its `requires.forgeProvider` dependency means the provider contribution is registered, not that a project must already exist. The host does not branch on Azure DevOps identity.

Repeated explicit calls use the live provider on the same generation. Disabling the host rollout flag, losing effective developer access (including Streamer Mode), or exiting the app revokes its lifetime. A subsequent explicit activation creates a fresh generation after cleanup; there is no automatic restart or helper in visible session history.

## Manual inspection

In **Settings > Debug tools**, use the developer-only **Inspect Azure DevOps extension** action. Opening the inspector reads the static descriptor and disabled/inactive status without starting an extension, and requires no project or conversation. Enable **Azure DevOps extension** in Experimental settings, then choose **Activate and describe**.

The inspector also lists the declared canvas. Open it to leave Settings and enter the app-owned canvas view. Refresh the description using the button inside the canvas. The app supplies only the title, close control, and availability/recovery states; it does not generate UI from declared actions. The declared host action remains available programmatically and invokes the same package handler. Reopen the retained instance from the inspector after navigating elsewhere and its count remains. Create another instance to see independent state, and close one without stopping the other or the provider.

Disable the flag to revoke calls and release the helper; re-enable and explicitly reopen to get a fresh generation. If the owned extension exits, pending calls fail and canvases become unavailable even when their route is hidden. Backend transport loss likewise makes guests unavailable until an authoritative reconnect snapshot arrives. Nothing restarts automatically, and app-canvas state is not restored across app restart.

## Authentication boundary

The future `authentication.getAccessToken` capability will be scoped to Azure DevOps repository accounts and the Azure DevOps resource. The intended host API returns an approved access token to the extension process, which makes ADO API requests directly. This is not host-mediated `provider.fetch`; the hosting preview requests no token capability.

Sign-in, consent, refresh, and persistent credential storage remain native. Tokens must not be sent to canvas UI, agent context, or persisted extension state. Repository authentication remains separate from inference and billing identity. The active metadata provider does not expose authentication or make ADO requests.

## Pull request client

`pull-requests.mjs` provides the provider-local REST client for the next integration slice. It is not registered by `app.mjs` yet: the host token API, repository binding, shared PR routing, and PR canvas are separate dependencies. Do not advertise PR capabilities as ready until those paths are connected.

The client targets the app-managed Node.js 24 extension process, not the canvas WebView. It uses the built-in `fetch`, `AbortSignal.timeout`, and `AbortSignal.any` APIs. No browser or older-Node compatibility layer is included.

```js
import { createPullRequestClient } from "./pull-requests.mjs";

const client = createPullRequestClient({
	repository: {
		organization,
		project,
		repositoryId,
		accountId: context.repositoryAccountId,
	},
	authentication: host.authentication,
});
```

The repository fields are a provider-local projection of the app's selected binding, not a proposed database schema. `repositoryId` is the ADO repository ID, not its display name. The client captures this target at construction; create a new client when the binding changes. Requests use the Azure DevOps Services `dev.azure.com` REST API, version 7.1. This does not add ADO Server or remote parsing.

| Method | Input and behavior |
| --- | --- |
| `create(input, options?)` | `title`, optional `description`, full `sourceRef` and `targetRef` (`refs/heads/...`), optional `draft` (default false). The app must commit and push first. |
| `get(id, options?)` | Fetch the current PR snapshot. No cache or background polling. |
| `complete(id, input, options?)` | Require `sourceCommitId` and an explicit `mergeStrategy`: `noFastForward`, `squash`, `rebase`, or `rebaseMerge`. `deleteSourceBranch` defaults to false. Never bypass policies or transition work items. |
| `abandon(id, options?)` | Set the selected PR to abandoned. |

All methods accept `{ signal }` as their final options argument and return the server's latest PR snapshot: `id`, `repositoryId`, `title`, `description`, `url`, `state`, `sourceRef`, `targetRef`, `sourceCommitId`, and `mergeStatus`. Unknown PR states and mismatched repository/PR identities are errors.

State mapping is `active` to `open` (or `draft` when `isDraft` is true), `completed` to `merged`, and `abandoned` to `closed`. A successful completion request may still return `active` while the merge is queued; use `get` to observe the final result. `mergeStatus` is retained as ADO data, not mapped to the app's GitHub merge-queue state.

The host supplies `authentication.getAccessToken({ accountId, resource: "azure-devops" })`. The client obtains a token for each call, does not cache it, and rejects redirects. Network requests have a 30-second timeout. HTTP failures throw `AzureDevOpsHttpError` with a numeric `status`; response bodies are not included in errors. Host, cancellation, and network errors propagate. No request is retried automatically: after an uncertain write result, reconcile with ADO before another create or update.

Cancellation stops this caller's wait for a token, not a host-owned refresh that other callers may share. Late token results cannot send an ADO request. A failed response-stream cleanup preserves the original HTTP error and status.

Sources: REST 7.1 [create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1), [get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/get-pull-request?view=azure-devops-rest-7.1), and [update](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/update?view=azure-devops-rest-7.1).

## Scope

The extension will own ADO API clients, repository discovery, PR behavior and status mapping, and canvas content. The app retains Git operations, repository/account bindings, shared PR indicators, and the native GitHub implementation.

Future work includes `repositories.connect`, `pullRequests.create`, `pullRequests.draft`, and `pullRequests.view`, the `pull-request` canvas, Azure DevOps account binding, and recognition of `https://dev.azure.com/*/*/_git/*` and `https://*.visualstudio.com/*/_git/*` remotes. These are design intent, not active capabilities. The future PR canvas remains unavailable rather than presenting fake PR UI.

This slice does not add account or database changes, session tools, model turns, external package discovery/installation/sharing, persistent recovery, or a general extension dashboard. Cloud and remote sessions, remote control, agent merge, merge when ready, My Work, work items, and automations remain outside its P0 declarations.
