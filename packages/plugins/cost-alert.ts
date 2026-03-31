const plugin = {
  name: "cost-alert",
  onRunFinish(runState: any) {
    const totalCost = runState.totalCost ?? 0;
    const configured = Number(
      runState?.pluginOptions?.["cost-alert"]?.thresholdUsd ??
      runState?.profile?.max_cost_per_run ??
      0.5
    );
    const threshold = Number.isFinite(configured) && configured > 0 ? configured : 0.5;
    if (totalCost > threshold) {
      console.warn(`[orchestrum] cost alert: run ${runState.runId} cost $${totalCost.toFixed(4)} (threshold $${threshold.toFixed(4)})`);
    }
  }
};

export default plugin;
