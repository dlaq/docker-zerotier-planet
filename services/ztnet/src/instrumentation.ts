export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		const cronTasksModule = await import("./cronTasks");
		if (cronTasksModule.CheckExpiredUsers) {
			cronTasksModule.CheckExpiredUsers();
		}

		const { startNotificationWorker } = await import("./server/notifications/service");
		startNotificationWorker();

		// Observe all managed members
		if (cronTasksModule.updatePeers) {
			cronTasksModule.updatePeers();
		}
	}
}
