import { DatabaseSync } from "node:sqlite";

const database = new DatabaseSync(process.argv[2]);
database.exec("BEGIN EXCLUSIVE; UPDATE users SET name = name;");
process.send("locked");
setTimeout(() => {
  database.exec("COMMIT");
  database.close();
}, 250);
