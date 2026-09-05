import { idSchema } from "../../packages/contracts/src/index.js";
import { connectDatabase, WorkerStore } from "../../packages/database/src/index.js";

const user = idSchema.parse(process.argv[2]);
const execution = idSchema.parse(process.argv[3]);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const connection = connectDatabase(process.env.DATABASE_URL);
try {
  const store = new WorkerStore(connection.db, {
    assert: async () => {
      throw new Error("Read-only inspector");
    },
  });
  const journal = await store.journal(user, execution);
  console.log(
    JSON.stringify(
      journal.map(({ leg, hash, nonce, signer, status, createdAt, confirmedAt, evidence }) => ({
        leg,
        hash,
        nonce,
        signer,
        status,
        createdAt,
        confirmedAt,
        evidence,
      })),
      null,
      2,
    ),
  );
} finally {
  await connection.close();
}
