import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const html = await readFile(
	new URL("./repository-picker.html", import.meta.url),
	"utf8",
);
const client = await readFile(
	new URL("./repository-picker-client.mjs", import.meta.url),
	"utf8",
);

export function createRepositoryPicker(describe) {
	const instances = new Map();
	let server;
	let started;
	let origin;
	let disposed = false;

	async function refreshDescription({ instanceId }) {
		const state = instances.get(instanceId);
		if (!state || disposed) throw new Error("Canvas instance is closed");
		const metadata = await describe();
		if (instances.get(instanceId) !== state || disposed)
			throw new Error("Canvas instance is closed");
		state.metadata = metadata;
		state.refreshCount += 1;
		return { ...metadata, refreshCount: state.refreshCount };
	}

	async function handleRequest(request, response) {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		if (disposed || request.headers.host !== new URL(origin).host) {
			response.writeHead(403).end("Canvas is unavailable");
			return;
		}
		const path = new URL(request.url, origin).pathname;
		if (request.method === "GET" && path === "/repository-picker-client.mjs") {
			response.setHeader("Content-Type", "text/javascript; charset=utf-8");
			response.end(client);
			return;
		}
		const match = /^\/(canvases|instances)\/([0-9a-f-]{36})$/.exec(path);
		const state = match && instances.get(match[2]);
		if (!state) {
			response.writeHead(404).end("Canvas instance is closed");
			return;
		}
		if (request.method === "GET" && match[1] === "canvases") {
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.end(html);
			return;
		}
		if (match[1] !== "instances") {
			response.writeHead(405).end("Method not allowed");
			return;
		}
		let result;
		if (request.method === "GET") {
			result = { ...state.metadata, refreshCount: state.refreshCount };
		} else if (
			request.method === "POST" &&
			request.headers.origin === origin &&
			request.headers["content-type"] === "application/json" &&
			!request.headers["transfer-encoding"] &&
			Number(request.headers["content-length"] ?? 0) === 0
		) {
			result = await refreshDescription({ instanceId: match[2] });
		} else {
			response.writeHead(403).end("Canvas request is not allowed");
			return;
		}
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.end(JSON.stringify(result));
	}

	async function start() {
		server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
			handleRequest(request, response).catch(() => {
				console.error("Azure DevOps canvas request failed");
				if (!response.headersSent) response.writeHead(500);
				response.end("The canvas request failed. Try again.");
			});
		});
		server.requestTimeout = 5000;
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		origin = `http://127.0.0.1:${server.address().port}`;
	}

	return {
		async open({ instanceId }) {
			if (disposed) throw new Error("Canvas activation is closed");
			started ??= start();
			await started;
			if (disposed) throw new Error("Canvas activation is closed");
			if (!instances.has(instanceId)) {
				instances.set(instanceId, {
					metadata: await describe(),
					refreshCount: 0,
				});
			}
			return {
				url: `${origin}/canvases/${instanceId}`,
				title: "Azure DevOps hosting preview",
			};
		},
		actions: [{ name: "refresh-description", handler: refreshDescription }],
		async onClose({ instanceId }) {
			instances.delete(instanceId);
		},
		async dispose() {
			disposed = true;
			instances.clear();
			if (!started) return;
			await started;
			await new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			});
		},
	};
}
