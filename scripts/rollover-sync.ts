import { storeFromEnv } from "../apps/api/src/mtf/store.ts";
import { NseBhavcopyProvider } from "../apps/api/src/rollovers/nse.ts";
const store = await storeFromEnv(process.env);
const provider = new NseBhavcopyProvider({ sql: store.sql });
try {
  await provider.initialize();
  await provider.sync(true);
  console.log(
    JSON.stringify(
      {
        status: provider.status,
        months: provider
          .load()
          .months.map((m) => ({
            month: m.month,
            status: m.status,
            rows: provider.load().rows.filter((r) => r.month === m.month)
              .length,
            snapshotDate: m.snapshotDate,
          })),
      },
      null,
      2,
    ),
  );
  if (provider.status.errors.length) process.exitCode = 1;
} finally {
  await store.close();
}
