// @vitest-environment node
import { getEventListeners } from "node:events";
import { setImmediate } from "node:timers/promises";
import { describe, expect, test, vi } from "vitest";
import { createPullRequestClient } from "./pull-requests.mjs";

const repository = {
	organization: "fabrikam",
	project: "Project & tools",
	repositoryId: "3411ebc1-d5aa-464f-9615-0b527bc66719",
	accountId: "repository-account",
};
const sourceCommitId = "b60280bc6e62e2f880f1b63c1e24987664d3bda3";
const apiUrl =
	"https://dev.azure.com/fabrikam/Project%20%26%20tools/_apis/git/repositories/3411ebc1-d5aa-464f-9615-0b527bc66719/pullrequests";
const createInput = {
	title: "Add the feature",
	description: "Feature details",
	sourceRef: "refs/heads/feature",
	targetRef: "refs/heads/main",
};

function response(overrides = {}) {
	return {
		pullRequestId: 22,
		repository: { id: repository.repositoryId },
		title: createInput.title,
		description: createInput.description,
		status: "active",
		isDraft: false,
		sourceRefName: createInput.sourceRef,
		targetRefName: createInput.targetRef,
		lastMergeSourceCommit: { commitId: sourceCommitId },
		mergeStatus: "succeeded",
		...overrides,
	};
}

function setup(data = response(), binding = repository) {
	const authentication = {
		getAccessToken: vi.fn().mockResolvedValue({ accessToken: "test-token" }),
	};
	const fetch = vi.fn().mockImplementation(async () => Response.json(data));
	const client = createPullRequestClient({
		repository: binding,
		authentication,
		fetch,
	});
	return { client, authentication, fetch };
}

describe("Azure DevOps pull request client", () => {
	test.each([false, true])("creates a PR with draft=%s", async (draft) => {
		const { client, authentication, fetch } = setup(
			response({ isDraft: draft }),
		);

		const pr = await client.create({ ...createInput, draft });

		expect(authentication.getAccessToken).toHaveBeenCalledExactlyOnceWith({
			accountId: repository.accountId,
			resource: "azure-devops",
		});
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			`${apiUrl}?api-version=7.1`,
			expect.objectContaining({
				method: "POST",
				redirect: "error",
				headers: {
					Accept: "application/json",
					Authorization: "Bearer test-token",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					title: createInput.title,
					description: createInput.description,
					sourceRefName: createInput.sourceRef,
					targetRefName: createInput.targetRef,
					isDraft: draft,
				}),
			}),
		);
		expect(pr).toEqual({
			id: 22,
			repositoryId: repository.repositoryId,
			title: createInput.title,
			description: createInput.description,
			state: draft ? "draft" : "open",
			sourceRef: createInput.sourceRef,
			targetRef: createInput.targetRef,
			sourceCommitId,
			mergeStatus: "succeeded",
			url: "https://dev.azure.com/fabrikam/Project%20%26%20tools/_git/3411ebc1-d5aa-464f-9615-0b527bc66719/pullrequest/22",
		});
		expect(JSON.stringify(pr)).not.toContain("test-token");
	});

	test("uses normal creation and an empty description when omitted", async () => {
		const { client, fetch } = setup();
		const { description: _description, ...input } = createInput;

		await client.create(input);

		expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
			description: "",
			isDraft: false,
		});
	});

	test.each([
		["active", false, "succeeded", "open"],
		["active", true, "succeeded", "draft"],
		["active", false, "queued", "open"],
		["active", false, "conflicts", "open"],
		["active", false, "rejectedByPolicy", "open"],
		["completed", false, "succeeded", "merged"],
		["completed", true, "succeeded", "merged"],
		["abandoned", false, "notSet", "closed"],
		["abandoned", true, "notSet", "closed"],
	])(
		"maps %s / draft=%s / merge=%s to %s",
		async (status, isDraft, mergeStatus, state) => {
			const { client, fetch } = setup(
				response({ status, isDraft, mergeStatus }),
			);

			expect(await client.get(22)).toMatchObject({ state, mergeStatus });
			expect(fetch).toHaveBeenCalledWith(
				`${apiUrl}/22?api-version=7.1`,
				expect.objectContaining({ method: "GET", body: undefined }),
			);
		},
	);

	test("handles optional fields without inventing a source commit", async () => {
		const { client } = setup(
			response({
				description: undefined,
				isDraft: undefined,
				lastMergeSourceCommit: undefined,
				mergeStatus: undefined,
			}),
		);

		expect(await client.get(22)).toMatchObject({
			state: "open",
			description: null,
			sourceCommitId: null,
			mergeStatus: null,
		});
	});

	test.each(["squash", "noFastForward", "rebase", "rebaseMerge"])(
		"requests completion with an explicit %s strategy and source commit",
		async (mergeStrategy) => {
			const { client, fetch } = setup(response({ status: "completed" }));

			expect(
				await client.complete(22, { sourceCommitId, mergeStrategy }),
			).toMatchObject({
				state: "merged",
			});
			expect(fetch).toHaveBeenCalledWith(
				`${apiUrl}/22?api-version=7.1`,
				expect.objectContaining({
					method: "PATCH",
					body: JSON.stringify({
						status: "completed",
						lastMergeSourceCommit: { commitId: sourceCommitId },
						completionOptions: {
							mergeStrategy,
							deleteSourceBranch: false,
							bypassPolicy: false,
							transitionWorkItems: false,
						},
					}),
				}),
			);
		},
	);

	test("deletes the source branch only when requested and never forwards policy bypass", async () => {
		const { client, fetch } = setup(response({ status: "completed" }));

		await client.complete(22, {
			sourceCommitId,
			mergeStrategy: "squash",
			deleteSourceBranch: true,
			bypassPolicy: true,
			transitionWorkItems: true,
		});

		expect(JSON.parse(fetch.mock.calls[0][1].body).completionOptions).toEqual({
			mergeStrategy: "squash",
			deleteSourceBranch: true,
			bypassPolicy: false,
			transitionWorkItems: false,
		});
	});

	test("does not report a queued completion as merged", async () => {
		const { client } = setup(
			response({ status: "active", mergeStatus: "queued" }),
		);

		expect(
			await client.complete(22, { sourceCommitId, mergeStrategy: "squash" }),
		).toMatchObject({
			state: "open",
			mergeStatus: "queued",
		});
	});

	test("abandons the exact PR without sending completion options", async () => {
		const { client, fetch } = setup(response({ status: "abandoned" }));

		expect(await client.abandon(22)).toMatchObject({ state: "closed" });
		expect(fetch).toHaveBeenCalledWith(
			`${apiUrl}/22?api-version=7.1`,
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ status: "abandoned" }),
			}),
		);
	});

	test("gets a token for each request and does not retain a stale token", async () => {
		const { client, authentication, fetch } = setup();
		authentication.getAccessToken
			.mockResolvedValueOnce({ accessToken: "first-token" })
			.mockResolvedValueOnce({ accessToken: "refreshed-token" });

		await client.get(22);
		await client.get(22);

		expect(
			fetch.mock.calls.map(([, init]) => init.headers.Authorization),
		).toEqual(["Bearer first-token", "Bearer refreshed-token"]);
	});

	test("keeps the account and repository together while awaiting a token", async () => {
		const binding = { ...repository };
		const { client, authentication, fetch } = setup(response(), binding);
		let finishToken;
		authentication.getAccessToken.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishToken = resolve;
				}),
		);

		const pending = client.get(22);
		binding.organization = "other-org";
		binding.accountId = "other-account";
		finishToken({ accessToken: "original-account-token" });
		await pending;

		expect(authentication.getAccessToken).toHaveBeenCalledWith({
			accountId: repository.accountId,
			resource: "azure-devops",
		});
		expect(fetch.mock.calls[0][0]).toBe(`${apiUrl}/22?api-version=7.1`);
	});

	test.each([400, 401, 403, 404, 409, 429, 500])(
		"reports HTTP %s without retrying a mutation or exposing the response body",
		async (status) => {
			const { client, fetch } = setup();
			fetch.mockResolvedValue(
				new Response("private server details: test-token", { status }),
			);

			await expect(client.create(createInput)).rejects.toMatchObject({
				name: "AzureDevOpsHttpError",
				status,
				message: `Azure DevOps PR request failed (HTTP ${status}).`,
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	test("propagates token and network failures without retrying", async () => {
		const { client, authentication, fetch } = setup();
		const authError = new Error("Sign in required");
		authentication.getAccessToken.mockRejectedValueOnce(authError);
		await expect(client.get(22)).rejects.toBe(authError);
		expect(fetch).not.toHaveBeenCalled();

		const networkError = new TypeError("Connection lost");
		fetch.mockRejectedValueOnce(networkError);
		await expect(client.abandon(22)).rejects.toBe(networkError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("releases the response stream on HTTP failure", async () => {
		const { client, fetch } = setup();
		const cancel = vi.fn();
		fetch.mockResolvedValueOnce(
			new Response(new ReadableStream({ cancel }), { status: 403 }),
		);

		await expect(client.get(22)).rejects.toMatchObject({ status: 403 });
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test.each(["already failed", "cleanup rejects"])(
		"preserves HTTP status when the response stream %s",
		async (failure) => {
			const { client, fetch } = setup();
			const cleanupError = new Error("Response stream failed");
			const stream = new ReadableStream({
				start(controller) {
					if (failure === "already failed") controller.error(cleanupError);
				},
				cancel() {
					return Promise.reject(cleanupError);
				},
			});
			fetch.mockResolvedValueOnce(new Response(stream, { status: 403 }));

			await expect(client.get(22)).rejects.toMatchObject({
				name: "AzureDevOpsHttpError",
				status: 403,
				message: "Azure DevOps PR request failed (HTTP 403).",
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	test("keeps the same PR number in two repositories separate", async () => {
		const other = {
			...repository,
			organization: "contoso",
			repositoryId: "a7573007-bbb3-4341-b726-0c4148a07853",
			accountId: "other-account",
		};
		const first = setup();
		const second = setup(
			response({ repository: { id: other.repositoryId } }),
			other,
		);

		const results = await Promise.all([
			first.client.get(22),
			second.client.get(22),
		]);

		expect(results.map(({ repositoryId }) => repositoryId)).toEqual([
			repository.repositoryId,
			other.repositoryId,
		]);
		expect(second.authentication.getAccessToken).toHaveBeenCalledWith({
			accountId: other.accountId,
			resource: "azure-devops",
		});
		expect(second.fetch.mock.calls[0][0]).toBe(
			`https://dev.azure.com/contoso/Project%20%26%20tools/_apis/git/repositories/${other.repositoryId}/pullrequests/22?api-version=7.1`,
		);
	});

	test("does not fetch when cancelled during token retrieval", async () => {
		const { client, authentication, fetch } = setup();
		const controller = new AbortController();
		authentication.getAccessToken.mockImplementationOnce(async () => {
			controller.abort();
			return { accessToken: "test-token" };
		});

		await expect(
			client.get(22, { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each(["create", "get", "complete", "abandon"])(
		"cancels %s before a pending token resolves or rejects",
		async (method) => {
			for (const lateFailure of [false, true]) {
				const { client, authentication, fetch } = setup();
				const token = Promise.withResolvers();
				authentication.getAccessToken.mockReturnValueOnce(token.promise);
				const controller = new AbortController();
				const options = { signal: controller.signal };
				const calls = {
					create: () => client.create(createInput, options),
					get: () => client.get(22, options),
					complete: () =>
						client.complete(
							22,
							{
								sourceCommitId,
								mergeStrategy: "squash",
							},
							options,
						),
					abandon: () => client.abandon(22, options),
				};
				let outcome;
				const pending = calls[method]().then(
					(value) => {
						outcome = value;
					},
					(error) => {
						outcome = error;
					},
				);

				try {
					expect(authentication.getAccessToken).toHaveBeenCalledTimes(1);
					controller.abort();
					await setImmediate();
					expect(outcome).toBe(controller.signal.reason);
					expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
					expect(fetch).not.toHaveBeenCalled();
				} finally {
					if (lateFailure) token.reject(new Error("Late token failure"));
					else token.resolve({ accessToken: "late-token" });
					await pending;
				}
				await setImmediate();
				expect(outcome).toBe(controller.signal.reason);
				expect(fetch).not.toHaveBeenCalled();
			}
		},
	);

	test.each([false, true])(
		"removes the token-wait abort listener after token failure=%s",
		async (failure) => {
			const { client, authentication, fetch } = setup();
			const controller = new AbortController();
			const tokenError = new Error("Token unavailable");
			authentication.getAccessToken.mockImplementationOnce(async () => {
				if (failure) throw tokenError;
				return { accessToken: "test-token" };
			});
			fetch.mockImplementationOnce(async () => {
				expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
				return Response.json(response());
			});

			const pending = client.get(22, { signal: controller.signal });
			if (failure) await expect(pending).rejects.toBe(tokenError);
			else await expect(pending).resolves.toMatchObject({ id: 22 });
			expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
		},
	);

	test("cancelling one caller does not cancel another caller sharing the token", async () => {
		const { client, authentication, fetch } = setup();
		const token = Promise.withResolvers();
		authentication.getAccessToken.mockReturnValue(token.promise);
		const controller = new AbortController();
		const cancelled = client.get(22, { signal: controller.signal });
		const cancelledResult = expect(cancelled).rejects.toMatchObject({
			name: "AbortError",
		});
		const active = client.get(22);

		controller.abort();
		token.resolve({ accessToken: "shared-token" });

		await cancelledResult;
		await expect(active).resolves.toMatchObject({ id: 22 });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	test("passes cancellation to fetch and skips already-cancelled requests", async () => {
		const { client, authentication, fetch } = setup();
		const controller = new AbortController();
		await client.get(22, { signal: controller.signal });
		controller.abort();

		expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
		await expect(
			client.get(22, { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(authentication.getAccessToken).toHaveBeenCalledTimes(1);
	});

	test("does not return a result after cancellation", async () => {
		const { client, fetch } = setup();
		const controller = new AbortController();
		fetch.mockImplementationOnce(async () => {
			controller.abort();
			return Response.json(response());
		});

		await expect(
			client.get(22, { signal: controller.signal }),
		).rejects.toMatchObject({
			name: "AbortError",
		});
	});

	test.each([undefined, null, 0, -1, 1.5, Number.NaN, "22"])(
		"requires an exact PR ID for read and update: %s",
		async (id) => {
			const { client, authentication, fetch } = setup();
			await expect(client.get(id)).rejects.toThrow("pull request ID");
			await expect(client.abandon(id)).rejects.toThrow("pull request ID");
			await expect(
				client.complete(id, {
					sourceCommitId,
					mergeStrategy: "squash",
				}),
			).rejects.toThrow("pull request ID");
			expect(authentication.getAccessToken).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	test.each([
		{ organization: ".." },
		{ project: "../another-project" },
		{ repositoryId: "" },
		{ accountId: "" },
	])("rejects an invalid repository binding: %j", (override) => {
		expect(() => setup(response(), { ...repository, ...override })).toThrow();
	});

	test("rejects invalid mutation inputs before requesting credentials", async () => {
		const { client, authentication, fetch } = setup();
		await expect(
			client.create({ ...createInput, title: " " }),
		).rejects.toThrow();
		await expect(
			client.create({ ...createInput, sourceRef: "feature" }),
		).rejects.toThrow();
		await expect(
			client.create({ ...createInput, draft: "false" }),
		).rejects.toThrow();
		await expect(client.get(-1)).rejects.toThrow();
		await expect(
			client.complete(22, { mergeStrategy: "squash" }),
		).rejects.toThrow();
		await expect(
			client.complete(22, { sourceCommitId, mergeStrategy: "unknown" }),
		).rejects.toThrow();
		await expect(
			client.complete(22, {
				sourceCommitId,
				mergeStrategy: "squash",
				deleteSourceBranch: "false",
			}),
		).rejects.toThrow();
		expect(authentication.getAccessToken).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each([
		null,
		{},
		response({ status: "future-status" }),
		response({ isDraft: "false" }),
		response({ pullRequestId: 23 }),
		response({ repository: { id: "other-repository" } }),
		response({ title: 123 }),
	])("rejects an invalid or mismatched response: %j", async (data) => {
		const { client } = setup(data);
		await expect(client.get(22)).rejects.toThrow();
	});

	test.each(["description", "mergeStatus"])(
		"names an invalid %s field without exposing its contents",
		async (field) => {
			const { client } = setup(
				response({ [field]: { privateDetails: "sensitive server data" } }),
			);

			await expect(client.get(22)).rejects.toMatchObject({
				name: "TypeError",
				message: `Invalid PR response field: ${field}`,
			});
		},
	);

	test("keeps unknown status contents out of errors", async () => {
		const { client } = setup(
			response({ status: "unexpected\nsensitive server data" }),
		);

		await expect(client.get(22)).rejects.toMatchObject({
			name: "TypeError",
			message: "Unknown Azure DevOps pull request status",
		});
	});

	test("rejects an empty access token without sending a request", async () => {
		const { client, authentication, fetch } = setup();
		authentication.getAccessToken.mockResolvedValue({ accessToken: "" });
		await expect(client.get(22)).rejects.toThrow("access token");
		expect(fetch).not.toHaveBeenCalled();
	});
});
