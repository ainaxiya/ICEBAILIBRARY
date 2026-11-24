import { ensureTestDb } from "./db-setup";

export default async function setup() {
  await ensureTestDb();
}
