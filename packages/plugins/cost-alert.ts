const plugin = {
  name: "cost-alert",
  onRunFinish(runState: any) {
    const totalCost = runState.totalCost ?? 0;
    if (totalCost > 0.5) {
      console.warn(`[orchestrum] cost alert: run ${runState.runId} cost $${totalCost.toFixed(4)}`);
    }
  }
};

export default plugin;
