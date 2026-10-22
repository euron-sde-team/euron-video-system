// Imported FIRST by each entry point (ESM evaluates imports before the module
// body, so this must be a side-effect import, not a statement in the entry).
process.env.TZ = "UTC";
process.env.EVS_SERVICE ??= "orchestrator";
