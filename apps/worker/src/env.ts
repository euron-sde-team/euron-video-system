// Imported FIRST by index.ts. ESM evaluates imports before the importing
// module's body, so setting TZ inside index.ts would run after @evs/core/db has
// already loaded; a side-effect module that is the first import runs before it.
// pg serializes Date objects with local getters, so the process must be UTC.
process.env.TZ = "UTC";
process.env.EVS_SERVICE ??= "worker";
