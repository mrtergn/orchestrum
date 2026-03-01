const plugin = {
  name: "log-to-console",
  onRunStart(runState: any) {
    console.log(`[orchestrum] run started: ${runState.runId}`);
  },
  onStepStart(stepState: any) {
    console.log(`[orchestrum] step started: ${stepState.stepId}`);
  },
  onStepFinish(stepState: any) {
    console.log(`[orchestrum] step finished: ${stepState.stepId} (${stepState.status})`);
  },
  onRunFinish(runState: any) {
    console.log(`[orchestrum] run finished: ${runState.runId} (${runState.status})`);
  }
};

export default plugin;
