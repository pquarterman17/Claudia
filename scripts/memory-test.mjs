// Exercise the memory finish-action on its own.
const { updateMemories } = await import('../server/src/memory-action.ts');
const t0 = Date.now();
try {
  const result = await updateMemories(process.argv[2] ?? process.cwd());
  console.log(`OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(result);
} catch (err) {
  console.log(`FAILED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(err instanceof Error ? err.message : String(err));
}
process.exit(0);
