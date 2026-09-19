/**
 * @typedef {{ organization: string, project: string, repositoryId: string, accountId: string }} AzureDevOpsRepository
 * @typedef {{ getAccessToken(input: { accountId: string, resource: "azure-devops" }): Promise<{ accessToken: string }> }} Authentication
 * @typedef {{ signal?: AbortSignal }} RequestOptions
 * @typedef {"open" | "draft" | "merged" | "closed"} PullRequestState
 * @typedef {"noFastForward" | "squash" | "rebase" | "rebaseMerge"} MergeStrategy
 * @typedef {{ title: string, description?: string, sourceRef: string, targetRef: string, draft?: boolean }} CreateInput
 * @typedef {{ sourceCommitId: string, mergeStrategy: MergeStrategy, deleteSourceBranch?: boolean }} CompleteInput
 * @typedef {object} PullRequest
 * @property {number} id
 * @property {string} repositoryId
 * @property {string} title
 * @property {string | null} description
 * @property {string} url
 * @property {PullRequestState} state
 * @property {string} sourceRef
 * @property {string} targetRef
 * @property {string | null} sourceCommitId
 * @property {string | null} mergeStatus
 */

const REQUEST_TIMEOUT_MS = 30_000;
const API_VERSION = "7.1";
const COMMIT_ID_PATTERN = /^[a-f0-9]{40}$/i;
const SUPPORTED_MERGE_STRATEGIES = [
	"noFastForward",
	"squash",
	"rebase",
	"rebaseMerge",
];

export class AzureDevOpsHttpError extends Error {
	/** @param {number} status */
	constructor(status) {
		super(`Azure DevOps PR request failed (HTTP ${status}).`);
		this.name = "AzureDevOpsHttpError";
		this.status = status;
	}
}

/**
 * Bind a client to one app-selected repository and account. Tokens are requested
 * per call; sign-in, refresh, and permission grants remain with the host.
 * @param {{ repository: AzureDevOpsRepository, authentication: Authentication, fetch?: typeof globalThis.fetch }} options
 */
export function createPullRequestClient({
	repository,
	authentication,
	fetch: requestFetch = globalThis.fetch,
}) {
	const accountId = requireString(repository.accountId, "account ID");
	const repositoryId = requireString(repository.repositoryId, "repository ID");
	const projectUrl = `https://dev.azure.com/${segment(repository.organization)}/${segment(repository.project)}`;
	const apiUrl = `${projectUrl}/_apis/git/repositories/${segment(repositoryId)}/pullrequests`;
	const webUrl = `${projectUrl}/_git/${segment(repositoryId)}/pullrequest`;

	/**
	 * @param {"GET" | "POST" | "PATCH"} method
	 * @param {number | undefined} id
	 * @param {Record<string, unknown> | undefined} body
	 * @param {AbortSignal | undefined} signal
	 * @returns {Promise<PullRequest>}
	 */
	async function request(method, id, body, signal) {
		const path = id === undefined ? apiUrl : `${apiUrl}/${id}`;
		const serialized = body === undefined ? undefined : JSON.stringify(body);
		signal?.throwIfAborted();
		const { accessToken } = await waitForAccessToken(
			authentication.getAccessToken({
				accountId,
				resource: "azure-devops",
			}),
			signal,
		);
		requireString(accessToken, "access token");
		signal?.throwIfAborted();

		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await requestFetch(`${path}?api-version=${API_VERSION}`, {
			method,
			redirect: "error",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${accessToken}`,
				...(serialized === undefined
					? {}
					: { "Content-Type": "application/json" }),
			},
			body: serialized,
			signal: requestSignal,
		});
		if (!response.ok) {
			const error = new AzureDevOpsHttpError(response.status);
			try {
				await response.body?.cancel();
			} catch {
				// Cleanup failure must not replace the known HTTP status.
				throw error;
			}
			throw error;
		}
		const data = await response.json();
		requestSignal.throwIfAborted();
		return readPullRequest(data, repositoryId, webUrl, id);
	}

	return {
		/**
		 * Create a normal or draft PR and return its current data.
		 * The app must commit and push the source branch before creation.
		 * @param {CreateInput} input
		 * @param {RequestOptions} [options]
		 */
		async create(
			{ title, description = "", sourceRef, targetRef, draft = false },
			{ signal } = {},
		) {
			if (typeof description !== "string")
				throw new TypeError("Invalid PR description");
			return request(
				"POST",
				undefined,
				{
					title: requireString(title, "PR title"),
					description,
					sourceRefName: requireBranchRef(sourceRef),
					targetRefName: requireBranchRef(targetRef),
					isDraft: requireBoolean(draft),
				},
				signal,
			);
		},

		/**
		 * Fetch current PR data without caching or starting background polling.
		 * @param {number} id
		 * @param {RequestOptions} [options]
		 */
		async get(id, { signal } = {}) {
			return request("GET", requireId(id), undefined, signal);
		},

		/**
		 * Request a merge using the supplied source commit and merge strategy.
		 * Completion can be queued: only a server status of completed maps to merged.
		 * @param {number} id
		 * @param {CompleteInput} input
		 * @param {RequestOptions} [options]
		 */
		async complete(
			id,
			{ sourceCommitId, mergeStrategy, deleteSourceBranch = false },
			{ signal } = {},
		) {
			if (!COMMIT_ID_PATTERN.test(sourceCommitId)) {
				throw new TypeError("A source commit ID is required to complete a PR");
			}
			if (!SUPPORTED_MERGE_STRATEGIES.includes(mergeStrategy)) {
				throw new TypeError("An explicit supported merge strategy is required");
			}
			return request(
				"PATCH",
				requireId(id),
				{
					status: "completed",
					lastMergeSourceCommit: { commitId: sourceCommitId },
					completionOptions: {
						mergeStrategy,
						deleteSourceBranch: requireBoolean(deleteSourceBranch),
						bypassPolicy: false,
						transitionWorkItems: false,
					},
				},
				signal,
			);
		},

		/**
		 * Close the PR without merging or deleting its source branch.
		 * @param {number} id
		 * @param {RequestOptions} [options]
		 */
		async abandon(id, { signal } = {}) {
			return request("PATCH", requireId(id), { status: "abandoned" }, signal);
		},
	};
}

/**
 * Cancel this caller's wait without cancelling a shared host token refresh.
 * @param {Promise<{ accessToken: string }>} pending
 * @param {AbortSignal | undefined} signal
 */
async function waitForAccessToken(pending, signal) {
	if (!signal) return pending;
	/** @type {PromiseWithResolvers<never>} */
	const cancelled = Promise.withResolvers();
	const onAbort = () => cancelled.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		return await Promise.race([cancelled.promise, pending]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** @param {unknown} value @param {string} name @returns {string} */
function requireString(value, name) {
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`Invalid ${name}`);
	}
	return value;
}

/** @param {unknown} value @param {string} field @returns {string | null} */
function optionalString(value, field) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string")
		throw new TypeError(`Invalid PR response field: ${field}`);
	return value;
}

/** @param {unknown} value @returns {boolean} */
function requireBoolean(value) {
	if (typeof value !== "boolean")
		throw new TypeError("Expected a boolean PR option");
	return value;
}

/** @param {unknown} value @returns {number} */
function requireId(value) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError("Invalid pull request ID");
	}
	return value;
}

/** @param {string} value */
function segment(value) {
	requireString(value, "repository path segment");
	if (value === "." || value === ".." || /[/\\]/.test(value)) {
		throw new TypeError("Invalid repository path segment");
	}
	return encodeURIComponent(value);
}

/** @param {unknown} value */
function requireBranchRef(value) {
	const ref = requireString(value, "branch ref");
	if (!ref.startsWith("refs/heads/") || ref === "refs/heads/") {
		throw new TypeError("Expected a full refs/heads/ branch ref");
	}
	return ref;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} repositoryId
 * @param {string} webUrl
 * @param {number | undefined} expectedId
 * @returns {PullRequest}
 */
function readPullRequest(value, repositoryId, webUrl, expectedId) {
	if (
		!isRecord(value) ||
		!isRecord(value.repository) ||
		typeof value.repository.id !== "string" ||
		value.repository.id.toLowerCase() !== repositoryId.toLowerCase()
	) {
		throw new TypeError("PR response does not match the repository");
	}
	const id = requireId(value.pullRequestId);
	if (expectedId !== undefined && id !== expectedId) {
		throw new TypeError(
			"PR response does not match the requested pull request",
		);
	}
	const draft =
		value.isDraft === undefined ? false : requireBoolean(value.isDraft);
	/** @type {PullRequestState} */
	let state;
	switch (value.status) {
		case "active":
			state = draft ? "draft" : "open";
			break;
		case "completed":
			state = "merged";
			break;
		case "abandoned":
			state = "closed";
			break;
		default:
			throw new TypeError("Unknown Azure DevOps pull request status");
	}
	let sourceCommitId = null;
	if (value.lastMergeSourceCommit != null) {
		if (!isRecord(value.lastMergeSourceCommit)) {
			throw new TypeError("Invalid source commit in PR response");
		}
		sourceCommitId = requireString(
			value.lastMergeSourceCommit.commitId,
			"source commit ID",
		);
	}
	return {
		id,
		repositoryId,
		title: requireString(value.title, "PR title"),
		description: optionalString(value.description, "description"),
		url: `${webUrl}/${id}`,
		state,
		sourceRef: requireBranchRef(value.sourceRefName),
		targetRef: requireBranchRef(value.targetRefName),
		sourceCommitId,
		mergeStatus: optionalString(value.mergeStatus, "mergeStatus"),
	};
}
