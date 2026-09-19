const instanceId = location.pathname.split("/").at(-1);
const button = document.getElementById("refresh");
const status = document.getElementById("status");

async function load(refresh) {
	button.setAttribute("aria-disabled", "true");
	try {
		const response = await fetch(`/instances/${instanceId}`, {
			method: refresh ? "POST" : "GET",
			headers: { "Content-Type": "application/json" },
		});
		if (!response.ok)
			throw new Error(
				"The canvas is unavailable. Close it and reopen from the inspector.",
			);
		const result = await response.json();
		document.getElementById("provider").textContent = result.displayName;
		document.getElementById("description").textContent = result.description;
		document.getElementById("count").textContent = String(result.refreshCount);
		status.textContent = refresh
			? `Provider description refreshed ${result.refreshCount} times in this instance.`
			: "";
	} catch (error) {
		status.textContent = error.message;
	} finally {
		button.setAttribute("aria-disabled", "false");
	}
}

button.addEventListener("click", () => {
	if (button.getAttribute("aria-disabled") === "true") return;
	void load(true);
});
await load(false);
