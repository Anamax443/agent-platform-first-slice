import { randomBytes } from "node:crypto";

let counter = 0;

/** Time-sortable id matching the contract id pattern ^[A-Za-z0-9][A-Za-z0-9._:-]*$ */
export function newId(prefix: string): string {
  counter = (counter + 1) % 46656;
  const t = Date.now().toString(36);
  const c = counter.toString(36).padStart(3, "0");
  return `${prefix}-${t}${c}${randomBytes(3).toString("hex")}`;
}
