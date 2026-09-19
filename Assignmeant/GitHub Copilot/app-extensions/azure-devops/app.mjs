import { createRepositoryPicker } from "./repository-picker.mjs";

export default async function activate(host) {
	const releaseProvider = await host.registerProvider("azure-devops", {
		describe,
	});
	const picker = createRepositoryPicker(describe);
	let releaseCanvas;
	try {
		releaseCanvas = await host.registerCanvas("repository-picker", picker);
	} catch (error) {
		releaseProvider();
		await picker.dispose();
		throw error;
	}
	return async () => {
		releaseCanvas();
		releaseProvider();
		await picker.dispose();
	};
}

async function describe() {
	return {
		displayName: "Azure DevOps",
		description:
			"Built-in Azure DevOps provider. Only metadata inspection is available.",
		capabilities: ["provider.describe"],
	};
}
